import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  executeIdempotentCommand,
  getNovelImportCommandOwnerRoot,
  listCommandLedger,
  type IdempotentCommandInput,
} from "../src/core/command-bus.js";
import {
  createAuthorizedNovelImportPreflight,
  resetNovelImportPreflightAuthorizationsForTests,
} from "../src/core/novel-import.js";
import { NovelRepository } from "../src/core/novel-manuscript.js";
import type { NovelCommandRequest } from "../src/core/novel-command-runtime.js";
import { runWithOperationContext } from "../src/core/operation-context.js";
import { listRegisteredProjects } from "../src/core/sidecar.js";

const temporaryRoots: string[] = [];
const previousRegistryPath = process.env.AI_CANVAS_REGISTRY_PATH;

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, stableValue(entry)]));
}

function fingerprint(value: unknown): string {
  return sha256(JSON.stringify(stableValue(value)));
}

function manuscriptMutation<T>(label: string, command: string, work: () => Promise<T>): Promise<T> {
  return runWithOperationContext({
    requestId: `novel-manuscript-request-${label}`,
    idempotencyKey: `novel-manuscript-idempotency-${label}`,
    requestHash: sha256(`novel-manuscript:${label}`),
    command,
  }, work);
}

async function exists(value: string): Promise<boolean> {
  return lstat(value).then(() => true, (error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  });
}

async function treeIdentity(root: string): Promise<string> {
  const rows: Array<Record<string, unknown>> = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      const metadata = await lstat(absolute);
      rows.push({
        relative,
        type: metadata.isDirectory() ? "directory" : metadata.isFile() ? "file" : "other",
        size: metadata.size,
        sha256: metadata.isFile() ? sha256(await readFile(absolute)) : null,
      });
      if (metadata.isDirectory()) await visit(absolute);
    }
  };
  await visit(root);
  return sha256(JSON.stringify(rows));
}

async function treeContainsBytes(root: string, needle: string): Promise<boolean> {
  const bytes = Buffer.from(needle, "utf8");
  const visit = async (directory: string): Promise<boolean> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (await visit(absolute)) return true;
      } else if (entry.isFile() && (await readFile(absolute)).includes(bytes)) {
        return true;
      }
    }
    return false;
  };
  return visit(root);
}

function absoluteStrings(value: unknown, output: string[] = []): string[] {
  if (typeof value === "string" && (path.isAbsolute(value) || path.win32.isAbsolute(value))) output.push(value);
  else if (Array.isArray(value)) value.forEach((entry) => absoluteStrings(entry, output));
  else if (value && typeof value === "object") Object.values(value as Record<string, unknown>)
    .forEach((entry) => absoluteStrings(entry, output));
  return output;
}

async function fixture(label: string): Promise<{
  base: string;
  appState: string;
  ownerRoot: string;
  projectsRoot: string;
  sourceRoot: string;
  sourcePath: string;
}> {
  const base = await realpath(await mkdtemp(path.join(await realpath(os.tmpdir()), `novel-import-command-${label}-`)));
  temporaryRoots.push(base);
  const appState = path.join(base, "app-state");
  const projectsRoot = path.join(base, "projects");
  const sourceRoot = path.join(base, "source");
  await Promise.all([mkdir(appState), mkdir(projectsRoot), mkdir(sourceRoot)]);
  process.env.AI_CANVAS_REGISTRY_PATH = path.join(appState, "projects.json");
  const ownerRoot = getNovelImportCommandOwnerRoot();
  const sourcePath = path.join(sourceRoot, "第一卷.md");
  await writeFile(sourcePath, "# 第一章 神落\n\n嘟嘟在青铜树下醒来。\n", "utf8");
  return { base, appState, ownerRoot, projectsRoot, sourceRoot, sourcePath };
}

async function importRequest(
  projectsRoot: string,
  sourcePath: string,
  authorization = true,
): Promise<Extract<NovelCommandRequest, { command: "novel_import_external_snapshot" }>> {
  const authorized = await createAuthorizedNovelImportPreflight(sourcePath);
  expect(authorized.authorization).not.toBeNull();
  return {
    command: "novel_import_external_snapshot",
    payload: {
      projectsRoot,
      projectName: "古蜀十三相·外部导入",
      preflightId: authorized.preflight.preflightId,
      preflightFingerprint: authorized.preflight.fingerprint,
      sourceTreeAggregateSha256: authorized.preflight.sourceTreeAggregateSha256,
      duplicateResolution: "include_all",
      convertToManagedMarkdown: true,
      ...(authorization ? { preflightAuthorization: authorized.authorization!.authorizationId } : {}),
    },
  };
}

function envelope(label: string, request: NovelCommandRequest, idempotencyKey = `novel-import-idempotency-${label}`): IdempotentCommandInput {
  return {
    requestId: `novel-import-request-${label}`,
    idempotencyKey,
    request,
  };
}

afterEach(async () => {
  delete process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE;
  delete process.env.AI_CANVAS_TEST_NOVEL_IMPORT_INTERRUPT;
  resetNovelImportPreflightAuthorizationsForTests();
  if (previousRegistryPath === undefined) delete process.env.AI_CANVAS_REGISTRY_PATH;
  else process.env.AI_CANVAS_REGISTRY_PATH = previousRegistryPath;
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe.sequential("novel import command owner", () => {
  it("首次无 token 与 source/projects 重叠都在 owner/ledger 写入前零写拒绝", async () => {
    const data = await fixture("zero-write");
    const request = await importRequest(data.projectsRoot, data.sourcePath);
    const sourceBefore = await treeIdentity(data.sourceRoot);
    const projectsBefore = await treeIdentity(data.projectsRoot);
    const tokenless: NovelCommandRequest = {
      ...request,
      payload: { ...request.payload, preflightAuthorization: undefined },
    };

    await expect(executeIdempotentCommand(data.ownerRoot, envelope("first-tokenless", tokenless)))
      .rejects.toThrow(/owner.*不存在|尚不存在|ENOENT/u);
    expect(await exists(data.ownerRoot)).toBe(false);
    expect(await treeIdentity(data.sourceRoot)).toBe(sourceBefore);
    expect(await treeIdentity(data.projectsRoot)).toBe(projectsBefore);

    const overlapping = await importRequest(data.sourceRoot, data.sourcePath);
    await expect(executeIdempotentCommand(data.ownerRoot, envelope("overlap", overlapping)))
      .rejects.toThrow(/不得相同|互为祖先|互为后代/u);
    expect(await exists(data.ownerRoot)).toBe(false);
    expect(await treeIdentity(data.sourceRoot)).toBe(sourceBefore);
    expect(await exists(path.join(data.sourceRoot, ".aicanvas"))).toBe(false);
    expect(await exists(path.join(data.sourceRoot, ".aicanvas-novel-import-transactions"))).toBe(false);
  });

  it("不同有效 token 具有同一 requestHash，token 不落账，成功结果不暴露绝对项目根且删源可重放", async () => {
    const data = await fixture("stable-hash");
    const firstRequest = await importRequest(data.projectsRoot, data.sourcePath);
    const firstToken = firstRequest.payload.preflightAuthorization!;
    const sourceBefore = await treeIdentity(data.sourceRoot);
    const idempotencyKey = "novel-import-idempotency-stable-hash";
    const first = await executeIdempotentCommand(
      data.ownerRoot,
      envelope("stable-hash-a", firstRequest, idempotencyKey),
    );
    expect(first.status).toBe("succeeded");
    expect(first.replayed).toBe(false);
    expect(first.result).not.toHaveProperty("projectRoot");
    expect(absoluteStrings(first.result)).toEqual([]);
    expect(JSON.stringify(first)).not.toContain(firstToken);
    expect(await treeIdentity(data.sourceRoot)).toBe(sourceBefore);

    const secondRequest = await importRequest(data.projectsRoot, data.sourcePath);
    const secondToken = secondRequest.payload.preflightAuthorization!;
    expect(secondToken).not.toBe(firstToken);
    expect(secondRequest.payload.preflightId).toBe(firstRequest.payload.preflightId);
    const second = await executeIdempotentCommand(
      data.ownerRoot,
      envelope("stable-hash-b", secondRequest, idempotencyKey),
    );
    expect(second.status).toBe("succeeded");
    expect(second.replayed).toBe(true);
    expect(second.requestHash).toBe(first.requestHash);

    const ledger = await listCommandLedger(data.ownerRoot);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.result).not.toHaveProperty("projectRoot");
    expect(absoluteStrings(ledger[0]!.result)).toEqual([]);
    const serializedLedger = JSON.stringify(ledger);
    expect(serializedLedger).not.toContain(firstToken);
    expect(serializedLedger).not.toContain(secondToken);
    expect(await treeContainsBytes(data.ownerRoot, firstToken)).toBe(false);
    expect(await treeContainsBytes(data.ownerRoot, secondToken)).toBe(false);
    expect(await treeContainsBytes(data.projectsRoot, firstToken)).toBe(false);
    expect(await treeContainsBytes(data.projectsRoot, secondToken)).toBe(false);
    const importedProject = (await readdir(data.projectsRoot, { withFileTypes: true }))
      .find((entry) => entry.isDirectory() && entry.name !== ".aicanvas-novel-import-transactions");
    expect(importedProject).toBeDefined();
    expect(await treeContainsBytes(data.ownerRoot, path.join(data.projectsRoot, importedProject!.name))).toBe(false);

    resetNovelImportPreflightAuthorizationsForTests();
    await rm(data.sourceRoot, { recursive: true, force: true });
    const tokenless: NovelCommandRequest = {
      ...secondRequest,
      payload: { ...secondRequest.payload, preflightAuthorization: undefined },
    };
    const replay = await executeIdempotentCommand(
      data.ownerRoot,
      envelope("stable-hash-c", tokenless, idempotencyKey),
    );
    expect(replay.status).toBe("succeeded");
    expect(replay.replayed).toBe(true);
    expect(replay.requestHash).toBe(first.requestHash);
    expect(replay.result).not.toHaveProperty("projectRoot");
  });

  it("副作用完成但响应丢失后，仅凭无 token durable snapshot 与 receipt 在删源后恢复", async () => {
    const data = await fixture("crash-recovery");
    const request = await importRequest(data.projectsRoot, data.sourcePath);
    const token = request.payload.preflightAuthorization!;
    const idempotencyKey = "novel-import-idempotency-crash-recovery";
    process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE = "novel_import_external_snapshot";
    await expect(executeIdempotentCommand(
      data.ownerRoot,
      envelope("crash-recovery-a", request, idempotencyKey),
    )).rejects.toThrow(/执行结果未确认|TEST_ONLY_CRASH_AFTER_EXECUTE/u);
    delete process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE;
    const unknown = (await listCommandLedger(data.ownerRoot))[0]!;
    expect(unknown.status).toBe("unknown");
    expect(JSON.stringify(unknown.durableReconciliation)).not.toContain(token);

    resetNovelImportPreflightAuthorizationsForTests();
    await rm(data.sourceRoot, { recursive: true, force: true });
    const tokenless: NovelCommandRequest = {
      ...request,
      payload: { ...request.payload, preflightAuthorization: undefined },
    };
    const recovered = await executeIdempotentCommand(
      data.ownerRoot,
      envelope("crash-recovery-b", tokenless, idempotencyKey),
    );
    expect(recovered.status).toBe("succeeded");
    expect(recovered.replayed).toBe(true);
    expect(recovered.result).toMatchObject({ replayed: true });
    expect(recovered.result).not.toHaveProperty("projectRoot");
    expect(absoluteStrings(recovered.result)).toEqual([]);
  });

  it("registered 中断前从未产生成功锚点时，可由完整闭包首次建立锚点并无源恢复", async () => {
    const data = await fixture("registered-first-anchor");
    const request = await importRequest(data.projectsRoot, data.sourcePath);
    const idempotencyKey = "novel-import-idempotency-registered-first-anchor";
    process.env.AI_CANVAS_TEST_NOVEL_IMPORT_INTERRUPT = "registered";
    await expect(executeIdempotentCommand(
      data.ownerRoot,
      envelope("registered-first-anchor-a", request, idempotencyKey),
    )).rejects.toThrow(/执行结果未确认|registered/u);
    delete process.env.AI_CANVAS_TEST_NOVEL_IMPORT_INTERRUPT;
    const unknown = (await listCommandLedger(data.ownerRoot))[0]!;
    expect(unknown.status).toBe("unknown");
    expect(unknown.result).toBeUndefined();
    expect(unknown.novelImportResultAnchor).toBeUndefined();

    resetNovelImportPreflightAuthorizationsForTests();
    await rm(data.sourceRoot, { recursive: true, force: true });
    const tokenless: NovelCommandRequest = {
      ...request,
      payload: { ...request.payload, preflightAuthorization: undefined },
    };
    const recovered = await executeIdempotentCommand(
      data.ownerRoot,
      envelope("registered-first-anchor-b", tokenless, idempotencyKey),
    );
    expect(recovered.status).toBe("succeeded");
    expect(recovered.novelImportResultAnchor).toMatchObject({
      kind: "novel-import-result-anchor",
      receiptFingerprint: (recovered.result as { receipt: { fingerprint: string } }).receipt.fingerprint,
    });
  });

  it("unknown 只有未完成 partial 时无 token 恢复零业务写并保持 unknown", async () => {
    const data = await fixture("partial-unknown");
    const request = await importRequest(data.projectsRoot, data.sourcePath);
    const idempotencyKey = "novel-import-idempotency-partial-unknown";
    process.env.AI_CANVAS_TEST_NOVEL_IMPORT_INTERRUPT = "source_objects_copied";
    await expect(executeIdempotentCommand(
      data.ownerRoot,
      envelope("partial-unknown-a", request, idempotencyKey),
    )).rejects.toThrow(/执行结果未确认|source_objects_copied/u);
    delete process.env.AI_CANVAS_TEST_NOVEL_IMPORT_INTERRUPT;
    expect((await listCommandLedger(data.ownerRoot))[0]?.status).toBe("unknown");

    resetNovelImportPreflightAuthorizationsForTests();
    const projectsBefore = await treeIdentity(data.projectsRoot);
    const tokenless: NovelCommandRequest = {
      ...request,
      payload: { ...request.payload, preflightAuthorization: undefined },
    };
    await expect(executeIdempotentCommand(
      data.ownerRoot,
      envelope("partial-unknown-b", tokenless, idempotencyKey),
    )).rejects.toThrow(/保持 unknown|不可变.*不足|未能.*证明完成/u);
    expect(await treeIdentity(data.projectsRoot)).toBe(projectsBefore);
    expect((await listCommandLedger(data.ownerRoot))[0]?.status).toBe("unknown");
  });

  it("receipt 候选存在但业务闭包损坏时，无 token proof 在 bootstrap/注册/terminal 修补前零写失败", async () => {
    const data = await fixture("corrupt-receipt-proof");
    const request = await importRequest(data.projectsRoot, data.sourcePath);
    const idempotencyKey = "novel-import-idempotency-corrupt-receipt-proof";
    process.env.AI_CANVAS_TEST_NOVEL_IMPORT_INTERRUPT = "registered";
    await expect(executeIdempotentCommand(
      data.ownerRoot,
      envelope("corrupt-receipt-proof-a", request, idempotencyKey),
    )).rejects.toThrow(/执行结果未确认|registered/u);
    delete process.env.AI_CANVAS_TEST_NOVEL_IMPORT_INTERRUPT;
    expect((await listCommandLedger(data.ownerRoot))[0]?.status).toBe("unknown");

    const projectEntry = (await readdir(data.projectsRoot, { withFileTypes: true }))
      .find((entry) => entry.isDirectory() && entry.name !== ".aicanvas-novel-import-transactions");
    expect(projectEntry).toBeDefined();
    const projectRoot = path.join(data.projectsRoot, projectEntry!.name);
    const manifest = JSON.parse(await readFile(path.join(projectRoot, "manuscript", "chapters.json"), "utf8")) as {
      chapters: Array<{ relativePath: string }>;
    };
    expect(manifest.chapters).toHaveLength(1);
    await writeFile(path.join(projectRoot, manifest.chapters[0]!.relativePath), "闭包已被篡改。", "utf8");

    resetNovelImportPreflightAuthorizationsForTests();
    const projectsBefore = await treeIdentity(data.projectsRoot);
    const registryBefore = await treeIdentity(data.appState);
    const ownerBefore = await treeIdentity(data.ownerRoot);
    const tokenless: NovelCommandRequest = {
      ...request,
      payload: { ...request.payload, preflightAuthorization: undefined },
    };
    await expect(executeIdempotentCommand(
      data.ownerRoot,
      envelope("corrupt-receipt-proof-b", tokenless, idempotencyKey),
    )).rejects.toThrow(/保持 unknown|不可变.*不足|未能.*证明完成/u);
    expect(await treeIdentity(data.projectsRoot)).toBe(projectsBefore);
    expect(await treeIdentity(data.appState)).toBe(registryBefore);
    expect(await treeIdentity(data.ownerRoot)).toBe(ownerBefore);
    expect((await listCommandLedger(data.ownerRoot))[0]?.status).toBe("unknown");
  });

  it("succeeded 账本重放必须重新证明不可变导入闭包，source CAS 损坏时拒绝伪成功并降为 unknown", async () => {
    const data = await fixture("succeeded-closure-drift");
    const request = await importRequest(data.projectsRoot, data.sourcePath);
    const idempotencyKey = "novel-import-idempotency-succeeded-closure-drift";
    const first = await executeIdempotentCommand(
      data.ownerRoot,
      envelope("succeeded-closure-drift-a", request, idempotencyKey),
    );
    expect(first.status).toBe("succeeded");

    const projectEntry = (await readdir(data.projectsRoot, { withFileTypes: true }))
      .find((entry) => entry.isDirectory() && entry.name !== ".aicanvas-novel-import-transactions");
    expect(projectEntry).toBeDefined();
    const projectRoot = path.join(data.projectsRoot, projectEntry!.name);
    const sourceObject = (first.result as {
      receipt: { sourceObjects: Array<{ objectRelativePath: string }> };
    }).receipt.sourceObjects[0]!;
    await writeFile(path.join(projectRoot, ...sourceObject.objectRelativePath.split("/")), "成功后不可变 CAS 已损坏。", "utf8");
    const projectsBefore = await treeIdentity(data.projectsRoot);
    const registryBefore = await listRegisteredProjects();

    resetNovelImportPreflightAuthorizationsForTests();
    const tokenless: NovelCommandRequest = {
      ...request,
      payload: { ...request.payload, preflightAuthorization: undefined },
    };
    await expect(executeIdempotentCommand(
      data.ownerRoot,
      envelope("succeeded-closure-drift-b", tokenless, idempotencyKey),
    )).rejects.toThrow(/闭包漂移|拒绝重放|降为 unknown/u);
    expect(await treeIdentity(data.projectsRoot)).toBe(projectsBefore);
    expect(await listRegisteredProjects()).toEqual(registryBefore);
    const drifted = (await listCommandLedger(data.ownerRoot))[0]!;
    expect(drifted.status).toBe("unknown");
    expect(drifted.result).toBeUndefined();
    expect(drifted.error?.message).toMatch(/registered 业务闭包漂移/u);
  });

  it("导入后的正常保存、改名、移卷与重排不冻结初始正文，原导入仍按历史回执无源重放", async () => {
    const data = await fixture("editable-history-replay");
    await writeFile(data.sourcePath, [
      "# 第一章 神落",
      "嘟嘟在青铜树下醒来。",
      "",
      "# 第二章 火路",
      "阿航越过没有名字的山口。",
    ].join("\n"), "utf8");
    const request = await importRequest(data.projectsRoot, data.sourcePath);
    const idempotencyKey = "novel-import-idempotency-editable-history-replay";
    const imported = await executeIdempotentCommand(
      data.ownerRoot,
      envelope("editable-history-replay-a", request, idempotencyKey),
    );
    expect(imported.status).toBe("succeeded");

    const projectEntry = (await readdir(data.projectsRoot, { withFileTypes: true }))
      .find((entry) => entry.isDirectory() && entry.name !== ".aicanvas-novel-import-transactions");
    expect(projectEntry).toBeDefined();
    const projectRoot = path.join(data.projectsRoot, projectEntry!.name);
    const repository = new NovelRepository(projectRoot);
    let snapshot = await repository.snapshot();
    expect(snapshot.chapters?.chapters).toHaveLength(2);
    const originalIds = snapshot.chapters!.chapters.map((chapter) => chapter.chapterId);
    let chapter = snapshot.chapters!.chapters[0]!;

    await manuscriptMutation("editable-save", "novel_save_chapter", () => repository.saveChapter({
      chapterId: chapter.chapterId,
      content: "这是导入后由作者正式保存的新正文。",
      expectedRevision: chapter.revision,
      expectedSha256: chapter.sha256,
    }));
    snapshot = await repository.snapshot();
    chapter = snapshot.chapters!.chapters.find((entry) => entry.chapterId === originalIds[0])!;
    await manuscriptMutation("editable-rename", "novel_rename_chapter", () => repository.renameChapter({
      chapterId: chapter.chapterId,
      title: "第一章·作者改名",
      expectedRevision: chapter.revision,
      expectedManifestRevision: snapshot.chapters!.revision,
    }));
    snapshot = await repository.snapshot();
    const createdVolume = await manuscriptMutation("editable-volume", "novel_create_volume", () => repository.createVolume({
      title: "第二卷",
      expectedManifestRevision: snapshot.chapters!.revision,
    }));
    snapshot = await repository.snapshot();
    chapter = snapshot.chapters!.chapters.find((entry) => entry.chapterId === originalIds[0])!;
    await manuscriptMutation("editable-move", "novel_move_chapter", () => repository.moveChapter({
      chapterId: chapter.chapterId,
      volumeId: createdVolume.volume.volumeId,
      order: 0,
      expectedRevision: chapter.revision,
      expectedSha256: chapter.sha256,
      expectedManifestRevision: snapshot.chapters!.revision,
    }));
    snapshot = await repository.snapshot();
    await manuscriptMutation("editable-reorder", "novel_reorder_chapters", () => repository.reorderChapters({
      orderedChapterIds: [...originalIds].reverse(),
      expectedManifestRevision: snapshot.chapters!.revision,
    }));
    const evolved = await repository.snapshot();
    expect(new Set(evolved.chapters!.chapters.map((entry) => entry.chapterId))).toEqual(new Set(originalIds));
    expect(await repository.readChapter(originalIds[0]!)).toMatchObject({
      status: "healthy",
      content: "这是导入后由作者正式保存的新正文。",
      chapter: { title: "第一章·作者改名", volumeId: createdVolume.volume.volumeId },
    });

    const projectBeforeNewKey = await treeIdentity(projectRoot);
    const sameReceiptNewKeyRequest = await importRequest(data.projectsRoot, data.sourcePath);
    expect(sameReceiptNewKeyRequest.payload.preflightFingerprint).toBe(request.payload.preflightFingerprint);
    const sameReceiptNewKey = await executeIdempotentCommand(
      data.ownerRoot,
      envelope(
        "editable-history-new-key",
        sameReceiptNewKeyRequest,
        "novel-import-idempotency-editable-history-new-key",
      ),
    );
    expect(sameReceiptNewKey.status).toBe("succeeded");
    expect(sameReceiptNewKey.result).toMatchObject({ replayed: true });
    expect(await treeIdentity(projectRoot)).toBe(projectBeforeNewKey);
    expect((await readdir(data.projectsRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name !== ".aicanvas-novel-import-transactions"))
      .toHaveLength(1);

    resetNovelImportPreflightAuthorizationsForTests();
    await rm(data.sourceRoot, { recursive: true, force: true });
    const projectBeforeReplay = await treeIdentity(projectRoot);
    const tokenless: NovelCommandRequest = {
      ...request,
      payload: { ...request.payload, preflightAuthorization: undefined },
    };
    const replay = await executeIdempotentCommand(
      data.ownerRoot,
      envelope("editable-history-replay-b", tokenless, idempotencyKey),
    );
    expect(replay).toMatchObject({ status: "succeeded", replayed: true });
    expect(await treeIdentity(projectRoot)).toBe(projectBeforeReplay);
    expect(await repository.readChapter(originalIds[0]!)).toMatchObject({
      status: "healthy",
      content: "这是导入后由作者正式保存的新正文。",
    });
  });

  it("业务 receipt 可自洽重签时仍必须匹配首次成功账本锚点，降 unknown 后不得被新 proof 覆盖", async () => {
    const data = await fixture("succeeded-ledger-anchor");
    const request = await importRequest(data.projectsRoot, data.sourcePath);
    const idempotencyKey = "novel-import-idempotency-succeeded-ledger-anchor";
    const first = await executeIdempotentCommand(
      data.ownerRoot,
      envelope("succeeded-ledger-anchor-a", request, idempotencyKey),
    );
    expect(first.status).toBe("succeeded");
    const firstLedger = (await listCommandLedger(data.ownerRoot))[0]!;
    expect(firstLedger.novelImportResultAnchor).toMatchObject({
      kind: "novel-import-result-anchor",
      receiptFingerprint: (first.result as { receipt: { fingerprint: string } }).receipt.fingerprint,
    });

    const projectEntry = (await readdir(data.projectsRoot, { withFileTypes: true }))
      .find((entry) => entry.isDirectory() && entry.name !== ".aicanvas-novel-import-transactions");
    expect(projectEntry).toBeDefined();
    const projectRoot = path.join(data.projectsRoot, projectEntry!.name);
    const receiptId = (first.result as { receipt: { receiptId: string } }).receipt.receiptId;
    const receiptPath = path.join(projectRoot, ".aicanvas", "novel", "import-receipts", receiptId, "receipt.json");
    const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as Record<string, unknown>;
    receipt.sourceDisplayName = "另一份安全显示名.md";
    delete receipt.fingerprint;
    receipt.fingerprint = fingerprint(receipt);
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");

    resetNovelImportPreflightAuthorizationsForTests();
    const tokenless: NovelCommandRequest = {
      ...request,
      payload: { ...request.payload, preflightAuthorization: undefined },
    };
    await expect(executeIdempotentCommand(
      data.ownerRoot,
      envelope("succeeded-ledger-anchor-b", tokenless, idempotencyKey),
    )).rejects.toThrow(/账本锚点|闭包漂移|降为 unknown/u);
    const downgraded = (await listCommandLedger(data.ownerRoot))[0]!;
    expect(downgraded.status).toBe("unknown");
    expect(downgraded.result).toBeUndefined();
    expect(downgraded.novelImportResultAnchor).toEqual(firstLedger.novelImportResultAnchor);

    const projectsBeforeNewKey = await treeIdentity(data.projectsRoot);
    const newKeyRequest = await importRequest(data.projectsRoot, data.sourcePath);
    await expect(executeIdempotentCommand(
      data.ownerRoot,
      envelope(
        "succeeded-ledger-anchor-new-key",
        newKeyRequest,
        "novel-import-idempotency-succeeded-ledger-anchor-new-key",
      ),
    )).rejects.toThrow(/账本锚点|历史结果锚点|执行结果未确认/u);
    expect(await treeIdentity(data.projectsRoot)).toBe(projectsBeforeNewKey);
    const afterNewKey = await listCommandLedger(data.ownerRoot);
    const anchored = afterNewKey
      .map((entry) => entry.novelImportResultAnchor)
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
    expect(new Set(anchored.map((entry) => JSON.stringify(entry)))).toHaveLength(1);
    expect(anchored[0]).toEqual(firstLedger.novelImportResultAnchor);

    await expect(executeIdempotentCommand(
      data.ownerRoot,
      envelope("succeeded-ledger-anchor-c", tokenless, idempotencyKey),
    )).rejects.toThrow(/账本锚点|闭包/u);
    expect((await listCommandLedger(data.ownerRoot))
      .find((entry) => entry.idempotencyKey === idempotencyKey)).toMatchObject({
      status: "unknown",
      novelImportResultAnchor: firstLedger.novelImportResultAnchor,
    });
  });

  it("receipt candidate 的 transaction pre-terminal state 缺失时，无 token 不得注册或修补任一镜像", async () => {
    const data = await fixture("transaction-state-missing");
    const request = await importRequest(data.projectsRoot, data.sourcePath);
    const idempotencyKey = "novel-import-idempotency-transaction-state-missing";
    process.env.AI_CANVAS_TEST_NOVEL_IMPORT_INTERRUPT = "receipt_candidate_persisted";
    await expect(executeIdempotentCommand(
      data.ownerRoot,
      envelope("transaction-state-missing-a", request, idempotencyKey),
    )).rejects.toThrow(/执行结果未确认|receipt_candidate_persisted/u);
    delete process.env.AI_CANVAS_TEST_NOVEL_IMPORT_INTERRUPT;
    expect((await listCommandLedger(data.ownerRoot))[0]?.status).toBe("unknown");
    expect(await listRegisteredProjects()).toEqual([]);

    const transactionNamespace = path.join(data.projectsRoot, ".aicanvas-novel-import-transactions");
    const transactionName = (await readdir(transactionNamespace)).find((name) => name.startsWith("novel-import-"));
    expect(transactionName).toBeDefined();
    await rm(path.join(transactionNamespace, transactionName!, "states", "0001-preflighted.json"));

    resetNovelImportPreflightAuthorizationsForTests();
    const projectsBefore = await treeIdentity(data.projectsRoot);
    const appBefore = await treeIdentity(data.appState);
    const tokenless: NovelCommandRequest = {
      ...request,
      payload: { ...request.payload, preflightAuthorization: undefined },
    };
    await expect(executeIdempotentCommand(
      data.ownerRoot,
      envelope("transaction-state-missing-b", tokenless, idempotencyKey),
    )).rejects.toThrow(/保持 unknown|不可变.*不足|未能.*证明完成/u);
    expect(await treeIdentity(data.projectsRoot)).toBe(projectsBefore);
    expect(await treeIdentity(data.appState)).toBe(appBefore);
    expect(await listRegisteredProjects()).toEqual([]);
    expect((await listCommandLedger(data.ownerRoot))[0]?.status).toBe("unknown");
  });

  it("intent 前崩溃留下的严格空 prepared transaction 不阻断新 token/new key 恢复或其他导入", async () => {
    const data = await fixture("empty-prepared-recovery");
    const request = await importRequest(data.projectsRoot, data.sourcePath);
    process.env.AI_CANVAS_TEST_NOVEL_IMPORT_INTERRUPT = "transaction_directory_prepared";
    await expect(executeIdempotentCommand(
      data.ownerRoot,
      envelope("empty-prepared-recovery-a", request),
    )).rejects.toThrow(/执行结果未确认|transaction_directory_prepared/u);
    delete process.env.AI_CANVAS_TEST_NOVEL_IMPORT_INTERRUPT;

    const namespace = path.join(data.projectsRoot, ".aicanvas-novel-import-transactions");
    const prepared = (await readdir(namespace, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory());
    expect(prepared).toHaveLength(1);
    expect(await readdir(path.join(namespace, prepared[0]!.name))).toEqual([]);
    await writeFile(
      path.join(namespace, prepared[0]!.name, `.aicanvas-dirfd-${"e".repeat(32)}.tmp`),
      "crash-leftover",
      "utf8",
    );
    const unrelated = path.join(namespace, `novel-import-${"f".repeat(32)}`);
    await mkdir(unrelated);
    await writeFile(path.join(unrelated, `.aicanvas-dirfd-${"d".repeat(32)}.tmp`), "concurrent-intent", "utf8");

    const resumedRequest = await importRequest(data.projectsRoot, data.sourcePath);
    const resumed = await executeIdempotentCommand(
      data.ownerRoot,
      envelope("empty-prepared-recovery-b", resumedRequest),
    );
    expect(resumed.status).toBe("succeeded");
    expect(resumed.result).not.toHaveProperty("projectRoot");
    expect((await listCommandLedger(data.ownerRoot)).map((entry) => entry.status).sort())
      .toEqual(["succeeded", "unknown"]);
  });

  it("其余 novel 命令仍拒绝普通 projectsRoot，且不会把它接管成受管工程", async () => {
    const data = await fixture("legacy-gate");
    const before = await treeIdentity(data.projectsRoot);
    await expect(executeIdempotentCommand(data.projectsRoot, envelope("ordinary-unmanaged", {
      command: "novel_initialize_manuscript",
      payload: { sourceMode: "managed_markdown" },
    }))).rejects.toThrow(/schema v2 novel\/hybrid/u);
    expect(await treeIdentity(data.projectsRoot)).toBe(before);
    expect(await exists(path.join(data.projectsRoot, ".aicanvas"))).toBe(false);
  });
});
