import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "@vue/compiler-sfc";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function source(): string {
  return readFileSync(path.join(root, "src/renderer/src/components/ProjectImportWizard.vue"), "utf8");
}

function buttonAttrs(text: string, testId: string): string {
  const marker = `data-testid="${testId}"`;
  const idx = text.indexOf(marker);
  expect(idx).toBeGreaterThan(-1);
  const start = text.lastIndexOf("<button", idx);
  const end = text.indexOf(">", idx);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return text.slice(start, end + 1);
}

function handlerBody(text: string, signature: string, nextSignature: string): string {
  const start = text.indexOf(signature);
  const end = text.indexOf(nextSignature, start + signature.length);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return text.slice(start, end);
}

describe("项目导入向导源码合同", () => {
  it("SFC 可解析并暴露预检/确认导入", () => {
    const vue = source();
    expect(parse(vue, { filename: "ProjectImportWizard.vue" }).errors).toEqual([]);
    expect(vue).toContain('data-testid="project-import-advance"');
    expect(vue).toContain('data-testid="project-import-back"');
    expect(vue).toContain('data-testid="project-import-close"');
  });

  it("预检与确认导入在进行中 fail-closed：busy 在首个 await 之前置位，按钮禁用并给出大白话原因，连点不会重复写入", () => {
    const vue = source();

    const advanceButton = buttonAttrs(vue, "project-import-advance");
    expect(advanceButton).toContain(':disabled="working || (stage === 3 && !preview?.canImport)"');
    expect(advanceButton).toContain("正在处理，不能再导入项目");
    expect(vue).toContain('{{ working ? "处理中" : primaryLabel }}');

    const backButton = buttonAttrs(vue, "project-import-back");
    expect(backButton).toContain(':disabled="working"');
    expect(backButton).toContain("正在处理，不能再返回");

    const closeButton = buttonAttrs(vue, "project-import-close");
    expect(closeButton).toContain(':disabled="working"');
    expect(closeButton).toContain("正在处理，不能再关闭导入向导");

    const prepare = handlerBody(vue, "async function prepare()", "async function advance()");
    expect(prepare).toContain("if (working.value) return;");
    expect(prepare).toContain("working.value = true");
    expect(prepare.indexOf("if (working.value) return;")).toBeLessThan(prepare.indexOf("working.value = true"));
    expect(prepare.indexOf("working.value = true")).toBeLessThan(prepare.indexOf("await runPrepare()"));
    expect(prepare).toContain("working.value = false");

    const advance = handlerBody(vue, "async function advance()", "async function replacePrimary()");
    expect(advance).toContain("if (working.value) return;");
    expect(advance).toContain("working.value = true");
    expect(advance.indexOf("if (working.value) return;")).toBeLessThan(advance.indexOf("working.value = true"));
    expect(advance.indexOf("working.value = true")).toBeLessThan(advance.indexOf("await"));
    expect(advance).toContain("await window.canvasApi.commitImport");
    expect(advance).toContain("working.value = false");

    const cancel = handlerBody(vue, "function requestCancel()", "async function runPrepare()");
    expect(cancel).toContain("if (working.value) return;");
  });

  it("更换主根/添加扫描根 fail-closed：pickingRoot 挡住连点双开系统目录框", () => {
    const vue = source();
    expect(vue).toContain("正在处理，不能再更换项目主根");
    expect(vue).toContain("正在处理，不能再添加扫描根");
    expect(vue).toContain('@click="replacePrimary"');
    expect(vue).toContain("@click=\"addRoot('source')\"");
    expect(vue).toContain("@click=\"addRoot('output')\"");
    expect(vue).toContain(':disabled="working || pickingRoot"');

    const replace = handlerBody(vue, "async function replacePrimary()", "async function addRoot(");
    expect(replace).toContain("if (working.value || pickingRoot.value) return;");
    expect(replace).toContain("pickingRoot.value = true;");
    expect(replace.indexOf("if (working.value || pickingRoot.value) return;")).toBeLessThan(replace.indexOf("pickingRoot.value = true;"));
    expect(replace.indexOf("pickingRoot.value = true;")).toBeLessThan(replace.indexOf("await window.canvasApi.pickProject"));
    expect(replace).toContain("pickingRoot.value = false;");

    const add = handlerBody(vue, "async function addRoot(", "function updateOutput(");
    expect(add).toContain("if (working.value || pickingRoot.value) return;");
    expect(add).toContain("pickingRoot.value = true;");
    expect(add.indexOf("if (working.value || pickingRoot.value) return;")).toBeLessThan(add.indexOf("pickingRoot.value = true;"));
    expect(add.indexOf("pickingRoot.value = true;")).toBeLessThan(add.indexOf("await window.canvasApi.pickProject"));
    expect(add).toContain("pickingRoot.value = false;");
  });
});
