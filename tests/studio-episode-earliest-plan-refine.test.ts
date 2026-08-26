import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  formatStudioEpisodeEarliestStatusLine,
  refineEarliestReadyToFreezeSlot,
  type StudioEpisodeUnitSlotProjection,
} from "../src/core/studio-episode-earliest.js";
import {
  readPersistedUnitGridPackAndPlan,
  unitGridPlanTargetKey,
} from "../src/core/studio-unit-grid-persisted-plan-read.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = (relative: string) => readFileSync(path.join(root, relative), "utf8");

const FP = "a".repeat(64);

let tempRoot: string | undefined;

afterEach(async () => {
  if (!tempRoot) return;
  await rm(tempRoot, { recursive: true, force: true });
  tempRoot = undefined;
});

function freezeSlot(unitId: string): StudioEpisodeUnitSlotProjection {
  return {
    unitId,
    sequence: 1,
    title: unitId,
    revision: 1,
    formalCommitted: false,
    reviewDecision: null,
    generationRunId: null,
    phase: "ready-to-freeze",
    code: "freeze-unit-grid",
    label: "冻结 unit-grid 生图包",
  };
}

async function seedLedger(options: {
  packs?: Array<{ unitId: string; packId: string; sequence?: number; unitGrid?: boolean }>;
  plans?: Array<{ unitId: string; planId: string }>;
}): Promise<string> {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), "earliest-plan-refine-"));
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
        unit_id TEXT NOT NULL
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
      CREATE TABLE studio_generation_plan_node_targets (
        plan_id TEXT NOT NULL,
        target_kind TEXT NOT NULL,
        target_key TEXT NOT NULL
      );
    `);
    const insertPack = db.prepare(
      "INSERT INTO studio_generation_packs(sequence, pack_id, fingerprint, unit_id) VALUES(?, ?, ?, ?)",
    );
    const insertTarget = db.prepare(
      "INSERT INTO studio_generation_pack_targets(pack_id, pack_fingerprint, target_kind, unit_id) VALUES(?, ?, 'unit-grid', ?)",
    );
    for (const pack of options.packs ?? []) {
      insertPack.run(pack.sequence ?? 1, pack.packId, FP, pack.unitId);
      if (pack.unitGrid !== false) insertTarget.run(pack.packId, FP, pack.unitId);
    }
    const insertPlan = db.prepare("INSERT INTO studio_generation_plans(plan_id) VALUES(?)");
    const insertPlanTarget = db.prepare(
      "INSERT INTO studio_generation_plan_node_targets(plan_id, target_kind, target_key) VALUES(?, 'unit-grid', ?)",
    );
    for (const plan of options.plans ?? []) {
      insertPlan.run(plan.planId);
      insertPlanTarget.run(plan.planId, unitGridPlanTargetKey(plan.unitId));
    }
  } finally {
    db.close();
  }
  return databasePath;
}

describe("earliest 人机同下一步：只精炼一个 pending 槽", () => {
  it("无 pack 保持 freeze；有 pack 无计划 → create-plan；有计划 → dispatch", () => {
    const freeze = freezeSlot("S1E2-U03");
    expect(refineEarliestReadyToFreezeSlot(freeze, { packId: null, hasPlan: false })).toEqual(freeze);
    const plan = refineEarliestReadyToFreezeSlot(freeze, { packId: "pack-grid", hasPlan: false });
    expect(plan.phase).toBe("ready-to-plan");
    expect(plan.code).toBe("create-unit-grid-plan");
    expect(plan.label).toContain("不派发");
    const dispatch = refineEarliestReadyToFreezeSlot(freeze, { packId: "pack-grid", hasPlan: true });
    expect(dispatch.phase).toBe("ready-to-dispatch");
    expect(dispatch.code).toBe("dispatch-unit-grid");
  });

  it("已 formal / 非 freeze 槽不改", () => {
    const approved = {
      ...freezeSlot("S1E2-U01"),
      formalCommitted: true,
      phase: "approved",
      code: "unit-grid-approved",
      label: "unit-grid 已通过审片，勿再 panel 级生图",
    };
    expect(refineEarliestReadyToFreezeSlot(approved, { packId: "pack", hasPlan: false })).toEqual(approved);
    const review = {
      ...freezeSlot("S1E2-U02"),
      phase: "pending-review",
      code: "submit-unit-grid-review",
      label: "raw/labeled 已齐，提交 unit-grid Review",
    };
    expect(refineEarliestReadyToFreezeSlot(review, { packId: "pack", hasPlan: true })).toEqual(review);
  });

  it("statusLine 带上 earliest 的 code/label", () => {
    expect(formatStudioEpisodeEarliestStatusLine({
      earliest: null,
      completedCount: 4,
      slotCount: 4,
    })).toBe("earliest：无待 formal 单元（列表内 4 齐）");
    expect(formatStudioEpisodeEarliestStatusLine({
      earliest: {
        unitId: "S1E2-U03",
        code: "create-unit-grid-plan",
        label: "建立 unit-grid 生成计划（不派发）",
      },
      completedCount: 2,
      slotCount: 6,
    })).toBe("earliest 下一步：S1E2-U03 create-unit-grid-plan（建立 unit-grid 生成计划（不派发））；已 formal 2/6");
  });
});

describe("单 unit 只读 pack+plan", () => {
  it("缺库失败关闭且不建文件", () => {
    const missing = path.join(os.tmpdir(), `earliest-missing-ledger-${Date.now()}.sqlite`);
    expect(readPersistedUnitGridPackAndPlan(missing, "S1E2-U03")).toEqual({
      packId: null,
      hasPlan: false,
    });
    expect(existsSync(missing)).toBe(false);
  });

  it("空 unitId 不查库", () => {
    expect(readPersistedUnitGridPackAndPlan("/tmp/does-not-matter.sqlite", "  ")).toEqual({
      packId: null,
      hasPlan: false,
    });
  });

  it("只认本 unit 的 unit-grid pack；单镜 pack 与其它 unit 忽略", async () => {
    const databasePath = await seedLedger({
      packs: [
        { unitId: "S1E2-U03", packId: "pack-panel", unitGrid: false },
        { unitId: "S1E2-U04", packId: "pack-other", unitGrid: true },
        { unitId: "S1E2-U03", packId: "pack-old", sequence: 2, unitGrid: true },
        { unitId: "S1E2-U03", packId: "pack-new", sequence: 9, unitGrid: true },
      ],
    });
    expect(readPersistedUnitGridPackAndPlan(databasePath, "S1E2-U03")).toEqual({
      packId: "pack-new",
      hasPlan: false,
    });
    expect(readPersistedUnitGridPackAndPlan(databasePath, "S1E2-U99")).toEqual({
      packId: null,
      hasPlan: false,
    });
  });

  it("本 unit 有 unit-grid 计划才 hasPlan", async () => {
    const databasePath = await seedLedger({
      packs: [{ unitId: "S1E2-U03", packId: "pack-grid", unitGrid: true }],
      plans: [
        { unitId: "S1E2-U04", planId: "plan-other" },
        { unitId: "S1E2-U03", planId: "plan-self" },
      ],
    });
    expect(readPersistedUnitGridPackAndPlan(databasePath, "S1E2-U03")).toEqual({
      packId: "pack-grid",
      hasPlan: true,
    });
  });
});

describe("earliest 源码合同：有界只读", () => {
  it("全槽位仍 hasCurrentPack=false；只对 earliest 一格只读查 pack/计划", () => {
    const text = source("src/core/studio-episode-earliest.ts");
    expect(text).toContain("hasCurrentPack: false");
    expect(text).toContain("readPersistedUnitGridPackAndPlan");
    expect(text).toContain("refineEarliestReadyToFreezeSlot");
    expect(text).toContain("formatStudioEpisodeEarliestStatusLine");
    expect(text).toContain("STUDIO_EPISODE_EARLIEST_SCHEMA_VERSION = 1");
    expect(text.match(/readPersistedUnitGridPackAndPlan\(/g)?.length).toBe(1);
    expect(text).not.toContain("listStudioGenerationPacksByUnit");
    expect(text).not.toContain("getStudioGenerationLatestPlanForUnitGrid");
    expect(text).not.toContain("managedLedgerPaths");
    expect(text).not.toMatch(/openDatabase\s*\(/u);
    expect(text).not.toContain("studio-generation-ledger.js");
    expect(text).not.toContain("listStudioProductionUnits");
    expect(text).not.toMatch(/getStudioProductionUnitSnapshot\s*\(/u);
    expect(text).not.toMatch(/inspectManagedProject\(/u);
    expect(text).not.toContain("dispatch_studio_generation_pack");
    expect(text).not.toContain("create_studio_generation_plan");
    expect(text).not.toContain("execute_command");
  });

  it("薄模块只读开库，不拉对照板 / 可写账本 / 驾驶舱", () => {
    const text = source("src/core/studio-unit-grid-persisted-plan-read.ts");
    expect(text).toContain("openGenerationLedgerReadOnly");
    expect(text).toContain("LIMIT 1");
    expect(text).toContain("target_kind = 'unit-grid'");
    expect(text).not.toContain("studio-generation-ledger.js");
    expect(text).not.toContain("studio-script-media-align");
    expect(text).not.toContain("studio-ssl5-missing-to-gen");
    expect(text).not.toContain("studio-production-dashboard");
    expect(text).not.toContain("managedLedgerPaths");
    expect(text).not.toMatch(/openDatabase\s*\(/u);
    expect(text).not.toContain("dispatch_studio_generation_pack");
    expect(text).not.toContain("create_studio_generation_plan");
    expect(text).not.toContain("journal_mode");
    expect(text).not.toContain("CREATE TABLE");
  });
});
