import { AsyncLocalStorage } from "node:async_hooks";

/**
 * SQLite busy_timeout 统一常量（对照 qmd 等本地优先实现的 120s 量级）。
 * 写路径高峰（生图回写/ledger）时 5s 过短易 SQLITE_BUSY。
 * 读路径可继续用较短 timeout；本常量面向写库。
 */
export const STUDIO_SQLITE_WRITE_BUSY_TIMEOUT_MS = 120_000;

/** 只读查询默认；保持较短以免 UI 假死 */
export const STUDIO_SQLITE_READ_BUSY_TIMEOUT_MS = 15_000;

/** busy 瞬时锁受控重试：最大尝试次数（含首次） */
export const STUDIO_SQLITE_BUSY_RETRY_MAX_ATTEMPTS = 3;

/** busy 瞬时锁受控重试：总预算上限（退避+执行总墙钟，超出即放弃） */
export const STUDIO_SQLITE_BUSY_RETRY_BUDGET_MS = 5_000;

/** busy 瞬时锁受控重试：指数退避基数 */
export const STUDIO_SQLITE_BUSY_RETRY_BASE_DELAY_MS = 120;

interface StudioSqliteBusyDeadlineContext {
  deadlineAtMs: number;
}

const studioSqliteBusyDeadlineContext = new AsyncLocalStorage<StudioSqliteBusyDeadlineContext>();

export type SqliteRetryProof =
  | { kind: "before_domain_execute" }
  | { kind: "atomic_transaction_rolled_back"; owner: string; operationId: string };

/**
 * 只有 owner 能证明整条 domain operation 尚未产生副作用时，才允许构造此错误。
 * 原始 SQLITE_BUSY/LOCKED 一律不是该类型，必须按 outcome_unknown 对账。
 */
export class RetrySafeSqliteBusyError extends Error {
  readonly code = "SQLITE_BUSY";
  readonly outcome = "retry_safe_no_effect";
  readonly retryProof: SqliteRetryProof;

  constructor(cause: unknown, retryProof: SqliteRetryProof) {
    super(sqliteBusyDetailMessage(cause), { cause });
    this.name = "RetrySafeSqliteBusyError";
    this.retryProof = retryProof;
  }
}

export function isRetrySafeSqliteBusyError(error: unknown): error is RetrySafeSqliteBusyError {
  return error instanceof RetrySafeSqliteBusyError
    && error.outcome === "retry_safe_no_effect"
    && isSqliteBusyError(error);
}

/** 纯函数：把连接级 busy timeout 限制在同一绝对 deadline 的剩余墙钟内。 */
export function sqliteBusyTimeoutWithinDeadline(
  configuredMs: number,
  deadlineAtMs: number | undefined,
  nowMs = Date.now(),
): number {
  const configured = Math.max(1, Math.floor(configuredMs));
  if (deadlineAtMs === undefined || !Number.isFinite(deadlineAtMs)) return configured;
  return Math.max(1, Math.min(configured, Math.floor(deadlineAtMs - nowMs)));
}

/** 读取当前 command-scoped deadline；不在命令上下文时保持 owner 原有 timeout。 */
export function studioSqliteBusyTimeoutMs(configuredMs = STUDIO_SQLITE_WRITE_BUSY_TIMEOUT_MS): number {
  return sqliteBusyTimeoutWithinDeadline(
    configuredMs,
    studioSqliteBusyDeadlineContext.getStore()?.deadlineAtMs,
  );
}

/**
 * 为一次完整命令（含账本登记、业务 owner、终态写回）绑定同一绝对截止时间。
 * 只影响显式调用 studioSqliteBusyTimeoutMs 的 SQLite 连接，不改变请求哈希或持久合同。
 */
export function withStudioSqliteBusyDeadline<T>(deadlineAtMs: number, work: () => T): T {
  if (!Number.isFinite(deadlineAtMs)) throw new Error("SQLite deadlineAtMs 必须为有限时间戳。");
  return studioSqliteBusyDeadlineContext.run({ deadlineAtMs }, work);
}

/**
 * 判断错误是否为 SQLite 瞬时写锁（SQLITE_BUSY=5 / SQLITE_LOCKED=6）。
 * node:sqlite DatabaseSync 抛出的错误带 errcode；message 兜底匹配
 * "database is locked" 等文案。沿 cause 链浅查，兼容包装错误。
 * AggregateError（如 withFileLock 临界区与锁释放双失败）把原始 busy 收进
 * errors 数组：浅查一层成员的 errcode/message，不再向下递归，避免漏判进 unknown。
 *
 * 语义边界：原始 SQLITE_BUSY/SQLITE_LOCKED 只能说明发生错误的那条 SQLite
 * 语句没有成功，不能证明同一跨 owner 命令此前没有文件、账本或其他数据库
 * 副作用。只有 RetrySafeSqliteBusyError 携带的窄化证明才允许自动重试；其余
 * 一律走命令账本 outcome_unknown / receipt 对账路径。
 */
export function isSqliteBusyError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 3 && current && typeof current === "object"; depth += 1) {
    const errcode = (current as { errcode?: unknown }).errcode;
    if (errcode === 5 || errcode === 6) return true;
    const message = current instanceof Error ? current.message : String(current);
    if (/database is locked|database table is locked|SQLITE_BUSY|SQLITE_LOCKED/i.test(message)) return true;
    if (current instanceof AggregateError) {
      // 深度限 1 层：只查成员自身的 errcode/message，不沿成员的 cause/errors 继续展开。
      for (const inner of current.errors) {
        if (!inner || typeof inner !== "object") continue;
        const innerErrcode = (inner as { errcode?: unknown }).errcode;
        if (innerErrcode === 5 || innerErrcode === 6) return true;
        const innerMessage = inner instanceof Error ? inner.message : String(inner);
        if (/database is locked|database table is locked|SQLITE_BUSY|SQLITE_LOCKED/i.test(innerMessage)) return true;
      }
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * 提取 busy 判定的细节文案：AggregateError 取首个 busy 成员的 message，
 * 否则取错误自身 message。供上层组合 RESOURCE_BUSY 分类可命中的错误文案。
 */
export function sqliteBusyDetailMessage(error: unknown): string {
  if (error instanceof AggregateError) {
    for (const inner of error.errors) {
      if (isSqliteBusyError(inner)) return inner instanceof Error ? inner.message : String(inner);
    }
  }
  return error instanceof Error ? error.message : String(error);
}

export interface SqliteBusyRetryOptions {
  /** 最大尝试次数（含首次），默认 STUDIO_SQLITE_BUSY_RETRY_MAX_ATTEMPTS */
  maxAttempts?: number;
  /** 总预算 ms（退避+执行总墙钟），默认 STUDIO_SQLITE_BUSY_RETRY_BUDGET_MS */
  budgetMs?: number;
  /** 指数退避基数 ms，默认 STUDIO_SQLITE_BUSY_RETRY_BASE_DELAY_MS */
  baseDelayMs?: number;
  /** 可注入的 sleep（测试或需要 AbortSignal 的调用方） */
  sleep?: (milliseconds: number) => Promise<void>;
  /** 每次尝试前回调（1 起），供调用方记录 attempts */
  onAttempt?: (attempt: number) => void;
  /** 绝对 deadline；默认继承 command-scoped SQLite deadline。 */
  deadlineAtMs?: number;
  /** 仅显式证明零副作用的 typed busy 可重试；默认 fail-closed。 */
  shouldRetry?: (error: unknown) => boolean;
}

/**
 * 对"已证明本次尝试零副作用"的瞬时 busy 做有界指数退避重试：
 * 最多 maxAttempts 次、退避与执行总预算不超过 budgetMs；原始 busy 与其他错误
 * 均立即抛出。重试仍失败时原样抛出 typed busy，由上层按 RESOURCE_BUSY 分类。
 */
export async function withSqliteBusyRetry<T>(
  work: () => Promise<T>,
  options?: SqliteBusyRetryOptions,
): Promise<T> {
  const maxAttempts = Math.max(1, options?.maxAttempts ?? STUDIO_SQLITE_BUSY_RETRY_MAX_ATTEMPTS);
  const budgetMs = Math.max(0, options?.budgetMs ?? STUDIO_SQLITE_BUSY_RETRY_BUDGET_MS);
  const baseDelayMs = Math.max(1, options?.baseDelayMs ?? STUDIO_SQLITE_BUSY_RETRY_BASE_DELAY_MS);
  const sleep = options?.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const shouldRetry = options?.shouldRetry ?? isRetrySafeSqliteBusyError;
  const startedAt = Date.now();
  const inheritedDeadlineAtMs = studioSqliteBusyDeadlineContext.getStore()?.deadlineAtMs;
  const deadlineAtMs = Math.min(
    startedAt + budgetMs,
    options?.deadlineAtMs ?? inheritedDeadlineAtMs ?? Number.POSITIVE_INFINITY,
  );
  for (let attempt = 1; ; attempt += 1) {
    options?.onAttempt?.(attempt);
    try {
      return await work();
    } catch (error) {
      if (!shouldRetry(error) || attempt >= maxAttempts) throw error;
      const remaining = deadlineAtMs - Date.now();
      if (remaining <= 0) throw error;
      // 指数退避 + 小抖动；封顶到剩余预算，总耗时绝不突破 budgetMs。
      const delay = Math.min(baseDelayMs * 2 ** (attempt - 1) + Math.random() * 25, remaining);
      await sleep(delay);
    }
  }
}
