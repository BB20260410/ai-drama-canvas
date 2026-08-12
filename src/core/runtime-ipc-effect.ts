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

/** 兼容旧调用方；语义仅代表“wrapper 不能无条件绕过门禁”。 */
export function runtimeGateRequiredForIpc(channel: string): boolean {
  return runtimeIpcGateMode(channel) !== "bypass";
}

export function runtimeIpcEffect(channel: string): RuntimeIpcEffect {
  if (RUNTIME_GATE_DIAGNOSTIC_READ_CHANNELS.has(channel)) return "diagnostic-read";
  if (RUNTIME_GATE_READ_ONLY_CHANNELS.has(channel)) return "read-only";
  if (RUNTIME_GATE_EXTERNAL_SIDE_EFFECT_CHANNELS.has(channel)) return "external-side-effect";
  if (RUNTIME_GATE_MUTATION_CHANNELS.has(channel)) return "mutation";
  return "mutation";
}

export function runtimeIpcGateMode(channel: string): RuntimeIpcGateMode {
  const effect = runtimeIpcEffect(channel);
  if (effect === "diagnostic-read") return "bypass";
  if (effect === "read-only") return "cached-read";
  return "strong";
}
