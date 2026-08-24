import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "@vue/compiler-sfc";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function source(): string {
  return readFileSync(path.join(root, "src/renderer/src/components/ProductionDesignView.vue"), "utf8");
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

describe("生产设计保存源码合同", () => {
  it("SFC 可解析并暴露五类保存动作", () => {
    const vue = source();
    expect(parse(vue, { filename: "ProductionDesignView.vue" }).errors).toEqual([]);
    expect(vue).toContain('data-testid="save-production-stage"');
    expect(vue).toContain('data-testid="save-creative-bible"');
    expect(vue).toContain('data-testid="save-storyboard-row"');
    expect(vue).toContain('data-testid="save-asset-relation"');
    expect(vue).toContain('data-testid="save-voice-identity"');
  });

  it("保存在进行中 fail-closed：busy 在首个 await 之前置位，按钮禁用并给出大白话原因，连点不会重复写入", () => {
    const vue = source();

    const stage = buttonAttrs(vue, "save-production-stage");
    expect(stage).toContain(':disabled="saving"');
    expect(stage).toContain("正在处理，不能再保存阶段");
    expect(vue).toContain('{{ saving ? "保存中" : "保存阶段" }}');

    const bible = buttonAttrs(vue, "save-creative-bible");
    expect(bible).toContain(':disabled="saving||!bibleDraft.name.trim()"');
    expect(bible).toContain("正在处理，不能再保存 Bible");
    expect(vue).toContain('{{ saving ? "保存中" : "保存 Bible" }}');

    const row = buttonAttrs(vue, "save-storyboard-row");
    expect(row).toContain(':disabled="saving"');
    expect(row).toContain("正在处理，不能再保存分镜");
    expect(vue).toContain('{{ saving ? "保存中" : "保存分镜" }}');

    const relation = buttonAttrs(vue, "save-asset-relation");
    expect(relation).toContain(':disabled="saving||!relationDraft.parentItemId||!relationDraft.childItemId"');
    expect(relation).toContain("正在处理，不能再保存关系");
    expect(vue).toContain('{{saving ? "保存中" : (relationDraft.id?\'修订关系\':\'保存关系\')}}');

    const voice = buttonAttrs(vue, "save-voice-identity");
    expect(voice).toContain(':disabled="saving||!voiceDraft.name.trim()"');
    expect(voice).toContain("正在处理，不能再保存音色");
    expect(vue).toContain('{{ saving ? "保存中" : "保存音色" }}');

    const saveStage = handlerBody(vue, "async function saveStage()", "function newBible()");
    expect(saveStage).toContain("if(!workflow.value||!stageDraft.value||saving.value)return;");
    expect(saveStage).toContain("saving.value=true");
    expect(saveStage.indexOf("if(!workflow.value||!stageDraft.value||saving.value)return;")).toBeLessThan(
      saveStage.indexOf("saving.value=true"),
    );
    expect(saveStage.indexOf("saving.value=true")).toBeLessThan(
      saveStage.indexOf("await window.canvasApi.updateProductionWorkflowStage"),
    );
    expect(saveStage).toContain("saving.value=false");

    const saveBible = handlerBody(vue, "async function saveBible()", "async function impactBible()");
    expect(saveBible).toContain("if(saving.value||!bibleDraft.name.trim())return;");
    expect(saveBible).toContain("saving.value=true");
    expect(saveBible.indexOf("if(saving.value||!bibleDraft.name.trim())return;")).toBeLessThan(
      saveBible.indexOf("saving.value=true"),
    );
    expect(saveBible.indexOf("saving.value=true")).toBeLessThan(
      saveBible.indexOf("await window.canvasApi.upsertCreativeBible"),
    );

    const saveRow = handlerBody(vue, "async function saveRow()", "function newRelation()");
    expect(saveRow).toContain("if(!storyboardItemId.value||saving.value)return;");
    expect(saveRow).toContain("saving.value=true");
    expect(saveRow.indexOf("if(!storyboardItemId.value||saving.value)return;")).toBeLessThan(
      saveRow.indexOf("saving.value=true"),
    );
    expect(saveRow.indexOf("saving.value=true")).toBeLessThan(
      saveRow.indexOf("await window.canvasApi.upsertStoryboardRow"),
    );

    const saveRelation = handlerBody(vue, "async function saveRelation()", "function newVoice()");
    expect(saveRelation).toContain("if(saving.value||!relationDraft.parentItemId||!relationDraft.childItemId)return;");
    expect(saveRelation).toContain("saving.value=true");
    expect(saveRelation.indexOf("if(saving.value||!relationDraft.parentItemId||!relationDraft.childItemId)return;")).toBeLessThan(
      saveRelation.indexOf("saving.value=true"),
    );
    expect(saveRelation.indexOf("saving.value=true")).toBeLessThan(
      saveRelation.indexOf("await window.canvasApi.upsertAssetRelation"),
    );

    const saveVoice = handlerBody(vue, "async function saveVoice()", "function stageLabel(");
    expect(saveVoice).toContain("if(saving.value||!voiceDraft.name.trim())return;");
    expect(saveVoice).toContain("saving.value=true");
    expect(saveVoice.indexOf("if(saving.value||!voiceDraft.name.trim())return;")).toBeLessThan(
      saveVoice.indexOf("saving.value=true"),
    );
    expect(saveVoice.indexOf("saving.value=true")).toBeLessThan(
      saveVoice.indexOf("await window.canvasApi.upsertVoiceIdentity"),
    );
  });

  it("一致性准备/提交/封存在进行中 fail-closed：busy 在首个 await 之前置位，按钮禁用并给出大白话原因，连点不会重复写入", () => {
    const vue = source();

    const prepare = buttonAttrs(vue, "prepare-fusion-asset-consistency");
    expect(prepare).toContain(':disabled="saving"');
    expect(prepare).toContain("正在处理，不能再准备复核板");
    expect(vue).toContain('{{ saving ? "准备中" : (consistencyState.persisted?\'准备 2×3 复核板\':\'接管当前六项\') }}');

    const submit = buttonAttrs(vue, "submit-fusion-asset-consistency");
    expect(submit).toContain(':disabled="!canSubmitConsistency||saving"');
    expect(submit).toContain("正在处理，不能再提交复核");
    expect(vue).toContain('{{ saving ? "提交中" : "提交内容绑定复核" }}');

    const seal = buttonAttrs(vue, "seal-fusion-asset-consistency");
    expect(seal).toContain(':disabled="saving"');
    expect(seal).toContain("正在处理，不能再封存批次");
    expect(vue).toContain('{{ saving ? "封存中" : "封存全季最终不足六项" }}');

    const prepareFn = handlerBody(vue, "async function prepareConsistencyReview()", "async function submitConsistencyReview()");
    expect(prepareFn).toContain("if(saving.value)return;");
    expect(prepareFn).toContain("saving.value=true");
    expect(prepareFn.indexOf("if(saving.value)return;")).toBeLessThan(prepareFn.indexOf("saving.value=true"));
    expect(prepareFn.indexOf("saving.value=true")).toBeLessThan(prepareFn.indexOf("await window.canvasApi.prepareFusionAssetConsistencyReview"));
    expect(prepareFn).toContain('emit("failed"');
    expect(prepareFn).toContain("saving.value=false");

    const submitFn = handlerBody(vue, "async function submitConsistencyReview()", "async function sealFinalConsistencyBatch()");
    expect(submitFn).toContain("if(saving.value||!batch?.currentSnapshotHash||!consistencyState.value)return;");
    expect(submitFn).toContain("saving.value=true");
    expect(submitFn.indexOf("if(saving.value||!batch?.currentSnapshotHash||!consistencyState.value)return;")).toBeLessThan(submitFn.indexOf("saving.value=true"));
    expect(submitFn.indexOf("saving.value=true")).toBeLessThan(submitFn.indexOf("await window.canvasApi.submitFusionAssetConsistencyReview"));
    expect(submitFn).toContain('emit("failed"');
    expect(submitFn).toContain("saving.value=false");

    const sealFn = handlerBody(vue, "async function sealFinalConsistencyBatch()", "function resetConsistencyForm()");
    expect(sealFn).toContain("if(saving.value||!batch||!consistencyState.value)return;");
    expect(sealFn).toContain("saving.value=true");
    expect(sealFn.indexOf("if(saving.value||!batch||!consistencyState.value)return;")).toBeLessThan(sealFn.indexOf("saving.value=true"));
    expect(sealFn.indexOf("saving.value=true")).toBeLessThan(sealFn.indexOf("await window.canvasApi.sealFinalFusionAssetConsistencyBatch"));
    expect(sealFn).toContain('emit("failed"');
    expect(sealFn).toContain("saving.value=false");
  });

  it("分镜构建/迁移/核验在进行中 fail-closed：handler 在置 busy 前拦截，同 tick 连点不会重复写入", () => {
    const vue = source();

    const build = buttonAttrs(vue, "build-fusion-storyboard-grid");
    expect(build).toContain(':disabled="saving||!storyboard.valid"');
    expect(build).toContain("正在处理，不能再构建宫格");

    const migrateEvidence = buttonAttrs(vue, "migrate-fusion-storyboard-evidence");
    expect(migrateEvidence).toContain(':disabled="saving||!storyboardItemId"');
    expect(migrateEvidence).toContain("正在处理，不能再迁移槽位证据");

    const reload = buttonAttrs(vue, "reload-production-workflow");
    expect(reload).toContain(':disabled="saving"');
    expect(reload).toContain("正在处理，不能再核验工作流");

    const reloadFn = handlerBody(vue, "async function reloadWorkflow()", "function stageAudit(");
    expect(reloadFn).toContain("if(saving.value)return;");
    expect(reloadFn.indexOf("if(saving.value)return;")).toBeLessThan(reloadFn.indexOf("saving.value=true"));
    expect(reloadFn.indexOf("saving.value=true")).toBeLessThan(reloadFn.indexOf("await window.canvasApi.getProductionWorkflow"));

    const buildFn = handlerBody(vue, "async function buildStoryboardGrid()", "async function migrateStoryboardEvidence()");
    expect(buildFn).toContain("if(!storyboardItemId.value||saving.value)return;");
    expect(buildFn.indexOf("if(!storyboardItemId.value||saving.value)return;")).toBeLessThan(buildFn.indexOf("saving.value=true"));
    expect(buildFn.indexOf("saving.value=true")).toBeLessThan(buildFn.indexOf("await window.canvasApi.buildFusionStoryboardGrid"));

    const migrateEvidenceFn = handlerBody(vue, "async function migrateStoryboardEvidence()", "async function migrateStoryboardSheets()");
    expect(migrateEvidenceFn).toContain("if(!storyboardItemId.value||saving.value)return;");
    expect(migrateEvidenceFn.indexOf("if(!storyboardItemId.value||saving.value)return;")).toBeLessThan(migrateEvidenceFn.indexOf("saving.value=true"));
    expect(migrateEvidenceFn.indexOf("saving.value=true")).toBeLessThan(migrateEvidenceFn.indexOf("await window.canvasApi.migrateFusionStoryboardEvidence"));

    const migrateSheetsFn = handlerBody(vue, "async function migrateStoryboardSheets()", "async function enqueueStoryboardPanel(");
    expect(migrateSheetsFn).toContain("if(saving.value||!itemId||!canMigrateSheet.value||!preview)return;");
    expect(migrateSheetsFn.indexOf("if(saving.value||!itemId||!canMigrateSheet.value||!preview)return;")).toBeLessThan(
      migrateSheetsFn.indexOf("saving.value=true"),
    );

    const enqueueFn = handlerBody(vue, "async function enqueueStoryboardPanel(", "async function renderStoryboardSheet()");
    expect(enqueueFn).toContain("if(saving.value||!storyboardItemId.value||!gridContract.value||!canEnqueueStoryboardPanel(panelIndex))return;");
    expect(enqueueFn.indexOf("if(saving.value||!storyboardItemId.value||!gridContract.value||!canEnqueueStoryboardPanel(panelIndex))return;")).toBeLessThan(
      enqueueFn.indexOf("saving.value=true"),
    );

    const renderFn = handlerBody(vue, "async function renderStoryboardSheet()", "async function showStoryboardSheet()");
    expect(renderFn).toContain("if(saving.value||!itemId||!contract||!canRenderSheet.value)return;");
    expect(renderFn.indexOf("if(saving.value||!itemId||!contract||!canRenderSheet.value)return;")).toBeLessThan(
      renderFn.indexOf("saving.value=true"),
    );
  });
});

describe("生产设计列表视口剔除", () => {
  it("bible-list 行使用 content-visibility，离屏圣经条目跳过同步布局", () => {
    const vue = source();
    expect(vue).toContain('v-for="bible in bibles"');
    expect(vue).toContain(".bible-list{overflow:auto;border-right:1px solid #30322c;background:#151613}");
    expect(vue).toContain(".bible-list>button{width:100%;padding:13px 15px;border:0;border-bottom:1px solid #292b25;border-left:2px solid transparent;background:transparent;color:#aaa;text-align:left;content-visibility:auto;contain-intrinsic-size:auto 56px}");
    expect(vue).not.toMatch(/\.bible-list>button\{[^}]*content-visibility:hidden/);
  });

  it("voice-list 与 registry-list 行使用 content-visibility，离屏音色/关系跳过同步布局", () => {
    const vue = source();
    expect(vue).toContain(".registry-list,.voice-list{max-height:220px;overflow:auto;border-bottom:1px solid #30322c;background:#121310}");
    expect(vue).toContain(".voice-list button{width:100%;padding:13px 22px;border:0;border-bottom:1px solid #292b25;border-left:2px solid transparent;background:transparent;color:#aaa;text-align:left;content-visibility:auto;contain-intrinsic-size:auto 56px}");
    expect(vue).toContain(".registry-list button{width:100%;padding:13px 22px;border:0;border-bottom:1px solid #292b25;border-left:2px solid transparent;background:transparent;color:#aaa;text-align:left;content-visibility:auto;contain-intrinsic-size:auto 56px}");
    expect(vue).not.toMatch(/\.voice-list button\{[^}]*content-visibility:hidden/);
  });

  it("registry-list article 使用 content-visibility，离屏只读关系卡跳过同步布局", () => {
    const vue = source();
    expect(vue).toContain(".registry-list article{padding:13px 22px;border-bottom:1px solid #292b25;content-visibility:auto;contain-intrinsic-size:auto 56px}");
    expect(vue).toContain(".registry-list button{width:100%;padding:13px 22px;border:0;border-bottom:1px solid #292b25;border-left:2px solid transparent;background:transparent;color:#aaa;text-align:left;content-visibility:auto;contain-intrinsic-size:auto 56px}");
    expect(vue).toContain(".voice-list button{width:100%;padding:13px 22px;border:0;border-bottom:1px solid #292b25;border-left:2px solid transparent;background:transparent;color:#aaa;text-align:left;content-visibility:auto;contain-intrinsic-size:auto 56px}");
    expect(vue).toContain('data-testid="production-design-dialogue"');
    expect(vue).toContain('data-testid="production-design-continuity"');
    expect(vue).toContain('data-testid="production-design-prompts"');
    expect(vue).not.toMatch(/\.registry-list article\{[^}]*content-visibility:\s*hidden/);
    expect(vue).not.toMatch(/\.registry-list>p\{[^}]*content-visibility/);
    expect(vue).not.toMatch(/\.registry-form label\{[^}]*content-visibility/);
  });

  it("storyboard-table 行使用 content-visibility，离屏分镜行跳过同步布局", () => {
    const vue = source();
    expect(vue).toContain('v-for="row in storyboard.rows"');
    expect(vue).toContain(".storyboard-table>button{width:100%;min-height:62px;padding:8px 12px;border:0;border-bottom:1px solid #292b25;border-left:2px solid transparent;background:transparent;color:#aaa;text-align:left;content-visibility:auto;contain-intrinsic-size:auto 62px}");
    expect(vue).not.toMatch(/\.storyboard-table>button\{[^}]*content-visibility:hidden/);
  });

  it("fusion-sheet-history 卡使用 content-visibility，离屏历史成板跳过同步布局", () => {
    const vue = source();
    expect(vue).toContain(".fusion-sheet-history>article{flex:0 0 520px;overflow:auto;padding:10px 14px;border-right:1px solid #30322c;content-visibility:auto;contain-intrinsic-size:auto 117px}");
    expect(vue).toContain(".registry-list article{padding:13px 22px;border-bottom:1px solid #292b25;content-visibility:auto;contain-intrinsic-size:auto 56px}");
    expect(vue).toContain('data-testid="fusion-sheet-history"');
    expect(vue).toContain('data-testid="production-design-dialogue"');
    expect(vue).toContain('data-testid="save-storyboard-row"');
    expect(vue).toContain(':disabled="saving"');
    expect(vue).not.toMatch(/\.fusion-sheet-history>article\{[^}]*content-visibility:\s*hidden/);
    expect(vue).not.toMatch(/\.fusion-sheet-history>p\{[^}]*content-visibility/);
    expect(vue).not.toMatch(/\.fusion-sheet-history article button\{[^}]*content-visibility/);
  });

  it("grid-panel-strip 卡使用 content-visibility，离屏宫格跳过同步布局", () => {
    const vue = source();
    expect(vue).toContain(".grid-panel-strip article{flex:0 0 520px;display:grid;grid-template-columns:128px 1fr;border-right:1px solid #40505a;background:#f1ede4;color:#17242a;content-visibility:auto;contain-intrinsic-size:auto 190px}");
    expect(vue).toContain(".fusion-sheet-history>article{flex:0 0 520px;overflow:auto;padding:10px 14px;border-right:1px solid #30322c;content-visibility:auto;contain-intrinsic-size:auto 117px}");
    expect(vue).toContain('data-testid="fusion-storyboard-grid-preview"');
    expect(vue).toContain("`enqueue-fusion-grid-panel-${panel.index}`");
    expect(vue).toContain('data-testid="production-design-continuity"');
    expect(vue).not.toMatch(/\.grid-panel-strip article\{[^}]*content-visibility:\s*hidden/);
    expect(vue).not.toMatch(/\.grid-frame\{[^}]*content-visibility/);
    expect(vue).not.toMatch(/\.storyboard-grid-preview>footer\{[^}]*content-visibility/);
  });

  it("fusion-sheet-blockers 行使用 content-visibility，离屏门禁跳过同步布局", () => {
    const vue = source();
    expect(vue).toContain(".fusion-sheet-blockers span{display:block;margin:4px 0;color:#c87b6c;font-size:7px;line-height:1.45;content-visibility:auto;contain-intrinsic-size:auto 18px}");
    expect(vue).toContain(".fusion-sheet-blockers span.ready{color:#83aa72}");
    expect(vue).toContain(".fusion-sheet-history>article{flex:0 0 520px;overflow:auto;padding:10px 14px;border-right:1px solid #30322c;content-visibility:auto;contain-intrinsic-size:auto 117px}");
    expect(vue).toContain('data-testid="fusion-sheet-blockers"');
    expect(vue).toContain('data-testid="production-design-prompts"');
    expect(vue).toContain(':disabled="saving"');
    expect(vue).not.toMatch(/\.fusion-sheet-blockers span\{[^}]*content-visibility:\s*hidden/);
    expect(vue).not.toMatch(/\.fusion-sheet-blockers span\.ready\{[^}]*content-visibility/);
    expect(vue).not.toMatch(/\.fusion-sheet-blockers>b\{[^}]*content-visibility/);
  });
});

describe("生产设计分镜诊断 disclosure", () => {
  it("只读来源证据 summary 含 testid，不改保存 busy", () => {
    const vue = source();
    expect(vue).toContain('class="evidence-contract"');
    expect(vue).toContain('data-testid="production-design-evidence"');
    expect(vue).toContain('<summary data-testid="production-design-evidence">只读来源证据</summary>');
    expect(vue).toContain("selectedRow?.sourceSpans");
    expect(vue).not.toContain("production-design-evidence-");
    expect(vue).not.toContain('evidence-contract" role="dialog"');
    expect(vue).toContain('data-testid="save-storyboard-row"');
    expect(vue).toContain(':disabled="saving"');
  });

  it("导演设计 summary 含 testid，details 仍默认展开", () => {
    const vue = source();
    expect(vue).toContain('data-testid="production-design-director"');
    expect(vue).toContain('<details open><summary data-testid="production-design-director">导演设计</summary>');
    expect(vue).not.toContain("production-design-director-");
    expect(vue).toContain('data-testid="production-design-evidence"');
  });

  it("对白旁白声音 summary 含 testid，不默认展开，不抢导演设计", () => {
    const vue = source();
    expect(vue).toContain('data-testid="production-design-dialogue"');
    expect(vue).toContain('<details><summary data-testid="production-design-dialogue">对白、旁白与声音</summary>');
    expect(vue).not.toContain("production-design-dialogue-");
    expect(vue).not.toContain('production-design-dialogue" role="dialog"');
    expect(vue).toContain('data-testid="production-design-director"');
    expect(vue).toContain('data-testid="production-design-evidence"');
    expect(vue).toContain(':disabled="saving"');
  });

  it("连续性与参考资产 summary 含 testid，details 仍默认展开", () => {
    const vue = source();
    expect(vue).toContain('data-testid="production-design-continuity"');
    expect(vue).toContain('<details open><summary data-testid="production-design-continuity">连续性与参考资产</summary>');
    expect(vue).not.toContain("production-design-continuity-");
    expect(vue).toContain('data-testid="production-design-director"');
    expect(vue).toContain('data-testid="production-design-dialogue"');
  });

  it("生成提示词 summary 含 testid，details 仍默认展开", () => {
    const vue = source();
    expect(vue).toContain('data-testid="production-design-prompts"');
    expect(vue).toContain('<details open><summary data-testid="production-design-prompts">生成提示词</summary>');
    expect(vue).not.toContain("production-design-prompts-");
    expect(vue).toContain('data-testid="production-design-evidence"');
    expect(vue).toContain('data-testid="production-design-director"');
    expect(vue).toContain('data-testid="production-design-dialogue"');
    expect(vue).toContain('data-testid="production-design-continuity"');
    expect(vue).toContain('data-testid="save-storyboard-row"');
  });
});
