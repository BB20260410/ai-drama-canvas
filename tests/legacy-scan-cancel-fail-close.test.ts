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

describe("旧工程取消扫描失败必须让用户看见", () => {
  it("SFC 可解析，扫描中主按钮走 cancelScanNow", () => {
    const vue = source();
    expect(parse(vue, { filename: "App.vue" }).errors).toEqual([]);
    expect(vue).toContain("@click=\"scanInProgress ? cancelScanNow() : scanNow()\"");
    expect(vue).toContain("取消扫描");
  });

  it("cancelScanNow 的 catch 不能空吞：取消扫描 IPC 失败要 showMessage 大白话，不能只 console 或 .catch(() => false)", () => {
    const vue = source();
    const cancel = handlerBody(vue, "async function cancelScanNow()", "function captureProjectUiSnapshot(");

    expect(cancel).toContain("await window.canvasApi.cancelScan(token.root)");
    expect(cancel).toContain("scanCancelling.value = true");
    expect(cancel).toContain("if (isLegacyProjectTokenCurrent(token) && !accepted) scanCancelling.value = false");

    expect(cancel).toContain("showMessage(");
    expect(cancel).toContain("扫描没取消掉");
    expect(cancel).toContain(", true)");

    expect(cancel).not.toContain(".catch(() => false)");
    expect(cancel).not.toContain(".catch(() => undefined)");
    expect(cancel).not.toMatch(/console\.(error|warn|log|info|debug)/);
  });

  it("scanNow 在工程操作 busy 时 fail-closed：不能边切换/创建工程边扫描", () => {
    const vue = source();
    const scan = handlerBody(vue, "async function scanNow()", "async function cancelScanNow()");
    expect(scan).toContain("if (projectOperationBusy.value) return;");
    expect(scan.indexOf("if (projectOperationBusy.value) return;")).toBeLessThan(
      scan.indexOf("activeLegacyScanToken = token"),
    );
    expect(scan.indexOf("if (projectOperationBusy.value) return;")).toBeLessThan(
      scan.indexOf("loading.value = true"),
    );
  });
});
