import { createHash, randomUUID } from "node:crypto";
import { copyFile, link, lstat, mkdtemp, mkdir, readFile, readdir, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  commitNovelExternalImport as commitNovelExternalImportCore,
  proveCompletedNovelExternalImport,
  type CommitNovelExternalImportInput,
  setNovelImportCopyHookForTests,
} from "../src/core/novel-import-commit.js";
import {
  createAuthorizedNovelImportPreflight,
  reserveNovelImportPreflightAuthorization,
  resetNovelImportPreflightAuthorizationsForTests,
} from "../src/core/novel-import.js";
import { NOVEL_IMPORT_CHAPTER_SPLIT_ALGORITHM } from "../src/core/novel-types.js";
import { NovelRepository } from "../src/core/novel-manuscript.js";
import { runWithOperationContext } from "../src/core/operation-context.js";
import { listRegisteredProjects } from "../src/core/sidecar.js";

const roots: string[] = [];
const require = createRequire(import.meta.url);

function hash(value: Buffer | string): string {
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
  return hash(JSON.stringify(stableValue(value)));
}

function absoluteStrings(value: unknown, output: string[] = []): string[] {
  if (typeof value === "string" && (path.isAbsolute(value) || path.win32.isAbsolute(value))) output.push(value);
  else if (Array.isArray(value)) value.forEach((entry) => absoluteStrings(entry, output));
  else if (value && typeof value === "object") Object.values(value as Record<string, unknown>)
    .forEach((entry) => absoluteStrings(entry, output));
  return output;
}

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(await realpath(os.tmpdir()), "ai-canvas-novel-import-commit-")));
  roots.push(root);
  const projectsRoot = path.join(root, "projects");
  const sourceRoot = path.join(root, "source");
  await mkdir(projectsRoot);
  await mkdir(sourceRoot);
  return { root, projectsRoot, sourceRoot };
}

async function treeIdentity(root: string): Promise<string> {
  const entries = (await readdir(root, { recursive: true })).map(String).sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  const rows = [];
  for (const relative of entries) {
    const absolute = path.join(root, relative);
    const metadata = await lstat(absolute);
    rows.push({
      relative: relative.split(path.sep).join("/"),
      kind: metadata.isDirectory() ? "directory" : metadata.isFile() ? "file" : "other",
      size: metadata.size,
      sha256: metadata.isFile() ? hash(await readFile(absolute)) : null,
    });
  }
  return hash(`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

function importContext<T>(work: () => Promise<T>): Promise<T> {
  return runWithOperationContext({
    requestId: "novel-import-request-0001",
    idempotencyKey: "novel-import-idempotency-0001",
    requestHash: hash("novel-import-fixed-request"),
    command: "novel_import_external_snapshot",
  }, work);
}

async function commitNovelExternalImport(input: CommitNovelExternalImportInput) {
  if (typeof input.preflightAuthorization === "string") {
    reserveNovelImportPreflightAuthorization(
      input.preflightAuthorization,
      hash("novel-import-fixed-request"),
    );
  }
  return commitNovelExternalImportCore(input);
}

async function authorizedPreflight(sourcePath: string) {
  const result = await createAuthorizedNovelImportPreflight(sourcePath);
  expect(result.authorization).not.toBeNull();
  return {
    preflight: result.preflight,
    authorizationId: result.authorization!.authorizationId,
    expiresAt: result.authorization!.expiresAt,
    identity: {
      preflightId: result.preflight.preflightId,
      preflightFingerprint: result.preflight.fingerprint,
      sourceTreeAggregateSha256: result.preflight.sourceTreeAggregateSha256,
    },
  };
}

afterEach(async () => {
  vi.useRealTimers();
  delete process.env.AI_CANVAS_TEST_NOVEL_IMPORT_INTERRUPT;
  setNovelImportCopyHookForTests(null);
  resetNovelImportPreflightAuthorizationsForTests();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("novel external import transaction", () => {
  it("以 raw CAS、staging 和整目录原子发布导入 Markdown，注册最后发生且重放幂等", async () => {
    const { projectsRoot, sourceRoot } = await fixture();
    await writeFile(path.join(sourceRoot, "第一卷.md"), [
      "# 第一章 神落",
      "阿航在雾河岸醒来。",
      "",
      "# 第二章 祭坛",
      "完整黄金面具在黑雨中发光。",
    ].join("\n"), "utf8");
    await writeFile(path.join(sourceRoot, "第二卷.txt"), "第三章 入梦\n青铜神树记住了他的名字。", "utf8");
    const sourceBefore = await treeIdentity(sourceRoot);
    const issued = await authorizedPreflight(sourceRoot);
    const { preflight, authorizationId } = issued;
    expect(preflight).toMatchObject({ eligible: true, summary: { supportedFiles: 2, chapterCount: 3 } });

    const first = await importContext(() => commitNovelExternalImport({
      projectsRoot,
      projectName: "古蜀十三相·导入副本",
      ...issued.identity,
      preflightAuthorization: authorizationId,
      duplicateResolution: "include_all",
      convertToManagedMarkdown: true,
    }));
    expect(first.replayed).toBe(false);
    expect(first.receipt.chapterSplitAlgorithm).toBe(NOVEL_IMPORT_CHAPTER_SPLIT_ALGORITHM);
    expect(first.receipt.converter.chapterSplitAlgorithm).toBe(NOVEL_IMPORT_CHAPTER_SPLIT_ALGORITHM);
    expect(first.receipt.duplicateResolution).toBe("include_all");
    expect(first.receipt.chapters).toHaveLength(3);
    expect(first.receipt.sourceObjects).toHaveLength(2);
    expect(await treeIdentity(sourceRoot)).toBe(sourceBefore);
    expect((await listRegisteredProjects()).some((entry) => entry.id === first.receipt.projectId
      && path.resolve(entry.primaryRoot) === first.projectRoot)).toBe(true);

    const transactionRoot = path.join(projectsRoot, ".aicanvas-novel-import-transactions", first.receipt.receiptId);
    const allocation = JSON.parse(await readFile(path.join(transactionRoot, "allocation.json"), "utf8")) as Record<string, unknown>;
    expect(allocation).toMatchObject({
      kind: "novel-import-project-allocation",
      projectDirectoryName: path.basename(first.projectRoot),
      projectId: first.receipt.projectId,
    });
    expect(allocation).not.toHaveProperty("projectRoot");
    expect(absoluteStrings(allocation)).toEqual([]);

    const repository = new NovelRepository(first.projectRoot);
    const snapshot = await repository.snapshot();
    expect(snapshot.workspace.sourceReceiptIds).toEqual([first.receipt.receiptId]);
    expect(snapshot.chapters?.chapters).toHaveLength(3);
    const chapterIds = snapshot.chapters!.chapters.map((chapter) => chapter.chapterId);
    for (const chapterId of chapterIds) expect((await repository.readChapter(chapterId)).status).toBe("healthy");

    const replay = await importContext(() => commitNovelExternalImport({
      projectsRoot,
      projectName: "古蜀十三相·导入副本",
      ...issued.identity,
      preflightAuthorization: authorizationId,
      duplicateResolution: "include_all",
      convertToManagedMarkdown: true,
    }));
    expect(replay.replayed).toBe(true);
    expect(replay.projectRoot).toBe(first.projectRoot);
    expect(replay.receipt.fingerprint).toBe(first.receipt.fingerprint);
    expect((await new NovelRepository(replay.projectRoot).snapshot()).chapters?.chapters.map((chapter) => chapter.chapterId))
      .toEqual(chapterIds);
    expect(await treeIdentity(sourceRoot)).toBe(sourceBefore);
  });

  it("completed closure 对章节使用单次 manifest snapshot 与 O(N) map，不逐章重读 manifest", async () => {
    const { projectsRoot, sourceRoot } = await fixture();
    const chapterCount = 200;
    await writeFile(
      path.join(sourceRoot, "many.md"),
      Array.from({ length: chapterCount }, (_, index) => `# 第${index + 1}章\n这是编号 ${index + 1} 的唯一正文。`).join("\n\n"),
      "utf8",
    );
    const issued = await authorizedPreflight(sourceRoot);
    const first = await importContext(() => commitNovelExternalImport({
      projectsRoot,
      projectName: "closure-linear-shape",
      ...issued.identity,
      preflightAuthorization: issued.authorizationId,
      duplicateResolution: "include_all",
      convertToManagedMarkdown: true,
    }));
    expect(first.receipt.chapters).toHaveLength(chapterCount);

    const snapshotSpy = vi.spyOn(NovelRepository.prototype, "snapshot");
    const readChapterSpy = vi.spyOn(NovelRepository.prototype, "readChapter");
    const proof = await proveCompletedNovelExternalImport({
      projectsRoot,
      projectName: "closure-linear-shape",
      ...issued.identity,
      duplicateResolution: "include_all",
      convertToManagedMarkdown: true,
    }, hash("novel-import-fixed-request"));
    expect(proof?.receipt.chapters).toHaveLength(chapterCount);
    expect(snapshotSpy).toHaveBeenCalledTimes(1);
    expect(readChapterSpy).not.toHaveBeenCalled();
    snapshotSpy.mockRestore();
    readChapterSpy.mockRestore();
    // 200 章导入 + completed closure 证明在 fast 分区并行负载下可能超过默认 30s；
    // 断言合同不变，只显式放宽本用例时限（wq-0004 有界修复）。
  }, 120_000);

  it.each(["source_objects_copied", "atomically_published", "registered"] as const)(
    "在 %s 状态中断后只向前恢复，中断前不会提前注册",
    async (phase) => {
      const { projectsRoot, sourceRoot } = await fixture();
      await writeFile(path.join(sourceRoot, "book.md"), "# 第一章\n本地导入事务。", "utf8");
      const issued = await authorizedPreflight(sourceRoot);
      const { authorizationId } = issued;
      process.env.AI_CANVAS_TEST_NOVEL_IMPORT_INTERRUPT = phase;
      await expect(importContext(() => commitNovelExternalImport({
        projectsRoot,
        projectName: `恢复-${phase}`,
        ...issued.identity,
        preflightAuthorization: authorizationId,
        duplicateResolution: "include_all",
        convertToManagedMarkdown: true,
      }))).rejects.toThrow(`test-only novel import interruption: ${phase}`);
      const beforeRecovery = await listRegisteredProjects();
      if (phase !== "registered") {
        expect(beforeRecovery.some((entry) => path.dirname(path.resolve(entry.primaryRoot)) === projectsRoot)).toBe(false);
      }
      delete process.env.AI_CANVAS_TEST_NOVEL_IMPORT_INTERRUPT;

      // 模拟进程崩溃丢失 capability。registered 中断发生在注册成功、terminal
      // marker 写入前；此时即使来源被删除，也必须只靠 registration 前已闭合的
      // receipt/source objects/manuscript 向前完成，且不能创建第二工程。
      resetNovelImportPreflightAuthorizationsForTests();
      const recoveryAuthorization = phase === "registered" ? null : await authorizedPreflight(sourceRoot);
      if (phase === "registered") await rm(sourceRoot, { recursive: true, force: true });
      const recovered = await importContext(() => commitNovelExternalImport({
        projectsRoot,
        projectName: `恢复-${phase}`,
        ...issued.identity,
        ...(recoveryAuthorization ? { preflightAuthorization: recoveryAuthorization.authorizationId } : {}),
        duplicateResolution: "include_all",
        convertToManagedMarkdown: true,
      }));
      if (phase === "registered") expect(recovered.replayed).toBe(true);
      expect(recovered.receipt.chapters).toHaveLength(1);
      expect((await new NovelRepository(recovered.projectRoot).readChapter(recovered.receipt.chapters[0]!.chapterId)).status)
        .toBe("healthy");
      expect((await listRegisteredProjects()).filter((entry) => entry.id === recovered.receipt.projectId)).toHaveLength(1);
      const projectDirectories = (await readdir(projectsRoot, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && entry.name !== ".aicanvas-novel-import-transactions");
      expect(projectDirectories).toHaveLength(1);
    },
  );

  it("来源在预检后变化时于 transaction/项目写入前失败关闭", async () => {
    const { projectsRoot, sourceRoot } = await fixture();
    const source = path.join(sourceRoot, "book.md");
    await writeFile(source, "# 第一章\n原始正文。", "utf8");
    const issued = await authorizedPreflight(sourceRoot);
    const { authorizationId } = issued;
    await writeFile(source, "# 第一章\n已经被外部修改。", "utf8");

    await expect(importContext(() => commitNovelExternalImport({
      projectsRoot,
      projectName: "不得创建",
      ...issued.identity,
      preflightAuthorization: authorizationId,
      duplicateResolution: "include_all",
      convertToManagedMarkdown: true,
    }))).rejects.toThrow(/预检后已变化/u);
    await expect(lstat(path.join(projectsRoot, ".aicanvas-novel-import-transactions")))
      .rejects.toMatchObject({ code: "ENOENT" });
    expect((await listRegisteredProjects()).some((entry) => entry.name === "不得创建")).toBe(false);
  });

  it.each([
    ["requestHash", hash("forged-import-request")],
    ["projectSlug", "novel-forged-project-slug"],
    ["preflightId", `novel-preflight-${"f".repeat(24)}`],
    ["convertToManagedMarkdown", false],
    ["sourceProjectsDisjoint", false],
  ] as const)("既有 transaction intent 的稳定字段 %s 被改写时零写拒绝重放", async (field, forgedValue) => {
    const { projectsRoot, sourceRoot } = await fixture();
    await writeFile(path.join(sourceRoot, "book.md"), "# 第一章\nintent 必须完整绑定请求。", "utf8");
    const issued = await authorizedPreflight(sourceRoot);
    const input = {
      projectsRoot,
      projectName: `intent-bind-${field}`,
      ...issued.identity,
      preflightAuthorization: issued.authorizationId,
      duplicateResolution: "include_all" as const,
      convertToManagedMarkdown: true as const,
    };
    process.env.AI_CANVAS_TEST_NOVEL_IMPORT_INTERRUPT = "preflighted";
    await expect(importContext(() => commitNovelExternalImport(input)))
      .rejects.toThrow(/test-only novel import interruption: preflighted/u);
    delete process.env.AI_CANVAS_TEST_NOVEL_IMPORT_INTERRUPT;

    const namespace = path.join(projectsRoot, ".aicanvas-novel-import-transactions");
    const transactions = (await readdir(namespace, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory());
    expect(transactions).toHaveLength(1);
    const intentPath = path.join(namespace, transactions[0]!.name, "intent.json");
    const intent = JSON.parse(await readFile(intentPath, "utf8")) as Record<string, unknown>;
    const semantic = { ...intent, [field]: forgedValue };
    delete semantic.fingerprint;
    await writeFile(intentPath, `${JSON.stringify({
      ...semantic,
      fingerprint: fingerprint(semantic),
    }, null, 2)}\n`, "utf8");
    const beforeRetry = await treeIdentity(projectsRoot);

    await expect(importContext(() => commitNovelExternalImport(input)))
      .rejects.toThrow(/transaction intent 结构无效|既有小说导入 transaction 与本次请求不一致|确定性小说导入 transaction 与本次 operation 身份不一致/u);
    expect(await treeIdentity(projectsRoot)).toBe(beforeRetry);
  });

  it("单文件来源与 projectsRoot 同父目录时允许导入，且来源保持零写", async () => {
    const { root, projectsRoot } = await fixture();
    const sourcePath = path.join(root, "同级单文件.md");
    await writeFile(sourcePath, "# 第一章\n同父目录不等于路径重叠。", "utf8");
    const sourceBefore = hash(await readFile(sourcePath));
    const issued = await authorizedPreflight(sourcePath);

    const result = await importContext(() => commitNovelExternalImport({
      projectsRoot,
      projectName: "同级单文件导入",
      ...issued.identity,
      preflightAuthorization: issued.authorizationId,
      duplicateResolution: "include_all",
      convertToManagedMarkdown: true,
    }));

    expect(result.receipt.chapters).toHaveLength(1);
    expect(hash(await readFile(sourcePath))).toBe(sourceBefore);
    expect((await new NovelRepository(result.projectRoot).readChapter(result.receipt.chapters[0]!.chapterId)).status)
      .toBe("healthy");
  });

  it("pre-terminal state 的 factsFingerprint 即使双镜像同字节重签也不能脱离真实闭包", async () => {
    const { projectsRoot, sourceRoot } = await fixture();
    await writeFile(path.join(sourceRoot, "book.md"), "# 第一章\nstate facts 必须可重算。", "utf8");
    const issued = await authorizedPreflight(sourceRoot);
    const first = await importContext(() => commitNovelExternalImport({
      projectsRoot,
      projectName: "state-facts-recompute",
      ...issued.identity,
      preflightAuthorization: issued.authorizationId,
      duplicateResolution: "include_all",
      convertToManagedMarkdown: true,
    }));
    const transactionState = path.join(
      projectsRoot,
      ".aicanvas-novel-import-transactions",
      first.receipt.receiptId,
      "states",
      "0001-preflighted.json",
    );
    const projectState = path.join(
      first.projectRoot,
      ".aicanvas",
      "novel",
      "import-receipts",
      first.receipt.receiptId,
      "states",
      "0001-preflighted.json",
    );
    const state = JSON.parse(await readFile(transactionState, "utf8")) as Record<string, unknown>;
    state.factsFingerprint = "f".repeat(64);
    delete state.fingerprint;
    state.fingerprint = fingerprint(state);
    const bytes = `${JSON.stringify(state, null, 2)}\n`;
    await writeFile(transactionState, bytes, "utf8");
    await writeFile(projectState, bytes, "utf8");

    await expect(proveCompletedNovelExternalImport({
      projectsRoot,
      projectName: "state-facts-recompute",
      ...issued.identity,
      duplicateResolution: "include_all",
      convertToManagedMarkdown: true,
    }, hash("novel-import-fixed-request"))).rejects.toThrow(/state facts.*业务闭包/u);
  });

  it.each([
    "same-root-directory",
    "projects-root-inside-source",
    "source-root-inside-projects",
    "single-file-inside-projects",
  ] as const)("projectsRoot/source 重叠 %s 在任何业务写入前失败关闭", async (relation) => {
    const { root, projectsRoot: fixtureProjectsRoot } = await fixture();
    let projectsRoot = fixtureProjectsRoot;
    let sourcePath: string;
    let sourceBoundary: string;

    if (relation === "same-root-directory") {
      sourceBoundary = projectsRoot;
      sourcePath = projectsRoot;
      await writeFile(path.join(projectsRoot, "book.md"), "# 第一章\n同根不得导入。", "utf8");
    } else if (relation === "projects-root-inside-source") {
      sourceBoundary = path.join(root, "overlap-source");
      projectsRoot = path.join(sourceBoundary, "projects");
      sourcePath = sourceBoundary;
      await mkdir(projectsRoot, { recursive: true });
      await writeFile(path.join(sourceBoundary, "book.md"), "# 第一章\n目标位于来源树内。", "utf8");
      await writeFile(path.join(projectsRoot, "destination-sentinel.bin"), "destination-must-stay", "utf8");
    } else if (relation === "source-root-inside-projects") {
      sourceBoundary = path.join(projectsRoot, "overlap-source");
      sourcePath = sourceBoundary;
      await mkdir(sourceBoundary);
      await writeFile(path.join(sourceBoundary, "book.md"), "# 第一章\n来源位于目标树内。", "utf8");
    } else {
      sourceBoundary = projectsRoot;
      sourcePath = path.join(projectsRoot, "single.md");
      await writeFile(sourcePath, "# 第一章\n单文件来源也不得与目标树重叠。", "utf8");
    }
    const sentinel = path.join(sourceBoundary, "source-sentinel.txt");
    await writeFile(sentinel, "source-must-stay", "utf8");
    const issued = await authorizedPreflight(sourcePath);
    const observedRoots = [...new Set([projectsRoot, sourceBoundary])];
    const before = await Promise.all(observedRoots.map(treeIdentity));

    await expect(importContext(() => commitNovelExternalImport({
      projectsRoot,
      projectName: `路径重叠-${relation}`,
      ...issued.identity,
      preflightAuthorization: issued.authorizationId,
      duplicateResolution: "include_all",
      convertToManagedMarkdown: true,
    }))).rejects.toThrow(/projectsRoot .*来源路径.*不得/u);

    expect(await Promise.all(observedRoots.map(treeIdentity))).toEqual(before);
    expect(await readFile(sentinel, "utf8")).toBe("source-must-stay");
    await expect(lstat(path.join(projectsRoot, ".aicanvas-novel-import-transactions")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("把 DOCX 原始包放入 CAS 后再在隔离 worker 中转换", async () => {
    const { projectsRoot, sourceRoot } = await fixture();
    const mammothEntry = require.resolve("mammoth");
    const mammothRoot = mammothEntry.slice(0, mammothEntry.lastIndexOf(`${path.sep}lib${path.sep}`));
    const source = path.join(sourceRoot, "sample.docx");
    await copyFile(path.join(mammothRoot, "test", "test-data", "single-paragraph.docx"), source);
    const issued = await authorizedPreflight(source);
    const { authorizationId } = issued;

    const result = await importContext(() => commitNovelExternalImport({
      projectsRoot,
      projectName: "DOCX 导入",
      ...issued.identity,
      preflightAuthorization: authorizationId,
      duplicateResolution: "include_all",
      convertToManagedMarkdown: true,
    }));
    expect(result.receipt.converter.docx).toEqual({ library: "mammoth", isolated: true });
    const object = result.receipt.sourceObjects[0]!;
    expect(await readFile(path.join(result.projectRoot, ...object.objectRelativePath.split("/"))))
      .toEqual(await readFile(source));
    expect((await new NovelRepository(result.projectRoot).readChapter(result.receipt.chapters[0]!.chapterId)).status)
      .toBe("healthy");
  });

  it("没有显式转换确认时在任何写入前拒绝", async () => {
    const { projectsRoot, sourceRoot } = await fixture();
    await writeFile(path.join(sourceRoot, "book.md"), "# 第一章\n正文。", "utf8");
    const issued = await authorizedPreflight(sourceRoot);
    const { authorizationId } = issued;
    await expect(importContext(() => commitNovelExternalImport({
      projectsRoot,
      projectName: "未确认",
      ...issued.identity,
      preflightAuthorization: authorizationId,
      duplicateResolution: "include_all",
      convertToManagedMarkdown: false,
    } as never))).rejects.toThrow(/convertToManagedMarkdown=true/u);
    expect(await readdir(projectsRoot)).toEqual([]);
  });

  it("非 novel_import_external_snapshot operation context 不得调用 Core commit", async () => {
    const { projectsRoot, sourceRoot } = await fixture();
    await writeFile(path.join(sourceRoot, "book.md"), "# 第一章\n错误命令上下文不得导入。", "utf8");
    const issued = await authorizedPreflight(sourceRoot);

    await expect(runWithOperationContext({
      requestId: "wrong-command-context-request",
      idempotencyKey: "wrong-command-context-idempotency",
      requestHash: hash("wrong-command-context"),
      command: "novel_save_chapter",
    }, () => commitNovelExternalImport({
      projectsRoot,
      projectName: "错误命令上下文",
      ...issued.identity,
      preflightAuthorization: issued.authorizationId,
      duplicateResolution: "include_all",
      convertToManagedMarkdown: true,
    }))).rejects.toThrow(/novel command operation context/u);
    expect(await readdir(projectsRoot)).toEqual([]);
  });

  it("POSIX 来源目录名含反斜杠时在写入前确定性转义 display name", async () => {
    const { root, projectsRoot } = await fixture();
    const escapedSourceRoot = path.join(root, "来源\\目录");
    await mkdir(escapedSourceRoot);
    await writeFile(path.join(escapedSourceRoot, "book.md"), "# 第一章\n合法 POSIX 路径。", "utf8");
    const issued = await authorizedPreflight(escapedSourceRoot);

    const result = await importContext(() => commitNovelExternalImport({
      projectsRoot,
      projectName: "反斜杠来源名",
      ...issued.identity,
      preflightAuthorization: issued.authorizationId,
      duplicateResolution: "include_all",
      convertToManagedMarkdown: true,
    }));

    expect(result.receipt.sourceDisplayName).toBe("来源＿目录");
    expect(result.receipt.sourceDisplayName).not.toMatch(/[\\/]/u);
  });

  it("已完成回执在来源删除且进程授权丢失后仍可由不可变闭包幂等重放", async () => {
    const { projectsRoot, sourceRoot } = await fixture();
    await writeFile(path.join(sourceRoot, "book.md"), "# 第一章\n响应丢失后仍可重放。", "utf8");
    const issued = await authorizedPreflight(sourceRoot);
    const first = await importContext(() => commitNovelExternalImport({
      projectsRoot,
      projectName: "无源幂等重放",
      ...issued.identity,
      preflightAuthorization: issued.authorizationId,
      duplicateResolution: "include_all",
      convertToManagedMarkdown: true,
    }));
    resetNovelImportPreflightAuthorizationsForTests();
    await rm(sourceRoot, { recursive: true, force: true });

    const replay = await importContext(() => commitNovelExternalImport({
      projectsRoot,
      projectName: "无源幂等重放",
      ...issued.identity,
      duplicateResolution: "include_all",
      convertToManagedMarkdown: true,
    }));
    expect(replay).toMatchObject({ replayed: true, projectRoot: first.projectRoot });
    expect(replay.receipt.fingerprint).toBe(first.receipt.fingerprint);
  });

  it("无源重放会完整验证 source object 闭包，篡改后失败关闭", async () => {
    const { projectsRoot, sourceRoot } = await fixture();
    await writeFile(path.join(sourceRoot, "book.md"), "# 第一章\n不可变对象。", "utf8");
    const issued = await authorizedPreflight(sourceRoot);
    const first = await importContext(() => commitNovelExternalImport({
      projectsRoot,
      projectName: "闭包篡改拒绝",
      ...issued.identity,
      preflightAuthorization: issued.authorizationId,
      duplicateResolution: "include_all",
      convertToManagedMarkdown: true,
    }));
    const object = first.receipt.sourceObjects[0]!;
    await writeFile(path.join(first.projectRoot, ...object.objectRelativePath.split("/")), "tampered", "utf8");
    resetNovelImportPreflightAuthorizationsForTests();
    await rm(sourceRoot, { recursive: true, force: true });

    await expect(importContext(() => commitNovelExternalImport({
      projectsRoot,
      projectName: "闭包篡改拒绝",
      ...issued.identity,
      duplicateResolution: "include_all",
      convertToManagedMarkdown: true,
    }))).rejects.toThrow(/source object 闭包/u);
  });

  it.each(["top-extra", "nested-extra", "committed-at"] as const)(
    "完成重放拒绝可重签 fingerprint 的非规范 receipt：%s",
    async (mutation) => {
      const { projectsRoot, sourceRoot } = await fixture();
      await writeFile(path.join(sourceRoot, "book.md"), "# 第一章\nreceipt 严格闭包。", "utf8");
      const issued = await authorizedPreflight(sourceRoot);
      const first = await importContext(() => commitNovelExternalImport({
        projectsRoot,
        projectName: `receipt-exact-${mutation}`,
        ...issued.identity,
        preflightAuthorization: issued.authorizationId,
        duplicateResolution: "include_all",
        convertToManagedMarkdown: true,
      }));
      const receiptPath = path.join(
        first.projectRoot,
        ".aicanvas",
        "novel",
        "import-receipts",
        first.receipt.receiptId,
        "receipt.json",
      );
      const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as Record<string, unknown>;
      if (mutation === "top-extra") receipt.sourcePath = "/tmp/不得进入 receipt";
      if (mutation === "nested-extra") {
        (receipt.sourceObjects as Array<Record<string, unknown>>)[0]!.preflightAuthorization = "不得持久化";
      }
      if (mutation === "committed-at") receipt.committedAt = new Date(Date.parse(String(receipt.committedAt)) + 1).toISOString();
      delete receipt.fingerprint;
      receipt.fingerprint = fingerprint(receipt);
      await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
      resetNovelImportPreflightAuthorizationsForTests();

      await expect(importContext(() => commitNovelExternalImport({
        projectsRoot,
        projectName: `receipt-exact-${mutation}`,
        ...issued.identity,
        duplicateResolution: "include_all",
        convertToManagedMarkdown: true,
      }))).rejects.toThrow(mutation === "committed-at" ? /intent\/allocation\/receipt 绑定/u : /未支持字段/u);
    },
  );

  it.each(["receipt", "source-object"] as const)(
    "完成重放拒绝由项目外 inode 硬链接替换的 %s",
    async (targetKind) => {
      const { root, projectsRoot, sourceRoot } = await fixture();
      await writeFile(path.join(sourceRoot, "book.md"), "# 第一章\n单链接闭包。", "utf8");
      const issued = await authorizedPreflight(sourceRoot);
      const first = await importContext(() => commitNovelExternalImport({
        projectsRoot,
        projectName: `硬链接闭包-${targetKind}`,
        ...issued.identity,
        preflightAuthorization: issued.authorizationId,
        duplicateResolution: "include_all",
        convertToManagedMarkdown: true,
      }));
      const targetPath = targetKind === "receipt"
        ? path.join(first.projectRoot, ".aicanvas", "novel", "import-receipts", first.receipt.receiptId, "receipt.json")
        : path.join(first.projectRoot, ...first.receipt.sourceObjects[0]!.objectRelativePath.split("/"));
      const outsidePath = path.join(root, `outside-${targetKind}.bin`);
      await copyFile(targetPath, outsidePath);
      await unlink(targetPath);
      await link(outsidePath, targetPath);
      expect((await lstat(targetPath)).nlink).toBe(2);
      resetNovelImportPreflightAuthorizationsForTests();

      await expect(importContext(() => commitNovelExternalImport({
        projectsRoot,
        projectName: `硬链接闭包-${targetKind}`,
        ...issued.identity,
        duplicateResolution: "include_all",
        convertToManagedMarkdown: true,
      }))).rejects.toThrow(/单链接普通文件/u);
    },
  );

  it("只接受服务端进程内 opaque authorization，伪造或过期 token 在写入前失败关闭", async () => {
    const { projectsRoot, sourceRoot } = await fixture();
    await writeFile(path.join(sourceRoot, "book.md"), "# 第一章\n正文。", "utf8");
    const issued = await authorizedPreflight(sourceRoot);

    await expect(importContext(() => commitNovelExternalImport({
      projectsRoot,
      projectName: "伪造授权",
      ...issued.identity,
      preflightAuthorization: `novel-preflight-auth-${"A".repeat(43)}`,
      duplicateResolution: "include_all",
      convertToManagedMarkdown: true,
      preflight: issued.preflight,
    } as never))).rejects.toThrow(/授权无效或已失效/u);

    await expect(importContext(() => commitNovelExternalImport({
      projectsRoot,
      projectName: "未选重复策略",
      ...issued.identity,
      preflightAuthorization: issued.authorizationId,
      convertToManagedMarkdown: true,
    } as never))).rejects.toThrow(/必须显式选择/u);

    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.parse(issued.expiresAt) + 1);
      await expect(importContext(() => commitNovelExternalImport({
        projectsRoot,
        projectName: "过期授权",
        ...issued.identity,
        preflightAuthorization: issued.authorizationId,
        duplicateResolution: "include_all",
        convertToManagedMarkdown: true,
      }))).rejects.toThrow(/授权无效或已失效/u);
    } finally {
      vi.useRealTimers();
    }

    expect(await readdir(projectsRoot)).toEqual([]);
  });

  it("写前 reservation 钉住 requestHash：原授权 TTL 后仍可 claim，错 hash 在业务写前拒绝", async () => {
    const valid = await fixture();
    await writeFile(path.join(valid.sourceRoot, "book.md"), "# 第一章\nreservation 正文。", "utf8");
    const issued = await authorizedPreflight(valid.sourceRoot);
    reserveNovelImportPreflightAuthorization(
      issued.authorizationId,
      hash("novel-import-fixed-request"),
    );
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.parse(issued.expiresAt) + 1);
      await expect(importContext(() => commitNovelExternalImportCore({
        projectsRoot: valid.projectsRoot,
        projectName: "reservation TTL claim",
        ...issued.identity,
        preflightAuthorization: issued.authorizationId,
        duplicateResolution: "include_all",
        convertToManagedMarkdown: true,
      }))).resolves.toMatchObject({ replayed: false });
    } finally {
      vi.useRealTimers();
    }

    const mismatch = await fixture();
    await writeFile(path.join(mismatch.sourceRoot, "book.md"), "# 第一章\n错 hash。", "utf8");
    const mismatchIssued = await authorizedPreflight(mismatch.sourceRoot);
    reserveNovelImportPreflightAuthorization(
      mismatchIssued.authorizationId,
      hash("another-command-request"),
    );
    await expect(importContext(() => commitNovelExternalImportCore({
      projectsRoot: mismatch.projectsRoot,
      projectName: "reservation hash mismatch",
      ...mismatchIssued.identity,
      preflightAuthorization: mismatchIssued.authorizationId,
      duplicateResolution: "include_all",
      convertToManagedMarkdown: true,
    }))).rejects.toThrow(/reservation|requestHash/u);
    expect(await readdir(mismatch.projectsRoot)).toEqual([]);
  });

  it.each(["preflightId", "preflightFingerprint", "sourceTreeAggregateSha256"] as const)(
    "稳定预检身份 %s 伪造时在业务写入前拒绝",
    async (field) => {
      const { projectsRoot, sourceRoot } = await fixture();
      await writeFile(path.join(sourceRoot, "book.md"), "# 第一章\n预检身份不可伪造。", "utf8");
      const issued = await authorizedPreflight(sourceRoot);
      const forged = {
        ...issued.identity,
        [field]: field === "preflightId"
          ? `novel-preflight-${"0".repeat(24)}`
          : "0".repeat(64),
      };

      await expect(importContext(() => commitNovelExternalImport({
        projectsRoot,
        projectName: `伪造稳定身份-${field}`,
        ...forged,
        preflightAuthorization: issued.authorizationId,
        duplicateResolution: "include_all",
        convertToManagedMarkdown: true,
      }))).rejects.toThrow(/稳定预检身份.*authorization 不一致/u);
      expect(await readdir(projectsRoot)).toEqual([]);
    },
  );

  it("对精确重复文件显式执行 include_all 或 skip_later_exact_duplicates", async () => {
    const { projectsRoot, sourceRoot } = await fixture();
    const content = "# 第一章\n同一份正文。";
    await writeFile(path.join(sourceRoot, "a.md"), content, "utf8");
    await writeFile(path.join(sourceRoot, "b.md"), content, "utf8");
    const includeAuthorization = await authorizedPreflight(sourceRoot);
    expect(includeAuthorization.preflight.summary.duplicateFiles).toBe(1);
    const includeAll = await importContext(() => commitNovelExternalImport({
      projectsRoot,
      projectName: "重复全部保留",
      ...includeAuthorization.identity,
      preflightAuthorization: includeAuthorization.authorizationId,
      duplicateResolution: "include_all",
      convertToManagedMarkdown: true,
    }));
    expect(includeAll.receipt).toMatchObject({
      duplicateResolution: "include_all",
      skippedDuplicateSourcePaths: [],
    });
    expect(includeAll.receipt.sourceObjects).toHaveLength(2);
    expect(includeAll.receipt.chapters).toHaveLength(2);

    const skipAuthorization = await authorizedPreflight(sourceRoot);
    const skipLater = await importContext(() => commitNovelExternalImport({
      projectsRoot,
      projectName: "重复跳过后者",
      ...skipAuthorization.identity,
      preflightAuthorization: skipAuthorization.authorizationId,
      duplicateResolution: "skip_later_exact_duplicates",
      convertToManagedMarkdown: true,
    }));
    expect(skipLater.receipt).toMatchObject({
      duplicateResolution: "skip_later_exact_duplicates",
      skippedDuplicateSourcePaths: ["b.md"],
    });
    expect(skipLater.receipt.sourceObjects).toHaveLength(1);
    expect(skipLater.receipt.chapters).toHaveLength(1);
  });

  it.each(["nested-unsupported", "copied-sibling"] as const)(
    "CAS 复制期 %s 变化会在发布前失败且不注册",
    async (mutationKind) => {
      const { projectsRoot, sourceRoot } = await fixture();
      await mkdir(path.join(sourceRoot, "nested"));
      const copiedSource = path.join(sourceRoot, "a.md");
      const unsupported = path.join(sourceRoot, "nested", "notes.bin");
      await writeFile(copiedSource, "# 第一章\n正文 A。", "utf8");
      await writeFile(path.join(sourceRoot, "b.md"), "# 第二章\n正文 B。", "utf8");
      await writeFile(unsupported, "ignored-v1", "utf8");
      const issued = await authorizedPreflight(sourceRoot);
      let mutated = false;
      setNovelImportCopyHookForTests(async (event) => {
        if (mutated || event.copiedSourceObjects !== 1) return;
        mutated = true;
        await writeFile(mutationKind === "nested-unsupported" ? unsupported : copiedSource,
          mutationKind === "nested-unsupported" ? "ignored-v2" : "# 第一章\n复制后外部修改。", "utf8");
      });

      await expect(importContext(() => commitNovelExternalImport({
        projectsRoot,
        projectName: `复制期变化-${mutationKind}`,
        ...issued.identity,
        preflightAuthorization: issued.authorizationId,
        duplicateResolution: "include_all",
        convertToManagedMarkdown: true,
      }))).rejects.toThrow(/变化/u);
      setNovelImportCopyHookForTests(null);
      expect(mutated).toBe(true);
      expect((await listRegisteredProjects()).some((entry) => path.dirname(path.resolve(entry.primaryRoot)) === projectsRoot)).toBe(false);
      const projectDirectories = (await readdir(projectsRoot, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && entry.name !== ".aicanvas-novel-import-transactions");
      expect(projectDirectories).toHaveLength(1);
      await expect(lstat(path.join(projectsRoot, projectDirectories[0]!.name, "manuscript")))
        .rejects.toMatchObject({ code: "ENOENT" });
    },
  );
});
