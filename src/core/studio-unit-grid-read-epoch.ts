import { AsyncLocalStorage } from "node:async_hooks";
import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { studioRequestSqliteValidationKey } from "./studio-request-schema-cache.js";

type StudioUnitGridReadEpochPhase = "initial" | "fresh-currentness";

interface StudioUnitGridReadEpochStore {
  root: string;
  phase: StudioUnitGridReadEpochPhase;
  closed: boolean;
  memo: Map<string, Promise<unknown>>;
  mediaPaths: Map<string, string>;
  verifiedMedia: Map<string, { objectPath: string; identity: string }>;
}

interface StudioUnitGridDatabaseIdentity {
  material: string;
  production: string;
  generation: string;
}

const unitGridReadEpoch = new AsyncLocalStorage<StudioUnitGridReadEpochStore>();
let epochObserverForTests:
  | ((event: {
      kind: "begin" | "end" | "memo-hit" | "memo-miss";
      phase: StudioUnitGridReadEpochPhase;
      key?: string;
    }) => void)
  | null = null;

export class StudioUnitGridReadEpochDriftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StudioUnitGridReadEpochDriftError";
  }
}

/** 仅供 Vitest 证明初建/fresh epoch 隔离及请求内去重。 */
export function __setStudioUnitGridReadEpochObserverForTests(
  observer: typeof epochObserverForTests,
): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Studio unit-grid read epoch observer 仅允许测试环境。");
  }
  epochObserverForTests = observer;
}

function canonicalRoot(projectRoot: string): string {
  const resolved = path.resolve(projectRoot);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function databaseIdentity(root: string): StudioUnitGridDatabaseIdentity {
  const databaseRoot = path.join(root, ".aicanvas");
  return {
    material: studioRequestSqliteValidationKey(
      "unit-grid-read-epoch-material",
      path.join(databaseRoot, "material-studio.sqlite"),
    ),
    production: studioRequestSqliteValidationKey(
      "unit-grid-read-epoch-production",
      path.join(databaseRoot, "studio-production.sqlite"),
    ),
    generation: studioRequestSqliteValidationKey(
      "unit-grid-read-epoch-generation",
      path.join(databaseRoot, "studio-generation-ledger.sqlite"),
    ),
  };
}

function changedOwners(
  before: StudioUnitGridDatabaseIdentity,
  after: StudioUnitGridDatabaseIdentity,
): string[] {
  return (Object.keys(before) as Array<keyof StudioUnitGridDatabaseIdentity>)
    .filter((owner) => before[owner] !== after[owner]);
}

function canonicalMediaObjectPath(objectPath: string): string {
  try {
    const resolved = path.resolve(objectPath);
    const metadata = lstatSync(resolved, { bigint: true });
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new StudioUnitGridReadEpochDriftError("unit-grid 媒体控制引用不是普通文件。");
    }
    return realpathSync(resolved);
  } catch (error) {
    if (error instanceof StudioUnitGridReadEpochDriftError) throw error;
    throw new StudioUnitGridReadEpochDriftError("unit-grid 媒体控制引用身份不可读取。");
  }
}

function mediaFileIdentity(objectPath: string): string {
  try {
    const canonical = canonicalMediaObjectPath(objectPath);
    const metadata = lstatSync(canonical, { bigint: true });
    return [
      canonical,
      metadata.dev,
      metadata.ino,
      metadata.nlink,
      metadata.size,
      metadata.mtimeNs,
      metadata.ctimeNs,
      metadata.mode,
    ].join(":");
  } catch (error) {
    if (error instanceof StudioUnitGridReadEpochDriftError) throw error;
    throw new StudioUnitGridReadEpochDriftError("unit-grid 媒体控制引用身份不可读取。");
  }
}

async function runEpoch<T>(
  projectRoot: string,
  phase: StudioUnitGridReadEpochPhase,
  callback: () => Promise<T>,
): Promise<T> {
  const root = canonicalRoot(projectRoot);
  const before = databaseIdentity(root);
  const store: StudioUnitGridReadEpochStore = {
    root,
    phase,
    closed: false,
    memo: new Map(),
    mediaPaths: new Map(),
    verifiedMedia: new Map(),
  };
  epochObserverForTests?.({ kind: "begin", phase });

  let result: T | undefined;
  let callbackError: unknown;
  try {
    result = await unitGridReadEpoch.run(store, callback);
  } catch (error) {
    callbackError = error;
  }

  // callback 已结束后立即封口；未 await 的迟到任务不得在终检窗口继续取数。
  store.closed = true;
  const after = databaseIdentity(root);
  const changed = changedOwners(before, after);
  const changedMedia = [...store.verifiedMedia.entries()]
    .filter(([, verified]) => {
      try {
        return mediaFileIdentity(verified.objectPath) !== verified.identity;
      } catch {
        return true;
      }
    })
    .map(([mediaSha256]) => mediaSha256);
  store.memo.clear();
  store.mediaPaths.clear();
  store.verifiedMedia.clear();
  epochObserverForTests?.({ kind: "end", phase });
  if (changed.length > 0 || changedMedia.length > 0) {
    throw new StudioUnitGridReadEpochDriftError(
      [
        `unit-grid ${phase} 只读 epoch 期间输入身份漂移`,
        changed.length > 0 ? `SQLite=${changed.join(",")}` : "",
        changedMedia.length > 0 ? `media=${changedMedia.join(",")}` : "",
      ].filter(Boolean).join("："),
    );
  }
  if (callbackError !== undefined) throw callbackError;
  return result as T;
}

/**
 * unit-grid 初建 epoch。嵌套读取只能复用同一工程的当前 epoch；不同工程拒绝
 * 共享 memo，避免把一个受管工程的只读事实投影到另一个工程。
 */
export async function withStudioUnitGridReadEpoch<T>(
  projectRoot: string,
  callback: () => Promise<T>,
): Promise<T> {
  const existing = unitGridReadEpoch.getStore();
  if (existing) {
    if (existing.root !== canonicalRoot(projectRoot)) {
      throw new StudioUnitGridReadEpochDriftError("unit-grid 只读 epoch 不允许跨工程复用。");
    }
    return callback();
  }
  return runEpoch(projectRoot, "initial", callback);
}

/**
 * 最终 currentness 必须强制新建 epoch；即使调用方外层仍有初建 epoch，也不能
 * 继承任何只读结果或媒体 SHA 结论。
 */
export function withFreshStudioUnitGridReadEpoch<T>(
  projectRoot: string,
  callback: () => Promise<T>,
): Promise<T> {
  return runEpoch(projectRoot, "fresh-currentness", callback);
}

/**
 * 只缓存显式标注的只读 Promise。失败不进入缓存；离开 epoch 后 Map 立即清空。
 * 调用方必须使用包含完整查询参数的稳定 key，且不得缓存写命令或可变事务句柄。
 */
export async function memoStudioUnitGridRead<T>(
  projectRoot: string,
  key: string,
  loader: () => Promise<T>,
): Promise<T> {
  const store = unitGridReadEpoch.getStore();
  if (!store) return loader();
  if (store.closed) {
    throw new StudioUnitGridReadEpochDriftError("unit-grid 只读 epoch 已结束，拒绝迟到读取。");
  }
  if (store.root !== canonicalRoot(projectRoot)) {
    throw new StudioUnitGridReadEpochDriftError("unit-grid memo 工程身份不一致。");
  }
  const scopedKey = `${store.root}\u0000${key}`;
  const existing = store.memo.get(scopedKey);
  if (existing) {
    epochObserverForTests?.({ kind: "memo-hit", phase: store.phase, key });
    return existing as Promise<T>;
  }
  epochObserverForTests?.({ kind: "memo-miss", phase: store.phase, key });
  const pending = loader();
  store.memo.set(scopedKey, pending);
  try {
    return await pending;
  } catch (error) {
    if (store.memo.get(scopedKey) === pending) store.memo.delete(scopedKey);
    throw error;
  }
}

/** 同一 epoch 内同一受管媒体 SHA 最多执行一次真实文件 SHA 校验。 */
export function verifyStudioUnitGridMediaOnce(
  projectRoot: string,
  mediaSha256: string,
  objectPath: string,
  verifier: () => Promise<boolean>,
): Promise<boolean> {
  const store = unitGridReadEpoch.getStore();
  if (!store) return verifier();
  let resolvedObjectPath: string;
  try {
    resolvedObjectPath = canonicalMediaObjectPath(objectPath);
  } catch (error) {
    return Promise.reject(error);
  }
  if (store?.closed) {
    return Promise.reject(
      new StudioUnitGridReadEpochDriftError("unit-grid 只读 epoch 已结束，拒绝迟到媒体校验。"),
    );
  }
  const existingPath = store?.mediaPaths.get(mediaSha256);
  if (existingPath && existingPath !== resolvedObjectPath) {
    return Promise.reject(
      new StudioUnitGridReadEpochDriftError(
        `unit-grid 同一媒体 SHA 指向不同对象路径：${mediaSha256}`,
      ),
    );
  }
  store?.mediaPaths.set(mediaSha256, resolvedObjectPath);
  return memoStudioUnitGridRead(
    projectRoot,
    `material:media-sha-verified:${mediaSha256}`,
    async () => {
      const before = mediaFileIdentity(resolvedObjectPath);
      const verified = await verifier();
      const after = mediaFileIdentity(resolvedObjectPath);
      if (before !== after) {
        throw new StudioUnitGridReadEpochDriftError(
          `unit-grid 媒体在 SHA 校验期间发生身份漂移：${mediaSha256}`,
        );
      }
      if (verified && store) {
        store.verifiedMedia.set(mediaSha256, {
          objectPath: resolvedObjectPath,
          identity: after,
        });
      }
      return verified;
    },
  );
}
