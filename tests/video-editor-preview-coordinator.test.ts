import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LatestBoundedTaskQueue } from "../src/renderer/src/bounded-task-queue.js";
import {
  collectVideoEditorNestedPreviewIds,
  KeyedPreviewCoordinator,
  ReferenceCountedPreviewSuspension,
} from "../src/renderer/src/video-editor-preview-coordinator.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => { resolve = nextResolve; reject = nextReject; });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe("视频编辑预览协调器", () => {
  it("1000 个嵌套片段只选择 selected/current/visible，再把实际并发限制为 2", async () => {
    const clips = Array.from({ length: 1_000 }, (_, index) => ({
      id: `clip-${index}`,
      kind: "timeline",
      startSeconds: index * 10,
      durationSeconds: 4,
    }));
    const selected = clips[900]!;
    const current = clips[901]!;
    const visible = clips[1]!;
    expect(collectVideoEditorNestedPreviewIds({
      priorityClips: [selected, current],
      tracks: [{ clips }],
      gestureClipId: "",
      visibleStart: 9,
      visibleEnd: 15,
    })).toEqual([selected.id, current.id, visible.id]);

    const requested: string[] = [];
    let active = 0;
    let maximum = 0;
    const waits = new Map<string, ReturnType<typeof deferred<string>>>();
    const coordinator = new KeyedPreviewCoordinator<string, string, string>({
      execute(key) {
        requested.push(key);
        active += 1;
        maximum = Math.max(maximum, active);
        const wait = deferred<string>();
        waits.set(key, wait);
        return wait.promise.finally(() => { active -= 1; });
      },
      onSuccess() {},
      onError() {},
    }, 2);

    coordinator.activate("nested-v1");
    coordinator.reconcile([selected.id, current.id, visible.id]);
    await flush();
    expect(requested).toEqual([selected.id, current.id]);
    expect(maximum).toBe(2);
    waits.get(selected.id)!.resolve(selected.id);
    await flush();
    expect(requested).toEqual([selected.id, current.id, visible.id]);
    waits.get(current.id)!.resolve(current.id);
    waits.get(visible.id)!.resolve(visible.id);
    await flush();
    expect(maximum).toBe(2);
  });

  it("hover 同 artifact 反复 enqueue 只发一次，并在新 scope 可重新开始", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const calls: string[] = [];
    const settled: string[] = [];
    let round = 0;
    const coordinator = new KeyedPreviewCoordinator<string, string, string>({
      execute(key) { calls.push(`${round}:${key}`); return round === 0 ? first.promise : second.promise; },
      onSuccess(key, value) { settled.push(`success:${key}:${value}`); },
      onError(key) { settled.push(`error:${key}`); },
      onSettled(key) { settled.push(`finally:${key}`); },
    }, 2);

    coordinator.activate("page-a");
    for (let index = 0; index < 20; index += 1) coordinator.enqueue("artifact-1");
    await flush();
    expect(calls).toEqual(["0:artifact-1"]);
    coordinator.activate("page-b");
    round = 1;
    coordinator.enqueue("artifact-1");
    await flush();
    first.resolve("old");
    await flush();
    expect(settled).toEqual([]);
    expect(calls).toEqual(["0:artifact-1", "1:artifact-1"]);
    second.resolve("new");
    await flush();
    expect(settled).toEqual(["success:artifact-1:new", "finally:artifact-1"]);
  });

  it("nested 与 hover 共用一个物理 limiter，总执行并发仍不超过 2", async () => {
    const sharedQueue = new LatestBoundedTaskQueue(2);
    const waits: Array<ReturnType<typeof deferred<string>>> = [];
    let active = 0;
    let maximum = 0;
    const options = {
      execute(key: string) {
        active += 1;
        maximum = Math.max(maximum, active);
        const wait = deferred<string>();
        waits.push(wait);
        return wait.promise.finally(() => { active -= 1; });
      },
      onSuccess() {},
      onError() {},
    };
    const nested = new KeyedPreviewCoordinator(options, 2, sharedQueue);
    const hover = new KeyedPreviewCoordinator(options, 2, sharedQueue);
    nested.activate("nested");
    hover.activate("hover");
    nested.reconcile(["nested-a", "nested-b"]);
    hover.reconcile(["hover-a", "hover-b"]);
    await flush();
    expect(maximum).toBe(2);
    for (const wait of waits.splice(0)) wait.resolve("done");
    await flush();
    for (const wait of waits.splice(0)) wait.resolve("done");
    await flush();
    expect(maximum).toBe(2);
    nested.dispose();
    hover.dispose();
    sharedQueue.dispose();
  });

  it("hover 只保留最新 demand；前两个在途自然收敛，旧回填被丢弃且随后只启动最新项", async () => {
    const sharedQueue = new LatestBoundedTaskQueue(2);
    const waits = new Map<string, ReturnType<typeof deferred<string>>>();
    const started: string[] = [];
    const updates: string[] = [];
    let active = 0;
    let maximum = 0;
    const hover = new KeyedPreviewCoordinator<string, string, string>({
      execute(key) {
        started.push(key);
        active += 1;
        maximum = Math.max(maximum, active);
        const wait = deferred<string>();
        waits.set(key, wait);
        return wait.promise.finally(() => { active -= 1; });
      },
      onSuccess(key) { updates.push(`success:${key}`); },
      onError(key) { updates.push(`error:${key}`); },
      onSettled(key) { updates.push(`settled:${key}`); },
    }, 2, sharedQueue);

    hover.activate("media-page");
    hover.reconcile(["A", "B"]);
    await flush();
    expect(started).toEqual(["A", "B"]);
    for (let index = 3; index <= 60; index += 1) hover.reconcile([`C${index}`]);
    await flush();
    expect(started).toEqual(["A", "B"]);
    waits.get("A")!.resolve("old-a");
    await flush();
    expect(started).toEqual(["A", "B", "C60"]);
    waits.get("B")!.reject(new Error("old-b"));
    waits.get("C60")!.resolve("current");
    await flush();
    expect(updates).toEqual(["success:C60", "settled:C60"]);
    expect(maximum).toBe(2);
    hover.dispose();
    sharedQueue.dispose();
  });

  it("foreground 暂停会清掉 queued hover/nested，最多等待两个在途任务后才开始，恢复后当前 scope 可再排", async () => {
    const sharedQueue = new LatestBoundedTaskQueue(2);
    const waits = new Map<string, ReturnType<typeof deferred<string>>>();
    const started: string[] = [];
    const updates: string[] = [];
    const makeCoordinator = (domain: string) => new KeyedPreviewCoordinator<string, string, string>({
      execute(key) {
        started.push(`${domain}:${key}`);
        const wait = deferred<string>();
        waits.set(`${domain}:${key}`, wait);
        return wait.promise;
      },
      onSuccess(key) { updates.push(`success:${domain}:${key}`); },
      onError(key) { updates.push(`error:${domain}:${key}`); },
      onSettled(key) { updates.push(`settled:${domain}:${key}`); },
    }, 2, sharedQueue);
    const nested = makeCoordinator("nested");
    const hover = makeCoordinator("hover");
    nested.activate("current");
    hover.activate("current");
    nested.reconcile(["A", "B", "queued-nested"]);
    hover.reconcile(["queued-hover"]);
    await flush();
    expect(started).toEqual(["nested:A", "nested:B"]);

    nested.invalidate();
    hover.invalidate();
    sharedQueue.invalidate();
    let foregroundStarted = false;
    const foreground = sharedQueue.whenIdle().then(() => { foregroundStarted = true; });
    await flush();
    expect(foregroundStarted).toBe(false);
    expect(started).not.toContain("nested:queued-nested");
    expect(started).not.toContain("hover:queued-hover");
    waits.get("nested:A")!.resolve("old-a");
    waits.get("nested:B")!.reject(new Error("old-b"));
    await foreground;
    expect(foregroundStarted).toBe(true);
    expect(updates).toEqual([]);

    nested.activate("current");
    hover.activate("current");
    hover.reconcile(["latest-after-foreground"]);
    await flush();
    expect(started).toContain("hover:latest-after-foreground");
    waits.get("hover:latest-after-foreground")!.resolve("new");
    await flush();
    expect(updates).toEqual(["success:hover:latest-after-foreground", "settled:hover:latest-after-foreground"]);
    nested.dispose();
    hover.dispose();
    sharedQueue.dispose();
  });

  it("并发 foreground lease 只暂停一次；先完成者释放后仍不恢复，最后一个才恢复", async () => {
    const drain = deferred<void>();
    let suspended = 0;
    let resumed = 0;
    const lease = new ReferenceCountedPreviewSuspension(
      async () => { suspended += 1; await drain.promise; },
      () => { resumed += 1; },
    );
    const first = lease.acquire();
    const second = lease.acquire();
    expect(suspended).toBe(0);
    drain.resolve();
    await Promise.all([first, second]);
    expect(suspended).toBe(1);
    lease.release();
    expect(resumed).toBe(0);
    lease.release();
    expect(resumed).toBe(1);
  });

  it("reconcile 替换需求时不会为未启动的旧 key 调 IPC", async () => {
    const calls: string[] = [];
    const coordinator = new KeyedPreviewCoordinator<string, string, string>({
      execute(key) { calls.push(key); return Promise.resolve(key); },
      onSuccess() {},
      onError() {},
    }, 1);

    coordinator.activate("v1");
    coordinator.reconcile(["A", "B", "C"]);
    coordinator.reconcile(["D"]);
    await flush();
    expect(calls).toEqual(["D"]);
  });

  it("reconcile 移除已启动 key 后，迟到结果和错误都不回填", async () => {
    const running = deferred<string>();
    const updates: string[] = [];
    const coordinator = new KeyedPreviewCoordinator<string, string, string>({
      execute: () => running.promise,
      onSuccess: (key) => updates.push(`success:${key}`),
      onError: (key) => updates.push(`error:${key}`),
      onSettled: (key) => updates.push(`finally:${key}`),
    }, 1);

    coordinator.activate("v1");
    coordinator.reconcile(["old-visible"]);
    await flush();
    coordinator.reconcile([]);
    running.resolve("late");
    await flush();
    expect(updates).toEqual([]);
  });

  it("失效、scope 变更和 dispose 后，旧成功、失败及 finally 都不回填", async () => {
    const old = deferred<string>();
    const updates: string[] = [];
    const coordinator = new KeyedPreviewCoordinator<string, string, string>({
      execute() { return old.promise; },
      onSuccess(key) { updates.push(`success:${key}`); },
      onError(key) { updates.push(`error:${key}`); },
      onSettled(key) { updates.push(`finally:${key}`); },
    }, 2);

    coordinator.activate("A");
    coordinator.enqueue("artifact");
    await flush();
    coordinator.activate("B");
    coordinator.invalidate();
    coordinator.dispose();
    old.reject(new Error("stale"));
    await flush();
    expect(updates).toEqual([]);
  });

  it("A→B→A 的修订切换只接纳最后 scope，旧成功、失败和 finally 都不影响它", async () => {
    const firstA = deferred<string>();
    const oldB = deferred<string>();
    const finalA = deferred<string>();
    const updates: string[] = [];
    const coordinator = new KeyedPreviewCoordinator<string, string, string>({
      execute: (_key, scope) => scope === "A-1" ? firstA.promise : scope === "B-1" ? oldB.promise : finalA.promise,
      onSuccess(_key, value, scope) { updates.push(`success:${scope}:${value}`); },
      onError(_key, _error, scope) { updates.push(`error:${scope}`); },
      onSettled(_key, scope) { updates.push(`finally:${scope}`); },
    }, 2);

    coordinator.activate("A-1");
    coordinator.enqueue("clip");
    await flush();
    coordinator.activate("B-1");
    coordinator.enqueue("clip");
    await flush();
    coordinator.activate("A-2");
    coordinator.enqueue("clip");
    firstA.resolve("old-a");
    oldB.reject(new Error("old-b"));
    await flush();
    finalA.resolve("new-a");
    await flush();
    expect(updates).toEqual(["success:A-2:new-a", "finally:A-2"]);
  });

  it("非当前分页的 hover 不调用 IPC", async () => {
    const calls: string[] = [];
    const coordinator = new KeyedPreviewCoordinator<string, string, { page: string }>({
      execute(key) { calls.push(key); return Promise.resolve(key); },
      onSuccess() {},
      onError() {},
      isEligible: (_key, scope) => scope.page === "current",
    }, 2);
    coordinator.activate({ page: "stale" });
    coordinator.enqueue("off-page-artifact");
    await flush();
    expect(calls).toEqual([]);
  });

  it("组件只将有限需求交给两个独立 coordinator，且业务路径不等待嵌套预览", async () => {
    const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const component = await readFile(path.join(workspace, "src/renderer/src/components/VideoEditorView.vue"), "utf8");
    expect(component).toContain('new KeyedPreviewCoordinator<string, EditNestedTimelinePreview, NestedPreviewScope>');
    expect(component).toContain('new KeyedPreviewCoordinator<string, Partial<EditMediaItem>, MediaPreviewScope>');
    expect(component.match(/}, 2, sharedPreviewExecutionQueue\);/g)).toHaveLength(2);
    expect(component).toContain("priorityClips: [");
    expect(component).toContain("selectedClip.value,");
    expect(component).toContain("previewClip.value,");
    expect(component).toContain("activeDissolve.value?.outgoing,");
    expect(component).toContain("...activeOverlayClips.value,");
    expect(component).toContain("tracks: active.value.tracks,");
    expect(component).toContain("invalidateNestedPreviews();\n  if (!id)");
    expect(component).toContain("mediaPreviewCoordinator.invalidate();");
    expect(component).toContain("mediaPreviewCoordinator.dispose();");
    expect(component).toContain("collectVideoEditorNestedPreviewIds({");
    expect(component).toContain("sharedPreviewExecutionQueue");
    expect(component).toContain("save({ scheduleNestedPreviews: false })");
    expect(component).toContain("@mouseleave=\"clearMediaPreviewDemand\"");
    expect(component).toContain("await suspendPreviewWork()");
    expect(component).toContain("await sharedPreviewExecutionQueue.whenIdle()");
    expect(component).toContain("new ReferenceCountedPreviewSuspension(");
    expect(component).toContain("mediaPreviewCoordinator.reconcile([item.artifactId]);");
    expect(component).not.toContain("await prepareNestedPreviews");
    expect(component).not.toContain("Promise.all(clips.map");
  });
});
