import os from "node:os";
import path from "node:path";

export interface ImmutableFileSnapshot {
  exists: boolean;
  bytes?: number;
  mtimeMs?: number;
  sha256?: string;
}

export interface IsolatedRuntimePaths {
  packageRoot: string;
  home: string;
  temporaryDirectory: string;
  registryPath: string;
  mediaRuntimeDirectory: string;
  projectRoot: string;
}

export interface PackagedReviewEvidenceExpectation {
  executablePath: string;
  screenshotPath: string;
}

export interface PackagedReviewEvidence {
  status?: string;
  transport?: string;
  executablePath?: string;
  pageErrors?: unknown[];
  assertions?: Record<string, unknown>;
  screenshot?: { path?: string; bytes?: number; width?: number; height?: number };
  terminal?: { rootRemoved?: boolean; registryRemoved?: boolean; userDataRemoved?: boolean };
}

const STATIC_PACKAGED_RESOURCES = ["aicanvas://projects", "aicanvas://server/capabilities"] as const;

function isStrictChild(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return Boolean(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function assertTemporaryPackageRoot(packageRoot: string, workspace: string): void {
  const resolvedRoot = path.resolve(packageRoot);
  if (!isStrictChild(os.tmpdir(), resolvedRoot)) {
    throw new Error(`隔离打包根目录必须是系统临时目录的子目录：${resolvedRoot}`);
  }
  if (resolvedRoot === path.resolve(workspace) || isStrictChild(workspace, resolvedRoot)) {
    throw new Error(`隔离打包根目录不得位于工作区内：${resolvedRoot}`);
  }
}

export function assertPathInsidePackageRoot(candidate: string, packageRoot: string, label: string): void {
  if (!isStrictChild(packageRoot, candidate)) {
    throw new Error(`${label} 必须位于隔离打包根目录内：${path.resolve(candidate)}`);
  }
}

export function assertImmutableFileUnchanged(before: ImmutableFileSnapshot, after: ImmutableFileSnapshot, label: string): void {
  const fields: Array<keyof ImmutableFileSnapshot> = ["exists", "bytes", "mtimeMs", "sha256"];
  const changed = fields.filter((field) => before[field] !== after[field]);
  if (changed.length) {
    throw new Error(`${label} 在隔离打包期间发生变化：${JSON.stringify({ changed, before, after })}`);
  }
}

export function createIsolatedRuntimeEnvironment(
  baseEnvironment: NodeJS.ProcessEnv,
  paths: IsolatedRuntimePaths,
): NodeJS.ProcessEnv {
  const guardedPaths: Array<[string, string]> = [
    ["HOME", paths.home],
    ["TMPDIR", paths.temporaryDirectory],
    ["registry 路径", paths.registryPath],
    ["媒体运行目录", paths.mediaRuntimeDirectory],
    ["默认项目根目录", paths.projectRoot],
  ];
  for (const [label, candidate] of guardedPaths) {
    assertPathInsidePackageRoot(candidate, paths.packageRoot, label);
  }
  return {
    ...baseEnvironment,
    HOME: path.resolve(paths.home),
    TMPDIR: path.resolve(paths.temporaryDirectory),
    AI_CANVAS_REGISTRY_PATH: path.resolve(paths.registryPath),
    AI_CANVAS_MEDIA_RUNTIME_DIR: path.resolve(paths.mediaRuntimeDirectory),
    AI_CANVAS_PROJECT_ROOT: path.resolve(paths.projectRoot),
  };
}

export function assertOnlyStaticPackagedResources(resources: string[]): void {
  const unexpectedDynamicResources = resources.filter((uri) => uri.startsWith("aicanvas://projects/"));
  if (unexpectedDynamicResources.length) {
    throw new Error(`packaged capability 暴露动态项目 Resource：${JSON.stringify(unexpectedDynamicResources)}`);
  }
  const actual = [...resources].sort();
  const expected = [...STATIC_PACKAGED_RESOURCES].sort();
  if (actual.length !== expected.length || actual.some((uri, index) => uri !== expected[index])) {
    throw new Error(`packaged capability 静态 Resource 必须精确为 ${JSON.stringify(expected)}，实际：${JSON.stringify(actual)}`);
  }
}

export function assertPackagedReviewEvidence(
  evidence: PackagedReviewEvidence,
  expected: PackagedReviewEvidenceExpectation,
): void {
  const failures: string[] = [];
  if (evidence.status !== "passed") failures.push(`status=${String(evidence.status)}`);
  if (evidence.transport !== "packaged-electron-current-source") failures.push(`transport=${String(evidence.transport)}`);
  if (path.resolve(evidence.executablePath ?? "") !== path.resolve(expected.executablePath)) failures.push(`executablePath=${String(evidence.executablePath)}`);
  if (!Array.isArray(evidence.pageErrors) || evidence.pageErrors.length) failures.push(`pageErrors=${JSON.stringify(evidence.pageErrors)}`);
  for (const assertion of [
    "staleSubmitRejectedThroughUi",
    "staleAttemptWroteNoReview",
    "staleRejectAutoReloadedHash",
    "staleRejectResetCriteria",
    "visualPassSubmittedThroughUi",
    "passRestoredAfterApplicationRestart",
    "restartHashMatchesPassedContent",
    "statusReturnedToVisualReview",
    "historyPreserved",
  ]) {
    if (evidence.assertions?.[assertion] !== true) failures.push(`assertions.${assertion}=${String(evidence.assertions?.[assertion])}`);
  }
  if (path.resolve(evidence.screenshot?.path ?? "") !== path.resolve(expected.screenshotPath)) failures.push(`screenshot.path=${String(evidence.screenshot?.path)}`);
  if ((evidence.screenshot?.bytes ?? 0) < 20_000) failures.push(`screenshot.bytes=${String(evidence.screenshot?.bytes)}`);
  if (evidence.screenshot?.width !== 1560) failures.push(`screenshot.width=${String(evidence.screenshot?.width)}`);
  if (evidence.screenshot?.height !== 980) failures.push(`screenshot.height=${String(evidence.screenshot?.height)}`);
  for (const terminal of ["rootRemoved", "registryRemoved", "userDataRemoved"] as const) {
    if (evidence.terminal?.[terminal] !== true) failures.push(`terminal.${terminal}=${String(evidence.terminal?.[terminal])}`);
  }
  if (failures.length) throw new Error(`packaged ReviewStudio 证据合同未通过：${failures.join("；")}`);
}
