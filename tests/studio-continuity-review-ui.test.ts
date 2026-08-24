import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "@vue/compiler-sfc";
import { describe, expect, it } from "vitest";
import type { StudioContinuityReviewControl } from "../src/core/studio-continuity-review-control.js";
import {
  beginStudioContinuityReviewLoad,
  buildStudioContinuityReviewQuery,
  commitStudioContinuityReviewLoad,
  createStudioContinuityReviewLoadState,
  failStudioContinuityReviewLoad,
  parseStudioContinuityReviewAssetIds,
} from "../src/renderer/src/studio-continuity-review-store.js";

function control(fingerprint: string): StudioContinuityReviewControl {
  return {
    schemaVersion: 1,
    kind: "studio-continuity-review-control",
    scope: {
      kind: "panel",
      scopeId: "panel-01",
      unitId: "unit-01",
      unitRevision: 1,
      startMilliseconds: 0,
      endMilliseconds: 7_500,
      fingerprint: "a".repeat(64),
    },
    assetIds: [],
    assets: [],
    conflicts: { offset: 0, limit: 18, total: 0, items: [] },
    generation: { status: "ready", packId: "pack-01", fingerprint: "c".repeat(64) },
    checkpoint: {
      completedSlotCount: 0,
      fullBatchCount: 0,
      collectingSlotCount: 0,
      newSlotDispatchAllowed: true,
      batches: { offset: 0, limit: 6, total: 0, items: [] },
      fingerprint: "b".repeat(64),
    },
    nextAction: {
      code: "freeze-generation-pack",
      label: "冻结当前宫格生成包",
      reason: "ready",
      requiresWrite: true,
      command: "freeze_studio_generation_pack",
    },
    fingerprint,
  };
}

describe("P7 连续性 / Review UI 有界 store", () => {
  it("只构造最多六资产及固定小页查询，不允许前端请求全量列表", () => {
    const query = buildStudioContinuityReviewQuery({
      unitId: "unit-01",
      unitRevision: "2",
      panelId: "panel-03",
      startMilliseconds: "5000",
      endMilliseconds: "7500",
      assetIds: "character-ahang，scene-stone-room prop-mask",
      generationRunId: "run-03",
    });
    expect(query).toMatchObject({
      unitId: "unit-01",
      unitRevision: 2,
      panelId: "panel-03",
      startMilliseconds: 5_000,
      endMilliseconds: 7_500,
      assetIds: ["character-ahang", "scene-stone-room", "prop-mask"],
      generationRunId: "run-03",
      timelineLimit: 18,
      conflictLimit: 18,
      reviewLimit: 12,
      checkpointLimit: 6,
    });
    expect(parseStudioContinuityReviewAssetIds("a b c d e f")).toHaveLength(6);
    expect(() => parseStudioContinuityReviewAssetIds("a b c d e f g")).toThrow(/最多查询 6 项/u);
    expect(() => parseStudioContinuityReviewAssetIds("a a")).toThrow(/不能重复/u);
  });

  it("异步旧响应不能覆盖切换工程后的新控制面", () => {
    const state = createStudioContinuityReviewLoadState();
    const oldToken = beginStudioContinuityReviewLoad(state, "/tmp/studio-old");
    const currentToken = beginStudioContinuityReviewLoad(state, "/tmp/studio-current");
    expect(commitStudioContinuityReviewLoad(state, oldToken, control("1".repeat(64)))).toBe(false);
    expect(commitStudioContinuityReviewLoad(state, currentToken, control("2".repeat(64)))).toBe(true);
    expect(state.control?.fingerprint).toBe("2".repeat(64));
    const newerToken = beginStudioContinuityReviewLoad(state, "/tmp/studio-current");
    expect(failStudioContinuityReviewLoad(state, currentToken, new Error("旧错误"))).toBe(false);
    expect(failStudioContinuityReviewLoad(state, newerToken, new Error("当前错误"))).toBe(true);
    expect(state.error).toBe("当前错误");
  });

  it("组件惰性读取并直接渲染 Core nextAction，不在前端维护第二套业务状态", async () => {
    const relative = "src/renderer/src/components/StudioContinuityReviewView.vue";
    const source = await readFile(path.join(process.cwd(), relative), "utf8");
    const parsed = parse(source, { filename: relative });
    expect(parsed.errors).toEqual([]);
    const template = parsed.descriptor.template?.content ?? "";
    expect(template).toContain('data-testid="studio-continuity-review-view"');
    expect(template).toContain('data-testid="continuity-next-action"');
    expect(template).toContain('data-testid="continuity-assets"');
    expect(template).toContain('data-testid="generation-review-control"');
    expect(template).toContain('data-testid="generation-checkpoint-control"');
    for (const label of ["服装", "伤势", "持物", "位置", "朝向", "情绪", "布局", "光线", "参考图"]) {
      expect(source).toContain(label);
    }
    expect(source).toContain("loadState.control.nextAction.label");
    expect(source).toContain("loadState.control.nextAction.reason");
    expect(source).toContain("当前六图停检批存在未完成或已陈旧的审片");
    expect(source).toContain("nextActionHasTechnicalReason");
    expect(source).toContain("请从宫格或结果节点打开审片");
    expect(source).toContain("整板生成结果");
    expect(source).toContain("连续性辅助范围");
    expect(source).toContain('focus.generationTarget?.targetKind === "unit-grid"');
    expect(source).toContain("<details class=\"diagnostic-details\">");
    expect(source).not.toContain("<details open");
    expect(source).not.toContain("onMounted(");
    expect(source).not.toContain("executeStudioCommand");
    expect(source).not.toMatch(/nextAction\s*=|nextAction\s*:/u);
    // immediate focus 会同步进入媒体失效逻辑；watch 必须在其依赖的后置状态初始化完成后注册。
    expect(source.indexOf("watch(() => props.focus?.token")).toBeGreaterThan(source.indexOf("let differenceRequestSequence = 0"));
  });

  it("整板末格交接把可读状态与内部定位明确区分，不能把定位 ID 伪装成站位或朝向", async () => {
    const relative = "src/renderer/src/components/StudioContinuityReviewView.vue";
    const source = await readFile(path.join(process.cwd(), relative), "utf8");
    const template = parse(source, { filename: relative }).descriptor.template?.content ?? "";
    expect(template).toContain('data-testid="continuity-next-shot-handoff"');
    expect(template).toContain("末格可复用状态");
    expect(source).toContain("const continuityHandoff = computed");
    expect(source).toContain('new Set<StudioContinuityField>(["position", "facing", "heldObject", "layout", "lighting"])');
    expect(source).toContain("内部定位（需人工补全，不可直接用作镜头状态）");
    expect(source).toContain("须先人工补全");
    expect(source).toContain('assetDisplayReady(asset) ? "就绪" : assetHasOpaqueState(asset) ? "需补全" : "阻断"');
    expect(source).toContain('assetFieldHasOpaqueState(asset, field.field) ? "需补全"');
  });

  it("内部定位只能经人工输入追加校正，UI 不会自动猜测或覆盖连续性历史", async () => {
    const relative = "src/renderer/src/components/StudioContinuityReviewView.vue";
    const source = await readFile(path.join(process.cwd(), relative), "utf8");
    const template = parse(source, { filename: relative }).descriptor.template?.content ?? "";
    expect(template).toContain('data-testid="continuity-opaque-correction"');
    expect(source).toContain("reviewMediaAvailable");
    expect(template).toContain('data-testid="continuity-reference-workbench"');
    expect(source).toContain("停检账本已闭合的 raw/labeled 仅供核对并追加真实连续性状态");
    expect(source).toContain("该记录没有受管生成 run，不能提交 Studio Review");
    expect(source).toContain("props.focus?.reviewWriteAllowed !== false");
    expect(source).toContain('(props.focus?.generationRunId ?? "") === generationRunId');
    expect(source).toContain("当前校正缺少已核验 raw/labeled 身份");
    expect(template).toContain("真实可见状态");
    expect(template).toContain("该字段不适用");
    expect(template).toContain("不适用原因");
    expect(template).toContain("追加人工校正");
    expect(source).toContain("const continuityCorrectionRows = computed");
    expect(source).toContain("item.field === \"referenceSha256\"");
    expect(source).toContain("isOpaqueContinuityLocator(value)");
    expect(source).toContain("appendOpaqueCorrection");
    expect(source).toContain('status: "not-applicable"');
    expect(source).toContain("props.api.appendContinuityCorrection");
    expect(source).toContain("每次提交会追加校正记录，不会覆盖历史");
    expect(source).not.toContain("append_studio_continuity_correction");

    const store = await readFile(path.join(process.cwd(), "src/renderer/src/studio-continuity-review-store.ts"), "utf8");
    expect(store).toContain("StudioContinuityCorrectionUiInput");
    expect(store).toContain('status: "not-applicable"; reason: string');
    expect(store).toContain('Exclude<StudioContinuityField, "referenceSha256">');
    expect(store).toContain("appendContinuityCorrection?");

    const app = await readFile(path.join(process.cwd(), "src/renderer/src/App.vue"), "utf8");
    expect(app).toContain('command: "append_studio_continuity_correction"');
    expect(app).toContain('kind: "user-visual-confirmation"');
    expect(app).toContain('status: "not-applicable" as const');

    const materialStudio = await readFile(path.join(process.cwd(), "src/renderer/src/components/MaterialStudioView.vue"), "utf8");
    expect(materialStudio).toContain('@open-review="onCanvasOpenReview"');
    expect(app).toContain("用户在无限画布连续性复核中确认的画面可见状态");
  });

  it("P19 一致性横幅在 workbench 之外且不受 loadState.control 门控（首载/降级均可见），store 默认请求评估", async () => {
    const relative = "src/renderer/src/components/StudioContinuityReviewView.vue";
    const source = await readFile(path.join(process.cwd(), relative), "utf8");
    expect(source).toContain('data-testid="consistency-banner"');
    const bannerAt = source.indexOf('data-testid="consistency-banner"');
    const controlGateAt = source.indexOf('<template v-if="loadState.control">');
    const workbenchAt = source.indexOf('v-if="reviewPairAvailable"');
    expect(bannerAt).toBeGreaterThan(-1);
    expect(controlGateAt).toBeGreaterThan(-1);
    expect(workbenchAt).toBeGreaterThan(-1);
    // 盲审 R3-F6：横幅必须位于 loadState.control 门控之外，首载（control 为 null 的评估窗口）与降级分支均可见。
    expect(bannerAt).toBeLessThan(controlGateAt);
    expect(bannerAt).toBeLessThan(workbenchAt);
    // 横幅必须出现"辅助参考，不替代人工审片"定位声明与结构硬锁人工核对出口。
    expect(source).toContain("辅助参考，不替代人工审片");
    expect(source).toContain("人工核对：");
    // 盲审 R3-F1：评估期间必须有进行中态；用户文案不得含技术黑话瞬态/stale 英文。
    expect(source).toContain("机器一致性：评估中（约几秒，最长 15 秒）…");
    expect(source).not.toContain("评估瞬态失败");
    const store = await readFile(path.join(process.cwd(), "src/renderer/src/studio-continuity-review-store.ts"), "utf8");
    expect(store).toContain("evaluateConsistency: true");
  });
});

describe("P22 批注对比与返工 UI 合同", () => {
  it("批注工具/草稿/七类分类/四模式/擦除/差分回退/双向锚点齐备，全画面占位已移除", async () => {
    const view = await readFile(path.join(process.cwd(), "src/renderer/src/components/StudioContinuityReviewView.vue"), "utf8");
    // 双向锚点：旧全画面占位字面量不再存在；提交引用草稿集合。
    expect(view).not.toContain("annotations: [{ x: 0, y: 0, width: 1, height: 1, note }]");
    expect(view).toContain("draftAnnotations");
    expect(view).toContain("assignUniqueAnnotationIds");
    // 位置不漂锚点：归一化 * 100 渲染 + % 定位。
    expect(view).toContain("ann.x * 100");
    expect(view).toContain("left: `${wipePercent}%`");
    // 七类分类标签。
    expect(view).toContain("STUDIO_REVIEW_ANNOTATION_CATEGORY_LABELS");
    // 四模式控件与差分回退。
    expect(view).toContain("review-compare-modes");
    expect(view).toContain("wipePercent");
    expect(view).toContain("clipPath");
    expect(view).toContain("当前环境不支持差分预检");
    expect(view).toContain("readStudioMediaBytes");
    expect(view).toContain("composeAbsDifference");
    // 返工引导与移除修正入口。
    expect(view).toContain("review-rework-guidance");
    expect(view).toContain("removeHeadAnnotation");
    expect(view).toContain("移除批注");
    // 历史回显置灰 class 绑定。
    expect(view).toContain("history-annotations");
    expect(view).toContain("ann.tone");
  });

  it("对比纯函数模块：|A−B| 自定语义、id 派生、七类标签、IPC 通道与 main 门禁", async () => {
    const compare = await readFile(path.join(process.cwd(), "src/renderer/src/studio-review-compare.ts"), "utf8");
    expect(compare).toContain("composeAbsDifference");
    expect(compare).toContain("Math.abs");
    expect(compare).toContain("deriveAnnotationId");
    expect(compare).toContain("assignUniqueAnnotationIds");
    expect(compare).toContain("golden-mask");
    expect(compare).toContain("wipeDividerPercent");
    const main = await readFile(path.join(process.cwd(), "src/main/index.ts"), "utf8");
    expect(main).toContain("canvas:read-studio-media-bytes");
    expect(main).toContain("16 * 1024 * 1024");
    const preload = await readFile(path.join(process.cwd(), "src/preload/index.ts"), "utf8");
    expect(preload).toContain("readStudioMediaBytes");
  });
});

describe("P22 REMEDIATING 新增守卫 UI 合同锚点", () => {
  it("草稿完整性守卫/切宫格清理/差分护栏/键盘可达/监听清理/overlay computed 均有锚点", async () => {
    const view = await readFile(path.join(process.cwd(), "src/renderer/src/components/StudioContinuityReviewView.vue"), "utf8");
    expect(view).toContain("incompleteDraftCount");
    expect(view).toContain("不会静默丢弃");
    expect(view).toContain("draft-incomplete-hint");
    expect(view).toContain("MAX_DIFFERENCE_LONG_EDGE");
    expect(view).toContain("review-decode-loaders");
    expect(view).toContain("differenceRequestSequence");
    expect(view).toContain("rawBitmap?.close()");
    expect(view).toContain("labeledBitmap?.close()");
    expect(view).toContain("criteria: buildReviewCriteria(review.decision, categorizedRemaining, review.note)");
    expect(view).toContain("aria-valuenow");
    expect(view).toContain("onWipeDividerKeydown");
    expect(view).toContain("registerPointerCleanup");
    expect(view).toContain("releasePointerCleanups");
    expect(view).toContain("overlayComputed");
    // R3-F1 清理点
    expect(view).toContain("draftAnnotations.value = []");
    expect(view).toContain("reworkGuidance.value = \"\"");
  });
});

describe("连续性审查网格视口剔除", () => {
  it("history/timeline/conflict/batch 卡片使用 content-visibility，离屏条目跳过同步布局", async () => {
    const view = await readFile(path.join(process.cwd(), "src/renderer/src/components/StudioContinuityReviewView.vue"), "utf8");
    expect(view).toContain(".continuity-review{min-height:0;height:100%;overflow:auto;background:var(--ui-surface);color:var(--ui-text)}");
    expect(view).toContain(".history-list article{padding:11px;background:var(--ui-surface);content-visibility:auto;contain-intrinsic-size:auto 56px}");
    expect(view).toContain(".timeline-list>div{position:relative;padding:9px 10px;background:var(--ui-surface);content-visibility:auto;contain-intrinsic-size:auto 40px}");
    expect(view).toContain(".conflict-section article{display:grid;grid-template-columns:minmax(180px,1fr) 1fr minmax(180px,1fr);gap:12px;padding:10px 13px;border-top:1px solid var(--ui-line);content-visibility:auto;contain-intrinsic-size:auto 56px}");
    expect(view).toContain(".batch-grid article{padding:11px;background:var(--ui-surface);content-visibility:auto;contain-intrinsic-size:auto 56px}");
    expect(view).not.toMatch(/\.history-list article\{[^}]*content-visibility:hidden/);
    expect(view).not.toMatch(/\.opaque-correction-list article\{[^}]*content-visibility/);
  });

  it("asset-control 使用 content-visibility，离屏资产卡跳过同步布局", async () => {
    const view = await readFile(path.join(process.cwd(), "src/renderer/src/components/StudioContinuityReviewView.vue"), "utf8");
    expect(view).toContain(".asset-control{margin:12px;border-left:3px solid var(--ui-danger);background:var(--ui-surface);content-visibility:auto;contain-intrinsic-size:auto 160px}");
    expect(view).toContain(".asset-control.ready{border-left-color:var(--ui-ok)}");
    expect(view).toContain(".field-grid{display:grid;grid-template-columns:repeat(9,minmax(72px,1fr));border-bottom:1px solid var(--ui-line)}");
    expect(view).toContain(".conflict-section article{display:grid;grid-template-columns:minmax(180px,1fr) 1fr minmax(180px,1fr);gap:12px;padding:10px 13px;border-top:1px solid var(--ui-line);content-visibility:auto;contain-intrinsic-size:auto 56px}");
    expect(view).toContain(".batch-grid article{padding:11px;background:var(--ui-surface);content-visibility:auto;contain-intrinsic-size:auto 56px}");
    expect(view).not.toMatch(/\.asset-control\{[^}]*content-visibility:\s*hidden/);
    expect(view).not.toMatch(/\.asset-control\.ready\{[^}]*content-visibility/);
    expect(view).not.toMatch(/\.field-grid>div\{[^}]*content-visibility/);
    expect(view).not.toMatch(/\.opaque-correction-list article\{[^}]*content-visibility/);
  });

  it("handoff-grid 格使用 content-visibility，离屏交接项跳过同步布局", async () => {
    const view = await readFile(path.join(process.cwd(), "src/renderer/src/components/StudioContinuityReviewView.vue"), "utf8");
    expect(view).toContain(".handoff-grid>div{min-width:0;padding:9px 10px;background:var(--ui-surface);content-visibility:auto;contain-intrinsic-size:auto 40px}");
    expect(view).toContain(".asset-control{margin:12px;border-left:3px solid var(--ui-danger);background:var(--ui-surface);content-visibility:auto;contain-intrinsic-size:auto 160px}");
    expect(view).toContain(".conflict-section article{display:grid;grid-template-columns:minmax(180px,1fr) 1fr minmax(180px,1fr);gap:12px;padding:10px 13px;border-top:1px solid var(--ui-line);content-visibility:auto;contain-intrinsic-size:auto 56px}");
    expect(view).toContain(".batch-grid article{padding:11px;background:var(--ui-surface);content-visibility:auto;contain-intrinsic-size:auto 56px}");
    expect(view).toContain(".handoff-note{margin:0;padding:10px 14px;border-bottom:1px solid var(--ui-line);color:var(--ui-text-3);font-size:9px;line-height:1.6}");
    expect(view).not.toMatch(/\.handoff-grid>div\{[^}]*content-visibility:\s*hidden/);
    expect(view).not.toMatch(/\.handoff-note\{[^}]*content-visibility/);
    expect(view).not.toMatch(/\.handoff-grid \.usable b\{[^}]*content-visibility/);
    expect(view).not.toMatch(/\.field-grid>div\{[^}]*content-visibility/);
    expect(view).not.toMatch(/\.opaque-correction-list article\{[^}]*content-visibility/);
  });
});
