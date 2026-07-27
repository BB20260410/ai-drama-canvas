import { access, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createManagedProject } from "../src/core/managed-project.js";
import { studioCanvasNodeId } from "../src/core/studio-canvas-layout.js";
import {
  clearStudioCanvasLayout,
  loadStudioCanvasLayout,
  saveStudioCanvasLayout,
  STUDIO_CANVAS_LAYOUT_RELATIVE_PATH,
  StudioCanvasLayoutStoreError,
} from "../src/core/studio-canvas-layout-store.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function managedRoot(): Promise<string> {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "canvas-layout-parent-")));
  roots.push(parent);
  const shell = await createManagedProject({ parentRoot: parent, name: "画布布局测试工程" });
  return shell.paths.root;
}

describe("studio-canvas-layout-store", () => {
  it("读取缺失布局不初始化 generation ledger 或其它受管副作用", async () => {
    const projectRoot = await managedRoot();
    const generationDatabase = path.join(
      projectRoot,
      ".aicanvas",
      "studio-generation-ledger.sqlite",
    );
    const layoutPath = path.join(projectRoot, STUDIO_CANVAS_LAYOUT_RELATIVE_PATH);
    const locksRoot = path.join(projectRoot, ".aicanvas", "locks");
    const [generationBytesBefore, generationStatBefore] = await Promise.all([
      readFile(generationDatabase),
      stat(generationDatabase, { bigint: true }),
    ]);
    await expect(access(layoutPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(locksRoot)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(loadStudioCanvasLayout(projectRoot)).resolves.toBeNull();
    const [generationBytesAfter, generationStatAfter] = await Promise.all([
      readFile(generationDatabase),
      stat(generationDatabase, { bigint: true }),
    ]);
    expect(generationBytesAfter).toEqual(generationBytesBefore);
    expect(generationStatAfter.mtimeNs).toBe(generationStatBefore.mtimeNs);
    await expect(access(layoutPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(locksRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("受管工程：写布局 → 重开读取坐标一致；merge 与 fingerprint 冲突", async () => {
    const projectRoot = await managedRoot();

    expect(await loadStudioCanvasLayout(projectRoot)).toBeNull();

    const panelKey = studioCanvasNodeId("panel", "p7-unit-b-panel-01");
    const first = await saveStudioCanvasLayout(projectRoot, {
      layout: {
        viewport: { x: 12, y: -40, zoom: 0.8 },
        nodes: { [panelKey]: { x: 360, y: 80 } },
        workspaceMode: "workflow",
        pinnedNodeIds: [panelKey],
        draftCanvasEdges: [{
          sourceId: panelKey,
          targetId: "media:raw:p7-unit-b-panel-01",
          sourceKind: "panel",
          targetKind: "raw",
        }],
        workflowGroups: [{
          id: "wg-test-1",
          title: "试跑组",
          panelIds: ["p7-unit-b-panel-01"],
          pipeline: ["image", "review"],
          createdAt: "2026-07-18T00:00:00.000Z",
        }],
        updatedAt: "2026-07-18T00:00:00.000Z",
      },
    });
    expect(first.created).toBe(true);
    expect(first.relativePath).toBe(STUDIO_CANVAS_LAYOUT_RELATIVE_PATH);
    expect(first.layout.nodes[panelKey]).toEqual({ x: 360, y: 80 });

    const diskPath = path.join(projectRoot, STUDIO_CANVAS_LAYOUT_RELATIVE_PATH);
    await access(diskPath);
    const reloaded = await loadStudioCanvasLayout(projectRoot);
    expect(reloaded?.fingerprint).toBe(first.layout.fingerprint);
    expect(reloaded?.nodes[panelKey]).toEqual({ x: 360, y: 80 });
    expect(reloaded?.workspaceMode).toBe("workflow");
    expect(reloaded?.pinnedNodeIds).toEqual([panelKey]);
    expect(reloaded?.draftCanvasEdges).toHaveLength(1);
    expect(reloaded?.workflowGroups[0]?.title).toBe("试跑组");

    // 模拟进程重开：再次 load 与磁盘 JSON 一致
    const raw = JSON.parse(await readFile(diskPath, "utf8")) as { fingerprint: string };
    expect(raw.fingerprint).toBe(first.layout.fingerprint);

    const merged = await saveStudioCanvasLayout(projectRoot, {
      patch: {
        nodes: { [panelKey]: { x: 400, y: 200 } },
        workspaceMode: "projection",
        pinnedNodeIds: [],
        draftCanvasEdges: [],
        updatedAt: "2026-07-18T01:00:00.000Z",
      },
      expectedFingerprint: first.layout.fingerprint,
    });
    expect(merged.created).toBe(false);
    expect(merged.layout.nodes[panelKey]).toEqual({ x: 400, y: 200 });
    expect(merged.layout.workspaceMode).toBe("projection");
    expect(merged.layout.pinnedNodeIds).toEqual([]);
    expect(merged.layout.draftCanvasEdges).toEqual([]);
    expect(merged.layout.fingerprint).not.toBe(first.layout.fingerprint);
    // workflow 组在 patch 未提供时保留
    expect(merged.layout.workflowGroups).toHaveLength(1);

    await expect(saveStudioCanvasLayout(projectRoot, {
      patch: { nodes: { [panelKey]: { x: 1, y: 1 } } },
      expectedFingerprint: first.layout.fingerprint,
    })).rejects.toMatchObject({ code: "fingerprint-conflict" });

    const again = await loadStudioCanvasLayout(projectRoot);
    expect(again?.nodes[panelKey]).toEqual({ x: 400, y: 200 });

    const cleared = await clearStudioCanvasLayout(projectRoot);
    expect(cleared.cleared).toBe(true);
    expect(await loadStudioCanvasLayout(projectRoot)).toBeNull();
  });

  it("读取旧 schemaVersion=1 磁盘文档时补齐自由工作区默认值", async () => {
    const projectRoot = await managedRoot();
    const diskPath = path.join(projectRoot, STUDIO_CANVAS_LAYOUT_RELATIVE_PATH);
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(path.dirname(diskPath), { recursive: true });
    await writeFile(diskPath, JSON.stringify({
      schemaVersion: 1,
      kind: "studio-canvas-layout",
      fingerprint: "0".repeat(64),
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: { "panel:legacy": { x: 10, y: 20 } },
      workflowGroups: [],
      updatedAt: "2026-07-18T00:00:00.000Z",
    }), "utf8");

    const loaded = await loadStudioCanvasLayout(projectRoot);
    expect(loaded?.schemaVersion).toBe(1);
    expect(loaded?.workspaceMode).toBe("projection");
    expect(loaded?.pinnedNodeIds).toEqual([]);
    expect(loaded?.draftCanvasEdges).toEqual([]);
    expect(loaded?.fingerprint).not.toBe("0".repeat(64));
  });

  it("非受管目录失败关闭；空输入失败", async () => {
    const junk = await realpath(await mkdtemp(path.join(os.tmpdir(), "canvas-layout-unmanaged-")));
    roots.push(junk);
    await expect(loadStudioCanvasLayout(junk)).rejects.toBeInstanceOf(StudioCanvasLayoutStoreError);
    await expect(loadStudioCanvasLayout(junk)).rejects.toMatchObject({ code: "unmanaged-project" });

    const projectRoot = await managedRoot();
    await expect(saveStudioCanvasLayout(projectRoot, {})).rejects.toMatchObject({ code: "invalid-input" });
  });
});
