import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import fg from "fast-glob";
import {
  FUSION_PANEL_REFERENCE_CONTRACT_COVERAGE_VERSION,
  loadFusionPanelReferenceStore,
  inspectFusionPanelReferenceCurrentness,
  materializeFusionPanelReferenceResolutions,
  type FusionPanelReferenceAudit,
  type FusionPanelReferenceResolutionStore,
} from "../src/core/fusion-panel-references.js";
import { scanAndPersist } from "../src/core/service.js";
import { executeIdempotentCommand } from "../src/core/command-bus.js";
import { getSidecarPaths, readJson, writeJsonAtomicExclusive } from "../src/core/sidecar.js";
import type {
  FusionStoryboardGridSelection,
  FusionStoryboardGridSelectionStore,
  GenerationJob,
  ProjectIndex,
  ReviewStore,
} from "../src/core/types.js";
import type { PublicationStore } from "../src/core/publication.js";

const EXPECTED_SOURCE = {
  files: 3_344,
  bytes: 24_570_877,
  aggregateSha256: "649160f22663ca4c45ee4a4084e278ef0edc61ec66db01bb84da38cbea3f8d26",
} as const;
const EXPECTED_DISTRIBUTION = { "2": 151, "3": 667, "4": 349, "5": 95, "6": 26 } as const;
const UNKNOWN_JOB_ID = "gen-2026-07-16T12-10-57-215Z-892023c0";
const OBSOLETE_TERMINAL_JOB_ID = "gen-2026-07-16T09-57-05-901Z-1515bab0";
const PRESERVED_UNITS = ["season-三-ep01-unit001", "season-三-ep01-unit008"] as const;

interface CliOptions {
  workspace: string;
  projectRoot: string;
  sourceRoot: string;
  evidencePath: string;
  apply: boolean;
  keepRehearsal: boolean;
}

interface FileEvidence {
  path: string;
  bytes: number;
  sha256: string;
}

interface SourceSnapshot {
  files: number;
  bytes: number;
  aggregateSha256: string;
}

interface ProtectedSnapshot {
  generationJobs: FileEvidence;
  publications: FileEvidence;
  reviews: FileEvidence;
  rawLabeled: Array<{ relativePath: string; bytes: number; sha256: string }>;
  generationCounts: Record<string, number>;
  publicationCounts: { intents: number; receipts: number };
  reviewCount: number;
  legacyPanelGenerationJobs: LegacyPanelGenerationJobs;
  legacyPanelArtifacts: {
    count: number;
    artifactIds: string[];
    identitySha256: string;
    withoutP2Evidence: number;
    withP2Evidence: number;
  };
  legacyPanelReviews: {
    count: number;
    reviewIds: string[];
    identitySha256: string;
    withoutP2Evidence: number;
    withP2Evidence: number;
  };
  unknownJobIdentitySha256: string;
  unknownJob: {
    id: string;
    status: string;
    attempts: number;
    checkpoint: { schemaVersion: number; revision: number; stage: string; unknownCode?: string };
    publicationBundleId: string;
    publicationIntentId: string;
    companionPublicationIntentId: string;
  };
}

interface LegacyPanelGenerationJobs {
  count: number;
  ids: string[];
  idsSha256: string;
  withoutP2Evidence: number;
  withP2Evidence: number;
}

interface FormalP2Snapshot {
  selectionStore: FileEvidence;
  projectOverrides: FileEvidence;
  resolutionStore?: FileEvidence;
  gridContracts: { files: number; bytes: number; aggregateSha256: string };
}

interface MaterializationSummary {
  revision: number;
  storeFingerprint: string;
  updatedAt: string;
  audit: FusionPanelReferenceAudit;
  inputSnapshot: FusionPanelReferenceResolutionStore["inputSnapshot"];
  resolutionCount: number;
  derivedDefinitionCount: number;
  overrideCount: number;
  selectionRevision: number;
  selectionCount: number;
  resolutionFile: FileEvidence;
  resolutionFileMtimeMs: number;
  selectionFileMtimeMs: number;
  preservedSelections: Record<string, FusionStoryboardGridSelection>;
  legacyGenerationJobIds: string[];
  legacyGenerationJobIdsSha256: string;
  legacyGenerationJobEvidence: FusionPanelReferenceResolutionStore["legacyGenerationJobEvidence"];
  legacyGenerationJobEvidenceSha256: string;
  legacyGenerationJobEvidenceKinds: {
    currentResolution: number;
    obsoleteTerminal: number;
    obsoleteTerminalJobIds: string[];
  };
}

function usage(): string {
  return `P2 逐分镜引用闭包迁移（默认仅演练）

用法：
  npm run fusion:migrate-p2-panel-references -- [参数]

参数：
  --workspace <path>       工作区，默认 /Users/hxx/Documents/无限画布
  --project-root <path>    正式隔离工程
  --source-root <path>     第三季只读源目录
  --evidence <path>        --apply 成功后的独占证据路径（仅 workspace/docs/evidence）
  --keep-rehearsal        保留 /tmp 演练副本便于调查
  --apply                 演练通过后才对正式工程物化
  --help                  显示帮助

安全约束：
  不带 --apply 时不改写正式工程；--apply 也会先演练、备份、校验 P1 状态与只读源。
`;
}

function optionValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} 缺少路径参数。`);
  return value;
}

function parseOptions(argv: string[]): CliOptions {
  const workspace = path.resolve(optionValue(argv, "--workspace") ?? "/Users/hxx/Documents/无限画布");
  return {
    workspace,
    projectRoot: path.resolve(optionValue(argv, "--project-root") ?? path.join(workspace, "productions/gushujuan-s3-f1a688020bfb7af6")),
    sourceRoot: path.resolve(optionValue(argv, "--source-root") ?? "/Users/hxx/Documents/古蜀卷第三季"),
    evidencePath: path.resolve(optionValue(argv, "--evidence") ?? path.join(workspace, "docs/evidence/p2-panel-reference-migration-corrected-20260717.json")),
    apply: argv.includes("--apply"),
    keepRehearsal: argv.includes("--keep-rehearsal"),
  };
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
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
  return sha256(JSON.stringify(stableValue(value)));
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function nearestExistingRealPath(candidate: string): Promise<{ real: string; suffix: string[] }> {
  const suffix: string[] = [];
  let cursor = path.resolve(candidate);
  while (!await exists(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) throw new Error(`无法找到输出路径的现存父目录：${candidate}`);
    suffix.unshift(path.basename(cursor));
    cursor = parent;
  }
  return { real: await realpath(cursor), suffix };
}

async function assertSafeEvidencePath(
  workspace: string,
  projectRoot: string,
  sourceRoot: string,
  candidate: string,
): Promise<void> {
  const evidenceRoot = path.resolve(workspace, "docs/evidence");
  const target = path.resolve(candidate);
  if (target === evidenceRoot || !isInside(evidenceRoot, target)) {
    throw new Error(`迁移证据必须位于 workspace/docs/evidence 内：${target}`);
  }
  if (isInside(projectRoot, target) || isInside(sourceRoot, target)) {
    throw new Error(`迁移证据不得写入正式 production 或只读源：${target}`);
  }
  const [canonicalWorkspace, canonicalRoot, canonicalProject, canonicalSource] = await Promise.all([
    realpath(workspace),
    realpath(evidenceRoot),
    realpath(projectRoot),
    realpath(sourceRoot),
  ]);
  if (!isInside(canonicalWorkspace, canonicalRoot)
    || isInside(canonicalProject, canonicalRoot)
    || isInside(canonicalSource, canonicalRoot)) {
    throw new Error("workspace/docs/evidence 经符号链接解析后不在工作区安全证据树内。");
  }
  const parent = await nearestExistingRealPath(path.dirname(target));
  const canonicalTarget = await exists(target)
    ? await realpath(target)
    : path.join(parent.real, ...parent.suffix, path.basename(target));
  if (!isInside(canonicalRoot, canonicalTarget)
    || isInside(canonicalProject, canonicalTarget)
    || isInside(canonicalSource, canonicalTarget)) {
    throw new Error(`迁移证据父目录经符号链接解析后越出 docs/evidence：${target}`);
  }
}

async function exists(filePath: string): Promise<boolean> {
  return access(filePath).then(() => true, () => false);
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(filePath), new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      callback();
    },
  }));
  return hash.digest("hex");
}

async function fileEvidence(filePath: string): Promise<FileEvidence> {
  const before = await stat(filePath);
  if (!before.isFile()) throw new Error(`不是常规文件：${filePath}`);
  const fileSha256 = await sha256File(filePath);
  const after = await stat(filePath);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
    throw new Error(`计算文件证据期间内容发生变化：${filePath}`);
  }
  return { path: filePath, bytes: before.size, sha256: fileSha256 };
}

async function readRequiredJsonWithEvidence<T>(filePath: string): Promise<{ value: T; file: FileEvidence }> {
  const before = await stat(filePath);
  const content = await readFile(filePath);
  const after = await stat(filePath);
  if (!before.isFile()
    || before.size !== after.size
    || before.mtimeMs !== after.mtimeMs
    || before.ctimeMs !== after.ctimeMs
    || content.length !== before.size) {
    throw new Error(`读取受保护 JSON 期间文件发生变化：${filePath}`);
  }
  let value: T;
  try {
    value = JSON.parse(content.toString("utf8")) as T;
  } catch {
    throw new Error(`受保护 JSON 无法解析：${filePath}`);
  }
  return { value, file: { path: filePath, bytes: content.length, sha256: sha256(content) } };
}

async function sourceSnapshot(root: string): Promise<SourceSnapshot> {
  const relativePaths = (await fg("**/*", {
    cwd: root,
    onlyFiles: true,
    followSymbolicLinks: false,
    dot: true,
  })).sort((left, right) => left.localeCompare(right, "en"));
  const records: string[] = [];
  let bytes = 0;
  for (const relativePath of relativePaths) {
    const absolutePath = path.join(root, ...relativePath.split("/"));
    const before = await stat(absolutePath);
    const fileSha256 = await sha256File(absolutePath);
    const after = await stat(absolutePath);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error(`读取只读源期间文件发生变化：${absolutePath}`);
    }
    bytes += before.size;
    records.push(`${relativePath}\0${before.size}\0${before.mtimeMs}\0${fileSha256}`);
  }
  return { files: relativePaths.length, bytes, aggregateSha256: sha256(records.join("\n")) };
}

function assertSource(snapshot: SourceSnapshot, stage: string): void {
  if (snapshot.files !== EXPECTED_SOURCE.files
    || snapshot.bytes !== EXPECTED_SOURCE.bytes
    || snapshot.aggregateSha256 !== EXPECTED_SOURCE.aggregateSha256) {
    throw new Error(`${stage}的第三季只读源基线漂移：${JSON.stringify(snapshot)}`);
  }
}

async function rawLabeledInventory(projectRoot: string): Promise<Array<{ relativePath: string; bytes: number; sha256: string }>> {
  const files = (await fg(["**/*_raw.png", "**/*_labeled.png"], {
    cwd: projectRoot,
    onlyFiles: true,
    followSymbolicLinks: false,
    dot: true,
    ignore: [".aicanvas/backups/**", ".aicanvas/subagent-staging/**", ".aicanvas/generation-downloads/**"],
  })).sort((left, right) => left.localeCompare(right, "en"));
  return Promise.all(files.map(async (relativePath) => {
    const absolutePath = path.join(projectRoot, ...relativePath.split("/"));
    const before = await stat(absolutePath);
    const fileSha256 = await sha256File(absolutePath);
    const after = await stat(absolutePath);
    if (!before.isFile()
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs) {
      throw new Error(`计算 P1 raw/labeled 清单期间文件发生变化：${absolutePath}`);
    }
    return { relativePath, bytes: before.size, sha256: fileSha256 };
  }));
}

function countByStatus(jobs: GenerationJob[]): Record<string, number> {
  return Object.fromEntries([...new Set(jobs.map((job) => job.status))]
    .sort()
    .map((status) => [status, jobs.filter((job) => job.status === status).length]));
}

function hasAnyPanelReferenceEvidence(job: GenerationJob): boolean {
  return job.panelReferenceEvidenceVersion !== undefined
    || job.fusionStoryboardPanel?.panelReferenceResolutionId !== undefined
    || job.fusionStoryboardPanel?.panelReferenceResolutionFingerprint !== undefined
    || job.fusionReferenceBoard?.panelReferenceResolutionId !== undefined
    || job.fusionReferenceBoard?.panelReferenceResolutionFingerprint !== undefined;
}

function legacyPanelGenerationJobs(jobs: GenerationJob[]): LegacyPanelGenerationJobs {
  const panelJobs = jobs
    .filter((job) => job.purpose === "fusion_storyboard_panel")
    .sort((left, right) => left.id.localeCompare(right.id, "en"));
  const ids = panelJobs.map((job) => job.id);
  if (new Set(ids).size !== ids.length) throw new Error("GenerationJob 存在重复 ID，无法冻结历史逐格任务白名单。");
  const withP2Evidence = panelJobs.filter(hasAnyPanelReferenceEvidence).length;
  if (withP2Evidence) {
    throw new Error(`首次 P2 迁移前已有 ${withP2Evidence} 个逐格任务携带部分或完整 P2 身份；拒绝把它们降级加入历史白名单。`);
  }
  return {
    count: ids.length,
    ids,
    idsSha256: sha256(ids.join("\n")),
    withoutP2Evidence: panelJobs.length - withP2Evidence,
    withP2Evidence,
  };
}

function assertLegacyWhitelist(
  actual: readonly string[],
  expected: LegacyPanelGenerationJobs,
  stage: string,
): void {
  const normalized = [...actual].sort((left, right) => left.localeCompare(right, "en"));
  if (new Set(actual).size !== actual.length || normalized.join("\0") !== expected.ids.join("\0")) {
    throw new Error(`${stage}历史逐格任务白名单与正式迁移前账不一致：${JSON.stringify({ expected, actual })}`);
  }
}

async function assertLegacyGenerationJobEvidence(
  store: FusionPanelReferenceResolutionStore,
  jobs: GenerationJob[],
  publications: PublicationStore,
  expected: LegacyPanelGenerationJobs,
  stage: string,
): Promise<{ currentResolution: number; obsoleteTerminal: number; obsoleteTerminalJobIds: string[] }> {
  const evidenceIds = Object.keys(store.legacyGenerationJobEvidence).sort((left, right) => left.localeCompare(right, "en"));
  if (evidenceIds.join("\0") !== expected.ids.join("\0")) {
    throw new Error(`${stage}没有为每个历史逐格任务冻结且仅冻结一份 P2 resolution 身份。`);
  }
  const jobsById = new Map(jobs.map((job) => [job.id, job]));
  let currentResolution = 0;
  const obsoleteTerminalJobIds: string[] = [];
  for (const jobId of expected.ids) {
    const job = jobsById.get(jobId);
    const panel = job?.fusionStoryboardPanel;
    const evidence = store.legacyGenerationJobEvidence[jobId];
    if (!job || job.purpose !== "fusion_storyboard_panel" || !panel || !evidence
      || evidence.contractId !== panel.contractId
      || evidence.panelId !== panel.panelId
      || evidence.jobLedgerFingerprint !== digest(job)) {
      throw new Error(`${stage}历史任务 ${jobId} 的 job ledger/contract/panel 冻结身份不完整或已漂移。`);
    }
    if (evidence.kind === "current-resolution") {
      const resolution = store.resolutions[`${panel.contractId}:${panel.panelId}`];
      const expectedFields = ["contractId", "jobLedgerFingerprint", "kind", "panelId", "resolutionFingerprint", "resolutionId"];
      if (Object.keys(evidence).sort().join("\0") !== expectedFields.sort().join("\0")
        || !resolution
        || resolution.unitItemId !== job.itemId
        || evidence.resolutionId !== resolution.resolutionId
        || evidence.resolutionFingerprint !== resolution.resolutionFingerprint) {
        throw new Error(`${stage}历史任务 ${jobId} 的 current-resolution 冻结身份不完整或不匹配。`);
      }
      currentResolution += 1;
      continue;
    }
    const publicationIntentIds = [...new Set([
      job.publicationIntentId,
      job.companionPublicationIntentId,
    ].filter((id): id is string => Boolean(id)))].sort((left, right) => left.localeCompare(right, "en"));
    const intents = publications.intents
      .filter((intent) => publicationIntentIds.includes(intent.id))
      .sort((left, right) => left.id.localeCompare(right.id, "en"));
    const receipts = publications.receipts
      .filter((receipt) => publicationIntentIds.includes(receipt.intentId))
      .sort((left, right) => left.id.localeCompare(right.id, "en"));
    const hasOutputLedger = Boolean(job.resultPath
      || job.companionPath
      || job.publicationReceiptId
      || job.companionPublicationReceiptId
      || job.isolatedDownloadPath
      || job.partialDownloadPath
      || job.resultSha256
      || job.remoteResultUrl
      || job.subagentCheckpoint?.output);
    const expectedFields = [
      "contractId",
      "disposition",
      "itemId",
      "jobLedgerFingerprint",
      "kind",
      "panelId",
      "publicationIntentIds",
      "publicationLedgerFingerprint",
      "terminalStatus",
    ];
    if (jobId !== OBSOLETE_TERMINAL_JOB_ID
      || Object.keys(evidence).sort().join("\0") !== expectedFields.sort().join("\0")
      || evidence.itemId !== job.itemId
      || job.status !== "failed"
      || evidence.terminalStatus !== "failed"
      || evidence.disposition !== "non-current-contract-no-output"
      || hasOutputLedger
      || await exists(job.expectedOutputPath)
      || Boolean(job.expectedCompanionPath && await exists(job.expectedCompanionPath))
      || Object.values(store.resolutions).some((resolution) => resolution.gridContractId === evidence.contractId)
      || JSON.stringify(evidence.publicationIntentIds) !== JSON.stringify(publicationIntentIds)
      || publicationIntentIds.length !== 1
      || intents.length !== publicationIntentIds.length
      || intents.some((intent) => intent.status !== "failed")
      || receipts.length !== 0
      || evidence.publicationLedgerFingerprint !== digest({ intents, receipts })) {
      throw new Error(`${stage}历史任务 ${jobId} 不是唯一、无输出、Publication failed 且旧合同已淘汰的 obsolete-terminal 证据。`);
    }
    obsoleteTerminalJobIds.push(jobId);
  }
  if (currentResolution !== 10
    || obsoleteTerminalJobIds.length !== 1
    || obsoleteTerminalJobIds[0] !== OBSOLETE_TERMINAL_JOB_ID) {
    throw new Error(`${stage}legacy evidence 类型分布不是 10 current-resolution + 1 指定 obsolete-terminal。`);
  }
  return { currentResolution, obsoleteTerminal: obsoleteTerminalJobIds.length, obsoleteTerminalJobIds };
}

function normalizedLegacyGenerationJobEvidence(
  store: FusionPanelReferenceResolutionStore,
): FusionPanelReferenceResolutionStore["legacyGenerationJobEvidence"] {
  return Object.fromEntries(Object.entries(store.legacyGenerationJobEvidence)
    .sort(([left], [right]) => left.localeCompare(right, "en")));
}

function assertUnknownJob(job: GenerationJob | undefined): asserts job is GenerationJob {
  if (!job
    || job.id !== UNKNOWN_JOB_ID
    || job.status !== "generation_unknown"
    || job.attempts !== 1
    || job.subagentCheckpoint?.schemaVersion !== 2
    || job.subagentCheckpoint.stage !== "generation_unknown"
    || job.subagentCheckpoint.unknown?.code !== "legacy_leased_without_call_receipt"
    || job.subagentCheckpoint.callIntent
    || job.subagentCheckpoint.output
    || job.resultPath
    || job.companionPath
    || job.publicationReceiptId
    || job.companionPublicationReceiptId
    || !job.publicationBundleId
    || !job.publicationIntentId
    || !job.companionPublicationIntentId) {
    throw new Error(`P1 unknown Job 不再满足禁止重试合同：${JSON.stringify(job ? {
      id: job.id,
      status: job.status,
      attempts: job.attempts,
      checkpoint: {
        schemaVersion: job.subagentCheckpoint?.schemaVersion,
        stage: job.subagentCheckpoint?.stage,
        unknownCode: job.subagentCheckpoint?.unknown?.code,
        hasCallIntent: Boolean(job.subagentCheckpoint?.callIntent),
        hasOutput: Boolean(job.subagentCheckpoint?.output),
      },
      hasResultPath: Boolean(job.resultPath),
      hasCompanionPath: Boolean(job.companionPath),
      hasPublicationReceipt: Boolean(job.publicationReceiptId),
      hasCompanionPublicationReceipt: Boolean(job.companionPublicationReceiptId),
      hasPublicationBundle: Boolean(job.publicationBundleId),
      hasPublicationIntent: Boolean(job.publicationIntentId),
      hasCompanionPublicationIntent: Boolean(job.companionPublicationIntentId),
    } : { missing: true })}`);
  }
}

function legacyPanelArtifactSnapshot(
  jobs: GenerationJob[],
  index: ProjectIndex,
): { count: number; artifactIds: string[]; identitySha256: string; withoutP2Evidence: number; withP2Evidence: number } {
  const outputPaths = new Set(jobs
    .filter((job) => job.purpose === "fusion_storyboard_panel")
    .flatMap((job) => [job.expectedOutputPath, job.expectedCompanionPath, job.resultPath, job.companionPath])
    .filter((value): value is string => Boolean(value))
    .map((value) => path.resolve(value)));
  const artifacts = index.artifacts
    .filter((artifact) => outputPaths.has(path.resolve(artifact.path)))
    .sort((left, right) => left.id.localeCompare(right.id, "en"));
  const artifactIds = artifacts.map((artifact) => artifact.id);
  if (new Set(artifactIds).size !== artifactIds.length) throw new Error("P1 legacy panel Artifact 存在重复 ID。");
  const withP2Evidence = artifacts.filter((artifact) => artifact.fusionStoryboardPanel?.panelReferenceEvidenceVersion !== undefined
    || artifact.fusionStoryboardPanel?.panelReferenceResolutionId !== undefined
    || artifact.fusionStoryboardPanel?.panelReferenceResolutionFingerprint !== undefined).length;
  if (withP2Evidence) throw new Error(`${withP2Evidence} 个 P1 legacy panel Artifact 不应携带后补 P2 身份。`);
  return {
    count: artifacts.length,
    artifactIds,
    identitySha256: sha256(JSON.stringify(artifacts)),
    withoutP2Evidence: artifacts.length - withP2Evidence,
    withP2Evidence,
  };
}

function legacyPanelReviewSnapshot(
  jobs: GenerationJob[],
  reviews: ReviewStore,
): { count: number; reviewIds: string[]; identitySha256: string; withoutP2Evidence: number; withP2Evidence: number } {
  const jobIds = new Set(jobs
    .filter((job) => job.purpose === "fusion_storyboard_panel")
    .map((job) => job.id));
  const records = reviews.records
    .filter((record) => record.artifactEvidence?.some((artifact) => jobIds.has(artifact.fusionStoryboardPanel?.generationJobId ?? ""))
      || record.requirement?.panels.some((panel) => jobIds.has(panel.generationJobId ?? "")))
    .sort((left, right) => left.id.localeCompare(right.id, "en"));
  const reviewIds = records.map((record) => record.id);
  if (new Set(reviewIds).size !== reviewIds.length) throw new Error("P1 legacy panel Review 存在重复 ID。");
  const withP2Evidence = records.filter((record) => record.artifactEvidence?.some((artifact) => artifact.fusionStoryboardPanel?.panelReferenceEvidenceVersion !== undefined
    || artifact.fusionStoryboardPanel?.panelReferenceResolutionId !== undefined
    || artifact.fusionStoryboardPanel?.panelReferenceResolutionFingerprint !== undefined)
    || record.requirement?.panels.some((panel) => panel.panelReferenceEvidenceVersion !== undefined
      || panel.panelReferenceResolutionId !== undefined
      || panel.panelReferenceResolutionFingerprint !== undefined)).length;
  if (withP2Evidence) throw new Error(`${withP2Evidence} 个 P1 legacy panel Review 不应携带后补 P2 身份。`);
  return {
    count: records.length,
    reviewIds,
    identitySha256: sha256(JSON.stringify(records)),
    withoutP2Evidence: records.length - withP2Evidence,
    withP2Evidence,
  };
}

async function protectedSnapshot(projectRoot: string): Promise<ProtectedSnapshot> {
  const sidecar = getSidecarPaths(projectRoot);
  const [jobsSnapshot, publicationsSnapshot, reviewsSnapshot, rawLabeled, indexSnapshot] = await Promise.all([
    readRequiredJsonWithEvidence<GenerationJob[]>(sidecar.generationJobs),
    readRequiredJsonWithEvidence<PublicationStore>(sidecar.publications),
    readRequiredJsonWithEvidence<ReviewStore>(sidecar.reviews),
    rawLabeledInventory(projectRoot),
    readRequiredJsonWithEvidence<ProjectIndex>(sidecar.index),
  ]);
  const jobs = jobsSnapshot.value;
  const publications = publicationsSnapshot.value;
  const reviews = reviewsSnapshot.value;
  const index = indexSnapshot.value;
  const unknownJob = jobs.find((job) => job.id === UNKNOWN_JOB_ID);
  assertUnknownJob(unknownJob);
  if (jobs.length !== 30
    || jobs.filter((job) => job.status === "succeeded").length !== 26
    || jobs.filter((job) => job.status === "failed").length !== 3
    || jobs.filter((job) => job.status === "generation_unknown").length !== 1) {
    throw new Error(`P1 GenerationJob 账不是 26 succeeded / 3 failed / 1 unknown：${JSON.stringify(countByStatus(jobs))}`);
  }
  if (publications.intents.length !== 31 || publications.receipts.length !== 26 || reviews.records.length !== 20) {
    throw new Error(`P1 Publication/Review 账异常：${JSON.stringify({ intents: publications.intents.length, receipts: publications.receipts.length, reviews: reviews.records.length })}`);
  }
  const raws = rawLabeled.filter((entry) => entry.relativePath.endsWith("_raw.png"));
  const labeled = rawLabeled.filter((entry) => entry.relativePath.endsWith("_labeled.png"));
  if (raws.length !== 26 || labeled.length !== 26) throw new Error(`P1 raw/labeled 不是 26/26：${raws.length}/${labeled.length}`);
  for (const outputPath of [unknownJob.expectedOutputPath, unknownJob.expectedCompanionPath].filter((value): value is string => Boolean(value))) {
    if (await exists(outputPath)) throw new Error(`unknown Job 的正式输出不应存在：${outputPath}`);
  }
  return {
    generationJobs: jobsSnapshot.file,
    publications: publicationsSnapshot.file,
    reviews: reviewsSnapshot.file,
    rawLabeled,
    generationCounts: countByStatus(jobs),
    publicationCounts: { intents: publications.intents.length, receipts: publications.receipts.length },
    reviewCount: reviews.records.length,
    legacyPanelGenerationJobs: legacyPanelGenerationJobs(jobs),
    legacyPanelArtifacts: legacyPanelArtifactSnapshot(jobs, index),
    legacyPanelReviews: legacyPanelReviewSnapshot(jobs, reviews),
    unknownJobIdentitySha256: sha256(JSON.stringify(unknownJob)),
    unknownJob: {
      id: unknownJob.id,
      status: unknownJob.status,
      attempts: unknownJob.attempts,
      checkpoint: {
        schemaVersion: unknownJob.subagentCheckpoint!.schemaVersion,
        revision: unknownJob.subagentCheckpoint!.revision,
        stage: unknownJob.subagentCheckpoint!.stage,
        unknownCode: unknownJob.subagentCheckpoint!.unknown?.code,
      },
      publicationBundleId: unknownJob.publicationBundleId!,
      publicationIntentId: unknownJob.publicationIntentId!,
      companionPublicationIntentId: unknownJob.companionPublicationIntentId!,
    },
  };
}

async function formalP2Snapshot(projectRoot: string): Promise<FormalP2Snapshot> {
  const sidecar = getSidecarPaths(projectRoot);
  const files = (await fg("**/*.json", {
    cwd: sidecar.storyboardGrids,
    onlyFiles: true,
    followSymbolicLinks: false,
  })).sort((left, right) => left.localeCompare(right, "en"));
  let bytes = 0;
  const records: string[] = [];
  for (const relativePath of files) {
    const absolutePath = path.join(sidecar.storyboardGrids, ...relativePath.split("/"));
    const before = await stat(absolutePath);
    const fileSha256 = await sha256File(absolutePath);
    const after = await stat(absolutePath);
    if (!before.isFile()
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs) {
      throw new Error(`计算宫格合同清单期间文件发生变化：${absolutePath}`);
    }
    bytes += before.size;
    records.push(`${relativePath}\0${before.size}\0${fileSha256}`);
  }
  return {
    selectionStore: await fileEvidence(sidecar.storyboardGridSelections),
    projectOverrides: await fileEvidence(sidecar.overrides),
    resolutionStore: await exists(sidecar.panelReferenceResolutions) ? await fileEvidence(sidecar.panelReferenceResolutions) : undefined,
    gridContracts: { files: files.length, bytes, aggregateSha256: sha256(records.join("\n")) },
  };
}

function protectedIdentity(snapshot: ProtectedSnapshot): string {
  return sha256(JSON.stringify({
    generationJobs: snapshot.generationJobs.sha256,
    publications: snapshot.publications.sha256,
    reviews: snapshot.reviews.sha256,
    rawLabeled: snapshot.rawLabeled,
    unknownJobIdentitySha256: snapshot.unknownJobIdentitySha256,
    legacyPanelArtifacts: snapshot.legacyPanelArtifacts,
    legacyPanelReviews: snapshot.legacyPanelReviews,
  }));
}

function selectedIdentity(
  store: FusionStoryboardGridSelectionStore,
): Record<string, FusionStoryboardGridSelection> {
  return Object.fromEntries(PRESERVED_UNITS.map((unitId) => {
    const selection = store.items[unitId];
    if (!selection) throw new Error(`缺少需保留的当前宫格选择：${unitId}`);
    return [unitId, structuredClone(selection)];
  }));
}

function assertPreservedSelections(
  expected: Record<string, FusionStoryboardGridSelection>,
  actual: Record<string, FusionStoryboardGridSelection>,
  stage: string,
): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${stage}改变了 EP01_001/008 当前合同身份：${JSON.stringify({ expected, actual })}`);
  }
}

function assertAudit(audit: FusionPanelReferenceAudit, stage: string): void {
  const distribution = JSON.stringify(Object.fromEntries(Object.entries(audit.panelDistribution).sort()));
  const expectedDistribution = JSON.stringify(EXPECTED_DISTRIBUTION);
  if (audit.currentContracts !== 1_288
    || audit.panels !== 4_330
    || audit.contractCoverageVersion !== FUSION_PANEL_REFERENCE_CONTRACT_COVERAGE_VERSION
    || audit.semanticAssetBindings !== 13_812
    || audit.referenceSlots !== 12_720
    || audit.detectedRowContinuityDifferencePanels !== 913
    || audit.detectedRowContinuityDifferences !== 1_994
    || distribution !== expectedDistribution
    || audit.unresolvedPanels !== 0
    || audit.unresolvedReferences !== 0
    || audit.knownAssetMissingBindingPanels !== 0
    || audit.knownAssetMissingBindings !== 0
    || audit.semanticAssetMissingSlotPanels !== 0
    || audit.semanticAssetMissingSlots !== 0
    || audit.contractAssetMissingBindingPanels !== 0
    || audit.contractAssetMissingBindings !== 0
    || audit.explicitContinuityMissingBindingPanels !== 0
    || audit.explicitContinuityMissingBindings !== 0
    || audit.unhandledOverflowPanels !== 0
    || audit.timeSpanContinuityMismatchPanels !== 0
    || audit.timeSpanContinuityMismatches !== 0
    || audit.maximumReferenceSlotsPerPanel > 6
    || !audit.closurePassed) {
    throw new Error(`${stage}的 P2 引用闭包审计未通过：${JSON.stringify(audit)}`);
  }
}

async function summarizeMaterialization(
  projectRoot: string,
  store: FusionPanelReferenceResolutionStore,
  expectedLegacyJobs: LegacyPanelGenerationJobs,
): Promise<MaterializationSummary> {
  const sidecar = getSidecarPaths(projectRoot);
  const [selections, jobs, publications, resolutionStat, selectionStat] = await Promise.all([
    readJson<FusionStoryboardGridSelectionStore>(sidecar.storyboardGridSelections, { schemaVersion: 1, revision: 0, items: {}, updatedAt: new Date(0).toISOString() }),
    readJson<GenerationJob[]>(sidecar.generationJobs, []),
    readJson<PublicationStore>(sidecar.publications, {
      schemaVersion: 1,
      revision: 0,
      intents: [],
      receipts: [],
      updatedAt: new Date(0).toISOString(),
    }),
    stat(sidecar.panelReferenceResolutions),
    stat(sidecar.storyboardGridSelections),
  ]);
  assertAudit(store.audit, "物化结果");
  assertLegacyWhitelist(store.legacyGenerationJobIds, expectedLegacyJobs, "物化结果");
  const legacyGenerationJobEvidenceKinds = await assertLegacyGenerationJobEvidence(
    store,
    jobs,
    publications,
    expectedLegacyJobs,
    "物化结果",
  );
  if (Object.keys(store.resolutions).length !== 4_330 || Object.keys(selections.items).length !== 1_288) {
    throw new Error(`P2 物化实体计数错误：${JSON.stringify({ resolutions: Object.keys(store.resolutions).length, selections: Object.keys(selections.items).length })}`);
  }
  const legacyEvidence = normalizedLegacyGenerationJobEvidence(store);
  return {
    revision: store.revision,
    storeFingerprint: store.storeFingerprint,
    updatedAt: store.updatedAt,
    audit: store.audit,
    inputSnapshot: store.inputSnapshot,
    resolutionCount: Object.keys(store.resolutions).length,
    derivedDefinitionCount: Object.keys(store.derivedAssets).length,
    overrideCount: Object.keys(store.overrides).length,
    selectionRevision: selections.revision,
    selectionCount: Object.keys(selections.items).length,
    resolutionFile: await fileEvidence(sidecar.panelReferenceResolutions),
    resolutionFileMtimeMs: resolutionStat.mtimeMs,
    selectionFileMtimeMs: selectionStat.mtimeMs,
    preservedSelections: selectedIdentity(selections),
    legacyGenerationJobIds: [...store.legacyGenerationJobIds],
    legacyGenerationJobIdsSha256: sha256([...store.legacyGenerationJobIds].sort().join("\n")),
    legacyGenerationJobEvidence: legacyEvidence,
    legacyGenerationJobEvidenceSha256: sha256(JSON.stringify(legacyEvidence)),
    legacyGenerationJobEvidenceKinds,
  };
}

function assertIdempotent(first: MaterializationSummary, second: MaterializationSummary, stage: string): void {
  if (first.revision !== second.revision
    || first.storeFingerprint !== second.storeFingerprint
    || first.resolutionFile.sha256 !== second.resolutionFile.sha256
    || first.resolutionFileMtimeMs !== second.resolutionFileMtimeMs
    || first.selectionRevision !== second.selectionRevision
    || first.selectionFileMtimeMs !== second.selectionFileMtimeMs
    || first.legacyGenerationJobIdsSha256 !== second.legacyGenerationJobIdsSha256
    || first.legacyGenerationJobEvidenceSha256 !== second.legacyGenerationJobEvidenceSha256
    || JSON.stringify(first.legacyGenerationJobEvidenceKinds) !== JSON.stringify(second.legacyGenerationJobEvidenceKinds)
    || JSON.stringify(first.legacyGenerationJobIds) !== JSON.stringify(second.legacyGenerationJobIds)
    || JSON.stringify(first.legacyGenerationJobEvidence) !== JSON.stringify(second.legacyGenerationJobEvidence)
    || JSON.stringify(first.preservedSelections) !== JSON.stringify(second.preservedSelections)) {
    throw new Error(`${stage}二次物化不幂等：${JSON.stringify({ first, second })}`);
  }
}

function assertFreshRehearsalDeterminism(
  first: MaterializationSummary,
  replica: MaterializationSummary,
): void {
  if (first.storeFingerprint !== replica.storeFingerprint
    || first.audit.auditFingerprint !== replica.audit.auditFingerprint
    || JSON.stringify(first.inputSnapshot) !== JSON.stringify(replica.inputSnapshot)
    || first.resolutionCount !== replica.resolutionCount
    || first.derivedDefinitionCount !== replica.derivedDefinitionCount
    || first.selectionCount !== replica.selectionCount
    || first.legacyGenerationJobIdsSha256 !== replica.legacyGenerationJobIdsSha256
    || first.legacyGenerationJobEvidenceSha256 !== replica.legacyGenerationJobEvidenceSha256
    || JSON.stringify(first.legacyGenerationJobEvidenceKinds) !== JSON.stringify(replica.legacyGenerationJobEvidenceKinds)
    || JSON.stringify(first.legacyGenerationJobEvidence) !== JSON.stringify(replica.legacyGenerationJobEvidence)) {
    throw new Error(`两份 fresh P2 演练没有形成同一内容身份：${JSON.stringify({
      first: {
        storeFingerprint: first.storeFingerprint,
        auditFingerprint: first.audit.auditFingerprint,
        inputSnapshot: first.inputSnapshot,
      },
      replica: {
        storeFingerprint: replica.storeFingerprint,
        auditFingerprint: replica.audit.auditFingerprint,
        inputSnapshot: replica.inputSnapshot,
      },
    })}`);
  }
}

async function copyIfPresent(sourcePath: string, targetPath: string): Promise<void> {
  if (!await exists(sourcePath)) return;
  await mkdir(path.dirname(targetPath), { recursive: true });
  await cp(sourcePath, targetPath, { errorOnExist: true, force: false, recursive: true });
}

async function prepareRehearsalProject(projectRoot: string, rehearsalRoot: string): Promise<void> {
  const source = getSidecarPaths(projectRoot);
  const target = getSidecarPaths(rehearsalRoot);
  await mkdir(target.root, { recursive: true });
  const requiredFiles = [
    source.config,
    source.index,
    source.overrides,
    source.storyboards,
    source.productionWorkflow,
    source.fusionProjectManifest,
    source.productionAssets,
    source.continuityTracks,
    source.reviews,
    source.generationJobs,
    source.publications,
    source.storyboardGridSelections,
    source.panelReferenceResolutions,
    source.storyAdaptation,
    source.storyIndex,
  ];
  for (const sourcePath of requiredFiles) {
    await copyIfPresent(sourcePath, path.join(target.root, path.relative(source.root, sourcePath)));
  }
  const selections = await readJson<FusionStoryboardGridSelectionStore>(source.storyboardGridSelections, {
    schemaVersion: 1,
    revision: 0,
    items: {},
    updatedAt: new Date(0).toISOString(),
  });
  const generationJobs = await readJson<GenerationJob[]>(source.generationJobs, []);
  const requiredGridContracts = new Map<string, { unitId: string; contractId: string }>();
  for (const [unitId, selection] of Object.entries(selections.items)) {
    requiredGridContracts.set(`${unitId}\0${selection.contractId}`, { unitId, contractId: selection.contractId });
  }
  // 首次 P2 物化还必须读取历史逐格任务绑定的原始内容寻址合同。这里取并集，
  // 不能只复制 1288 个当前选择，否则已淘汰但无输出的安全终态任务无法验真。
  for (const job of generationJobs) {
    if (job.purpose !== "fusion_storyboard_panel" || !job.fusionStoryboardPanel) continue;
    requiredGridContracts.set(`${job.itemId}\0${job.fusionStoryboardPanel.contractId}`, {
      unitId: job.itemId,
      contractId: job.fusionStoryboardPanel.contractId,
    });
  }
  for (const { unitId, contractId } of [...requiredGridContracts.values()]
    .sort((left, right) => left.unitId.localeCompare(right.unitId, "en") || left.contractId.localeCompare(right.contractId, "en"))) {
    if (!/^[\p{L}\p{N}][\p{L}\p{N}._:-]{0,199}$/u.test(unitId) || !/^grid-[a-f0-9]{20}$/u.test(contractId)) {
      throw new Error(`演练所需宫格合同身份不安全：${JSON.stringify({ unitId, contractId })}`);
    }
    const relativePath = path.join("storyboard-grids", unitId, `${contractId}.json`);
    const sourcePath = path.join(source.root, relativePath);
    if (!await exists(sourcePath)) throw new Error(`演练缺少所需内容寻址宫格合同：${sourcePath}`);
    await copyIfPresent(sourcePath, path.join(target.root, relativePath));
  }
  // P2 解析器必须重读隔离工程内 1288 份 Markdown 快照；演练不得
  // 回退到只读原始源目录。production 也一并复制，使任何相对生产路径都在演练根内存在。
  await copyIfPresent(path.join(projectRoot, "source_snapshot"), path.join(rehearsalRoot, "source_snapshot"));
  await copyIfPresent(path.join(projectRoot, "production"), path.join(rehearsalRoot, "production"));
}

async function runRehearsal(
  projectRoot: string,
  expectedSelections: Record<string, FusionStoryboardGridSelection>,
  expectedLegacyJobs: LegacyPanelGenerationJobs,
  keep: boolean,
): Promise<{
  rehearsalRoot: string;
  first: MaterializationSummary;
  second: MaterializationSummary;
  freshReplicaRoot: string;
  freshReplicaFirst: MaterializationSummary;
  freshReplicaSecond: MaterializationSummary;
}> {
  const rehearsalRoot = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-p2-panel-reference-rehearsal-"));
  const freshReplicaRoot = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-p2-panel-reference-rehearsal-replica-"));
  try {
    await prepareRehearsalProject(projectRoot, rehearsalRoot);
    const first = await summarizeMaterialization(rehearsalRoot, await materializeFusionPanelReferenceResolutions(rehearsalRoot), expectedLegacyJobs);
    const second = await summarizeMaterialization(rehearsalRoot, await materializeFusionPanelReferenceResolutions(rehearsalRoot), expectedLegacyJobs);
    assertIdempotent(first, second, "P2 演练");
    assertPreservedSelections(expectedSelections, first.preservedSelections, "P2 演练");
    await prepareRehearsalProject(projectRoot, freshReplicaRoot);
    const freshReplicaFirst = await summarizeMaterialization(
      freshReplicaRoot,
      await materializeFusionPanelReferenceResolutions(freshReplicaRoot),
      expectedLegacyJobs,
    );
    const freshReplicaSecond = await summarizeMaterialization(
      freshReplicaRoot,
      await materializeFusionPanelReferenceResolutions(freshReplicaRoot),
      expectedLegacyJobs,
    );
    assertIdempotent(freshReplicaFirst, freshReplicaSecond, "P2 fresh replica 演练");
    assertPreservedSelections(expectedSelections, freshReplicaFirst.preservedSelections, "P2 fresh replica 演练");
    assertFreshRehearsalDeterminism(first, freshReplicaFirst);
    return {
      rehearsalRoot,
      first,
      second,
      freshReplicaRoot,
      freshReplicaFirst,
      freshReplicaSecond,
    };
  } finally {
    if (!keep) await Promise.all([
      rm(rehearsalRoot, { recursive: true, force: true }),
      rm(freshReplicaRoot, { recursive: true, force: true }),
    ]);
  }
}

async function backupP2Sidecar(
  projectRoot: string,
  evidencePath: string,
): Promise<{ backupRoot: string; files: Array<{ sourcePath: string; backupPath: string; bytes: number; sha256: string }>; gridInventorySha256: string; gridFiles: number }> {
  const sidecar = getSidecarPaths(projectRoot);
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const backupRoot = path.join(sidecar.root, "backups", `p2-panel-reference-${stamp}-before-migration`);
  await mkdir(path.dirname(backupRoot), { recursive: true });
  await mkdir(backupRoot, { recursive: false });
  const candidates = [
    sidecar.config,
    sidecar.index,
    sidecar.overrides,
    sidecar.events,
    sidecar.commandLedger,
    sidecar.storyboards,
    sidecar.productionWorkflow,
    sidecar.fusionProjectManifest,
    sidecar.productionAssets,
    sidecar.continuityTracks,
    sidecar.reviews,
    sidecar.generationJobs,
    sidecar.publications,
    sidecar.storyboardGridSelections,
    sidecar.panelReferenceResolutions,
  ];
  const files: Array<{ sourcePath: string; backupPath: string; bytes: number; sha256: string }> = [];
  for (const sourcePath of candidates) {
    if (!await exists(sourcePath)) continue;
    const sourceBefore = await fileEvidence(sourcePath);
    const backupPath = path.join(backupRoot, path.relative(sidecar.root, sourcePath));
    await mkdir(path.dirname(backupPath), { recursive: true });
    await cp(sourcePath, backupPath, { errorOnExist: true, force: false });
    const [sourceAfter, evidence] = await Promise.all([fileEvidence(sourcePath), fileEvidence(backupPath)]);
    if (sourceBefore.bytes !== sourceAfter.bytes
      || sourceBefore.sha256 !== sourceAfter.sha256
      || sourceBefore.bytes !== evidence.bytes
      || sourceBefore.sha256 !== evidence.sha256) {
      throw new Error(`备份关键 sidecar 期间源文件发生变化或副本不一致：${sourcePath}`);
    }
    files.push({ sourcePath, backupPath, bytes: evidence.bytes, sha256: evidence.sha256 });
  }
  const selected = await readJson<FusionStoryboardGridSelectionStore>(sidecar.storyboardGridSelections, {
    schemaVersion: 1,
    revision: 0,
    items: {},
    updatedAt: new Date(0).toISOString(),
  });
  for (const [unitId, selection] of Object.entries(selected.items)) {
    const sourcePath = path.join(sidecar.storyboardGrids, unitId, `${selection.contractId}.json`);
    if (!await exists(sourcePath)) continue;
    const sourceBefore = await fileEvidence(sourcePath);
    const backupPath = path.join(backupRoot, "storyboard-grids", unitId, `${selection.contractId}.json`);
    await mkdir(path.dirname(backupPath), { recursive: true });
    await cp(sourcePath, backupPath, { errorOnExist: true, force: false });
    const [sourceAfter, evidence] = await Promise.all([fileEvidence(sourcePath), fileEvidence(backupPath)]);
    if (sourceBefore.bytes !== sourceAfter.bytes
      || sourceBefore.sha256 !== sourceAfter.sha256
      || sourceBefore.bytes !== evidence.bytes
      || sourceBefore.sha256 !== evidence.sha256) {
      throw new Error(`备份当前宫格合同期间源文件发生变化或副本不一致：${sourcePath}`);
    }
    files.push({ sourcePath, backupPath, bytes: evidence.bytes, sha256: evidence.sha256 });
  }
  const gridRelativePaths = (await fg("**/*.json", {
    cwd: sidecar.storyboardGrids,
    onlyFiles: true,
    followSymbolicLinks: false,
  })).sort((left, right) => left.localeCompare(right, "en"));
  const gridInventorySha256 = sha256((await Promise.all(gridRelativePaths.map(async (relativePath) => {
    const absolutePath = path.join(sidecar.storyboardGrids, ...relativePath.split("/"));
    const before = await stat(absolutePath);
    const fileSha256 = await sha256File(absolutePath);
    const after = await stat(absolutePath);
    if (!before.isFile()
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs) {
      throw new Error(`冻结迁移前宫格清单期间文件发生变化：${absolutePath}`);
    }
    return `${relativePath}\0${fileSha256}`;
  }))).join("\n"));
  const manifest = {
    schemaVersion: 1,
    kind: "p2-panel-reference-sidecar-backup",
    createdAt: new Date().toISOString(),
    projectRoot,
    futureEvidencePath: evidencePath,
    files,
    gridInventory: { files: gridRelativePaths.length, sha256: gridInventorySha256 },
    rollbackNote: "备份保留 P2 可改写状态、P1 保护账与原当前合同；新内容寻址合同可由 gridInventory 识别，不会覆盖旧合同。",
  };
  await writeFile(path.join(backupRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  return { backupRoot, files, gridInventorySha256, gridFiles: gridRelativePaths.length };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(usage());
    return;
  }
  const options = parseOptions(argv);
  await assertSafeEvidencePath(options.workspace, options.projectRoot, options.sourceRoot, options.evidencePath);
  const sidecar = getSidecarPaths(options.projectRoot);
  if (options.apply && await exists(options.evidencePath)) throw new Error(`迁移证据已存在，拒绝覆盖：${options.evidencePath}`);

  const [sourceBefore, protectedBefore, selectionsBefore, formalP2Before] = await Promise.all([
    sourceSnapshot(options.sourceRoot),
    protectedSnapshot(options.projectRoot),
    readJson<FusionStoryboardGridSelectionStore>(sidecar.storyboardGridSelections, {
      schemaVersion: 1,
      revision: 0,
      items: {},
      updatedAt: new Date(0).toISOString(),
    }),
    formalP2Snapshot(options.projectRoot),
  ]);
  assertSource(sourceBefore, "迁移前");
  const preservedBefore = selectedIdentity(selectionsBefore);

  process.stderr.write("[P2 migration] 正在 /tmp 执行两份 fresh 副本、每份两次物化演练…\n");
  const rehearsal = await runRehearsal(
    options.projectRoot,
    preservedBefore,
    protectedBefore.legacyPanelGenerationJobs,
    options.keepRehearsal,
  );
  const [sourceAfterRehearsal, protectedAfterRehearsal, formalP2AfterRehearsal] = await Promise.all([
    sourceSnapshot(options.sourceRoot),
    protectedSnapshot(options.projectRoot),
    formalP2Snapshot(options.projectRoot),
  ]);
  assertSource(sourceAfterRehearsal, "演练后");
  if (JSON.stringify(sourceAfterRehearsal) !== JSON.stringify(sourceBefore)) throw new Error("演练期间第三季只读源发生变化。");
  if (protectedIdentity(protectedAfterRehearsal) !== protectedIdentity(protectedBefore)) throw new Error("演练改写了正式 P1 受保护状态。");
  if (JSON.stringify(formalP2AfterRehearsal) !== JSON.stringify(formalP2Before)) throw new Error("演练改写了正式 P2 selection/resolution/grid 状态。");

  const rehearsalSummary = {
    root: options.keepRehearsal ? rehearsal.rehearsalRoot : "deleted-after-success",
    first: rehearsal.first,
    second: rehearsal.second,
    freshReplica: {
      root: options.keepRehearsal ? rehearsal.freshReplicaRoot : "deleted-after-success",
      first: rehearsal.freshReplicaFirst,
      second: rehearsal.freshReplicaSecond,
    },
    idempotent: true,
    freshCopiesShareStoreFingerprint: true,
    formalProjectUnchanged: true,
  };
  if (!options.apply) {
    process.stdout.write(`${JSON.stringify({
      schemaVersion: 1,
      kind: "p2-panel-reference-migration-dry-run",
      apply: false,
      projectRoot: options.projectRoot,
      sourceRoot: options.sourceRoot,
      source: sourceBefore,
      protectedP1: {
        generationCounts: protectedBefore.generationCounts,
        publicationCounts: protectedBefore.publicationCounts,
        reviewCount: protectedBefore.reviewCount,
        rawLabeledFiles: protectedBefore.rawLabeled.length,
        identitySha256: protectedIdentity(protectedBefore),
        legacyPanelGenerationJobs: protectedBefore.legacyPanelGenerationJobs,
        legacyPanelArtifacts: protectedBefore.legacyPanelArtifacts,
        legacyPanelReviews: protectedBefore.legacyPanelReviews,
      },
      legacyGenerationJobWhitelist: {
        expected: protectedBefore.legacyPanelGenerationJobs,
        rehearsalFirst: rehearsal.first.legacyGenerationJobIds,
        rehearsalSecond: rehearsal.second.legacyGenerationJobIds,
        freshReplicaFirst: rehearsal.freshReplicaFirst.legacyGenerationJobIds,
        freshReplicaSecond: rehearsal.freshReplicaSecond.legacyGenerationJobIds,
        resolutionEvidence: {
          rehearsalFirst: {
            items: rehearsal.first.legacyGenerationJobEvidence,
            sha256: rehearsal.first.legacyGenerationJobEvidenceSha256,
            kinds: rehearsal.first.legacyGenerationJobEvidenceKinds,
          },
          rehearsalSecond: {
            items: rehearsal.second.legacyGenerationJobEvidence,
            sha256: rehearsal.second.legacyGenerationJobEvidenceSha256,
            kinds: rehearsal.second.legacyGenerationJobEvidenceKinds,
          },
          freshReplicaFirst: {
            items: rehearsal.freshReplicaFirst.legacyGenerationJobEvidence,
            sha256: rehearsal.freshReplicaFirst.legacyGenerationJobEvidenceSha256,
            kinds: rehearsal.freshReplicaFirst.legacyGenerationJobEvidenceKinds,
          },
          freshReplicaSecond: {
            items: rehearsal.freshReplicaSecond.legacyGenerationJobEvidence,
            sha256: rehearsal.freshReplicaSecond.legacyGenerationJobEvidenceSha256,
            kinds: rehearsal.freshReplicaSecond.legacyGenerationJobEvidenceKinds,
          },
        },
        immutable: true,
      },
      formalP2: { before: formalP2Before, after: formalP2AfterRehearsal, unchanged: true },
      preservedSelections: preservedBefore,
      rehearsal: rehearsalSummary,
      next: "仅在确认演练证据后显式追加 --apply；本次未改写正式工程。",
    }, null, 2)}\n`);
    return;
  }

  process.stderr.write("[P2 migration] 演练通过，正在备份 P2 sidecar 状态…\n");
  const backup = await backupP2Sidecar(options.projectRoot, options.evidencePath);
  const commandEnvelope = {
    requestId: "p2-panel-reference-materialization-20260717-request-v2-contract-coverage",
    idempotencyKey: "p2-panel-reference-materialization-20260717-v2-contract-coverage",
    request: { command: "materialize_fusion_panel_references" as const, payload: {} },
  };
  const firstCommand = await executeIdempotentCommand(options.projectRoot, commandEnvelope);
  if (firstCommand.status !== "succeeded") throw new Error(`P2 正式物化命令未成功：${firstCommand.status}`);
  const firstStore = await loadFusionPanelReferenceStore(options.projectRoot);
  if (!firstStore) throw new Error("P2 命令返回成功但正式 resolution store 未落盘。");
  const first = await summarizeMaterialization(options.projectRoot, firstStore, protectedBefore.legacyPanelGenerationJobs);
  assertPreservedSelections(preservedBefore, first.preservedSelections, "P2 正式物化");

  // 物化完成后必须重新投影索引，令后续新增的 P2 任务 Artifact/Review
  // 能携带冻结身份；历史任务则继续只由旁路 evidence 解释，绝不改写旧 Job/Artifact/Review。
  const indexBeforeScan = await fileEvidence(sidecar.index);
  const scan = await scanAndPersist(options.projectRoot, { includeHashes: true });
  const [indexAfterScan, persistedIndexAfterScan, protectedAfterScan, currentnessAfterScan] = await Promise.all([
    fileEvidence(sidecar.index),
    readJson<ProjectIndex | null>(sidecar.index, null),
    protectedSnapshot(options.projectRoot),
    inspectFusionPanelReferenceCurrentness(options.projectRoot, {
      verifyAllContractFiles: true,
      verifyAllUnitMarkdowns: true,
    }),
  ]);
  if (!persistedIndexAfterScan
    || persistedIndexAfterScan.scanId !== scan.scanId
    || indexBeforeScan.sha256 === indexAfterScan.sha256) {
    throw new Error("P2 正式物化后的 scanAndPersist 没有形成可验证的新索引投影。");
  }
  if (!currentnessAfterScan.current
    || currentnessAfterScan.storeRevision !== first.revision
    || currentnessAfterScan.storeFingerprint !== first.storeFingerprint
    || currentnessAfterScan.driftedInputs.length) {
    throw new Error(`P2 正式索引投影后引用仓不再 current：${JSON.stringify(currentnessAfterScan)}`);
  }
  if (protectedIdentity(protectedAfterScan) !== protectedIdentity(protectedBefore)) {
    throw new Error("P2 正式索引投影改写了历史 Job/Artifact/Review 或其他 P1 受保护状态。");
  }

  const secondCommand = await executeIdempotentCommand(options.projectRoot, commandEnvelope);
  if (secondCommand.status !== "succeeded" || !secondCommand.replayed) {
    throw new Error(`P2 相同幂等键未安全重放：${JSON.stringify({ status: secondCommand.status, replayed: secondCommand.replayed })}`);
  }
  const secondStore = await loadFusionPanelReferenceStore(options.projectRoot);
  if (!secondStore) throw new Error("P2 幂等重放后 resolution store 消失。");
  const second = await summarizeMaterialization(options.projectRoot, secondStore, protectedBefore.legacyPanelGenerationJobs);
  assertIdempotent(first, second, "P2 正式迁移");
  assertPreservedSelections(preservedBefore, second.preservedSelections, "P2 正式二次物化");

  const [sourceAfter, protectedAfter, formalP2After] = await Promise.all([
    sourceSnapshot(options.sourceRoot),
    protectedSnapshot(options.projectRoot),
    formalP2Snapshot(options.projectRoot),
  ]);
  assertSource(sourceAfter, "迁移后");
  if (JSON.stringify(sourceAfter) !== JSON.stringify(sourceBefore)) throw new Error("正式迁移期间第三季只读源发生变化。");
  if (protectedIdentity(protectedAfter) !== protectedIdentity(protectedBefore)) {
    throw new Error(`P2 迁移改变了 P1 jobs/publications/reviews/raw/labeled/unknown；备份位于 ${backup.backupRoot}`);
  }

  const evidence = {
    schemaVersion: 1,
    kind: "p2-panel-reference-migration",
    createdAt: new Date().toISOString(),
    apply: true,
    workspace: options.workspace,
    projectRoot: options.projectRoot,
    sourceRoot: options.sourceRoot,
    source: { before: sourceBefore, after: sourceAfter, unchanged: true },
    protectedP1: {
      before: protectedBefore,
      after: protectedAfter,
      identitySha256: protectedIdentity(protectedAfter),
      unchanged: true,
      unknownJobRetryForbidden: true,
    },
    preservedSelections: { before: preservedBefore, after: second.preservedSelections, unchanged: true },
    legacyGenerationJobWhitelist: {
      expected: protectedBefore.legacyPanelGenerationJobs,
      rehearsalFirst: rehearsal.first.legacyGenerationJobIds,
      rehearsalSecond: rehearsal.second.legacyGenerationJobIds,
      freshReplicaFirst: rehearsal.freshReplicaFirst.legacyGenerationJobIds,
      freshReplicaSecond: rehearsal.freshReplicaSecond.legacyGenerationJobIds,
      formalFirst: first.legacyGenerationJobIds,
      formalSecond: second.legacyGenerationJobIds,
      resolutionEvidence: {
        rehearsalFirst: {
          items: rehearsal.first.legacyGenerationJobEvidence,
          sha256: rehearsal.first.legacyGenerationJobEvidenceSha256,
          kinds: rehearsal.first.legacyGenerationJobEvidenceKinds,
        },
        rehearsalSecond: {
          items: rehearsal.second.legacyGenerationJobEvidence,
          sha256: rehearsal.second.legacyGenerationJobEvidenceSha256,
          kinds: rehearsal.second.legacyGenerationJobEvidenceKinds,
        },
        freshReplicaFirst: {
          items: rehearsal.freshReplicaFirst.legacyGenerationJobEvidence,
          sha256: rehearsal.freshReplicaFirst.legacyGenerationJobEvidenceSha256,
          kinds: rehearsal.freshReplicaFirst.legacyGenerationJobEvidenceKinds,
        },
        freshReplicaSecond: {
          items: rehearsal.freshReplicaSecond.legacyGenerationJobEvidence,
          sha256: rehearsal.freshReplicaSecond.legacyGenerationJobEvidenceSha256,
          kinds: rehearsal.freshReplicaSecond.legacyGenerationJobEvidenceKinds,
        },
        formalFirst: {
          items: first.legacyGenerationJobEvidence,
          sha256: first.legacyGenerationJobEvidenceSha256,
          kinds: first.legacyGenerationJobEvidenceKinds,
        },
        formalSecond: {
          items: second.legacyGenerationJobEvidence,
          sha256: second.legacyGenerationJobEvidenceSha256,
          kinds: second.legacyGenerationJobEvidenceKinds,
        },
      },
      immutable: true,
    },
    rehearsal: rehearsalSummary,
    backup,
    command: {
      requestId: firstCommand.requestId,
      idempotencyKey: firstCommand.idempotencyKey,
      requestHash: firstCommand.requestHash,
      first: { status: firstCommand.status, replayed: firstCommand.replayed },
      second: { status: secondCommand.status, replayed: secondCommand.replayed },
    },
    scanProjection: {
      scanId: scan.scanId,
      scannedAt: scan.scannedAt,
      summary: scan.summary,
      scanStats: scan.scanStats,
      itemCount: scan.items.length,
      artifactCount: scan.artifacts.length,
      warningCount: scan.warnings.length,
      index: { before: indexBeforeScan, after: indexAfterScan, changed: true },
      currentness: currentnessAfterScan,
      legacyPanelArtifacts: {
        before: protectedBefore.legacyPanelArtifacts,
        after: protectedAfterScan.legacyPanelArtifacts,
        unchanged: true,
      },
      legacyPanelReviews: {
        before: protectedBefore.legacyPanelReviews,
        after: protectedAfterScan.legacyPanelReviews,
        unchanged: true,
      },
      reviews: {
        before: protectedBefore.reviews,
        after: protectedAfterScan.reviews,
        unchanged: true,
      },
      p1ProtectedIdentityUnchanged: true,
    },
    formal: { first, second, idempotent: true },
    formalP2: { before: formalP2Before, after: formalP2After },
    assertions: {
      rehearsalFirst: true,
      twoFreshRehearsalsShareStoreFingerprint: true,
      sourceBaselineExactAndUnchanged: true,
      p1JobsPublicationsReviewsRawLabeledUnknownUnchanged: true,
      ep01Unit001And008SelectionIdentityPreserved: true,
      legacyPanelGenerationJobWhitelistFrozenFromLivePreMigrationLedger: true,
      legacyPanelGenerationJobWhitelistImmutableAcrossRehearsalAndFormalReplay: true,
      everyLegacyPanelJobHasFrozenUnifiedLedgerEvidence: true,
      legacyEvidenceDistribution10CurrentResolution1ObsoleteTerminal: true,
      postMaterializationIndexProjectionPersistedAndCurrent: true,
      legacyPanelArtifactsAndReviewsUnchangedAcrossScanProjection: true,
      currentContracts1288: first.audit.currentContracts === 1_288,
      panels4330: first.audit.panels === 4_330,
      panelDistributionExact: JSON.stringify(first.audit.panelDistribution) === JSON.stringify(EXPECTED_DISTRIBUTION),
      fourClosureErrorClassesZero: first.audit.unresolvedPanels === 0
        && first.audit.knownAssetMissingBindings === 0
        && first.audit.unhandledOverflowPanels === 0
        && first.audit.timeSpanContinuityMismatches === 0,
      referenceSlotsAtMostSix: first.audit.maximumReferenceSlotsPerPanel <= 6,
      closurePassed: first.audit.closurePassed,
      secondRunIdempotentWithoutMtimeChange: true,
    },
  };
  await mkdir(path.dirname(options.evidencePath), { recursive: true });
  await writeJsonAtomicExclusive(options.evidencePath, evidence);
  process.stdout.write(`${JSON.stringify({
    evidencePath: options.evidencePath,
    backupRoot: backup.backupRoot,
    audit: first.audit,
    store: { revision: first.revision, fingerprint: first.storeFingerprint, file: first.resolutionFile },
    selections: { revision: first.selectionRevision, count: first.selectionCount, preserved: first.preservedSelections },
    idempotent: true,
    sourceUnchanged: true,
    protectedP1Unchanged: true,
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
