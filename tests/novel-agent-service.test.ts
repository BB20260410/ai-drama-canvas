import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { executeIdempotentCommand } from "../src/core/command-bus.js";
import { createManagedProject } from "../src/core/managed-project.js";
import {
  buildNovelContextPack,
  getNovelAgentCapabilities,
  getNovelManuscriptWorkspace,
  getNovelSearchIndexStatus,
  listNovelManuscriptChapters,
  readNovelManuscriptRange,
  resolveNovelAgentProject,
  searchNovelManuscript,
} from "../src/core/novel-agent-service.js";
import { registerProject, setActiveProjectRegistration } from "../src/core/sidecar.js";

const roots: string[] = [];
const originalRegistryPath = process.env.AI_CANVAS_REGISTRY_PATH;
let sequence = 0;

afterEach(async () => {
  if (originalRegistryPath === undefined) delete process.env.AI_CANVAS_REGISTRY_PATH;
  else process.env.AI_CANVAS_REGISTRY_PATH = originalRegistryPath;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function envelope(command: string, payload: Record<string, unknown>) {
  sequence += 1;
  return {
    requestId: `novel-agent-request-${sequence}-${randomUUID()}`,
    idempotencyKey: `novel-agent-key-${sequence}-${randomUUID()}`,
    request: { command, payload },
  } as Parameters<typeof executeIdempotentCommand>[1];
}

async function fixture() {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "novel-agent-service-")));
  roots.push(parent);
  process.env.AI_CANVAS_REGISTRY_PATH = path.join(parent, "registry", "projects.json");
  const shell = await createManagedProject({ parentRoot: parent, name: "AI 小说合同夹具", workspaceMode: "novel" });
  await registerProject(shell.project);
  const initialized = await executeIdempotentCommand(shell.paths.root, envelope(
    "novel_initialize_manuscript",
    { sourceMode: "managed_markdown" },
  ));
  const initResult = initialized.result as { chapters: { revision: number; volumes: Array<{ volumeId: string }> } };
  return { parent, shell, initialized: initResult };
}

async function createChapter(
  root: string,
  volumeId: string,
  expectedManifestRevision: number,
  title: string,
  content: string,
) {
  const record = await executeIdempotentCommand(root, envelope("novel_create_chapter", {
    volumeId,
    title,
    content,
    expectedManifestRevision,
  }), { novelWriteActor: "human_ui" });
  return record.result as {
    chapter: {
      chapterId: string;
      relativePath: string;
      revision: number;
      sha256: string;
      charCount: number;
    };
    manifest: { revision: number };
  };
}

describe("Novel Agent shared service", () => {
  it("暴露固定 AI 合同，并支持显式根与活动登记两种无猜测选择", async () => {
    const { shell } = await fixture();
    expect(getNovelAgentCapabilities()).toMatchObject({
      schemaVersion: 1,
      contract: "aicanvas.novel-agent",
      authority: { derivedDatabaseRequired: false, writes: "execute-command-only" },
      offsets: { encoding: "utf16-code-unit", interval: "half-open" },
      operations: {
        read: expect.arrayContaining([
          "list_writing_source_receipts",
          "compare_writing_source_receipts",
          "get_state_rebuild_status",
        ]),
        writeCommands: expect.arrayContaining([
          "novel_import_writing_source_snapshot",
          "novel_recover_writing_state",
        ]),
        controlTools: ["prepare_novel_chapter_write"],
        controlOperations: [{
          operationId: "prepare_chapter_write",
          transports: {
            mcpTool: "prepare_novel_chapter_write",
            jsonCliOperation: "prepare_novel_chapter_write",
            jsonCliLegacyAliases: ["prepare_chapter_write"],
          },
        }],
      },
      consistency: {
        stateHistory: "append-only-event-checkpoint-with-shadow-rebuild-promotion",
        stateRecovery: "intent-before-after-cas-fail-on-third-sha",
      },
    });
    await expect(resolveNovelAgentProject(shell.paths.root)).resolves.toMatchObject({
      projectId: shell.project.id,
      workspaceMode: "novel",
      selection: "explicit",
    });
    await setActiveProjectRegistration(shell.paths.root);
    await expect(resolveNovelAgentProject()).resolves.toMatchObject({
      projectId: shell.project.id,
      selection: "active",
    });
  });

  it("在 100 字正文上完成 workspace/list/range/search/context 精确闭环", async () => {
    const { shell, initialized } = await fixture();
    const volumeId = initialized.chapters.volumes[0]!.volumeId;
    const seed = "青铜树下，嘟嘟听见风从古蜀城门穿过。";
    const firstText = seed.repeat(Math.ceil(100 / seed.length)).slice(0, 100);
    expect(firstText).toHaveLength(100);
    const first = await createChapter(
      shell.paths.root,
      volumeId,
      initialized.chapters.revision,
      "第一章 青铜树",
      firstText,
    );
    const futureText = "未来泄漏标记：王城在第二天陷落。";
    const future = await createChapter(
      shell.paths.root,
      volumeId,
      first.manifest.revision,
      "第二章 未发生的未来",
      futureText,
    );

    const workspace = await getNovelManuscriptWorkspace(shell.paths.root);
    expect(workspace).toMatchObject({
      project: { projectId: shell.project.id },
      manuscript: { status: "ready", chapterCount: 2, charCount: 100 + futureText.length },
    });
    const page = await listNovelManuscriptChapters(shell.paths.root, { offset: 0, limit: 1 });
    expect(page).toMatchObject({ total: 2, offset: 0, limit: 1, nextOffset: 1 });
    expect(page.items[0]).toMatchObject({ chapterId: first.chapter.chapterId, relativePath: first.chapter.relativePath });
    expect(JSON.stringify(page.items)).not.toContain(shell.paths.root);

    const range = await readNovelManuscriptRange(shell.paths.root, {
      chapterId: first.chapter.chapterId,
      startOffset: 2,
      maxCharacters: 20,
    });
    expect(range).toMatchObject({
      status: "healthy",
      range: { startOffset: 2, endOffset: 22, totalCharacters: 100, offsetEncoding: "utf16-code-unit" },
      content: firstText.slice(2, 22),
    });

    const indexStatus = await getNovelSearchIndexStatus(shell.paths.root);
    expect(indexStatus).toMatchObject({
      project: { projectId: shell.project.id },
      status: { state: "missing", pendingGenerationCount: 0 },
      rebuild: { tool: "execute_command", request: { command: "novel_rebuild_search_index", payload: {} } },
    });
    await expect(readFile(path.join(shell.paths.root, ".aicanvas", "novel", "novel-derived.sqlite")))
      .rejects.toMatchObject({ code: "ENOENT" });

    const search = await searchNovelManuscript(shell.paths.root, { query: "青铜树", limit: 10 });
    expect(search).toMatchObject({
      engine: "linear_scan",
      indexedChapters: 0,
      indexState: "missing",
      fallbackReason: "index_missing",
      scannedChapters: 2,
      skippedExternalChanges: 0,
    });
    expect(search.hits[0]).toMatchObject({
      chapter: { chapterId: first.chapter.chapterId, sha256: first.chapter.sha256 },
      startOffset: 0,
      endOffset: 3,
      offsetEncoding: "utf16-code-unit",
    });

    const context = await buildNovelContextPack(shell.paths.root, {
      query: "青铜树",
      cutoffChapterId: first.chapter.chapterId,
      maxCharacters: 256,
    });
    expect(context.excerpts).toHaveLength(1);
    expect(context.excerpts[0]).toMatchObject({
      chapter: { chapterId: first.chapter.chapterId, sha256: first.chapter.sha256 },
      reasons: ["query"],
    });
    const excerpt = context.excerpts[0]!;
    expect(firstText.slice(excerpt.range.startOffset, excerpt.range.endOffset)).toBe(excerpt.text);
    expect(context.budget.usedCharacters).toBe(excerpt.text.length);
    expect(context.budget.usedCharacters).toBeLessThanOrEqual(256);
    expect(context.fingerprint).toMatch(/^[a-f0-9]{64}$/u);

    const futureSearch = await buildNovelContextPack(shell.paths.root, {
      query: "未来泄漏标记",
      cutoffChapterId: first.chapter.chapterId,
      maxCharacters: 256,
    });
    expect(futureSearch.excerpts).toEqual([]);
    expect(JSON.stringify(futureSearch)).not.toContain("王城在第二天陷落");
    await expect(buildNovelContextPack(shell.paths.root, {
      chapterIds: [future.chapter.chapterId],
      cutoffChapterId: first.chapter.chapterId,
      maxCharacters: 256,
    })).rejects.toThrow(/未来正文泄漏/u);
  });

  it("上下文预算公平覆盖多章，默认上下文只取截止章前最近三章", async () => {
    const { shell, initialized } = await fixture();
    const volumeId = initialized.chapters.volumes[0]!.volumeId;
    let revision = initialized.chapters.revision;
    const chapters: Array<{ chapterId: string; text: string }> = [];
    for (let index = 1; index <= 5; index += 1) {
      const text = `第${index}章内容`.repeat(100);
      const created = await createChapter(shell.paths.root, volumeId, revision, `第${index}章`, text);
      revision = created.manifest.revision;
      chapters.push({ chapterId: created.chapter.chapterId, text });
    }
    const pack = await buildNovelContextPack(shell.paths.root, {
      cutoffChapterId: chapters[3]!.chapterId,
      maxCharacters: 300,
    });
    expect(pack.excerpts.map((entry) => entry.chapter.chapterId)).toEqual(
      chapters.slice(1, 4).map((chapter) => chapter.chapterId),
    );
    expect(pack.excerpts).toHaveLength(3);
    expect(pack.budget.usedCharacters).toBeLessThanOrEqual(300);
    expect(pack.excerpts.every((entry) => entry.reasons.includes("recent"))).toBe(true);
    expect(JSON.stringify(pack)).not.toContain(chapters[4]!.text);
  });

  it("外部改写返回 external_change，区间读取和 context 都不冒充健康正文", async () => {
    const { shell, initialized } = await fixture();
    const created = await createChapter(
      shell.paths.root,
      initialized.chapters.volumes[0]!.volumeId,
      initialized.chapters.revision,
      "外部变化章",
      "权威正文未被外部改写",
    );
    const absoluteChapter = path.join(shell.paths.root, ...created.chapter.relativePath.split("/"));
    const before = await readFile(absoluteChapter, "utf8");
    expect(before).toBe("权威正文未被外部改写");
    await writeFile(absoluteChapter, "外部工具直接改写", "utf8");

    await expect(readNovelManuscriptRange(shell.paths.root, {
      chapterId: created.chapter.chapterId,
    })).resolves.toMatchObject({
      status: "external_change",
      chapter: { chapterId: created.chapter.chapterId, sha256: created.chapter.sha256 },
    });
    const pack = await buildNovelContextPack(shell.paths.root, {
      chapterIds: [created.chapter.chapterId],
      maxCharacters: 256,
    });
    expect(pack.excerpts).toEqual([]);
    expect(pack.skippedExternalChanges).toHaveLength(1);
    expect(JSON.stringify(pack)).not.toContain("外部工具直接改写");
  });

  it("区间读取拒绝拆开 emoji 的 UTF-16 代理对", async () => {
    const { shell, initialized } = await fixture();
    const created = await createChapter(
      shell.paths.root,
      initialized.chapters.volumes[0]!.volumeId,
      initialized.chapters.revision,
      "UTF-16 边界章",
      "甲😀乙",
    );
    await expect(readNovelManuscriptRange(shell.paths.root, {
      chapterId: created.chapter.chapterId,
      startOffset: 2,
      maxCharacters: 2,
    })).rejects.toThrow(/代理对中间/u);
    const safe = await readNovelManuscriptRange(shell.paths.root, {
      chapterId: created.chapter.chapterId,
      startOffset: 1,
      maxCharacters: 2,
    });
    expect(safe).toMatchObject({ content: "😀", range: { startOffset: 1, endOffset: 3 } });
  });
});
