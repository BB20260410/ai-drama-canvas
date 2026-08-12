import { describe, expect, it } from "vitest";
import { createStudioInitialOverviewReleaseGate } from "../src/renderer/src/studio-initial-overview-release-gate.js";

describe("素材中心首屏 overview 释放门", () => {
  it("同一工程只释放一次，旧工程迟到事件不能释放当前工程", () => {
    const gate = createStudioInitialOverviewReleaseGate();
    gate.reset("/tmp/project-a");

    expect(gate.tryRelease("/tmp/project-a")).toBe(true);
    expect(gate.tryRelease("/tmp/project-a")).toBe(false);

    gate.reset("/tmp/project-b");
    expect(gate.tryRelease("/tmp/project-a")).toBe(false);
    expect(gate.tryRelease("/tmp/project-b")).toBe(true);
  });

  it("手动刷新先占用释放权，后续首卡或失败事件不得重复请求", () => {
    const gate = createStudioInitialOverviewReleaseGate();
    gate.reset("/tmp/project-a");

    gate.markReleased("/tmp/project-a");

    expect(gate.isReleased("/tmp/project-a")).toBe(true);
    expect(gate.tryRelease("/tmp/project-a")).toBe(false);
    expect(gate.isReleased("/tmp/project-b")).toBe(false);
  });
});
