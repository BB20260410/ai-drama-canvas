import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "@vue/compiler-sfc";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function source(): string {
  return readFileSync(path.join(root, "src/renderer/src/components/ProductionWorkspace.vue"), "utf8");
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

describe("生产工作台源码合同", () => {
  it("SFC 可解析并暴露建包/设权威/提升硬锁动作", () => {
    const vue = source();
    expect(parse(vue, { filename: "ProductionWorkspace.vue" }).errors).toEqual([]);
    expect(vue).toContain('data-testid="production-workspace-create-pack"');
    expect(vue).toContain('data-testid="production-workspace-set-authority"');
    expect(vue).toContain('data-testid="production-workspace-promote-asset"');
  });

  it("建包/设权威/提升硬锁在进行中 fail-closed：busy 在首个 await 之前置位，按钮禁用并给出大白话原因，连点不会重复写入", () => {
    const vue = source();

    const create = buttonAttrs(vue, "production-workspace-create-pack");
    expect(create).toContain(':disabled="creating"');
    expect(create).toContain("正在处理，不能再创建任务包");
    expect(vue).toContain('{{ creating ? "创建中" : `创建${mode === \'videos\' ? \'视频\' : \'图片\'}任务包` }}');

    const authority = buttonAttrs(vue, "production-workspace-set-authority");
    expect(authority).toContain(':disabled="Boolean(actionBusy)"');
    expect(authority).toContain("正在处理，不能再设为权威");

    const promote = buttonAttrs(vue, "production-workspace-promote-asset");
    expect(promote).toContain(':disabled="Boolean(actionBusy)"');
    expect(promote).toContain("正在处理，不能再提升为硬锁");

    const createHandler = handlerBody(vue, "async function createPack()", "</script>");
    expect(createHandler).toContain("if (creating.value) return;");
    expect(createHandler).toContain("creating.value = true");
    expect(createHandler.indexOf("if (creating.value) return;")).toBeLessThan(
      createHandler.indexOf("creating.value = true"),
    );
    expect(createHandler.indexOf("creating.value = true")).toBeLessThan(
      createHandler.indexOf("await window.canvasApi.createTaskPack"),
    );
    expect(createHandler).toContain("creating.value = false");

    const authorityHandler = handlerBody(vue, "async function setVideoAuthority(artifact: Artifact)", "function pad(");
    expect(authorityHandler).toContain("if (!selectedVideoItem.value || actionBusy.value) return;");
    expect(authorityHandler).toContain('actionBusy.value = "authority"');
    expect(authorityHandler.indexOf("if (!selectedVideoItem.value || actionBusy.value) return;")).toBeLessThan(
      authorityHandler.indexOf('actionBusy.value = "authority"'),
    );
    expect(authorityHandler.indexOf('actionBusy.value = "authority"')).toBeLessThan(
      authorityHandler.indexOf("await window.canvasApi.setAuthoritativeArtifact"),
    );
    expect(authorityHandler).toContain('actionBusy.value = ""');

    const promoteHandler = handlerBody(vue, "async function promoteAsset(item: WorkItem)", "function toggle(");
    expect(promoteHandler).toContain("if (actionBusy.value) return;");
    expect(promoteHandler).toContain("actionBusy.value = `promote-${item.id}`");
    expect(promoteHandler.indexOf("if (actionBusy.value) return;")).toBeLessThan(
      promoteHandler.indexOf("actionBusy.value = `promote-${item.id}`"),
    );
    expect(promoteHandler.indexOf("actionBusy.value = `promote-${item.id}`")).toBeLessThan(
      promoteHandler.indexOf("await window.canvasApi.promoteAssetToHardLock"),
    );
    expect(promoteHandler).toContain('actionBusy.value = ""');
  });
});
