/**
 * Qwen D5 · 导演动作面板（改写 Palette）
 *
 * 仅导演只读/导航动作；禁止「任意 execute_command」。
 * UI 负责展示；调用方把 payload 交给既有只读 API。
 */

import type { GatedHotkeyActionId } from "./use-gated-hotkeys.js";

export type DirectorActionKind =
  | "navigate-earliest"
  | "open-align-board"
  | "open-reader"
  | "open-trace"
  | "open-consistency"
  | "open-wizard"
  | "refresh"
  | "toggle-panel";

export interface DirectorAction {
  id: string;
  kind: DirectorActionKind;
  title: string;
  description: string;
  hotkeyActionId?: GatedHotkeyActionId;
  /** 只读 MCP/Core 操作提示，非写命令 */
  readonlyHint?: string;
  requiresSeasonEpisode?: boolean;
  requiresPackOrRun?: boolean;
}

export const DIRECTOR_ACTIONS: DirectorAction[] = [
  {
    id: "earliest",
    kind: "navigate-earliest",
    title: "定位 earliest",
    description: "跳到集内第一个未 formal/未审单元（与 STATUS 同源）",
    hotkeyActionId: "focus-earliest",
    readonlyHint: "get_studio_episode_earliest / dashboard units",
    requiresSeasonEpisode: true,
  },
  {
    id: "align",
    kind: "open-align-board",
    title: "图文对照",
    description: "一键查看 unit→图 SHA / 缺图 / trace 钥匙",
    hotkeyActionId: "open-script-align",
    readonlyHint: "get_studio_script_library_projection script-media-align",
    requiresSeasonEpisode: true,
  },
  {
    id: "reader",
    kind: "open-reader",
    title: "阅读剧本",
    description: "打开脚本正文 + 大纲导航",
    hotkeyActionId: "open-script-reader",
    readonlyHint: "get_studio_script_library_projection reader-view",
  },
  {
    id: "trace",
    kind: "open-trace",
    title: "生成追溯",
    description: "按 pack/run 打开双向 trace",
    hotkeyActionId: "open-trace",
    readonlyHint: "get_studio_trace",
    requiresPackOrRun: true,
  },
  {
    id: "consistency",
    kind: "open-consistency",
    title: "一致性四态",
    description: "机器辅助一致/需复核/漂移/无法检查（不自动 Review PASS）",
    hotkeyActionId: "open-consistency",
    readonlyHint: "get_studio_consistency_evaluation",
    requiresPackOrRun: true,
  },
  {
    id: "wizard",
    kind: "open-wizard",
    title: "15s 分镜建议",
    description: "打开 SSL-4 向导建议会话（物化需显式确认）",
    hotkeyActionId: "open-wizard-suggest",
    readonlyHint: "storyboard-wizard-suggest",
  },
  {
    id: "refresh",
    kind: "refresh",
    title: "刷新投影",
    description: "使 overview/units/assets 投影失效重载",
    hotkeyActionId: "refresh-projection",
  },
];

export function filterDirectorActions(query: string): DirectorAction[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...DIRECTOR_ACTIONS];
  return DIRECTOR_ACTIONS.filter(
    (a) =>
      a.title.toLowerCase().includes(q)
      || a.description.toLowerCase().includes(q)
      || a.id.includes(q)
      || (a.readonlyHint ?? "").toLowerCase().includes(q),
  );
}

export function directorActionByHotkey(actionId: GatedHotkeyActionId): DirectorAction | undefined {
  return DIRECTOR_ACTIONS.find((a) => a.hotkeyActionId === actionId);
}
