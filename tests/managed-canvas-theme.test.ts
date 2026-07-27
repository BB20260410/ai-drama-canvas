import { describe, expect, it } from "vitest";
import {
  DEFAULT_MANAGED_CANVAS_THEME,
  MANAGED_CANVAS_THEMES,
  MANAGED_CANVAS_THEME_STORAGE_KEY,
  getManagedCanvasThemeAssets,
  normalizeManagedCanvasTheme,
  readManagedCanvasTheme,
  syncDocumentCanvasTheme,
  writeManagedCanvasTheme,
} from "../src/renderer/src/managed-canvas-theme.js";

describe("managed-canvas-theme", () => {
  it("默认主题为浅色，且提供浅色/深色/米色三套皮肤", () => {
    expect(DEFAULT_MANAGED_CANVAS_THEME).toBe("light");
    expect(MANAGED_CANVAS_THEMES.map((theme) => theme.id)).toEqual(["light", "dark", "paper"]);
    expect(MANAGED_CANVAS_THEMES.map((theme) => theme.label)).toEqual(["浅色", "深色", "米色"]);
  });

  it("normalize 对非法值回退浅色", () => {
    expect(normalizeManagedCanvasTheme("dark")).toBe("dark");
    expect(normalizeManagedCanvasTheme("paper")).toBe("paper");
    expect(normalizeManagedCanvasTheme("neon")).toBe("light");
    expect(normalizeManagedCanvasTheme(undefined)).toBe("light");
    expect(normalizeManagedCanvasTheme(null)).toBe("light");
    expect(normalizeManagedCanvasTheme(42)).toBe("light");
  });

  it("每套皮肤都提供 VueFlow 背景点色与 MiniMap 色", () => {
    for (const theme of MANAGED_CANVAS_THEMES) {
      const assets = getManagedCanvasThemeAssets(theme.id);
      expect(assets.patternColor).toMatch(/^#/);
      expect(assets.minimapMaskColor).toMatch(/^(#|rgba?\()/);
      expect(assets.minimapNodeColor).toMatch(/^#/);
    }
  });

  it("未知主题 id 回退浅色 assets", () => {
    expect(getManagedCanvasThemeAssets("bogus" as never)).toEqual(
      getManagedCanvasThemeAssets(DEFAULT_MANAGED_CANVAS_THEME),
    );
  });

  it("无参读写（node 环境无 storage）回退浅色且不抛错", () => {
    expect(readManagedCanvasTheme()).toBe("light");
    expect(() => writeManagedCanvasTheme("dark")).not.toThrow();
  });

  it("读写 localStorage 往返；坏值回退浅色；写非法值被归一", () => {
    const map = new Map<string, string>();
    const storage = {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => void map.set(key, value),
    };
    expect(readManagedCanvasTheme(storage)).toBe("light");
    writeManagedCanvasTheme("paper", storage);
    expect(map.get(MANAGED_CANVAS_THEME_STORAGE_KEY)).toBe("paper");
    expect(readManagedCanvasTheme(storage)).toBe("paper");
    map.set(MANAGED_CANVAS_THEME_STORAGE_KEY, "bogus");
    expect(readManagedCanvasTheme(storage)).toBe("light");
    writeManagedCanvasTheme("neon" as never, storage);
    expect(map.get(MANAGED_CANVAS_THEME_STORAGE_KEY)).toBe("light");
  });

  it("存储异常时静默回退，不抛错", () => {
    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(readManagedCanvasTheme(broken)).toBe("light");
    expect(() => writeManagedCanvasTheme("dark", broken)).not.toThrow();
  });

  it("syncDocumentCanvasTheme 写入 <html data-theme> 并对非法值归一（P29）", () => {
    const element = { dataset: {} as Record<string, string> };
    const doc = { documentElement: element } as never;
    syncDocumentCanvasTheme("paper", doc);
    expect(element.dataset.theme).toBe("paper");
    syncDocumentCanvasTheme("dark", doc);
    expect(element.dataset.theme).toBe("dark");
    syncDocumentCanvasTheme("neon" as never, doc);
    expect(element.dataset.theme).toBe("light");
  });

  it("syncDocumentCanvasTheme 非 DOM 环境静默跳过（P29）", () => {
    expect(() => syncDocumentCanvasTheme("dark", null)).not.toThrow();
    expect(() => syncDocumentCanvasTheme("paper")).not.toThrow();
  });
});
