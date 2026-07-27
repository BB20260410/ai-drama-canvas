import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { promisify } from "node:util";
import path from "node:path";
import { createEditProject, saveEditProject } from "../src/core/editor.js";
import { commitProjectImport, prepareProjectImport } from "../src/core/importer.js";
import { scanAndPersist } from "../src/core/service.js";
import { seedProductionReady } from "../tests/workflow-helpers.js";
import { resetOwnedFixtureRoot } from "./lib/owned-fixture-root.js";

const execFileAsync = promisify(execFile);
const defaultSuffix = `${process.pid}-${randomUUID()}`;
const root = path.resolve(process.argv[2] || path.join(os.tmpdir(), `ai-canvas-editor-ui-${defaultSuffix}`));
const registryPath = path.resolve(process.argv[3] || path.join(os.tmpdir(), `ai-canvas-editor-ui-registry-${defaultSuffix}.json`));
const mode = ["subdivision", "main-transform", "nested"].includes(process.argv[4] ?? "") ? process.argv[4]! : "bezier";
process.env.AI_CANVAS_REGISTRY_PATH = registryPath;

await Promise.all([resetOwnedFixtureRoot(root, "create-editor-ui-fixture"), rm(registryPath, { force: true })]);
for (const unit of [1, 2]) {
  const stem = `EP01_15s_${String(unit).padStart(3, "0")}`;
  const directory = path.join(root, `${stem}_${unit === 1 ? "雾河建立镜头" : "祭坛反应镜头"}`);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "00_信息.md"), `# ${stem}\n\n本地剪辑台 UI 验收素材。\n`, "utf8");
  await execFileAsync("ffmpeg", [
    "-v", "error", "-f", "lavfi", "-i", `testsrc2=size=540x960:rate=24000/1001`,
    "-vf", unit === 1 ? "hue=h=18:s=0.72" : "hue=h=140:s=0.7", "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p",
    path.join(directory, `${stem}_v1.mp4`),
  ]);
}

const preview = await prepareProjectImport({ primaryRoot: root, projectMode: "filesystem", name: "导演剪辑台 UI 验收" });
if (!preview.canImport) throw new Error(preview.issues.map((issue) => issue.message).join("；"));
await commitProjectImport({ previewId: preview.previewId, config: preview.config, projectMode: "filesystem" });
await scanAndPersist(root);
await seedProductionReady(root, "storyboard");
if (mode === "nested") {
  const child = await createEditProject(root, { name: "EP01 嵌套子时间线", episode: 1, width: 540, height: 960, fps: 23.976, autoPopulate: true });
  const childClip = child.tracks.find((track) => track.kind === "visual")?.clips[0];
  if (!childClip) throw new Error("嵌套 UI 夹具未能从真实视频建立子时间线片段。 ");
  const parent = await createEditProject(root, { name: "EP01 嵌套父时间线", episode: 1, width: 540, height: 960, fps: 29.97, autoPopulate: false });
  process.stdout.write(`${JSON.stringify({ root, registryPath, mode, parentEditProjectId: parent.id, parentRevision: parent.revision, parentVisualTrackId: parent.tracks.find((track) => track.kind === "visual")?.id, childEditProjectId: child.id, childRevision: child.revision, childClipId: childClip.id, childClips: child.tracks.find((track) => track.kind === "visual")?.clips.length, parentTimebase: parent.timebase, childTimebase: child.timebase }, null, 2)}\n`);
} else {
const editProject = await createEditProject(root, { name: "EP01 分割、Ripple 与贝塞尔验收", episode: 1, width: 540, height: 960, fps: 23.976, autoPopulate: true });
const source = editProject.tracks[0]!.clips[0]!;
const overlayTrackId = mode === "subdivision" ? "track-ui-subdivision-overlay" : "track-ui-bezier-overlay";
const overlayClipId = mode === "subdivision" ? "clip-ui-subdivision-overlay" : "clip-ui-bezier-overlay";
const overlayStartFrame = mode === "subdivision" ? 6 : undefined;
const overlayDurationFrames = mode === "subdivision" ? 36 : undefined;
const uiFrameRate = 24_000 / 1_001;
const overlayStartSeconds = mode === "subdivision" ? Math.round(6 / uiFrameRate * 1_000) / 1_000 : .25;
const overlayDurationSeconds = mode === "subdivision" ? Math.round(36 / uiFrameRate * 1_000) / 1_000 : 1.5;
const startKeyframeId = mode === "subdivision" ? "kf-ui-subdivision-start" : "kf-ui-bezier-start";
const endKeyframeId = mode === "subdivision" ? "kf-ui-subdivision-end" : "kf-ui-bezier-end";
const mainStartKeyframeId = "kf-ui-main-transform-start";
const mainEndKeyframeId = "kf-ui-main-transform-end";
if (mode === "main-transform") {
  const mainDurationFrames = 36;
  const mainDurationSeconds = Math.round(mainDurationFrames / uiFrameRate * 1_000) / 1_000;
  editProject.name = "EP01 主画面 Transform 关键帧验收";
  editProject.backgroundColor = "#18314f";
  Object.assign(source, {
    name: "主画面 Transform UI",
    startSeconds: 0,
    durationSeconds: mainDurationSeconds,
    startFrame: 0,
    durationFrames: mainDurationFrames,
    volume: 0,
    muted: false,
    opacity: .72,
    positionX: -45,
    positionY: -70,
    scale: .42,
    rotation: -16,
    keyframes: [
      { id: mainStartKeyframeId, frame: 0, timeSeconds: 0, easing: "hold", positionX: -45, positionY: -70, scale: .42, rotation: -16 },
      { id: mainEndKeyframeId, frame: mainDurationFrames, timeSeconds: mainDurationSeconds, easing: "cubic_bezier", bezier: { x1: 1, y1: 0, x2: 0, y2: 1 }, positionX: 35, positionY: 60, scale: .65, rotation: 17 },
    ],
  });
  editProject.tracks[0]!.clips = [source];
} else {
  editProject.tracks.splice(1, 0, {
    id: overlayTrackId,
    kind: "visual",
    name: "贝塞尔画中画",
    order: 1,
    locked: false,
    muted: false,
    hidden: false,
    clips: [{
      ...structuredClone(source),
      id: overlayClipId,
      trackId: overlayTrackId,
      name: mode === "subdivision" ? "病态曲线分段 UI 覆盖层" : "贝塞尔 UI 覆盖层",
      startSeconds: overlayStartSeconds,
      durationSeconds: overlayDurationSeconds,
      startFrame: overlayStartFrame,
      durationFrames: overlayDurationFrames,
      volume: 0,
      muted: false,
      opacity: .92,
      positionX: -120,
      positionY: -80,
      scale: .3,
      rotation: -6,
      keyframes: [
        { id: startKeyframeId, frame: mode === "subdivision" ? 0 : undefined, timeSeconds: 0, easing: "hold", positionX: -120, positionY: -80, scale: .3, rotation: -6 },
        { id: endKeyframeId, frame: mode === "subdivision" ? 36 : undefined, timeSeconds: overlayDurationSeconds, easing: "cubic_bezier", bezier: mode === "subdivision" ? { x1: 1, y1: 0, x2: 0, y2: 1 } : { x1: .25, y1: .1, x2: .25, y2: 1 }, positionX: 120, positionY: 80, scale: .5, rotation: 6 },
      ],
    }],
  });
}
editProject.tracks.forEach((track, order) => track.order = order);
const saved = await saveEditProject(root, editProject, editProject.revision);
process.stdout.write(`${JSON.stringify({ root, registryPath, mode, editProjectId: saved.id, revision: saved.revision, mainClips: saved.tracks[0]?.clips.length, mainClipId: mode === "main-transform" ? source.id : undefined, mainStartKeyframeId: mode === "main-transform" ? mainStartKeyframeId : undefined, mainEndKeyframeId: mode === "main-transform" ? mainEndKeyframeId : undefined, overlayClipId, overlayStartFrame: saved.tracks.find((track) => track.id === overlayTrackId)?.clips[0]?.startFrame, overlayDurationFrames: saved.tracks.find((track) => track.id === overlayTrackId)?.clips[0]?.durationFrames, timebase: saved.timebase }, null, 2)}\n`);
}
