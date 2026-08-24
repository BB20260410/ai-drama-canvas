import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "@vue/compiler-sfc";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function source(): string {
  return readFileSync(path.join(root, "src/renderer/src/components/ProjectSettingsView.vue"), "utf8");
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

describe("项目设置源码合同", () => {
  it("SFC 可解析并暴露保存并重扫", () => {
    const vue = source();
    expect(parse(vue, { filename: "ProjectSettingsView.vue" }).errors).toEqual([]);
    expect(vue).toContain('data-testid="project-settings-save"');
  });

  it("保存并重扫在进行中 fail-closed：busy 在首个 await 之前置位，按钮禁用并给出大白话原因，连点不会重复写入", () => {
    const vue = source();
    const saveButton = buttonAttrs(vue, "project-settings-save");
    expect(saveButton).toContain(':disabled="saving"');
    expect(saveButton).toContain("正在处理，不能再保存并重扫");
    expect(vue).toContain('{{ saving ? "保存中" : "保存并重扫" }}');

    const save = handlerBody(vue, "async function save()", "</script>");
    expect(save).toContain("if (saving.value) return;");
    expect(save).toContain("saving.value = true");
    expect(save.indexOf("if (saving.value) return;")).toBeLessThan(save.indexOf("saving.value = true"));
    expect(save.indexOf("saving.value = true")).toBeLessThan(save.indexOf("await window.canvasApi.saveProjectConfig"));
    expect(save).toContain("saving.value = false");
  });
});
