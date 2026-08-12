import os from "node:os";
import path from "node:path";
import { lstat, realpath } from "node:fs/promises";
import { assertFreshOutputSet } from "./lib/exclusive-evidence-output.mjs";

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

export interface BackgroundSmokeWindowEvidence {
  id?: number;
  showEvents?: number;
  focusEvents?: number;
  readyToShowEvents?: number;
  visible?: boolean;
  focused?: boolean;
  destroyed?: boolean;
}

export interface BackgroundSmokeSnapshotEvidence {
  label?: string;
  enabled?: boolean;
  platform?: string;
  activationPolicy?: string;
  dockVisible?: boolean | null;
  focusedWindowId?: number | null;
  windows?: BackgroundSmokeWindowEvidence[];
}

export interface BackgroundSmokeEvidence {
  enabled?: boolean;
  bringToFrontUsed?: boolean;
  snapshots?: BackgroundSmokeSnapshotEvidence[];
}

export interface ExactDependencyVersionIdentity {
  dependencyName: string;
  packageDirectSpec: string;
  lockRootSpec: string;
  lockEntryVersion: string;
  stageInstalledVersion: string;
  packagedInstalledVersion: string;
}

export interface DirectDependencyVersionIdentity {
  dependencyName: string;
  packageDirectSpec: string;
  lockRootSpec: string;
  lockEntryVersion: string;
  stageInstalledVersion: string;
  packagedInstalledVersion: string;
}

export interface ElectronBinaryProvenance {
  packageDirectSpec: string;
  lockEntryVersion: string;
  installedPackageVersion: string;
  distVersion: string;
  executableRelativePath: string;
  executableBytes: number;
  executableMode: number;
  architectures: string[];
  archiveName: string;
  archiveBytes: number;
  archiveEntries: string[];
}

const STATIC_PACKAGED_RESOURCES = ["aicanvas://projects", "aicanvas://server/capabilities"] as const;

export async function assertFreshEvidenceTargets(
  entries: Array<{ label: string; path: string }>,
): Promise<void> {
  await assertFreshOutputSet(entries);
}

async function canonicalizePotentialPath(candidate: string): Promise<string> {
  const missingSegments: string[] = [path.basename(candidate)];
  let ancestor = path.dirname(candidate);
  for (;;) {
    try {
      const canonicalAncestor = await realpath(ancestor);
      return path.join(canonicalAncestor, ...missingSegments);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      missingSegments.unshift(path.basename(ancestor));
      ancestor = parent;
    }
  }
}

export async function assertFreshEvidenceTargetOutsideApp(input: {
  appPath: string;
  evidencePath: string;
}): Promise<{ canonicalAppPath: string; canonicalEvidencePath: string }> {
  if (!path.isAbsolute(input.appPath) || !path.isAbsolute(input.evidencePath)) {
    throw new Error("App 与验收证据路径必须是绝对路径。");
  }
  const canonicalAppPath = await realpath(input.appPath);
  try {
    await lstat(input.evidencePath);
    throw new Error(`验收证据已存在，拒绝启动 App 或覆盖：${input.evidencePath}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const canonicalEvidencePath = await canonicalizePotentialPath(input.evidencePath);
  if (canonicalEvidencePath === canonicalAppPath || isStrictChild(canonicalAppPath, canonicalEvidencePath)) {
    throw new Error(`验收证据不得写入已安装 App 内部：${input.evidencePath}`);
  }
  return { canonicalAppPath, canonicalEvidencePath };
}

function isStrictChild(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return Boolean(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function assertTemporaryPackageRoot(packageRoot: string, workspace: string): void {
  const resolvedRoot = path.resolve(packageRoot);
  const allowedTemporaryRoots = [path.resolve(os.tmpdir())];
  if (process.platform === "darwin") allowedTemporaryRoots.push(path.resolve("/private/tmp"));
  if (!allowedTemporaryRoots.some((temporaryRoot) => isStrictChild(temporaryRoot, resolvedRoot))) {
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

export function assertExactDependencyVersionIdentity(
  identity: ExactDependencyVersionIdentity,
): ExactDependencyVersionIdentity {
  const exactVersionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
  if (!exactVersionPattern.test(identity.packageDirectSpec)) {
    throw new Error(`${identity.dependencyName} package direct spec 必须使用 exact 版本：${identity.packageDirectSpec}`);
  }
  const versions = [
    identity.lockRootSpec,
    identity.lockEntryVersion,
    identity.stageInstalledVersion,
    identity.packagedInstalledVersion,
  ];
  if (versions.some((version) => version !== identity.packageDirectSpec)) {
    throw new Error(`${identity.dependencyName} 五方版本身份不一致：${JSON.stringify(identity)}`);
  }
  return { ...identity };
}

export function assertDirectDependencyVersionIdentity(
  identity: DirectDependencyVersionIdentity,
): DirectDependencyVersionIdentity {
  if (!identity.dependencyName || !identity.packageDirectSpec || !identity.lockRootSpec || !identity.lockEntryVersion) {
    throw new Error(`直接生产依赖身份字段不完整：${JSON.stringify(identity)}`);
  }
  if (identity.packageDirectSpec !== identity.lockRootSpec) {
    throw new Error(`${identity.dependencyName} package 与 lock root spec 不一致：${JSON.stringify(identity)}`);
  }
  if (identity.stageInstalledVersion !== identity.lockEntryVersion
    || identity.packagedInstalledVersion !== identity.lockEntryVersion) {
    throw new Error(`${identity.dependencyName} lock、stage 与 packaged 版本不一致：${JSON.stringify(identity)}`);
  }
  return { ...identity };
}

export function assertElectronBinaryProvenance(
  provenance: ElectronBinaryProvenance,
): ElectronBinaryProvenance {
  const exactVersionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
  const versions = [
    provenance.packageDirectSpec,
    provenance.lockEntryVersion,
    provenance.installedPackageVersion,
    provenance.distVersion,
  ];
  if (!versions.every((version) => exactVersionPattern.test(version))
    || versions.some((version) => version !== provenance.packageDirectSpec)) {
    throw new Error(`Electron package、lock、installed 与 dist 版本身份不一致：${JSON.stringify(versions)}`);
  }
  const expectedExecutable = "Electron.app/Contents/MacOS/Electron";
  if (provenance.executableRelativePath !== expectedExecutable
    || !Number.isSafeInteger(provenance.executableBytes)
    || provenance.executableBytes <= 0
    || (provenance.executableMode & 0o111) === 0) {
    throw new Error(`Electron 可执行体无效：${JSON.stringify({
      executableRelativePath: provenance.executableRelativePath,
      executableBytes: provenance.executableBytes,
      executableMode: provenance.executableMode,
    })}`);
  }
  if (provenance.architectures.length !== 1 || provenance.architectures[0] !== "arm64") {
    throw new Error(`Electron binary 必须且只能是 arm64：${JSON.stringify(provenance.architectures)}`);
  }
  const expectedArchiveName = `electron-v${provenance.packageDirectSpec}-darwin-arm64.zip`;
  if (provenance.archiveName !== expectedArchiveName
    || !Number.isSafeInteger(provenance.archiveBytes)
    || provenance.archiveBytes < 1_000_000
    || !provenance.archiveEntries.includes(expectedExecutable)) {
    throw new Error(`Electron ZIP 身份或布局无效：${JSON.stringify({
      archiveName: provenance.archiveName,
      archiveBytes: provenance.archiveBytes,
      hasExecutable: provenance.archiveEntries.includes(expectedExecutable),
    })}`);
  }
  return { ...provenance };
}

export function assertBackgroundSmokeEvidence(
  evidence: BackgroundSmokeEvidence | undefined,
  label: string,
): void {
  const failures: string[] = [];
  if (evidence?.enabled !== true) failures.push(`enabled=${String(evidence?.enabled)}`);
  if (evidence?.bringToFrontUsed !== false) {
    failures.push(`bringToFrontUsed=${String(evidence?.bringToFrontUsed)}`);
  }
  const snapshots = Array.isArray(evidence?.snapshots) ? evidence.snapshots : [];
  if (snapshots.length < 4) failures.push(`snapshots=${snapshots.length}`);
  for (const [index, snapshot] of snapshots.entries()) {
    const prefix = `snapshots[${index}](${snapshot.label ?? "missing-label"})`;
    const windows = Array.isArray(snapshot.windows) ? snapshot.windows : [];
    const showEvents = windows.reduce((total, window) => total + Number(window.showEvents ?? 0), 0);
    const focusEvents = windows.reduce((total, window) => total + Number(window.focusEvents ?? 0), 0);
    if (snapshot.enabled !== true) failures.push(`${prefix}.enabled=${String(snapshot.enabled)}`);
    if (windows.length !== 1) failures.push(`${prefix}.windowCount=${windows.length}`);
    if (showEvents !== 0) failures.push(`${prefix}.showEvents=${showEvents}`);
    if (focusEvents !== 0) failures.push(`${prefix}.focusEvents=${focusEvents}`);
    if (windows.some((window) => window.visible === true)) failures.push(`${prefix}.visible=true`);
    if (windows.some((window) => window.focused === true)) failures.push(`${prefix}.focused=true`);
    if (snapshot.focusedWindowId !== null) {
      failures.push(`${prefix}.focusedWindowId=${String(snapshot.focusedWindowId)}`);
    }
    if (snapshot.platform === "darwin") {
      if (snapshot.activationPolicy !== "accessory") {
        failures.push(`${prefix}.activationPolicy=${String(snapshot.activationPolicy)}`);
      }
      if (snapshot.dockVisible !== false) failures.push(`${prefix}.dockVisible=${String(snapshot.dockVisible)}`);
    }
  }
  if (failures.length) {
    throw new Error(`${label} 后台 smoke 证据合同未通过：${failures.join("；")}`);
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
