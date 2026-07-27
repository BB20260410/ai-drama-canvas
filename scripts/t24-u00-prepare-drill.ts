/**
 * T24 真实 S1E1 U00 零扣费全链演练：freeze → plan → dispatch → prepare。
 * 到 prepare 为止，不执行真实 imagegen 调用。
 * 用法：npx tsx scripts/t24-u00-prepare-drill.ts
 */
import { inspectManagedProject } from "../src/core/managed-project.js";
import { getStudioProductionUnitSnapshot } from "../src/core/studio-production.js";
import { queryStudioUnitGridGenerationFreeze } from "../src/core/studio-unit-grid-generation.js";
import {
  createStudioGenerationPlan,
  dispatchStudioGenerationPack,
  listStudioGenerationActiveRuns,
} from "../src/core/studio-generation-ledger.js";
import { deriveGenerationTargetState } from "../src/core/studio-generation-target-state.js";

const root = "projects/dudu-s1e1-a84aa353";

async function main() {
  console.log("=== T24 U00 零扣费全链演练 ===\n");

  // 1. 检查 U00 当前状态
  console.log("1. 检查 U00 状态...");
  const state = await deriveGenerationTargetState(root, { unitId: "S1E01-U00", targetKind: "unit-grid" });
  console.log(`   状态: ${state.state}, 原因: ${state.reason}`);

  if (state.state !== "failed_retryable" && state.state !== "ready_to_freeze" && state.state !== "ready_to_dispatch") {
    console.log(`   U00 当前状态 ${state.state} 不适合演练。跳过。`);
    return;
  }

  // 2. 检查 readiness（绑定就绪）
  console.log("\n2. 检查绑定就绪...");
  try {
    const readiness = await queryStudioUnitGridGenerationFreeze(root, {
      targetKind: "unit-grid",
      unitId: "S1E01-U00",
    });
    if (readiness.status === "blocked") {
      console.log(`   绑定阻断: ${readiness.message}`);
      console.log("   演练终止：需要先解决绑定问题。");
      return;
    }
    console.log(`   绑定就绪: packId=${readiness.packId}, fingerprint=${readiness.fingerprint.slice(0, 16)}...`);

    // 3. 创建 plan
    console.log("\n3. 创建生成计划...");
    const plan = await createStudioGenerationPlan(root, {
      nodes: [{ unitId: "S1E01-U00", targetKind: "unit-grid" as const }],
      sourceCommandRequestId: `t24-u00-drill-${Date.now()}`,
    });
    console.log(`   planId: ${plan.planId.slice(0, 16)}...`);

    // 4. dispatch
    console.log("\n4. 派发...");
    const planRunId = `${plan.planId}:node:1:attempt:1`;
    await dispatchStudioGenerationPack(root, {
      packId: readiness.packId,
      packFingerprint: readiness.fingerprint,
      generationRunId: planRunId,
      provider: "codex",
    });
    console.log(`   runId: ${planRunId.slice(0, 32)}...`);

    // 5. 验证 active-runs
    console.log("\n5. 验证 active-runs...");
    const activeRuns = await listStudioGenerationActiveRuns(root, {
      unitId: "S1E01-U00",
      targetKind: "unit-grid",
    });
    const newRun = activeRuns.runs.find((r) => r.generationRunId === planRunId);
    if (newRun) {
      console.log(`   新 run 已注册: terminal=${newRun.terminal}, hasCallIntent=${newRun.hasCallIntent}`);
    } else {
      console.log("   警告：未找到新 run");
    }

    // 6. 状态机验证
    console.log("\n6. 状态机验证...");
    const newState = await deriveGenerationTargetState(root, { unitId: "S1E01-U00", targetKind: "unit-grid" });
    console.log(`   新状态: ${newState.state}`);
    console.log(`   下一步: ${newState.nextAction}`);

    console.log("\n=== 零扣费演练完成（到 dispatch 为止）===");
    console.log("下一步是 prepare_studio_imagegen_call（需要 projectContextToken）");
    console.log("然后是真实 imagegen 调用（用户已授权）");
  } catch (error) {
    console.error("演练失败:", error instanceof Error ? error.message : error);
    // 如果是 plan 已存在等幂等错误，不算失败
    if (error instanceof Error && error.message.includes("已存在")) {
      console.log("（幂等重放，不算失败）");
    }
  }
}

main().catch((error) => {
  console.error("脚本失败:", error);
  process.exit(1);
});
