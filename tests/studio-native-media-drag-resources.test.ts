import {
  access,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupStaleStudioNativeMediaDragDirectories,
  resolveStudioNativeMediaDragExportRoot,
  STUDIO_NATIVE_MEDIA_DRAG_MAX_CONCURRENT_PREPARES,
  STUDIO_NATIVE_MEDIA_DRAG_MAX_OWNED_COPIES,
  STUDIO_NATIVE_MEDIA_DRAG_MAX_PREPARED_COPIES,
  StudioNativeMediaDragBusyError,
  StudioNativeMediaDragResourceManager,
  type StudioNativeMediaDragOwnedEntry,
} from "../src/main/studio-native-media-drag-resources.js";

interface TestDragEntry extends StudioNativeMediaDragOwnedEntry {
  label: string;
}

let temporaryRoot = "";
let exportRoot = "";

async function exists(target: string): Promise<boolean> {
  return access(target).then(() => true).catch(() => false);
}

async function makeEntry(token: string): Promise<TestDragEntry> {
  const temporaryDirectory = await mkdtemp(path.join(exportRoot, "drag-"));
  await writeFile(path.join(temporaryDirectory, "copy.bin"), token, "utf8");
  return {
    token,
    temporaryDirectory,
    label: token,
  };
}

beforeEach(async () => {
  temporaryRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "native-drag-resources-")));
  exportRoot = await resolveStudioNativeMediaDragExportRoot(
    path.join(temporaryRoot, "ai-drama-canvas-export"),
  );
});

afterEach(async () => {
  await rm(temporaryRoot, { recursive: true, force: true });
});

describe("Main 原生媒体拖出临时资源管理", () => {
  it("最多同时准备 2 份复制体，第三份快速失败且错误不泄漏路径", async () => {
    expect(STUDIO_NATIVE_MEDIA_DRAG_MAX_CONCURRENT_PREPARES).toBe(2);
    const manager = new StudioNativeMediaDragResourceManager<TestDragEntry>({ exportRoot });
    const releases: Array<() => void> = [];
    const prepareBlocked = (token: string) => manager.prepare(async () => {
      await new Promise<void>((resolve) => releases.push(resolve));
      return makeEntry(token);
    });

    const first = prepareBlocked("first");
    const second = prepareBlocked("second");
    expect(manager.snapshot().activePreparations).toBe(2);

    let rejection: unknown;
    try {
      await manager.prepare(() => makeEntry("third"));
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toBeInstanceOf(StudioNativeMediaDragBusyError);
    expect((rejection as Error).message).toContain("安全并发或保留上限");
    expect((rejection as Error).message).not.toContain(temporaryRoot);
    expect(manager.snapshot().activePreparations).toBe(2);

    releases.splice(0).forEach((release) => release());
    const prepared = await Promise.all([first, second]);
    expect(manager.snapshot()).toMatchObject({
      activePreparations: 0,
      prepared: 2,
      ownedDirectories: 2,
    });
    await manager.cleanupForExit();
    await expect(Promise.all(prepared.map(({ entry }) => exists(entry.temporaryDirectory))))
      .resolves.toEqual([false, false]);
  });

  it("prepared token 最多保留 4 份，第 5 份安全淘汰最旧 prepared 目录", async () => {
    expect(STUDIO_NATIVE_MEDIA_DRAG_MAX_PREPARED_COPIES).toBe(4);
    const manager = new StudioNativeMediaDragResourceManager<TestDragEntry>({ exportRoot });
    const prepared: Array<{ entry: TestDragEntry; expiresAt: number }> = [];
    for (let index = 0; index < 5; index += 1) {
      prepared.push(await manager.prepare(() => makeEntry(`token-${index}`)));
    }

    expect(manager.snapshot()).toMatchObject({
      prepared: 4,
      ownedDirectories: 4,
    });
    expect(manager.takePrepared("token-0")).toBeNull();
    expect(await exists(prepared[0]!.entry.temporaryDirectory)).toBe(false);
    for (const current of prepared.slice(1)) {
      expect(await exists(current.entry.temporaryDirectory)).toBe(true);
    }

    await manager.cleanupForExit();
    for (const current of prepared.slice(1)) {
      expect(await exists(current.entry.temporaryDirectory)).toBe(false);
    }
  });

  it("prepared 满载时两路并发 prepare 各自预留替换槽，总 owned 始终不越界", async () => {
    const manager = new StudioNativeMediaDragResourceManager<TestDragEntry>({
      exportRoot,
      maxConcurrentPreparations: 2,
      maxPreparedCopies: 4,
      maxOwnedCopies: 4,
    });
    const initial: TestDragEntry[] = [];
    for (let index = 0; index < 4; index += 1) {
      const prepared = await manager.prepare(() => makeEntry(`initial-${index}`));
      initial.push(prepared.entry);
    }

    const releases: Array<() => void> = [];
    let bothFactoriesEntered!: () => void;
    const bothFactories = new Promise<void>((resolve) => {
      bothFactoriesEntered = resolve;
    });
    const replace = (token: string) => manager.prepare(async () => {
      await new Promise<void>((resolve) => {
        releases.push(resolve);
        if (releases.length === 2) bothFactoriesEntered();
      });
      return makeEntry(token);
    });
    const fifth = replace("replacement-4");
    const sixth = replace("replacement-5");
    await bothFactories;

    expect(manager.snapshot()).toMatchObject({
      activePreparations: 2,
      capacityReservations: 2,
      prepared: 2,
      ownedDirectories: 2,
    });
    releases.splice(0).forEach((release) => release());
    await Promise.all([fifth, sixth]);
    expect(manager.snapshot()).toMatchObject({
      activePreparations: 0,
      capacityReservations: 0,
      prepared: 4,
      ownedDirectories: 4,
    });
    await expect(Promise.all(initial.slice(0, 2).map(({ temporaryDirectory }) => (
      exists(temporaryDirectory)
    )))).resolves.toEqual([false, false]);
    await expect(Promise.all(initial.slice(2).map(({ temporaryDirectory }) => (
      exists(temporaryDirectory)
    )))).resolves.toEqual([true, true]);
    await manager.cleanupForExit();
  });

  it("重复 token 清理本次新目录，重复目录拒绝时不删除既有合法副本", async () => {
    const manager = new StudioNativeMediaDragResourceManager<TestDragEntry>({ exportRoot });
    const first = await manager.prepare(() => makeEntry("stable-token"));
    const duplicateTokenDirectory = await mkdtemp(path.join(exportRoot, "drag-"));
    await writeFile(path.join(duplicateTokenDirectory, "copy.bin"), "duplicate", "utf8");

    await expect(manager.prepare(async () => ({
      token: first.entry.token,
      temporaryDirectory: duplicateTokenDirectory,
      label: "duplicate-token",
    }))).rejects.toThrow("令牌冲突");
    expect(await exists(duplicateTokenDirectory)).toBe(false);
    expect(await exists(first.entry.temporaryDirectory)).toBe(true);
    expect(manager.takePrepared(first.entry.token)?.entry).toBe(first.entry);

    await expect(manager.prepare(async () => ({
      token: "different-token",
      temporaryDirectory: first.entry.temporaryDirectory,
      label: "duplicate-directory",
    }))).rejects.toThrow("目录身份冲突");
    expect(await exists(first.entry.temporaryDirectory)).toBe(true);
    await manager.discard(first.entry);
  });

  it("连续 16 次完整 OS handoff 均保留，第 17 次友好 Busy 且不运行 factory", async () => {
    expect(STUDIO_NATIVE_MEDIA_DRAG_MAX_OWNED_COPIES).toBe(16);
    const manager = new StudioNativeMediaDragResourceManager<TestDragEntry>({ exportRoot });
    const handoffs: TestDragEntry[] = [];
    for (let index = 0; index < STUDIO_NATIVE_MEDIA_DRAG_MAX_OWNED_COPIES; index += 1) {
      const prepared = await manager.prepare(() => makeEntry(`handoff-${index}`));
      const claimed = manager.takePrepared(prepared.entry.token);
      expect(claimed?.entry).toBe(prepared.entry);
      manager.beginOsHandoff(prepared.entry);
      manager.finishOsHandoff(prepared.entry);
      handoffs.push(prepared.entry);
      expect(manager.snapshot().ownedDirectories).toBeLessThanOrEqual(
        STUDIO_NATIVE_MEDIA_DRAG_MAX_OWNED_COPIES,
      );
    }

    expect(manager.snapshot()).toMatchObject({
      prepared: 0,
      claimed: 0,
      activeOsHandoffs: 0,
      retained: STUDIO_NATIVE_MEDIA_DRAG_MAX_OWNED_COPIES,
      ownedDirectories: STUDIO_NATIVE_MEDIA_DRAG_MAX_OWNED_COPIES,
    });
    await expect(Promise.all(handoffs.map(({ temporaryDirectory }) => (
      exists(temporaryDirectory)
    )))).resolves.toEqual(Array.from(
      { length: STUDIO_NATIVE_MEDIA_DRAG_MAX_OWNED_COPIES },
      () => true,
    ));

    let factoryCalled = false;
    let rejection: unknown;
    try {
      await manager.prepare(async () => {
        factoryCalled = true;
        return makeEntry("handoff-over-capacity");
      });
    } catch (error) {
      rejection = error;
    }
    expect(factoryCalled).toBe(false);
    expect(rejection).toBeInstanceOf(StudioNativeMediaDragBusyError);
    expect((rejection as Error).message).not.toContain(temporaryRoot);
    await expect(Promise.all(handoffs.map(({ temporaryDirectory }) => (
      exists(temporaryDirectory)
    )))).resolves.toEqual(Array.from(
      { length: STUDIO_NATIVE_MEDIA_DRAG_MAX_OWNED_COPIES },
      () => true,
    ));
    await manager.cleanupForExit();
  });

  it("retention 到期并完成清理后恢复总容量", async () => {
    const manager = new StudioNativeMediaDragResourceManager<TestDragEntry>({
      exportRoot,
      maxPreparedCopies: 1,
      maxOwnedCopies: 1,
      copyRetentionMs: 20,
    });
    const first = await manager.prepare(() => makeEntry("retention-expiry"));
    const claimed = manager.takePrepared(first.entry.token);
    expect(claimed?.entry).toBe(first.entry);
    manager.beginOsHandoff(first.entry);
    manager.finishOsHandoff(first.entry);

    await expect(manager.prepare(() => makeEntry("too-early")))
      .rejects.toBeInstanceOf(StudioNativeMediaDragBusyError);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await manager.flushPendingCleanups();
    expect(await exists(first.entry.temporaryDirectory)).toBe(false);

    const afterExpiry = await manager.prepare(() => makeEntry("after-expiry"));
    expect(afterExpiry.entry.token).toBe("after-expiry");
    await manager.cleanupForExit();
  });

  it("容量全部处于 active OS handoff 时友好拒绝新 prepare，且不删除拖中目录或泄漏路径", async () => {
    const manager = new StudioNativeMediaDragResourceManager<TestDragEntry>({
      exportRoot,
      maxPreparedCopies: 2,
      maxOwnedCopies: 2,
    });
    const active: TestDragEntry[] = [];
    for (let index = 0; index < 2; index += 1) {
      const prepared = await manager.prepare(() => makeEntry(`active-${index}`));
      const claimed = manager.takePrepared(prepared.entry.token);
      expect(claimed?.entry).toBe(prepared.entry);
      manager.beginOsHandoff(prepared.entry);
      active.push(prepared.entry);
    }

    let factoryCalled = false;
    let rejection: unknown;
    try {
      await manager.prepare(async () => {
        factoryCalled = true;
        return makeEntry("must-not-run");
      });
    } catch (error) {
      rejection = error;
    }
    expect(factoryCalled).toBe(false);
    expect(rejection).toBeInstanceOf(StudioNativeMediaDragBusyError);
    expect((rejection as Error).message).not.toContain(temporaryRoot);
    expect(manager.snapshot()).toMatchObject({
      activeOsHandoffs: 2,
      ownedDirectories: 2,
      capacityReservations: 0,
    });
    await expect(Promise.all(active.map(({ temporaryDirectory }) => exists(temporaryDirectory))))
      .resolves.toEqual([true, true]);

    for (const entry of active) manager.finishOsHandoff(entry);
    await manager.cleanupForExit();
  });

  it("退出清理 prepared/retained，但活动 OS handoff 在拖动完成前保持可读", async () => {
    const activeManager = new StudioNativeMediaDragResourceManager<TestDragEntry>({ exportRoot });
    const activePrepared = await activeManager.prepare(() => makeEntry("active-handoff"));
    const activeClaim = activeManager.takePrepared(activePrepared.entry.token);
    expect(activeClaim?.entry).toBe(activePrepared.entry);
    activeManager.beginOsHandoff(activePrepared.entry);

    await activeManager.cleanupForExit();
    expect(activeManager.snapshot()).toMatchObject({
      activeOsHandoffs: 1,
      closing: true,
    });
    expect(await exists(activePrepared.entry.temporaryDirectory)).toBe(true);

    activeManager.finishOsHandoff(activePrepared.entry);
    await activeManager.flushPendingCleanups();
    expect(await exists(activePrepared.entry.temporaryDirectory)).toBe(false);

    const retainedManager = new StudioNativeMediaDragResourceManager<TestDragEntry>({ exportRoot });
    const retainedPrepared = await retainedManager.prepare(() => makeEntry("retained-copy"));
    const retainedClaim = retainedManager.takePrepared(retainedPrepared.entry.token);
    expect(retainedClaim?.entry).toBe(retainedPrepared.entry);
    retainedManager.beginOsHandoff(retainedPrepared.entry);
    retainedManager.finishOsHandoff(retainedPrepared.entry);
    expect(retainedManager.snapshot().retained).toBe(1);

    await retainedManager.cleanupForExit();
    expect(await exists(retainedPrepared.entry.temporaryDirectory)).toBe(false);
    expect(retainedManager.snapshot()).toMatchObject({
      prepared: 0,
      claimed: 0,
      retained: 0,
      ownedDirectories: 0,
    });
  });

  it("启动只删除固定 exportRoot 下严格命名且超龄的 drag 目录", async () => {
    const nowMs = Date.now();
    const oldTime = new Date(nowMs - 2 * 60 * 60_000);
    const stale = path.join(exportRoot, "drag-OLD123");
    const fresh = path.join(exportRoot, "drag-NEW123");
    const unsafeName = path.join(exportRoot, "drag-not-six");
    const unrelated = path.join(exportRoot, "other-old");
    const external = path.join(temporaryRoot, "external-do-not-delete");
    const symlinkPath = path.join(exportRoot, "drag-LNK123");
    const siblingStale = path.join(temporaryRoot, "drag-OUT123");
    await Promise.all([
      mkdir(stale),
      mkdir(fresh),
      mkdir(unsafeName),
      mkdir(unrelated),
      mkdir(external),
      mkdir(siblingStale),
    ]);
    await Promise.all([
      writeFile(path.join(stale, "copy.bin"), "stale"),
      writeFile(path.join(fresh, "copy.bin"), "fresh"),
      writeFile(path.join(external, "keep.bin"), "external"),
      writeFile(path.join(siblingStale, "keep.bin"), "sibling"),
    ]);
    await Promise.all([
      utimes(stale, oldTime, oldTime),
      utimes(unsafeName, oldTime, oldTime),
      utimes(unrelated, oldTime, oldTime),
      utimes(siblingStale, oldTime, oldTime),
      symlink(external, symlinkPath),
    ]);

    const result = await cleanupStaleStudioNativeMediaDragDirectories({
      exportRoot,
      nowMs,
      staleAfterMs: 60 * 60_000,
    });

    expect(result).toMatchObject({
      removed: 1,
      skippedFresh: 1,
      skippedUnsafe: 3,
      failed: 0,
    });
    expect(await exists(stale)).toBe(false);
    expect(await exists(fresh)).toBe(true);
    expect(await exists(unsafeName)).toBe(true);
    expect(await exists(unrelated)).toBe(true);
    expect(await exists(symlinkPath)).toBe(true);
    expect(await exists(external)).toBe(true);
    expect(await exists(siblingStale)).toBe(true);
  });
});
