import path from "node:path";

export const P13_P14_INSTALLED_UI_SCREENSHOTS = [
  "01-first-run.png",
  "02-help-backup-restore.png",
  "03-restart-restored-project.png",
  "04-agent-connection.png",
  "05-managed-canvas-results.png",
  "06-one-click-review.png",
] as const;

export interface P13P14InstalledUiSmokeCli {
  executablePath: string;
  evidencePath: string;
  screenshotDirectory: string;
}

export interface P13P14InstalledUiSmokeScreenshotEvidence {
  fileName: typeof P13_P14_INSTALLED_UI_SCREENSHOTS[number];
  path: string;
  width: number;
  height: number;
  sizeBytes: number;
  sha256: string;
  maxChannelStandardDeviation: number;
}

export interface P13P14InstalledUiSmokeEvidence {
  schemaVersion: 1;
  kind: "p13-p14-installed-production-loop-ui-smoke";
  status: "pass";
  runtime: {
    executablePath: string;
    installedBundle: true;
    systemNodeRequired: false;
    release: {
      version: string;
      sourceDigest: string;
      buildId: string;
      mcpToolCount: number;
      distribution: "local-only";
    };
  };
  assertions: Record<string, boolean>;
  isolation: {
    freshUserData: boolean;
    isolatedRegistry: boolean;
    createdProjectContained: boolean;
    restoredProjectContained: boolean;
    fixtureProjectContained: boolean;
    formalProjectOpened: boolean;
    formalProjectWrites: number;
    externalRequests: number;
    agentRepairClicks: number;
  };
  screenshots: P13P14InstalledUiSmokeScreenshotEvidence[];
  terminal: {
    applicationClosed: boolean;
    runtimeRootRemoved: boolean;
    fixtureRootRemoved: boolean;
  };
  [key: string]: unknown;
}

function absolute(value: string, label: string): string {
  if (!value.trim()) throw new Error(`${label} 不能为空。`);
  if (!path.isAbsolute(value)) throw new Error(`${label} 必须是绝对路径：${value}`);
  return path.normalize(value);
}

export function parseP13P14InstalledUiSmokeCli(argv: readonly string[]): P13P14InstalledUiSmokeCli {
  if (argv.length !== 3) {
    throw new Error("用法：tsx scripts/ui-p13-p14-installed-production-loop-smoke.ts <安装版可执行文件> <证据 JSON> <全新截图目录>");
  }
  const executablePath = absolute(argv[0] ?? "", "安装版可执行文件");
  const evidencePath = absolute(argv[1] ?? "", "证据 JSON");
  const screenshotDirectory = absolute(argv[2] ?? "", "截图目录");
  if (!/\.app\/Contents\/MacOS\/[^/]+$/u.test(executablePath)) {
    throw new Error(`只接受 .app/Contents/MacOS 内的安装版可执行文件：${executablePath}`);
  }
  if (path.extname(evidencePath).toLowerCase() !== ".json") {
    throw new Error(`证据路径必须以 .json 结尾：${evidencePath}`);
  }
  const appMarker = `${path.sep}Contents${path.sep}MacOS${path.sep}`;
  const appBundleRoot = executablePath.slice(0, executablePath.indexOf(appMarker));
  for (const [label, candidate] of [["证据 JSON", evidencePath], ["截图目录", screenshotDirectory]] as const) {
    const relative = path.relative(appBundleRoot, candidate);
    if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
      throw new Error(`${label} 不得写入安装包内部：${candidate}`);
    }
  }
  return { executablePath, evidencePath, screenshotDirectory };
}

export function isStrictPathChild(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return Boolean(relative)
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

export function assertPathInsideOneOf(
  candidate: string,
  allowedRoots: readonly string[],
  label: string,
): void {
  if (!allowedRoots.some((root) => isStrictPathChild(root, candidate))) {
    throw new Error(`${label} 越出隔离根：${path.resolve(candidate)}`);
  }
}

const REQUIRED_ASSERTIONS = [
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
] as const;

export function assertP13P14InstalledUiSmokeEvidence(value: P13P14InstalledUiSmokeEvidence): void {
  const failures: string[] = [];
  if (value.schemaVersion !== 1) failures.push(`schemaVersion=${String(value.schemaVersion)}`);
  if (value.kind !== "p13-p14-installed-production-loop-ui-smoke") failures.push(`kind=${String(value.kind)}`);
  if (value.status !== "pass") failures.push(`status=${String(value.status)}`);
  if (value.runtime?.installedBundle !== true) failures.push("runtime.installedBundle");
  if (value.runtime?.systemNodeRequired !== false) failures.push("runtime.systemNodeRequired");
  if (value.runtime?.release?.distribution !== "local-only") failures.push("runtime.release.distribution");
  if (!/^0\.2\./u.test(value.runtime?.release?.version ?? "")) failures.push("runtime.release.version");
  if (!/^[a-f0-9]{64}$/u.test(value.runtime?.release?.sourceDigest ?? "")) failures.push("runtime.release.sourceDigest");
  if (!/^[a-f0-9]{32}$/u.test(value.runtime?.release?.buildId ?? "")) failures.push("runtime.release.buildId");
  if (!Number.isInteger(value.runtime?.release?.mcpToolCount) || value.runtime.release.mcpToolCount <= 0) {
    failures.push("runtime.release.mcpToolCount");
  }
  for (const assertion of REQUIRED_ASSERTIONS) {
    if (value.assertions?.[assertion] !== true) failures.push(`assertions.${assertion}`);
  }
  for (const isolation of [
    "freshUserData",
    "isolatedRegistry",
    "createdProjectContained",
    "restoredProjectContained",
    "fixtureProjectContained",
  ] as const) {
    if (value.isolation?.[isolation] !== true) failures.push(`isolation.${isolation}`);
  }
  if (value.isolation?.formalProjectOpened !== false) failures.push("isolation.formalProjectOpened");
  if (value.isolation?.formalProjectWrites !== 0) failures.push("isolation.formalProjectWrites");
  if (value.isolation?.externalRequests !== 0) failures.push("isolation.externalRequests");
  if (value.isolation?.agentRepairClicks !== 0) failures.push("isolation.agentRepairClicks");
  const screenshotNames = value.screenshots?.map((entry) => entry.fileName) ?? [];
  if (screenshotNames.length !== P13_P14_INSTALLED_UI_SCREENSHOTS.length
    || P13_P14_INSTALLED_UI_SCREENSHOTS.some((name) => !screenshotNames.includes(name))) {
    failures.push("screenshots.names");
  }
  for (const screenshot of value.screenshots ?? []) {
    if (screenshot.width < 1_200 || screenshot.height < 700 || screenshot.sizeBytes < 20_000
      || !/^[a-f0-9]{64}$/u.test(screenshot.sha256)
      || screenshot.maxChannelStandardDeviation < 3) {
      failures.push(`screenshots.${screenshot.fileName}`);
    }
  }
  for (const terminal of ["applicationClosed", "runtimeRootRemoved", "fixtureRootRemoved"] as const) {
    if (value.terminal?.[terminal] !== true) failures.push(`terminal.${terminal}`);
  }
  if (failures.length) throw new Error(`P13/P14 安装版 UI smoke 证据不完整：${failures.join("；")}`);
}
