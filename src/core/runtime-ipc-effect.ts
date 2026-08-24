import path from "node:path";

/**
 * 源码 Electron 运行时的 IPC 副作用策略。
 *
 * 这里登记的是“物理副作用”，不是按 get/list/pick 等名称猜测。任何未登记
 * 通道都按 mutation 处理；只有经过零写验证的通道才可进入 read-only。
 */
export type RuntimeIpcEffect =
  | "diagnostic-read"
  | "read-only"
  | "mutation"
  | "external-side-effect";

export type RuntimeIpcGateMode = "bypass" | "cached-read" | "strong";

/**
 * 同一通道上按 invocation 再细分时使用。缺省/未知字段必须让调用方走
 * mutation，不能把“看起来像读取”的参数猜成只读。
 */
export interface RuntimeIpcEffectContext {
  readonly operation?: string;
  /** canvas:list-projects 经完整入参语法校验后的零刷新读取形态。 */
  readonly projectListReadOnly?: true;
}

export const RUNTIME_GATE_DIAGNOSTIC_READ_CHANNELS = new Set<string>([
  "canvas:get-runtime-write-gate",
  "canvas:get-runtime-build-identity",
]);

/**
 * 当前仅登记不创建目录、不打开可写 SQLite、不初始化 ledger/watcher 的物理读取。
 * Studio 的多数 get/list 仍会做惰性初始化，必须先改成端到端只读后才能加入。
 */
export const RUNTIME_GATE_READ_ONLY_CHANNELS = new Set<string>([
  "canvas:get-active-project",
  "canvas:preflight-active-managed-project-startup",
  "canvas:get-active-hybrid-workspace-preference",
  "canvas:get-managed-project-shell",
  "canvas:get-default-managed-projects-root",
  "canvas:get-managed-project-operation-state",
  "canvas:get-local-creative-project-ingest-status",
  "canvas:novel-get-workspace",
  "canvas:novel-get-navigation",
  "canvas:novel-list-chapters",
  "canvas:novel-read-chapter",
  "canvas:novel-search-chapters",
  "canvas:novel-list-facts",
  "canvas:list-global-studio-assets",
  "canvas:list-global-studio-asset-images",
  "canvas:get-global-studio-asset-image",
  "canvas:list-global-studio-image-resources",
  "canvas:get-global-studio-image-resource",
  "canvas:list-global-studio-media-resources",
  "canvas:get-global-studio-media-resource",
  "canvas:load-studio-canvas-layout",
  "canvas:get-studio-unit-write-leases",
]);

/**
 * 驾驶舱通道混有仍会 inspectManagedProject / 初始化 ledger 的 operation。
 * 整通道不能进 READ_ONLY；只放已经端到端只读（requireManagedStudioProjectReadOnly
 * + inspectManagedProjectReadOnly）的 units。overview/unit/assets 等保持 mutation。
 */
export const RUNTIME_GATE_DASHBOARD_CHANNEL = "canvas:get-studio-production-dashboard";
export const RUNTIME_GATE_READ_ONLY_DASHBOARD_OPERATIONS = new Set<string>([
  "units",
]);

export const RUNTIME_GATE_PROJECT_LIST_CHANNEL = "canvas:list-projects";
const PROJECT_LIST_OPTION_KEYS = new Set(["refreshSources", "sourceProjectRoot", "requestId"]);
const PROJECT_LIST_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

/**
 * 会打开系统选择器、访问系统 shell/剪贴板或对外部进程产生影响的接口。它们与
 * mutation 一样使用强门禁，但单独分类，便于审计与性能探针识别。
 */
export const RUNTIME_GATE_EXTERNAL_SIDE_EFFECT_CHANNELS = new Set<string>([
  "canvas:pick-managed-projects-parent",
  "canvas:pick-studio-media-files",
  "canvas:show-in-folder",
  "canvas:open-path",
  "canvas:pick-project",
  "canvas:pick-story-source",
  "canvas:pick-otio",
  "canvas:copy-text",
]);

/**
 * 启动/恢复的这些通道即使健康路径通常只读，也可能持有 activation fence、推进
 * pending restore 或执行必要 compatibility repair，必须始终走强门禁。
 */
export const RUNTIME_GATE_MUTATION_CHANNELS = new Set<string>([
  "canvas:reconcile-active-managed-project-startup",
  "canvas:validate-restored-managed-project-shell",
  "canvas:release-restored-managed-project-shell-validation",
]);

function isReadOnlyDashboardInvocation(
  channel: string,
  context?: RuntimeIpcEffectContext,
): boolean {
  return channel === RUNTIME_GATE_DASHBOARD_CHANNEL
    && typeof context?.operation === "string"
    && RUNTIME_GATE_READ_ONLY_DASHBOARD_OPERATIONS.has(context.operation);
}

function isReadOnlyProjectListInvocation(context?: RuntimeIpcEffectContext): boolean {
  return context?.projectListReadOnly === true;
}

function isStrictReadOnlyProjectListOptions(value: unknown): boolean {
  // parseProjectListRequestOptions 明确把 undefined/null 归一为缺省 options。
  if (value === undefined || value === null) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !PROJECT_LIST_OPTION_KEYS.has(key))) return false;
  if (record.refreshSources === true) return false;
  if (record.refreshSources !== undefined && typeof record.refreshSources !== "boolean") return false;
  if (record.sourceProjectRoot !== undefined
    && (typeof record.sourceProjectRoot !== "string"
      || !path.isAbsolute(record.sourceProjectRoot)
      || record.sourceProjectRoot.length > 4_096)) return false;
  if (record.requestId !== undefined
    && (typeof record.requestId !== "string" || !PROJECT_LIST_REQUEST_ID.test(record.requestId))) return false;
  return true;
}

/**
 * ipcMain.handle listener 的 args 是 (event, ...invokeArgs)。
 * 驾驶舱 query 在 args[2]；缺字段或非对象时返回 undefined，调用方按 mutation。
 */
export function runtimeIpcEffectContextFromInvokeArgs(
  channel: string,
  args: readonly unknown[],
): RuntimeIpcEffectContext | undefined {
  if (channel === RUNTIME_GATE_PROJECT_LIST_CHANNEL) {
    return isStrictReadOnlyProjectListOptions(args[1]) ? { projectListReadOnly: true } : undefined;
  }
  if (channel !== RUNTIME_GATE_DASHBOARD_CHANNEL) return undefined;
  const query = args[2];
  if (!query || typeof query !== "object" || Array.isArray(query)) return undefined;
  const operation = (query as { operation?: unknown }).operation;
  return typeof operation === "string" ? { operation } : undefined;
}

/** 兼容旧调用方；语义仅代表“wrapper 不能无条件绕过门禁”。 */
export function runtimeGateRequiredForIpc(
  channel: string,
  context?: RuntimeIpcEffectContext,
): boolean {
  return runtimeIpcGateMode(channel, context) !== "bypass";
}

export function runtimeIpcEffect(
  channel: string,
  context?: RuntimeIpcEffectContext,
): RuntimeIpcEffect {
  if (RUNTIME_GATE_DIAGNOSTIC_READ_CHANNELS.has(channel)) return "diagnostic-read";
  if (RUNTIME_GATE_READ_ONLY_CHANNELS.has(channel)) return "read-only";
  if (isReadOnlyDashboardInvocation(channel, context)) return "read-only";
  if (channel === RUNTIME_GATE_PROJECT_LIST_CHANNEL && isReadOnlyProjectListInvocation(context)) return "read-only";
  if (RUNTIME_GATE_EXTERNAL_SIDE_EFFECT_CHANNELS.has(channel)) return "external-side-effect";
  if (RUNTIME_GATE_MUTATION_CHANNELS.has(channel)) return "mutation";
  return "mutation";
}

export function runtimeIpcGateMode(
  channel: string,
  context?: RuntimeIpcEffectContext,
): RuntimeIpcGateMode {
  const effect = runtimeIpcEffect(channel, context);
  if (effect === "diagnostic-read") return "bypass";
  if (effect === "read-only") return "cached-read";
  return "strong";
}
