import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { deleteCanvasEntity, deleteCanvasLink, getCanvasHistoryInfo, getCanvasSemanticState, moveCanvasEntities, redoCanvasSemanticState, undoCanvasSemanticState, upsertCanvasEntity, upsertCanvasLink } from "../src/core/canvas-state.js";
import { ensureSidecar, getSidecarPaths, writeJsonAtomic } from "../src/core/sidecar.js";
import { scanAndPersist } from "../src/core/service.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function project(): Promise<{ root: string; source: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-semantic-"));
  roots.push(root);
  const config = await ensureSidecar(root);
  config.sourceRoots = [];
  config.outputRoots = [root];
  config.hardLocks = [];
  await writeJsonAtomic(getSidecarPaths(root).config, config);
  const directory = path.join(root, "EP01_15s_001_语义画布测试");
  await mkdir(directory, { recursive: true });
  const source = path.join(directory, "00_信息.md");
  await writeFile(source, "首帧提示词：测试。\n尾帧提示词：测试。\n", "utf8");
  await scanAndPersist(root);
  return { root, source };
}

describe("自定义画布语义层", () => {
  it("持久化批注、分组、位置与关系线且不改动素材", async () => {
    const { root, source } = await project();
    const original = await readFile(source, "utf8");
    expect((await getCanvasSemanticState(root)).entities).toHaveLength(0);
    const note = await upsertCanvasEntity(root, { kind: "note", title: "连续性提醒", body: "面具必须完整。", color: "gold", position: { x: 120, y: 80 } });
    const group = await upsertCanvasEntity(root, { kind: "group", title: "第一段", body: "神落段落", color: "blue", position: { x: 40, y: 30 }, memberIds: ["main-ep01-unit001"], memberOffsets: { "main-ep01-unit001": { x: 80, y: 90 } } });
    expect(group.state.entities).toHaveLength(2);
    expect(group.entity.memberOffsets["main-ep01-unit001"]).toEqual({ x: 80, y: 90 });
    await expect(upsertCanvasEntity(root, { kind: "group", title: "重复分组", memberIds: ["main-ep01-unit001"] })).rejects.toThrow("已属于其他");
    const moved = await moveCanvasEntities(root, { [note.entity.id]: { x: 333.33, y: -40 } });
    expect(moved.entities.find((entity) => entity.id === note.entity.id)?.position).toEqual({ x: 333.33, y: -40 });
    const link = await upsertCanvasLink(root, { sourceId: note.entity.id, targetId: "main-ep01-unit001", kind: "continuity", label: "完整面具" });
    expect(link.state.links[0]).toMatchObject({ sourceId: note.entity.id, targetId: "main-ep01-unit001", label: "完整面具" });
    await expect(upsertCanvasLink(root, { sourceId: note.entity.id, targetId: "main-ep01-unit001", kind: "continuity" })).rejects.toThrow("已存在");
    const withoutLink = await deleteCanvasLink(root, link.link.id);
    expect(withoutLink.links).toHaveLength(0);
    const secondLink = await upsertCanvasLink(root, { sourceId: group.entity.id, targetId: note.entity.id, kind: "comment" });
    expect(secondLink.state.links).toHaveLength(1);
    const deleted = await deleteCanvasEntity(root, note.entity.id);
    expect(deleted.entities.some((entity) => entity.id === note.entity.id)).toBe(false);
    expect(deleted.links).toHaveLength(0);
    const undone = await undoCanvasSemanticState(root);
    expect(undone.state.entities.some((entity) => entity.id === note.entity.id)).toBe(true);
    expect(undone.state.links).toHaveLength(1);
    expect(undone.history.canRedo).toBe(true);
    expect(undone.state.revision).toBeGreaterThan(deleted.revision);
    const redone = await redoCanvasSemanticState(root);
    expect(redone.state.entities.some((entity) => entity.id === note.entity.id)).toBe(false);
    expect(redone.state.links).toHaveLength(0);
    expect(redone.state.revision).toBeGreaterThan(undone.state.revision);
    expect(await readFile(source, "utf8")).toBe(original);
    await expect(access(getSidecarPaths(root).canvasSemantic)).resolves.toBeUndefined();
    await expect(access(getSidecarPaths(root).canvasHistory)).resolves.toBeUndefined();
  });

  it("串行化并发写入，避免 MCP 与桌面端互相覆盖", async () => {
    const { root } = await project();
    await Promise.all(Array.from({ length: 12 }, (_, index) => upsertCanvasEntity(root, { kind: "note", title: `批注 ${index + 1}`, position: { x: index * 20, y: index * 10 } })));
    const state = await getCanvasSemanticState(root);
    expect(state.entities).toHaveLength(12);
    expect(state.revision).toBe(12);
    expect((await getCanvasHistoryInfo(root)).undoCount).toBe(12);
  });
});
