import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { computed, nextTick, ref, watch } from "vue";
import { describe, expect, it } from "vitest";
import { createVideoEditorPreviewSyncScheduler } from "../src/renderer/src/video-editor-preview-sync.js";

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe("视频编辑预览同步调度", () => {
  it("复现 P2：旧接法下同批 watcher 直调与 seek 的 nextTick 会同步两次", async () => {
    const syncs: string[] = [];
    const sync = () => syncs.push("sync");
    const playhead = ref(0);
    // 与组件一致：叠加层 computed 依赖播放头，post-flush watcher 直接同步。
    const activeOverlayClips = computed(() => (playhead.value >= 1 && playhead.value < 2 ? ["overlay"] : []));
    watch([activeOverlayClips], () => sync(), { flush: "post" });
    // 与组件旧 seek 一致：设置播放头后 nextTick 再安排一次同步。
    const seek = (value: number) => {
      playhead.value = value;
      void nextTick(sync);
    };
    seek(1.5);
    await flush();
    expect(syncs).toHaveLength(2);
  });

  it("同一刷新批次的 watcher 请求与 seek 请求只执行一次同步，下一批仍可执行", async () => {
    const syncs: string[] = [];
    const scheduler = createVideoEditorPreviewSyncScheduler(() => syncs.push("sync"));
    const playhead = ref(0);
    const activeOverlayClips = computed(() => (playhead.value >= 1 && playhead.value < 2 ? ["overlay"] : []));
    watch([activeOverlayClips], () => { void scheduler.request(); }, { flush: "post" });
    const seek = (value: number) => {
      playhead.value = value;
      void scheduler.request();
    };
    seek(1.5); // 同批：seek 请求 + watcher 请求
    await flush();
    expect(syncs).toHaveLength(1);
    seek(1.6); // 下一批：仍可执行
    await flush();
    expect(syncs).toHaveLength(2);
    seek(0.5); // 播放中每个 tick 仍各同步一次（漂移校正不降级）
    await flush();
    expect(syncs).toHaveLength(3);
  });

  it("播放开始与同批 post-flush watcher 共用一次同步，不在首个 tick 前重复 seek/play", async () => {
    const syncs: string[] = [];
    const playing = ref(false);
    const scheduler = createVideoEditorPreviewSyncScheduler(() => syncs.push("sync"));
    watch(playing, () => { void scheduler.request(); }, { flush: "post" });

    playing.value = true;
    void scheduler.request();
    await flush();

    expect(syncs).toEqual(["sync"]);
  });

  it("同批任意多个请求只执行一次，且同步读取最新状态", async () => {
    const executions: number[] = [];
    const playhead = ref(0);
    const scheduler = createVideoEditorPreviewSyncScheduler(() => executions.push(playhead.value));
    void scheduler.request();
    playhead.value = 3;
    void scheduler.request();
    void scheduler.request();
    await flush();
    expect(executions).toEqual([3]);
  });

  it("await request 在该批同步执行后兑现，与同批其他请求共享一次执行", async () => {
    const order: string[] = [];
    const scheduler = createVideoEditorPreviewSyncScheduler(() => order.push("sync"));
    void scheduler.request();
    await scheduler.request();
    order.push("after");
    expect(order).toEqual(["sync", "after"]);
  });

  it("invalidate 后迟到任务被丢弃且不回填，后续请求立即兑现且不再同步", async () => {
    const syncs: string[] = [];
    const scheduler = createVideoEditorPreviewSyncScheduler(() => syncs.push("sync"));
    const pending = scheduler.request();
    scheduler.invalidate();
    await pending; // 已排队任务正常兑现，但不再执行同步
    await flush();
    expect(syncs).toHaveLength(0);
    await scheduler.request(); // 卸载后迟到的请求直接作废
    await flush();
    expect(syncs).toHaveLength(0);
  });

  it("同步异常被稳定投影且不形成未处理拒绝，下一批仍可重新调度", async () => {
    const errors: unknown[] = [];
    let calls = 0;
    const scheduler = createVideoEditorPreviewSyncScheduler(() => {
      calls += 1;
      if (calls === 1) throw new Error("media state unavailable");
    }, (error) => errors.push(error));

    await expect(scheduler.request()).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
    await expect(scheduler.request()).resolves.toBeUndefined();
    expect(calls).toBe(2);
    expect(errors).toHaveLength(1);
  });

  it("组件仅将两个 post-flush watcher 与 seek 交给同一调度 owner，卸载时失效", async () => {
    const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const component = await readFile(path.join(workspace, "src/renderer/src/components/VideoEditorView.vue"), "utf8");
    expect(component).toContain("const previewSyncScheduler = createVideoEditorPreviewSyncScheduler(");
    expect(component).toContain("  syncPreview,");
    expect(component).toContain("预览同步失败：${message(error)}");
    expect(component).toMatch(/\(error\) => \{\s*stopPlayback\(\);\s*emit\("failed", `预览同步失败：\$\{message\(error\)\}`\);\s*\}/u);
    expect(component).toContain("watch([previewClip, activeDissolve, activeOverlayClips], () => { void previewSyncScheduler.request(); }, { flush: \"post\" });");
    expect(component).toMatch(/watch\(\(\) => active\.value\?\.tracks[\s\S]*?\(\) => \{ void previewSyncScheduler\.request\(\); \}, \{ flush: \"post\" \}\);/);
    expect(component).toMatch(/function seek\([\s\S]*?playhead\.value = quantizeTimelineTime[\s\S]*?void previewSyncScheduler\.request\(\);\n\}/);
    const toggleStart = component.indexOf("function togglePlayback()");
    const toggleEnd = component.indexOf("\nfunction stopPlayback()", toggleStart);
    const togglePlaybackSource = component.slice(toggleStart, toggleEnd);
    expect(togglePlaybackSource).toContain("playing.value = true;\n  void previewSyncScheduler.request();");
    expect(togglePlaybackSource).not.toContain("syncPreview()");
    expect(togglePlaybackSource).not.toContain("nextTick(");
    expect(component.match(/previewSyncScheduler\.request\(\)/g)).toHaveLength(4);
    expect(component).toContain("previewSyncScheduler.invalidate()");
  });
});
