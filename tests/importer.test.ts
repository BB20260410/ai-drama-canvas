import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { commitProjectImport, prepareProjectImport } from "../src/core/importer.js";
import { getSidecarPaths, listEvents, writeJsonAtomic } from "../src/core/sidecar.js";
import { listProjects } from "../src/core/service.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function temporary(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function unit(root: string, episode: number, number: number, title: string): Promise<void> {
  const id = `EP${String(episode).padStart(2, "0")}_15s_${String(number).padStart(3, "0")}`;
  const directory = path.join(root, `${id}_${title}`);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "00_信息.md"), `首帧提示词：${title}\n尾帧提示词：${title}\n`, "utf8");
  await sharp({ create: { width: 720, height: 1280, channels: 3, background: "#76543a" } }).png().toFile(path.join(directory, `${id}_首帧_raw.png`));
}

describe("真实项目导入与恢复", () => {
  it("预检不落盘，确认后原子建立侧车并扫描附加来源根", async () => {
    const primary = await temporary("ai-canvas-import-main-");
    const source = await temporary("ai-canvas-import-source-");
    await unit(primary, 1, 1, "主根单元");
    await unit(source, 2, 1, "来源单元");

    const preview = await prepareProjectImport({ primaryRoot: primary, name: "导入闭环", sourceRoots: [source] });
    expect(preview.mode).toBe("new");
    expect(preview.canImport).toBe(true);
    expect(preview.recognized.units).toBe(2);
    expect(preview.roots.find((root) => root.role === "source")?.recognizedArtifacts).toBeGreaterThan(0);
    await expect(access(path.join(primary, ".aicanvas"))).rejects.toThrow();

    const index = await commitProjectImport({ previewId: preview.previewId, config: preview.config });
    expect(index.project.name).toBe("导入闭环");
    expect(index.items.filter((item) => item.type === "unit")).toHaveLength(2);
    expect(await readFile(getSidecarPaths(primary).progressMarkdown, "utf8")).toContain("导入闭环");
    expect((await listProjects()).some((project) => project.primaryRoot === primary)).toBe(true);
    expect((await listEvents(primary)).some((event) => event.type === "project.imported")).toBe(true);
  });

  it("小说起步模式经明确确认后可建立真实空索引，且模式变化必须重新预检", async () => {
    const primary = await temporary("ai-canvas-import-story-first-");
    const preview = await prepareProjectImport({ primaryRoot: primary, projectMode: "story_first", name: "小说起步测试" });
    expect(preview.projectMode).toBe("story_first");
    expect(preview.canImport).toBe(true);
    expect(preview.recognized.units).toBe(0);
    expect(preview.recognized.shots).toBe(0);
    expect(preview.issues).toContainEqual(expect.objectContaining({ code: "story_first_empty", severity: "info" }));
    await expect(access(getSidecarPaths(primary).root)).rejects.toThrow();

    await expect(commitProjectImport({ previewId: preview.previewId, config: preview.config })).rejects.toThrow("重新预检");
    const index = await commitProjectImport({ previewId: preview.previewId, config: preview.config, projectMode: "story_first" });
    expect(index.items).toEqual([]);
    expect(index.artifacts).toEqual([]);
    expect(index.summary.total).toBe(0);
    await expect(access(getSidecarPaths(primary).config)).resolves.toBeUndefined();
    await expect(access(getSidecarPaths(primary).index)).resolves.toBeUndefined();
    expect((await listEvents(primary)).some((event) => event.type === "project.imported" && event.data?.projectMode === "story_first")).toBe(true);
    expect((await listProjects()).some((project) => project.primaryRoot === primary)).toBe(true);
  });

  it("小说起步模式仍拒绝不存在的主根且不创建侧车", async () => {
    const parent = await temporary("ai-canvas-import-story-first-missing-");
    const missing = path.join(parent, "不存在的项目根");
    const preview = await prepareProjectImport({ primaryRoot: missing, projectMode: "story_first" });
    expect(preview.canImport).toBe(false);
    expect(preview.issues.some((issue) => issue.code === "primary_missing" && issue.severity === "error")).toBe(true);
    await expect(commitProjectImport({ previewId: preview.previewId, config: preview.config, projectMode: "story_first" })).rejects.toThrow("预检未通过");
    await expect(access(getSidecarPaths(missing).root)).rejects.toThrow();
  });

  it("重新导入保留既有画布历史，并拒绝未经重新预检的规则变化", async () => {
    const primary = await temporary("ai-canvas-import-resume-");
    await unit(primary, 3, 1, "恢复单元");
    const first = await prepareProjectImport({ primaryRoot: primary });
    await commitProjectImport({ previewId: first.previewId, config: first.config });
    const canvasPath = getSidecarPaths(primary).canvasSemantic;
    const canvasState = { schemaVersion: 1, revision: 9, entities: [], links: [], updatedAt: new Date().toISOString() };
    await writeJsonAtomic(canvasPath, canvasState);

    const again = await prepareProjectImport({ primaryRoot: primary, name: "恢复后的项目" });
    expect(again.mode).toBe("registered");
    await expect(commitProjectImport({ previewId: again.previewId, config: { ...again.config, name: "未预检名称" } })).rejects.toThrow("重新预检");
    await commitProjectImport({ previewId: again.previewId, config: again.config });
    expect(JSON.parse(await readFile(canvasPath, "utf8"))).toEqual(canvasState);
  });

  it("缺失来源根会阻止导入且不创建侧车", async () => {
    const primary = await temporary("ai-canvas-import-invalid-");
    const missing = path.join(primary, "不存在的来源");
    const preview = await prepareProjectImport({ primaryRoot: primary, sourceRoots: [missing] });
    expect(preview.canImport).toBe(false);
    expect(preview.issues.some((issue) => issue.code === "source_missing" && issue.severity === "error")).toBe(true);
    await expect(commitProjectImport({ previewId: preview.previewId, config: preview.config })).rejects.toThrow("预检未通过");
    await expect(access(path.join(primary, ".aicanvas"))).rejects.toThrow();
  });

  it("多个来源的显式季编号冲突会合并版本并给出告警", async () => {
    const primary = await temporary("ai-canvas-import-collision-main-");
    const source = await temporary("ai-canvas-import-collision-source-");
    await unit(path.join(primary, "第一季"), 1, 1, "主版本");
    await unit(path.join(source, "第一季"), 1, 1, "外部版本");
    const preview = await prepareProjectImport({ primaryRoot: primary, sourceRoots: [source] });
    expect(preview.recognized.units).toBe(1);
    expect(preview.issues.some((issue) => issue.code === "cross_root_merge")).toBe(true);
  });

  it("未知目录结构必须先用命名规则或手工映射纠正，不能导入空画布", async () => {
    const primary = await temporary("ai-canvas-import-custom-naming-");
    const directory = path.join(primary, "第一集", "开场甲");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "00_信息.md"), "首帧提示词：自定义目录。\n尾帧提示词：继续。\n", "utf8");
    const blocked = await prepareProjectImport({ primaryRoot: primary });
    expect(blocked.projectMode).toBe("filesystem");
    expect(blocked.canImport).toBe(false);
    expect(blocked.issues.some((issue) => issue.code === "no_work_items" && issue.severity === "error")).toBe(true);

    const mapped = await prepareProjectImport({ primaryRoot: primary, namingRules: { patterns: [], manualMappings: [{ pathPrefix: "第一集/开场甲", type: "unit", episode: 1, unit: 1, title: "开场甲" }] } });
    expect(mapped.canImport).toBe(true);
    expect(mapped.sampleItems[0]?.id).toBe("main-ep01-unit001");
    expect(mapped.config.namingRules.manualMappings).toHaveLength(1);
  });
});
