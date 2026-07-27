import { access, copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { seedProductionReady } from "./workflow-helpers.js";
import { createTaskPack, scanAndPersist } from "../src/core/service.js";
import { getSidecarPaths } from "../src/core/sidecar.js";
import { buildStoryContext, connectStoryEvents, importStoryFile, importStoryText, listStoryChapters, listStoryEvents, listStorySources, readStoryChapter, splitStoryChapters, upsertStoryEvent } from "../src/core/story.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function project(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-story-"));
  roots.push(root);
  const unit = path.join(root, "EP01_15s_001_祭坛初醒");
  await mkdir(unit, { recursive: true });
  await writeFile(path.join(unit, "00_信息.md"), "首帧提示词：阿航在祭坛苏醒。\n尾帧提示词：完整黄金面具发光。\n", "utf8");
  await scanAndPersist(root);
  await seedProductionReady(root, "frames");
  return root;
}

describe("原文、章节与故事事件图", () => {
  it("按中文和 Markdown 标题稳定拆章，无标题长文按段落分块", () => {
    const chapters = splitStoryChapters("前言说明文字不足不会单独成章。\n\n第一章 神落\n阿航从雾河醒来。\n\n## 第二章 祭坛\n完整黄金面具发光。");
    expect(chapters.map((chapter) => chapter.title)).toEqual(["第一章 神落", "第二章 祭坛"]);
    const long = splitStoryChapters(`${"第一段。".repeat(2000)}\n\n${"第二段。".repeat(2000)}`);
    expect(long.length).toBeGreaterThanOrEqual(2);
    expect(long.every((chapter) => chapter.content.length > 0)).toBe(true);
  });

  it("导入真实文本与 DOCX 快照，重导入保留版本历史", async () => {
    const root = await project();
    const sourcePath = path.join(root, "原著.txt");
    await writeFile(sourcePath, "第一章 神落\n阿航从雾河醒来。\n\n第二章 祭坛\n完整黄金面具发光。", "utf8");
    const first = await importStoryFile(root, sourcePath, "黄金面具原著");
    expect(first.chapters).toHaveLength(2);
    expect((await readStoryChapter(root, first.chapters[1]!.id)).content).toContain("黄金面具");
    expect((await listStorySources(root))[0]?.encoding).toBe("utf-8");
    await writeFile(sourcePath, "第一章 神落\n阿航从雾河醒来，听见祭司呼喊。\n\n第二章 祭坛\n完整黄金面具发光。", "utf8");
    const second = await importStoryFile(root, sourcePath, "黄金面具原著");
    expect(second.source.revision).toBe(2);
    expect(second.chapters[0]?.revision).toBe(2);
    const historyDirectory = path.join(getSidecarPaths(root).storyHistory, first.source.id);
    await expect(access(historyDirectory)).resolves.toBeUndefined();

    const docxPath = path.join(root, "单段原文.docx");
    await copyFile(path.resolve("node_modules/mammoth/test/test-data/single-paragraph.docx"), docxPath);
    const docx = await importStoryFile(root, docxPath);
    expect(docx.source.kind).toBe("docx");
    expect(docx.source.encoding).toBe("docx");
    expect(docx.chapters.length).toBeGreaterThan(0);
    const pasted = await importStoryText(root, { title: "补充设定", content: "# 补充\n豆姐守在祭坛外。", kind: "markdown" });
    expect(pasted.source.originalPath).toContain("aicanvas://pasted/");
    expect(await listStoryChapters(root)).toHaveLength(4);
  });

  it("事件只有确认后进入生产上下文，并把事件引用写入任务包", async () => {
    const root = await project();
    const source = await importStoryText(root, { title: "事件测试", content: "第一章 祭坛\n阿航醒来，完整黄金面具发出金光。\n\n第二章 追逐\n嘟嘟带阿航逃离祭坛。" });
    const first = await upsertStoryEvent(root, { chapterId: source.chapters[0]!.id, title: "阿航苏醒", description: "阿航在祭坛苏醒，黄金面具保持完整。", sourceExcerpt: "阿航醒来，完整黄金面具发出金光。", characters: ["阿航"], locations: ["祭坛"], props: ["完整黄金面具"], episode: 1, unit: 1, itemIds: ["main-ep01-unit001"], status: "draft" });
    expect((await buildStoryContext(root, "main-ep01-unit001")).events).toHaveLength(0);
    const confirmed = await upsertStoryEvent(root, { ...first, status: "confirmed", expectedRevision: first.revision });
    const second = await upsertStoryEvent(root, { chapterId: source.chapters[1]!.id, title: "逃离祭坛", description: "嘟嘟带阿航离开。", sourceExcerpt: "嘟嘟带阿航逃离祭坛。", characters: ["嘟嘟", "阿航"], locations: ["祭坛"], status: "confirmed" });
    const connected = await connectStoryEvents(root, confirmed.id, second.id);
    expect(connected.dependencyIds).toEqual([confirmed.id]);
    await expect(upsertStoryEvent(root, { chapterId: source.chapters[0]!.id, title: "错误关联", description: "", itemIds: ["missing-item"] })).rejects.toThrow("生产节点不存在");

    const context = await buildStoryContext(root, "main-ep01-unit001");
    expect(context.events.map((event) => event.id)).toContain(confirmed.id);
    expect(context.prompt).toContain("原文证据");
    expect(context.prompt).toContain("完整黄金面具发出金光");
    const { task } = await createTaskPack(root, { itemIds: ["main-ep01-unit001"], kind: "image" });
    expect(task.itemSnapshots[0]?.storyEventIds).toEqual([confirmed.id]);
    expect((await listStoryEvents(root, { status: "confirmed" })).length).toBe(2);
    expect(await readFile(getSidecarPaths(root).storyEvents, "utf8")).toContain("阿航苏醒");
  });

  it("确认事件校验原文证据、修订和依赖环", async () => {
    const root = await project();
    const source = await importStoryText(root, { title: "证据校验", content: "第一章 追踪\n阿航进入祭坛。嘟嘟守在门外。" });
    await expect(upsertStoryEvent(root, { chapterId: source.chapters[0]!.id, title: "伪造事实", description: "不存在的情节", sourceExcerpt: "阿航飞上月球。", status: "confirmed" })).rejects.toThrow("原文句段与章节快照不匹配");
    await expect(upsertStoryEvent(root, { chapterId: source.chapters[0]!.id, title: "无证据事实", description: "缺少证据", status: "confirmed" })).rejects.toThrow("必须提供可核对的原文句段");
    const inferred = await upsertStoryEvent(root, { chapterId: source.chapters[0]!.id, title: "改编推断", description: "用于镜头衔接的推断", tags: ["改编推断"], status: "confirmed" });
    await expect(upsertStoryEvent(root, { ...inferred, description: "旧窗口覆盖" })).rejects.toThrow("必须提供 expectedRevision");
    const first = await upsertStoryEvent(root, { chapterId: source.chapters[0]!.id, title: "进入祭坛", description: "阿航进入祭坛", sourceExcerpt: "阿航进入祭坛。", status: "confirmed" });
    const second = await upsertStoryEvent(root, { chapterId: source.chapters[0]!.id, title: "门外守候", description: "嘟嘟守在门外", sourceExcerpt: "嘟嘟守在门外。", dependencyIds: [first.id], status: "confirmed" });
    await expect(upsertStoryEvent(root, { ...first, dependencyIds: [second.id], expectedRevision: first.revision })).rejects.toThrow("依赖形成循环");
  });
});
