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

describe("旧语义画布组内卡片拖拽落盘源码合同", () => {
  it("SFC 可解析，组内生产卡拖拽停止走 saveGroupMemberOffset 写侧车", () => {
    const vue = source();
    expect(parse(vue, { filename: "App.vue" }).errors).toEqual([]);
    expect(vue).toContain('@node-drag-stop="onNodeDragStop"');
    const drag = handlerBody(vue, "function onNodeDragStop(", "function onMove(");
    expect(drag).toContain("void saveGroupMemberOffset(");
  });

  it("移动组内卡片进行中 fail-closed：busy 在首个 await 之前置位，连次拖拽不会重复 upsert，忙时明确失败而不是静默", () => {
    const vue = source();
    const offset = handlerBody(vue, "async function saveGroupMemberOffset(", "async function removeCanvasEntity(");
    expect(offset).toContain("if (canvasHistoryBusy.value || savingCanvasEntity.value)");
    expect(offset).toContain('showMessage("正在处理，不能再移动组内卡片", true)');
    expect(offset).toContain("canvasHistoryBusy.value = true");
    expect(offset.indexOf("if (canvasHistoryBusy.value || savingCanvasEntity.value)")).toBeLessThan(
      offset.indexOf("canvasHistoryBusy.value = true"),
    );
    expect(offset.indexOf("canvasHistoryBusy.value = true")).toBeLessThan(
      offset.indexOf("await window.canvasApi.upsertCanvasEntity"),
    );
    expect(offset).toContain("canvasHistoryBusy.value = false");
    expect(offset.indexOf('showMessage("正在处理，不能再移动组内卡片", true)')).toBeLessThan(
      offset.indexOf("canvasHistoryBusy.value = true"),
    );
  });
});
