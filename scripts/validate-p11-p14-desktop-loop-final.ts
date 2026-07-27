/**
 * P11–P14 最终证据聚合门禁。
 *
 * 本脚本不运行任何重门禁，只读取 docs/evidence 下冻结文件名的全新证据，
 * 校验它们与工作区 release-manifest.json 绑定到同一构建身份后，独占写入
 * final-validation。任一证据缺失、失败、漂移、符号链接或旧 final 已存在时
 * 都失败关闭。
 */
import { createHash } from "node:crypto";
import { access, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assertReleaseManifest,
  readReleaseManifest,
  type ReleaseManifest,
} from "../src/core/release-manifest.js";
import {
  assertP13P14InstalledUiSmokeEvidence,
  type P13P14InstalledUiSmokeEvidence,
} from "./p13-p14-installed-ui-smoke-guards.js";
import {
  assertP14InstalledAgentRepairEvidence,
  type P14InstalledAgentRepairEvidence,
} from "./p14-installed-agent-repair-ui-smoke-guards.js";
import {
  assertP14InstalledRealCanaryUiEvidence,
  type P14InstalledRealCanaryUiEvidence,
} from "./p14-installed-real-canary-ui-guards.js";
import {
  fixedP11P14GateCommand,
  type P11P14CommandGateMode,
} from "./run-p11-p14-command-gate.js";

const SCRIPT_WORKSPACE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const BUILD_ID_PATTERN = /^[a-f0-9]{32}$/u;
const MAX_EVIDENCE_BYTES = 64 * 1024 * 1024;

export const P11_P14_FINAL_VALIDATION_FILE = "final-validation-20260718-p11-p14-desktop-loop.json" as const;

export const P11_P14_FINAL_EVIDENCE_FILES = {
  typecheck: "p11-p14-typecheck-20260718-r7.json",
  targetedTests: "p11-p14-targeted-tests-20260718-r7.json",
  fullTests: "p11-p14-full-tests-20260718-r7.json",
  productionBuild: "p11-p14-production-build-20260718-r7.json",
  isolatedPackage: "p14-isolated-package-smoke-20260718-p11p14-r7.json",
  installedSignature: "p14-installed-signature-20260718-r7.json",
  installedProductionLoopUi: "p14-installed-production-loop-ui-20260718-r7.json",
  installedScaleCanvasUi: "p14-installed-scale-canvas-ui-20260718-r7.json",
  installedAgentConnectionUi: "p14-installed-agent-connection-ui-20260718-r7.json",
  installedRealCanaryUi: "p14-installed-real-canary-ui-20260718-r7.json",
  dualAgentFreshSessionRead: "p14-dual-agent-fresh-session-read-20260718-r7.json",
  formalBackupRestore: "p14-formal-backup-restore-20260718-r7.json",
  installedSoak: "p14-installed-soak-20260718-r7.json",
} as const;

export type P11P14FinalEvidenceKey = keyof typeof P11_P14_FINAL_EVIDENCE_FILES;

interface EvidenceFile<T = Record<string, unknown>> {
  fileName: string;
  absolutePath: string;
  sizeBytes: number;
  sha256: string;
  value: T;
}

export interface P11P14FinalValidationOptions {
  workspace?: string;
  evidenceRoot?: string;
  outputPath?: string;
}

export interface P11P14FinalValidationReport {
  schemaVersion: 1;
  kind: "p11-p14-desktop-loop-final-validation";
  status: "PASS";
  generatedAt: string;
  release: {
    version: string;
    architecture: NodeJS.Architecture;
    sourceDigest: string;
    buildId: string;
    buildIdentityFingerprint: string;
    releaseManifestFingerprint: string;
    protocolVersion: string;
    mcpToolCount: number;
    distribution: "local-only";
  };
  evidence: Record<P11P14FinalEvidenceKey, {
    fileName: string;
    sizeBytes: number;
    sha256: string;
    gate: "PASS";
  }>;
  assertions: {
    exactEvidenceSet: true;
    allGatesPassed: true;
    sameSourceDigest: true;
    sameBuildId: true;
    sameBuildIdentityFingerprint: true;
    sameReleaseManifestFingerprint: true;
    realInstalledApplication: true;
    realCodexCanaryReviewed: true;
    dualAgentFreshSessionsReadSameProject: true;
    formalBackupRestoreAndRestoredWritePassed: true;
    installedScaleAndEndurancePassed: true;
  };
  boundaries: {
    aggregationOnly: true;
    evidenceOverwritten: false;
    gitActions: 0;
    browserCalls: 0;
    uploads: 0;
    notarizationPerformed: false;
    distribution: "local-only";
  };
  fingerprint: string;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([key, entry]) => [key, stableValue(entry)]));
}

function digest(value: unknown): string {
  const content = typeof value === "string" ? value : JSON.stringify(stableValue(value));
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function fail(label: string, message: string): never {
  throw new Error(`P11–P14 最终验收失败 [${label}]：${message}`);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(label, "必须是对象");
  return value as Record<string, unknown>;
}

function child(value: unknown, key: string, label: string): Record<string, unknown> {
  return record(record(value, label)[key], `${label}.${key}`);
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) fail(label, "必须是数组");
  return value;
}

function integer(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) fail(label, `必须是 >= ${minimum} 的安全整数`);
  return Number(value);
}

function finite(value: unknown, label: string, minimum = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) fail(label, `必须是 >= ${minimum} 的有限数值`);
  return value;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) fail(label, "必须是非空字符串");
  return value;
}

function exact(value: unknown, expected: unknown, label: string): void {
  if (value !== expected) fail(label, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(value)}`);
}

function sha256(value: unknown, label: string): string {
  const normalized = text(value, label);
  if (!SHA256_PATTERN.test(normalized)) fail(label, "必须是 64 位小写 SHA-256");
  return normalized;
}

function buildId(value: unknown, label: string): string {
  const normalized = text(value, label);
  if (!BUILD_ID_PATTERN.test(normalized)) fail(label, "必须是 32 位小写 buildId");
  return normalized;
}

function allTrue(value: unknown, keys: readonly string[], label: string): void {
  const target = record(value, label);
  for (const key of keys) exact(target[key], true, `${label}.${key}`);
}

function allZero(value: unknown, keys: readonly string[], label: string): void {
  const target = record(value, label);
  for (const key of keys) exact(target[key], 0, `${label}.${key}`);
}

function assertReleaseIdentity(
  value: unknown,
  release: ReleaseManifest,
  label: string,
  fields: {
    version?: string;
    sourceDigest?: string;
    buildId?: string;
    buildIdentityFingerprint?: string;
    releaseManifestFingerprint?: string;
    mcpToolCount?: string;
  } = {},
): void {
  const target = record(value, label);
  const at = (pathValue: string): unknown => pathValue.split(".").reduce<unknown>((current, segment) => (
    record(current, `${label}.${pathValue}`)[segment]
  ), target);
  if (fields.version) exact(at(fields.version), release.version, `${label}.${fields.version}`);
  if (fields.sourceDigest) exact(at(fields.sourceDigest), release.sourceDigest, `${label}.${fields.sourceDigest}`);
  if (fields.buildId) exact(at(fields.buildId), release.buildId, `${label}.${fields.buildId}`);
  if (fields.buildIdentityFingerprint) {
    exact(at(fields.buildIdentityFingerprint), release.buildIdentityFingerprint, `${label}.${fields.buildIdentityFingerprint}`);
  }
  if (fields.releaseManifestFingerprint) {
    exact(at(fields.releaseManifestFingerprint), release.fingerprint, `${label}.${fields.releaseManifestFingerprint}`);
  }
  if (fields.mcpToolCount) exact(at(fields.mcpToolCount), release.mcpToolCount, `${label}.${fields.mcpToolCount}`);
}

async function readEvidenceFile(evidenceRoot: string, fileName: string): Promise<EvidenceFile> {
  const absolutePath = path.join(evidenceRoot, fileName);
  const relative = path.relative(evidenceRoot, absolutePath);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) fail(fileName, "路径越出 evidenceRoot");
  const metadata = await lstat(absolutePath).catch(() => fail(fileName, "证据文件缺失"));
  if (!metadata.isFile() || metadata.isSymbolicLink()) fail(fileName, "只接受普通文件，拒绝符号链接");
  if (metadata.size <= 1 || metadata.size > MAX_EVIDENCE_BYTES) fail(fileName, `文件大小无效：${metadata.size}`);
  const bytes = await readFile(absolutePath);
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail(fileName, "不是有效 JSON");
  }
  const parsed = record(value, fileName);
  return { fileName, absolutePath, sizeBytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex"), value: parsed };
}

async function assertCommandGate(
  file: EvidenceFile,
  mode: P11P14CommandGateMode,
  release: ReleaseManifest,
  workspace: string,
): Promise<void> {
  const label = file.fileName;
  const value = file.value;
  exact(value.schemaVersion, 1, `${label}.schemaVersion`);
  exact(value.kind, "p11-p14-command-gate-record", `${label}.kind`);
  exact(value.status, "PASS", `${label}.status`);
  exact(value.mode, mode, `${label}.mode`);
  exact(value.exitCode, 0, `${label}.exitCode`);
  exact(value.sourceStable, true, `${label}.sourceStable`);
  exact(path.resolve(text(value.cwd, `${label}.cwd`)), workspace, `${label}.cwd`);
  if (array(value.failureReasons, `${label}.failureReasons`).length !== 0) fail(`${label}.failureReasons`, "PASS 证据不得含失败原因");
  const expectedCommand = fixedP11P14GateCommand(mode);
  const expectedArgv = [expectedCommand.command, ...expectedCommand.args];
  if (JSON.stringify(value.argv) !== JSON.stringify(expectedArgv)) fail(`${label}.argv`, "不是冻结命令 argv");
  const source = child(value, "sourceDigest", label);
  exact(source.before, release.sourceDigest, `${label}.sourceDigest.before`);
  exact(source.after, release.sourceDigest, `${label}.sourceDigest.after`);
  integer(source.beforeFiles, `${label}.sourceDigest.beforeFiles`, 1);
  exact(source.afterFiles, source.beforeFiles, `${label}.sourceDigest.afterFiles`);
  const identities = child(value, "buildIdentity", label);
  for (const side of ["before", "after"] as const) {
    const identity = record(identities[side], `${label}.buildIdentity.${side}`);
    exact(identity.sourceDigest, release.sourceDigest, `${label}.buildIdentity.${side}.sourceDigest`);
    exact(identity.buildId, release.buildId, `${label}.buildIdentity.${side}.buildId`);
    exact(identity.fingerprint, release.buildIdentityFingerprint, `${label}.buildIdentity.${side}.fingerprint`);
  }
  const counts = child(value, "testCounts", label);
  exact(counts.applicable, expectedCommand.expectsTestCounts, `${label}.testCounts.applicable`);
  if (expectedCommand.expectsTestCounts) {
    for (const key of ["files", "tests"] as const) {
      const group = record(counts[key], `${label}.testCounts.${key}`);
      const total = integer(group.total, `${label}.testCounts.${key}.total`, 1);
      exact(group.passed, total, `${label}.testCounts.${key}.passed`);
      exact(group.failed, 0, `${label}.testCounts.${key}.failed`);
    }
  } else if (counts.files !== null || counts.tests !== null) {
    fail(`${label}.testCounts`, "非测试命令必须记录 applicable=false 且 files/tests=null");
  }
  const log = child(value, "log", label);
  const relativeLog = text(log.relativePath, `${label}.log.relativePath`);
  const logPath = path.resolve(workspace, relativeLog);
  const evidenceRelative = path.relative(path.join(workspace, "docs", "evidence"), logPath);
  if (!evidenceRelative || evidenceRelative.startsWith(`..${path.sep}`) || path.isAbsolute(evidenceRelative)) {
    fail(`${label}.log.relativePath`, "命令日志必须位于 docs/evidence 内");
  }
  const logMetadata = await lstat(logPath).catch(() => fail(`${label}.log`, "日志文件缺失"));
  if (!logMetadata.isFile() || logMetadata.isSymbolicLink()) fail(`${label}.log`, "日志必须是普通文件");
  const logBytes = await readFile(logPath);
  exact(log.sizeBytes, logBytes.byteLength, `${label}.log.sizeBytes`);
  exact(log.sha256, createHash("sha256").update(logBytes).digest("hex"), `${label}.log.sha256`);
  const security = child(value, "security", label);
  exact(security.environmentRecorded, false, `${label}.security.environmentRecorded`);
  exact(security.childEnvironmentAllowlisted, true, `${label}.security.childEnvironmentAllowlisted`);
}

function assertIsolatedPackage(file: EvidenceFile, release: ReleaseManifest): void {
  const value = file.value;
  const label = file.fileName;
  exact(value.schemaVersion, 1, `${label}.schemaVersion`);
  exact(value.status, "passed", `${label}.status`);
  exact(value.scope, "current-source-isolated-unpacked-app-validation", `${label}.scope`);
  const boundary = child(value, "authorizationBoundary", label);
  for (const key of [
    "formalProjectUsed", "externalWebsiteUsed", "uploadUsed", "paidActionUsed", "installed", "published",
    "dmgGenerated", "developerIdSigningRequested", "notarizationRequested", "workspaceDistOverwritten",
    "closesRealProjectNleValidation",
  ]) exact(boundary[key], false, `${label}.authorizationBoundary.${key}`);
  const packageEvidence = child(value, "package", label);
  const packagedManifest = record(packageEvidence.releaseManifest, `${label}.package.releaseManifest`);
  assertReleaseManifest(packagedManifest);
  assertReleaseIdentity(packagedManifest, release, `${label}.package.releaseManifest`, {
    version: "version",
    sourceDigest: "sourceDigest",
    buildId: "buildId",
    buildIdentityFingerprint: "buildIdentityFingerprint",
    mcpToolCount: "mcpToolCount",
  });
  exact(packagedManifest.architecture, release.architecture, `${label}.package.releaseManifest.architecture`);
  exact(packagedManifest.protocolVersion, release.protocolVersion, `${label}.package.releaseManifest.protocolVersion`);
  exact(packagedManifest.distribution, release.distribution, `${label}.package.releaseManifest.distribution`);
  exact(packagedManifest.localOnly, true, `${label}.package.releaseManifest.localOnly`);
  exact(child(packageEvidence, "stageMcpCapabilities", `${label}.package`).toolCount, release.mcpToolCount, `${label}.package.stageMcpCapabilities.toolCount`);
  exact(child(value, "packagedMcp", label).toolCount, release.mcpToolCount, `${label}.packagedMcp.toolCount`);
  exact(child(value, "protectedWorkspaceArtifacts", label).unchanged, true, `${label}.protectedWorkspaceArtifacts.unchanged`);
  const terminal = child(value, "terminal", label);
  allTrue(terminal, [
    "tempRootRemoved", "emptyProjectRemoved", "emptyProjectRegistryRemoved", "effectTransitionRegistryRemoved",
    "packagedRegistryRemoved", "packagedMediaRuntimeRemoved", "packagedProjectRootRemoved",
    "packagedReviewProjectRemoved", "packagedReviewRegistryRemoved", "packagedReviewUserDataRemoved",
  ], `${label}.terminal`);
  if (array(terminal.lingeringProcessesAfterCleanup, `${label}.terminal.lingeringProcessesAfterCleanup`).length !== 0) {
    fail(`${label}.terminal.lingeringProcessesAfterCleanup`, "清理后仍有残留进程");
  }
}

function assertInstalledSignature(file: EvidenceFile, release: ReleaseManifest): void {
  const value = file.value;
  const label = file.fileName;
  exact(value.schemaVersion, 1, `${label}.schemaVersion`);
  exact(value.kind, "p14-installed-signature-evidence", `${label}.kind`);
  exact(value.status, "pass", `${label}.status`);
  assertReleaseIdentity(value, release, label, {
    version: "release.version",
    sourceDigest: "release.sourceDigest",
    buildId: "release.buildId",
    releaseManifestFingerprint: "release.releaseManifestFingerprint",
    mcpToolCount: "release.mcpToolCount",
  });
  const bundle = child(value, "bundle", label);
  exact(bundle.identifier, "com.hxx.aidramacanvas", `${label}.bundle.identifier`);
  exact(bundle.version, release.version, `${label}.bundle.version`);
  exact(bundle.name, "AI 漫剧画布", `${label}.bundle.name`);
  exact(bundle.architecture, release.architecture, `${label}.bundle.architecture`);
  const signing = child(value, "signing", label);
  exact(signing.verified, true, `${label}.signing.verified`);
  exact(signing.deepStrict, true, `${label}.signing.deepStrict`);
  exact(signing.identityCommonName, "Developer ID Application: YIHANG LI (3JS43BTTJ3)", `${label}.signing.identityCommonName`);
  exact(signing.teamIdentifier, "3JS43BTTJ3", `${label}.signing.teamIdentifier`);
  const installation = child(value, "installation", label);
  exact(installation.path, "/Applications/AI 漫剧画布.app", `${label}.installation.path`);
  exact(installation.launchWithoutSystemNode, true, `${label}.installation.launchWithoutSystemNode`);
  exact(installation.packagedMcpStartedWithAppElectronRuntime, true, `${label}.installation.packagedMcpStartedWithAppElectronRuntime`);
  exact(installation.actualMcpToolCount, release.mcpToolCount, `${label}.installation.actualMcpToolCount`);
  exact(value.distribution, "local-only", `${label}.distribution`);
  exact(child(value, "notarization", label).performed, false, `${label}.notarization.performed`);
  const boundaries = child(value, "boundaries", label);
  for (const key of ["systemNodeRequired", "uploaded", "published", "autoUpdateConfigured"] as const) {
    exact(boundaries[key], false, `${label}.boundaries.${key}`);
  }
}

function assertInstalledProductionLoop(file: EvidenceFile, release: ReleaseManifest): void {
  const value = file.value as unknown as P13P14InstalledUiSmokeEvidence;
  assertP13P14InstalledUiSmokeEvidence(value);
  assertReleaseIdentity(value, release, file.fileName, {
    version: "runtime.release.version",
    sourceDigest: "runtime.release.sourceDigest",
    buildId: "runtime.release.buildId",
    mcpToolCount: "runtime.release.mcpToolCount",
  });
}

function assertInstalledScale(file: EvidenceFile, release: ReleaseManifest): void {
  const value = file.value;
  const label = file.fileName;
  exact(value.schemaVersion, 2, `${label}.schemaVersion`);
  exact(value.kind, "managed-studio-scale-canvas-ui-smoke", `${label}.kind`);
  exact(value.status, "pass", `${label}.status`);
  assertReleaseIdentity(value, release, label, {
    version: "buildIdentity.version",
    sourceDigest: "buildIdentity.sourceDigest",
    buildId: "buildIdentity.buildId",
    buildIdentityFingerprint: "buildIdentity.fingerprint",
    releaseManifestFingerprint: "buildIdentity.releaseManifestFingerprint",
  });
  exact(child(value, "buildIdentity", label).source, "installed-app-resources-release-manifest", `${label}.buildIdentity.source`);
  const fixture = child(value, "fixture", label);
  const large = record(fixture.large, `${label}.fixture.large`);
  exact(large.units, 1_288, `${label}.fixture.large.units`);
  exact(large.panels, 4_235, `${label}.fixture.large.panels`);
  exact(large.assets, 77, `${label}.fixture.large.assets`);
  const media = record(large.media, `${label}.fixture.large.media`);
  exact(media.total, 10_000, `${label}.fixture.large.media.total`);
  exact(media.verifiedCas, 10_000, `${label}.fixture.large.media.verifiedCas`);
  integer(media.verifiedThumbnails, `${label}.fixture.large.media.verifiedThumbnails`, 1_000);
  const startup = child(value, "startup", label);
  allZero(startup, ["pageErrors", "consoleErrors", "externalRequests"], `${label}.startup`);
  const runtime = child(value, "runtime", label);
  exact(runtime.kind, "installed-application", `${label}.runtime.kind`);
  exact(runtime.systemNodeRequired, false, `${label}.runtime.systemNodeRequired`);
  const canvas = child(value, "canvas", label);
  exact(canvas.logicalPageLimit, 36, `${label}.canvas.logicalPageLimit`);
  exact(canvas.assetPageLimit, 6, `${label}.canvas.assetPageLimit`);
  exact(canvas.unitPageLimit, 36, `${label}.canvas.unitPageLimit`);
  exact(canvas.panelExpansionLimit, 6, `${label}.canvas.panelExpansionLimit`);
  exact(canvas.pipelineNodeLimit, 18, `${label}.canvas.pipelineNodeLimit`);
  const maximumDom = integer(canvas.maximumDomNodes, `${label}.canvas.maximumDomNodes`, 1);
  if (integer(canvas.initialDom, `${label}.canvas.initialDom`) > maximumDom
    || integer(canvas.expandedDom, `${label}.canvas.expandedDom`) > maximumDom
    || integer(canvas.pipelineDom, `${label}.canvas.pipelineDom`) > 18) fail(`${label}.canvas`, "DOM 投影超过冻结上限");
  exact(canvas.unitPageReplaced, true, `${label}.canvas.unitPageReplaced`);
  exact(canvas.assetPageReplaced, true, `${label}.canvas.assetPageReplaced`);
  exact(canvas.viewportCullingEnabled, true, `${label}.canvas.viewportCullingEnabled`);
  exact(canvas.panelExpansionBound, 6, `${label}.canvas.panelExpansionBound`);
  const mediaLibrary = child(value, "mediaLibrary", label);
  exact(mediaLibrary.exactCount, 10_000, `${label}.mediaLibrary.exactCount`);
  for (const key of ["firstPageDom", "scrolledDom", "secondPageDom"] as const) {
    const count = integer(mediaLibrary[key], `${label}.mediaLibrary.${key}`);
    if (count > 36) fail(`${label}.mediaLibrary.${key}`, "媒体 DOM 超过 36");
  }
  exact(mediaLibrary.keysetPageReplaced, true, `${label}.mediaLibrary.keysetPageReplaced`);
  exact(mediaLibrary.previousPageRestored, true, `${label}.mediaLibrary.previousPageRestored`);
  const projectSwitch = child(value, "projectSwitch", label);
  exact(projectSwitch.largeToSmall, true, `${label}.projectSwitch.largeToSmall`);
  exact(projectSwitch.smallToLarge, true, `${label}.projectSwitch.smallToLarge`);
  exact(projectSwitch.crossProjectLeak, false, `${label}.projectSwitch.crossProjectLeak`);
  const screenshot = child(value, "screenshot", label);
  integer(screenshot.sizeBytes, `${label}.screenshot.sizeBytes`, 40_000);
  sha256(screenshot.sha256, `${label}.screenshot.sha256`);
  integer(screenshot.width, `${label}.screenshot.width`, 1_400);
  integer(screenshot.height, `${label}.screenshot.height`, 800);
  finite(screenshot.stdev, `${label}.screenshot.stdev`, 5);
  const boundaries = child(value, "boundaries", label);
  allZero(boundaries, ["filesystemScans", "formalImageGenerationCalls", "browserSupplierCalls", "uploads", "gitStage"], `${label}.boundaries`);
  exact(boundaries.formalStudioTouched, false, `${label}.boundaries.formalStudioTouched`);
}

function assertInstalledAgentConnection(file: EvidenceFile, release: ReleaseManifest): void {
  const value = file.value as unknown as P14InstalledAgentRepairEvidence;
  assertP14InstalledAgentRepairEvidence(value);
  assertReleaseIdentity(value, release, file.fileName, {
    sourceDigest: "runtime.sourceDigest",
    buildId: "runtime.buildId",
    mcpToolCount: "runtime.mcpToolCount",
  });
}

function assertInstalledCanary(file: EvidenceFile, release: ReleaseManifest): void {
  const value = file.value as unknown as P14InstalledRealCanaryUiEvidence;
  assertP14InstalledRealCanaryUiEvidence(value);
  assertReleaseIdentity(value, release, file.fileName, {
    version: "runtime.release.version",
    sourceDigest: "runtime.release.sourceDigest",
    buildId: "runtime.release.buildId",
    mcpToolCount: "runtime.release.mcpToolCount",
  });
  const root = file.value;
  const boundary = child(root, "boundaries", file.fileName);
  exact(boundary.imageGeneratedByScript, false, `${file.fileName}.boundaries.imageGeneratedByScript`);
  exact(boundary.fixtureCreatedByScript, false, `${file.fileName}.boundaries.fixtureCreatedByScript`);
  exact(boundary.mechanicalDecodeEqualsVisualApproval, false, `${file.fileName}.boundaries.mechanicalDecodeEqualsVisualApproval`);
  exact(boundary.browserUsed, false, `${file.fileName}.boundaries.browserUsed`);
  allZero(boundary, ["uploads", "gitActions"], `${file.fileName}.boundaries`);
}

function assertDualAgentFreshSession(file: EvidenceFile, release: ReleaseManifest): void {
  const value = file.value;
  const label = file.fileName;
  exact(value.schemaVersion, 1, `${label}.schemaVersion`);
  exact(value.kind, "p14-dual-agent-fresh-session-read-evidence", `${label}.kind`);
  exact(value.status, "PASS", `${label}.status`);
  const { fingerprint, ...semantic } = value;
  exact(sha256(fingerprint, `${label}.fingerprint`), digest(semantic), `${label}.fingerprint`);
  const expected = child(value, "expected", label);
  text(expected.projectId, `${label}.expected.projectId`);
  sha256(expected.manifestFingerprint, `${label}.expected.manifestFingerprint`);
  exact(expected.sourceDigest, release.sourceDigest, `${label}.expected.sourceDigest`);
  const clients = child(value, "clients", label);
  for (const client of ["codex", "grok"] as const) {
    const clientValue = record(clients[client], `${label}.clients.${client}`);
    exact(clientValue.sessionStarted, true, `${label}.clients.${client}.sessionStarted`);
    exact(record(clientValue.help, `${label}.clients.${client}.help`).supported, true, `${label}.clients.${client}.help.supported`);
    const trace = record(clientValue.nativeTrace, `${label}.clients.${client}.nativeTrace`);
    exact(trace.verifiable, true, `${label}.clients.${client}.nativeTrace.verifiable`);
    exact(trace.exactToolSequence, true, `${label}.clients.${client}.nativeTrace.exactToolSequence`);
    const calls = array(trace.toolCalls, `${label}.clients.${client}.nativeTrace.toolCalls`);
    if (calls.length !== 2) fail(`${label}.clients.${client}.nativeTrace.toolCalls`, "必须精确两次只读调用");
    const names = calls.map((entry, index) => {
      const call = record(entry, `${label}.clients.${client}.nativeTrace.toolCalls[${index}]`);
      exact(call.serverName, "ai-drama-canvas", `${label}.clients.${client}.nativeTrace.toolCalls[${index}].serverName`);
      exact(call.argumentsEmpty, true, `${label}.clients.${client}.nativeTrace.toolCalls[${index}].argumentsEmpty`);
      exact(call.completed, true, `${label}.clients.${client}.nativeTrace.toolCalls[${index}].completed`);
      exact(call.succeeded, true, `${label}.clients.${client}.nativeTrace.toolCalls[${index}].succeeded`);
      return call.toolName;
    });
    if (JSON.stringify(names) !== JSON.stringify(["get_capabilities", "get_active_managed_studio_context"])) {
      fail(`${label}.clients.${client}.nativeTrace.toolCalls`, "调用顺序或工具不正确");
    }
  }
  const results = child(value, "results", label);
  let contextFingerprint: string | undefined;
  for (const client of ["codex", "grok"] as const) {
    const result = record(results[client], `${label}.results.${client}`);
    const capabilities = record(result.capabilities, `${label}.results.${client}.capabilities`);
    exact(capabilities.serverName, "ai-drama-canvas", `${label}.results.${client}.capabilities.serverName`);
    exact(capabilities.sourceDigest, release.sourceDigest, `${label}.results.${client}.capabilities.sourceDigest`);
    exact(capabilities.buildId, release.buildId, `${label}.results.${client}.capabilities.buildId`);
    exact(capabilities.buildIdentityFingerprint, release.buildIdentityFingerprint, `${label}.results.${client}.capabilities.buildIdentityFingerprint`);
    exact(capabilities.toolCount, release.mcpToolCount, `${label}.results.${client}.capabilities.toolCount`);
    const active = record(result.activeContext, `${label}.results.${client}.activeContext`);
    exact(active.projectId, expected.projectId, `${label}.results.${client}.activeContext.projectId`);
    exact(active.manifestFingerprint, expected.manifestFingerprint, `${label}.results.${client}.activeContext.manifestFingerprint`);
    exact(active.sourceDigest, release.sourceDigest, `${label}.results.${client}.activeContext.sourceDigest`);
    sha256(active.contextFingerprint, `${label}.results.${client}.activeContext.contextFingerprint`);
    contextFingerprint ??= String(active.contextFingerprint);
    exact(active.contextFingerprint, contextFingerprint, `${label}.results.${client}.activeContext.contextFingerprint`);
    exact(active.promptEntry, "managed_studio_lock_generate_writeback", `${label}.results.${client}.activeContext.promptEntry`);
    const safety = record(result.safety, `${label}.results.${client}.safety`);
    exact(safety.projectRootArgumentSupplied, false, `${label}.results.${client}.safety.projectRootArgumentSupplied`);
    exact(safety.secretsReadOrPrinted, false, `${label}.results.${client}.safety.secretsReadOrPrinted`);
  }
  allTrue(child(value, "comparisons", label), [
    "expectedIdentity", "sameBuildIdentity", "sameContextFingerprint", "sameLockedAssets", "sameNextAction",
    "samePromptEntry", "exactToolSequence",
  ], `${label}.comparisons`);
  const boundaries = child(value, "boundaries", label);
  allTrue(boundaries, ["execFileWithoutShell", "freshSessions"], `${label}.boundaries`);
  for (const key of [
    "projectRootAcceptedByScript", "projectRootArgumentSupplied", "agentConfigurationModified",
    "secretEnvironmentVariablesForwarded", "secretsReadOrPrinted",
  ]) exact(boundaries[key], false, `${label}.boundaries.${key}`);
}

function assertFormalBackupRestore(file: EvidenceFile, release: ReleaseManifest): void {
  const value = file.value;
  const label = file.fileName;
  exact(value.schemaVersion, 1, `${label}.schemaVersion`);
  exact(value.kind, "p14-formal-project-backup-restore-validation", `${label}.kind`);
  exact(value.status, "pass", `${label}.status`);
  assertReleaseIdentity(value, release, label, { sourceDigest: "buildIdentity.sourceDigest", buildId: "buildIdentity.buildId" });
  const source = child(value, "source", label);
  text(source.projectId, `${label}.source.projectId`);
  sha256(source.manifestFingerprint, `${label}.source.manifestFingerprint`);
  exact(source.writeCommandsByThisRun, 0, `${label}.source.writeCommandsByThisRun`);
  const sourceInventory = record(source.mediaInventory, `${label}.source.mediaInventory`);
  const backup = child(value, "backup", label);
  exact(backup.schemaVersion, 2, `${label}.backup.schemaVersion`);
  integer(backup.fileCount, `${label}.backup.fileCount`, 1);
  sha256(backup.aggregateSha256, `${label}.backup.aggregateSha256`);
  sha256(backup.manifestSha256, `${label}.backup.manifestSha256`);
  const restore = child(value, "restore", label);
  exact(restore.overwriteSource, false, `${label}.restore.overwriteSource`);
  exact(restore.projectIdPreserved, true, `${label}.restore.projectIdPreserved`);
  const integrity = array(restore.sqliteIntegrity, `${label}.restore.sqliteIntegrity`);
  if (!integrity.length || integrity.some((entry) => record(entry, `${label}.restore.sqliteIntegrity`).result !== "ok")) {
    fail(`${label}.restore.sqliteIntegrity`, "SQLite integrity_check 未全部为 ok");
  }
  const restoredInventory = record(restore.mediaInventory, `${label}.restore.mediaInventory`);
  const mediaSamples = record(restore.mediaSamples, `${label}.restore.mediaSamples`);
  for (const [sampleKind, inventoryKind] of [["images", "image"], ["videos", "video"], ["audio", "audio"]] as const) {
    const sourceCount = integer(sourceInventory[inventoryKind], `${label}.source.mediaInventory.${inventoryKind}`);
    const restoredCount = integer(restoredInventory[inventoryKind], `${label}.restore.mediaInventory.${inventoryKind}`);
    exact(restoredCount, sourceCount, `${label}.restore.mediaInventory.${inventoryKind}`);
    const samples = array(mediaSamples[sampleKind], `${label}.restore.mediaSamples.${sampleKind}`);
    if (sourceCount > 0 && samples.length === 0) fail(`${label}.restore.mediaSamples.${sampleKind}`, "库存非零但缺少解码抽样");
    if (sourceCount === 0 && samples.length !== 0) fail(`${label}.restore.mediaSamples.${sampleKind}`, "库存为零却出现伪造抽样");
  }
  const safeWrite = record(restore.safeWrite, `${label}.restore.safeWrite`);
  exact(safeWrite.command, "create_studio_prompt_document", `${label}.restore.safeWrite.command`);
  exact(safeWrite.status, "succeeded", `${label}.restore.safeWrite.status`);
  const boundaries = child(value, "boundaries", label);
  allZero(boundaries, ["formalProjectGenerationCalls", "formalProjectWriteCommands", "browserCalls", "uploads", "gitStage"], `${label}.boundaries`);
  exact(boundaries.restoredCopyWriteCommands, 1, `${label}.boundaries.restoredCopyWriteCommands`);
}

function assertInstalledSoak(file: EvidenceFile, release: ReleaseManifest): void {
  const value = file.value;
  const label = file.fileName;
  exact(value.schemaVersion, 1, `${label}.schemaVersion`);
  exact(value.kind, "p14-installed-application-endurance-smoke", `${label}.kind`);
  exact(value.status, "pass", `${label}.status`);
  assertReleaseIdentity(value, release, label, {
    version: "buildIdentity.version",
    sourceDigest: "buildIdentity.sourceDigest",
    buildId: "buildIdentity.buildId",
    buildIdentityFingerprint: "buildIdentity.fingerprint",
    releaseManifestFingerprint: "buildIdentity.releaseManifestFingerprint",
  });
  exact(child(value, "buildIdentity", label).source, "installed-app-resources-release-manifest", `${label}.buildIdentity.source`);
  const runtime = child(value, "runtime", label);
  exact(runtime.installed, true, `${label}.runtime.installed`);
  exact(runtime.systemNodeRequired, false, `${label}.runtime.systemNodeRequired`);
  const endurance = child(value, "endurance", label);
  finite(endurance.requestedMs, `${label}.endurance.requestedMs`, 1_800_000);
  finite(endurance.actualMs, `${label}.endurance.actualMs`, 1_800_000);
  if (array(endurance.samples, `${label}.endurance.samples`).length < 5) fail(`${label}.endurance.samples`, "稳定性样本少于 5");
  if (finite(endurance.stableTailRssDeltaKiB, `${label}.endurance.stableTailRssDeltaKiB`, -Infinity) > 128 * 1_024) {
    fail(`${label}.endurance.stableTailRssDeltaKiB`, "尾部 RSS 增长超过 128 MiB");
  }
  if (finite(endurance.stableTailFileDescriptorDelta, `${label}.endurance.stableTailFileDescriptorDelta`, -Infinity) > 64) {
    fail(`${label}.endurance.stableTailFileDescriptorDelta`, "尾部文件描述符增长超过 64");
  }
  exact(endurance.stableTailMediaRequests, true, `${label}.endurance.stableTailMediaRequests`);
  const projectSwitch = child(value, "projectSwitch", label);
  exact(projectSwitch.count, 10, `${label}.projectSwitch.count`);
  exact(projectSwitch.crossProjectLeak, false, `${label}.projectSwitch.crossProjectLeak`);
  const formalProject = child(value, "formalProject", label);
  exact(formalProject.writesBySmoke, 0, `${label}.formalProject.writesBySmoke`);
  exact(formalProject.stableFilesUnchanged, true, `${label}.formalProject.stableFilesUnchanged`);
  const snapshotBefore = record(formalProject.snapshotBefore, `${label}.formalProject.snapshotBefore`);
  const snapshotAfter = record(formalProject.snapshotAfter, `${label}.formalProject.snapshotAfter`);
  sha256(snapshotBefore.fingerprint, `${label}.formalProject.snapshotBefore.fingerprint`);
  exact(snapshotAfter.fingerprint, snapshotBefore.fingerprint, `${label}.formalProject.snapshotAfter.fingerprint`);
  exact(snapshotAfter.manifestFingerprint, snapshotBefore.manifestFingerprint, `${label}.formalProject.snapshotAfter.manifestFingerprint`);
  exact(snapshotAfter.stableFileCount, snapshotBefore.stableFileCount, `${label}.formalProject.snapshotAfter.stableFileCount`);
  const restart = child(value, "forceRestart", label);
  exact(restart.reopened, true, `${label}.forceRestart.reopened`);
  exact(restart.restoredProjectId, formalProject.projectId, `${label}.forceRestart.restoredProjectId`);
  const screenshot = child(value, "screenshot", label);
  integer(screenshot.width, `${label}.screenshot.width`, 1_400);
  integer(screenshot.height, `${label}.screenshot.height`, 800);
  integer(screenshot.sizeBytes, `${label}.screenshot.sizeBytes`, 40_000);
  const boundaries = child(value, "boundaries", label);
  allZero(boundaries, ["formalProjectGenerationCalls", "browserSupplierCalls", "uploads", "gitStage"], `${label}.boundaries`);
}

function evidenceSummary(file: EvidenceFile): { fileName: string; sizeBytes: number; sha256: string; gate: "PASS" } {
  return { fileName: file.fileName, sizeBytes: file.sizeBytes, sha256: file.sha256, gate: "PASS" };
}

export async function validateP11P14DesktopLoopFinal(
  options: P11P14FinalValidationOptions = {},
): Promise<{ outputPath: string; report: P11P14FinalValidationReport }> {
  const workspace = path.resolve(options.workspace ?? SCRIPT_WORKSPACE);
  const evidenceRoot = path.resolve(options.evidenceRoot ?? path.join(workspace, "docs", "evidence"));
  const outputPath = path.resolve(options.outputPath ?? path.join(evidenceRoot, P11_P14_FINAL_VALIDATION_FILE));
  if (path.dirname(outputPath) !== evidenceRoot || path.basename(outputPath) !== P11_P14_FINAL_VALIDATION_FILE) {
    fail("outputPath", `必须精确为 ${path.join(evidenceRoot, P11_P14_FINAL_VALIDATION_FILE)}`);
  }
  await access(outputPath).then(
    () => fail("outputPath", "旧 final-validation 已存在，拒绝覆盖或复用"),
    () => undefined,
  );
  await mkdir(evidenceRoot, { recursive: true });
  const release = await readReleaseManifest(path.join(workspace, "release-manifest.json"));
  const entries = await Promise.all(Object.entries(P11_P14_FINAL_EVIDENCE_FILES).map(async ([key, fileName]) => (
    [key, await readEvidenceFile(evidenceRoot, fileName)] as const
  )));
  const files = Object.fromEntries(entries) as Record<P11P14FinalEvidenceKey, EvidenceFile>;

  await assertCommandGate(files.typecheck, "typecheck", release, workspace);
  await assertCommandGate(files.targetedTests, "targeted", release, workspace);
  await assertCommandGate(files.fullTests, "full", release, workspace);
  await assertCommandGate(files.productionBuild, "production-build", release, workspace);
  assertIsolatedPackage(files.isolatedPackage, release);
  assertInstalledSignature(files.installedSignature, release);
  assertInstalledProductionLoop(files.installedProductionLoopUi, release);
  assertInstalledScale(files.installedScaleCanvasUi, release);
  assertInstalledAgentConnection(files.installedAgentConnectionUi, release);
  assertInstalledCanary(files.installedRealCanaryUi, release);
  assertDualAgentFreshSession(files.dualAgentFreshSessionRead, release);
  assertFormalBackupRestore(files.formalBackupRestore, release);
  assertInstalledSoak(files.installedSoak, release);

  const evidence = Object.fromEntries(Object.entries(files).map(([key, file]) => [key, evidenceSummary(file)])) as P11P14FinalValidationReport["evidence"];
  const semantic: Omit<P11P14FinalValidationReport, "fingerprint"> = {
    schemaVersion: 1,
    kind: "p11-p14-desktop-loop-final-validation",
    status: "PASS",
    generatedAt: new Date().toISOString(),
    release: {
      version: release.version,
      architecture: release.architecture,
      sourceDigest: release.sourceDigest,
      buildId: release.buildId,
      buildIdentityFingerprint: release.buildIdentityFingerprint,
      releaseManifestFingerprint: release.fingerprint,
      protocolVersion: release.protocolVersion,
      mcpToolCount: release.mcpToolCount,
      distribution: release.distribution,
    },
    evidence,
    assertions: {
      exactEvidenceSet: true,
      allGatesPassed: true,
      sameSourceDigest: true,
      sameBuildId: true,
      sameBuildIdentityFingerprint: true,
      sameReleaseManifestFingerprint: true,
      realInstalledApplication: true,
      realCodexCanaryReviewed: true,
      dualAgentFreshSessionsReadSameProject: true,
      formalBackupRestoreAndRestoredWritePassed: true,
      installedScaleAndEndurancePassed: true,
    },
    boundaries: {
      aggregationOnly: true,
      evidenceOverwritten: false,
      gitActions: 0,
      browserCalls: 0,
      uploads: 0,
      notarizationPerformed: false,
      distribution: "local-only",
    },
  };
  const report: P11P14FinalValidationReport = { ...semantic, fingerprint: digest(semantic) };
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  return { outputPath, report };
}

async function main(): Promise<void> {
  const result = await validateP11P14DesktopLoopFinal();
  process.stdout.write(`${JSON.stringify({
    ok: true,
    status: result.report.status,
    outputPath: result.outputPath,
    sourceDigest: result.report.release.sourceDigest,
    buildId: result.report.release.buildId,
    releaseManifestFingerprint: result.report.release.releaseManifestFingerprint,
    evidenceCount: Object.keys(result.report.evidence).length,
  }, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
