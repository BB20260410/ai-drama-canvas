import { describe, expect, it } from "vitest";
import { createProjectScopedActionGate } from "../src/renderer/src/project-scoped-action-gate.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("工程作用域异步操作门", () => {
  it("工程或单元变化后旧操作立即失效", () => {
    const gate = createProjectScopedActionGate();
    const token = gate.begin("/project-a", "unit-a");
    expect(gate.isCurrent(token, "/project-a", "unit-a")).toBe(true);
    expect(gate.isCurrent(token, "/project-b", "unit-a")).toBe(false);
    expect(gate.isCurrent(token, "/project-a", "unit-b")).toBe(false);
  });

  it("显式失效可阻止 A→B→A 后旧操作复活", () => {
    const gate = createProjectScopedActionGate();
    const token = gate.begin("/project-a", "unit-a");
    gate.invalidate();
    expect(gate.isCurrent(token, "/project-a", "unit-a")).toBe(false);
  });

  it("新操作替代旧操作，关闭后不再允许开始", () => {
    const gate = createProjectScopedActionGate();
    const first = gate.begin("/project-a", "unit-a");
    const second = gate.begin("/project-a", "unit-a");
    expect(gate.isCurrent(first, "/project-a", "unit-a")).toBe(false);
    expect(gate.isCurrent(second, "/project-a", "unit-a")).toBe(true);
    gate.dispose();
    expect(gate.isCurrent(second, "/project-a", "unit-a")).toBe(false);
    expect(() => gate.begin("/project-a", "unit-a")).toThrow("已关闭");
  });

  it("pin/add/import 分 lane 后，互不使对方的在途 owner 失效", () => {
    const pinGate = createProjectScopedActionGate();
    const addGate = createProjectScopedActionGate();
    const importGate = createProjectScopedActionGate();
    const pin = pinGate.begin("/project-a", "pin:asset-a");
    const add = addGate.begin("/project-a", "add-unit:unit-a");
    const externalImport = importGate.begin("/project-a", "external-media-import");

    expect(pinGate.isCurrent(pin, "/project-a", "pin:asset-a")).toBe(true);
    expect(addGate.isCurrent(add, "/project-a", "add-unit:unit-a")).toBe(true);
    expect(importGate.isCurrent(externalImport, "/project-a", "external-media-import")).toBe(true);
  });

  it("A→B 切工程后，A 的迟到 finally 不会清掉 B 的 busy owner", async () => {
    const gate = createProjectScopedActionGate();
    const oldResult = deferred();
    const newResult = deferred();
    let currentRoot = "/project-a";
    let busy = false;

    const run = async (root: string, result: ReturnType<typeof deferred>) => {
      const actionId = "external-media-import";
      const token = gate.begin(root, actionId);
      busy = true;
      await result.promise;
      if (gate.isCurrent(token, currentRoot, actionId)) busy = false;
    };

    const oldRun = run(currentRoot, oldResult);
    gate.invalidate();
    busy = false; // root watcher 的同步清理
    currentRoot = "/project-b";
    const newRun = run(currentRoot, newResult);

    oldResult.resolve();
    await oldRun;
    expect(busy).toBe(true);

    newResult.resolve();
    await newRun;
    expect(busy).toBe(false);
  });

  it("A→B 后迟到的 detail、catch 与 finally 都不能污染 B 的选择和反馈", async () => {
    const gate = createProjectScopedActionGate();
    const oldResult = deferred();
    const newResult = deferred();
    let currentRoot = "/project-a";
    let selection = "asset-a-pending";
    let error = "";
    let loading = false;

    const run = async (
      root: string,
      result: ReturnType<typeof deferred>,
      nextSelection: string,
      shouldFail = false,
    ) => {
      const lane = "asset-detail";
      const token = gate.begin(root, lane);
      loading = true;
      try {
        await result.promise;
        if (shouldFail) throw new Error("A detail failed");
        if (gate.isCurrent(token, currentRoot, lane)) selection = nextSelection;
      } catch (reason) {
        if (gate.isCurrent(token, currentRoot, lane)) {
          error = reason instanceof Error ? reason.message : String(reason);
        }
      } finally {
        if (gate.isCurrent(token, currentRoot, lane)) loading = false;
      }
    };

    const oldRun = run(currentRoot, oldResult, "asset-a", true);
    gate.invalidate();
    currentRoot = "/project-b";
    selection = "asset-b-pending";
    error = "";
    loading = false;
    const newRun = run(currentRoot, newResult, "asset-b");

    oldResult.resolve();
    await oldRun;
    expect({ selection, error, loading }).toEqual({
      selection: "asset-b-pending",
      error: "",
      loading: true,
    });

    newResult.resolve();
    await newRun;
    expect({ selection, error, loading }).toEqual({
      selection: "asset-b",
      error: "",
      loading: false,
    });
  });

  it("同工程刷新先撤销旧 owner，失败不恢复，只有最新成功请求可恢复", async () => {
    const gate = createProjectScopedActionGate();
    const firstResult = deferred();
    const secondResult = deferred();
    const root = "/project-a";
    const actionId = "generation-progress";
    let ownerRoot = root;

    const refresh = async (result: ReturnType<typeof deferred>, succeeds: boolean) => {
      const token = gate.begin(root, actionId);
      ownerRoot = "";
      await result.promise;
      if (!succeeds) return;
      if (gate.isCurrent(token, root, actionId)) ownerRoot = root;
    };

    const first = refresh(firstResult, true);
    const second = refresh(secondResult, false);
    expect(ownerRoot).toBe("");

    firstResult.resolve();
    await first;
    expect(ownerRoot).toBe("");

    secondResult.resolve();
    await second;
    expect(ownerRoot).toBe("");

    const finalResult = deferred();
    const finalRefresh = refresh(finalResult, true);
    finalResult.resolve();
    await finalRefresh;
    expect(ownerRoot).toBe(root);
  });
});
