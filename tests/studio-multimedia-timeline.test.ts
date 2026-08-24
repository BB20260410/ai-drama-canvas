import { constants as fsConstants } from "node:fs";
import { accessSync } from "node:fs";
import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { importStudioMedia } from "../src/core/material-studio.js";
import { MEDIA_WEIGHTS, mediaStageTimeout, runMediaProcess } from "../src/core/media-runtime.js";
import { materializeStudioMediaDerivatives } from "../src/core/studio-media-derivatives.js";
import {
  attachStudioMultimediaTimelineMedia,
  getStudioMultimediaTimelineProjection,
  initializeStudioMultimediaTimeline,
  listStudioMultimediaTimelineBindingHistory,
  StudioMultimediaTimelineConflictError,
} from "../src/core/studio-multimedia-timeline.js";
import { getStudioProductionUnitSnapshot } from "../src/core/studio-production.js";
import { toJsLiteral } from "../src/core/js-code-literal.js";
import {
  commitUnitGridBundle,
  createUnitGridFixtureProject,
  createUnitGridTestImage,
  freezeDispatchPrepareUnitGrid,
  passUnitGridReview,
} from "./helpers/studio-unit-grid-fixture.js";

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];
const originalFfmpeg = process.env.AI_CANVAS_FFMPEG;
const originalFfprobe = process.env.AI_CANVAS_FFPROBE;
const originalRuntime = process.env.AI_CANVAS_MEDIA_RUNTIME_DIR;

function executable(name: "ffmpeg" | "ffprobe"): string | undefined {
  const configured = name === "ffmpeg" ? originalFfmpeg : originalFfprobe;
  const candidates = [
    configured,
    ...(process.env.PATH ?? "").split(path.delimiter).filter(Boolean).map((directory) => path.join(directory, name)),
    `/opt/homebrew/bin/${name}`,
    `/usr/local/bin/${name}`,
    `/usr/bin/${name}`,
  ].filter((value): value is string => Boolean(value));
  for (const candidate of [...new Set(candidates)]) {
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // 继续查找。
    }
  }
  return undefined;
}

const FFMPEG = executable("ffmpeg");
const FFPROBE = executable("ffprobe");

function currentNodeExecutable(): string {
  for (const candidate of [process.execPath, "/usr/local/bin/node", "/Users/hxx/.nvm/versions/node/v22.22.2/bin/node"]) {
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Vitest 的启动 runtime 可能已被升级移除，继续选择真实存在的 Node。
    }
  }
  throw new Error("找不到可执行 Node，无法验证跨进程重启读取。");
}

afterEach(async () => {
  if (originalFfmpeg === undefined) delete process.env.AI_CANVAS_FFMPEG;
  else process.env.AI_CANVAS_FFMPEG = originalFfmpeg;
  if (originalFfprobe === undefined) delete process.env.AI_CANVAS_FFPROBE;
  else process.env.AI_CANVAS_FFPROBE = originalFfprobe;
  if (originalRuntime === undefined) delete process.env.AI_CANVAS_MEDIA_RUNTIME_DIR;
  else process.env.AI_CANVAS_MEDIA_RUNTIME_DIR = originalRuntime;
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function runFixture(outputPath: string, args: string[]): Promise<void> {
  const result = await runMediaProcess(FFMPEG!, [...args, "-y", outputPath], {
    tool: "ffmpeg",
    stage: "studio-multimedia-timeline-fixture",
    weight: MEDIA_WEIGHTS.foreground,
    timeoutMs: mediaStageTimeout("ffmpeg", 60_000),
    maxOutputBytes: 64 * 1_024,
  });
  if (result.status !== "succeeded") throw new Error(result.output || "FFmpeg fixture failed");
}

async function realVideo(target: string): Promise<void> {
  await runFixture(target, [
    "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=12",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100",
    "-t", "1", "-shortest",
    "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "96k",
  ]);
}

async function realAudio(target: string, frequency: number): Promise<void> {
  await runFixture(target, [
    "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", `sine=frequency=${frequency}:sample_rate=44100`,
    "-t", "1", "-c:a", "pcm_s16le",
  ]);
}

function materialCount(root: string): number {
  const database = new DatabaseSync(path.join(root, ".aicanvas", "material-studio.sqlite"), { readOnly: true });
  try {
    return Number((database.prepare("SELECT COUNT(*) AS count FROM studio_media").get() as { count: number }).count);
  } finally {
    database.close();
  }
}

function timelineCounts(root: string): { bindings: number; heads: number } {
  const database = new DatabaseSync(path.join(root, ".aicanvas", "studio-production.sqlite"), { readOnly: true });
  try {
    return {
      bindings: Number((database.prepare("SELECT COUNT(*) AS count FROM studio_multimedia_timeline_bindings").get() as { count: number }).count),
      heads: Number((database.prepare("SELECT COUNT(*) AS count FROM studio_multimedia_timeline_heads").get() as { count: number }).count),
    };
  } finally {
    database.close();
  }
}

describe("受管四媒体时间线关系 owner", () => {
  it.skipIf(!FFMPEG || !FFPROBE)(
    "真实 image/video/audio 只绑定既有 CAS，显式 supersession、正式 raw/labeled、派生物和进程重启投影保持一致",
    async () => {
      const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "studio-multimedia-timeline-")));
      temporaryRoots.push(parent);
      process.env.AI_CANVAS_MEDIA_RUNTIME_DIR = path.join(parent, "media-runtime");
      process.env.AI_CANVAS_FFMPEG = FFMPEG!;
      process.env.AI_CANVAS_FFPROBE = FFPROBE!;
      const fixture = await createUnitGridFixtureProject(parent, {
        unitId: "timeline-unit-001",
        season: "S08",
        episode: "EP02",
      });
      const snapshot = await getStudioProductionUnitSnapshot(fixture.root, fixture.unitId);
      if (!snapshot) throw new Error("missing fixture snapshot");

      const storyboard = await createUnitGridTestImage(fixture.root, "timeline-storyboard-panel-01", "#334b59");
      const videoPath = path.join(fixture.root, "timeline-video.mp4");
      const dialoguePath = path.join(fixture.root, "timeline-dialogue.wav");
      const dialogueReplacementPath = path.join(fixture.root, "timeline-dialogue-replacement.wav");
      const musicPath = path.join(fixture.root, "timeline-music.wav");
      const sfxPath = path.join(fixture.root, "timeline-sfx.wav");
      await realVideo(videoPath);
      await Promise.all([
        realAudio(dialoguePath, 440),
        realAudio(dialogueReplacementPath, 550),
        realAudio(musicPath, 660),
        realAudio(sfxPath, 770),
      ]);
      const [video, dialogue, dialogueReplacement, music, sfx] = await Promise.all([
        importStudioMedia(fixture.root, { sourcePath: videoPath }),
        importStudioMedia(fixture.root, { sourcePath: dialoguePath }),
        importStudioMedia(fixture.root, { sourcePath: dialogueReplacementPath }),
        importStudioMedia(fixture.root, { sourcePath: musicPath }),
        importStudioMedia(fixture.root, { sourcePath: sfxPath }),
      ]);
      await Promise.all([
        materializeStudioMediaDerivatives(fixture.root, { mediaSha256: video.sha256 }),
        materializeStudioMediaDerivatives(fixture.root, { mediaSha256: dialogue.sha256 }),
        materializeStudioMediaDerivatives(fixture.root, { mediaSha256: dialogueReplacement.sha256 }),
        materializeStudioMediaDerivatives(fixture.root, { mediaSha256: music.sha256 }),
        materializeStudioMediaDerivatives(fixture.root, { mediaSha256: sfx.sha256 }),
      ]);

      const formalRun = await freezeDispatchPrepareUnitGrid(
        fixture.root,
        fixture.unitId,
        "timeline-formal-run-001",
      );
      const formalBundle = await commitUnitGridBundle(fixture.root, formalRun, "timeline-formal");
      await passUnitGridReview(fixture.root, formalRun, formalBundle, "timeline-formal-review-pass");
      const mediaCountBeforeBinding = materialCount(fixture.root);

      const init = await initializeStudioMultimediaTimeline(fixture.root);
      expect(init).toMatchObject({ schemaVersion: 1, bindingCount: 0, headCount: 0 });
      const common = {
        unitId: fixture.unitId,
        unitRevision: snapshot.unit.revision,
        expectedUnitFingerprint: snapshot.fingerprint,
      };
      const firstStoryboard = await attachStudioMultimediaTimelineMedia(fixture.root, {
        ...common,
        operationId: "timeline-attach-storyboard-001",
        slotId: "storyboard-panel-01",
        expectedHeadRevision: 0,
        panelIndex: 1,
        startSeconds: 0,
        endSeconds: 7,
        role: "storyboard",
        mediaSha256: storyboard.sha256,
        note: "第一格外部故事板参考。",
      });
      const firstVideo = await attachStudioMultimediaTimelineMedia(fixture.root, {
        ...common,
        operationId: "timeline-attach-video-001",
        slotId: "video-main",
        expectedHeadRevision: 0,
        startSeconds: 0,
        endSeconds: 15,
        role: "video",
        mediaSha256: video.sha256,
      });
      const firstDialogue = await attachStudioMultimediaTimelineMedia(fixture.root, {
        ...common,
        operationId: "timeline-attach-dialogue-001",
        slotId: "dialogue-main",
        expectedHeadRevision: 0,
        panelIndex: 1,
        startSeconds: 0,
        endSeconds: 3,
        role: "dialogue",
        mediaSha256: dialogue.sha256,
      });
      await attachStudioMultimediaTimelineMedia(fixture.root, {
        ...common,
        operationId: "timeline-attach-music-001",
        slotId: "music-main",
        expectedHeadRevision: 0,
        startSeconds: 0,
        endSeconds: 15,
        role: "music",
        mediaSha256: music.sha256,
      });
      await attachStudioMultimediaTimelineMedia(fixture.root, {
        ...common,
        operationId: "timeline-attach-sfx-001",
        slotId: "sfx-panel-02",
        expectedHeadRevision: 0,
        panelIndex: 2,
        startSeconds: 8,
        endSeconds: 9,
        role: "sfx",
        mediaSha256: sfx.sha256,
      });
      expect(firstStoryboard).toMatchObject({ replayed: false, binding: { revision: 1, mediaKind: "image" } });
      expect(firstVideo).toMatchObject({ replayed: false, binding: { revision: 1, mediaKind: "video" } });
      expect(firstDialogue).toMatchObject({ replayed: false, binding: { revision: 1, mediaKind: "audio" } });

      const replacedDialogue = await attachStudioMultimediaTimelineMedia(fixture.root, {
        ...common,
        operationId: "timeline-attach-dialogue-002",
        slotId: "dialogue-main",
        expectedHeadRevision: 1,
        panelIndex: 1,
        startSeconds: 0,
        endSeconds: 3,
        role: "dialogue",
        mediaSha256: dialogueReplacement.sha256,
        note: "对白修订。",
      });
      expect(replacedDialogue).toMatchObject({
        replayed: false,
        binding: {
          revision: 2,
          mediaSha256: dialogueReplacement.sha256,
          supersedesRecordId: firstDialogue.binding.recordId,
        },
      });
      const replay = await attachStudioMultimediaTimelineMedia(fixture.root, {
        ...common,
        operationId: "timeline-attach-dialogue-002",
        slotId: "dialogue-main",
        expectedHeadRevision: 1,
        panelIndex: 1,
        startSeconds: 0,
        endSeconds: 3,
        role: "dialogue",
        mediaSha256: dialogueReplacement.sha256,
        note: "对白修订。",
      });
      expect(replay).toEqual({ binding: replacedDialogue.binding, replayed: true });

      await expect(attachStudioMultimediaTimelineMedia(fixture.root, {
        ...common,
        operationId: "timeline-invalid-kind",
        slotId: "video-invalid",
        expectedHeadRevision: 0,
        startSeconds: 0,
        endSeconds: 2,
        role: "video",
        mediaSha256: dialogue.sha256,
      })).rejects.toThrow("role video 只能绑定 video");
      await expect(attachStudioMultimediaTimelineMedia(fixture.root, {
        ...common,
        operationId: "timeline-invalid-range",
        slotId: "sfx-invalid",
        expectedHeadRevision: 0,
        panelIndex: 1,
        startSeconds: 6,
        endSeconds: 8,
        role: "sfx",
        mediaSha256: sfx.sha256,
      })).rejects.toThrow("越出 panel 1");
      await expect(attachStudioMultimediaTimelineMedia(fixture.root, {
        ...common,
        operationId: "timeline-invalid-fingerprint",
        expectedUnitFingerprint: "0".repeat(64),
        slotId: "music-invalid",
        expectedHeadRevision: 0,
        startSeconds: 0,
        endSeconds: 1,
        role: "music",
        mediaSha256: music.sha256,
      })).rejects.toThrow("指纹不匹配");
      await expect(attachStudioMultimediaTimelineMedia(fixture.root, {
        ...common,
        operationId: "timeline-conflict",
        slotId: "dialogue-main",
        expectedHeadRevision: 1,
        panelIndex: 1,
        startSeconds: 0,
        endSeconds: 3,
        role: "dialogue",
        mediaSha256: dialogue.sha256,
      })).rejects.toBeInstanceOf(StudioMultimediaTimelineConflictError);

      expect(materialCount(fixture.root)).toBe(mediaCountBeforeBinding);
      expect(timelineCounts(fixture.root)).toEqual({ bindings: 6, heads: 5 });
      expect(await listStudioMultimediaTimelineBindingHistory(fixture.root, {
        unitId: fixture.unitId,
        unitRevision: snapshot.unit.revision,
        slotId: "dialogue-main",
      })).toEqual([firstDialogue.binding, replacedDialogue.binding]);

      const projection = await getStudioMultimediaTimelineProjection(fixture.root, { unitId: fixture.unitId });
      expect(projection).not.toBeNull();
      expect(projection).toMatchObject({
        schemaVersion: 1,
        unit: {
          id: fixture.unitId,
          revision: 1,
          durationSeconds: 15,
        },
        availability: {
          script: "available",
          storyboard: "available",
          video: "available",
          audio: "available",
        },
        approvedStoryboard: {
          status: "available",
          productionStatus: "pass",
          raw: { sha256: formalBundle.raw.mediaSha256, kind: "image", casVerified: true },
          labeled: { sha256: formalBundle.labeled.mediaSha256, kind: "image", casVerified: true },
        },
      });
      expect(projection!.script.body).toContain("阿航走入古蜀石室");
      expect(projection!.panels).toHaveLength(2);
      expect(projection!.panels[0]!.sourceSurfaces[0]!.text).toBe("阿航");
      expect(projection!.tracks).toHaveLength(5);
      expect(projection!.tracks.find((entry) => entry.binding.slotId === "dialogue-main")).toMatchObject({
        binding: {
          revision: 2,
          mediaSha256: dialogueReplacement.sha256,
          supersedesRecordId: firstDialogue.binding.recordId,
        },
        media: {
          kind: "audio",
          derivatives: [{ kind: "audio_waveform", status: "ready" }],
          derivativeGaps: [],
        },
      });
      expect(projection!.tracks.find((entry) => entry.binding.slotId === "video-main")).toMatchObject({
        media: {
          kind: "video",
          derivatives: expect.arrayContaining([
            expect.objectContaining({ kind: "video_poster", status: "ready" }),
            expect.objectContaining({ kind: "video_proxy", status: "ready" }),
          ]),
          derivativeGaps: [],
        },
      });
      expect(projection!.gaps).toEqual([]);

      const moduleUrl = new URL("../src/core/studio-multimedia-timeline.ts", import.meta.url).href;
      const childScript = `
        import { getStudioMultimediaTimelineProjection } from ${toJsLiteral(moduleUrl)};
        const projection = await getStudioMultimediaTimelineProjection(
          ${toJsLiteral(fixture.root)},
          { unitId: ${toJsLiteral(fixture.unitId)} }
        );
        process.stdout.write(JSON.stringify({
          fingerprint: projection?.fingerprint,
          trackCount: projection?.tracks.length,
          dialogueSha: projection?.tracks.find((entry) => entry.binding.slotId === "dialogue-main")?.media.sha256,
          approvedRawSha: projection?.approvedStoryboard.raw?.sha256
        }) + "\\n");
      `;
      const child = await execFileAsync(currentNodeExecutable(), [
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        childScript,
      ], {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: process.env,
        maxBuffer: 1_024 * 1_024,
      });
      const restarted = JSON.parse(child.stdout.trim()) as Record<string, unknown>;
      expect(restarted).toEqual({
        fingerprint: projection!.fingerprint,
        trackCount: 5,
        dialogueSha: dialogueReplacement.sha256,
        approvedRawSha: formalBundle.raw.mediaSha256,
      });

      await writeFile(dialogueReplacement.objectPath, "tampered-cas-object");
      await expect(getStudioMultimediaTimelineProjection(fixture.root, { unitId: fixture.unitId }))
        .rejects.toThrow(/完整性|SHA|字节|大小|漂移/u);
    },
    180_000,
  );

  it("没有时间线关系表时只读投影明确报告缺项且不偷偷初始化 schema", async () => {
    const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "studio-multimedia-empty-")));
    temporaryRoots.push(parent);
    const fixture = await createUnitGridFixtureProject(parent, {
      unitId: "timeline-empty-unit",
      season: "S09",
      episode: "EP01",
    });
    const before = new DatabaseSync(path.join(fixture.root, ".aicanvas", "studio-production.sqlite"), { readOnly: true });
    expect(before.prepare(`
      SELECT COUNT(*) AS count FROM sqlite_master
      WHERE type = 'table' AND name LIKE 'studio_multimedia_timeline_%'
    `).get()).toEqual({ count: 0 });
    before.close();

    const projection = await getStudioMultimediaTimelineProjection(fixture.root, { unitId: fixture.unitId });
    expect(projection).toMatchObject({
      availability: {
        script: "available",
        storyboard: "missing",
        video: "missing",
        audio: "missing",
      },
      tracks: [],
    });
    expect(projection!.gaps.map((entry) => entry.code).sort()).toEqual([
      "approved-storyboard-unavailable",
      "audio-track-missing",
      "video-track-missing",
    ]);
    const after = new DatabaseSync(path.join(fixture.root, ".aicanvas", "studio-production.sqlite"), { readOnly: true });
    expect(after.prepare(`
      SELECT COUNT(*) AS count FROM sqlite_master
      WHERE type = 'table' AND name LIKE 'studio_multimedia_timeline_%'
    `).get()).toEqual({ count: 0 });
    after.close();

    const snapshot = await getStudioProductionUnitSnapshot(fixture.root, fixture.unitId);
    if (!snapshot) throw new Error("fixture unit snapshot 不存在。");
    const sourceStoryboard = await createUnitGridTestImage(
      fixture.root,
      "timeline-source-only-panel-01",
      "#496274",
    );
    await attachStudioMultimediaTimelineMedia(fixture.root, {
      operationId: "timeline-source-only-attach",
      unitId: fixture.unitId,
      unitRevision: snapshot.unit.revision,
      expectedUnitFingerprint: snapshot.fingerprint,
      slotId: "source-storyboard-panel-01",
      expectedHeadRevision: 0,
      panelIndex: 1,
      startSeconds: snapshot.panels[0]!.startSeconds,
      endSeconds: snapshot.panels[0]!.endSeconds,
      role: "storyboard",
      mediaSha256: sourceStoryboard.sha256,
      note: "来源故事板，不继承为 Review PASS。",
    });
    const sourceOnly = await getStudioMultimediaTimelineProjection(fixture.root, {
      unitId: fixture.unitId,
    });
    expect(sourceOnly).toMatchObject({
      availability: { storyboard: "source-only" },
      approvedStoryboard: { status: "missing" },
      tracks: [{ binding: { role: "storyboard", panelId: snapshot.panels[0]!.id } }],
    });
    expect(sourceOnly!.gaps).toContainEqual(expect.objectContaining({
      code: "approved-storyboard-unavailable",
      required: true,
    }));
  }, 120_000);
});
