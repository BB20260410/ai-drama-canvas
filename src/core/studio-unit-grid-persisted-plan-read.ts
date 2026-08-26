/**
 * 只读：单个 unit 是否已有落盘 unit-grid pack / 生成计划。
 * 给 earliest 人机同下一步用。不走 managedLedgerPaths / 可写 openDatabase。
 * 禁止全槽位扫描。缺库/缺表失败关闭为「无 pack、无计划」，不建库。
 */
import { openGenerationLedgerReadOnly } from "./studio-generation-ledger-readiness.js";

export type PersistedUnitGridPackAndPlan = {
  packId: string | null;
  hasPlan: boolean;
};

const EMPTY: PersistedUnitGridPackAndPlan = { packId: null, hasPlan: false };

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
