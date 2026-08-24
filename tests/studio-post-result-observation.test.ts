import { createHash } from "node:crypto";
import { accessSync, constants as fsConstants } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  dispatchStudioGenerationPack,
  freezeAndPersistStudioGenerationPack,
  freezeAndPersistStudioUnitGridGenerationPack,
  prepareStudioImagegenCall,
  registerStudioGenerationResult,
  registerStudioGenerationResultBundle,
} from "../src/core/studio-generation-ledger.js";
import {
  getStudioGenerationReviewControl,
  submitStudioGenerationReview,
} from "../src/core/studio-generation-review.js";
import {
  __setStudioPostResultObservationFinalReviewHookForTests,
  getStudioPostResultObservationControl,
  readStudioPostResultObservationOperationRecordReadOnly,
  readStudioPostResultObservation,
  readStudioPostResultObservationOutcomeByOperationId,
  submitStudioPostResultObservation,
  type SubmitStudioPostResultObservationInput,
} from "../src/core/studio-post-result-observation.js";
import { buildNextShotContinuitySnapshot } from "../src/core/studio-next-shot-continuity.js";
import {
  MEDIA_WEIGHTS,
  mediaStageTimeout,
  runMediaProcess,
} from "../src/core/media-runtime.js";
import { importStudioMedia } from "../src/core/material-studio.js";
import {
  createStudioP7Fixture,
  seedStudioP7ResolvedContinuity,
  studioP7ContinuationWaiver,
  type StudioP7Fixture,
} from "./helpers/studio-p7-fixture.js";

let fixture: StudioP7Fixture | undefined;
const ORIGINAL_FFMPEG = process.env.AI_CANVAS_FFMPEG;
const ORIGINAL_FFPROBE = process.env.AI_CANVAS_FFPROBE;

function executable(name: "ffmpeg" | "ffprobe"): string | undefined {
  const configured = name === "ffmpeg" ? ORIGINAL_FFMPEG : ORIGINAL_FFPROBE;
  const candidates = [
    configured,
    ...(process.env.PATH ?? "")
      .split(path.delimiter)
      .filter(Boolean)
      .map((directory) => path.join(directory, name)),
    `/opt/homebrew/bin/${name}`,
    `/usr/local/bin/${name}`,
    `/usr/bin/${name}`,
  ].filter((value): value is string => Boolean(value));
  for (const candidate of [...new Set(candidates)]) {
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // 继续寻找。
    }
  }
  return undefined;
}

const FFMPEG = executable("ffmpeg");
const FFPROBE = executable("ffprobe");

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([key, entry]) => [key, stableValue(entry)]));
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stableValue(value)), "utf8").digest("hex");
}

afterEach(async () => {
  __setStudioPostResultObservationFinalReviewHookForTests(null);
  if (ORIGINAL_FFMPEG === undefined) delete process.env.AI_CANVAS_FFMPEG;
  else process.env.AI_CANVAS_FFMPEG = ORIGINAL_FFMPEG;
  if (ORIGINAL_FFPROBE === undefined) delete process.env.AI_CANVAS_FFPROBE;
  else process.env.AI_CANVAS_FFPROBE = ORIGINAL_FFPROBE;
  await fixture?.cleanup();
  fixture = undefined;
});

async function createVideoFixture(
  outputPath: string,
  includeAudio: boolean,
): Promise<void> {
  if (!FFMPEG) throw new Error("FFmpeg unavailable");
  const inputArgs = [
    "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=12",
    ...(includeAudio
      ? ["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100"]
      : []),
    "-t", "1",
    ...(includeAudio ? ["-shortest"] : []),
    "-c:v", "libx264", "-pix_fmt", "yuv420p",
    ...(includeAudio ? ["-c:a", "aac", "-b:a", "96k"] : []),
    "-y", outputPath,
  ];
  const result = await runMediaProcess(FFMPEG, inputArgs, {
    tool: "ffmpeg",
    stage: "post-result-observation-video-fixture",
    weight: MEDIA_WEIGHTS.foreground,
    timeoutMs: mediaStageTimeout("ffmpeg", 60_000),
    maxOutputBytes: 64 * 1_024,
  });
  if (result.status !== "succeeded") throw new Error(result.output || "FFmpeg fixture failed");
}

async function generationLedgerFootprint(projectRoot: string): Promise<Record<string, string>> {
  const databasePath = path.join(projectRoot, ".aicanvas/studio-generation-ledger.sqlite");
  const result: Record<string, string> = {};
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    try {
      const bytes = await readFile(`${databasePath}${suffix}`);
      result[suffix || "main"] = createHash("sha256").update(bytes).digest("hex");
    } catch (error) {
      if (!(error instanceof Error && "code" in error
        && (error as NodeJS.ErrnoException).code === "ENOENT")) throw error;
    }
  }
  return result;
}

async function prepareReviewedPair(decision: "pass" | "rework" = "pass") {
  fixture = await createStudioP7Fixture();
  await seedStudioP7ResolvedContinuity(fixture);
  const panel = fixture.units.sixPanel.panels[0]!;
  const media = fixture.panelMediaPairs.find((entry) => entry.panelId === panel.id)!;
  const evidenceMedia = fixture.panelMediaPairs.find((entry) => entry.panelId !== panel.id)!.raw.imported;
  const persisted = await freezeAndPersistStudioGenerationPack(fixture.root, {
    unitId: fixture.units.sixPanel.unit.id,
    panelId: panel.id,
  });
  const generationRunId = `post-result-${decision}-run`;
  await dispatchStudioGenerationPack(fixture.root, {
    packId: persisted.packId,
    packFingerprint: persisted.fingerprint,
    generationRunId,
    provider: "codex",
  });
  const raw = await registerStudioGenerationResult(fixture.root, {
    packId: persisted.packId,
    packFingerprint: persisted.fingerprint,
    generationRunId,
    variant: "raw",
    mediaSha256: media.raw.imported.sha256,
  });
  const labeled = await registerStudioGenerationResult(fixture.root, {
    packId: persisted.packId,
    packFingerprint: persisted.fingerprint,
    generationRunId,
    variant: "labeled",
    mediaSha256: media.labeled.imported.sha256,
  });
  const review = await submitStudioGenerationReview(fixture.root, {
    operationId: `post-result-review-${decision}`,
    generationRunId,
    kind: "observation",
    expectedHeadRevision: 0,
    rawResultId: raw.resultId,
    rawSha256: raw.mediaSha256,
    labeledResultId: labeled.resultId,
    labeledSha256: labeled.mediaSha256,
    expectedPackFingerprint: persisted.fingerprint,
    continuityFingerprint: persisted.pack.continuity.fingerprint,
    decision,
    criteria: [{
      code: "fixture-visual-review",
      status: decision === "pass" ? "pass" : "fail",
      note: "确定性夹具，仅验证账本门禁。",
    }],
    reviewer: "post-result-test",
    note: decision === "pass" ? "夹具 PASS Review。" : "夹具非 PASS Review。",
  });
  return { panel, media, evidenceMedia, persisted, generationRunId, raw, labeled, review };
}

async function prepareReviewedUnitGridPair() {
  fixture = await createStudioP7Fixture();
  await seedStudioP7ResolvedContinuity(fixture);
  const unit = fixture.units.twoPanel;
  const persisted = await freezeAndPersistStudioUnitGridGenerationPack(fixture.root, {
    targetKind: "unit-grid",
    unitId: unit.unit.id,
    verifiedHistoricalImportContinuationWaiver: await studioP7ContinuationWaiver(
      fixture.root,
      unit,
      "decision:observation-receipt-fixture-waiver",
    ),
  });
  const generationRunId = "post-result-grid-pass-run";
  await dispatchStudioGenerationPack(fixture.root, {
    packId: persisted.packId,
    packFingerprint: persisted.fingerprint,
    generationRunId,
    provider: "codex",
  });
  const intent = await prepareStudioImagegenCall(fixture.root, {
    packId: persisted.packId,
    packFingerprint: persisted.fingerprint,
    generationRunId,
    provider: "codex",
    projectContextToken: "post-result-grid-fixture-context",
    commandRequestId: "post-result-grid-call-command",
    expectedRevision: 0,
  });
  const firstMedia = fixture.panelMediaPairs.find((entry) => entry.panelId === unit.panels[0]!.id)!;
  const terminalEvidence = fixture.panelMediaPairs.find(
    (entry) => entry.panelId === unit.panels.at(-1)!.id,
  )!.raw.imported;
  const bundle = await registerStudioGenerationResultBundle(fixture.root, {
    packId: persisted.packId,
    packFingerprint: persisted.fingerprint,
    generationRunId,
    provider: "codex",
    rawMediaSha256: firstMedia.raw.imported.sha256,
    labeledMediaSha256: firstMedia.labeled.imported.sha256,
    callId: intent.callId,
  });
  const { raw, labeled } = bundle;
  const review = await submitStudioGenerationReview(fixture.root, {
    operationId: "post-result-grid-review-pass",
    generationRunId,
    kind: "observation",
    expectedHeadRevision: 0,
    rawResultId: raw.resultId,
    rawSha256: raw.mediaSha256,
    labeledResultId: labeled.resultId,
    labeledSha256: labeled.mediaSha256,
    expectedPackFingerprint: persisted.fingerprint,
    continuityFingerprint: persisted.pack.continuityFingerprint,
    decision: "pass",
    criteria: [{ code: "fixture-grid-review", status: "pass", note: "确定性 unit-grid PASS。" }],
    reviewer: "post-result-test",
    note: "为 terminal panel 证据提供 current unit-grid Review。",
  });
  return {
    unit,
    persisted,
    generationRunId,
    raw,
    labeled,
    review,
    terminalEvidence,
  };
}

function observationInput(
  prepared: Awaited<ReturnType<typeof prepareReviewedPair>>,
  overrides: Partial<SubmitStudioPostResultObservationInput> = {},
): SubmitStudioPostResultObservationInput {
  return {
    operationId: "post-result-observation-001",
    generationRunId: prepared.generationRunId,
    expectedHeadRevision: 0,
    expectedReviewId: prepared.review.reviewId,
    expectedReviewFingerprint: prepared.review.fingerprint,
    rawResultId: prepared.raw.resultId,
    rawSha256: prepared.raw.mediaSha256,
    labeledResultId: prepared.labeled.resultId,
    labeledSha256: prepared.labeled.mediaSha256,
    packId: prepared.persisted.packId,
    packFingerprint: prepared.persisted.fingerprint,
    plannedContinuityFingerprint: prepared.persisted.pack.continuity.fingerprint,
    evidenceKind: "accepted-last-frame",
    evidenceSha256: prepared.evidenceMedia.sha256,
    observedState: {
      costume: "实际画面中阿航保持素麻古蜀服。",
      injury: "实际画面未见伤势。",
      heldObject: "实际画面中双手持完整黄金面具。",
      position: "实际画面中位于石室中央。",
      facing: "实际画面中面向镜头略偏左。",
      emotion: "实际画面中神情警觉。",
      layout: "实际画面为阿航居中、石墙在后、黄金面具在胸前。",
      lighting: "实际画面左侧火光，右侧较暗。",
      referenceSha256: prepared.evidenceMedia.sha256,
      motionVector: "实际末帧动作已收稳，无继续位移。",
      cameraPhase: "实际末帧机位稳定，无残余推拉。",
      focusState: "实际末帧焦点落在阿航与黄金面具。",
      audioPhase: "实际末帧对白结束，环境声延续。",
    },
    observedAvailability: observationAvailability(),
    observer: "post-result-test",
    note: "仅记录人工从 PASS 结果观察到的实际末态；不复制计划终态。",
    ...overrides,
  };
}

function observationAvailability(
  overrides: Partial<SubmitStudioPostResultObservationInput["observedAvailability"]> = {},
): SubmitStudioPostResultObservationInput["observedAvailability"] {
  return {
    costume: "observed",
    injury: "observed",
    heldObject: "observed",
    position: "observed",
    facing: "observed",
    emotion: "observed",
    layout: "observed",
    lighting: "observed",
    motionVector: "unknown",
    cameraPhase: "unknown",
    focusState: "observed",
    audioPhase: "unknown",
    ...overrides,
  };
}

describe("PASS 审片结果实际末态观察收据", () => {
  it("get-control 在观察/Review schema 尚未建立时保持物理只读", async () => {
    fixture = await createStudioP7Fixture();
    const before = await generationLedgerFootprint(fixture.root);
    await expect(getStudioPostResultObservationControl(fixture.root, "post-result-readonly-run"))
      .resolves.toMatchObject({
        status: "missing",
        headRevision: 0,
        blockers: ["review-schema-not-initialized"],
        nextAction: "wait-for-current-pass-review",
      });
    expect(await generationLedgerFootprint(fixture.root)).toEqual(before);
  }, 60_000);

  it("内容寻址追加实际末态，operation 幂等且 Head 使用 CAS", async () => {
    const prepared = await prepareReviewedPair("pass");
    const input = observationInput(prepared);
    await expect(getStudioPostResultObservationControl(fixture!.root, prepared.generationRunId))
      .resolves.toMatchObject({
        status: "missing",
        headRevision: 0,
        blockers: [],
        nextAction: "submit-observed-end-state",
      });

    const written = await submitStudioPostResultObservation(fixture!.root, input);
    expect(written).toMatchObject({
      generationRunId: prepared.generationRunId,
      baseHeadRevision: 0,
      headRevision: 1,
      reviewId: prepared.review.reviewId,
      reviewFingerprint: prepared.review.fingerprint,
      rawResultId: prepared.raw.resultId,
      rawSha256: prepared.raw.mediaSha256,
      labeledResultId: prepared.labeled.resultId,
      labeledSha256: prepared.labeled.mediaSha256,
      packId: prepared.persisted.packId,
      packFingerprint: prepared.persisted.fingerprint,
      plannedContinuityFingerprint: prepared.persisted.pack.continuity.fingerprint,
      evidenceContractVersion: 3,
      evidenceKind: "accepted-last-frame",
      evidenceSha256: prepared.evidenceMedia.sha256,
      head: true,
      current: true,
      continuationEligible: false,
      currentStaleReasons: [],
      continuationIneligibleReasons: [
        "accepted-last-frame-without-specialized-lineage-receipt",
      ],
    });
    expect(written.observedState.position).toContain("实际画面");
    expect(written.observedState.referenceSha256).toBe(prepared.evidenceMedia.sha256);
    expect(written.observedState.motionVector).toBeUndefined();
    expect(written.observedAvailability.audioPhase).toBe("unknown");

    const replay = await submitStudioPostResultObservation(fixture!.root, input);
    expect(replay.observationId).toBe(written.observationId);
    expect(replay.fingerprint).toBe(written.fingerprint);
    await expect(submitStudioPostResultObservation(fixture!.root, {
      ...input,
      note: "同 operation 键异载荷必须被拒绝。",
    })).rejects.toMatchObject({ code: "operation-conflict" });
    await expect(submitStudioPostResultObservation(fixture!.root, {
      ...input,
      operationId: "post-result-observation-stale-cas",
    })).rejects.toMatchObject({ code: "observation-conflict" });

    await expect(readStudioPostResultObservation(fixture!.root, written.observationId))
      .resolves.toMatchObject({ current: true, continuationEligible: false });
    await expect(readStudioPostResultObservationOutcomeByOperationId(fixture!.root, input.operationId))
      .resolves.toMatchObject({
        observationId: written.observationId,
        fingerprint: written.fingerprint,
        current: true,
      });
    await expect(readStudioPostResultObservationOutcomeByOperationId(
      fixture!.root,
      "post-result-observation-missing",
    )).resolves.toBeNull();
    await expect(getStudioPostResultObservationControl(fixture!.root, prepared.generationRunId))
      .resolves.toMatchObject({
        status: "stale",
        headRevision: 1,
        blockers: ["accepted-last-frame-without-specialized-lineage-receipt"],
        nextAction: "reobserve-current-pass-result",
      });
    // 新表不能污染 Review 模块自己的严格前缀 allowlist。
    await expect(getStudioGenerationReviewControl(fixture!.root, prepared.generationRunId))
      .resolves.toMatchObject({ status: "pass", headRevision: 1 });

    const db = new DatabaseSync(path.join(fixture!.root, ".aicanvas/studio-generation-ledger.sqlite"));
    expect(db.prepare("SELECT COUNT(*) AS count FROM studio_post_result_observation_events").get())
      .toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM studio_post_result_observation_operation_receipts").get())
      .toEqual({ count: 1 });
    expect(() => db.prepare(`
      UPDATE studio_post_result_observation_events SET note='forbidden' WHERE observation_id=?
    `).run(written.observationId)).toThrow(/append-only/u);
    db.close();
  }, 60_000);

  it("v4 结构化连续性快照绑定 PASS raw、可回读并进入下一镜承接", async () => {
    const prepared = await prepareReviewedPair("pass");
    const continuitySnapshot = buildNextShotContinuitySnapshot({
      sourceUnitId: fixture!.units.sixPanel.unit.id,
      sourcePanelId: prepared.panel.id,
      sourceRawSha256: prepared.raw.mediaSha256,
      characters: [{
        assetId: "character-ahang",
        costumeState: "古蜀猎人服装完整，无新增污损",
        position: "画面中央",
        facing: "朝镜头左前方",
        gazeDirection: "注视黄金面具",
        actionEndPose: "双手托住黄金面具并收稳",
        nextActionStart: "保持托举姿态，从面具抬眼看向石门",
        expression: "警觉",
        injuryState: "无新增伤势",
      }],
      props: [{
        assetId: "prop-golden-mask",
        heldBy: "character-ahang",
        position: "阿航胸前双手之间",
        physicalState: "完整、闭合",
      }],
      scene: {
        layout: "阿航居中，石墙在后",
        axisLine: "阿航与黄金面具构成前后轴线",
        screenDirection: "阿航视线由画面中央指向右后方",
        entryExits: ["画面右后方石门"],
        lighting: "左侧火光，右侧较暗",
        timeOfDay: "夜",
        cutExit: "阿航抬眼锁定右后方石门时切出",
      },
      vfx: [],
      referenceSha256List: [
        prepared.raw.mediaSha256,
        prepared.evidenceMedia.sha256,
      ],
    });
    const input = observationInput(prepared, {
      operationId: "post-result-observation-v4-001",
      continuitySnapshot,
    });

    const written = await submitStudioPostResultObservation(fixture!.root, input);
    expect(written).toMatchObject({
      evidenceContractVersion: 4,
      current: true,
      continuationEligible: true,
      continuationIneligibleReasons: [],
      continuitySnapshot: {
        sourceUnitId: fixture!.units.sixPanel.unit.id,
        sourcePanelId: prepared.panel.id,
        sourceRawSha256: prepared.raw.mediaSha256,
        continuityFingerprint: continuitySnapshot.continuityFingerprint,
      },
    });
    await expect(readStudioPostResultObservation(fixture!.root, written.observationId))
      .resolves.toMatchObject({
        evidenceContractVersion: 4,
        continuationEligible: true,
        continuitySnapshot: {
          continuityFingerprint: continuitySnapshot.continuityFingerprint,
        },
      });
    await expect(getStudioPostResultObservationControl(fixture!.root, prepared.generationRunId))
      .resolves.toMatchObject({
        status: "current",
        nextAction: "use-observed-end-state",
      });
    await expect(submitStudioPostResultObservation(fixture!.root, {
      ...input,
      operationId: "post-result-observation-v4-wrong-raw",
      continuitySnapshot: {
        ...continuitySnapshot,
        sourceRawSha256: prepared.evidenceMedia.sha256,
      },
    })).rejects.toMatchObject({ code: "invalid-input" });
    await expect(submitStudioPostResultObservation(fixture!.root, {
      ...input,
      operationId: "post-result-observation-v4-wrong-fingerprint",
      continuitySnapshot: {
        ...continuitySnapshot,
        continuityFingerprint: "0".repeat(64),
      },
    })).rejects.toMatchObject({ code: "invalid-input" });
  }, 60_000);

  it("当前 Review 不是 PASS/approvedRawEligible 时拒绝记录", async () => {
    const prepared = await prepareReviewedPair("rework");
    await expect(submitStudioPostResultObservation(
      fixture!.root,
      observationInput(prepared),
    )).rejects.toMatchObject({ code: "review-ineligible" });
    await expect(getStudioPostResultObservationControl(fixture!.root, prepared.generationRunId))
      .resolves.toMatchObject({
        status: "missing",
        headRevision: 0,
        nextAction: "wait-for-current-pass-review",
      });
  }, 60_000);

  it("拒绝用整张 raw 冒充末格证据，并严格校验 evidence kind 与 reference 绑定", async () => {
    const prepared = await prepareReviewedPair("pass");
    const valid = observationInput(prepared);
    await expect(submitStudioPostResultObservation(fixture!.root, {
      ...valid,
      evidenceSha256: valid.rawSha256,
      observedState: { ...valid.observedState, referenceSha256: valid.rawSha256 },
    })).rejects.toMatchObject({ code: "invalid-input" });
    await expect(submitStudioPostResultObservation(fixture!.root, {
      ...valid,
      evidenceKind: "reviewed-video",
    })).rejects.toMatchObject({ code: "invalid-input" });
    await expect(submitStudioPostResultObservation(fixture!.root, {
      ...valid,
      evidenceKind: "terminal-panel-crop",
    } as SubmitStudioPostResultObservationInput)).rejects.toMatchObject({ code: "invalid-input" });
    await expect(submitStudioPostResultObservation(fixture!.root, {
      ...valid,
      observedState: { ...valid.observedState, referenceSha256: "d".repeat(64) },
    })).rejects.toMatchObject({ code: "invalid-input" });
    await expect(submitStudioPostResultObservation(fixture!.root, {
      ...valid,
      evidenceSha256: "f".repeat(64),
      observedState: { ...valid.observedState, referenceSha256: "f".repeat(64) },
    })).rejects.toMatchObject({ code: "invalid-input" });
    for (const field of ["motionVector", "cameraPhase", "audioPhase"] as const) {
      await expect(submitStudioPostResultObservation(fixture!.root, {
        ...valid,
        operationId: `post-result-accepted-frame-dynamic-${field}`,
        observedAvailability: {
          ...valid.observedAvailability,
          [field]: "observed",
        },
      })).rejects.toMatchObject({
        code: "invalid-input",
        message: expect.stringContaining("静态图片"),
      });
    }
  }, 60_000);

  it("文本伪装成 mp4 即使登记为 video 也不能成为 reviewed-video 证据", async () => {
    const prepared = await prepareReviewedPair("pass");
    const fakePath = path.join(fixture!.root, "fake-reviewed-video.mp4");
    await writeFile(fakePath, "this is not a video container", "utf8");
    const fake = await importStudioMedia(fixture!.root, {
      sourcePath: fakePath,
      kind: "video",
    });
    const input = observationInput(prepared, {
      operationId: "post-result-fake-reviewed-video",
      evidenceKind: "reviewed-video",
      evidenceSha256: fake.sha256,
      observedState: {
        ...observationInput(prepared).observedState,
        referenceSha256: fake.sha256,
      },
      observedAvailability: observationAvailability({
        motionVector: "observed",
        cameraPhase: "observed",
        audioPhase: "unknown",
      }),
    });
    await expect(submitStudioPostResultObservation(fixture!.root, input))
      .rejects.toMatchObject({ code: "invalid-input" });
    const db = new DatabaseSync(path.join(fixture!.root, ".aicanvas/studio-generation-ledger.sqlite"));
    expect(db.prepare("SELECT COUNT(*) AS count FROM studio_post_result_observation_events").get())
      .toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM studio_post_result_observation_operation_receipts").get())
      .toEqual({ count: 0 });
    db.close();
  }, 60_000);

  it.skipIf(!FFMPEG || !FFPROBE)(
    "只有真实可完整解码且含视频流的 reviewed-video 才能承载动态 observed",
    async () => {
      const prepared = await prepareReviewedPair("pass");
      const videoPath = path.join(fixture!.root, "reviewed-video.mp4");
      await createVideoFixture(videoPath, true);
      process.env.AI_CANVAS_FFMPEG = FFMPEG!;
      process.env.AI_CANVAS_FFPROBE = FFPROBE!;
      const video = await importStudioMedia(fixture!.root, {
        sourcePath: videoPath,
        kind: "video",
      });
      const base = observationInput(prepared);
      const written = await submitStudioPostResultObservation(fixture!.root, {
        ...base,
        operationId: "post-result-real-reviewed-video",
        evidenceKind: "reviewed-video",
        evidenceSha256: video.sha256,
        observedState: {
          ...base.observedState,
          referenceSha256: video.sha256,
        },
        observedAvailability: observationAvailability({
          motionVector: "observed",
          cameraPhase: "observed",
          audioPhase: "observed",
        }),
      });
      expect(written).toMatchObject({
        evidenceKind: "reviewed-video",
        evidenceSha256: video.sha256,
        current: true,
        continuationEligible: false,
        continuationIneligibleReasons: [
          "reviewed-video-without-specialized-lineage-receipt",
        ],
      });
    },
    120_000,
  );

  it.skipIf(!FFMPEG || !FFPROBE)(
    "无音频流的真实 reviewed-video 不能声称 audioPhase=observed",
    async () => {
      const prepared = await prepareReviewedPair("pass");
      const videoPath = path.join(fixture!.root, "reviewed-video-without-audio.mp4");
      await createVideoFixture(videoPath, false);
      process.env.AI_CANVAS_FFMPEG = FFMPEG!;
      process.env.AI_CANVAS_FFPROBE = FFPROBE!;
      const video = await importStudioMedia(fixture!.root, {
        sourcePath: videoPath,
        kind: "video",
      });
      const base = observationInput(prepared);
      await expect(submitStudioPostResultObservation(fixture!.root, {
        ...base,
        operationId: "post-result-video-without-audio",
        evidenceKind: "reviewed-video",
        evidenceSha256: video.sha256,
        observedState: {
          ...base.observedState,
          referenceSha256: video.sha256,
        },
        observedAvailability: observationAvailability({
          motionVector: "observed",
          cameraPhase: "observed",
          audioPhase: "observed",
        }),
      })).rejects.toMatchObject({
        code: "invalid-input",
        message: expect.stringContaining("不含可验证音频流"),
      });
    },
    120_000,
  );

  it("terminal-panel-crop 只接受当前 unit-grid 冻结包的最后一格与受管 image CAS", async () => {
    const prepared = await prepareReviewedUnitGridPair();
    const terminalPanel = prepared.unit.panels.at(-1)!;
    const base: SubmitStudioPostResultObservationInput = {
      operationId: "post-result-grid-observation",
      generationRunId: prepared.generationRunId,
      expectedHeadRevision: 0,
      expectedReviewId: prepared.review.reviewId,
      expectedReviewFingerprint: prepared.review.fingerprint,
      rawResultId: prepared.raw.resultId,
      rawSha256: prepared.raw.mediaSha256,
      labeledResultId: prepared.labeled.resultId,
      labeledSha256: prepared.labeled.mediaSha256,
      packId: prepared.persisted.packId,
      packFingerprint: prepared.persisted.fingerprint,
      plannedContinuityFingerprint: prepared.persisted.pack.continuityFingerprint,
      evidenceKind: "terminal-panel-crop",
      evidenceSha256: prepared.terminalEvidence.sha256,
      terminalPanelId: prepared.unit.panels[0]!.id,
      observedState: {
        costume: "末格实际服装。",
        injury: "末格实际伤势。",
        heldObject: "末格实际持物。",
        position: "末格实际站位。",
        facing: "末格实际朝向。",
        emotion: "末格实际情绪。",
        layout: "末格实际布局。",
        lighting: "末格实际光线。",
        referenceSha256: prepared.terminalEvidence.sha256,
        motionVector: "静态末格无法证明动作余势。",
        cameraPhase: "静态末格无法证明镜头运动阶段。",
        focusState: "末格实际焦点。",
        audioPhase: "末格音频不可从静帧判断。",
      },
      observedAvailability: observationAvailability(),
      observer: "post-result-test",
      note: "验证 terminal panel 与 CAS 证据门禁。",
    };
    await expect(submitStudioPostResultObservation(fixture!.root, base))
      .rejects.toMatchObject({ code: "invalid-input" });
    for (const field of ["motionVector", "cameraPhase", "audioPhase"] as const) {
      await expect(submitStudioPostResultObservation(fixture!.root, {
        ...base,
        operationId: `post-result-grid-observation-dynamic-${field}`,
        terminalPanelId: terminalPanel.id,
        observedAvailability: {
          ...base.observedAvailability,
          [field]: "observed",
        },
      })).rejects.toMatchObject({
        code: "invalid-input",
        message: expect.stringContaining("静态图片"),
      });
    }
    const written = await submitStudioPostResultObservation(fixture!.root, {
      ...base,
      terminalPanelId: terminalPanel.id,
    });
    expect(written).toMatchObject({
      evidenceContractVersion: 3,
      terminalPanelId: terminalPanel.id,
      evidenceKind: "terminal-panel-crop",
      evidenceSha256: prepared.terminalEvidence.sha256,
      current: true,
      continuationEligible: false,
      continuationIneligibleReasons: [
        "terminal-panel-crop-without-trusted-raw-derivation-receipt",
      ],
    });
    expect(written.observedState).toMatchObject({
      costume: "末格实际服装。",
      position: "末格实际站位。",
      focusState: "末格实际焦点。",
    });
    expect(written.observedState.motionVector).toBeUndefined();
    await expect(getStudioPostResultObservationControl(fixture!.root, prepared.generationRunId))
      .resolves.toMatchObject({
        status: "stale",
        blockers: ["terminal-panel-crop-without-trusted-raw-derivation-receipt"],
        nextAction: "reobserve-current-pass-result",
      });
  }, 90_000);

  it("旧 v1 无显式末格证据事件保持可读，但永远不能静默升级为续接来源", async () => {
    const prepared = await prepareReviewedPair("pass");
    const current = await submitStudioPostResultObservation(
      fixture!.root,
      observationInput(prepared),
    );
    const legacyObservedState = {
      ...observationInput(prepared).observedState,
      referenceSha256: prepared.raw.mediaSha256,
    };
    const legacySemantic = {
      schemaVersion: 1,
      kind: "studio-post-result-observation",
      generationRunId: prepared.generationRunId,
      baseHeadRevision: 1,
      headRevision: 2,
      reviewId: prepared.review.reviewId,
      reviewFingerprint: prepared.review.fingerprint,
      rawResultId: prepared.raw.resultId,
      rawSha256: prepared.raw.mediaSha256,
      labeledResultId: prepared.labeled.resultId,
      labeledSha256: prepared.labeled.mediaSha256,
      packId: prepared.persisted.packId,
      packFingerprint: prepared.persisted.fingerprint,
      plannedContinuityFingerprint: prepared.persisted.pack.continuity.fingerprint,
      observedState: legacyObservedState,
      observer: "legacy-observer",
      note: "历史 v1 事件：当时仅把整张 raw 当作 reference。",
    };
    const fingerprint = digest(legacySemantic);
    const observationId = `studio-post-result-observation-${fingerprint.slice(0, 40)}`;
    const now = new Date().toISOString();
    const db = new DatabaseSync(path.join(fixture!.root, ".aicanvas/studio-generation-ledger.sqlite"));
    db.exec("PRAGMA foreign_keys=ON");
    db.prepare(`
      INSERT INTO studio_post_result_observation_events(
        observation_id,generation_run_id,base_head_revision,head_revision,review_id,review_fingerprint,
        raw_result_id,raw_sha256,labeled_result_id,labeled_sha256,pack_id,pack_fingerprint,
        planned_continuity_fingerprint,observed_state_json,observer,note,fingerprint,created_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      observationId, prepared.generationRunId, 1, 2,
      prepared.review.reviewId, prepared.review.fingerprint,
      prepared.raw.resultId, prepared.raw.mediaSha256,
      prepared.labeled.resultId, prepared.labeled.mediaSha256,
      prepared.persisted.packId, prepared.persisted.fingerprint,
      prepared.persisted.pack.continuity.fingerprint,
      JSON.stringify(legacyObservedState), "legacy-observer", legacySemantic.note,
      fingerprint, now,
    );
    db.prepare(`
      UPDATE studio_post_result_observation_heads
      SET revision=2,observation_id=?,observation_fingerprint=?,updated_at=?
      WHERE generation_run_id=? AND revision=1
    `).run(observationId, fingerprint, now, prepared.generationRunId);
    const legacyOperationId = "a".repeat(64);
    db.prepare(`
      INSERT INTO studio_post_result_observation_operation_receipts(
        operation_id,input_fingerprint,observation_id,outcome_fingerprint,created_at
      ) VALUES(?,?,?,?,?)
    `).run(legacyOperationId, "b".repeat(64), observationId, fingerprint, now);
    db.close();

    await expect(readStudioPostResultObservationOperationRecordReadOnly(
      fixture!.root,
      legacyOperationId,
    )).rejects.toMatchObject({
      code: "storage-invalid",
      details: [expect.stringMatching(/legacy v1 输入无法/u)],
    });

    const legacy = await readStudioPostResultObservation(fixture!.root, observationId);
    expect(legacy).toMatchObject({
      evidenceContractVersion: 1,
      current: true,
      continuationEligible: false,
      continuationIneligibleReasons: ["legacy-observation-without-explicit-evidence"],
      observedAvailability: {
        motionVector: "unknown",
        cameraPhase: "unknown",
        audioPhase: "unknown",
      },
    });
    expect(legacy?.evidenceKind).toBeUndefined();
    await expect(getStudioPostResultObservationControl(fixture!.root, prepared.generationRunId))
      .resolves.toMatchObject({
        status: "stale",
        blockers: ["legacy-observation-without-explicit-evidence"],
        nextAction: "reobserve-current-pass-result",
      });
  }, 60_000);

  it("旧 v2 缺少全字段 availability 与不可变血缘时保守降级且不泄漏 actual", async () => {
    const prepared = await prepareReviewedPair("pass");
    await submitStudioPostResultObservation(fixture!.root, observationInput(prepared));
    const legacyObservedState = observationInput(prepared).observedState;
    const legacyAvailability = {
      motionVector: "observed",
      cameraPhase: "unknown",
      audioPhase: "unknown",
    } as const;
    const legacySemantic = {
      schemaVersion: 2,
      kind: "studio-post-result-observation",
      generationRunId: prepared.generationRunId,
      baseHeadRevision: 1,
      headRevision: 2,
      reviewId: prepared.review.reviewId,
      reviewFingerprint: prepared.review.fingerprint,
      rawResultId: prepared.raw.resultId,
      rawSha256: prepared.raw.mediaSha256,
      labeledResultId: prepared.labeled.resultId,
      labeledSha256: prepared.labeled.mediaSha256,
      packId: prepared.persisted.packId,
      packFingerprint: prepared.persisted.fingerprint,
      plannedContinuityFingerprint: prepared.persisted.pack.continuity.fingerprint,
      evidenceKind: "accepted-last-frame",
      evidenceSha256: prepared.evidenceMedia.sha256,
      observedState: legacyObservedState,
      observedAvailability: legacyAvailability,
      observer: "legacy-v2-observer",
      note: "历史 v2 事件：只有三个动态字段 availability。",
    };
    const fingerprint = digest(legacySemantic);
    const observationId = `studio-post-result-observation-${fingerprint.slice(0, 40)}`;
    const now = new Date().toISOString();
    const db = new DatabaseSync(path.join(fixture!.root, ".aicanvas/studio-generation-ledger.sqlite"));
    db.prepare(`
      INSERT INTO studio_post_result_observation_events(
        observation_id,generation_run_id,base_head_revision,head_revision,review_id,review_fingerprint,
        raw_result_id,raw_sha256,labeled_result_id,labeled_sha256,pack_id,pack_fingerprint,
        planned_continuity_fingerprint,observed_state_json,observer,note,fingerprint,created_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      observationId, prepared.generationRunId, 1, 2,
      prepared.review.reviewId, prepared.review.fingerprint,
      prepared.raw.resultId, prepared.raw.mediaSha256,
      prepared.labeled.resultId, prepared.labeled.mediaSha256,
      prepared.persisted.packId, prepared.persisted.fingerprint,
      prepared.persisted.pack.continuity.fingerprint,
      JSON.stringify({
        schemaVersion: 2,
        evidence: {
          kind: "accepted-last-frame",
          sha256: prepared.evidenceMedia.sha256,
        },
        observedState: legacyObservedState,
        observedAvailability: legacyAvailability,
      }),
      legacySemantic.observer,
      legacySemantic.note,
      fingerprint,
      now,
    );
    db.prepare(`
      UPDATE studio_post_result_observation_heads
      SET revision=2,observation_id=?,observation_fingerprint=?,updated_at=?
      WHERE generation_run_id=? AND revision=1
    `).run(observationId, fingerprint, now, prepared.generationRunId);
    const legacyOperationId = "c".repeat(64);
    db.prepare(`
      INSERT INTO studio_post_result_observation_operation_receipts(
        operation_id,input_fingerprint,observation_id,outcome_fingerprint,created_at
      ) VALUES(?,?,?,?,?)
    `).run(legacyOperationId, "d".repeat(64), observationId, fingerprint, now);
    db.close();

    await expect(readStudioPostResultObservationOperationRecordReadOnly(
      fixture!.root,
      legacyOperationId,
    )).rejects.toMatchObject({
      code: "storage-invalid",
      details: [expect.stringMatching(/legacy v2 输入无法/u)],
    });

    const legacy = await readStudioPostResultObservation(fixture!.root, observationId);
    expect(legacy).toMatchObject({
      evidenceContractVersion: 2,
      current: true,
      continuationEligible: false,
      continuationIneligibleReasons: [
        "legacy-v2-observation-without-full-availability-or-lineage",
      ],
      observedState: { referenceSha256: prepared.evidenceMedia.sha256 },
    });
    expect(Object.values(legacy!.observedAvailability).every((value) => value === "unknown")).toBe(true);
    expect(legacy!.observedState.costume).toBeUndefined();
    expect(legacy!.observedState.motionVector).toBeUndefined();
  }, 60_000);

  it("Review Head 漂移后旧实际末态立即失效，不能作为下一镜真实起态", async () => {
    const prepared = await prepareReviewedPair("pass");
    const input = observationInput(prepared);
    const written = await submitStudioPostResultObservation(fixture!.root, input);
    const correction = await submitStudioGenerationReview(fixture!.root, {
      operationId: "post-result-review-correction-rework",
      generationRunId: prepared.generationRunId,
      kind: "correction",
      expectedHeadRevision: 1,
      supersedesReviewId: prepared.review.reviewId,
      rawResultId: prepared.raw.resultId,
      rawSha256: prepared.raw.mediaSha256,
      labeledResultId: prepared.labeled.resultId,
      labeledSha256: prepared.labeled.mediaSha256,
      expectedPackFingerprint: prepared.persisted.fingerprint,
      continuityFingerprint: prepared.persisted.pack.continuity.fingerprint,
      decision: "rework",
      criteria: [{ code: "fixture-visual-review", status: "fail", note: "复核改为返工。" }],
      reviewer: "post-result-test",
      note: "追加 Review correction，使旧 PASS 与实际末态失效。",
    });
    expect(correction).toMatchObject({ decision: "rework", current: true, approvedRawEligible: false });

    const stale = await readStudioPostResultObservation(fixture!.root, written.observationId);
    expect(stale).toMatchObject({
      head: true,
      current: false,
      continuationEligible: false,
    });
    expect(stale!.currentStaleReasons).toEqual(expect.arrayContaining([
      "review-head-drift",
      "review-not-current-pass",
    ]));
    await expect(getStudioPostResultObservationControl(fixture!.root, prepared.generationRunId))
      .resolves.toMatchObject({
        status: "stale",
        headRevision: 1,
        nextAction: "reobserve-current-pass-result",
      });
    await expect(submitStudioPostResultObservation(fixture!.root, {
      ...input,
      operationId: "post-result-observation-after-review-drift",
      expectedHeadRevision: 1,
    })).rejects.toMatchObject({ code: "review-ineligible" });
  }, 60_000);

  it("projection 后 Review 才漂移时最终复读仍失败关闭", async () => {
    const prepared = await prepareReviewedPair("pass");
    await submitStudioPostResultObservation(fixture!.root, observationInput(prepared));
    __setStudioPostResultObservationFinalReviewHookForTests(async () => {
      await submitStudioGenerationReview(fixture!.root, {
        operationId: "post-result-review-race-correction",
        generationRunId: prepared.generationRunId,
        kind: "correction",
        expectedHeadRevision: 1,
        supersedesReviewId: prepared.review.reviewId,
        rawResultId: prepared.raw.resultId,
        rawSha256: prepared.raw.mediaSha256,
        labeledResultId: prepared.labeled.resultId,
        labeledSha256: prepared.labeled.mediaSha256,
        expectedPackFingerprint: prepared.persisted.fingerprint,
        continuityFingerprint: prepared.persisted.pack.continuity.fingerprint,
        decision: "rework",
        criteria: [{ code: "fixture-visual-review", status: "fail", note: "最终复读前漂移。" }],
        reviewer: "post-result-test",
        note: "确定性注入 projection 后 Review correction。",
      });
    });
    const control = await getStudioPostResultObservationControl(
      fixture!.root,
      prepared.generationRunId,
    );
    expect(control).toMatchObject({
      status: "stale",
      nextAction: "reobserve-current-pass-result",
    });
    expect(control.blockers).toContain("review-rework");
  }, 90_000);

  it("projection 后 Observation Head 才推进时最终复读拒绝返回旧 head 为 current", async () => {
    const prepared = await prepareReviewedPair("pass");
    await submitStudioPostResultObservation(fixture!.root, observationInput(prepared));
    __setStudioPostResultObservationFinalReviewHookForTests(async () => {
      await submitStudioPostResultObservation(fixture!.root, observationInput(prepared, {
        operationId: "post-result-observation-head-race-successor",
        expectedHeadRevision: 1,
        note: "确定性注入 projection 后新的 Observation Head。",
      }));
    });
    const control = await getStudioPostResultObservationControl(
      fixture!.root,
      prepared.generationRunId,
    );
    expect(control).toMatchObject({
      status: "stale",
      headRevision: 2,
      nextAction: "reobserve-current-pass-result",
    });
    expect(control.blockers).toContain("observation-head-changed-after-projection");
  }, 90_000);

  it("结果媒体漂移时读回失败关闭，不返回可承接实际末态", async () => {
    const prepared = await prepareReviewedPair("pass");
    const written = await submitStudioPostResultObservation(fixture!.root, observationInput(prepared));
    await writeFile(prepared.media.raw.imported.objectPath, Buffer.from("corrupted-result-media", "utf8"));

    const stale = await readStudioPostResultObservation(fixture!.root, written.observationId);
    expect(stale).toMatchObject({
      head: true,
      current: false,
      continuationEligible: false,
    });
    expect(stale!.currentStaleReasons).toEqual(expect.arrayContaining([
      "raw-currentness-unavailable",
      "raw-result-drift",
    ]));
    await expect(getStudioPostResultObservationControl(fixture!.root, prepared.generationRunId))
      .resolves.toMatchObject({
        status: "stale",
        nextAction: "reobserve-current-pass-result",
      });
  }, 60_000);

  it("末态 evidence CAS 在提交后损坏时立即撤销 continuation 资格", async () => {
    const prepared = await prepareReviewedPair("pass");
    const written = await submitStudioPostResultObservation(
      fixture!.root,
      observationInput(prepared),
    );
    await writeFile(prepared.evidenceMedia.objectPath, Buffer.from("corrupted-evidence-media", "utf8"));

    const stale = await readStudioPostResultObservation(fixture!.root, written.observationId);
    expect(stale).toMatchObject({
      head: true,
      current: false,
      continuationEligible: false,
    });
    expect(stale!.currentStaleReasons).toContain("evidence-media-or-terminal-panel-drift");
  }, 60_000);
});
