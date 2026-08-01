import { AsyncLocalStorage } from "node:async_hooks";
import { lstatSync } from "node:fs";
import path from "node:path";

interface StudioRequestSchemaCache {
  completed: Set<string>;
}

const requestSchemaCache = new AsyncLocalStorage<StudioRequestSchemaCache>();
let schemaCacheObserverForTests:
  | ((event: { kind: "hit" | "miss" | "mark"; cacheKey: string }) => void)
  | null = null;

/** 仅供 Vitest 统计真实 unit-grid 请求里的深验次数。 */
export function __setStudioRequestSchemaCacheObserverForTests(
  observer: typeof schemaCacheObserverForTests,
): void {
  if (process.env.NODE_ENV !== "test") throw new Error("Studio schema cache observer 仅允许测试环境。");
  schemaCacheObserverForTests = observer;
}

/**
 * 只在一次上层 Studio 请求内复用“本 SQLite 状态已经做过完整结构/内容校验”的
 * 结论。这里不保存连接、查询结果、Head、媒体或冻结包；离开 callback 后即失效。
 */
export function withStudioRequestSchemaCache<T>(callback: () => Promise<T>): Promise<T> {
  if (requestSchemaCache.getStore()) return callback();
  return requestSchemaCache.run({ completed: new Set() }, callback);
}

/**
 * 最终 currentness 门必须从新的验证 epoch 开始，不能沿用冻结初建阶段的深验结论。
 */
export function withFreshStudioRequestSchemaCache<T>(callback: () => Promise<T>): Promise<T> {
  return requestSchemaCache.run({ completed: new Set() }, callback);
}

export function hasStudioRequestSchemaValidation(cacheKey: string): boolean {
  const hit = requestSchemaCache.getStore()?.completed.has(cacheKey) ?? false;
  schemaCacheObserverForTests?.({ kind: hit ? "hit" : "miss", cacheKey });
  return hit;
}

export function markStudioRequestSchemaValidation(cacheKey: string): void {
  const store = requestSchemaCache.getStore();
  if (!store) return;
  store.completed.add(cacheKey);
  schemaCacheObserverForTests?.({ kind: "mark", cacheKey });
}

/** 最终验证结束后丢弃调用方旧 epoch，避免后续写开库复用冻结前的 marker。 */
export function clearStudioRequestSchemaCache(): void {
  requestSchemaCache.getStore()?.completed.clear();
}

function sqliteFileIdentity(
  filePath: string,
  options: { transientEmpty?: boolean } = {},
): string {
  try {
    const metadata = lstatSync(filePath, { bigint: true });
    if (options.transientEmpty && metadata.size === 0n) return "empty";
    return [
      metadata.dev,
      metadata.ino,
      metadata.nlink,
      metadata.size,
      metadata.mtimeNs,
      metadata.ctimeNs,
      metadata.mode,
    ].join(":");
  } catch (error) {
    if (error instanceof Error && "code" in error
      && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return options.transientEmpty ? "empty" : "missing";
    }
    throw error;
  }
}

/**
 * 主库、非空 WAL 或 rollback journal 任一身份/字节状态变化都会换 key；
 * SHM 只承载瞬态锁，不进入权威字节身份。namespace 把 schema 初始化、
 * 深内容验证等不同强度的结论严格隔离。
 */
export function studioRequestSqliteValidationKey(
  namespace: string,
  databasePathValue: string,
): string {
  const databasePath = path.resolve(databasePathValue);
  return [
    namespace,
    databasePath,
    sqliteFileIdentity(databasePath),
    // 空 WAL/journal 会随最后一个连接关闭而消失；两者都等价于无待合并字节。
    sqliteFileIdentity(`${databasePath}-wal`, { transientEmpty: true }),
    // SHM 只承载锁与索引的瞬态状态，不承载权威业务字节，不能让 reader lock 击穿缓存。
    "transient-shm",
    sqliteFileIdentity(`${databasePath}-journal`, { transientEmpty: true }),
  ].join("\u0000");
}

/**
 * 只能标记刚刚实际校验过的同一份 SQLite 字节状态。深验期间若主库/WAL/journal
 * 漂移，调用方必须失败关闭或重试，绝不能把新的 afterKey 冒充成已验证状态。
 */
export function markStudioRequestSqliteValidationIfUnchanged(
  beforeKey: string,
  namespace: string,
  databasePath: string,
): boolean {
  if (!isStudioRequestSqliteValidationUnchanged(beforeKey, namespace, databasePath)) return false;
  markStudioRequestSchemaValidation(beforeKey);
  return true;
}

export function isStudioRequestSqliteValidationUnchanged(
  beforeKey: string,
  namespace: string,
  databasePath: string,
): boolean {
  return studioRequestSqliteValidationKey(namespace, databasePath) === beforeKey;
}
