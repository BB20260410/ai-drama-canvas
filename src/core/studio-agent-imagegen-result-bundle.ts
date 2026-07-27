/**
 * Agent imagegen 原子写回编排。
 *
 * 这里只编排既有 owner：活动工程 token、material CAS、本地 labeled 派生、
 * generation ledger 成对登记。不调用任何外部生图服务，不自动写 Review。
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import {
  assertActiveManagedStudioContextToken,
  type ActiveManagedStudioContext,
} from "./active-managed-studio-context.js";
import { importStudioMedia } from "./material-studio.js";
import {
  assertStudioGenerationRawNotDetachedCandidate,
  readAnyStudioGenerationFrozenPack,
  readStudioImagegenCallContextRebindByRun,
  verifyStudioImagegenCallContextRebindEvidence,
  readStudioGenerationDispatch,
  readStudioImagegenCallIntentByRun,
  readStudioGenerationResultBundle,
  registerStudioGenerationResultBundle,
  studioImagegenContextTokenHash,
  type AnyStudioGenerationFreezePack,
  type StudioGenerationCallIntentRecord,
  type StudioGenerationResultBundleRecord,
  type StudioImagegenCallContextRebindRecord,
} from "./studio-generation-ledger.js";
import type { StudioFormalImagegenProvider } from "./studio-imagegen-providers.js";
import {
  assertStudioGenerationFreezePackCurrent,
} from "./studio-generation.js";
import {
  assertStudioUnitGridGenerationFreezePackCurrent,
  type StudioUnitGridGenerationFreezePack,
} from "./studio-unit-grid-generation.js";
import {
  formatStudioPanelTitle,
  renderStudioLabeledLayoutToBuffer,
  renderStudioUnitGridLabeledLayoutToBuffer,
} from "./studio-labeled-layout.js";
import { assertStudioImagegenCandidatePathAllowed } from "./studio-imagegen-candidate-gate.js";
import {
  ensureConfinedDirectory,
  inspectExistingConfinedDirectory,
  persistConfinedBytesNoReplace,
  readConfinedRegularFileWithIdentity,
  type ConfinedDirectoryIdentity,
} from "./confined-project-storage.js";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/u;
const WRITEBACK_ROOT = ".aicanvas/studio-generation/writebacks";
const RECEIPT_ROOT = ".aicanvas/studio-generation/writeback-receipts/sha256";
const MAX_RECEIPT_BYTES = 256 * 1024;
const TARGET_ASPECT_RATIO = 9 / 16;
const ASPECT_RATIO_TOLERANCE = 0.025;

export type StudioAgentImagegenBundleErrorCode =
  | "invalid-input"
  | "raw-unreadable"
  | "raw-decode-failed"
  | "raw-sha-mismatch"
  | "raw-aspect-ratio-invalid"
  | "pack-not-found"
  | "pack-conflict"
  | "dispatch-not-found"
  | "provider-mismatch"
  | "call-intent-required"
  | "call-intent-conflict"
  | "result-conflict"
  | "receipt-drift"
  | "labeled-conflict"
  | "storage-unsafe";

export class StudioAgentImagegenBundleError extends Error {
  readonly code: StudioAgentImagegenBundleErrorCode;
  readonly details: string[];

  constructor(code: StudioAgentImagegenBundleErrorCode, message: string, details: string[] = []) {
    super(message);
    this.name = "StudioAgentImagegenBundleError";
    this.code = code;
    this.details = details;
  }
}

export interface StudioAgentImagegenExecutionReceipt {
  schemaVersion: 1;
  kind: "agent-imagegen-execution-receipt";
  provider: StudioFormalImagegenProvider;
  source: "codex-imagegen" | "grok-build-imagine" | "fixture-canary";
  /** 这是 Agent 对自己会话观测的声明，不是供应商签名回执。 */
  attestationLevel: "agent-session-direct" | "unverified-external-agent";
  /** 当前 Codex/Grok 执行面均无密码学供应商回执，必须显式 false。 */
  cryptographicProviderReceipt: false;
  callId: string;
  model: string;
  /** Grok build/imagine 的 Agent 直观测字段；其他 source 不得伪填。 */
  agentSessionId?: string;
  toolCallId?: string;
  toolName?: "image_gen" | "image_edit";
  toolInvocationCount?: 1;
  inputFingerprint?: string;
  candidateSha256?: string;
  startedAt?: string;
  generatedAt: string;
}

export interface CommitAgentImagegenResultBundleInput {
  projectContextToken: string;
  packId: string;
  packFingerprint: string;
  generationRunId: string;
  provider: StudioFormalImagegenProvider;
  rawPath: string;
  rawSha256: string;
  /** Grok live 必须指向 pre-call 授权 quarantine 内的原始 Agent 回执。 */
  executionReceiptPath?: string;
  expectedRevision: number;
  executionReceipt: StudioAgentImagegenExecutionReceipt;
}

export interface StudioAgentImagegenResultBundleOutcome {
  schemaVersion: 4 | 5;
  kind: "studio-agent-imagegen-result-bundle-outcome";
  projectId: string;
  manifestFingerprint: string;
  generationRunId: string;
  packId: string;
  packFingerprint: string;
  provider: StudioFormalImagegenProvider;
  target?: { targetKind: "unit-grid"; targetKey: string; panelCount: number };
  executionReceiptFingerprint: string;
  writebackReceiptFingerprint: string;
  media: {
    raw: { sha256: string; width: number; height: number; aspectRatio: number };
    labeled: { sha256: string; width: number; height: number };
  };
  results: StudioGenerationResultBundleRecord;
  review: {
    status: "pending";
    autoApproved: false;
    instruction: string;
  };
  fingerprint: string;
}

interface NormalizedExecutionReceipt extends StudioAgentImagegenExecutionReceipt {
  fingerprint: string;
}

interface RawInspection {
  canonicalPath: string;
  sha256: string;
  width: number;
  height: number;
  aspectRatio: number;
}

interface WritebackReceipt {
  schemaVersion: 4 | 5;
  kind: "studio-agent-imagegen-writeback-receipt";
  projectId: string;
  manifestFingerprint: string;
  projectContextTokenSha256: string;
  generationRunId: string;
  packId: string;
  packFingerprint: string;
  provider: StudioFormalImagegenProvider;
  target?: { targetKind: "unit-grid"; targetKey: string; panelCount: number };
  executionReceipt: NormalizedExecutionReceipt;
  raw: { sha256: string; width: number; height: number; aspectRatio: number };
  labeled: {
    sha256: string;
    width: number;
    height: number;
    recipe: "chinese-panel-chrome-v1" | "chinese-unit-grid-chrome-v1";
  };
  fingerprint: string;
}

function fail(code: StudioAgentImagegenBundleErrorCode, message: string, details: string[] = []): never {
  throw new StudioAgentImagegenBundleError(code, message, details);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([key, entry]) => [key, stableValue(entry)]));
}

function stableBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(stableValue(value), null, 2)}\n`, "utf8");
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stableValue(value)), "utf8").digest("hex");
}

function normalizeId(value: string, field: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!ID_PATTERN.test(normalized)) fail("invalid-input", `${field} 格式无效。`);
  return normalized;
}

function normalizeSha256(value: string, field: string): string {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!SHA256_PATTERN.test(normalized)) fail("invalid-input", `${field} 必须是 64 位 SHA-256。`);
  return normalized;
}

function normalizeExecutionReceipt(
  receipt: StudioAgentImagegenExecutionReceipt,
  provider: StudioFormalImagegenProvider,
): NormalizedExecutionReceipt {
  if (!receipt || receipt.schemaVersion !== 1 || receipt.kind !== "agent-imagegen-execution-receipt") {
    fail("invalid-input", "executionReceipt 必须是 agent-imagegen-execution-receipt v1。");
  }
  if (receipt.provider !== provider) {
    fail("provider-mismatch", `executionReceipt.provider=${receipt.provider} 与命令 provider=${provider} 不一致。`);
  }
  if ((provider === "codex" && receipt.source !== "codex-imagegen" && receipt.source !== "fixture-canary")
    || (provider === "grok" && receipt.source !== "grok-build-imagine" && receipt.source !== "fixture-canary")) {
    fail("provider-mismatch", `executionReceipt.source=${receipt.source} 与 provider=${provider} 不一致。`);
  }
  const callId = normalizeId(receipt.callId, "executionReceipt.callId");
  if (receipt.attestationLevel !== "agent-session-direct"
    && receipt.attestationLevel !== "unverified-external-agent") {
    fail("invalid-input", "executionReceipt.attestationLevel 必须显式声明 Agent 观测级别。");
  }
  if (receipt.cryptographicProviderReceipt !== false) {
    fail("invalid-input", "当前执行面没有密码学供应商回执，cryptographicProviderReceipt 必须为 false。");
  }
  const model = typeof receipt.model === "string" ? receipt.model.trim() : "";
  if (!model || model.length > 200) fail("invalid-input", "executionReceipt.model 必须是 1-200 字符。");
  const generated = new Date(receipt.generatedAt);
  if (!receipt.generatedAt || Number.isNaN(generated.getTime()) || generated.toISOString() !== receipt.generatedAt) {
    fail("invalid-input", "executionReceipt.generatedAt 必须是规范 ISO-8601 UTC 时间。");
  }
  const base = {
    schemaVersion: 1 as const,
    kind: "agent-imagegen-execution-receipt" as const,
    provider,
    source: receipt.source,
    attestationLevel: receipt.attestationLevel,
    cryptographicProviderReceipt: false as const,
    callId,
    model,
    generatedAt: receipt.generatedAt,
  };
  const grokFields = [
    receipt.agentSessionId,
    receipt.toolCallId,
    receipt.toolName,
    receipt.toolInvocationCount,
    receipt.inputFingerprint,
    receipt.candidateSha256,
    receipt.startedAt,
  ];
  if (receipt.source !== "grok-build-imagine" && grokFields.some((value) => value !== undefined)) {
    fail("invalid-input", "仅 grok-build-imagine 回执允许声明 Grok 工具直观测字段。");
  }
  if (receipt.source !== "grok-build-imagine") {
    return { ...base, fingerprint: digest(base) };
  }
  if (receipt.attestationLevel !== "agent-session-direct") {
    fail("invalid-input", "grok-build-imagine 必须由执行会话直接声明，禁止使用未验证外部 Agent 回执。");
  }
  const agentSessionId = normalizeId(receipt.agentSessionId ?? "", "executionReceipt.agentSessionId");
  const toolCallId = normalizeId(receipt.toolCallId ?? "", "executionReceipt.toolCallId");
  if (receipt.toolName !== "image_gen" && receipt.toolName !== "image_edit") {
    fail("invalid-input", "executionReceipt.toolName 必须是 image_gen 或 image_edit。");
  }
  if (receipt.toolInvocationCount !== 1) {
    fail("invalid-input", "executionReceipt.toolInvocationCount 必须严格为 1。");
  }
  const inputFingerprint = normalizeSha256(receipt.inputFingerprint ?? "", "executionReceipt.inputFingerprint");
  const candidateSha256 = normalizeSha256(receipt.candidateSha256 ?? "", "executionReceipt.candidateSha256");
  const started = new Date(receipt.startedAt ?? "");
  if (!receipt.startedAt || Number.isNaN(started.getTime()) || started.toISOString() !== receipt.startedAt) {
    fail("invalid-input", "executionReceipt.startedAt 必须是规范 ISO-8601 UTC 时间。");
  }
  if (started.getTime() > generated.getTime()) {
    fail("invalid-input", "executionReceipt.startedAt 不得晚于 generatedAt。");
  }
  const normalized = {
    ...base,
    agentSessionId,
    toolCallId,
    toolName: receipt.toolName,
    toolInvocationCount: 1 as const,
    inputFingerprint,
    candidateSha256,
    startedAt: receipt.startedAt,
  };
  return { ...normalized, fingerprint: digest(normalized) };
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolve);
  });
  return hash.digest("hex");
}

async function inspectRaw(rawPath: string, expectedSha256: string, expectedPath?: string): Promise<RawInspection> {
  if (typeof rawPath !== "string" || !rawPath.trim() || !path.isAbsolute(rawPath.trim())) {
    fail("invalid-input", "rawPath 必须是绝对路径。");
  }
  const requested = path.resolve(rawPath.trim());
  if (expectedPath) {
    // 统一走 quarantine-only 门禁：拒绝 prop authority 等非 candidate 精确路径。
    try {
      assertStudioImagegenCandidatePathAllowed({
        rootPath: path.dirname(path.resolve(expectedPath)),
        candidatePath: path.resolve(expectedPath),
      }, requested);
    } catch (error) {
      fail("storage-unsafe", "rawPath 不在本次 pre-call 授权的 quarantine candidatePath。", [
        `expected=${path.resolve(expectedPath)}`,
        `actual=${requested}`,
        error instanceof Error ? error.message : String(error),
      ]);
    }
  }
  let stat: Awaited<ReturnType<typeof lstat>>;
  try {
    stat = await lstat(requested);
  } catch (error) {
    fail("raw-unreadable", `无法读取 raw：${requested}`, [error instanceof Error ? error.message : String(error)]);
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
    fail("raw-unreadable", "raw 必须是单链接、非符号链接的普通文件。");
  }
  const canonicalPath = path.normalize(await realpath(requested));
  if (expectedPath && canonicalPath !== path.normalize(path.resolve(expectedPath))) {
    fail("storage-unsafe", "raw 真实路径与授权 quarantine candidatePath 不一致。");
  }
  let metadata: sharp.Metadata;
  try {
    metadata = await sharp(canonicalPath, { failOn: "error", limitInputPixels: 100_000_000 }).rotate().metadata();
  } catch (error) {
    fail("raw-decode-failed", "raw 图像无法完整解码。", [error instanceof Error ? error.message : String(error)]);
  }
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  if (width < 64 || height < 64) fail("raw-decode-failed", `raw 尺寸无效：${width}x${height}`);
  const aspectRatio = width / height;
  if (height <= width || Math.abs(aspectRatio - TARGET_ASPECT_RATIO) > ASPECT_RATIO_TOLERANCE) {
    fail(
      "raw-aspect-ratio-invalid",
      `raw 必须是 9:16 竖屏，实际 ${width}x${height}（${aspectRatio.toFixed(4)}）。`,
    );
  }
  const sha256 = await sha256File(canonicalPath);
  if (sha256 !== expectedSha256) {
    fail("raw-sha-mismatch", `raw SHA 不匹配：期望 ${expectedSha256}，实际 ${sha256}。`);
  }
  return { canonicalPath, sha256, width, height, aspectRatio };
}

async function inspectGrokExecutionReceiptFile(input: {
  receiptPath: string | undefined;
  expectedPath: string;
  normalized: NormalizedExecutionReceipt;
}): Promise<void> {
  if (!input.receiptPath || !path.isAbsolute(input.receiptPath)) {
    fail("invalid-input", "grok-build-imagine 必须提供绝对 executionReceiptPath。");
  }
  const requested = path.resolve(input.receiptPath);
  const expected = path.resolve(input.expectedPath);
  if (requested !== expected) {
    fail("storage-unsafe", "executionReceiptPath 不在本次 pre-call 授权的 quarantine。", [
      `expected=${expected}`,
      `actual=${requested}`,
    ]);
  }
  const stat = await lstat(requested).catch((error: unknown) => {
    fail("raw-unreadable", "无法读取 Grok execution receipt。", [error instanceof Error ? error.message : String(error)]);
  });
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || stat.size < 2 || stat.size > 64 * 1024) {
    fail("storage-unsafe", "Grok execution receipt 必须是 quarantine 内 2-65536B 的单链接普通文件。");
  }
  if (await realpath(requested) !== expected) {
    fail("storage-unsafe", "Grok execution receipt 真实路径与授权路径不一致。");
  }
  let parsed: StudioAgentImagegenExecutionReceipt;
  try {
    parsed = JSON.parse(await readFile(requested, "utf8")) as StudioAgentImagegenExecutionReceipt;
  } catch (error) {
    fail("invalid-input", "Grok execution receipt 不是有效 JSON。", [error instanceof Error ? error.message : String(error)]);
  }
  const normalizedFile = normalizeExecutionReceipt(parsed, "grok");
  if (normalizedFile.fingerprint !== input.normalized.fingerprint) {
    fail("receipt-drift", "命令内 Grok executionReceipt 与 quarantine 回执文件不一致。");
  }
}

function assertGrokExecutionReceiptMatchesCall(input: {
  receipt: NormalizedExecutionReceipt;
  callIntent: StudioGenerationCallIntentRecord | undefined;
  raw: RawInspection;
}): void {
  if (input.receipt.source !== "grok-build-imagine") return;
  if (!input.callIntent) fail("call-intent-required", "grok-build-imagine 只允许写回已 pre-call 的 unit-grid。");
  if (input.receipt.inputFingerprint !== input.callIntent.inputFingerprint) {
    fail("call-intent-conflict", "Grok receipt inputFingerprint 与 pre-call intent 不一致。");
  }
  if (input.receipt.candidateSha256 !== input.raw.sha256) {
    fail("raw-sha-mismatch", "Grok receipt candidateSha256 与 quarantine 候选不一致。");
  }
}

async function verifyPackAndDispatch(input: {
  projectRoot: string;
  projectContextToken: string;
  packId: string;
  packFingerprint: string;
  generationRunId: string;
  provider: StudioFormalImagegenProvider;
  expectedRevision: number;
  callId: string;
}): Promise<{
  pack: AnyStudioGenerationFreezePack;
  callIntent?: StudioGenerationCallIntentRecord;
  contextRebind?: StudioImagegenCallContextRebindRecord;
}> {
  const pack = await readAnyStudioGenerationFrozenPack(input.projectRoot, input.packId);
  if (!pack) fail("pack-not-found", `持久冻结包不存在：${input.packId}`);
  if (pack.fingerprint !== input.packFingerprint || pack.target.unitRevision !== input.expectedRevision) {
    fail(
      "pack-conflict",
      `冻结包指纹或 revision 不匹配：${input.packId}。`,
      [
        `expectedFingerprint=${input.packFingerprint}`,
        `actualFingerprint=${pack.fingerprint}`,
        `expectedRevision=${input.expectedRevision}`,
        `actualRevision=${pack.target.unitRevision}`,
      ],
    );
  }
  const dispatch = await readStudioGenerationDispatch(input.projectRoot, input.generationRunId);
  if (!dispatch) fail("dispatch-not-found", `generationRunId=${input.generationRunId} 没有 dispatch intent。`);
  if (dispatch.packId !== input.packId || dispatch.packFingerprint !== input.packFingerprint) {
    fail("pack-conflict", `generationRunId=${input.generationRunId} 已绑定其他冻结包。`);
  }
  if (dispatch.provider !== input.provider) {
    fail("provider-mismatch", `dispatch provider=${dispatch.provider} 与写回 provider=${input.provider} 不一致。`);
  }
  if (isUnitGridPack(pack)) {
    const callIntent = await readStudioImagegenCallIntentByRun(input.projectRoot, input.generationRunId);
    const contextRebind = await readStudioImagegenCallContextRebindByRun(input.projectRoot, input.generationRunId);
    const requestedContextTokenHash = studioImagegenContextTokenHash(input.projectContextToken);
    if (!callIntent) {
      fail("call-intent-required", `unit-grid generationRunId=${input.generationRunId} 缺少 pre-call intent。`);
    }
    if (callIntent.callId !== input.callId
      || callIntent.packId !== input.packId
      || callIntent.packFingerprint !== input.packFingerprint
      || callIntent.provider !== input.provider
      || callIntent.targetKind !== "unit-grid"
      || (!contextRebind && callIntent.contextTokenHash !== requestedContextTokenHash)
      || (contextRebind && (contextRebind.callId !== input.callId
        || contextRebind.generationRunId !== input.generationRunId
        || contextRebind.packId !== input.packId
        || contextRebind.packFingerprint !== input.packFingerprint
        || contextRebind.provider !== input.provider
        || contextRebind.inputFingerprint !== callIntent.inputFingerprint
        // 链式 rebind 时 latest.from 可能是上一环 to，不必等于 call 原始 token hash
        || contextRebind.toContextTokenHash !== requestedContextTokenHash))
      || callIntent.status === "not-invoked") {
      fail("call-intent-conflict", `executionReceipt.callId=${input.callId} 与 unit-grid pre-call intent 不一致。`);
    }
    await assertStudioUnitGridGenerationFreezePackCurrent(
      input.projectRoot,
      pack,
      contextRebind ? { afterPaidCallIntent: true } : {},
    );
    if (contextRebind) {
      let verifiedRebind: StudioImagegenCallContextRebindRecord | null;
      try {
        verifiedRebind = await verifyStudioImagegenCallContextRebindEvidence(
          input.projectRoot,
          input.generationRunId,
        );
      } catch (error) {
        fail("receipt-drift", "context rebind 的 quarantine candidate/receipt 复核失败。", [
          error instanceof Error ? error.message : String(error),
        ]);
      }
      if (!verifiedRebind || verifiedRebind.eventId !== contextRebind.eventId) {
        fail("receipt-drift", "context rebind 的 quarantine candidate/receipt 复核失败。");
      }
    }
    return { pack, callIntent, ...(contextRebind ? { contextRebind } : {}) };
  } else {
    await assertStudioGenerationFreezePackCurrent(input.projectRoot, pack);
  }
  return { pack };
}

function isUnitGridPack(pack: AnyStudioGenerationFreezePack): pack is StudioUnitGridGenerationFreezePack {
  return pack.schemaVersion === 5 && pack.provenance === "unit-grid-binding-sets";
}

interface RenderedLabeled {
  png: Buffer;
  sha256: string;
  width: number;
  height: number;
  recipe: "chinese-panel-chrome-v1" | "chinese-unit-grid-chrome-v1";
  targetName: string;
}

interface WritebackStorage {
  labeledTarget: ConfinedDirectoryIdentity;
  receiptTarget: ConfinedDirectoryIdentity;
}

async function renderLabeled(input: {
  pack: AnyStudioGenerationFreezePack;
  generationRunId: string;
  provider: StudioFormalImagegenProvider;
  raw: RawInspection;
}): Promise<RenderedLabeled> {
  const rendered = isUnitGridPack(input.pack)
    ? await renderStudioUnitGridLabeledLayoutToBuffer({
        rawPath: input.raw.canonicalPath,
        unitTitle: `${input.pack.target.seasonId}/${input.pack.target.episodeId}/${input.pack.target.unitId}`,
        badge: input.provider,
        panels: input.pack.panels.map((panel) => ({
          order: panel.order,
          panelId: panel.panelId,
          startSeconds: panel.startSeconds,
          endSeconds: panel.endSeconds,
          subtitle: panel.instruction.subtitle || panel.instruction.dialogue || panel.instruction.visualAction,
        })),
      })
    : await renderStudioLabeledLayoutToBuffer({
        rawPath: input.raw.canonicalPath,
        labels: {
          panelTitle: formatStudioPanelTitle(
            `${input.pack.target.seasonId}/${input.pack.target.episodeId}/${input.pack.target.unitId}`,
            input.pack.target.panelIndex,
          ),
          subtitle: input.pack.panel.subtitle || input.pack.panel.dialogue || input.pack.panel.visualAction,
          badge: input.provider,
        },
      });
  return {
    png: rendered.png,
    sha256: rendered.labeledSha256,
    width: rendered.width,
    height: rendered.height,
    recipe: rendered.recipe,
    targetName: `${input.pack.fingerprint.slice(0, 16)}-${input.raw.sha256.slice(0, 16)}_labeled.png`,
  };
}

async function prepareWritebackStorage(
  projectRoot: string,
  generationRunId: string,
  receiptStorageKey: string,
): Promise<WritebackStorage> {
  try {
    const labeledTarget = await ensureConfinedDirectory(
      projectRoot,
      path.join(projectRoot, WRITEBACK_ROOT, generationRunId),
    );
    const receiptTarget = await ensureConfinedDirectory(
      projectRoot,
      path.join(projectRoot, RECEIPT_ROOT, receiptStorageKey.slice(0, 2)),
    );
    return { labeledTarget, receiptTarget };
  } catch (error) {
    fail("storage-unsafe", "writeback/receipt 受管目录预检失败，未开始正式写回。", [
      error instanceof Error ? error.message : String(error),
    ]);
  }
}

async function materializeLabeled(
  rendered: RenderedLabeled,
  storage: WritebackStorage,
): Promise<RenderedLabeled & { path: string }> {
  const persistedReceipt = await persistConfinedBytesNoReplace(
    storage.labeledTarget,
    rendered.targetName,
    rendered.png,
  );
  if (persistedReceipt.sha256 !== rendered.sha256 || persistedReceipt.size !== rendered.png.byteLength) {
    fail("labeled-conflict", `本地 labeled dirfd 回执漂移：${rendered.targetName}`);
  }
  const persisted = await readConfinedRegularFileWithIdentity(
    storage.labeledTarget,
    rendered.targetName,
    Math.max(rendered.png.byteLength * 2, 16 * 1024 * 1024),
  );
  if (persisted.nlink !== 1 || !persisted.bytes.equals(rendered.png)) {
    fail("labeled-conflict", `本地 labeled 持久化后身份漂移：${rendered.targetName}`);
  }
  return {
    ...rendered,
    path: path.join(storage.labeledTarget.directory, rendered.targetName),
  };
}

function buildWritebackReceipt(input: {
  context: ActiveManagedStudioContext;
  pack: AnyStudioGenerationFreezePack;
  projectContextToken: string;
  packId: string;
  packFingerprint: string;
  generationRunId: string;
  provider: StudioFormalImagegenProvider;
  executionReceipt: NormalizedExecutionReceipt;
  raw: RawInspection;
  labeled: {
    sha256: string;
    width: number;
    height: number;
    recipe: "chinese-panel-chrome-v1" | "chinese-unit-grid-chrome-v1";
  };
}): WritebackReceipt {
  const unitGrid = isUnitGridPack(input.pack);
  const body = {
    schemaVersion: unitGrid ? 5 as const : 4 as const,
    kind: "studio-agent-imagegen-writeback-receipt" as const,
    projectId: input.context.projectId,
    manifestFingerprint: input.context.manifestFingerprint,
    projectContextTokenSha256: digest(input.projectContextToken),
    generationRunId: input.generationRunId,
    packId: input.packId,
    packFingerprint: input.packFingerprint,
    provider: input.provider,
    ...(unitGrid ? {
      target: {
        targetKind: "unit-grid" as const,
        targetKey: `unit-grid:${input.pack.target.unitId}`,
        panelCount: input.pack.target.panelCount,
      },
    } : {}),
    executionReceipt: input.executionReceipt,
    raw: {
      sha256: input.raw.sha256,
      width: input.raw.width,
      height: input.raw.height,
      aspectRatio: input.raw.aspectRatio,
    },
    labeled: {
      sha256: input.labeled.sha256,
      width: input.labeled.width,
      height: input.labeled.height,
      recipe: input.labeled.recipe,
    },
  };
  return { ...body, fingerprint: digest(body) };
}

async function persistWritebackReceipt(storage: WritebackStorage, receipt: WritebackReceipt): Promise<void> {
  const bytes = stableBytes(receipt);
  if (bytes.byteLength > MAX_RECEIPT_BYTES) fail("invalid-input", "writeback receipt 超过 256 KiB。");
  const storageKey = writebackReceiptStorageKey(receipt);
  const targetName = `${storageKey}.json`;
  const persistedReceipt = await persistConfinedBytesNoReplace(storage.receiptTarget, targetName, bytes);
  if (persistedReceipt.sha256 !== createHash("sha256").update(bytes).digest("hex")
    || persistedReceipt.size !== bytes.byteLength) {
    fail("receipt-drift", `writeback receipt dirfd 回执漂移：${receipt.fingerprint}`);
  }
  const persisted = await readConfinedRegularFileWithIdentity(storage.receiptTarget, targetName, MAX_RECEIPT_BYTES);
  if (persisted.nlink !== 1 || !persisted.bytes.equals(bytes)) {
    fail("receipt-drift", `writeback receipt 持久化后身份漂移：${receipt.fingerprint}`);
  }
}

function writebackReceiptStorageKey(receipt: Pick<WritebackReceipt,
  | "projectId"
  | "manifestFingerprint"
  | "projectContextTokenSha256"
  | "generationRunId"
  | "packId"
  | "packFingerprint"
  | "provider"
  | "executionReceipt"
  | "raw"
  | "labeled"
>): string {
  return digest({
    schemaVersion: 1,
    kind: "studio-agent-imagegen-writeback-receipt-storage-key",
    projectId: receipt.projectId,
    manifestFingerprint: receipt.manifestFingerprint,
    projectContextTokenSha256: receipt.projectContextTokenSha256,
    generationRunId: receipt.generationRunId,
    packId: receipt.packId,
    packFingerprint: receipt.packFingerprint,
    provider: receipt.provider,
    executionReceiptFingerprint: receipt.executionReceipt.fingerprint,
    rawSha256: receipt.raw.sha256,
    labeledSha256: receipt.labeled.sha256,
  });
}

function writebackReceiptLocator(input: {
  context: ActiveManagedStudioContext;
  projectContextToken: string;
  generationRunId: string;
  packId: string;
  packFingerprint: string;
  provider: StudioFormalImagegenProvider;
  executionReceipt: NormalizedExecutionReceipt;
  rawSha256: string;
  labeledSha256: string;
}): Pick<WritebackReceipt,
  | "projectId"
  | "manifestFingerprint"
  | "projectContextTokenSha256"
  | "generationRunId"
  | "packId"
  | "packFingerprint"
  | "provider"
  | "executionReceipt"
  | "raw"
  | "labeled"> {
  return {
    projectId: input.context.projectId,
    manifestFingerprint: input.context.manifestFingerprint,
    projectContextTokenSha256: digest(input.projectContextToken),
    generationRunId: input.generationRunId,
    packId: input.packId,
    packFingerprint: input.packFingerprint,
    provider: input.provider,
    executionReceipt: input.executionReceipt,
    raw: { sha256: input.rawSha256 } as WritebackReceipt["raw"],
    labeled: { sha256: input.labeledSha256 } as WritebackReceipt["labeled"],
  };
}

async function loadWritebackReceipt(
  projectRoot: string,
  locator: ReturnType<typeof writebackReceiptLocator>,
): Promise<WritebackReceipt | null> {
  try {
    const storageKey = writebackReceiptStorageKey(locator);
    const directory = await inspectExistingConfinedDirectory(
      projectRoot,
      path.join(projectRoot, RECEIPT_ROOT, storageKey.slice(0, 2)),
    );
    const stored = await readConfinedRegularFileWithIdentity(directory, `${storageKey}.json`, MAX_RECEIPT_BYTES);
    if (stored.nlink !== 1) return null;
    const receipt = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(stored.bytes)) as WritebackReceipt;
    if (writebackReceiptStorageKey(receipt) !== storageKey
      || receipt.fingerprint !== digest(Object.fromEntries(Object.entries(receipt).filter(([key]) => key !== "fingerprint")))
      || !stableBytes(receipt).equals(stored.bytes)) return null;
    const expectedIdentity = stableValue(locator);
    const actualIdentity = stableValue({
      projectId: receipt.projectId,
      manifestFingerprint: receipt.manifestFingerprint,
      projectContextTokenSha256: receipt.projectContextTokenSha256,
      generationRunId: receipt.generationRunId,
      packId: receipt.packId,
      packFingerprint: receipt.packFingerprint,
      provider: receipt.provider,
      executionReceipt: receipt.executionReceipt,
      raw: { sha256: receipt.raw.sha256 },
      labeled: { sha256: receipt.labeled.sha256 },
    });
    return JSON.stringify(actualIdentity) === JSON.stringify(expectedIdentity) ? receipt : null;
  } catch {
    return null;
  }
}

function outcomeFrom(input: {
  context: ActiveManagedStudioContext;
  packId: string;
  packFingerprint: string;
  generationRunId: string;
  provider: StudioFormalImagegenProvider;
  executionReceipt: NormalizedExecutionReceipt;
  writebackReceipt: WritebackReceipt;
  results: StudioGenerationResultBundleRecord;
}): StudioAgentImagegenResultBundleOutcome {
  const body = {
    schemaVersion: input.writebackReceipt.schemaVersion,
    kind: "studio-agent-imagegen-result-bundle-outcome" as const,
    projectId: input.context.projectId,
    manifestFingerprint: input.context.manifestFingerprint,
    generationRunId: input.generationRunId,
    packId: input.packId,
    packFingerprint: input.packFingerprint,
    provider: input.provider,
    ...(input.writebackReceipt.target ? { target: input.writebackReceipt.target } : {}),
    executionReceiptFingerprint: input.executionReceipt.fingerprint,
    writebackReceiptFingerprint: input.writebackReceipt.fingerprint,
    media: {
      raw: input.writebackReceipt.raw,
      labeled: {
        sha256: input.writebackReceipt.labeled.sha256,
        width: input.writebackReceipt.labeled.width,
        height: input.writebackReceipt.labeled.height,
      },
    },
    results: input.results,
    review: {
      status: "pending" as const,
      autoApproved: false as const,
      instruction: "机械验收与 raw/labeled 成对已完成；必须在 Review owner 中独立进行原尺寸视觉审片。",
    },
  };
  return { ...body, fingerprint: digest(body) };
}

export async function commitAgentImagegenResultBundle(
  projectRoot: string,
  input: CommitAgentImagegenResultBundleInput,
): Promise<StudioAgentImagegenResultBundleOutcome> {
  const packId = normalizeId(input.packId, "packId");
  const packFingerprint = normalizeSha256(input.packFingerprint, "packFingerprint");
  const generationRunId = normalizeId(input.generationRunId, "generationRunId");
  const rawSha256 = normalizeSha256(input.rawSha256, "rawSha256");
  if (input.provider !== "codex" && input.provider !== "grok") fail("invalid-input", "provider 必须是 codex 或 grok。");
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
    fail("invalid-input", "expectedRevision 必须是正整数。");
  }
  const context = await assertActiveManagedStudioContextToken(projectRoot, input.projectContextToken);
  const executionReceipt = normalizeExecutionReceipt(input.executionReceipt, input.provider);
  const verified = await verifyPackAndDispatch({
    projectRoot,
    projectContextToken: input.projectContextToken,
    packId,
    packFingerprint,
    generationRunId,
    provider: input.provider,
    expectedRevision: input.expectedRevision,
    callId: executionReceipt.callId,
  });
  const pack = verified.pack;
  const liveCall = executionReceipt.source !== "fixture-canary" ? verified.callIntent : undefined;
  if (executionReceipt.source !== "fixture-canary" && !liveCall) {
    fail("call-intent-required", "真实 Agent imagegen 结果只允许写回已 pre-call 的 unit-grid quarantine。");
  }
  if (verified.contextRebind
    && verified.contextRebind.executionReceiptFingerprint !== executionReceipt.fingerprint) {
    fail("receipt-drift", "context rebind 授权的 execution receipt 与提交内联回执不一致。");
  }
  const raw = await inspectRaw(input.rawPath, rawSha256, liveCall?.quarantine.candidatePath);
  await assertStudioGenerationRawNotDetachedCandidate(projectRoot, {
    packId,
    packFingerprint,
    rawMediaSha256: raw.sha256,
  });
  if (verified.contextRebind && verified.contextRebind.candidateSha256 !== raw.sha256) {
    fail("raw-sha-mismatch", "context rebind 授权的 candidate SHA 与提交 raw 不一致。");
  }
  if (verified.contextRebind) {
    let revalidated: StudioImagegenCallContextRebindRecord | null;
    try {
      revalidated = await verifyStudioImagegenCallContextRebindEvidence(projectRoot, generationRunId);
    } catch (error) {
      fail("receipt-drift", "context rebind 的完整 quarantine 审计证据在提交前发生漂移。", [
        error instanceof Error ? error.message : String(error),
      ]);
    }
    if (!revalidated || revalidated.eventId !== verified.contextRebind.eventId) {
      fail("receipt-drift", "context rebind 的完整 quarantine 审计证据在提交前发生漂移。");
    }
  }
  assertGrokExecutionReceiptMatchesCall({ receipt: executionReceipt, callIntent: verified.callIntent, raw });
  if (executionReceipt.source === "grok-build-imagine") {
    await inspectGrokExecutionReceiptFile({
      receiptPath: input.executionReceiptPath,
      expectedPath: verified.callIntent!.quarantine.receiptPath,
      normalized: executionReceipt,
    });
  }
  const prior = await readStudioGenerationResultBundle(projectRoot, generationRunId);
  if (prior) {
    if (isUnitGridPack(pack) && verified.callIntent?.status !== "result-committed") {
      fail("call-intent-conflict", `unit-grid generationRunId=${generationRunId} 已有结果，但 call 未处于 result-committed。`);
    }
    if (prior.packId !== packId
      || prior.packFingerprint !== packFingerprint
      || prior.provider !== input.provider
      || prior.raw.mediaSha256 !== raw.sha256) {
      fail("result-conflict", `generationRunId=${generationRunId} 已绑定其他 raw/labeled 结果。`);
    }
    const existingReceipt = await loadWritebackReceipt(projectRoot, writebackReceiptLocator({
      context,
      projectContextToken: input.projectContextToken,
      generationRunId,
      packId,
      packFingerprint,
      provider: input.provider,
      executionReceipt,
      rawSha256: raw.sha256,
      labeledSha256: prior.labeled.mediaSha256,
    }));
    // 旧的两次单项 register 即使恰好成对，也不是 v4 原子 bundle。
    // 只有同一命令先前落盘的不可变 writeback receipt 存在时才允许幂等恢复。
    if (!existingReceipt
      || existingReceipt.raw.width !== raw.width
      || existingReceipt.raw.height !== raw.height
      || existingReceipt.raw.aspectRatio !== raw.aspectRatio) {
      fail("receipt-drift", `generationRunId=${generationRunId} 已有历史结果对，但缺少本 v4 命令的原子收据。`);
    }
    return outcomeFrom({
      context,
      packId,
      packFingerprint,
      generationRunId,
      provider: input.provider,
      executionReceipt,
      writebackReceipt: existingReceipt,
      results: prior,
    });
  }
  if (isUnitGridPack(pack) && verified.callIntent?.status !== "generation_unknown") {
    fail("call-intent-conflict", `unit-grid callId=${executionReceipt.callId} 已终态，禁止新增结果。`);
  }
  const renderedLabeled = await renderLabeled({
    pack,
    generationRunId,
    provider: input.provider,
    raw,
  });
  const writebackReceipt = buildWritebackReceipt({
    context,
    pack,
    projectContextToken: input.projectContextToken,
    packId,
    packFingerprint,
    generationRunId,
    provider: input.provider,
    executionReceipt,
    raw,
    labeled: renderedLabeled,
  });
  // 所有 writeback/receipt 目录在 labeled、material CAS 或 ledger 任一写入前统一冻结身份。
  const storage = await prepareWritebackStorage(
    projectRoot,
    generationRunId,
    writebackReceiptStorageKey(writebackReceipt),
  );
  const labeled = await materializeLabeled(renderedLabeled, storage);
  const [rawMedia, labeledMedia] = await Promise.all([
    importStudioMedia(projectRoot, { sourcePath: raw.canonicalPath, kind: "image", expectedSha256: raw.sha256 }),
    importStudioMedia(projectRoot, { sourcePath: labeled.path, kind: "image", expectedSha256: labeled.sha256 }),
  ]);
  if (rawMedia.sha256 !== raw.sha256 || labeledMedia.sha256 !== labeled.sha256) {
    fail("raw-sha-mismatch", "material CAS 导入返回了非预期 SHA，已停止登记。");
  }
  // 收据先于 ledger transaction 落盘；崩溃时可能留下无害孤儿收据，
  // 但只有收据 + ledger 成对结果同时成立才能证明命令完成。
  await persistWritebackReceipt(storage, writebackReceipt);
  const results = await registerStudioGenerationResultBundle(projectRoot, {
    packId,
    packFingerprint,
    generationRunId,
    provider: input.provider,
    rawMediaSha256: raw.sha256,
    labeledMediaSha256: labeled.sha256,
    ...(isUnitGridPack(pack) ? { callId: executionReceipt.callId } : {}),
  });
  return outcomeFrom({
    context,
    packId,
    packFingerprint,
    generationRunId,
    provider: input.provider,
    executionReceipt,
    writebackReceipt,
    results,
  });
}

/**
 * command-bus 崩溃恢复只读不可变收据 + ledger 结果，从不重做导入或 labeled 派生。
 */
export async function proveAgentImagegenResultBundleOutcome(
  projectRoot: string,
  input: CommitAgentImagegenResultBundleInput,
): Promise<StudioAgentImagegenResultBundleOutcome | null> {
  try {
    const packId = normalizeId(input.packId, "packId");
    const packFingerprint = normalizeSha256(input.packFingerprint, "packFingerprint");
    const generationRunId = normalizeId(input.generationRunId, "generationRunId");
    const rawSha256 = normalizeSha256(input.rawSha256, "rawSha256");
    const context = await assertActiveManagedStudioContextToken(projectRoot, input.projectContextToken);
    const executionReceipt = normalizeExecutionReceipt(input.executionReceipt, input.provider);
    const results = await readStudioGenerationResultBundle(projectRoot, generationRunId);
    if (!results
      || results.packId !== packId
      || results.packFingerprint !== packFingerprint
      || results.provider !== input.provider
      || results.raw.mediaSha256 !== rawSha256
      || results.raw.status !== "pending"
      || results.labeled.status !== "pending") return null;
    if (results.schemaVersion === 5) {
      const callIntent = await readStudioImagegenCallIntentByRun(projectRoot, generationRunId);
      const contextRebind = await readStudioImagegenCallContextRebindByRun(projectRoot, generationRunId);
      const verifiedRebind = contextRebind
        ? await verifyStudioImagegenCallContextRebindEvidence(projectRoot, generationRunId)
        : null;
      const requestedContextTokenHash = studioImagegenContextTokenHash(input.projectContextToken);
      if (!callIntent
        || callIntent.callId !== executionReceipt.callId
        || callIntent.packId !== packId
        || callIntent.packFingerprint !== packFingerprint
        || callIntent.provider !== input.provider
        || callIntent.targetKind !== "unit-grid"
        || (!contextRebind && callIntent.contextTokenHash !== requestedContextTokenHash)
        // verifyStudioImagegenCallContextRebindEvidence 已复核首环从原 call token
        // 起步且整条 from/to 连续；恢复只应要求 latest.to 命中当前 token。
        || (contextRebind && (contextRebind.toContextTokenHash !== requestedContextTokenHash
          || contextRebind.executionReceiptFingerprint !== executionReceipt.fingerprint
          || contextRebind.candidateSha256 !== rawSha256
          || !verifiedRebind
          || verifiedRebind.eventId !== contextRebind.eventId))
        || callIntent.status !== "result-committed") return null;
    }
    const matching = await loadWritebackReceipt(projectRoot, writebackReceiptLocator({
      context,
      projectContextToken: input.projectContextToken,
      generationRunId,
      packId,
      packFingerprint,
      provider: input.provider,
      executionReceipt,
      rawSha256,
      labeledSha256: results.labeled.mediaSha256,
    }));
    if (!matching
      || matching.kind !== "studio-agent-imagegen-writeback-receipt"
      || matching.projectId !== context.projectId
      || matching.manifestFingerprint !== context.manifestFingerprint
      || matching.projectContextTokenSha256 !== digest(input.projectContextToken)
      || matching.generationRunId !== generationRunId
      || matching.packId !== packId
      || matching.packFingerprint !== packFingerprint
      || matching.provider !== input.provider
      || matching.executionReceipt.fingerprint !== executionReceipt.fingerprint
      || matching.raw.sha256 !== rawSha256
      || matching.labeled.sha256 !== results.labeled.mediaSha256) return null;
    return outcomeFrom({
      context,
      packId,
      packFingerprint,
      generationRunId,
      provider: input.provider,
      executionReceipt,
      writebackReceipt: matching,
      results,
    });
  } catch {
    return null;
  }
}
