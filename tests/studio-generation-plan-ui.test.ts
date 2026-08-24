import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative: string) => readFileSync(path.join(root, relative), "utf8");

/**
 * P21 §4-8 UI 合同：生成计划任务区、按钮可用性映射、自猜装饰移除、进度投影通道。
 */
describe("P21 生成计划与任务 UI 合同", () => {
  it("生成控制页含计划任务区：投影驱动、按钮按状态映射、取消/重试文案符合失败关闭约定", () => {
    const view = read("src/renderer/src/components/StudioGenerationControlView.vue");
    expect(view).toContain("生成计划与任务");
    expect(view).toContain("getStudioGenerationPlanProgress");
    expect(view).toContain("onStudioGenerationProgress");
    expect(view).toContain("payload.projectId !== currentProjectId");
    expect(view).toContain("executeStudioCommand");
    expect(view).toContain("createProjectScopedActionGate");
    expect(view).toContain("const root = props.projectRoot");
    expect(view).toContain("executeStudioCommand(root, envelope)");
    expect(view).toContain("planActionGate.invalidate()");
    expect(view).toContain("progressOwnerRoot");
    expect(view).toContain("progressLoadGate");
    expect(view).toContain("generationProjectionCurrent");
    const progressLoader = view.slice(
      view.indexOf("async function loadProgress"),
      view.indexOf("function planNodeStatusLabel"),
    );
    expect(progressLoader.indexOf('progressOwnerRoot.value = "";')).toBeGreaterThan(-1);
    expect(progressLoader.indexOf('progressOwnerRoot.value = "";')).toBeLessThan(
      progressLoader.indexOf("getStudioGenerationPlanProgress"),
    );
    expect(progressLoader).toContain("progressLoadGate.isCurrent");
    expect(progressLoader.indexOf("getStudioGenerationPlanProgress")).toBeLessThan(
      progressLoader.indexOf("progressOwnerRoot.value = root;"),
    );
    expect(view).toContain("旧工程任务已失效");
    expect(view).toContain("cancel_studio_generation_run");
    expect(view).toContain("retry_studio_generation_plan_nodes");
    // 按钮可用性 = 投影状态函数输出
    expect(view).toContain("node.status === 'dispatched'");
    expect(view).toContain("node.status === 'failed' || node.status === 'cancelled'");
    expect(view).toContain("node.status === 'succeeded' && node.resultId");
    // 中文失败关闭文案
    expect(view).toContain("仅停止账本跟踪，不撤回已派发意图；已出图结果不会被删除");
    expect(view).toContain("将创建新 attempt，旧结果保留不动");
    // 状态词表（不自猜：全部来自投影）
    expect(view).toContain("已派发，等待 Agent");
    expect(view).toContain("已被重试取代");
    // 状态只来自账本的明示
    expect(view).toContain("进度只来自本地账本");
    // P30：整板任务保留 target 身份，不把 unit-grid:<unit> 当 panelId。
    expect(view).toContain('node.targetKind === "unit-grid" ? `整板 · ${node.unitId}` : node.panelId');
    expect(view).toContain('operation: "history"');
    expect(view).toContain('targetKind: "unit-grid"');
    expect(view).toContain('order: "newest-first"');
    expect(view).toContain("const newestResult = items[0]");
    expect(view).toContain("return history.value[0]?.packId");
    expect(view).toContain("unitGridReadinessPackId");
    expect(view).toContain('operation: "readiness"');
    expect(view).toContain("readinessResult.candidate.packId");
    expect(view).not.toContain("[...(progress.value?.nodes ?? [])].reverse().find");
    expect(view).toContain("new Set(history.value.map((item) => item.generationRunId))");
    expect(view).not.toContain("new Set([...history.value].reverse()");
    expect(view).toContain('getDuduReadonlyImportControl');
    expect(view).toContain('node.targetKind === "unit-grid"');
    expect(view).toContain('operation: "detached-unknown"');
    expect(view).toContain("generation_unknown");
    expect(view).toContain("detachedUnknownNodeStates");
    expect(view).toContain('detachedUnknownNodeStates.value[node.unitId] !== "clear"');
    expect(view).toContain('isUnknownBlockedGroup(group.nodes)');
    expect(view).toContain(':disabled="!latestReviewPair || generationActionsBlocked"');
    expect(view).toContain("rawResultId: pair.raw.resultId");
    expect(view).toContain("labeledResultId: pair.labeled.resultId");
    expect(view).toContain("generationTarget,");
    // P30：Dudu 探测是异步的；旧单元响应必须在重置分页/readiness fallback 前丢弃。
    const detectionAwait = view.indexOf('const useUnitGrid = await isDuduManagedProject(root)');
    const staleUnitGuard = view.indexOf("if (!isCurrent()) return;", detectionAwait);
    const firstHistoryMutation = view.indexOf("const desiredTargetKind", detectionAwait);
    expect(detectionAwait).toBeGreaterThan(-1);
    expect(staleUnitGuard).toBeGreaterThan(detectionAwait);
    expect(staleUnitGuard).toBeLessThan(firstHistoryMutation);
  });

  it("画布移除 1.6s setTimeout 自猜装饰，宫格状态改由账本投影驱动", () => {
    const view = read("src/renderer/src/components/ManagedStudioCanvasView.vue");
    expect(view).not.toMatch(/window\.setTimeout\([\s\S]{0,240}nodeStatusStore/u);
    expect(view).toContain("syncPlanNodeStatuses");
    expect(view).toContain("getStudioGenerationPlanProgress");
    expect(view).toContain("onStudioGenerationProgress");
    expect(view).toContain("payload.projectId !== overview.value?.projectId");
    expect(view).toContain("scheduleGenerationProjectionRefresh");
    expect(view).toContain("loadApprovedUnitGridRawProjection");
    expect(view).toContain("已派发，等待 Agent");
    expect(view).toContain('node.targetKind === "unit-grid" ? `unit:${node.unitId}` : `panel:${node.panelId}`');
    expect(view).toContain('kindLabel: "生产单元"');
    expect(view).toContain('getDuduReadonlyImportControl(projectRoot)');
    expect(view).toContain('targetKind: "unit-grid" as const');
    expect(view).toContain("workflowActionIsCurrent(scope)");
    expect(view).toContain("workflowActionGate.invalidate()");
  });

  it("preload/main 暴露进度投影通道与全量拉取", () => {
    const preload = read("src/preload/index.ts");
    expect(preload).toContain("onStudioGenerationProgress");
    expect(preload).toContain("canvas:studio-generation-progress");
    expect(preload).toContain("getStudioGenerationPlanProgress");
    const main = read("src/main/index.ts");
    expect(main).toContain("canvas:studio-generation-progress");
    expect(main).toContain("canvas:get-studio-generation-plan-progress");
    expect(main).toContain("createStudioGenerationLedgerWatcher");
    expect(main).toContain("STUDIO_GENERATION_PROGRESS_COMMANDS");
    expect(main).toContain('"submit_studio_generation_review"');
    expect(main).toContain("emitNow");
    const watcher = read("src/main/studio-generation-ledger-watcher.ts");
    expect(watcher).toContain("studio-generation-ledger\\.sqlite(-wal|-shm)?$");
    // R3-F1 回归：ignored 必须放行被监听根目录（chokidar 对根路径同样应用 ignored 谓词）。
    expect(watcher).toContain("candidate !== aicanvasDir");
  });

  it("生成控制技术消息诊断 summary 含 testid，不改冻结包/结果身份", () => {
    const view = read("src/renderer/src/components/StudioGenerationControlView.vue");
    expect(view).toContain("isTechnicalGenerationMessage(detail.selectedPanel.generation.message)");
    expect(view).toContain('data-testid="studio-generation-message-diagnostics"');
    expect(view).toContain('<summary data-testid="studio-generation-message-diagnostics">诊断详情</summary>');
    expect(view).toContain('data-testid="studio-pack-identity"');
    expect(view).toContain("`studio-result-identity-${item.resultId}`");
    expect(view).not.toContain("material-studio-diagnostics");
    expect(view).not.toContain("studio-continuity-next-action-diagnostics");
  });

  it("生成控制计划 ID 诊断 summary 含共享 testid，不改技术消息与冻结包身份", () => {
    const view = read("src/renderer/src/components/StudioGenerationControlView.vue");
    expect(view).toContain('class="plan-group"');
    expect(view).toContain('class="plan-id-diagnostics"');
    expect(view).toContain('data-testid="studio-generation-plan-id-diagnostics"');
    expect(view).toContain('<summary data-testid="studio-generation-plan-id-diagnostics">诊断</summary>');
    expect(view).toContain("计划 ID {{ group.planId }}");
    expect(view).not.toContain("studio-generation-plan-id-diagnostics-");
    expect(view).toContain('data-testid="studio-generation-message-diagnostics"');
    expect(view).toContain('data-testid="studio-pack-identity"');
    expect(view).toContain("`studio-result-identity-${item.resultId}`");
    expect(view).not.toContain("studio-binding-diagnostics");
  });

  it("冻结包身份 summary 含 testid，details 仍 studio-pack-identity", () => {
    const view = read("src/renderer/src/components/StudioGenerationControlView.vue");
    expect(view).toContain('class="technical-diagnostics pack-identity"');
    expect(view).toContain('data-testid="studio-pack-identity"');
    expect(view).toContain('data-testid="studio-pack-identity-summary"');
    expect(view).toContain('<summary data-testid="studio-pack-identity-summary">冻结包身份（生成时版本）</summary>');
    expect(view).not.toContain("studio-pack-identity-summary-");
    expect(view).not.toContain('pack-identity" role="dialog"');
    expect(view).toContain('data-testid="studio-generation-message-diagnostics"');
    expect(view).toContain('data-testid="studio-generation-plan-id-diagnostics"');
  });

  it("结果行生成时身份 summary 含共享 testid，不改 per-result details", () => {
    const view = read("src/renderer/src/components/StudioGenerationControlView.vue");
    expect(view).toContain('class="technical-diagnostics result-identity"');
    expect(view).toContain("`studio-result-identity-${item.resultId}`");
    expect(view).toContain('data-testid="studio-result-identity-summary"');
    expect(view).toContain('<summary data-testid="studio-result-identity-summary">生成时身份</summary>');
    expect(view).not.toContain("studio-result-identity-summary-");
    expect(view).toContain('@toggle="onResultIdentityToggle(item.packId)"');
    expect(view).toContain('data-testid="studio-pack-identity-summary"');
    expect(view).toContain('data-testid="studio-generation-message-diagnostics"');
  });
});
