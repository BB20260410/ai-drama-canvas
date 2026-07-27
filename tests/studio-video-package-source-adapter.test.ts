import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildManagedEvidenceVideoPackageSource,
  managedEvidenceVideoPackageSourceAdapter,
  type ManagedEvidenceVideoPackageSourceInput,
  type StudioVideoPackageSourceAdapterError,
} from "../src/core/studio-video-package-source-adapter.js";
import {
  prepareStudioVideoPackageSource,
  type StudioVideoPackageError,
} from "../src/core/studio-video-package.js";
import { submitStudioGenerationReview } from "../src/core/studio-generation-review.js";
import {
  getStudioProductionUnitSnapshot,
  reviseStudioProductionUnit,
} from "../src/core/studio-production.js";
import {
  getStudioPostResultObservationControl,
  submitStudioPostResultObservation,
} from "../src/core/studio-post-result-observation.js";
import {
  commitUnitGridBundle,
  createUnitGridTestImage,
  createUnitGridFixtureProject,
  freezeDispatchPrepareUnitGrid,
  passUnitGridReview,
  unitGridFixtureDigest,
} from "./helpers/studio-unit-grid-fixture.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function readyCurrentPass(tag: string) {
  const parent = await realpath(await mkdtemp(path.join(tmpdir(), `managed-video-source-${tag}-`)));
  roots.push(parent);
  const fixture = await createUnitGridFixtureProject(parent, {
    unitId: "unit-video-source-001",
    season: "MYTH-S2",
    episode: "E07",
  });
  const run = await freezeDispatchPrepareUnitGrid(
    fixture.root,
    fixture.unitId,
    `managed-video-source-run-${tag}`,
  );
  const bundle = await commitUnitGridBundle(fixture.root, run, `managed-video-source-${tag}`);
  const review = await passUnitGridReview(
    fixture.root,
    run,
    bundle,
    `managed-video-source-review-${tag}`,
  );
  const snapshot = await getStudioProductionUnitSnapshot(fixture.root, fixture.unitId);
  if (!snapshot) throw new Error("fixture unit missing");
  const observationControl = await getStudioPostResultObservationControl(
    fixture.root,
    review.generationRunId,
  );
  const input: ManagedEvidenceVideoPackageSourceInput = {
    reviewId: review.reviewId,
    expectedReviewFingerprint: review.fingerprint,
    expectedPackFingerprint: run.pack.fingerprint,
    expectedUnitSnapshotFingerprint: snapshot.fingerprint,
    expectedObservationControlFingerprint: observationControl.fingerprint,
    expectedObservationHeadRevision: observationControl.headRevision,
    expectedObservationStatus: observationControl.status,
    expectedObservationHeadId: observationControl.head?.observationId ?? null,
    expectedObservationHeadFingerprint: observationControl.head?.fingerprint ?? null,
    expectedObservationEvidenceSha256: observationControl.head?.evidenceSha256 ?? null,
  };
  return { fixture, run, bundle, review, snapshot, input };
}

async function refreshedSourceInput(
  current: Awaited<ReturnType<typeof readyCurrentPass>>,
): Promise<ManagedEvidenceVideoPackageSourceInput> {
  const control = await getStudioPostResultObservationControl(
    current.fixture.root,
    current.review.generationRunId,
  );
  return {
    ...current.input,
    expectedObservationControlFingerprint: control.fingerprint,
    expectedObservationHeadRevision: control.headRevision,
    expectedObservationStatus: control.status,
    expectedObservationHeadId: control.head?.observationId ?? null,
    expectedObservationHeadFingerprint: control.head?.fingerprint ?? null,
    expectedObservationEvidenceSha256: control.head?.evidenceSha256 ?? null,
  };
}

async function submitCurrentObservation(
  current: Awaited<ReturnType<typeof readyCurrentPass>>,
  tag: string,
  evidenceKind: "accepted-last-frame" | "terminal-panel-crop" = "accepted-last-frame",
) {
  const evidence = await createUnitGridTestImage(
    current.fixture.root,
    `managed-video-source-${tag}-terminal-evidence`,
    "#172f48",
  );
  const terminalPanel = [...current.run.pack.pack.panels].sort((left, right) =>
    left.endSeconds - right.endSeconds
    || left.order - right.order
    || left.panelId.localeCompare(right.panelId, "en")).at(-1);
  if (!terminalPanel) throw new Error("fixture terminal panel missing");
  const observation = await submitStudioPostResultObservation(current.fixture.root, {
    operationId: `managed-video-source-observation-${tag}`,
    generationRunId: current.review.generationRunId,
    expectedHeadRevision: 0,
    expectedReviewId: current.review.reviewId,
    expectedReviewFingerprint: current.review.fingerprint,
    rawResultId: current.review.rawResultId,
    rawSha256: current.review.rawSha256,
    labeledResultId: current.review.labeledResultId,
    labeledSha256: current.review.labeledSha256,
    packId: current.review.packId,
    packFingerprint: current.review.packFingerprint,
    plannedContinuityFingerprint: current.review.continuityFingerprint,
    evidenceKind,
    evidenceSha256: evidence.sha256,
    ...(evidenceKind === "terminal-panel-crop"
      ? { terminalPanelId: terminalPanel.panelId }
      : {}),
    observedState: {
      costume: "实际末格中阿航保持素麻古蜀服。",
      injury: "unknown: STATIC_INJURY_SENTINEL",
      heldObject: "not-applicable: STATIC_HELD_SENTINEL",
      position: "实际末格位于石室中央偏右。",
      facing: "实际末格回头看向画面左侧。",
      emotion: "实际末格神情警觉。",
      layout: "实际末格阿航在右、石墙在后。",
      lighting: "实际末格为左侧暖火光与右侧冷暗部。",
      referenceSha256: evidence.sha256,
      motionVector: "静态末格无法证明动作余势。",
      cameraPhase: "静态末格无法证明镜头运动阶段。",
      focusState: "未知：STATIC_FOCUS_SENTINEL",
      audioPhase: "静帧无法判断环境声尾相。",
    },
    observedAvailability: {
      costume: "observed",
      injury: "unknown",
      heldObject: "not-applicable",
      position: "observed",
      facing: "observed",
      emotion: "observed",
      layout: "observed",
      lighting: "observed",
      motionVector: "unknown",
      cameraPhase: "not-applicable",
      focusState: "unknown",
      audioPhase: "unknown",
    },
    observer: "managed-video-source-test",
    note: "只把受管末格裁图中人工观察到的实际末态接入视频来源。",
  });
  return { evidence, terminalPanel, observation };
}

describe("managed-evidence Studio video package source adapter", () => {
  it("经既有视频包 facade 只读准备 managed-evidence-v1，且不引入项目路径或伪造声音/实际末态", async () => {
    const current = await readyCurrentPass("facade");
    const direct = await buildManagedEvidenceVideoPackageSource(current.fixture.root, current.input);
    const prepared = await prepareStudioVideoPackageSource(current.fixture.root, {
      adapterKind: "managed-evidence-v1",
      ...current.input,
    });

    expect(prepared).toEqual(direct);
    expect(JSON.stringify(prepared)).not.toContain(current.fixture.root);
    expect(prepared.panels.every((panel) =>
      panel.sound.voiceover === null
      && panel.sound.soundEffects === null
      && panel.sound.unspecifiedStatus === "unknown")).toBe(true);
    expect(prepared.continuity).toEqual({
      planned: {
        status: "frozen-plan",
        fingerprint: current.run.pack.pack.continuityFingerprint,
      },
      previousActual: {
        status: "unknown",
        endState: null,
        sourceFingerprint: null,
        reason: "first-unit-or-no-continuation-source",
      },
      observed: {
        status: "unknown",
        endState: null,
        evidenceFingerprint: null,
        reason: "post-result-observation-not-provided",
      },
    });

    await expect(prepareStudioVideoPackageSource(current.fixture.root, {
      adapterKind: "managed-evidence-v1",
      ...current.input,
      productionRoot: "/tmp/forbidden-project-specific-path",
    } as never)).rejects.toMatchObject({
      code: "invalid-input",
    } satisfies Partial<StudioVideoPackageError>);
    await expect(prepareStudioVideoPackageSource(current.fixture.root, {
      adapterKind: "legacy-dudu-v3",
      ...current.input,
    } as never)).rejects.toMatchObject({
      code: "invalid-input",
    } satisfies Partial<StudioVideoPackageError>);
  }, 120_000);

  it("从非 Dudu 受管路径的 current PASS unit-grid 建立完整、稳定的内容寻址来源规范", async () => {
    const current = await readyCurrentPass("success");
    expect(current.fixture.root).not.toMatch(/dudu/iu);

    const first = await buildManagedEvidenceVideoPackageSource(current.fixture.root, current.input);
    const replay = await managedEvidenceVideoPackageSourceAdapter.build(current.fixture.root, current.input);

    expect(first).toEqual(replay);
    expect(first.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.id).toBe(`studio-video-package-source-${first.fingerprint.slice(0, 40)}`);
    expect(first).toMatchObject({
      schemaVersion: 1,
      kind: "studio-video-package-source-spec",
      adapterKind: "managed-evidence-v1",
      unit: {
        unitId: current.fixture.unitId,
        seasonId: "MYTH-S2",
        episodeId: "E07",
        durationSeconds: 15,
        panelCount: 2,
      },
      evidence: {
        reviewId: current.review.reviewId,
        reviewFingerprint: current.review.fingerprint,
        packFingerprint: current.run.pack.fingerprint,
        rawSha256: current.bundle.raw.mediaSha256,
        labeledSha256: current.bundle.labeled.mediaSha256,
      },
      continuity: {
        planned: { status: "frozen-plan" },
        observed: {
          status: "unknown",
          endState: null,
          evidenceFingerprint: null,
          reason: "post-result-observation-not-provided",
        },
      },
    });
    expect(first.references.map((entry) => entry.mediaSha256))
      .toEqual(current.run.pack.pack.request.controlReferences.map((entry) => entry.mediaSha256).sort());
    expect(first.panels).toHaveLength(2);
    expect(first.panels.map((panel) => [panel.panelIndex, panel.timecode.unitStartSeconds, panel.timecode.unitEndSeconds]))
      .toEqual([[1, 0, 7], [2, 7, 15]]);
    expect(first.panels[0]).toMatchObject({
      visualAction: "阿航走入石室。",
      shotComposition: "中景居中。",
      cameraMovement: "稳定器跟拍。",
      dialogue: "阿航：别出声。",
      subtitle: "别出声",
      positivePrompt: "只生成一张电影写实分镜，保持阿航一致。",
      observed: { status: "unknown", endState: null },
      sound: {
        dialogueSource: "canonical-panel",
        subtitleSource: "canonical-panel",
        voiceover: null,
        soundEffects: null,
        unspecifiedStatus: "unknown",
      },
    });
    expect(first.panels[0]!.negativePrompt).toContain("禁止换脸");
    expect(first.panels[0]!.negativePrompt).toContain("禁止半面具");
  }, 120_000);

  it("无专用 lineage receipt 的 accepted-last-frame 只保留审计，不进入 actual 投影", async () => {
    const current = await readyCurrentPass("observed-current");
    const withoutObservation = await buildManagedEvidenceVideoPackageSource(
      current.fixture.root,
      current.input,
    );
    const submitted = await submitCurrentObservation(current, "observed-current");
    await expect(buildManagedEvidenceVideoPackageSource(current.fixture.root, current.input))
      .rejects.toMatchObject({ code: "evidence-drift" });
    const refreshedInput = await refreshedSourceInput(current);
    const source = await buildManagedEvidenceVideoPackageSource(current.fixture.root, refreshedInput);
    const replay = await buildManagedEvidenceVideoPackageSource(current.fixture.root, refreshedInput);

    expect(source).toEqual(replay);
    expect(source.fingerprint).not.toBe(withoutObservation.fingerprint);
    expect(source.panels[0]!.observed).toEqual({
      status: "unknown",
      endState: null,
      evidenceFingerprint: null,
      reason: "post-result-observation-not-current",
    });
    expect(source.panels.at(-1)!.panelId).toBe(submitted.terminalPanel.panelId);
    expect(source.panels.at(-1)!.observed).toEqual({
      status: "unknown",
      endState: null,
      evidenceFingerprint: null,
      reason: "post-result-observation-not-current",
    });
    expect(submitted.observation.continuationIneligibleReasons).toContain(
      "accepted-last-frame-without-specialized-lineage-receipt",
    );
    expect(JSON.stringify(source)).not.toContain("静态末格无法证明动作余势");
    expect(JSON.stringify(source)).not.toContain("静态末格无法证明镜头运动阶段");
    expect(JSON.stringify(source)).not.toContain("静帧无法判断环境声尾相");
    expect(JSON.stringify(source)).not.toContain("STATIC_INJURY_SENTINEL");
    expect(JSON.stringify(source)).not.toContain("STATIC_HELD_SENTINEL");
    expect(JSON.stringify(source)).not.toContain("STATIC_FOCUS_SENTINEL");
    expect(source.continuity.observed).toEqual(source.panels.at(-1)!.observed);
    expect(source.panels.slice(0, -1).every((panel) => panel.observed.status === "unknown")).toBe(true);
  }, 120_000);

  it("没有可信 raw 派生收据的 terminal-panel-crop 不进入视频续接来源", async () => {
    const current = await readyCurrentPass("untrusted-terminal-crop");
    const submitted = await submitCurrentObservation(
      current,
      "untrusted-terminal-crop",
      "terminal-panel-crop",
    );
    expect(submitted.observation).toMatchObject({
      current: true,
      continuationEligible: false,
      continuationIneligibleReasons: [
        "terminal-panel-crop-without-trusted-raw-derivation-receipt",
      ],
    });
    await expect(buildManagedEvidenceVideoPackageSource(current.fixture.root, current.input))
      .rejects.toMatchObject({ code: "evidence-drift" });
    const source = await buildManagedEvidenceVideoPackageSource(
      current.fixture.root,
      await refreshedSourceInput(current),
    );
    expect(source.continuity.observed).toEqual({
      status: "unknown",
      endState: null,
      evidenceFingerprint: null,
      reason: "post-result-observation-not-current",
    });
  }, 120_000);

  it("末态证据 CAS 漂移后只降级为 unknown，不把旧观察继续交给视频链", async () => {
    const current = await readyCurrentPass("observed-stale");
    const submitted = await submitCurrentObservation(current, "observed-stale");
    await writeFile(submitted.evidence.objectPath, Buffer.from("corrupted-observation-evidence", "utf8"));

    await expect(buildManagedEvidenceVideoPackageSource(current.fixture.root, current.input))
      .rejects.toMatchObject({ code: "evidence-drift" });
    const source = await buildManagedEvidenceVideoPackageSource(
      current.fixture.root,
      await refreshedSourceInput(current),
    );
    expect(source.continuity.observed).toEqual({
      status: "unknown",
      endState: null,
      evidenceFingerprint: null,
      reason: "post-result-observation-not-current",
    });
    expect(source.panels.every((panel) => panel.observed.status === "unknown")).toBe(true);
    expect(source.evidence.observationControl.headId).toBe(submitted.observation.observationId);
    const projectedContinuity = JSON.stringify({
      panels: source.panels,
      continuity: source.continuity,
    });
    expect(projectedContinuity).not.toContain(submitted.observation.observationId);
    expect(projectedContinuity).not.toContain(submitted.observation.observedState.position);
  }, 120_000);

  it("旧 v1 观察即使仍是 observation Head，也不得进入末格或 continuity", async () => {
    const current = await readyCurrentPass("observed-legacy");
    const submitted = await submitCurrentObservation(current, "observed-legacy");
    const legacyObservedState = {
      costume: "旧事件服装。",
      injury: "旧事件伤势。",
      heldObject: "旧事件持物。",
      position: "旧事件声称的站位绝不能进入通用视频来源。",
      facing: "旧事件朝向。",
      emotion: "旧事件情绪。",
      layout: "旧事件布局。",
      lighting: "旧事件光线。",
      motionVector: "旧事件动作余势。",
      cameraPhase: "旧事件镜头阶段。",
      focusState: "旧事件焦点。",
      audioPhase: "旧事件声音尾相。",
      referenceSha256: current.review.rawSha256,
    };
    const legacySemantic = {
      schemaVersion: 1,
      kind: "studio-post-result-observation",
      generationRunId: current.review.generationRunId,
      baseHeadRevision: 1,
      headRevision: 2,
      reviewId: current.review.reviewId,
      reviewFingerprint: current.review.fingerprint,
      rawResultId: current.review.rawResultId,
      rawSha256: current.review.rawSha256,
      labeledResultId: current.review.labeledResultId,
      labeledSha256: current.review.labeledSha256,
      packId: current.review.packId,
      packFingerprint: current.review.packFingerprint,
      plannedContinuityFingerprint: current.review.continuityFingerprint,
      observedState: legacyObservedState,
      observer: "managed-video-source-legacy-test",
      note: "模拟历史 v1 事件，仅有整张 raw 绑定，不具备末格证据。",
    };
    const fingerprint = unitGridFixtureDigest(legacySemantic);
    const observationId = `studio-post-result-observation-${fingerprint.slice(0, 40)}`;
    const now = new Date().toISOString();
    const db = new DatabaseSync(
      path.join(current.fixture.root, ".aicanvas/studio-generation-ledger.sqlite"),
    );
    try {
      db.exec("PRAGMA foreign_keys=ON");
      db.prepare(`
        INSERT INTO studio_post_result_observation_events(
          observation_id,generation_run_id,base_head_revision,head_revision,review_id,review_fingerprint,
          raw_result_id,raw_sha256,labeled_result_id,labeled_sha256,pack_id,pack_fingerprint,
          planned_continuity_fingerprint,observed_state_json,observer,note,fingerprint,created_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        observationId,
        current.review.generationRunId,
        1,
        2,
        current.review.reviewId,
        current.review.fingerprint,
        current.review.rawResultId,
        current.review.rawSha256,
        current.review.labeledResultId,
        current.review.labeledSha256,
        current.review.packId,
        current.review.packFingerprint,
        current.review.continuityFingerprint,
        JSON.stringify(legacyObservedState),
        legacySemantic.observer,
        legacySemantic.note,
        fingerprint,
        now,
      );
      db.prepare(`
        UPDATE studio_post_result_observation_heads
        SET revision=2,observation_id=?,observation_fingerprint=?,updated_at=?
        WHERE generation_run_id=? AND revision=1
      `).run(observationId, fingerprint, now, current.review.generationRunId);
    } finally {
      db.close();
    }

    await expect(buildManagedEvidenceVideoPackageSource(current.fixture.root, current.input))
      .rejects.toMatchObject({ code: "evidence-drift" });
    const source = await buildManagedEvidenceVideoPackageSource(
      current.fixture.root,
      await refreshedSourceInput(current),
    );
    expect(source.continuity.observed).toEqual({
      status: "unknown",
      endState: null,
      evidenceFingerprint: null,
      reason: "post-result-observation-not-current",
    });
    expect(source.panels.every((panel) => panel.observed.status === "unknown")).toBe(true);
    expect(source.evidence.observationControl.headId).toBe(observationId);
    const projectedContinuity = JSON.stringify({
      panels: source.panels,
      continuity: source.continuity,
    });
    expect(projectedContinuity).not.toContain(legacyObservedState.position);
    expect(projectedContinuity).not.toContain(observationId);
  }, 120_000);

  it("旧 Review Head 与当前非 PASS Review 均失败关闭", async () => {
    const current = await readyCurrentPass("review-gates");
    const correction = await submitStudioGenerationReview(current.fixture.root, {
      operationId: "managed-video-source-review-rework",
      generationRunId: current.review.generationRunId,
      kind: "correction",
      expectedHeadRevision: 1,
      supersedesReviewId: current.review.reviewId,
      rawResultId: current.review.rawResultId,
      rawSha256: current.review.rawSha256,
      labeledResultId: current.review.labeledResultId,
      labeledSha256: current.review.labeledSha256,
      expectedPackFingerprint: current.review.packFingerprint,
      continuityFingerprint: current.review.continuityFingerprint,
      decision: "rework",
      criteria: [{ code: "identity", status: "fail", note: "fixture 明确拒绝。" }],
      reviewer: "managed-video-source-test",
      note: "建立非 PASS 当前 Head，用于验证导出失败关闭。",
    });

    await expect(buildManagedEvidenceVideoPackageSource(current.fixture.root, current.input))
      .rejects.toMatchObject({
        code: "review-not-current-pass",
      } satisfies Partial<StudioVideoPackageSourceAdapterError>);
    await expect(buildManagedEvidenceVideoPackageSource(current.fixture.root, {
      ...current.input,
      reviewId: correction.reviewId,
      expectedReviewFingerprint: correction.fingerprint,
    })).rejects.toMatchObject({
      code: "review-not-current-pass",
    } satisfies Partial<StudioVideoPackageSourceAdapterError>);
  }, 120_000);

  it("调用方旧 pack/unit 指纹及结果产生后的 unit 漂移均被拒绝", async () => {
    const current = await readyCurrentPass("fingerprint-gates");
    await expect(buildManagedEvidenceVideoPackageSource(current.fixture.root, {
      ...current.input,
      expectedPackFingerprint: "0".repeat(64),
    })).rejects.toMatchObject({
      code: "evidence-drift",
    } satisfies Partial<StudioVideoPackageSourceAdapterError>);

    await reviseStudioProductionUnit(current.fixture.root, {
      unitId: current.fixture.unitId,
      expectedRevision: current.snapshot.unit.revision,
      season: current.snapshot.unit.season,
      episode: current.snapshot.unit.episode,
      sequence: current.snapshot.unit.sequence,
      title: "修订后单元",
      durationSeconds: current.snapshot.unit.durationSeconds,
      scriptRevisionId: current.snapshot.unit.scriptRevisionId,
      panels: current.snapshot.panels.map((panel) => ({
        id: panel.id,
        title: panel.title,
        visualAction: panel.visualAction,
        shotComposition: panel.shotComposition,
        filmingMethod: panel.filmingMethod,
        dialogue: panel.dialogue,
        subtitle: panel.subtitle,
        startSeconds: panel.startSeconds,
        endSeconds: panel.endSeconds,
        durationSeconds: panel.durationSeconds,
        promptRevisionId: panel.promptRevisionId,
        sourceSpans: panel.sourceSpans.map((span) => ({
          startOffsetUtf16: span.startOffsetUtf16,
          endOffsetUtf16: span.endOffsetUtf16,
        })),
        assets: panel.assets.map((asset) => ({
          assetId: asset.assetId,
          category: asset.category,
          presence: asset.presence,
          role: asset.role,
          continuityState: asset.continuityState,
          evidence: asset.evidence.map((evidence) => ({
            kind: evidence.kind,
            reference: evidence.reference,
            note: evidence.note,
          })),
        })),
        transition: panel.transition,
        costumeState: panel.costumeState,
        sceneLighting: panel.sceneLighting,
        shotType: panel.shotType,
        negativePrompt: panel.negativePrompt,
      })),
    });
    await expect(buildManagedEvidenceVideoPackageSource(current.fixture.root, current.input))
      .rejects.toMatchObject({
        code: "review-not-current-pass",
      } satisfies Partial<StudioVideoPackageSourceAdapterError>);
  }, 120_000);
});
