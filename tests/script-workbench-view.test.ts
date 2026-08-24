import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "@vue/compiler-sfc";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function scriptWorkbenchSource(): string {
  return readFileSync(path.join(root, "src/renderer/src/components/ScriptWorkbenchView.vue"), "utf8");
}

function buttonAttrs(source: string, testId: string): string {
  const marker = `data-testid="${testId}"`;
  const idx = source.indexOf(marker);
  expect(idx).toBeGreaterThan(-1);
  const start = source.lastIndexOf("<button", idx);
  const end = source.indexOf(">", idx);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end + 1);
}

function handlerBody(source: string, signature: string, nextSignature: string): string {
  const start = source.indexOf(signature);
  const end = source.indexOf(nextSignature, start + signature.length);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("制作文档工作台源码合同", () => {
  it("SFC 可解析并暴露创建/保存动作", () => {
    const source = scriptWorkbenchSource();
    expect(parse(source, { filename: "ScriptWorkbenchView.vue" }).errors).toEqual([]);
    expect(source).toContain('data-testid="script-create-document"');
    expect(source).toContain('data-testid="script-save-document"');
  });

  it("创建/保存在进行中 fail-closed：busy 在首个 await 之前置位，按钮禁用并给出大白话原因，连点不会重复写入", () => {
    const source = scriptWorkbenchSource();

    const create = buttonAttrs(source, "script-create-document");
    expect(create).toContain(':disabled="createBusy || saving"');
    expect(create).toContain("正在处理，不能再创建文档");
    expect(source).toContain('{{ createBusy ? "创建中" : "创建 Markdown" }}');

    const save = buttonAttrs(source, "script-save-document");
    expect(save).toContain(':disabled="saving || createBusy || !dirty"');
    expect(save).toContain("正在处理，不能再保存");

    const createHandler = handlerBody(source, "async function createDocument()", "function reveal()");
    expect(createHandler).toContain("if (createBusy.value || saving.value) return;");
    expect(createHandler).toContain("createBusy.value = true");
    expect(createHandler.indexOf("if (createBusy.value || saving.value) return;")).toBeLessThan(
      createHandler.indexOf("createBusy.value = true"),
    );
    expect(createHandler.indexOf("createBusy.value = true")).toBeLessThan(
      createHandler.indexOf("await window.canvasApi.createScriptDocument"),
    );
    expect(createHandler).toContain("createBusy.value = false");

    const saveHandler = handlerBody(source, "async function save()", "async function createDocument()");
    expect(saveHandler).toContain("if (!activeDocument.value || saving.value || createBusy.value) return;");
    expect(saveHandler).toContain("saving.value = true");
    expect(saveHandler.indexOf("if (!activeDocument.value || saving.value || createBusy.value) return;")).toBeLessThan(
      saveHandler.indexOf("saving.value = true"),
    );
    expect(saveHandler.indexOf("saving.value = true")).toBeLessThan(
      saveHandler.indexOf("await window.canvasApi.saveScriptDocument"),
    );
  });
});

describe("制作文档列表视口剔除", () => {
  it("document-list 行使用 content-visibility，离屏过滤文档跳过同步布局", () => {
    const source = scriptWorkbenchSource();
    expect(source).toContain('v-for="document in filteredDocuments"');
    expect(source).toContain(".document-list { flex: 1; overflow: auto; }");
    expect(source).toContain(
      ".document-list button { width: 100%; min-width: 0; padding: 11px 16px; border: 0; border-bottom: 1px solid #292b25; background: transparent; color: #aaa; text-align: left; cursor: pointer; content-visibility: auto; contain-intrinsic-size: auto 64px; }",
    );
    expect(source).not.toMatch(/\.document-list button \{[^}]*content-visibility:hidden/);
    expect(source).not.toMatch(/\.document-kind-tabs button \{[^}]*content-visibility/);
  });
});
