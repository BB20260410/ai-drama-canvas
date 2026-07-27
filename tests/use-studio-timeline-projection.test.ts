/**
 * T12/T13 前端投影 composable 的异步 token 绑定测试。
 * 验证：旧响应（root 已切换 / seq 非最新 / 已 invalidate）落地前被丢弃；
 * reset 清空投影并使在途失效；getContinuousState 旧响应返回 null。
 */
import { afterEach, describe, expect, it } from "vitest";
import { ref } from "vue";
import {
  resolveTimelineProjectionScope,
  useStudioTimelineProjection,
} from "../src/renderer/src/composables/useStudioTimelineProjection.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeProjection(unitId: string) {
  return {
    units: [{
      unitId,
      displaySequence: 1,
      displayLabel: `001｜S1E1-${unitId}`,
      title: unitId,
      productionStatus: "pass",
      selectedRawSha256: null,
      latestRunId: null,
      reviewStatus: "pass",
      panelCount: 4,
      candidateWarning: null,
      projectionError: null,
    }],
    summary: { pass: 1, pendingReview: 0, inProgress: 0, failed: 0, blocked: 0 },
    builtAt: "2026-07-25T00:00:00.000Z",
  };
}

function installCanvasApi(api: Record<string, unknown>): void {
  (globalThis as Record<string, unknown>).window = { canvasApi: api };
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).window;
});

describe("useStudioTimelineProjection 异步 token 绑定", () => {
  it("当前请求正常落地 projection/summary", async () => {
    installCanvasApi({ getApprovedTimelineProjection: async () => makeProjection("u1") });
    const root = ref("/proj-a");
    const tp = useStudioTimelineProjection(root);
    await tp.refresh("S1", "S1E2");
    expect(tp.projection.value?.[0]?.unitId).toBe("u1");
    expect(tp.summary.value?.pass).toBe(1);
    expect(tp.loading.value).toBe(false);
    expect(tp.error.value).toBeNull();
  });

  it("旧 seq 响应（乱序到达）被丢弃，不覆盖更新的投影", async () => {
    const first = deferred<ReturnType<typeof makeProjection>>();
    const second = deferred<ReturnType<typeof makeProjection>>();
    let call = 0;
    installCanvasApi({
      getApprovedTimelineProjection: () => (++call === 1 ? first.promise : second.promise),
    });
    const root = ref("/proj-a");
    const tp = useStudioTimelineProjection(root);
    const slow = tp.refresh("S1", "S1E2");
    const fast = tp.refresh("S1", "S1E2");
    second.resolve(makeProjection("newer"));
    await fast;
    expect(tp.projection.value?.[0]?.unitId).toBe("newer");
    first.resolve(makeProjection("stale"));
    await slow;
    expect(tp.projection.value?.[0]?.unitId).toBe("newer");
    expect(tp.loading.value).toBe(false);
  });

  it("root 切换后在途响应被丢弃", async () => {
    const pending = deferred<ReturnType<typeof makeProjection>>();
    installCanvasApi({ getApprovedTimelineProjection: () => pending.promise });
    const root = ref("/proj-a");
    const tp = useStudioTimelineProjection(root);
    const inflight = tp.refresh("S1", "S1E2");
    root.value = "/proj-b";
    pending.resolve(makeProjection("stale-root"));
    await inflight;
    expect(tp.projection.value).toBeNull();
    expect(tp.summary.value).toBeNull();
  });

  it("reset 清空投影并使在途响应失效", async () => {
    const pending = deferred<ReturnType<typeof makeProjection>>();
    installCanvasApi({ getApprovedTimelineProjection: () => pending.promise });
    const root = ref("/proj-a");
    const tp = useStudioTimelineProjection(root);
    const inflight = tp.refresh("S1", "S1E2");
    tp.reset();
    expect(tp.projection.value).toBeNull();
    expect(tp.summary.value).toBeNull();
    expect(tp.lastUpdated.value).toBeNull();
    expect(tp.loading.value).toBe(false);
    pending.resolve(makeProjection("after-reset"));
    await inflight;
    expect(tp.projection.value).toBeNull();
  });

  it("getContinuousState：root 切换后旧响应返回 null", async () => {
    const pending = deferred<{ status: string }>();
    installCanvasApi({ getContinuousGenerationState: () => pending.promise });
    const root = ref("/proj-a");
    const tp = useStudioTimelineProjection(root);
    const inflight = tp.getContinuousState("S1", "S1E2");
    root.value = "/proj-b";
    pending.resolve({ status: "running" });
    expect(await inflight).toBeNull();
  });

  it("getContinuousState：invalidate 后在途响应返回 null", async () => {
    const pending = deferred<{ status: string }>();
    installCanvasApi({ getContinuousGenerationState: () => pending.promise });
    const tp = useStudioTimelineProjection("/proj-a");
    const inflight = tp.getContinuousState("S1", "S1E2");
    tp.invalidate();
    pending.resolve({ status: "running" });
    expect(await inflight).toBeNull();
  });
});

describe("resolveTimelineProjectionScope 季集隔离", () => {
  it("显式选择季集时保持 S1E2，不回退到 S1E1", () => {
    expect(resolveTimelineProjectionScope({
      season: "S1",
      episode: "S1E2",
      units: [{ seasonId: "S1", episodeId: "S1E1" }],
    })).toEqual({ season: "S1", episode: "S1E2" });
  });

  it("未显式选择时可从单一季集页面推导", () => {
    expect(resolveTimelineProjectionScope({
      units: [
        { seasonId: "S1", episodeId: "S1E2" },
        { seasonId: "S1", episodeId: "S1E2" },
      ],
    })).toEqual({ season: "S1", episode: "S1E2" });
  });

  it("多季集混排时拒绝猜测，避免错误投影", () => {
    expect(resolveTimelineProjectionScope({
      units: [
        { seasonId: "S1", episodeId: "S1E1" },
        { seasonId: "S1", episodeId: "S1E2" },
      ],
    })).toBeNull();
  });
});
