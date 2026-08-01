import path from "node:path";
import {
  lstat,
  mkdir,
  readdir,
  realpath,
  rm,
} from "node:fs/promises";

export const STUDIO_NATIVE_MEDIA_DRAG_MAX_CONCURRENT_PREPARES = 2;
export const STUDIO_NATIVE_MEDIA_DRAG_MAX_PREPARED_COPIES = 4;
export const STUDIO_NATIVE_MEDIA_DRAG_MAX_OWNED_COPIES = 16;
export const STUDIO_NATIVE_MEDIA_DRAG_TOKEN_TTL_MS = 30_000;
export const STUDIO_NATIVE_MEDIA_DRAG_COPY_RETENTION_MS = 15 * 60_000;
export const STUDIO_NATIVE_MEDIA_DRAG_STALE_DIRECTORY_AGE_MS = 60 * 60_000;

const STUDIO_NATIVE_MEDIA_DRAG_DIRECTORY_PATTERN = /^drag-[A-Za-z0-9]{6}$/u;

export interface StudioNativeMediaDragOwnedEntry {
  token: string;
  temporaryDirectory: string;
}

export interface StudioNativeMediaDragResourceSnapshot {
  activePreparations: number;
  capacityReservations: number;
  prepared: number;
  claimed: number;
  activeOsHandoffs: number;
  retained: number;
  ownedDirectories: number;
  closing: boolean;
}

export interface StudioNativeMediaDragStaleCleanupResult {
  exportRoot: string;
  inspected: number;
  removed: number;
  skippedFresh: number;
  skippedUnsafe: number;
  failed: number;
}

interface PreparedRecord<T extends StudioNativeMediaDragOwnedEntry> {
  entry: T;
  directory: string;
  expiresAt: number;
  expiryTimer: ReturnType<typeof setTimeout>;
}

interface RetainedRecord<T extends StudioNativeMediaDragOwnedEntry> {
  entry: T;
  directory: string;
  cleanupTimer: ReturnType<typeof setTimeout>;
}

interface PreparationCapacityReservation {
  reclaimedDirectory?: string;
}

export class StudioNativeMediaDragBusyError extends Error {
  readonly code = "STUDIO_NATIVE_MEDIA_DRAG_BUSY";

  constructor() {
    super("拖出复制体已达安全并发或保留上限，请稍候当前复制或目标软件读取完成后再试。");
    this.name = "StudioNativeMediaDragBusyError";
  }
}

export class StudioNativeMediaDragClosingError extends Error {
  readonly code = "STUDIO_NATIVE_MEDIA_DRAG_CLOSING";

  constructor() {
    super("应用正在退出，暂时不能准备拖出复制体。");
    this.name = "StudioNativeMediaDragClosingError";
  }
}

export function isStudioNativeMediaDragDirectoryName(value: string): boolean {
  return STUDIO_NATIVE_MEDIA_DRAG_DIRECTORY_PATTERN.test(value);
}

export async function resolveStudioNativeMediaDragExportRoot(exportRoot: string): Promise<string> {
  const resolvedRoot = path.resolve(exportRoot);
  await mkdir(resolvedRoot, { recursive: true, mode: 0o700 });
  const metadata = await lstat(resolvedRoot);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("拖出临时目录无效。");
  }
  return realpath(resolvedRoot);
}

function sameDirectoryIdentity(
  before: Awaited<ReturnType<typeof lstat>>,
  after: Awaited<ReturnType<typeof lstat>>,
): boolean {
  return before.isDirectory()
    && after.isDirectory()
    && !before.isSymbolicLink()
    && !after.isSymbolicLink()
    && before.dev === after.dev
    && before.ino === after.ino
    && before.size === after.size
    && before.mtimeMs === after.mtimeMs
    && before.ctimeMs === after.ctimeMs;
}

/**
 * 启动时只回收固定 exportRoot 的直接子目录。目录名必须精确符合 Node
 * `mkdtemp("drag-")` 的六字符后缀，且目录身份在删除前保持稳定并超过安全年龄。
 */
export async function cleanupStaleStudioNativeMediaDragDirectories(options: {
  exportRoot: string;
  nowMs?: number;
  staleAfterMs?: number;
}): Promise<StudioNativeMediaDragStaleCleanupResult> {
  const exportRoot = await resolveStudioNativeMediaDragExportRoot(options.exportRoot);
  const nowMs = options.nowMs ?? Date.now();
  const staleAfterMs = options.staleAfterMs ?? STUDIO_NATIVE_MEDIA_DRAG_STALE_DIRECTORY_AGE_MS;
  if (!Number.isFinite(nowMs) || !Number.isFinite(staleAfterMs) || staleAfterMs < 1) {
    throw new Error("拖出临时目录清理参数无效。");
  }

  const result: StudioNativeMediaDragStaleCleanupResult = {
    exportRoot,
    inspected: 0,
    removed: 0,
    skippedFresh: 0,
    skippedUnsafe: 0,
    failed: 0,
  };
  const entries = await readdir(exportRoot, { withFileTypes: true });
  for (const entry of entries) {
    result.inspected += 1;
    if (!entry.isDirectory() || !isStudioNativeMediaDragDirectoryName(entry.name)) {
      result.skippedUnsafe += 1;
      continue;
    }
    const candidate = path.join(exportRoot, entry.name);
    try {
      const before = await lstat(candidate);
      if (!before.isDirectory() || before.isSymbolicLink()) {
        result.skippedUnsafe += 1;
        continue;
      }
      if (nowMs - before.mtimeMs < staleAfterMs) {
        result.skippedFresh += 1;
        continue;
      }
      const canonicalCandidate = await realpath(candidate);
      if (path.dirname(canonicalCandidate) !== exportRoot
        || path.basename(canonicalCandidate) !== entry.name) {
        result.skippedUnsafe += 1;
        continue;
      }
      const after = await lstat(candidate);
      if (!sameDirectoryIdentity(before, after)
        || nowMs - after.mtimeMs < staleAfterMs) {
        result.skippedFresh += 1;
        continue;
      }
      await rm(candidate, { recursive: true, force: true });
      result.removed += 1;
    } catch {
      result.failed += 1;
    }
  }
  return result;
}

export class StudioNativeMediaDragResourceManager<
  T extends StudioNativeMediaDragOwnedEntry,
> {
  readonly exportRoot: string;

  private readonly maxConcurrentPreparations: number;
  private readonly maxPreparedCopies: number;
  private readonly maxOwnedCopies: number;
  private readonly tokenTtlMs: number;
  private readonly copyRetentionMs: number;
  private readonly now: () => number;
  private activePreparations = 0;
  private capacityReservations = 0;
  private closing = false;
  private readonly activePreparationPromises = new Set<Promise<unknown>>();
  private readonly prepared = new Map<string, PreparedRecord<T>>();
  private readonly claimed = new Map<string, PreparedRecord<T>>();
  private readonly activeOsHandoffs = new Map<string, PreparedRecord<T>>();
  private readonly retained = new Map<string, RetainedRecord<T>>();
  private readonly ownedDirectories = new Set<string>();
  private readonly reclaimingDirectories = new Set<string>();
  private readonly pendingCleanups = new Set<Promise<void>>();
  private exitCleanupPromise: Promise<void> | null = null;

  constructor(options: {
    exportRoot: string;
    maxConcurrentPreparations?: number;
    maxPreparedCopies?: number;
    maxOwnedCopies?: number;
    tokenTtlMs?: number;
    copyRetentionMs?: number;
    now?: () => number;
  }) {
    this.exportRoot = path.resolve(options.exportRoot);
    this.maxConcurrentPreparations = options.maxConcurrentPreparations
      ?? STUDIO_NATIVE_MEDIA_DRAG_MAX_CONCURRENT_PREPARES;
    this.maxPreparedCopies = options.maxPreparedCopies
      ?? STUDIO_NATIVE_MEDIA_DRAG_MAX_PREPARED_COPIES;
    this.maxOwnedCopies = options.maxOwnedCopies
      ?? STUDIO_NATIVE_MEDIA_DRAG_MAX_OWNED_COPIES;
    this.tokenTtlMs = options.tokenTtlMs ?? STUDIO_NATIVE_MEDIA_DRAG_TOKEN_TTL_MS;
    this.copyRetentionMs = options.copyRetentionMs ?? STUDIO_NATIVE_MEDIA_DRAG_COPY_RETENTION_MS;
    this.now = options.now ?? Date.now;
    if (!Number.isInteger(this.maxConcurrentPreparations)
      || this.maxConcurrentPreparations < 1
      || !Number.isInteger(this.maxPreparedCopies)
      || this.maxPreparedCopies < 1
      || !Number.isInteger(this.maxOwnedCopies)
      || this.maxOwnedCopies < 1
      || this.maxPreparedCopies > this.maxOwnedCopies
      || !Number.isFinite(this.tokenTtlMs)
      || this.tokenTtlMs < 1
      || !Number.isFinite(this.copyRetentionMs)
      || this.copyRetentionMs < 1) {
      throw new Error("拖出复制体资源上限无效。");
    }
  }

  snapshot(): StudioNativeMediaDragResourceSnapshot {
    return {
      activePreparations: this.activePreparations,
      capacityReservations: this.capacityReservations,
      prepared: this.prepared.size,
      claimed: this.claimed.size,
      activeOsHandoffs: this.activeOsHandoffs.size,
      retained: this.retained.size,
      ownedDirectories: this.ownedDirectories.size,
      closing: this.closing,
    };
  }

  needsExitCleanup(): boolean {
    return this.activePreparations > 0
      || this.ownedDirectories.size > 0
      || this.pendingCleanups.size > 0;
  }

  async prepare(factory: () => Promise<T>): Promise<{ entry: T; expiresAt: number }> {
    if (this.closing) throw new StudioNativeMediaDragClosingError();
    if (this.activePreparations >= this.maxConcurrentPreparations) {
      throw new StudioNativeMediaDragBusyError();
    }
    const reservation = this.reservePreparationCapacity();
    this.activePreparations += 1;
    const operation = this.prepareWithinCapacity(factory, reservation);
    this.activePreparationPromises.add(operation);
    void operation.then(
      () => this.activePreparationPromises.delete(operation),
      () => this.activePreparationPromises.delete(operation),
    );
    return operation;
  }

  private async prepareWithinCapacity(
    factory: () => Promise<T>,
    reservation: PreparationCapacityReservation,
  ): Promise<{ entry: T; expiresAt: number }> {
    let ownedDirectory: string | undefined;
    let directoryRegistered = false;
    try {
      if (reservation.reclaimedDirectory) {
        try {
          await this.deleteOwnedDirectory(reservation.reclaimedDirectory);
        } catch {
          throw new Error("无法安全回收旧的拖出复制体，请稍后重试。");
        } finally {
          this.reclaimingDirectories.delete(reservation.reclaimedDirectory);
        }
      }
      if (this.closing) throw new StudioNativeMediaDragClosingError();
      const entry = await factory();
      ownedDirectory = this.requireOwnedDirectoryShape(entry.temporaryDirectory);
      if (!entry.token || this.hasToken(entry.token)) {
        throw new Error("拖出复制体令牌冲突，请重试。");
      }
      if (this.ownedDirectories.has(ownedDirectory)
        || this.reclaimingDirectories.has(ownedDirectory)) {
        throw new Error("拖出复制体目录身份冲突，请重试。");
      }
      this.ownedDirectories.add(ownedDirectory);
      directoryRegistered = true;
      if (this.closing) {
        await this.deleteOwnedDirectory(ownedDirectory);
        throw new StudioNativeMediaDragClosingError();
      }
      const expiresAt = this.now() + this.tokenTtlMs;
      const expiryTimer = setTimeout(() => {
        const record = this.prepared.get(entry.token);
        if (!record) return;
        this.prepared.delete(entry.token);
        this.scheduleOwnedDirectoryCleanup(record.directory);
      }, this.tokenTtlMs);
      expiryTimer.unref();
      this.prepared.set(entry.token, {
        entry,
        directory: ownedDirectory,
        expiresAt,
        expiryTimer,
      });
      return { entry, expiresAt };
    } catch (error) {
      if (ownedDirectory) {
        if (directoryRegistered) {
          await this.deleteOwnedDirectory(ownedDirectory).catch(() => undefined);
        } else if (!this.ownedDirectories.has(ownedDirectory)
          && !this.reclaimingDirectories.has(ownedDirectory)) {
          await rm(ownedDirectory, { recursive: true, force: true }).catch(() => undefined);
        }
      }
      throw error;
    } finally {
      this.activePreparations -= 1;
      this.capacityReservations -= 1;
    }
  }

  takePrepared(token: string): { entry: T; expiresAt: number } | null {
    const record = this.prepared.get(token);
    if (!record) return null;
    this.prepared.delete(token);
    clearTimeout(record.expiryTimer);
    if (record.expiresAt < this.now()) {
      this.scheduleOwnedDirectoryCleanup(record.directory);
      return null;
    }
    this.claimed.set(token, record);
    return { entry: record.entry, expiresAt: record.expiresAt };
  }

  beginOsHandoff(entry: T): void {
    const record = this.claimed.get(entry.token);
    if (!record || record.entry !== entry) {
      throw new Error("拖出复制体令牌状态无效。");
    }
    this.claimed.delete(entry.token);
    this.activeOsHandoffs.set(entry.token, record);
  }

  finishOsHandoff(entry: T): void {
    const record = this.activeOsHandoffs.get(entry.token);
    if (!record || record.entry !== entry) return;
    this.activeOsHandoffs.delete(entry.token);
    if (this.closing) {
      this.scheduleOwnedDirectoryCleanup(record.directory);
      return;
    }
    const cleanupTimer = setTimeout(() => {
      const retained = this.retained.get(entry.token);
      if (!retained) return;
      this.retained.delete(entry.token);
      this.scheduleOwnedDirectoryCleanup(retained.directory);
    }, this.copyRetentionMs);
    cleanupTimer.unref();
    this.retained.set(entry.token, {
      entry,
      directory: record.directory,
      cleanupTimer,
    });
  }

  async discard(entry: T): Promise<void> {
    const records = [
      this.prepared.get(entry.token),
      this.claimed.get(entry.token),
      this.activeOsHandoffs.get(entry.token),
    ];
    const retained = this.retained.get(entry.token);
    this.prepared.delete(entry.token);
    this.claimed.delete(entry.token);
    this.activeOsHandoffs.delete(entry.token);
    this.retained.delete(entry.token);
    for (const record of records) {
      if (record) clearTimeout(record.expiryTimer);
    }
    if (retained) clearTimeout(retained.cleanupTimer);
    const directory = records.find(Boolean)?.directory
      ?? retained?.directory
      ?? this.requireOwnedDirectoryShape(entry.temporaryDirectory);
    await this.deleteOwnedDirectory(directory);
  }

  async cleanupForExit(): Promise<void> {
    if (this.exitCleanupPromise) return this.exitCleanupPromise;
    this.closing = true;
    this.exitCleanupPromise = (async () => {
      await Promise.allSettled([...this.activePreparationPromises]);
      const activeDirectories = new Set(
        [...this.activeOsHandoffs.values()].map((record) => record.directory),
      );
      for (const record of this.prepared.values()) clearTimeout(record.expiryTimer);
      for (const record of this.claimed.values()) clearTimeout(record.expiryTimer);
      for (const record of this.retained.values()) clearTimeout(record.cleanupTimer);
      this.prepared.clear();
      this.claimed.clear();
      this.retained.clear();
      const cleanupTargets = [...this.ownedDirectories]
        .filter((directory) => !activeDirectories.has(directory));
      await Promise.allSettled(cleanupTargets.map((directory) => this.deleteOwnedDirectory(directory)));
      await this.flushPendingCleanups();
    })();
    return this.exitCleanupPromise;
  }

  async flushPendingCleanups(): Promise<void> {
    while (this.pendingCleanups.size > 0) {
      await Promise.allSettled([...this.pendingCleanups]);
    }
  }

  private reservePreparationCapacity(): PreparationCapacityReservation {
    const futurePreparedCopies = this.prepared.size + this.capacityReservations;
    const occupiedSlots = this.ownedDirectories.size
      + this.capacityReservations
      - this.reclaimingDirectories.size;
    if (futurePreparedCopies < this.maxPreparedCopies
      && occupiedSlots < this.maxOwnedCopies) {
      this.capacityReservations += 1;
      return {};
    }

    const oldest = this.prepared.entries().next().value as [string, PreparedRecord<T>] | undefined;
    if (oldest) {
      const [token, record] = oldest;
      this.prepared.delete(token);
      clearTimeout(record.expiryTimer);
      this.reclaimingDirectories.add(record.directory);
      this.capacityReservations += 1;
      return { reclaimedDirectory: record.directory };
    }

    // claimed、active OS handoff 与 retention 期内副本都可能仍被目标 App
    // 异步读取；容量满时宁可拒绝，也绝不能为了新 prepare 删除这些目录。
    throw new StudioNativeMediaDragBusyError();
  }

  private hasToken(token: string): boolean {
    return this.prepared.has(token)
      || this.claimed.has(token)
      || this.activeOsHandoffs.has(token)
      || this.retained.has(token);
  }

  private requireOwnedDirectoryShape(directory: string): string {
    const resolved = path.resolve(directory);
    if (path.dirname(resolved) !== this.exportRoot
      || !isStudioNativeMediaDragDirectoryName(path.basename(resolved))) {
      throw new Error("拖出临时目录身份无效。");
    }
    return resolved;
  }

  private scheduleOwnedDirectoryCleanup(directory: string): void {
    const cleanup = this.deleteOwnedDirectory(directory);
    this.pendingCleanups.add(cleanup);
    void cleanup.then(
      () => this.pendingCleanups.delete(cleanup),
      () => this.pendingCleanups.delete(cleanup),
    );
  }

  private async deleteOwnedDirectory(directory: string): Promise<void> {
    const resolved = this.requireOwnedDirectoryShape(directory);
    if (!this.ownedDirectories.has(resolved)) return;
    await rm(resolved, { recursive: true, force: true });
    this.ownedDirectories.delete(resolved);
  }
}
