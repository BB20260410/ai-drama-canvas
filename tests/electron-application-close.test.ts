import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
  captureBackgroundElectronStateOrThrow,
  closeElectronApplicationOrThrow,
} from "../scripts/lib/electron-application-close.mjs";

class FakeChild extends EventEmitter {
  readonly pid = 4242;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  signals: NodeJS.Signals[] = [];

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.signals.push(signal);
    this.signalCode = signal;
    queueMicrotask(() => this.emit("exit", null, signal));
    return true;
  }

  exitNormally(): void {
    this.exitCode = 0;
    queueMicrotask(() => this.emit("exit", 0, null));
  }

  crash(exitCode = 1): void {
    this.exitCode = exitCode;
    queueMicrotask(() => this.emit("exit", exitCode, null));
  }
}

describe("Electron application 有界关闭 helper", () => {
  it("正常 close 必须等到根进程退出且不发送信号", async () => {
    const child = new FakeChild();
    const application = {
      process: () => child,
      close: async () => child.exitNormally(),
      evaluate: async () => ({}),
    };

    await expect(closeElectronApplicationOrThrow(application, { label: "clean", timeoutMs: 100 }))
      .resolves.toMatchObject({ graceful: true, forceTerminated: false, forceKilled: false });
    expect(child.signals).toEqual([]);
  });

  it("graceful close 超时必须抛错，TERM 只用于失败清理且不能升级为 PASS", async () => {
    const child = new FakeChild();
    const application = {
      process: () => child,
      close: () => new Promise<void>(() => undefined),
      evaluate: async () => ({ closeSnapshot: { phase: "awaiting_renderer" }, windows: [{ id: 1 }] }),
    };

    await expect(closeElectronApplicationOrThrow(application, {
      label: "blocked",
      timeoutMs: 10,
      termTimeoutMs: 50,
      killTimeoutMs: 50,
    })).rejects.toThrow(/强杀不计 PASS.*forceTerminated.*true/u);
    expect(child.signals).toEqual(["SIGTERM"]);
  });

  it("application.close 返回但根进程非零退出时必须失败，不能记作 graceful", async () => {
    const child = new FakeChild();
    const application = {
      process: () => child,
      close: async () => child.crash(1),
      evaluate: async () => ({}),
    };

    await expect(closeElectronApplicationOrThrow(application, { label: "crashed", timeoutMs: 100 }))
      .rejects.toThrow(/非正常退出.*exitCode.*1/u);
  });

  it("后台 smoke 只接受从创建起零 show/zero focus 且当前不可见的窗口", async () => {
    const snapshot = {
      enabled: true,
      platform: "darwin",
      activationPolicy: "accessory",
      dockVisible: false,
      focusedWindowId: null,
      windows: [{
        id: 7,
        showEvents: 0,
        focusEvents: 0,
        readyToShowEvents: 1,
        visible: false,
        focused: false,
        destroyed: false,
      }],
    };
    const application = { evaluate: async () => snapshot };

    await expect(captureBackgroundElectronStateOrThrow(application, { label: "hidden" }))
      .resolves.toEqual({ label: "hidden", ...snapshot });
  });

  it("后台 smoke 若曾展示或聚焦必须立即失败", async () => {
    const application = {
      evaluate: async () => ({
        enabled: true,
        platform: "darwin",
        activationPolicy: "accessory",
        dockVisible: false,
        focusedWindowId: 7,
        windows: [{ id: 7, showEvents: 1, focusEvents: 1, readyToShowEvents: 1, visible: false, focused: false, destroyed: false }],
      }),
    };

    await expect(captureBackgroundElectronStateOrThrow(application, { label: "leaked" }))
      .rejects.toThrow(/后台 smoke.*showEvents.*focusedWindowId/u);
  });
});
