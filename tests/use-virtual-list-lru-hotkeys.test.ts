import { describe, expect, it } from "vitest";
import { computeVirtualListWindow, sliceVirtualWindow } from "../src/renderer/src/use-virtual-list.js";
import { createThumbnailLru } from "../src/renderer/src/use-thumbnail-lru.js";
import {
  createGatedHotkeyRegistry,
  DEFAULT_DIRECTOR_HOTKEYS,
  eventToHotkeyChord,
  normalizeHotkeyChord,
} from "../src/renderer/src/use-gated-hotkeys.js";
import { DIRECTOR_ACTIONS, filterDirectorActions, directorActionByHotkey } from "../src/renderer/src/director-action-panel.js";

describe("D3 virtual list", () => {
  it("computes window with overscan", () => {
    const w = computeVirtualListWindow({
      itemCount: 100,
      itemHeight: 40,
      viewportHeight: 200,
      scrollTop: 400,
      overscan: 2,
    });
    expect(w.startIndex).toBe(8);
    expect(w.endIndex).toBeGreaterThan(w.startIndex);
    expect(w.offsetTop).toBe(8 * 40);
    expect(w.totalHeight).toBe(4000);
    expect(sliceVirtualWindow(Array.from({ length: 100 }, (_, i) => i), w)).toHaveLength(w.visibleCount);
  });
});

describe("D3 thumbnail LRU", () => {
  it("evicts oldest on overflow and refreshes on get", () => {
    const lru = createThumbnailLru(2);
    lru.set("a", "ua");
    lru.set("b", "ub");
    expect(lru.get("a")).toBe("ua");
    lru.set("c", "uc");
    expect(lru.has("b")).toBe(false);
    expect(lru.has("a")).toBe(true);
    expect(lru.has("c")).toBe(true);
    expect(lru.size()).toBe(2);
  });
});

describe("D4 gated hotkeys", () => {
  it("matches default chords and rejects unknown actions", () => {
    const reg = createGatedHotkeyRegistry(DEFAULT_DIRECTOR_HOTKEYS);
    expect(reg.match({ key: "e", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false })).toBe(
      "focus-earliest",
    );
    expect(normalizeHotkeyChord("Ctrl+E")).toBe("mod+e");
    expect(eventToHotkeyChord({ key: "A", metaKey: false, ctrlKey: true, altKey: false, shiftKey: true })).toBe(
      "mod+shift+a",
    );
    expect(() => reg.register({ actionId: "focus-earliest", chord: "mod+1", label: "x" })).not.toThrow();
    expect(() =>
      reg.register({ actionId: "rm-rf" as "focus-earliest", chord: "mod+x", label: "bad" }),
    ).toThrow(/未授权/);
  });
});

describe("D5 director panel model", () => {
  it("filters and maps hotkeys; no write commands in hints", () => {
    expect(DIRECTOR_ACTIONS.length).toBeGreaterThanOrEqual(6);
    expect(filterDirectorActions("对照")[0]?.id).toBe("align");
    expect(directorActionByHotkey("focus-earliest")?.kind).toBe("navigate-earliest");
    for (const a of DIRECTOR_ACTIONS) {
      expect(JSON.stringify(a).toLowerCase()).not.toMatch(/execute_command/);
    }
  });
});
