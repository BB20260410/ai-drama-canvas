import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  runtimeGateRequiredForIpc,
  runtimeIpcEffect,
  runtimeIpcEffectContextFromInvokeArgs,
  runtimeIpcGateMode,
} from "../src/core/runtime-ipc-effect.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("源码桌面 IPC 副作用默认拒绝策略", () => {
  it("把诊断、物理读取、写入和外部副作用分开，未知通道默认 mutation", () => {
    expect(runtimeIpcEffect("canvas:get-runtime-write-gate")).toBe("diagnostic-read");
    expect(runtimeIpcEffect("canvas:get-active-project")).toBe("read-only");
    expect(runtimeIpcEffect("canvas:get-managed-project-shell")).toBe("read-only");
    expect(runtimeIpcEffect("canvas:get-active-hybrid-workspace-preference")).toBe("read-only");
    expect(runtimeIpcEffect("canvas:get-default-managed-projects-root")).toBe("read-only");
    expect(runtimeIpcEffect("canvas:get-managed-project-operation-state")).toBe("read-only");
    expect(runtimeIpcEffect("canvas:get-local-creative-project-ingest-status")).toBe("read-only");
    expect(runtimeIpcEffect("canvas:novel-get-workspace")).toBe("read-only");
    expect(runtimeIpcEffect("canvas:novel-get-navigation")).toBe("read-only");
    expect(runtimeIpcEffect("canvas:novel-list-chapters")).toBe("read-only");
    expect(runtimeIpcEffect("canvas:novel-read-chapter")).toBe("read-only");
    expect(runtimeIpcEffect("canvas:novel-search-chapters")).toBe("read-only");
    expect(runtimeIpcEffect("canvas:novel-list-facts")).toBe("read-only");
    expect(runtimeIpcEffect("canvas:list-global-studio-assets")).toBe("read-only");
    expect(runtimeIpcEffect("canvas:list-global-studio-asset-images")).toBe("read-only");
    expect(runtimeIpcEffect("canvas:get-global-studio-asset-image")).toBe("read-only");
    expect(runtimeIpcEffect("canvas:list-global-studio-image-resources")).toBe("read-only");
    expect(runtimeIpcEffect("canvas:get-global-studio-image-resource")).toBe("read-only");
    expect(runtimeIpcEffect("canvas:list-global-studio-media-resources")).toBe("read-only");
    expect(runtimeIpcEffect("canvas:get-global-studio-media-resource")).toBe("read-only");
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
    expect(runtimeIpcGateMode("canvas:get-managed-project-shell")).toBe("cached-read");
    expect(runtimeIpcGateMode("canvas:novel-search-chapters")).toBe("cached-read");
    expect(runtimeIpcGateMode("canvas:list-global-studio-assets")).toBe("cached-read");
    expect(runtimeIpcGateMode("canvas:list-global-studio-asset-images")).toBe("cached-read");
    expect(runtimeIpcGateMode("canvas:get-global-studio-asset-image")).toBe("cached-read");
    expect(runtimeIpcGateMode("canvas:list-global-studio-image-resources")).toBe("cached-read");
    expect(runtimeIpcGateMode("canvas:get-global-studio-image-resource")).toBe("cached-read");
    expect(runtimeIpcGateMode("canvas:list-global-studio-media-resources")).toBe("cached-read");
    expect(runtimeIpcGateMode("canvas:get-global-studio-media-resource")).toBe("cached-read");
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

describe("驾驶舱 units 只读与 mutation 失败关闭", () => {
  const dashboard = "canvas:get-studio-production-dashboard";
  const unitsContext = { operation: "units" };

  it("units dashboard IPC 走 read；缺 operation / 未知通道 / 真写入仍是 mutation", () => {
    expect(runtimeIpcEffect(dashboard, unitsContext)).toBe("read-only");
    expect(runtimeIpcGateMode(dashboard, unitsContext)).toBe("cached-read");
    expect(runtimeIpcEffect(dashboard, runtimeIpcEffectContextFromInvokeArgs(
      dashboard,
      [{}, "/tmp/project", { operation: "units", limit: 36 }],
    ))).toBe("read-only");

    expect(runtimeIpcEffect(dashboard)).toBe("mutation");
    expect(runtimeIpcGateMode(dashboard)).toBe("strong");
    expect(runtimeIpcEffect(dashboard, { operation: "overview" })).toBe("mutation");
    expect(runtimeIpcEffect(dashboard, { operation: "unit" })).toBe("mutation");
    expect(runtimeIpcEffect(dashboard, { operation: "assets" })).toBe("mutation");
    expect(runtimeIpcEffect(dashboard, { operation: "unknown-op" })).toBe("mutation");
    expect(runtimeIpcEffectContextFromInvokeArgs(dashboard, [{}, "/tmp/project"])).toBeUndefined();
    expect(runtimeIpcEffectContextFromInvokeArgs(dashboard, [{}, "/tmp/project", "units"])).toBeUndefined();

    expect(runtimeIpcEffect("canvas:reconcile-active-managed-project-startup")).toBe("mutation");
    expect(runtimeIpcGateMode("canvas:reconcile-active-managed-project-startup")).toBe("strong");
    expect(runtimeIpcEffect("canvas:preflight-active-managed-project-startup")).toBe("read-only");
    expect(runtimeIpcGateMode("canvas:preflight-active-managed-project-startup")).toBe("cached-read");
    expect(runtimeIpcEffect("canvas:save-studio-canvas-layout")).toBe("mutation");
    expect(runtimeIpcEffect("canvas:get-studio-frozen-pack")).toBe("mutation");
    expect(runtimeIpcEffect("canvas:new-unregistered-channel")).toBe("mutation");
    expect(runtimeIpcGateMode("canvas:new-unregistered-channel")).toBe("strong");
  });

  it("main wrapper 必须按 invoke args 分类，不能把整条 dashboard 通道写成 read", () => {
    const main = readFileSync(path.join(root, "src/main/index.ts"), "utf8");
    const wrapper = main.slice(
      main.indexOf("function installSourceRuntimeWriteGate"),
      main.indexOf("async function startSourceRuntimeGateWatchers"),
    );
    expect(wrapper).toContain("runtimeIpcEffectContextFromInvokeArgs(channel, args)");
    expect(wrapper).toContain("runtimeIpcEffect(channel, context)");
    expect(wrapper).toContain("runtimeIpcGateMode(channel, context)");
    expect(main).not.toContain("RUNTIME_GATE_READ_ONLY_CHANNELS = new Set");
    const effectOwner = readFileSync(path.join(root, "src/core/runtime-ipc-effect.ts"), "utf8");
    const readOnlySetStart = effectOwner.indexOf("export const RUNTIME_GATE_READ_ONLY_CHANNELS");
    const readOnlySet = effectOwner.slice(
      readOnlySetStart,
      effectOwner.indexOf("]);", readOnlySetStart) + 3,
    );
    expect(readOnlySet).toContain("canvas:get-active-project");
    expect(readOnlySet).not.toContain("get-studio-production-dashboard");
    expect(effectOwner).toContain("RUNTIME_GATE_READ_ONLY_DASHBOARD_OPERATIONS = new Set<string>([");
    expect(effectOwner).toContain('"units"');
    expect(effectOwner).not.toContain('"overview"');
  });

  it("项目列表只放行严格的缓存读取形态；刷新和畸形调用保持 strong", () => {
    const list = "canvas:list-projects";
    expect(runtimeIpcEffect(list, runtimeIpcEffectContextFromInvokeArgs(list, [{}]))).toBe("read-only");
    expect(runtimeIpcEffect(list, runtimeIpcEffectContextFromInvokeArgs(list, [{}, null]))).toBe("read-only");
    expect(runtimeIpcEffect(list, runtimeIpcEffectContextFromInvokeArgs(list, [{}, {
      requestId: "startup-list-1",
      sourceProjectRoot: "/tmp/project",
      refreshSources: false,
    }]))).toBe("read-only");
    for (const rawOptions of [
      { refreshSources: true },
      [],
      "not-an-options-object",
      { unexpected: true },
      { refreshSources: "false" },
      { requestId: "not valid spaces" },
      { sourceProjectRoot: "relative/path" },
    ]) {
      expect(runtimeIpcEffect(list, runtimeIpcEffectContextFromInvokeArgs(list, [{}, rawOptions]))).toBe("mutation");
      expect(runtimeIpcGateMode(list, runtimeIpcEffectContextFromInvokeArgs(list, [{}, rawOptions]))).toBe("strong");
    }
    const main = readFileSync(path.join(root, "src/main/index.ts"), "utf8");
    expect(main).toContain("项目清单请求包含未知字段。");
  });
});
