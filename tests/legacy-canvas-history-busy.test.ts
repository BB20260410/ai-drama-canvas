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

describe("旧语义画布撤销/重做源码合同", () => {
  it("SFC 可解析并暴露撤销/重做入口与 ⌘Z 快捷键", () => {
    const vue = source();
    expect(parse(vue, { filename: "App.vue" }).errors).toEqual([]);
    expect(vue).toContain("@click=\"undoCanvas\"");
    expect(vue).toContain("@click=\"redoCanvas\"");
    expect(vue).toContain("function onCanvasShortcut(");
  });

  it("撤销/重做进行中 fail-closed：busy 在首个 await 之前置位，按钮禁用并给出大白话原因，⌘Z 连按不会重复写入", () => {
    const vue = source();

    expect(vue).toContain("const canvasHistoryBusy = ref(false);");
    expect(vue).toContain(':disabled="!canvasHistory.canUndo || canvasHistoryBusy || savingCanvasEntity"');
    expect(vue).toContain(':disabled="!canvasHistory.canRedo || canvasHistoryBusy || savingCanvasEntity"');
    expect(vue).toContain("正在处理画布历史，不能再撤销");
    expect(vue).toContain("正在处理画布历史，不能再重做");

    const undo = handlerBody(vue, "async function undoCanvas()", "async function redoCanvas()");
    expect(undo).toContain("if (projectSwitching.value || projectRemovingRoot.value || canvasHistoryBusy.value || savingCanvasEntity.value) return;");
    expect(undo).toContain("canvasHistoryBusy.value = true;");
    expect(undo.indexOf("if (projectSwitching.value || projectRemovingRoot.value || canvasHistoryBusy.value || savingCanvasEntity.value) return;")).toBeLessThan(
      undo.indexOf("canvasHistoryBusy.value = true;"),
    );
    expect(undo.indexOf("canvasHistoryBusy.value = true;")).toBeLessThan(
      undo.indexOf("await window.canvasApi.undoCanvasSemanticState"),
    );
    expect(undo).toContain("canvasHistoryBusy.value = false;");

    const redo = handlerBody(vue, "async function redoCanvas()", "function onCanvasShortcut(");
    expect(redo).toContain("if (projectSwitching.value || projectRemovingRoot.value || canvasHistoryBusy.value || savingCanvasEntity.value) return;");
    expect(redo).toContain("canvasHistoryBusy.value = true;");
    expect(redo.indexOf("if (projectSwitching.value || projectRemovingRoot.value || canvasHistoryBusy.value || savingCanvasEntity.value) return;")).toBeLessThan(
      redo.indexOf("canvasHistoryBusy.value = true;"),
    );
    expect(redo.indexOf("canvasHistoryBusy.value = true;")).toBeLessThan(
      redo.indexOf("await window.canvasApi.redoCanvasSemanticState"),
    );
    expect(redo).toContain("canvasHistoryBusy.value = false;");

    const shortcut = handlerBody(vue, "function onCanvasShortcut(", "function showMessage(");
    expect(shortcut).toContain("if (canvasHistoryBusy.value || savingCanvasEntity.value) return;");
    expect(shortcut.indexOf("event.preventDefault();")).toBeLessThan(shortcut.indexOf("if (canvasHistoryBusy.value || savingCanvasEntity.value) return;"));
    expect(shortcut.indexOf("if (canvasHistoryBusy.value || savingCanvasEntity.value) return;")).toBeLessThan(shortcut.indexOf("void redoCanvas()"));
    expect(shortcut.indexOf("if (canvasHistoryBusy.value || savingCanvasEntity.value) return;")).toBeLessThan(shortcut.indexOf("void undoCanvas()"));
  });

  it("保存画布实体进行中 fail-closed：savingCanvasEntity 在首个 await 之前置位，连点不会重复 upsert，也不能边保存边撤销", () => {
    const vue = source();
    expect(vue).toContain('data-testid="legacy-canvas-save-entity"');
    expect(vue).toContain(':disabled="savingCanvasEntity || canvasHistoryBusy || !canvasEditor.title.trim()"');
    expect(vue).toContain("正在处理，不能再保存画布实体");

    const save = handlerBody(vue, "async function saveCanvasEntity()", "async function saveCanvasEntityMove(");
    expect(save).toContain("if (projectSwitching.value || projectRemovingRoot.value || savingCanvasEntity.value || canvasHistoryBusy.value) return;");
    expect(save).toContain("savingCanvasEntity.value = true");
    expect(save.indexOf("if (projectSwitching.value || projectRemovingRoot.value || savingCanvasEntity.value || canvasHistoryBusy.value) return;")).toBeLessThan(
      save.indexOf("savingCanvasEntity.value = true"),
    );
    expect(save.indexOf("savingCanvasEntity.value = true")).toBeLessThan(
      save.indexOf("await window.canvasApi.upsertCanvasEntity"),
    );
  });

  it("删除实体/写关系线/删关系线进行中 fail-closed：canvasHistoryBusy 在 confirm 和首个 await 之前置位，连点不会重复写入", () => {
    const vue = source();

    const remove = handlerBody(vue, "async function removeCanvasEntity(", "function toggleLinkMode(");
    expect(remove).toContain("if (projectSwitching.value || projectRemovingRoot.value || canvasHistoryBusy.value || savingCanvasEntity.value) return;");
    expect(remove).toContain("canvasHistoryBusy.value = true");
    expect(remove.indexOf("if (projectSwitching.value || projectRemovingRoot.value || canvasHistoryBusy.value || savingCanvasEntity.value) return;")).toBeLessThan(
      remove.indexOf("canvasHistoryBusy.value = true"),
    );
    expect(remove.indexOf("canvasHistoryBusy.value = true")).toBeLessThan(remove.indexOf("window.confirm("));
    expect(remove.indexOf("canvasHistoryBusy.value = true")).toBeLessThan(remove.indexOf("await window.canvasApi.deleteCanvasEntity"));
    expect(remove).toContain("canvasHistoryBusy.value = false");

    const link = handlerBody(vue, "async function chooseLinkEndpoint(", "async function onEdgeClick(");
    expect(link).toContain("if (projectSwitching.value || projectRemovingRoot.value || canvasHistoryBusy.value || savingCanvasEntity.value) return;");
    expect(link).toContain("canvasHistoryBusy.value = true");
    expect(link.indexOf("if (projectSwitching.value || projectRemovingRoot.value || canvasHistoryBusy.value || savingCanvasEntity.value) return;")).toBeLessThan(
      link.indexOf("if (!linkSourceId.value)"),
    );
    expect(link.indexOf("canvasHistoryBusy.value = true")).toBeLessThan(link.indexOf("await window.canvasApi.upsertCanvasLink"));
    expect(link.indexOf("if (!linkSourceId.value)")).toBeLessThan(link.indexOf("canvasHistoryBusy.value = true"));
    expect(link).toContain("canvasHistoryBusy.value = false");

    const edge = handlerBody(vue, "async function onEdgeClick(", "async function refreshCanvasHistory(");
    expect(edge).toContain("if (projectSwitching.value || projectRemovingRoot.value || canvasHistoryBusy.value || savingCanvasEntity.value) return;");
    expect(edge).toContain("canvasHistoryBusy.value = true");
    expect(edge.indexOf("canvasHistoryBusy.value = true")).toBeLessThan(edge.indexOf("window.confirm("));
    expect(edge.indexOf("canvasHistoryBusy.value = true")).toBeLessThan(edge.indexOf("await window.canvasApi.deleteCanvasLink"));
    expect(edge).toContain("canvasHistoryBusy.value = false");
  });

  it("新建批注/分组/进入连线在写入进行中 fail-closed：不能边保存边打开编辑器", () => {
    const vue = source();
    expect(vue).toContain("正在处理，不能再添加导演批注");
    expect(vue).toContain("正在处理，不能再添加自定义分组");
    expect(vue).toContain("正在处理，不能再建立关系线");

    const create = handlerBody(vue, "function createCanvasEntity(", "function editCanvasEntity(");
    expect(create).toContain("if (savingCanvasEntity.value || canvasHistoryBusy.value) return;");
    expect(create.indexOf("if (savingCanvasEntity.value || canvasHistoryBusy.value) return;")).toBeLessThan(
      create.indexOf("canvasEditor.value ="),
    );

    const edit = handlerBody(vue, "function editCanvasEntity(", "async function saveCanvasEntity()");
    expect(edit).toContain("if (savingCanvasEntity.value || canvasHistoryBusy.value) return;");
    expect(edit.indexOf("if (savingCanvasEntity.value || canvasHistoryBusy.value) return;")).toBeLessThan(
      edit.indexOf("canvasEditor.value ="),
    );

    const toggle = handlerBody(vue, "function toggleLinkMode()", "async function chooseLinkEndpoint(");
    expect(toggle).toContain("if (savingCanvasEntity.value || canvasHistoryBusy.value) return;");
    expect(toggle.indexOf("if (savingCanvasEntity.value || canvasHistoryBusy.value) return;")).toBeLessThan(
      toggle.indexOf("linkMode.value = !linkMode.value"),
    );
  });
});
