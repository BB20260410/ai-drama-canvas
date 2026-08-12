import { describe, expect, it } from "vitest";
import { createNovelProjectLoadGate } from "../src/renderer/src/novel-project-load-gate.js";

describe("小说 renderer 项目异步代次门", () => {
  it("旧根晚返回不能覆盖新根状态", async () => {
    const gate = createNovelProjectLoadGate();
    let currentRoot = "/projects/A";
    let visible = "";
    let releaseA!: () => void;
    const waitA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const tokenA = gate.begin(currentRoot);
    const requestA = waitA.then(() => {
      if (gate.isCurrent(tokenA, currentRoot)) visible = "A";
    });

    currentRoot = "/projects/B";
    const tokenB = gate.begin(currentRoot);
    if (gate.isCurrent(tokenB, currentRoot)) visible = "B";
    releaseA();
    await requestA;

    expect(visible).toBe("B");
    expect(gate.isCurrent(tokenA, currentRoot)).toBe(false);
    expect(gate.isCurrent(tokenB, currentRoot)).toBe(true);
  });

  it("离开请求会使同根仍在途结果失效", () => {
    const gate = createNovelProjectLoadGate();
    const token = gate.begin("/projects/A");
    gate.invalidate();
    expect(gate.isCurrent(token, "/projects/A")).toBe(false);
  });
});
