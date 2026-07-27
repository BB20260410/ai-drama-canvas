import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "@vue/compiler-sfc";
import { describe, expect, it } from "vitest";
import {
  STUDIO_BINDING_PAGE_LIMIT,
  STUDIO_BINDING_SOURCE_EXCERPT_LIMIT,
  assertStudioBindingPanelCount,
  boundedStudioBindingCandidates,
  boundedStudioBindingSourceExcerpt,
  boundedStudioBindingUnits,
  buildStudioBindingResolveInput,
  commitStudioBindingFirstPage,
  commitStudioBindingNextPage,
  commitStudioBindingPreviousPage,
  createStudioBindingCursorState,
  createStudioBindingRequestGate,
  createStudioBindingResolutionDraft,
  studioBindingFreezeDisabled,
  studioBindingStatusPresentation,
  type StudioBindingControlSnapshot,
  type StudioBindingPanel,
  type StudioBindingProposal,
  type StudioBindingUnitSummary,
} from "../src/renderer/src/studio-binding-pagination.js";

function unit(index = 1, status: StudioBindingUnitSummary["status"] = "pending"): StudioBindingUnitSummary {
  return {
    id: `unit-${String(index).padStart(3, "0")}`,
    seasonId: "season-3",
    seasonLabel: "第三季",
    episodeId: "ep01",
    episodeLabel: "EP01",
    label: `EP01_15s_${String(index).padStart(3, "0")}`,
    durationSeconds: 15,
    panelCount: 4,
    status,
  };
}

function proposal(overrides: Partial<StudioBindingProposal> = {}): StudioBindingProposal {
  return {
    id: "proposal-ahang",
    sourceExcerptId: "excerpt-ahang",
    entityText: "阿航",
    entityCategory: "character",
    status: "ambiguous",
    matchKind: "confirmed-alias",
    candidates: [
      { assetId: "character-ahang-young", assetName: "青年阿航", category: "character", matchKind: "exact-alias" },
      { assetId: "character-ahang-child", assetName: "童年阿航", category: "character", matchKind: "exact-alias" },
    ],
    presence: "required",
    role: "主角",
    blockerCodes: ["entity-ambiguous"],
    ...overrides,
  };
}

function panel(overrides: Partial<StudioBindingPanel> = {}): StudioBindingPanel {
  return {
    id: "panel-01",
    ordinal: 1,
    label: "宫格 01",
    startSeconds: 0,
    endSeconds: 4,
    status: "ambiguous",
    sourceExcerpts: [],
    proposals: [proposal()],
    blockers: [{ code: "entity-ambiguous", message: "阿航存在两个规范资产候选。", severity: "blocking" }],
    freezeAllowed: false,
    ...overrides,
    confirmEmptyAllowed: overrides.confirmEmptyAllowed ?? false,
  };
}

function snapshot(overrides: Partial<StudioBindingControlSnapshot> = {}): StudioBindingControlSnapshot {
  return {
    revisionToken: "binding-r7",
    nextAction: "人工消解阿航的歧义候选。",
    unit: unit(1, "ambiguous"),
    panels: [panel(), panel({ id: "panel-02", ordinal: 2, label: "宫格 02" })],
    selectedPanelId: "panel-01",
    ...overrides,
  };
}

describe("P6 三栏资产绑定工作台", () => {
  it("只把 Core 状态映射为固定中文呈现，不从计数推导状态或 nextAction", () => {
    expect([
      "pending",
      "unchecked",
      "ambiguous",
      "unmatched",
      "bound",
      "stale",
      "generation-ready",
    ].map((status) => studioBindingStatusPresentation(status as StudioBindingUnitSummary["status"]).label)).toEqual([
      "待解析",
      "待核验",
      "歧义",
      "未匹配",
      "已绑定",
      "已过期",
      "可以生图",
    ]);
    expect(snapshot().nextAction).toBe("人工消解阿航的歧义候选。");
  });

  it("歧义提案绝不默认采用第一候选，明确 matched 也只接受 Core 给出的 matchedAssetId", () => {
    const ambiguous = proposal();
    expect(createStudioBindingResolutionDraft(ambiguous)).toMatchObject({ selectedAssetId: "", presence: "required", role: "主角" });
    expect(ambiguous.candidates[0]?.assetId).toBe("character-ahang-young");

    const matchedWithoutIdentity = proposal({ status: "matched", matchedAssetId: undefined, blockerCodes: [] });
    expect(createStudioBindingResolutionDraft(matchedWithoutIdentity).selectedAssetId).toBe("");
    const matched = proposal({ status: "matched", matchedAssetId: "character-ahang-young", blockerCodes: [] });
    expect(createStudioBindingResolutionDraft(matched).selectedAssetId).toBe("character-ahang-young");
    const resolvedAmbiguous = proposal({ status: "ambiguous", resolvedAssetId: "character-ahang-child", blockerCodes: [] });
    expect(createStudioBindingResolutionDraft(resolvedAmbiguous).selectedAssetId).toBe("character-ahang-child");
  });

  it("展示 unmatched/forbidden 阻塞，并严格使用 Core freezeAllowed 控制冻结准入", () => {
    const blocked = panel({
      status: "unmatched",
      proposals: [proposal({ status: "unmatched", candidates: [], presence: "forbidden", blockerCodes: ["entity-unmatched", "forbidden-reference"] })],
      blockers: [
        { code: "entity-unmatched", message: "实体未匹配。", severity: "blocking" },
        { code: "forbidden-reference", message: "禁止项仍进入参考。", severity: "blocking" },
      ],
      freezeAllowed: false,
    });
    expect(blocked.proposals[0]).toMatchObject({ status: "unmatched", presence: "forbidden", blockerCodes: ["entity-unmatched", "forbidden-reference"] });
    expect(studioBindingFreezeDisabled(blocked)).toBe(true);

    // 证明 UI 没有根据 blocker 文案重算：Core 若明确放行，UI 原样服从。
    expect(studioBindingFreezeDisabled({ ...blocked, freezeAllowed: true })).toBe(false);
  });

  it("accept/select/exclude 写操作都冻结 revision token、presence、role 和显式选择", () => {
    const current = snapshot();
    const targetPanel = current.panels[0]!;
    const matched = proposal({ status: "matched", matchedAssetId: "character-ahang-young", blockerCodes: [] });
    const matchedDraft = createStudioBindingResolutionDraft(matched);
    expect(buildStudioBindingResolveInput(current, targetPanel, matched, matchedDraft, "accept")).toEqual({
      unitId: "unit-001",
      panelId: "panel-01",
      proposalId: "proposal-ahang",
      decision: "accept",
      selectedAssetId: "character-ahang-young",
      presence: "required",
      role: "主角",
      expectedRevisionToken: "binding-r7",
      reviewer: "user",
    });

    const ambiguous = proposal();
    expect(() => buildStudioBindingResolveInput(current, targetPanel, ambiguous, createStudioBindingResolutionDraft(ambiguous), "select")).toThrow("人工选择");
    expect(buildStudioBindingResolveInput(current, targetPanel, ambiguous, {
      selectedAssetId: "character-ahang-child",
      presence: "optional",
      role: "  回忆中的阿航  ",
    }, "select")).toMatchObject({
      decision: "select",
      selectedAssetId: "character-ahang-child",
      presence: "optional",
      role: "回忆中的阿航",
      expectedRevisionToken: "binding-r7",
      reviewer: "user",
    });
    expect(buildStudioBindingResolveInput(current, targetPanel, ambiguous, {
      selectedAssetId: "character-ahang-young",
      presence: "forbidden",
      role: "禁用角色",
    }, "exclude")).toEqual({
      unitId: "unit-001",
      panelId: "panel-01",
      proposalId: "proposal-ahang",
      decision: "exclude",
      presence: "forbidden",
      role: "禁用角色",
      expectedRevisionToken: "binding-r7",
      reviewer: "user",
    });
  });

  it("宫格解析必须携带显式 panelId 与 revision token", async () => {
    const componentPath = path.join(process.cwd(), "src/renderer/src/components/StudioBindingWorkbench.vue");
    const source = await readFile(componentPath, "utf8");
    expect(source).toContain("解析当前宫格");
    expect(source).toContain("panelId: panel.id");
    expect(source).toContain("expectedRevisionToken: snapshot.revisionToken");
    expect(source).toContain('data-testid="`binding-source-section-${section.kind}`"');
    expect(source).toContain("剧本章节与场景来源");
    expect(source).not.toMatch(/expectedRevisionToken\s*\?/u);
    expect(source).not.toContain("解析剧本实体");
  });

  it("零提案只显示显式 confirmed-empty 审阅入口，并提交 user、note 与 revision token", async () => {
    const componentPath = path.join(process.cwd(), "src/renderer/src/components/StudioBindingWorkbench.vue");
    const source = await readFile(componentPath, "utf8");
    expect(source).toContain('data-testid="binding-empty-review"');
    expect(source).toContain('data-testid="binding-empty-note"');
    expect(source).toContain('data-testid="binding-confirm-empty"');
    expect(source).toContain("panel.confirmEmptyAllowed");
    expect(source).toContain('reviewer: "user"');
    expect(source).toContain("note,");
    expect(source).toContain("expectedRevisionToken: snapshot.revisionToken");
    expect(source).not.toMatch(/proposals\.length\s*===\s*0[^\n]{0,120}freezeAllowed\s*=\s*true/u);
  });

  it("分页替换而不累积，单页最多 36 个唯一单元", () => {
    const first = boundedStudioBindingUnits([...Array.from({ length: 44 }, (_, index) => unit(index + 1)), unit(1)]);
    const second = boundedStudioBindingUnits(Array.from({ length: 36 }, (_, index) => unit(index + 45)));
    expect(STUDIO_BINDING_PAGE_LIMIT).toBe(36);
    expect(first).toHaveLength(36);
    expect(new Set(first.map((entry) => entry.id)).size).toBe(36);
    expect(second).toHaveLength(36);
    expect(second.some((entry) => first.some((old) => old.id === entry.id))).toBe(false);

    const state = createStudioBindingCursorState();
    commitStudioBindingFirstPage(state, "cursor-2");
    commitStudioBindingNextPage(state, "cursor-2", "cursor-3");
    expect(state).toEqual({ currentCursor: "cursor-2", previousCursors: [undefined], nextCursor: "cursor-3" });
    commitStudioBindingPreviousPage(state, undefined, "cursor-2");
    expect(state).toEqual({ currentCursor: undefined, previousCursors: [], nextCursor: "cursor-2" });
  });

  it("revision request token 使旧筛选/旧详情响应无法覆盖最新请求", () => {
    const gate = createStudioBindingRequestGate();
    const oldPage = gate.issue("unit-page");
    const latestPage = gate.issue("unit-page");
    const control = gate.issue("control");
    expect(gate.isCurrent(oldPage)).toBe(false);
    expect(gate.isCurrent(latestPage)).toBe(true);
    expect(gate.isCurrent(control)).toBe(true);
    gate.invalidate("control");
    expect(gate.isCurrent(control)).toBe(false);
    expect(gate.isCurrent(latestPage)).toBe(true);
    gate.invalidateAll();
    expect(gate.isCurrent(latestPage)).toBe(false);
  });

  it("严格限制 2–6 格、候选数和 source excerpt DOM 文本长度", () => {
    expect(() => assertStudioBindingPanelCount([panel()])).toThrow("2–6");
    expect(() => assertStudioBindingPanelCount(Array.from({ length: 7 }, (_, index) => panel({ id: `panel-${index}` })))).toThrow("2–6");
    expect(() => assertStudioBindingPanelCount([panel(), panel()])).toThrow("重复 panel id");
    expect(() => assertStudioBindingPanelCount(snapshot().panels)).not.toThrow();

    const candidates = Array.from({ length: 10 }, (_, index) => ({
      assetId: `asset-${index}`,
      assetName: `资产 ${index}`,
      category: "prop" as const,
      matchKind: "semantic",
    }));
    expect(boundedStudioBindingCandidates([...candidates, candidates[0]!])).toHaveLength(6);
    const excerpt = boundedStudioBindingSourceExcerpt(`  ${"长剧情 ".repeat(100)}  `);
    expect(excerpt).toHaveLength(STUDIO_BINDING_SOURCE_EXCERPT_LIMIT);
    expect(excerpt.endsWith("…")).toBe(true);
    expect(excerpt).not.toMatch(/\s{2,}/);
  });

  it("SFC 可解析，写边界只出现四个明确 API，且包含键盘、ARIA 与减弱动态契约", async () => {
    const componentPath = path.join(process.cwd(), "src/renderer/src/components/StudioBindingWorkbench.vue");
    const source = await readFile(componentPath, "utf8");
    const parsed = parse(source, { filename: componentPath });
    expect(parsed.errors).toEqual([]);
    expect(parsed.descriptor.template?.content).toContain('data-testid="studio-binding-workbench"');
    expect(parsed.descriptor.template?.content).toContain('@keydown.down.prevent="moveUnitSelection(1)"');
    expect(parsed.descriptor.template?.content).toContain('aria-label="2 至 6 格时间线"');
    expect(parsed.descriptor.styles.some((style) => style.content.includes("prefers-reduced-motion"))).toBe(true);
    expect(source).not.toMatch(/localStorage|sessionStorage|indexedDB|\.aicanvas\/canvas\.json/);

    const writeCalls = [...source.matchAll(/props\.api\.(analyze|resolve|confirmEmpty|freeze)\s*\(/g)].map((match) => match[1]).sort();
    expect(writeCalls).toEqual(["analyze", "confirmEmpty", "freeze", "resolve"]);
  });
});
