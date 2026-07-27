import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "@vue/compiler-sfc";
import { describe, expect, it } from "vitest";
import {
  assertP14CanaryOutputsOutsideRun,
  assertP14InstalledRealCanaryUiEvidence,
  assertP14PendingRealCanaryState,
  P14_INSTALLED_REAL_CANARY_SCREENSHOTS,
  p14CanaryStateDigest,
  parseP14InstalledRealCanaryUiCli,
  type P14InstalledRealCanaryUiEvidence,
} from "../scripts/p14-installed-real-canary-ui-guards.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const formalRoot = path.join(root, "projects", "codex-ai-drama-studio");

function pendingState(): Record<string, unknown> {
  const runRoot = "/tmp/p14-real-canary/run";
  const rawSha256 = "d".repeat(64);
  const executionReceipt = {
    schemaVersion: 1,
    kind: "agent-imagegen-execution-receipt",
    provider: "codex",
    source: "codex-imagegen",
    attestationLevel: "agent-session-direct",
    cryptographicProviderReceipt: false,
    callId: "call_codex_imagegen_0001",
    model: "gpt-image-1",
    generatedAt: "2026-07-18T00:00:01.000Z",
  };
  const bundleFingerprint = "1".repeat(64);
  const semantic = {
    schemaVersion: 1,
    kind: "p14-real-canary-orchestration-state",
    phase: "writeback-pending-review",
    createdAt: "2026-07-18T00:00:00.000Z",
    updatedAt: "2026-07-18T00:00:01.000Z",
    runRoot,
    registryPath: path.join(runRoot, "registry", "projects.json"),
    workspaceRoot: root,
    project: { root: path.join(runRoot, "project"), id: "canary", manifestFingerprint: "a".repeat(64) },
    target: { unitId: "unit", unitRevision: 1, panelId: "panel", panelIndex: 1, panelCount: 2, durationSeconds: 15, assetIds: [] },
    ambiguity: {},
    continuityFingerprint: "b".repeat(64),
    pack: { id: "pack", fingerprint: "c".repeat(64) },
    dispatch: { provider: "codex" },
    generationRunId: "run",
    provider: "codex",
    authorityReferences: {
      mode: "real-user-assets",
      assets: ["character-ahang", "prop-complete-golden-mask", "scene-stone-room"].map((assetId, index) => ({
        assetId,
        sourcePath: path.join(runRoot, `reference-${index + 1}.png`),
        sourceBasename: `reference-${index + 1}.png`,
        sourceSha256: String(index + 4).repeat(64),
        importedSha256: String(index + 4).repeat(64),
        width: 1_024,
        height: 1_024,
        sizeBytes: 100_000,
        sourceMtimeMs: 1_721_260_800_000 + index,
        entropy: 4.5,
        sourceUnchanged: true,
        authorityVersionId: `version-${index + 1}`,
      })),
    },
    requestEnvelopePath: path.join(runRoot, "imagegen-request-envelope.json"),
    prepareEvidencePath: path.join(runRoot, "prepare-evidence.json"),
    finalization: {
      rawPath: path.join(runRoot, "generated.png"),
      rawSha256,
      executionReceipt,
      bundle: {
        schemaVersion: 4,
        provider: "codex",
        status: "pending-review",
        pairComplete: true,
        raw: { mediaSha256: rawSha256 },
        labeled: { mediaSha256: "e".repeat(64) },
        fingerprint: bundleFingerprint,
      },
      writebackAudit: {
        schemaVersion: 1,
        kind: "p14-agent-imagegen-writeback-audit",
        executionReceiptFingerprint: p14CanaryStateDigest(executionReceipt),
        writebackReceiptFingerprint: "2".repeat(64),
        outcomeFingerprint: "3".repeat(64),
        resultBundleFingerprint: bundleFingerprint,
      },
      evidencePath: path.join(runRoot, "finalize-evidence.json"),
    },
  };
  return { ...semantic, fingerprint: p14CanaryStateDigest(semantic) };
}

function validEvidence(): P14InstalledRealCanaryUiEvidence {
  const assertions = Object.fromEntries([
    "stateFingerprintValidated", "pendingReviewPhaseValidated", "projectManifestMatched",
    "activeRegistryProjectMatched", "installedBuildMatchedCanary", "realAuthorityReferencesValidated", "rawDecoded", "labeledDecoded",
    "authoritySourcesUnchanged", "primaryAuthoritiesCurrent", "packReferencesMatched", "continuityReferencesMatched",
    "fixtureAuthoritiesExcluded", "goldenMaskDefinitionLocked",
    "rawAndLabeledVisible", "canvasResultNodesVisible", "oneClickOpenedReview",
    "decisionSubmittedThroughUiOwner", "explicitCliDecisionRecorded", "reviewHeadMatchedDecision",
    "reviewPersistedAfterRestart",
  ].map((key) => [key, true]));
  return {
    schemaVersion: 1,
    kind: "p14-installed-real-canary-review-ui-smoke",
    status: "pass",
    decision: "pass",
    authority: { actor: "main-agent", source: "explicit-cli-decision", userConfirmationClaimed: false, visualQualityInferredByScript: false },
    assertions,
    isolation: { canaryProjectOnly: true, formalProjectOpened: false, formalProjectWrites: 0, externalRequests: 0, agentRepairClicks: 0, imageGenerationCalls: 0 },
    screenshots: P14_INSTALLED_REAL_CANARY_SCREENSHOTS.map((fileName) => ({
      fileName,
      path: path.join("/tmp/p14-real-canary-screenshots", fileName),
      width: 1_728,
      height: 1_029,
      sizeBytes: 20_001,
      sha256: "f".repeat(64),
      maxChannelStandardDeviation: 3.1,
    })),
    terminal: { applicationClosed: true, temporaryRuntimeRemoved: true, reviewPersistedAfterRestart: true },
  };
}

describe("P14 安装版真实 canary UI 审片失败关闭门禁", () => {
  it("只接受安装版、pending state、隔离输出与显式 decision", () => {
    const argv = [
      "/Applications/AI 漫剧画布.app/Contents/MacOS/AI 漫剧画布",
      "/tmp/p14-real-canary/run/canary-state.json",
      "/tmp/p14-real-canary-ui.json",
      "/tmp/p14-real-canary-screenshots",
      "rework",
    ];
    expect(parseP14InstalledRealCanaryUiCli(argv).decision).toBe("rework");
    expect(() => parseP14InstalledRealCanaryUiCli(argv.slice(0, 4))).toThrow(/用法/);
    expect(() => parseP14InstalledRealCanaryUiCli([...argv.slice(0, 4), "approve"])).toThrow(/pass\|rework\|reject/);
    expect(() => parseP14InstalledRealCanaryUiCli(["/usr/bin/electron", ...argv.slice(1)])).toThrow(/\.app\/Contents\/MacOS/);

    const state = pendingState();
    expect(() => assertP14PendingRealCanaryState(state, argv[1]!, formalRoot)).not.toThrow();
    expect(() => assertP14CanaryOutputsOutsideRun(state as never, argv[2]!, argv[3]!, formalRoot)).not.toThrow();
    expect(() => assertP14CanaryOutputsOutsideRun(state as never, path.join(formalRoot, "evidence.json"), argv[3]!, formalRoot)).toThrow(/正式工程/);
  });

  it("拒绝 phase、fingerprint 与工程边界漂移", () => {
    const state = pendingState();
    expect(() => assertP14PendingRealCanaryState({ ...state, phase: "reviewed" }, "/tmp/p14-real-canary/run/canary-state.json", formalRoot)).toThrow(/phase/);
    expect(() => assertP14PendingRealCanaryState({ ...state, fingerprint: "0".repeat(64) }, "/tmp/p14-real-canary/run/canary-state.json", formalRoot)).toThrow(/fingerprint/);
    const project = { ...(state.project as Record<string, unknown>), root: formalRoot };
    const { fingerprint: _fingerprint, ...semantic } = { ...state, project } as Record<string, unknown>;
    const overlapped = { ...semantic, fingerprint: p14CanaryStateDigest(semantic) };
    expect(() => assertP14PendingRealCanaryState(overlapped, "/tmp/p14-real-canary/run/canary-state.json", formalRoot)).toThrow(/formal-project-overlap/);
  });

  it("真实 canary 拒绝 fixture 与 self-reported receipt，只接受当前 Codex imagegen 直接调用回执", () => {
    const state = pendingState();
    const statePath = "/tmp/p14-real-canary/run/canary-state.json";
    const replaceReceipt = (receiptPatch: Record<string, unknown>) => {
      const finalization = state.finalization as Record<string, unknown>;
      const receipt = { ...(finalization.executionReceipt as Record<string, unknown>), ...receiptPatch };
      const writebackAudit = {
        ...(finalization.writebackAudit as Record<string, unknown>),
        executionReceiptFingerprint: p14CanaryStateDigest(receipt),
      };
      const { fingerprint: _fingerprint, ...semantic } = {
        ...state,
        finalization: { ...finalization, executionReceipt: receipt, writebackAudit },
      } as Record<string, unknown>;
      return { ...semantic, fingerprint: p14CanaryStateDigest(semantic) };
    };
    expect(() => assertP14PendingRealCanaryState(replaceReceipt({
      source: "fixture-canary",
      attestationLevel: "unverified-external-agent",
      callId: "fixture-call-0001",
      model: "fixture-imagegen",
    }), statePath, formalRoot)).toThrow(/auditable-codex-imagegen-execution-receipt/);
    expect(() => assertP14PendingRealCanaryState(replaceReceipt({
      source: "codex-imagegen",
      attestationLevel: "unverified-external-agent",
      callId: "self-reported-call-0001",
    }), statePath, formalRoot)).toThrow(/auditable-codex-imagegen-execution-receipt/);
    const { fingerprint: _fingerprint, ...fixtureSemantic } = {
      ...state,
      authorityReferences: { ...(state.authorityReferences as Record<string, unknown>), mode: "fixture-only" },
    } as Record<string, unknown>;
    const fixtureAuthorities = { ...fixtureSemantic, fingerprint: p14CanaryStateDigest(fixtureSemantic) };
    expect(() => assertP14PendingRealCanaryState(fixtureAuthorities, statePath, formalRoot))
      .toThrow(/real-authority-references/);
    expect(() => assertP14PendingRealCanaryState(replaceReceipt({}), statePath, formalRoot)).not.toThrow();
  });

  it("PASS 证据必须声明主 Agent CLI 权限边界、完整截图与重启持久性", () => {
    const evidence = validEvidence();
    expect(() => assertP14InstalledRealCanaryUiEvidence(evidence)).not.toThrow();
    expect(() => assertP14InstalledRealCanaryUiEvidence({ ...evidence, authority: { ...evidence.authority, userConfirmationClaimed: true } as never })).toThrow(/authority/);
    expect(() => assertP14InstalledRealCanaryUiEvidence({ ...evidence, screenshots: evidence.screenshots.slice(1) })).toThrow(/screenshots.names/);
    expect(() => assertP14InstalledRealCanaryUiEvidence({ ...evidence, terminal: { ...evidence.terminal, reviewPersistedAfterRestart: false } })).toThrow(/terminal/);
  });

  it("桌面审片组件显式提供 pass、rework、reject 三态", () => {
    const source = readFileSync(path.join(root, "src/renderer/src/components/StudioContinuityReviewView.vue"), "utf8");
    expect(parse(source, { filename: "StudioContinuityReviewView.vue" }).errors).toEqual([]);
    expect(source).toContain("submitVisualReview('reject')");
    expect(source).toContain('decision: "pass" | "rework" | "reject"');
    expect(source).toContain("拒绝意见已追加写回。");
  });
});
