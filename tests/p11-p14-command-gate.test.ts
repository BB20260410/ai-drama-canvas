import { describe, expect, it } from "vitest";
import {
  evaluateP11P14Gate,
  fixedP11P14GateCommand,
  P11_P14_COMMAND_GATE_MODES,
  P11_P14_TARGETED_TESTS,
  parseP11P14CommandGateMode,
  parseVitestCounts,
} from "../scripts/run-p11-p14-command-gate.js";

describe("P11–P14 固定命令门禁", () => {
  it("只接受四种 mode，且每种 argv 都来自固定 allowlist", () => {
    expect(P11_P14_COMMAND_GATE_MODES).toEqual(["typecheck", "targeted", "full", "production-build"]);
    expect(parseP11P14CommandGateMode(["targeted"])).toBe("targeted");
    expect(() => parseP11P14CommandGateMode([])).toThrow(/用法/);
    expect(() => parseP11P14CommandGateMode(["targeted", "--", "rm"])).toThrow(/用法/);
    expect(() => parseP11P14CommandGateMode(["arbitrary"])).toThrow(/用法/);
    expect(fixedP11P14GateCommand("typecheck")).toEqual({ command: "npm", args: ["run", "typecheck"], expectsTestCounts: false });
    expect(fixedP11P14GateCommand("full")).toEqual({ command: "npm", args: ["test", "--", "--maxWorkers=1"], expectsTestCounts: true });
    expect(fixedP11P14GateCommand("production-build")).toEqual({ command: "npm", args: ["run", "build"], expectsTestCounts: false });
    expect(fixedP11P14GateCommand("targeted")).toEqual({
      command: "npx",
      args: ["--no-install", "vitest", "run", ...P11_P14_TARGETED_TESTS],
      expectsTestCounts: true,
    });
  });

  it("targeted 固定覆盖 P11/P12/P13/P14 的新合同与 UI 测试", () => {
    for (const required of [
      "tests/active-managed-studio-context.test.ts",
      "tests/studio-agent-imagegen-result-bundle.test.ts",
      "tests/p13-desktop-production-loop-ui.test.ts",
      "tests/studio-continuity-review-ui.test.ts",
      "tests/studio-continuity-review-desktop-integration.test.ts",
      "tests/studio-continuity-command-bus.test.ts",
      "tests/p14-real-canary-orchestrator.test.ts",
      "tests/p14-installed-real-canary-ui-guards.test.ts",
      "tests/p14-installed-runtime-identity-guards.test.ts",
      "tests/p14-installed-agent-repair-ui-smoke-guards.test.ts",
      "tests/validate-p11-p14-desktop-loop-final.test.ts",
    ]) expect(P11_P14_TARGETED_TESTS).toContain(required);
    expect(new Set(P11_P14_TARGETED_TESTS).size).toBe(P11_P14_TARGETED_TESTS.length);
  });

  it("从带 ANSI 的 Vitest 完整日志解析真实文件和测试计数", () => {
    const counts = parseVitestCounts("\u001b[32m Test Files  3 passed (3)\u001b[39m\n Tests  9 passed (9)\n");
    expect(counts).toEqual({
      applicable: true,
      files: { total: 3, passed: 3, failed: 0 },
      tests: { total: 9, passed: 9, failed: 0 },
    });
    expect(parseVitestCounts("typecheck completed\n")).toBeNull();
  });

  it("exit、源码漂移、缺失计数或失败测试任一发生即 FAIL", () => {
    const passedCounts = parseVitestCounts("Test Files  2 passed (2)\nTests  7 passed (7)\n")!;
    expect(evaluateP11P14Gate({ exitCode: 0, sourceBefore: "a", sourceAfter: "a", expectsTestCounts: true, testCounts: passedCounts }))
      .toEqual({ status: "PASS", sourceStable: true, failureReasons: [] });
    expect(evaluateP11P14Gate({ exitCode: 0, sourceBefore: "a", sourceAfter: "b", expectsTestCounts: true, testCounts: passedCounts }))
      .toMatchObject({ status: "FAIL", sourceStable: false, failureReasons: ["source-digest-drift"] });
    expect(evaluateP11P14Gate({ exitCode: 1, sourceBefore: "a", sourceAfter: "a", expectsTestCounts: false, testCounts: null }).status).toBe("FAIL");
    expect(evaluateP11P14Gate({ exitCode: 0, sourceBefore: "a", sourceAfter: "a", expectsTestCounts: true, testCounts: null }).failureReasons)
      .toContain("test-counts-missing");
    const failedCounts = parseVitestCounts("Test Files  1 failed | 1 passed (2)\nTests  1 failed | 6 passed (7)\n")!;
    expect(evaluateP11P14Gate({ exitCode: 0, sourceBefore: "a", sourceAfter: "a", expectsTestCounts: true, testCounts: failedCounts }).failureReasons)
      .toContain("tests-not-all-passed");
  });
});
