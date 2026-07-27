import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { upsertAssetRelation, upsertVoiceIdentity } from "../src/core/asset-registry.js";
import { applyEditOperation, createEditProject, listEditMedia } from "../src/core/editor.js";
import { ensureSidecar, getSidecarPaths, writeJsonAtomic } from "../src/core/sidecar.js";
import { createTaskPack, scanAndPersist, summarizeForMcp } from "../src/core/service.js";
import { mkdtempOwnedFixtureRoot } from "./lib/owned-fixture-root.js";

const root = (await mkdtempOwnedFixtureRoot("ai-drama-canvas-demo", "create-demo")).root;

const config = await ensureSidecar(root);
config.name = "黄金面具 · 演示项目";
config.sourceRoots = [];
config.outputRoots = [root];
config.hardLocks = [];
await writeJsonAtomic(getSidecarPaths(root).config, config);

const units = [
  { id: "001", title: "雾河神落", accepted: true, end: true, start: "#416d83", finish: "#b78b48" },
  { id: "002", title: "阿依发现异光", accepted: false, end: false, start: "#806b4e", finish: "#806b4e" },
  { id: "003", title: "完整金面初醒", accepted: false, end: true, start: "#6d4f38", finish: "#d3a84c" },
];

for (const unit of units) {
  const directory = path.join(root, `EP01_15s_${unit.id}_${unit.title}`);
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "00_信息.md"),
    `# EP01_15s_${unit.id} ${unit.title}\n\n## 首帧提示词\n9:16 高品质国漫电影质感。\n\n## 尾帧提示词\n保持角色与场景连续性。\n${unit.accepted ? "\n## 逐项视觉验收\n最终状态：通过\n" : ""}`,
    "utf8",
  );
  await makeImage(path.join(directory, `EP01_15s_${unit.id}_首帧_raw.png`), unit.start, false);
  await makeImage(path.join(directory, `EP01_15s_${unit.id}_首帧_labeled.png`), unit.start, true);
  if (unit.end) {
    await makeImage(path.join(directory, `EP01_15s_${unit.id}_尾帧_raw.png`), unit.finish, false);
    await makeImage(path.join(directory, `EP01_15s_${unit.id}_尾帧_labeled.png`), unit.finish, true);
  }
}

const index = await scanAndPersist(root);
const editProject = await createEditProject(root, { name: "EP01 演示成片", episode: 1, width: 540, height: 960, fps: 24, autoPopulate: false });
const firstUnitMedia = (await listEditMedia(root, 1)).find((media) => media.itemId.endsWith("unit001") && /raw/i.test(path.basename(media.path)));
if (!firstUnitMedia) throw new Error("演示项目缺少第一单元 raw 素材，无法建立续作时间线。 ");
await applyEditOperation(root, editProject.id, editProject.revision, {
  type: "add_media_clip",
  trackId: editProject.tracks[0]!.id,
  artifactId: firstUnitMedia.artifactId,
  startSeconds: 0,
}, "user");
await createTaskPack(root, { kind: "image", mode: "autopilot" });
await upsertAssetRelation(root, { kind: "derived_from", parentItemId: "main-ep01-unit001", childItemId: "main-ep01-unit002", operation: "从雾河神落尾帧派生下一单元首帧", note: "保持阿航脸部、发饰与雾河光向连续" }, "user");
await upsertVoiceIdentity(root, { name: "阿航·少年声线", provider: "本地参考", language: "zh-CN", description: "清亮但克制，紧张时不抬高音调。", characterItemIds: ["main-ep01-unit001"], tags: ["演示", "连续性"] }, "user");
process.stdout.write(`${root}\n${JSON.stringify(summarizeForMcp(index), null, 2)}\n`);

async function makeImage(filePath: string, color: string, labeled: boolean): Promise<void> {
  const overlays = [{
    input: Buffer.from(`<svg width="900" height="1600" xmlns="http://www.w3.org/2000/svg">
      <defs><linearGradient id="light" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#d9f0ff" stop-opacity=".34"/><stop offset=".48" stop-color="#101513" stop-opacity=".08"/><stop offset="1" stop-color="#070807" stop-opacity=".62"/></linearGradient><filter id="grain"><feTurbulence type="fractalNoise" baseFrequency=".72" numOctaves="3" seed="17"/></filter></defs>
      <rect width="900" height="1600" fill="url(#light)"/><circle cx="650" cy="360" r="260" fill="#e7c66b" opacity=".16"/><path d="M0 1110 Q190 860 390 1080 T900 990 V1600 H0Z" fill="#101513" opacity=".52"/><rect width="900" height="1600" filter="url(#grain)" opacity=".07"/>
    </svg>`),
  }];
  if (labeled) overlays.push({
    input: Buffer.from(`<svg width="900" height="1600"><rect x="24" y="24" width="852" height="1552" fill="none" stroke="#e7c66b" stroke-width="8"/><text x="52" y="88" fill="#ffffff" font-size="34">AI DRAMA CANVAS</text></svg>`),
  });
  const image = sharp({ create: { width: 900, height: 1_600, channels: 3, background: color } }).composite(overlays);
  await image.png({ compressionLevel: 0 }).toFile(filePath);
}
