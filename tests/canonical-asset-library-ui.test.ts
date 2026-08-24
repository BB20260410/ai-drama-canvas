import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

async function source(): Promise<string> {
  return readFile(path.join(process.cwd(), "src/renderer/src/components/CanonicalAssetLibraryView.vue"), "utf8");
}

describe("规范资产库卡片视口剔除", () => {
  it("canonical-card 使用 content-visibility，离屏卡片跳过同步布局", async () => {
    const view = await source();
    expect(view).toContain('class="canonical-card"');
    expect(view).toContain("const limit = 24;");
    expect(view).toContain(".canonical-library{height:100%;min-width:0;overflow:auto;");
    expect(view).toContain('loading="lazy"');
    expect(view).toContain(".canonical-card{width:calc(25% - 1px);min-width:170px;vertical-align:top;padding:0;border:0;border-right:1px solid #2b2d27;border-bottom:1px solid #2b2d27;background:#171815;color:inherit;text-align:left;content-visibility:auto;contain-intrinsic-size:auto 262px}");
    expect(view).not.toMatch(/\.canonical-card\{[^}]*content-visibility:hidden/);
  });

  it("asset-detail 权威/版本行使用 content-visibility，离屏条目跳过同步布局", async () => {
    const view = await source();
    expect(view).toContain('v-for="entry in detail.authorities"');
    expect(view).toContain('v-for="version in detail.versions"');
    expect(view).toContain(".asset-detail{min-width:0;overflow:auto;background:#141512}");
    expect(view).toContain(".authority-entry,.version-entry{padding:9px 0;border-top:1px solid #292b25;content-visibility:auto;contain-intrinsic-size:auto 40px}");
    expect(view).not.toMatch(/\.authority-entry,\.version-entry\{[^}]*content-visibility:hidden/);
    expect(view).not.toMatch(/\.version-entry button\{[^}]*content-visibility/);
  });
});
