import { describe, expect, it } from "vitest";
import {
  runtimeMcpEffect,
  runtimeMcpGateMode,
} from "../src/core/runtime-mcp-effect.js";

describe("源码 MCP 物理副作用分类", () => {
  it("只让诊断绕过、已证明零写的活动上下文使用短缓存", () => {
    expect(runtimeMcpEffect("get_capabilities")).toBe("diagnostic-read");
    expect(runtimeMcpGateMode("get_capabilities")).toBe("bypass");
    expect(runtimeMcpEffect("get_active_managed_studio_context")).toBe("read-only");
    expect(runtimeMcpGateMode("get_active_managed_studio_context")).toBe("cached-read");
    expect(runtimeMcpEffect("get_canvas_state")).toBe("read-only");
    expect(runtimeMcpEffect("read_story_chapter")).toBe("read-only");
  });

  it("外部动作与未知工具都保持强门禁", () => {
    expect(runtimeMcpEffect("start_edit_render")).toBe("external-side-effect");
    expect(runtimeMcpGateMode("start_edit_render")).toBe("strong");
    expect(runtimeMcpEffect("new_unclassified_tool")).toBe("mutation");
    expect(runtimeMcpGateMode("new_unclassified_tool")).toBe("strong");
  });

  it("不信任名称看似只读但尚未证明零写的工具", () => {
    expect(runtimeMcpEffect("get_studio_production_dashboard")).toBe("mutation");
    expect(runtimeMcpEffect("list_studio_media")).toBe("mutation");
  });
});
