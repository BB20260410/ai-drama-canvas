import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ScriptMediaAlignRow } from "../src/core/studio-script-media-align.js";
import {
  buildSsl5PlanFromBoard,
  composeSsl5GenerationPlanDraft,
  earliestBlockingPath,
  refineSsl5FocusIfEarliestBlocking,
  refineSsl5FocusIfCheckpointBlocking,
  refineSsl5FocusPlanDraftIfPersisted,
  SSL5_GENERATION_PLAN_COMMAND,
  SSL5_PLAN_SCHEMA_VERSION,
} from "../src/core/studio-ssl5-missing-to-gen.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = (relative: string) => readFileSync(path.join(root, relative), "utf8");

function panel(partial: Partial<ScriptMediaAlignRow["panels"][number]> & Pick<ScriptMediaAlignRow["panels"][number], "panelId" | "panelIndex" | "hasMedia">): ScriptMediaAlignRow["panels"][number] {
  return {
    title: partial.title ?? partial.panelId,
    sourceSpans: [],
    packId: null,
    packFingerprint: null,
    rawSha256: partial.hasMedia ? "raw" : null,
    labeledSha256: null,
    generationRunId: null,
    shotComposition: "",
    visualAction: "",
    filmingMethod: "",
    sceneLighting: "",
    costumeState: "",
    shotType: "",
    assetMentions: [],
    previousHandoff: null,
    consistencyPeek: { status: "unevaluated" },
    ...partial,
  };
}

function row(partial: Partial<ScriptMediaAlignRow> & Pick<ScriptMediaAlignRow, "unitId" | "sequence" | "status">): ScriptMediaAlignRow {
  return {
    title: partial.title ?? partial.unitId,
    formalCommitted: false,
    isEarliest: false,
    reviewDecision: null,
    scriptRevisionId: null,
    panelCount: 4,
    coveredPanelCount: partial.status === "covered" ? 4 : partial.status === "partial" ? 2 : 0,
    missingPanelCount: partial.status === "covered" ? 0 : 2,
    rawSha256: null,
    labeledSha256: null,
    packId: null,
    packFingerprint: null,
    generationRunId: null,
    trace: { byPack: null, byRun: null },
    sourceSpans: [],
    outlineAnchors: [],
    consistencyPeek: { status: "unevaluated" },
    panels: [],
    ...partial,
  };
}

describe("SSL-5 缺图下一步纯函数", () => {
  it("earliest 覆盖行仍是焦点，covered 非 earliest 不进 items", () => {
    const plan = buildSsl5PlanFromBoard(
      "/tmp/iso",
      { season: "S1", episode: "E2" },
      {
        earliestUnitId: "u-early",
        missingAllCount: 1,
        partialCount: 1,
        rows: [
          row({ unitId: "u-covered", sequence: 1, status: "covered" }),
          row({ unitId: "u-early", sequence: 2, status: "covered", isEarliest: true }),
          row({
            unitId: "u-missing",
            sequence: 3,
            status: "missing-all",
            panels: [panel({ panelId: "p2", panelIndex: 2, hasMedia: false }), panel({ panelId: "p1", panelIndex: 1, hasMedia: false })],
          }),
          row({ unitId: "u-partial", sequence: 4, status: "partial" }),
        ],
      },
      "2026-08-26T17:40:00.000Z",
    );
    expect(plan.schemaVersion).toBe(SSL5_PLAN_SCHEMA_VERSION);
    expect(plan.kind).toBe("studio-ssl5-missing-to-gen-plan");
    expect(plan.focusUnitId).toBe("u-early");
    expect(plan.focusPanelId).toBeNull();
    expect(plan.items.find((item) => item.unitId === "u-missing")?.focusPanelId).toBe("p1");
    expect(plan.items.find((item) => item.unitId === "u-missing")?.focusPanelIndex).toBe(1);
    expect(plan.items.map((item) => item.unitId)).toEqual(["u-early", "u-missing", "u-partial"]);
    expect(plan.lightingCostumeLine).toBe("没有宫格可查光线/服化");
    expect(plan.previousLightingLine).toBeNull();
    expect(plan.previousCostumeLine).toBeNull();
    expect(plan.sceneBackReferences).toEqual([]);
    expect(plan.propBackReferenceLine).toBe("没有宫格可查道具回指");
    expect(plan.propBackReferences).toEqual([]);
    expect(plan.characterBackReferenceLine).toBe("没有宫格可查角色回指");
    expect(plan.characterBackReferences).toEqual([]);
    expect(plan.shotTypeLine).toBe("没有宫格可查镜头类型");
    expect(plan.styleLockLine).toBe("没有宫格可查风格锁");
    expect(plan.shotType).toBeUndefined();
    expect(plan.beatLine).toBe("没有宫格可查 15s 节拍");
    expect(plan.unitBeatLine).toBe("没有宫格可查 15s 节拍");
    expect(plan.items[0]?.lightingCostumeLine).toBe("没有宫格可查光线/服化");
    expect(plan.items[0]?.shotTypeLine).toBe("没有宫格可查镜头类型");
    expect(plan.items[0]?.styleLockLine).toBe("没有宫格可查风格锁");
    expect(plan.items[0]?.beatLine).toBe("没有宫格可查 15s 节拍");
    expect(plan.items[0]?.unitBeatLine).toBe("没有宫格可查 15s 节拍");
    expect(plan.items[0]?.recommendedPath).toEqual([
      "binding-ready?",
      "readiness",
      "freeze",
      "create-plan",
      "dispatch",
      "prepare",
      "gen",
      "commit",
      "review",
    ]);
    expect(plan.focusPackId).toBeNull();
    expect(plan.generationPlanDraft.ready).toBe(false);
    expect(plan.generationPlanDraft.dispatch).toBe(false);
    expect(plan.generationPlanDraft.command).toBe(SSL5_GENERATION_PLAN_COMMAND);
    expect(plan.generationPlanDraft.blockedReason).toBe("没有目标宫格，禁止猜第一格");
    expect(plan.generationPlanDraft.nodes).toBeNull();
  });

  it("create-plan 草稿只认缺图格自己的 pack，不用同行已出图 packId", () => {
    const plan = buildSsl5PlanFromBoard(
      "/tmp/iso",
      { season: "S1", episode: "E2" },
      {
        earliestUnitId: "u-partial",
        missingAllCount: 0,
        partialCount: 1,
        rows: [
          row({
            unitId: "u-partial",
            sequence: 1,
            status: "partial",
            isEarliest: true,
            packId: "preview-covered-pack",
            panels: [
              panel({ panelId: "p-covered", panelIndex: 1, hasMedia: true, packId: "preview-covered-pack" }),
              panel({ panelId: "p-missing", panelIndex: 2, hasMedia: false, packId: null }),
            ],
          }),
        ],
      },
    );
    expect(plan.schemaVersion).toBe(SSL5_PLAN_SCHEMA_VERSION);
    expect(plan.focusUnitId).toBe("u-partial");
    expect(plan.focusPanelId).toBe("p-missing");
    expect(plan.items[0]?.packId).toBe("preview-covered-pack");
    expect(plan.focusPackId).toBeNull();
    expect(plan.items[0]?.focusPackId).toBeNull();
    expect(plan.generationPlanDraft.ready).toBe(false);
    expect(plan.generationPlanDraft.nodes).toBeNull();
    expect(plan.generationPlanDraft.blockedReason).toContain("禁止用同行已出图宫格的 packId");
  });

  it("缺图格已有自己的冻结 pack 时草稿 ready，仍不派发", () => {
    const plan = buildSsl5PlanFromBoard(
      "/tmp/iso",
      { season: "S1", episode: "E2" },
      {
        earliestUnitId: "u-frozen",
        missingAllCount: 1,
        partialCount: 0,
        rows: [
          row({
            unitId: "u-frozen",
            sequence: 1,
            status: "missing-all",
            isEarliest: true,
            packId: null,
            panels: [
              panel({ panelId: "p-focus", panelIndex: 1, hasMedia: false, packId: "focus-own-pack" }),
            ],
          }),
        ],
      },
    );
    expect(plan.focusUnitId).toBe("u-frozen");
    expect(plan.focusPanelId).toBe("p-focus");
    expect(plan.focusPackId).toBe("focus-own-pack");
    expect(plan.generationPlanDraft).toEqual({
      command: SSL5_GENERATION_PLAN_COMMAND,
      ready: true,
      blockedReason: null,
      nodes: [{ unitId: "u-frozen", panelId: "p-focus" }],
      dispatch: false,
      note: "只起草建计划节点；不执行、不派发。派发须用计划推导 runId。",
    });
    expect(plan.items[0]?.generationPlanDraft.ready).toBe(true);
    const refined = refineSsl5FocusPlanDraftIfPersisted(plan, true);
    expect(refined.schemaVersion).toBe(SSL5_PLAN_SCHEMA_VERSION);
    expect(refined.generationPlanDraft.ready).toBe(false);
    expect(refined.generationPlanDraft.dispatch).toBe(false);
    expect(refined.generationPlanDraft.blockedReason).toContain("下一步是 dispatch");
    expect(refined.generationPlanDraft.nodes).toEqual([{ unitId: "u-frozen", panelId: "p-focus" }]);
    expect(refined.items[0]?.generationPlanDraft.ready).toBe(false);
    expect(refined.items[0]?.recommendedPath).toEqual(["dispatch", "prepare", "gen", "commit", "review"]);
    expect(refineSsl5FocusPlanDraftIfPersisted(plan, false).generationPlanDraft.ready).toBe(true);
    const failed = refineSsl5FocusPlanDraftIfPersisted(plan, { hasPlan: true, status: "failed" });
    expect(failed.generationPlanDraft.blockedReason).toContain("下一步是 retry");
    expect(failed.generationPlanDraft.dispatch).toBe(false);
    expect(failed.items[0]?.recommendedPath).toEqual(["retry"]);
    const waiting = refineSsl5FocusPlanDraftIfPersisted(plan, { hasPlan: true, status: "dispatched" });
    expect(waiting.generationPlanDraft.blockedReason).toContain("等待结果或对账");
    expect(waiting.items[0]?.recommendedPath).toEqual(["wait"]);
    const reviewed = refineSsl5FocusPlanDraftIfPersisted(plan, { hasPlan: true, status: "succeeded" });
    expect(reviewed.generationPlanDraft.blockedReason).toContain("下一步是 Review");
    expect(reviewed.items[0]?.recommendedPath).toEqual(["review"]);
  });

  it("earliest 在途/待重试/待审时焦点禁止再建议 create-plan/dispatch", () => {
    expect(earliestBlockingPath("wait-or-reconcile-unit-grid-run")).toBe("wait");
    expect(earliestBlockingPath("retry-unit-grid-plan-nodes")).toBe("retry");
    expect(earliestBlockingPath("submit-unit-grid-review")).toBe("review");
    expect(earliestBlockingPath("reconcile-unit-grid-call")).toBe("reconcile");
    expect(earliestBlockingPath("dispatch-unit-grid")).toBeNull();
    expect(earliestBlockingPath("create-unit-grid-plan")).toBeNull();
    expect(earliestBlockingPath("freeze-unit-grid")).toBeNull();

    const waiting = buildSsl5PlanFromBoard(
      "/tmp/iso",
      { season: "S1", episode: "E2" },
      {
        earliestUnitId: "u-frozen",
        earliestCode: "wait-or-reconcile-unit-grid-run",
        earliestLabel: "unit-grid 正在执行，等待结果或对账现有 run",
        missingAllCount: 1,
        partialCount: 0,
        rows: [
          row({
            unitId: "u-frozen",
            sequence: 1,
            status: "missing-all",
            isEarliest: true,
            panels: [
              panel({ panelId: "p-focus", panelIndex: 1, hasMedia: false, packId: "focus-own-pack" }),
            ],
          }),
        ],
      },
    );
    expect(waiting.schemaVersion).toBe(SSL5_PLAN_SCHEMA_VERSION);
    expect(waiting.earliestCode).toBe("wait-or-reconcile-unit-grid-run");
    expect(waiting.focusUnitId).toBe("u-frozen");
    expect(waiting.generationPlanDraft.ready).toBe(false);
    expect(waiting.generationPlanDraft.dispatch).toBe(false);
    expect(waiting.generationPlanDraft.blockedReason).toBe("unit-grid 正在执行，等待结果或对账现有 run");
    expect(waiting.generationPlanDraft.nodes).toEqual([{ unitId: "u-frozen", panelId: "p-focus" }]);
    expect(waiting.items[0]?.recommendedPath).toEqual(["wait"]);

    const retried = buildSsl5PlanFromBoard(
      "/tmp/iso",
      { season: "S1", episode: "E2" },
      {
        earliestUnitId: "u-frozen",
        earliestCode: "retry-unit-grid-plan-nodes",
        earliestLabel: "unit-grid 计划节点已失败/已取消，下一步 retry（不重试、不派发）",
        missingAllCount: 1,
        partialCount: 0,
        rows: [
          row({
            unitId: "u-frozen",
            sequence: 1,
            status: "missing-all",
            isEarliest: true,
            panels: [
              panel({ panelId: "p-focus", panelIndex: 1, hasMedia: false, packId: "focus-own-pack" }),
            ],
          }),
        ],
      },
    );
    expect(retried.generationPlanDraft.ready).toBe(false);
    expect(retried.items[0]?.recommendedPath).toEqual(["retry"]);
    expect(retried.generationPlanDraft.blockedReason).toContain("下一步 retry");

    const reviewedGrid = buildSsl5PlanFromBoard(
      "/tmp/iso",
      { season: "S1", episode: "E2" },
      {
        earliestUnitId: "u-frozen",
        earliestCode: "submit-unit-grid-review",
        earliestLabel: null,
        missingAllCount: 1,
        partialCount: 0,
        rows: [
          row({
            unitId: "u-frozen",
            sequence: 1,
            status: "missing-all",
            isEarliest: true,
            panels: [
              panel({ panelId: "p-focus", panelIndex: 1, hasMedia: false, packId: "focus-own-pack" }),
            ],
          }),
        ],
      },
    );
    expect(reviewedGrid.generationPlanDraft.ready).toBe(false);
    expect(reviewedGrid.items[0]?.recommendedPath).toEqual(["review"]);
    expect(reviewedGrid.generationPlanDraft.blockedReason).toContain("下一步是 Review");

    const dispatching = buildSsl5PlanFromBoard(
      "/tmp/iso",
      { season: "S1", episode: "E2" },
      {
        earliestUnitId: "u-frozen",
        earliestCode: "dispatch-unit-grid",
        earliestLabel: "派发 unit-grid 生图包",
        missingAllCount: 1,
        partialCount: 0,
        rows: [
          row({
            unitId: "u-frozen",
            sequence: 1,
            status: "missing-all",
            isEarliest: true,
            panels: [
              panel({ panelId: "p-focus", panelIndex: 1, hasMedia: false, packId: "focus-own-pack" }),
            ],
          }),
        ],
      },
    );
    expect(dispatching.generationPlanDraft.ready).toBe(true);
    expect(dispatching.items[0]?.recommendedPath).toContain("create-plan");
  });

  it("焦点不是 earliest 时不改 create-plan 草稿", () => {
    const plan = buildSsl5PlanFromBoard(
      "/tmp/iso",
      { season: "S1", episode: "E2" },
      {
        earliestUnitId: "u-early",
        earliestCode: "wait-or-reconcile-unit-grid-run",
        earliestLabel: "unit-grid 正在执行，等待结果或对账现有 run",
        missingAllCount: 1,
        partialCount: 0,
        rows: [
          row({
            unitId: "u-other",
            sequence: 2,
            status: "missing-all",
            panels: [
              panel({ panelId: "p-other", panelIndex: 1, hasMedia: false, packId: "other-pack" }),
            ],
          }),
        ],
      },
    );
    expect(plan.focusUnitId).toBe("u-other");
    expect(plan.earliestUnitId).toBe("u-early");
    expect(plan.generationPlanDraft.ready).toBe(true);
    expect(plan.generationPlanDraft.blockedReason).toBeNull();
    expect(plan.items[0]?.recommendedPath).toContain("create-plan");
    expect(refineSsl5FocusIfEarliestBlocking(plan).generationPlanDraft.ready).toBe(true);
  });

  it("单镜已有计划改标 dispatch 之后 earliest wait 仍赢", () => {
    const plan = buildSsl5PlanFromBoard(
      "/tmp/iso",
      { season: "S1", episode: "E2" },
      {
        earliestUnitId: "u-frozen",
        earliestCode: "wait-or-reconcile-unit-grid-run",
        earliestLabel: "unit-grid 正在执行，等待结果或对账现有 run",
        missingAllCount: 1,
        partialCount: 0,
        rows: [
          row({
            unitId: "u-frozen",
            sequence: 1,
            status: "missing-all",
            isEarliest: true,
            panels: [
              panel({ panelId: "p-focus", panelIndex: 1, hasMedia: false, packId: "focus-own-pack" }),
            ],
          }),
        ],
      },
    );
    expect(plan.generationPlanDraft.ready).toBe(false);
    expect(plan.items[0]?.recommendedPath).toEqual(["wait"]);
    const persisted = refineSsl5FocusPlanDraftIfPersisted(plan, { hasPlan: true, status: "planned" });
    expect(persisted.generationPlanDraft.blockedReason).toContain("下一步是 dispatch");
    expect(persisted.items[0]?.recommendedPath).toEqual(["dispatch", "prepare", "gen", "commit", "review"]);
    const again = refineSsl5FocusIfEarliestBlocking(persisted);
    expect(again.generationPlanDraft.ready).toBe(false);
    expect(again.generationPlanDraft.dispatch).toBe(false);
    expect(again.generationPlanDraft.blockedReason).toBe("unit-grid 正在执行，等待结果或对账现有 run");
    expect(again.generationPlanDraft.nodes).toEqual([{ unitId: "u-frozen", panelId: "p-focus" }]);
    expect(again.items[0]?.recommendedPath).toEqual(["wait"]);
  });

  it("composeSsl5GenerationPlanDraft 无焦点 / 无宫格失败关闭", () => {
    expect(composeSsl5GenerationPlanDraft({
      focusUnitId: null,
      focusPanelId: "p1",
      focusPackId: "pack-1",
    }).blockedReason).toBe("没有目标单元，不能建立计划");
    expect(composeSsl5GenerationPlanDraft({
      focusUnitId: "u1",
      focusPanelId: null,
      focusPackId: "pack-1",
    }).blockedReason).toBe("没有目标宫格，禁止猜第一格");
  });

  it("无 earliest 时焦点落在第一条 missing-all", () => {
    const plan = buildSsl5PlanFromBoard("/tmp/iso", { season: "S1", episode: "E2" }, {
      earliestUnitId: null,
      missingAllCount: 2,
      partialCount: 0,
      rows: [
        row({ unitId: "u-b", sequence: 20, status: "missing-all" }),
        row({ unitId: "u-a", sequence: 10, status: "missing-all" }),
      ],
    });
    expect(plan.focusUnitId).toBe("u-a");
    expect(plan.items[0]?.priority).toBe("missing-all");
  });

  it("无 earliest 的部分覆盖焦点落到第一张缺图宫格", () => {
    const plan = buildSsl5PlanFromBoard("/tmp/iso", { season: "S1", episode: "E2" }, {
      earliestUnitId: null,
      missingAllCount: 0,
      partialCount: 1,
      rows: [row({
        unitId: "u-partial",
        sequence: 1,
        status: "partial",
        panels: [
          panel({
            panelId: "p1",
            panelIndex: 1,
            hasMedia: true,
            shotComposition: "中景",
            visualAction: "站定",
            filmingMethod: "固定",
            sceneLighting: "窗侧冷光",
            costumeState: "素袍",
            startSeconds: 0,
            endSeconds: 7.5,
            durationSeconds: 7.5,
          }),
          panel({
            panelId: "p2",
            panelIndex: 2,
            hasMedia: false,
            sceneLighting: "近灯",
            costumeState: "加披风",
            shotType: "extension",
            startSeconds: 7.5,
            endSeconds: 15,
            durationSeconds: 7.5,
            previousHandoff: { panelIndex: 1, panelId: "p1", shotComposition: "中景", visualAction: "站定", filmingMethod: "固定" },
          }),
        ],
      })],
    });
    expect(plan.focusUnitId).toBe("u-partial");
    expect(plan.focusPanelId).toBe("p2");
    expect(plan.focusPanelIndex).toBe(2);
    expect(plan.previousPanelIndex).toBe(1);
    expect(plan.previousShotComposition).toBe("中景");
    expect(plan.previousVisualAction).toBe("站定");
    expect(plan.previousFilmingMethod).toBe("固定");
    expect(plan.standingGapLine).toContain("锁版站位缺口");
    expect(plan.standingGapLine).toContain("不是 BindingSet");
    expect(plan.lightingCostumeLine).toContain("锁版光线：G2 近灯");
    expect(plan.lightingCostumeLine).toContain("锁版服装：G2 加披风");
    expect(plan.lightingCostumeLine).toContain("不是 BindingSet");
    expect(plan.previousLightingLine).toContain("锁版前镜光线：G1 窗侧冷光");
    expect(plan.previousCostumeLine).toContain("锁版前镜服化：G1 素袍");
    expect(plan.items[0]?.lightingCostumeLine).toContain("锁版光线：G2 近灯");
    expect(plan.shotType).toBe("extension");
    expect(plan.shotTypeLine).toContain("扩写格：G2");
    expect(plan.shotTypeLine).toContain("禁止重新起镜");
    expect(plan.shotTypeLine).toContain("不是 BindingSet");
    expect(plan.items[0]?.shotTypeLine).toContain("扩写格：G2");
    expect(plan.styleLockLine).toBe("锁版未记风格控制参考。不是 BindingSet，不能当 generation-ready。");
    expect(plan.items[0]?.styleLockLine).toBe(plan.styleLockLine);
    expect(plan.beatLine).toContain("15s 节拍：G2 7.5–15s（7.5s）");
    expect(plan.beatLine).toContain("本单元须 2–6 格合计 15.0s");
    expect(plan.unitBeatLine).toContain("2 格合计 15.0s");
    expect(plan.items[0]?.beatLine).toBe(plan.beatLine);
    expect(plan.items[0]?.unitBeatLine).toBe(plan.unitBeatLine);
  });

  it("焦点宫格场景回指只扫已加载对照板，忽略更晚单元", () => {
    const plan = buildSsl5PlanFromBoard("/tmp/iso", { season: "S1", episode: "E2" }, {
      earliestUnitId: null,
      missingAllCount: 1,
      partialCount: 0,
      rows: [
        row({
          unitId: "u-early",
          sequence: 1,
          status: "covered",
          panels: [panel({
            panelId: "e1",
            panelIndex: 1,
            hasMedia: true,
            assetMentions: [
              { assetId: "scene-stone", category: "scene", role: "石室" },
              { assetId: "prop-mask", category: "prop", role: "黄金面具" },
              { assetId: "char-dou", category: "character", role: "豆姐" },
            ],
          })],
        }),
        row({
          unitId: "u-focus",
          sequence: 2,
          status: "missing-all",
          panels: [panel({
            panelId: "f1",
            panelIndex: 1,
            hasMedia: false,
            sceneLighting: "石室火塘",
            costumeState: "青布短打",
            shotType: "original",
            assetMentions: [
              { assetId: "scene-stone", category: "scene", role: "石室" },
              { assetId: "prop-mask", category: "prop", role: "黄金面具" },
              { assetId: "char-dou", category: "character", role: "豆姐" },
              { assetId: "style-cine", category: "style", role: "夜戏油彩" },
            ],
          })],
        }),
        row({
          unitId: "u-later",
          sequence: 3,
          status: "missing-all",
          panels: [panel({
            panelId: "l1",
            panelIndex: 1,
            hasMedia: false,
            assetMentions: [
              { assetId: "scene-stone", category: "scene", role: "石室" },
              { assetId: "prop-mask", category: "prop", role: "黄金面具" },
              { assetId: "char-dou", category: "character", role: "豆姐" },
            ],
          })],
        }),
      ],
    });
    expect(plan.focusUnitId).toBe("u-focus");
    expect(plan.sceneBackReferenceLine).toContain("U1 G1 石室");
    expect(plan.sceneBackReferenceLine).toContain("不是 BindingSet");
    expect(plan.sceneBackReferenceLine).not.toContain("U3");
    expect(plan.sceneBackReferences).toEqual([{
      assetId: "scene-stone",
      role: "石室",
      unitId: "u-early",
      sequence: 1,
      panelIndex: 1,
      panelId: "e1",
    }]);
    expect(plan.lightingCostumeLine).toContain("锁版光线：G1 石室火塘");
    expect(plan.lightingCostumeLine).toContain("锁版服装：G1 青布短打");
    expect(plan.previousLightingLine).toBeNull();
    expect(plan.previousCostumeLine).toBeNull();
    expect(plan.items.find((item) => item.unitId === "u-focus")?.sceneBackReferenceLine).toContain("U1 G1 石室");
    expect(plan.items.find((item) => item.unitId === "u-focus")?.sceneBackReferences).toEqual(plan.sceneBackReferences);
    expect(plan.propBackReferenceLine).toContain("U1 G1 黄金面具");
    expect(plan.propBackReferenceLine).toContain("不是 BindingSet");
    expect(plan.propBackReferenceLine).not.toContain("U3");
    expect(plan.propBackReferences).toEqual([{
      assetId: "prop-mask",
      role: "黄金面具",
      unitId: "u-early",
      sequence: 1,
      panelIndex: 1,
      panelId: "e1",
    }]);
    expect(plan.items.find((item) => item.unitId === "u-focus")?.propBackReferences).toEqual(plan.propBackReferences);
    expect(plan.characterBackReferenceLine).toContain("U1 G1 豆姐");
    expect(plan.characterBackReferenceLine).toContain("不是 BindingSet");
    expect(plan.characterBackReferenceLine).not.toContain("U3");
    expect(plan.characterBackReferences).toEqual([{
      assetId: "char-dou",
      role: "豆姐",
      unitId: "u-early",
      sequence: 1,
      panelIndex: 1,
      panelId: "e1",
    }]);
    expect(plan.items.find((item) => item.unitId === "u-focus")?.characterBackReferences).toEqual(plan.characterBackReferences);
    expect(plan.shotType).toBe("original");
    expect(plan.shotTypeLine).toContain("原镜：G1");
    expect(plan.shotTypeLine).toContain("必须锚定原文");
    expect(plan.items.find((item) => item.unitId === "u-focus")?.shotTypeLine).toBe(plan.shotTypeLine);
    expect(plan.styleLockLine).toContain("风格锁：style-cine 夜戏油彩");
    expect(plan.styleLockLine).toContain("禁止另起画风");
    expect(plan.items.find((item) => item.unitId === "u-focus")?.styleLockLine).toBe(plan.styleLockLine);
  });

  it("全 covered 且无 earliest 则无焦点", () => {
    const plan = buildSsl5PlanFromBoard("/tmp/iso", { season: "S1", episode: "E2" }, {
      earliestUnitId: null,
      missingAllCount: 0,
      partialCount: 0,
      rows: [row({ unitId: "u-ok", sequence: 1, status: "covered" })],
    });
    expect(plan.focusUnitId).toBeNull();
    expect(plan.focusPackId).toBeNull();
    expect(plan.generationPlanDraft.ready).toBe(false);
    expect(plan.generationPlanDraft.blockedReason).toBe("没有目标单元，不能建立计划");
    expect(plan.items).toEqual([]);
    expect(plan.lightingCostumeLine).toBe("没有宫格可查光线/服化");
    expect(plan.previousLightingLine).toBeNull();
    expect(plan.previousCostumeLine).toBeNull();
    expect(plan.sceneBackReferences).toEqual([]);
    expect(plan.propBackReferenceLine).toBe("没有宫格可查道具回指");
    expect(plan.propBackReferences).toEqual([]);
    expect(plan.characterBackReferenceLine).toBe("没有宫格可查角色回指");
    expect(plan.characterBackReferences).toEqual([]);
    expect(plan.shotTypeLine).toBe("没有宫格可查镜头类型");
    expect(plan.styleLockLine).toBe("没有宫格可查风格锁");
    expect(plan.beatLine).toBe("没有宫格可查 15s 节拍");
    expect(plan.unitBeatLine).toBe("没有宫格可查 15s 节拍");
    expect(plan.consistencyPeek).toEqual({ status: "unevaluated" });
    expect(plan.checkpoint).toBeNull();
    expect(plan.checkpointLine).toBe("对照板未投影六图闸");
    expect(plan.writeLease).toBeNull();
    expect(plan.writeLeaseLine).toBe("对照板未投影写租约");
  });

  it("六图闸未放行时禁止再建议 create-plan/dispatch，earliest wait 文案更具体时保留", () => {
    const blocked = buildSsl5PlanFromBoard("/tmp/iso", { season: "S1", episode: "E2" }, {
      earliestUnitId: "u-frozen",
      earliestCode: "dispatch-unit-grid",
      missingAllCount: 1,
      partialCount: 0,
      checkpoint: { newSlotDispatchAllowed: false, blockingBatchNumber: 2 },
      rows: [
        row({
          unitId: "u-frozen",
          sequence: 1,
          status: "missing-all",
          isEarliest: true,
          panels: [
            panel({ panelId: "p-focus", panelIndex: 1, hasMedia: false, packId: "focus-own-pack" }),
          ],
        }),
      ],
    });
    expect(blocked.generationPlanDraft.ready).toBe(false);
    expect(blocked.generationPlanDraft.dispatch).toBe(false);
    expect(blocked.generationPlanDraft.blockedReason).toContain("六图闸未放行（batch 2）");
    expect(blocked.items[0]?.recommendedPath).toEqual(["wait"]);
    expect(blocked.checkpointLine).toContain("batch 2");

    const other = buildSsl5PlanFromBoard("/tmp/iso", { season: "S1", episode: "E2" }, {
      earliestUnitId: "u-early",
      earliestCode: "dispatch-unit-grid",
      missingAllCount: 1,
      partialCount: 0,
      checkpoint: { newSlotDispatchAllowed: false, blockingBatchNumber: 4 },
      rows: [
        row({
          unitId: "u-other",
          sequence: 2,
          status: "missing-all",
          panels: [
            panel({ panelId: "p-other", panelIndex: 1, hasMedia: false, packId: "other-pack" }),
          ],
        }),
      ],
    });
    expect(other.focusUnitId).toBe("u-other");
    expect(other.generationPlanDraft.ready).toBe(false);
    expect(other.items[0]?.recommendedPath).toEqual(["wait"]);

    const waiting = buildSsl5PlanFromBoard("/tmp/iso", { season: "S1", episode: "E2" }, {
      earliestUnitId: "u-frozen",
      earliestCode: "wait-or-reconcile-unit-grid-run",
      earliestLabel: "unit-grid 正在执行，等待结果或对账现有 run",
      missingAllCount: 1,
      partialCount: 0,
      checkpoint: { newSlotDispatchAllowed: false, blockingBatchNumber: 2 },
      rows: [
        row({
          unitId: "u-frozen",
          sequence: 1,
          status: "missing-all",
          isEarliest: true,
          panels: [
            panel({ panelId: "p-focus", panelIndex: 1, hasMedia: false, packId: "focus-own-pack" }),
          ],
        }),
      ],
    });
    expect(waiting.generationPlanDraft.blockedReason).toBe("unit-grid 正在执行，等待结果或对账现有 run");
    expect(waiting.items[0]?.recommendedPath).toEqual(["wait"]);
    expect(refineSsl5FocusIfCheckpointBlocking(waiting).generationPlanDraft.blockedReason).toBe(
      "unit-grid 正在执行，等待结果或对账现有 run",
    );
  });

  it("写租约未持有时路径插入 acquire-lease，未投影/闸/earliest 不插", () => {
    const open = buildSsl5PlanFromBoard("/tmp/iso", { season: "S1", episode: "E2" }, {
      earliestUnitId: "u-focus",
      missingAllCount: 1,
      partialCount: 0,
      writeLease: { held: false, holderId: null, denialHint: null },
      rows: [
        row({
          unitId: "u-focus",
          sequence: 1,
          status: "missing-all",
          isEarliest: true,
          panels: [panel({ panelId: "p1", panelIndex: 1, hasMedia: false, packId: "pack-1" })],
        }),
      ],
    });
    expect(open.generationPlanDraft.ready).toBe(true);
    expect(open.writeLeaseLine).toBe("写租约未持有；写命令前须 acquire-lease（不派发）");
    expect(open.items[0]?.recommendedPath).toEqual([
      "binding-ready?",
      "readiness",
      "acquire-lease",
      "freeze",
      "create-plan",
      "dispatch",
      "prepare",
      "gen",
      "commit",
      "review",
    ]);

    const unprojected = buildSsl5PlanFromBoard("/tmp/iso", { season: "S1", episode: "E2" }, {
      earliestUnitId: "u-focus",
      missingAllCount: 1,
      partialCount: 0,
      rows: [
        row({
          unitId: "u-focus",
          sequence: 1,
          status: "missing-all",
          isEarliest: true,
          panels: [panel({ panelId: "p1", panelIndex: 1, hasMedia: false, packId: "pack-1" })],
        }),
      ],
    });
    expect(unprojected.writeLeaseLine).toBe("对照板未投影写租约");
    expect(unprojected.items[0]?.recommendedPath).toEqual([
      "binding-ready?",
      "readiness",
      "freeze",
      "create-plan",
      "dispatch",
      "prepare",
      "gen",
      "commit",
      "review",
    ]);

    const held = buildSsl5PlanFromBoard("/tmp/iso", { season: "S1", episode: "E2" }, {
      earliestUnitId: "u-focus",
      missingAllCount: 1,
      partialCount: 0,
      writeLease: { held: true, holderId: "agent-a", denialHint: null },
      rows: [
        row({
          unitId: "u-focus",
          sequence: 1,
          status: "missing-all",
          isEarliest: true,
          panels: [panel({ panelId: "p1", panelIndex: 1, hasMedia: false, packId: "pack-1" })],
        }),
      ],
    });
    expect(held.writeLeaseLine).toContain("agent-a");
    expect(held.items[0]?.recommendedPath.includes("acquire-lease")).toBe(false);
    expect(held.generationPlanDraft.ready).toBe(true);

    const waiting = buildSsl5PlanFromBoard("/tmp/iso", { season: "S1", episode: "E2" }, {
      earliestUnitId: "u-focus",
      earliestCode: "wait-or-reconcile-unit-grid-run",
      missingAllCount: 1,
      partialCount: 0,
      writeLease: { held: false, holderId: null, denialHint: null },
      rows: [
        row({
          unitId: "u-focus",
          sequence: 1,
          status: "missing-all",
          isEarliest: true,
          panels: [panel({ panelId: "p1", panelIndex: 1, hasMedia: false, packId: "pack-1" })],
        }),
      ],
    });
    expect(waiting.items[0]?.recommendedPath).toEqual(["wait"]);

    const gated = buildSsl5PlanFromBoard("/tmp/iso", { season: "S1", episode: "E2" }, {
      earliestUnitId: "u-focus",
      earliestCode: "dispatch-unit-grid",
      missingAllCount: 1,
      partialCount: 0,
      checkpoint: { newSlotDispatchAllowed: false, blockingBatchNumber: 2 },
      writeLease: { held: false, holderId: null, denialHint: null },
      rows: [
        row({
          unitId: "u-focus",
          sequence: 1,
          status: "missing-all",
          isEarliest: true,
          panels: [panel({ panelId: "p1", panelIndex: 1, hasMedia: false, packId: "pack-1" })],
        }),
      ],
    });
    expect(gated.items[0]?.recommendedPath).toEqual(["wait"]);
    expect(gated.generationPlanDraft.blockedReason).toContain("六图闸");
  });

  it("consistencyPeek 复用焦点缺图格，不偷同行已出图格", () => {
    const plan = buildSsl5PlanFromBoard("/tmp/iso", { season: "S1", episode: "E2" }, {
      earliestUnitId: "u-partial",
      missingAllCount: 0,
      partialCount: 1,
      rows: [
        row({
          unitId: "u-partial",
          sequence: 1,
          status: "partial",
          isEarliest: true,
          generationRunId: "run-covered",
          consistencyPeek: { status: "cached", verdict: "consistent" },
          panels: [
            panel({
              panelId: "p-covered",
              panelIndex: 1,
              hasMedia: true,
              generationRunId: "run-covered",
              consistencyPeek: { status: "cached", verdict: "consistent" },
            }),
            panel({
              panelId: "p-missing",
              panelIndex: 2,
              hasMedia: false,
              generationRunId: null,
              consistencyPeek: { status: "unevaluated" },
            }),
          ],
        }),
      ],
    });
    expect(plan.focusPanelId).toBe("p-missing");
    expect(plan.consistencyPeek).toEqual({ status: "unevaluated" });
    expect(plan.items[0]?.consistencyPeek).toEqual({ status: "unevaluated" });
  });

  it("焦点缺图格已有 peek 则原样复用；无缺图格才用行 peek", () => {
    const focused = buildSsl5PlanFromBoard("/tmp/iso", { season: "S1", episode: "E2" }, {
      earliestUnitId: "u-partial",
      missingAllCount: 0,
      partialCount: 1,
      rows: [
        row({
          unitId: "u-partial",
          sequence: 1,
          status: "partial",
          isEarliest: true,
          consistencyPeek: { status: "cached", verdict: "consistent" },
          panels: [
            panel({ panelId: "p-covered", panelIndex: 1, hasMedia: true }),
            panel({
              panelId: "p-missing",
              panelIndex: 2,
              hasMedia: false,
              generationRunId: "run-focus",
              consistencyPeek: { status: "cached", verdict: "needs-review" },
            }),
          ],
        }),
      ],
    });
    expect(focused.focusPanelId).toBe("p-missing");
    expect(focused.consistencyPeek).toEqual({ status: "cached", verdict: "needs-review" });

    const covered = buildSsl5PlanFromBoard("/tmp/iso", { season: "S1", episode: "E2" }, {
      earliestUnitId: "u-early",
      missingAllCount: 0,
      partialCount: 0,
      rows: [
        row({
          unitId: "u-early",
          sequence: 1,
          status: "covered",
          isEarliest: true,
          consistencyPeek: { status: "cached", verdict: "drifted" },
          panels: [
            panel({
              panelId: "p1",
              panelIndex: 1,
              hasMedia: true,
              consistencyPeek: { status: "cached", verdict: "consistent" },
            }),
          ],
        }),
      ],
    });
    expect(covered.focusPanelId).toBeNull();
    expect(covered.consistencyPeek).toEqual({ status: "cached", verdict: "drifted" });
  });
});

describe("SSL-5 入口源码合同", () => {
  it("MCP 经懒加载暴露 ssl5-missing-to-gen-plan，不静态拉模块，不自动 dispatch", () => {
    const server = source("src/mcp/server.ts");
    const ssl5 = source("src/core/studio-ssl5-missing-to-gen.ts");
    const lazy = source("src/core/studio-readonly-diagnostics-lazy.ts");
    expect(server).toContain("ssl5-missing-to-gen-plan");
    expect(server).toContain("writeLease/writeLeaseLine");
    expect(server).toContain("missingReport");
    expect(server).toContain("acquire-lease");
    expect(server).toContain("withStudioSsl5MissingToGen");
    expect(server).not.toMatch(/from ["'].*studio-ssl5-missing-to-gen\.js["']/u);
    expect(lazy).toContain('import("./studio-ssl5-missing-to-gen.js")');
    expect(ssl5).not.toMatch(/getStudioEpisodeEarliest\s*\(/u);
    expect(ssl5).not.toContain("execute_command");
    expect(ssl5).not.toContain("dispatch_studio_generation_pack");
    expect(ssl5).toContain("create-plan");
    expect(ssl5).toContain("composeSsl5GenerationPlanDraft");
    expect(ssl5).toContain("refineSsl5FocusPlanDraftIfPersisted");
    expect(ssl5).toContain("refineSsl5FocusIfEarliestBlocking");
    expect(ssl5).toContain("refineSsl5FocusIfCheckpointBlocking");
    expect(ssl5).toContain("formatAlignCheckpointLine");
    expect(ssl5).toContain("refineSsl5RecommendedPathIfWriteLeaseOpen");
    expect(ssl5).toContain("formatAlignWriteLeaseLine");
    expect(ssl5).not.toContain("studio-generation-checkpoint");
    expect(ssl5).not.toContain("getStudioGenerationCheckpointControl");
    expect(ssl5).not.toContain("studio-project-write-lease");
    expect(ssl5).not.toContain("studio-trace");
    expect(ssl5).not.toContain("getStudioScriptRevisionImpact");
    expect(ssl5).toContain("earliestBlockingPath");
    expect(ssl5).toContain("readPersistedPanelPlanState");
    expect(ssl5).toContain("studio-generation-plan-draft");
    expect(ssl5).toContain("focusPackId");
    expect(ssl5).toContain("SSL5_PLAN_SCHEMA_VERSION = 1");
    expect(ssl5).not.toContain("studio-generation-ledger.js");
    expect(ssl5).not.toContain("managedLedgerPaths");
  });

  it("桌面对照面展示只读下一步，导演动作不写命令", () => {
    const vue = source("src/renderer/src/components/ScriptMediaAlignView.vue");
    const director = source("src/renderer/src/director-action-panel.ts");
    const ssl5 = source("src/core/studio-ssl5-missing-to-gen.ts");
    expect(vue).toContain('data-testid="ssl5-missing-to-gen-plan"');
    expect(vue).toContain('data-testid="ssl5-focus-panel"');
    expect(vue).toContain('data-testid="ssl5-focus-handoff"');
    expect(vue).toContain('data-testid="ssl5-focus-standing-gaps"');
    expect(vue).toContain('data-testid="ssl5-focus-scene-backrefs"');
    expect(vue).toContain('data-testid="ssl5-focus-prop-backrefs"');
    expect(vue).toContain('data-testid="ssl5-focus-character-backrefs"');
    expect(vue).toContain('data-testid="ssl5-focus-peek"');
    expect(vue).toContain("peekLabel(ssl5Plan.consistencyPeek)");
    expect(vue).toContain('data-testid="ssl5-focus-shot-type"');
    expect(vue).toContain('data-testid="ssl5-focus-style-lock"');
    expect(vue).toContain('data-testid="ssl5-focus-beat"');
    expect(vue).toContain('data-testid="ssl5-focus-unit-beat"');
    expect(vue).toContain('data-testid="ssl5-focus-lighting"');
    expect(vue).toContain('data-testid="ssl5-focus-previous-lighting"');
    expect(vue).toContain('data-testid="ssl5-focus-previous-costume"');
    expect(vue).toContain('data-testid="ssl5-generation-plan-draft"');
    expect(vue).toContain('data-testid="ssl5-generation-plan-command"');
    expect(vue).toContain('data-testid="ssl5-generation-plan-nodes"');
    expect(vue).toContain("formatSsl5PlanDraftNode");
    expect(vue).toContain("不执行 create-plan");
    expect(vue).toContain('data-testid="ssl5-earliest-next"');
    expect(vue).toContain('data-testid="ssl5-checkpoint-next"');
    expect(vue).toContain('data-testid="align-checkpoint-gate"');
    expect(vue).toContain('data-testid="ssl5-write-lease"');
    expect(vue).toContain('data-testid="align-write-lease"');
    expect(vue).toContain('data-testid="align-missing-report"');
    expect(vue).toContain('data-testid="align-missing-report-copy"');
    expect(vue).toContain("align-review-");
    expect(vue).toContain("reviewDecisionLabel");
    expect(vue).toContain("ssl5EarliestNextLine");
    expect(vue).toContain("ssl5DisplayedPlan");
    expect(vue).toContain("refineSsl5FocusIfUnexpectedRevisionImpact");
    expect(vue).not.toContain("from \"@core/studio-trace");
    expect(vue).not.toContain("dispatch_studio_generation_pack");
    expect(ssl5).toContain("formatSceneBackReferenceLineFromBoard");
    expect(ssl5).toContain("formatPanelLightingCostumeLine");
    expect(ssl5).toContain("formatPanelShotTypeLine");
    expect(ssl5).toContain("shotTypeLine");
    expect(ssl5).toContain("formatStyleLockLine");
    expect(ssl5).toContain("styleLockLine");
    expect(ssl5).not.toContain("listStyleBackReferences");
    expect(ssl5).toContain("formatPanelBeatLine");
    expect(ssl5).toContain("formatUnitBeatLine");
    expect(ssl5).toContain("beatLine");
    expect(ssl5).toContain("unitBeatLine");
    expect(ssl5).toContain("没有宫格可查 15s 节拍");
    expect(ssl5).toContain("wizardPreviousLightingForPanel");
    expect(ssl5).toContain("wizardPreviousCostumeForPanel");
    expect(ssl5).toContain("lightingCostumeLine");
    expect(ssl5).toContain("sceneBackReferences");
    expect(ssl5).toContain("propBackReferences");
    expect(ssl5).toContain("formatPropBackReferenceLineFromBoard");
    expect(ssl5).toContain("characterBackReferences");
    expect(ssl5).toContain("formatCharacterBackReferenceLineFromBoard");
    expect(ssl5).not.toContain("studio-scene-backrefs-read");
    expect(ssl5).not.toContain("evaluateStudioConsistency");
    expect(ssl5).not.toContain("studio-consistency-evaluator");
    expect(ssl5).toContain("reuseBoardConsistencyPeek");
    expect(ssl5).toContain("consistencyPeek");
    expect(ssl5).not.toContain("getStudioBindingControl");
    expect(vue).toContain("planSsl5MissingToGen");
    expect(vue).toContain("不自动 dispatch");
    expect(director).toContain("ssl5-missing-to-gen-plan");
    expect(director).toContain("不自动 dispatch");
    expect(director).toContain("不执行建计划");
    expect(director).toContain("下一步以 earliest 为准");
    expect(director).toContain("六图闸");
    expect(director).toContain("acquire-lease");
    expect(director).toContain("缺图报告");
    expect(director).not.toContain("dispatch_studio_generation_pack");
  });
});
