import { createHash } from "node:crypto";
import path from "node:path";
import type { P14CanaryState } from "./p14-real-canary-orchestrator.js";

export const P14_INSTALLED_REAL_CANARY_SCREENSHOTS = [
  "01-canvas-result-nodes.png",
  "02-review-before-decision.png",
  "03-review-after-decision.png",
  "04-review-after-restart.png",
] as const;

export type P14InstalledRealCanaryDecision = "pass" | "rework" | "reject";

export interface P14InstalledRealCanaryUiCli {
  executablePath: string;
  statePath: string;
  evidencePath: string;
  screenshotDirectory: string;
  decision: P14InstalledRealCanaryDecision;
}

export interface P14InstalledRealCanaryScreenshotEvidence {
  fileName: typeof P14_INSTALLED_REAL_CANARY_SCREENSHOTS[number];
  path: string;
  width: number;
  height: number;
  sizeBytes: number;
  sha256: string;
  maxChannelStandardDeviation: number;
}

export interface P14InstalledRealCanaryUiEvidence {
  schemaVersion: 1;
  kind: "p14-installed-real-canary-review-ui-smoke";
  status: "pass";
  decision: P14InstalledRealCanaryDecision;
  authority: {
    actor: "main-agent";
    source: "explicit-cli-decision";
    userConfirmationClaimed: false;
    visualQualityInferredByScript: false;
  };
  assertions: Record<string, boolean>;
  isolation: {
    canaryProjectOnly: boolean;
    formalProjectOpened: boolean;
    formalProjectWrites: number;
    externalRequests: number;
    agentRepairClicks: number;
    imageGenerationCalls: number;
  };
  screenshots: P14InstalledRealCanaryScreenshotEvidence[];
  terminal: {
    applicationClosed: boolean;
    temporaryRuntimeRemoved: boolean;
    reviewPersistedAfterRestart: boolean;
  };
  [key: string]: unknown;
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const AUDIT_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,199}$/u;

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([key, entry]) => [key, stableValue(entry)]));
}

export function p14CanaryStateDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stableValue(value)), "utf8").digest("hex");
}

export function sealP14CanaryState(
  semantic: Omit<P14CanaryState, "fingerprint">,
): P14CanaryState {
  return { ...semantic, fingerprint: p14CanaryStateDigest(semantic) };
}

function absolute(value: string, label: string): string {
  if (!value.trim()) throw new Error(`${label} 不能为空。`);
  if (!path.isAbsolute(value)) throw new Error(`${label} 必须是绝对路径：${value}`);
  return path.normalize(value);
}

function isInsideOrEqual(candidate: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export function parseP14InstalledRealCanaryUiCli(argv: readonly string[]): P14InstalledRealCanaryUiCli {
  if (argv.length !== 5) {
    throw new Error("用法：tsx scripts/ui-p14-installed-real-canary-review-smoke.ts <安装版可执行文件> <canary-state.json> <证据 JSON> <全新截图目录> <pass|rework|reject>");
  }
  const executablePath = absolute(argv[0] ?? "", "安装版可执行文件");
  const statePath = absolute(argv[1] ?? "", "canary-state.json");
  const evidencePath = absolute(argv[2] ?? "", "证据 JSON");
  const screenshotDirectory = absolute(argv[3] ?? "", "截图目录");
  const decision = argv[4];
  if (!/\.app\/Contents\/MacOS\/[^/]+$/u.test(executablePath)) {
    throw new Error(`只接受 .app/Contents/MacOS 内的安装版可执行文件：${executablePath}`);
  }
  if (path.basename(statePath) !== "canary-state.json") throw new Error(`state 必须名为 canary-state.json：${statePath}`);
  if (path.extname(evidencePath).toLowerCase() !== ".json") throw new Error(`证据路径必须以 .json 结尾：${evidencePath}`);
  if (decision !== "pass" && decision !== "rework" && decision !== "reject") {
    throw new Error("decision 必须是 pass|rework|reject。");
  }
  return { executablePath, statePath, evidencePath, screenshotDirectory, decision };
}

export function assertP14PendingRealCanaryState(
  value: unknown,
  statePath: string,
  formalProjectRoot: string,
): asserts value is P14CanaryState {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("canary state 不是对象。");
  const state = value as P14CanaryState;
  const failures: string[] = [];
  if (state.schemaVersion !== 1 || state.kind !== "p14-real-canary-orchestration-state") failures.push("schema/kind");
  if (state.phase !== "writeback-pending-review") failures.push(`phase=${String(state.phase)}`);
  const { fingerprint, ...semantic } = state;
  if (!SHA256_PATTERN.test(fingerprint ?? "") || p14CanaryStateDigest(semantic) !== fingerprint) failures.push("fingerprint");
  for (const [label, candidate] of [
    ["runRoot", state.runRoot],
    ["registryPath", state.registryPath],
    ["project.root", state.project?.root],
  ] as const) {
    if (typeof candidate !== "string" || !path.isAbsolute(candidate)) failures.push(label);
  }
  if (typeof state.runRoot === "string") {
    if (!isInsideOrEqual(statePath, state.runRoot)) failures.push("statePath-outside-runRoot");
    if (!isInsideOrEqual(state.registryPath ?? "", state.runRoot)) failures.push("registry-outside-runRoot");
    if (!isInsideOrEqual(state.project?.root ?? "", state.runRoot)) failures.push("project-outside-runRoot");
  }
  if (state.project?.root && (isInsideOrEqual(state.project.root, formalProjectRoot)
    || isInsideOrEqual(formalProjectRoot, state.project.root))) failures.push("formal-project-overlap");
  if (!SHA256_PATTERN.test(state.project?.manifestFingerprint ?? "")) failures.push("manifestFingerprint");
  if (!state.finalization) failures.push("finalization");
  const receipt = state.finalization?.executionReceipt;
  if (!receipt
    || receipt.schemaVersion !== 1
    || receipt.kind !== "agent-imagegen-execution-receipt"
    || receipt.provider !== "codex"
    || receipt.source !== "codex-imagegen"
    || receipt.attestationLevel !== "agent-session-direct"
    || receipt.cryptographicProviderReceipt !== false
    || !AUDIT_ID_PATTERN.test(receipt.callId ?? "")
    || /(?:fixture|placeholder|self[-_ ]?reported|unverified)/iu.test(`${receipt.callId ?? ""} ${receipt.model ?? ""}`)
    || typeof receipt.model !== "string"
    || !receipt.model.trim()
    || receipt.model.length > 200
    || !receipt.generatedAt
    || Number.isNaN(Date.parse(receipt.generatedAt))
    || new Date(receipt.generatedAt).toISOString() !== receipt.generatedAt) {
    failures.push("auditable-codex-imagegen-execution-receipt");
  }
  const writebackAudit = state.finalization?.writebackAudit;
  if (!writebackAudit
    || writebackAudit.schemaVersion !== 1
    || writebackAudit.kind !== "p14-agent-imagegen-writeback-audit"
    || !SHA256_PATTERN.test(writebackAudit.executionReceiptFingerprint ?? "")
    || writebackAudit.executionReceiptFingerprint !== p14CanaryStateDigest(receipt)
    || !SHA256_PATTERN.test(writebackAudit.writebackReceiptFingerprint ?? "")
    || !SHA256_PATTERN.test(writebackAudit.outcomeFingerprint ?? "")
    || !SHA256_PATTERN.test(writebackAudit.resultBundleFingerprint ?? "")) {
    failures.push("writeback-audit");
  }
  const bundle = state.finalization?.bundle;
  if (!bundle || bundle.schemaVersion !== 4 || bundle.provider !== "codex"
    || bundle.status !== "pending-review" || bundle.pairComplete !== true) failures.push("bundle");
  if (!SHA256_PATTERN.test(bundle?.raw?.mediaSha256 ?? "")
    || !SHA256_PATTERN.test(bundle?.labeled?.mediaSha256 ?? "")) failures.push("result-sha");
  if (bundle?.fingerprint !== writebackAudit?.resultBundleFingerprint) failures.push("result-bundle-audit-drift");
  if (bundle?.raw?.mediaSha256 !== state.finalization?.rawSha256) failures.push("raw-sha-drift");
  if (state.target?.durationSeconds !== 15 || state.target.panelCount < 2 || state.target.panelCount > 6) failures.push("target-contract");
  if (state.provider !== "codex" || state.dispatch?.provider !== "codex") failures.push("provider");
  const authorityReferences = state.authorityReferences;
  if (authorityReferences?.mode !== "real-user-assets" || authorityReferences.assets?.length !== 3) {
    failures.push("real-authority-references");
  } else {
    const expectedAssetIds = ["character-ahang", "prop-complete-golden-mask", "scene-stone-room"];
    const observedAssetIds = authorityReferences.assets.map((asset) => asset.assetId).sort();
    if (JSON.stringify(observedAssetIds) !== JSON.stringify(expectedAssetIds)) failures.push("authority-asset-set");
    for (const asset of authorityReferences.assets) {
      if (!path.isAbsolute(asset.sourcePath ?? "") || path.basename(asset.sourcePath) !== asset.sourceBasename
        || !SHA256_PATTERN.test(asset.sourceSha256) || asset.sourceSha256 !== asset.importedSha256
        || asset.sourceUnchanged !== true || asset.width < 512 || asset.height < 512
        || asset.sizeBytes < 10_000 || !Number.isFinite(asset.sourceMtimeMs) || asset.sourceMtimeMs <= 0
        || !Number.isFinite(asset.entropy) || asset.entropy < 1
        || !asset.authorityVersionId?.trim()) failures.push(`authority-reference:${asset.assetId}`);
    }
  }
  if (failures.length) throw new Error(`P14 canary state 未通过安装版审片前检：${failures.join("；")}`);
}

export function assertP14CanaryOutputsOutsideRun(
  state: P14CanaryState,
  evidencePath: string,
  screenshotDirectory: string,
  formalProjectRoot: string,
): void {
  for (const [label, candidate] of [["证据 JSON", evidencePath], ["截图目录", screenshotDirectory]] as const) {
    if (isInsideOrEqual(candidate, state.runRoot)) throw new Error(`${label} 不得写入 canary runRoot：${candidate}`);
    if (isInsideOrEqual(candidate, state.project.root)) throw new Error(`${label} 不得写入 canary 工程：${candidate}`);
    if (isInsideOrEqual(candidate, formalProjectRoot)) throw new Error(`${label} 不得写入正式工程：${candidate}`);
  }
  if (isInsideOrEqual(evidencePath, screenshotDirectory)
    || isInsideOrEqual(screenshotDirectory, evidencePath)) {
    throw new Error("证据 JSON 与截图目录不得互相包含。");
  }
}

const REQUIRED_ASSERTIONS = [
  "stateFingerprintValidated",
  "pendingReviewPhaseValidated",
  "projectManifestMatched",
  "activeRegistryProjectMatched",
  "installedBuildMatchedCanary",
  "realAuthorityReferencesValidated",
  "authoritySourcesUnchanged",
  "primaryAuthoritiesCurrent",
  "packReferencesMatched",
  "continuityReferencesMatched",
  "fixtureAuthoritiesExcluded",
  "goldenMaskDefinitionLocked",
  "rawDecoded",
  "labeledDecoded",
  "rawAndLabeledVisible",
  "canvasResultNodesVisible",
  "oneClickOpenedReview",
  "decisionSubmittedThroughUiOwner",
  "explicitCliDecisionRecorded",
  "reviewHeadMatchedDecision",
  "reviewPersistedAfterRestart",
] as const;

export function assertP14InstalledRealCanaryUiEvidence(value: P14InstalledRealCanaryUiEvidence): void {
  const failures: string[] = [];
  if (value.schemaVersion !== 1 || value.kind !== "p14-installed-real-canary-review-ui-smoke" || value.status !== "pass") failures.push("identity");
  if (!(["pass", "rework", "reject"] as string[]).includes(value.decision)) failures.push("decision");
  if (value.authority?.actor !== "main-agent" || value.authority.source !== "explicit-cli-decision"
    || value.authority.userConfirmationClaimed !== false || value.authority.visualQualityInferredByScript !== false) {
    failures.push("authority");
  }
  for (const assertion of REQUIRED_ASSERTIONS) {
    if (value.assertions?.[assertion] !== true) failures.push(`assertions.${assertion}`);
  }
  if (value.isolation?.canaryProjectOnly !== true || value.isolation?.formalProjectOpened !== false
    || value.isolation?.formalProjectWrites !== 0 || value.isolation?.externalRequests !== 0
    || value.isolation?.agentRepairClicks !== 0 || value.isolation?.imageGenerationCalls !== 0) {
    failures.push("isolation");
  }
  const names = value.screenshots?.map((entry) => entry.fileName) ?? [];
  if (names.length !== P14_INSTALLED_REAL_CANARY_SCREENSHOTS.length
    || P14_INSTALLED_REAL_CANARY_SCREENSHOTS.some((name) => !names.includes(name))) failures.push("screenshots.names");
  for (const screenshot of value.screenshots ?? []) {
    if (screenshot.width < 1_200 || screenshot.height < 700 || screenshot.sizeBytes < 20_000
      || !SHA256_PATTERN.test(screenshot.sha256) || screenshot.maxChannelStandardDeviation < 3) {
      failures.push(`screenshots.${screenshot.fileName}`);
    }
  }
  if (value.terminal?.applicationClosed !== true || value.terminal.temporaryRuntimeRemoved !== true
    || value.terminal.reviewPersistedAfterRestart !== true) failures.push("terminal");
  if (failures.length) throw new Error(`P14 安装版真实 canary UI 证据不完整：${failures.join("；")}`);
}
