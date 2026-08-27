import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "@vue/compiler-sfc";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function source(): string {
  return readFileSync(path.join(root, "src/renderer/src/components/ScriptMediaAlignView.vue"), "utf8");
}

function buttonAttrs(text: string, testId: string): string {
  const marker = `data-testid="${testId}"`;
  const idx = text.indexOf(marker);
  expect(idx).toBeGreaterThan(-1);
  const start = text.lastIndexOf("<button", idx);
  const end = text.indexOf(">", idx);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return text.slice(start, end + 1);
}

function handlerBody(text: string, signature: string, nextSignature: string): string {
  const start = text.indexOf(signature);
  const end = text.indexOf(nextSignature, start + signature.length);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return text.slice(start, end);
}

describe("剧本库与 15 秒分镜源码合同", () => {
  it("SFC 可解析并暴露导入剧本与物化分镜", () => {
    const vue = source();
    expect(parse(vue, { filename: "ScriptMediaAlignView.vue" }).errors).toEqual([]);
    expect(vue).toContain('data-testid="script-library-import"');
    expect(vue).toContain("有图 {{ item.coveredMediaCount }}");
    expect(vue).toContain('data-testid="script-library-covered-media"');
    expect(vue).toContain('data-testid="script-reader-to-wizard"');
    expect(vue).toContain('data-testid="script-reader-span-media"');
    expect(vue).toContain('data-testid="script-reader-span-media-board"');
    expect(vue).toContain('data-testid="script-reader-revision-impact"');
    expect(vue).toContain('data-testid="script-reader-revision-impact-board"');
    expect(vue).toContain("span-media-hit-standing");
    expect(vue).toContain("span-media-hit-handoff");
    expect(vue).toContain("span-media-hit-gaps");
    expect(vue).toContain("span-media-hit-lighting");
    expect(vue).toContain("span-media-hit-scene-backref-");
    expect(vue).toContain("span-media-hit-align");
    expect(vue).toContain("span-media-hit-trace");
    expect(vue).toContain("openHitGenerationTrace");
    expect(vue).toContain("formatPanelStandingHandoff(hit.previousHandoff)");
    expect(vue).toContain("formatPanelStandingGaps");
    expect(vue).toContain("align-panel-standing-gaps");
    expect(vue).toContain("ssl5-focus-standing-gaps");
    expect(vue).toContain("ssl5-focus-lighting");
    expect(vue).toContain("ssl5-focus-previous-lighting");
    expect(vue).toContain("ssl5-focus-previous-costume");
    expect(vue).toContain("ssl5-focus-scene-backrefs");
    expect(vue).toContain("ssl5-focus-scene-backref-");
    expect(vue).toContain("ssl5-focus-prop-backrefs");
    expect(vue).toContain("ssl5-focus-character-backrefs");
    expect(vue).toContain("ssl5-focus-shot-type");
    expect(vue).toContain("ssl5-focus-beat");
    expect(vue).toContain("ssl5-focus-unit-beat");
    expect(vue).toContain("span-media-hit-shot-type");
    expect(vue).toContain("span-media-hit-style-lock");
    expect(vue).toContain("span-media-hit-beat");
    expect(vue).toContain("span-media-hit-scene-backrefs");
    expect(vue).toContain("span-media-hit-prop-backrefs");
    expect(vue).toContain("span-media-hit-character-backrefs");
    expect(vue).toContain("span-media-hit-peek");
    expect(vue).toContain("ssl5-focus-peek");
    expect(vue).toContain("ssl5-checkpoint-next");
    expect(vue).toContain("align-checkpoint-gate");
    expect(vue).toContain("align-write-lease");
    expect(vue).toContain("ssl5-write-lease");
    expect(vue).toContain("align-missing-report");
    expect(vue).toContain("align-missing-report-copy");
    expect(vue).toContain("copyMissingReport");
    expect(vue).toContain("missingReportOpenItems");
    expect(vue).toContain("align-review-");
    expect(vue).toContain("script-reader-earliest-reason");
    expect(vue).toContain("script-reader-checkpoint");
    expect(vue).toContain("script-reader-write-lease");
    expect(vue).toContain("peekLabel(hit.consistencyPeek)");
    expect(vue).toContain("peekLabel(ssl5Plan.consistencyPeek)");
    expect(vue).not.toContain("studio-consistency-evaluator");
    expect(vue).toContain("revealReaderSceneBackRef");
    expect(vue).toContain("formatPanelLightingCostumeLine");
    expect(vue).toContain("formatPanelShotTypeLine");
    expect(vue).toContain("formatStyleLockLine");
    expect(vue).toContain("formatWizardStyleLockLine");
    expect(vue).toContain("align-panel-style-lock");
    expect(vue).toContain("storyboard-wizard-style-lock");
    expect(vue).toContain("wizardStyleLockLine");
    expect(vue).not.toContain("listStyleBackReferences");
    expect(vue).toContain("formatPanelBeatLine");
    expect(vue).toContain("revealAlignLocator");
    expect(vue).toContain("revealSpanMediaHit");
    expect(vue).toContain("revealImpactRowAlign");
    expect(vue).toContain("refineSsl5FocusIfUnexpectedRevisionImpact");
    expect(vue).toContain("ssl5DisplayedPlan");
    expect(vue).toContain("revision-impact-row-align");
    expect(vue).toContain("露出这单元");
    expect(vue).toContain("不猜第一格");
    expect(vue).toContain("getStudioScriptSpanMediaMap");
    expect(vue).toContain('data-testid="storyboard-wizard-suggest"');
    expect(vue).toContain('data-testid="storyboard-wizard-materialize"');
    expect(vue).toContain('data-testid="storyboard-wizard-next"');
    expect(vue).toContain("Binding → freeze → create-plan → dispatch");
    expect(vue).toContain("wizardPostMaterializeNextLine");
    expect(vue).toContain("wizardAlignCheckpointLine");
    expect(vue).toContain("wizardAlignWriteLeaseLine");
    expect(vue).toContain("storyboard-wizard-checkpoint");
    expect(vue).toContain("storyboard-wizard-write-lease");
    expect(vue).toContain("对照板未加载，不自动查六图闸");
    expect(vue).toContain("对照板未加载，不自动查写租约");
    expect(vue).toContain("board.value?.checkpointLine");
    expect(vue).toContain("board.value?.writeLeaseLine");
    expect(vue).toContain("仍需后续 Binding / freeze / create-plan");
    expect(vue).toContain("进入 Binding");
    expect(vue).not.toContain("仍需后续 Binding / freeze。</p>");
    expect(vue).toContain('data-testid="storyboard-wizard-previous-standing"');
    expect(vue).toContain('data-testid="storyboard-wizard-lighting"');
    expect(vue).toContain('data-testid="storyboard-wizard-costume"');
    expect(vue).toContain('data-testid="storyboard-wizard-previous-lighting"');
    expect(vue).toContain('data-testid="storyboard-wizard-previous-costume"');
    expect(vue).toContain("wizardStandingLine");
    expect(vue).toContain("wizardLightingLine");
    expect(vue).toContain("wizardCostumeLine");
    expect(vue).toContain("wizardSceneBackRefLine");
    expect(vue).toContain("formatWizardSceneBackReferenceLine");
    expect(vue).toContain('data-testid="storyboard-wizard-scene-backrefs"');
    expect(vue).toContain("revealWizardSceneBackRef");
    expect(vue).toContain('activeTab.value = "align"');
    expect(vue).not.toContain("studio-scene-backrefs-read");
    expect(vue).toContain("wizardPreviousStandingForPanel");
    expect(vue).toContain("formatUnitLockPreviousStandingLine");
    expect(vue).toContain("formatWizardLockPreviousLightingLine");
    expect(vue).toContain("formatWizardLockPreviousCostumeLine");
    expect(vue).toContain('data-testid="ssl5-missing-to-gen-plan"');
    expect(vue).toContain("planSsl5MissingToGen");
    expect(vue).toContain("不自动 dispatch");
    expect(vue).toContain('data-testid="ssl5-earliest-next"');
    expect(vue).toContain("ssl5EarliestNextLine");
    expect(vue).toContain("align-peek-");
    expect(vue).toContain("未评估");
    expect(vue).toContain("<th>四态</th>");
    expect(vue).toContain("<th>宫格</th>");
    expect(vue).toContain("align-panels-");
    expect(vue).toContain("align-table-panel-");
    expect(vue).toContain("selectAlignTablePanel");
    expect(vue).toContain("align-panel-list");
    expect(vue).toContain("align-panel-peek");
    expect(vue).toContain("align-panel-pack");
    expect(vue).toContain("align-panel-run");
    expect(vue).toContain('data-testid="align-open-trace"');
    expect(vue).toContain("openAlignGenerationTrace");
    expect(vue).toContain("resolveAlignTraceSelector");
    expect(vue).toContain("getStudioTrace");
    expect(vue).toContain("getStudioScriptRevisionImpact");
    expect(vue).toContain("lookupRevisionImpact");
    expect(vue).toContain("scriptRevisionId: reader.value.revisionId");
    expect(vue).toContain("须人工复核（不自动 Review PASS）");
    expect(vue).not.toContain("from \"@core/studio-trace");
    expect(vue).not.toContain("from \"@core/studio-generation-session-snapshot");
    expect(vue).toContain("禁止猜第一格");
    expect(vue).not.toContain("evaluateStudioConsistency");
    expect(vue).not.toContain("getStudioBindingControl");
    expect(vue).toContain("align-panel-composition");
    expect(vue).toContain("align-panel-action");
    expect(vue).toContain("align-panel-lighting");
    expect(vue).toContain("align-panel-costume");
    expect(vue).toContain("align-panel-handoff");
    expect(vue).toContain("align-panel-assets");
    expect(vue).toContain("align-panel-scene-backrefs");
    expect(vue).toContain("align-panel-prop-backrefs");
    expect(vue).toContain("align-panel-character-backrefs");
    expect(vue).toContain("align-panel-shot-type");
    expect(vue).toContain("align-panel-style-lock");
    expect(vue).toContain("align-panel-beat");
    expect(vue).toContain("listSceneBackReferences");
    expect(vue).toContain("listPropBackReferences");
    expect(vue).toContain("listCharacterBackReferences");
    expect(vue).toContain("formatSceneBackReferences");
    expect(vue).toContain("formatPropBackReferences");
    expect(vue).toContain("formatCharacterBackReferences");
    expect(vue).toContain("formatWizardPropBackReferenceLine");
    expect(vue).toContain("formatWizardCharacterBackReferenceLine");
    expect(vue).toContain('data-testid="storyboard-wizard-prop-backrefs"');
    expect(vue).toContain('data-testid="storyboard-wizard-character-backrefs"');
    expect(vue).toContain('data-testid="storyboard-wizard-shot-type"');
    expect(vue).toContain('data-testid="storyboard-wizard-style-lock"');
    expect(vue).toContain('data-testid="storyboard-wizard-beat"');
    expect(vue).toContain("revealSceneBackRef");
    expect(vue).toContain("不能猜宫格");
    expect(vue).toContain("不是 BindingSet");
    expect(vue).toContain("formatPanelStandingHandoff");
    expect(vue).toContain("selectAlignPanel");
    expect(vue).toContain("formatPanelCoverageMarks");
    expect(vue).toContain("revealSsl5Focus");
    expect(vue).toContain("pickFirstMissingPanel");
    const loadAlign = handlerBody(vue, "async function loadAlign()", "async function bootstrap(");
    expect(loadAlign).toContain("await revealSsl5Focus(nextBoard, nextPlan)");
    expect(loadAlign.indexOf("ssl5Plan.value = nextPlan")).toBeLessThan(
      loadAlign.indexOf("await revealSsl5Focus(nextBoard, nextPlan)"),
    );
    expect(loadAlign).not.toContain("getStudioScriptRevisionImpact");
    expect(loadAlign).not.toContain("lookupRevisionImpact");
  });

  it("导入/物化在进行中 fail-closed：actionLoading 在首个 await 之前置位，按钮禁用并给出大白话原因，连点不会重复写入", () => {
    const vue = source();

    const importButton = buttonAttrs(vue, "script-library-import");
    expect(importButton).toContain(':disabled="Boolean(actionLoading)"');
    expect(importButton).toContain("正在处理，不能再导入剧本");
    expect(vue).toContain('{{ actionLoading === "import" ? "导入中…" : "导入新剧本" }}');

    const materializeButton = buttonAttrs(vue, "storyboard-wizard-materialize");
    expect(materializeButton).toContain(":disabled=\"!wizard || Boolean(wizardValidationErrors.length) || Boolean(actionLoading) || !wizardUnitTitle.trim()\"");
    expect(materializeButton).toContain("正在处理，不能再物化分镜");
    expect(vue).toContain('{{ actionLoading === "materialize" ? "写入中…" : "经命令总线物化" }}');

    const importHandler = handlerBody(vue, "async function importScript()", "function captureSelection(");
    expect(importHandler).toContain("if (actionLoading.value) return;");
    expect(importHandler).toContain('actionLoading.value = "import"');
    expect(importHandler.indexOf("if (actionLoading.value) return;")).toBeLessThan(
      importHandler.indexOf('actionLoading.value = "import"'),
    );
    expect(importHandler.indexOf('actionLoading.value = "import"')).toBeLessThan(
      importHandler.indexOf("await props.api.importScript"),
    );
    expect(importHandler).toContain('actionLoading.value = ""');

    const materializeHandler = handlerBody(vue, "async function materializeWizard()", "async function selectAlignRow(");
    expect(materializeHandler).toContain("if (!reader.value || !wizard.value || wizardValidationErrors.value.length || actionLoading.value) return;");
    expect(materializeHandler).toContain('actionLoading.value = "materialize"');
    expect(materializeHandler.indexOf("if (!reader.value || !wizard.value || wizardValidationErrors.value.length || actionLoading.value) return;")).toBeLessThan(
      materializeHandler.indexOf('actionLoading.value = "materialize"'),
    );
    expect(materializeHandler.indexOf('actionLoading.value = "materialize"')).toBeLessThan(
      materializeHandler.indexOf("await props.api.materializeStoryboardWizard"),
    );
    expect(materializeHandler).toContain('actionLoading.value = ""');
  });

  it("分镜建议进行中 fail-closed：busy 在首个 await 之前置位，阅读器与向导入口都禁用并给出大白话原因，连点不会重复写入", () => {
    const vue = source();

    const spanButton = buttonAttrs(vue, "script-reader-span-media");
    expect(spanButton).toContain(':disabled="Boolean(actionLoading)"');
    expect(spanButton).toContain("正在处理，不能再查这段配图");

    const readerSuggest = buttonAttrs(vue, "script-reader-to-wizard");
    expect(readerSuggest).toContain(':disabled="Boolean(actionLoading)"');
    expect(readerSuggest).toContain("正在处理，不能再生成分镜建议");
    expect(vue).toContain('{{ actionLoading === "wizard" ? "拆格中…" : "按选区生成 15 秒分镜" }}');

    const wizardSuggest = buttonAttrs(vue, "storyboard-wizard-suggest");
    expect(wizardSuggest).toContain(':disabled="Boolean(actionLoading)"');
    expect(wizardSuggest).toContain("正在处理，不能再生成分镜建议");
    expect(vue).toContain('{{ actionLoading === "wizard" ? "建议中…" : "重新生成建议" }}');

    const spanLookup = handlerBody(vue, "async function lookupSpanMedia()", "async function suggestWizard(");
    expect(spanLookup).toContain("if (actionLoading.value) return;");
    expect(spanLookup).toContain('actionLoading.value = "span-media"');
    expect(spanLookup.indexOf("if (actionLoading.value) return;")).toBeLessThan(
      spanLookup.indexOf('actionLoading.value = "span-media"'),
    );
    expect(spanLookup.indexOf('actionLoading.value = "span-media"')).toBeLessThan(
      spanLookup.indexOf("await props.api.getStudioScriptSpanMediaMap"),
    );

    const suggest = handlerBody(vue, "async function suggestWizard()", "function reflowWizardTimings(");
    expect(suggest).toContain("if (actionLoading.value) return;");
    expect(suggest).toContain('actionLoading.value = "wizard"');
    expect(suggest.indexOf("if (actionLoading.value) return;")).toBeLessThan(
      suggest.indexOf('actionLoading.value = "wizard"'),
    );
    expect(suggest.indexOf('actionLoading.value = "wizard"')).toBeLessThan(
      suggest.indexOf("await props.api.openStoryboardWizard"),
    );
    expect(suggest).toContain('actionLoading.value = ""');
    expect(suggest).toContain("report(reason)");
    expect(suggest).not.toContain("loadAlign(");
    expect(vue).toContain("wizardAlignCheckpointLine");
    expect(vue).toContain("对照板未加载，不自动查六图闸");
  });

  it("选区命中对照这格 fail-closed：busy 在首个 await 之前置位，未命中不猜宫格，缺图不绑其他格的图", () => {
    const vue = source();
    const alignButton = buttonAttrs(vue, "span-media-hit-align");
    expect(alignButton).toContain(':disabled="Boolean(actionLoading)"');
    expect(alignButton).toContain("正在处理，不能再对照这格");
    const reveal = handlerBody(vue, "async function revealAlignLocator(", "async function revealSpanMediaHit(");
    expect(reveal).toContain("if (actionLoading.value) return;");
    expect(reveal).toContain('actionLoading.value = "span-align"');
    expect(reveal.indexOf("if (actionLoading.value) return;")).toBeLessThan(
      reveal.indexOf('actionLoading.value = "span-align"'),
    );
    expect(reveal.indexOf('actionLoading.value = "span-align"')).toBeLessThan(
      reveal.indexOf("await Promise.all("),
    );
    expect(reveal).toContain('activeTab.value = "align"');
    expect(reveal).toContain("不能猜宫格");
    expect(reveal).toContain("loadAlignPreview(focusPanel.rawSha256)");
    expect(reveal).toContain("scrollAlignRowIntoView(target.unitId)");
    expect(vue).toContain('scrollIntoView({ block: "nearest" })');
    expect(reveal).toContain("不猜第一格");
    expect(reveal).not.toContain("revealSsl5Focus");
    expect(reveal).not.toContain("pickFirstCoveredPanel");
    expect(reveal).not.toContain("selectAlignRow");
    expect(reveal).not.toContain("getStudioBindingControl");
    expect(reveal).not.toContain("evaluateStudioConsistency");
    expect(vue).toContain("await revealAlignLocator({ unitId: hit.unitId, panelId: hit.panelId, panelIndex: hit.panelIndex })");
  });

  it("阅读器场景回指点穿：对照板未加载时由用户点穿再加载，不猜宫格", () => {
    const vue = source();
    const reveal = handlerBody(vue, "async function revealReaderSceneBackRef(", "async function revealSsl5Focus(");
    expect(reveal).toContain("if (actionLoading.value) return;");
    expect(reveal).toContain("getStudioScriptMediaAlignBoard");
    expect(reveal).toContain("planSsl5MissingToGen");
    expect(reveal).toContain("revealSceneBackRef");
    expect(reveal).toContain("不能当 generation-ready");
    expect(reveal).toContain('activeTab.value = "align"');
    expect(reveal).not.toContain("pickFirstCoveredPanel");
    expect(reveal).not.toContain("revealSsl5Focus");
    expect(reveal).not.toContain("getStudioBindingControl");
    expect(reveal).not.toContain("evaluateStudioConsistency");
    expect(vue).not.toContain("studio-scene-backrefs-read");
  });

  it("对照行选中只绑所选宫格 raw，不再回退整行/unit-grid 图", () => {
    const vue = source();
    const selectRow = handlerBody(vue, "async function selectAlignRow(", "async function selectAlignPanel(");
    expect(selectRow).toContain("loadAlignPreview(selectedAlignPanel.value?.rawSha256)");
    expect(selectRow).not.toContain("row.rawSha256");
    const ssl5 = handlerBody(vue, "async function revealSsl5Focus(", "async function scrollAlignRowIntoView(");
    expect(ssl5).toContain("loadAlignPreview(selectedAlignPanel.value?.rawSha256)");
    expect(ssl5).not.toContain("focusRow.rawSha256");
  });

  it("对照表宫格钮点精确格：stop 冒泡，缺图不绑其他格的图，不猜第一张有图", () => {
    const vue = source();
    const selectTable = handlerBody(vue, "async function selectAlignTablePanel(", "function peekLabel(");
    expect(selectTable).toContain("selectedAlignRow.value = row");
    expect(selectTable).toContain("selectedAlignPanel.value = panel");
    expect(selectTable).toContain("loadAlignPreview(panel.rawSha256)");
    expect(selectTable).not.toContain("pickFirstCoveredPanel");
    expect(selectTable).not.toContain("row.rawSha256");
    expect(vue).toContain('@click.stop="selectAlignTablePanel(row, panel)"');
    expect(vue).toContain("formatPanelCoverageMarks(row.panels)");
  });
});

describe("剧本媒体对齐文档卡视口剔除", () => {
  it("document-card 使用 content-visibility，离屏文稿跳过同步布局", () => {
    const vue = source();
    expect(vue).toContain('v-for="item in visibleLibraryItems"');
    expect(vue).toContain(".document-card{width:100%;display:block;margin-bottom:6px;text-align:left;padding:10px;content-visibility:auto;contain-intrinsic-size:auto 56px}");
    expect(vue).not.toMatch(/\.document-card\{[^}]*content-visibility:hidden/);
  });

  it("reader-nav 行使用 content-visibility，离屏大纲/单元跳过同步布局", () => {
    const vue = source();
    expect(vue).toContain('v-for="heading in reader.outline"');
    expect(vue).toContain(".reader-nav{max-height:680px;overflow:auto}");
    expect(vue).toContain(
      ".reader-nav button{width:100%;display:flex;justify-content:space-between;text-align:left;border:0;border-radius:0;background:transparent;color:var(--ui-text-2,#a6a99e);content-visibility:auto;contain-intrinsic-size:auto 28px}",
    );
    expect(vue).not.toMatch(/\.reader-nav button\{[^}]*content-visibility:hidden/);
    expect(vue).not.toMatch(/\.selection-status button\{[^}]*content-visibility/);
  });
});

describe("阅读器联动 earliest 正文", () => {
  it("点击本集单元用 sourceSpans 选中正文，不猜未锚定选区", () => {
    const vue = source();
    expect(vue).toContain("function focusUnitHighlight");
    expect(vue).toContain("function focusEarliestUnit");
    expect(vue).toContain('data-testid="script-reader-focus-earliest"');
    expect(vue).toContain("@keydown=\"onReaderKeydown\"");
    expect(vue).toContain("event.key.toLowerCase() === \"e\"");
    expect(vue).toContain("@click=\"focusUnitHighlight(unit)\"");
    expect(vue).toContain("void focusOutline(start, end)");
    expect(vue).toContain("该单元尚未锚定本修订，不能猜选区。");
    expect(vue).not.toContain("@click=\"emit('openUnit', { unitId: unit.unitId, target: 'canvas' })\"");
  });
});

describe("对照侧栏打开生成追溯", () => {
  it("点穿 pack/run 走 getStudioTrace，无钥匙不猜第一格", () => {
    const vue = source();
    const app = readFileSync(path.join(root, "src/renderer/src/App.vue"), "utf8");
    const contract = readFileSync(path.join(root, "src/renderer/src/material-studio-ui-contract.ts"), "utf8");
    expect(vue).toContain('data-testid="align-open-trace"');
    expect(vue).toContain('data-testid="span-media-hit-trace"');
    expect(vue).toContain("StudioGenerationTraceDrawer");
    expect(vue).toContain("resolveAlignTraceSelector");
    expect(vue).toContain("openHitGenerationTrace");
    expect(vue).toContain("禁止猜第一格");
    expect(vue).not.toContain("evaluateStudioConsistency");
    expect(app).toContain("window.canvasApi.getStudioTrace");
    expect(contract).toContain("getStudioTrace?");
  });

  it("阅读器本修订影响走 script-revision-impact，无 pack/run 不猜第一格", () => {
    const vue = source();
    const app = readFileSync(path.join(root, "src/renderer/src/App.vue"), "utf8");
    const contract = readFileSync(path.join(root, "src/renderer/src/material-studio-ui-contract.ts"), "utf8");
    expect(vue).toContain('data-testid="script-reader-revision-impact"');
    expect(vue).toContain("lookupRevisionImpact");
    expect(vue).toContain("openImpactRowTrace");
    expect(vue).toContain("getStudioScriptRevisionImpact");
    expect(vue).toContain("scriptRevisionId: reader.value.revisionId");
    expect(vue).toContain("limit: 20");
    expect(vue).toContain("非预期变化必须人工复核");
    expect(vue).toContain("不自动 Review PASS");
    expect(vue).not.toContain("from \"@core/studio-trace");
    expect(vue).not.toContain("evaluateStudioConsistency");
    expect(vue).not.toContain("getStudioBindingControl");
    expect(app).toContain("window.canvasApi.getStudioScriptRevisionImpact");
    expect(contract).toContain("getStudioScriptRevisionImpact?");
  });

  it("本修订影响可点穿对照格；无 panelId 只露单元行；已加载 unexpected 精炼 SSL-5", () => {
    const vue = source();
    const alignButton = buttonAttrs(vue, "revision-impact-row-align");
    expect(alignButton).toContain(':disabled="Boolean(actionLoading)"');
    expect(alignButton).toContain("revealImpactRowAlign(unit, row)");
    expect(vue).toContain('{{ row.panelId ? "对照这格" : "露出这单元" }}');
    expect(vue).toContain("无 panelId，只露单元行，不猜第一格");
    const impactAlign = handlerBody(vue, "async function revealImpactRowAlign(", "async function revealReaderSceneBackRef(");
    expect(impactAlign).toContain("await revealAlignLocator({ unitId: unit.unitId, panelId: row.panelId })");
    expect(impactAlign).not.toContain("pickFirstCoveredPanel");
    expect(impactAlign).not.toContain("selectAlignRow");
    expect(impactAlign).not.toContain("from \"@core/studio-trace");
    expect(vue).toContain("refineSsl5FocusIfUnexpectedRevisionImpact(ssl5Plan.value, revisionImpact.value)");
    expect(vue).toContain("planSsl5MissingToGen(props.projectRoot, query)");
    expect(vue).not.toContain("revisionImpact: revisionImpact.value");
    expect(vue).toContain("ssl5DisplayedPlan");
    expect(vue).toContain("SSL5_UNEXPECTED_REVISION_IMPACT_REASON");
    expect(vue).toContain("ssl5DisplayedPlan?.generationPlanDraft.ready");
    const lookup = handlerBody(vue, "async function lookupRevisionImpact(", "async function lookupRevisionImpactNext(");
    expect(lookup).not.toContain("loadAlign(");
    expect(lookup).not.toContain("planSsl5MissingToGen");
    expect(vue).toContain("import type { Ssl5MissingToGenPlan } from \"@core/studio-ssl5-missing-to-gen\"");
    expect(vue).not.toMatch(/import\s+\{[^}]*planSsl5MissingToGen/u);
  });

  it("本修订影响可翻下一页，对照表复用已加载 unexpected，不自动查", () => {
    const vue = source();
    expect(vue).toContain('data-testid="script-reader-revision-impact-next"');
    expect(vue).toContain("lookupRevisionImpactNext");
    expect(vue).toContain("mergeSsl5RevisionImpactPages");
    expect(vue).toContain("cursor");
    expect(vue).toContain("loadedRevisionImpactUnexpectedMark");
    expect(vue).toContain("loadedRevisionImpactAlignLine");
    expect(vue).toContain('data-testid="align-panel-revision-impact"');
    expect(vue).toContain("align-impact-");
    expect(vue).toContain("ssl5UnexpectedReview");
    expect(vue).toContain("去审片复核");
    expect(vue).toContain("target: ssl5UnexpectedReview ? 'review' : 'binding'");
    const next = handlerBody(vue, "async function lookupRevisionImpactNext(", "async function lookupSpanMedia(");
    expect(next).toContain("if (actionLoading.value) return;");
    expect(next).toContain("revisionImpact.value?.nextCursor");
    expect(next).toContain("cursor");
    expect(next).toContain("mergeSsl5RevisionImpactPages");
    expect(next).not.toContain("loadAlign(");
    expect(next).not.toContain("planSsl5MissingToGen");
    const loadAlign = handlerBody(vue, "async function loadAlign()", "async function bootstrap(");
    expect(loadAlign).not.toContain("lookupRevisionImpactNext");
    expect(loadAlign).not.toContain("getStudioScriptRevisionImpact");
    expect(vue).not.toContain("from \"@core/studio-trace");
  });
});
