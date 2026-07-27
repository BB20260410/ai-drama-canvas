import { describe, expect, it } from "vitest";
import {
  runtimeGateRequiredForIpc,
  runtimeIpcEffect,
  runtimeIpcGateMode,
} from "../src/core/runtime-ipc-effect.js";

describe("源码桌面 IPC 副作用默认拒绝策略", () => {
  it("把诊断、物理读取、写入和外部副作用分开，未知通道默认 mutation", () => {
    expect(runtimeIpcEffect("canvas:get-runtime-write-gate")).toBe("diagnostic-read");
    expect(runtimeIpcEffect("canvas:get-active-project")).toBe("read-only");
    expect(runtimeIpcEffect("canvas:get-default-managed-projects-root")).toBe("read-only");
    expect(runtimeIpcEffect("canvas:get-managed-project-operation-state")).toBe("read-only");
    expect(runtimeIpcEffect("canvas:get-local-creative-project-ingest-status")).toBe("read-only");
    expect(runtimeIpcEffect("canvas:load-studio-canvas-layout")).toBe("read-only");
    expect(runtimeIpcEffect("canvas:get-studio-unit-write-leases")).toBe("read-only");
    expect(runtimeIpcEffect("canvas:pick-managed-projects-parent")).toBe("external-side-effect");
    expect(runtimeIpcEffect("canvas:show-in-folder")).toBe("external-side-effect");
    expect(runtimeIpcEffect("canvas:new-unregistered-channel")).toBe("mutation");
  });

  it("仅诊断绕过 wrapper，物理读取走缓存门，写入与外部副作用走强门", () => {
    expect(runtimeIpcGateMode("canvas:get-runtime-write-gate")).toBe("bypass");
    expect(runtimeIpcGateMode("canvas:get-runtime-build-identity")).toBe("bypass");
    expect(runtimeIpcGateMode("canvas:get-active-project")).toBe("cached-read");
    expect(runtimeIpcGateMode("canvas:get-index")).toBe("strong");
    expect(runtimeIpcGateMode("canvas:pick-managed-projects-parent")).toBe("strong");
  });

  it("保留旧布尔接口；名称像读取但实际可能写入的通道仍必须过强闸", () => {
    expect(runtimeGateRequiredForIpc("canvas:get-runtime-write-gate")).toBe(false);
    expect(runtimeGateRequiredForIpc("canvas:get-runtime-build-identity")).toBe(false);
    expect(runtimeGateRequiredForIpc("canvas:get-active-project")).toBe(true);
    expect(runtimeGateRequiredForIpc("canvas:get-index")).toBe(true);
    expect(runtimeGateRequiredForIpc("canvas:pick-and-import-studio-script")).toBe(true);
    expect(runtimeGateRequiredForIpc("canvas:pick-and-import-studio-prompt")).toBe(true);
    expect(runtimeGateRequiredForIpc("canvas:get-studio-generation-review-control")).toBe(true);
    expect(runtimeGateRequiredForIpc("canvas:new-unregistered-channel")).toBe(true);
  });
});
