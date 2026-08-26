import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ScriptMediaAlignRow } from "../src/core/studio-script-media-align.js";
import {
  buildSsl5PlanFromBoard,
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
    expect(plan.items[0]?.recommendedPath).toEqual([
      "binding-ready?",
      "readiness",
      "freeze",
      "dispatch",
      "prepare",
      "gen",
      "commit",
      "review",
    ]);
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
          panel({ panelId: "p1", panelIndex: 1, hasMedia: true }),
          panel({ panelId: "p2", panelIndex: 2, hasMedia: false }),
        ],
      })],
    });
    expect(plan.focusUnitId).toBe("u-partial");
    expect(plan.focusPanelId).toBe("p2");
    expect(plan.focusPanelIndex).toBe(2);
  });

  it("全 covered 且无 earliest 则无焦点", () => {
    const plan = buildSsl5PlanFromBoard("/tmp/iso", { season: "S1", episode: "E2" }, {
      earliestUnitId: null,
      missingAllCount: 0,
      partialCount: 0,
      rows: [row({ unitId: "u-ok", sequence: 1, status: "covered" })],
    });
    expect(plan.focusUnitId).toBeNull();
    expect(plan.items).toEqual([]);
  });
});

describe("SSL-5 入口源码合同", () => {
  it("MCP 经懒加载暴露 ssl5-missing-to-gen-plan，不静态拉模块，不自动 dispatch", () => {
    const server = source("src/mcp/server.ts");
    const ssl5 = source("src/core/studio-ssl5-missing-to-gen.ts");
    const lazy = source("src/core/studio-readonly-diagnostics-lazy.ts");
    expect(server).toContain("ssl5-missing-to-gen-plan");
    expect(server).toContain("withStudioSsl5MissingToGen");
    expect(server).not.toMatch(/from ["'].*studio-ssl5-missing-to-gen\.js["']/u);
    expect(lazy).toContain('import("./studio-ssl5-missing-to-gen.js")');
    expect(ssl5).not.toMatch(/getStudioEpisodeEarliest\s*\(/u);
    expect(ssl5).not.toContain("execute_command");
    expect(ssl5).not.toContain("dispatch_studio_generation_pack");
  });

  it("桌面对照面展示只读下一步，导演动作不写命令", () => {
    const vue = source("src/renderer/src/components/ScriptMediaAlignView.vue");
    const director = source("src/renderer/src/director-action-panel.ts");
    expect(vue).toContain('data-testid="ssl5-missing-to-gen-plan"');
    expect(vue).toContain('data-testid="ssl5-focus-panel"');
    expect(vue).toContain("planSsl5MissingToGen");
    expect(vue).toContain("不自动 dispatch");
    expect(director).toContain("ssl5-missing-to-gen-plan");
    expect(director).toContain("不自动 dispatch");
    expect(director).not.toContain("dispatch_studio_generation_pack");
  });
});
