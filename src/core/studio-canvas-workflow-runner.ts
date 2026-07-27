/**
 * 画布 workflow 组串行执行器：仅 panelIds + pipeline 步骤；
 * image 步默认 freeze+dispatch（不假装真实生图）；可选 register 需显式 SHA。
 * P21：image 步的 plan/dispatch 经 command-bus 命令（幂等外壳），
 * 冻结全部目标格后建生成计划，派发使用计划推导 runId。
 */
import { randomUUID } from "node:crypto";
import { executeIdempotentCommand } from "./command-bus.js";
import {
  listStudioActiveDetachedGenerationUnknownObservations,
  readStudioGenerationPackCurrentRunLatestEvent,
  type FreezeAndPersistStudioGenerationPackResult,
  type FreezeAndPersistStudioUnitGridGenerationPackResult,
  type StudioGenerationDispatchRecord,
  type StudioGenerationPlanRecord,
} from "./studio-generation-ledger.js";
import type { StudioCanvasWorkflowGroup, StudioCanvasWorkflowStep } from "./studio-canvas-layout.js";
import {
  normalizeStudioCanvasWorkflowDraft,
  type StudioCanvasWorkflowDraftInput,
  type StudioCanvasWorkflowPanelConnections,
} from "./studio-canvas-workflow-draft.js";
import { buildStudioGenerationFreezePack, type StudioGenerationFreezePack } from "./studio-generation.js";
import {
  queryStudioUnitGridGenerationFreeze,
  type StudioUnitGridGenerationFreezePack,
} from "./studio-unit-grid-generation.js";
import { normalizeStudioFormalImagegenProvider } from "./studio-imagegen-providers.js";
import { inspectManagedProject, readManagedProjectBootstrapClaim } from "./managed-project.js";
import { assertStudioProjectWriteLeaseForCommand } from "./studio-project-write-lease.js";

export type StudioCanvasWorkflowProvider = "codex" | "grok";

export type StudioCanvasWorkflowTarget =
  | { targetKind?: "panel"; panelId: string; unitId: string }
  | {
      targetKind: "unit-grid";
      unitId: string;
      continuationWaiver?: { receiptId: string; receiptFingerprint: string };
    };

export interface StudioCanvasWorkflowRunOptions {
  provider: StudioCanvasWorkflowProvider;
  /** 旧工程按 panel 映射；unit-grid 整板必须只传一个 unit target。 */
  targets: readonly StudioCanvasWorkflowTarget[];
  /**
   * 画布自由连线仅是草稿输入声明，不是 BindingSet 或 generation 的事实源。
   * 一旦提供，执行器会在任何账本副作用前，用正式冻结包逐格精确复核。
   */
  draft?: StudioCanvasWorkflowDraftInput;
  stopOnFailure?: boolean;
  /**
   * freeze-dispatch-only：只关门禁与派发（默认，不冒充实生图）
   * freeze-dispatch-register：历史兼容字段，runner 已失败关闭；正式结果必须走原子 bundle。
   */
  imageMode?: "freeze-dispatch-only" | "freeze-dispatch-register";
  /** @deprecated runner 不再接受逐项 register；保留字段仅用于兼容旧调用类型。 */
  mediaShaByPanel?: Readonly<Record<string, { raw: string; labeled: string }>>;
  generationRunIdPrefix?: string;
  /**
   * 桌面 IPC 边界获取的写租约凭据（holder/token），逐调用透传给命令总线。
   * 脚本等进程内调用方自行处理租约时保持缺省即可。
   */
  writeLease?: { writeLeaseHolderId?: string; writeLeaseToken?: string };
}

export interface StudioCanvasWorkflowStepOutcome {
  targetKind: "panel" | "unit-grid";
  panelId?: string;
  unitId: string;
  step: StudioCanvasWorkflowStep;
  ok: boolean;
  code?: string;
  message?: string;
  packId?: string;
  packFingerprint?: string;
  generationRunId?: string;
  dispatchId?: string;
}

export interface StudioCanvasWorkflowRunResult {
  schemaVersion: 1;
  kind: "studio-canvas-workflow-run";
  groupId: string;
  provider: StudioCanvasWorkflowProvider;
  stoppedEarly: boolean;
  outcomes: StudioCanvasWorkflowStepOutcome[];
}

export class StudioCanvasWorkflowRunnerError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "StudioCanvasWorkflowRunnerError";
    this.code = code;
  }
}

interface NormalizedWorkflowTargets {
  panelUnits: Map<string, string>;
  unitGrid: {
    targetKind: "unit-grid";
    unitId: string;
    continuationWaiver?: { receiptId: string; receiptFingerprint: string };
  } | null;
}

type PanelFreezeTestHook = (context: {
  projectRoot: string;
  group: StudioCanvasWorkflowGroup;
  expectedPacks: Map<string, StudioGenerationFreezePack>;
}) => void | Promise<void>;

let beforePanelFreezeForTests: PanelFreezeTestHook | undefined;

/**
 * 仅供回归测试在“只读预检完成、任何 freeze 尚未发生”这一窄窗口注入漂移。
 * 生产调用方不得依赖该入口。
 */
export function __setBeforeStudioCanvasWorkflowPanelFreezeHookForTests(
  hook: PanelFreezeTestHook | undefined,
): void {
  beforePanelFreezeForTests = hook;
}

function normalizeTargets(targets: readonly StudioCanvasWorkflowTarget[]): NormalizedWorkflowTargets {
  const panelUnits = new Map<string, string>();
  let unitGrid: NormalizedWorkflowTargets["unitGrid"] = null;
  for (const target of targets) {
    if (target.targetKind === "unit-grid") {
      if (!target.unitId?.trim() || unitGrid || panelUnits.size > 0) {
        throw new StudioCanvasWorkflowRunnerError("invalid-input", "unit-grid targets 必须只有一个 unitId，且不得混入 panel target。");
      }
      const continuationWaiver = target.continuationWaiver;
      if (continuationWaiver
        && (!continuationWaiver.receiptId?.trim()
          || !/^[a-f0-9]{64}$/u.test(continuationWaiver.receiptFingerprint?.trim()))) {
        throw new StudioCanvasWorkflowRunnerError(
          "invalid-input",
          "unit-grid continuationWaiver 必须引用有效 receiptId 与 receiptFingerprint。",
        );
      }
      unitGrid = {
        targetKind: "unit-grid",
        unitId: target.unitId.trim(),
        ...(continuationWaiver
          ? {
              continuationWaiver: {
                receiptId: continuationWaiver.receiptId.trim(),
                receiptFingerprint: continuationWaiver.receiptFingerprint.trim(),
              },
            }
          : {}),
      };
      continue;
    }
    if (!target.panelId?.trim() || !target.unitId?.trim() || unitGrid) {
      throw new StudioCanvasWorkflowRunnerError("invalid-input", "panel targets 需要 panelId 与 unitId，且不得混入 unit-grid target。");
    }
    const panelId = target.panelId.trim();
    const unitId = target.unitId.trim();
    const existing = panelUnits.get(panelId);
    if (existing && existing !== unitId) {
      throw new StudioCanvasWorkflowRunnerError("invalid-input", `panel ${panelId} 被映射到多个 unit。`);
    }
    panelUnits.set(panelId, unitId);
  }
  return { panelUnits, unitGrid };
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort((left, right) => left.localeCompare(right, "en"));
}

function equalIds(left: readonly string[], right: readonly string[]): boolean {
  const normalizedLeft = sorted(left);
  const normalizedRight = sorted(right);
  return normalizedLeft.length === normalizedRight.length
    && normalizedLeft.every((value, index) => value === normalizedRight[index]);
}

function assertDraftMatchesPack(
  connection: StudioCanvasWorkflowPanelConnections | undefined,
  pack: StudioGenerationFreezePack,
): void {
  if (!connection) {
    throw new StudioCanvasWorkflowRunnerError(
      "workflow-binding-mismatch",
      `宫格 ${pack.target.panelId} 没有完整的画布连接，请连接已锁资产、剧本和提示词后再开始。`,
    );
  }
  const expectedAssetIds = pack.assets.map((asset) => asset.assetId);
  if (!equalIds(connection.assetIds, expectedAssetIds)) {
    throw new StudioCanvasWorkflowRunnerError(
      "workflow-binding-mismatch",
      `宫格 ${pack.target.panelId} 的画布资产连接与正式 BindingSet 不一致；请刷新素材与绑定后重试。`,
    );
  }
  if (connection.scriptDocumentId !== pack.scriptRevision.documentId) {
    throw new StudioCanvasWorkflowRunnerError(
      "workflow-binding-mismatch",
      `宫格 ${pack.target.panelId} 的剧本连接不是当前冻结修订所属文档。`,
    );
  }
  if (connection.promptDocumentId !== pack.promptRevision.documentId) {
    throw new StudioCanvasWorkflowRunnerError(
      "workflow-binding-mismatch",
      `宫格 ${pack.target.panelId} 的提示词连接不是当前冻结修订所属文档。`,
    );
  }
}

/**
 * 先完成全部目标格的只读预检，再进入任何 freeze CAS / dispatch 账本写入。
 * 这样第二格连接错误不会留下第一格已派发的半截工作流。
 */
async function preflightPanelTargets(
  projectRoot: string,
  group: StudioCanvasWorkflowGroup,
  units: ReadonlyMap<string, string>,
  input?: StudioCanvasWorkflowDraftInput,
): Promise<Map<string, StudioGenerationFreezePack>> {
  const packs = new Map<string, StudioGenerationFreezePack>();
  const draft = input ? normalizeStudioCanvasWorkflowDraft(input) : undefined;
  const connectionByPanel = new Map(draft?.panels.map((entry) => [entry.panelId, entry] as const) ?? []);
  for (const panelId of group.panelIds) {
    const unitId = units.get(panelId);
    if (!unitId) {
      throw new StudioCanvasWorkflowRunnerError(
        "target-scope-mismatch",
        `宫格 ${panelId} 没有冻结的 unitId 映射。`,
      );
    }
    const pack = await buildStudioGenerationFreezePack(projectRoot, { unitId, panelId });
    if (draft) assertDraftMatchesPack(connectionByPanel.get(panelId), pack);
    packs.set(panelId, pack);
  }
  return packs;
}

function assertPanelFreezeMatchesPreflight(
  expected: StudioGenerationFreezePack,
  frozen: FreezeAndPersistStudioGenerationPackResult,
): void {
  if (frozen.unitId !== expected.target.unitId
    || frozen.panelId !== expected.target.panelId
    || frozen.unitRevision !== expected.target.unitRevision
    || frozen.packId !== expected.id
    || frozen.fingerprint !== expected.fingerprint
    || frozen.pack.id !== expected.id
    || frozen.pack.fingerprint !== expected.fingerprint) {
    throw new StudioCanvasWorkflowRunnerError(
      "workflow-freeze-conflict",
      `宫格 ${expected.target.panelId} 的实际冻结包与只读预检指纹不一致；已停止建计划和派发。`,
    );
  }
}

function assertPanelPlanMatchesFrozenPacks(
  plan: StudioGenerationPlanRecord,
  group: StudioCanvasWorkflowGroup,
  units: ReadonlyMap<string, string>,
  frozenByPanel: ReadonlyMap<string, FreezeAndPersistStudioGenerationPackResult>,
): Map<string, { planId: string; nodeIndex: number }> {
  if (plan.nodeCount !== group.panelIds.length || plan.nodes.length !== group.panelIds.length) {
    throw new StudioCanvasWorkflowRunnerError(
      "workflow-plan-conflict",
      "生成计划节点数量与本次冻结目标不一致；已停止派发。",
    );
  }
  const planNodeByPanel = new Map<string, { planId: string; nodeIndex: number }>();
  for (const panelId of group.panelIds) {
    const unitId = units.get(panelId);
    const frozen = frozenByPanel.get(panelId);
    const matches = plan.nodes.filter((node) => node.targetKind === "panel"
      && node.panelId === panelId
      && node.unitId === unitId
      && node.packId === frozen?.packId
      && node.packFingerprint === frozen?.fingerprint);
    if (!unitId || !frozen || matches.length !== 1 || planNodeByPanel.has(panelId)) {
      throw new StudioCanvasWorkflowRunnerError(
        "workflow-plan-conflict",
        `宫格 ${panelId} 的计划节点未精确绑定本次冻结包；已停止派发。`,
      );
    }
    planNodeByPanel.set(panelId, { planId: plan.planId, nodeIndex: matches[0]!.nodeIndex });
  }
  return planNodeByPanel;
}

function assertUnitGridGroupMatchesPack(
  group: StudioCanvasWorkflowGroup,
  pack: StudioUnitGridGenerationFreezePack,
): void {
  const expectedPanelIds = pack.panels.map((panel) => panel.panelId);
  if (group.panelIds.length !== expectedPanelIds.length
    || group.panelIds.some((panelId, index) => panelId !== expectedPanelIds[index])) {
    throw new StudioCanvasWorkflowRunnerError(
      "unit-grid-scope-mismatch",
      `整板开始必须覆盖 ${pack.target.unitId} 当前全部 ${expectedPanelIds.length} 格并保持顺序；禁止拆格或漏格派发。`,
    );
  }
}

function assertUnitGridDraftMatchesPack(
  draftInput: StudioCanvasWorkflowDraftInput,
  pack: StudioUnitGridGenerationFreezePack,
): void {
  const draft = normalizeStudioCanvasWorkflowDraft(draftInput);
  const connectionByPanel = new Map(draft.panels.map((entry) => [entry.panelId, entry] as const));
  for (const panel of pack.panels) {
    assertDraftMatchesPack(connectionByPanel.get(panel.panelId), panel.panelPack);
  }
}

async function runUnitGridWorkflow(
  projectRoot: string,
  group: StudioCanvasWorkflowGroup,
  target: NonNullable<NormalizedWorkflowTargets["unitGrid"]>,
  options: StudioCanvasWorkflowRunOptions,
): Promise<StudioCanvasWorkflowRunResult> {
  if (group.pipeline.length !== 1 || group.pipeline[0] !== "image") {
    throw new StudioCanvasWorkflowRunnerError(
      "unit-grid-pipeline-unsupported",
      "unit-grid 画布开始当前只允许 image 派发；Review/视频必须走各自受控面。",
    );
  }
  if ((options.imageMode ?? "freeze-dispatch-only") !== "freeze-dispatch-only") {
    throw new StudioCanvasWorkflowRunnerError(
      "unit-grid-register-forbidden",
      "unit-grid 正式结果必须经 pre-call intent 与 raw/labeled 原子 bundle 写回，禁止旧 register 模式。",
    );
  }

  const detachedUnknown = await listStudioActiveDetachedGenerationUnknownObservations(projectRoot, {
    unitId: target.unitId,
  });
  if (detachedUnknown.length > 0) {
    throw new StudioCanvasWorkflowRunnerError(
      "generation-unknown",
      `${target.unitId} 存在 generation_unknown 防重观察；只能对账旧调用/候选，禁止再次冻结、计划或派发。`,
    );
  }

  const readiness = await queryStudioUnitGridGenerationFreeze(projectRoot, {
    ...target,
  });
  if (readiness.status === "blocked") {
    throw new StudioCanvasWorkflowRunnerError(readiness.code, readiness.message);
  }
  assertUnitGridGroupMatchesPack(group, readiness.pack);
  if (options.draft) assertUnitGridDraftMatchesPack(options.draft, readiness.pack);

  const suffix = randomUUID().slice(0, 8);
  const prefix = options.generationRunIdPrefix ?? `wf-${group.id}`;
  const freezeRecord = await executeIdempotentCommand(projectRoot, {
    requestId: `${prefix}-unit-grid-freeze-${suffix}`.slice(0, 160),
    idempotencyKey: `${prefix}-unit-grid-freeze-key-${suffix}`.slice(0, 200),
    request: {
      command: "freeze_studio_generation_pack",
      payload: {
        targetKind: "unit-grid",
        unitId: target.unitId,
        ...(target.continuationWaiver
          ? { continuationWaiver: target.continuationWaiver }
          : {}),
        expectedRevision: readiness.pack.target.unitRevision,
      },
    },
  }, { ...(options.writeLease ?? {}) });
  const frozen = freezeRecord.result as FreezeAndPersistStudioUnitGridGenerationPackResult;
  if (frozen.targetKind !== "unit-grid" || frozen.unitId !== target.unitId
    || frozen.packId !== readiness.packId || frozen.fingerprint !== readiness.fingerprint) {
    throw new StudioCanvasWorkflowRunnerError(
      "unit-grid-freeze-conflict",
      "unit-grid 冻结结果与只读预检身份不一致，已停止派发。",
    );
  }

  const planRecord = await executeIdempotentCommand(projectRoot, {
    requestId: `${prefix}-unit-grid-plan-${suffix}`.slice(0, 160),
    idempotencyKey: `${prefix}-unit-grid-plan-key-${suffix}`.slice(0, 200),
    request: {
      command: "create_studio_generation_plan",
      payload: { nodes: [{ targetKind: "unit-grid", unitId: target.unitId }] },
    },
  }, { ...(options.writeLease ?? {}) });
  const plan = planRecord.result as StudioGenerationPlanRecord;
  const node = plan.nodes.find((entry) => entry.targetKind === "unit-grid" && entry.unitId === target.unitId);
  if (!node) {
    throw new StudioCanvasWorkflowRunnerError("unit-grid-plan-conflict", "生成计划未返回唯一 unit-grid 节点。 ");
  }
  const generationRunId = `${plan.planId}:node:${node.nodeIndex}:attempt:1`;
  const dispatchRecord = await executeIdempotentCommand(projectRoot, {
    requestId: `${prefix}-unit-grid-dispatch-${suffix}`.slice(0, 160),
    idempotencyKey: `${prefix}-unit-grid-dispatch-key-${suffix}`.slice(0, 200),
    request: {
      command: "dispatch_studio_generation_pack",
      payload: {
        packId: frozen.packId,
        packFingerprint: frozen.fingerprint,
        generationRunId,
        provider: options.provider,
        expectedRevision: frozen.unitRevision,
      },
    },
  }, { ...(options.writeLease ?? {}) });
  const dispatch = dispatchRecord.result as StudioGenerationDispatchRecord;
  const latestEvent = await readStudioGenerationPackCurrentRunLatestEvent(
    projectRoot,
    frozen.packId,
    frozen.fingerprint,
  );
  const terminal = latestEvent?.kind === "failed" || latestEvent?.kind === "cancelled";
  return {
    schemaVersion: 1,
    kind: "studio-canvas-workflow-run",
    groupId: group.id,
    provider: options.provider,
    stoppedEarly: terminal,
    outcomes: [{
      targetKind: "unit-grid",
      unitId: target.unitId,
      step: "image",
      ok: !terminal,
      ...(terminal ? {
        code: "run-terminal-replay",
        message: `该整板上次任务已${latestEvent.kind === "failed" ? "失败" : "取消"}；请在生成面板按计划节点重试。`,
      } : {}),
      packId: frozen.packId,
      packFingerprint: frozen.fingerprint,
      generationRunId,
      dispatchId: dispatch.dispatchId,
    }],
  };
}

async function runImageStep(
  projectRoot: string,
  panelId: string,
  unitId: string,
  provider: StudioCanvasWorkflowProvider,
  generationRunId: string,
  frozen: FreezeAndPersistStudioGenerationPackResult,
  commandKeySuffix: string,
  writeLease?: StudioCanvasWorkflowRunOptions["writeLease"],
): Promise<StudioCanvasWorkflowStepOutcome> {
  try {
    const dispatchRecord = await executeIdempotentCommand(projectRoot, {
      requestId: `${generationRunId}-dispatch-${commandKeySuffix}`.slice(0, 160),
      idempotencyKey: `${generationRunId}-key-${commandKeySuffix}`.slice(0, 200),
      request: {
        command: "dispatch_studio_generation_pack",
        payload: {
          packId: frozen.packId,
          packFingerprint: frozen.fingerprint,
          generationRunId,
          provider,
          expectedRevision: frozen.unitRevision,
        },
      },
    }, { ...(writeLease ?? {}) });
    const dispatch = dispatchRecord.result as StudioGenerationDispatchRecord;
    // P21：终态（failed/cancelled）run 的幂等重放不算成功——引导在生成面板重试（新 attempt）。
    // 判定挂节点"当前 run"（sequence 最大 dispatch）的最新事件：retry 后 attempt:1 恒为
    // retry-superseded，若看 attempt:1 自身会在当前 run 已 failed/cancelled 时误报成功（R1 N-1）。
    const latestEvent = await readStudioGenerationPackCurrentRunLatestEvent(
      projectRoot,
      frozen.packId,
      frozen.fingerprint,
    );
    if (latestEvent?.kind === "failed" || latestEvent?.kind === "cancelled") {
      return {
        targetKind: "panel",
        panelId,
        unitId,
        step: "image",
        ok: false,
        code: "run-terminal-replay",
        message: `该宫格上次任务已${latestEvent.kind === "failed" ? "失败" : "取消"}，重复开始不会重新派发；请在生成面板对该节点执行重试（新 attempt）。`,
        generationRunId,
      };
    }
    return {
      targetKind: "panel",
      panelId,
      unitId,
      step: "image",
      ok: true,
      packId: frozen.packId,
      packFingerprint: frozen.fingerprint,
      generationRunId,
      dispatchId: dispatch.dispatchId,
    };
  } catch (error) {
    return {
      targetKind: "panel",
      panelId,
      unitId,
      step: "image",
      ok: false,
      code: "image-step-failed",
      message: error instanceof Error ? error.message : String(error),
      generationRunId,
    };
  }
}

/**
 * 按组内 panelIds 顺序 × pipeline 步骤串行执行。
 * review/audio/video 步若未实现具体副作用，记 not-implemented 失败（可扩展）。
 */
export async function runStudioCanvasWorkflowGroup(
  projectRoot: string,
  group: StudioCanvasWorkflowGroup,
  options: StudioCanvasWorkflowRunOptions,
): Promise<StudioCanvasWorkflowRunResult> {
  // Renderer/IPC 输入在任何 freeze/plan/dispatch 副作用前失败关闭，不能只依赖 TS 类型。
  let provider: StudioCanvasWorkflowProvider;
  try {
    provider = normalizeStudioFormalImagegenProvider(options.provider, "provider");
  } catch (error) {
    throw new StudioCanvasWorkflowRunnerError(
      "invalid-input",
      error instanceof Error ? error.message : String(error),
    );
  }
  const normalizedOptions: StudioCanvasWorkflowRunOptions = { ...options, provider };
  if (!group.panelIds?.length) {
    throw new StudioCanvasWorkflowRunnerError("invalid-input", "group.panelIds 为空。");
  }
  if (!group.pipeline?.length) {
    throw new StudioCanvasWorkflowRunnerError("invalid-input", "group.pipeline 为空。");
  }
  if (group.pipeline.length !== 1 || group.pipeline[0] !== "image") {
    throw new StudioCanvasWorkflowRunnerError(
      "pipeline-unsupported",
      "workflow runner 当前只允许单一步骤 image；Review、音频和视频必须走各自受控入口。",
    );
  }
  const imageMode = normalizedOptions.imageMode ?? "freeze-dispatch-only";
  if (imageMode !== "freeze-dispatch-only" && imageMode !== "freeze-dispatch-register") {
    throw new StudioCanvasWorkflowRunnerError("invalid-input", "imageMode 非法。");
  }
  if (imageMode === "freeze-dispatch-register") {
    throw new StudioCanvasWorkflowRunnerError(
      "legacy-register-forbidden",
      "旧 freeze-dispatch-register 会造成 raw/labeled 单边登记，已失败关闭；正式结果必须走原子 bundle 写回。",
    );
  }

  await inspectManagedProject(projectRoot);
  const targets = normalizeTargets(normalizedOptions.targets);
  const bootstrapClaim = await readManagedProjectBootstrapClaim(projectRoot);
  const duduManagedProject = bootstrapClaim?.purpose === "dudu-readonly-import";
  if (duduManagedProject && !targets.unitGrid) {
    throw new StudioCanvasWorkflowRunnerError(
      "unit-grid-target-required",
      "《嘟嘟》受管工程只允许整单元 unit-grid 开始；禁止回退为逐 panel 冻结、计划或派发。",
    );
  }
  if (targets.unitGrid) {
    return runUnitGridWorkflow(projectRoot, group, targets.unitGrid, normalizedOptions);
  }
  const units = targets.panelUnits;
  const uniqueGroupPanelIds = new Set(group.panelIds);
  if (uniqueGroupPanelIds.size !== group.panelIds.length
    || units.size !== group.panelIds.length
    || group.panelIds.some((panelId) => !units.has(panelId))
    || [...units.keys()].some((panelId) => !uniqueGroupPanelIds.has(panelId))) {
    throw new StudioCanvasWorkflowRunnerError(
      "target-scope-mismatch",
      "工作流 group.panelIds 必须与冻结的 panel targets 一一对应，禁止漏格、增格或跨单元猜测。",
    );
  }
  await assertStudioProjectWriteLeaseForCommand(projectRoot, {
    command: "freeze_studio_generation_pack",
    holderId: normalizedOptions.writeLease?.writeLeaseHolderId,
    leaseToken: normalizedOptions.writeLease?.writeLeaseToken,
  });
  // 即使没有自由连线 draft，也要在任何 freeze/plan/dispatch 前逐格验证
  // projectRoot + unitId + panelId 的真实归属；后序坏目标不能留下前序半提交。
  const expectedPacks = await preflightPanelTargets(projectRoot, group, units, normalizedOptions.draft);
  if (beforePanelFreezeForTests) {
    await beforePanelFreezeForTests({ projectRoot, group, expectedPacks });
  }
  const stopOnFailure = normalizedOptions.stopOnFailure !== false;
  const prefix = normalizedOptions.generationRunIdPrefix ?? `wf-${group.id}`;
  const outcomes: StudioCanvasWorkflowStepOutcome[] = [];
  let stoppedEarly = false;
  let runIndex = 0;

  // P21：先冻结全部 image 目标格（内容寻址幂等），再经命令建立生成计划；
  // 之后每格派发使用计划推导 runId（命中 plan 节点的 pack 强制校验要求）。
  const commandKeySuffix = randomUUID().slice(0, 8);
  const imageTargets = group.panelIds.map((panelId) => ({
    panelId,
    unitId: units.get(panelId)!,
  }));
  const frozenByPanel = new Map<string, FreezeAndPersistStudioGenerationPackResult>();
  for (const entry of imageTargets) {
    const expected = expectedPacks.get(entry.panelId);
    if (!expected) {
      throw new StudioCanvasWorkflowRunnerError(
        "workflow-preflight-conflict",
        `宫格 ${entry.panelId} 缺少只读预检冻结包；已停止写入。`,
      );
    }
    const freezeRecord = await executeIdempotentCommand(projectRoot, {
      requestId: `${prefix}-freeze-${entry.panelId}-${commandKeySuffix}`.slice(0, 160),
      idempotencyKey: `${prefix}-freeze-key-${entry.panelId}-${commandKeySuffix}`.slice(0, 200),
      request: {
        command: "freeze_studio_generation_pack",
        payload: {
          unitId: entry.unitId,
          panelId: entry.panelId,
          expectedRevision: expected.target.unitRevision,
        },
      },
    }, { ...(normalizedOptions.writeLease ?? {}) });
    const frozen = freezeRecord.result as FreezeAndPersistStudioGenerationPackResult;
    assertPanelFreezeMatchesPreflight(expected, frozen);
    frozenByPanel.set(entry.panelId, frozen);
  }
  const planRecord = await executeIdempotentCommand(projectRoot, {
    requestId: `${prefix}-plan-${commandKeySuffix}`.slice(0, 160),
    idempotencyKey: `${prefix}-plan-key-${commandKeySuffix}`.slice(0, 200),
    request: {
      command: "create_studio_generation_plan",
      payload: { nodes: imageTargets.map((entry) => ({ unitId: entry.unitId, panelId: entry.panelId })) },
    },
  }, { ...(normalizedOptions.writeLease ?? {}) });
  const plan = planRecord.result as StudioGenerationPlanRecord;
  const planNodeByPanel = assertPanelPlanMatchesFrozenPacks(plan, group, units, frozenByPanel);

  outer: for (const panelId of group.panelIds) {
    const unitId = units.get(panelId);
    if (!unitId) {
      outcomes.push({
        targetKind: "panel",
        panelId,
        unitId: "",
        step: group.pipeline[0]!,
        ok: false,
        code: "target-missing",
        message: `panel ${panelId} 无 unitId 映射`,
      });
      if (stopOnFailure) {
        stoppedEarly = true;
        break;
      }
      continue;
    }
    for (const step of group.pipeline) {
      runIndex += 1;
      const planNode = planNodeByPanel.get(panelId);
      const generationRunId = (step === "image" && planNode
        ? `${planNode.planId}:node:${planNode.nodeIndex}:attempt:1`
        : `${prefix}-${runIndex}-${panelId}`).slice(0, 254);
      let outcome: StudioCanvasWorkflowStepOutcome;
      if (step === "image") {
        const frozen = frozenByPanel.get(panelId);
        if (!planNode || !frozen) {
          throw new StudioCanvasWorkflowRunnerError(
            "workflow-plan-conflict",
            `宫格 ${panelId} 缺少已验证的冻结包或计划节点；已停止派发。`,
          );
        }
        outcome = await runImageStep(
          projectRoot,
          panelId,
          unitId,
          provider,
          generationRunId,
          frozen,
          commandKeySuffix,
          normalizedOptions.writeLease,
        );
      } else {
        outcome = {
          targetKind: "panel",
          panelId,
          unitId,
          step,
          ok: false,
          code: "step-not-implemented",
          message: `步骤 ${step} 尚未在 runner 中实现副作用（仅 image 默认支持）`,
          generationRunId,
        };
      }
      outcomes.push(outcome);
      if (!outcome.ok && stopOnFailure) {
        stoppedEarly = true;
        break outer;
      }
    }
  }

  return {
    schemaVersion: 1,
    kind: "studio-canvas-workflow-run",
    groupId: group.id,
    provider,
    stoppedEarly,
    outcomes,
  };
}
