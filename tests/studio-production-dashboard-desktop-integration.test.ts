import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("P8 Desktop 集成合同", () => {
  it("main/preload 暴露只读驾驶舱 IPC，MaterialStudio 默认可进入 dashboard", () => {
    const main = readFileSync(path.join(root, "src/main/index.ts"), "utf8");
    const preload = readFileSync(path.join(root, "src/preload/index.ts"), "utf8");
    const studio = readFileSync(path.join(root, "src/renderer/src/components/MaterialStudioView.vue"), "utf8");
    expect(main).toContain("canvas:get-studio-production-dashboard");
    expect(main).toContain("getStudioProductionDashboard");
    expect(preload).toContain("getStudioProductionDashboard");
    expect(studio).toContain("studio-mode-dashboard");
    expect(studio).toContain("dashboardApi");
    expect(studio).toContain("AsyncStudioProductionDashboardView");
  });
});
