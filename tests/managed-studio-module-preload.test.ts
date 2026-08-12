import { describe, expect, it } from "vitest";
import { createManagedStudioModulePreloader } from "../src/renderer/src/managed-studio-module-preload.js";

describe("受管 Studio 模块预热", () => {
  it("预热与正式加载复用同一个 Promise，不重复 import", async () => {
    let loadCount = 0;
    let resolveModule!: (value: { name: string }) => void;
    const pending = new Promise<{ name: string }>((resolve) => {
      resolveModule = resolve;
    });
    const preloader = createManagedStudioModulePreloader(async () => {
      loadCount += 1;
      return pending;
    });

    preloader.warm();
    const formalLoad = preloader.load();
    expect(loadCount).toBe(1);

    resolveModule({ name: "material-studio" });
    await expect(formalLoad).resolves.toEqual({ name: "material-studio" });
    await expect(preloader.load()).resolves.toEqual({ name: "material-studio" });
    expect(loadCount).toBe(1);
  });

  it("失败结果保持单次且不在后台形成无限重试", async () => {
    let loadCount = 0;
    const preloader = createManagedStudioModulePreloader(async () => {
      loadCount += 1;
      throw new Error("chunk unavailable");
    });

    preloader.warm();
    await expect(preloader.load()).rejects.toThrow("chunk unavailable");
    await expect(preloader.load()).rejects.toThrow("chunk unavailable");
    expect(loadCount).toBe(1);
  });
});
