import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { executeIdempotentCommand } from "../src/core/command-bus.js";
import { getActiveManagedStudioContext } from "../src/core/active-managed-studio-context.js";
import {
  dispatchStudioGenerationPack,
  freezeAndPersistStudioGenerationPack,
} from "../src/core/studio-generation-ledger.js";
import {
  evaluateStudioReviewTargetConsistency,
  getStudioContinuityReviewControl,
} from "../src/core/studio-continuity-review-control.js";
import { registerProject, setActiveProjectRegistration } from "../src/core/sidecar.js";
import {
  createStudioP7Fixture,
  seedStudioP7ResolvedPanelContinuity,
  type StudioP7Fixture,
} from "./helpers/studio-p7-fixture.js";

/**
 * P19 control 投影与 PASS 链路回归（规范 v2.1 §7-8/9）。
 * 夹具：P7 受管工程 + 连续性种子 + 冻结 + 派发 + 提交合成结果对（90×160 有效比例）。
 */

const originalRegistry = process.env.AI_CANVAS_REGISTRY_PATH;
const originalWorkspace = process.env.AI_CANVAS_WORKSPACE;
const originalRecordedDigest = process.env.AI_CANVAS_RECORDED_SOURCE_DIGEST;
let fixture: StudioP7Fixture | undefined;

afterEach(async () => {
  if (originalRegistry === undefined) delete process.env.AI_CANVAS_REGISTRY_PATH;
  else process.env.AI_CANVAS_REGISTRY_PATH = originalRegistry;
  if (originalWorkspace === undefined) delete process.env.AI_CANVAS_WORKSPACE;
  else process.env.AI_CANVAS_WORKSPACE = originalWorkspace;
  if (originalRecordedDigest === undefined) delete process.env.AI_CANVAS_RECORDED_SOURCE_DIGEST;
  else process.env.AI_CANVAS_RECORDED_SOURCE_DIGEST = originalRecordedDigest;
  if (fixture) await fixture.cleanup();
  fixture = undefined;
});

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe.sequential("P19 control consistency 段", () => {
  it("可选段语义：未评估/已评估/不可用；不进 fingerprint；PASS 链路不变", async () => {
    delete process.env.AI_CANVAS_RECORDED_SOURCE_DIGEST;
    process.env.AI_CANVAS_REGISTRY_PATH = path.join("/tmp", `ai-canvas-p19-control-registry-${process.pid}-${Date.now()}`, "projects.json");
    fixture = await createStudioP7Fixture();
    const identityWorkspace = path.join(fixture.parentRoot, "stable-build-identity");
    await mkdir(path.join(identityWorkspace, "src", "mcp"), { recursive: true });
    await Promise.all([
      writeFile(path.join(identityWorkspace, "package.json"), `${JSON.stringify({ name: "ai-drama-canvas", version: "0.2.0" })}\n`),
      writeFile(path.join(identityWorkspace, "src", "mcp", "server.ts"), "server.registerTool(\"fixture\", {}, () => ({}));\n"),
    ]);
    process.env.AI_CANVAS_WORKSPACE = identityWorkspace;
    await registerProject(fixture.shell.project);
    await setActiveProjectRegistration(fixture.root);

    const unit = fixture.units.twoPanel;
    const panel = unit.panels[0]!;
    const assetIds = panel.assets.filter((asset) => asset.presence !== "forbidden").map((asset) => asset.assetId);

    // 无 generation run 时：consistency 段缺省（review? 同款可选语义）。
    const withoutRun = await getStudioContinuityReviewControl(fixture.root, {
      unitId: unit.unit.id,
      unitRevision: unit.unit.revision,
      panelId: panel.id,
      startMilliseconds: 0,
      endMilliseconds: 15_000,
      assetIds,
    });
    expect(withoutRun.consistency).toBeUndefined();

    await seedStudioP7ResolvedPanelContinuity(fixture.root, {
      unitId: unit.unit.id,
      panelId: panel.id,
      assetIds,
    });
    const frozen = await freezeAndPersistStudioGenerationPack(fixture.root, {
      unitId: unit.unit.id,
      panelId: panel.id,
    });
    const generationRunId = "p19-control-codex-run-0001";
    await dispatchStudioGenerationPack(fixture.root, {
      packId: frozen.packId,
      packFingerprint: frozen.fingerprint,
      generationRunId,
      provider: "codex",
    });

    // 有 run 但账本尚无结果行：run 无法自解析，consistency 段缺省；显式评估 → unavailable(result-pair-missing)。
    const beforeBundle = await getStudioContinuityReviewControl(fixture.root, {
      unitId: unit.unit.id,
      unitRevision: unit.unit.revision,
      panelId: panel.id,
      startMilliseconds: 0,
      endMilliseconds: 15_000,
      assetIds,
    });
    expect(beforeBundle.consistency).toBeUndefined();
    const unavailable = await evaluateStudioReviewTargetConsistency(fixture.root, { generationRunId });
    expect(unavailable.status).toBe("unavailable");
    expect(unavailable.reason).toBe("result-pair-missing");

    // 提交合成结果对（90×160 与夹具面板比例一致）。
    const context = await getActiveManagedStudioContext();
    const rawPath = path.join(fixture.root, "fixture-inputs", "p19-control-codex-run-0001_raw.png");
    await sharp({ create: { width: 90, height: 160, channels: 3, background: "#25384f" } })
      .png({ compressionLevel: 0 })
      .toFile(rawPath);
    await executeIdempotentCommand(fixture.root, {
      requestId: "p19-control-bundle-request-1",
      idempotencyKey: "p19-control-bundle-idem-1",
      request: {
        command: "commit_agent_imagegen_result_bundle",
        payload: {
          projectContextToken: context.projectContextToken,
          packId: frozen.packId,
          packFingerprint: frozen.fingerprint,
          generationRunId,
          provider: "codex",
          rawPath,
          rawSha256: sha256(await readFile(rawPath)),
          expectedRevision: frozen.pack.target.unitRevision,
          executionReceipt: {
            schemaVersion: 1,
            kind: "agent-imagegen-execution-receipt",
            provider: "codex",
            source: "fixture-canary",
            attestationLevel: "unverified-external-agent",
            cryptographicProviderReceipt: false,
            callId: "codex-p19-control-call-0001",
            model: "fixture-imagegen",
            generatedAt: "2026-07-19T08:01:00.000Z",
          },
        },
      },
    });

    const controlInput = {
      unitId: unit.unit.id,
      unitRevision: unit.unit.revision,
      panelId: panel.id,
      startMilliseconds: 0,
      endMilliseconds: 15_000,
      assetIds,
    } as const;
    const [withoutFlag, withFlag] = await Promise.all([
      getStudioContinuityReviewControl(fixture.root, { ...controlInput }),
      getStudioContinuityReviewControl(fixture.root, { ...controlInput, evaluateConsistency: true }),
    ]);

    // 默认只反映未评估态；显式才评估。
    expect(withoutFlag.consistency?.status).toBe("not-evaluated");
    expect(withFlag.consistency?.status).toBe("evaluated");
    const evaluation = withFlag.consistency?.evaluation;
    expect(evaluation?.kind).toBe("studio-consistency-evaluation");
    expect(evaluation?.evidence.generationRunId).toBe(generationRunId);
    expect(evaluation?.evidence.packFingerprint).toBe(frozen.fingerprint);
    expect(evaluation?.evidence.resultSha256).toBeTruthy();
    expect(evaluation?.evidence.referenceSha256.length).toBeGreaterThan(0);
    expect(evaluation?.evidence.evaluatorVersion).toMatch(/^p19-evaluator-/u);
    expect(evaluation!.assets.length).toBeGreaterThan(0);
    expect(evaluation!.assets.length).toBeLessThanOrEqual(6);
    for (const asset of evaluation!.assets) {
      expect(asset.criteria.length).toBeGreaterThan(0);
      expect(["consistent", "needs-review", "drifted", "not-checkable"]).toContain(asset.verdict);
    }

    // consistency 段不进入 fingerprint。
    expect(withFlag.fingerprint).toBe(withoutFlag.fingerprint);

    // PASS 链路回归：review/checkpoint/nextAction/resolvedRun 在两种读取下完全一致。
    expect(withFlag.review?.control).toEqual(withoutFlag.review?.control);
    expect(withFlag.checkpoint).toEqual(withoutFlag.checkpoint);
    expect(withFlag.nextAction).toEqual(withoutFlag.nextAction);
    expect(withFlag.resolvedGenerationRunId).toBe(withoutFlag.resolvedGenerationRunId);

    // 显式评估路径的共享构建器与 control 段一致（同键同结果）。
    const direct = await evaluateStudioReviewTargetConsistency(fixture.root, { generationRunId });
    expect(direct.status).toBe("evaluated");
    expect(direct.evaluation?.evidence).toEqual(evaluation?.evidence);
    expect(direct.evaluation?.computedAt).toBe(evaluation?.computedAt);
  }, 120_000);
});
