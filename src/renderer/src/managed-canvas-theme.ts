/**
 * 受管画布主题系统（P25）：浅色（默认）/深色/米色 三套皮肤。
 * 皮肤只通过配置切换——组件根节点 `[data-theme]` + scoped CSS 变量生效，
 * 不依赖全局 styles.css，组件保持自包含、可整体嵌入。
 */

export type ManagedCanvasThemeId = "light" | "dark" | "paper";

export interface ManagedCanvasThemeAssets {
  /** VueFlow Background 网格点颜色。 */
  patternColor: string;
  /** MiniMap 遮罩色。 */
  minimapMaskColor: string;
  /** MiniMap 节点色。 */
  minimapNodeColor: string;
}

export interface ManagedCanvasThemeDefinition {
  id: ManagedCanvasThemeId;
  label: string;
  assets: ManagedCanvasThemeAssets;
}

export const MANAGED_CANVAS_THEMES: readonly ManagedCanvasThemeDefinition[] = [
  {
    id: "light",
    label: "浅色",
    assets: {
      patternColor: "#d8d9d2",
      minimapMaskColor: "rgba(60, 64, 58, 0.14)",
      minimapNodeColor: "#9aa89c",
    },
  },
  {
    id: "dark",
    label: "深色",
    assets: {
      patternColor: "#2e322e",
      minimapMaskColor: "rgba(20, 24, 20, 0.55)",
      minimapNodeColor: "#6b8f71",
    },
  },
  {
    id: "paper",
    label: "米色",
    assets: {
      patternColor: "#ddd3ba",
      minimapMaskColor: "rgba(96, 82, 52, 0.16)",
      minimapNodeColor: "#b3a075",
    },
  },
] as const;

export const MANAGED_CANVAS_THEME_STORAGE_KEY = "managed-canvas-theme";

/** 主题变更自定义事件名（同窗口跨组件联动；同页 localStorage 写入不触发 storage 事件，故显式派发）。 */
export const MANAGED_CANVAS_THEME_CHANGED_EVENT = "managed-canvas-theme-changed";

/** 主题写入后派发变更事件（CanvasInspectorPanel 之外的宿主组件——如素材中心壳——据此联动）。 */
export function notifyManagedCanvasThemeChanged(themeId: ManagedCanvasThemeId): void {
  try {
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(MANAGED_CANVAS_THEME_CHANGED_EVENT, { detail: themeId }));
  } catch {
    // 事件派发失败不影响主题本身。
  }
}

export const DEFAULT_MANAGED_CANVAS_THEME: ManagedCanvasThemeId = "light";

/**
 * 把主题同步到 `<html data-theme>`，让 design-tokens.css 的全局 --ui-* 变量随主题生效（P29）。
 * 非 DOM 环境（vitest node）静默跳过；写入失败不阻断交互。
 */
export function syncDocumentCanvasTheme(
  themeId: ManagedCanvasThemeId,
  doc?: Pick<Document, "documentElement"> | null,
): void {
  try {
    const root = (doc ?? (typeof document !== "undefined" ? document : null))?.documentElement;
    if (root) root.dataset.theme = normalizeManagedCanvasTheme(themeId);
  } catch {
    // DOM 不可用时主题仅停留在组件层，不阻断。
  }
}

export function normalizeManagedCanvasTheme(value: unknown): ManagedCanvasThemeId {
  return MANAGED_CANVAS_THEMES.some((theme) => theme.id === value)
    ? (value as ManagedCanvasThemeId)
    : DEFAULT_MANAGED_CANVAS_THEME;
}

export function getManagedCanvasThemeAssets(themeId: ManagedCanvasThemeId): ManagedCanvasThemeAssets {
  const found = MANAGED_CANVAS_THEMES.find((theme) => theme.id === themeId);
  if (found) return found.assets;
  const fallback = MANAGED_CANVAS_THEMES.find((theme) => theme.id === DEFAULT_MANAGED_CANVAS_THEME);
  if (fallback) return fallback.assets;
  throw new Error("MANAGED_CANVAS_THEMES 缺少默认主题定义");
}

export function readManagedCanvasTheme(storage?: Pick<Storage, "getItem"> | null): ManagedCanvasThemeId {
  try {
    const store = storage ?? (typeof localStorage !== "undefined" ? localStorage : null);
    return normalizeManagedCanvasTheme(store?.getItem(MANAGED_CANVAS_THEME_STORAGE_KEY));
  } catch {
    return DEFAULT_MANAGED_CANVAS_THEME;
  }
}

export function writeManagedCanvasTheme(
  themeId: ManagedCanvasThemeId,
  storage?: Pick<Storage, "setItem"> | null,
): void {
  const normalized = normalizeManagedCanvasTheme(themeId);
  try {
    const store = storage ?? (typeof localStorage !== "undefined" ? localStorage : null);
    store?.setItem(MANAGED_CANVAS_THEME_STORAGE_KEY, normalized);
  } catch {
    // 存储不可用时主题仅保持在会话内，不阻断交互。
  }
  // P29：单点写入同步 <html data-theme>，全局 --ui-* 一并换肤（存储失败也同步会话内主题）。
  syncDocumentCanvasTheme(normalized);
}
