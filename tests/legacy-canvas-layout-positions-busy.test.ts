import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "@vue/compiler-sfc";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function source(): string {
  return readFileSync(path.join(root, "src/renderer/src/App.vue"), "utf8");
}

function handlerBody(text: string, signature: string, nextSignature: string): string {
  const start = text.indexOf(signature);
  const end = text.indexOf(nextSignature, start + signature.length);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return text.slice(start, end);
}

describe("旧语义画布生产卡布局落盘源码合同", () => {
  it("SFC 可解析，生产卡拖拽停止走 persistLayoutPositions 写 saveLayout", () => {
    const vue = source();
    expect(parse(vue, { filename: "App.vue" }).errors).toEqual([]);
    expect(vue).toContain('@node-drag-stop="onNodeDragStop"');
    const drag = handlerBody(vue, "function onNodeDragStop(", "function onMove(");
    expect(drag).toContain("void persistLayoutPositions(");
    expect(drag).toContain("void saveCanvasEntityMove(");
    expect(drag).toContain("void saveGroupMemberOffset(");
  });

  it("保存布局进行中 fail-closed：专用 layoutPositionsBusy 在首个 await 之前置位，连次拖拽不会重复 saveLayout，忙时明确失败而不是静默", () => {
    const vue = source();
    expect(vue).toContain("const layoutPositionsBusy = ref(false);");
    expect(vue).toContain("layoutPositionsBusy.value = false;");

    const persist = handlerBody(vue, "async function persistLayoutPositions(", "async function rebuildFlow(");
    expect(persist).toContain("if (layoutPositionsBusy.value)");
    expect(persist).toContain('showMessage("正在保存布局，不能再改卡片位置", true)');
    expect(persist).toContain("layoutPositionsBusy.value = true");
    expect(persist).not.toContain("canvasHistoryBusy.value");
    expect(persist).not.toContain("savingCanvasEntity.value");
    expect(persist.indexOf("if (layoutPositionsBusy.value)")).toBeLessThan(
      persist.indexOf("layoutPositionsBusy.value = true"),
    );
    expect(persist.indexOf('showMessage("正在保存布局，不能再改卡片位置", true)')).toBeLessThan(
      persist.indexOf("layoutPositionsBusy.value = true"),
    );
    expect(persist.indexOf("layoutPositionsBusy.value = true")).toBeLessThan(
      persist.indexOf("await window.canvasApi.saveLayout"),
    );
    expect(persist).toContain("layoutPositionsBusy.value = false");
    expect(persist.indexOf("layoutPositionsBusy.value = true")).toBeLessThan(
      persist.indexOf("layoutPositionsBusy.value = false"),
    );
  });
});
