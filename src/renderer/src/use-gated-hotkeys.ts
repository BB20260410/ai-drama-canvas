/**
 * Qwen D4 · 受闸快捷键注册表
 *
 * 仅允许白名单导演动作；禁止绑定任意 execute_command / 写路径。
 * match 返回 actionId 或 null；由 UI 再分发到只读导航。
 */

export type GatedHotkeyActionId =
  | "focus-earliest"
  | "open-script-align"
  | "open-script-reader"
  | "open-trace"
  | "open-consistency"
  | "open-wizard-suggest"
  | "refresh-projection"
  | "toggle-director-panel";

export interface GatedHotkeyBinding {
  actionId: GatedHotkeyActionId;
  /** 如 "mod+e" / "mod+shift+a" / "slash" */
  chord: string;
  label: string;
  enabled?: boolean;
}

export interface GatedHotkeyRegistry {
  list(): GatedHotkeyBinding[];
  register(binding: GatedHotkeyBinding): void;
  unregister(actionId: GatedHotkeyActionId): void;
  setEnabled(actionId: GatedHotkeyActionId, enabled: boolean): void;
  match(event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">): GatedHotkeyActionId | null;
}

const ALLOWED = new Set<GatedHotkeyActionId>([
  "focus-earliest",
  "open-script-align",
  "open-script-reader",
  "open-trace",
  "open-consistency",
  "open-wizard-suggest",
  "refresh-projection",
  "toggle-director-panel",
]);

export function normalizeHotkeyChord(chord: string): string {
  return chord
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace("cmd+", "mod+")
    .replace("command+", "mod+")
    .replace("control+", "mod+")
    .replace("ctrl+", "mod+");
}

export function eventToHotkeyChord(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
): string {
  const parts: string[] = [];
  if (event.metaKey || event.ctrlKey) parts.push("mod");
  if (event.altKey) parts.push("alt");
  if (event.shiftKey) parts.push("shift");
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key.toLowerCase();
  if (key === "control" || key === "meta" || key === "shift" || key === "alt") return parts.join("+");
  parts.push(key === " " ? "space" : key);
  return parts.join("+");
}

export function createGatedHotkeyRegistry(seed: GatedHotkeyBinding[] = []): GatedHotkeyRegistry {
  const map = new Map<GatedHotkeyActionId, GatedHotkeyBinding>();
  for (const b of seed) {
    if (!ALLOWED.has(b.actionId)) continue;
    map.set(b.actionId, { ...b, chord: normalizeHotkeyChord(b.chord), enabled: b.enabled !== false });
  }

  return {
    list() {
      return [...map.values()];
    },
    register(binding) {
      if (!ALLOWED.has(binding.actionId)) {
        throw new Error(`拒绝注册未授权快捷键动作：${binding.actionId}`);
      }
      map.set(binding.actionId, {
        ...binding,
        chord: normalizeHotkeyChord(binding.chord),
        enabled: binding.enabled !== false,
      });
    },
    unregister(actionId) {
      map.delete(actionId);
    },
    setEnabled(actionId, enabled) {
      const cur = map.get(actionId);
      if (cur) map.set(actionId, { ...cur, enabled });
    },
    match(event) {
      const chord = normalizeHotkeyChord(eventToHotkeyChord(event));
      for (const b of map.values()) {
        if (b.enabled === false) continue;
        if (normalizeHotkeyChord(b.chord) === chord) return b.actionId;
      }
      return null;
    },
  };
}

/** 默认导演快捷键（可被 UI 覆盖注册）。 */
export const DEFAULT_DIRECTOR_HOTKEYS: GatedHotkeyBinding[] = [
  { actionId: "focus-earliest", chord: "mod+e", label: "定位 earliest 单元" },
  { actionId: "open-script-align", chord: "mod+shift+a", label: "打开图文对照" },
  { actionId: "open-script-reader", chord: "mod+shift+r", label: "打开剧本阅读" },
  { actionId: "open-trace", chord: "mod+shift+t", label: "打开 trace" },
  { actionId: "open-consistency", chord: "mod+shift+c", label: "一致性四态" },
  { actionId: "open-wizard-suggest", chord: "mod+shift+w", label: "15s 分镜建议" },
  { actionId: "refresh-projection", chord: "mod+shift+.", label: "刷新投影" },
  { actionId: "toggle-director-panel", chord: "mod+/", label: "导演动作面板" },
];
