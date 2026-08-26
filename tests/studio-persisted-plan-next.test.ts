import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  generationLedgerSidecarPath,
  panelPlanTargetKey,
  readPersistedPanelHasPlan,
  readPersistedUnitGridPackAndPlan,
} from "../src/core/studio-unit-grid-persisted-plan-read.js";
import {
  composeStudioGenerationPlanDraft,
  STUDIO_GENERATION_PLAN_ALREADY_EXISTS_PANEL,
  STUDIO_GENERATION_PLAN_COMMAND,
} from "../src/core/studio-generation-plan-draft.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = (relative: string) => readFileSync(path.join(root, relative), "utf8");
const FP = "b".repeat(64);

let tempRoot: string | undefined;

afterEach(async () => {
  if (!tempRoot) return;
  await rm(tempRoot, { recursive: true, force: true });
  tempRoot = undefined;
});

async function seedLedger(options: {
  packs?: Array<{
    unitId: string;
    packId: string;
    panelId: string;
    sequence?: number;
    unitGrid?: boolean;
  }>;
  panelPlans?: Array<{ unitId: string; panelId: string; planId: string; packId: string }>;
  unitGridPlans?: Array<{ unitId: string; planId: string; panelId?: string; packId?: string }>;
}): Promise<string> {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), "persisted-plan-next-"));
  const sidecar = path.join(tempRoot, ".aicanvas");
  await mkdir(sidecar, { recursive: true });
  const databasePath = path.join(sidecar, "studio-generation-ledger.sqlite");
  const db = new DatabaseSync(databasePath);
  try {
    db.exec(`
      CREATE TABLE studio_generation_ledger_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT INTO studio_generation_ledger_meta(key, value) VALUES('schema_version', '7');
      CREATE TABLE studio_generation_packs (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        pack_id TEXT NOT NULL UNIQUE,
        fingerprint TEXT NOT NULL,
        unit_id TEXT NOT NULL,
        panel_id TEXT NOT NULL
      );
      CREATE TABLE studio_generation_pack_targets (
        pack_id TEXT NOT NULL,
        pack_fingerprint TEXT NOT NULL,
        target_kind TEXT NOT NULL,
        unit_id TEXT NOT NULL
      );
      CREATE TABLE studio_generation_plans (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        plan_id TEXT NOT NULL UNIQUE
      );
      CREATE TABLE studio_generation_plan_nodes (
        plan_id TEXT NOT NULL,
        unit_id TEXT NOT NULL,
        panel_id TEXT NOT NULL,
        pack_id TEXT NOT NULL
      );
      CREATE TABLE studio_generation_plan_node_targets (
        plan_id TEXT NOT NULL,
        target_kind TEXT NOT NULL,
        target_key TEXT NOT NULL
      );
    `);
    const insertPack = db.prepare(
      "INSERT INTO studio_generation_packs(sequence, pack_id, fingerprint, unit_id, panel_id) VALUES(?, ?, ?, ?, ?)",
    );
    const insertPackTarget = db.prepare(
      "INSERT INTO studio_generation_pack_targets(pack_id, pack_fingerprint, target_kind, unit_id) VALUES(?, ?, 'unit-grid', ?)",
    );
    for (const pack of options.packs ?? []) {
      insertPack.run(pack.sequence ?? 1, pack.packId, FP, pack.unitId, pack.panelId);
      if (pack.unitGrid) insertPackTarget.run(pack.packId, FP, pack.unitId);
    }
    const insertPlan = db.prepare("INSERT INTO studio_generation_plans(plan_id) VALUES(?)");
    const insertNode = db.prepare(
      "INSERT INTO studio_generation_plan_nodes(plan_id, unit_id, panel_id, pack_id) VALUES(?, ?, ?, ?)",
    );
    const insertPlanTarget = db.prepare(
      "INSERT INTO studio_generation_plan_node_targets(plan_id, target_kind, target_key) VALUES(?, 'unit-grid', ?)",
    );
    for (const plan of options.panelPlans ?? []) {
      insertPlan.run(plan.planId);
      insertNode.run(plan.planId, plan.unitId, plan.panelId, plan.packId);
    }
    for (const plan of options.unitGridPlans ?? []) {
      insertPlan.run(plan.planId);
      insertPlanTarget.run(plan.planId, `unit-grid:${plan.unitId}`);
      if (plan.panelId && plan.packId) {
        insertNode.run(plan.planId, plan.unitId, plan.panelId, plan.packId);
      }
    }
  } finally {
    db.close();
  }
  return databasePath;
}

describe("单镜落盘计划只读", () => {
  it("缺库 / 空 id 失败关闭且不建文件", () => {
    const missing = path.join(os.tmpdir(), `panel-plan-missing-${Date.now()}.sqlite`);
    expect(readPersistedPanelHasPlan(missing, "u1", "p1")).toBe(false);
    expect(existsSync(missing)).toBe(false);
    expect(readPersistedPanelHasPlan("/tmp/x.sqlite", "  ", "p1")).toBe(false);
    expect(readPersistedPanelHasPlan("/tmp/x.sqlite", "u1", "")).toBe(false);
  });

  it("整板兼容 panel_id 不当单镜计划", async () => {
    const databasePath = await seedLedger({
      packs: [
        { unitId: "u-focus", packId: "pack-panel", panelId: "p-focus", sequence: 1, unitGrid: false },
        { unitId: "u-focus", packId: "pack-grid", panelId: "p-focus", sequence: 2, unitGrid: true },
        { unitId: "u-other", packId: "pack-other", panelId: "p-other", sequence: 3, unitGrid: false },
      ],
      panelPlans: [
        { unitId: "u-other", panelId: "p-other", planId: "plan-other", packId: "pack-other" },
      ],
      unitGridPlans: [
        { unitId: "u-focus", planId: "plan-grid", panelId: "p-focus", packId: "pack-grid" },
      ],
    });
    expect(readPersistedPanelHasPlan(databasePath, "u-focus", "p-focus")).toBe(false);
    expect(readPersistedUnitGridPackAndPlan(databasePath, "u-focus")).toEqual({
      packId: "pack-grid",
      hasPlan: true,
    });
  });

  it("本格单镜 plan 才 hasPlan", async () => {
    const databasePath = await seedLedger({
      packs: [
        { unitId: "u-focus", packId: "pack-panel", panelId: "p-focus", sequence: 1, unitGrid: false },
        { unitId: "u-focus", packId: "pack-grid", panelId: "p-focus", sequence: 2, unitGrid: true },
      ],
      panelPlans: [
        { unitId: "u-focus", panelId: "p-focus", planId: "plan-panel", packId: "pack-panel" },
      ],
      unitGridPlans: [
        { unitId: "u-focus", planId: "plan-grid", panelId: "p-focus", packId: "pack-grid" },
      ],
    });
    expect(readPersistedPanelHasPlan(databasePath, "u-focus", "p-focus")).toBe(true);
    expect(readPersistedPanelHasPlan(databasePath, "u-focus", "p-missing")).toBe(false);
  });

  it("sidecar 路径只拼已知相对段", () => {
    expect(generationLedgerSidecarPath("/tmp/iso")).toBe(
      path.join("/tmp/iso", ".aicanvas", "studio-generation-ledger.sqlite"),
    );
    expect(panelPlanTargetKey("u1", "p1")).toBe("panel:u1:p1");
  });
});

describe("已有计划时人机同下一步源码合同", () => {
  it("草稿薄模块仍不读库、不执行", () => {
    const draft = source("src/core/studio-generation-plan-draft.ts");
    expect(draft).toContain("hasPersistedPlan");
    expect(draft).toContain(STUDIO_GENERATION_PLAN_ALREADY_EXISTS_PANEL);
    expect(draft).toContain(STUDIO_GENERATION_PLAN_COMMAND);
    expect(draft).not.toContain("node:sqlite");
    expect(draft).not.toContain("studio-script-media-align");
    expect(draft).not.toContain("execute_command");
    expect(draft).not.toContain("dispatch_studio_generation_pack");
    expect(composeStudioGenerationPlanDraft({
      focusUnitId: "u1",
      focusPanelId: "p1",
      focusPackId: "pack-1",
      hasPersistedPlan: true,
    }).dispatch).toBe(false);
  });

  it("薄读模块只读开库，不拉对照板 / 可写账本", () => {
    const text = source("src/core/studio-unit-grid-persisted-plan-read.ts");
    expect(text).toContain("readPersistedPanelHasPlan");
    expect(text).toContain("generationLedgerSidecarPath");
    expect(text).toContain("t.pack_id IS NULL");
    expect(text).toContain("LIMIT 1");
    expect(text).not.toContain("studio-generation-ledger.js");
    expect(text).not.toContain("studio-ssl5-missing-to-gen");
    expect(text).not.toContain("managedLedgerPaths");
    expect(text).not.toMatch(/openDatabase\s*\(/u);
    expect(text).not.toContain("dispatch_studio_generation_pack");
    expect(text).not.toContain("create_studio_generation_plan");
    expect(text).not.toContain("CREATE TABLE");
  });

  it("SSL-5 / session-snapshot / 生成控制只精炼焦点或当前格", () => {
    const ssl5 = source("src/core/studio-ssl5-missing-to-gen.ts");
    const snapshot = source("src/core/studio-generation-session-snapshot.ts");
    const control = source("src/renderer/src/components/StudioGenerationControlView.vue");
    expect(ssl5).toContain("refineSsl5FocusPlanDraftIfPersisted");
    expect(ssl5).toContain("readPersistedPanelHasPlan");
    expect(ssl5).toContain("generationLedgerSidecarPath");
    expect(ssl5.match(/readPersistedPanelHasPlan\(/g)?.length).toBe(1);
    expect(ssl5).not.toContain("studio-generation-ledger.js");
    expect(snapshot).toContain("hasPersistedPlan");
    expect(snapshot).toContain("readPersistedPanelHasPlan");
    expect(snapshot).toContain("readPersistedUnitGridPackAndPlan");
    expect(snapshot).not.toContain("studio-ssl5-missing-to-gen");
    expect(snapshot).not.toContain("studio-script-media-align");
    expect(control).toContain("hasPersistedPlanForDraft");
    expect(control).toContain('node.targetKind === "panel"');
    expect(control).not.toContain("dispatch_studio_generation_pack");
  });
});
