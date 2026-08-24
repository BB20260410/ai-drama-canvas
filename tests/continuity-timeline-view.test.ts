import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function source(): string {
  return readFileSync(path.join(root, "src/renderer/src/components/ContinuityTimelineView.vue"), "utf8");
}

describe("连续性时间线列表视口剔除", () => {
  it("track-list 行使用 content-visibility，离屏轨道跳过同步布局", () => {
    const vue = source();
    expect(vue).toContain('v-for="track in trackPage.items"');
    expect(vue).toContain(".track-list { min-height: 0; flex: 1; overflow: auto; }");
    expect(vue).toContain(
      ".track-list > button { width: 100%; min-height: 72px; display: grid; grid-template-columns: 42px minmax(0,1fr) auto; align-items: center; gap: 10px; padding: 9px 12px; border: 0; border-bottom: 1px solid #292b25; border-left: 2px solid transparent; background: transparent; text-align: left; cursor: pointer; content-visibility: auto; contain-intrinsic-size: auto 72px; }",
    );
    expect(vue).not.toMatch(/\.track-list > button \{[^}]*content-visibility:\s*hidden/);
  });

  it("span-row 使用 content-visibility，离屏跨度行跳过同步布局", () => {
    const vue = source();
    expect(vue).toContain('v-for="entry in spanPage?.items ?? []"');
    expect(vue).toContain(".track-detail { min-width: 0; min-height: 0; position: relative; overflow: auto; padding: 0 26px 70px; background: #11120f; }");
    expect(vue).toContain(
      ".span-row { width: 100%; min-height: 72px; padding: 8px 0; border: 0; border-bottom: 1px solid #292b25; background: transparent; color: #d8d7d0; text-align: left; cursor: pointer; content-visibility: auto; contain-intrinsic-size: auto 72px; }",
    );
    expect(vue).not.toMatch(/\.span-row \{[^}]*content-visibility:\s*hidden/);
    expect(vue).not.toMatch(/\.span-table > header \{[^}]*content-visibility/);
  });
});
