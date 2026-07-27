import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { getActiveManagedStudioContext } from "../src/core/active-managed-studio-context.js";
import {
  evaluateStudioReviewTargetConsistency,
  getStudioContinuityReviewControl,
} from "../src/core/studio-continuity-review-control.js";
import {
  finalizeDuduReadonlyManagedProject,
  stageDuduReadonlyManagedProject,
} from "../src/core/dudu-readonly-import.js";
import { inspectDuduReadonlySources } from "../src/core/dudu-readonly-source.js";
import { commitAgentImagegenResultBundle } from "../src/core/studio-agent-imagegen-result-bundle.js";
import {
  dispatchStudioGenerationPack,
  prepareStudioImagegenCall,
  readStudioUnitGridGenerationFrozenPack,
} from "../src/core/studio-generation-ledger.js";
import {
  createDuduReadonlySourceFixture,
} from "./helpers/dudu-readonly-source-fixture.js";

/**
 * P30 S3：unit-grid Review 一致性辅助必须按 target-aware 路径读取。
 * 回归锚：旧 buildStudioConsistencyEvaluationRequest 只对 panel pack 取 readStudioGenerationFrozenPack，
 * 遇到 unit-grid 冻结包直接抛出并使整个 Review 控制面加载失败。
 * 只允许临时夹具；不生图、不调真实模型。
 */

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe.sequential("P30 unit-grid Review 一致性辅助 target-aware", () => {
  it("unit-grid 结果对的一致性请求覆盖全板参考闭包，Review 控制面与显式评估均不抛错", async () => {
    const fixture = await createDuduReadonlySourceFixture();
    const priorRegistry = process.env.AI_CANVAS_REGISTRY_PATH;
    process.env.AI_CANVAS_REGISTRY_PATH = fixture.registryPath;
    try {
      const staged = await stageDuduReadonlyManagedProject({
        projectsRoot: fixture.projectsRoot,
        source: fixture.source,
      });
      const projectRoot = staged.shell.paths.root;
      await finalizeDuduReadonlyManagedProject(projectRoot, fixture.source);
      // 动态选择 binding-ready 且 storyboard pending 的单元（历史 PASS 单元禁止真实 dispatch）。
      const inspection = await inspectDuduReadonlySources(fixture.source);
      const targetUnitId = inspection.computedProjection.pendingStoryboardUnitIds
        .find((unitId) => inspection.computedProjection.bindingReadyUnitIds.includes(unitId));
      if (!targetUnitId) throw new Error("夹具缺少 binding-ready pending 单元。 ");
      const targetReceipt = staged.receipt.units.find((unit) => unit.unitId === targetUnitId)!;
      const pack = await readStudioUnitGridGenerationFrozenPack(projectRoot, targetReceipt.packId!);
      expect(pack).not.toBeNull();
      const generationRunId = "p30-consistency-unit-grid-run-1";
      await dispatchStudioGenerationPack(projectRoot, {
        packId: pack!.id,
        packFingerprint: pack!.fingerprint,
        generationRunId,
        provider: "codex",
      });
      const context = await getActiveManagedStudioContext();
      const call = await prepareStudioImagegenCall(projectRoot, {
        packId: pack!.id,
        packFingerprint: pack!.fingerprint,
        generationRunId,
        provider: "codex",
        projectContextToken: context.projectContextToken,
        commandRequestId: "p30-consistency-unit-grid-prepare",
        expectedRevision: 0,
      });
      expect(call).toMatchObject({ callAllowed: true, status: "generation_unknown" });
      const rawPath = path.join(fixture.root, "p30-consistency-unit-grid-raw.png");
      await sharp({
        create: { width: 900, height: 1600, channels: 3, background: { r: 52, g: 68, b: 96 } },
      }).png({ compressionLevel: 9 }).toFile(rawPath);
      const rawBytes = await readFile(rawPath);
      await commitAgentImagegenResultBundle(projectRoot, {
        projectContextToken: context.projectContextToken,
        packId: pack!.id,
        packFingerprint: pack!.fingerprint,
        generationRunId,
        provider: "codex",
        rawPath,
        rawSha256: sha256(rawBytes),
        expectedRevision: pack!.target.unitRevision,
        executionReceipt: {
          schemaVersion: 1,
          kind: "agent-imagegen-execution-receipt",
          provider: "codex",
          source: "fixture-canary",
          attestationLevel: "unverified-external-agent",
          cryptographicProviderReceipt: false,
          callId: call.callId,
          model: "fixture-no-model",
          generatedAt: "2026-07-22T00:00:00.000Z",
        },
      });

      // 默认 Review 控制面加载（不触发像素评估）也必须可加载 unit-grid：不再抛
      // “必须使用 unit-grid 读取入口”；consistency 段按缓存语义给出未评估/不可用而非异常。
      const control = await getStudioContinuityReviewControl(projectRoot, {
        unitId: targetUnitId,
        panelId: pack!.panels[0]!.panelId,
        unitRevision: pack!.target.unitRevision,
        startMilliseconds: 0,
        endMilliseconds: Math.round(pack!.panels[0]!.durationSeconds * 1000),
        assetIds: [],
        generationRunId,
      });
      expect(control.review?.control).toMatchObject({ generationRunId });
      expect(control.consistency === undefined
        || control.consistency.status === "not-evaluated"
        || control.consistency.status === "evaluated"
        || control.consistency.status === "unavailable").toBe(true);

      // 显式评估：参考闭包必须覆盖全板逐格 panel pack 的资产并集（禁止首格冒充）。
      const evaluated = await evaluateStudioReviewTargetConsistency(projectRoot, { generationRunId });
      expect(evaluated.status).toBe("evaluated");
      if (evaluated.status !== "evaluated" || !evaluated.evaluation) throw new Error("unit-grid 显式一致性评估未闭合。");
      const expectedAssetKeys = new Set(pack!.panels.flatMap((panel) => panel.panelPack.assets.map((asset) => `${asset.assetId} ${asset.version.id}`)));
      expect(evaluated.evaluation.assets.length).toBe(expectedAssetKeys.size);
      expect(new Set(evaluated.evaluation.assets.map((asset) => `${asset.assetId} ${asset.reference.assetVersionId}`)))
        .toEqual(expectedAssetKeys);
      expect(["consistent", "needs-review", "drifted", "not-checkable"]).toContain(evaluated.evaluation.verdict);
    } finally {
      if (priorRegistry === undefined) delete process.env.AI_CANVAS_REGISTRY_PATH;
      else process.env.AI_CANVAS_REGISTRY_PATH = priorRegistry;
      await fixture.cleanup();
    }
  }, 240_000);
});
