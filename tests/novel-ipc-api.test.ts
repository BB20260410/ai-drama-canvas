import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import { createManagedProject, inspectManagedProjectReadOnly } from "../src/core/managed-project.js";
import { ensureConfinedDirectory } from "../src/core/confined-project-storage.js";
import { NOVEL_COMMAND_NAMES, parseNovelCommandRequestForCore } from "../src/core/novel-command-runtime.js";
import {
  createAuthorizedNovelImportPreflightFromSelection,
  inspectNovelImportPreflightAuthorization,
  resetNovelImportPreflightAuthorizationsForTests,
} from "../src/core/novel-import.js";
import { resolveNovelImportProjectsRoot } from "../src/core/novel-import-commit.js";
import {
  bindNovelDestinationToPreflightAuthorization,
  consumeNovelDestinationForPreflightAuthorization,
  consumeNovelDestinationSelection,
  issueNovelDestinationSelection,
  NOVEL_DESTINATION_AUTHORIZATION_CAPACITY,
  releaseNovelDestinationPreflightReservation,
  reserveNovelDestinationForPreflightAuthorization,
  resetNovelDestinationSelectionsForTests,
} from "../src/core/novel-destination-selection.js";
import {
  consumeNovelSourceSelection,
  issueNovelSourceSelection,
  resetNovelSourceSelectionsForTests,
} from "../src/core/novel-source-selection.js";

const workspace = process.cwd();
const temporaryRoots: string[] = [];

afterEach(async () => {
  resetNovelImportPreflightAuthorizationsForTests();
  resetNovelSourceSelectionsForTests();
  resetNovelDestinationSelectionsForTests();
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface ExecutableContract {
  requireNovelDesktopIpcArgs: (args: readonly unknown[], expectedLength: number, label: string) => readonly unknown[];
  parseNovelDesktopProjectRoot: (value: unknown) => string;
  parseNovelDesktopNavigationPage: (value: unknown) => { offset: number; limit: number; anchorVolumeId?: string };
  parseNovelDesktopChapterPage: (value: unknown) => {
    offset: number;
    limit: number;
    volumeId?: string;
    anchorChapterId?: string;
  };
  parseNovelDesktopChapterId: (value: unknown) => string;
  parseNovelDesktopSearchInput: (value: unknown) => { query: string; limit?: number; maxHitsPerChapter?: number };
  parseNovelDesktopWritingDashboardInput: (value: unknown) => { selectedChapterId?: string; workflowMode?: "formal" | "rehearsal" };
  parseNovelDesktopStateCandidateReviewInput: (value: unknown) => {
    candidateId: string;
    expectedCandidateFingerprint: string;
    expectedWritingStateRevision: number;
    expectedWritingStateFingerprint: string;
    decision: "accepted" | "rejected";
    note?: string;
  };
  parseNovelDesktopSourceSelectionKind: (value: unknown) => "file" | "directory";
  parseNovelDesktopSelectionId: (value: unknown) => string;
  parseNovelDesktopDestinationId: (value: unknown) => string;
  parseNovelDesktopCommandInput: (value: unknown) => {
    requestId: string;
    idempotencyKey: string;
    request: { command: string; payload: unknown };
  };
  sanitizeNovelDesktopPreflight: (value: Record<string, unknown>) => Record<string, unknown>;
  sanitizeNovelDesktopSourceSelection: (value: Record<string, unknown>) => Record<string, unknown>;
  sanitizeNovelDesktopDestinationSelection: (value: Record<string, unknown>) => Record<string, unknown>;
  sanitizeNovelDesktopCommandResult: (value: Record<string, unknown>) => Record<string, unknown>;
  requireNovelDesktopProjectsRoot: (value: unknown) => Promise<string>;
  requireManagedNovelDesktopProjectRoot: (value: unknown) => Promise<string>;
  assertNovelDesktopDestinationOwnerDisjoint: (projectsRoot: string, ownerRoot: string) => void;
  withNovelDesktopPublicError: <T>(
    code: "NOVEL_SOURCE_PICK_FAILED" | "NOVEL_DESTINATION_PICK_FAILED" | "NOVEL_SOURCE_PREFLIGHT_FAILED" | "NOVEL_IMPORT_COMMAND_FAILED",
    work: () => T | Promise<T>,
  ) => Promise<T>;
}

async function source(relativePath: string): Promise<string> {
  return readFile(path.join(workspace, relativePath), "utf8");
}

function executableContract(main: string): ExecutableContract {
  const startMarker = "// NOVEL_DESKTOP_IPC_CONTRACT_START";
  const endMarker = "// NOVEL_DESKTOP_IPC_CONTRACT_END";
  const start = main.indexOf(startMarker);
  const end = main.indexOf(endMarker, start + startMarker.length);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const compiled = ts.transpileModule(main.slice(start + startMarker.length, end), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports: Record<string, unknown> = {};
  const evaluate = new Function(
    "exports",
    "path",
    "parseNovelCommandRequestForCore",
    "inspectManagedProjectReadOnly",
    "resolveNovelImportProjectsRoot",
    compiled,
  ) as (
    exportsValue: Record<string, unknown>,
    pathValue: typeof path,
    parser: typeof parseNovelCommandRequestForCore,
    inspector: typeof inspectManagedProjectReadOnly,
    projectsRootResolver: typeof resolveNovelImportProjectsRoot,
  ) => void;
  evaluate(
    exports,
    path,
    parseNovelCommandRequestForCore,
    inspectManagedProjectReadOnly,
    resolveNovelImportProjectsRoot,
  );
  return exports as unknown as ExecutableContract;
}

function handlerSlice(main: string, channel: string): string {
  const start = main.indexOf(`ipcMain.handle("${channel}"`);
  expect(start, `缺少 IPC handler：${channel}`).toBeGreaterThanOrEqual(0);
  const next = main.indexOf('ipcMain.handle("canvas:', start + 20);
  return main.slice(start, next < 0 ? main.length : next);
}

async function treeSnapshot(root: string): Promise<Array<Record<string, unknown>>> {
  const output: Array<Record<string, unknown>> = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, "en"))) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      const metadata = await lstat(absolute);
      if (metadata.isDirectory()) {
        output.push({ path: relative, type: "directory" });
        await visit(absolute);
      } else if (metadata.isFile()) {
        const bytes = await readFile(absolute);
        output.push({
          path: relative,
          type: "file",
          size: bytes.byteLength,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        });
      } else {
        output.push({ path: relative, type: metadata.isSymbolicLink() ? "symlink" : "special" });
      }
    }
  };
  await visit(root);
  return output;
}

function absoluteStrings(value: unknown, output: string[] = []): string[] {
  if (typeof value === "string" && (path.isAbsolute(value) || path.win32.isAbsolute(value))) output.push(value);
  else if (Array.isArray(value)) value.forEach((entry) => absoluteStrings(entry, output));
  else if (value && typeof value === "object") Object.values(value as Record<string, unknown>)
    .forEach((entry) => absoluteStrings(entry, output));
  return output;
}

describe("desktop novel IPC API", () => {
  it("严格拒绝额外位置参数、信封字段、非 novel 命令和越界分页", async () => {
    const contract = executableContract(await source("src/main/index.ts"));
    const valid = {
      requestId: "novel-request-0001",
      idempotencyKey: "novel-idempotency-0001",
      request: { command: "novel_initialize_manuscript", payload: {} },
    };
    expect(contract.parseNovelDesktopCommandInput(valid)).toEqual(valid);
    expect(() => contract.parseNovelDesktopCommandInput({ ...valid, actor: "user" }))
      .toThrow(/未支持参数：actor/u);
    expect(() => contract.parseNovelDesktopCommandInput({
      ...valid,
      request: { ...valid.request, extra: true },
    })).toThrow(/严格合同/u);
    expect(() => contract.parseNovelDesktopCommandInput({
      ...valid,
      request: { command: "scan_project", payload: {} },
    })).toThrow(/只允许受支持的 novel 命令/u);
    expect(() => contract.parseNovelDesktopCommandInput({ ...valid, requestId: "short" }))
      .toThrow(/requestId/u);

    expect(contract.requireNovelDesktopIpcArgs(["root", {}], 2, "测试")).toHaveLength(2);
    expect(() => contract.requireNovelDesktopIpcArgs(["root", {}, "extra"], 2, "测试"))
      .toThrow(/参数数量无效/u);
    expect(contract.parseNovelDesktopNavigationPage({ offset: 0, limit: 50 })).toEqual({ offset: 0, limit: 50 });
    expect(() => contract.parseNovelDesktopNavigationPage({ offset: 0, limit: 51 })).toThrow(/1–50/u);
    const volumeId = "22222222-2222-4222-8222-222222222222";
    const anchorChapterId = "11111111-1111-4111-8111-111111111111";
    expect(contract.parseNovelDesktopNavigationPage({ offset: 0, limit: 50, anchorVolumeId: volumeId }))
      .toEqual({ offset: 0, limit: 50, anchorVolumeId: volumeId });
    expect(contract.parseNovelDesktopChapterPage({ offset: 0, limit: 100, volumeId, anchorChapterId }))
      .toEqual({ offset: 0, limit: 100, volumeId, anchorChapterId });
    expect(() => contract.parseNovelDesktopChapterPage({ offset: 0, limit: 1, extra: true }))
      .toThrow(/未支持参数：extra/u);
    expect(() => contract.parseNovelDesktopChapterPage({ offset: -1, limit: 10 })).toThrow(/offset/u);
    expect(() => contract.parseNovelDesktopChapterPage({ offset: 0, limit: 101 })).toThrow(/limit/u);
    expect(() => contract.parseNovelDesktopChapterPage({ offset: 0, limit: 100, volumeId: "not-uuid" }))
      .toThrow(/volumeId/u);
    expect(() => contract.parseNovelDesktopProjectRoot("relative/project")).toThrow(/绝对 projectRoot/u);
    expect(contract.parseNovelDesktopSourceSelectionKind("file")).toBe("file");
    expect(contract.parseNovelDesktopSourceSelectionKind("directory")).toBe("directory");
    expect(() => contract.parseNovelDesktopSourceSelectionKind("path")).toThrow(/file 或 directory/u);
    expect(() => contract.parseNovelDesktopSelectionId(path.resolve("任意绝对来源.md")))
      .toThrow(/原生选择器.*selectionId/u);
    expect(() => contract.parseNovelDesktopSelectionId("novel-source-selection-short"))
      .toThrow(/selectionId/u);
    expect(() => contract.parseNovelDesktopDestinationId(path.resolve("任意绝对目标")))
      .toThrow(/原生选择器.*destinationId/u);
    expect(() => contract.parseNovelDesktopDestinationId("novel-destination-selection-short"))
      .toThrow(/destinationId/u);
    expect(contract.parseNovelDesktopChapterId("11111111-1111-4111-8111-111111111111"))
      .toBe("11111111-1111-4111-8111-111111111111");
    expect(() => contract.parseNovelDesktopChapterId("../chapter.md")).toThrow(/UUID/u);
    expect(contract.parseNovelDesktopSearchInput({ query: "  青铜铃  ", limit: 200, maxHitsPerChapter: 5 }))
      .toEqual({ query: "青铜铃", limit: 200, maxHitsPerChapter: 5 });
    expect(() => contract.parseNovelDesktopSearchInput({ query: "青", limit: 200 }))
      .toThrow(/2–200/u);
    expect(() => contract.parseNovelDesktopSearchInput({ query: "青铜铃", limit: 201 }))
      .toThrow(/limit/u);
    expect(() => contract.parseNovelDesktopSearchInput({ query: "青铜铃", extra: true }))
      .toThrow(/未支持参数：extra/u);
    const chapterId = "11111111-1111-4111-8111-111111111111";
    expect(contract.parseNovelDesktopWritingDashboardInput({ selectedChapterId: chapterId, workflowMode: "formal" }))
      .toEqual({ selectedChapterId: chapterId, workflowMode: "formal" });
    expect(() => contract.parseNovelDesktopWritingDashboardInput({ workflowMode: "agent" }))
      .toThrow(/formal 或 rehearsal/u);
    const review = {
      candidateId: `novel-state-candidate-${"a".repeat(24)}`,
      expectedCandidateFingerprint: "b".repeat(64),
      expectedWritingStateRevision: 3,
      expectedWritingStateFingerprint: "c".repeat(64),
      decision: "accepted" as const,
      note: "  人工核对通过  ",
    };
    expect(contract.parseNovelDesktopStateCandidateReviewInput(review)).toEqual({ ...review, note: "人工核对通过" });
    expect(() => contract.parseNovelDesktopStateCandidateReviewInput({ ...review, reviewer: "forged-owner" }))
      .toThrow(/未支持参数：reviewer/u);
    expect(() => contract.parseNovelDesktopStateCandidateReviewInput({ ...review, decision: "auto" }))
      .toThrow(/accepted 或 rejected/u);

    const desktopImport = {
      requestId: "novel-request-import-0001",
      idempotencyKey: "novel-idempotency-import-0001",
      request: {
        command: "novel_import_external_snapshot",
        payload: {
          projectName: "山海长篇",
          preflightId: `novel-preflight-${"a".repeat(24)}`,
          preflightFingerprint: "b".repeat(64),
          sourceTreeAggregateSha256: "c".repeat(64),
          duplicateResolution: "include_all",
          convertToManagedMarkdown: true,
          preflightAuthorization: `novel-preflight-auth-${"d".repeat(43)}`,
        },
      },
    };
    expect(contract.parseNovelDesktopCommandInput(desktopImport)).toEqual(desktopImport);
    expect(absoluteStrings(contract.parseNovelDesktopCommandInput(desktopImport))).toEqual([]);
    expect(() => contract.parseNovelDesktopCommandInput({
      ...desktopImport,
      request: {
        ...desktopImport.request,
        payload: { ...desktopImport.request.payload, projectsRoot: path.resolve("renderer-forged-root") },
      },
    })).toThrow(/未支持参数：projectsRoot/u);
  });

  it("项目根只经只读 managed inspection 放行 v2 novel/hybrid，drama 与普通目录失败且零写", async () => {
    const contract = executableContract(await source("src/main/index.ts"));
    const parent = await realpath(await mkdtemp(path.join(await realpath(os.tmpdir()), "ai-canvas-novel-ipc-root-")));
    temporaryRoots.push(parent);
    const novel = await createManagedProject({ parentRoot: parent, name: "Novel IPC", workspaceMode: "novel" });
    const hybrid = await createManagedProject({ parentRoot: parent, name: "Hybrid IPC", workspaceMode: "hybrid" });
    const drama = await createManagedProject({ parentRoot: parent, name: "Drama IPC", workspaceMode: "drama" });
    const unmanaged = await realpath(await mkdtemp(path.join(parent, "unmanaged-")));

    for (const shell of [novel, hybrid]) {
      const before = await treeSnapshot(shell.paths.root);
      await expect(contract.requireManagedNovelDesktopProjectRoot(shell.paths.root)).resolves.toBe(shell.paths.root);
      expect(await treeSnapshot(shell.paths.root)).toEqual(before);
    }
    const dramaBefore = await treeSnapshot(drama.paths.root);
    await expect(contract.requireManagedNovelDesktopProjectRoot(drama.paths.root))
      .rejects.toThrow(/schema v2 novel\/hybrid/u);
    expect(await treeSnapshot(drama.paths.root)).toEqual(dramaBefore);
    const unmanagedBefore = await treeSnapshot(unmanaged);
    await expect(contract.requireManagedNovelDesktopProjectRoot(unmanaged)).rejects.toThrow(/受管工程/u);
    expect(await treeSnapshot(unmanaged)).toEqual(unmanagedBefore);
  });

  it("来源预检保持源目录和项目零写，IPC 投影移除绝对来源根与 command storageRoot", async () => {
    const contract = executableContract(await source("src/main/index.ts"));
    const parent = await realpath(await mkdtemp(path.join(await realpath(os.tmpdir()), "ai-canvas-novel-ipc-preflight-")));
    temporaryRoots.push(parent);
    const shell = await createManagedProject({ parentRoot: parent, name: "Novel Preflight IPC", workspaceMode: "novel" });
    const projectsRoot = path.join(parent, "novel-projects");
    await mkdir(projectsRoot);
    const sourceRoot = path.join(parent, "source");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(sourceRoot));
    const sourcePath = path.join(sourceRoot, "第一卷.md");
    await writeFile(sourcePath, "# 第一章\n\n青铜树下，嘟嘟醒来。\n", "utf8");
    const projectBefore = await treeSnapshot(shell.paths.root);
    const sourceBefore = await treeSnapshot(sourceRoot);
    const destinationBefore = await treeSnapshot(projectsRoot);

    const destinationTicket = await issueNovelDestinationSelection(projectsRoot);
    const safeDestination = contract.sanitizeNovelDesktopDestinationSelection(
      destinationTicket as unknown as Record<string, unknown>,
    );
    expect(safeDestination).toEqual({
      destinationId: expect.stringMatching(/^novel-destination-selection-[A-Za-z0-9_-]{43}$/u),
      destinationName: "novel-projects",
    });
    expect(absoluteStrings(safeDestination)).toEqual([]);
    const destination = await consumeNovelDestinationSelection(String(safeDestination.destinationId));
    const reservation = await reserveNovelDestinationForPreflightAuthorization(destination);
    const ticket = await issueNovelSourceSelection(sourcePath, "file");
    const safeTicket = contract.sanitizeNovelDesktopSourceSelection(ticket as unknown as Record<string, unknown>);
    expect(safeTicket).toEqual({
      selectionId: expect.stringMatching(/^novel-source-selection-[A-Za-z0-9_-]{43}$/u),
      sourceName: "第一卷.md",
      kind: "file",
    });
    expect(absoluteStrings(safeTicket)).toEqual([]);
    const selection = await consumeNovelSourceSelection(String(safeTicket.selectionId));
    const preflight = await createAuthorizedNovelImportPreflightFromSelection(selection);
    const safe = contract.sanitizeNovelDesktopPreflight(preflight as unknown as Record<string, unknown>);
    expect(preflight.authorization).not.toBeNull();
    await bindNovelDestinationToPreflightAuthorization(reservation, preflight.authorization!);
    const concurrentDestinationConsumes = await Promise.allSettled([
      consumeNovelDestinationForPreflightAuthorization(preflight.authorization!.authorizationId),
      consumeNovelDestinationForPreflightAuthorization(preflight.authorization!.authorizationId),
    ]);
    expect(concurrentDestinationConsumes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(concurrentDestinationConsumes.filter((result) => result.status === "rejected")).toHaveLength(1);
    const reboundDestination = concurrentDestinationConsumes.find(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<
        typeof consumeNovelDestinationForPreflightAuthorization
      >>> => result.status === "fulfilled",
    )!.value;
    expect(reboundDestination.projectsRoot).toBe(projectsRoot);
    expect(reboundDestination.identity.dev).toBe(destination.identity.dev);
    expect(inspectNovelImportPreflightAuthorization(preflight.authorization!.authorizationId).preflightId)
      .toBe(preflight.preflight.preflightId);
    expect(safe).toMatchObject({
      sourceName: "第一卷.md",
      eligible: true,
      authorization: {
        schemaVersion: 1,
        kind: "novel-import-preflight-authorization",
      },
    });
    expect((safe.authorization as Record<string, unknown>).authorizationId)
      .toMatch(/^novel-preflight-auth-[A-Za-z0-9_-]{43}$/u);
    expect(safe).not.toHaveProperty("sourcePath");
    expect(safe).not.toHaveProperty("sourceRoot");
    expect(absoluteStrings(safe)).toEqual([]);
    expect(await treeSnapshot(shell.paths.root)).toEqual(projectBefore);
    expect(await treeSnapshot(sourceRoot)).toEqual(sourceBefore);
    expect(await treeSnapshot(projectsRoot)).toEqual(destinationBefore);

    const record = contract.sanitizeNovelDesktopCommandResult({
      schemaVersion: 1,
      requestId: "novel-request-0001",
      idempotencyKey: "novel-idempotency-0001",
      command: "novel_initialize_manuscript",
      status: "succeeded",
      replayed: false,
      requestHash: "a".repeat(64),
      storageRoot: shell.paths.root,
      durableReconciliation: {
        schemaVersion: 1,
        request: {
          command: "novel_import_external_snapshot",
          payload: { projectsRoot },
        },
      },
      startedAt: new Date(0).toISOString(),
    });
    expect(record).not.toHaveProperty("storageRoot");
    expect(record).not.toHaveProperty("durableReconciliation");
    expect(absoluteStrings(record)).toEqual([]);
    expect(() => contract.sanitizeNovelDesktopCommandResult({
      ...record,
      result: { projectRoot: shell.paths.root },
    })).toThrow(/内部绝对 locator/u);
    expect(() => contract.sanitizeNovelDesktopCommandResult({
      ...record,
      result: { receipt: { sourcePath } },
    })).toThrow(/内部绝对 locator/u);
  });

  it("目标只能由原生一次性票据授权，伪造值零写且 inode/符号链接替换失败", async () => {
    const contract = executableContract(await source("src/main/index.ts"));
    const parent = await realpath(await mkdtemp(path.join(await realpath(os.tmpdir()), "ai-canvas-novel-destination-")));
    temporaryRoots.push(parent);
    const destination = path.join(parent, "projects");
    await mkdir(destination);
    await writeFile(path.join(destination, "keep.txt"), "unchanged", "utf8");
    const beforeForged = await treeSnapshot(parent);

    await expect(consumeNovelDestinationSelection(path.resolve(parent, "renderer-forged")))
      .rejects.toThrow(/destinationId/u);
    await expect(consumeNovelDestinationSelection(`novel-destination-selection-${"x".repeat(43)}`))
      .rejects.toThrow(/destinationId/u);
    expect(await treeSnapshot(parent)).toEqual(beforeForged);

    const ticket = await issueNovelDestinationSelection(destination);
    const original = `${destination}-original`;
    await rename(destination, original);
    await mkdir(destination);
    await writeFile(path.join(destination, "replacement.txt"), "replacement", "utf8");
    const replacementBefore = await treeSnapshot(destination);
    await expect(consumeNovelDestinationSelection(ticket.destinationId)).rejects.toMatchObject({
      code: "NOVEL_DESTINATION_CHANGED",
    });
    expect(await treeSnapshot(destination)).toEqual(replacementBefore);

    const stable = path.join(parent, "stable-projects");
    await mkdir(stable);
    const stableTicket = await issueNovelDestinationSelection(stable);
    const stableOriginal = `${stable}-original`;
    await rename(stable, stableOriginal);
    await symlink(stableOriginal, stable, "dir");
    const symlinkBefore = await treeSnapshot(parent);
    await expect(consumeNovelDestinationSelection(stableTicket.destinationId)).rejects.toMatchObject({
      code: "NOVEL_DESTINATION_CHANGED",
    });
    expect(await treeSnapshot(parent)).toEqual(symlinkBefore);

    expect(() => contract.assertNovelDesktopDestinationOwnerDisjoint(destination, destination))
      .toThrow(/command owner.*完全分离/u);
    expect(() => contract.assertNovelDesktopDestinationOwnerDisjoint(path.join(destination, "child"), destination))
      .toThrow(/command owner.*完全分离/u);
    expect(() => contract.assertNovelDesktopDestinationOwnerDisjoint(destination, path.join(destination, "child")))
      .toThrow(/command owner.*完全分离/u);
  });

  it("目标授权并发预留不超容量，首次 dirfd 写边界仍复验原生 inode", async () => {
    const parent = await realpath(await mkdtemp(path.join(await realpath(os.tmpdir()), "ai-canvas-novel-destination-capacity-")));
    temporaryRoots.push(parent);
    const destination = path.join(parent, "projects");
    await mkdir(destination);
    const grant = await consumeNovelDestinationSelection(
      (await issueNovelDestinationSelection(destination)).destinationId,
    );
    const settled = await Promise.allSettled(Array.from(
      { length: NOVEL_DESTINATION_AUTHORIZATION_CAPACITY + 1 },
      () => reserveNovelDestinationForPreflightAuthorization(grant),
    ));
    const fulfilled = settled.filter((result): result is PromiseFulfilledResult<Awaited<
      ReturnType<typeof reserveNovelDestinationForPreflightAuthorization>
    >> => result.status === "fulfilled");
    expect(fulfilled).toHaveLength(NOVEL_DESTINATION_AUTHORIZATION_CAPACITY);
    expect(settled.filter((result) => result.status === "rejected")).toHaveLength(1);
    fulfilled.forEach((result) => releaseNovelDestinationPreflightReservation(result.value));

    const oldDestination = `${destination}-selected-inode`;
    await rename(destination, oldDestination);
    await mkdir(destination);
    const replacementBefore = await treeSnapshot(destination);
    await expect(ensureConfinedDirectory(
      destination,
      path.join(destination, ".aicanvas-novel-import-transactions", "test-transaction"),
      0o700,
      {
        projectsRoot: grant.projectsRoot,
        canonicalRoot: grant.projectsRoot,
        dev: grant.identity.dev,
        ino: grant.identity.ino,
      },
    )).rejects.toMatchObject({ code: "NOVEL_DESTINATION_CHANGED" });
    expect(await treeSnapshot(destination)).toEqual(replacementBefore);
  });

  it("renderer-visible novel 错误只暴露稳定 code/固定文案，不泄露已删除来源的路径或 Main stack", async () => {
    const contract = executableContract(await source("src/main/index.ts"));
    const parent = await realpath(await mkdtemp(path.join(await realpath(os.tmpdir()), "ai-canvas-novel-ipc-error-")));
    temporaryRoots.push(parent);
    const sourceRoot = path.join(parent, "绝密小说来源");
    await mkdir(sourceRoot);
    const sourcePath = path.join(sourceRoot, "未公开正文.md");
    await writeFile(sourcePath, "# 第一章\n不得进入 IPC 错误消息。\n", "utf8");
    const ticket = await issueNovelSourceSelection(sourcePath, "file");
    await rm(sourcePath);

    let visible: unknown;
    try {
      await contract.withNovelDesktopPublicError("NOVEL_SOURCE_PREFLIGHT_FAILED", () => (
        consumeNovelSourceSelection(ticket.selectionId)
      ));
    } catch (error) {
      visible = error;
    }
    expect(visible).toBeInstanceOf(Error);
    const publicError = visible as Error & { code?: unknown; cause?: unknown };
    expect(publicError.code).toBe("NOVEL_SOURCE_CHANGED");
    expect(publicError.name).toBe("NovelDesktopPublicError");
    expect(publicError.message).toBe(
      "[NOVEL_SOURCE_CHANGED] 小说来源在选择或预检后发生变化。请重新选择并预检。",
    );
    expect(publicError.stack).toBe(`NovelDesktopPublicError: ${publicError.message}`);
    expect(publicError).not.toHaveProperty("cause");
    for (const secret of [sourcePath, sourceRoot, parent, "未公开正文.md", "绝密小说来源"]) {
      expect(publicError.message).not.toContain(secret);
      expect(publicError.stack).not.toContain(secret);
    }
  });

  it("按规范把存储、权限、忙、来源变化、闭包漂移、恢复和校验错误映射为固定公开枚举", async () => {
    const contract = executableContract(await source("src/main/index.ts"));
    const secretRoot = path.resolve(os.tmpdir(), "绝不能进入公开错误", "私密小说.md");
    const cases: Array<{
      label: string;
      internal: unknown;
      expectedCode: string;
      expectedMessage: string;
    }> = [
      {
        label: "ENOSPC",
        internal: Object.assign(new Error(`no space left on device: ${secretRoot}`), { code: "ENOSPC" }),
        expectedCode: "NOVEL_STORAGE_FULL",
        expectedMessage: "存储空间不足，操作已失败关闭。请释放空间后重试。",
      },
      ...(["EACCES", "EPERM"] as const).map((code) => ({
        label: code,
        internal: new Error("outer", {
          cause: Object.assign(new Error(`permission denied: ${secretRoot}`), { code }),
        }),
        expectedCode: "NOVEL_PERMISSION_DENIED",
        expectedMessage: "没有访问所选位置的权限。请调整权限或重新选择位置。",
      })),
      {
        label: "SQLITE_BUSY",
        internal: Object.assign(new Error(`database is locked: ${secretRoot}`), { code: "SQLITE_BUSY", errcode: 5 }),
        expectedCode: "NOVEL_RESOURCE_BUSY",
        expectedMessage: "小说资源暂时被占用，本次没有重复执行。请稍后重试。",
      },
      {
        label: "source changed",
        internal: new Error(`小说来源在预检后已变化：${secretRoot}`),
        expectedCode: "NOVEL_SOURCE_CHANGED",
        expectedMessage: "小说来源在选择或预检后发生变化。请重新选择并预检。",
      },
      {
        label: "destination changed",
        internal: Object.assign(new Error(`destination changed: ${secretRoot}`, {
          cause: Object.assign(new Error(`no such file: ${secretRoot}`), { code: "ENOENT" }),
        }), { code: "NOVEL_DESTINATION_CHANGED" }),
        expectedCode: "NOVEL_DESTINATION_CHANGED",
        expectedMessage: "小说目标在选择或预检后发生变化。请重新选择并预检。",
      },
      {
        label: "closure drift",
        internal: new Error(`小说导入 receipt 闭包与 state chain 不一致：${secretRoot}`),
        expectedCode: "NOVEL_CLOSURE_DRIFT",
        expectedMessage: "小说数据闭包校验不一致，操作已停止。请先检查项目完整性。",
      },
      {
        label: "recovery required",
        internal: new Error(`outcome_unknown，保持 unknown，禁止自动重放，请先对账：${secretRoot}`),
        expectedCode: "NOVEL_RECOVERY_REQUIRED",
        expectedMessage: "小说操作结果尚未确认，禁止重复执行。请先执行恢复与对账。",
      },
      {
        label: "validation",
        internal: new Error(`小说来源参数无效且包含不允许格式：${secretRoot}`),
        expectedCode: "NOVEL_VALIDATION_FAILED",
        expectedMessage: "小说请求未通过安全校验。请检查选择和参数后重试。",
      },
    ];

    for (const current of cases) {
      let visible: unknown;
      try {
        await contract.withNovelDesktopPublicError("NOVEL_IMPORT_COMMAND_FAILED", () => {
          throw current.internal;
        });
      } catch (error) {
        visible = error;
      }
      expect(visible, current.label).toBeInstanceOf(Error);
      const publicError = visible as Error & { code?: unknown; cause?: unknown };
      expect(publicError.code, current.label).toBe(current.expectedCode);
      expect(publicError.message, current.label).toBe(`[${current.expectedCode}] ${current.expectedMessage}`);
      expect(publicError.stack, current.label).toBe(`NovelDesktopPublicError: ${publicError.message}`);
      expect(publicError, current.label).not.toHaveProperty("cause");
      expect(publicError.message, current.label).not.toContain(secretRoot);
      expect(publicError.stack, current.label).not.toContain(secretRoot);
    }
  });

  it("Main/Preload 形成小说窄命名空间，正文写入复用 command bus，记忆只读投影 Writing OS 权威", async () => {
    const [main, preload, env, commandBus, commit, confined, dirfd] = await Promise.all([
      source("src/main/index.ts"),
      source("src/preload/index.ts"),
      source("src/renderer/src/env.d.ts"),
      source("src/core/command-bus.ts"),
      source("src/core/novel-import-commit.ts"),
      source("src/core/confined-project-storage.ts"),
      source("src/core/darwin-dirfd-storage.ts"),
    ]);
    expect(NOVEL_COMMAND_NAMES).toEqual([
      "novel_initialize_manuscript",
      "novel_create_volume",
      "novel_create_chapter",
      "novel_save_chapter",
      "novel_rename_chapter",
      "novel_move_chapter",
      "novel_reorder_chapters",
      "novel_rebuild_search_index",
      "novel_recover_manuscript",
      "novel_recover_writing_state",
      "novel_seed_writing_state",
      "novel_stage_chapter_state_candidate",
      "novel_review_chapter_state_candidate",
      "novel_stage_story_bible_candidate",
      "novel_review_story_bible_candidate",
      "novel_invalidate_writing_state_from",
      "novel_attach_review_ticket",
      "novel_import_writing_source_snapshot",
      "novel_import_external_snapshot",
    ]);

    const channels = [
      "canvas:novel-get-workspace",
      "canvas:novel-get-navigation",
      "canvas:novel-list-chapters",
      "canvas:novel-read-chapter",
      "canvas:novel-search-chapters",
      "canvas:novel-list-facts",
      "canvas:novel-get-writing-dashboard",
      "canvas:novel-review-state-candidate",
      "canvas:novel-upsert-fact",
      "canvas:novel-pick-source",
      "canvas:novel-pick-destination",
      "canvas:novel-preflight-source",
      "canvas:novel-execute-command",
    ] as const;
    const allowlistStart = main.indexOf("export const NOVEL_DESKTOP_IPC_CHANNELS");
    const allowlistEnd = main.indexOf("] as const;", allowlistStart);
    const allowlist = main.slice(allowlistStart, allowlistEnd);
    expect((allowlist.match(/"canvas:novel-/gu) ?? [])).toHaveLength(channels.length);
    channels.forEach((channel) => expect(allowlist).toContain(`"${channel}"`));

    const namespaceStart = preload.indexOf("  novel: {");
    const namespaceEnd = preload.indexOf("  upgradeManagedStudioProject:", namespaceStart);
    expect(namespaceStart).toBeGreaterThanOrEqual(0);
    expect(namespaceEnd).toBeGreaterThan(namespaceStart);
    const namespace = preload.slice(namespaceStart, namespaceEnd);
    expect((namespace.match(/ipcRenderer\.invoke\("canvas:novel-/gu) ?? [])).toHaveLength(channels.length);
    for (const channel of channels) expect(namespace).toContain(`ipcRenderer.invoke("${channel}"`);
    expect(namespace).toContain("executeNovelCommand:");
    expect(namespace).toContain("getWritingDashboard:");
    expect(namespace).toContain("reviewStateCandidate:");
    expect(namespace).toContain("pickSource:");
    expect(namespace).toContain("pickDestination:");
    expect(namespace).toContain("preflightSource: (destinationId: string, selectionId: string)");
    expect(namespace).toContain("executeNovelCommand: (root: string | null");
    expect(namespace).not.toContain("preflightSource: (projectsRoot: string, selectionId: string)");
    expect(namespace).not.toContain("preflightSource: (projectsRoot: string, sourcePath: string)");
    expect(namespace).not.toMatch(/commitNovelExternalImport|new NovelRepository|writeFile|outputPath/u);
    expect(env).toContain('import type { CanvasApi } from "../../preload/index"');

    const getWorkspace = handlerSlice(main, "canvas:novel-get-workspace");
    const getNavigation = handlerSlice(main, "canvas:novel-get-navigation");
    const list = handlerSlice(main, "canvas:novel-list-chapters");
    const read = handlerSlice(main, "canvas:novel-read-chapter");
    const search = handlerSlice(main, "canvas:novel-search-chapters");
    const listFacts = handlerSlice(main, "canvas:novel-list-facts");
    const dashboard = handlerSlice(main, "canvas:novel-get-writing-dashboard");
    const reviewState = handlerSlice(main, "canvas:novel-review-state-candidate");
    const upsertFact = handlerSlice(main, "canvas:novel-upsert-fact");
    const picker = handlerSlice(main, "canvas:novel-pick-source");
    const destinationPicker = handlerSlice(main, "canvas:novel-pick-destination");
    const preflight = handlerSlice(main, "canvas:novel-preflight-source");
    const execute = handlerSlice(main, "canvas:novel-execute-command");
    expect(getWorkspace).toContain("new NovelRepository(projectRoot).snapshot()");
    expect(getNavigation).toContain("parseNovelDesktopNavigationPage(pageValue)");
    expect(getNavigation).toContain("new NovelRepository(projectRoot).getNavigation(page)");
    expect(list).toContain("new NovelRepository(projectRoot).listChapters(page)");
    expect(read).toContain("new NovelRepository(projectRoot).readChapter(chapterId)");
    expect(search).toContain("parseNovelDesktopSearchInput(inputValue)");
    expect(search).toContain("new NovelRepository(projectRoot).searchChapters(input)");
    expect(search).toContain("assertNovelDesktopSafeResult(result)");
    expect(listFacts).toContain("getNovelMemoryAuthorityProjection(projectRoot, snapshot)");
    expect(listFacts).toContain("new NovelRepository(projectRoot).snapshot()");
    expect(dashboard).toContain("parseNovelDesktopWritingDashboardInput(inputValue)");
    expect(dashboard).toContain("getNovelDesktopWritingDashboard(projectRoot, input)");
    expect(dashboard).toContain("assertNovelDesktopSafeResult(result)");
    expect(reviewState).toContain("parseNovelDesktopStateCandidateReviewInput(inputValue)");
    expect(reviewState).toContain("reviewNovelDesktopStateCandidate(projectRoot, input)");
    expect(reviewState).toContain("assertNovelDesktopSafeResult(result)");
    expect(upsertFact).not.toContain("upsertNovelFact(projectRoot");
    expect(upsertFact).toContain("NOVEL_MEMORY_AUTHORITY_CONFLICT");
    expect(upsertFact).toContain("novel_stage_story_bible_candidate");
    expect(upsertFact).toContain("novel_review_story_bible_candidate");
    expect(upsertFact).toContain("requireManagedNovelDesktopProjectRoot(projectRootValue)");
    expect(picker).toContain("dialog.showOpenDialog(mainWindow");
    expect(picker).toContain('properties: ["openFile"]');
    expect(picker).toContain('properties: ["openDirectory"]');
    expect(picker).toContain('extensions: ["txt", "md", "markdown", "docx"]');
    expect(picker).toContain("issueNovelSourceSelection(selectedPath, selectionKind)");
    expect(picker).toContain("sanitizeNovelDesktopSourceSelection");
    expect(picker).toContain('withNovelDesktopPublicError("NOVEL_SOURCE_PICK_FAILED"');
    expect(picker.indexOf("dialog.showOpenDialog(mainWindow"))
      .toBeLessThan(picker.indexOf("issueNovelSourceSelection(selectedPath, selectionKind)"));
    expect(destinationPicker).toContain("dialog.showOpenDialog(mainWindow");
    expect(destinationPicker).toContain('properties: ["openDirectory"]');
    expect(destinationPicker).toContain("issueNovelDestinationSelection(selectedPath)");
    expect(destinationPicker).toContain("sanitizeNovelDesktopDestinationSelection");
    expect(destinationPicker).toContain('withNovelDesktopPublicError("NOVEL_DESTINATION_PICK_FAILED"');
    expect(destinationPicker).not.toMatch(/defaultPath|projectsRoot/u);
    expect(preflight).toContain("parseNovelDesktopDestinationId(destinationIdValue)");
    expect(preflight).toContain("parseNovelDesktopSelectionId(selectionIdValue)");
    expect(preflight).toContain("consumeNovelDestinationSelection(destinationId)");
    expect(preflight).toContain("consumeNovelSourceSelection(selectionId)");
    expect(preflight).toContain("createAuthorizedNovelImportPreflightFromSelection(selection)");
    expect(preflight).toContain("reserveNovelDestinationForPreflightAuthorization(destination)");
    expect(preflight).toContain("bindNovelDestinationToPreflightAuthorization(reservation, authorized.authorization)");
    expect(preflight).toContain("assertNovelDesktopDestinationOwnerDisjoint");
    expect(preflight).toContain("assertNovelImportDestinationDoesNotOverlapPreflight");
    expect(preflight).toContain("path.resolve(getNovelImportCommandOwnerRoot())");
    expect(preflight).toContain("sanitizeNovelDesktopPreflight");
    expect(preflight).toContain('withNovelDesktopPublicError("NOVEL_SOURCE_PREFLIGHT_FAILED"');
    expect(preflight.indexOf("assertNovelImportDestinationDoesNotOverlapPreflight"))
      .toBeLessThan(preflight.indexOf("createAuthorizedNovelImportPreflightFromSelection(selection)"));
    expect(preflight.indexOf("reserveNovelDestinationForPreflightAuthorization(destination)"))
      .toBeLessThan(preflight.indexOf("createAuthorizedNovelImportPreflightFromSelection(selection)"));
    expect(preflight).not.toMatch(/sourcePathValue|parseNovelDesktopSourcePath|createAuthorizedNovelImportPreflight\(sourcePath/u);
    expect(preflight).not.toContain("issueNovelSourceSelection");
    expect(execute).toContain("executeIdempotentCommand(projectRoot, coreInput, {");
    expect(execute).toContain('novelWriteActor: "human_ui"');
    expect(execute).toContain("executeIdempotentCommand(");
    expect(execute).toContain("getNovelImportCommandOwnerRoot()");
    expect(execute).toContain("projectRootValue !== null");
    expect(execute).toContain("resolveNovelDesktopImportCoreInput");
    expect(execute).toContain("novelImportDestinationIdentity: resolved.destinationIdentity");
    expect(execute).not.toContain("requireNovelDesktopProjectsRoot(projectRootValue)");
    expect(execute).not.toContain("isNovelImportCommandRequest(commandInput.request)");
    expect(execute).toContain("sanitizeNovelDesktopCommandResult");
    expect(execute).toContain('withNovelDesktopPublicError("NOVEL_IMPORT_COMMAND_FAILED"');
    expect(execute).not.toMatch(/\.initialize\(|\.createVolume\(|\.createChapter\(|\.saveChapter\(|\.renameChapter\(|\.moveChapter\(|\.reorderChapters\(|\.recoverIncompleteOperations\(/u);
    expect(execute.indexOf("parseNovelDesktopCommandInput(commandValue)"))
      .toBeLessThan(execute.indexOf("requireManagedNovelDesktopProjectRoot(projectRootValue)"));
    expect(execute.indexOf("requireManagedNovelDesktopProjectRoot(projectRootValue)"))
      .toBeLessThan(execute.indexOf("executeIdempotentCommand(projectRoot, coreInput, {"));

    for (const channel of channels) {
      const handler = handlerSlice(main, channel);
      expect(handler).toContain("...args: unknown[]");
      expect(handler).toContain("requireNovelDesktopIpcArgs(args,");
    }
    for (const channel of channels.slice(0, 3)) {
      expect(handlerSlice(main, channel)).toContain("requireManagedNovelDesktopProjectRoot(projectRootValue)");
    }
    expect(preflight).not.toContain("requireManagedNovelDesktopProjectRoot(projectRootValue)");
    expect(main).not.toContain("export function parseNovelDesktopSourcePath");
    const rootGuardStart = main.indexOf("export async function requireManagedNovelDesktopProjectRoot");
    const rootGuardEnd = main.indexOf("// NOVEL_DESKTOP_IPC_CONTRACT_END", rootGuardStart);
    const rootGuard = main.slice(rootGuardStart, rootGuardEnd);
    expect(rootGuard).toContain("inspectManagedProjectReadOnly(projectRoot)");
    expect(rootGuard).toContain("shell.manifest.schemaVersion !== 2");
    expect(rootGuard).toContain('shell.workspaceMode !== "novel"');
    expect(rootGuard).toContain('shell.workspaceMode !== "hybrid"');
    expect(rootGuard).not.toMatch(/\b(?:isManagedProject|getManagedProjectShell|mkdir|writeFile|executeIdempotentCommand|new NovelRepository)\b/u);

    const importResolverStart = main.indexOf("async function consumeNovelDesktopBoundDestination");
    const importResolverEnd = main.indexOf("export const LEGACY_STORY_MUTATION_IPC_CHANNELS", importResolverStart);
    const importResolver = main.slice(importResolverStart, importResolverEnd);
    expect(importResolver).toContain("getCommandLedgerEntryByIdempotencyKey(ownerRoot, input.idempotencyKey)");
    expect(importResolver).not.toContain("listCommandLedger(ownerRoot, 500)");
    expect(importResolver).toContain("busyUncommitted");
    expect(importResolver).toContain("consumeNovelDesktopBoundDestination(authorizationId)");
    expect(importResolver).toContain("if (consumedBinding) revokeNovelImportPreflightAuthorization(authorizationId)");
    expect(importResolver).toContain("destinationIdentity: rebound.destinationIdentity");
    expect(commandBus).toContain("novelImportDestinationIdentity?: NovelImportDestinationExecutionIdentity");
    expect(commandBus).toContain("await assertConfinedRootIdentity(input.destinationIdentity)");
    expect(commandBus).toContain("novelImportDestinationIdentity: options.novelImportDestinationIdentity");
    expect(commit).toContain("inspectExistingConfinedDirectoryAtExpectedRoot(expectedRoot, transactionPath)");
    expect(commit).toContain('expectedDestination ? "prove-complete" : "repair-terminal"');
    expect(commit).toContain("expectedDestination,");
    expect(confined).toContain('runDarwinDirfdStorage("inspect-directory"');
    expect(confined).toContain("String(expectedRoot.dev)");
    expect(confined).toContain("String(expectedRoot.ino)");
    expect(dirfd).toContain('if action == "inspect-directory": return action_inspect_directory(args)');
    expect(dirfd).toContain('raise OSError(errno.ESTALE, "directory identity mismatch")');
  });
});
