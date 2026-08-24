import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function source(): string {
  return readFileSync(path.join(root, "src/renderer/src/components/PanelReferenceWorkbench.vue"), "utf8");
}

describe("宫格参考工作台列表视口剔除", () => {
  it("resolution-row 与 derived-card 使用 content-visibility，离屏条目跳过同步布局", () => {
    const vue = source();
    expect(vue).toContain('v-for="resolution in page?.items ?? []"');
    expect(vue).toContain(
      ".resolution-row { width: 100%; min-height: 61px; padding: 8px 14px; border: 0; border-bottom: 1px solid #272a26; background: transparent; color: #d8dbd4; text-align: left; cursor: pointer; transition: background .14s ease, box-shadow .14s ease; content-visibility: auto; contain-intrinsic-size: auto 61px; }",
    );
    expect(vue).toContain(
      ".derived-card { width: 100%; display: block; padding: 10px 0; overflow: hidden; border: 0; border-bottom: 1px solid #252824; background: transparent; color: inherit; text-align: left; cursor: pointer; content-visibility: auto; contain-intrinsic-size: auto 56px; }",
    );
    expect(vue).not.toMatch(/\.resolution-row \{[^}]*content-visibility:\s*hidden/);
    expect(vue).not.toMatch(/\.derived-card \{[^}]*content-visibility:\s*hidden/);
  });
});
