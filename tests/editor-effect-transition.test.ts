import { execFile } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import sharp from "sharp";
import {
  applyEditOperation,
  exportEditProjectOtio,
  extractTimelineFrame,
  getEditProject,
  getEditHistoryInfo,
  importEditProjectOtio,
  listEditProjects,
  renderEditProject,
  redoEditProject,
  startEditRender,
  undoEditProject,
  waitForEditRender,
} from "../src/core/editor.js";
import { ensureSidecar, getSidecarPaths, readJson, writeJsonAtomic } from "../src/core/sidecar.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

function rational(value: number, rate = 24) {
  return { OTIO_SCHEMA: "RationalTime.1", value, rate };
}

function range(start: number, duration: number, rate = 24) {
  return { OTIO_SCHEMA: "TimeRange.1", start_time: rational(start, rate), duration: rational(duration, rate) };
}

async function fixture(): Promise<{ root: string; firstVideo: string; secondVideo: string; audio: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-effect-transition-"));
  roots.push(root);
  const config = await ensureSidecar(root);
  config.sourceRoots = [];
  config.outputRoots = [root];
  await writeJsonAtomic(getSidecarPaths(root).config, config);
  const firstVideo = path.join(root, "outgoing.mp4");
  const secondVideo = path.join(root, "incoming.mp4");
  const audio = path.join(root, "timewarp.wav");
  await execFileAsync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=red:s=320x320:r=24:d=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", firstVideo]);
  await execFileAsync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=320x320:r=24:d=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", secondVideo]);
  await execFileAsync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=523:sample_rate=48000:duration=2", "-c:a", "pcm_s16le", "-y", audio]);
  return { root, firstVideo, secondVideo, audio };
}

function clip(name: string, sourcePath: string, start: number, duration: number, availableDuration = 48, effects: unknown[] = []) {
  return {
    OTIO_SCHEMA: "Clip.2",
    name,
    source_range: range(start, duration),
    media_reference: {
      OTIO_SCHEMA: "ExternalReference.1",
      target_url: pathToFileURL(sourcePath).href,
      available_range: range(0, availableDuration),
      available_image_bounds: null,
      metadata: {},
    },
    effects,
    markers: [],
    metadata: {},
  };
}

function linearTimeWarp(scalar: number) {
  return { OTIO_SCHEMA: "LinearTimeWarp.1", name: "2x", effect_name: "LinearTimeWarp", time_scalar: scalar, enabled: true, metadata: {} };
}

function dissolve(inOffset = 3, outOffset = 5, transitionType = "SMPTE_Dissolve") {
  return {
    OTIO_SCHEMA: "Transition.1",
    name: "标准交叉溶解",
    transition_type: transitionType,
    in_offset: rational(inOffset),
    out_offset: rational(outOffset),
    enabled: true,
    metadata: {},
  };
}

function document(firstVideo: string, secondVideo: string, audio: string) {
  return {
    OTIO_SCHEMA: "Timeline.1",
    name: "标准 Effect Transition",
    global_start_time: null,
    tracks: {
      OTIO_SCHEMA: "Stack.1",
      name: "tracks",
      source_range: null,
      effects: [],
      markers: [],
      metadata: {},
      children: [
        {
          OTIO_SCHEMA: "Track.1",
          name: "V1",
          kind: "Video",
          source_range: null,
          effects: [],
          markers: [],
          metadata: {},
          children: [clip("A", firstVideo, 0, 24), dissolve(), clip("B", secondVideo, 4, 24)],
        },
        {
          OTIO_SCHEMA: "Track.1",
          name: "A1",
          kind: "Audio",
          source_range: null,
          effects: [],
          markers: [],
          metadata: {},
          children: [clip("2x audio", audio, 0, 48, 48, [linearTimeWarp(2)])],
        },
      ],
    },
    metadata: { aicanvas: { fps: 24, width: 320, height: 320, backgroundColor: "#000000" } },
  };
}

function rewriteRationalRates(value: unknown, rate: number): void {
  if (Array.isArray(value)) { value.forEach((entry) => rewriteRationalRates(entry, rate)); return; }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (record.OTIO_SCHEMA === "RationalTime.1") record.rate = rate;
  Object.values(record).forEach((entry) => rewriteRationalRates(entry, rate));
}

async function writeOtio(root: string, name: string, value: unknown): Promise<string> {
  const filePath = path.join(root, name);
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return filePath;
}

describe("OTIO 第三方 Effect / Transition 有界兼容", () => {
  it("导入并标准往返 LinearTimeWarp.1 与非对称 SMPTE_Dissolve", async () => {
    const { root, firstVideo, secondVideo, audio } = await fixture();
    const inputPath = await writeOtio(root, "standard.otio", document(firstVideo, secondVideo, audio));
    const imported = await importEditProjectOtio(root, inputPath);
    const visual = imported.tracks.find((track) => track.kind === "visual")!;
    const first = visual.clips[0]!;
    const second = visual.clips[1]!;
    expect(first).toMatchObject({ startFrame: 0, durationFrames: 24, transitionOut: "smpte_dissolve" });
    expect((first as any).sourceAvailableRange).toEqual({ startFrame: 0, durationFrames: 48 });
    expect((first as any).transition).toEqual({ contract: "aicanvas.otio-transition.v1", kind: "smpte_dissolve", targetClipId: second.id, inOffsetFrames: 3, outOffsetFrames: 5 });
    expect(second).toMatchObject({ startFrame: 24, durationFrames: 24, trimStartFrame: 4 });
    const audioClip = imported.tracks.find((track) => track.kind === "audio")!.clips[0]!;
    expect(audioClip).toMatchObject({ playbackRate: 2, durationFrames: 24, trimStartFrame: 0 });
    expect((audioClip as any).sourceAvailableRange).toEqual({ startFrame: 0, durationFrames: 48 });

    const exported = await exportEditProjectOtio(root, imported.id, imported.revision);
    const exportedDocument = await readJson<Record<string, any>>(exported.path, {});
    expect(exportedDocument.metadata.aicanvas.effectTransitionContract).toBe("aicanvas.otio-effect-transition.v1");
    const videoChildren = exportedDocument.tracks.children[0].children;
    expect(videoChildren.map((entry: any) => entry.OTIO_SCHEMA)).toEqual(["Clip.2", "Transition.1", "Clip.2"]);
    expect(videoChildren[1]).toMatchObject({ transition_type: "SMPTE_Dissolve", in_offset: { value: 3, rate: 24 }, out_offset: { value: 5, rate: 24 }, enabled: true });
    const audioEffects = exportedDocument.tracks.children[1].children[0].effects;
    expect(audioEffects).toEqual([expect.objectContaining({ OTIO_SCHEMA: "LinearTimeWarp.1", effect_name: "LinearTimeWarp", time_scalar: 2, enabled: true })]);

    const roundTripped = await importEditProjectOtio(root, exported.path, "标准往返");
    const roundVisual = roundTripped.tracks.find((track) => track.kind === "visual")!.clips;
    expect(roundVisual[0]!.transitionOut).toBe("smpte_dissolve");
    expect((roundVisual[0] as any).transition).toMatchObject({ targetClipId: roundVisual[1]!.id, inOffsetFrames: 3, outOffsetFrames: 5 });
    expect(roundTripped.tracks.find((track) => track.kind === "audio")!.clips[0]!.playbackRate).toBe(2);
  });

  it("未知 schema、非整帧 offset、handle 不足、私有冲突和未验证组合均在创建工程前拒绝", async () => {
    const { root, firstVideo, secondVideo, audio } = await fixture();
    const base = document(firstVideo, secondVideo, audio);
    const variants: Array<{ name: string; mutate: (value: any) => void }> = [
      { name: "custom-transition", mutate: (value) => { value.tracks.children[0].children[1].transition_type = "Custom_Transition"; } },
      { name: "fractional-offset", mutate: (value) => { value.tracks.children[0].children[1].in_offset.value = .5; } },
      { name: "missing-outgoing-handle", mutate: (value) => { value.tracks.children[0].children[0].media_reference.available_range.duration.value = 26; } },
      { name: "generic-effect", mutate: (value) => { value.tracks.children[1].children[0].effects = [{ OTIO_SCHEMA: "Effect.1", name: "blur", effect_name: "Blur", enabled: true, metadata: {} }]; } },
      { name: "private-conflict", mutate: (value) => { value.tracks.children[1].children[0].metadata = { aicanvas: { playbackRate: 1 } }; } },
      { name: "timewarp-transition-combination", mutate: (value) => { value.tracks.children[0].children[0].effects = [linearTimeWarp(2)]; } },
    ];
    for (const variant of variants) {
      const candidate = structuredClone(base);
      variant.mutate(candidate);
      const before = await listEditProjects(root);
      await expect(importEditProjectOtio(root, await writeOtio(root, `${variant.name}.otio`, candidate))).rejects.toThrow();
      expect(await listEditProjects(root), variant.name).toHaveLength(before.length);
    }
  });

  it("24000/1001 分数时基下 offsets 与 LinearTimeWarp 仍保持整数帧 round-trip", async () => {
    const { root, firstVideo, secondVideo, audio } = await fixture();
    const fractional = document(firstVideo, secondVideo, audio);
    const rate = 24_000 / 1_001;
    rewriteRationalRates(fractional, rate);
    fractional.metadata.aicanvas.fps = rate;
    for (const track of fractional.tracks.children) {
      for (const child of track.children) {
        const mediaReference = (child as any).media_reference;
        if (mediaReference?.available_range) mediaReference.available_range.duration.value = 47;
      }
    }
    (fractional.tracks.children[1]!.children[0]! as any).source_range.duration.value = 46;
    const imported = await importEditProjectOtio(root, await writeOtio(root, "fractional.otio", fractional));
    expect(imported.timebase).toEqual({ rateNumerator: 24_000, rateDenominator: 1_001 });
    const clips = imported.tracks.find((track) => track.kind === "visual")!.clips;
    expect((clips[0] as any).transition).toMatchObject({ targetClipId: clips[1]!.id, inOffsetFrames: 3, outOffsetFrames: 5 });
    expect(imported.tracks.find((track) => track.kind === "audio")!.clips[0]).toMatchObject({ durationFrames: 23, playbackRate: 2 });
    const exported = await exportEditProjectOtio(root, imported.id, imported.revision);
    const roundTripped = await importEditProjectOtio(root, exported.path, "分数时基往返");
    expect(roundTripped.timebase).toEqual(imported.timebase);
    expect((roundTripped.tracks.find((track) => track.kind === "visual")!.clips[0] as any).transition).toMatchObject({ inOffsetFrames: 3, outOffsetFrames: 5 });
  });

  it("split 保持目标身份，破坏转场邻接或 handles 的 trim/move 失败关闭，undo/redo 精确恢复", async () => {
    const { root, firstVideo, secondVideo, audio } = await fixture();
    const imported = await importEditProjectOtio(root, await writeOtio(root, "editing.otio", document(firstVideo, secondVideo, audio)));
    const visual = imported.tracks.find((track) => track.kind === "visual")!;
    const originalFirst = visual.clips[0]!;
    const target = visual.clips[1]!;
    const split = await applyEditOperation(root, imported.id, imported.revision, { type: "split_clip", clipId: originalFirst.id, timeSeconds: 10 / 24 });
    const splitVisual = split.project.tracks.find((track) => track.kind === "visual")!.clips;
    expect(splitVisual).toHaveLength(3);
    expect(splitVisual[0]!.transitionOut).toBe("cut");
    expect(splitVisual[1]!.transitionOut).toBe("smpte_dissolve");
    expect((splitVisual[1] as any).transition?.targetClipId).toBe(target.id);
    await expect(applyEditOperation(root, imported.id, split.project.revision, { type: "trim_to_playhead", clipId: splitVisual[1]!.id, timeSeconds: 22 / 24, side: "end" })).rejects.toThrow();
    expect((await getEditProject(root, imported.id)).revision).toBe(split.project.revision);
    await expect(applyEditOperation(root, imported.id, split.project.revision, { type: "move_clip", clipId: target.id, targetTrackId: visual.id, startSeconds: 2 })).rejects.toThrow();
    expect((await getEditProject(root, imported.id)).revision).toBe(split.project.revision);

    const undone = await undoEditProject(root, imported.id, split.project.revision);
    expect(undone.tracks.find((track) => track.kind === "visual")!.clips).toHaveLength(2);
    const redone = await redoEditProject(root, imported.id, undone.revision);
    const redoneVisual = redone.tracks.find((track) => track.kind === "visual")!.clips;
    expect(redoneVisual).toHaveLength(3);
    expect((redoneVisual[1] as any).transition).toMatchObject({ targetClipId: target.id, inOffsetFrames: 3, outOffsetFrames: 5 });
    expect(await getEditHistoryInfo(root, imported.id)).toMatchObject({ canUndo: true, canRedo: false });
  });

  it("同步/后台 FFmpeg 与抽帧共享非对称 dissolve 和 LinearTimeWarp 结果", async () => {
    const { root, firstVideo, secondVideo, audio } = await fixture();
    const imported = await importEditProjectOtio(root, await writeOtio(root, "render.otio", document(firstVideo, secondVideo, audio)));
    const frames = await Promise.all([21, 24, 28, 29].map((frame) => extractTimelineFrame(root, { editProjectId: imported.id, expectedRevision: imported.revision, timeSeconds: frame / 24 })));
    const colors = await Promise.all(frames.map(async (entry) => {
      const stats = await sharp(entry.framePath).stats();
      return { red: stats.channels[0]!.mean, blue: stats.channels[2]!.mean };
    }));
    expect(colors[0]!.red).toBeGreaterThan(220);
    expect(colors[0]!.blue).toBeLessThan(30);
    expect(colors[1]!.red).toBeGreaterThan(60);
    expect(colors[1]!.blue).toBeGreaterThan(60);
    expect(colors[2]!.blue).toBeGreaterThan(colors[2]!.red * 3);
    expect(colors[3]!.blue).toBeGreaterThan(220);
    expect(colors[3]!.red).toBeLessThan(30);

    const synchronous = await renderEditProject(root, imported.id, { expectedRevision: imported.revision });
    expect(synchronous.status).toBe("succeeded");
    expect((await stat(synchronous.outputPath)).size).toBeGreaterThan(1_000);
    const { stdout } = await execFileAsync("ffprobe", ["-v", "error", "-count_frames", "-show_entries", "stream=codec_type,nb_read_frames,duration", "-of", "json", synchronous.outputPath]);
    const streams = JSON.parse(stdout) as { streams?: Array<{ codec_type?: string; nb_read_frames?: string; duration?: string }> };
    expect(streams.streams?.find((stream) => stream.codec_type === "video")?.nb_read_frames).toBe("48");
    const audioStream = streams.streams?.find((stream) => stream.codec_type === "audio");
    expect(Number(audioStream?.duration)).toBeGreaterThan(.95);
    expect(Number(audioStream?.duration)).toBeLessThan(1.05);

    const background = await startEditRender(root, imported.id, { expectedRevision: imported.revision });
    const completed = await waitForEditRender(root, background.id);
    expect(completed.status).toBe("succeeded");
    expect((await stat(completed.outputPath)).size).toBeGreaterThan(1_000);
  }, 60_000);
});
