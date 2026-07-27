import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getContinuitySpans, listContinuityTracks } from "../src/core/continuity.js";
import type { FusionContinuityStore, MaterializedContinuitySpan, MaterializedContinuityTrack } from "../src/core/fusion-production.js";
import { scanAndPersist } from "../src/core/service.js";
import { ensureSidecar, getSidecarPaths, writeJsonAtomic } from "../src/core/sidecar.js";

const roots: string[] = [];

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

function unitItemId(episode: number, unit: number): string {
  return `season-三-ep${String(episode).padStart(2, "0")}-unit${String(unit).padStart(3, "0")}`;
}

function span(assetId: string, episode: number, unit: number, startSeconds: number, endSeconds: number): MaterializedContinuitySpan {
  const category = assetId.startsWith("C") ? "character" : assetId.startsWith("S") ? "scene" : "prop";
  return {
    id: `${assetId}-EP${String(episode).padStart(2, "0")}-${String(unit).padStart(3, "0")}-${startSeconds}`,
    assetId,
    episode: `EP${String(episode).padStart(2, "0")}`,
    episodeNumber: episode,
    unitId: `EP${String(episode).padStart(2, "0")}_15s_${String(unit).padStart(3, "0")}`,
    unitSequence: unit,
    sourceShots: [1],
    scheduleRowIndexes: [0],
    startSeconds,
    endSeconds,
    usageSources: ["fusion-index"],
    characterAssetIds: category === "character" ? [assetId] : ["C01"],
    sceneAssetIds: category === "scene" ? [assetId] : ["S01"],
    propAssetIds: category === "prop" ? [assetId] : [],
    referenceVersion: "sha256:test-reference-v1",
    unitItemId: unitItemId(episode, unit),
    shotItemIds: [],
  };
}

async function project(): Promise<{ root: string; store: FusionContinuityStore }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-continuity-timeline-"));
  roots.push(root);
  const config = await ensureSidecar(root);
  config.sourceRoots = [];
  config.outputRoots = [root];
  await writeJsonAtomic(getSidecarPaths(root).config, config);
  for (const [episode, unit] of [[1, 1], [1, 2], [2, 1], [2, 2]] as const) {
    const directory = path.join(root, `蜀道山古蜀卷第三季_EP${String(episode).padStart(2, "0")}_测试`, "04_15秒融合分镜", `EP${String(episode).padStart(2, "0")}_15s_${String(unit).padStart(3, "0")}_测试`);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "00_信息.md"), `# EP${episode} U${unit}\n首帧提示词：连续性测试。\n`, "utf8");
  }
  await scanAndPersist(root);
  const tracks: MaterializedContinuityTrack[] = [
    {
      assetId: "C01", assetName: "阿航", category: "character", workItemId: "asset-C01",
      episodeCodes: ["EP01", "EP02"], unitIds: ["EP01_15s_001", "EP01_15s_002", "EP02_15s_001"],
      spans: [span("C01", 2, 1, 0, 7), span("C01", 1, 2, 4, 15), span("C01", 1, 1, 0, 8)],
    },
    {
      assetId: "S01", assetName: "封神榜空间", category: "scene", workItemId: "asset-S01",
      episodeCodes: ["EP01"], unitIds: ["EP01_15s_001", "EP01_15s_002"],
      spans: [span("S01", 1, 1, 0, 8), span("S01", 1, 2, 4, 15)],
    },
    {
      assetId: "P01", assetName: "不透明布囊", category: "prop", workItemId: "asset-P01",
      episodeCodes: ["EP02"], unitIds: ["EP02_15s_002"], spans: [span("P01", 2, 2, 7, 15)],
    },
  ];
  const store: FusionContinuityStore = {
    schemaVersion: 1,
    kind: "fusion-continuity-tracks",
    sourceContentAddress: `sha256:${"a".repeat(64)}`,
    tracks,
    updatedAt: "2026-07-15T00:00:00.000Z",
  };
  await writeJsonAtomic(getSidecarPaths(root).continuityTracks, store);
  return { root, store };
}

describe("融合工程连续性时间线查询", () => {
  it("只返回轨道摘要并支持资产、分类、分集与分页筛选", async () => {
    const { root } = await project();
    const first = await listContinuityTracks(root, { limit: 2 });
    expect(first).toMatchObject({ available: true, total: 3, offset: 0, limit: 2 });
    expect(first.items.map((track) => track.assetId)).toEqual(["C01", "S01"]);
    expect(first.items[0]).toMatchObject({ unitCount: 3, spanCount: 3, episodeSpanCounts: { EP01: 2, EP02: 1 } });
    expect(first.items[0]?.firstAppearance).toMatchObject({ episode: "EP01", unitSequence: 1, unitItemId: unitItemId(1, 1) });
    expect(first.items[0]?.lastAppearance).toMatchObject({ episode: "EP02", unitSequence: 1, unitItemId: unitItemId(2, 1) });
    expect((await listContinuityTracks(root, { offset: 2, limit: 2 })).items.map((track) => track.assetId)).toEqual(["P01"]);
    expect((await listContinuityTracks(root, { category: "scene" })).items.map((track) => track.assetId)).toEqual(["S01"]);
    expect((await listContinuityTracks(root, { search: "布囊" })).items.map((track) => track.assetId)).toEqual(["P01"]);
    expect((await listContinuityTracks(root, { assetId: "C01" })).items).toHaveLength(1);
    expect((await listContinuityTracks(root, { episode: 2 })).items.map((track) => track.assetId)).toEqual(["C01", "P01"]);
  });

  it("按稳定时间顺序分页返回跨度且每条都能跳到真实 unit 工作项", async () => {
    const { root } = await project();
    const first = await getContinuitySpans(root, "C01", { limit: 2 });
    expect(first).toMatchObject({ available: true, total: 3, offset: 0, limit: 2, track: { assetId: "C01", spanCount: 3 } });
    expect(first.items.map((entry) => entry.unitItemId)).toEqual([unitItemId(1, 1), unitItemId(1, 2)]);
    const second = await getContinuitySpans(root, "C01", { offset: 2, limit: 2 });
    expect(second.items.map((entry) => entry.unitItemId)).toEqual([unitItemId(2, 1)]);
    const episode = await getContinuitySpans(root, "C01", { episode: 2 });
    expect(episode.total).toBe(1);
    expect(episode.items[0]).toMatchObject({ episodeNumber: 2, unitItemId: unitItemId(2, 1), startSeconds: 0, endSeconds: 7 });
  });

  it("侧车缺失时返回不可用，坏筛选和悬空 unit 引用失败关闭", async () => {
    const emptyRoot = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-continuity-empty-"));
    roots.push(emptyRoot);
    await ensureSidecar(emptyRoot);
    expect(await listContinuityTracks(emptyRoot)).toMatchObject({ available: false, total: 0, items: [] });
    await expect(listContinuityTracks(emptyRoot, { assetId: "bad" })).rejects.toThrow("assetId 格式无效");
    await expect(listContinuityTracks(emptyRoot, { category: "costume" as never })).rejects.toThrow("category 格式无效");
    await expect(listContinuityTracks(emptyRoot, { limit: 0 })).rejects.toThrow("limit");

    const { root, store } = await project();
    store.tracks[0]!.spans[0]!.unitItemId = "season-三-ep99-unit999";
    await writeJsonAtomic(getSidecarPaths(root).continuityTracks, store);
    await expect(getContinuitySpans(root, "C01", { offset: 1, limit: 1 })).rejects.toThrow("不存在的 unit 工作项");
  });
});
