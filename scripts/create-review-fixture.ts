import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { getReviewQueue, submitReview } from "../src/core/reviews.js";
import { scanAndPersist } from "../src/core/service.js";
import { ensureSidecar, getSidecarPaths, writeJsonAtomic } from "../src/core/sidecar.js";
import { mkdtempOwnedFixtureRoot, resetOwnedFixtureRoot } from "./lib/owned-fixture-root.js";

const root = process.argv[2]
  ? await resetOwnedFixtureRoot(path.resolve(process.argv[2]), "create-review-fixture")
  : (await mkdtempOwnedFixtureRoot("ai-canvas-review-fixture", "create-review-fixture")).root;
const unit = path.join(root, "EP01_15s_001_雾河神落");
await mkdir(unit, { recursive: true });
const config = await ensureSidecar(root);
config.name = "导演审片批注 · 隔离测试";
config.sourceRoots = [];
config.outputRoots = [root];
await writeJsonAtomic(getSidecarPaths(root).config, config);
await writeFile(path.join(unit, "00_信息.md"), "# EP01_15s_001 雾河神落\n\n首帧提示词：阿航在雾河苏醒。\n尾帧提示词：完整黄金面具发光。\n", "utf8");

for (const [name, color] of [
  ["EP01_15s_001_首帧_raw.png", "#344b59"],
  ["EP01_15s_001_首帧_labeled.png", "#506c7b"],
  ["EP01_15s_001_尾帧_raw.png", "#6f5536"],
  ["EP01_15s_001_尾帧_labeled.png", "#a0783f"],
] as const) {
  await sharp({ create: { width: 900, height: 1600, channels: 3, background: color } })
    .composite([{ input: Buffer.from(`<svg width="900" height="1600" xmlns="http://www.w3.org/2000/svg"><circle cx="640" cy="430" r="230" fill="#e6bd5b" opacity=".22"/><path d="M0 1180 Q220 900 430 1130 T900 1040 V1600 H0Z" fill="#080a09" opacity=".58"/><text x="54" y="96" fill="#f0cf76" font-size="32">REVIEW FIXTURE · ${name.includes("尾帧") ? "END" : "START"}</text></svg>`) }])
    .png()
    .toFile(path.join(unit, name));
}

const index = await scanAndPersist(root, true);
const item = index.items.find((candidate) => candidate.id === "main-ep01-unit001");
if (!item) throw new Error("隔离审片夹具未识别目标节点。 ");
const artifact = index.artifacts.find((candidate) => candidate.itemId === item.id && candidate.kind === "raw-image" && candidate.variant === "start" && candidate.authoritative);
if (!artifact) throw new Error("隔离审片夹具未识别首帧 raw。 ");
const reviewEntry = (await getReviewQueue(root, { includeResolved: true })).find((entry) => entry.item.id === item.id);
if (!reviewEntry) throw new Error("隔离审片夹具未建立内容哈希快照。 ");
await submitReview(root, {
  itemId: item.id,
  reviewType: "image",
  artifactIds: [artifact.id],
  expectedScanId: reviewEntry.reviewSnapshot.scanId,
  expectedArtifactHashes: { [artifact.id]: reviewEntry.reviewSnapshot.artifactHashes[artifact.id]! },
  decision: "pending",
  criteria: [],
  annotations: [{ artifactId: artifact.id, type: "continuity", x: 0.67, y: 0.29, text: "检查完整黄金面具高光方向与下一镜是否连续。" }],
  note: "隔离 UI 证据，不代表真实项目视觉结论。",
}, "user");

process.stdout.write(`${JSON.stringify({ root, itemId: item.id, artifactId: artifact.id, status: item.status })}\n`);
