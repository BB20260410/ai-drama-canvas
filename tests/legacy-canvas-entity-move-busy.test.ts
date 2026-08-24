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

describe("旧语义画布实体拖拽落盘源码合同", () => {
  it("SFC 可解析，拖拽停止走 saveCanvasEntityMove 写侧车", () => {
    const vue = source();
    expect(parse(vue, { filename: "App.vue" }).errors).toEqual([]);
    expect(vue).toContain('@node-drag-stop="onNodeDragStop"');
    const drag = handlerBody(vue, "function onNodeDragStop(", "function onMove(");
    expect(drag).toContain("void saveCanvasEntityMove(");
  });

  it("移动画布实体进行中 fail-closed：busy 在首个 await 之前置位，连次拖拽不会重复 move，忙时明确失败而不是静默", () => {
    const vue = source();
    const move = handlerBody(vue, "async function saveCanvasEntityMove(", "async function saveGroupMemberOffset(");
    expect(move).toContain("if (canvasHistoryBusy.value || savingCanvasEntity.value)");
    expect(move).toContain('showMessage("正在处理，不能再移动画布实体", true)');
    expect(move).toContain("canvasHistoryBusy.value = true");
    expect(move.indexOf("if (canvasHistoryBusy.value || savingCanvasEntity.value)")).toBeLessThan(
      move.indexOf("canvasHistoryBusy.value = true"),
    );
    expect(move.indexOf("canvasHistoryBusy.value = true")).toBeLessThan(
      move.indexOf("await window.canvasApi.moveCanvasEntities"),
    );
    expect(move).toContain("canvasHistoryBusy.value = false");
    expect(move.indexOf('showMessage("正在处理，不能再移动画布实体", true)')).toBeLessThan(
      move.indexOf("canvasHistoryBusy.value = true"),
    );
  });
});
