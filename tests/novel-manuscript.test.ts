import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, readdir, realpath, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createManagedProject, inspectManagedProjectReadOnly } from "../src/core/managed-project.js";
import {
  getNovelDerivedSearchIdentityCacheMetricsForTests,
  resetNovelDerivedSearchIdentityCacheForTests,
  setNovelDerivedSearchBeforeActivationHookForTests,
} from "../src/core/novel-derived-search.js";
import { NovelRepository } from "../src/core/novel-manuscript.js";
import { listProjectLocks } from "../src/core/locks.js";
import { runWithOperationContext } from "../src/core/operation-context.js";

const temporaryRoots: string[] = [];
let commandSequence = 0;

async function fixture(mode: "novel" | "hybrid" = "novel") {
  const parent = await realpath(await mkdtemp(path.join(await realpath(os.tmpdir()), "ai-canvas-novel-manuscript-")));
  temporaryRoots.push(parent);
  const shell = await createManagedProject({ parentRoot: parent, name: `小说 Repository ${mode}`, workspaceMode: mode });
  return { parent, shell, repository: new NovelRepository(shell.paths.root) };
}

function command<T>(name: string, work: () => Promise<T>): Promise<T> {
  commandSequence += 1;
  const requestHash = createHash("sha256").update(`${name}:${commandSequence}`).digest("hex");
  return runWithOperationContext({
    requestId: randomUUID(),
    idempotencyKey: randomUUID(),
    requestHash,
    command: `novel_${name}`,
  }, work);
}

function commandWithRequestHash<T>(name: string, requestHash: string, work: () => Promise<T>): Promise<T> {
  return runWithOperationContext({
    requestId: randomUUID(),
    idempotencyKey: randomUUID(),
    requestHash,
    command: `novel_${name}`,
  }, work);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, stableValue(entry)]));
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
}

async function treeSnapshot(root: string): Promise<string[]> {
  const snapshot: string[] = [];
  async function visit(directory: string, relativeDirectory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        snapshot.push(`directory:${relativePath}`);
        await visit(absolutePath, relativePath);
      } else if (entry.isFile()) {
        snapshot.push(`file:${relativePath}:${createHash("sha256").update(await readFile(absolutePath)).digest("hex")}`);
      } else {
        snapshot.push(`other:${relativePath}`);
      }
    }
  }
  await visit(root, "");
  return snapshot;
}

async function interruptedSaveFixture() {
  const { repository, shell, parent } = await fixture();
  const initialized = await command("initialize_manuscript", () => repository.initialize());
  const created = await command("create_chapter", () => repository.createChapter({
    volumeId: initialized.chapters!.volumes[0]!.volumeId,
    title: "恢复审计章",
    content: "before",
    expectedManifestRevision: initialized.chapters!.revision,
  }));
  const requestHash = createHash("sha256").update(`interrupted:${randomUUID()}`).digest("hex");
  process.env.AI_CANVAS_TEST_NOVEL_MUTATION_INTERRUPT = "after-file-mutation";
  await expect(commandWithRequestHash("save_chapter", requestHash, () => repository.saveChapter({
    chapterId: created.chapter!.chapterId,
    content: "after",
    expectedRevision: created.chapter!.revision,
    expectedSha256: created.chapter!.sha256,
  }))).rejects.toThrow(/test-only novel mutation interruption/u);
  delete process.env.AI_CANVAS_TEST_NOVEL_MUTATION_INTERRUPT;
  const operationDirectory = path.join(shell.paths.root, ".aicanvas", "novel", "operations", requestHash);
  return {
    parent,
    shell,
    repository,
    requestHash,
    operationDirectory,
    manifestPath: path.join(shell.paths.root, "manuscript", "chapters.json"),
  };
}

async function writeFakeCompletedReceipt(operationDirectory: string): Promise<void> {
  const intent = JSON.parse(await readFile(path.join(operationDirectory, "intent.json"), "utf8")) as Record<string, unknown>;
  const after = JSON.parse(await readFile(path.join(operationDirectory, "after-manifest.json"), "utf8")) as Record<string, unknown>;
  const payload = {
    schemaVersion: 1,
    kind: "novel-manuscript-mutation-receipt",
    operationId: intent.operationId,
    requestHash: intent.requestHash,
    command: intent.command,
    projectId: intent.projectId,
    manifestRevision: after.revision,
    manifestSha256: intent.afterManifestSha256,
    completedAt: "2026-08-01T00:00:00.000Z",
    intentFingerprint: intent.fingerprint,
  };
  await writeFile(path.join(operationDirectory, "completed.json"), `${JSON.stringify({
    ...payload,
    fingerprint: fingerprint(payload),
  }, null, 2)}\n`, "utf8");
}

async function publishImportAdoptionCrashWindow(
  shell: Awaited<ReturnType<typeof createManagedProject>>,
  options: { corruptChapter?: boolean } = {},
) {
  const receiptId = "receipt-adoption-recovery-0001";
  const volumeId = randomUUID();
  const chapterId = randomUUID();
  const relativePath = `manuscript/volumes/${volumeId}/${chapterId}.md`;
  const expectedContent = "导入后等待激活的正文";
  const actualContent = options.corruptChapter ? "导入后已遭外部篡改" : expectedContent;
  const expectedBytes = Buffer.from(expectedContent, "utf8");
  const now = "2026-08-01T00:00:00.000Z";
  const chapterManifest = {
    schemaVersion: 1,
    kind: "novel-chapter-manifest",
    projectId: shell.project.id,
    revision: 1,
    volumes: [{ volumeId, title: "第一卷", order: 0, revision: 1 }],
    chapters: [{
      chapterId,
      volumeId,
      title: "第一章",
      order: 0,
      relativePath,
      sha256: createHash("sha256").update(expectedBytes).digest("hex"),
      byteLength: expectedBytes.byteLength,
      charCount: expectedContent.length,
      offsetEncoding: "utf16-code-unit",
      revision: 1,
      sourceReceiptId: receiptId,
      createdAt: now,
      updatedAt: now,
    }],
    updatedAt: now,
  };
  const chapterManifestBytes = Buffer.from(`${JSON.stringify(chapterManifest, null, 2)}\n`, "utf8");
  const workspacePayload = {
    schemaVersion: 1,
    kind: "novel-workspace-manifest",
    projectId: shell.project.id,
    sourceMode: "managed_markdown",
    chapterManifest: "manuscript/chapters.json",
    sourceReceiptIds: [receiptId],
    revision: 1,
    createdAt: now,
    updatedAt: now,
  };
  await mkdir(path.join(shell.paths.root, "manuscript", "volumes", volumeId), { recursive: true });
  await mkdir(path.join(shell.paths.root, ".aicanvas", "novel"), { recursive: true });
  await writeFile(path.join(shell.paths.root, ...relativePath.split("/")), actualContent, "utf8");
  await writeFile(path.join(shell.paths.root, "manuscript", "chapters.json"), chapterManifestBytes);
  await writeFile(path.join(shell.paths.root, ".aicanvas", "novel", "manifest.json"), `${JSON.stringify({
    ...workspacePayload,
    fingerprint: fingerprint(workspacePayload),
  }, null, 2)}\n`, "utf8");
  return {
    receiptId,
    chapterId,
    expectedChapterManifestSha256: createHash("sha256").update(chapterManifestBytes).digest("hex"),
  };
}

afterEach(async () => {
  delete process.env.AI_CANVAS_TEST_NOVEL_MUTATION_INTERRUPT;
  delete process.env.AI_CANVAS_TEST_NOVEL_OPERATION_PERSIST_INTERRUPT;
  delete process.env.AI_CANVAS_TEST_NOVEL_INITIALIZE_INTERRUPT;
  setNovelDerivedSearchBeforeActivationHookForTests(undefined);
  resetNovelDerivedSearchIdentityCacheForTests();
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("NovelRepository", () => {
  it("初始化 managed Markdown，并用 stable UUID 创建、改名、移卷和重排", async () => {
    const { repository, shell } = await fixture("hybrid");
    const initialized = await command("initialize_manuscript", () => repository.initialize());
    expect(initialized.workspace).toMatchObject({
      projectId: shell.project.id,
      sourceMode: "managed_markdown",
      chapterManifest: "manuscript/chapters.json",
    });
    expect(initialized.chapters?.volumes).toHaveLength(1);

    const firstVolumeId = initialized.chapters!.volumes[0]!.volumeId;
    const created = await command("create_chapter", () => repository.createChapter({
      volumeId: firstVolumeId,
      title: "第一章 青铜树下",
      content: "阿航在青铜树下醒来。",
      expectedManifestRevision: initialized.chapters!.revision,
    }));
    const stableId = created.chapter!.chapterId;
    expect(created.chapter?.relativePath).toBe(`manuscript/volumes/${firstVolumeId}/${stableId}.md`);

    const renamed = await command("rename_chapter", () => repository.renameChapter({
      chapterId: stableId,
      title: "第一章 神树之声",
      expectedRevision: created.chapter!.revision,
      expectedManifestRevision: created.manifest.revision,
    }));
    expect(renamed.chapter?.chapterId).toBe(stableId);
    expect(renamed.chapter?.relativePath).toBe(created.chapter?.relativePath);

    const secondVolume = await command("create_volume", () => repository.createVolume({
      title: "第二卷",
      expectedManifestRevision: renamed.manifest.revision,
    }));
    const moved = await command("move_chapter", () => repository.moveChapter({
      chapterId: stableId,
      volumeId: secondVolume.volume.volumeId,
      expectedRevision: renamed.chapter!.revision,
      expectedSha256: renamed.chapter!.sha256,
      expectedManifestRevision: secondVolume.manifest.revision,
    }));
    expect(moved.chapter?.chapterId).toBe(stableId);
    expect(moved.chapter?.relativePath).toBe(`manuscript/volumes/${secondVolume.volume.volumeId}/${stableId}.md`);

    const second = await command("create_chapter", () => repository.createChapter({
      volumeId: secondVolume.volume.volumeId,
      title: "第二章",
      content: "黑雨降下。",
      expectedManifestRevision: moved.manifest.revision,
    }));
    const reordered = await command("reorder_chapters", () => repository.reorderChapters({
      orderedChapterIds: [second.chapter!.chapterId, stableId],
      expectedManifestRevision: second.manifest.revision,
    }));
    expect(new Set(reordered.manifest.chapters.map((chapter) => chapter.chapterId)))
      .toEqual(new Set([stableId, second.chapter!.chapterId]));

    const read = await repository.readChapter(stableId);
    expect(read).toMatchObject({ status: "healthy", content: "阿航在青铜树下醒来。" });
  });

  it("导航投影只返回有界卷页，章节分页按卷隔离并可用锚点定位", async () => {
    const { repository } = await fixture();
    const initialized = await command("initialize_manuscript", () => repository.initialize());
    const firstVolumeId = initialized.chapters!.volumes[0]!.volumeId;
    const secondVolume = await command("create_volume", () => repository.createVolume({
      title: "第二卷",
      expectedManifestRevision: initialized.chapters!.revision,
    }));
    const first = await command("create_chapter", () => repository.createChapter({
      volumeId: firstVolumeId,
      title: "第一卷第一章",
      content: "甲乙丙",
      expectedManifestRevision: secondVolume.manifest.revision,
    }));
    const second = await command("create_chapter", () => repository.createChapter({
      volumeId: firstVolumeId,
      title: "第一卷第二章",
      content: "丁戊",
      expectedManifestRevision: first.manifest.revision,
    }));
    const third = await command("create_chapter", () => repository.createChapter({
      volumeId: secondVolume.volume.volumeId,
      title: "第二卷第一章",
      content: "己庚辛壬",
      expectedManifestRevision: second.manifest.revision,
    }));

    const firstNavigationPage = await repository.getNavigation({ offset: 0, limit: 1 });
    expect(firstNavigationPage).toMatchObject({
      manifestRevision: third.manifest.revision,
      totals: { volumeCount: 2, chapterCount: 3, charCount: 9 },
      volumes: {
        total: 2,
        offset: 0,
        limit: 1,
        items: [{ volumeId: firstVolumeId, chapterCount: 2, charCount: 5 }],
      },
    });
    expect((await repository.getNavigation({ offset: 1, limit: 1 })).volumes.items)
      .toEqual([expect.objectContaining({
        volumeId: secondVolume.volume.volumeId,
        chapterCount: 1,
        charCount: 4,
      })]);
    expect((await repository.getNavigation({
      offset: 0,
      limit: 1,
      anchorVolumeId: secondVolume.volume.volumeId,
    })).volumes).toMatchObject({
      offset: 1,
      items: [{ volumeId: secondVolume.volume.volumeId }],
    });
    await expect(repository.getNavigation({ offset: 0, limit: 51 })).rejects.toThrow(/卷导航分页/u);

    const anchored = await repository.listChapters({
      volumeId: firstVolumeId,
      anchorChapterId: second.chapter!.chapterId,
      offset: 0,
      limit: 1,
    });
    expect(anchored).toMatchObject({
      total: 2,
      offset: 1,
      limit: 1,
      items: [{ chapterId: second.chapter!.chapterId, volumeId: firstVolumeId }],
    });
    expect((await repository.listChapters({
      volumeId: secondVolume.volume.volumeId,
      offset: 0,
      limit: 100,
    })).items).toEqual([expect.objectContaining({ chapterId: third.chapter!.chapterId })]);
    await expect(repository.listChapters({
      volumeId: secondVolume.volume.volumeId,
      anchorChapterId: first.chapter!.chapterId,
      limit: 100,
    })).rejects.toThrow(/锚点不在当前卷章范围/u);
  });

  it("pending-marker layout 保留旧 operation locator，并可从无 layout 的 legacy archive 一次升级", async () => {
    const { repository, shell } = await fixture();
    const initialized = await command("initialize_manuscript", () => repository.initialize());
    const requestHash = createHash("sha256").update("pending-marker-layout-fixture").digest("hex");
    await commandWithRequestHash("create_chapter", requestHash, () => repository.createChapter({
      volumeId: initialized.chapters!.volumes[0]!.volumeId,
      title: "marker layout",
      content: "旧 locator 不迁移。",
      expectedManifestRevision: initialized.chapters!.revision,
    }));
    const operationsRoot = path.join(shell.paths.root, ".aicanvas", "novel", "operations");
    expect(JSON.parse(await readFile(path.join(operationsRoot, "layout.json"), "utf8")))
      .toMatchObject({ strategy: "pending-markers-v1", projectId: shell.project.id });
    expect(await readdir(path.join(operationsRoot, "pending"))).toEqual([]);
    expect(await readdir(path.join(operationsRoot, "completed-markers"))).toEqual([`${requestHash}.json`]);
    expect((await readdir(path.join(operationsRoot, requestHash))).sort()).toEqual([
      "after-content.bin", "after-manifest.json", "completed.json", "intent.json",
    ]);

    await rm(path.join(operationsRoot, "layout.json"));
    await rm(path.join(operationsRoot, "pending"), { recursive: true, force: true });
    await rm(path.join(operationsRoot, "completed-markers"), { recursive: true, force: true });
    expect(await command("recover_legacy_archive", () => repository.recoverIncompleteOperations())).toBe(0);
    expect(JSON.parse(await readFile(path.join(operationsRoot, "layout.json"), "utf8")))
      .toMatchObject({ strategy: "pending-markers-v1", projectId: shell.project.id });
    expect((await readdir(path.join(operationsRoot, requestHash))).sort()).toEqual([
      "after-content.bin", "after-manifest.json", "completed.json", "intent.json",
    ]);
  });

  it("单次一致性搜索复用 manifest，并返回可反查的 UTF-16 offset", async () => {
    const { repository, shell } = await fixture();
    const initialized = await command("initialize_manuscript", () => repository.initialize());
    const volumeId = initialized.chapters!.volumes[0]!.volumeId;
    const firstContent = "序章。青铜铃在风中响起。青铜铃再次响起。";
    const first = await command("create_chapter", () => repository.createChapter({
      volumeId,
      title: "第一章",
      content: firstContent,
      expectedManifestRevision: initialized.chapters!.revision,
    }));
    const second = await command("create_chapter", () => repository.createChapter({
      volumeId,
      title: "第二章",
      content: "这一章没有目标词。",
      expectedManifestRevision: first.manifest.revision,
    }));

    const result = await repository.searchChapters({ query: " 青铜铃 ", limit: 10, maxHitsPerChapter: 5 });
    expect(result).toMatchObject({
      query: "青铜铃",
      manifestRevision: second.manifest.revision,
      engine: "linear_scan",
      indexedChapters: 0,
      indexState: "missing",
      fallbackReason: "index_missing",
      scannedChapters: 2,
      skippedExternalChanges: 0,
    });
    expect(result.hits).toHaveLength(2);
    expect(result.hits.every((hit) => hit.chapter.chapterId === first.chapter!.chapterId)).toBe(true);
    expect(result.hits.map((hit) => firstContent.slice(hit.startOffset, hit.endOffset)))
      .toEqual(["青铜铃", "青铜铃"]);

    await writeFile(path.join(shell.paths.root, ...second.chapter!.relativePath.split("/")), "外部编辑写入青铜铃。", "utf8");
    const withExternalChange = await repository.searchChapters({ query: "青铜铃" });
    expect(withExternalChange.hits).toHaveLength(2);
    expect(withExternalChange.skippedExternalChanges).toBe(1);
    await expect(repository.searchChapters({ query: "青" })).rejects.toThrow(/2–200/u);
  });

  it("显式构建 FTS5 generation，并在短词、stale、外部漂移和中断时安全回退", async () => {
    const { repository, shell } = await fixture();
    const initialized = await command("initialize_manuscript", () => repository.initialize());
    const volumeId = initialized.chapters!.volumes[0]!.volumeId;
    const first = await command("create_chapter", () => repository.createChapter({
      volumeId,
      title: "索引命中章",
      content: "月下青铜树发光，账本翻到第十一页。",
      expectedManifestRevision: initialized.chapters!.revision,
    }));
    const second = await command("create_chapter", () => repository.createChapter({
      volumeId,
      title: "索引未命中章",
      content: "这一章只写风声。",
      expectedManifestRevision: first.manifest.revision,
    }));

    const beforeStatus = await treeSnapshot(shell.paths.root);
    expect(await repository.getSearchIndexStatus()).toMatchObject({ state: "missing", pendingGenerationCount: 0 });
    expect(await treeSnapshot(shell.paths.root)).toEqual(beforeStatus);

    const built = await command("rebuild_search_index", () => repository.rebuildSearchIndex());
    expect(built).toMatchObject({
      state: "fresh",
      pendingGenerationCount: 0,
      activeGeneration: {
        status: "active",
        manifestRevision: second.manifest.revision,
        chapterCount: 2,
        indexedChapterCount: 2,
      },
    });
    const firstGenerationId = built.activeGeneration!.generationId;

    const indexed = await repository.searchChapters({ query: "青铜树" });
    expect(indexed).toMatchObject({
      engine: "fts5_trigram",
      indexedChapters: 2,
      indexState: "fresh",
      indexGenerationId: firstGenerationId,
      scannedChapters: 1,
      skippedExternalChanges: 0,
    });
    expect(indexed).not.toHaveProperty("fallbackReason");
    expect(indexed.hits.map((hit) => hit.chapter.chapterId)).toEqual([first.chapter!.chapterId]);
    expect(getNovelDerivedSearchIdentityCacheMetricsForTests()).toMatchObject({
      fullScans: 1,
      fullIdentityChecks: 2,
      hotCacheHits: 0,
      candidateIdentityChecks: 1,
    });

    const indexedHot = await repository.searchChapters({ query: "青铜树" });
    expect(indexedHot).toMatchObject({ engine: "fts5_trigram", scannedChapters: 1 });
    expect(getNovelDerivedSearchIdentityCacheMetricsForTests()).toMatchObject({
      fullScans: 1,
      fullIdentityChecks: 2,
      hotCacheHits: 1,
      candidateIdentityChecks: 2,
    });

    expect(await repository.searchChapters({ query: "青铜" })).toMatchObject({
      engine: "linear_scan",
      indexState: "fresh",
      fallbackReason: "query_too_short",
      scannedChapters: 2,
    });

    const third = await command("create_chapter", () => repository.createChapter({
      volumeId,
      title: "使索引陈旧的章节",
      content: "仍然没有目标词。",
      expectedManifestRevision: second.manifest.revision,
    }));
    expect(await repository.searchChapters({ query: "青铜树" })).toMatchObject({
      engine: "linear_scan",
      indexState: "stale",
      fallbackReason: "index_stale",
      scannedChapters: 3,
    });

    process.env.AI_CANVAS_TEST_NOVEL_SEARCH_INTERRUPT = "after-building-generation";
    await expect(command("rebuild_search_index", () => repository.rebuildSearchIndex()))
      .rejects.toThrow(/test-only novel search index interruption/u);
    delete process.env.AI_CANVAS_TEST_NOVEL_SEARCH_INTERRUPT;
    const interrupted = await repository.getSearchIndexStatus();
    expect(interrupted).toMatchObject({
      state: "stale",
      pendingGenerationCount: 1,
      activeGeneration: { generationId: firstGenerationId },
    });

    const rebuilt = await command("rebuild_search_index", () => repository.rebuildSearchIndex());
    expect(rebuilt).toMatchObject({
      state: "fresh",
      pendingGenerationCount: 0,
      activeGeneration: { manifestRevision: third.manifest.revision, indexedChapterCount: 3 },
    });
    expect(rebuilt.activeGeneration!.generationId).not.toBe(firstGenerationId);

    await writeFile(
      path.join(shell.paths.root, ...second.chapter!.relativePath.split("/")),
      "外部改写加入青铜树。",
      "utf8",
    );
    const drifted = await repository.searchChapters({ query: "青铜树" });
    expect(drifted).toMatchObject({
      engine: "linear_scan",
      indexState: "fresh",
      fallbackReason: "chapter_identity_changed",
      scannedChapters: 3,
      skippedExternalChanges: 1,
    });
    expect(drifted.hits.map((hit) => hit.chapter.chapterId)).toEqual([first.chapter!.chapterId]);
  });

  it("派生索引激活与正文写入共享互斥，重建不得对已经变化的 manifest 返回伪 fresh", async () => {
    const { repository, shell } = await fixture();
    const initialized = await command("initialize_manuscript", () => repository.initialize());
    const created = await command("create_chapter", () => repository.createChapter({
      volumeId: initialized.chapters!.volumes[0]!.volumeId,
      title: "索引激活竞态章",
      content: "青铜树初稿。",
      expectedManifestRevision: initialized.chapters!.revision,
    }));
    let signalActivationWindow!: () => void;
    const activationWindowEntered = new Promise<void>((resolve) => {
      signalActivationWindow = resolve;
    });
    let releaseActivationWindow!: () => void;
    const activationWindowRelease = new Promise<void>((resolve) => {
      releaseActivationWindow = resolve;
    });
    setNovelDerivedSearchBeforeActivationHookForTests(async () => {
      signalActivationWindow();
      await activationWindowRelease;
    });
    const completionOrder: string[] = [];
    const rebuilding = command("rebuild_search_index", () => repository.rebuildSearchIndex())
      .then((result) => {
        completionOrder.push("rebuild");
        return result;
      });

    await activationWindowEntered;
    const heldLockNames = (await listProjectLocks(shell.paths.root)).map((lock) => lock.name);

    let saveSettled = false;
    const saving = command("save_chapter", () => repository.saveChapter({
      chapterId: created.chapter!.chapterId,
      content: "青铜树第二稿。",
      expectedRevision: created.chapter!.revision,
      expectedSha256: created.chapter!.sha256,
    })).then((result) => {
      saveSettled = true;
      completionOrder.push("save");
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const saveSettledWhileActivationBlocked = saveSettled;
    releaseActivationWindow();
    const [rebuilt, saved] = await Promise.all([rebuilding, saving]);

    expect(heldLockNames).toEqual(["novel-manuscript"]);
    expect(saveSettledWhileActivationBlocked).toBe(false);
    expect(completionOrder).toEqual(["rebuild", "save"]);
    expect(rebuilt).toMatchObject({
      state: "fresh",
      activeGeneration: { manifestRevision: created.manifest.revision },
    });
    expect(saved.chapter).toMatchObject({ revision: created.chapter!.revision + 1 });
    expect(await repository.getSearchIndexStatus()).toMatchObject({ state: "stale" });
  });

  it("Repository 边界也拒绝 rehearsal 权威正文写入", async () => {
    const { repository } = await fixture();
    const initialized = await command("initialize_manuscript", () => repository.initialize());
    const created = await command("create_chapter", () => repository.createChapter({
      volumeId: initialized.chapters!.volumes[0]!.volumeId,
      title: "Repository 演练门禁",
      content: "原始正文",
      expectedManifestRevision: initialized.chapters!.revision,
    }));
    const before = await repository.readChapter(created.chapter!.chapterId);

    await expect(command("save_chapter", () => repository.saveChapter({
      chapterId: created.chapter!.chapterId,
      content: "REHEARSAL-MUST-NOT-WRITE",
      expectedRevision: created.chapter!.revision,
      expectedSha256: created.chapter!.sha256,
      aiWriteContext: {
        preflightId: "novel-write-preflight-0123456789abcdef01234567",
        contextPackFingerprint: "b".repeat(64),
        workflowMode: "rehearsal",
      },
    }))).rejects.toMatchObject({
      name: "NovelPreconditionRejectedError",
      result: { applied: false, reason: "workflow_mode_forbidden" },
    });
    expect(await repository.readChapter(created.chapter!.chapterId)).toEqual(before);
  });

  it("派生搜索库损坏时不修库、不写正文，直接回退完整扫描", async () => {
    const { repository, shell } = await fixture();
    const initialized = await command("initialize_manuscript", () => repository.initialize());
    const created = await command("create_chapter", () => repository.createChapter({
      volumeId: initialized.chapters!.volumes[0]!.volumeId,
      title: "损坏回退章",
      content: "青铜树仍在原正文中。",
      expectedManifestRevision: initialized.chapters!.revision,
    }));
    await command("rebuild_search_index", () => repository.rebuildSearchIndex());
    const chapterBefore = await readFile(path.join(shell.paths.root, ...created.chapter!.relativePath.split("/")));
    await writeFile(path.join(shell.paths.root, ".aicanvas", "novel", "novel-derived.sqlite"), "not-a-sqlite-database", "utf8");

    const result = await repository.searchChapters({ query: "青铜树" });
    expect(result).toMatchObject({
      engine: "linear_scan",
      indexState: "corrupt",
      fallbackReason: "index_corrupt",
      scannedChapters: 1,
      skippedExternalChanges: 0,
    });
    expect(result.hits).toHaveLength(1);
    expect(await readFile(path.join(shell.paths.root, ...created.chapter!.relativePath.split("/"))))
      .toEqual(chapterBefore);
  });

  it("用 expectedRevision + expectedSha256 拒绝旧窗口后写覆盖，且历史先于新版本落盘", async () => {
    const { repository, shell } = await fixture();
    const initialized = await command("initialize_manuscript", () => repository.initialize());
    const created = await command("create_chapter", () => repository.createChapter({
      volumeId: initialized.chapters!.volumes[0]!.volumeId,
      title: "CAS 章节",
      content: "第一版",
      expectedManifestRevision: initialized.chapters!.revision,
    }));
    const stale = { revision: created.chapter!.revision, sha256: created.chapter!.sha256 };
    const saved = await command("save_chapter", () => repository.saveChapter({
      chapterId: created.chapter!.chapterId,
      content: "第二版",
      expectedRevision: stale.revision,
      expectedSha256: stale.sha256,
    }));
    expect(saved.chapter?.revision).toBe(stale.revision + 1);
    await expect(command("save_chapter", () => repository.saveChapter({
      chapterId: created.chapter!.chapterId,
      content: "过期窗口的第三版",
      expectedRevision: stale.revision,
      expectedSha256: stale.sha256,
    }))).rejects.toThrow(/CAS 已过期/u);
    expect(await repository.readChapter(created.chapter!.chapterId))
      .toMatchObject({ status: "healthy", content: "第二版" });

    const history = path.join(
      shell.paths.root,
      ".aicanvas/history/story/chapters",
      created.chapter!.chapterId,
      "sha256",
      `${stale.sha256}.md`,
    );
    expect(await readFile(history, "utf8")).toBe("第一版");
  });

  it("外部改写后读取显示 external_change，正式保存失败关闭", async () => {
    const { repository, shell } = await fixture();
    const initialized = await command("initialize_manuscript", () => repository.initialize());
    const created = await command("create_chapter", () => repository.createChapter({
      volumeId: initialized.chapters!.volumes[0]!.volumeId,
      title: "外部编辑",
      content: "应用内版本",
      expectedManifestRevision: initialized.chapters!.revision,
    }));
    await writeFile(path.join(shell.paths.root, ...created.chapter!.relativePath.split("/")), "外部编辑器版本", "utf8");

    expect(await repository.readChapter(created.chapter!.chapterId)).toMatchObject({ status: "external_change" });
    await expect(command("save_chapter", () => repository.saveChapter({
      chapterId: created.chapter!.chapterId,
      content: "不得覆盖",
      expectedRevision: created.chapter!.revision,
      expectedSha256: created.chapter!.sha256,
    }))).rejects.toThrow(/外部修改/u);
    expect(await readFile(path.join(shell.paths.root, ...created.chapter!.relativePath.split("/")), "utf8"))
      .toBe("外部编辑器版本");
  });

  it("崩溃在正文替换与 manifest 提交之间时，下次命令按 intent 向前恢复", async () => {
    const { repository } = await fixture();
    const initialized = await command("initialize_manuscript", () => repository.initialize());
    const created = await command("create_chapter", () => repository.createChapter({
      volumeId: initialized.chapters!.volumes[0]!.volumeId,
      title: "崩溃恢复",
      content: "before",
      expectedManifestRevision: initialized.chapters!.revision,
    }));
    process.env.AI_CANVAS_TEST_NOVEL_MUTATION_INTERRUPT = "after-file-mutation";
    await expect(command("save_chapter", () => repository.saveChapter({
      chapterId: created.chapter!.chapterId,
      content: "after",
      expectedRevision: created.chapter!.revision,
      expectedSha256: created.chapter!.sha256,
    }))).rejects.toThrow(/test-only novel mutation interruption/u);
    delete process.env.AI_CANVAS_TEST_NOVEL_MUTATION_INTERRUPT;

    expect(await command("recover_manuscript", () => repository.recoverIncompleteOperations())).toBe(1);
    expect(await repository.readChapter(created.chapter!.chapterId))
      .toMatchObject({ status: "healthy", content: "after" });
  });

  it.each([
    "after-operation-directory",
    "after-content",
    "after-manifest",
    "after-intent",
  ] as const)("operation 工件持久化在 %s 中断后可确定性续写/恢复", async (phase) => {
    const { repository, shell } = await fixture();
    const initialized = await command("initialize_manuscript", () => repository.initialize());
    const created = await command("create_chapter", () => repository.createChapter({
      volumeId: initialized.chapters!.volumes[0]!.volumeId,
      title: "工件提交点",
      content: "before-persist",
      expectedManifestRevision: initialized.chapters!.revision,
    }));
    const requestHash = createHash("sha256").update(`operation-persist:${phase}`).digest("hex");
    const save = () => repository.saveChapter({
      chapterId: created.chapter!.chapterId,
      content: "after-persist",
      expectedRevision: created.chapter!.revision,
      expectedSha256: created.chapter!.sha256,
    });
    process.env.AI_CANVAS_TEST_NOVEL_OPERATION_PERSIST_INTERRUPT = phase;
    await expect(commandWithRequestHash("save_chapter", requestHash, save))
      .rejects.toThrow(`test-only novel operation persistence interruption: ${phase}`);
    delete process.env.AI_CANVAS_TEST_NOVEL_OPERATION_PERSIST_INTERRUPT;

    if (phase === "after-intent") {
      expect(await command("recover_persisted_intent", () => repository.recoverIncompleteOperations())).toBe(1);
    } else {
      // intent.json 未提交的 prepared 目录不得被 recovery 执行，
      // 但也不得阻断同 requestHash 用同字节续写。
      expect(await command("skip_prepared_operation", () => repository.recoverIncompleteOperations())).toBe(0);
      await expect(commandWithRequestHash("save_chapter", requestHash, save)).resolves.toMatchObject({ changed: true });
    }

    await expect(repository.readChapter(created.chapter!.chapterId))
      .resolves.toMatchObject({ status: "healthy", content: "after-persist" });
    const operationRoot = path.join(shell.paths.root, ".aicanvas", "novel", "operations", requestHash);
    expect((await readdir(operationRoot)).sort()).toEqual([
      "after-content.bin", "after-manifest.json", "completed.json", "intent.json",
    ]);
  });

  it("intent-less prepared operation 含多余节点时失败关闭，且不阻断合法准备目录的只读识别", async () => {
    const { repository, shell } = await fixture();
    await command("initialize_manuscript", () => repository.initialize());
    const requestHash = createHash("sha256").update("illegal-intentless-prepared").digest("hex");
    const operationRoot = path.join(shell.paths.root, ".aicanvas", "novel", "operations", requestHash);
    await mkdir(operationRoot, { recursive: true });
    await writeFile(path.join(operationRoot, "unowned.bin"), "must-fail-closed", "utf8");
    const before = await treeSnapshot(shell.paths.root);

    await expect(command("recover_illegal_prepared", () => repository.recoverIncompleteOperations()))
      .rejects.toThrow(/无法归属的工件 unowned\.bin/u);
    expect(await treeSnapshot(shell.paths.root)).toEqual(before);
  });

  it("坏 intent 在任何恢复写入前失败，正文与 manifest 均保持现场", async () => {
    const fixture = await interruptedSaveFixture();
    const intentPath = path.join(fixture.operationDirectory, "intent.json");
    const intent = JSON.parse(await readFile(intentPath, "utf8")) as Record<string, unknown>;
    const fileMutation = { ...(intent.fileMutation as Record<string, unknown>), sourceLocator: "manuscript/volumes/00000000-0000-4000-8000-000000000000/00000000-0000-4000-8000-000000000001.md" };
    const payload: Record<string, unknown> = { ...intent, fileMutation };
    delete payload.fingerprint;
    await writeFile(intentPath, `${JSON.stringify({ ...payload, fingerprint: fingerprint(payload) }, null, 2)}\n`, "utf8");

    const before = await treeSnapshot(fixture.shell.paths.root);
    await expect(command("recover_bad_intent", () => fixture.repository.recoverIncompleteOperations()))
      .rejects.toThrow(/replace locator 不属于 before/u);
    expect(await treeSnapshot(fixture.shell.paths.root)).toEqual(before);
  });

  it("语义越权的 after manifest 即使同步更新 intent SHA/fingerprint 也零写失败", async () => {
    const fixture = await interruptedSaveFixture();
    const intentPath = path.join(fixture.operationDirectory, "intent.json");
    const afterPath = path.join(fixture.operationDirectory, "after-manifest.json");
    const after = JSON.parse(await readFile(afterPath, "utf8")) as { chapters: Array<Record<string, unknown>> } & Record<string, unknown>;
    after.chapters[0] = { ...after.chapters[0], title: "越权篡改标题" };
    const afterBytes = Buffer.from(`${JSON.stringify(after, null, 2)}\n`, "utf8");
    await writeFile(afterPath, afterBytes);
    const intent = JSON.parse(await readFile(intentPath, "utf8")) as Record<string, unknown>;
    const payload: Record<string, unknown> = { ...intent, afterManifestSha256: createHash("sha256").update(afterBytes).digest("hex") };
    delete payload.fingerprint;
    await writeFile(intentPath, `${JSON.stringify({ ...payload, fingerprint: fingerprint(payload) }, null, 2)}\n`, "utf8");

    const before = await treeSnapshot(fixture.shell.paths.root);
    await expect(command("recover_bad_after", () => fixture.repository.recoverIncompleteOperations()))
      .rejects.toThrow(/非法修改 save\.chapter/u);
    expect(await treeSnapshot(fixture.shell.paths.root)).toEqual(before);
  });

  it("伪造 completed receipt 不能跳过恢复：当前 manifest 落后时零写失败", async () => {
    const fixture = await interruptedSaveFixture();
    await writeFakeCompletedReceipt(fixture.operationDirectory);
    const before = await treeSnapshot(fixture.shell.paths.root);
    await expect(command("recover_fake_completed", () => fixture.repository.recoverIncompleteOperations()))
      .rejects.toThrow(/超前于当前 project manifest/u);
    expect(await treeSnapshot(fixture.shell.paths.root)).toEqual(before);
  });

  it.each([
    "intent.json",
    "after-manifest.json",
    "after-content.bin",
    "completed.json",
    "history-manifest",
    "current-manifest",
    "current-chapter",
  ])(
    "恢复依赖文件 %s 被换成工程外同字节 hardlink 时零写失败",
    async (artifactName) => {
      const fixture = await interruptedSaveFixture();
      if (artifactName === "completed.json") await writeFakeCompletedReceipt(fixture.operationDirectory);
      const intent = JSON.parse(await readFile(path.join(fixture.operationDirectory, "intent.json"), "utf8")) as {
        beforeManifestSha256: string;
      };
      const currentManifest = JSON.parse(await readFile(fixture.manifestPath, "utf8")) as {
        chapters: Array<{ relativePath: string }>;
      };
      const artifactPath = artifactName === "history-manifest" ? path.join(
          fixture.shell.paths.root,
          ".aicanvas", "history", "story", "manifests", "sha256",
          `${intent.beforeManifestSha256}.json`,
        )
        : artifactName === "current-manifest" ? fixture.manifestPath
          : artifactName === "current-chapter"
            ? path.join(fixture.shell.paths.root, ...currentManifest.chapters[0]!.relativePath.split("/"))
            : path.join(fixture.operationDirectory, artifactName);
      const outsidePath = path.join(fixture.parent, `outside-${artifactName.replace(/[^a-z.-]/gu, "-")}-${randomUUID()}`);
      const outsideBytes = await readFile(artifactPath);
      await writeFile(outsidePath, outsideBytes);
      await unlink(artifactPath);
      await link(outsidePath, artifactPath);

      const before = await treeSnapshot(fixture.shell.paths.root);
      await expect(command(`recover_hardlink_${artifactName}`, () => fixture.repository.recoverIncompleteOperations()))
        .rejects.toThrow(/nlink=1/u);
      expect(await treeSnapshot(fixture.shell.paths.root)).toEqual(before);
      expect(await readFile(outsidePath)).toEqual(outsideBytes);
    },
  );

  it("external_snapshot 保持只读，不生成可写 chapter manifest", async () => {
    const { repository, shell } = await fixture();
    const initialized = await command("initialize_external_snapshot", () => repository.initialize("external_snapshot"));
    expect(initialized).toMatchObject({ workspace: { sourceMode: "external_snapshot" }, chapters: null });
    await expect(readFile(path.join(shell.paths.root, "manuscript", "chapters.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["after-chapters", "after-workspace", "after-attach"] as const)(
    "initialize 在 %s 中断后复用 intent.createdAt/volumeId 确定性向前恢复",
    async (phase) => {
      const { repository, shell } = await fixture();
      const requestHash = createHash("sha256").update(`initialize-crash:${phase}`).digest("hex");
      process.env.AI_CANVAS_TEST_NOVEL_INITIALIZE_INTERRUPT = phase;
      await expect(commandWithRequestHash("initialize_manuscript", requestHash, () => repository.initialize()))
        .rejects.toThrow(`test-only novel initialization interruption: ${phase}`);
      delete process.env.AI_CANVAS_TEST_NOVEL_INITIALIZE_INTERRUPT;

      const recovered = await commandWithRequestHash("initialize_manuscript", requestHash, () => repository.initialize());
      expect(recovered).toMatchObject({
        workspace: { sourceMode: "managed_markdown", projectId: shell.project.id },
        chapters: { revision: 1, volumes: [{ title: "第一卷" }], chapters: [] },
      });
      const initializationRoot = path.join(shell.paths.root, ".aicanvas", "novel", "initializations", requestHash);
      const intent = JSON.parse(await readFile(path.join(initializationRoot, "intent.json"), "utf8")) as {
        createdAt: string;
        volumeId: string;
      };
      expect(recovered.workspace.createdAt).toBe(intent.createdAt);
      expect(recovered.workspace.updatedAt).toBe(intent.createdAt);
      expect(recovered.chapters!.updatedAt).toBe(intent.createdAt);
      expect(recovered.chapters!.volumes[0]!.volumeId).toBe(intent.volumeId);
      expect((await inspectManagedProjectReadOnly(shell.paths.root)).manifest.novelManifest)
        .toBe(".aicanvas/novel/manifest.json");

      const completedTree = await treeSnapshot(shell.paths.root);
      await expect(commandWithRequestHash("initialize_manuscript", requestHash, () => repository.initialize()))
        .resolves.toEqual(recovered);
      expect(await treeSnapshot(shell.paths.root)).toEqual(completedTree);
    },
  );

  it.each(["fingerprint", "extra-field"] as const)(
    "initialize intent %s 损坏时在任何后续写入前失败关闭",
    async (tamperKind) => {
      const { repository, shell } = await fixture();
      const requestHash = createHash("sha256").update(`initialize-intent-tamper:${tamperKind}`).digest("hex");
      process.env.AI_CANVAS_TEST_NOVEL_INITIALIZE_INTERRUPT = "after-chapters";
      await expect(commandWithRequestHash("initialize_manuscript", requestHash, () => repository.initialize()))
        .rejects.toThrow(/initialization interruption/u);
      delete process.env.AI_CANVAS_TEST_NOVEL_INITIALIZE_INTERRUPT;
      const intentPath = path.join(
        shell.paths.root,
        ".aicanvas", "novel", "initializations", requestHash, "intent.json",
      );
      const intent = JSON.parse(await readFile(intentPath, "utf8")) as Record<string, unknown>;
      if (tamperKind === "fingerprint") {
        intent.fingerprint = "0".repeat(64);
      } else {
        intent.unexpected = true;
        const payload = { ...intent };
        delete payload.fingerprint;
        intent.fingerprint = fingerprint(payload);
      }
      await writeFile(intentPath, `${JSON.stringify(intent, null, 2)}\n`, "utf8");
      const before = await treeSnapshot(shell.paths.root);

      await expect(commandWithRequestHash("initialize_manuscript", requestHash, () => repository.initialize()))
        .rejects.toThrow(tamperKind === "fingerprint" ? /fingerprint 不匹配/u : /字段集合无效/u);
      expect(await treeSnapshot(shell.paths.root)).toEqual(before);
      expect((await inspectManagedProjectReadOnly(shell.paths.root)).manifest.novelManifest).toBeUndefined();
    },
  );

  it("导入 workspace 已落但 managed manifest 尚未绑定时，adopt 重放会补绑定且保持幂等", async () => {
    const { repository, shell } = await fixture();
    const published = await publishImportAdoptionCrashWindow(shell);
    expect((await inspectManagedProjectReadOnly(shell.paths.root)).manifest.novelManifest).toBeUndefined();

    const recovered = await command("adopt_imported_manuscript", () => repository.adoptImportedManuscript(published));
    expect(recovered.workspace.sourceReceiptIds).toContain(published.receiptId);
    expect(recovered.chapters?.chapters).toHaveLength(1);
    const attached = await inspectManagedProjectReadOnly(shell.paths.root);
    expect(attached.manifest.novelManifest).toBe(".aicanvas/novel/manifest.json");

    await expect(command("adopt_imported_manuscript", () => repository.adoptImportedManuscript(published)))
      .resolves.toMatchObject({ workspace: { sourceReceiptIds: [published.receiptId] } });
    expect((await inspectManagedProjectReadOnly(shell.paths.root)).manifestFingerprint)
      .toBe(attached.manifestFingerprint);
  });

  it("导入 workspace 崩溃窗口存在错误章节闭包时拒绝补绑 managed manifest", async () => {
    const { repository, shell } = await fixture();
    const published = await publishImportAdoptionCrashWindow(shell, { corruptChapter: true });

    await expect(command("adopt_imported_manuscript", () => repository.adoptImportedManuscript(published)))
      .rejects.toThrow(/导入章节闭包对账失败/u);
    expect((await inspectManagedProjectReadOnly(shell.paths.root)).manifest.novelManifest).toBeUndefined();
  });

  it("无 command bus novel 上下文时拒绝任何正典初始化", async () => {
    const { repository } = await fixture();
    await expect(repository.initialize()).rejects.toThrow(/command bus/u);
  });
});
