import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createProjectScopedActionGate } from "../src/renderer/src/project-scoped-action-gate.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("Review Studio history latest-only gate", () => {
  it("A→B 后 A 的迟到成功或失败都不能覆盖 B", async () => {
    const gate = createProjectScopedActionGate();
    const a = deferred<string[]>();
    const b = deferred<string[]>();
    const root = "/project";
    let activeItemId = "item-a";
    let history: string[] = [];
    let error = "";

    const load = async (itemId: string, result: ReturnType<typeof deferred<string[]>>) => {
      const token = gate.begin(root, itemId);
      history = [];
      try {
        const next = await result.promise;
        if (gate.isCurrent(token, root, activeItemId)) history = next;
      } catch (reason) {
        if (gate.isCurrent(token, root, activeItemId)) {
          error = reason instanceof Error ? reason.message : String(reason);
        }
      }
    };

    const oldRun = load("item-a", a);
    activeItemId = "item-b";
    const currentRun = load("item-b", b);
    b.resolve(["history-b"]);
    await currentRun;
    expect(history).toEqual(["history-b"]);

    a.resolve(["history-a"]);
    await oldRun;
    expect({ history, error }).toEqual({ history: ["history-b"], error: "" });

    const staleFailure = deferred<string[]>();
    activeItemId = "item-a";
    const staleRun = load("item-a", staleFailure);
    activeItemId = "item-b";
    const finalResult = deferred<string[]>();
    const finalRun = load("item-b", finalResult);
    staleFailure.reject(new Error("stale-a-failure"));
    await staleRun;
    expect(error).toBe("");
    finalResult.resolve(["history-b-final"]);
    await finalRun;
    expect(history).toEqual(["history-b-final"]);
  });

  it("ReviewStudioView 将 history 请求接到独立 gate，并在卸载时关闭", async () => {
    const source = await readFile(
      path.join(process.cwd(), "src/renderer/src/components/ReviewStudioView.vue"),
      "utf8",
    );
    expect(source).toContain('from "../project-scoped-action-gate"');
    expect(source).toContain("const historyRequestGate = createProjectScopedActionGate()");
    expect(source).toContain("historyRequestGate.begin(projectRoot, itemId)");
    expect(source).toContain("historyRequestGate.isCurrent(historyScope, props.projectRoot, activeId.value)");
    expect(source).toContain("historyRequestGate.dispose()");
  });

  it("当前 scope 历史读取失败投影为错误态并只 emit 一次，stale 失败不投影也不 emit", async () => {
    const gate = createProjectScopedActionGate();
    const root = "/project";
    let activeItemId = "item-a";
    let history: string[] = [];
    let historyError = "";
    const failedEvents: string[] = [];

    const load = async (itemId: string, result: ReturnType<typeof deferred<string[]>>) => {
      const token = gate.begin(root, itemId);
      history = [];
      historyError = "";
      try {
        const next = await result.promise;
        if (gate.isCurrent(token, root, activeItemId)) history = next;
      } catch (reason) {
        if (!gate.isCurrent(token, root, activeItemId)) return;
        historyError = reason instanceof Error ? reason.message : String(reason);
        failedEvents.push(historyError);
      }
    };

    const failing = deferred<string[]>();
    const failingRun = load("item-a", failing);
    failing.reject(new Error("history-read-broken"));
    await failingRun;
    expect(history).toEqual([]);
    expect(historyError).toBe("history-read-broken");
    expect(failedEvents).toEqual(["history-read-broken"]);

    activeItemId = "item-b";
    const ok = deferred<string[]>();
    const okRun = load("item-b", ok);
    ok.resolve(["history-b"]);
    await okRun;
    expect({ history, historyError }).toEqual({ history: ["history-b"], historyError: "" });

    activeItemId = "item-a";
    const stale = deferred<string[]>();
    const staleRun = load("item-a", stale);
    activeItemId = "item-b";
    const current = deferred<string[]>();
    const currentRun = load("item-b", current);
    stale.reject(new Error("stale-failure"));
    await staleRun;
    expect(historyError).toBe("");
    expect(failedEvents).toEqual(["history-read-broken"]);
    current.resolve(["history-b-final"]);
    await currentRun;
    expect(history).toEqual(["history-b-final"]);
    expect(historyError).toBe("");
  });

  it("ReviewStudioView 用独立 historyError 区分失败态与空态，失败不再向上抛出", async () => {
    const source = await readFile(
      path.join(process.cwd(), "src/renderer/src/components/ReviewStudioView.vue"),
      "utf8",
    );
    expect(source).toContain('const historyError = ref("")');

    const reset = source.slice(
      source.indexOf("async function resetActive"),
      source.indexOf("function chooseVariant"),
    );
    expect(reset.indexOf('historyError.value = ""')).toBeGreaterThan(-1);
    expect(reset.indexOf("history.value = []")).toBeLessThan(reset.indexOf("historyRequestGate.begin"));
    expect(reset.indexOf('historyError.value = ""')).toBeLessThan(reset.indexOf("historyRequestGate.begin"));
    expect(reset).toContain("historyError.value = message(error)");
    expect(reset).toContain('emit("failed", historyError.value)');
    expect(reset).not.toContain("throw error");

    expect(source).toContain('data-testid="review-history-error"');
    expect(source).toContain('role="alert"');
    expect(source).toContain('v-if="!historyError && !history.length"');
    expect(source).toContain("尚无视觉验收记录");
  });
});
