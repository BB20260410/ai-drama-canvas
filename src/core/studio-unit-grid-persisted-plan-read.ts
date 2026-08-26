/**
 * 只读：单个 unit / 单镜是否已有落盘 pack / 生成计划。
 * 给 earliest / SSL-5 / session-snapshot 人机同下一步用。
 * 不走可写账本路径 / 可写开库。禁止全槽位扫描。
 * 缺库/缺表失败关闭为「无 pack、无计划」，不建库。
 */
import path from "node:path";
import { openGenerationLedgerReadOnly } from "./studio-generation-ledger-readiness.js";

export type PersistedUnitGridPackAndPlan = {
  packId: string | null;
  hasPlan: boolean;
};

const EMPTY: PersistedUnitGridPackAndPlan = { packId: null, hasPlan: false };
const LEDGER_RELATIVE = path.join(".aicanvas", "studio-generation-ledger.sqlite");

/** 只拼已知 sidecar 相对路径；不 ensure、不建库。 */
export function generationLedgerSidecarPath(projectRoot: string): string {
  return path.join(projectRoot, LEDGER_RELATIVE);
}

const LATEST_UNIT_GRID_PACK_SQL = `
  SELECT p.pack_id AS packId
  FROM studio_generation_packs p
  INNER JOIN studio_generation_pack_targets t
    ON t.pack_id = p.pack_id
   AND t.pack_fingerprint = p.fingerprint
  WHERE p.unit_id = ?
    AND t.target_kind = 'unit-grid'
    AND t.unit_id = ?
  ORDER BY p.sequence DESC
  LIMIT 1
`;

const LATEST_UNIT_GRID_PLAN_SQL = `
  SELECT p.plan_id AS planId
  FROM studio_generation_plans p
  INNER JOIN studio_generation_plan_node_targets target
    ON target.plan_id = p.plan_id
  WHERE target.target_kind = 'unit-grid'
    AND target.target_key = ?
  ORDER BY p.sequence DESC
  LIMIT 1
`;

export function unitGridPlanTargetKey(unitId: string): string {
  return `unit-grid:${unitId}`;
}

export function panelPlanTargetKey(unitId: string, panelId: string): string {
  return `panel:${unitId}:${panelId}`;
}

/**
 * 单镜计划：plan_nodes 指向无 pack_targets 的单镜 pack。
 * 整板 plan 会把兼容 panel_id 写进 plan_nodes，必须用 pack_targets 排除，不能当单镜计划。
 */
const LATEST_PANEL_PLAN_SQL = `
  SELECT p.plan_id AS planId
  FROM studio_generation_plans p
  INNER JOIN studio_generation_plan_nodes n
    ON n.plan_id = p.plan_id
  INNER JOIN studio_generation_packs pack
    ON pack.pack_id = n.pack_id
  LEFT JOIN studio_generation_pack_targets t
    ON t.pack_id = pack.pack_id
   AND t.pack_fingerprint = pack.fingerprint
  WHERE n.unit_id = ?
    AND n.panel_id = ?
    AND t.pack_id IS NULL
  ORDER BY p.sequence DESC
  LIMIT 1
`;

/**
 * 一次只读开库，查一个宫格是否已有单镜 plan。
 * 整板 plan / 缺库 / 缺表失败关闭为 false，不建库。
 */
export function readPersistedPanelHasPlan(
  databasePath: string,
  unitId: string,
  panelId: string,
): boolean {
  const normalizedUnit = unitId.trim();
  const normalizedPanel = panelId.trim();
  if (!normalizedUnit || !normalizedPanel || !databasePath.trim()) return false;
  let db: ReturnType<typeof openGenerationLedgerReadOnly> | undefined;
  try {
    db = openGenerationLedgerReadOnly(databasePath);
    const plan = db.prepare(LATEST_PANEL_PLAN_SQL).get(normalizedUnit, normalizedPanel) as
      | { planId?: string }
      | undefined;
    return typeof plan?.planId === "string" && Boolean(plan.planId);
  } catch {
    return false;
  } finally {
    db?.close();
  }
}

/**
 * 一次只读开库，查一个 unit 的最新 unit-grid pack 与是否已有 plan。
 * 单镜 pack（无 pack_targets 行）不当整板 pack。
 */
export function readPersistedUnitGridPackAndPlan(
  databasePath: string,
  unitId: string,
): PersistedUnitGridPackAndPlan {
  const normalized = unitId.trim();
  if (!normalized || !databasePath.trim()) return EMPTY;
  let db: ReturnType<typeof openGenerationLedgerReadOnly> | undefined;
  try {
    db = openGenerationLedgerReadOnly(databasePath);
    const pack = db.prepare(LATEST_UNIT_GRID_PACK_SQL).get(normalized, normalized) as
      | { packId?: string }
      | undefined;
    const plan = db.prepare(LATEST_UNIT_GRID_PLAN_SQL).get(unitGridPlanTargetKey(normalized)) as
      | { planId?: string }
      | undefined;
    return {
      packId: typeof pack?.packId === "string" && pack.packId ? pack.packId : null,
      hasPlan: typeof plan?.planId === "string" && Boolean(plan.planId),
    };
  } catch {
    return EMPTY;
  } finally {
    db?.close();
  }
}
