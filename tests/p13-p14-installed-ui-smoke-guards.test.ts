import path from "node:path";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  assertP13P14InstalledUiSmokeEvidence,
  assertPathInsideOneOf,
  P13_P14_INSTALLED_UI_SCREENSHOTS,
  parseP13P14InstalledUiSmokeCli,
  type P13P14InstalledUiSmokeEvidence,
} from "../scripts/p13-p14-installed-ui-smoke-guards.js";

function validEvidence(): P13P14InstalledUiSmokeEvidence {
  const assertions = Object.fromEntries([
    "firstRunThreeEntriesVisible",
    "firstRunRecentDisabledWithoutExplicitActiveProject",
    "importEntryCanceledWithoutMutation",
    "projectCreatedThroughUi",
    "backupCompletedThroughUi",
    "restoreCompletedThroughUiToNewDirectory",
    "restartRestoredExplicitActiveProject",
    "projectSwitchIsolated",
    "fiveStepNavigation",
    "materialLibraryCharacterSceneProp",
    "scriptAndPromptVisible",
    "generationPaneVisible",
    "managedCanvasVisible",
    "rawLabeledReviewNodesVisible",
    "oneClickResultNodeOpenedReview",
    "agentConnectionStatusVisible",
    "helpAndBackupRestoreEntriesVisible",
  ].map((key) => [key, true]));
  return {
    schemaVersion: 1,
    kind: "p13-p14-installed-production-loop-ui-smoke",
    status: "pass",
    runtime: {
      executablePath: "/Applications/AI 漫剧画布.app/Contents/MacOS/AI 漫剧画布",
      installedBundle: true,
      systemNodeRequired: false,
      release: {
        version: "0.2.0",
        sourceDigest: "a".repeat(64),
        buildId: "b".repeat(32),
        mcpToolCount: 183,
        distribution: "local-only",
      },
    },
    assertions,
    isolation: {
      freshUserData: true,
      isolatedRegistry: true,
      createdProjectContained: true,
      restoredProjectContained: true,
      fixtureProjectContained: true,
      formalProjectOpened: false,
      formalProjectWrites: 0,
      externalRequests: 0,
      agentRepairClicks: 0,
    },
    screenshots: P13_P14_INSTALLED_UI_SCREENSHOTS.map((fileName) => ({
      fileName,
      path: path.join("/tmp/p13-p14-screenshots", fileName),
      width: 1_728,
      height: 1_029,
      sizeBytes: 20_001,
      sha256: "c".repeat(64),
      maxChannelStandardDeviation: 3.1,
    })),
    terminal: {
      applicationClosed: true,
      runtimeRootRemoved: true,
      fixtureRootRemoved: true,
    },
  };
}

describe("P13/P14 installed UI smoke fail-closed guards", () => {
  it("只接受安装包内可执行文件与三个显式绝对参数", () => {
    const valid = [
      "/Applications/AI 漫剧画布.app/Contents/MacOS/AI 漫剧画布",
      "/tmp/p13-p14-evidence.json",
      "/tmp/p13-p14-screenshots",
    ];
    expect(parseP13P14InstalledUiSmokeCli(valid)).toEqual({
      executablePath: valid[0],
      evidencePath: valid[1],
      screenshotDirectory: valid[2],
    });
    expect(() => parseP13P14InstalledUiSmokeCli(valid.slice(0, 2))).toThrow(/用法/);
    expect(() => parseP13P14InstalledUiSmokeCli(["./electron", valid[1]!, valid[2]!])).toThrow(/绝对路径/);
    expect(() => parseP13P14InstalledUiSmokeCli(["/usr/bin/electron", valid[1]!, valid[2]!])).toThrow(/\.app\/Contents\/MacOS/);
    expect(() => parseP13P14InstalledUiSmokeCli([valid[0]!, "/tmp/evidence.txt", valid[2]!])).toThrow(/\.json/);
    expect(() => parseP13P14InstalledUiSmokeCli([
      valid[0]!,
      "/Applications/AI 漫剧画布.app/evidence.json",
      valid[2]!,
    ])).toThrow(/安装包内部/);
  });

  it("工程路径必须严格位于显式临时根，拒绝根自身与目录逃逸", () => {
    const root = "/tmp/p13-p14-runtime";
    expect(() => assertPathInsideOneOf(path.join(root, "projects", "one"), [root], "验收工程")).not.toThrow();
    expect(() => assertPathInsideOneOf(root, [root], "验收工程")).toThrow(/越出隔离根/);
    expect(() => assertPathInsideOneOf("/Users/hxx/Documents/无限画布/projects/codex-ai-drama-studio", [root], "验收工程"))
      .toThrow(/越出隔离根/);
  });

  it("缺少任一桌面闭环断言、隔离门禁或有效截图时不得标记 PASS", () => {
    const evidence = validEvidence();
    expect(() => assertP13P14InstalledUiSmokeEvidence(evidence)).not.toThrow();
    expect(() => assertP13P14InstalledUiSmokeEvidence({
      ...evidence,
      assertions: { ...evidence.assertions, oneClickResultNodeOpenedReview: false },
    })).toThrow(/oneClickResultNodeOpenedReview/);
    expect(() => assertP13P14InstalledUiSmokeEvidence({
      ...evidence,
      isolation: { ...evidence.isolation, formalProjectWrites: 1 },
    })).toThrow(/formalProjectWrites/);
    expect(() => assertP13P14InstalledUiSmokeEvidence({
      ...evidence,
      screenshots: evidence.screenshots.slice(1),
    })).toThrow(/screenshots.names/);
  });

  it("Electron 主进程注入函数自包含，不依赖 tsx 宿主侧 __name helper", async () => {
    const source = await readFile(path.join(process.cwd(), "scripts", "ui-p13-p14-installed-production-loop-smoke.ts"), "utf8");
    expect(source).toContain('new Function("electron", "initialRoutes"');
    expect(source).toContain('new Function("electron", "selectedBackupRoot"');
    expect(source).not.toContain("target.evaluate(({ dialog }");
    expect(source).toContain("expectedLocation: { root?: string; parent?: string }");
    expect(source).toContain("async function waitForRestoreFeedback(page: Page)");
    expect(source).toContain('document.querySelector<HTMLElement>(".toast-message")');
    expect(source).toContain("async function clickNodeInsideFlowViewport(node: Locator)");
    expect(source).toContain("document.elementFromPoint(clientX, clientY)");
    expect(source).not.toMatch(/(?:sixPanelUnitNode|node)\.click\(\{\s*force:\s*true/u);
    expect(source).toContain('{ parent: restoreParent }');
    expect(source).toContain('{ root: restoredRegistration.primaryRoot }');
  });
});
