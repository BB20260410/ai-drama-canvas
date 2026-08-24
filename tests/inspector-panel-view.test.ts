import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "@vue/compiler-sfc";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function source(): string {
  return readFileSync(path.join(root, "src/renderer/src/components/InspectorPanel.vue"), "utf8");
}

function styles(): string {
  return readFileSync(path.join(root, "src/renderer/src/styles.css"), "utf8");
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

describe("旧画布节点检查器源码合同", () => {
  it("SFC 可解析并暴露写回状态与设为权威", () => {
    const vue = source();
    expect(parse(vue, { filename: "InspectorPanel.vue" }).errors).toEqual([]);
    expect(vue).toContain('data-testid="inspector-save-status"');
    expect(vue).toContain('data-testid="inspector-set-authority"');
  });

  it("写回状态/设为权威在进行中 fail-closed：saving 或 settingAuthority 在首个 await 之前置位，连点不会重复写入", () => {
    const vue = source();
    const saveButton = buttonAttrs(vue, "inspector-save-status");
    expect(saveButton).toContain(':disabled="saving || Boolean(settingAuthority)"');
    expect(saveButton).toContain("正在处理，不能再写回画布");

    const authorityButton = buttonAttrs(vue, "inspector-set-authority");
    expect(authorityButton).toContain(':disabled="saving || Boolean(settingAuthority)"');
    expect(authorityButton).toContain("正在处理，不能再设为权威");

    const save = handlerBody(vue, "async function saveStatus()", "async function setAuthority(");
    expect(save).toContain("if (!props.item || saving.value || settingAuthority.value) return;");
    expect(save).toContain("saving.value = true");
    expect(save.indexOf("if (!props.item || saving.value || settingAuthority.value) return;")).toBeLessThan(
      save.indexOf("saving.value = true"),
    );
    expect(save.indexOf("saving.value = true")).toBeLessThan(save.indexOf("await window.canvasApi.updateStatus"));
    expect(save).toContain("saving.value = false");

    const setAuthority = handlerBody(vue, "async function setAuthority(", "function revealPrimary(");
    expect(setAuthority).toContain("if (!props.item || saving.value || settingAuthority.value) return;");
    expect(setAuthority).toContain("settingAuthority.value = artifact.id");
    expect(setAuthority.indexOf("if (!props.item || saving.value || settingAuthority.value) return;")).toBeLessThan(
      setAuthority.indexOf("settingAuthority.value = artifact.id"),
    );
    expect(setAuthority.indexOf("settingAuthority.value = artifact.id")).toBeLessThan(
      setAuthority.indexOf("await window.canvasApi.setAuthoritativeArtifact"),
    );
  });

  it("素材版本行视口剔除：.artifact-row 用 content-visibility:auto，滚动容器 overflow-y:auto 仍在", () => {
    const vue = source();
    const css = styles();
    expect(vue).toContain('class="artifact-row"');
    expect(vue).toContain('v-for="artifact in sortedArtifacts"');
    expect(css).toContain(".inspector { min-width: 0; overflow-y: auto;");
    expect(css).toContain(
      ".artifact-row { width: 100%; min-width: 0; display: flex; align-items: center; gap: 5px; border-bottom: 1px solid #282a24; content-visibility: auto; contain-intrinsic-size: auto 40px; }",
    );
    expect(css).not.toContain("content-visibility: hidden");
    expect(css).not.toMatch(/\.artifact-open\s*\{[^}]*content-visibility/);
    expect(css).not.toMatch(/\.lock-list li\s*\{[^}]*content-visibility/);
  });
});
