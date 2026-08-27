import { readFileSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyWizardPanelEdits,
  mapWizardSuggestedAssetsToPanelMentions,
  materializeStudioStoryboardWizardUnit,
  openStudioStoryboardWizard,
  toWizardEditablePanels,
  validateWizardForMaterialize,
  STORYBOARD_WIZARD_SCHEMA_VERSION,
  type WizardEditablePanel,
  type WizardResolvedSuggestedAsset,
} from "../src/core/studio-storyboard-wizard.js";
import {
  formatWizardPromptBody,
  wizardPreviousCostumeForPanel,
  wizardPreviousLightingForPanel,
  wizardPreviousStandingForPanel,
} from "../src/core/studio-panel-standing.js";
import type { StudioStoryboardDraftPanelSuggestion } from "../src/core/studio-storyboard-draft.js";
import {
  appendStudioScriptRevision,
  createStudioScriptDocument,
  getStudioProductionUnitSnapshot,
  initializeStudioProduction,
} from "../src/core/studio-production.js";
import { createStudioCanonicalAsset } from "../src/core/material-studio.js";
import { createManagedProject } from "../src/core/managed-project.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function basePanel(index: number, overrides: Partial<StudioStoryboardDraftPanelSuggestion> = {}): StudioStoryboardDraftPanelSuggestion {
  return {
    panelIndex: index,
    shotType: "original",
    startSeconds: (index - 1) * 5,
    endSeconds: index * 5,
    durationSeconds: 5,
    sourceSpans: [{ startOffsetUtf16: 0, endOffsetUtf16: 4 }],
    suggestedAssetIds: [],
    unresolvedProposals: [],
    ...overrides,
  };
}

describe("studio-storyboard-wizard", () => {
  it("toWizardEditablePanels seeds editable fields", () => {
    const panels = toWizardEditablePanels([basePanel(1), basePanel(2), basePanel(3)]);
    expect(panels).toHaveLength(3);
    expect(panels[0]?.title).toBe("G1");
    expect(panels[0]?.visualAction).toBe("");
  });

  it("applyWizardPanelEdits merges by panelIndex", () => {
    const panels = toWizardEditablePanels([basePanel(1), basePanel(2)]);
    const next = applyWizardPanelEdits(panels, [{
      panelIndex: 2,
      visualAction: "推近",
      title: "近景格",
      sceneLighting: "走廊冷光",
      costumeState: "湿祭服",
    }]);
    expect(next[0]?.visualAction).toBe("");
    expect(next[1]?.visualAction).toBe("推近");
    expect(next[1]?.title).toBe("近景格");
    expect(next[1]?.sceneLighting).toBe("走廊冷光");
    expect(next[1]?.costumeState).toBe("湿祭服");
    expect(next[0]?.sceneLighting).toBe("");
  });

  it("validateWizardForMaterialize enforces 15s and visualAction", () => {
    const panels = toWizardEditablePanels([basePanel(1), basePanel(2), basePanel(3)]) as WizardEditablePanel[];
    expect(validateWizardForMaterialize(panels).some((e) => e.includes("visualAction"))).toBe(true);
    const filled = applyWizardPanelEdits(panels, [
      { panelIndex: 1, visualAction: "a" },
      { panelIndex: 2, visualAction: "b" },
      { panelIndex: 3, visualAction: "c" },
    ]);
    expect(validateWizardForMaterialize(filled)).toEqual([]);
  });

  it("schema frozen", () => {
    expect(STORYBOARD_WIZARD_SCHEMA_VERSION).toBe(1);
  });

  it("建议资产按规范分类落盘，禁止一律写成 character", () => {
    const resolved = new Map<string, WizardResolvedSuggestedAsset>([
      ["character-ahang", { assetId: "character-ahang", category: "character", name: "阿航" }],
      ["scene-stone", { assetId: "scene-stone", category: "scene", name: "石室" }],
      ["prop-mask", { assetId: "prop-mask", category: "prop", name: "黄金面具" }],
      ["style-cine", { assetId: "style-cine", category: "style", name: "电影写实" }],
    ]);
    const mentions = mapWizardSuggestedAssetsToPanelMentions(
      ["character-ahang", "scene-stone", "prop-mask", "style-cine", "gone-missing", "character-ahang"],
      resolved,
      "script-rev-1",
    );
    expect(mentions.map((item) => ({ assetId: item.assetId, category: item.category, role: item.role }))).toEqual([
      { assetId: "character-ahang", category: "character", role: "阿航" },
      { assetId: "scene-stone", category: "scene", role: "石室" },
      { assetId: "prop-mask", category: "prop", role: "黄金面具" },
      { assetId: "style-cine", category: "style", role: "电影写实" },
    ]);
    expect(mentions.every((item) => item.presence === "optional")).toBe(true);
    const wizard = readFileSync(new URL("../src/core/studio-storyboard-wizard.ts", import.meta.url), "utf8");
    expect(wizard).toContain("mapWizardSuggestedAssetsToPanelMentions");
    expect(wizard).toContain("getStudioCanonicalAsset");
    expect(wizard).not.toContain('category: "character" as const');
    const app = readFileSync(new URL("../src/renderer/src/App.vue", import.meta.url), "utf8");
    expect(app).toContain("category: asset.category");
    expect(app).toContain("role: asset.name");
  });

  it("物化后下一步含 create-plan，不跳过 Binding，不自动派发", () => {
    const wizard = readFileSync(new URL("../src/core/studio-storyboard-wizard.ts", import.meta.url), "utf8");
    expect(wizard).toContain("WIZARD_POST_MATERIALIZE_NEXT");
    expect(wizard).toContain("Binding→readiness→freeze→create-plan→dispatch");
    expect(wizard).toContain("不跳过 Binding，不自动派发");
    expect(wizard).not.toContain("物化后走 readiness→freeze→dispatch（不跳过 Binding）");
    expect(wizard).toContain("WIZARD_POST_MATERIALIZE_NEXT,");
  });

  it("G2+ 向导前镜取上一格；物化 prompt 首格不写前镜行", () => {
    const panels = applyWizardPanelEdits(toWizardEditablePanels([basePanel(1), basePanel(2)]), [
      { panelIndex: 1, visualAction: "站定", shotComposition: "中景", filmingMethod: "固定" },
      { panelIndex: 2, visualAction: "抬手", shotComposition: "近景", filmingMethod: "推" },
    ]);
    expect(wizardPreviousStandingForPanel(panels, 1)).toBeNull();
    expect(wizardPreviousStandingForPanel(panels, 2)).toEqual({
      panelIndex: 1,
      panelId: "G1",
      shotComposition: "中景",
      visualAction: "站定",
      filmingMethod: "固定",
    });
    const body = formatWizardPromptBody(panels);
    expect(body).toContain("G1 original 0-5s G1: 站定");
    expect(body).not.toMatch(/^G1 .*\n前镜交接/u);
    expect(body).toContain("G2 original 5-10s G2: 抬手");
    expect(body).toContain("前镜交接：G1 中景 · 站定 · 固定。本格必须从该站位连续起拍");
    expect(body).not.toContain("光线：");
    expect(body).not.toContain("服化：");
    expect(body).not.toContain("场景回指");
    expect(body).not.toContain("道具回指");
    expect(body).not.toContain("角色回指");
    expect(body).not.toContain("扩写格：必须与前一格连续");
    expect(body).not.toContain("禁止锚定原文");
    const lit = applyWizardPanelEdits(panels, [
      { panelIndex: 1, sceneLighting: "室内火光", costumeState: "深灰祭服" },
    ]);
    expect(wizardPreviousLightingForPanel(lit, 1)).toBeNull();
    expect(wizardPreviousLightingForPanel(lit, 2)).toEqual({ panelIndex: 1, sceneLighting: "室内火光" });
    expect(wizardPreviousCostumeForPanel(lit, 2)).toEqual({ panelIndex: 1, costumeState: "深灰祭服" });
    const litBody = formatWizardPromptBody(lit);
    expect(litBody).toContain("光线：室内火光");
    expect(litBody).toContain("服化：深灰祭服");
    expect(litBody).not.toMatch(/G2[\s\S]*光线：/u);
  });

  it("keeps a selected span anchored to the original revision offsets", async () => {
    const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "storyboard-wizard-source-range-")));
    roots.push(parent);
    const projectRoot = (await createManagedProject({ parentRoot: parent, name: "选区向导" })).paths.root;
    await initializeStudioProduction(projectRoot);
    const doc = await createStudioScriptDocument(projectRoot, {
      id: "script-wizard-range",
      title: "选区剧本",
      expectedRevision: 0,
    });
    const prefix = "不在选区。";
    const selected = "第一句动作。第二句反应。第三句收束。";
    const revision = await appendStudioScriptRevision(projectRoot, {
      documentId: doc.id,
      expectedRevision: 0,
      body: `${prefix}${selected}选区之外。`,
      source: "test",
      sourceVersion: "1",
    });
    const startOffsetUtf16 = prefix.length;
    const endOffsetUtf16 = prefix.length + selected.length;
    const session = await openStudioStoryboardWizard(projectRoot, {
      scriptRevisionId: revision.revision.id,
      panelCount: 3,
      sourceRange: { startOffsetUtf16, endOffsetUtf16 },
    });
    expect(session.sourceRange).toEqual({ startOffsetUtf16, endOffsetUtf16 });
    expect(session.panels).toHaveLength(3);
    expect(session.panels.flatMap((panel) => panel.sourceSpans).every((span) =>
      span.startOffsetUtf16 >= startOffsetUtf16 && span.endOffsetUtf16 <= endOffsetUtf16
    )).toBe(true);
    expect(session.panels[0]?.sourceSpans[0]?.startOffsetUtf16).toBe(startOffsetUtf16);
  });

  it.skipIf(process.platform !== "darwin")("Core 物化写入规范资产真实 category/name，缺记录跳过", async () => {
    const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "storyboard-wizard-asset-cat-")));
    roots.push(parent);
    const projectRoot = (await createManagedProject({ parentRoot: parent, name: "向导资产分类" })).paths.root;
    await initializeStudioProduction(projectRoot);
    await createStudioCanonicalAsset(projectRoot, {
      id: "character-ahang",
      category: "character",
      name: "阿航",
      expectedRevision: 0,
    } as Parameters<typeof createStudioCanonicalAsset>[1]);
    await createStudioCanonicalAsset(projectRoot, {
      id: "scene-stone",
      category: "scene",
      name: "石室",
      expectedRevision: 0,
    } as Parameters<typeof createStudioCanonicalAsset>[1]);
    await createStudioCanonicalAsset(projectRoot, {
      id: "prop-mask",
      category: "prop",
      name: "黄金面具",
      expectedRevision: 0,
    } as Parameters<typeof createStudioCanonicalAsset>[1]);
    await createStudioCanonicalAsset(projectRoot, {
      id: "style-cine",
      category: "style",
      name: "电影写实",
      expectedRevision: 0,
    } as Parameters<typeof createStudioCanonicalAsset>[1]);
    const doc = await createStudioScriptDocument(projectRoot, {
      id: "script-wizard-assets",
      title: "资产分类剧本",
      expectedRevision: 0,
    });
    const revision = await appendStudioScriptRevision(projectRoot, {
      documentId: doc.id,
      expectedRevision: 0,
      body: "第一句动作。第二句反应。第三句收束。",
      source: "test",
      sourceVersion: "1",
    });
    const panels = applyWizardPanelEdits(toWizardEditablePanels([
      { ...basePanel(1), suggestedAssetIds: ["character-ahang", "scene-stone", "prop-mask", "style-cine"] },
      { ...basePanel(2), suggestedAssetIds: ["character-ahang", "gone-missing"] },
      { ...basePanel(3), suggestedAssetIds: [] },
    ]), [
      { panelIndex: 1, visualAction: "站定" },
      { panelIndex: 2, visualAction: "抬手" },
      { panelIndex: 3, visualAction: "收束" },
    ]);
    const materialized = await materializeStudioStoryboardWizardUnit(projectRoot, {
      season: "S1",
      episode: "E1",
      sequence: 1,
      unitId: "unit-wizard-asset-cat",
      unitTitle: "向导资产分类",
      scriptRevisionId: revision.revision.id,
      panels,
    });
    const snapshot = await getStudioProductionUnitSnapshot(projectRoot, materialized.unitId);
    expect(snapshot?.panels.map((panel) => panel.assets.map((asset) => ({
      assetId: asset.assetId,
      category: asset.category,
      role: asset.role,
    })))).toEqual([
      [
        { assetId: "character-ahang", category: "character", role: "阿航" },
        { assetId: "prop-mask", category: "prop", role: "黄金面具" },
        { assetId: "scene-stone", category: "scene", role: "石室" },
        { assetId: "style-cine", category: "style", role: "电影写实" },
      ],
      [
        { assetId: "character-ahang", category: "character", role: "阿航" },
      ],
      [],
    ]);
  });
});
