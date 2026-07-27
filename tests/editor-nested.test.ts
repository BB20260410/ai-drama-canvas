import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import sharp from "sharp";
import {
  applyEditOperation,
  createEditProject,
  exportEditProjectOtio,
  extractTimelineFrame,
  getEditProject,
  importEditProjectOtio,
  listEditProjects,
  prepareNestedTimelinePreview,
  redoEditProject,
  renderEditProject,
  saveEditProject,
  startEditRender,
  undoEditProject,
  waitForEditRender,
} from "../src/core/editor.js";
import { ensureSidecar, getSidecarPaths, writeJsonAtomic } from "../src/core/sidecar.js";
import { getPublicationReceipt } from "../src/core/publication.js";
import type { EditClip, EditProject } from "../src/core/types.js";

const roots: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

function secondsForFrames(project: Pick<EditProject, "timebase" | "fps">, frames: number): number {
  const rate = project.timebase ? project.timebase.rateNumerator / project.timebase.rateDenominator : project.fps;
  return Math.round(frames / rate * 1_000) / 1_000;
}

async function fixture(): Promise<{ root: string; imagePath: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-editor-nested-"));
  roots.push(root);
  const config = await ensureSidecar(root);
  config.sourceRoots = [];
  config.outputRoots = [root];
  await writeJsonAtomic(getSidecarPaths(root).config, config);
  const imagePath = path.join(root, "nested-source.png");
  await sharp({ create: { width: 320, height: 256, channels: 3, background: "#b24a2f" } }).png().toFile(imagePath);
  return { root, imagePath };
}

async function projectWithImage(
  root: string,
  imagePath: string,
  input: { name: string; fps: number; durationFrames: number },
): Promise<EditProject> {
  const created = await createEditProject(root, { name: input.name, width: 320, height: 256, fps: input.fps, autoPopulate: false });
  const track = created.tracks.find((entry) => entry.kind === "visual")!;
  const durationSeconds = secondsForFrames(created, input.durationFrames);
  track.clips.push({
    id: `clip-${created.id}`,
    trackId: track.id,
    kind: "image",
    name: `${input.name} 色板`,
    sourcePath: imagePath,
    startFrame: 0,
    durationFrames: input.durationFrames,
    trimStartFrame: 0,
    startSeconds: 0,
    durationSeconds,
    trimStartSeconds: 0,
    playbackRate: 1,
    volume: 1,
    opacity: 1,
    muted: false,
  });
  return saveEditProject(root, created, created.revision);
}

async function projectWithVideo(
  root: string,
  videoPath: string,
  input: { name: string; fps: number; durationFrames: number },
): Promise<EditProject> {
  const created = await createEditProject(root, { name: input.name, width: 320, height: 256, fps: input.fps, autoPopulate: false });
  const track = created.tracks.find((entry) => entry.kind === "visual")!;
  track.clips.push({
    id: `clip-${created.id}`,
    trackId: track.id,
    kind: "video",
    name: `${input.name} 动态帧`,
    sourcePath: videoPath,
    startFrame: 0,
    durationFrames: input.durationFrames,
    trimStartFrame: 0,
    startSeconds: 0,
    durationSeconds: secondsForFrames(created, input.durationFrames),
    trimStartSeconds: 0,
    playbackRate: 1,
    volume: 1,
    opacity: 1,
    muted: false,
  });
  return saveEditProject(root, created, created.revision);
}

function nestedClip(project: EditProject): EditClip {
  return project.tracks.flatMap((track) => track.clips).find((clip) => clip.kind === "timeline")!;
}

function stableTestValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableTestValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, stableTestValue(entry)]));
  return value;
}

function sha256TestJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stableTestValue(value))).digest("hex");
}

async function generateFrameIdentityVideo(filePath: string, frameRate: string, frames: number): Promise<void> {
  await execFileAsync("ffmpeg", [
    "-v", "error",
    "-f", "lavfi",
    "-i", `testsrc2=size=320x256:rate=${frameRate}`,
    "-frames:v", String(frames),
    "-c:v", "ffv1",
    "-level", "3",
    "-g", "1",
    "-pix_fmt", "yuv420p",
    "-an",
    "-y",
    filePath,
  ]);
}

async function frameMd5(filePath: string): Promise<string[]> {
  const { stdout } = await execFileAsync("ffmpeg", ["-v", "error", "-i", filePath, "-map", "0:v:0", "-f", "framemd5", "-"]);
  return stdout.split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("#")).map((line) => line.split(",").at(-1)!.trim());
}

async function meanVolumeDb(filePath: string): Promise<number> {
  const { stderr } = await execFileAsync("ffmpeg", ["-hide_banner", "-i", filePath, "-map", "0:a:0", "-af", "volumedetect", "-f", "null", "-"]);
  const match = stderr.match(/mean_volume:\s*(-?[0-9.]+)\s*dB/);
  if (!match) throw new Error(`无法从 FFmpeg volumedetect 读取平均音量：${stderr.split("\n").slice(-20).join("\n")}`);
  return Number(match[1]);
}

describe("复杂嵌套时间线冻结合同", () => {
  it("创建内容寻址快照并锁定身份、时基、画布和有理映射", async () => {
    const { root, imagePath } = await fixture();
    const child = await projectWithImage(root, imagePath, { name: "29.97 子时间线", fps: 29.97, durationFrames: 30 });
    const parent = await createEditProject(root, { name: "23.976 父时间线", width: 320, height: 256, fps: 23.976, autoPopulate: false });
    const parentTrack = parent.tracks.find((track) => track.kind === "visual")!;

    const attached = await applyEditOperation(root, parent.id, parent.revision, {
      type: "add_nested_timeline",
      trackId: parentTrack.id,
      childEditProjectId: child.id,
      childExpectedRevision: child.revision,
      startFrame: 0,
      sourceStartFrame: 0,
      sourceDurationFrames: 30,
    });
    const clip = nestedClip(attached.project);
    expect(clip).toMatchObject({ kind: "timeline", startFrame: 0, durationFrames: 24, trimStartFrame: 0 });
    expect(clip.sourcePath).toBeUndefined();
    expect(clip.nestedTimeline).toMatchObject({
      contract: "aicanvas.nested-timeline.v1",
      ownerProjectId: child.projectId,
      childEditProjectId: child.id,
      childEditProjectRevision: child.revision,
      childTimebase: { rateNumerator: 30_000, rateDenominator: 1_001 },
      childCanvas: { width: 320, height: 256 },
      childDurationFrames: 30,
      sourceRange: { startFrame: 0, durationFrames: 30 },
      sourceOffset: { numerator: 0, denominator: 1 },
      sourceStep: { numerator: 5, denominator: 4 },
      mappedDurationFrames: 24,
    });
    expect(Object.keys(clip.nestedTimeline!.childTimebase).sort()).toEqual(["rateDenominator", "rateNumerator"]);
    expect(clip.nestedTimeline?.childSnapshotSha256).toMatch(/^[a-f0-9]{64}$/);
    const snapshotPath = path.join(getSidecarPaths(root).editorDependencies, `${clip.nestedTimeline!.childSnapshotSha256}.json`);
    await expect(access(snapshotPath)).resolves.toBeUndefined();
    expect(JSON.parse(await readFile(snapshotPath, "utf8"))).toMatchObject({ schemaVersion: 1, project: { id: child.id, revision: child.revision } });

    const reloaded = await getEditProject(root, parent.id);
    expect(nestedClip(reloaded).nestedTimeline).toEqual(clip.nestedTimeline);
    const forged = structuredClone(reloaded);
    nestedClip(forged).trimStartFrame = 1;
    nestedClip(forged).trimStartSeconds = secondsForFrames(forged, 1);
    await expect(saveEditProject(root, forged, reloaded.revision)).rejects.toThrow("有理 sourceOffset");
    expect((await getEditProject(root, parent.id)).revision).toBe(reloaded.revision);

    const exported = await exportEditProjectOtio(root, parent.id, attached.project.revision);
    const document = JSON.parse(await readFile(exported.path, "utf8")) as any;
    expect(document.metadata.aicanvas.nestedTimelineContract).toBe("aicanvas.nested-timeline.v1");
    const stack = document.tracks.children[0].children[0];
    expect(stack).toMatchObject({ OTIO_SCHEMA: "Stack.1", metadata: { aicanvas: { nestedTimeline: { childEditProjectId: child.id, childSnapshotSha256: clip.nestedTimeline!.childSnapshotSha256 } } } });
    expect(stack.children[0].OTIO_SCHEMA).toBe("Track.1");
    const imported = await importEditProjectOtio(root, exported.path, "嵌套 OTIO 回读");
    expect(nestedClip(imported).nestedTimeline).toEqual(clip.nestedTimeline);

    const countBeforeTamper = (await listEditProjects(root)).length;
    const tamperedDocument = structuredClone(document);
    const tamperedStack = tamperedDocument.tracks.children[0].children[0];
    tamperedStack.children[0].name = "攻击者改写的标准轨道";
    tamperedStack.metadata.aicanvas.embeddedOtioSha256 = sha256TestJson(tamperedStack.children);
    const tamperedPath = path.join(root, "nested-self-hashed-tamper.otio");
    await writeFile(tamperedPath, `${JSON.stringify(tamperedDocument)}\n`, "utf8");
    await expect(importEditProjectOtio(root, tamperedPath)).rejects.toThrow("标准视图与冻结工程不一致");
    expect(await listEditProjects(root)).toHaveLength(countBeforeTamper);

    const unknownDocument = structuredClone(document);
    const unknownStack = unknownDocument.tracks.children[0].children[0];
    unknownStack.children[0].children.push({ OTIO_SCHEMA: "Timeline.1", effects: [], markers: [] });
    unknownStack.metadata.aicanvas.embeddedOtioSha256 = sha256TestJson(unknownStack.children);
    const unknownPath = path.join(root, "nested-unknown-timeline.otio");
    await writeFile(unknownPath, `${JSON.stringify(unknownDocument)}\n`, "utf8");
    await expect(importEditProjectOtio(root, unknownPath)).rejects.toThrow("不支持 Timeline.1");
    expect(await listEditProjects(root)).toHaveLength(countBeforeTamper);
  });

  it("按父整数帧无损 split/trim，并让 move/ripple/undo 继续走同一状态机", async () => {
    const { root, imagePath } = await fixture();
    const child = await projectWithImage(root, imagePath, { name: "30fps 子时间线", fps: 30, durationFrames: 30 });
    const parent = await createEditProject(root, { name: "24fps 父时间线", width: 320, height: 256, fps: 24, autoPopulate: false });
    const visual = parent.tracks.find((track) => track.kind === "visual")!;
    const attached = await applyEditOperation(root, parent.id, parent.revision, {
      type: "add_nested_timeline", trackId: visual.id, childEditProjectId: child.id, childExpectedRevision: child.revision, startFrame: 0,
    });
    const original = nestedClip(attached.project);
    expect(original.durationFrames).toBe(24);
    expect(original.nestedTimeline?.sourceStep).toEqual({ numerator: 5, denominator: 4 });

    const split = await applyEditOperation(root, parent.id, attached.project.revision, { type: "split_clip", clipId: original.id, timeSeconds: 7 / 24 });
    const pieces = split.project.tracks.find((track) => track.id === visual.id)!.clips;
    expect(pieces.map((clip) => ({ startFrame: clip.startFrame, durationFrames: clip.durationFrames, sourceOffset: clip.nestedTimeline?.sourceOffset }))).toEqual([
      { startFrame: 0, durationFrames: 7, sourceOffset: { numerator: 0, denominator: 1 } },
      { startFrame: 7, durationFrames: 17, sourceOffset: { numerator: 35, denominator: 4 } },
    ]);
    const right = pieces[1]!;
    const trimmed = await applyEditOperation(root, parent.id, split.project.revision, { type: "trim_to_playhead", clipId: right.id, timeSeconds: 10 / 24, side: "start" });
    const trimmedRight = trimmed.project.tracks.find((track) => track.id === visual.id)!.clips[1]!;
    expect(trimmedRight).toMatchObject({ startFrame: 10, durationFrames: 14 });
    expect(trimmedRight.nestedTimeline?.sourceOffset).toEqual({ numerator: 25, denominator: 2 });

    const overlay = await applyEditOperation(root, parent.id, trimmed.project.revision, { type: "add_track", kind: "visual", name: "嵌套移动轨" });
    const overlayTrack = overlay.project.tracks.find((track) => track.name === "嵌套移动轨")!;
    const moved = await applyEditOperation(root, parent.id, overlay.project.revision, { type: "move_clip", clipId: trimmedRight.id, targetTrackId: overlayTrack.id, startSeconds: 0 });
    expect(moved.project.tracks.find((track) => track.id === overlayTrack.id)?.clips[0]?.nestedTimeline?.sourceOffset).toEqual({ numerator: 25, denominator: 2 });
    await expect(applyEditOperation(root, parent.id, moved.project.revision, { type: "move_clip", clipId: trimmedRight.id, targetTrackId: parent.tracks.find((track) => track.kind === "audio")!.id, startSeconds: 0 })).rejects.toThrow("类型与目标轨道不匹配");
  });

  it("分数时基重复 split/trim 后保持精确有理 offset，并由 undo/redo/CAS 恢复", async () => {
    const { root, imagePath } = await fixture();
    const child = await projectWithImage(root, imagePath, { name: "23.976 精确子时间线", fps: 23.976, durationFrames: 24 });
    const parent = await createEditProject(root, { name: "29.97 精确父时间线", width: 320, height: 256, fps: 29.97, autoPopulate: false });
    const visual = parent.tracks.find((track) => track.kind === "visual")!;
    const attached = await applyEditOperation(root, parent.id, parent.revision, {
      type: "add_nested_timeline", trackId: visual.id, childEditProjectId: child.id, childExpectedRevision: child.revision, startFrame: 0,
    });
    const original = nestedClip(attached.project);
    expect(original).toMatchObject({ durationFrames: 30, nestedTimeline: { sourceStep: { numerator: 4, denominator: 5 } } });
    const parentRate = attached.project.timebase!.rateNumerator / attached.project.timebase!.rateDenominator;
    const split = await applyEditOperation(root, parent.id, attached.project.revision, { type: "split_clip", clipId: original.id, timeSeconds: 7 / parentRate });
    const right = split.project.tracks.find((track) => track.id === visual.id)!.clips[1]!;
    expect(right).toMatchObject({ startFrame: 7, durationFrames: 23, nestedTimeline: { sourceOffset: { numerator: 28, denominator: 5 } } });
    const trimStart = await applyEditOperation(root, parent.id, split.project.revision, { type: "trim_to_playhead", clipId: right.id, timeSeconds: 11 / parentRate, side: "start" });
    const trimmed = trimStart.project.tracks.find((track) => track.id === visual.id)!.clips[1]!;
    expect(trimmed).toMatchObject({ startFrame: 11, durationFrames: 19, nestedTimeline: { sourceOffset: { numerator: 44, denominator: 5 } } });
    const trimEnd = await applyEditOperation(root, parent.id, trimStart.project.revision, { type: "trim_to_playhead", clipId: trimmed.id, timeSeconds: 23 / parentRate, side: "end" });
    const trimmedEnd = trimEnd.project.tracks.find((track) => track.id === visual.id)!.clips[1]!;
    expect(trimmedEnd).toMatchObject({ startFrame: 11, durationFrames: 12, nestedTimeline: { sourceOffset: { numerator: 44, denominator: 5 } } });
    const secondSplit = await applyEditOperation(root, parent.id, trimEnd.project.revision, { type: "split_clip", clipId: trimmedEnd.id, timeSeconds: 17 / parentRate });
    const finalPieces = secondSplit.project.tracks.find((track) => track.id === visual.id)!.clips.slice(1);
    expect(finalPieces.map((entry) => ({ startFrame: entry.startFrame, durationFrames: entry.durationFrames, offset: entry.nestedTimeline?.sourceOffset }))).toEqual([
      { startFrame: 11, durationFrames: 6, offset: { numerator: 44, denominator: 5 } },
      { startFrame: 17, durationFrames: 6, offset: { numerator: 68, denominator: 5 } },
    ]);

    const undone = await undoEditProject(root, parent.id, secondSplit.project.revision);
    expect(undone.tracks.find((track) => track.id === visual.id)!.clips.slice(1)).toEqual([expect.objectContaining({ startFrame: 11, durationFrames: 12, nestedTimeline: expect.objectContaining({ sourceOffset: { numerator: 44, denominator: 5 } }) })]);
    const redone = await redoEditProject(root, parent.id, undone.revision);
    expect(redone.tracks.find((track) => track.id === visual.id)!.clips.slice(1).map((entry) => entry.nestedTimeline?.sourceOffset)).toEqual([{ numerator: 44, denominator: 5 }, { numerator: 68, denominator: 5 }]);
    await expect(applyEditOperation(root, parent.id, secondSplit.project.revision, { type: "ripple_insert_gap", timeSeconds: 0, durationSeconds: 1 / parentRate })).rejects.toThrow("其他窗口更新");
  });

  it("OTIO 私有 compound clip 保真并拒绝缺字段、非法 RationalTime 与丢失 children", async () => {
    const { root, imagePath } = await fixture();
    const child = await projectWithImage(root, imagePath, { name: "OTIO 私有子时间线", fps: 24, durationFrames: 24 });
    const parent = await createEditProject(root, { name: "OTIO 私有父时间线", width: 320, height: 256, fps: 24, autoPopulate: false });
    const attached = await applyEditOperation(root, parent.id, parent.revision, {
      type: "add_nested_timeline",
      trackId: parent.tracks.find((track) => track.kind === "visual")!.id,
      childEditProjectId: child.id,
      childExpectedRevision: child.revision,
      startFrame: 0,
    });
    const clip = nestedClip(attached.project);
    const customized = await applyEditOperation(root, parent.id, attached.project.revision, {
      type: "update_clip",
      clipId: clip.id,
      patch: {
        positionX: 64,
        positionY: -12,
        scale: 0.75,
        opacity: 0.5,
        filter: "warm",
        filterIntensity: 0.6,
        keyframes: [{ id: "nested-otio-keyframe", frame: 12, timeSeconds: 0.5, easing: "linear", positionX: 80, positionY: 4, scale: 0.9, rotation: 6 }],
      },
    });
    const exported = await exportEditProjectOtio(root, parent.id, customized.project.revision);
    const document = JSON.parse(await readFile(exported.path, "utf8")) as any;
    const imported = await importEditProjectOtio(root, exported.path, "OTIO compound 保真回读");
    expect(nestedClip(imported)).toMatchObject({ positionX: 64, positionY: -12, scale: 0.75, opacity: 0.5, filter: "warm", filterIntensity: 0.6 });
    expect(nestedClip(imported).keyframes).toEqual([expect.objectContaining({ id: "nested-otio-keyframe", frame: 12, positionX: 80 })]);
    const countBeforeReject = (await listEditProjects(root)).length;

    const rejectVariant = async (name: string, mutate: (value: any) => void, expected: string): Promise<void> => {
      const variant = structuredClone(document);
      mutate(variant);
      const filePath = path.join(root, `${name}.otio`);
      await writeFile(filePath, `${JSON.stringify(variant)}\n`, "utf8");
      await expect(importEditProjectOtio(root, filePath)).rejects.toThrow(expected);
      expect(await listEditProjects(root)).toHaveLength(countBeforeReject);
    };
    await rejectVariant("nested-missing-private-clip", (value) => { delete value.tracks.children[0].children[0].metadata.aicanvas.clip; }, "私有 clip metadata");
    await rejectVariant("nested-missing-duration", (value) => { delete value.tracks.children[0].children[0].metadata.aicanvas.clip.durationFrames; }, "标准时长与私有 metadata 不一致");
    await rejectVariant("nested-invalid-keyframes", (value) => { value.tracks.children[0].children[0].metadata.aicanvas.clip.keyframes = {}; }, "私有 clip 结构不完整");
    await rejectVariant("nested-zero-rate", (value) => { value.tracks.children[0].children[0].source_range.duration.rate = 0; }, "RationalTime.rate");
    await rejectVariant("nested-missing-track-children", (value) => { value.tracks.children[0].children = {}; }, "轨道 children 必须是数组");
  });

  it("拒绝自身引用和跨修订循环，失败时不推进父 revision", async () => {
    const { root, imagePath } = await fixture();
    const a = await projectWithImage(root, imagePath, { name: "时间线 A", fps: 24, durationFrames: 24 });
    const b = await projectWithImage(root, imagePath, { name: "时间线 B", fps: 24, durationFrames: 24 });
    const aVisual = a.tracks.find((track) => track.kind === "visual")!;
    await expect(applyEditOperation(root, a.id, a.revision, {
      type: "add_nested_timeline", trackId: aVisual.id, childEditProjectId: a.id, childExpectedRevision: a.revision, startFrame: 24,
    })).rejects.toThrow("自身");
    expect((await getEditProject(root, a.id)).revision).toBe(a.revision);

    const aWithB = await applyEditOperation(root, a.id, a.revision, {
      type: "add_nested_timeline", trackId: aVisual.id, childEditProjectId: b.id, childExpectedRevision: b.revision, startFrame: 24,
    });
    const bVisual = b.tracks.find((track) => track.kind === "visual")!;
    await expect(applyEditOperation(root, b.id, b.revision, {
      type: "add_nested_timeline", trackId: bVisual.id, childEditProjectId: a.id, childExpectedRevision: aWithB.project.revision, startFrame: 24,
    })).rejects.toThrow("循环");
    expect((await getEditProject(root, b.id)).revision).toBe(b.revision);
  });

  it("允许最多 8 层冻结 DAG，并拒绝第 9 层、缺失快照和缺失当前子工程", async () => {
    const { root, imagePath } = await fixture();
    let child = await projectWithImage(root, imagePath, { name: "深度 0 叶子", fps: 24, durationFrames: 4 });
    for (let depth = 1; depth <= 8; depth += 1) {
      const wrapper = await createEditProject(root, { name: `深度 ${depth} 包装`, width: 320, height: 256, fps: 24, autoPopulate: false });
      const attached = await applyEditOperation(root, wrapper.id, wrapper.revision, {
        type: "add_nested_timeline",
        trackId: wrapper.tracks.find((track) => track.kind === "visual")!.id,
        childEditProjectId: child.id,
        childExpectedRevision: child.revision,
        startFrame: 0,
      });
      child = attached.project;
    }
    const tooDeep = await createEditProject(root, { name: "深度 9 拒绝", width: 320, height: 256, fps: 24, autoPopulate: false });
    await expect(applyEditOperation(root, tooDeep.id, tooDeep.revision, {
      type: "add_nested_timeline",
      trackId: tooDeep.tracks.find((track) => track.kind === "visual")!.id,
      childEditProjectId: child.id,
      childExpectedRevision: child.revision,
      startFrame: 0,
    })).rejects.toThrow("深度超过 8");
    expect((await getEditProject(root, tooDeep.id)).revision).toBe(tooDeep.revision);

    const isolatedParent = await createEditProject(root, { name: "缺失依赖父工程", width: 320, height: 256, fps: 24, autoPopulate: false });
    const isolatedChild = await projectWithImage(root, imagePath, { name: "缺失依赖子工程", fps: 24, durationFrames: 4 });
    const isolated = await applyEditOperation(root, isolatedParent.id, isolatedParent.revision, {
      type: "add_nested_timeline",
      trackId: isolatedParent.tracks.find((track) => track.kind === "visual")!.id,
      childEditProjectId: isolatedChild.id,
      childExpectedRevision: isolatedChild.revision,
      startFrame: 0,
    });
    const snapshotPath = path.join(getSidecarPaths(root).editorDependencies, `${nestedClip(isolated.project).nestedTimeline!.childSnapshotSha256}.json`);
    await rm(snapshotPath);
    await expect(applyEditOperation(root, isolatedParent.id, isolated.project.revision, { type: "ripple_insert_gap", timeSeconds: 0, durationSeconds: 1 / 24 })).rejects.toThrow("快照缺失");
    expect((await getEditProject(root, isolatedParent.id)).revision).toBe(isolated.project.revision);

    const currentMissingParent = await createEditProject(root, { name: "当前子缺失父工程", width: 320, height: 256, fps: 24, autoPopulate: false });
    const currentMissingChild = await projectWithImage(root, imagePath, { name: "将删除当前文件的子工程", fps: 24, durationFrames: 4 });
    const currentMissing = await applyEditOperation(root, currentMissingParent.id, currentMissingParent.revision, {
      type: "add_nested_timeline",
      trackId: currentMissingParent.tracks.find((track) => track.kind === "visual")!.id,
      childEditProjectId: currentMissingChild.id,
      childExpectedRevision: currentMissingChild.revision,
      startFrame: 0,
    });
    await rm(path.join(getSidecarPaths(root).editorProjects, `${currentMissingChild.id}.json`));
    await expect(applyEditOperation(root, currentMissingParent.id, currentMissing.project.revision, { type: "ripple_insert_gap", timeSeconds: 0, durationSeconds: 1 / 24 })).rejects.toThrow("项目已缺失");
    expect((await getEditProject(root, currentMissingParent.id)).revision).toBe(currentMissing.project.revision);
  });

  it("子工程漂移后失败关闭，只有显式 refresh 才更新冻结快照", async () => {
    const { root, imagePath } = await fixture();
    const child = await projectWithImage(root, imagePath, { name: "可刷新子时间线", fps: 24, durationFrames: 24 });
    const parent = await createEditProject(root, { name: "刷新父时间线", width: 320, height: 256, fps: 24, autoPopulate: false });
    const visual = parent.tracks.find((track) => track.kind === "visual")!;
    const attached = await applyEditOperation(root, parent.id, parent.revision, {
      type: "add_nested_timeline", trackId: visual.id, childEditProjectId: child.id, childExpectedRevision: child.revision, startFrame: 0,
    });
    const oldRef = nestedClip(attached.project).nestedTimeline!;

    const oldSnapshotPath = path.join(getSidecarPaths(root).editorDependencies, `${oldRef.childSnapshotSha256}.json`);
    let childCurrent = child;
    for (let revisionIndex = 1; revisionIndex <= 35; revisionIndex += 1) {
      const childChanged = structuredClone(childCurrent);
      childChanged.name = `子时间线新修订 ${revisionIndex}`;
      childCurrent = await saveEditProject(root, childChanged, childCurrent.revision);
    }
    expect(childCurrent.revision).toBeGreaterThan(30);
    await expect(access(oldSnapshotPath)).resolves.toBeUndefined();
    await expect(applyEditOperation(root, parent.id, attached.project.revision, { type: "ripple_insert_gap", timeSeconds: 0, durationSeconds: 1 / 24 })).rejects.toThrow("漂移");
    expect((await getEditProject(root, parent.id)).revision).toBe(attached.project.revision);

    const refreshed = await applyEditOperation(root, parent.id, attached.project.revision, {
      type: "refresh_nested_timeline", clipId: nestedClip(attached.project).id, childExpectedRevision: childCurrent.revision,
    });
    const newRef = nestedClip(refreshed.project).nestedTimeline!;
    expect(newRef.childEditProjectRevision).toBe(childCurrent.revision);
    expect(newRef.childSnapshotSha256).not.toBe(oldRef.childSnapshotSha256);
    await expect(access(oldSnapshotPath)).resolves.toBeUndefined();

    const snapshotPath = path.join(getSidecarPaths(root).editorDependencies, `${newRef.childSnapshotSha256}.json`);
    const tampered = JSON.parse(await readFile(snapshotPath, "utf8")) as { project: { name: string } };
    tampered.project.name = "篡改快照";
    await writeFile(snapshotPath, `${JSON.stringify(tampered)}\n`, "utf8");
    await expect(applyEditOperation(root, parent.id, refreshed.project.revision, { type: "ripple_insert_gap", timeSeconds: 0, durationSeconds: 1 / 24 })).rejects.toThrow("哈希");
    expect((await getEditProject(root, parent.id)).revision).toBe(refreshed.project.revision);
  });

  it("真实 FFmpeg 同步导出与合成帧共享冻结依赖和渲染计划身份", async () => {
    const { root, imagePath } = await fixture();
    const child = await projectWithImage(root, imagePath, { name: "真实子合成", fps: 30, durationFrames: 15 });
    const parent = await createEditProject(root, { name: "真实父合成", width: 320, height: 256, fps: 24, autoPopulate: false });
    const visual = parent.tracks.find((track) => track.kind === "visual")!;
    const attached = await applyEditOperation(root, parent.id, parent.revision, {
      type: "add_nested_timeline", trackId: visual.id, childEditProjectId: child.id, childExpectedRevision: child.revision, startFrame: 0,
    });

    const extraction = await extractTimelineFrame(root, { editProjectId: parent.id, expectedRevision: attached.project.revision, timeSeconds: 5 / 24 });
    expect(extraction).toMatchObject({ width: 320, height: 256 });
    expect(extraction.dependencyManifestSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(extraction.renderPlanSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(extraction.dependencyRefs).toEqual([expect.objectContaining({ editProjectId: child.id, revision: child.revision, snapshotSha256: nestedClip(attached.project).nestedTimeline!.childSnapshotSha256 })]);
    expect(extraction.sourceClipRefs).toEqual(expect.arrayContaining([
      expect.objectContaining({ editProjectId: parent.id, editProjectRevision: attached.project.revision, clipId: nestedClip(attached.project).id }),
      expect.objectContaining({ editProjectId: child.id, editProjectRevision: child.revision, clipId: `clip-${child.id}` }),
    ]));
    await expect(access(extraction.framePath)).resolves.toBeUndefined();

    const job = await renderEditProject(root, parent.id, { expectedRevision: attached.project.revision });
    expect(job.status).toBe("succeeded");
    expect(job.editProjectRevision).toBe(attached.project.revision);
    expect(job.dependencyManifestSha256).toBe(extraction.dependencyManifestSha256);
    expect(job.renderPlanSha256).toBe(extraction.renderPlanSha256);
    expect(job.renderPlanPath).toContain(path.join(".aicanvas", "editor", "render-plans"));
    expect(job.commandSha256).toMatch(/^[a-f0-9]{64}$/);
    await expect(access(job.outputPath)).resolves.toBeUndefined();
    await expect(access(job.renderPlanPath!)).resolves.toBeUndefined();
  }, 60_000);

  it("用逐帧 framemd5 精确兑现 30→24 丢帧与 23.976→29.97 复制帧映射", async () => {
    const cases = [
      { childFps: 30, childRate: "30", childFrames: 30, parentFps: 24, numerator: 5, denominator: 4, outputFrames: 24 },
      { childFps: 23.976, childRate: "24000/1001", childFrames: 24, parentFps: 29.97, numerator: 4, denominator: 5, outputFrames: 30 },
      { childFps: 25, childRate: "25", childFrames: 25, parentFps: 24, numerator: 25, denominator: 24, outputFrames: 24 },
    ];
    for (const [caseIndex, entry] of cases.entries()) {
      const { root } = await fixture();
      const sourcePath = path.join(root, `frame-identity-${caseIndex}.mkv`);
      await generateFrameIdentityVideo(sourcePath, entry.childRate, entry.childFrames);
      const child = await projectWithVideo(root, sourcePath, { name: `动态子时间线 ${caseIndex}`, fps: entry.childFps, durationFrames: entry.childFrames });
      const parent = await createEditProject(root, { name: `动态父时间线 ${caseIndex}`, width: 320, height: 256, fps: entry.parentFps, autoPopulate: false });
      const attached = await applyEditOperation(root, parent.id, parent.revision, {
        type: "add_nested_timeline",
        trackId: parent.tracks.find((track) => track.kind === "visual")!.id,
        childEditProjectId: child.id,
        childExpectedRevision: child.revision,
        startFrame: 0,
      });
      expect(nestedClip(attached.project).nestedTimeline?.sourceStep).toEqual({ numerator: entry.numerator, denominator: entry.denominator });
      expect(nestedClip(attached.project).durationFrames).toBe(entry.outputFrames);
      const browserPreview = await prepareNestedTimelinePreview(root, parent.id, attached.project.revision, nestedClip(attached.project).id);
      expect(browserPreview.path).toMatch(/preview-[a-f0-9]{64}\.mp4$/);
      await expect(access(browserPreview.path)).resolves.toBeUndefined();
      const cacheNames = await readdir(getSidecarPaths(root).editorNestedCache);
      const childProxy = path.join(getSidecarPaths(root).editorNestedCache, cacheNames.find((name) => name.startsWith("project-") && name.endsWith(".mkv"))!);
      const mappedProxy = path.join(getSidecarPaths(root).editorNestedCache, cacheNames.find((name) => name.startsWith("mapped-") && name.endsWith(".mkv"))!);
      const childHashes = await frameMd5(childProxy);
      const mappedHashes = await frameMd5(mappedProxy);
      expect(childHashes).toHaveLength(entry.childFrames);
      expect(mappedHashes).toHaveLength(entry.outputFrames);
      for (let parentFrame = 0; parentFrame < entry.outputFrames; parentFrame += 1) {
        const expectedChildFrame = Math.floor(parentFrame * entry.numerator / entry.denominator);
        expect(mappedHashes[parentFrame], `case ${caseIndex} parent F${parentFrame} -> child F${expectedChildFrame}`).toBe(childHashes[expectedChildFrame]);
      }
    }
  }, 90_000);

  it("三层真实媒体保留子画中画、字幕和单份音频，并让同步/后台/抽帧共享血缘", async () => {
    const { root, imagePath } = await fixture();
    const overlayPath = path.join(root, "nested-overlay-blue.png");
    const audioPath = path.join(root, "nested-leaf-tone.wav");
    await sharp({ create: { width: 180, height: 180, channels: 3, background: "#2768c7" } }).png().toFile(overlayPath);
    await execFileAsync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=523.25:sample_rate=48000:duration=1", "-af", "volume=0.2", "-c:a", "pcm_s16le", "-y", audioPath]);

    const leafInitial = await projectWithImage(root, imagePath, { name: "25fps 多轨叶子", fps: 25, durationFrames: 25 });
    const leafDraft = structuredClone(leafInitial);
    const overlayTrackId = `track-overlay-${leafInitial.id}`;
    leafDraft.tracks.splice(1, 0, {
      id: overlayTrackId,
      kind: "visual",
      name: "叶子蓝色画中画",
      order: 1,
      locked: false,
      muted: false,
      hidden: false,
      clips: [{
        id: `clip-overlay-${leafInitial.id}`,
        trackId: overlayTrackId,
        kind: "image",
        name: "蓝色画中画",
        sourcePath: overlayPath,
        startFrame: 0,
        durationFrames: 25,
        trimStartFrame: 0,
        startSeconds: 0,
        durationSeconds: 1,
        trimStartSeconds: 0,
        playbackRate: 1,
        volume: 1,
        opacity: 1,
        muted: false,
        positionX: 48,
        positionY: -18,
        scale: 0.42,
        rotation: 0,
        filter: "none",
        filterIntensity: 1,
        keyframes: [],
      }],
    });
    leafDraft.tracks.forEach((track, order) => { track.order = order; });
    const leafAudio = leafDraft.tracks.find((track) => track.kind === "audio")!;
    leafAudio.clips.push({ id: `clip-audio-${leafInitial.id}`, trackId: leafAudio.id, kind: "audio", name: "叶子单音", sourcePath: audioPath, startFrame: 0, durationFrames: 25, trimStartFrame: 0, startSeconds: 0, durationSeconds: 1, trimStartSeconds: 0, playbackRate: 1, volume: 1, opacity: 1, muted: false, fadeInSeconds: 0, fadeOutSeconds: 0 });
    const leafSubtitle = leafDraft.tracks.find((track) => track.kind === "subtitle")!;
    leafSubtitle.clips.push({ id: `clip-subtitle-${leafInitial.id}`, trackId: leafSubtitle.id, kind: "subtitle", name: "叶子字幕", startFrame: 0, durationFrames: 25, trimStartFrame: 0, startSeconds: 0, durationSeconds: 1, trimStartSeconds: 0, playbackRate: 1, volume: 1, opacity: 1, muted: false, text: "嵌套字幕可见", fontSize: 28, fontColor: "#ffffff", subtitleBackground: "#000000" });
    const leaf = await saveEditProject(root, leafDraft, leafInitial.revision);

    const middleInitial = await createEditProject(root, { name: "24fps 中层", width: 320, height: 256, fps: 24, autoPopulate: false });
    const middleAttached = await applyEditOperation(root, middleInitial.id, middleInitial.revision, { type: "add_nested_timeline", trackId: middleInitial.tracks.find((track) => track.kind === "visual")!.id, childEditProjectId: leaf.id, childExpectedRevision: leaf.revision, startFrame: 0 });
    const middleAdjusted = await applyEditOperation(root, middleInitial.id, middleAttached.project.revision, { type: "update_clip", clipId: nestedClip(middleAttached.project).id, patch: { scale: 0.94, positionY: 4 } });
    const middle = middleAdjusted.project;

    const rootInitial = await createEditProject(root, { name: "29.97 根层", width: 320, height: 256, fps: 29.97, autoPopulate: false });
    const rootAttached = await applyEditOperation(root, rootInitial.id, rootInitial.revision, { type: "add_nested_timeline", trackId: rootInitial.tracks.find((track) => track.kind === "visual")!.id, childEditProjectId: middle.id, childExpectedRevision: middle.revision, startFrame: 0 });
    const rootAdjusted = await applyEditOperation(root, rootInitial.id, rootAttached.project.revision, { type: "update_clip", clipId: nestedClip(rootAttached.project).id, patch: { scale: 0.9, positionX: 8, opacity: 0.95, volume: 0.5 } });
    const rootProject = rootAdjusted.project;
    const rootRate = rootProject.timebase!.rateNumerator / rootProject.timebase!.rateDenominator;

    const extraction = await extractTimelineFrame(root, { editProjectId: rootProject.id, expectedRevision: rootProject.revision, timeSeconds: 15 / rootRate });
    expect(extraction.dependencyRefs?.map((entry) => ({ id: entry.editProjectId, depth: entry.depth }))).toEqual([
      { id: middle.id, depth: 1 },
      { id: leaf.id, depth: 2 },
    ]);
    const leafLineage = extraction.sourceClipRefs?.filter((entry) => entry.editProjectId === leaf.id).map((entry) => entry.clipId).sort();
    expect(leafLineage).toEqual([`clip-${leaf.id}`, `clip-audio-${leaf.id}`, `clip-overlay-${leaf.id}`, `clip-subtitle-${leaf.id}`].sort());
    const { data, info } = await sharp(extraction.framePath).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    let bluePixels = 0;
    let lightPixels = 0;
    for (let index = 0; index < data.length; index += info.channels) {
      const red = data[index]!;
      const green = data[index + 1]!;
      const blue = data[index + 2]!;
      if (blue > 120 && blue > red * 1.25 && blue > green * 1.15) bluePixels += 1;
      if (red > 210 && green > 210 && blue > 210) lightPixels += 1;
    }
    expect(bluePixels).toBeGreaterThan(500);
    expect(lightPixels).toBeGreaterThan(40);

    const leafJob = await renderEditProject(root, leaf.id, { expectedRevision: leaf.revision });
    const rootJob = await renderEditProject(root, rootProject.id, { expectedRevision: rootProject.revision });
    expect(rootJob).toMatchObject({ status: "succeeded", dependencyManifestSha256: extraction.dependencyManifestSha256, renderPlanSha256: extraction.renderPlanSha256 });
    const receipt = await getPublicationReceipt(root, rootJob.publicationReceiptId!);
    expect(receipt?.context.metadata).toMatchObject({ editProjectId: rootProject.id, editProjectRevision: rootProject.revision, dependencyManifestSha256: rootJob.dependencyManifestSha256, renderPlanSha256: rootJob.renderPlanSha256 });
    expect(receipt?.check.sha256).toMatch(/^[a-f0-9]{64}$/);
    const backgroundStarted = await startEditRender(root, rootProject.id, { expectedRevision: rootProject.revision });
    const background = await waitForEditRender(root, backgroundStarted.id);
    expect(background).toMatchObject({ status: "succeeded", dependencyManifestSha256: rootJob.dependencyManifestSha256, renderPlanSha256: rootJob.renderPlanSha256 });
    const leafVolume = await meanVolumeDb(leafJob.outputPath);
    const rootVolume = await meanVolumeDb(rootJob.outputPath);
    expect(rootVolume - leafVolume).toBeGreaterThan(-7.4);
    expect(rootVolume - leafVolume).toBeLessThan(-4.8);
    const { stdout: probeJson } = await execFileAsync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name", "-of", "json", rootJob.outputPath]);
    const probe = JSON.parse(probeJson) as { streams?: Array<{ codec_type?: string; codec_name?: string }> };
    expect(probe.streams).toEqual(expect.arrayContaining([expect.objectContaining({ codec_type: "video", codec_name: "h264" }), expect.objectContaining({ codec_type: "audio", codec_name: "aac" })]));
  }, 120_000);
});
