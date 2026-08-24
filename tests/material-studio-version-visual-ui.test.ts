import { readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "@vue/compiler-sfc";
import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("素材版本具体视觉裁决 UI", () => {
  it("pending 版本使用轻量缩略图，并只在用户点击后按需打开受管原图", () => {
    const view = readFileSync(
      path.join(root, "src/renderer/src/components/MaterialStudioView.vue"),
      "utf8",
    );
    const app = readFileSync(path.join(root, "src/renderer/src/App.vue"), "utf8");
    expect(parse(view, { filename: "MaterialStudioView.vue" }).errors).toEqual([]);
    expect(view).toContain('class="version-visual"');
    expect(view).toContain("@click=\"openVersionPreview(version)\"");
    expect(view).toContain('v-if="versionPreview"');
    expect(view).toContain('class="version-preview-dialog"');
    expect(view).toContain(":src=\"versionPreview.mediaUrl\"");
    expect(view).toContain("批准、拒绝和提升权威仍在版本卡片中分别执行");
    expect(app).toContain("version.thumbnailRecipeKey");
    expect(app).toContain("aicanvas-studio://media/${version.mediaSha256}");
  });

  it("详情栏诊断 summary 含 testid，不铺版本行/关系行", () => {
    const view = readFileSync(
      path.join(root, "src/renderer/src/components/MaterialStudioView.vue"),
      "utf8",
    );
    expect(view.match(/data-testid="material-studio-diagnostics"/g)?.length).toBe(3);
    expect(view).toContain('class="detail-section resource-image-detail"');
    expect(view).toContain('class="detail-section text-document-section"');
    expect(view).toContain('class="detail-section prompt-section"');
    expect(view).toContain('<summary data-testid="material-studio-diagnostics">诊断详情</summary>');
    expect(view).toContain('data-testid="studio-text-revision-history"');
    expect(view).toContain('<details class="technical-diagnostics"><summary data-testid="material-studio-relation-diagnostics">诊断详情</summary><code>{{ relation.id }}');
    expect(view).toContain('<details class="technical-diagnostics"><summary data-testid="material-studio-version-diagnostics">诊断详情</summary><code>{{ version.id }}');
    expect(view).toContain('<details v-if="detail.primaryAuthority" class="technical-diagnostics"><summary data-testid="material-studio-authority-diagnostics">诊断详情</summary>');
    expect(view).not.toMatch(/class="technical-diagnostics"[^>]*role="dialog"/);
    expect(view).not.toContain("managed-canvas-diagnostics");
    expect(view).not.toContain("managed-canvas-inspector-diagnostics");
  });

  it("关联行诊断 summary 含共享 testid，不铺详情栏/版本行/关系编辑器", () => {
    const view = readFileSync(
      path.join(root, "src/renderer/src/components/MaterialStudioView.vue"),
      "utf8",
    );
    expect(view).toContain('class="relation-list"');
    expect(view).toContain('data-testid="material-studio-relation-diagnostics"');
    expect(view).toContain('<summary data-testid="material-studio-relation-diagnostics">诊断详情</summary>');
    expect(view).toContain("{{ relation.id }} · {{ relationOtherAsset(relation, detail.id) }} · r{{ relation.revision }}");
    expect(view).toContain('data-testid="relation-asset-select"');
    expect(view).toContain('class="asset-relation-editor"');
    expect(view).not.toContain("material-studio-relation-diagnostics-");
    expect(view.match(/data-testid="material-studio-diagnostics"/g)?.length).toBe(3);
    expect(view).toContain('<details class="technical-diagnostics"><summary data-testid="material-studio-version-diagnostics">诊断详情</summary><code>{{ version.id }}');
    expect(view).toContain('<details v-if="detail.primaryAuthority" class="technical-diagnostics"><summary data-testid="material-studio-authority-diagnostics">诊断详情</summary>');
  });

  it("版本行诊断 summary 含共享 testid，不改 version-visual / 权威图诊断", () => {
    const view = readFileSync(
      path.join(root, "src/renderer/src/components/MaterialStudioView.vue"),
      "utf8",
    );
    expect(view).toContain('class="version-meta"');
    expect(view).toContain('class="detail-section versions-section"');
    expect(view).toContain('data-testid="material-studio-version-diagnostics"');
    expect(view).toContain('<summary data-testid="material-studio-version-diagnostics">诊断详情</summary>');
    expect(view).toContain("{{ version.id }} · {{ shortSha(version.mediaSha256) }}");
    expect(view).toContain('class="version-visual"');
    expect(view).not.toContain("material-studio-version-diagnostics-");
    expect(view).toContain('<details v-if="detail.primaryAuthority" class="technical-diagnostics"><summary data-testid="material-studio-authority-diagnostics">诊断详情</summary>');
    expect(view).toContain('data-testid="material-studio-relation-diagnostics"');
    expect(view.match(/data-testid="material-studio-diagnostics"/g)?.length).toBe(3);
  });

  it("权威图诊断 summary 含 testid，不改 version-visual / 详情栏", () => {
    const view = readFileSync(
      path.join(root, "src/renderer/src/components/MaterialStudioView.vue"),
      "utf8",
    );
    expect(view).toContain('class="authority-visual"');
    expect(view).toContain('data-testid="material-studio-authority-diagnostics"');
    expect(view).toContain('<summary data-testid="material-studio-authority-diagnostics">诊断详情</summary>');
    expect(view).toContain("{{ detail.primaryAuthority.versionId }}");
    expect(view).toContain('class="version-visual"');
    expect(view).not.toContain("material-studio-authority-diagnostics-");
    expect(view.match(/data-testid="material-studio-diagnostics"/g)?.length).toBe(3);
    expect(view).toContain('data-testid="material-studio-version-diagnostics"');
  });

  it("关联编辑器 summary 含 testid，不抢关联行诊断", () => {
    const view = readFileSync(
      path.join(root, "src/renderer/src/components/MaterialStudioView.vue"),
      "utf8",
    );
    expect(view).toContain('class="asset-relation-editor"');
    expect(view).toContain('data-testid="material-studio-relation-editor"');
    expect(view).toContain('<summary data-testid="material-studio-relation-editor">关联另一个资产</summary>');
    expect(view).toContain('data-testid="relation-asset-select"');
    expect(view).not.toContain("material-studio-relation-editor-");
    expect(view).toContain('data-testid="material-studio-relation-diagnostics"');
    expect(view.match(/data-testid="material-studio-diagnostics"/g)?.length).toBe(3);
  });
});
