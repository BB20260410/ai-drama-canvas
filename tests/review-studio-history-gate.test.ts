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
});
