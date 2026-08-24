import { readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

async function source(relativePath: string): Promise<string> {
  return readFile(path.join(process.cwd(), relativePath), "utf8");
}

describe("Material Studio UI contract", () => {
  it("把跨视图公共类型放在无运行时 UI 依赖的合同中", async () => {
    const contractPath = "src/renderer/src/material-studio-ui-contract.ts";
    const contract = await source(contractPath);
    const parsed = ts.createSourceFile(contractPath, contract, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const imports = parsed.statements.filter(ts.isImportDeclaration).map((statement) => ({
      specifier: ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : "",
      typeOnly: statement.importClause?.isTypeOnly ?? false,
    }));

    expect(contract).toContain("export interface MaterialStudioUiApi");
    expect(contract).toContain("export interface MaterialStudioProjectOverview");
    expect(contract).toContain("export interface StudioScriptProductUiApi");
    expect(imports.every((entry) => entry.typeOnly)).toBe(true);
    expect(imports.map((entry) => entry.specifier)).not.toContain("vue");
    expect(imports.map((entry) => entry.specifier).some((specifier) => specifier.endsWith(".vue"))).toBe(false);
    expect(contract).not.toContain("preload");
  });

  it("SFC 兼容再导出，消费者不再把 SFC 当类型合同", async () => {
    const material = await source("src/renderer/src/components/MaterialStudioView.vue");
    expect(material).toContain('} from "../material-studio-ui-contract";');
    expect(material).toContain("export type {");
    expect(material).not.toContain("export interface MaterialStudioUiApi");
    expect(material).not.toContain("export interface StudioScriptProductUiApi");

    for (const relativePath of [
      "src/renderer/src/App.vue",
      "src/renderer/src/components/ManagedStudioCanvasView.vue",
      "src/renderer/src/components/ScriptMediaAlignView.vue",
    ]) {
      const content = await source(relativePath);
      expect(content).toContain("material-studio-ui-contract");
      expect(content).not.toContain("MaterialStudioView.vue\";");
    }
  });

  it("material-entry 使用 content-visibility，离屏卡片跳过同步布局", async () => {
    const view = await source("src/renderer/src/components/MaterialStudioView.vue");
    expect(view).toContain('class="material-entry"');
    expect(view).toContain(".material-entry{position:relative;min-width:0;padding:0;border:0;border-right:1px solid var(--line);border-bottom:1px solid var(--line);background:var(--ui-surface);color:inherit;text-align:left;cursor:pointer;content-visibility:auto;contain-intrinsic-size:auto 260px}");
    expect(view).toContain(".entry-collection.list .material-entry{width:100%;min-height:82px;display:grid;grid-template-columns:104px minmax(0,1fr) 24px;align-items:stretch;border-right:0;contain-intrinsic-size:auto 82px}");
    expect(view).toContain(".entries-region{min-height:0;overflow:auto;");
    expect(view).toContain('loading="lazy"');
    expect(view).not.toMatch(/\.material-entry\{[^}]*content-visibility:hidden/);
  });

  it("继续/打开创建表单在 pendingAction 时 fail-closed：不能边写入边切流程或打开资产表单", async () => {
    const view = await source("src/renderer/src/components/MaterialStudioView.vue");
    const continueBtn = view.slice(
      view.lastIndexOf("<button", view.indexOf('data-testid="studio-continue-action"')),
      view.indexOf(">", view.indexOf('data-testid="studio-continue-action"')) + 1,
    );
    expect(continueBtn).toContain(':disabled="loading || Boolean(pendingAction)');
    expect(continueBtn).toContain("正在处理，不能再继续");

    const continueFn = view.slice(
      view.indexOf("async function continueFromCore()"),
      view.indexOf("function selectStudioMode("),
    );
    expect(continueFn).toContain("if (pendingAction.value) return;");
    expect(continueFn.indexOf("if (pendingAction.value) return;")).toBeLessThan(
      continueFn.indexOf("openCreateDialog"),
    );

    const openCreate = view.slice(
      view.indexOf("function openCreateDialog("),
      view.indexOf("function closeCreateDialog("),
    );
    expect(openCreate).toContain("if (pendingAction.value) return;");
    expect(openCreate.indexOf("if (pendingAction.value) return;")).toBeLessThan(
      openCreate.indexOf("createDialogOpen.value = true"),
    );

    expect(view).toContain(':disabled="!createDraft.name || Boolean(pendingAction)"');
    expect(view).toContain("正在处理，不能再创建资产");
  });

  it("素材库原生音频 play 加入画布互斥，离开时 pause+release", async () => {
    const view = await source("src/renderer/src/components/MaterialStudioView.vue");
    expect(view).toContain('class="media-player audio-player"');
    expect(view).toContain('@play="onStudioAudioPlay"');
    expect(view).toContain("claimCanvasAudioPlayback(studioAudioEl.value)");
    expect(view).toContain("releaseCanvasAudioPlayback(studioAudioEl.value)");
    expect(view).toContain("studioAudioEl.value?.pause()");
    expect(view).not.toContain("wavesurfer");
  });

  it("pendingAction 时点原生 play 立即 pause，不认领互斥", async () => {
    const view = await source("src/renderer/src/components/MaterialStudioView.vue");
    const play = view.slice(
      view.indexOf("function onStudioAudioPlay()"),
      view.indexOf("const onCanvasThemeChanged"),
    );
    expect(play).toContain("if (pendingAction.value) {");
    expect(play).toContain("studioAudioEl.value?.pause();");
    expect(play.indexOf("if (pendingAction.value)")).toBeLessThan(play.indexOf("claimCanvasAudioPlayback(studioAudioEl.value)"));
  });

  it("pendingAction 时禁用原生音频 pointer-events", async () => {
    const view = await source("src/renderer/src/components/MaterialStudioView.vue");
    expect(view).toContain(':class="{ \'audio-blocked\': Boolean(pendingAction) }"');
    expect(view).toContain(".audio-player.audio-blocked{pointer-events:none}");
  });
});
