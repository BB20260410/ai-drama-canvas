import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import fg from "fast-glob";
import { inspectFusionPackage, THIRD_SEASON_FUSION_EXPECTED_COUNTS } from "../src/core/fusion-package.js";
import { materializeFusionProject } from "../src/core/fusion-production.js";
import { getSidecarPaths, readJson, writeJsonAtomic } from "../src/core/sidecar.js";
import { scanAndPersist } from "../src/core/service.js";
import type { StoryboardStore } from "../src/core/types.js";

const workspace = path.resolve(process.cwd());
const sourceRoot = path.resolve(process.argv[2] ?? "/Users/hxx/Documents/古蜀卷第三季");
const packageRoot = path.resolve(process.argv[3] ?? path.join(sourceRoot, "07_9x16_15秒融合制作包"));
const targetParent = path.resolve(process.argv[4] ?? path.join(workspace, "productions"));
const evidencePath = process.argv[5] ? path.resolve(process.argv[5]) : undefined;

const authorities = [
  {
    id: "ahang",
    assetId: "C01",
    name: "阿航青年三视图",
    sourcePath: "/Users/hxx/Desktop/阿航_青年_三视图_.jpg",
    expectedSha256: "5132d4320f956cf2a2320e52fae941ef15ffb243ad79343045006a8773f4548e",
    rules: ["同一张脸", "黑色古代衣袍", "发髻", "左侧银白挑染", "覆盖第三季灰褐衣和赤红鬓发文字"],
    exposeToGeneration: true,
  },
  {
    id: "dudu",
    assetId: "C02",
    name: "嘟嘟参考图",
    sourcePath: "/Users/hxx/Desktop/嘟嘟参考图.png",
    expectedSha256: "d6759fbd03df6d3b9c83e193130bea6073c15865a5f9cf7d308b069ea2b131cd",
    rules: ["犬种固定", "脸型固定", "黑白棕花纹固定", "白色卷尾固定"],
    exposeToGeneration: true,
  },
  {
    id: "golden-mask",
    name: "完整三星堆黄金面具三视图",
    sourcePath: "/Users/hxx/Desktop/豆包版本/04_资产库/05_EP01-EP05_真人实拍补充资产_20260702/00_锁定可用图片素材/03_锁定道具三视图/D01_整张三星堆黄金面具_真人实拍三视图.png",
    expectedSha256: "91b074b882113d6c0bdde156e6d38adf7883e8388ba4064168d6c32ade8e2253",
    rules: ["完整结构", "EP32 前不得露出实体", "禁止半面具、裂面具和口型", "仅作为 P01 布囊内部身份来源"],
    exposeToGeneration: false,
  },
] as const;

interface SourceFileSnapshot {
  relativePath: string;
  bytes: number;
  mtimeMs: number;
  sha256: string;
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(filePath), new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      callback(null, chunk);
    },
  }), new Transform({ transform(_chunk, _encoding, callback) { callback(); } }));
  return hash.digest("hex");
}

async function sourceSnapshot(root: string): Promise<{ aggregateSha256: string; totalBytes: number; files: SourceFileSnapshot[] }> {
  const relativePaths = (await fg("**/*", { cwd: root, onlyFiles: true, followSymbolicLinks: false, dot: true })).sort((a, b) => a.localeCompare(b, "en"));
  const files: SourceFileSnapshot[] = [];
  for (const relativePath of relativePaths) {
    const absolute = path.join(root, ...relativePath.split("/"));
    const metadata = await stat(absolute);
    files.push({ relativePath, bytes: metadata.size, mtimeMs: metadata.mtimeMs, sha256: await sha256File(absolute) });
  }
  const aggregateSha256 = createHash("sha256")
    .update(files.map((file) => `${file.relativePath}\0${file.bytes}\0${file.mtimeMs}\0${file.sha256}`).join("\n"))
    .digest("hex");
  return { aggregateSha256, totalBytes: files.reduce((sum, file) => sum + file.bytes, 0), files };
}

async function main(): Promise<void> {
  if (await realpath(sourceRoot) === await realpath(targetParent).catch(() => "")) throw new Error("源根和目标父目录不能相同。 ");
  await mkdir(targetParent, { recursive: true });
  const fullSourceBefore = await sourceSnapshot(sourceRoot);
  const inspection = await inspectFusionPackage({ packageRoot, sourceRoot, expectedCounts: THIRD_SEASON_FUSION_EXPECTED_COUNTS });
  const materialized = await materializeFusionProject({ inspection, targetParent, authorities: authorities.map((authority) => ({ ...authority, rules: [...authority.rules] })) });
  const index = await scanAndPersist(materialized.targetRoot, true);
  const [storyboards, fullSourceAfter, reinspection] = await Promise.all([
    readJson<StoryboardStore>(getSidecarPaths(materialized.targetRoot).storyboards, { schemaVersion: 1, revision: 0, rows: [], updatedAt: new Date(0).toISOString() }),
    sourceSnapshot(sourceRoot),
    inspectFusionPackage({ packageRoot, sourceRoot, expectedCounts: THIRD_SEASON_FUSION_EXPECTED_COUNTS }),
  ]);
  if (fullSourceAfter.aggregateSha256 !== fullSourceBefore.aggregateSha256) throw new Error("第三季源目录的清单、大小、mtime 或 SHA 在建库过程中发生变化。 ");
  if (reinspection.inventory.aggregateSha256 !== inspection.inventory.aggregateSha256) throw new Error("融合包受控源清单在建库过程中发生变化。 ");

  const counts = {
    units: index.items.filter((item) => item.type === "unit").length,
    shots: index.items.filter((item) => item.type === "shot").length,
    assets: index.items.filter((item) => item.type === "asset").length,
    storyboardRows: storyboards.rows.filter((row) => row.status === "confirmed").length,
    continuityTracks: materialized.continuity.tracks.length,
    continuitySpans: materialized.continuity.tracks.reduce((sum, track) => sum + track.spans.length, 0),
  };
  const expected = { units: 1_288, shots: 1_472, assets: 77, storyboardRows: 2_640, continuityTracks: 77, continuitySpans: 4_287 };
  if (JSON.stringify(counts) !== JSON.stringify(expected)) throw new Error(`真实工程计数不符：${JSON.stringify({ counts, expected })}`);
  const ep01AssetIds = [...new Set(materialized.manifest.units.filter((unit) => unit.episodeNumber === 1).flatMap((unit) => unit.assetIds))].sort();
  if (ep01AssetIds.length !== 20) throw new Error(`EP01 资产应为 20 项，实际 ${ep01AssetIds.length} 项。`);
  const assetsById = new Map(materialized.assetCatalog.assets.map((entry) => [entry.definition.id, entry]));
  const ahang = index.items.find((item) => item.id === "asset-C01");
  const dudu = index.items.find((item) => item.id === "asset-C02");
  const mask = materialized.receipt.authorities.find((authority) => authority.id === "golden-mask");
  if (ahang?.status !== "已完成" || dudu?.status !== "已完成") throw new Error("阿航或嘟嘟权威资产未被识别为已完成硬锁。 ");
  if (!ahang.hardLockIds.includes("C01") || !dudu.hardLockIds.includes("C02")) throw new Error("阿航或嘟嘟缺少硬锁 ID。 ");
  if (!mask || mask.exposeToGeneration || materialized.assetCatalog.assets.some((entry) => entry.contract.authorityReferences.some((reference) => reference.sha256 === mask.snapshotSha256))) {
    throw new Error("完整黄金面具被错误暴露到第三季资产生图合同。 ");
  }
  if (!assetsById.get("P01")?.contract.prompt.includes("任何角度均不得露出实体")) throw new Error("P01 隐藏完整黄金面具铁律未冻结。 ");
  const unit001 = materialized.manifest.units.find((unit) => unit.id === "EP01_15s_001");
  const unit008 = materialized.manifest.units.find((unit) => unit.id === "EP01_15s_008");
  if (!unit001?.assetIds.includes("S01") || !["C01", "C02", "P01"].every((id) => unit008?.assetIds.includes(id))) {
    throw new Error("EP01 两个验证单元的资产作用域不符合锁定计划。 ");
  }

  const report = {
    schemaVersion: 1,
    kind: "gushujuan-s3-cas-materialization-validation",
    createdAt: new Date().toISOString(),
    created: materialized.created,
    targetRoot: materialized.targetRoot,
    projectId: materialized.manifest.projectId,
    sourceContentAddress: materialized.manifest.contentAddress,
    sourceInventory: {
      root: sourceRoot,
      beforeAggregateSha256: fullSourceBefore.aggregateSha256,
      afterAggregateSha256: fullSourceAfter.aggregateSha256,
      fileCount: fullSourceBefore.files.length,
      totalBytes: fullSourceBefore.totalBytes,
      controlledInventorySha256: inspection.inventory.aggregateSha256,
      files: fullSourceBefore.files,
    },
    counts,
    ep01: { units: materialized.manifest.units.filter((unit) => unit.episodeNumber === 1).length, assetIds: ep01AssetIds },
    authorities: materialized.receipt.authorities.map((authority) => ({
      id: authority.id,
      assetId: authority.assetId,
      sourceSha256: authority.sourceSha256,
      snapshotSha256: authority.snapshotSha256,
      exposeToGeneration: authority.exposeToGeneration,
    })),
    safety: {
      maskExcludedFromGenerationContracts: true,
      p01HiddenMaskRuleFrozen: true,
      sourceUnchanged: true,
      contentAddressIdempotent: true,
    },
  };
  if (evidencePath) await writeJsonAtomic(evidencePath, report);
  process.stdout.write(`${JSON.stringify({
    targetRoot: report.targetRoot,
    created: report.created,
    sourceContentAddress: report.sourceContentAddress,
    sourceAggregateSha256: report.sourceInventory.beforeAggregateSha256,
    sourceFiles: report.sourceInventory.fileCount,
    counts: report.counts,
    ep01Assets: report.ep01.assetIds.length,
    evidencePath,
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
