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
    expect(vue).toContain('data-testid="script-reader-to-wizard"');
    expect(vue).toContain('data-testid="script-reader-span-media"');
    expect(vue).toContain('data-testid="script-reader-span-media-board"');
    expect(vue).toContain("getStudioScriptSpanMediaMap");
    expect(vue).toContain('data-testid="storyboard-wizard-suggest"');
    expect(vue).toContain('data-testid="storyboard-wizard-materialize"');
    expect(vue).toContain('data-testid="ssl5-missing-to-gen-plan"');
    expect(vue).toContain("planSsl5MissingToGen");
    expect(vue).toContain("不自动 dispatch");
    expect(vue).toContain("align-peek-");
    expect(vue).toContain("未评估");
    expect(vue).toContain("<th>四态</th>");
    expect(vue).toContain("<th>宫格</th>");
    expect(vue).toContain("align-panels-");
    expect(vue).toContain("align-panel-list");
    expect(vue).toContain("selectAlignPanel");
    expect(vue).toContain("formatPanelCoverageMarks");
    expect(vue).toContain("revealSsl5Focus");
    expect(vue).toContain("pickFirstMissingPanel");
    const loadAlign = handlerBody(vue, "async function loadAlign()", "async function bootstrap(");
    expect(loadAlign).toContain("await revealSsl5Focus(nextBoard, nextPlan)");
    expect(loadAlign.indexOf("ssl5Plan.value = nextPlan")).toBeLessThan(
      loadAlign.indexOf("await revealSsl5Focus(nextBoard, nextPlan)"),
    );
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
