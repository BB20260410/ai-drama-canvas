import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  releaseManifestDigest,
  type ReleaseManifest,
} from "../src/core/release-manifest.js";
import { P13_P14_INSTALLED_UI_SCREENSHOTS } from "../scripts/p13-p14-installed-ui-smoke-guards.js";
import {
  P14_AGENT_REPAIR_SCREENSHOT,
  p14AgentRepairEvidenceDigest,
} from "../scripts/p14-installed-agent-repair-ui-smoke-guards.js";
import { P14_INSTALLED_REAL_CANARY_SCREENSHOTS } from "../scripts/p14-installed-real-canary-ui-guards.js";
import {
  P11_P14_FINAL_EVIDENCE_FILES,
  P11_P14_FINAL_VALIDATION_FILE,
  validateP11P14DesktopLoopFinal,
} from "../scripts/validate-p11-p14-desktop-loop-final.js";
import {
  fixedP11P14GateCommand,
  type P11P14CommandGateMode,
} from "../scripts/run-p11-p14-command-gate.js";

const roots: string[] = [];
const SOURCE_DIGEST = "a".repeat(64);
const BUILD_ID = "b".repeat(32);
const BUILD_FINGERPRINT = "c".repeat(64);
const MANIFEST_FINGERPRINT_INPUT = "d".repeat(64);
const PROJECT_ID = "formal-project";
const MCP_TOOL_COUNT = 183;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([key, entry]) => [key, stableValue(entry)]));
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stableValue(value)), "utf8").digest("hex");
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function releaseManifest(): ReleaseManifest {
  const body = {
    schemaVersion: 1 as const,
    kind: "ai-drama-canvas-release-manifest" as const,
    version: "0.2.0",
    architecture: "arm64" as const,
    sourceDigest: SOURCE_DIGEST,
    buildId: BUILD_ID,
    buildIdentityFingerprint: BUILD_FINGERPRINT,
    protocolVersion: "1.1",
    mcpToolCount: MCP_TOOL_COUNT,
    builtAt: "2026-07-18T12:00:00.000Z",
    distribution: "local-only" as const,
    localOnly: true as const,
    source: { files: 450, bytes: 10_000_000 },
  };
  return { ...body, fingerprint: releaseManifestDigest(body) };
}

function releaseFields(manifest: ReleaseManifest) {
  return {
    version: manifest.version,
    sourceDigest: manifest.sourceDigest,
    buildId: manifest.buildId,
    mcpToolCount: manifest.mcpToolCount,
    distribution: manifest.distribution,
  };
}

async function commandGate(
  workspace: string,
  evidenceRoot: string,
  mode: P11P14CommandGateMode,
  fileName: string,
  manifest: ReleaseManifest,
): Promise<void> {
  const command = fixedP11P14GateCommand(mode);
  const logBytes = Buffer.from(`${mode} passed\n`, "utf8");
  const logPath = path.join(evidenceRoot, "runs", `${mode}.log`);
  await mkdir(path.dirname(logPath), { recursive: true });
  await writeFile(logPath, logBytes);
  const testCounts = command.expectsTestCounts
    ? { applicable: true, files: { total: 2, passed: 2, failed: 0 }, tests: { total: 8, passed: 8, failed: 0 } }
    : { applicable: false, files: null, tests: null };
  await writeJson(path.join(evidenceRoot, fileName), {
    schemaVersion: 1,
    kind: "p11-p14-command-gate-record",
    status: "PASS",
    mode,
    startedAt: "2026-07-18T12:00:00.000Z",
    endedAt: "2026-07-18T12:00:01.000Z",
    durationMs: 1_000,
    argv: [command.command, ...command.args],
    cwd: workspace,
    exitCode: 0,
    sourceStable: true,
    failureReasons: [],
    sourceDigest: { before: manifest.sourceDigest, after: manifest.sourceDigest, beforeFiles: 450, afterFiles: 450 },
    buildIdentity: {
      before: { buildId: manifest.buildId, sourceDigest: manifest.sourceDigest, fingerprint: manifest.buildIdentityFingerprint },
      after: { buildId: manifest.buildId, sourceDigest: manifest.sourceDigest, fingerprint: manifest.buildIdentityFingerprint },
    },
    testCounts,
    log: {
      relativePath: path.relative(workspace, logPath).split(path.sep).join("/"),
      sizeBytes: logBytes.byteLength,
      sha256: createHash("sha256").update(logBytes).digest("hex"),
    },
    security: { environmentRecorded: false, childEnvironmentAllowlisted: true },
  });
}

function screenshot(fileName: string, sha = "e".repeat(64)) {
  return {
    fileName,
    path: path.join("/tmp/p11-p14-final-shots", fileName),
    width: 1_728,
    height: 1_029,
    sizeBytes: 50_000,
    sha256: sha,
    maxChannelStandardDeviation: 8,
  };
}

function freshSessionResult(client: "codex" | "grok", manifest: ReleaseManifest) {
  return {
    schemaVersion: 1,
    marker: "AI_DRAMA_CANVAS_FRESH_SESSION_READ_V1",
    client,
    toolCalls: ["get_capabilities", "get_active_managed_studio_context"],
    capabilities: {
      serverName: "ai-drama-canvas",
      buildId: manifest.buildId,
      sourceDigest: manifest.sourceDigest,
      toolCount: manifest.mcpToolCount,
      buildIdentityFingerprint: manifest.buildIdentityFingerprint,
    },
    activeContext: {
      projectId: PROJECT_ID,
      manifestFingerprint: MANIFEST_FINGERPRINT_INPUT,
      contextFingerprint: "f".repeat(64),
      sourceDigest: manifest.sourceDigest,
      lockedAssets: [],
      nextAction: { code: "ready", label: "继续", reason: "ready", requiresWrite: false, command: null },
      promptEntry: "managed_studio_lock_generate_writeback",
    },
    safety: { projectRootArgumentSupplied: false, secretsReadOrPrinted: false },
  };
}

function nativeTrace(client: "codex" | "grok") {
  return {
    client,
    format: client === "codex" ? "codex-jsonl" : "grok-streaming-json",
    verifiable: true,
    exactToolSequence: true,
    jsonEventCount: 4,
    toolCalls: ["get_capabilities", "get_active_managed_studio_context"].map((toolName) => ({
      serverName: "ai-drama-canvas",
      toolName,
      argumentsEmpty: true,
      completed: true,
      succeeded: true,
    })),
    traceSha256: "1".repeat(64),
  };
}

async function createFixture(): Promise<{ workspace: string; evidenceRoot: string; manifest: ReleaseManifest }> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "p11-p14-final-validator-"));
  roots.push(workspace);
  const evidenceRoot = path.join(workspace, "docs", "evidence");
  await mkdir(evidenceRoot, { recursive: true });
  const manifest = releaseManifest();
  await writeJson(path.join(workspace, "release-manifest.json"), manifest);
  await commandGate(workspace, evidenceRoot, "typecheck", P11_P14_FINAL_EVIDENCE_FILES.typecheck, manifest);
  await commandGate(workspace, evidenceRoot, "targeted", P11_P14_FINAL_EVIDENCE_FILES.targetedTests, manifest);
  await commandGate(workspace, evidenceRoot, "full", P11_P14_FINAL_EVIDENCE_FILES.fullTests, manifest);
  await commandGate(workspace, evidenceRoot, "production-build", P11_P14_FINAL_EVIDENCE_FILES.productionBuild, manifest);

  await writeJson(path.join(evidenceRoot, P11_P14_FINAL_EVIDENCE_FILES.isolatedPackage), {
    schemaVersion: 1,
    status: "passed",
    scope: "current-source-isolated-unpacked-app-validation",
    authorizationBoundary: {
      formalProjectUsed: false,
      externalWebsiteUsed: false,
      uploadUsed: false,
      paidActionUsed: false,
      installed: false,
      published: false,
      dmgGenerated: false,
      developerIdSigningRequested: false,
      notarizationRequested: false,
      workspaceDistOverwritten: false,
      closesRealProjectNleValidation: false,
    },
    package: { releaseManifest: manifest, stageMcpCapabilities: { toolCount: manifest.mcpToolCount } },
    packagedMcp: { toolCount: manifest.mcpToolCount },
    protectedWorkspaceArtifacts: { unchanged: true },
    terminal: {
      tempRootRemoved: true,
      lingeringProcessesAfterCleanup: [],
      emptyProjectRemoved: true,
      emptyProjectRegistryRemoved: true,
      effectTransitionRegistryRemoved: true,
      packagedRegistryRemoved: true,
      packagedMediaRuntimeRemoved: true,
      packagedProjectRootRemoved: true,
      packagedReviewProjectRemoved: true,
      packagedReviewRegistryRemoved: true,
      packagedReviewUserDataRemoved: true,
    },
  });

  await writeJson(path.join(evidenceRoot, P11_P14_FINAL_EVIDENCE_FILES.installedSignature), {
    schemaVersion: 1,
    kind: "p14-installed-signature-evidence",
    status: "pass",
    release: {
      version: manifest.version,
      sourceDigest: manifest.sourceDigest,
      buildId: manifest.buildId,
      releaseManifestFingerprint: manifest.fingerprint,
      mcpToolCount: manifest.mcpToolCount,
    },
    bundle: { identifier: "com.hxx.aidramacanvas", version: manifest.version, name: "AI 漫剧画布", architecture: manifest.architecture },
    signing: {
      verified: true,
      deepStrict: true,
      identityCommonName: "Developer ID Application: YIHANG LI (3JS43BTTJ3)",
      teamIdentifier: "3JS43BTTJ3",
    },
    installation: {
      path: "/Applications/AI 漫剧画布.app",
      launchWithoutSystemNode: true,
      packagedMcpStartedWithAppElectronRuntime: true,
      actualMcpToolCount: manifest.mcpToolCount,
    },
    distribution: "local-only",
    notarization: { performed: false },
    boundaries: { systemNodeRequired: false, uploaded: false, published: false, autoUpdateConfigured: false },
  });

  const productionAssertions = Object.fromEntries([
    "firstRunThreeEntriesVisible", "firstRunRecentDisabledWithoutExplicitActiveProject", "importEntryCanceledWithoutMutation",
    "projectCreatedThroughUi", "backupCompletedThroughUi", "restoreCompletedThroughUiToNewDirectory",
    "restartRestoredExplicitActiveProject", "projectSwitchIsolated", "fiveStepNavigation",
    "materialLibraryCharacterSceneProp", "scriptAndPromptVisible", "generationPaneVisible", "managedCanvasVisible",
    "rawLabeledReviewNodesVisible", "oneClickResultNodeOpenedReview", "agentConnectionStatusVisible", "helpAndBackupRestoreEntriesVisible",
  ].map((key) => [key, true]));
  await writeJson(path.join(evidenceRoot, P11_P14_FINAL_EVIDENCE_FILES.installedProductionLoopUi), {
    schemaVersion: 1,
    kind: "p13-p14-installed-production-loop-ui-smoke",
    status: "pass",
    runtime: {
      executablePath: "/Applications/AI 漫剧画布.app/Contents/MacOS/AI 漫剧画布",
      installedBundle: true,
      systemNodeRequired: false,
      release: releaseFields(manifest),
    },
    assertions: productionAssertions,
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
    screenshots: P13_P14_INSTALLED_UI_SCREENSHOTS.map((name) => screenshot(name)),
    terminal: { applicationClosed: true, runtimeRootRemoved: true, fixtureRootRemoved: true },
  });

  await writeJson(path.join(evidenceRoot, P11_P14_FINAL_EVIDENCE_FILES.installedScaleCanvasUi), {
    schemaVersion: 2,
    kind: "managed-studio-scale-canvas-ui-smoke",
    status: "pass",
    buildIdentity: {
      version: manifest.version,
      sourceDigest: manifest.sourceDigest,
      buildId: manifest.buildId,
      fingerprint: manifest.buildIdentityFingerprint,
      releaseManifestFingerprint: manifest.fingerprint,
      source: "installed-app-resources-release-manifest",
    },
    fixture: { large: { units: 1_288, panels: 4_235, assets: 77, media: { total: 10_000, verifiedCas: 10_000, verifiedThumbnails: 1_000 } } },
    startup: { pageErrors: 0, consoleErrors: 0, externalRequests: 0 },
    runtime: { kind: "installed-application", systemNodeRequired: false },
    canvas: {
      logicalPageLimit: 36,
      assetPageLimit: 6,
      unitPageLimit: 36,
      panelExpansionLimit: 6,
      pipelineNodeLimit: 18,
      maximumDomNodes: 74,
      initialDom: 42,
      expandedDom: 48,
      pipelineDom: 18,
      unitPageReplaced: true,
      assetPageReplaced: true,
      viewportCullingEnabled: true,
      panelExpansionBound: 6,
    },
    mediaLibrary: { exactCount: 10_000, firstPageDom: 36, scrolledDom: 36, secondPageDom: 36, keysetPageReplaced: true, previousPageRestored: true },
    projectSwitch: { largeToSmall: true, smallToLarge: true, crossProjectLeak: false },
    screenshot: { sizeBytes: 50_000, sha256: "2".repeat(64), width: 1_728, height: 1_029, stdev: 8 },
    boundaries: { filesystemScans: 0, formalStudioTouched: false, formalImageGenerationCalls: 0, browserSupplierCalls: 0, uploads: 0, gitStage: 0 },
  });

  const projectSnapshot = { files: 20, bytes: 50_000, aggregateSha256: "3".repeat(64) };
  const agentRepairBody = {
    schemaVersion: 1,
    kind: "p14-installed-agent-repair-ui-smoke",
    status: "PASS",
    runtime: {
      installedBundle: true,
      localOnly: true,
      executablePathSha256: "4".repeat(64),
      sourceDigest: manifest.sourceDigest,
      buildId: manifest.buildId,
      mcpToolCount: manifest.mcpToolCount,
    },
    project: {
      projectRootPathSha256: "5".repeat(64),
      managed: true,
      explicitActiveProject: true,
      defaultRegistry: true,
      before: projectSnapshot,
      after: projectSnapshot,
      unchanged: true,
    },
    agents: {
      repairButtonClicked: true,
      repairIpcCompletedAfterGrokDoctor: true,
      codexCurrent: true,
      grokCurrent: true,
      codexConfiguredRuntimeStarted: true,
      codexRuntimeToolCount: manifest.mcpToolCount,
    },
    backup: {
      newDirectoryCount: 1,
      directoryPathSha256: "6".repeat(64),
      directoryMode: "0700",
      files: [
        { role: "codex-config", originalState: "present", sha256: "7".repeat(64), mode: "0600", matchesPreRepairSnapshot: true },
        { role: "grok-config", originalState: "missing", sha256: "8".repeat(64), mode: "0600", matchesPreRepairSnapshot: true },
      ],
      preserved: true,
    },
    repairedConfigs: {
      codex: { state: "present", sha256: "9".repeat(64), mode: "0600" },
      grok: { state: "present", sha256: "0".repeat(64), mode: "0600" },
    },
    ui: {
      screenshot: {
        fileName: P14_AGENT_REPAIR_SCREENSHOT,
        sha256: "1".repeat(64),
        width: 1_728,
        height: 1_029,
        sizeBytes: 50_000,
        maxChannelStandardDeviation: 8,
      },
      pageErrorCount: 0,
      consoleErrorCount: 0,
      externalRequestCount: 0,
      highEntropyValueCount: 0,
    },
    boundaries: {
      realHome: true,
      isolatedUserData: true,
      noProjectWrites: true,
      noConfigContentsInEvidence: true,
      noSecretEnvironmentForwardedToMcpProbe: true,
      failureKeepsBackup: true,
    },
  };
  await writeJson(path.join(evidenceRoot, P11_P14_FINAL_EVIDENCE_FILES.installedAgentConnectionUi), {
    ...agentRepairBody,
    fingerprint: p14AgentRepairEvidenceDigest(agentRepairBody),
  });

  const canaryAssertions = Object.fromEntries([
    "stateFingerprintValidated", "pendingReviewPhaseValidated", "projectManifestMatched", "activeRegistryProjectMatched",
    "installedBuildMatchedCanary", "realAuthorityReferencesValidated", "authoritySourcesUnchanged", "primaryAuthoritiesCurrent",
    "packReferencesMatched", "continuityReferencesMatched", "fixtureAuthoritiesExcluded", "goldenMaskDefinitionLocked",
    "rawDecoded", "labeledDecoded", "rawAndLabeledVisible", "canvasResultNodesVisible",
    "oneClickOpenedReview", "decisionSubmittedThroughUiOwner", "explicitCliDecisionRecorded", "reviewHeadMatchedDecision",
    "reviewPersistedAfterRestart",
  ].map((key) => [key, true]));
  await writeJson(path.join(evidenceRoot, P11_P14_FINAL_EVIDENCE_FILES.installedRealCanaryUi), {
    schemaVersion: 1,
    kind: "p14-installed-real-canary-review-ui-smoke",
    status: "pass",
    decision: "pass",
    authority: { actor: "main-agent", source: "explicit-cli-decision", userConfirmationClaimed: false, visualQualityInferredByScript: false },
    runtime: { release: releaseFields(manifest) },
    assertions: canaryAssertions,
    isolation: { canaryProjectOnly: true, formalProjectOpened: false, formalProjectWrites: 0, externalRequests: 0, agentRepairClicks: 0, imageGenerationCalls: 0 },
    screenshots: P14_INSTALLED_REAL_CANARY_SCREENSHOTS.map((name) => screenshot(name, "3".repeat(64))),
    terminal: { applicationClosed: true, temporaryRuntimeRemoved: true, reviewPersistedAfterRestart: true },
    boundaries: {
      imageGeneratedByScript: false,
      fixtureCreatedByScript: false,
      userPersonallyClickedClaimed: false,
      mechanicalDecodeEqualsVisualApproval: false,
      agentConfigurationMutated: false,
      browserUsed: false,
      uploads: 0,
      gitActions: 0,
    },
  });

  const dualSemantic = {
    schemaVersion: 1,
    kind: "p14-dual-agent-fresh-session-read-evidence",
    status: "PASS",
    startedAt: "2026-07-18T12:00:00.000Z",
    completedAt: "2026-07-18T12:00:01.000Z",
    expected: { projectId: PROJECT_ID, manifestFingerprint: MANIFEST_FINGERPRINT_INPUT, sourceDigest: manifest.sourceDigest },
    clients: {
      codex: { executable: "codex", help: { supported: true }, sessionStarted: true, nativeTrace: nativeTrace("codex") },
      grok: { executable: "grok", help: { supported: true }, sessionStarted: true, nativeTrace: nativeTrace("grok") },
    },
    results: { codex: freshSessionResult("codex", manifest), grok: freshSessionResult("grok", manifest) },
    comparisons: {
      expectedIdentity: true,
      sameBuildIdentity: true,
      sameContextFingerprint: true,
      sameLockedAssets: true,
      sameNextAction: true,
      samePromptEntry: true,
      exactToolSequence: true,
    },
    boundaries: {
      execFileWithoutShell: true,
      freshSessions: true,
      projectRootAcceptedByScript: false,
      projectRootArgumentSupplied: false,
      agentConfigurationModified: false,
      secretEnvironmentVariablesForwarded: false,
      secretsReadOrPrinted: false,
    },
  };
  await writeJson(path.join(evidenceRoot, P11_P14_FINAL_EVIDENCE_FILES.dualAgentFreshSessionRead), {
    ...dualSemantic,
    fingerprint: digest(dualSemantic),
  });

  await writeJson(path.join(evidenceRoot, P11_P14_FINAL_EVIDENCE_FILES.formalBackupRestore), {
    schemaVersion: 1,
    kind: "p14-formal-project-backup-restore-validation",
    status: "pass",
    buildIdentity: { sourceDigest: manifest.sourceDigest, buildId: manifest.buildId },
    source: {
      projectId: PROJECT_ID,
      manifestFingerprint: MANIFEST_FINGERPRINT_INPUT,
      mediaInventory: { image: 12, video: 0, audio: 0 },
      writeCommandsByThisRun: 0,
    },
    backup: { schemaVersion: 2, fileCount: 100, aggregateSha256: "4".repeat(64), manifestSha256: "5".repeat(64) },
    restore: {
      overwriteSource: false,
      projectIdPreserved: true,
      sqliteIntegrity: [{ relativePath: "project/.aicanvas/studio.sqlite", result: "ok" }],
      mediaInventory: { image: 12, video: 0, audio: 0 },
      mediaSamples: { images: [{ sha256: "6".repeat(64) }], videos: [], audio: [] },
      safeWrite: { command: "create_studio_prompt_document", status: "succeeded" },
    },
    boundaries: {
      formalProjectGenerationCalls: 0,
      formalProjectWriteCommands: 0,
      restoredCopyWriteCommands: 1,
      browserCalls: 0,
      uploads: 0,
      gitStage: 0,
    },
  });

  await writeJson(path.join(evidenceRoot, P11_P14_FINAL_EVIDENCE_FILES.installedSoak), {
    schemaVersion: 1,
    kind: "p14-installed-application-endurance-smoke",
    status: "pass",
    buildIdentity: {
      version: manifest.version,
      sourceDigest: manifest.sourceDigest,
      buildId: manifest.buildId,
      fingerprint: manifest.buildIdentityFingerprint,
      releaseManifestFingerprint: manifest.fingerprint,
      source: "installed-app-resources-release-manifest",
    },
    runtime: { installed: true, systemNodeRequired: false },
    formalProject: {
      projectId: PROJECT_ID,
      writesBySmoke: 0,
      stableFilesUnchanged: true,
      snapshotBefore: { manifestFingerprint: MANIFEST_FINGERPRINT_INPUT, stableFileCount: 12, fingerprint: "9".repeat(64) },
      snapshotAfter: { manifestFingerprint: MANIFEST_FINGERPRINT_INPUT, stableFileCount: 12, fingerprint: "9".repeat(64) },
    },
    endurance: {
      requestedMs: 1_800_000,
      actualMs: 1_800_001,
      samples: Array.from({ length: 5 }, (_, index) => ({ index })),
      stableTailRssDeltaKiB: 1_024,
      stableTailFileDescriptorDelta: 1,
      stableTailMediaRequests: true,
    },
    projectSwitch: { count: 10, crossProjectLeak: false },
    forceRestart: { reopened: true, restoredProjectId: PROJECT_ID },
    screenshot: { width: 1_728, height: 1_029, sizeBytes: 50_000 },
    boundaries: { formalProjectGenerationCalls: 0, browserSupplierCalls: 0, uploads: 0, gitStage: 0 },
  });
  return { workspace, evidenceRoot, manifest };
}

describe("P11–P14 最终证据聚合器", () => {
  it("只在 13 个冻结证据全部通过且绑定同一 release identity 时独占写入 PASS", async () => {
    const fixture = await createFixture();
    const result = await validateP11P14DesktopLoopFinal(fixture);
    expect(result.report.status).toBe("PASS");
    expect(Object.keys(result.report.evidence)).toHaveLength(13);
    expect(result.report.release).toMatchObject({
      sourceDigest: fixture.manifest.sourceDigest,
      buildId: fixture.manifest.buildId,
      releaseManifestFingerprint: fixture.manifest.fingerprint,
    });
    const persisted = JSON.parse(await readFile(result.outputPath, "utf8")) as Record<string, unknown>;
    expect(persisted.fingerprint).toBe(result.report.fingerprint);
  });

  it("旧 final-validation 即使内容相同也拒绝覆盖或复用", async () => {
    const fixture = await createFixture();
    const outputPath = path.join(fixture.evidenceRoot, P11_P14_FINAL_VALIDATION_FILE);
    await writeJson(outputPath, { status: "PASS", stale: true });
    await expect(validateP11P14DesktopLoopFinal(fixture)).rejects.toThrow(/旧 final-validation 已存在/);
  });

  it("任一证据 sourceDigest/buildId 漂移即失败关闭且不生成 final", async () => {
    const fixture = await createFixture();
    const target = path.join(fixture.evidenceRoot, P11_P14_FINAL_EVIDENCE_FILES.installedScaleCanvasUi);
    const value = JSON.parse(await readFile(target, "utf8")) as Record<string, unknown>;
    const identity = value.buildIdentity as Record<string, unknown>;
    identity.sourceDigest = "9".repeat(64);
    await writeJson(target, value);
    await expect(validateP11P14DesktopLoopFinal(fixture)).rejects.toThrow(/buildIdentity\.sourceDigest/);
    await expect(readFile(path.join(fixture.evidenceRoot, P11_P14_FINAL_VALIDATION_FILE), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("隔离包 buildIdentityFingerprint 漂移时即使 manifest 自洽也失败关闭", async () => {
    const fixture = await createFixture();
    const target = path.join(fixture.evidenceRoot, P11_P14_FINAL_EVIDENCE_FILES.isolatedPackage);
    const value = JSON.parse(await readFile(target, "utf8")) as Record<string, any>;
    const packagedManifest = value.package.releaseManifest as ReleaseManifest;
    packagedManifest.buildIdentityFingerprint = "9".repeat(64);
    const { fingerprint: _fingerprint, ...body } = packagedManifest;
    packagedManifest.fingerprint = releaseManifestDigest(body);
    await writeJson(target, value);
    await expect(validateP11P14DesktopLoopFinal(fixture)).rejects.toThrow(/buildIdentityFingerprint/);
    await expect(readFile(path.join(fixture.evidenceRoot, P11_P14_FINAL_VALIDATION_FILE), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("测试失败、短时 soak 或双 Agent 非精确原生调用均不能冒充终态", async () => {
    const fixture = await createFixture();
    const testPath = path.join(fixture.evidenceRoot, P11_P14_FINAL_EVIDENCE_FILES.fullTests);
    const failedTest = JSON.parse(await readFile(testPath, "utf8")) as Record<string, unknown>;
    failedTest.status = "FAIL";
    await writeJson(testPath, failedTest);
    await expect(validateP11P14DesktopLoopFinal(fixture)).rejects.toThrow(/status/);

    const second = await createFixture();
    const soakPath = path.join(second.evidenceRoot, P11_P14_FINAL_EVIDENCE_FILES.installedSoak);
    const shortSoak = JSON.parse(await readFile(soakPath, "utf8")) as Record<string, unknown>;
    (shortSoak.endurance as Record<string, unknown>).actualMs = 60_000;
    await writeJson(soakPath, shortSoak);
    await expect(validateP11P14DesktopLoopFinal(second)).rejects.toThrow(/actualMs/);

    const third = await createFixture();
    const dualPath = path.join(third.evidenceRoot, P11_P14_FINAL_EVIDENCE_FILES.dualAgentFreshSessionRead);
    const dual = JSON.parse(await readFile(dualPath, "utf8")) as Record<string, unknown>;
    const clients = dual.clients as Record<string, Record<string, unknown>>;
    ((clients.codex?.nativeTrace as Record<string, unknown>) ?? {}).exactToolSequence = false;
    const { fingerprint: _fingerprint, ...semantic } = dual;
    await writeJson(dualPath, { ...semantic, fingerprint: digest(semantic) });
    await expect(validateP11P14DesktopLoopFinal(third)).rejects.toThrow(/exactToolSequence/);

    const fourth = await createFixture();
    const fourthSoakPath = path.join(fourth.evidenceRoot, P11_P14_FINAL_EVIDENCE_FILES.installedSoak);
    const driftingSoak = JSON.parse(await readFile(fourthSoakPath, "utf8")) as Record<string, any>;
    driftingSoak.formalProject.snapshotAfter.fingerprint = "8".repeat(64);
    await writeJson(fourthSoakPath, driftingSoak);
    await expect(validateP11P14DesktopLoopFinal(fourth)).rejects.toThrow(/snapshotAfter\.fingerprint/);
  });

  it("正式工程媒体抽样按真实分类库存验收，不要求不存在的音视频", async () => {
    const valid = await createFixture();
    await expect(validateP11P14DesktopLoopFinal(valid)).resolves.toBeTruthy();

    const missingImage = await createFixture();
    const evidencePath = path.join(missingImage.evidenceRoot, P11_P14_FINAL_EVIDENCE_FILES.formalBackupRestore);
    const evidence = JSON.parse(await readFile(evidencePath, "utf8")) as Record<string, any>;
    evidence.restore.mediaSamples.images = [];
    await writeJson(evidencePath, evidence);
    await expect(validateP11P14DesktopLoopFinal(missingImage)).rejects.toThrow(/库存非零但缺少解码抽样/);

    const inventedVideo = await createFixture();
    const inventedPath = path.join(inventedVideo.evidenceRoot, P11_P14_FINAL_EVIDENCE_FILES.formalBackupRestore);
    const invented = JSON.parse(await readFile(inventedPath, "utf8")) as Record<string, any>;
    invented.restore.mediaSamples.videos = [{ sha256: "7".repeat(64) }];
    await writeJson(inventedPath, invented);
    await expect(validateP11P14DesktopLoopFinal(inventedVideo)).rejects.toThrow(/库存为零却出现伪造抽样/);
  });
});
