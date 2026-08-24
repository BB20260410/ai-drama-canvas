/**
 * T23 源码 dev 规模性能门。
 *
 * - 只创建 /private/var/... 下的可重复合成受管工程；
 * - 36 个 15 秒单元，其中 4 个走真实 Core freeze/dispatch/commit/Review PASS 链；
 * - raw/labeled/冻结参考均为 sharp 生成的可解码纯色 PNG，只做机械与性能验收，
 *   不构成 AI 生图、内容质量或人工视觉验收；
 * - 仅启动 electron-vite dev，不安装、不 build、不读取或写入正式项目。
 */
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  ensureStudioImageThumbnail,
  getStudioCanonicalAsset,
} from "../src/core/material-studio.js";
import { inspectManagedProject } from "../src/core/managed-project.js";
import { getApprovedTimelineProjection } from "../src/core/studio-approved-timeline-projection.js";
import { registerProject, setActiveProjectRegistration } from "../src/core/sidecar.js";
import {
  addUnitGridFixtureUnit,
  commitUnitGridBundle,
  createUnitGridFixtureProject,
  createUnitGridFixtureCharacterAuthority,
  freezeDispatchPrepareUnitGrid,
  passUnitGridReview,
  unitGridFixtureContinuationWaiver,
} from "../tests/helpers/studio-unit-grid-fixture.js";
import {
  assertBuildArtifacts,
  launchBuiltElectron,
  launchDevElectron,
  launchInstalledElectron,
  type LaunchedUi,
} from "./lib/t23-project-ui-verify-shared.js";
import {
  evaluateT23ScalePerformance,
  T23_SCALE_PERFORMANCE_BUDGET,
  type T23ScalePerformanceBudget,
  type T23ScalePerformanceEvaluation,
} from "./lib/t23-scale-performance-contract.js";
import {
  assertT23ScaleExactPassBindings,
  redactT23ScaleRendererProbeForEvidence,
  summarizeT23ScaleRendererProbe,
  type T23ScaleExpectedPassBinding,
  type T23ScaleRendererProbeEvidenceSnapshot,
  type T23ScaleRendererProbeSummary,
} from "./lib/t23-scale-performance-probe.js";
import { t23RendererCyclePageFunction } from "./lib/t23-renderer-cycle-page-function.mjs";
import {
  assertWorkspaceRuntimeBuildIdentity,
  type WorkspaceRuntimeBuildIdentityEvidence,
} from "./lib/workspace-runtime-build-identity.js";

const UNIT_COUNT = 36;
const PASS_RAW_COUNT = 4;
const SEASON = "S1";
const EPISODE = "E01";
const PASS_RAW_COLORS = ["#30495d", "#315f7a", "#4a3f69", "#265d53"] as const;
const PASS_LABELED_COLORS = ["#715b43", "#8a5944", "#66517d", "#7b7044"] as const;
const PASS_REFERENCE_COLORS = ["#654b37", "#365d4a", "#63405c", "#3f526f"] as const;

interface UnitGridRawSnapshot {
  loading: boolean;
  unitNodeIds: string[];
  corePassUnitIds: string[];
  referenceCount: number;
  referenceUnitIds: string[];
  raws: Array<{
    unitId: string;
    rawMediaSha256: string;
    thumbnailUrl?: string;
    verification: string;
    provenance: string;
  }>;
  references: Array<{
    unitId: string;
    referenceId: string;
    mediaSha256: string;
    referenceType: string;
    thumbnailUrl?: string;
  }>;
}

interface IpcProbeSnapshot {
  enabled: boolean;
  totalCalls: number;
  currentOutstanding: number;
  peakOutstanding: number;
  channels: Array<{
    channel: string;
    totalCalls: number;
    currentOutstanding: number;
    peakOutstanding: number;
    lastDurationMs?: number | null;
  }>;
  projectionTimeline?: {
    schemaVersion: 1;
    phases: Array<{
      phase: string;
      durationMs: number;
      panelCount?: number;
      controlAssetCount?: number;
      neighborCount?: number;
      frozenReferenceCount?: number;
    }>;
  };
  unitsReadTimeline?: {
    schemaVersion: 1;
    phases: Array<{
      phase: string;
      startOffsetMs: number;
      durationMs: number;
    }>;
    counters: {
      managedProjectShellInspections: number;
      generationLedgerEnsureCalls: number;
      generationLedgerInitializationStarts: number;
      generationLedgerInitializationJoins: number;
      productionDirectoryEnsureCalls: number;
      productionOpenDatabaseCalls: number;
      productionReadOnlyProbeConnections: number;
      productionOwnerConnections: number;
      productionBusinessSqlExecutions: number;
      unitPageQueries: number;
      unitTimingQueries: number;
      episodeStartQueries: number;
      facetQueries: number;
      bindingHeadQueries: number;
      successorQueries: number;
      productionSchemaCacheHits: number;
      productionSchemaCacheMisses: number;
      returnedUnitCount: number;
    };
  };
  rendererStartupTimeline?: {
    schemaVersion: 1;
    milestones: Array<{
      milestone: string;
      atMs: number;
    }>;
  };
  startupRuntimeGate?: {
    schemaVersion: 1;
    baselineMutationChecks?: number;
    firstCardMutationChecks?: number;
    finalMutationChecks?: number;
  };
}

interface RuntimeStartupGateSnapshot {
  runtimeGateMetrics?: {
    mutationChecks: number;
  };
  runtimeIpcMetrics?: {
    channels: Array<{
      channel: string;
      effect: string;
      calls: number;
      failures: number;
    }>;
  };
}

/**
 * 失败报告只保留 main 端无参数、无路径的门禁/IPC 聚合。不要把 getRuntimeWriteGate
 * 的完整响应写入证据，以免未来诊断字段扩展后把工程身份误带进 T23 报告。
 */
function summarizeRuntimeStartupGate(snapshot: RuntimeStartupGateSnapshot): RuntimeStartupGateSnapshot {
  const mutationChecks = snapshot.runtimeGateMetrics?.mutationChecks;
  const channels = snapshot.runtimeIpcMetrics?.channels
    .filter((entry) => (
      /^canvas:[a-z0-9-]+$/u.test(entry.channel)
      && (entry.effect === "read-only" || entry.effect === "mutation")
      && Number.isSafeInteger(entry.calls) && entry.calls >= 0
      && Number.isSafeInteger(entry.failures) && entry.failures >= 0
    ))
    .map((entry) => ({
      channel: entry.channel,
      effect: entry.effect,
      calls: entry.calls,
      failures: entry.failures,
    }));
  return {
    ...(typeof mutationChecks === "number" && Number.isSafeInteger(mutationChecks) && mutationChecks >= 0
      ? { runtimeGateMetrics: { mutationChecks } }
      : {}),
    ...(channels ? { runtimeIpcMetrics: { channels } } : {}),
  };
}

type RendererCyclePageResult = {
  ok: true;
  timeOrigin: number;
  rendererFirstCardMs: number;
  rendererFirstRawMs: number;
  rendererAllPassReferencesMs: number;
  drainDurationMs: number;
  rawSnapshot: UnitGridRawSnapshot;
  ipcProbe: IpcProbeSnapshot;
} | {
  ok: false;
  error: "product-hook-missing" | "ipc-drain-timeout";
  timeOrigin: number;
  drainDurationMs?: number;
  rawSnapshot?: UnitGridRawSnapshot;
  ipcProbe?: IpcProbeSnapshot;
};

interface RendererCycleSnapshot {
  timeOrigin: number;
  rendererFirstCardMs: number;
  rendererFirstRawMs: number;
  rendererAllPassReferencesMs: number;
  drainDurationMs: number;
  rawSnapshot: UnitGridRawSnapshot;
  ipcProbe: IpcProbeSnapshot;
  contextAttempts: number;
}

interface InteractionProbeSnapshot {
  frames: number[];
  longTasks: Array<{
    startTime: number;
    duration: number;
  }>;
  longTaskSupported: boolean;
}

interface TimingSummary {
  count: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  meanMs: number;
}

interface InteractionPerformanceEvidence {
  status: "PASS" | "FAIL";
  budgets: {
    warmUnitSwitchP95Ms: 500;
    inputFeedbackP95Ms: 100;
    dragFeedbackP95Ms: 100;
    panAverageFpsMin: 50;
    panAverageFpsMax: 60;
    panFrameP95Ms: 20;
    unexplainedLongTaskMaxMs: 200;
  };
  warmUnitSwitch: TimingSummary & {
    sampleCount: 10;
    unitIds: string[];
  };
  zoomInputFeedback: TimingSummary & {
    sampleCount: 100;
  };
  dragFeedback: TimingSummary & {
    sampleCount: 10;
    nodeId: string;
  };
  canvasPan: {
    sampleDurationMs: number;
    frameCount: number;
    frameIntervals: TimingSummary;
    averageFps: number;
  };
  longTasks: {
    supported: boolean;
    count: number;
    maxMs: number;
    overBudget: Array<{
      startTime: number;
      duration: number;
    }>;
  };
  checks: Array<{
    id: string;
    status: "PASS" | "FAIL";
    actual: number | boolean;
    comparator: "<=" | ">=" | "between" | "===";
    budget: number | boolean | [number, number];
  }>;
}

interface SmokeReport {
  schemaVersion: 1;
  kind: "t23-scale-performance";
  status: "PASS" | "FAIL";
  ok: boolean;
  mode: "dev" | "build" | "packaged";
  budgetProfile: "t23-compat" | "p7-strict";
  createdAt: string;
  runtimeBuildIdentity?: WorkspaceRuntimeBuildIdentityEvidence;
  fixture: {
    kind: "deterministic-synthetic-mechanical-fixture";
    visualAcceptance: false;
    aiImageGeneration: false;
    isolatedTemporaryProject: true;
    unitCount: number;
    passRawCount: number;
    note: string;
  };
  performance?: T23ScalePerformanceEvaluation;
  ui?: {
    /** 视口剔除后当前 DOM 中可见的 unit 节点，仅作诊断，不作为 36 单元硬门。 */
    visibleUnitNodeCount: number;
    /** 来自 renderer VueFlow nodes store 的实际 unit 节点数量。 */
    projectedUnitNodeCount: number;
    rendererProbe: T23ScaleRendererProbeSummary;
    projectMetricsText: string;
    buildIdentityText: string;
    rawSnapshot: T23ScaleRendererProbeEvidenceSnapshot;
    decodedRawThumbnailCount: number;
    decodedReferenceThumbnailCount: number;
  };
  ipcProbe?: IpcProbeSnapshot;
  ipcDrain?: {
    budgetMs: 5_000;
    durationMs: number;
    currentOutstanding: number;
    status: "PASS" | "FAIL";
  };
  interactions?: InteractionPerformanceEvidence;
  rendererDocument?: {
    timeOrigin: number;
    contextAttempts: number;
    reloadCount: number;
  };
  consoleErrors: string[];
  pageErrors: string[];
  failureDiagnostics?: {
    errorKind: "Error" | "TypeError" | "RangeError" | "UnknownError";
    rawSnapshot?: T23ScaleRendererProbeEvidenceSnapshot;
    ipcProbe?: IpcProbeSnapshot;
    /** main 进程的安全聚合：仅 gate mutationChecks 与 canvas IPC 计数。 */
    runtimeStartupGate?: RuntimeStartupGateSnapshot;
  };
  error?: string;
}

function unitId(sequence: number): string {
  return `S1E01-U${String(sequence - 1).padStart(2, "0")}`;
}

function t23EvidenceErrorKind(error: unknown): NonNullable<SmokeReport["failureDiagnostics"]>["errorKind"] {
  if (error instanceof TypeError) return "TypeError";
  if (error instanceof RangeError) return "RangeError";
  if (error instanceof Error) return "Error";
  return "UnknownError";
}

function parseReportPath(): string {
  const raw = process.argv.find((argument) => argument.startsWith("--report="))
    ?.slice("--report=".length).trim();
  if (raw) {
    if (!path.isAbsolute(raw)) throw new Error("--report 必须是绝对路径。");
    return path.resolve(raw);
  }
  const timestamp = new Date().toISOString().replace(/[:.]/gu, "-");
  return path.join(os.tmpdir(), `t23-source-dev-scale-${timestamp}.json`);
}

function parseMode(): "dev" | "build" | "packaged" {
  const raw = process.argv.find((argument) => argument.startsWith("--mode="))
    ?.slice("--mode=".length).trim() ?? "dev";
  if (raw !== "dev" && raw !== "build" && raw !== "packaged") {
    throw new Error("--mode 只接受 dev、build 或 packaged。");
  }
  return raw;
}

function parsePackagedAppPath(mode: "dev" | "build" | "packaged"): string | undefined {
  const raw = process.argv.find((argument) => argument.startsWith("--appPath="))
    ?.slice("--appPath=".length).trim();
  if (mode !== "packaged") return undefined;
  if (!raw || !path.isAbsolute(raw)) throw new Error("packaged 模式必须提供绝对路径 --appPath=<.app>。");
  return path.resolve(raw);
}

function parseBudgetProfile(): "t23-compat" | "p7-strict" {
  return process.argv.includes("--strict") ? "p7-strict" : "t23-compat";
}

function shouldMeasureInteractions(): boolean {
  return process.argv.includes("--interactions");
}

const P7_STRICT_PERFORMANCE_BUDGET: T23ScalePerformanceBudget = {
  ...T23_SCALE_PERFORMANCE_BUDGET,
  maxRendererFirstCardMs: 1_500,
  maxRendererFirstRawMs: 5_000,
  maxRendererAllPassReferencesMs: 8_000,
  maxOutstandingProjectionIpc: 4,
};

function restoreEnvironment(previous: Map<string, string | undefined>): void {
  for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function readRawSnapshot(launched: LaunchedUi): Promise<UnitGridRawSnapshot> {
  return launched.page.evaluate(() => {
    const hook = (window as unknown as {
      __aiCanvasManagedStudioVerify?: {
        getUnitGridRawSnapshot?: () => UnitGridRawSnapshot;
      };
    }).__aiCanvasManagedStudioVerify;
    if (!hook?.getUnitGridRawSnapshot) throw new Error("缺少 T23 unit-grid raw 只读核对钩子。");
    return hook.getUnitGridRawSnapshot();
  });
}

async function readIpcProbe(launched: LaunchedUi): Promise<IpcProbeSnapshot> {
  return launched.page.evaluate(() => {
    const api = (window as unknown as {
      canvasApi?: {
        getT23IpcPerformanceProbeSnapshot?: () => IpcProbeSnapshot;
      };
    }).canvasApi;
    if (!api?.getT23IpcPerformanceProbeSnapshot) {
      throw new Error("缺少 T23 IPC 性能只读探针。");
    }
    return api.getT23IpcPerformanceProbeSnapshot();
  });
}

async function readRuntimeStartupGate(launched: LaunchedUi): Promise<RuntimeStartupGateSnapshot> {
  return launched.page.evaluate(async () => {
    const api = (window as unknown as {
      canvasApi?: { getRuntimeWriteGate?: () => Promise<RuntimeStartupGateSnapshot> };
    }).canvasApi;
    if (!api?.getRuntimeWriteGate) throw new Error("缺少运行时门禁诊断入口。 ");
    return api.getRuntimeWriteGate();
  });
}

function runtimeIpcChannel(snapshot: RuntimeStartupGateSnapshot, channel: string): {
  channel: string;
  effect: string;
  calls: number;
  failures: number;
} | undefined {
  return snapshot.runtimeIpcMetrics?.channels.find((entry) => entry.channel === channel);
}

function assertStartupRuntimeGateReadback(snapshot: RuntimeStartupGateSnapshot): void {
  const preflight = runtimeIpcChannel(snapshot, "canvas:preflight-active-managed-project-startup");
  const reconcile = runtimeIpcChannel(snapshot, "canvas:reconcile-active-managed-project-startup");
  const lifecycle = runtimeIpcChannel(snapshot, "canvas:ensure-active-managed-project-generation-watcher");
  const listProjects = runtimeIpcChannel(snapshot, "canvas:list-projects");
  if (!preflight || preflight.calls !== 1 || preflight.failures !== 0 || preflight.effect !== "read-only") {
    throw new Error(`T23 健康启动 preflight IPC 不精确：${JSON.stringify(preflight)}`);
  }
  if (reconcile && reconcile.calls !== 0) {
    throw new Error(`T23 健康启动错误进入旧 reconcile：${JSON.stringify(reconcile)}`);
  }
  if (!listProjects || listProjects.calls < 1 || listProjects.failures !== 0 || listProjects.effect !== "read-only") {
    throw new Error(`T23 启动项目列表没有走只读 cached-read：${JSON.stringify(listProjects)}`);
  }
  if (!lifecycle || lifecycle.calls !== 1 || lifecycle.failures !== 0 || lifecycle.effect !== "mutation") {
    throw new Error(`T23 首卡后 watcher 生命周期未真实完成：${JSON.stringify(lifecycle)}`);
  }
}

function assertStructuredStartupRuntimeGate(probe: IpcProbeSnapshot): void {
  const gate = probe.startupRuntimeGate;
  const baseline = gate?.baselineMutationChecks;
  const firstCard = gate?.firstCardMutationChecks;
  const final = gate?.finalMutationChecks;
  if (!gate || gate.schemaVersion !== 1
    || typeof baseline !== "number" || !Number.isSafeInteger(baseline)
    || typeof firstCard !== "number" || !Number.isSafeInteger(firstCard)
    || typeof final !== "number" || !Number.isSafeInteger(final)
    || baseline !== firstCard
    || final < firstCard + 1) {
    throw new Error(`T23 启动 runtime gate 结构化摘要不闭合：${JSON.stringify(gate)}`);
  }
}

function assertProjectionTimeline(probe: IpcProbeSnapshot): void {
  const projectionTimeline = probe.projectionTimeline;
  const expectedProjectionPhases = [
    "main-managed-project-preflight",
    "current-dashboard-binding",
    "panel-fanout",
    "timeline-approved-neighbors",
    "observation-review",
    "adjacent-pack-video",
    "frozen-reference-media",
    "assemble-digest",
    "core-total",
  ];
  if (!projectionTimeline
    || expectedProjectionPhases.some((phase) => !projectionTimeline.phases.some((entry) => entry.phase === phase))) {
    throw new Error("T23 深投影分阶段计时不完整。 ");
  }
  const mainPreflightMs = projectionTimeline.phases.find((entry) => entry.phase === "main-managed-project-preflight")!.durationMs;
  const coreTotalMs = projectionTimeline.phases.find((entry) => entry.phase === "core-total")!.durationMs;
  const bundleRoundtripMs = probe.channels.find((entry) => entry.channel === "canvas:get-studio-production-projection-bundle")?.lastDurationMs;
  if (typeof bundleRoundtripMs === "number" && mainPreflightMs + coreTotalMs > bundleRoundtripMs + 5) {
    throw new Error(`深投影阶段计时超过 IPC 往返：main=${mainPreflightMs} core=${coreTotalMs} ipc=${bundleRoundtripMs}`);
  }
}

function assertUnitsReadTimeline(probe: IpcProbeSnapshot): void {
  const timeline = probe.unitsReadTimeline;
  const expectedPhases = [
    "request-total",
    "main-managed-project-preflight",
    "dashboard-core-total",
    "dashboard-readonly-shell",
    "binding-owner-total",
    "binding-managed-inspect",
    "managed-inspect-shell",
    "managed-generation-ledger",
    "production-page",
    "production-facets",
    "binding-heads",
    "successors",
    "binding-map",
    "dashboard-map-digest",
  ];
  if (!timeline || expectedPhases.some(
    (phase) => !timeline.phases.some((entry) => entry.phase === phase),
  )) {
    throw new Error("T23 units 请求级分阶段计时不完整。 ");
  }
  const counters = timeline.counters;
  const expectedBusinessQueries = 6 + 2 * counters.returnedUnitCount;
  if (counters.returnedUnitCount !== UNIT_COUNT
    || counters.productionBusinessSqlExecutions !== expectedBusinessQueries
    || counters.unitPageQueries !== 1
    || counters.unitTimingQueries !== counters.returnedUnitCount
    || counters.episodeStartQueries !== counters.returnedUnitCount
    || counters.facetQueries !== 3
    || counters.bindingHeadQueries !== 1
    || counters.successorQueries !== 1) {
    throw new Error(
      `T23 units 匿名查询计数不闭合：units=${counters.returnedUnitCount} business=${counters.productionBusinessSqlExecutions}/${expectedBusinessQueries}`,
    );
  }
  const requestTotalMs = timeline.phases.find((entry) => entry.phase === "request-total")!.durationMs;
  const mainPreflightMs = timeline.phases.find((entry) => entry.phase === "main-managed-project-preflight")!.durationMs;
  const coreTotalMs = timeline.phases.find((entry) => entry.phase === "dashboard-core-total")!.durationMs;
  if (mainPreflightMs + coreTotalMs > requestTotalMs + 5) {
    throw new Error(
      `units 阶段计时超过请求总时长：main=${mainPreflightMs} core=${coreTotalMs} total=${requestTotalMs}`,
    );
  }
}

interface T23RawReferenceSpanTimeline {
  spanId: number;
  firstRawReadyAt?: number;
  allPassReferencesReadyAt?: number;
  completeAt?: number;
  passReferenceUnitIds: string[];
}

/**
 * 从 renderer 自己写入 probe 的精确事件中锁定最新未失效 span。
 * 不接受 CDP 观察/轮询完成时刻；ready 缺失时完整阶段一律失败关闭。
 */
function readLatestT23RawReferenceSpan(
  timeline: NonNullable<IpcProbeSnapshot["rendererStartupTimeline"]>,
): T23RawReferenceSpanTimeline | null {
  const starts = timeline.milestones
    .map((entry) => ({ entry, match: /^canvas-raw-span-start:(\d+)$/u.exec(entry.milestone) }))
    .filter((item): item is { entry: { milestone: string; atMs: number }; match: RegExpExecArray } => Boolean(item.match));
  const invalidated = new Set(timeline.milestones
    .map((entry) => /^canvas-raw-span-invalidated:(\d+)$/u.exec(entry.milestone)?.[1])
    .filter((spanId): spanId is string => Boolean(spanId)));
  const latest = starts
    .sort((left, right) => Number(left.match[1]) - Number(right.match[1]))
    .at(-1);
  if (!latest || invalidated.has(latest.match[1]!)) return null;
  const spanId = Number(latest.match[1]);
  const findUniqueAt = (pattern: RegExp): number | undefined => {
    const matches = timeline.milestones.filter((entry) => pattern.test(entry.milestone));
    return matches.length === 1 ? matches[0]!.atMs : undefined;
  };
  return {
    spanId,
    firstRawReadyAt: findUniqueAt(new RegExp(`^canvas-first-raw-ready:${spanId}$`, "u")),
    allPassReferencesReadyAt: findUniqueAt(new RegExp(`^canvas-all-pass-references-ready:${spanId}$`, "u")),
    completeAt: findUniqueAt(new RegExp(`^canvas-raw-span-complete:${spanId}$`, "u")),
    passReferenceUnitIds: timeline.milestones
      .map((entry) => new RegExp(`^canvas-all-pass-reference-unit:${spanId}:(.+)$`, "u").exec(entry.milestone)?.[1])
      .filter((unitId): unitId is string => Boolean(unitId)),
  };
}

function assertCompleteT23RawReferenceSpan(
  timeline: NonNullable<IpcProbeSnapshot["rendererStartupTimeline"]>,
  expectedPassUnitIds: ReadonlySet<string>,
): T23RawReferenceSpanTimeline {
  const span = readLatestT23RawReferenceSpan(timeline);
  if (!span || span.firstRawReadyAt === undefined
    || span.allPassReferencesReadyAt === undefined
    || span.completeAt === undefined
    || span.firstRawReadyAt > span.allPassReferencesReadyAt
    || span.allPassReferencesReadyAt > span.completeAt
    || span.passReferenceUnitIds.length !== expectedPassUnitIds.size
    || new Set(span.passReferenceUnitIds).size !== expectedPassUnitIds.size
    || span.passReferenceUnitIds.some((unitId, index) => (
      unitId !== [...expectedPassUnitIds].sort((left, right) => left.localeCompare(right))[index]
    ))) {
    throw new Error("T23 raw/reference 精确 span 未完整闭合或 fixture PASS 单元不精确。");
  }
  return span;
}

function assertRendererStartupTimeline(
  probe: IpcProbeSnapshot,
  expectedUnitIds: ReadonlySet<string>,
  expectedPassUnitIds: ReadonlySet<string>,
): void {
  const timeline = probe.rendererStartupTimeline;
  const requiredMilestones = [
    "app-mounted",
    "app-runtime-gate-start",
    "app-runtime-gate-ready",
    "app-bootstrap-reads-start",
    "app-bootstrap-reads-ready",
    "app-managed-shell-start",
    "app-managed-shell-ready",
    "app-startup-reconcile-start",
    "app-startup-reconcile-ready",
    "app-managed-studio-chunks-start",
    "app-managed-studio-chunks-ready",
    "canvas-mounted",
    "canvas-runtime-gate-start",
    "canvas-runtime-gate-ready",
    "canvas-units-start",
    "canvas-units-ready",
    "canvas-first-card-dom-ready",
    "canvas-dashboard-overview-start",
    "canvas-dashboard-overview-ready",
    "material-overview-start",
    "canvas-raw-activation-start",
  ];
  if (!timeline || timeline.schemaVersion !== 1) {
    throw new Error("T23 renderer 冷启动时间线缺失。");
  }
  const firstAt = new Map<string, number>();
  for (const entry of timeline.milestones) {
    if (!firstAt.has(entry.milestone)) firstAt.set(entry.milestone, entry.atMs);
  }
  const missing = requiredMilestones.filter((milestone) => !firstAt.has(milestone));
  if (missing.length) {
    throw new Error(`T23 renderer 冷启动时间线不完整：${missing.join(",")}`);
  }
  const firstCardMilestones = timeline.milestones.filter(
    (entry) => entry.milestone === "canvas-first-card-dom-ready",
  );
  const firstCardUnitMilestones = timeline.milestones.filter(
    (entry) => entry.milestone.startsWith("canvas-first-card-dom-unit:"),
  );
  const firstCardUnitId = firstCardUnitMilestones[0]?.milestone.slice(
    "canvas-first-card-dom-unit:".length,
  );
  if (firstCardMilestones.length !== 1
    || firstCardUnitMilestones.length !== 1
    || !firstCardUnitId
    || !expectedUnitIds.has(firstCardUnitId)
    || Math.abs(firstCardMilestones[0]!.atMs - firstCardUnitMilestones[0]!.atMs) > 2) {
    throw new Error("T23 首卡里程碑未唯一绑定当前 fixture 单元。");
  }
  for (const [start, ready] of [
    ["app-runtime-gate-start", "app-runtime-gate-ready"],
    ["app-bootstrap-reads-start", "app-bootstrap-reads-ready"],
    ["app-managed-shell-start", "app-managed-shell-ready"],
    ["app-managed-shell-ready", "app-startup-reconcile-start"],
    ["app-startup-reconcile-start", "app-startup-reconcile-ready"],
    ["app-startup-reconcile-ready", "canvas-mounted"],
    ["app-managed-shell-ready", "app-managed-studio-chunks-start"],
    ["app-managed-studio-chunks-start", "app-bootstrap-reads-ready"],
    ["app-managed-studio-chunks-start", "app-managed-studio-chunks-ready"],
    ["app-managed-studio-chunks-ready", "canvas-mounted"],
    ["canvas-runtime-gate-start", "canvas-runtime-gate-ready"],
    ["canvas-units-start", "canvas-units-ready"],
    ["canvas-units-ready", "canvas-first-card-dom-ready"],
    ["canvas-first-card-dom-ready", "canvas-dashboard-overview-start"],
    ["canvas-first-card-dom-ready", "material-overview-start"],
    ["canvas-dashboard-overview-start", "canvas-dashboard-overview-ready"],
    ["canvas-dashboard-overview-ready", "canvas-raw-activation-start"],
  ] as const) {
    const startAt = firstAt.get(start);
    const readyAt = firstAt.get(ready);
    if (startAt === undefined || readyAt === undefined || readyAt < startAt) {
      throw new Error(`T23 renderer 冷启动阶段顺序异常：${start} -> ${ready}`);
    }
  }
  for (const [start, ready] of [
    ["material-overview-start", "material-overview-ready"],
    ["canvas-layout-start", "canvas-layout-ready"],
    ["canvas-build-identity-start", "canvas-build-identity-ready"],
  ] as const) {
    const startAt = firstAt.get(start);
    const readyAt = firstAt.get(ready);
    if (startAt !== undefined && readyAt !== undefined && readyAt < startAt) {
      throw new Error(`T23 renderer 后台阶段顺序异常：${start} -> ${ready}`);
    }
  }
  const firstCardAt = firstAt.get("canvas-first-card-dom-ready");
  const identityStartAt = firstAt.get("canvas-build-identity-start");
  if (firstCardAt !== undefined && identityStartAt !== undefined && identityStartAt < firstCardAt) {
    throw new Error("T23 完整构建身份不得重新进入首卡关键路径。");
  }
  const rawReferenceSpan = assertCompleteT23RawReferenceSpan(timeline, expectedPassUnitIds);
  if (firstCardAt === undefined || rawReferenceSpan.firstRawReadyAt === undefined
    || rawReferenceSpan.firstRawReadyAt < firstCardAt) {
    throw new Error("T23 raw/reference 精确 span 不能早于首卡。");
  }
  const startupMutation = timeline.milestones.filter((entry) => (
    /^app-first-card-startup-mutation-checks:\d+:\d+$/u.test(entry.milestone)
  ));
  const watcherStart = firstAt.get("app-generation-watcher-lifecycle-start");
  const watcherReady = firstAt.get("app-generation-watcher-lifecycle-ready");
  if (startupMutation.length !== 1
    || watcherStart === undefined
    || watcherReady === undefined
    || firstAt.has("app-generation-watcher-lifecycle-failed")
    || firstCardAt === undefined
    || watcherStart < firstCardAt
    || watcherReady < watcherStart) {
    throw new Error("T23 首卡后的 watcher 生命周期时间线不完整或错误提前执行。 ");
  }
  const [, beforeText, afterText] = /^app-first-card-startup-mutation-checks:(\d+):(\d+)$/u
    .exec(startupMutation[0]!.milestone) ?? [];
  if (beforeText === undefined || afterText === undefined || Number(beforeText) !== Number(afterText)) {
    throw new Error(`T23 首卡前 startup mutationChecks 被读取路径增加：${startupMutation[0]!.milestone}`);
  }
}

function percentileType7(values: readonly number[], percentile: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  if (sorted.length === 1) return sorted[0]!;
  const rank = (sorted.length - 1) * percentile;
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  const weight = rank - lower;
  return (sorted[lower] ?? 0) * (1 - weight) + (sorted[upper] ?? 0) * weight;
}

function summarizeTimings(values: readonly number[]): TimingSummary {
  const mean = values.length
    ? values.reduce((total, value) => total + value, 0) / values.length
    : 0;
  return {
    count: values.length,
    p50Ms: Math.round(percentileType7(values, 0.5) * 100) / 100,
    p95Ms: Math.round(percentileType7(values, 0.95) * 100) / 100,
    maxMs: Math.round(Math.max(0, ...values) * 100) / 100,
    meanMs: Math.round(mean * 100) / 100,
  };
}

async function installInteractionProbe(launched: LaunchedUi): Promise<void> {
  await launched.page.evaluate(() => {
    interface BrowserInteractionProbe {
      frames: number[];
      longTasks: Array<{ startTime: number; duration: number }>;
      longTaskSupported: boolean;
      lastFrameAt: number;
      sampleFrame(now: number): void;
    }
    const probe: BrowserInteractionProbe = {
      frames: [],
      longTasks: [],
      longTaskSupported: true,
      lastFrameAt: performance.now(),
      sampleFrame(now: number): void {
        probe.frames.push(now - probe.lastFrameAt);
        probe.lastFrameAt = now;
        if (probe.frames.length < 20_000) requestAnimationFrame(probe.sampleFrame);
      },
    };
    (window as unknown as { __p7InteractionProbe: BrowserInteractionProbe })
      .__p7InteractionProbe = probe;
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          probe.longTasks.push({
            startTime: Math.round(entry.startTime * 100) / 100,
            duration: Math.round(entry.duration * 100) / 100,
          });
        }
      }).observe({ entryTypes: ["longtask"] });
    } catch {
      probe.longTaskSupported = false;
    }
    requestAnimationFrame(probe.sampleFrame);
  });
}

async function resetInteractionProbe(launched: LaunchedUi): Promise<void> {
  await launched.page.evaluate(() => {
    const probe = (window as unknown as {
      __p7InteractionProbe: {
        frames: number[];
        longTasks: Array<{ startTime: number; duration: number }>;
        lastFrameAt: number;
      };
    }).__p7InteractionProbe;
    probe.frames = [];
    probe.longTasks = [];
    probe.lastFrameAt = performance.now();
  });
}

async function readInteractionProbe(launched: LaunchedUi): Promise<InteractionProbeSnapshot> {
  return launched.page.evaluate(() => {
    const probe = (window as unknown as {
      __p7InteractionProbe: InteractionProbeSnapshot;
    }).__p7InteractionProbe;
    return {
      frames: [...probe.frames],
      longTasks: [...probe.longTasks],
      longTaskSupported: probe.longTaskSupported,
    };
  });
}

async function rendererNow(launched: LaunchedUi): Promise<number> {
  return launched.page.evaluate(() => performance.now());
}

async function rendererElapsed(launched: LaunchedUi, startedAt: number): Promise<number> {
  return launched.page.evaluate((start) => performance.now() - start, startedAt);
}

async function measureInteractions(
  launched: LaunchedUi,
): Promise<InteractionPerformanceEvidence> {
  await installInteractionProbe(launched);
  const visibleUnitNodeIds = await launched.page
    .locator(".vue-flow__node.unit-node")
    .evaluateAll((elements) => elements
      .map((element) => element.getAttribute("data-id") ?? "")
      .filter((id) => id.startsWith("unit:")));
  if (visibleUnitNodeIds.length < 2) {
    throw new Error(`暖切单元至少需要 2 个可见节点，当前 ${visibleUnitNodeIds.length}。`);
  }

  await launched.page.locator('[data-testid="managed-canvas-open-library"]').click();
  await launched.page
    .locator(".canvas-library .library-tabs button")
    .filter({ hasText: "15 秒分镜" })
    .click();
  const unitLibraryRows = launched.page.locator(".canvas-library .unit-list .library-item");
  await unitLibraryRows.nth(1).waitFor();
  const unitLibraryTargets: Array<{ index: number; unitId: string }> = [];
  for (const index of [0, 1]) {
    const text = await unitLibraryRows.nth(index).innerText();
    const unitId = text.match(/S\d+E\d+-U\d+/u)?.[0];
    if (!unitId) throw new Error(`素材库单元缺少可测双编号：${text}`);
    unitLibraryTargets.push({ index, unitId });
  }

  await resetInteractionProbe(launched);
  const warmUnitSwitchDurations: number[] = [];
  const warmUnitSwitchIds: string[] = [];
  for (let index = 0; index < 10; index += 1) {
    const target = unitLibraryTargets[(index + 1) % unitLibraryTargets.length]!;
    const unitId = target.unitId;
    const startedAt = await rendererNow(launched);
    await unitLibraryRows.nth(target.index).click({ force: true });
    await launched.page.waitForFunction((expectedUnitId) => {
      const context = document.querySelector('[data-testid="managed-canvas-context"]');
      // 暖切指标测量用户已经看见新单元上下文的时刻；后台 bundle/媒体读取
      // 另由本脚本末尾的 ≤5 秒 IPC 排空硬门约束，不能拿 aria-busy 混成首反馈。
      return Boolean(context?.textContent?.includes(expectedUnitId));
    }, unitId, { timeout: 5_000 });
    warmUnitSwitchDurations.push(await rendererElapsed(launched, startedAt));
    warmUnitSwitchIds.push(unitId);
  }
  await launched.page.getByRole("button", { name: "关闭素材库" }).click();
  const inspectorClose = launched.page.locator(".canvas-inspector .inspector-close");
  if (await inspectorClose.isVisible().catch(() => false)) {
    await inspectorClose.click();
  }
  await launched.page.waitForTimeout(100);

  const zoomInputDurations: number[] = [];
  const zoomIn = launched.page.locator(".vue-flow__controls-zoomin");
  const zoomOut = launched.page.locator(".vue-flow__controls-zoomout");
  for (let index = 0; index < 50; index += 1) {
    let startedAt = await rendererNow(launched);
    await zoomIn.click({ force: true });
    zoomInputDurations.push(await rendererElapsed(launched, startedAt));
    startedAt = await rendererNow(launched);
    await zoomOut.click({ force: true });
    zoomInputDurations.push(await rendererElapsed(launched, startedAt));
  }
  await launched.page.waitForTimeout(350);

  const draggableNodeId = await launched.page.evaluate(() => {
    const viewportMargin = 24;
    for (const element of document.querySelectorAll(".vue-flow__node.unit-node")) {
      if (!(element instanceof HTMLElement)) continue;
      const body = element.querySelector(".msc-node .body");
      if (!(body instanceof HTMLElement)) continue;
      const rect = body.getBoundingClientRect();
      const centerX = rect.x + rect.width / 2;
      const centerY = rect.y + rect.height / 2;
      if (rect.width >= 80
        && centerX >= viewportMargin
        && centerX <= window.innerWidth - viewportMargin
        && centerY >= viewportMargin
        && centerY <= window.innerHeight - viewportMargin) {
        return element.getAttribute("data-id");
      }
    }
    return null;
  });
  if (!draggableNodeId) throw new Error("缺少可拖动的 unit 节点 ID。");
  const draggableNode = launched.page.locator(
    `.vue-flow__node.unit-node[data-id="${draggableNodeId}"]`,
  );
  const dragFeedbackDurations: number[] = [];
  for (let index = 0; index < 10; index += 1) {
    const box = await draggableNode.boundingBox();
    const bodyBox = await draggableNode.locator(".msc-node .body").boundingBox();
    if (!box || !bodyBox) throw new Error(`拖拽节点离开视口：${draggableNodeId}`);
    const centerX = bodyBox.x + bodyBox.width / 2;
    const centerY = bodyBox.y + bodyBox.height / 2;
    await launched.page.mouse.move(centerX, centerY);
    await launched.page.mouse.down();
    await launched.page.evaluate((input) => {
      interface DragFeedbackProbe {
        beforeX: number;
        beforeY: number;
        armedAt: number;
        pointerMoveCount: number;
        startedAt?: number;
        feedbackAt?: number;
        timedOut: boolean;
        after?: {
          x: number;
          y: number;
          width: number;
          height: number;
        };
        handlePointerMove(): void;
        sampleVisiblePosition(now: number): void;
      }
      const probe: DragFeedbackProbe = {
        beforeX: input.beforeX,
        beforeY: input.beforeY,
        armedAt: performance.now(),
        pointerMoveCount: 0,
        timedOut: false,
        handlePointerMove(): void {
          probe.pointerMoveCount += 1;
          // Vue Flow 的第一次 pointermove 只跨过拖拽阈值，第二次才提交节点位置。
          // Playwright 从 renderer 外部逐步派发 mouse.move；若从探针安装或第一次
          // 阈值事件开始计时，会把两次输入事件间的自动化调度误算成应用反馈。
          if (probe.pointerMoveCount < 2) return;
          window.removeEventListener("pointermove", probe.handlePointerMove, true);
          probe.startedAt = performance.now();
          requestAnimationFrame(probe.sampleVisiblePosition);
        },
        sampleVisiblePosition(now: number): void {
          // rAF 形参是当前帧的基准时间，可能早于同一帧内刚处理的 pointer 事件；
          // 用回调内实时单调时钟结算，避免“同帧反馈”被记录成负时延。
          const sampledAt = Math.max(now, performance.now());
          const element = document.querySelector(input.selector);
          if (!(element instanceof HTMLElement) || probe.startedAt === undefined) {
            probe.timedOut = true;
            return;
          }
          const rect = element.getBoundingClientRect();
          if (Math.abs(rect.x - probe.beforeX) >= 10
            || Math.abs(rect.y - probe.beforeY) >= 6) {
            probe.feedbackAt = sampledAt;
            probe.after = {
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height,
            };
            return;
          }
          if (sampledAt - probe.startedAt >= 100) {
            probe.timedOut = true;
            return;
          }
          requestAnimationFrame(probe.sampleVisiblePosition);
        },
      };
      (window as unknown as { __p7DragFeedbackProbe: DragFeedbackProbe })
        .__p7DragFeedbackProbe = probe;
      window.addEventListener("pointermove", probe.handlePointerMove, true);
    }, {
      selector: `.vue-flow__node.unit-node[data-id="${draggableNodeId}"]`,
      beforeX: box.x,
      beforeY: box.y,
    });
    const direction = index % 2 === 0 ? 1 : -1;
    await launched.page.mouse.move(
      centerX + direction * 32,
      centerY + direction * 18,
      // Vue Flow 首个 pointermove 用来跨过拖拽阈值，第二个才提交可见位置。
      { steps: 2 },
    );
    await launched.page.waitForFunction(() => {
      const probe = (window as unknown as {
        __p7DragFeedbackProbe?: {
          feedbackAt?: number;
          timedOut: boolean;
        };
      }).__p7DragFeedbackProbe;
      return Boolean(probe && (probe.feedbackAt !== undefined || probe.timedOut));
    }, undefined, { polling: "raf", timeout: 500 });
    const dragProbe = await launched.page.evaluate(() => (
      (window as unknown as {
        __p7DragFeedbackProbe: {
          startedAt?: number;
          feedbackAt?: number;
          timedOut: boolean;
          after?: {
            x: number;
            y: number;
            width: number;
            height: number;
          };
        };
      }).__p7DragFeedbackProbe
    ));
    await launched.page.mouse.up();
    const afterBox = dragProbe.after ?? await draggableNode.boundingBox();
    const feedbackDuration = dragProbe.startedAt !== undefined
      && dragProbe.feedbackAt !== undefined
      ? dragProbe.feedbackAt - dragProbe.startedAt
      : 100;
    if (dragProbe.timedOut
      || !afterBox
      || (Math.abs(afterBox.x - box.x) < 10 && Math.abs(afterBox.y - box.y) < 6)) {
      throw new Error(
        `节点拖拽没有产生可见反馈：${JSON.stringify({
          draggableNodeId,
          iteration: index + 1,
          before: box,
          after: afterBox,
          feedbackDuration,
        })}`,
      );
    }
    dragFeedbackDurations.push(feedbackDuration);
  }

  const prePanProbe = await readInteractionProbe(launched);
  await resetInteractionProbe(launched);
  const flowShell = launched.page.locator('[data-testid="managed-canvas-flow-shell"]');
  const flowBox = await flowShell.boundingBox();
  if (!flowBox) throw new Error("画布平移测试缺少可见 flow shell。");
  const panStartedAt = await rendererNow(launched);
  const panCenterX = flowBox.x + flowBox.width / 2;
  const panCenterY = flowBox.y + flowBox.height / 2;
  await launched.page.mouse.move(panCenterX, panCenterY);
  await launched.page.mouse.down({ button: "middle" });
  for (let index = 0; index < 180; index += 1) {
    const phase = (index / 180) * Math.PI * 4;
    await launched.page.mouse.move(
      panCenterX + Math.sin(phase) * 90,
      panCenterY + Math.cos(phase) * 36,
      { steps: 1 },
    );
    await launched.page.waitForTimeout(8);
  }
  await launched.page.mouse.up({ button: "middle" });
  await launched.page.waitForTimeout(100);
  const panDurationMs = await rendererElapsed(launched, panStartedAt);
  const panProbe = await readInteractionProbe(launched);
  const frameIntervals = panProbe.frames.slice(1).filter((duration) => duration > 0);
  const frameSummary = summarizeTimings(frameIntervals);
  const averageFps = frameSummary.meanMs > 0
    ? Math.round((1_000 / frameSummary.meanMs) * 100) / 100
    : 0;
  const allProbe: InteractionProbeSnapshot = {
    frames: [...prePanProbe.frames, ...panProbe.frames],
    longTasks: [...prePanProbe.longTasks, ...panProbe.longTasks],
    longTaskSupported: prePanProbe.longTaskSupported && panProbe.longTaskSupported,
  };
  const maxLongTaskMs = Math.max(0, ...allProbe.longTasks.map((task) => task.duration));
  const checks: InteractionPerformanceEvidence["checks"] = [
    {
      id: "warm-unit-switch-p95",
      status: percentileType7(warmUnitSwitchDurations, 0.95) <= 500 ? "PASS" : "FAIL",
      actual: Math.round(percentileType7(warmUnitSwitchDurations, 0.95) * 100) / 100,
      comparator: "<=",
      budget: 500,
    },
    {
      id: "zoom-input-feedback-p95",
      status: percentileType7(zoomInputDurations, 0.95) <= 100 ? "PASS" : "FAIL",
      actual: Math.round(percentileType7(zoomInputDurations, 0.95) * 100) / 100,
      comparator: "<=",
      budget: 100,
    },
    {
      id: "drag-feedback-p95",
      status: percentileType7(dragFeedbackDurations, 0.95) <= 100 ? "PASS" : "FAIL",
      actual: Math.round(percentileType7(dragFeedbackDurations, 0.95) * 100) / 100,
      comparator: "<=",
      budget: 100,
    },
    {
      id: "canvas-pan-average-fps",
      status: averageFps >= 50 ? "PASS" : "FAIL",
      actual: averageFps,
      comparator: ">=",
      budget: 50,
    },
    {
      id: "canvas-pan-frame-p95",
      status: percentileType7(frameIntervals, 0.95) <= 20 ? "PASS" : "FAIL",
      actual: Math.round(percentileType7(frameIntervals, 0.95) * 100) / 100,
      comparator: "<=",
      budget: 20,
    },
    {
      id: "unexplained-long-task-max",
      status: maxLongTaskMs <= 200 ? "PASS" : "FAIL",
      actual: maxLongTaskMs,
      comparator: "<=",
      budget: 200,
    },
    {
      id: "long-task-observer-supported",
      status: allProbe.longTaskSupported ? "PASS" : "FAIL",
      actual: allProbe.longTaskSupported,
      comparator: "===",
      budget: true,
    },
  ];
  return {
    status: checks.every((check) => check.status === "PASS") ? "PASS" : "FAIL",
    budgets: {
      warmUnitSwitchP95Ms: 500,
      inputFeedbackP95Ms: 100,
      dragFeedbackP95Ms: 100,
      panAverageFpsMin: 50,
      panAverageFpsMax: 60,
      panFrameP95Ms: 20,
      unexplainedLongTaskMaxMs: 200,
    },
    warmUnitSwitch: {
      ...summarizeTimings(warmUnitSwitchDurations),
      sampleCount: 10,
      unitIds: warmUnitSwitchIds,
    },
    zoomInputFeedback: {
      ...summarizeTimings(zoomInputDurations),
      sampleCount: 100,
    },
    dragFeedback: {
      ...summarizeTimings(dragFeedbackDurations),
      sampleCount: 10,
      nodeId: draggableNodeId,
    },
    canvasPan: {
      sampleDurationMs: Math.round(panDurationMs * 100) / 100,
      frameCount: frameIntervals.length,
      frameIntervals: frameSummary,
      averageFps,
    },
    longTasks: {
      supported: allProbe.longTaskSupported,
      count: allProbe.longTasks.length,
      maxMs: maxLongTaskMs,
      overBudget: allProbe.longTasks.filter((task) => task.duration > 200),
    },
    checks,
  };
}

async function waitForRendererCycle(
  launched: LaunchedUi,
  expectedPassUnitIds: readonly string[],
): Promise<RendererCycleSnapshot> {
  const pageInput = {
    expectedPassUnitIds,
    drainBudgetMs: 5_000,
  };
  // 使用未经过 tsx/esbuild 改写的原生 .mjs 函数对象。Playwright 负责序列化并传参，
  // 不触发应用 CSP 的 unsafe-eval，也不会引用宿主 __name helper。
  const handle = await launched.page.waitForFunction(
    t23RendererCyclePageFunction,
    pageInput,
    { timeout: 30_000 },
  );
  const result = await handle.jsonValue() as RendererCyclePageResult;
  if (!result.ok) {
    if (result.error === "product-hook-missing") {
      throw new Error("T23 同一 Renderer 文档已完成 raw/reference，但产品只读核对钩子缺失。");
    }
    throw new Error(
      `T23 投影 IPC 未在 5000ms 内排空：outstanding=${result.ipcProbe?.currentOutstanding ?? "unknown"}`,
    );
  }
  return { ...result, contextAttempts: 1 };
}

async function decodeThumbnails(
  launched: LaunchedUi,
  urls: readonly string[],
): Promise<number> {
  return launched.page.evaluate(async (thumbnailUrls) => {
    const results = await Promise.all(thumbnailUrls.map((url) => new Promise<boolean>((resolve) => {
      const image = new Image();
      image.onload = () => resolve(image.naturalWidth > 0 && image.naturalHeight > 0);
      image.onerror = () => resolve(false);
      image.src = url;
    })));
    return results.filter(Boolean).length;
  }, urls);
}

async function createScaleFixture(
  fixtureParent: string,
): Promise<{
  root: string;
  passUnitIds: string[];
  passRawSha256s: string[];
  passReferenceSha256s: string[];
  expectedPassBindings: T23ScaleExpectedPassBinding[];
}> {
  const first = await createUnitGridFixtureProject(fixtureParent, {
    unitId: unitId(1),
    season: SEASON,
    episode: EPISODE,
    sequence: 1,
  });
  const passReferenceAssetIds = ["character-ahang"];
  for (let sequence = 2; sequence <= UNIT_COUNT; sequence += 1) {
    const requiredAssetId = sequence <= PASS_RAW_COUNT
      ? `character-t23-${String(sequence).padStart(2, "0")}`
      : undefined;
    if (requiredAssetId) {
      await createUnitGridFixtureCharacterAuthority(first.root, {
        assetId: requiredAssetId,
        name: `T23 角色 ${sequence}`,
        color: PASS_REFERENCE_COLORS[sequence - 1]!,
      });
      passReferenceAssetIds.push(requiredAssetId);
    }
    await addUnitGridFixtureUnit(first.root, {
      unitId: unitId(sequence),
      season: SEASON,
      episode: EPISODE,
      sequence,
      scriptRevisionId: first.scriptRevisionId,
      promptRevisionId: first.promptRevisionId,
      ...(requiredAssetId ? { requiredAssetId } : {}),
    });
  }

  const passReferenceSha256s: string[] = [];
  for (const assetId of [...passReferenceAssetIds, "prop-complete-mask"]) {
    const asset = await getStudioCanonicalAsset(first.root, assetId);
    const versionId = asset?.primaryAuthority?.versionId;
    const mediaSha256 = asset?.versions.find((version) => version.id === versionId)?.mediaSha256;
    if (!mediaSha256) throw new Error(`合成 fixture 缺少权威媒体：${assetId}`);
    await ensureStudioImageThumbnail(first.root, mediaSha256);
    if (passReferenceAssetIds.includes(assetId)) passReferenceSha256s.push(mediaSha256);
  }
  if (new Set(passReferenceSha256s).size !== PASS_RAW_COUNT) {
    throw new Error(`合成 fixture 冻结参考源 SHA 不唯一：${new Set(passReferenceSha256s).size}/${PASS_RAW_COUNT}`);
  }

  const passUnitIds = Array.from({ length: PASS_RAW_COUNT }, (_, index) => unitId(index + 1));
  const passRawSha256s: string[] = [];
  const expectedPassBindings: T23ScaleExpectedPassBinding[] = [];
  for (const [index, currentUnitId] of passUnitIds.entries()) {
    // 首单元没有上一镜，Core 明确禁止伪造 continuation waiver；
    // 仅后续测试单元使用显式 fixture receipt。
    const waiver = index === 0
      ? undefined
      : await unitGridFixtureContinuationWaiver(
        first.root,
        currentUnitId,
        `t23-scale-synthetic-${currentUnitId}`,
      );
    const run = await freezeDispatchPrepareUnitGrid(
      first.root,
      currentUnitId,
      `t23-scale-run-${String(index + 1).padStart(2, "0")}`,
      { ...(waiver ? { continuationWaiver: waiver } : {}) },
    );
    const bundle = await commitUnitGridBundle(
      first.root,
      run,
      `t23-scale-${String(index + 1).padStart(2, "0")}`,
      {
        rawColor: PASS_RAW_COLORS[index]!,
        labeledColor: PASS_LABELED_COLORS[index]!,
      },
    );
    const frozenReferenceSha256s = run.pack.pack.controlReferences
      .map((reference) => reference.mediaSha256);
    if (frozenReferenceSha256s.length !== 1
      || frozenReferenceSha256s[0] !== passReferenceSha256s[index]) {
      throw new Error(
        `${currentUnitId} 冻结参考未绑定本单元唯一权威：${frozenReferenceSha256s.join(",")}`,
      );
    }
    passRawSha256s.push(bundle.raw.mediaSha256);
    expectedPassBindings.push({
      unitId: currentUnitId,
      rawMediaSha256: bundle.raw.mediaSha256,
      referenceMediaSha256: passReferenceSha256s[index]!,
    });
    await Promise.all([
      ensureStudioImageThumbnail(first.root, bundle.raw.mediaSha256),
      ensureStudioImageThumbnail(first.root, bundle.labeled.mediaSha256),
    ]);
    await passUnitGridReview(
      first.root,
      run,
      bundle,
      `t23-scale-review-${String(index + 1).padStart(2, "0")}`,
      {
        reviewer: "t23-synthetic-scale-fixture",
        note: "可重复纯色 PNG 合成夹具，仅做机械链路与性能验收；不构成人工视觉验收。",
      },
    );
  }
  if (new Set(passRawSha256s).size !== PASS_RAW_COUNT) {
    throw new Error(`合成 fixture raw SHA 不唯一：${new Set(passRawSha256s).size}/${PASS_RAW_COUNT}`);
  }
  return {
    root: first.root,
    passUnitIds,
    passRawSha256s,
    passReferenceSha256s,
    expectedPassBindings,
  };
}

async function main(): Promise<number> {
  const reportPath = parseReportPath();
  const mode = parseMode();
  const packagedAppPath = parsePackagedAppPath(mode);
  const budgetProfile = parseBudgetProfile();
  const interactionsRequested = shouldMeasureInteractions();
  const workspace = path.resolve(process.cwd());
  const runtimeRoot = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "t23-source-dev-scale-")),
  );
  const fixtureParent = path.join(runtimeRoot, "fixture-projects");
  const registryPath = path.join(runtimeRoot, "registry", "projects.json");
  const managedProjectsRoot = path.join(runtimeRoot, "managed-projects");
  const mediaRuntimeRoot = path.join(runtimeRoot, "media-runtime");
  const userDataRoot = path.join(runtimeRoot, "electron-user-data");
  await Promise.all([
    mkdir(fixtureParent, { recursive: true }),
    mkdir(path.dirname(registryPath), { recursive: true }),
    mkdir(managedProjectsRoot, { recursive: true }),
    mkdir(mediaRuntimeRoot, { recursive: true }),
    mkdir(userDataRoot, { recursive: true }),
    mkdir(path.dirname(reportPath), { recursive: true }),
  ]);

  const environmentKeys = [
    "AI_CANVAS_PROJECT_ROOT",
    "AI_CANVAS_REGISTRY_PATH",
    "AI_CANVAS_MANAGED_PROJECTS_ROOT",
    "AI_CANVAS_MEDIA_RUNTIME_DIR",
    "AI_CANVAS_T23_PERF_PROBE",
    "AI_CANVAS_ELECTRON_BACKGROUND_SMOKE",
  ] as const;
  const previousEnvironment = new Map(
    environmentKeys.map((key) => [key, process.env[key]]),
  );
  process.env.AI_CANVAS_REGISTRY_PATH = registryPath;
  process.env.AI_CANVAS_MANAGED_PROJECTS_ROOT = managedProjectsRoot;
  process.env.AI_CANVAS_MEDIA_RUNTIME_DIR = mediaRuntimeRoot;
  process.env.AI_CANVAS_T23_PERF_PROBE = "1";
  process.env.AI_CANVAS_ELECTRON_BACKGROUND_SMOKE = "1";

  let launched: LaunchedUi | undefined;
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  let report: SmokeReport = {
    schemaVersion: 1,
    kind: "t23-scale-performance",
    status: "FAIL",
    ok: false,
    mode,
    budgetProfile,
    createdAt: new Date().toISOString(),
    fixture: {
      kind: "deterministic-synthetic-mechanical-fixture",
      visualAcceptance: false,
      aiImageGeneration: false,
      isolatedTemporaryProject: true,
      unitCount: UNIT_COUNT,
      passRawCount: PASS_RAW_COUNT,
      note: "所有图均为 sharp 生成的可解码纯色 PNG；PASS 仅表示测试账本闭环，不代表视觉质量。",
    },
    consoleErrors,
    pageErrors,
  };

  try {
    const fixture = await createScaleFixture(fixtureParent);
    process.env.AI_CANVAS_PROJECT_ROOT = fixture.root;
    await registerProject((await inspectManagedProject(fixture.root)).project);
    await setActiveProjectRegistration(fixture.root);
    const projection = await getApprovedTimelineProjection(fixture.root, {
      season: SEASON,
      episode: EPISODE,
      fastMode: true,
    });
    if (projection.unitCount !== UNIT_COUNT || projection.summary.pass !== PASS_RAW_COUNT) {
      throw new Error(
        `合成 fixture 投影不闭合：units=${projection.unitCount} pass=${projection.summary.pass}`,
      );
    }

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      AI_CANVAS_PROJECT_ROOT: fixture.root,
      AI_CANVAS_REGISTRY_PATH: registryPath,
      AI_CANVAS_MANAGED_PROJECTS_ROOT: managedProjectsRoot,
      AI_CANVAS_MEDIA_RUNTIME_DIR: mediaRuntimeRoot,
      AI_CANVAS_T23_PERF_PROBE: "1",
      AI_CANVAS_ELECTRON_BACKGROUND_SMOKE: "1",
      AI_CANVAS_WINDOW_WIDTH: "1728",
      AI_CANVAS_WINDOW_HEIGHT: "1029",
      ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
    };
    const devLaunchStarted = performance.now();
    const devLogTail: string[] = [];
    if (mode === "packaged") {
      launched = await launchInstalledElectron({
        appPath: packagedAppPath!,
        userDataRoot,
        env,
      });
    } else if (mode === "build") {
      await assertBuildArtifacts(workspace);
      launched = await launchBuiltElectron({ workspace, userDataRoot, env });
    } else {
      launched = await launchDevElectron({ workspace, userDataRoot, env, logTail: devLogTail });
    }
    const devToolchainToCdpReadyMs = Math.round(performance.now() - devLaunchStarted);
    launched.page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    launched.page.on("pageerror", (error) => pageErrors.push(error.message));
    if (launched.page.url() === "about:blank") {
      await launched.page.waitForURL((url) => url.toString() !== "about:blank", { timeout: 30_000 });
    }
    const runtimeBuildIdentity = mode === "build"
      ? await assertWorkspaceRuntimeBuildIdentity(workspace, launched.page)
      : undefined;
    const initialRendererTimeOrigin = await launched.page.evaluate(() => performance.timeOrigin);
    let rendererDocumentReloadCount = 0;
    const onMainFrameNavigated = (frame: { url(): string }) => {
      if (frame !== launched?.page.mainFrame()) return;
      rendererDocumentReloadCount += 1;
    };
    launched.page.on("framenavigated", onMainFrameNavigated);

    const rendererCycle = await waitForRendererCycle(launched, fixture.passUnitIds);
    const {
      rendererFirstCardMs,
      rendererFirstRawMs,
      rendererAllPassReferencesMs,
      rawSnapshot,
    } = rendererCycle;
    let drainDurationMs = rendererCycle.drainDurationMs;
    let probe = rendererCycle.ipcProbe;
    let drainStatus: "PASS" | "FAIL" = "PASS";
    if (!probe.enabled) throw new Error("T23 IPC 探针未启用。");
    assertUnitsReadTimeline(probe);
    const expectedUnitIds = new Set(Array.from({ length: UNIT_COUNT }, (_, index) => unitId(index + 1)));
    await launched.page.waitForFunction(async () => {
      const api = (window as unknown as {
        canvasApi?: { getRuntimeWriteGate?: () => Promise<RuntimeStartupGateSnapshot> };
      }).canvasApi;
      const gate = await api?.getRuntimeWriteGate?.();
      return gate?.runtimeIpcMetrics?.channels.some((entry) => (
        entry.channel === "canvas:ensure-active-managed-project-generation-watcher"
        && entry.calls === 1
        && entry.failures === 0
      ));
    }, undefined, { timeout: 20_000 });
    // lifecycle IPC 的成功记录只会在 main 确认 watcher 已真实挂载后落下；重读
    // renderer probe 后再断言 ready 里程碑，避免首卡后微任务调度形成假阴性。
    probe = await readIpcProbe(launched);
    assertRendererStartupTimeline(probe, expectedUnitIds, new Set(fixture.passUnitIds));
    const runtimeStartupGate = await readRuntimeStartupGate(launched);
    assertStartupRuntimeGateReadback(runtimeStartupGate);
    const finalMutationChecks = runtimeStartupGate.runtimeGateMetrics?.mutationChecks;
    if (typeof finalMutationChecks !== "number" || !Number.isSafeInteger(finalMutationChecks)) {
      throw new Error("T23 无法读取 final runtime gate mutationChecks。");
    }
    await launched.page.evaluate((mutationChecks) => {
      (window as unknown as {
        canvasApi?: {
          recordT23StartupRuntimeGate?: (
            phase: "final",
            value: number,
          ) => void;
        };
      }).canvasApi?.recordT23StartupRuntimeGate?.("final", mutationChecks);
    }, finalMutationChecks);
    probe = await readIpcProbe(launched);
    assertStructuredStartupRuntimeGate(probe);
    const rendererProbe = summarizeT23ScaleRendererProbe(rawSnapshot, fixture.passUnitIds);
    const projectedUnitIds = new Set(rawSnapshot.unitNodeIds);
    if (rawSnapshot.unitNodeIds.length !== UNIT_COUNT
      || projectedUnitIds.size !== UNIT_COUNT
      || [...expectedUnitIds].some((id) => !projectedUnitIds.has(id))) {
      throw new Error(
        `renderer 实际 unit 节点不闭合：rows=${rawSnapshot.unitNodeIds.length} unique=${projectedUnitIds.size}/${UNIT_COUNT}`,
      );
    }
    const {
      rawThumbnailUrls: rawUrls,
      referenceThumbnailUrls: referenceUrls,
    } = assertT23ScaleExactPassBindings(rawSnapshot, fixture.expectedPassBindings);
    const [decodedRawThumbnailCount, decodedReferenceThumbnailCount] = await Promise.all([
      decodeThumbnails(launched, rawUrls),
      decodeThumbnails(launched, referenceUrls),
    ]);
    if (decodedRawThumbnailCount !== PASS_RAW_COUNT) {
      throw new Error(
        `PASS raw 缩略图解码不足：${decodedRawThumbnailCount}/${PASS_RAW_COUNT}`,
      );
    }
    if (decodedReferenceThumbnailCount < PASS_RAW_COUNT) {
      throw new Error(
        `冻结参考缩略图解码不足：${decodedReferenceThumbnailCount}/${PASS_RAW_COUNT}`,
      );
    }
    const interactions = interactionsRequested
      ? await measureInteractions(launched)
      : undefined;
    if (interactionsRequested) {
      const interactionDrainStartedAt = performance.now();
      try {
        await launched.page.waitForFunction(async () => {
          const api = (window as unknown as {
            canvasApi?: {
              getT23IpcPerformanceProbeSnapshot?: () => Promise<IpcProbeSnapshot>;
            };
          }).canvasApi;
          const snapshot = await api?.getT23IpcPerformanceProbeSnapshot?.();
          return snapshot?.currentOutstanding === 0;
        }, undefined, { timeout: 5_000 });
      } catch {
        drainStatus = "FAIL";
      }
      drainDurationMs += Math.round(performance.now() - interactionDrainStartedAt);
      probe = await readIpcProbe(launched);
      assertProjectionTimeline(probe);
    }
    const evaluation = evaluateT23ScalePerformance({
      fixtureUnitCount: projection.unitCount,
      ...rendererProbe,
      devToolchainToCdpReadyMs,
      rendererFirstCardMs,
      rendererFirstRawMs,
      rendererAllPassReferencesMs,
      peakOutstandingProjectionIpc: probe.peakOutstanding,
    }, budgetProfile === "p7-strict" ? P7_STRICT_PERFORMANCE_BUDGET : undefined);
    const visibleUnitNodeCount = await launched.page.locator(".vue-flow__node.unit-node").count();
    const projectMetricsText = (await launched.page
      .locator('[data-testid="managed-canvas-metrics"]')
      .innerText())
      .replace(/\s+/gu, " ")
      .trim();
    const buildIdentityText = (await launched.page
      .locator('[data-testid="build-identity"]')
      .innerText())
      .replace(/\s+/gu, " ")
      .trim();
    if (!new RegExp(`\\b${UNIT_COUNT}\\s*单元`, "u").test(projectMetricsText)) {
      throw new Error(`画布项目概览未显示 ${UNIT_COUNT} 单元：${projectMetricsText}`);
    }
    if (consoleErrors.length || pageErrors.length) {
      throw new Error(
        `renderer 出现错误：console=${consoleErrors.length} page=${pageErrors.length}`,
      );
    }
    const finalRendererTimeOrigin = await launched.page.evaluate(() => performance.timeOrigin);
    if (rendererCycle.timeOrigin !== initialRendererTimeOrigin
      || finalRendererTimeOrigin !== rendererCycle.timeOrigin
      || rendererDocumentReloadCount > 0) {
      throw new Error(
        `T23 Renderer 在严格测量期间发生重载：reloads=${rendererDocumentReloadCount}`,
      );
    }
    launched.page.off("framenavigated", onMainFrameNavigated);
    const ipcDrain: NonNullable<SmokeReport["ipcDrain"]> = {
      budgetMs: 5_000,
      durationMs: drainDurationMs,
      currentOutstanding: probe.currentOutstanding,
      status: drainStatus === "PASS" && probe.currentOutstanding === 0 ? "PASS" : "FAIL",
    };
    report = {
      ...report,
      ...(runtimeBuildIdentity ? { runtimeBuildIdentity } : {}),
      status: evaluation.status,
      ok: evaluation.ok,
      performance: evaluation,
      ui: {
        visibleUnitNodeCount,
        projectedUnitNodeCount: rendererProbe.projectedUnitNodeCount,
        rendererProbe,
        projectMetricsText,
        buildIdentityText,
        rawSnapshot: redactT23ScaleRendererProbeForEvidence(rawSnapshot),
        decodedRawThumbnailCount,
        decodedReferenceThumbnailCount,
      },
      ipcProbe: probe,
      ipcDrain,
      ...(interactions ? { interactions } : {}),
      rendererDocument: {
        timeOrigin: rendererCycle.timeOrigin,
        contextAttempts: rendererCycle.contextAttempts,
        reloadCount: rendererDocumentReloadCount,
      },
    };
    if (ipcDrain.status !== "PASS") {
      report.status = "FAIL";
      report.ok = false;
      report.error = `投影 IPC 未在 5000ms 内排空：outstanding=${probe.currentOutstanding}`;
    }
    if (interactions?.status === "FAIL") {
      report.status = "FAIL";
      report.ok = false;
      report.error = "P7 交互性能硬门未通过。";
    }
  } catch (error) {
    const rawError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    process.stderr.write(`[t23-scale-performance] ${rawError}\n`);
    report.error = "T23_SMOKE_FAILED";
    if (launched) {
      const [rawSnapshot, ipcProbe, runtimeStartupGate] = await Promise.all([
        readRawSnapshot(launched).catch(() => undefined),
        readIpcProbe(launched).catch(() => undefined),
        readRuntimeStartupGate(launched).catch(() => undefined),
      ]);
      if (ipcProbe) report.ipcProbe = ipcProbe;
      report.failureDiagnostics = {
        errorKind: t23EvidenceErrorKind(error),
        ...(rawSnapshot
          ? { rawSnapshot: redactT23ScaleRendererProbeForEvidence(rawSnapshot) }
          : {}),
        ...(ipcProbe ? { ipcProbe } : {}),
        ...(runtimeStartupGate
          ? { runtimeStartupGate: summarizeRuntimeStartupGate(runtimeStartupGate) }
          : {}),
      };
    }
  } finally {
    await launched?.close().catch(() => undefined);
    restoreEnvironment(previousEnvironment);
    // Electron 主进程退出后，Chromium Shared Dictionary helper 偶尔会迟到落最后一批
    // userData 文件；分两次清理，防止已完成的临时 smoke 残留空壳目录。
    await new Promise((resolve) => setTimeout(resolve, 250));
    await rm(runtimeRoot, { recursive: true, force: true });
    await new Promise((resolve) => setTimeout(resolve, 500));
    await rm(runtimeRoot, { recursive: true, force: true });
  }

  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  process.stdout.write(`${JSON.stringify({
    status: report.status,
    ok: report.ok,
    reportPath,
    measurements: report.performance?.measurements,
    failedChecks: report.performance?.checks.filter((check) => check.status === "FAIL"),
    error: report.error,
  }, null, 2)}\n`);
  return report.ok ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 2;
  },
);
