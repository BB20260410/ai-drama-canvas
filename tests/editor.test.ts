import { access, chmod, copyFile, mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import sharp from "sharp";
import { seedProductionReady } from "./workflow-helpers.js";
import { MAX_EDIT_TIMELINE_SECONDS, applyEditOperation, beginEditorSession, cancelEditRender, closeEditorSession, createEditProject, createVideoContinuationPack, exportEditProjectOtio, extractLastFrame, extractTimelineFrame, getEditHistoryInfo, getEditProject, getEditorSessionState, importEditProjectOtio, listEditMedia, listEditProjects, listEditRenderJobs, listTimelineFrameExtractions, listVideoContinuationPacks, prepareEditMediaPreview, prepareEditMediaProxy, prepareTimelineVideoContinuation, probeVideoEngine, redoEditProject, renderEditProject, resolveEditorSessionRecovery, saveEditProject, setEditorSessionProject, startEditRender, undoEditProject, updateVideoContinuationPack, waitForEditRender } from "../src/core/editor.js";
import { listAssetRelations } from "../src/core/asset-registry.js";
import { executeIdempotentCommand } from "../src/core/command-bus.js";
import { listGenerationJobs, processGenerationQueue } from "../src/core/generation.js";
import { listPublicationReceipts } from "../src/core/publication.js";
import { getProjectIndex, scanAndPersist } from "../src/core/service.js";
import { ensureSidecar, getSidecarPaths, readJson, writeJsonAtomic } from "../src/core/sidecar.js";
import { evaluateEditTransformAtFrame } from "../src/core/keyframe-curve.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

function expectTransformClose(actual: ReturnType<typeof evaluateEditTransformAtFrame>, expected: ReturnType<typeof evaluateEditTransformAtFrame>, precision = 5): void {
  for (const property of ["positionX", "positionY", "scale", "rotation"] as const) expect(actual[property]).toBeCloseTo(expected[property], precision);
}

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-editor-"));
  roots.push(root);
  const config = await ensureSidecar(root);
  config.sourceRoots = [];
  config.outputRoots = [root];
  await writeJsonAtomic(getSidecarPaths(root).config, config);
  for (const unit of [1, 2]) {
    const directory = path.join(root, `EP01_15s_${String(unit).padStart(3, "0")}_剪辑测试${unit}`);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "00_信息.md"), `# 剪辑测试 ${unit}\n视频最终状态：通过\n`, "utf8");
    await execFileAsync("ffmpeg", [
      "-v", "error",
      "-f", "lavfi",
      "-i", `testsrc2=size=320x320:rate=24`,
      "-vf", unit === 1 ? "hue=h=0" : "hue=h=120",
      "-t", "2",
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      path.join(directory, `EP01_15s_${String(unit).padStart(3, "0")}_v1.mp4`),
    ]);
    if (unit === 1) {
      await execFileAsync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "2", "-c:a", "aac", path.join(directory, "EP01_15s_001_测试配乐.m4a")]);
    }
  }
  await scanAndPersist(root);
  await seedProductionReady(root, "frames");
  return root;
}

describe("本地成片剪辑工程", () => {
  it("同一项目只允许一个活动后台成片导出，取消后释放容量", async () => {
    const root = await fixture();
    const project = await createEditProject(root, { name: "导出容量测试", episode: 1, width: 320, height: 320, fps: 24 });
    const fakeFfmpeg = path.join(root, "fake-ffmpeg.mjs");
    await writeFile(fakeFfmpeg, `#!/usr/bin/env node\nif (process.argv.includes("-version")) { console.log("ffmpeg version fake-capacity-test"); process.exit(0); }\nprocess.on("SIGTERM", () => process.exit(143));\nsetInterval(() => {}, 1000);\n`, "utf8");
    await chmod(fakeFfmpeg, 0o755);
    const previousFfmpeg = process.env.AI_CANVAS_FFMPEG;
    process.env.AI_CANVAS_FFMPEG = fakeFfmpeg;
    try {
      const first = await startEditRender(root, project.id, { expectedRevision: project.revision });
      expect(first.status).toBe("running");
      await expect(startEditRender(root, project.id, { expectedRevision: project.revision })).rejects.toThrow("已有活动成片导出");
      const videoArtifactId = (await listEditMedia(root, 1)).find((item) => item.kind === "video")!.artifactId;
      await expect(prepareEditMediaPreview(root, videoArtifactId)).rejects.toThrow("正在进行成片导出");
      await expect(prepareEditMediaProxy(root, videoArtifactId)).rejects.toThrow("正在进行成片导出");
      await expect(extractTimelineFrame(root, { editProjectId: project.id, expectedRevision: project.revision, timeSeconds: .1 })).rejects.toThrow("正在进行成片导出");
      await cancelEditRender(root, first.id);
      expect((await waitForEditRender(root, first.id)).status).toBe("cancelled");

      const second = await startEditRender(root, project.id, { expectedRevision: project.revision });
      expect(second.id).not.toBe(first.id);
      await cancelEditRender(root, second.id);
      expect((await waitForEditRender(root, second.id)).status).toBe("cancelled");
      expect((await listEditRenderJobs(root)).filter((job) => job.status === "running")).toEqual([]);
    } finally {
      if (previousFfmpeg === undefined) delete process.env.AI_CANVAS_FFMPEG;
      else process.env.AI_CANVAS_FFMPEG = previousFfmpeg;
    }
  }, 60_000);

  it("并发预览通过项目容量锁保留全部索引，重复素材只生成一个缓存版本", async () => {
    const root = await fixture();
    for (const unit of [1, 2]) {
      const directory = path.join(root, `EP01_15s_${String(unit).padStart(3, "0")}_剪辑测试${unit}`);
      await sharp({ create: { width: 1080, height: 1920 + unit, channels: 3, background: unit === 1 ? "#7f5a2a" : "#274f68" } })
        .png()
        .toFile(path.join(directory, `EP01_15s_${String(unit).padStart(3, "0")}_首帧_raw.png`));
    }
    await scanAndPersist(root);
    const images = (await getProjectIndex(root)).artifacts.filter((artifact) => artifact.kind === "raw-image").slice(0, 2);
    expect(images).toHaveLength(2);
    const [first, second, repeated] = await Promise.all([
      prepareEditMediaPreview(root, images[0]!.id),
      prepareEditMediaPreview(root, images[1]!.id),
      prepareEditMediaPreview(root, images[0]!.id),
    ]);
    expect(first.thumbnailPath).toBeTruthy();
    expect(second.thumbnailPath).toBeTruthy();
    expect(repeated.thumbnailPath).toBe(first.thumbnailPath);
    const refreshed = await readJson<{ previews: Record<string, { thumbnailPath?: string }> }>(getSidecarPaths(root).editorPreviewIndex, { previews: {} });
    expect(refreshed.previews[images[0]!.id]?.thumbnailPath).toBe(first.thumbnailPath);
    expect(refreshed.previews[images[1]!.id]?.thumbnailPath).toBe(second.thumbnailPath);
  }, 60_000);

  it("异常退出后必须明确选择稳定修订或最新修订，稳定恢复复用现有历史", async () => {
    const root = await fixture();
    const opened = await beginEditorSession(root);
    expect(opened.recovery).toBeUndefined();
    const project = await createEditProject(root, { name: "异常恢复测试", episode: 1, width: 320, height: 320, fps: 24 });
    await setEditorSessionProject(root, opened.state.sessionId, project.id);
    const originalDuration = project.tracks[0]!.clips[0]!.durationSeconds;
    project.tracks[0]!.clips[0]!.durationSeconds = .4;
    project.tracks[0]!.clips[1]!.startSeconds = .4;
    project.tracks[0]!.clips[1]!.durationSeconds = .4;
    const latest = await saveEditProject(root, project, project.revision);
    await setEditorSessionProject(root, opened.state.sessionId, latest.id);

    const afterCrash = await beginEditorSession(root);
    expect(afterCrash.recovery).toEqual(expect.objectContaining({ projectId: latest.id, latestRevision: 2, stableRevision: 1, stableAvailable: true }));
    await expect(setEditorSessionProject(root, afterCrash.state.sessionId, latest.id)).rejects.toThrow("必须先选择");
    const unresolvedClose = await closeEditorSession(root, afterCrash.state.sessionId);
    expect(unresolvedClose).toEqual(expect.objectContaining({ cleanShutdown: false, recoveryPending: true }));

    const promptedAgain = await beginEditorSession(root);
    expect(promptedAgain.recovery?.stableAvailable).toBe(true);
    const restored = await resolveEditorSessionRecovery(root, promptedAgain.state.sessionId, "stable");
    expect(restored.project.revision).toBe(3);
    expect(restored.project.tracks[0]?.clips[0]?.durationSeconds).toBe(originalDuration);
    expect(restored.state).toEqual(expect.objectContaining({ recoveryPending: false, lastStableRevision: 3, lastProjectRevision: 3 }));
    const closed = await closeEditorSession(root, promptedAgain.state.sessionId);
    expect(closed).toEqual(expect.objectContaining({ cleanShutdown: true, lastStableRevision: 3 }));

    const cleanReopen = await beginEditorSession(root);
    expect(cleanReopen.recovery).toBeUndefined();
    await closeEditorSession(root, cleanReopen.state.sessionId);
  });

  it("异常恢复状态保留未完成导出 ID，选择最新修订不会改写工程", async () => {
    const root = await fixture();
    const opened = await beginEditorSession(root);
    const project = await createEditProject(root, { name: "最新修订恢复", episode: 1, width: 320, height: 320, fps: 24 });
    await setEditorSessionProject(root, opened.state.sessionId, project.id);
    await writeJsonAtomic(getSidecarPaths(root).editorRenders, {
      schemaVersion: 1,
      jobs: [{ schemaVersion: 1, id: "render-interrupted-session", editProjectId: project.id, status: "running", outputPath: path.join(root, "interrupted.mp4"), progress: .42, durationSeconds: 10, pid: 999_999_997, startedAt: new Date().toISOString() }],
    });
    const afterCrash = await beginEditorSession(root);
    expect(afterCrash.recovery?.incompleteRenderIds).toContain("render-interrupted-session");
    const resolved = await resolveEditorSessionRecovery(root, afterCrash.state.sessionId, "latest");
    expect(resolved.project.revision).toBe(project.revision);
    expect(resolved.choice).toBe("latest");
    expect((await getEditorSessionState(root))?.recoveryPending).toBe(false);
    await closeEditorSession(root, afterCrash.state.sessionId);
  });

  it("从真实视频建立工程并用修订号防止并发覆盖", async () => {
    const root = await fixture();
    const media = await listEditMedia(root, 1);
    expect(media.filter((item) => item.kind === "video")).toHaveLength(2);
    expect(media.filter((item) => item.kind === "audio")).toHaveLength(1);
    expect(media.every((item) => path.isAbsolute(item.path))).toBe(true);

    const project = await createEditProject(root, { name: "EP01 成片", episode: 1, width: 320, height: 320, fps: 24 });
    expect(project.tracks).toHaveLength(3);
    expect(project.tracks[0]?.clips).toHaveLength(2);
    expect(project.tracks[0]?.clips[1]?.startSeconds).toBeGreaterThan(0);
    expect(await listEditProjects(root)).toHaveLength(1);

    project.tracks[0]!.clips[0]!.durationSeconds = 0.4;
    project.tracks[0]!.clips[1]!.startSeconds = 0.4;
    project.tracks[0]!.clips[1]!.durationSeconds = 0.4;
    const saved = await saveEditProject(root, project, project.revision);
    expect(saved.revision).toBe(2);
    expect(saved.timebase).toEqual({ rateNumerator: 24, rateDenominator: 1 });
    expect(saved.tracks[0]?.clips.every((clip) => Number.isInteger(clip.startFrame) && Number.isInteger(clip.durationFrames))).toBe(true);
    const unchanged = await saveEditProject(root, saved, saved.revision);
    expect(unchanged.revision).toBe(saved.revision);
    expect((await getEditHistoryInfo(root, saved.id)).pastCount).toBe(1);
    await expect(saveEditProject(root, project, project.revision)).rejects.toThrow("其他窗口更新");
    expect((await getEditProject(root, project.id)).revision).toBe(2);
    expect((await getEditHistoryInfo(root, project.id)).canUndo).toBe(true);
    const undone = await undoEditProject(root, project.id, saved.revision);
    expect(undone.revision).toBe(3);
    expect((await getEditHistoryInfo(root, project.id)).canRedo).toBe(true);
    const redone = await redoEditProject(root, project.id, undone.revision);
    expect(redone.revision).toBe(4);
    expect(redone.tracks[0]?.clips[0]?.durationFrames).toBe(saved.tracks[0]?.clips[0]?.durationFrames);
  });

  it("同一工程并发保存只允许一个修订提交，旧修订不能撤销或导出", async () => {
    const root = await fixture();
    const created = await createEditProject(root, { name: "原子修订测试", episode: 1, width: 320, height: 320, fps: 23.976 });
    expect(created.fps).toBe(23.976);
    expect(created.timebase).toEqual({ rateNumerator: 24_000, rateDenominator: 1_001 });
    const first = structuredClone(created);
    const second = structuredClone(created);
    first.name = "并发提交 A";
    second.name = "并发提交 B";
    const settled = await Promise.allSettled([
      saveEditProject(root, first, created.revision, "codex"),
      saveEditProject(root, second, created.revision, "codex"),
    ]);
    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(settled.filter((result) => result.status === "rejected")).toHaveLength(1);
    const current = await getEditProject(root, created.id);
    expect(current.revision).toBe(created.revision + 1);
    expect(["并发提交 A", "并发提交 B"]).toContain(current.name);
    expect((await getEditHistoryInfo(root, created.id)).pastCount).toBe(1);
    await expect(undoEditProject(root, created.id, created.revision)).rejects.toThrow("其他窗口更新");
    await expect(exportEditProjectOtio(root, created.id, created.revision)).rejects.toThrow("其他窗口更新");
  });

  it("Codex 可用原子操作编辑轨道与片段，并拒绝旧修订覆盖", async () => {
    const root = await fixture();
    const media = (await listEditMedia(root, 1)).find((item) => item.kind === "video")!;
    const created = await createEditProject(root, { name: "命令编辑", episode: 1, width: 320, height: 320, fps: 23.976, autoPopulate: false });
    const mainTrack = created.tracks.find((track) => track.kind === "visual")!;
    await expect(applyEditOperation(root, created.id, created.revision, {
      type: "add_media_clip",
      trackId: mainTrack.id,
      mediaId: media.id,
      startSeconds: MAX_EDIT_TIMELINE_SECONDS + 1,
    })).rejects.toThrow(/有界时间线/u);
    expect((await getEditProject(root, created.id)).revision).toBe(created.revision);
    const added = await applyEditOperation(root, created.id, created.revision, { type: "add_media_clip", trackId: mainTrack.id, mediaId: media.id, startSeconds: 0 });
    expect(added.project.revision).toBe(2);
    const clipId = added.affectedClipIds[0]!;
    const shortened = await applyEditOperation(root, created.id, 2, { type: "update_clip", clipId, patch: { durationSeconds: .8, filter: "warm", filterIntensity: .4 } });
    const split = await applyEditOperation(root, created.id, shortened.project.revision, { type: "split_clip", clipId, timeSeconds: .4 });
    expect(split.project.tracks.find((track) => track.id === mainTrack.id)?.clips).toHaveLength(2);
    expect(split.affectedClipIds).toHaveLength(2);
    expect(split.project.tracks.find((track) => track.id === mainTrack.id)?.clips.map((clip) => ({ startFrame: clip.startFrame, durationFrames: clip.durationFrames, startSeconds: clip.startSeconds }))).toEqual([
      { startFrame: 0, durationFrames: 10, startSeconds: 0 },
      { startFrame: 10, durationFrames: 9, startSeconds: .417 },
    ]);
    const secondClipId = split.affectedClipIds.find((id) => id !== clipId)!;
    const trimmed = await applyEditOperation(root, created.id, split.project.revision, { type: "trim_to_playhead", clipId: secondClipId, timeSeconds: .6, side: "start" });
    const ripple = await applyEditOperation(root, created.id, trimmed.project.revision, { type: "ripple_delete", clipId, allUnlockedTracks: true });
    expect(ripple.project.tracks.find((track) => track.id === mainTrack.id)?.clips[0]?.startFrame).toBe(4);
    await expect(applyEditOperation(root, created.id, 2, { type: "remove_clip", clipId })).rejects.toThrow("其他窗口更新");
  });

  it("自定义曲线随 CAS 与撤销重做持久化，并在任意整数帧无损分割或裁切", async () => {
    const root = await fixture();
    const media = (await listEditMedia(root, 1)).find((item) => item.kind === "video")!;
    const project = await createEditProject(root, { name: "曲线修订测试", episode: 1, width: 320, height: 320, fps: 24 });
    const trackId = "track-curve-cas";
    project.tracks.splice(1, 0, {
      id: trackId,
      kind: "visual",
      name: "曲线覆盖层",
      order: 1,
      locked: false,
      muted: false,
      hidden: false,
      clips: [{
        id: "clip-curve-cas",
        trackId,
        kind: "video",
        name: "曲线 CAS",
        sourcePath: media.path,
        artifactId: media.artifactId,
        itemId: media.itemId,
        startSeconds: 0,
        durationSeconds: 1,
        trimStartSeconds: 0,
        playbackRate: 1,
        volume: 0,
        opacity: 1,
        muted: true,
        positionX: -80,
        positionY: 0,
        scale: .25,
        rotation: 0,
        keyframes: [
          { id: "curve-start", timeSeconds: 0, easing: "hold", positionX: -80, positionY: 0, scale: .25, rotation: 0 },
          { id: "curve-middle", timeSeconds: .5, easing: "cubic_bezier", bezier: { x1: .25, y1: .1, x2: .25, y2: 1 }, positionX: 0, positionY: 20, scale: .4, rotation: 5 },
          { id: "curve-end", timeSeconds: 1, easing: "linear", positionX: 80, positionY: 0, scale: .25, rotation: 0 },
        ],
      }],
    });
    const saved = await saveEditProject(root, project, project.revision);
    const changedKeyframes = structuredClone(saved.tracks.find((track) => track.id === trackId)!.clips[0]!.keyframes!);
    changedKeyframes[1]!.bezier = { x1: 1, y1: 0, x2: 0, y2: 1 };
    const changed = await applyEditOperation(root, saved.id, saved.revision, { type: "update_clip", clipId: "clip-curve-cas", patch: { keyframes: changedKeyframes } });
    expect(changed.project.tracks.find((track) => track.id === trackId)!.clips[0]!.keyframes![1]!.bezier).toEqual({ x1: 1, y1: 0, x2: 0, y2: 1 });
    await expect(applyEditOperation(root, saved.id, saved.revision, { type: "update_clip", clipId: "clip-curve-cas", patch: { keyframes: changedKeyframes } })).rejects.toThrow("其他窗口更新");
    const undone = await undoEditProject(root, saved.id, changed.project.revision);
    expect(undone.tracks.find((track) => track.id === trackId)!.clips[0]!.keyframes![1]!.bezier).toEqual({ x1: .25, y1: .1, x2: .25, y2: 1 });
    const redone = await redoEditProject(root, saved.id, undone.revision);
    expect(redone.tracks.find((track) => track.id === trackId)!.clips[0]!.keyframes![1]!.bezier).toEqual({ x1: 1, y1: 0, x2: 0, y2: 1 });

    const invalid = structuredClone(redone);
    delete invalid.tracks.find((track) => track.id === trackId)!.clips[0]!.keyframes![1]!.bezier;
    await expect(saveEditProject(root, invalid, redone.revision)).rejects.toThrow("必须提供四个控制点");
    const duplicate = structuredClone(redone);
    duplicate.tracks.find((track) => track.id === trackId)!.clips[0]!.keyframes!.push({ ...structuredClone(duplicate.tracks.find((track) => track.id === trackId)!.clips[0]!.keyframes![1]!), id: "curve-duplicate-frame" });
    await expect(saveEditProject(root, duplicate, redone.revision)).rejects.toThrow("同一帧");
    const tooMany = structuredClone(redone);
    tooMany.tracks.find((track) => track.id === trackId)!.clips[0]!.keyframes = Array.from({ length: 201 }, (_, index) => ({ id: `curve-limit-${index}`, timeSeconds: index / 200, easing: "linear" as const, positionX: 0, positionY: 0, scale: 1, rotation: 0 }));
    await expect(saveEditProject(root, tooMany, redone.revision)).rejects.toThrow("不能超过 200 个");
    const originalClip = structuredClone(redone.tracks.find((track) => track.id === trackId)!.clips[0]!);
    const originalFrames = Array.from({ length: 25 }, (_, frame) => evaluateEditTransformAtFrame(originalClip, frame, 24));
    const split = await applyEditOperation(root, saved.id, redone.revision, { type: "split_clip", clipId: "clip-curve-cas", timeSeconds: .25 });
    expect(split.affectedClipIds).toHaveLength(2);
    const splitClips = split.project.tracks.find((track) => track.id === trackId)!.clips.slice().sort((left, right) => left.startFrame! - right.startFrame!);
    expect(splitClips.map((clip) => ({ startFrame: clip.startFrame, durationFrames: clip.durationFrames }))).toEqual([{ startFrame: 0, durationFrames: 6 }, { startFrame: 6, durationFrames: 18 }]);
    const firstSegmentSourceTransform = {
      start: { positionX: -80, positionY: 0, scale: .25, rotation: 0 },
      end: { positionX: 0, positionY: 20, scale: .4, rotation: 5 },
    };
    expect(splitClips[0]!.keyframes?.at(-1)).toEqual(expect.objectContaining({ sourceTransform: firstSegmentSourceTransform, bezier: expect.objectContaining({ mode: "derived_monotone", sourceWindow: expect.objectContaining({ sourceEasing: "cubic_bezier", startFrame: 0, endFrame: 6, totalFrames: 12 }) }) }));
    expect(splitClips[1]!.keyframes?.[0]).toEqual(expect.objectContaining({ sourceTransform: firstSegmentSourceTransform, bezier: expect.objectContaining({ mode: "derived_monotone", sourceWindow: expect.objectContaining({ sourceEasing: "cubic_bezier", startFrame: 6, endFrame: 12, totalFrames: 12 }) }) }));
    const originalKeyframeIds = new Set(originalClip.keyframes!.map((keyframe) => keyframe.id));
    expect(splitClips[1]!.keyframes?.every((keyframe) => !originalKeyframeIds.has(keyframe.id))).toBe(true);
    for (let frame = 0; frame <= 24; frame += 1) {
      const clip = frame < 6 ? splitClips[0]! : splitClips[1]!;
      expectTransformClose(evaluateEditTransformAtFrame(clip, frame < 6 ? frame : frame - 6, 24), originalFrames[frame]!);
    }
    const splitOtio = await exportEditProjectOtio(root, split.project.id, split.project.revision);
    const splitDocument = await readJson<Record<string, any>>(splitOtio.path, {});
    expect(splitDocument.metadata?.aicanvas?.keyframeCurveContract).toBe("aicanvas.cubic-bezier.v2");
    const importedSplit = await importEditProjectOtio(root, splitOtio.path, "分段 OTIO 回读");
    expect(importedSplit.tracks.flatMap((track) => track.clips).flatMap((clip) => clip.keyframes ?? []).some((keyframe) => keyframe.bezier?.mode === "derived_monotone")).toBe(true);
    expect(importedSplit.tracks.flatMap((track) => track.clips).flatMap((clip) => clip.keyframes ?? []).some((keyframe) => keyframe.sourceTransform?.start.positionX === -80 && keyframe.sourceTransform.end.positionX === 0)).toBe(true);
    const tamperedSourceTransform = structuredClone(split.project);
    tamperedSourceTransform.tracks.find((track) => track.id === trackId)!.clips[1]!.keyframes![0]!.sourceTransform!.start.positionX += 1;
    await expect(saveEditProject(root, tamperedSourceTransform, split.project.revision)).rejects.toThrow("sourceTransform 与当前片段边界不一致");
    const forgedLegacyDerivedPath = path.join(root, "forged-v1-derived.otio");
    splitDocument.metadata.aicanvas.keyframeCurveContract = "aicanvas.cubic-bezier.v1";
    await writeFile(forgedLegacyDerivedPath, `${JSON.stringify(splitDocument)}\n`, "utf8");
    await expect(importEditProjectOtio(root, forgedLegacyDerivedPath, "禁止旧合同派生曲线")).rejects.toThrow("不能承载 derived_monotone");

    const undoneSplit = await undoEditProject(root, split.project.id, split.project.revision);
    const redoneSplit = await redoEditProject(root, split.project.id, undoneSplit.revision);
    expect(redoneSplit.tracks.find((track) => track.id === trackId)!.clips).toEqual(splitClips);
    const originalAgain = await undoEditProject(root, split.project.id, redoneSplit.revision);

    const trimmedStart = await applyEditOperation(root, split.project.id, originalAgain.revision, { type: "trim_to_playhead", clipId: "clip-curve-cas", timeSeconds: .25, side: "start" });
    const rightOnly = trimmedStart.project.tracks.find((track) => track.id === trackId)!.clips[0]!;
    expect(rightOnly).toMatchObject({ startFrame: 6, durationFrames: 18 });
    expect(rightOnly.keyframes?.[0]).toEqual(expect.objectContaining({ sourceTransform: firstSegmentSourceTransform, bezier: expect.objectContaining({ mode: "derived_monotone", sourceWindow: expect.objectContaining({ sourceEasing: "cubic_bezier", startFrame: 6, endFrame: 12, totalFrames: 12 }) }) }));
    expect(rightOnly.keyframes?.map((keyframe) => keyframe.id)).toEqual(["curve-middle", "curve-end"]);
    for (let frame = 6; frame <= 24; frame += 1) expectTransformClose(evaluateEditTransformAtFrame(rightOnly, frame - 6, 24), originalFrames[frame]!);

    const beforeTrimEnd = await undoEditProject(root, split.project.id, trimmedStart.project.revision);
    const trimmedEnd = await applyEditOperation(root, split.project.id, beforeTrimEnd.revision, { type: "trim_to_playhead", clipId: "clip-curve-cas", timeSeconds: .25, side: "end" });
    const leftOnly = trimmedEnd.project.tracks.find((track) => track.id === trackId)!.clips[0]!;
    expect(leftOnly).toMatchObject({ startFrame: 0, durationFrames: 6 });
    expect(leftOnly.keyframes?.at(-1)).toEqual(expect.objectContaining({ sourceTransform: firstSegmentSourceTransform, bezier: expect.objectContaining({ mode: "derived_monotone", sourceWindow: expect.objectContaining({ sourceEasing: "cubic_bezier", startFrame: 0, endFrame: 6, totalFrames: 12 }) }) }));
    for (let frame = 0; frame <= 6; frame += 1) expectTransformClose(evaluateEditTransformAtFrame(leftOnly, frame, 24), originalFrames[frame]!);

    const beforeExactSplit = await undoEditProject(root, split.project.id, trimmedEnd.project.revision);
    const exactSplit = await applyEditOperation(root, split.project.id, beforeExactSplit.revision, { type: "split_clip", clipId: "clip-curve-cas", timeSeconds: .5 });
    const exactClips = exactSplit.project.tracks.find((track) => track.id === trackId)!.clips.slice().sort((left, right) => left.startFrame! - right.startFrame!);
    expect(exactClips[1]!.keyframes?.every((keyframe) => keyframe.frame! > 0)).toBe(true);
    expect(exactClips[1]).toMatchObject({ positionX: 0, positionY: 20, scale: .4, rotation: 5 });
    for (let frame = 0; frame <= 24; frame += 1) {
      const clip = frame < 12 ? exactClips[0]! : exactClips[1]!;
      expectTransformClose(evaluateEditTransformAtFrame(clip, frame < 12 ? frame : frame - 12, 24), originalFrames[frame]!);
    }
  });

  it("主画面复用同一 transform 关键帧、任意分段与 OTIO 合同，并拒绝非视觉关键帧", async () => {
    const root = await fixture();
    const media = (await listEditMedia(root, 1)).find((item) => item.kind === "video")!;
    const frameRate = 24_000 / 1_001;
    const durationFrames = 24;
    const durationSeconds = Math.round(durationFrames / frameRate * 1_000) / 1_000;
    const project = await createEditProject(root, { name: "主画面关键帧合同", episode: 1, width: 320, height: 320, fps: 23.976, autoPopulate: false });
    const mainTrack = project.tracks.find((track) => track.kind === "visual")!;
    mainTrack.clips.push({
      id: "clip-main-keyframes", trackId: mainTrack.id, kind: "video", name: "主画面动画", sourcePath: media.path,
      startSeconds: 0, durationSeconds, trimStartSeconds: 0, playbackRate: 1, volume: 0, opacity: .9, muted: false,
      positionX: -90, positionY: -40, scale: .35, rotation: -12, filter: "none", filterIntensity: 1,
      keyframes: [
        { id: "main-kf-start", frame: 0, timeSeconds: 0, easing: "hold", positionX: -90, positionY: -40, scale: .35, rotation: -12 },
        { id: "main-kf-end", frame: durationFrames, timeSeconds: durationSeconds, easing: "cubic_bezier", bezier: { x1: 1, y1: 0, x2: 0, y2: 1 }, positionX: 90, positionY: 40, scale: .7, rotation: 12 },
      ],
    });

    const nonVisual = structuredClone(project);
    nonVisual.tracks.find((track) => track.kind === "audio")!.clips.push({
      id: "clip-audio-with-transform", trackId: nonVisual.tracks.find((track) => track.kind === "audio")!.id, kind: "audio", name: "非法音频关键帧", sourcePath: media.path,
      startSeconds: 0, durationSeconds, trimStartSeconds: 0, playbackRate: 1, volume: 1, opacity: 1, muted: false,
      keyframes: [{ id: "audio-kf", frame: 0, timeSeconds: 0, easing: "linear", positionX: 0, positionY: 0, scale: 1, rotation: 0 }],
    });
    await expect(saveEditProject(root, nonVisual, project.revision)).rejects.toThrow("关键帧只支持视觉片段");
    const invalidStatic = structuredClone(project);
    invalidStatic.tracks.find((track) => track.id === mainTrack.id)!.clips[0]!.positionX = Number.NaN;
    await expect(saveEditProject(root, invalidStatic, project.revision)).rejects.toThrow("画面位置必须是有效数字");

    const saved = await saveEditProject(root, project, project.revision);
    const savedMain = saved.tracks.find((track) => track.id === mainTrack.id)!.clips[0]!;
    expect(savedMain.keyframes).toHaveLength(2);
    expect(savedMain).toMatchObject({ positionX: -90, positionY: -40, scale: .35, rotation: -12, opacity: .9 });
    const continuation = await prepareTimelineVideoContinuation(root, {
      editProjectId: saved.id,
      targetItemId: "main-ep01-unit002",
      expectedRevision: saved.revision,
      timeSeconds: 12 / frameRate,
      enqueue: false,
    });
    expect(continuation.pack).toMatchObject({
      sourceType: "timeline",
      sourceVideoPath: savedMain.sourcePath,
      editProjectId: saved.id,
      editProjectRevision: saved.revision,
    });
    expect(continuation.extraction).toMatchObject({ width: 320, height: 320, registeredVariant: "start" });
    expect(continuation.extraction.sourceClipIds).toContain(savedMain.id);
    await expect(access(continuation.extraction.framePath)).resolves.toBeUndefined();
    const unitOtio = await exportEditProjectOtio(root, saved.id, saved.revision);
    expect((await readJson<Record<string, any>>(unitOtio.path, {})).metadata?.aicanvas?.keyframeCurveContract).toBe("aicanvas.cubic-bezier.v1");

    const originalFrames = Array.from({ length: durationFrames + 1 }, (_, frame) => evaluateEditTransformAtFrame(savedMain, frame, frameRate));
    const splitFrame = 7;
    const split = await applyEditOperation(root, saved.id, saved.revision, { type: "split_clip", clipId: savedMain.id, timeSeconds: splitFrame / frameRate });
    const splitClips = split.project.tracks.find((track) => track.id === mainTrack.id)!.clips.slice().sort((left, right) => left.startFrame! - right.startFrame!);
    expect(splitClips.map((clip) => ({ startFrame: clip.startFrame, durationFrames: clip.durationFrames }))).toEqual([{ startFrame: 0, durationFrames: 7 }, { startFrame: 7, durationFrames: 17 }]);
    expect(splitClips[0]!.keyframes?.at(-1)?.bezier?.mode).toBe("derived_monotone");
    expect(splitClips[1]!.keyframes?.[0]?.sourceTransform).toEqual({
      start: { positionX: -90, positionY: -40, scale: .35, rotation: -12 },
      end: { positionX: 90, positionY: 40, scale: .7, rotation: 12 },
    });
    for (let frame = 0; frame <= durationFrames; frame += 1) {
      const clip = frame < splitFrame ? splitClips[0]! : splitClips[1]!;
      expectTransformClose(evaluateEditTransformAtFrame(clip, frame < splitFrame ? frame : frame - splitFrame, frameRate), originalFrames[frame]!);
    }
    const splitOtio = await exportEditProjectOtio(root, split.project.id, split.project.revision);
    const splitDocument = await readJson<Record<string, any>>(splitOtio.path, {});
    expect(splitDocument.metadata?.aicanvas?.keyframeCurveContract).toBe("aicanvas.cubic-bezier.v2");
    const imported = await importEditProjectOtio(root, splitOtio.path, "主画面派生曲线回读");
    const importedMain = imported.tracks.filter((track) => track.kind === "visual").sort((left, right) => left.order - right.order)[0]!;
    expect(importedMain.clips).toHaveLength(2);
    expect(importedMain.clips.flatMap((clip) => clip.keyframes ?? []).some((keyframe) => keyframe.bezier?.mode === "derived_monotone")).toBe(true);
  });

  it("任意分段保持 hold 目标帧跳变，并把末关键帧后的尾段作为静态基值", async () => {
    const root = await fixture();
    const media = (await listEditMedia(root, 1)).find((item) => item.kind === "video")!;
    const project = await createEditProject(root, { name: "hold 与常量尾段", episode: 1, width: 320, height: 320, fps: 24 });
    const trackId = "track-hold-subdivision";
    project.tracks.splice(1, 0, {
      id: trackId, kind: "visual", name: "hold 覆盖层", order: 1, locked: false, muted: false, hidden: false,
      clips: [{
        id: "clip-hold-subdivision", trackId, kind: "video", name: "hold 分段", sourcePath: media.path,
        startSeconds: 0, durationSeconds: 1, trimStartSeconds: 0, playbackRate: 1, volume: 0, opacity: 1, muted: true,
        positionX: -60, positionY: 0, scale: .25, rotation: 0,
        keyframes: [
          { id: "hold-start", frame: 0, timeSeconds: 0, easing: "linear", positionX: -60, positionY: 0, scale: .25, rotation: 0 },
          { id: "hold-target", frame: 12, timeSeconds: .5, easing: "hold", positionX: 60, positionY: 20, scale: .5, rotation: 10 },
        ],
      }],
    });
    const saved = await saveEditProject(root, project, project.revision);
    const original = saved.tracks.find((track) => track.id === trackId)!.clips[0]!;
    const originalFrames = Array.from({ length: 25 }, (_, frame) => evaluateEditTransformAtFrame(original, frame, 24));
    const insideHold = await applyEditOperation(root, saved.id, saved.revision, { type: "split_clip", clipId: original.id, timeSeconds: .25 });
    const holdClips = insideHold.project.tracks.find((track) => track.id === trackId)!.clips.slice().sort((left, right) => left.startFrame! - right.startFrame!);
    expect(holdClips[0]!.keyframes?.at(-1)).toEqual(expect.objectContaining({ frame: 6, easing: "linear", positionX: -60 }));
    expect(holdClips[1]!.keyframes?.[0]).toEqual(expect.objectContaining({ frame: 6, easing: "hold", positionX: 60 }));
    for (let frame = 0; frame <= 24; frame += 1) {
      const clip = frame < 6 ? holdClips[0]! : holdClips[1]!;
      expectTransformClose(evaluateEditTransformAtFrame(clip, frame < 6 ? frame : frame - 6, 24), originalFrames[frame]!);
    }

    const restored = await undoEditProject(root, saved.id, insideHold.project.revision);
    const inConstantTail = await applyEditOperation(root, saved.id, restored.revision, { type: "split_clip", clipId: original.id, timeSeconds: .75 });
    const tailClips = inConstantTail.project.tracks.find((track) => track.id === trackId)!.clips.slice().sort((left, right) => left.startFrame! - right.startFrame!);
    expect(tailClips[0]!.keyframes?.map((keyframe) => keyframe.frame)).toEqual([0, 12]);
    expect(tailClips[1]!.keyframes).toEqual([]);
    expect(tailClips[1]).toMatchObject({ positionX: 60, positionY: 20, scale: .5, rotation: 10 });
    for (let frame = 0; frame <= 24; frame += 1) {
      const clip = frame < 18 ? tailClips[0]! : tailClips[1]!;
      expectTransformClose(evaluateEditTransformAtFrame(clip, frame < 18 ? frame : frame - 18, 24), originalFrames[frame]!);
    }
  });

  it("FFmpeg 将连续主画面导出为新 MP4 并保留可审计记录", async () => {
    const root = await fixture();
    const engine = await probeVideoEngine();
    expect(engine.available).toBe(true);
    expect(engine.ffmpegPath).toBeTruthy();
    const previewMedia = await listEditMedia(root, 1);
    const videoPreview = await prepareEditMediaPreview(root, previewMedia.find((item) => item.kind === "video")!.artifactId);
    expect(videoPreview.filmstripPath).toBeTruthy();
    await expect(access(videoPreview.filmstripPath!)).resolves.toBeUndefined();
    const videoProxy = await prepareEditMediaProxy(root, previewMedia.find((item) => item.kind === "video")!.artifactId);
    expect(videoProxy.proxyPath).toContain(path.join(".aicanvas", "editor", "proxies"));
    await expect(access(videoProxy.proxyPath!)).resolves.toBeUndefined();
    expect((await listEditMedia(root, 1)).find((item) => item.artifactId === videoProxy.artifactId)?.proxyPath).toBe(videoProxy.proxyPath);
    const audioPreview = await prepareEditMediaPreview(root, previewMedia.find((item) => item.kind === "audio")!.artifactId);
    expect(audioPreview.waveformPath).toBeTruthy();
    await expect(access(audioPreview.waveformPath!)).resolves.toBeUndefined();
    const project = await createEditProject(root, { name: "EP01 导出验证", episode: 1, width: 320, height: 320, fps: 24 });
    project.tracks[0]!.clips.forEach((clip, index) => {
      clip.startSeconds = index * 0.35;
      clip.durationSeconds = 0.35;
    });
    project.tracks[0]!.clips[0]!.transitionOut = "fade";
    project.tracks[0]!.clips[0]!.transitionDurationSeconds = 0.15;
    const overlaySource = (await listEditMedia(root, 1)).find((item) => item.kind === "video")!;
    const overlayTrackId = "track-overlay-test";
    project.tracks.splice(1, 0, {
      id: overlayTrackId,
      kind: "visual",
      name: "画中画",
      order: 1,
      locked: false,
      muted: false,
      hidden: false,
      clips: [{
        id: "clip-overlay-test",
        trackId: overlayTrackId,
        kind: "video",
        name: "关键帧画中画",
        sourcePath: overlaySource.path,
        artifactId: overlaySource.artifactId,
        itemId: overlaySource.itemId,
        startSeconds: .1,
        durationSeconds: .5,
        trimStartSeconds: 0,
        playbackRate: 1,
        volume: 0,
        opacity: .82,
        muted: false,
        positionX: -60,
        positionY: -50,
        scale: .28,
        rotation: -5,
        filter: "vivid",
        filterIntensity: .5,
        keyframes: [
          { id: "kf-overlay-start", timeSeconds: 0, easing: "hold", positionX: -60, positionY: -50, scale: .28, rotation: -5 },
          { id: "kf-overlay-end", timeSeconds: .5, easing: "cubic_bezier", bezier: { x1: .25, y1: .1, x2: .25, y2: 1 }, positionX: 60, positionY: 50, scale: .42, rotation: 5 },
        ],
      }],
    });
    const audio = (await listEditMedia(root, 1)).find((item) => item.kind === "audio")!;
    const audioTrack = project.tracks.find((track) => track.kind === "audio")!;
    audioTrack.clips.push({
      id: "clip-audio-test",
      trackId: audioTrack.id,
      kind: "audio",
      name: "测试配乐",
      sourcePath: audio.path,
      artifactId: audio.artifactId,
      itemId: audio.itemId,
      startSeconds: 0,
      durationSeconds: 0.7,
      trimStartSeconds: 0,
      playbackRate: 1,
      volume: 0.5,
      opacity: 1,
      muted: false,
      fadeInSeconds: 0.1,
      fadeOutSeconds: 0.1,
    });
    const subtitleTrack = project.tracks.find((track) => track.kind === "subtitle")!;
    subtitleTrack.clips.push({
      id: "clip-subtitle-test",
      trackId: subtitleTrack.id,
      kind: "subtitle",
      name: "测试字幕",
      startSeconds: 0,
      durationSeconds: 0.7,
      trimStartSeconds: 0,
      playbackRate: 1,
      volume: 1,
      opacity: 1,
      muted: false,
      text: "黄金面具必须保持完整",
      fontSize: 28,
      fontColor: "#ffffff",
      subtitleBackground: "#000000",
    });
    const saved = await saveEditProject(root, project, project.revision);
    const savedCurve = saved.tracks.flatMap((track) => track.clips).find((clip) => clip.id === "clip-overlay-test")?.keyframes?.at(-1);
    expect(savedCurve).toMatchObject({ easing: "cubic_bezier", bezier: { x1: .25, y1: .1, x2: .25, y2: 1 } });
    const otio = await exportEditProjectOtio(root, saved.id, saved.revision);
    await expect(access(otio.path)).resolves.toBeUndefined();
    const otioDocument = await readJson<Record<string, any>>(otio.path, {});
    expect(otioDocument.metadata?.aicanvas).toMatchObject({ keyframeCurveContract: "aicanvas.cubic-bezier.v1", curvePortability: "aicanvas-private-metadata" });
    const imported = await importEditProjectOtio(root, otio.path, "OTIO 回读验证");
    expect(imported.name).toBe("OTIO 回读验证");
    expect(imported.tracks.filter((track) => track.kind === "visual")).toHaveLength(2);
    expect(imported.tracks.flatMap((track) => track.clips).every((clip) => Number.isInteger(clip.startFrame) && Number.isInteger(clip.durationFrames))).toBe(true);
    expect(imported.tracks.flatMap((track) => track.clips).find((clip) => clip.name === "关键帧画中画")?.keyframes?.at(-1)).toMatchObject({ easing: "cubic_bezier", bezier: { x1: .25, y1: .1, x2: .25, y2: 1 } });
    const compositeFrame = await extractTimelineFrame(root, { editProjectId: saved.id, expectedRevision: saved.revision, timeSeconds: .3 });
    expect(compositeFrame.width).toBe(320);
    expect(compositeFrame.height).toBe(320);
    expect(compositeFrame.sourceClipIds).toContain("clip-overlay-test");
    await expect(access(compositeFrame.framePath)).resolves.toBeUndefined();
    expect((await listTimelineFrameExtractions(root, saved.id))[0]?.id).toBe(compositeFrame.id);
    await expect(prepareTimelineVideoContinuation(root, { editProjectId: saved.id, targetItemId: "main-ep01-unit002", expectedRevision: saved.revision - 1, enqueue: false })).rejects.toThrow("修订已变化");
    const continuationCommand = { requestId: "request-timeline-continuation-001", idempotencyKey: "timeline-continuation-edit-unit002-r1", request: { command: "prepare_timeline_continuation" as const, payload: { editProjectId: saved.id, targetItemId: "main-ep01-unit002", expectedRevision: saved.revision, enqueue: true } } };
    const commandResult = await executeIdempotentCommand(root, continuationCommand);
    const preparedContinuation = commandResult.result as Awaited<ReturnType<typeof prepareTimelineVideoContinuation>>;
    const replayedContinuation = await executeIdempotentCommand(root, { ...continuationCommand, requestId: "request-timeline-continuation-002" });
    expect(replayedContinuation.replayed).toBe(true);
    expect(preparedContinuation.extraction.registeredVariant).toBe("start");
    expect(preparedContinuation.extraction.registeredArtifactId).toBeTruthy();
    expect(preparedContinuation.pack.sourceType).toBe("timeline");
    expect(preparedContinuation.pack.editProjectRevision).toBe(saved.revision);
    expect(preparedContinuation.pack.targetFirstFrameArtifactId).toBe(preparedContinuation.extraction.registeredArtifactId);
    expect(preparedContinuation.generationJob?.purpose).toBe("timeline_continuation");
    expect(preparedContinuation.generationJob?.parameters?.mode).toBe("first_frame");
    expect(preparedContinuation.generationJob?.references?.find((reference) => reference.role === "first_frame")?.artifactId).toBe(preparedContinuation.extraction.registeredArtifactId);
    expect((await listGenerationJobs(root)).filter((entry) => entry.continuationId === preparedContinuation.pack.id)).toHaveLength(1);
    const directRetry = await prepareTimelineVideoContinuation(root, { editProjectId: saved.id, targetItemId: "main-ep01-unit002", expectedRevision: saved.revision, enqueue: true });
    expect(directRetry.extraction.id).toBe(preparedContinuation.extraction.id);
    expect(directRetry.pack.id).toBe(preparedContinuation.pack.id);
    expect(directRetry.generationJob?.id).toBe(preparedContinuation.generationJob?.id);
    expect((await listGenerationJobs(root)).filter((entry) => entry.continuationId === preparedContinuation.pack.id)).toHaveLength(1);
    expect((await listAssetRelations(root, { artifactId: preparedContinuation.extraction.registeredArtifactId }))[0]?.kind).toBe("derived_from");
    expect((await listVideoContinuationPacks(root, "main-ep01-unit002")).filter((pack) => pack.sourceType === "timeline")).toHaveLength(1);
    await copyFile(saved.tracks[0]!.clips[0]!.sourcePath!, preparedContinuation.generationJob!.expectedOutputPath);
    await processGenerationQueue(root);
    await processGenerationQueue(root);
    const synchronizedPack = (await listVideoContinuationPacks(root, "main-ep01-unit002")).find((pack) => pack.id === preparedContinuation.pack.id)!;
    expect(synchronizedPack.status).toBe("completed");
    expect(synchronizedPack.outputVideoPath).toBe(preparedContinuation.generationJob!.expectedOutputPath);
    expect(synchronizedPack.generationStatus).toBe("succeeded");
    await expect(updateVideoContinuationPack(root, synchronizedPack.id, { expectedRevision: synchronizedPack.revision, status: "cancelled", error: "不应允许绕过 GenerationJob。" })).rejects.toThrow("状态只能由 GenerationJob 投影");
    const job = await renderEditProject(root, saved.id, { expectedRevision: saved.revision });
    expect(job.status).toBe("succeeded");
    expect(job.publicationIntentId).toMatch(/^publication-/);
    expect(job.publicationReceiptId).toMatch(/^receipt-/);
    await expect(access(job.outputPath)).resolves.toBeUndefined();
    await expect(access(job.commandPath!)).resolves.toBeUndefined();
    await expect(access(job.logPath)).resolves.toBeUndefined();
    expect((await stat(job.outputPath)).size).toBeGreaterThan(1_000);
    const { stdout } = await execFileAsync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type", "-of", "json", job.outputPath]);
    const probe = JSON.parse(stdout) as { streams?: Array<{ codec_type?: string }> };
    expect(probe.streams?.map((stream) => stream.codec_type).sort()).toEqual(["audio", "video"]);
    expect((await listEditRenderJobs(root))[0]?.id).toBe(job.id);

    const background = await startEditRender(root, saved.id, { expectedRevision: saved.revision });
    expect(background.status).toBe("running");
    expect(background.pid).toBeGreaterThan(0);
    const backgroundDone = await waitForEditRender(root, background.id);
    expect(backgroundDone.status).toBe("succeeded");
    expect(backgroundDone.progress).toBe(1);
    expect(backgroundDone.publicationReceiptId).toMatch(/^receipt-/);
    await expect(access(backgroundDone.outputPath)).resolves.toBeUndefined();
    const renderReceipts = (await listPublicationReceipts(root)).filter((receipt) => receipt.context.purpose === "edit-render");
    expect(renderReceipts.map((receipt) => receipt.targetPath)).toEqual(expect.arrayContaining([job.outputPath, backgroundDone.outputPath]));

    const frame = await extractLastFrame(root, { itemId: "main-ep01-unit001", videoPath: job.outputPath });
    expect(frame.width).toBe(320);
    expect(frame.height).toBe(320);
    await expect(access(frame.framePath)).resolves.toBeUndefined();
    const continuation = await createVideoContinuationPack(root, { itemId: frame.itemId, sourceVideoPath: job.outputPath, lastFramePath: frame.framePath });
    expect(continuation.prompt).toContain("最后一帧");
    expect(continuation.referencePaths[0]).toBe(frame.framePath);
    expect(continuation.revision).toBe(1);
    expect((await listVideoContinuationPacks(root, frame.itemId))[0]?.id).toBe(continuation.id);
    const cancelled = await updateVideoContinuationPack(root, continuation.id, { expectedRevision: continuation.revision, status: "cancelled", error: "用户决定不再提交这个未入队续接包。" });
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.revision).toBe(2);
    expect(cancelled.error).toContain("用户决定");
    expect((await getProjectIndex(root)).items.find((item) => item.id === continuation.itemId)?.status).not.toBe("已完成");
    await expect(updateVideoContinuationPack(root, continuation.id, { expectedRevision: continuation.revision, status: "failed", error: "过期窗口写入。" })).rejects.toThrow("修订冲突");
    await expect(updateVideoContinuationPack(root, continuation.id, { expectedRevision: cancelled.revision, status: "failed", error: "终态覆盖。" })).rejects.toThrow("不能回退或覆盖终态");
  // 全量套件会并行运行两个真实 MCP/FFmpeg 闭环；保留真实编解码覆盖并给高负载机器足够时间完成。
  }, 120_000);

  it("导入 OTIO 时按源 RationalTime.rate 换算且拒绝静默丢弃转场", async () => {
    const root = await fixture();
    const otioPath = path.join(root, "external-rate.otio");
    const sourcePath = (await getProjectIndex(root)).artifacts.find((artifact) => artifact.kind === "video")!.path;
    const clip = { OTIO_SCHEMA: "Clip.2", name: "24fps source", source_range: { OTIO_SCHEMA: "TimeRange.1", start_time: { OTIO_SCHEMA: "RationalTime.1", value: 0, rate: 24 }, duration: { OTIO_SCHEMA: "RationalTime.1", value: 240, rate: 24 } }, media_reference: { OTIO_SCHEMA: "ExternalReference.1", target_url: pathToFileURL(sourcePath).href }, effects: [], markers: [], metadata: {} };
    const document = { OTIO_SCHEMA: "Timeline.1", name: "30fps target", tracks: { OTIO_SCHEMA: "Stack.1", children: [{ OTIO_SCHEMA: "Track.1", name: "V1", kind: "Video", effects: [], metadata: {}, children: [clip] }] }, metadata: { aicanvas: { fps: 30, width: 320, height: 320 } } };
    await writeFile(otioPath, `${JSON.stringify(document)}\n`, "utf8");
    const imported = await importEditProjectOtio(root, otioPath);
    const importedClip = imported.tracks.find((track) => track.kind === "visual")!.clips[0]!;
    expect(importedClip.durationFrames).toBe(300);
    expect(importedClip.durationSeconds).toBe(10);

    const unsupportedPath = path.join(root, "external-transition.otio");
    const unsupported = structuredClone(document);
    (unsupported.tracks.children[0]!.children as unknown[]).push({ OTIO_SCHEMA: "Transition.1" });
    await writeFile(unsupportedPath, `${JSON.stringify(unsupported)}\n`, "utf8");
    const projectsBeforeReject = await listEditProjects(root);
    await expect(importEditProjectOtio(root, unsupportedPath)).rejects.toThrow("只支持 active Transition.1/SMPTE_Dissolve");
    expect(await listEditProjects(root)).toHaveLength(projectsBeforeReject.length);

    const missingCurveContractPath = path.join(root, "external-curve-without-contract.otio");
    const missingCurveContract = structuredClone(document);
    missingCurveContract.tracks.children[0]!.children[0]!.metadata = { aicanvas: { keyframes: [{ id: "foreign-curve", timeSeconds: 1, easing: "cubic_bezier", bezier: { x1: .25, y1: .1, x2: .25, y2: 1 }, positionX: 0, positionY: 0, scale: 1, rotation: 0 }] } };
    await writeFile(missingCurveContractPath, `${JSON.stringify(missingCurveContract)}\n`, "utf8");
    await expect(importEditProjectOtio(root, missingCurveContractPath)).rejects.toThrow("缺少 aicanvas.cubic-bezier.v1");
    expect(await listEditProjects(root)).toHaveLength(projectsBeforeReject.length);

    const unknownCurveContractPath = path.join(root, "external-unknown-curve-contract.otio");
    const unknownCurveContract = structuredClone(document);
    (unknownCurveContract.metadata.aicanvas as Record<string, unknown>).keyframeCurveContract = "foreign.curve.v9";
    await writeFile(unknownCurveContractPath, `${JSON.stringify(unknownCurveContract)}\n`, "utf8");
    await expect(importEditProjectOtio(root, unknownCurveContractPath)).rejects.toThrow("不支持 OTIO 关键帧曲线合同 foreign.curve.v9");
    expect(await listEditProjects(root)).toHaveLength(projectsBeforeReject.length);
  });

  it("重启后会把已不存在的后台渲染进程标记为可重试失败", async () => {
    const root = await fixture();
    const paths = getSidecarPaths(root);
    await writeJsonAtomic(paths.editorRenders, {
      schemaVersion: 1,
      jobs: [{ schemaVersion: 1, id: "render-stale-after-restart", editProjectId: "edit-missing", status: "running", outputPath: path.join(root, "stale.mp4"), progress: 0.4, durationSeconds: 20, pid: 999_999_999, startedAt: new Date().toISOString() }],
    });
    const [recovered] = await listEditRenderJobs(root);
    expect(recovered?.status).toBe("failed");
    expect(recovered?.error).toContain("输出文件未通过 ffprobe");
    expect(recovered?.completedAt).toBeTruthy();
  });

  it("重启时 FFmpeg 已退出但完整成片存在会恢复为成功", async () => {
    const root = await fixture();
    const outputPath = path.join(root, "recovered-complete.mp4");
    await execFileAsync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x320:rate=24", "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", outputPath]);
    await writeJsonAtomic(getSidecarPaths(root).editorRenders, {
      schemaVersion: 1,
      jobs: [{ schemaVersion: 1, id: "render-finished-before-restart", editProjectId: "edit-recovery", status: "running", outputPath, progress: 0.95, durationSeconds: 1, pid: 999_999_998, startedAt: new Date().toISOString() }],
    });
    const [recovered] = await listEditRenderJobs(root);
    expect(recovered?.status).toBe("succeeded");
    expect(recovered?.progress).toBe(1);
    expect(recovered?.error).toBeUndefined();
  });
});
