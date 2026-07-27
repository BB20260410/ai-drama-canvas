import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createManagedProject } from "../src/core/managed-project.js";
import {
  appendStudioPromptRevision,
  appendStudioScriptRevision,
  appendStudioScriptSectionRevision,
  createStudioPromptDocument,
  createStudioScriptDocument,
  getStudioProductionState,
  getStudioScriptSectionRevision,
  initializeStudioProduction,
  listStudioScriptSections,
} from "../src/core/studio-production.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function managedRoot(): Promise<string> {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "studio-section-recovery-")));
  roots.push(parent);
  return (await createManagedProject({ parentRoot: parent, name: "Studio section 恢复" })).paths.root;
}

describe("Studio 章节/场景可恢复读取", () => {
  it("以任一 script revision 锚定同文档 current heads，按 revisionId 读取历史，并固定 section lineage", async () => {
    const root = await managedRoot();
    const bodyV1 = "第一章：阿航入城。\n场景一：阿航走进石室。";
    const bodyV2 = "第一章：阿航入城。\n场景一：阿航走进石室，守卫回头。";
    const document = await createStudioScriptDocument(root, {
      id: "script-sections-main",
      title: "主剧本",
      expectedRevision: 0,
    });
    const scriptV1 = (await appendStudioScriptRevision(root, {
      documentId: document.id,
      expectedRevision: 0,
      body: bodyV1,
      source: "fixture",
      sourceVersion: "v1",
    })).revision;
    const scriptV2 = (await appendStudioScriptRevision(root, {
      documentId: document.id,
      expectedRevision: 1,
      body: bodyV2,
      source: "fixture",
      sourceVersion: "v2",
    })).revision;
    const otherDocument = await createStudioScriptDocument(root, {
      id: "script-sections-other",
      title: "另一剧本",
      expectedRevision: 0,
    });
    const otherScript = (await appendStudioScriptRevision(root, {
      documentId: otherDocument.id,
      expectedRevision: 0,
      body: "另一章：不属于主剧本。",
      source: "fixture",
      sourceVersion: "v1",
    })).revision;
    const promptDocument = await createStudioPromptDocument(root, {
      id: "prompt-sections",
      title: "提示词",
      expectedRevision: 0,
    });
    const promptRevision = (await appendStudioPromptRevision(root, {
      documentId: promptDocument.id,
      expectedRevision: 0,
      body: "电影写实。",
      source: "fixture",
      sourceVersion: "v1",
    })).revision;

    const chapterV1 = await appendStudioScriptSectionRevision(root, {
      sectionId: "chapter-main-01",
      expectedRevision: 0,
      kind: "chapter",
      title: "第一章",
      scriptRevisionId: scriptV1.id,
      scriptSha256: scriptV1.bodySha256,
      startOffsetUtf16: 0,
      endOffsetUtf16: bodyV1.indexOf("\n"),
    });
    const scene = await appendStudioScriptSectionRevision(root, {
      sectionId: "scene-main-01",
      expectedRevision: 0,
      kind: "scene",
      title: "石室",
      scriptRevisionId: scriptV1.id,
      scriptSha256: scriptV1.bodySha256,
      startOffsetUtf16: bodyV1.indexOf("场景一"),
      endOffsetUtf16: bodyV1.length,
    });
    const chapterV2 = await appendStudioScriptSectionRevision(root, {
      sectionId: chapterV1.sectionId,
      expectedRevision: chapterV1.revision,
      kind: "chapter",
      title: "第一章（修订）",
      scriptRevisionId: scriptV2.id,
      scriptSha256: scriptV2.bodySha256,
      startOffsetUtf16: 0,
      endOffsetUtf16: bodyV2.indexOf("\n"),
    });

    await expect(getStudioScriptSectionRevision(root, chapterV1.id)).resolves.toEqual(chapterV1);
    await expect(getStudioScriptSectionRevision(root, chapterV2.id)).resolves.toEqual(chapterV2);
    await expect(getStudioScriptSectionRevision(root, "script-section-missing")).resolves.toBeNull();

    const collect = async (scriptRevisionId: string) => {
      const items = [];
      let cursor: string | undefined;
      do {
        const page = await listStudioScriptSections(root, { scriptRevisionId, cursor, limit: 1 });
        items.push(...page.items);
        cursor = page.nextCursor;
      } while (cursor);
      return items.sort((left, right) => left.sectionId.localeCompare(right.sectionId, "en"));
    };
    const fromV1 = await collect(scriptV1.id);
    const fromV2 = await collect(scriptV2.id);
    expect(fromV1).toEqual([
      expect.objectContaining({ id: chapterV2.id, sectionId: chapterV1.sectionId, revision: 2, scriptRevisionId: scriptV2.id }),
      expect.objectContaining({ id: scene.id, sectionId: scene.sectionId, revision: 1, scriptRevisionId: scriptV1.id }),
    ]);
    expect(fromV2).toEqual(fromV1);
    expect((await listStudioScriptSections(root, { scriptRevisionId: otherScript.id, limit: 100 })).items).toEqual([]);
    await expect(listStudioScriptSections(root, { scriptRevisionId: scriptV1.id, limit: 101 })).rejects.toThrow("1-100");
    await expect(listStudioScriptSections(root, { scriptRevisionId: promptRevision.id })).rejects.toThrow("剧本修订不存在");

    const firstPage = await listStudioScriptSections(root, { scriptRevisionId: scriptV1.id, limit: 1 });
    expect(firstPage.nextCursor).toBeTruthy();
    await expect(listStudioScriptSections(root, {
      scriptRevisionId: otherScript.id,
      cursor: firstPage.nextCursor,
      limit: 1,
    })).rejects.toThrow("cursor");

    await expect(appendStudioScriptSectionRevision(root, {
      sectionId: chapterV1.sectionId,
      expectedRevision: chapterV2.revision,
      kind: "scene",
      title: "禁止换 kind",
      scriptRevisionId: scriptV2.id,
      scriptSha256: scriptV2.bodySha256,
      startOffsetUtf16: 0,
      endOffsetUtf16: bodyV2.indexOf("\n"),
    })).rejects.toThrow(/kind 已固定/u);
    await expect(appendStudioScriptSectionRevision(root, {
      sectionId: chapterV1.sectionId,
      expectedRevision: chapterV2.revision,
      kind: "chapter",
      title: "禁止跨文档",
      scriptRevisionId: otherScript.id,
      scriptSha256: otherScript.bodySha256,
      startOffsetUtf16: 0,
      endOffsetUtf16: otherScript.body.length,
    })).rejects.toThrow(/同一 script document/u);

    const db = new DatabaseSync(path.join(root, ".aicanvas", "studio-production.sqlite"));
    try {
      expect(() => db.prepare(`INSERT INTO studio_script_section_revisions(
        id, section_id, revision, kind, title, script_revision_id, script_sha256,
        start_offset_utf16, end_offset_utf16, surface_sha256, fingerprint, created_at
      ) SELECT ?, section_id, 3, kind, title, ?, ?, 0, ?, surface_sha256, ?, created_at
        FROM studio_script_section_revisions WHERE id = ?`).run(
        "script-section-illegal-cross-document",
        otherScript.id,
        otherScript.bodySha256,
        otherScript.body.length,
        "f".repeat(64),
        chapterV2.id,
      )).toThrow(/lineage mismatch/u);
    } finally {
      db.close();
    }
    expect((await getStudioProductionState(root)).counts.scriptSectionRevisions).toBe(3);

    await initializeStudioProduction(root);
    await expect(getStudioScriptSectionRevision(root, chapterV1.id)).resolves.toEqual(chapterV1);
    expect(await collect(scriptV1.id)).toEqual(fromV1);
  });
});
