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
  });

  it("session-snapshot / 生成控制 / 审片从冻结提示词露前镜，不读 head", () => {
    const snapshot = readFileSync(path.join(repoRoot, "src/core/studio-generation-session-snapshot.ts"), "utf8");
    expect(snapshot).toContain("previousStandingFromFrozenRenderedPrompt(frozenPanel)");
    expect(snapshot).toContain('source: "frozen-rendered-prompt"');
    expect(snapshot).toContain("不读 unit head");
    expect(snapshot).not.toContain("getCurrentStudioPanelAssetBindingSet");
    expect(snapshot).not.toContain("evaluateStudioConsistency");
    const mcp = readFileSync(path.join(repoRoot, "src/mcp/server.ts"), "utf8");
    expect(mcp).toContain("previousStanding");
    expect(mcp).toContain("只从该包 renderedPrompt 还原");
    const control = readFileSync(path.join(repoRoot, "src/renderer/src/components/StudioGenerationControlView.vue"), "utf8");
    expect(control).toContain('data-testid="studio-pack-previous-standing"');
    expect(control).toContain("previousStandingFromAnyFrozenPack(pack, selectedPanelId.value)");
    expect(control).toContain("formatPreviousStandingReadonlyLine");
    expect(control).not.toContain("evaluateStudioConsistency");
    expect(control).not.toContain("getStudioBindingControl");
    const review = readFileSync(path.join(repoRoot, "src/renderer/src/components/StudioContinuityReviewView.vue"), "utf8");
    expect(review).toContain('data-testid="studio-review-previous-standing"');
    expect(review).toContain("previousStandingFromAnyFrozenPack(pack, reviewStandingPanelId.value)");
    expect(review).toContain("focus?.packId");
    expect(review).not.toContain("evaluateStudioConsistency(");
    expect(review).not.toContain("getStudioBindingControl");
    expect(review).not.toContain("generation.packId");
  });
});
