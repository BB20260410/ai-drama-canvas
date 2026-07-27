import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "@vue/compiler-sfc";
import { describe, expect, it } from "vitest";
import {
  createLegacyProjectEpochGate,
  isCurrentLegacyWatcherEvent,
} from "../src/renderer/src/legacy-project-epoch-gate.js";
import { createProjectScopedActionGate } from "../src/renderer/src/project-scoped-action-gate.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("旧文件系统画布 root+epoch 异步门", () => {
  it("同时拦截跨 root 与 A→B→A 的 ABA 迟到回包", () => {
    const gate = createLegacyProjectEpochGate();
    const firstA = gate.capture("/project-a");
    expect(gate.isCurrent(firstA, "/project-a")).toBe(true);
    gate.invalidate();
    expect(gate.isCurrent(firstA, "/project-b")).toBe(false);
    expect(gate.isCurrent(firstA, "/project-a")).toBe(false);
    const secondA = gate.capture("/project-a");
    expect(gate.isCurrent(secondA, "/project-a")).toBe(true);
  });

  it("异步写在 A→B→A 后完成时不能把第一代 A 的结果提交到新 A", async () => {
    const gate = createLegacyProjectEpochGate();
    let currentRoot = "/project-a";
    const firstA = gate.capture(currentRoot);
    let resolveWrite!: (value: string) => void;
    const deferredWrite = new Promise<string>((resolve) => {
      resolveWrite = resolve;
    });
    let committed: string | undefined;
    const completion = deferredWrite.then((value) => {
      if (gate.isCurrent(firstA, currentRoot)) committed = value;
    });

    gate.invalidate();
    currentRoot = "/project-b";
    gate.invalidate();
    currentRoot = "/project-a";
    resolveWrite("first-a-late-result");
    await completion;

    expect(committed).toBeUndefined();
  });

  it("同一路径的新 watcher incarnation 会拒绝旧 semantic 事件", () => {
    const firstA = { projectRoot: "/project-a", watcherEpoch: 7 };
    const secondA = { projectRoot: "/project-a", watcherEpoch: 11 };
    expect(isCurrentLegacyWatcherEvent(secondA, firstA, "/project-a")).toBe(false);
    expect(isCurrentLegacyWatcherEvent(secondA, secondA, "/project-a")).toBe(true);
    expect(isCurrentLegacyWatcherEvent(secondA, secondA, "/project-b")).toBe(false);
  });

  it("移除 A 的迟到成功或失败在 B 成为当前工程后都不能清 B 或恢复 A watcher", async () => {
    const removalGate = createProjectScopedActionGate();
    const legacyGate = createLegacyProjectEpochGate();
    let currentRoot = "/project-a";
    let removingRoot = "/project-a";
    const legacyEpoch = legacyGate.invalidate();
    const removalToken = removalGate.begin("/project-a", "/project-a");
    const isCurrent = () => removalGate.isCurrent(removalToken, removingRoot, "/project-a")
      && currentRoot === "/project-a"
      && legacyGate.isEpochCurrent(legacyEpoch);
    let resolveRemoval!: () => void;
    const deferredRemoval = new Promise<void>((resolve) => {
      resolveRemoval = resolve;
    });
    let rejectRemoval!: (reason: Error) => void;
    const deferredRemovalFailure = new Promise<void>((_resolve, reject) => {
      rejectRemoval = reject;
    });
    let clearedCurrent = false;
    let restoredAWatcher = false;
    const lateSuccess = deferredRemoval.then(() => {
      if (isCurrent()) clearedCurrent = true;
    });
    const lateFailure = deferredRemovalFailure.catch(() => {
      if (isCurrent()) restoredAWatcher = true;
    });

    removalGate.invalidate();
    legacyGate.invalidate();
    removingRoot = "";
    currentRoot = "/project-b";
    resolveRemoval();
    rejectRemoval(new Error("late removal failure"));
    await Promise.all([lateSuccess, lateFailure]);

    expect(clearedCurrent).toBe(false);
    expect(restoredAWatcher).toBe(false);
    expect(currentRoot).toBe("/project-b");
  });

  it("App 的读取、扫描、切换和布局 IPC 均使用冻结 root 与 epoch 门", () => {
    const source = readFileSync(path.join(root, "src/renderer/src/App.vue"), "utf8");
    expect(parse(source, { filename: "App.vue" }).errors).toEqual([]);
    for (const marker of [
      "createLegacyProjectEpochGate",
      "invalidateLegacyProjectAsyncState",
      "captureLegacyProjectToken",
      "isLegacyProjectTokenCurrent",
      "cancelInvalidatedLegacyScan",
      "token.root",
      "frozenViewKey",
    ]) expect(source).toContain(marker);
    expect(source).not.toContain("window.canvasApi.scan(projectRoot.value)");
    expect(source).not.toContain("window.canvasApi.loadLayout(projectRoot.value");
    expect(source).not.toContain("window.canvasApi.saveLayout(projectRoot.value");
    const switchStart = source.indexOf("const invalidated = invalidateLegacyProjectAsyncState()");
    expect(switchStart).toBeGreaterThan(-1);
    expect(switchStart).toBeLessThan(source.indexOf("window.canvasApi.getActiveProject()", switchStart));
  });

  it("legacy 语义写、watcher 协议和移除互斥均使用冻结 owner", () => {
    const appSource = readFileSync(path.join(root, "src/renderer/src/App.vue"), "utf8");
    const mainSource = readFileSync(path.join(root, "src/main/index.ts"), "utf8");
    const preloadSource = readFileSync(path.join(root, "src/preload/index.ts"), "utf8");
    const projectCenterSource = readFileSync(path.join(root, "src/renderer/src/components/ProjectCenter.vue"), "utf8");
    expect(parse(appSource, { filename: "App.vue" }).errors).toEqual([]);
    expect(parse(projectCenterSource, { filename: "ProjectCenter.vue" }).errors).toEqual([]);

    const semanticMethods = [
      "upsertCanvasEntity",
      "moveCanvasEntities",
      "deleteCanvasEntity",
      "upsertCanvasLink",
      "deleteCanvasLink",
      "getCanvasHistoryInfo",
      "undoCanvasSemanticState",
      "redoCanvasSemanticState",
    ];
    for (const method of semanticMethods) {
      expect(appSource).not.toMatch(new RegExp(`window\\.canvasApi\\.${method}\\(projectRoot\\.value`));
      expect(appSource).toContain(`window.canvasApi.${method}(token.root`);
    }
    for (const marker of [
      "projectRemovingRoot.value = targetRoot",
      "projectRemovalGate.begin(targetRoot, targetRoot)",
      "projectRemovalIsCurrent(scope)",
      "projectRemovalOwnsOperation(scope)",
      "projectRemovalGate.dispose()",
      ":removing-root=\"projectRemovingRoot\"",
      "isCurrentLegacyWatcherEvent(activeLegacyWatcherIdentity, event, projectRoot.value)",
    ]) expect(appSource).toContain(marker);
    expect(projectCenterSource).toContain("removingRoot?: string");
    expect(projectCenterSource).toContain("props.creating || props.switching || props.removingRoot");

    for (const marker of [
      "watcherEpoch += 1",
      "watcherEpoch: ++watcherEpoch",
      "if (!legacyWatcherIdentityIsCurrent(identity)) return",
      'mainWindow?.webContents.send("canvas:semantic-updated", {',
      "...identity",
    ]) expect(mainSource).toContain(marker);
    expect(preloadSource).toContain("startWatch: (projectRoot: string): Promise<LegacyWatcherIdentity>");
    expect(preloadSource).toContain("onCanvasSemanticUpdated: (callback: (event: CanvasSemanticUpdatedEvent) => void)");
  });
});
