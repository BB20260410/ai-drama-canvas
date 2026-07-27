/**
 * T24 真实 S1E1 工程零扣费演练 + 状态检查。
 * 用法：npx tsx scripts/t24-real-drill.ts
 */
import { listStudioProductionUnits } from "../src/core/studio-production.js";
import { listStudioGenerationActiveRuns } from "../src/core/studio-generation-ledger.js";
import { deriveGenerationTargetState } from "../src/core/studio-generation-target-state.js";
import { getStudioProductionDiagnostics } from "../src/core/studio-production-diagnostics.js";
import { getApprovedTimelineProjection } from "../src/core/studio-approved-timeline-projection.js";
import { getContinuousGenerationState } from "../src/core/studio-continuous-generation-state.js";

const root = "projects/dudu-s1e1-a84aa353";

async function main() {
  console.log("=== T24 真实 S1E1 工程演练 ===\n");

  // 1. 诊断
  console.log("1. 生产诊断...");
  const diag = await getStudioProductionDiagnostics(root);
  console.log(`   单元: ${diag.counts.units}, 派发: ${diag.counts.dispatches}, 结果: ${diag.counts.results}`);
  console.log(`   raw: ${diag.counts.rawResults}, labeled: ${diag.counts.labeledResults}`);
  console.log(`   Review PASS: ${diag.reviewDistribution.pass}, REWORK: ${diag.reviewDistribution.rework}`);
  console.log(`   Run 终态: succeeded=${diag.runStateDistribution.succeeded}, failed=${diag.runStateDistribution.failed}, cancelled=${diag.runStateDistribution.cancelled}`);

  // 2. U00 状态
  console.log("\n2. U00 状态检查...");
  const units = await listStudioProductionUnits(root, { season: "S1", episode: "S1E1", limit: 5 });
  const u00 = units.items[0]!;
  console.log(`   U00: ${u00.id}, seq: ${u00.sequence}`);

  const activeRuns = await listStudioGenerationActiveRuns(root, { unitId: u00.id, targetKind: "unit-grid" });
  console.log(`   Active runs: ${activeRuns.runs.length}`);
  for (const run of activeRuns.runs) {
    console.log(`     run: ${run.generationRunId}, terminal: ${run.terminal}, event: ${run.latestEventKind}, pair: ${run.hasResultPair}, review: ${run.reviewStatus}`);
  }
  console.log(`   Blocking: ${activeRuns.blockingRuns.length}`);
  for (const b of activeRuns.blockingRuns) {
    console.log(`     ${b.generationRunId}: ${b.reason} → ${b.recoveryAction}`);
  }

  const state = await deriveGenerationTargetState(root, { unitId: u00.id, targetKind: "unit-grid" });
  console.log(`   归约器状态: ${state.state}, 原因: ${state.reason}`);
  console.log(`   下一步: ${state.nextAction}`);

  // 3. 批量投影（fastMode）
  console.log("\n3. 批量时间线投影（fastMode）...");
  const start = Date.now();
  const projection = await getApprovedTimelineProjection(root, { season: "S1", episode: "S1E1", fastMode: true });
  const elapsed = Date.now() - start;
  console.log(`   ${projection.unitCount} 单元, 耗时 ${elapsed}ms`);
  console.log(`   PASS: ${projection.summary.pass}, 待审: ${projection.summary.pendingReview}, 进行中: ${projection.summary.inProgress}, 失败: ${projection.summary.failed}, 阻断: ${projection.summary.blocked}`);

  // 4. 持续生图状态机
  console.log("\n4. 持续生图状态机...");
  const contState = await getContinuousGenerationState(root, { season: "S1", episode: "S1E1" });
  console.log(`   阶段: ${contState.phase}`);
  console.log(`   焦点单元: ${contState.focusUnitId}`);
  console.log(`   焦点状态: ${contState.focusUnitState}`);
  console.log(`   主动作: ${contState.primaryAction.label} (${contState.primaryAction.code})`);
  console.log(`   进度: ${contState.progress.completedUnits}/${contState.progress.totalUnits}`);
  console.log(`   阻断: ${contState.blocking.blocked ? contState.blocking.reason : "无"}`);
  console.log(`   写租约: ${contState.writeLease.held ? `由 ${contState.writeLease.holderKind} 持有` : "无"}`);

  // 5. 逐单元状态摘要
  console.log("\n5. 逐单元状态摘要（前 10 个）...");
  for (const unit of projection.units.slice(0, 10)) {
    const status = unit.productionStatus;
    const label = unit.displayLabel;
    const warn = unit.candidateWarning ? ` ⚠${unit.candidateWarning}` : "";
    const err = unit.projectionError ? ` ✗${unit.projectionError}` : "";
    console.log(`   ${label} ${unit.title}: ${status}${warn}${err}`);
  }

  console.log("\n=== 演练完成 ===");
}

main().catch((error) => {
  console.error("演练失败:", error);
  process.exit(1);
});
