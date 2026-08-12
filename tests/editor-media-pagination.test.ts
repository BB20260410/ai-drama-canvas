import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { __setEditMediaCatalogCacheObserverForTests, listEditMediaPage, paginateEditMediaItems } from "../src/core/editor.js";
import { getSidecarPaths, writeJsonAtomic } from "../src/core/sidecar.js";
import type { EditMediaItem, ProjectIndex } from "../src/core/types.js";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoots: string[] = [];

afterEach(async () => {
  __setEditMediaCatalogCacheObserverForTests();
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function mediaFixture(count = 205): EditMediaItem[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `media-artifact-${String(index).padStart(4, "0")}`,
    artifactId: `artifact-${String(index).padStart(4, "0")}`,
    itemId: `item-${String(index).padStart(4, "0")}`,
    kind: index % 3 === 0 ? "video" : index % 3 === 1 ? "image" : "audio",
    name: `${index % 2 === 0 ? "镜头" : "对白"} ${String(index).padStart(4, "0")}`,
    path: `/project/media/${String(index).padStart(4, "0")}.dat`,
    authoritative: index % 5 === 0,
    accepted: index % 7 === 0,
    episode: (index % 4) + 1,
    unit: index + 1,
  }));
}

async function projectFixture(scanId = "scan-001", scannedAt = "2026-08-11T00:00:00.000Z"): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-editor-page-"));
  temporaryRoots.push(root);
  const paths = getSidecarPaths(root);
  await mkdir(path.dirname(paths.index), { recursive: true });
  await mkdir(path.dirname(paths.editorPreviewIndex), { recursive: true });
  const items = mediaFixture(7);
  const index = {
    schemaVersion: 1,
    project: {
      schemaVersion: 1,
      id: "project-page-test",
      name: "分页测试",
      primaryRoot: root,
      sourceRoots: [],
      outputRoots: [root],
      ignoreSegments: [],
      namingRules: { patterns: [], manualMappings: [] },
      hardLocks: [],
      automation: { imageBatchSize: 3, videoBatchSize: 2, pauseAfterVisualBatch: true, allowOverwriteAuthoritative: false },
      createdAt: scannedAt,
      updatedAt: scannedAt,
    },
    scanId,
    scannedAt,
    scanDurationMs: 1,
    warnings: [],
    summary: { total: items.length },
    items: items.map((item) => ({
      id: item.itemId,
      type: "unit",
      title: item.name,
      episode: item.episode,
      unit: item.unit,
      status: "待处理",
      inferredStatus: "待处理",
      stage: "首尾帧",
      priority: 1,
      sourcePaths: [],
      nextAction: "测试",
      hardLockIds: [],
      artifactIds: [item.artifactId],
      dependencies: [],
      updatedAt: scannedAt,
    })),
    artifacts: items.map((item) => ({
      id: item.artifactId,
      uri: `file://${item.path}`,
      itemId: item.itemId,
      path: item.path,
      rootSlot: "output-0",
      relativePath: path.basename(item.path),
      kind: item.kind === "video" ? "video" : item.kind === "audio" ? "audio" : "raw-image",
      variant: item.kind === "image" ? "raw" : "none",
      versionLabel: "v1",
      deprecated: false,
      authoritative: item.authoritative,
      accepted: item.accepted,
      modifiedAt: scannedAt,
      check: { ok: true, exists: true, size: 1, issues: [] },
    })),
  } as unknown as ProjectIndex;
  await writeJsonAtomic(paths.index, index);
  await writeJsonAtomic(paths.editorPreviewIndex, { schemaVersion: 1, previews: {} });
  return root;
}

describe("剪辑台媒体服务端游标分页", () => {
  it("分页、搜索和类型筛选由 Core 完成，cursor 不可跨查询或扫描复用", () => {
    const items = mediaFixture();
    const identity = { scanId: "scan-001", scannedAt: "2026-08-11T00:00:00.000Z" };
    const query = { kind: "video" as const, search: "镜头", limit: 17 };
    const first = paginateEditMediaItems(items, identity, query);
    expect(first.items).toHaveLength(17);
    expect(first.total).toBeGreaterThan(17);
    expect(first.items.every((item) => item.kind === "video" && item.name.includes("镜头"))).toBe(true);
    expect(first.nextCursor).toEqual(expect.any(String));

    const second = paginateEditMediaItems(items, identity, { ...query, cursor: first.nextCursor });
    expect(new Set([...first.items, ...second.items].map((item) => item.artifactId)).size).toBe(first.items.length + second.items.length);
    expect(() => paginateEditMediaItems(items, identity, { ...query, search: "对白", cursor: first.nextCursor })).toThrow(/查询|cursor/u);
    expect(() => paginateEditMediaItems(items, { ...identity, scanId: "scan-002" }, { ...query, cursor: first.nextCursor })).toThrow(/查询|cursor/u);
    expect(() => paginateEditMediaItems(items, identity, { limit: 101 })).toThrow(/limit/u);
  });

  it("Main、preload 与剪辑台只使用有界 page API，不再前端截断 500 条", async () => {
    const [main, preload, component] = await Promise.all([
      readFile(path.join(workspaceRoot, "src/main/index.ts"), "utf8"),
      readFile(path.join(workspaceRoot, "src/preload/index.ts"), "utf8"),
      readFile(path.join(workspaceRoot, "src/renderer/src/components/VideoEditorView.vue"), "utf8"),
    ]);
    expect(main).toContain('ipcMain.handle("canvas:list-edit-media-page"');
    expect(preload).toContain('listEditMediaPage:');
    expect(preload).toContain('ipcRenderer.invoke("canvas:list-edit-media-page"');
    expect(component).toContain("window.canvasApi.listEditMediaPage");
    expect(component).toContain("mediaNextCursor");
    expect(component).toContain("props.index.scanId");
    expect(component).toContain("invalidateMediaPaging()");
    expect(component).not.toContain(".slice(0, 500)");
  });

  it("同一扫描的多页只构建一次 catalog 和查询投影，预览索引变化会使旧 cursor 失效", async () => {
    const root = await projectFixture();
    const events: string[] = [];
    __setEditMediaCatalogCacheObserverForTests((event) => events.push(event));

    const first = await listEditMediaPage(root, { limit: 2 });
    const second = await listEditMediaPage(root, { limit: 2, cursor: first.nextCursor });
    expect(first.items).toHaveLength(2);
    expect(second.items).toHaveLength(2);
    expect(events.filter((event) => event === "catalog-built")).toHaveLength(1);
    expect(events.filter((event) => event === "query-built")).toHaveLength(1);
    expect(events).toContain("catalog-hit");
    expect(events).toContain("query-hit");

    const artifactId = first.items[0]!.artifactId;
    const thumbnailPath = path.join(root, "new-thumbnail.jpg");
    await writeJsonAtomic(getSidecarPaths(root).editorPreviewIndex, {
      schemaVersion: 1,
      previews: {
        [artifactId]: { artifactId, kind: first.items[0]!.kind, sourceModifiedAt: "2026-08-11T00:00:00.000Z", generatedAt: "2026-08-11T00:01:00.000Z", thumbnailPath },
      },
    });
    await expect(listEditMediaPage(root, { limit: 2, cursor: first.nextCursor })).rejects.toThrow(/cursor|查询/u);
    const refreshed = await listEditMediaPage(root, { limit: 2 });
    expect(refreshed.items.find((item) => item.artifactId === artifactId)?.thumbnailPath).toBe(thumbnailPath);
    expect(events.filter((event) => event === "catalog-built")).toHaveLength(2);
  });

  it("cursor 绑定工程根与文件快照，复制同一扫描身份到另一工程也不能复用", async () => {
    const firstRoot = await projectFixture();
    const secondRoot = await projectFixture();
    const first = await listEditMediaPage(firstRoot, { limit: 2 });
    await expect(listEditMediaPage(secondRoot, { limit: 2, cursor: first.nextCursor })).rejects.toThrow(/cursor|查询/u);
  });
});
