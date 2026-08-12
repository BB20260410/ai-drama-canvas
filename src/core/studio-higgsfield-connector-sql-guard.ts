import { DatabaseSync } from "node:sqlite";

export type StudioHiggsfieldConnectorSqlGuardReason =
  | "formal-dispatch-missing"
  | "formal-dispatch-provider-mismatch"
  | "formal-pack-missing"
  | "formal-call-intent-exists"
  | "formal-run-not-dispatched"
  | "formal-run-has-results"
  | "connector-reservation-active";

const FORMAL_RUN_BOUND_CONNECTOR_STATUSES = [
  "authorized",
  "submitted",
  "submission_unknown",
  "succeeded",
  "failed",
  "cancelled",
] as const;

/** Shared by transaction and public preflight: queued/claimed remain reclaimable, all other owner/terminal states bind the formal run. */
export function isStudioHiggsfieldConnectorFormalRunBoundStatus(status: string): boolean {
  return (FORMAL_RUN_BOUND_CONNECTOR_STATUSES as readonly string[]).includes(status);
}

export class StudioHiggsfieldConnectorSqlGuardError extends Error {
  readonly reason: StudioHiggsfieldConnectorSqlGuardReason;

  constructor(reason: StudioHiggsfieldConnectorSqlGuardReason, message: string) {
    super(message);
    this.name = "StudioHiggsfieldConnectorSqlGuardError";
    this.reason = reason;
  }
}

function tableExists(db: DatabaseSync, name: string): boolean {
  return Boolean(db.prepare(
    "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
  ).get(name));
}

/**
 * authorize 的事务内 formal owner 终检。调用方必须已经持有同一 generation
 * ledger 的 BEGIN IMMEDIATE；本函数只读 SQL，不创建表、不提交事务。
 */
export function assertStudioHiggsfieldFormalRunAuthorizable(
  db: DatabaseSync,
  generationRunId: string,
): void {
  const dispatch = db.prepare(`
    SELECT
      dispatch.executor_provider AS executorProvider,
      dispatch.pack_id AS packId,
      pack.pack_id AS existingPackId
    FROM studio_generation_dispatches dispatch
    LEFT JOIN studio_generation_packs pack
      ON pack.pack_id = dispatch.pack_id
      AND pack.fingerprint = dispatch.pack_fingerprint
    WHERE dispatch.generation_run_id = ?
    LIMIT 1
  `).get(generationRunId) as {
    executorProvider: string;
    packId: string;
    existingPackId: string | null;
  } | undefined;
  if (!dispatch) {
    throw new StudioHiggsfieldConnectorSqlGuardError(
      "formal-dispatch-missing",
      `generationRunId=${generationRunId} 缺少 formal dispatch，禁止授权 Higgsfield connector。`,
    );
  }
  if (dispatch.executorProvider !== "codex") {
    throw new StudioHiggsfieldConnectorSqlGuardError(
      "formal-dispatch-provider-mismatch",
      `generationRunId=${generationRunId} 的 formal dispatch provider 不是 codex，禁止授权 Higgsfield connector。`,
    );
  }
  if (!dispatch.existingPackId) {
    throw new StudioHiggsfieldConnectorSqlGuardError(
      "formal-pack-missing",
      `generationRunId=${generationRunId} 的 formal pack ${dispatch.packId} 不存在，禁止授权 Higgsfield connector。`,
    );
  }

  const existingCallIntent = db.prepare(`
    SELECT call_id AS callId
    FROM studio_generation_call_intents
    WHERE generation_run_id = ?
    LIMIT 1
  `).get(generationRunId) as { callId: string } | undefined;
  if (existingCallIntent) {
    throw new StudioHiggsfieldConnectorSqlGuardError(
      "formal-call-intent-exists",
      `generationRunId=${generationRunId} 已绑定 Codex call intent ${existingCallIntent.callId}，禁止再授权第二个执行 owner。`,
    );
  }

  const latestRunEvent = db.prepare(`
    SELECT kind
    FROM studio_generation_run_events
    WHERE generation_run_id = ?
    ORDER BY sequence DESC
    LIMIT 1
  `).get(generationRunId) as { kind: string } | undefined;
  if (latestRunEvent?.kind !== "dispatched") {
    throw new StudioHiggsfieldConnectorSqlGuardError(
      "formal-run-not-dispatched",
      `generationRunId=${generationRunId} 的 formal run 最新状态不是 dispatched，禁止授权 Higgsfield connector。`,
    );
  }

  const resultCount = Number((db.prepare(`
    SELECT COUNT(*) AS count
    FROM studio_generation_results
    WHERE generation_run_id = ?
  `).get(generationRunId) as { count: number }).count);
  if (resultCount !== 0) {
    throw new StudioHiggsfieldConnectorSqlGuardError(
      "formal-run-has-results",
      `generationRunId=${generationRunId} 已有 ${resultCount} 条 formal result，禁止授权 Higgsfield connector。`,
    );
  }
}

/**
 * formal prepare/terminal/result/retry 的事务内 connector 终检。旧 ledger 没有 connector
 * 扩展表时直接放行；存在时，每个 request 只采用最大 revision/sequence 的最新事件。
 * connector 的全局并发槽只由 in-flight 状态占用。latest status 为
 * authorized/submitted/submission_unknown/remote terminal 时，connector 绑定同一
 * formal run，formal owner 不得接管；queued/claimed 仍允许 formal owner 继续，claimed 租约回收到 queued 后该绑定同样解除。远端 terminal
 * 历史保留为最新状态时则持续绑定该 run，即使它已经释放全局槽位。
 */
export function assertNoActiveStudioHiggsfieldConnectorReservationInTransaction(
  db: DatabaseSync,
  generationRunId: string,
): void {
  if (!tableExists(db, "studio_higgsfield_connector_request_events")) return;
  const active = db.prepare(`
    SELECT latest.request_id AS requestId, latest.status
    FROM studio_higgsfield_connector_request_events latest
    WHERE latest.image_generation_run_id = ?
      AND latest.sequence = (
        SELECT candidate.sequence
        FROM studio_higgsfield_connector_request_events candidate
        WHERE candidate.request_id = latest.request_id
        ORDER BY candidate.revision DESC, candidate.sequence DESC
        LIMIT 1
      )
      AND latest.status IN (${FORMAL_RUN_BOUND_CONNECTOR_STATUSES.map((status) => `'${status}'`).join(",")})
    ORDER BY latest.sequence DESC
    LIMIT 1
  `).get(generationRunId) as { requestId: string; status: string } | undefined;
  if (active) {
    throw new StudioHiggsfieldConnectorSqlGuardError(
      "connector-reservation-active",
      `generationRunId=${generationRunId} 已被 Higgsfield connector 请求 ${active.requestId} 绑定（${active.status}）；formal owner 不得接管该 run。`,
    );
  }
}
