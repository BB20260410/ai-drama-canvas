import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { readStudioGenerationResultBundle } from "../src/core/studio-generation-ledger.js";
import { getStudioGenerationReviewControl } from "../src/core/studio-generation-review.js";
import {
  finalizeP14RealCanary,
  prepareP14RealCanary,
  reviewP14RealCanary,
} from "../scripts/p14-real-canary-orchestrator.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function createNonPlaceholderReference(root: string, name: string, seed: number): Promise<string> {
  const width = 640;
  const height = 640;
  const pixels = Buffer.alloc(width * height * 3);
  for (let offset = 0, block = 0; offset < pixels.length; offset += 32, block += 1) {
    createHash("sha256").update(`${seed}:${block}`, "utf8").digest().copy(pixels, offset);
  }
  const outputPath = path.join(root, name);
  await sharp(pixels, { raw: { width, height, channels: 3 } }).png().toFile(outputPath);
  return outputPath;
}

describe.sequential("P14 真实单图 canary 本地编排", () => {
  it("不调用生图即可隔离建库、显式解歧义、派发，并将给定 raw 原子写回后交给 user Review owner", async () => {
    const outputRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "p14-real-canary-test-")));
    roots.push(outputRoot);
    const [characterAhangPath, sceneStoneRoomPath, completeGoldenMaskPath] = await Promise.all([
      createNonPlaceholderReference(outputRoot, "character-reference.png", 11),
      createNonPlaceholderReference(outputRoot, "scene-reference.png", 22),
      createNonPlaceholderReference(outputRoot, "prop-reference.png", 33),
    ]);
    const prepared = await prepareP14RealCanary({
      outputRoot,
      runName: "orchestrator-test",
      authorityReferences: { characterAhangPath, sceneStoneRoomPath, completeGoldenMaskPath },
    });

    expect(prepared).toMatchObject({
      phase: "dispatched",
      provider: "codex",
      target: { durationSeconds: 15, panelCount: 2 },
      ambiguity: {
        surfaceText: "阿航",
        selectedAssetId: "character-ahang",
        reviewer: "codex",
      },
      dispatch: { provider: "codex", dispatchProvenance: "local-dispatch-intent" },
      authorityReferences: { mode: "real-user-assets" },
    });
    expect(prepared.ambiguity.candidateAssetIds).toEqual([
      "character-ahang",
      "character-ahang-ambiguity-candidate",
    ]);
    expect(prepared.target.assetIds).toEqual([
      "character-ahang",
      "prop-complete-golden-mask",
      "scene-stone-room",
    ]);
    expect(path.relative(prepared.runRoot, prepared.project.root)).not.toMatch(/^\.\./u);
    expect(prepared.project.root).not.toContain(path.join("projects", "codex-ai-drama-studio"));
    expect(await readStudioGenerationResultBundle(prepared.project.root, prepared.generationRunId)).toBeNull();

    const request = JSON.parse(await readFile(prepared.requestEnvelopePath, "utf8")) as Record<string, any>;
    expect(request).toMatchObject({
      schemaVersion: 1,
      kind: "p14-codex-imagegen-request-envelope",
      generation: { provider: "codex", generationRunId: prepared.generationRunId },
      request: {
        schemaVersion: 4,
        executorKind: "agent-imagegen",
        exactlyOneImage: true,
        maxCalls: 1,
      },
      outputContract: { orientation: "portrait-9:16", variant: "raw", maxCalls: 1 },
      finalizeCommandTemplate: {
        command: "commit_agent_imagegen_result_bundle",
        payload: { provider: "codex" },
      },
    });
    expect(request.request.controlReferences).toHaveLength(3);
    const maskModelAsset = request.request.modelPayload.assets.find((entry: Record<string, unknown>) => entry.assetId === "prop-complete-golden-mask");
    expect(maskModelAsset?.positiveLocks.join("\n")).toMatch(/平额|杏仁|长窄鼻梁|闭口|铆孔/u);
    expect(maskModelAsset?.negativeLocks.join("\n")).toMatch(/无冠|高额冠|无兽耳|长颈/u);
    expect(`${maskModelAsset?.identityFeatures.join("\n")}\n${maskModelAsset?.defaultPrompt}`).not.toMatch(/外展双耳|完整下颌与颈部结构/u);
    const prepareEvidence = JSON.parse(await readFile(prepared.prepareEvidencePath, "utf8")) as Record<string, any>;
    expect(prepareEvidence.gates).toMatchObject({
      independentRegistry: true,
      isolatedProject: true,
      assetCategoriesPresent: true,
      scriptAndPromptFrozen: true,
      unitIsFifteenSeconds: true,
      panelCountWithinTwoToSix: true,
      bindingCurrent: true,
      continuityReady: true,
      ambiguityExplicitlyResolved: true,
      dispatchedToCodex: true,
      realAuthorityReferences: true,
      authoritySourcesUnchanged: true,
      authorityReferencesNonPlaceholder: true,
      primaryAuthoritiesCurrent: true,
      packReferencesMatched: true,
      continuityReferencesMatched: true,
      fixtureAuthoritiesExcluded: true,
      goldenMaskDefinitionLocked: true,
      fixtureAuthoritiesExplicitlyAllowedForTest: false,
      imagegenInvokedByOrchestrator: false,
    });

    // 只用本地真 PNG 验证 finalize 编排，不调用任何生图模型。
    const rawPath = path.join(prepared.runRoot, "fixture-canary-raw.png");
    await sharp({ create: { width: 90, height: 160, channels: 3, background: "#28445f" } })
      .png({ compressionLevel: 0 })
      .toFile(rawPath);
    const rawSha256 = sha256(await readFile(rawPath));
    const finalizeInput = {
      statePath: path.join(prepared.runRoot, "canary-state.json"),
      rawPath,
      rawSha256,
      callId: "p14-fixture-call-0001",
      model: "fixture-imagegen",
      generatedAt: "2026-07-18T11:10:00.000Z",
      executionSource: "fixture-canary" as const,
    };
    const finalized = await finalizeP14RealCanary(finalizeInput);
    expect(finalized).toMatchObject({
      phase: "writeback-pending-review",
      finalization: {
        rawPath,
        rawSha256,
        bundle: {
          schemaVersion: 4,
          provider: "codex",
          status: "pending-review",
          pairComplete: true,
          raw: { mediaSha256: rawSha256, status: "pending" },
          labeled: { status: "pending" },
        },
      },
    });
    expect(finalized.finalization!.bundle.labeled.mediaSha256).not.toBe(rawSha256);
    expect(await getStudioGenerationReviewControl(finalized.project.root, finalized.generationRunId))
      .toMatchObject({ status: "unreviewed", headRevision: 0 });
    expect((await finalizeP14RealCanary(finalizeInput)).fingerprint).toBe(finalized.fingerprint);

    await expect(reviewP14RealCanary({
      statePath: path.join(finalized.runRoot, "canary-state.json"),
      decision: "reject",
      note: "拒绝纯色机械夹具；仅验证 user Review owner 路由。",
      confirmedByUser: false,
      failedCriterion: "image_quality",
    })).rejects.toThrow("--confirmed-by-user");

    // 此步是会被清理的隔离负向夹具：明示拒绝纯色图，不伪造视觉 PASS。
    const reviewInput = {
      statePath: path.join(finalized.runRoot, "canary-state.json"),
      decision: "reject" as const,
      note: "用户路由验收：拒绝纯色机械夹具；不作为正式视觉验收证据。",
      confirmedByUser: true,
      failedCriterion: "image_quality" as const,
    };
    const reviewed = await reviewP14RealCanary(reviewInput);
    expect(reviewed).toMatchObject({
      phase: "reviewed",
      review: {
        decision: "reject",
        review: { reviewer: "user", decision: "reject", current: true },
      },
    });
    expect(await getStudioGenerationReviewControl(reviewed.project.root, reviewed.generationRunId))
      .toMatchObject({ status: "reject", headRevision: 1, head: { reviewer: "user" } });
    const reviewEvidence = JSON.parse(await readFile(reviewed.review!.evidencePath, "utf8")) as Record<string, any>;
    expect(reviewEvidence).toMatchObject({
      status: "PASS",
      decision: "reject",
      reviewer: "user",
      currentStatus: "reject",
      approvedRawEligible: false,
    });
    expect((await reviewP14RealCanary(reviewInput)).fingerprint).toBe(reviewed.fingerprint);
  }, 60_000);

  it("真实 prepare 缺少三项权威参考时失败关闭", async () => {
    await expect(prepareP14RealCanary({ runName: "missing-real-authorities" }))
      .rejects.toThrow("必须显式提供阿航、石室和完整黄金面具");
  });
});
