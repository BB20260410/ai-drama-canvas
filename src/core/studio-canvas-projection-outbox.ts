/**
 * T11 Outbox 原子画布更新：canvas_projection_event 可重放事件。
 *
 * 结果入账事务同时提交 canvas_projection_event；
 * 提交后才通知界面；通知丢失可重放；重启自动恢复未消费事件；
 * 画布按 projectionRevision 幂等应用；前端刷新不丢正式节点。
 *
 * 接入方式（2026-07 T11 实接）：
 * - 表由 ledger openDatabase 在 assertCurrentSchema 后幂等 ensure（同 review/continuity
 *   扩展表模式：独立 ensure，不进 core-owned schema_version 断言集，老库无表演进、
 *   既有表与 generation ledger schema_version 不受影响）。
 * - raw/labeled 入账在 ledger 同一 runTransaction 内追加（严格同事务）。
 * - Review/连续性表因各自 owner 模块的 schema 合同禁止外挂 trigger，且 owner 文件
 *   不在可改范围，故事件由包装层（main reconcile/replay）补缀：
 *   eventId 由源事实派生（review-updated:<reviewId> / continuity-updated:<entryId>），
 *   INSERT OR IGNORE 幂等，重启 reconcile 兜底最终一致。
 */
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";

export const CANVAS_PROJECTION_EVENT_SCHEMA_VERSION = 1 as const;

/** 画布投影事件类型。 */
export type CanvasProjectionEventKind =
  | "result-committed"
  | "review-updated"
  | "unit-state-changed"
  | "continuity-updated";

export interface CanvasProjectionEvent {
  eventId: string;
  /** 单调递增投影修订号（画布幂等消费）。 */
  projectionRevision: number;
  kind: CanvasProjectionEventKind;
  unitId: string;
  panelId?: string;
  generationRunId?: string;
  /** 事件负载（JSON 可序列化）。 */
  payload: Record<string, unknown>;
  /** 是否已被画布消费。 */
  consumed: boolean;
  createdAt: string;
}

/** DDL：在既有 ledger 数据库内创建 outbox 表（幂等）。 */
export function ensureCanvasProjectionOutboxSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS studio_canvas_projection_outbox (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      projection_revision INTEGER NOT NULL UNIQUE,
      kind TEXT NOT NULL CHECK(kind IN ('result-committed','review-updated','unit-state-changed','continuity-updated')),
      unit_id TEXT NOT NULL,
      panel_id TEXT,
      generation_run_id TEXT,
      payload_json TEXT NOT NULL DEFAULT '{}',
      consumed INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_canvas_outbox_unconsumed
      ON studio_canvas_projection_outbox(consumed, sequence)
      WHERE consumed = 0;
    CREATE INDEX IF NOT EXISTS idx_canvas_outbox_unit
      ON studio_canvas_projection_outbox(unit_id, sequence);
  `);
  // 跟随 ledger append-only trigger 风格：事件事实列不可改写、不可删除；
  // 仅 consumed 消费标记允许 UPDATE（消费方幂等推进的必要写入）。
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS studio_canvas_projection_outbox_no_update
      BEFORE UPDATE OF event_id, projection_revision, kind, unit_id, panel_id, generation_run_id, payload_json
      ON studio_canvas_projection_outbox
      BEGIN SELECT RAISE(ABORT, 'canvas projection outbox events are immutable except consumed flag'); END;
    CREATE TRIGGER IF NOT EXISTS studio_canvas_projection_outbox_no_delete
      BEFORE DELETE ON studio_canvas_projection_outbox
      BEGIN SELECT RAISE(ABORT, 'canvas projection outbox events are append-only'); END;
  `);
}

function outboxTableExists(db: DatabaseSync): boolean {
  return Boolean(db.prepare(
    "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'studio_canvas_projection_outbox'",
  ).get());
}

/** 获取当前最大 projectionRevision（用于递增）。 */
function latestProjectionRevision(db: DatabaseSync): number {
  const row = db.prepare(
    "SELECT MAX(projection_revision) AS max_rev FROM studio_canvas_projection_outbox",
  ).get() as { max_rev?: number | null } | undefined;
  return row?.max_rev ?? 0;
}

/**
 * 在同一事务内追加画布投影事件（由结果入账/Review 更新调用方在事务内调用）。
 * 返回新事件的 projectionRevision。
 * 调用方必须已持有写事务（BEGIN IMMEDIATE），保证 MAX+1 序号分配串行。
 */
export function appendCanvasProjectionEvent(
  db: DatabaseSync,
  input: {
    kind: CanvasProjectionEventKind;
    unitId: string;
    panelId?: string;
    generationRunId?: string;
    payload?: Record<string, unknown>;
  },
): { eventId: string; projectionRevision: number } {
  ensureCanvasProjectionOutboxSchema(db);
  const projectionRevision = latestProjectionRevision(db) + 1;
  const eventId = createHash("sha256")
    .update(JSON.stringify({ kind: input.kind, unitId: input.unitId, panelId: input.panelId, generationRunId: input.generationRunId, projectionRevision }))
    .digest("hex");
  db.prepare(`
    INSERT OR IGNORE INTO studio_canvas_projection_outbox
      (event_id, projection_revision, kind, unit_id, panel_id, generation_run_id, payload_json, consumed)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0)
  `).run(
    eventId,
    projectionRevision,
    input.kind,
    input.unitId,
    input.panelId ?? null,
    input.generationRunId ?? null,
    JSON.stringify(input.payload ?? {}),
  );
  return { eventId, projectionRevision };
}

/**
 * 幂等追加：eventId 由调用方从源事实派生（如 review-updated:<reviewId>）。
 * 同一源事实重复补缀不产生重复事件（INSERT OR IGNORE）。
 * 用于 Review/连续性包装层与启动 reconcile；调用方必须已持有写事务。
 */
export function appendCanvasProjectionEventIfAbsent(
  db: DatabaseSync,
  input: {
    eventId: string;
    kind: CanvasProjectionEventKind;
    unitId: string;
    panelId?: string;
    generationRunId?: string;
    payload?: Record<string, unknown>;
  },
): { eventId: string; projectionRevision: number; inserted: boolean } {
  ensureCanvasProjectionOutboxSchema(db);
  const existing = db.prepare(
    "SELECT projection_revision AS revision FROM studio_canvas_projection_outbox WHERE event_id = ?",
  ).get(input.eventId) as { revision?: number } | undefined;
  if (existing?.revision !== undefined) {
    return { eventId: input.eventId, projectionRevision: Number(existing.revision), inserted: false };
  }
  const projectionRevision = latestProjectionRevision(db) + 1;
  const result = db.prepare(`
    INSERT OR IGNORE INTO studio_canvas_projection_outbox
      (event_id, projection_revision, kind, unit_id, panel_id, generation_run_id, payload_json, consumed)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0)
  `).run(
    input.eventId,
    projectionRevision,
    input.kind,
    input.unitId,
    input.panelId ?? null,
    input.generationRunId ?? null,
    JSON.stringify(input.payload ?? {}),
  );
  return { eventId: input.eventId, projectionRevision, inserted: Number(result.changes) > 0 };
}

/**
 * 读取未消费事件（重启恢复 / 通知丢失重放）。
 * 按 sequence 升序，最多 limit 条。
 */
export function readUnconsumedCanvasProjectionEvents(
  db: DatabaseSync,
  limit = 100,
): CanvasProjectionEvent[] {
  ensureCanvasProjectionOutboxSchema(db);
  const rows = db.prepare(`
    SELECT * FROM studio_canvas_projection_outbox
    WHERE consumed = 0
    ORDER BY sequence ASC
    LIMIT ?
  `).all(limit) as Array<{
    event_id: string;
    projection_revision: number;
    kind: string;
    unit_id: string;
    panel_id: string | null;
    generation_run_id: string | null;
    payload_json: string;
    consumed: number;
    created_at: string;
  }>;
  return rows.map((row) => ({
    eventId: row.event_id,
    projectionRevision: row.projection_revision,
    kind: row.kind as CanvasProjectionEventKind,
    unitId: row.unit_id,
    panelId: row.panel_id ?? undefined,
    generationRunId: row.generation_run_id ?? undefined,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    consumed: Boolean(row.consumed),
    createdAt: row.created_at,
  }));
}

/**
 * 标记事件已消费（画布幂等应用后调用）。
 * 按 projectionRevision 标记，确保幂等。
 */
export function markCanvasProjectionEventsConsumed(
  db: DatabaseSync,
  upToProjectionRevision: number,
): number {
  ensureCanvasProjectionOutboxSchema(db);
  const result = db.prepare(`
    UPDATE studio_canvas_projection_outbox
    SET consumed = 1
    WHERE consumed = 0 AND projection_revision <= ?
  `).run(upToProjectionRevision);
  return Number(result.changes);
}

// ---------------------------------------------------------------------------
// 消费方：按 projectionRevision 幂等应用，重复事件不产生重复节点。
// ---------------------------------------------------------------------------

export type CanvasProjectionApplyStatus = "applied" | "skipped-duplicate-revision" | "upserted-node";

export interface CanvasProjectionAppliedNode {
  nodeKey: string;
  kind: CanvasProjectionEventKind;
  unitId: string;
  projectionRevision: number;
  eventId: string;
}

export interface CanvasProjectionEventApplier {
  /** 应用单条事件；同一 projectionRevision 重放跳过，同一逻辑节点 upsert。 */
  apply(event: CanvasProjectionEvent): CanvasProjectionApplyStatus;
  /** 已应用节点表（key 稳定，重放不膨胀）。 */
  nodes(): ReadonlyMap<string, CanvasProjectionAppliedNode>;
  /** 已应用的 projectionRevision 集合。 */
  appliedRevisions(): ReadonlySet<number>;
}

/** 从事件推导稳定逻辑节点 key（同节点重复事件覆盖而非新增）。 */
function canvasProjectionNodeKey(event: CanvasProjectionEvent): string {
  const payload = event.payload;
  switch (event.kind) {
    case "result-committed":
      return `result:${event.unitId}:${event.generationRunId ?? String(payload.resultId ?? event.eventId)}`;
    case "review-updated":
      return `review:${event.unitId}:${String(payload.reviewId ?? event.generationRunId ?? event.eventId)}`;
    case "unit-state-changed":
      return `unit-state:${event.unitId}`;
    case "continuity-updated":
      return `continuity:${event.unitId}:${String(payload.entryId ?? payload.headKey ?? event.eventId)}`;
  }
}

/**
 * 参考幂等消费方（main 进程启动重放与测试共用）：
 * - revision 守卫：已应用的 projectionRevision 直接跳过；
 * - 节点守卫：同一逻辑节点（key 稳定）upsert，重复事件不产生重复节点。
 */
export function createCanvasProjectionEventApplier(): CanvasProjectionEventApplier {
  const revisions = new Set<number>();
  const nodeMap = new Map<string, CanvasProjectionAppliedNode>();
  return {
    apply(event) {
      if (revisions.has(event.projectionRevision)) return "skipped-duplicate-revision";
      revisions.add(event.projectionRevision);
      const nodeKey = canvasProjectionNodeKey(event);
      const node: CanvasProjectionAppliedNode = {
        nodeKey,
        kind: event.kind,
        unitId: event.unitId,
        projectionRevision: event.projectionRevision,
        eventId: event.eventId,
      };
      if (nodeMap.has(nodeKey)) {
        nodeMap.set(nodeKey, node);
        return "upserted-node";
      }
      nodeMap.set(nodeKey, node);
      return "applied";
    },
    nodes: () => nodeMap,
    appliedRevisions: () => revisions,
  };
}

export interface CanvasProjectionReplayResult {
  /** 本次成功应用的事件数。 */
  applied: number;
  /** 本次新标记消费的事件数。 */
  consumed: number;
  /** 首个 apply 失败消息（失败即停，后续事件保持未消费）。 */
  error: string | null;
}

/**
 * 重放未消费事件：按 sequence（即 projectionRevision）升序逐条应用，
 * 每批成功后按最大已应用 revision 标记消费；任一条失败即停，
 * 失败及其后事件保持未消费，等待下次重放（重启恢复语义）。
 */
export function replayUnconsumedCanvasProjectionEvents(
  db: DatabaseSync,
  apply: (event: CanvasProjectionEvent) => unknown,
  options: { batchSize?: number } = {},
): CanvasProjectionReplayResult {
  ensureCanvasProjectionOutboxSchema(db);
  const batchSize = Math.max(1, Math.min(500, Math.trunc(options.batchSize ?? 100)));
  let applied = 0;
  let consumed = 0;
  let error: string | null = null;
  for (;;) {
    const events = readUnconsumedCanvasProjectionEvents(db, batchSize);
    if (events.length === 0) break;
    let batchMaxRevision = 0;
    for (const event of events) {
      try {
        apply(event);
        applied += 1;
        batchMaxRevision = Math.max(batchMaxRevision, event.projectionRevision);
      } catch (reason) {
        error = reason instanceof Error ? reason.message : String(reason);
        break;
      }
    }
    if (batchMaxRevision > 0) {
      consumed += markCanvasProjectionEventsConsumed(db, batchMaxRevision);
    }
    if (error || events.length < batchSize) break;
  }
  return { applied, consumed, error };
}

// ---------------------------------------------------------------------------
// 补缀：Review / 连续性事实 → outbox 事件（幂等，启动与命令后包装层调用）。
// ---------------------------------------------------------------------------

export interface CanvasProjectionReconcileResult {
  reviewAppended: number;
  continuityAppended: number;
  /** 源事实缺 unit 归属而跳过的条数（防御，正常为 0）。 */
  skipped: number;
}

function reconcileTableExists(db: DatabaseSync, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

/**
 * 扫描 Review heads 与连续性 heads，把缺失的源事实补缀为 outbox 事件。
 * eventId 由源事实派生，重复执行/重启恢复均幂等；整个扫描在单个写事务内完成。
 *
 * 取舍说明：Review/连续性 owner 模块（studio-generation-review.ts /
 * studio-continuity-ledger.ts）的 schema 合同按 tbl_name 捕获外挂 trigger，
 * 且文件不在可改范围，无法做到与源写入同一 SQLite 事务；此处以
 * "派生 eventId + INSERT OR IGNORE + 启动/命令后 reconcile" 实现最终一致，
 * 崩溃窗口由重启 reconcile 兜底闭合。
 */
export function reconcileCanvasProjectionOutbox(db: DatabaseSync): CanvasProjectionReconcileResult {
  ensureCanvasProjectionOutboxSchema(db);
  const hasReview = reconcileTableExists(db, "studio_generation_review_heads")
    && reconcileTableExists(db, "studio_generation_review_events")
    && reconcileTableExists(db, "studio_generation_dispatches")
    && reconcileTableExists(db, "studio_generation_packs");
  const hasContinuity = reconcileTableExists(db, "studio_continuity_heads")
    && reconcileTableExists(db, "studio_continuity_entries");

  let reviewAppended = 0;
  let continuityAppended = 0;
  let skipped = 0;

  db.exec("BEGIN IMMEDIATE");
  try {
    if (hasReview) {
      const rows = db.prepare(`
        SELECT e.review_id AS reviewId,
               e.generation_run_id AS generationRunId,
               e.decision AS decision,
               e.created_at AS createdAt,
               p.unit_id AS unitId,
               p.panel_id AS panelId
        FROM studio_generation_review_heads h
        JOIN studio_generation_review_events e ON e.review_id = h.review_id
        LEFT JOIN studio_generation_dispatches d ON d.generation_run_id = e.generation_run_id
        LEFT JOIN studio_generation_packs p
          ON p.pack_id = d.pack_id AND p.fingerprint = d.pack_fingerprint
        ORDER BY e.sequence ASC
      `).all() as Array<{
        reviewId: string;
        generationRunId: string;
        decision: string;
        createdAt: string;
        unitId: string | null;
        panelId: string | null;
      }>;
      for (const row of rows) {
        if (!row.unitId) {
          skipped += 1;
          continue;
        }
        const appended = appendCanvasProjectionEventIfAbsent(db, {
          eventId: `review-updated:${row.reviewId}`,
          kind: "review-updated",
          unitId: row.unitId,
          ...(row.panelId ? { panelId: row.panelId } : {}),
          generationRunId: row.generationRunId,
          payload: {
            reviewId: row.reviewId,
            decision: row.decision,
            reviewedAt: row.createdAt,
            source: "reconcile",
          },
        });
        if (appended.inserted) reviewAppended += 1;
      }
    }
    if (hasContinuity) {
      const rows = db.prepare(`
        SELECT e.entry_id AS entryId,
               e.unit_id AS unitId,
               e.entry_kind AS entryKind,
               e.field AS field,
               e.subject_id AS subjectId,
               e.created_at AS createdAt
        FROM studio_continuity_heads h
        JOIN studio_continuity_entries e ON e.entry_id = h.entry_id
        ORDER BY e.sequence ASC
      `).all() as Array<{
        entryId: string;
        unitId: string;
        entryKind: string;
        field: string;
        subjectId: string;
        createdAt: string;
      }>;
      for (const row of rows) {
        const appended = appendCanvasProjectionEventIfAbsent(db, {
          eventId: `continuity-updated:${row.entryId}`,
          kind: "continuity-updated",
          unitId: row.unitId,
          payload: {
            entryId: row.entryId,
            entryKind: row.entryKind,
            field: row.field,
            subjectId: row.subjectId,
            observedAt: row.createdAt,
            source: "reconcile",
          },
        });
        if (appended.inserted) continuityAppended += 1;
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { reviewAppended, continuityAppended, skipped };
}
