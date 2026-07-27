/**
 * 源码 MCP 工具的物理副作用策略。
 *
 * 工具名或 readOnlyHint 不能证明物理零写：不少历史 get/list 路径会惰性建库、
 * 迁移 schema、创建 lock/WAL 或刷新 watcher。因此只把经过端到端零写测试的工具
 * 放入 read-only；未知工具一律按 mutation 使用强门禁。
 */
export type RuntimeMcpEffect =
  | "diagnostic-read"
  | "read-only"
  | "mutation"
  | "external-side-effect";

export type RuntimeMcpGateMode = "bypass" | "cached-read" | "strong";

export const RUNTIME_GATE_DIAGNOSTIC_MCP_TOOLS = new Set<string>([
  "get_capabilities",
]);

export const RUNTIME_GATE_READ_ONLY_MCP_TOOLS = new Set<string>([
  "get_active_managed_studio_context",
  "get_canvas_state",
  "list_context",
  "list_story_sources",
  "list_story_chapters",
  "read_story_chapter",
  "list_story_events",
  "list_voice_identities",
  "list_asset_relations",
]);

/**
 * 已确认会启动进程、打开系统资源或触发外部供应方动作的工具。它们仍与 mutation
 * 一样使用强门禁；单独分类只用于审计与性能观测。
 */
export const RUNTIME_GATE_EXTERNAL_SIDE_EFFECT_MCP_TOOLS = new Set<string>([
  "process_generation_queue",
  "start_edit_render",
  "probe_novel_analysis_provider",
  "execute_next_novel_analysis_run_task",
]);

export function runtimeMcpEffect(toolName: string): RuntimeMcpEffect {
  if (RUNTIME_GATE_DIAGNOSTIC_MCP_TOOLS.has(toolName)) return "diagnostic-read";
  if (RUNTIME_GATE_READ_ONLY_MCP_TOOLS.has(toolName)) return "read-only";
  if (RUNTIME_GATE_EXTERNAL_SIDE_EFFECT_MCP_TOOLS.has(toolName)) return "external-side-effect";
  return "mutation";
}

export function runtimeMcpGateMode(toolName: string): RuntimeMcpGateMode {
  const effect = runtimeMcpEffect(toolName);
  if (effect === "diagnostic-read") return "bypass";
  if (effect === "read-only") return "cached-read";
  return "strong";
}
