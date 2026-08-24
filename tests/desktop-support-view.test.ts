import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "@vue/compiler-sfc";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function source(): string {
  return readFileSync(path.join(root, "src/renderer/src/components/DesktopSupportView.vue"), "utf8");
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

describe("桌面生产支持源码合同", () => {
  it("SFC 可解析并暴露刷新/修复/备份/恢复", () => {
    const vue = source();
    expect(parse(vue, { filename: "DesktopSupportView.vue" }).errors).toEqual([]);
    expect(vue).toContain('data-testid="desktop-support-refresh"');
    expect(vue).toContain('data-testid="desktop-support-repair"');
    expect(vue).toContain('data-testid="desktop-support-backup"');
    expect(vue).toContain('data-testid="desktop-support-restore"');
  });

  it("桌面支持高级诊断 summary 含 testid，不改备份恢复 busy", () => {
    const vue = source();
    expect(vue).toContain('data-testid="desktop-support-diagnostics"');
    expect(vue).toContain('<summary data-testid="desktop-support-diagnostics">诊断详情（高级）</summary>');
    expect(vue).toContain("{{ projectRoot }}");
    expect(vue).not.toContain("desktop-support-diagnostics-");
    expect(vue).not.toContain('desktop-support-diagnostics" role="dialog"');
    expect(vue).toContain('data-testid="desktop-support-backup"');
    expect(vue).toContain('data-testid="desktop-support-restore"');
    expect(vue).toContain(':disabled="busy"');
  });

  it("修复/备份/恢复在进行中 fail-closed：busy 挡住按钮与 handler，同 tick 连点不会重复写入", () => {
    const vue = source();

    const refresh = buttonAttrs(vue, "desktop-support-refresh");
    expect(refresh).toContain(':disabled="busy"');
    expect(refresh).toContain("正在处理，不能再刷新状态");

    const repair = buttonAttrs(vue, "desktop-support-repair");
    expect(repair).toContain(':disabled="busy || !status?.repairAvailable || !status?.repairNeeded"');
    expect(repair).toContain("正在处理，不能再修复连接");

    const backup = buttonAttrs(vue, "desktop-support-backup");
    expect(backup).toContain(':disabled="busy"');
    expect(backup).toContain("正在处理，不能再备份当前工程");

    const restore = buttonAttrs(vue, "desktop-support-restore");
    expect(restore).toContain(':disabled="busy"');
    expect(restore).toContain("正在处理，不能再恢复到新目录");

    const withBusy = handlerBody(vue, "async function withBusy(", "async function refreshStatus()");
    expect(withBusy).toContain("if (busy.value) return;");
    expect(withBusy.indexOf("if (busy.value) return;")).toBeLessThan(withBusy.indexOf("busyOperation.value = kind;"));

    const repairFn = handlerBody(vue, "async function repairConnections()", "async function backupProject()");
    expect(repairFn).toContain("if (busy.value) return;");
    expect(repairFn.indexOf("if (busy.value) return;")).toBeLessThan(repairFn.indexOf('await withBusy("repair"'));

    const backupFn = handlerBody(vue, "async function backupProject()", "async function restoreProject()");
    expect(backupFn).toContain("if (busy.value) return;");
    expect(backupFn.indexOf("if (busy.value) return;")).toBeLessThan(backupFn.indexOf('await withBusy("backup"'));

    const restoreFn = handlerBody(vue, "async function restoreProject()", "watch(() => props.projectRoot");
    expect(restoreFn).toContain("if (busy.value) return;");
    expect(restoreFn.indexOf("if (busy.value) return;")).toBeLessThan(restoreFn.indexOf('await withBusy("restore"'));
  });
});
