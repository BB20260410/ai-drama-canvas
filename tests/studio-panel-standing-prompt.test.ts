import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  formatPreviousStandingPromptLine,
  formatPreviousStandingReadonlyLine,
  parsePreviousStandingFromRenderedPrompt,
  pickPreviousPanelStanding,
  previousStandingFromAnyFrozenPack,
  previousStandingFromFrozenRenderedPrompt,
  previousStandingsFromFrozenPanelPacks,
  formatUnitLockPreviousStandingLine,
  wizardPreviousStandingForPanel,
  formatWizardPromptBody,
  formatWizardLightingPromptLine,
  formatWizardCostumePromptLine,
  formatWizardLockPreviousLightingLine,
  formatWizardLockPreviousCostumeLine,
  wizardPreviousLightingForPanel,
  wizardPreviousCostumeForPanel,
  parseFrozenPanelLightingFromRenderedPrompt,
  parseFrozenPanelCostumeFromRenderedPrompt,
  frozenPanelLightingFromAnyFrozenPack,
  frozenPanelCostumeFromAnyFrozenPack,
  formatFrozenPanelLightingReadonlyLine,
  formatFrozenPanelCostumeReadonlyLine,
} from "../src/core/studio-panel-standing.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("前镜站位写入冻结提示词（纯函数）", () => {
  it("pickPreviousPanelStanding 取同单元上一格，首格为 null", () => {
    const panels = [
      { index: 1, id: "p1", shotComposition: "中景", visualAction: "站定", filmingMethod: "固定" },
      { index: 2, id: "p2", shotComposition: "近景", visualAction: "抬手", filmingMethod: "推" },
    ];
    expect(pickPreviousPanelStanding(panels, 1)).toBeNull();
    expect(pickPreviousPanelStanding(panels, 2)).toEqual({
      panelIndex: 1,
      panelId: "p1",
      shotComposition: "中景",
      visualAction: "站定",
      filmingMethod: "固定",
    });
    expect(pickPreviousPanelStanding(panels, Number.NaN)).toBeNull();
  });

  it("formatPreviousStandingPromptLine 首格不写行，后续格强制连续起拍", () => {
    expect(formatPreviousStandingPromptLine(null)).toBeNull();
    expect(formatPreviousStandingPromptLine({
      panelIndex: 1,
      panelId: "p1",
      shotComposition: "中景",
      visualAction: "站定",
      filmingMethod: "固定",
    })).toBe("前镜交接：G1 中景 · 站定 · 固定。本格必须从该站位连续起拍，禁止重起镜、镜像或改空间布局。");
  });

  it("parsePreviousStandingFromRenderedPrompt 只认冻结行，不读 head", () => {
    const line = formatPreviousStandingPromptLine({
      panelIndex: 1,
      panelId: "p1",
      shotComposition: "中景",
      visualAction: "站定",
      filmingMethod: "固定",
    });
    expect(parsePreviousStandingFromRenderedPrompt("只生成一张 9:16 竖屏")).toBeNull();
    expect(parsePreviousStandingFromRenderedPrompt(`头\n${line}\n尾`)).toEqual({
      panelIndex: 1,
      panelId: "",
      shotComposition: "中景",
      visualAction: "站定",
      filmingMethod: "固定",
    });
  });

  it("单镜冻结与 unit-grid 提示词接入前镜行；brief 不改已冻结 renderedPrompt", () => {
    const generation = readFileSync(path.join(repoRoot, "src/core/studio-generation.ts"), "utf8");
    expect(generation).toContain("pickPreviousPanelStanding(snapshot.panels, panel.index)");
    expect(generation).toContain("formatPreviousStandingPromptLine(input.previousStanding)");
    expect(generation).toContain("previousStanding: parsePreviousStandingFromRenderedPrompt");
    expect(generation).toContain("若 previousStanding 或 renderedPrompt 含「前镜交接」");
    expect(generation).not.toContain("前镜交接：首格无前镜");
    expect(generation).toContain("光线（宫格覆盖）：${input.panel.sceneLighting}");
    expect(generation).not.toContain("前镜光线");
    const unitGrid = readFileSync(path.join(repoRoot, "src/core/studio-unit-grid-generation.ts"), "utf8");
    expect(unitGrid).toContain("formatPreviousStandingPromptLine");
    expect(unitGrid).toContain("第${offset + 1}格${previousLine}");
    const brief = readFileSync(path.join(repoRoot, "src/core/unit-grid-brief-contract.ts"), "utf8");
    expect(brief).toContain("previousStanding");
    expect(brief).toContain("不改 renderedPrompt");
  });

  it("previousStandingFromAnyFrozenPack 只认该包提示词，unit-grid 不猜第一格", () => {
    const line = formatPreviousStandingPromptLine({
      panelIndex: 1,
      panelId: "p1",
      shotComposition: "中景",
      visualAction: "站定",
      filmingMethod: "固定",
    });
    const parsed = {
      panelIndex: 1,
      panelId: "",
      shotComposition: "中景",
      visualAction: "站定",
      filmingMethod: "固定",
    };
    expect(previousStandingFromFrozenRenderedPrompt({
      request: { modelPayload: { renderedPrompt: `头\n${line}\n尾` } },
    })).toEqual(parsed);
    expect(previousStandingFromFrozenRenderedPrompt({
      request: { modelPayload: { renderedPrompt: "只生成一张 9:16 竖屏" } },
    })).toBeNull();
    expect(previousStandingFromAnyFrozenPack({
      schemaVersion: 5,
      panels: [{
        panelId: "p2",
        panelPack: { request: { modelPayload: { renderedPrompt: `头\n${line}\n尾` } } },
      }],
    })).toBeNull();
    expect(previousStandingFromAnyFrozenPack({
      schemaVersion: 5,
      panels: [{
        panelId: "p2",
        panelPack: { request: { modelPayload: { renderedPrompt: `头\n${line}\n尾` } } },
      }],
    }, "p2")).toEqual(parsed);
    expect(formatPreviousStandingReadonlyLine(parsed)).toContain("不是 BindingSet");
    expect(formatPreviousStandingReadonlyLine(null)).toBeNull();
    expect(formatUnitLockPreviousStandingLine(parsed)).toContain("不能当 generation-ready");
    expect(formatUnitLockPreviousStandingLine(null)).toBeNull();
    expect(previousStandingsFromFrozenPanelPacks([
      { target: { panelId: "p1" }, request: { modelPayload: { renderedPrompt: "只生成一张" } } },
      { target: { panelId: "p2" }, request: { modelPayload: { renderedPrompt: `头\n${line}\n尾` } } },
    ])).toEqual([{
      panelId: "p2",
      previousStanding: { ...parsed, source: "frozen-rendered-prompt" },
    }]);
    expect(previousStandingsFromFrozenPanelPacks([
      { target: { panelId: "p1" }, request: { modelPayload: { renderedPrompt: "只生成一张" } } },
    ])).toEqual([]);
    expect(wizardPreviousStandingForPanel([
      { panelIndex: 1, shotComposition: "中景", visualAction: "站定", filmingMethod: "固定" },
      { panelIndex: 2, shotComposition: "近景", visualAction: "抬手", filmingMethod: "推" },
    ], 1)).toBeNull();
    expect(formatWizardPromptBody([
      { panelIndex: 1, shotType: "original", startSeconds: 0, endSeconds: 5, title: "G1", visualAction: "站定", shotComposition: "中景", filmingMethod: "固定" },
      { panelIndex: 2, shotType: "original", startSeconds: 5, endSeconds: 10, title: "G2", visualAction: "抬手", shotComposition: "近景", filmingMethod: "推" },
    ])).toContain("前镜交接：G1 中景 · 站定 · 固定");
    const emptyContinuity = formatWizardPromptBody([
      { panelIndex: 1, shotType: "original", startSeconds: 0, endSeconds: 5, title: "G1", visualAction: "站定", shotComposition: "中景", filmingMethod: "固定" },
      { panelIndex: 2, shotType: "original", startSeconds: 5, endSeconds: 10, title: "G2", visualAction: "抬手", shotComposition: "近景", filmingMethod: "推" },
    ]);
    expect(emptyContinuity).not.toContain("光线：");
    expect(emptyContinuity).not.toContain("服化：");
    expect(formatWizardLightingPromptLine("")).toBeNull();
    expect(formatWizardCostumePromptLine("  ")).toBeNull();
    expect(formatWizardLightingPromptLine("室内火光")).toBe("光线：室内火光");
    expect(formatWizardCostumePromptLine("深灰祭服")).toBe("服化：深灰祭服");
    const withContinuity = formatWizardPromptBody([
      { panelIndex: 1, shotType: "original", startSeconds: 0, endSeconds: 5, title: "G1", visualAction: "站定", shotComposition: "中景", filmingMethod: "固定", sceneLighting: "室内火光", costumeState: "深灰祭服" },
      { panelIndex: 2, shotType: "original", startSeconds: 5, endSeconds: 10, title: "G2", visualAction: "抬手", shotComposition: "近景", filmingMethod: "推" },
    ]);
    expect(withContinuity).toContain("G1 original 0-5s G1: 站定\n光线：室内火光\n服化：深灰祭服");
    expect(withContinuity).toContain("前镜交接：G1 中景 · 站定 · 固定");
    expect(withContinuity).not.toMatch(/G2[\s\S]*光线：室内火光/u);
    expect(wizardPreviousLightingForPanel([
      { panelIndex: 1, sceneLighting: "室内火光" },
      { panelIndex: 2, sceneLighting: "" },
    ], 1)).toBeNull();
    expect(wizardPreviousLightingForPanel([
      { panelIndex: 1, sceneLighting: "室内火光" },
      { panelIndex: 2, sceneLighting: "" },
    ], 2)).toEqual({ panelIndex: 1, sceneLighting: "室内火光" });
    expect(wizardPreviousCostumeForPanel([
      { panelIndex: 1, costumeState: "深灰祭服" },
      { panelIndex: 2, costumeState: "" },
    ], 2)).toEqual({ panelIndex: 1, costumeState: "深灰祭服" });
    expect(formatWizardLockPreviousLightingLine({ panelIndex: 1, sceneLighting: "室内火光" })).toContain("不能当 generation-ready");
    expect(formatWizardLockPreviousCostumeLine({ panelIndex: 1, costumeState: "深灰祭服" })).toContain("不是 BindingSet");
    expect(formatWizardLockPreviousLightingLine(null)).toBeNull();
    expect(parseFrozenPanelLightingFromRenderedPrompt("只生成一张 9:16 竖屏")).toBeNull();
    expect(parseFrozenPanelLightingFromRenderedPrompt("光线（宫格覆盖）：室内火光\n尾")).toBe("室内火光");
    expect(parseFrozenPanelCostumeFromRenderedPrompt("服装（宫格覆盖）：深灰祭服")).toBe("深灰祭服");
    expect(frozenPanelLightingFromAnyFrozenPack({
      request: { modelPayload: { renderedPrompt: "光线（宫格覆盖）：室内火光" } },
    })).toBe("室内火光");
    expect(frozenPanelLightingFromAnyFrozenPack({
      schemaVersion: 5,
      panels: [{
        panelId: "p2",
        panelPack: { request: { modelPayload: { renderedPrompt: "光线（宫格覆盖）：室内火光" } } },
      }],
    })).toBeNull();
    expect(frozenPanelCostumeFromAnyFrozenPack({
      schemaVersion: 5,
      panels: [{
        panelId: "p2",
        panelPack: { request: { modelPayload: { renderedPrompt: "服装（宫格覆盖）：深灰祭服" } } },
      }],
    }, "p2")).toBe("深灰祭服");
    expect(formatFrozenPanelLightingReadonlyLine("室内火光")).toContain("不是 BindingSet");
    expect(formatFrozenPanelCostumeReadonlyLine("")).toBeNull();
  });

  it("session-snapshot / 生成控制 / 审片从冻结提示词露前镜，不读 head", () => {
    const snapshot = readFileSync(path.join(repoRoot, "src/core/studio-generation-session-snapshot.ts"), "utf8");
    expect(snapshot).toContain("previousStandingFromFrozenRenderedPrompt(frozenPanel)");
    expect(snapshot).toContain("parseFrozenPanelLightingFromRenderedPrompt");
    expect(snapshot).toContain("parseFrozenPanelCostumeFromRenderedPrompt");
    expect(snapshot).toContain("frozenPanelLighting");
    expect(snapshot).toContain("frozenPanelCostume");
    expect(snapshot).toContain('source: "frozen-rendered-prompt"');
    expect(snapshot).toContain("不读 unit head");
    expect(snapshot).not.toContain("getCurrentStudioPanelAssetBindingSet");
    expect(snapshot).not.toContain("evaluateStudioConsistency");
    const mcp = readFileSync(path.join(repoRoot, "src/mcp/server.ts"), "utf8");
    expect(mcp).toContain("previousStanding");
    expect(mcp).toContain("只从该包 renderedPrompt 还原");
    const control = readFileSync(path.join(repoRoot, "src/renderer/src/components/StudioGenerationControlView.vue"), "utf8");
    expect(control).toContain('data-testid="studio-pack-previous-standing"');
    expect(control).toContain('data-testid="studio-pack-lighting"');
    expect(control).toContain('data-testid="studio-pack-costume"');
    expect(control).toContain("previousStandingFromAnyFrozenPack(pack, selectedPanelId.value)");
    expect(control).toContain("frozenPanelLightingFromAnyFrozenPack(pack, selectedPanelId.value)");
    expect(control).toContain("formatPreviousStandingReadonlyLine");
    expect(control).not.toContain("evaluateStudioConsistency");
    expect(control).not.toContain("getStudioBindingControl");
    const review = readFileSync(path.join(repoRoot, "src/renderer/src/components/StudioContinuityReviewView.vue"), "utf8");
    expect(review).toContain('data-testid="studio-review-previous-standing"');
    expect(review).toContain('data-testid="studio-review-lighting-costume"');
    expect(review).toContain("previousStandingFromAnyFrozenPack(pack, reviewStandingPanelId.value)");
    expect(review).toContain("frozenPanelLightingFromAnyFrozenPack(pack, reviewStandingPanelId.value)");
    expect(review).toContain("focus?.packId");
    expect(review).not.toContain("evaluateStudioConsistency(");
    expect(review).not.toContain("getStudioBindingControl");
    expect(review).not.toContain("generation.packId");
    const wizard = readFileSync(path.join(repoRoot, "src/core/studio-storyboard-wizard.ts"), "utf8");
    expect(wizard).toContain("formatWizardPromptBody(input.panels)");
    expect(wizard).toContain("G2+ 必须从上一格站位连续起拍");
    expect(wizard).toContain("上一格光线/服化只作锁版提示");
    const app = readFileSync(path.join(repoRoot, "src/renderer/src/App.vue"), "utf8");
    expect(app).toContain("formatWizardPromptBody(input.panels)");
    expect(app).not.toContain("evaluateStudioConsistency(");
    const wizardView = readFileSync(path.join(repoRoot, "src/renderer/src/components/ScriptMediaAlignView.vue"), "utf8");
    expect(wizardView).toContain('data-testid="storyboard-wizard-previous-standing"');
    expect(wizardView).toContain('data-testid="storyboard-wizard-lighting"');
    expect(wizardView).toContain('data-testid="storyboard-wizard-costume"');
    expect(wizardView).toContain('data-testid="storyboard-wizard-previous-lighting"');
    expect(wizardView).toContain('data-testid="storyboard-wizard-previous-costume"');
    expect(wizardView).toContain("wizardLightingLine");
    expect(wizardView).toContain("wizardCostumeLine");
    expect(wizardView).toContain("formatWizardLockPreviousLightingLine");
    expect(wizardView).not.toContain("evaluateStudioConsistency(");
    expect(wizardView).toContain("wizardStandingLine");
    expect(wizardView).toContain("formatUnitLockPreviousStandingLine");
    const brief = readFileSync(path.join(repoRoot, "src/core/codex.ts"), "utf8");
    expect(brief).toContain("previousStandings");
    expect(brief).toContain("previousStandingFromFrozenRenderedPrompt(panel.panelPack)");
    expect(brief).toContain("UNIT_GRID_PREVIOUS_STANDING_TOOL_NOTE");
    const canvas = readFileSync(path.join(repoRoot, "src/renderer/src/components/ManagedStudioCanvasView.vue"), "utf8");
    expect(canvas).toContain("previousStandingFromAnyFrozenPack(pack, panel.id)");
    expect(canvas).toContain("frozenPanelLightingFromAnyFrozenPack(pack, panel.id)");
    expect(canvas).toContain("formatFrozenPanelLightingReadonlyLine");
    expect(canvas).toContain("formatUnitLockPreviousStandingLine");
    expect(canvas).toContain("frozen-rendered-prompt");
    expect(canvas).toContain("getStudioTrace");
    expect(canvas).toContain("resolveStudioTraceSelector");
    expect(canvas).toContain("禁止猜第一格");
    expect(canvas).not.toContain('action.kind === "open-trace" || action.kind === "open-consistency"');
    expect(canvas).not.toContain("evaluateStudioConsistency(");
    expect(canvas).not.toContain("getStudioBindingControl");
    const trace = readFileSync(path.join(repoRoot, "src/core/studio-trace.ts"), "utf8");
    expect(trace).toContain("previousStandingsFromFrozenPanelPacks(panelPacks)");
    expect(trace).toContain("previousStandings.length > 0 ? { previousStandings }");
    expect(trace).toContain("不读 unit head");
    expect(trace).not.toContain("getCurrentStudioPanelAssetBindingSet");
    const mcpTrace = readFileSync(path.join(repoRoot, "src/mcp/server.ts"), "utf8");
    expect(mcpTrace).toContain("previousStandings");
    expect(mcpTrace).toContain("无该行则省略");
  });
});
