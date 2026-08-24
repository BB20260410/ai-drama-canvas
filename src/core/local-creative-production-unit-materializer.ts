import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { inspectManagedProjectReadOnly } from "./managed-project.js";
import { getLocalCreativeProjectIngestStatus } from "./local-creative-project-ingest-status.js";
import {
  readValidatedExternalDeclaredReferenceMediaSha256,
  readValidatedLocalCreativeImportedMediaIdentityIndex,
} from "./local-creative-project-content-import.js";
import {
  inspectLocalCreativeSourceInventory,
  type LocalCreativeSourceInventoryLayer,
} from "./local-creative-source-inventory.js";
import {
  previewLocalCreativeProductionUnits,
  type LocalCreativeProductionPanelCandidate,
  type LocalCreativeProductionUnitCandidate,
} from "./local-creative-production-unit-preview.js";
import {
  normalizeLocalCreativeUnitSourcePanels,
  prepareLocalCreativeUnitSourceContract,
  readLocalCreativeUnitSourceContract,
  writeLocalCreativeUnitSourceContract,
  type LocalCreativeUnitSourceContract,
  type LocalCreativeUnitSourcePanelContract,
} from "./local-creative-unit-source-contract.js";
import {
  listConfinedJsonSidecarNames,
  readConfinedJsonSidecar,
  writeConfinedJsonSidecarNoReplace,
} from "./confined-json-sidecar.js";
import {
  appendStudioPromptRevision,
  appendStudioScriptRevision,
  createStudioProductionUnit,
  createStudioPromptDocument,
  createStudioScriptDocument,
  getStudioProductionUnitSnapshot,
  listStudioProductionUnits,
  readStudioProductionUnitSnapshotReadOnly,
  readStudioProductionUnitSnapshotForCodex,
  reviseStudioProductionUnit,
  getStudioTextDocument,
  getStudioTextRevision,
  listStudioTextRevisions,
  type StudioProductionUnitSnapshot,
  type StudioTextDocumentKind,
  type StudioTextRevision,
} from "./studio-production.js";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_SELECTED_UNITS = 3;
const MAX_SCRIPT_BYTES = 8 * 1024 * 1024;
const MAX_BOARD_BYTES = 512 * 1024 * 1024;
const MAX_RECEIPT_BYTES = 4 * 1024 * 1024;
const RECEIPT_DIRECTORY = "local-creative-production-unit-materializations";
const MAX_INTENT_BYTES = 64 * 1024;
const INTENT_DIRECTORY = "local-creative-production-unit-materialization-intents";
const MAX_BATCH_JOURNAL_BYTES = 256 * 1024;
const MAX_BATCH_CHECKPOINT_BYTES = 2 * 1024 * 1024;
const BATCH_JOURNAL_DIRECTORY = "local-creative-production-unit-materialization-batches";
const BATCH_CHECKPOINT_DIRECTORY = "local-creative-production-unit-materialization-batch-checkpoints";

export interface MaterializeLocalCreativeProductionUnitsInput {
  idempotencyKey: string;
  expectedPreviewFingerprint: string;
  expectedSourceFingerprint: string;
  candidateIds: string[];
  scopeId?: string;
  adapterKind?: "auto" | "dudu-world-prologue-v1";
}

export interface LocalCreativeProductionUnitMaterializationItem {
  candidateId: string;
  candidateFingerprint: string;
  unitId: string;
  unitRevision?: number;
  unitFingerprint: string;
  disposition: "created" | "reused" | "revised" | "recovered";
  scriptRevisionId: string;
  promptRevisionIds: string[];
  sourceSoundAndText: Array<{
    panelId: string;
    value: string;
  }>;
  sourceContractFingerprint: string;
  /** 合同创建时的项目来源快照；允许与本次全局快照不同，但必须显式记录。 */
  sourceContractSourceFingerprint?: string;
  existingBoard?: LocalCreativeProductionUnitCandidate["existingBoard"];
}

export interface LocalCreativeProductionUnitMaterializationReceipt {
  schemaVersion: 1;
  kind: "local-creative-production-unit-materialization-receipt";
  idempotencyKey: string;
  requestHash: string;
  projectRoot: string;
  previewFingerprint: string;
  sourceFingerprint: string;
  adapterId: "dudu-world-prologue-v1";
  scopeId: string;
  units: LocalCreativeProductionUnitMaterializationItem[];
  /**
   * current 表示提交回执时来源仍等于已验证快照；stale-after-verified-snapshot
   * 表示受管内容来自已完整验真的快照，但写入期间外部来源又发生了变化。
   * 后者必须重新同步来源后才能继续生产，不能否定已写入的历史内容。
   */
  sourceSnapshotAtCommit?: "current" | "stale-after-verified-snapshot";
  assetBindingReadiness: "blocked-unresolved";
  note: string;
  fingerprint: string;
  createdAt: string;
}

interface LocalCreativeProductionUnitMaterializationBatchJournal {
  schemaVersion: 1;
  kind: "local-creative-production-unit-materialization-batch-journal";
  requestHash: string;
  projectRoot: string;
  previewFingerprint: string;
  sourceFingerprint: string;
  adapterId: "dudu-world-prologue-v1";
  scopeId: string;
  candidates: Array<{
    candidateId: string;
    candidateFingerprint: string;
    unitId: string;
  }>;
  fingerprint: string;
  createdAt: string;
}

interface LocalCreativeProductionUnitMaterializationBatchCheckpoint {
  schemaVersion: 1;
  kind: "local-creative-production-unit-materialization-batch-checkpoint";
  requestHash: string;
  journalFingerprint: string;
  index: number;
  previousCheckpointFingerprint: string | null;
  item: LocalCreativeProductionUnitMaterializationItem;
  fingerprint: string;
  createdAt: string;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([key, entry]) => [key, stable(entry)]));
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stable(value)), "utf8").digest("hex");
}

function assertBatchJournal(
  value: unknown,
  requestHash: string,
): LocalCreativeProductionUnitMaterializationBatchJournal {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("单元批物化 journal 损坏。");
  }
  const journal = value as LocalCreativeProductionUnitMaterializationBatchJournal;
  const actualKeys = Object.keys(journal).sort((left, right) => left.localeCompare(right, "en"));
  const expectedKeys = [
    "schemaVersion",
    "kind",
    "requestHash",
    "projectRoot",
    "previewFingerprint",
    "sourceFingerprint",
    "adapterId",
    "scopeId",
    "candidates",
    "fingerprint",
    "createdAt",
  ].sort((left, right) => left.localeCompare(right, "en"));
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)
    || journal.schemaVersion !== 1
    || journal.kind !== "local-creative-production-unit-materialization-batch-journal"
    || journal.requestHash !== requestHash
    || !path.isAbsolute(journal.projectRoot)
    || !SHA256_PATTERN.test(journal.previewFingerprint)
    || !SHA256_PATTERN.test(journal.sourceFingerprint)
    || journal.adapterId !== "dudu-world-prologue-v1"
    || typeof journal.scopeId !== "string"
    || !journal.scopeId
    || !Array.isArray(journal.candidates)
    || journal.candidates.length < 1
    || journal.candidates.length > MAX_SELECTED_UNITS
    || journal.candidates.some((candidate) => (
      !candidate
      || typeof candidate !== "object"
      || typeof candidate.candidateId !== "string"
      || !SHA256_PATTERN.test(candidate.candidateFingerprint)
      || typeof candidate.unitId !== "string"
      || !candidate.unitId
    ))
    || new Set(journal.candidates.map((candidate) => candidate.candidateId)).size !== journal.candidates.length
    || !SHA256_PATTERN.test(journal.fingerprint)
    || typeof journal.createdAt !== "string"
    || !Number.isFinite(Date.parse(journal.createdAt))
    || new Date(journal.createdAt).toISOString() !== journal.createdAt) {
    throw new Error("单元批物化 journal 结构无效。");
  }
  const { fingerprint: _fingerprint, ...body } = journal;
  if (digest(body) !== journal.fingerprint) {
    throw new Error("单元批物化 journal 指纹无效。");
  }
  return journal;
}

async function ensureBatchJournal(input: {
  projectRoot: string;
  requestHash: string;
  previewFingerprint: string;
  sourceFingerprint: string;
  scopeId: string;
  selected: LocalCreativeProductionUnitCandidate[];
}): Promise<LocalCreativeProductionUnitMaterializationBatchJournal> {
  const fileName = `${input.requestHash}.json`;
  let existing = await readConfinedJsonSidecar<unknown>(
    input.projectRoot,
    BATCH_JOURNAL_DIRECTORY,
    fileName,
    null,
    MAX_BATCH_JOURNAL_BYTES,
  );
  if (existing === null) {
    const body = {
      schemaVersion: 1 as const,
      kind: "local-creative-production-unit-materialization-batch-journal" as const,
      requestHash: input.requestHash,
      projectRoot: input.projectRoot,
      previewFingerprint: input.previewFingerprint,
      sourceFingerprint: input.sourceFingerprint,
      adapterId: "dudu-world-prologue-v1" as const,
      scopeId: input.scopeId,
      candidates: input.selected.map((candidate) => ({
        candidateId: candidate.candidateId,
        candidateFingerprint: candidate.fingerprint,
        unitId: unitId(candidate),
      })),
      createdAt: new Date().toISOString(),
    };
    const journal: LocalCreativeProductionUnitMaterializationBatchJournal = {
      ...body,
      fingerprint: digest(body),
    };
    await writeConfinedJsonSidecarNoReplace(
      input.projectRoot,
      BATCH_JOURNAL_DIRECTORY,
      fileName,
      journal,
      MAX_BATCH_JOURNAL_BYTES,
    );
    existing = await readConfinedJsonSidecar<unknown>(
      input.projectRoot,
      BATCH_JOURNAL_DIRECTORY,
      fileName,
      null,
      MAX_BATCH_JOURNAL_BYTES,
    );
  }
  const journal = assertBatchJournal(existing, input.requestHash);
  const expectedSemantic = {
    projectRoot: input.projectRoot,
    previewFingerprint: input.previewFingerprint,
    sourceFingerprint: input.sourceFingerprint,
    adapterId: "dudu-world-prologue-v1",
    scopeId: input.scopeId,
    candidates: input.selected.map((candidate) => ({
      candidateId: candidate.candidateId,
      candidateFingerprint: candidate.fingerprint,
      unitId: unitId(candidate),
    })),
  };
  const actualSemantic = {
    projectRoot: journal.projectRoot,
    previewFingerprint: journal.previewFingerprint,
    sourceFingerprint: journal.sourceFingerprint,
    adapterId: journal.adapterId,
    scopeId: journal.scopeId,
    candidates: journal.candidates,
  };
  if (JSON.stringify(stable(actualSemantic)) !== JSON.stringify(stable(expectedSemantic))) {
    throw new Error("MATERIALIZATION_BATCH_CONFLICT：批 journal 与当前请求身份不一致。");
  }
  return journal;
}

function checkpointFileName(requestHash: string, index: number): string {
  return `${requestHash}-${String(index + 1).padStart(4, "0")}.json`;
}

function assertBatchCheckpoint(
  value: unknown,
  journal: LocalCreativeProductionUnitMaterializationBatchJournal,
  index: number,
  previousCheckpointFingerprint: string | null,
): LocalCreativeProductionUnitMaterializationBatchCheckpoint {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("单元批物化 checkpoint 损坏。");
  }
  const checkpoint = value as LocalCreativeProductionUnitMaterializationBatchCheckpoint;
  const actualKeys = Object.keys(checkpoint).sort((left, right) => left.localeCompare(right, "en"));
  const expectedKeys = [
    "schemaVersion",
    "kind",
    "requestHash",
    "journalFingerprint",
    "index",
    "previousCheckpointFingerprint",
    "item",
    "fingerprint",
    "createdAt",
  ].sort((left, right) => left.localeCompare(right, "en"));
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)
    || checkpoint.schemaVersion !== 1
    || checkpoint.kind !== "local-creative-production-unit-materialization-batch-checkpoint"
    || checkpoint.requestHash !== journal.requestHash
    || checkpoint.journalFingerprint !== journal.fingerprint
    || checkpoint.index !== index
    || checkpoint.previousCheckpointFingerprint !== previousCheckpointFingerprint
    || !checkpoint.item
    || typeof checkpoint.item !== "object"
    || typeof checkpoint.item.candidateId !== "string"
    || !SHA256_PATTERN.test(checkpoint.item.candidateFingerprint)
    || typeof checkpoint.item.unitId !== "string"
    || !SHA256_PATTERN.test(checkpoint.item.unitFingerprint)
    || !SHA256_PATTERN.test(checkpoint.item.sourceContractFingerprint)
    || !SHA256_PATTERN.test(checkpoint.fingerprint)
    || typeof checkpoint.createdAt !== "string"
    || !Number.isFinite(Date.parse(checkpoint.createdAt))
    || new Date(checkpoint.createdAt).toISOString() !== checkpoint.createdAt) {
    throw new Error("单元批物化 checkpoint 结构无效。");
  }
  const { fingerprint: _fingerprint, ...body } = checkpoint;
  if (digest(body) !== checkpoint.fingerprint) {
    throw new Error("单元批物化 checkpoint 指纹无效。");
  }
  return checkpoint;
}

async function readBatchCheckpoints(
  projectRoot: string,
  journal: LocalCreativeProductionUnitMaterializationBatchJournal,
): Promise<LocalCreativeProductionUnitMaterializationBatchCheckpoint[]> {
  const names = (await listConfinedJsonSidecarNames(projectRoot, BATCH_CHECKPOINT_DIRECTORY))
    .filter((name) => name.startsWith(`${journal.requestHash}-`) && name.endsWith(".json"))
    .sort((left, right) => left.localeCompare(right, "en"));
  if (names.length > journal.candidates.length
    || names.some((name, index) => name !== checkpointFileName(journal.requestHash, index))) {
    throw new Error("MATERIALIZATION_BATCH_CONFLICT：批 checkpoint 不连续或含额外记录。");
  }
  const checkpoints: LocalCreativeProductionUnitMaterializationBatchCheckpoint[] = [];
  let previousCheckpointFingerprint: string | null = null;
  for (const [index, name] of names.entries()) {
    const raw = await readConfinedJsonSidecar<unknown>(
      projectRoot,
      BATCH_CHECKPOINT_DIRECTORY,
      name,
      null,
      MAX_BATCH_CHECKPOINT_BYTES,
    );
    const checkpoint = assertBatchCheckpoint(raw, journal, index, previousCheckpointFingerprint);
    checkpoints.push(checkpoint);
    previousCheckpointFingerprint = checkpoint.fingerprint;
  }
  return checkpoints;
}

async function writeBatchCheckpoint(
  projectRoot: string,
  journal: LocalCreativeProductionUnitMaterializationBatchJournal,
  index: number,
  previousCheckpointFingerprint: string | null,
  item: LocalCreativeProductionUnitMaterializationItem,
): Promise<LocalCreativeProductionUnitMaterializationBatchCheckpoint> {
  const fileName = checkpointFileName(journal.requestHash, index);
  const existing = await readConfinedJsonSidecar<unknown>(
    projectRoot,
    BATCH_CHECKPOINT_DIRECTORY,
    fileName,
    null,
    MAX_BATCH_CHECKPOINT_BYTES,
  );
  if (existing !== null) {
    const checkpoint = assertBatchCheckpoint(existing, journal, index, previousCheckpointFingerprint);
    if (JSON.stringify(stable(checkpoint.item)) !== JSON.stringify(stable(item))) {
      throw new Error(`MATERIALIZATION_BATCH_CONFLICT：第 ${index + 1} 项 checkpoint 已绑定不同结果。`);
    }
    return checkpoint;
  }
  const body = {
    schemaVersion: 1 as const,
    kind: "local-creative-production-unit-materialization-batch-checkpoint" as const,
    requestHash: journal.requestHash,
    journalFingerprint: journal.fingerprint,
    index,
    previousCheckpointFingerprint,
    item,
    createdAt: new Date().toISOString(),
  };
  const checkpoint: LocalCreativeProductionUnitMaterializationBatchCheckpoint = {
    ...body,
    fingerprint: digest(body),
  };
  await writeConfinedJsonSidecarNoReplace(
    projectRoot,
    BATCH_CHECKPOINT_DIRECTORY,
    fileName,
    checkpoint,
    MAX_BATCH_CHECKPOINT_BYTES,
  );
  const persisted = await readConfinedJsonSidecar<unknown>(
    projectRoot,
    BATCH_CHECKPOINT_DIRECTORY,
    fileName,
    null,
    MAX_BATCH_CHECKPOINT_BYTES,
  );
  return assertBatchCheckpoint(persisted, journal, index, previousCheckpointFingerprint);
}

interface LocalCreativeProductionUnitMaterializationIntent {
  schemaVersion: 1;
  kind: "local-creative-production-unit-materialization-intent";
  unitId: string;
  unitRevision: number;
  candidateId: string;
  candidateFingerprint: string;
  sourceFingerprint: string;
  sourceContractFingerprint: string;
  /** 首次冻结该语义操作的请求，仅作审计；不参与后续同语义接管判断。 */
  firstRequestHash: string;
  /** 与请求/幂等键无关的稳定操作身份。 */
  semanticFingerprint: string;
  fingerprint: string;
  createdAt: string;
}

type LocalCreativeProductionUnitMaterializationIntentSemanticBody = Omit<
  LocalCreativeProductionUnitMaterializationIntent,
  "firstRequestHash" | "semanticFingerprint" | "fingerprint" | "createdAt"
>;

function assertMaterializationIntent(value: unknown): LocalCreativeProductionUnitMaterializationIntent {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("单元物化意图损坏。");
  }
  const intent = value as LocalCreativeProductionUnitMaterializationIntent;
  const actualKeys = Object.keys(intent).sort((left, right) => left.localeCompare(right, "en"));
  const expectedKeys = [
    "schemaVersion",
    "kind",
    "unitId",
    "unitRevision",
    "candidateId",
    "candidateFingerprint",
    "sourceFingerprint",
    "sourceContractFingerprint",
    "firstRequestHash",
    "semanticFingerprint",
    "fingerprint",
    "createdAt",
  ].sort((left, right) => left.localeCompare(right, "en"));
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)
    || intent.schemaVersion !== 1
    || intent.kind !== "local-creative-production-unit-materialization-intent"
    || !intent.unitId
    || !intent.candidateId
    || !Number.isSafeInteger(intent.unitRevision)
    || intent.unitRevision < 1
    || !SHA256_PATTERN.test(intent.candidateFingerprint)
    || !SHA256_PATTERN.test(intent.sourceFingerprint)
    || !SHA256_PATTERN.test(intent.sourceContractFingerprint)
    || !SHA256_PATTERN.test(intent.firstRequestHash)
    || !SHA256_PATTERN.test(intent.semanticFingerprint)
    || !SHA256_PATTERN.test(intent.fingerprint)
    || typeof intent.createdAt !== "string"
    || !Number.isFinite(Date.parse(intent.createdAt))
    || new Date(intent.createdAt).toISOString() !== intent.createdAt) {
    throw new Error("单元物化意图结构无效。");
  }
  const {
    fingerprint: _fingerprint,
    createdAt: _createdAt,
    firstRequestHash: _firstRequestHash,
    semanticFingerprint: _semanticFingerprint,
    ...semanticBody
  } = intent;
  if (digest(semanticBody) !== intent.semanticFingerprint) {
    throw new Error("单元物化意图语义指纹无效。");
  }
  const { fingerprint: _ignored, createdAt: _ignoredAt, ...body } = intent;
  if (digest(body) !== intent.fingerprint) throw new Error("单元物化意图指纹无效。");
  return intent;
}

async function ensureMaterializationIntent(
  projectRoot: string,
  expectedSemanticBody: LocalCreativeProductionUnitMaterializationIntentSemanticBody,
  requestHash: string,
  allowCreate: boolean,
): Promise<LocalCreativeProductionUnitMaterializationIntent> {
  const semanticFingerprint = digest(expectedSemanticBody);
  const fileName = `${expectedSemanticBody.unitId}-r${expectedSemanticBody.unitRevision}-${semanticFingerprint}.json`;
  if (!allowCreate) {
    const revisionPrefix = `${expectedSemanticBody.unitId}-r${expectedSemanticBody.unitRevision}-`;
    const revisionIntentNames = (await listConfinedJsonSidecarNames(
      projectRoot,
      INTENT_DIRECTORY,
    )).filter((name) => name.startsWith(revisionPrefix) && name.endsWith(".json"));
    if (revisionIntentNames.length !== 1 || revisionIntentNames[0] !== fileName) {
      throw new Error(
        `PARTIAL_COMMIT_CONFLICT：受管单元 ${expectedSemanticBody.unitId} 的当前修订没有唯一写前来源意图。`,
      );
    }
  }
  let existing = await readConfinedJsonSidecar<unknown>(
    projectRoot,
    INTENT_DIRECTORY,
    fileName,
    null,
    MAX_INTENT_BYTES,
  );
  if (existing === null && !allowCreate) {
    throw new Error(
      `PARTIAL_COMMIT_CONFLICT：受管单元 ${expectedSemanticBody.unitId} 缺少写前不可变意图，拒绝为历史修订猜测补写来源合同。`,
    );
  }
  if (existing === null) {
    const intentBody = {
      ...expectedSemanticBody,
      firstRequestHash: requestHash,
      semanticFingerprint,
    };
    const intent: LocalCreativeProductionUnitMaterializationIntent = {
      ...intentBody,
      fingerprint: digest(intentBody),
      createdAt: new Date().toISOString(),
    };
    await writeConfinedJsonSidecarNoReplace(
      projectRoot,
      INTENT_DIRECTORY,
      fileName,
      intent,
      MAX_INTENT_BYTES,
    );
    existing = await readConfinedJsonSidecar<unknown>(
      projectRoot,
      INTENT_DIRECTORY,
      fileName,
      null,
      MAX_INTENT_BYTES,
    );
  }
  const parsed = assertMaterializationIntent(existing);
  if (parsed.semanticFingerprint !== semanticFingerprint) {
    throw new Error(
      `PARTIAL_COMMIT_CONFLICT：受管单元 ${expectedSemanticBody.unitId} 的写前来源闭包与当前请求不同。`,
    );
  }
  return parsed;
}

function requiredText(value: unknown, label: string, max = 500): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} 必须是非空字符串。`);
  const normalized = value.trim();
  if (normalized.length > max) throw new Error(`${label} 不能超过 ${max} 个字符。`);
  return normalized;
}

function requiredSha(value: unknown, label: string): string {
  const normalized = requiredText(value, label, 64).toLowerCase();
  if (!SHA256_PATTERN.test(normalized)) throw new Error(`${label} 必须是 SHA-256。`);
  return normalized;
}

function normalizeInput(input: MaterializeLocalCreativeProductionUnitsInput) {
  const idempotencyKey = requiredText(input.idempotencyKey, "idempotencyKey", 200);
  const candidateIds = [...new Set((input.candidateIds ?? []).map((value, index) =>
    requiredText(value, `candidateIds[${index}]`, 255),
  ))].sort((left, right) => left.localeCompare(right, "en"));
  if (!candidateIds.length || candidateIds.length > MAX_SELECTED_UNITS) {
    throw new Error(`candidateIds 必须包含 1-${MAX_SELECTED_UNITS} 个不重复单元。`);
  }
  const scopeId = input.scopeId === undefined
    ? "world-prologue"
    : requiredText(input.scopeId, "scopeId", 200);
  const adapterKind = input.adapterKind ?? "auto";
  if (adapterKind !== "auto" && adapterKind !== "dudu-world-prologue-v1") {
    throw new Error("adapterKind 不受支持。");
  }
  return {
    idempotencyKey,
    expectedPreviewFingerprint: requiredSha(input.expectedPreviewFingerprint, "expectedPreviewFingerprint"),
    expectedSourceFingerprint: requiredSha(input.expectedSourceFingerprint, "expectedSourceFingerprint"),
    candidateIds,
    scopeId,
    adapterKind,
  } as const;
}

async function readSourceText(
  sourceRoot: string,
  relativePath: string,
  expectedSha256: string,
): Promise<string> {
  const rootReal = await realpath(sourceRoot);
  const targetReal = await realpath(path.resolve(rootReal, relativePath));
  const relative = path.relative(rootReal, targetReal);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`来源文本越界：${relativePath}`);
  }
  const metadata = await lstat(targetReal);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0 || metadata.size > MAX_SCRIPT_BYTES) {
    throw new Error(`来源文本不是有界普通文件：${relativePath}`);
  }
  const bytes = await readFile(targetReal);
  const actualSha256 = createHash("sha256").update(bytes).digest("hex");
  if (actualSha256 !== expectedSha256) {
    throw new Error(`SOURCE_FINGERPRINT_CONFLICT：${relativePath} 内容已变化。`);
  }
  return bytes.toString("utf8");
}

async function verifySourceFile(
  sourceRoot: string,
  relativePath: string,
  expectedSha256: string,
  maximumBytes: number,
): Promise<void> {
  const rootReal = await realpath(sourceRoot);
  const targetReal = await realpath(path.resolve(rootReal, relativePath));
  const relative = path.relative(rootReal, targetReal);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`来源证据越界：${relativePath}`);
  }
  const metadata = await lstat(targetReal);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0 || metadata.size > maximumBytes) {
    throw new Error(`来源证据不是有界普通文件：${relativePath}`);
  }
  const bytes = await readFile(targetReal);
  const after = await lstat(targetReal);
  if (!after.isFile() || after.isSymbolicLink()
    || after.size !== metadata.size
    || Math.trunc(after.mtimeMs) !== Math.trunc(metadata.mtimeMs)) {
    throw new Error(`SOURCE_RACE_DETECTED：${relativePath} 在证据读取期间发生变化。`);
  }
  const actualSha256 = createHash("sha256").update(bytes).digest("hex");
  if (actualSha256 !== expectedSha256) {
    throw new Error(`SOURCE_FINGERPRINT_CONFLICT：${relativePath} 内容已变化。`);
  }
}

async function verifyPreviewEvidence(
  sourceRoot: string,
  preview: Awaited<ReturnType<typeof previewLocalCreativeProductionUnits>>,
  selected: LocalCreativeProductionUnitCandidate[],
): Promise<void> {
  const evidence = new Map<string, { sha256: string; maximumBytes: number }>();
  for (const item of preview.evidence) {
    evidence.set(item.relativePath, { sha256: item.sha256, maximumBytes: MAX_SCRIPT_BYTES * 2 });
  }
  for (const candidate of selected) {
    if (candidate.existingBoard?.rawRelativePath && candidate.existingBoard.rawSha256) {
      evidence.set(candidate.existingBoard.rawRelativePath, {
        sha256: candidate.existingBoard.rawSha256,
        maximumBytes: MAX_BOARD_BYTES,
      });
    }
    if (candidate.existingBoard?.labeledRelativePath && candidate.existingBoard.labeledSha256) {
      evidence.set(candidate.existingBoard.labeledRelativePath, {
        sha256: candidate.existingBoard.labeledSha256,
        maximumBytes: MAX_BOARD_BYTES,
      });
    }
  }
  for (const [relativePath, item] of [...evidence.entries()]
    .sort(([left], [right]) => left.localeCompare(right, "en"))) {
    await verifySourceFile(sourceRoot, relativePath, item.sha256, item.maximumBytes);
  }
}

function inventoryLayers(
  status: Awaited<ReturnType<typeof getLocalCreativeProjectIngestStatus>>,
): LocalCreativeSourceInventoryLayer[] {
  return status.sourceLayers.map((layer) => ({
    role: layer.role,
    rootPath: layer.root,
    ...(layer.maxDepth === undefined ? {} : { maxDepth: layer.maxDepth }),
    ...(!layer.excludeRelativePrefixes.length ? {} : {
      excludeRelativePrefixes: [...layer.excludeRelativePrefixes],
    }),
  }));
}

async function sourceInventoryMatches(
  layers: LocalCreativeSourceInventoryLayer[],
  expectedFingerprint: string,
): Promise<boolean> {
  const inventory = await inspectLocalCreativeSourceInventory(layers, { cache: false });
  return inventory.fingerprint === expectedFingerprint;
}

function textDocumentId(
  kind: StudioTextDocumentKind,
  title: string,
  bodySha256: string,
): string {
  return `local-${kind}-${digest({ kind, title, bodySha256 }).slice(0, 40)}`;
}

async function findRevisionBySha(
  projectRoot: string,
  documentId: string,
  bodySha256: string,
): Promise<StudioTextRevision | null> {
  let cursor: string | undefined;
  for (let page = 0; page < 20; page += 1) {
    const revisions = await listStudioTextRevisions(projectRoot, { documentId, cursor, limit: 100 });
    for (const metadata of revisions.items) {
      if (metadata.bodySha256 !== bodySha256) continue;
      return getStudioTextRevision(projectRoot, metadata.id);
    }
    if (!revisions.nextCursor) return null;
    cursor = revisions.nextCursor;
  }
  throw new Error(`文档 ${documentId} 修订超过有界检索上限，拒绝猜测。`);
}

async function ensureTextRevision(input: {
  projectRoot: string;
  kind: StudioTextDocumentKind;
  title: string;
  body: string;
  source: string;
  sourceVersion: string;
}): Promise<StudioTextRevision> {
  const bodySha256 = createHash("sha256").update(input.body, "utf8").digest("hex");
  const documentId = textDocumentId(input.kind, input.title, bodySha256);
  let document = await getStudioTextDocument(input.projectRoot, documentId);
  if (!document) {
    document = input.kind === "script"
      ? await createStudioScriptDocument(input.projectRoot, {
        id: documentId,
        title: input.title,
        expectedRevision: 0,
      })
      : await createStudioPromptDocument(input.projectRoot, {
        id: documentId,
        title: input.title,
        expectedRevision: 0,
      });
  }
  if (document.kind !== input.kind || document.title !== input.title) {
    throw new Error(`内容寻址文档 ${documentId} 的类型或标题冲突。`);
  }
  const existing = await findRevisionBySha(input.projectRoot, documentId, bodySha256);
  if (existing) return existing;
  if (document.revision !== 0) {
    throw new Error(`内容寻址文档 ${documentId} 已含不同内容，拒绝追加漂移修订。`);
  }
  const appended = input.kind === "script"
    ? await appendStudioScriptRevision(input.projectRoot, {
      documentId,
      expectedRevision: 0,
      body: input.body,
      source: input.source,
      sourceVersion: input.sourceVersion,
    })
    : await appendStudioPromptRevision(input.projectRoot, {
      documentId,
      expectedRevision: 0,
      body: input.body,
      source: input.source,
      sourceVersion: input.sourceVersion,
    });
  return appended.revision;
}

function panelMatchesCandidate(
  panel: StudioProductionUnitSnapshot["panels"][number],
  candidate: LocalCreativeProductionPanelCandidate,
): boolean {
  return panel.id === candidate.sourcePanelId
    && panel.index === candidate.index
    && panel.title === `${candidate.sourcePanelId}`
    && panel.visualAction === candidate.visualAction
    && panel.shotComposition === candidate.shotComposition
    && panel.filmingMethod === candidate.filmingMethod
    && panel.dialogue === ""
    && panel.subtitle === ""
    && panel.startSeconds === candidate.startSeconds
    && panel.endSeconds === candidate.endSeconds
    && panel.durationSeconds === candidate.durationSeconds
    && panel.promptRevision.bodySha256 === candidate.promptSha256
    && panel.assets.length === 0
    && panel.sourceSpans.length === 1
    && panel.sourceSpans[0]!.startOffsetUtf16 === candidate.sourceSpan.startOffsetUtf16
    && panel.sourceSpans[0]!.endOffsetUtf16 === candidate.sourceSpan.endOffsetUtf16
    && panel.sourceSpans[0]!.surfaceSha256 === candidate.sourceSpan.surfaceSha256;
}

function unitMatchesCandidate(
  snapshot: StudioProductionUnitSnapshot,
  candidate: LocalCreativeProductionUnitCandidate,
): boolean {
  return snapshot.unit.season === candidate.season
    && snapshot.unit.episode === candidate.episode
    && snapshot.unit.sequence === candidate.sequence
    && snapshot.unit.title === candidate.title
    && snapshot.unit.durationSeconds === candidate.durationSeconds
    && snapshot.scriptRevision.bodySha256 === candidate.scriptSha256
    && snapshot.panels.length === candidate.panels.length
    && snapshot.panels.every((panel, index) => panelMatchesCandidate(panel, candidate.panels[index]!));
}

function unitId(candidate: LocalCreativeProductionUnitCandidate): string {
  return `unit-local-${digest({
    adapterId: "dudu-world-prologue-v1",
    candidateId: candidate.candidateId,
  }).slice(0, 40)}`;
}

function productionUnitDraft(
  candidate: LocalCreativeProductionUnitCandidate,
  scriptRevisionId: string,
  promptRevisions: StudioTextRevision[],
) {
  return {
    season: candidate.season,
    episode: candidate.episode,
    sequence: candidate.sequence,
    title: candidate.title,
    durationSeconds: candidate.durationSeconds,
    scriptRevisionId,
    panels: candidate.panels.map((panel, index) => ({
      id: panel.sourcePanelId,
      title: panel.sourcePanelId,
      visualAction: panel.visualAction,
      shotComposition: panel.shotComposition,
      filmingMethod: panel.filmingMethod,
      dialogue: "",
      subtitle: "",
      startSeconds: panel.startSeconds,
      endSeconds: panel.endSeconds,
      durationSeconds: panel.durationSeconds,
      promptRevisionId: promptRevisions[index]!.id,
      sourceSpans: [{
        startOffsetUtf16: panel.sourceSpan.startOffsetUtf16,
        endOffsetUtf16: panel.sourceSpan.endOffsetUtf16,
      }],
      assets: [],
      shotType: "original" as const,
    })),
  };
}

type LocalCreativeMaterializationOperation = "create" | "recover" | "revise" | "reuse";

interface PreparedLocalCreativeProductionUnitMaterialization {
  projectRoot: string;
  sourceFingerprint: string;
  candidate: LocalCreativeProductionUnitCandidate;
  scriptBody: string;
  sourceContractPanels: LocalCreativeUnitSourcePanelContract[];
  targetUnitId: string;
  operation: LocalCreativeMaterializationOperation;
  expectedContractRevision: number;
  preparedContract: LocalCreativeUnitSourceContract;
  intentSemanticBody: LocalCreativeProductionUnitMaterializationIntentSemanticBody;
  snapshotFingerprintAtPrepare: string | null;
  sourceContractFingerprintAtPrepare: string | null;
}

async function assertMaterializationSequenceSlotsAvailable(
  projectRoot: string,
  candidates: readonly LocalCreativeProductionUnitCandidate[],
): Promise<void> {
  const requestedOwners = new Map<string, string>();
  for (const candidate of candidates) {
    const targetUnitId = unitId(candidate);
    const slot = JSON.stringify([candidate.season, candidate.episode, candidate.sequence]);
    const requestedOwner = requestedOwners.get(slot);
    if (requestedOwner && requestedOwner !== targetUnitId) {
      throw new Error(
        `MATERIALIZATION_SEQUENCE_CONFLICT：${candidate.season}/${candidate.episode} 的序号 ${candidate.sequence} 被批次内多个单元请求。`,
      );
    }
    requestedOwners.set(slot, targetUnitId);
  }

  const scopes = new Map<string, { season: string; episode: string }>();
  for (const candidate of candidates) {
    scopes.set(JSON.stringify([candidate.season, candidate.episode]), {
      season: candidate.season,
      episode: candidate.episode,
    });
  }
  for (const scope of scopes.values()) {
    let cursor: string | undefined;
    do {
      const page = await listStudioProductionUnits(projectRoot, {
        season: scope.season,
        episode: scope.episode,
        ...(cursor ? { cursor } : {}),
        limit: 100,
      });
      for (const existing of page.items) {
        const slot = JSON.stringify([existing.season, existing.episode, existing.sequence]);
        const requestedOwner = requestedOwners.get(slot);
        if (requestedOwner && requestedOwner !== existing.id) {
          throw new Error(
            `MATERIALIZATION_SEQUENCE_CONFLICT：${existing.season}/${existing.episode} 的序号 ${existing.sequence} 已由 ${existing.id} 使用。`,
          );
        }
      }
      cursor = page.nextCursor;
    } while (cursor);
  }
}

async function prepareMaterializationCandidate(input: {
  projectRoot: string;
  sourceRoot: string;
  sourceFingerprint: string;
  requestHash: string;
  candidate: LocalCreativeProductionUnitCandidate;
}): Promise<PreparedLocalCreativeProductionUnitMaterialization> {
  const scriptBody = await readSourceText(
    input.sourceRoot,
    input.candidate.scriptRelativePath,
    input.candidate.scriptSha256,
  );
  const declaredAbsolutePaths = input.candidate.panels.flatMap((panel) => (
    panel.sourceDeclaredReferencePaths.map((declaredPath) => (
      path.isAbsolute(declaredPath)
        ? path.normalize(declaredPath)
        : path.resolve(input.sourceRoot, declaredPath)
    ))
  ));
  const importedMediaByPath = await readValidatedLocalCreativeImportedMediaIdentityIndex(
    input.projectRoot,
    {
      expectedSourceFingerprint: input.sourceFingerprint,
      sourcePaths: declaredAbsolutePaths,
    },
  );
  // 声明引用可指向内容导入源层之外（独立锁库、另一工程 imports）；这些媒体经
  // 独立导入通道入库，主索引查不到。fallback 用精确 import origin + 现场/CAS
  // 双复验取回身份，同强度 fail-closed；仍取不到才落 null。
  const externalDeclaredSha256ByPath = new Map<string, string>();
  for (const absolutePath of new Set(declaredAbsolutePaths)) {
    if (importedMediaByPath.has(absolutePath)) continue;
    const sha256 = await readValidatedExternalDeclaredReferenceMediaSha256(input.projectRoot, absolutePath);
    if (sha256) externalDeclaredSha256ByPath.set(absolutePath, sha256);
  }
  const sourceContractPanels: LocalCreativeUnitSourcePanelContract[] = normalizeLocalCreativeUnitSourcePanels(
    input.candidate.panels.map((panel) => ({
    panelId: panel.sourcePanelId,
    soundAndText: panel.soundAndText,
    declaredReferences: panel.sourceDeclaredReferencePaths.map((declaredPath) => {
      const absolutePath = path.isAbsolute(declaredPath)
        ? path.normalize(declaredPath)
        : path.resolve(input.sourceRoot, declaredPath);
        return {
          declaredPath,
          importedMediaSha256: importedMediaByPath.get(absolutePath)?.sha256
            ?? externalDeclaredSha256ByPath.get(absolutePath)
            ?? null,
        };
    }),
    })),
  );
  const targetUnitId = unitId(input.candidate);
  const snapshot = await getStudioProductionUnitSnapshot(input.projectRoot, targetUnitId);
  const currentSourceContract = snapshot
    ? await readLocalCreativeUnitSourceContract(input.projectRoot, targetUnitId, snapshot.unit.revision)
    : null;
  const sourceContractMatches = currentSourceContract !== null
    && currentSourceContract.candidateFingerprint === input.candidate.fingerprint
    && JSON.stringify(stable(currentSourceContract.panels)) === JSON.stringify(stable(sourceContractPanels));

  const operation: LocalCreativeMaterializationOperation = !snapshot
    ? "create"
    : !currentSourceContract
      ? "recover"
      : !unitMatchesCandidate(snapshot, input.candidate) || !sourceContractMatches
        ? "revise"
        : "reuse";
  const expectedContractRevision = operation === "create"
    ? 1
    : operation === "revise"
      ? snapshot!.unit.revision + 1
      : snapshot!.unit.revision;
  const preparedContract = operation === "reuse"
    ? currentSourceContract!
    : prepareLocalCreativeUnitSourceContract({
      unitId: targetUnitId,
      unitRevision: expectedContractRevision,
      candidateId: input.candidate.candidateId,
      candidateFingerprint: input.candidate.fingerprint,
      sourceFingerprint: input.sourceFingerprint,
      panels: sourceContractPanels,
    });
  const expectedIntentBody: LocalCreativeProductionUnitMaterializationIntentSemanticBody = {
    schemaVersion: 1,
    kind: "local-creative-production-unit-materialization-intent",
    unitId: targetUnitId,
    unitRevision: expectedContractRevision,
    candidateId: input.candidate.candidateId,
    candidateFingerprint: input.candidate.fingerprint,
    sourceFingerprint: input.sourceFingerprint,
    sourceContractFingerprint: preparedContract.fingerprint,
  };
  if (operation === "recover") {
    if (!unitMatchesCandidate(snapshot!, input.candidate)) {
      throw new Error(
        `PARTIAL_COMMIT_CONFLICT：受管单元 ${targetUnitId} 缺少来源合同且当前内容已变化，拒绝猜测恢复。`,
      );
    }
    // 恢复只能消费在任何 Studio 写入之前已冻结的同一来源闭包。
    // 不允许在看到缺合同后临时补建 intent，否则同路径后来替换的参考图会污染旧 revision。
    await ensureMaterializationIntent(input.projectRoot, expectedIntentBody, input.requestHash, false);
  } else if (operation !== "reuse") {
    // create/revise 在 prepare 阶段只读取同语义 intent（若存在）并验证；缺失时
    // 允许继续，但绝不能在整批所有候选通过之前创建文件。
    const existingIntent = await readConfinedJsonSidecar<unknown>(
      input.projectRoot,
      INTENT_DIRECTORY,
      `${targetUnitId}-r${expectedContractRevision}-${digest(expectedIntentBody)}.json`,
      null,
      MAX_INTENT_BYTES,
    );
    if (existingIntent !== null) {
      const parsed = assertMaterializationIntent(existingIntent);
      if (parsed.semanticFingerprint !== digest(expectedIntentBody)) {
        throw new Error(
          `PARTIAL_COMMIT_CONFLICT：受管单元 ${targetUnitId} 的写前来源闭包与当前请求不同。`,
        );
      }
    }
  }
  return {
    projectRoot: input.projectRoot,
    sourceFingerprint: input.sourceFingerprint,
    candidate: input.candidate,
    scriptBody,
    sourceContractPanels,
    targetUnitId,
    operation,
    expectedContractRevision,
    preparedContract,
    intentSemanticBody: expectedIntentBody,
    snapshotFingerprintAtPrepare: snapshot?.fingerprint ?? null,
    sourceContractFingerprintAtPrepare: currentSourceContract?.fingerprint ?? null,
  };
}

async function commitPreparedMaterializationCandidate(
  prepared: PreparedLocalCreativeProductionUnitMaterialization,
): Promise<LocalCreativeProductionUnitMaterializationItem> {
  const {
    projectRoot,
    sourceFingerprint,
    candidate,
    scriptBody,
    sourceContractPanels,
    targetUnitId,
    operation,
    expectedContractRevision,
    preparedContract,
  } = prepared;
  let snapshot = await getStudioProductionUnitSnapshot(projectRoot, targetUnitId);
  let currentSourceContract = snapshot
    ? await readLocalCreativeUnitSourceContract(projectRoot, targetUnitId, snapshot.unit.revision)
    : null;
  if ((snapshot?.fingerprint ?? null) !== prepared.snapshotFingerprintAtPrepare
    || (currentSourceContract?.fingerprint ?? null) !== prepared.sourceContractFingerprintAtPrepare) {
    throw new Error(
      `MATERIALIZATION_PRECONDITION_CONFLICT：受管单元 ${targetUnitId} 在整批预检后发生变化。`,
    );
  }
  let disposition: LocalCreativeProductionUnitMaterializationItem["disposition"] = "reused";
  let scriptRevision: StudioTextRevision;
  let promptRevisions: StudioTextRevision[];
  if (operation === "reuse" || operation === "recover") {
    if (!snapshot) {
      throw new Error(`MATERIALIZATION_PRECONDITION_CONFLICT：受管单元 ${targetUnitId} 已消失。`);
    }
    scriptRevision = snapshot.scriptRevision;
    promptRevisions = snapshot.panels.map((panel) => panel.promptRevision);
  } else {
    scriptRevision = await ensureTextRevision({
      projectRoot,
      kind: "script",
      title: `${candidate.episode} · 来源分镜剧本`,
      body: scriptBody,
      source: `local-creative-unit:${candidate.scriptRelativePath}`,
      sourceVersion: sourceFingerprint,
    });
    promptRevisions = await Promise.all(candidate.panels.map((panel) => ensureTextRevision({
      projectRoot,
      kind: "prompt",
      title: `${candidate.sourceUnitId} ${panel.sourcePanelId} · 冻结提示词`,
      body: panel.prompt,
      source: `local-creative-unit:${panel.sourcePanelId}`,
      sourceVersion: candidate.fingerprint,
    })));
  }

  if (operation === "create") {
    snapshot = await createStudioProductionUnit(projectRoot, {
      ...productionUnitDraft(candidate, scriptRevision.id, promptRevisions),
      id: targetUnitId,
      expectedRevision: 0,
    });
    disposition = "created";
    currentSourceContract = null;
  } else if (operation === "recover") {
    disposition = "recovered";
  } else if (operation === "revise") {
    snapshot = await reviseStudioProductionUnit(projectRoot, {
      ...productionUnitDraft(candidate, scriptRevision.id, promptRevisions),
      unitId: targetUnitId,
      expectedRevision: snapshot!.unit.revision,
    });
    disposition = "revised";
    currentSourceContract = null;
  }
  if (!snapshot || snapshot.unit.revision !== expectedContractRevision
    || !unitMatchesCandidate(snapshot, candidate)) {
    throw new Error(`受管单元 ${targetUnitId} 已存在但与当前来源候选不一致，拒绝静默修订。`);
  }
  if (process.env.NODE_ENV === "test"
    && process.env.AI_CANVAS_TEST_LOCAL_UNIT_CRASH_BEFORE_SOURCE_CONTRACT === "1") {
    throw new Error("TEST_CRASH_BEFORE_LOCAL_UNIT_SOURCE_CONTRACT");
  }
  const sourceContract = currentSourceContract ?? await writeLocalCreativeUnitSourceContract(projectRoot, {
    unitId: targetUnitId,
    unitRevision: snapshot.unit.revision,
    candidateId: candidate.candidateId,
    candidateFingerprint: candidate.fingerprint,
    sourceFingerprint,
    panels: sourceContractPanels,
  });
  if (sourceContract.fingerprint !== preparedContract.fingerprint) {
    throw new Error(`受管单元 ${targetUnitId} 的来源合同与写前意图不一致。`);
  }
  return {
    candidateId: candidate.candidateId,
    candidateFingerprint: candidate.fingerprint,
    unitId: targetUnitId,
    unitRevision: snapshot.unit.revision,
    unitFingerprint: snapshot.fingerprint,
    disposition,
    scriptRevisionId: scriptRevision.id,
    promptRevisionIds: promptRevisions.map((revision) => revision.id),
    sourceSoundAndText: candidate.panels.map((panel) => ({
      panelId: panel.sourcePanelId,
      value: panel.soundAndText,
    })),
    sourceContractFingerprint: sourceContract.fingerprint,
    sourceContractSourceFingerprint: sourceContract.sourceFingerprint,
    ...(candidate.existingBoard ? { existingBoard: candidate.existingBoard } : {}),
  };
}

async function assertPreparedMaterializationCandidateCurrent(
  prepared: PreparedLocalCreativeProductionUnitMaterialization,
): Promise<void> {
  const snapshot = await getStudioProductionUnitSnapshot(prepared.projectRoot, prepared.targetUnitId);
  const sourceContract = snapshot
    ? await readLocalCreativeUnitSourceContract(
      prepared.projectRoot,
      prepared.targetUnitId,
      snapshot.unit.revision,
    )
    : null;
  if ((snapshot?.fingerprint ?? null) !== prepared.snapshotFingerprintAtPrepare
    || (sourceContract?.fingerprint ?? null) !== prepared.sourceContractFingerprintAtPrepare) {
    throw new Error(
      `MATERIALIZATION_PRECONDITION_CONFLICT：受管单元 ${prepared.targetUnitId} 在整批预检后发生变化。`,
    );
  }
}

function assertReceipt(value: unknown, requestHash: string): LocalCreativeProductionUnitMaterializationReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("单元物化回执损坏。");
  const receipt = value as LocalCreativeProductionUnitMaterializationReceipt;
  if (receipt.schemaVersion !== 1
    || receipt.kind !== "local-creative-production-unit-materialization-receipt"
    || receipt.requestHash !== requestHash
    || !SHA256_PATTERN.test(receipt.fingerprint)
    || !Array.isArray(receipt.units)
    || !receipt.units.length) {
    throw new Error("单元物化回执结构或请求身份无效。");
  }
  const { fingerprint: _fingerprint, createdAt: _createdAt, ...body } = receipt;
  if (digest(body) !== receipt.fingerprint) throw new Error("单元物化回执指纹无效。");
  return receipt;
}

async function validateMaterializationItems(
  projectRoot: string,
  items: LocalCreativeProductionUnitMaterializationItem[],
  snapshotReader: typeof readStudioProductionUnitSnapshotForCodex = readStudioProductionUnitSnapshotForCodex,
): Promise<void> {
  for (const item of items) {
    if (typeof item.sourceContractFingerprint !== "string"
      || !SHA256_PATTERN.test(item.sourceContractFingerprint)
      || (item.sourceContractSourceFingerprint !== undefined
        && !SHA256_PATTERN.test(item.sourceContractSourceFingerprint))
      || item.unitRevision === undefined) {
      throw new Error(`单元物化回执 ${item.unitId} 缺少可验证的来源合同身份。`);
    }
    const snapshot = await snapshotReader(projectRoot, item.unitId, item.unitRevision);
    if (!snapshot || snapshot.fingerprint !== item.unitFingerprint
      || snapshot.scriptRevision.id !== item.scriptRevisionId
      || JSON.stringify(snapshot.panels.map((panel) => panel.promptRevision.id))
        !== JSON.stringify(item.promptRevisionIds)) {
      throw new Error(`单元物化回执所指向的 ${item.unitId} 已缺失或漂移。`);
    }
    const contract = await readLocalCreativeUnitSourceContract(
      projectRoot,
      item.unitId,
      item.unitRevision,
    );
    if (!contract
      || contract.fingerprint !== item.sourceContractFingerprint
      || contract.unitId !== item.unitId
      || contract.unitRevision !== item.unitRevision
      || contract.candidateId !== item.candidateId
      || contract.candidateFingerprint !== item.candidateFingerprint
      // 新回执显式绑定合同来源；旧回执没有该字段时，合同自身的冻结 fingerprint
      // 已覆盖 sourceFingerprint，不能错误地拿“本次全局来源”替代历史合同来源。
      || (item.sourceContractSourceFingerprint !== undefined
        && contract.sourceFingerprint !== item.sourceContractSourceFingerprint)) {
      throw new Error(`单元物化回执所指向的 ${item.unitId} 来源合同已缺失或漂移。`);
    }
  }
}

async function validateReceiptUnits(
  projectRoot: string,
  receipt: LocalCreativeProductionUnitMaterializationReceipt,
  snapshotReader: typeof readStudioProductionUnitSnapshotForCodex = readStudioProductionUnitSnapshotForCodex,
): Promise<void> {
  await validateMaterializationItems(projectRoot, receipt.units, snapshotReader);
}

async function validateBatchCheckpoints(
  projectRoot: string,
  journal: LocalCreativeProductionUnitMaterializationBatchJournal,
  checkpoints: LocalCreativeProductionUnitMaterializationBatchCheckpoint[],
  preparedCandidates: PreparedLocalCreativeProductionUnitMaterialization[],
): Promise<void> {
  for (const [index, checkpoint] of checkpoints.entries()) {
    const journalCandidate = journal.candidates[index];
    const prepared = preparedCandidates[index];
    if (!journalCandidate || !prepared
      || checkpoint.item.candidateId !== journalCandidate.candidateId
      || checkpoint.item.candidateFingerprint !== journalCandidate.candidateFingerprint
      || checkpoint.item.unitId !== journalCandidate.unitId
      || checkpoint.item.candidateId !== prepared.candidate.candidateId
      || checkpoint.item.candidateFingerprint !== prepared.candidate.fingerprint
      || checkpoint.item.unitId !== prepared.targetUnitId
      || checkpoint.item.unitRevision !== prepared.expectedContractRevision
      || checkpoint.item.sourceContractFingerprint !== prepared.preparedContract.fingerprint) {
      throw new Error(`MATERIALIZATION_BATCH_CONFLICT：第 ${index + 1} 项 checkpoint 与当前候选不一致。`);
    }
  }
  await validateMaterializationItems(projectRoot, checkpoints.map((checkpoint) => checkpoint.item));
}

export async function materializeLocalCreativeProductionUnits(
  projectRoot: string,
  rawInput: MaterializeLocalCreativeProductionUnitsInput,
): Promise<LocalCreativeProductionUnitMaterializationReceipt> {
  const shell = await inspectManagedProjectReadOnly(projectRoot);
  const input = normalizeInput(rawInput);
  const requestBody = {
    projectId: shell.project.id,
    ...input,
  };
  const requestHash = digest(requestBody);
  const receiptFileName = `${requestHash}.json`;
  const existing = await readConfinedJsonSidecar<unknown>(
    shell.paths.root,
    RECEIPT_DIRECTORY,
    receiptFileName,
    null,
    MAX_RECEIPT_BYTES,
  );
  if (existing !== null) {
    const receipt = assertReceipt(existing, requestHash);
    await validateReceiptUnits(shell.paths.root, receipt);
    return receipt;
  }
  const status = await getLocalCreativeProjectIngestStatus(shell.paths.root, { refreshSource: true, limit: 1 });
  if (status.contentImport.sourceSnapshot !== "current") {
    throw new Error(`SOURCE_NOT_CURRENT：当前来源状态为 ${status.contentImport.sourceSnapshot}，必须先同步内容。`);
  }
  if (status.contentImport.failures.total > 0
    || !["CURRENT_COMPLETE", "PARTIAL_BY_POLICY"].includes(status.contentImport.truthStatus)) {
    throw new Error(`CONTENT_IMPORT_NOT_READY：当前内容状态为 ${status.contentImport.truthStatus}。`);
  }
  const preview = await previewLocalCreativeProductionUnits(shell.paths.root, {
    scopeId: input.scopeId,
    adapterKind: input.adapterKind,
    expectedSourceFingerprint: input.expectedSourceFingerprint,
  });
  if (preview.applicability !== "eligible"
    || preview.adapterId !== "dudu-world-prologue-v1"
    || preview.fingerprint !== input.expectedPreviewFingerprint
    || preview.sourceFingerprint !== input.expectedSourceFingerprint
    || !preview.sourceRoot) {
    throw new Error("PREVIEW_FINGERPRINT_CONFLICT：预览身份或适用性已变化。");
  }
  const byId = new Map(preview.units.map((candidate) => [candidate.candidateId, candidate]));
  const selected = input.candidateIds.map((candidateId) => {
    const candidate = byId.get(candidateId);
    if (!candidate) throw new Error(`预览中不存在候选单元：${candidateId}`);
    return candidate;
  });
  // sequence 是同季同集的全局唯一位置。必须在 intent、文稿、Unit 等任何写入前
  // 完整核对整批目标，否则后序冲突会留下前序 Unit 或孤儿文本。
  await assertMaterializationSequenceSlotsAvailable(shell.paths.root, selected);
  await verifyPreviewEvidence(preview.sourceRoot, preview, selected);
  if (process.env.NODE_ENV === "test" && process.env.AI_CANVAS_TEST_LOCAL_UNIT_BEFORE_WRITE_DELAY_MS) {
    const delay = Number(process.env.AI_CANVAS_TEST_LOCAL_UNIT_BEFORE_WRITE_DELAY_MS);
    if (Number.isFinite(delay) && delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(5_000, Math.trunc(delay))));
    }
  }
  const sourceLayers = inventoryLayers(status);
  if (!await sourceInventoryMatches(sourceLayers, input.expectedSourceFingerprint)) {
    throw new Error("SOURCE_RACE_DETECTED：pre-write 来源指纹已变化；尚未写入任何受管单元。");
  }
  // 整批先完成来源读取、引用闭包、合同字节、现有 Unit/合同状态和 intent 校验。
  // 此阶段不得写 Studio 文档或 Unit，确保后续候选的已知冲突不会留下前序部分提交。
  const preparedCandidates: PreparedLocalCreativeProductionUnitMaterialization[] = [];
  for (const candidate of selected) {
    preparedCandidates.push(await prepareMaterializationCandidate({
      projectRoot: shell.paths.root,
      sourceRoot: preview.sourceRoot,
      sourceFingerprint: preview.sourceFingerprint,
      requestHash,
      candidate,
    }));
  }
  // 公开写路径由项目级 studio-mutation 租约串行化；进入首个 commit 前仍一次性
  // 重验整批状态，避免 prepare 期间发生的漂移在前序单元写入后才被发现。
  for (const prepared of preparedCandidates) {
    await assertPreparedMaterializationCandidateCurrent(prepared);
  }
  // prepare 会读取外部来源和受管引用；进入首个 Studio 写入前再次核对全局序号，
  // 配合项目级 studio-mutation 锁阻止已知冲突形成部分批次。
  await assertMaterializationSequenceSlotsAvailable(shell.paths.root, selected);
  // 批 journal 是崩溃恢复的不可变入口：它在任何 Studio 写入前绑定整批候选，
  // 后续每完成一项追加一个内容寻址 checkpoint。进程中断后只能沿同一链续做。
  const batchJournal = await ensureBatchJournal({
    projectRoot: shell.paths.root,
    requestHash,
    previewFingerprint: preview.fingerprint,
    sourceFingerprint: preview.sourceFingerprint,
    scopeId: preview.scopeId,
    selected,
  });
  // 到这里整批候选已完成纯读取预检。只有现在才允许落盘不可变 intent；
  // 后序 legacy partial/序号/来源闭包冲突不会再给前序候选留下孤儿 intent。
  for (const prepared of preparedCandidates) {
    if (prepared.operation === "reuse") continue;
    await ensureMaterializationIntent(
      shell.paths.root,
      prepared.intentSemanticBody,
      requestHash,
      prepared.operation !== "recover",
    );
  }
  if (process.env.NODE_ENV === "test"
    && process.env.AI_CANVAS_TEST_LOCAL_UNIT_CRASH_AFTER_INTENT_BEFORE_STUDIO === "1") {
    throw new Error("TEST_CRASH_AFTER_LOCAL_UNIT_INTENT_BEFORE_STUDIO");
  }
  const existingCheckpoints = await readBatchCheckpoints(shell.paths.root, batchJournal);
  await validateBatchCheckpoints(
    shell.paths.root,
    batchJournal,
    existingCheckpoints,
    preparedCandidates,
  );
  const units: LocalCreativeProductionUnitMaterializationItem[] =
    existingCheckpoints.map((checkpoint) => checkpoint.item);
  let previousCheckpointFingerprint = existingCheckpoints.at(-1)?.fingerprint ?? null;
  for (let index = existingCheckpoints.length; index < preparedCandidates.length; index += 1) {
    const item = await commitPreparedMaterializationCandidate(preparedCandidates[index]!);
    const checkpoint = await writeBatchCheckpoint(
      shell.paths.root,
      batchJournal,
      index,
      previousCheckpointFingerprint,
      item,
    );
    units.push(checkpoint.item);
    previousCheckpointFingerprint = checkpoint.fingerprint;
    const crashAfterCommitCount = Number(process.env.AI_CANVAS_TEST_LOCAL_UNIT_CRASH_AFTER_COMMIT_COUNT);
    if (process.env.NODE_ENV === "test"
      && Number.isSafeInteger(crashAfterCommitCount)
      && crashAfterCommitCount === units.length) {
      throw new Error(`TEST_CRASH_AFTER_LOCAL_UNIT_COMMIT_COUNT:${crashAfterCommitCount}`);
    }
  }
  if (process.env.NODE_ENV === "test" && process.env.AI_CANVAS_TEST_LOCAL_UNIT_AFTER_WRITE_DELAY_MS) {
    const delay = Number(process.env.AI_CANVAS_TEST_LOCAL_UNIT_AFTER_WRITE_DELAY_MS);
    if (Number.isFinite(delay) && delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(5_000, Math.trunc(delay))));
    }
  }
  const sourceSnapshotAtCommit = await sourceInventoryMatches(sourceLayers, input.expectedSourceFingerprint)
    ? "current" as const
    : "stale-after-verified-snapshot" as const;
  const createdAt = new Date().toISOString();
  const body = {
    schemaVersion: 1 as const,
    kind: "local-creative-production-unit-materialization-receipt" as const,
    idempotencyKey: input.idempotencyKey,
    requestHash,
    projectRoot: shell.paths.root,
    previewFingerprint: preview.fingerprint,
    sourceFingerprint: preview.sourceFingerprint,
    adapterId: preview.adapterId,
    scopeId: preview.scopeId,
    units,
    sourceSnapshotAtCommit,
    assetBindingReadiness: "blocked-unresolved" as const,
    note: sourceSnapshotAtCommit === "current"
      ? "只物化经来源证据验证的剧本、提示词与 Canonical Panel；来源参考路径尚未映射为受管 Authority，禁止直接正式生图。"
      : "受管内容来自写入前已完整验真的来源快照；写入期间外部来源再次变化，必须先重新同步。来源参考路径也尚未映射为受管 Authority，禁止直接正式生图。",
  };
  const receipt: LocalCreativeProductionUnitMaterializationReceipt = {
    ...body,
    fingerprint: digest(body),
    createdAt,
  };
  await writeConfinedJsonSidecarNoReplace(
    shell.paths.root,
    RECEIPT_DIRECTORY,
    receiptFileName,
    receipt,
    MAX_RECEIPT_BYTES,
  );
  const persisted = await readConfinedJsonSidecar<unknown>(
    shell.paths.root,
    RECEIPT_DIRECTORY,
    receiptFileName,
    null,
    MAX_RECEIPT_BYTES,
  );
  const validated = assertReceipt(persisted, requestHash);
  await validateReceiptUnits(shell.paths.root, validated);
  return validated;
}

export async function readLocalCreativeProductionUnitMaterializationOutcome(
  projectRoot: string,
  rawInput: MaterializeLocalCreativeProductionUnitsInput,
): Promise<LocalCreativeProductionUnitMaterializationReceipt | null> {
  const shell = await inspectManagedProjectReadOnly(projectRoot);
  const input = normalizeInput(rawInput);
  const requestHash = digest({
    projectId: shell.project.id,
    ...input,
  });
  const receipt = await readConfinedJsonSidecar<unknown>(
    shell.paths.root,
    RECEIPT_DIRECTORY,
    `${requestHash}.json`,
    null,
    MAX_RECEIPT_BYTES,
  );
  if (receipt === null) return null;
  const validated = assertReceipt(receipt, requestHash);
  await validateReceiptUnits(shell.paths.root, validated);
  return validated;
}

/**
 * Command crash/replay 专用严格只读 proof：不触发 production ensure/live DB open。
 */
export async function readLocalCreativeProductionUnitMaterializationOutcomeReadOnly(
  projectRoot: string,
  rawInput: MaterializeLocalCreativeProductionUnitsInput,
): Promise<LocalCreativeProductionUnitMaterializationReceipt | null> {
  const shell = await inspectManagedProjectReadOnly(projectRoot);
  const input = normalizeInput(rawInput);
  const requestHash = digest({
    projectId: shell.project.id,
    ...input,
  });
  const receipt = await readConfinedJsonSidecar<unknown>(
    shell.paths.root,
    RECEIPT_DIRECTORY,
    `${requestHash}.json`,
    null,
    MAX_RECEIPT_BYTES,
  );
  if (receipt === null) return null;
  const validated = assertReceipt(receipt, requestHash);
  await validateReceiptUnits(shell.paths.root, validated, readStudioProductionUnitSnapshotReadOnly);
  return validated;
}
