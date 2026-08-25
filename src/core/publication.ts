import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, type BigIntStats } from "node:fs";
import { lstat, mkdir, open, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { loadSharpDefault } from "./sharp-lazy.js";
import { z } from "zod";
import { ConfirmedCommandFailure, RejectedCommandFailure } from "./command-outcome.js";
import { withProjectLock } from "./locks.js";
import { MEDIA_WEIGHTS, mediaStageTimeout, runMediaProcess } from "./media-runtime.js";
import { getOperationContext } from "./operation-context.js";
import { appendEvent, getSidecarPaths, loadProjectConfig, readJson, writeJsonAtomic } from "./sidecar.js";
import type { ArtifactKind, ArtifactVariant, MechanicalCheck, ProjectEvent } from "./types.js";

export const PUBLICATION_PURPOSES = ["generation-output", "edit-render", "preview", "proxy", "import", "other"] as const;
export const PUBLICATION_KINDS = ["info", "prompt", "raw-image", "labeled-image", "video", "audio", "manifest", "other"] as const satisfies readonly ArtifactKind[];
export const PUBLICATION_VARIANTS = ["start", "end", "generic"] as const satisfies readonly ArtifactVariant[];
export type PublicationPurpose = (typeof PUBLICATION_PURPOSES)[number];
export type PublicationStatus = "reserved" | "registered" | "cancelled" | "failed";
export type PublicationBundleMember = "primary" | "companion";

export interface PublicationContext {
  purpose: PublicationPurpose;
  itemId?: string;
  taskId?: string;
  jobId?: string;
  metadata?: Record<string, string | number | boolean>;
}

export type GenerationPublicationTerminalCause =
  | "http_submission_not_found"
  | "browser_submission_not_found"
  | "remote_confirmed_failed"
  | "remote_cancel_confirmed"
  | "local_pre_submit_failure"
  | "local_execution_failed"
  | "visual_rejected"
  | "user_cancelled_before_submit";

export interface GenerationPublicationSubmissionReconciliation {
  method: "provider_task_list" | "client_job_id_search" | "provider_idempotency_lookup" | "provider_request_log" | "provider_support" | "browser_history";
  result: "found" | "not_found";
  clientJobId: string;
  attempt: number;
  evidenceReference: string;
  note: string;
  externalTaskId?: string;
  confirmNoRemoteResult?: true;
  checkedAt: string;
}

export interface GenerationPublicationTerminalProvenance {
  schemaVersion: 1;
  source: "generation";
  generationJobId: string;
  cause: GenerationPublicationTerminalCause;
  clientJobId: string;
  attempt: number;
  externalTaskId?: string;
  checkpointRevision?: number;
  comfyUi?: {
    promptId: string;
    clientId: string;
    submittedWorkflowHash: string;
    historySha256?: string;
    eventName?: "execution_error" | "execution_interrupted";
    confirmationKind?: "history_interrupted" | "pending_deleted";
    cancellationResponseSha256?: string;
  };
  reconciliation?: GenerationPublicationSubmissionReconciliation;
}

export interface FinishPublicationInput {
  intentId: string;
  reservationToken: string;
  reason: string;
  expectedRevision: number;
  provenance?: GenerationPublicationTerminalProvenance;
}

export interface FinishPublicationBundleInput {
  bundleId: string;
  members: Array<{
    member: PublicationBundleMember;
    intentId: string;
    reservationToken: string;
    expectedRevision: number;
  }>;
  reason: string;
  provenance?: GenerationPublicationTerminalProvenance;
}

export interface PublicationIntent {
  schemaVersion: 1;
  id: string;
  projectId: string;
  revision: number;
  status: PublicationStatus;
  idempotencyKey: string;
  requestHash: string;
  reservationToken: string;
  requestedPath: string;
  targetPath: string;
  allowedRoot: string;
  kind: ArtifactKind;
  variant: ArtifactVariant;
  context: PublicationContext;
  /** 同一不可拆分发布事务的稳定身份；旧意图可在 bundle 提交时补齐。 */
  bundleId?: string;
  bundleMember?: PublicationBundleMember;
  note?: string;
  terminal?: { reason: string; at: string; provenance?: GenerationPublicationTerminalProvenance };
  receiptId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PublicationReceipt {
  schemaVersion: 1;
  id: string;
  intentId: string;
  projectId: string;
  targetPath: string;
  kind: ArtifactKind;
  variant: ArtifactVariant;
  context: PublicationContext;
  bundleId?: string;
  bundleMember?: PublicationBundleMember;
  check: MechanicalCheck & { sha256: string; modifiedAt: string };
  registeredAt: string;
}

export interface PublicationStore {
  schemaVersion: 1;
  revision: number;
  intents: PublicationIntent[];
  receipts: PublicationReceipt[];
  updatedAt: string;
}

export interface PublicationRegistrationOptions {
  /** 供确定性并发/崩溃门禁使用；回调在锁内快照完成并释放项目锁后执行。 */
  afterSnapshot?: (snapshot: { intentId: string; revision: number; status: "reserved" | "registered"; targetPath: string }) => void | Promise<void>;
  /** 供确定性 CAS/崩溃门禁使用；回调在机械校验完成、重新获取提交锁之前执行。 */
  beforeCommit?: (snapshot: { intentId: string; revision: number; status: "reserved" | "registered"; targetPath: string }) => void | Promise<void>;
  hashTimeoutMs?: number;
}

export interface PublicationBundleRegistrationOptions {
  /** 两个意图的锁内快照已经完成，机械校验尚未开始。 */
  afterSnapshot?: (snapshot: {
    bundleId: string;
    members: Array<{ member: PublicationBundleMember; intentId: string; revision: number; status: "reserved" | "registered"; targetPath: string }>;
  }) => void | Promise<void>;
  /** 两个文件均机械校验完成、重新获取提交锁之前。 */
  beforeCommit?: (snapshot: {
    bundleId: string;
    members: Array<{ member: PublicationBundleMember; intentId: string; revision: number; status: "reserved" | "registered"; targetPath: string }>;
  }) => void | Promise<void>;
  hashTimeoutMs?: number;
}

export interface PublicationBundleRegistrationInput {
  bundleId: string;
  members: Array<{
    member: PublicationBundleMember;
    intentId: string;
    reservationToken: string;
    expectedRevision: number;
  }>;
}

export interface PublicationBundleRegistrationResult {
  bundleId: string;
  receipts: PublicationReceipt[];
  registeredAt: string;
}

export interface BindPublicationBundleInput {
  bundleId: string;
  members: Array<{
    member: PublicationBundleMember;
    intentId: string;
    reservationToken: string;
    expectedRevision: number;
  }>;
}

export interface PreflightPublicationBundleInput {
  bundleId: string;
  idempotencyKey?: string;
  primaryRequestedPath: string;
  companionRequestedPath: string;
  allowedRoot?: string;
  variant?: ArtifactVariant;
  context: PublicationContext;
  note?: string;
}

export interface PreflightPublicationBundleResult {
  bundleId: string;
  primary: PublicationIntent;
  companion: PublicationIntent;
}

export interface ExtendPublicationToBundleInput {
  bundleId: string;
  idempotencyKey?: string;
  primaryIntentId: string;
  primaryReservationToken: string;
  primaryExpectedRevision: number;
  companionRequestedPath: string;
  note?: string;
}

interface PresentFileIdentity {
  state: "present";
  type: "file" | "directory" | "symlink" | "other";
  dev: string;
  ino: string;
  mode: string;
  nlink: string;
  size: string;
  mtimeNs: string;
  ctimeNs: string;
}

type FileIdentity = PresentFileIdentity | { state: "missing" } | { state: "error"; code: string };

interface BoundaryIdentity {
  valid: boolean;
  reason?: string;
  allowedRoot: string;
  parentPath: string;
  canonicalRoot?: string;
  canonicalParent?: string;
  rootIdentity: FileIdentity;
  parentIdentity: FileIdentity;
}

interface PublicationValidationIdentity {
  file: FileIdentity;
  boundary: BoundaryIdentity;
}

interface RegistrationSnapshot {
  intent: PublicationIntent;
  receipt?: PublicationReceipt;
  identity: PublicationValidationIdentity;
}

type PublicationValidationOutcome =
  | { kind: "success"; check: PublicationReceipt["check"]; identity: PublicationValidationIdentity }
  | { kind: "failure"; reason: string; identity: PublicationValidationIdentity };

class PublicationValidationConflict extends Error {
  constructor(message = "最终发布文件或路径在校验期间发生变化，CAS 未提交；发布意图仍保留为 reserved。") {
    super(message);
    this.name = "PublicationValidationConflict";
  }
}

export interface PreflightPublicationInput {
  idempotencyKey?: string;
  requestedPath: string;
  allowedRoot?: string;
  kind: ArtifactKind;
  variant?: ArtifactVariant;
  context: PublicationContext;
  bundleId?: string;
  bundleMember?: PublicationBundleMember;
  note?: string;
}

const emptyStore = (): PublicationStore => ({ schemaVersion: 1, revision: 0, intents: [], receipts: [], updatedAt: new Date(0).toISOString() });
export const getPublicationStorePath = (projectRoot: string): string => getSidecarPaths(projectRoot).publications;

const publicationContextSchema = z.object({
  purpose: z.enum(PUBLICATION_PURPOSES),
  itemId: z.string().min(1).max(200).optional(),
  taskId: z.string().min(1).max(200).optional(),
  jobId: z.string().min(1).max(200).optional(),
  metadata: z.record(z.string().min(1).max(120), z.union([z.string().max(4_000), z.number().finite(), z.boolean()])).optional(),
}).passthrough();
const generationPublicationTerminalProvenanceSchema = z.object({
  schemaVersion: z.literal(1),
  source: z.literal("generation"),
  generationJobId: z.string().min(3).max(200),
  cause: z.enum(["http_submission_not_found", "browser_submission_not_found", "remote_confirmed_failed", "remote_cancel_confirmed", "local_pre_submit_failure", "local_execution_failed", "visual_rejected", "user_cancelled_before_submit"]),
  clientJobId: z.string().min(3).max(200),
  attempt: z.number().int().positive(),
  externalTaskId: z.string().min(1).max(200).optional(),
  checkpointRevision: z.number().int().positive().optional(),
  comfyUi: z.object({
    promptId: z.string().uuid(),
    clientId: z.string().min(1).max(200),
    submittedWorkflowHash: z.string().regex(/^[a-f0-9]{64}$/i),
    historySha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
    eventName: z.enum(["execution_error", "execution_interrupted"]).optional(),
    confirmationKind: z.enum(["history_interrupted", "pending_deleted"]).optional(),
    cancellationResponseSha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
  }).strict().optional(),
  reconciliation: z.object({
    method: z.enum(["provider_task_list", "client_job_id_search", "provider_idempotency_lookup", "provider_request_log", "provider_support", "browser_history"]),
    result: z.enum(["found", "not_found"]),
    clientJobId: z.string().min(3).max(200),
    attempt: z.number().int().positive(),
    evidenceReference: z.string().min(3).max(200),
    note: z.string().min(3).max(1_000),
    externalTaskId: z.string().min(1).max(200).optional(),
    confirmNoRemoteResult: z.literal(true).optional(),
    checkedAt: z.string().min(1),
  }).strict().optional(),
}).strict();
const publicationIntentSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  projectId: z.string().min(1),
  revision: z.number().int().positive(),
  status: z.enum(["reserved", "registered", "cancelled", "failed"]),
  idempotencyKey: z.string().min(8).max(200),
  requestHash: z.string().regex(/^[a-f0-9]{64}$/i),
  reservationToken: z.string().min(1),
  requestedPath: z.string().refine((value) => path.isAbsolute(value), "requestedPath 必须是绝对路径"),
  targetPath: z.string().refine((value) => path.isAbsolute(value), "targetPath 必须是绝对路径"),
  allowedRoot: z.string().refine((value) => path.isAbsolute(value), "allowedRoot 必须是绝对路径"),
  kind: z.enum(PUBLICATION_KINDS),
  variant: z.enum(PUBLICATION_VARIANTS),
  context: publicationContextSchema,
  bundleId: z.string().min(8).max(200).optional(),
  bundleMember: z.enum(["primary", "companion"]).optional(),
  note: z.string().max(4_000).optional(),
  terminal: z.object({ reason: z.string().min(1).max(4_000), at: z.string().min(1), provenance: generationPublicationTerminalProvenanceSchema.optional() }).passthrough().optional(),
  receiptId: z.string().min(1).optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
}).passthrough();
const publicationReceiptSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  intentId: z.string().min(1),
  projectId: z.string().min(1),
  targetPath: z.string().refine((value) => path.isAbsolute(value), "回执 targetPath 必须是绝对路径"),
  kind: z.enum(PUBLICATION_KINDS),
  variant: z.enum(PUBLICATION_VARIANTS),
  context: publicationContextSchema,
  bundleId: z.string().min(8).max(200).optional(),
  bundleMember: z.enum(["primary", "companion"]).optional(),
  check: z.object({
    ok: z.literal(true),
    exists: z.literal(true),
    decodable: z.boolean().optional(),
    width: z.number().positive().optional(),
    height: z.number().positive().optional(),
    duration: z.number().positive().optional(),
    size: z.number().int().positive(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/i),
    modifiedAt: z.string().min(1),
    issues: z.array(z.string()),
  }).passthrough(),
  registeredAt: z.string().min(1),
}).passthrough();
const publicationStoreSchema = z.object({
  schemaVersion: z.literal(1),
  revision: z.number().int().nonnegative(),
  intents: z.array(publicationIntentSchema),
  receipts: z.array(publicationReceiptSchema),
  updatedAt: z.string().min(1),
}).passthrough();

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, stableValue(entry)]));
  return value;
}

function requestHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
}

function validateIdempotencyKey(value: string): string {
  const normalized = value.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,199}$/.test(normalized)) throw new Error("发布幂等键必须为 8–200 位稳定标识。 ");
  return normalized;
}

function validateBundleId(value: string): string {
  const normalized = value.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,199}$/.test(normalized)) throw new Error("发布 bundleId 必须为 8–200 位稳定标识。 ");
  return normalized;
}

function normalizeContext(context: PublicationContext): PublicationContext {
  if (!PUBLICATION_PURPOSES.includes(context.purpose)) throw new Error(`未知发布用途：${context.purpose}`);
  const normalizeId = (value: string | undefined, label: string) => {
    const normalized = value?.trim();
    if (normalized && normalized.length > 200) throw new Error(`${label} 过长。`);
    return normalized || undefined;
  };
  const metadataEntries = Object.entries(context.metadata ?? {});
  if (metadataEntries.length > 100) throw new Error("发布用途元数据最多 100 项。 ");
  const metadataKeys = new Set<string>();
  const metadata = Object.fromEntries(metadataEntries.map(([key, value]) => {
    const normalizedKey = key.trim();
    if (!normalizedKey || normalizedKey.length > 120) throw new Error("发布用途元数据键不能为空或超过 120 字符。 ");
    if (metadataKeys.has(normalizedKey)) throw new Error(`发布用途元数据键重复：${normalizedKey}`);
    metadataKeys.add(normalizedKey);
    if (!["string", "number", "boolean"].includes(typeof value)) throw new Error(`发布用途元数据 ${normalizedKey} 只能是字符串、数字或布尔值。`);
    if (typeof value === "string" && value.length > 4_000) throw new Error(`发布用途元数据 ${normalizedKey} 过长。`);
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error(`发布用途元数据 ${normalizedKey} 不是有限数字。`);
    return [normalizedKey, value];
  }));
  return {
    purpose: context.purpose,
    itemId: normalizeId(context.itemId, "itemId"),
    taskId: normalizeId(context.taskId, "taskId"),
    jobId: normalizeId(context.jobId, "jobId"),
    metadata: Object.keys(metadata).length ? metadata : undefined,
  };
}

async function canonicalDirectoryWithin(root: string, targetPath: string): Promise<void> {
  await mkdir(root, { recursive: true });
  await mkdir(path.dirname(targetPath), { recursive: true });
  const [canonicalRoot, canonicalParent] = await Promise.all([realpath(root), realpath(path.dirname(targetPath))]);
  if (!isWithin(canonicalRoot, canonicalParent)) throw new Error("发布路径通过符号链接逃逸了允许输出根。 ");
}

async function exists(candidate: string): Promise<boolean> {
  return lstat(candidate).then(() => true).catch(() => false);
}

function nextVersionPath(requestedPath: string, version: number): string {
  const parsed = path.parse(requestedPath);
  const match = parsed.name.match(/^(.*?)(?:_v(\d+))?$/i);
  const base = match?.[1] || parsed.name;
  const currentWidth = match?.[2]?.length ?? 3;
  return path.join(parsed.dir, `${base}_v${String(version).padStart(Math.max(3, currentWidth), "0")}${parsed.ext}`);
}

async function allocateTargetPath(requestedPath: string, occupied: Set<string>): Promise<string> {
  if (!occupied.has(path.resolve(requestedPath)) && !(await exists(requestedPath))) return requestedPath;
  const parsed = path.parse(requestedPath);
  const existingVersion = Number(parsed.name.match(/_v(\d+)$/i)?.[1] ?? 1);
  for (let version = Math.max(2, existingVersion + 1); version < existingVersion + 10_000; version += 1) {
    const candidate = nextVersionPath(requestedPath, version);
    if (!occupied.has(path.resolve(candidate)) && !(await exists(candidate))) return candidate;
  }
  throw new Error("无法为发布结果分配新的版本路径。 ");
}

function parsePairedImagePath(filePath: string, member: PublicationBundleMember): {
  directory: string;
  base: string;
  extension: string;
  version?: number;
  versionWidth: number;
} {
  const parsed = path.parse(filePath);
  const suffix = member === "primary" ? "raw" : "labeled";
  const match = parsed.name.match(new RegExp(`^(.*?)(?:_v(\\d+))?_${suffix}$`, "iu"));
  if (!match?.[1]) throw new Error(`成对图片路径必须以 _${suffix}.<ext> 结尾，并把版本号放在 _${suffix} 之前。`);
  return {
    directory: parsed.dir,
    base: match[1],
    extension: parsed.ext,
    version: match[2] ? Number(match[2]) : undefined,
    versionWidth: Math.max(3, match[2]?.length ?? 3),
  };
}

async function allocatePairedTargetPaths(
  primaryRequestedPath: string,
  companionRequestedPath: string,
  occupied: Set<string>,
): Promise<{ primary: string; companion: string }> {
  const primary = parsePairedImagePath(primaryRequestedPath, "primary");
  const companion = parsePairedImagePath(companionRequestedPath, "companion");
  if (path.resolve(primary.directory) !== path.resolve(companion.directory)
    || primary.base !== companion.base
    || primary.extension.toLowerCase() !== companion.extension.toLowerCase()
    || primary.version !== companion.version) {
    throw new Error("raw/labeled 请求路径必须共享目录、基础名、扩展名与版本号。 ");
  }
  const exact = { primary: path.resolve(primaryRequestedPath), companion: path.resolve(companionRequestedPath) };
  const exactFree = !occupied.has(exact.primary)
    && !occupied.has(exact.companion)
    && !(await exists(exact.primary))
    && !(await exists(exact.companion));
  if (exactFree) return exact;
  const startingVersion = Math.max(2, (primary.version ?? 1) + 1);
  const width = Math.max(primary.versionWidth, companion.versionWidth);
  for (let version = startingVersion; version < startingVersion + 10_000; version += 1) {
    const versionText = String(version).padStart(width, "0");
    const candidates = {
      primary: path.join(primary.directory, `${primary.base}_v${versionText}_raw${primary.extension}`),
      companion: path.join(primary.directory, `${primary.base}_v${versionText}_labeled${primary.extension}`),
    };
    if (!occupied.has(path.resolve(candidates.primary))
      && !occupied.has(path.resolve(candidates.companion))
      && !(await exists(candidates.primary))
      && !(await exists(candidates.companion))) {
      return candidates;
    }
  }
  throw new Error("无法为 raw/labeled 发布事务分配共同版本路径。 ");
}

function normalizeBundleMembers<T extends { member: PublicationBundleMember }>(members: T[]): [T, T] {
  if (members.length !== 2) throw new Error("raw/labeled 发布事务必须且只能包含两个成员。 ");
  const primary = members.find((member) => member.member === "primary");
  const companion = members.find((member) => member.member === "companion");
  if (!primary || !companion || primary === companion) throw new Error("发布事务必须同时包含唯一 primary 与 companion。 ");
  return [primary, companion];
}

function fileType(metadata: BigIntStats): PresentFileIdentity["type"] {
  if (metadata.isFile()) return "file";
  if (metadata.isDirectory()) return "directory";
  if (metadata.isSymbolicLink()) return "symlink";
  return "other";
}

function presentFileIdentity(metadata: BigIntStats): PresentFileIdentity {
  return {
    state: "present",
    type: fileType(metadata),
    dev: metadata.dev.toString(),
    ino: metadata.ino.toString(),
    mode: metadata.mode.toString(),
    nlink: metadata.nlink.toString(),
    size: metadata.size.toString(),
    mtimeNs: metadata.mtimeNs.toString(),
    ctimeNs: metadata.ctimeNs.toString(),
  };
}

function fileErrorCode(error: unknown): string {
  return error instanceof Error && "code" in error && typeof (error as NodeJS.ErrnoException).code === "string"
    ? (error as NodeJS.ErrnoException).code!
    : "UNKNOWN";
}

async function captureFileIdentity(filePath: string): Promise<FileIdentity> {
  try {
    return presentFileIdentity(await lstat(filePath, { bigint: true }));
  } catch (error) {
    return fileErrorCode(error) === "ENOENT" ? { state: "missing" } : { state: "error", code: fileErrorCode(error) };
  }
}

async function captureBoundaryIdentity(allowedRoot: string, targetPath: string): Promise<BoundaryIdentity> {
  const resolvedRoot = path.resolve(allowedRoot);
  const parentPath = path.resolve(path.dirname(targetPath));
  let canonicalRoot: string | undefined;
  let canonicalParent: string | undefined;
  try {
    [canonicalRoot, canonicalParent] = await Promise.all([realpath(resolvedRoot), realpath(parentPath)]);
  } catch (error) {
    const [rootIdentity, parentIdentity] = await Promise.all([captureFileIdentity(resolvedRoot), captureFileIdentity(parentPath)]);
    return { valid: false, reason: `发布允许根或目标父目录不可解析（${fileErrorCode(error)}）。`, allowedRoot: resolvedRoot, parentPath, canonicalRoot, canonicalParent, rootIdentity, parentIdentity };
  }
  const [rootIdentity, parentIdentity] = await Promise.all([captureFileIdentity(canonicalRoot), captureFileIdentity(canonicalParent)]);
  const escaped = !isWithin(canonicalRoot, canonicalParent);
  const invalidDirectory = rootIdentity.state !== "present" || rootIdentity.type !== "directory" || parentIdentity.state !== "present" || parentIdentity.type !== "directory";
  return {
    valid: !escaped && !invalidDirectory,
    reason: escaped ? "发布路径通过符号链接逃逸了允许输出根。 " : invalidDirectory ? "发布允许根或目标父路径不是可用目录。 " : undefined,
    allowedRoot: resolvedRoot,
    parentPath,
    canonicalRoot,
    canonicalParent,
    rootIdentity,
    parentIdentity,
  };
}

async function captureValidationIdentity(intent: Pick<PublicationIntent, "allowedRoot" | "targetPath">): Promise<PublicationValidationIdentity> {
  const [file, boundary] = await Promise.all([captureFileIdentity(intent.targetPath), captureBoundaryIdentity(intent.allowedRoot, intent.targetPath)]);
  return { file, boundary };
}

function sameIdentity(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertStableIdentity(expected: PublicationValidationIdentity, actual: PublicationValidationIdentity, message?: string): void {
  if (!sameIdentity(expected, actual)) throw new PublicationValidationConflict(message);
}

function positiveFileSize(identity: FileIdentity): number {
  if (identity.state === "missing") throw new Error("最终发布文件不存在。 ");
  if (identity.state === "error") throw new Error(`最终发布文件无法读取（${identity.code}）。`);
  if (identity.type !== "file") throw new Error("最终发布路径必须是普通文件，不能是目录或符号链接。 ");
  const size = Number(identity.size);
  if (!Number.isSafeInteger(size)) throw new Error("最终发布文件过大，无法安全记录机械验收尺寸。 ");
  if (size <= 0) throw new Error("最终发布文件为空。 ");
  return size;
}

function publicationHashTimeout(options: PublicationRegistrationOptions): number {
  const environmentValue = Number(process.env.AI_CANVAS_PUBLICATION_HASH_TIMEOUT_MS);
  const configured = options.hashTimeoutMs ?? (Number.isFinite(environmentValue) && environmentValue > 0 ? environmentValue : 120_000);
  return Math.max(50, Math.min(30 * 60_000, Math.floor(configured)));
}

async function hashOpenFile(handle: FileHandle, timeoutMs: number): Promise<string> {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const deadline = Date.now() + timeoutMs;
  let position = 0;
  while (true) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new Error(`最终发布文件 SHA-256 校验超时（${timeoutMs}ms）。`);
    let timer: NodeJS.Timeout | undefined;
    const read = handle.read(buffer, 0, buffer.length, position);
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`最终发布文件 SHA-256 校验超时（${timeoutMs}ms）。`)), remainingMs);
      timer.unref();
    });
    const { bytesRead } = await Promise.race([read, timeout]).finally(() => {
      if (timer) clearTimeout(timer);
    });
    if (bytesRead === 0) break;
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return hash.digest("hex");
}

function modifiedAtFromIdentity(identity: PresentFileIdentity): string {
  const milliseconds = Number(BigInt(identity.mtimeNs) / 1_000_000n);
  const value = new Date(milliseconds);
  if (!Number.isFinite(milliseconds) || Number.isNaN(value.getTime())) throw new Error("最终发布文件修改时间无效。 ");
  return value.toISOString();
}

async function inspectPublicationFile(
  projectRoot: string,
  filePath: string,
  kind: ArtifactKind,
  expectedIdentity: PublicationValidationIdentity,
  options: PublicationRegistrationOptions,
): Promise<PublicationReceipt["check"]> {
  const size = positiveFileSize(expectedIdentity.file);
  if (!expectedIdentity.boundary.valid) throw new Error(expectedIdentity.boundary.reason ?? "发布路径没有通过允许根校验。 ");
  if (expectedIdentity.file.state !== "present") throw new Error("最终发布文件身份不可用。 ");
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  const handle = await open(filePath, fsConstants.O_RDONLY | noFollow);
  let decodable: boolean | undefined;
  let width: number | undefined;
  let height: number | undefined;
  let duration: number | undefined;
  try {
    const openedIdentity = presentFileIdentity(await handle.stat({ bigint: true }));
    if (!sameIdentity(expectedIdentity.file, openedIdentity)) throw new PublicationValidationConflict("最终发布文件在打开固定句柄前发生变化，CAS 未提交；发布意图仍保留为 reserved。");
    if (["raw-image", "labeled-image"].includes(kind)) {
      const image = await (await loadSharpDefault())(filePath).metadata().catch(() => undefined);
      width = image?.width;
      height = image?.height;
      decodable = Boolean(image?.format && width && height);
      if (!decodable) throw new Error("最终图片无法解码或缺少有效尺寸。 ");
    }
    if (["video", "audio"].includes(kind)) {
      const args = kind === "video"
        ? ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,width,height:format=duration", "-of", "json", filePath]
        : ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_name:format=duration", "-of", "json", filePath];
      const result = await runMediaProcess(process.env.FFPROBE_PATH || "ffprobe", args, {
        projectRoot,
        tool: "ffprobe",
        stage: "publication-register",
        weight: MEDIA_WEIGHTS.probe,
        timeoutMs: mediaStageTimeout("ffprobe"),
        maxOutputBytes: 1_000_000,
      });
      if (result.status !== "succeeded") {
        throw new Error(result.status === "timed_out"
          ? `最终${kind === "video" ? "视频" : "音频"}的 ffprobe 校验超时。`
          : `最终${kind === "video" ? "视频" : "音频"}的 ffprobe 校验失败：${result.output.trim().split("\n").slice(-8).join("\n") || `退出码 ${result.code}`}`);
      }
      const probe = (() => {
        try { return JSON.parse(result.stdout) as { streams?: Array<{ codec_name?: string; width?: number; height?: number }>; format?: { duration?: string } }; }
        catch { return undefined; }
      })();
      const stream = probe?.streams?.[0];
      width = stream?.width;
      height = stream?.height;
      duration = Number(probe?.format?.duration);
      decodable = Boolean(stream?.codec_name && Number.isFinite(duration) && duration > 0 && (kind === "audio" || (width && height)));
      if (!decodable) throw new Error(`最终${kind === "video" ? "视频" : "音频"}无法通过 ffprobe 解码。`);
    }
    const sha256 = await hashOpenFile(handle, publicationHashTimeout(options));
    const afterHandleIdentity = presentFileIdentity(await handle.stat({ bigint: true }));
    if (!sameIdentity(openedIdentity, afterHandleIdentity)) throw new PublicationValidationConflict("最终发布文件内容在固定句柄校验期间发生变化，CAS 未提交；发布意图仍保留为 reserved。");
    return {
      ok: true,
      exists: true,
      decodable,
      width,
      height,
      duration,
      size,
      sha256,
      modifiedAt: modifiedAtFromIdentity(afterHandleIdentity),
      issues: [],
    };
  } finally {
    await handle.close();
  }
}

async function validateRegistrationSnapshot(projectRoot: string, snapshot: RegistrationSnapshot, options: PublicationRegistrationOptions): Promise<PublicationValidationOutcome> {
  const start = await captureValidationIdentity(snapshot.intent);
  assertStableIdentity(snapshot.identity, start, "最终发布文件或路径在锁内快照释放后发生变化，CAS 未提交；发布意图仍保留为 reserved。");
  try {
    const check = await inspectPublicationFile(projectRoot, snapshot.intent.targetPath, snapshot.intent.kind, start, options);
    const end = await captureValidationIdentity(snapshot.intent);
    assertStableIdentity(start, end);
    return { kind: "success", check, identity: end };
  } catch (error) {
    if (error instanceof PublicationValidationConflict) throw error;
    const end = await captureValidationIdentity(snapshot.intent);
    assertStableIdentity(start, end);
    return { kind: "failure", reason: error instanceof Error ? error.message : String(error), identity: end };
  }
}

async function loadStore(projectRoot: string): Promise<PublicationStore> {
  const filePath = getPublicationStorePath(projectRoot);
  const value = await readJson<unknown>(filePath, emptyStore());
  const parsed = publicationStoreSchema.safeParse(value);
  if (!parsed.success) {
    const detail = parsed.error.issues.slice(0, 8).map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`).join("；");
    throw new Error(`发布侧车结构损坏：${filePath}（${detail}）`);
  }
  return parsed.data as PublicationStore;
}

function actorEvent(actor: ProjectEvent["actor"]): ProjectEvent["actor"] {
  return actor;
}

export async function preflightPublication(
  projectRoot: string,
  input: PreflightPublicationInput,
  actor: ProjectEvent["actor"] = "codex",
): Promise<PublicationIntent> {
  return withProjectLock(projectRoot, "publications", async () => {
    const config = await loadProjectConfig(projectRoot);
    const idempotencyKey = validateIdempotencyKey(input.idempotencyKey ?? getOperationContext()?.idempotencyKey ?? "");
    const requestedPath = path.resolve(input.requestedPath);
    // P4 中文分镜板只能由内容寻址 sheet store 登记，不能借通用 Publication
    // 入口伪造正式板。因此 PUBLICATION_KINDS 有意不包含三种 sheet Artifact。
    if (!PUBLICATION_KINDS.includes(input.kind as (typeof PUBLICATION_KINDS)[number])) throw new Error(`未知发布文件类型：${String(input.kind)}`);
    if (input.variant !== undefined && !PUBLICATION_VARIANTS.includes(input.variant)) throw new Error(`未知发布文件变体：${String(input.variant)}`);
    if (!path.isAbsolute(input.requestedPath)) throw new Error("发布目标必须使用绝对路径。 ");
    if (requestedPath === path.parse(requestedPath).root) throw new Error("发布目标必须是文件路径。 ");
    const configuredRoots = [...new Set([config.primaryRoot, ...config.outputRoots].map((root) => path.resolve(root)))];
    const explicitRoot = input.allowedRoot ? path.resolve(input.allowedRoot) : undefined;
    if (explicitRoot && !configuredRoots.includes(explicitRoot)) throw new Error("指定允许根不在项目配置的输出根中。 ");
    const allowedRoot = explicitRoot ?? configuredRoots.filter((root) => isWithin(root, requestedPath)).sort((a, b) => b.length - a.length)[0];
    if (!allowedRoot || !isWithin(allowedRoot, requestedPath)) throw new Error("发布目标不在项目允许输出根中。 ");
    if (isWithin(getSidecarPaths(projectRoot).root, requestedPath)) throw new Error("发布媒体不能写入 .aicanvas 侧车目录。 ");
    await canonicalDirectoryWithin(allowedRoot, requestedPath);
    const context = normalizeContext(input.context);
    const bundleId = input.bundleId ? validateBundleId(input.bundleId) : undefined;
    if (Boolean(bundleId) !== Boolean(input.bundleMember)) throw new Error("发布 bundleId 与 bundleMember 必须同时提供。 ");
    const normalizedRequest = { requestedPath, allowedRoot, kind: input.kind, variant: input.variant ?? "generic", context, bundleId, bundleMember: input.bundleMember, note: input.note?.trim().slice(0, 4_000) || undefined };
    const hash = requestHash(normalizedRequest);
    const store = await loadStore(projectRoot);
    const replay = store.intents.find((intent) => intent.idempotencyKey === idempotencyKey);
    if (replay) {
      if (replay.requestHash !== hash) throw new Error("发布幂等键已用于不同参数，拒绝复用。 ");
      return replay;
    }
    const occupied = new Set(store.intents.filter((intent) => ["reserved", "registered"].includes(intent.status)).map((intent) => path.resolve(intent.targetPath)));
    const targetPath = await allocateTargetPath(requestedPath, occupied);
    const now = new Date().toISOString();
    const intent: PublicationIntent = {
      schemaVersion: 1,
      id: `publication-${randomUUID()}`,
      projectId: config.id,
      revision: 1,
      status: "reserved",
      idempotencyKey,
      requestHash: hash,
      reservationToken: randomUUID(),
      requestedPath,
      targetPath,
      allowedRoot,
      kind: input.kind,
      variant: input.variant ?? "generic",
      context,
      bundleId,
      bundleMember: input.bundleMember,
      note: normalizedRequest.note,
      createdAt: now,
      updatedAt: now,
    };
    store.intents.unshift(intent);
    store.revision += 1;
    store.updatedAt = now;
    await writeJsonAtomic(getPublicationStorePath(projectRoot), store);
    await appendEvent(projectRoot, { actor: actorEvent(actor), type: "publication.preflighted", itemId: context.itemId, idempotencyKey, data: { intentId: intent.id, purpose: context.purpose, targetPath, allowedRoot, kind: intent.kind } });
    return intent;
  });
}

export async function preflightPublicationBundle(
  projectRoot: string,
  input: PreflightPublicationBundleInput,
  actor: ProjectEvent["actor"] = "codex",
): Promise<PreflightPublicationBundleResult> {
  return withProjectLock(projectRoot, "publications", async () => {
    const config = await loadProjectConfig(projectRoot);
    const bundleId = validateBundleId(input.bundleId);
    const idempotencyKey = validateIdempotencyKey(input.idempotencyKey ?? getOperationContext()?.idempotencyKey ?? "");
    const primaryRequestedPath = path.resolve(input.primaryRequestedPath);
    const companionRequestedPath = path.resolve(input.companionRequestedPath);
    if (!path.isAbsolute(input.primaryRequestedPath) || !path.isAbsolute(input.companionRequestedPath)) throw new Error("发布事务目标必须使用绝对路径。 ");
    if (primaryRequestedPath === path.parse(primaryRequestedPath).root || companionRequestedPath === path.parse(companionRequestedPath).root) throw new Error("发布事务目标必须是文件路径。 ");
    const configuredRoots = [...new Set([config.primaryRoot, ...config.outputRoots].map((root) => path.resolve(root)))];
    const explicitRoot = input.allowedRoot ? path.resolve(input.allowedRoot) : undefined;
    if (explicitRoot && !configuredRoots.includes(explicitRoot)) throw new Error("指定允许根不在项目配置的输出根中。 ");
    const allowedRoot = explicitRoot ?? configuredRoots
      .filter((root) => isWithin(root, primaryRequestedPath) && isWithin(root, companionRequestedPath))
      .sort((a, b) => b.length - a.length)[0];
    if (!allowedRoot || !isWithin(allowedRoot, primaryRequestedPath) || !isWithin(allowedRoot, companionRequestedPath)) throw new Error("发布事务目标不在同一项目允许输出根中。 ");
    if (isWithin(getSidecarPaths(projectRoot).root, primaryRequestedPath) || isWithin(getSidecarPaths(projectRoot).root, companionRequestedPath)) throw new Error("发布媒体不能写入 .aicanvas 侧车目录。 ");
    await Promise.all([
      canonicalDirectoryWithin(allowedRoot, primaryRequestedPath),
      canonicalDirectoryWithin(allowedRoot, companionRequestedPath),
    ]);
    const context = normalizeContext(input.context);
    const variant = input.variant ?? "generic";
    if (!PUBLICATION_VARIANTS.includes(variant)) throw new Error(`未知发布文件变体：${String(variant)}`);
    const note = input.note?.trim().slice(0, 4_000) || undefined;
    const memberRequests = [
      {
        member: "primary" as const,
        idempotencyKey: validateIdempotencyKey(`${idempotencyKey}:primary`),
        requestedPath: primaryRequestedPath,
        kind: "raw-image" as const,
      },
      {
        member: "companion" as const,
        idempotencyKey: validateIdempotencyKey(`${idempotencyKey}:companion`),
        requestedPath: companionRequestedPath,
        kind: "labeled-image" as const,
      },
    ];
    const memberRequestHash = (request: typeof memberRequests[number]) => requestHash({
      requestedPath: request.requestedPath,
      allowedRoot,
      kind: request.kind,
      variant,
      context,
      bundleId,
      bundleMember: request.member,
      note,
    });
    const store = await loadStore(projectRoot);
    const existingBundleMembers = store.intents.filter((intent) => intent.bundleId === bundleId);
    if (existingBundleMembers.length) {
      if (existingBundleMembers.length !== 2) throw new Error(`发布事务 ${bundleId} 成员数量损坏，拒绝重放。`);
      const [primary, companion] = normalizeBundleMembers(existingBundleMembers.map((intent) => ({
        member: intent.bundleMember as PublicationBundleMember,
        intent,
      })));
      for (const existing of [primary, companion]) {
        const expected = memberRequests.find((request) => request.member === existing.member)!;
        if (existing.intent.idempotencyKey !== expected.idempotencyKey || existing.intent.requestHash !== memberRequestHash(expected)) {
          throw new Error(`发布事务 ${bundleId} 幂等重放参数不一致。`);
        }
      }
      return { bundleId, primary: structuredClone(primary.intent), companion: structuredClone(companion.intent) };
    }
    for (const request of memberRequests) {
      const reused = store.intents.find((intent) => intent.idempotencyKey === request.idempotencyKey);
      if (reused) throw new Error(`发布幂等键 ${request.idempotencyKey} 已用于其他事务。`);
    }
    const occupied = new Set(store.intents.filter((intent) => ["reserved", "registered"].includes(intent.status)).map((intent) => path.resolve(intent.targetPath)));
    const targets = await allocatePairedTargetPaths(primaryRequestedPath, companionRequestedPath, occupied);
    const now = new Date().toISOString();
    const intents = memberRequests.map((request): PublicationIntent => ({
      schemaVersion: 1,
      id: `publication-${randomUUID()}`,
      projectId: config.id,
      revision: 1,
      status: "reserved",
      idempotencyKey: request.idempotencyKey,
      requestHash: memberRequestHash(request),
      reservationToken: randomUUID(),
      requestedPath: request.requestedPath,
      targetPath: targets[request.member],
      allowedRoot,
      kind: request.kind,
      variant,
      context,
      bundleId,
      bundleMember: request.member,
      note,
      createdAt: now,
      updatedAt: now,
    }));
    const [primary, companion] = normalizeBundleMembers(intents.map((intent) => ({ member: intent.bundleMember!, intent })));
    store.intents.unshift(primary.intent, companion.intent);
    store.revision += 1;
    store.updatedAt = now;
    await writeJsonAtomic(getPublicationStorePath(projectRoot), store);
    await appendEvent(projectRoot, {
      actor: actorEvent(actor),
      type: "publication.bundle-preflighted",
      itemId: context.itemId,
      idempotencyKey,
      data: {
        bundleId,
        primaryIntentId: primary.intent.id,
        companionIntentId: companion.intent.id,
        primaryTargetPath: primary.intent.targetPath,
        companionTargetPath: companion.intent.targetPath,
        allowedRoot,
        variant,
      },
    });
    return { bundleId, primary: primary.intent, companion: companion.intent };
  });
}

export async function bindPublicationBundle(
  projectRoot: string,
  input: BindPublicationBundleInput,
  actor: ProjectEvent["actor"] = "codex",
): Promise<PreflightPublicationBundleResult> {
  const bundleId = validateBundleId(input.bundleId);
  const [primaryInput, companionInput] = normalizeBundleMembers(input.members);
  const result = await withProjectLock(projectRoot, "publications", async (): Promise<PreflightPublicationBundleResult & { changed: boolean }> => {
    const store = await loadStore(projectRoot);
    const resolved = [primaryInput, companionInput].map((member) => {
      if (!Number.isInteger(member.expectedRevision) || member.expectedRevision < 1) throw new Error("绑定发布事务必须携带当前正整数 expectedRevision。 ");
      const intent = store.intents.find((candidate) => candidate.id === member.intentId);
      if (!intent) throw new Error(`找不到发布意图：${member.intentId}`);
      if (intent.reservationToken !== member.reservationToken) throw new Error(`发布事务 ${member.member} 预留令牌不匹配。`);
      if (intent.revision !== member.expectedRevision) throw new Error(`发布事务 ${member.member} 意图已更新（当前修订 ${intent.revision}）。`);
      if (intent.status !== "reserved" || intent.receiptId) throw new Error(`发布事务 ${member.member} 必须是尚未登记的 reserved 意图。`);
      if (intent.bundleId && (intent.bundleId !== bundleId || intent.bundleMember !== member.member)) throw new Error(`发布事务 ${member.member} 已绑定不同事务。`);
      return { member: member.member, intent };
    });
    const existing = store.intents.filter((intent) => intent.bundleId === bundleId && !resolved.some((member) => member.intent.id === intent.id));
    if (existing.length) throw new Error(`bundleId ${bundleId} 已被其他发布意图占用。`);
    const primary = resolved.find((member) => member.member === "primary")!;
    const companion = resolved.find((member) => member.member === "companion")!;
    if (primary.intent.kind !== "raw-image" || companion.intent.kind !== "labeled-image") throw new Error("raw/labeled 发布事务的成员类型不正确。 ");
    if (primary.intent.projectId !== companion.intent.projectId
      || primary.intent.variant !== companion.intent.variant
      || primary.intent.allowedRoot !== companion.intent.allowedRoot
      || primary.intent.context.purpose !== companion.intent.context.purpose
      || primary.intent.context.itemId !== companion.intent.context.itemId
      || primary.intent.context.taskId !== companion.intent.context.taskId
      || primary.intent.context.jobId !== companion.intent.context.jobId
      || path.resolve(primary.intent.targetPath) === path.resolve(companion.intent.targetPath)) {
      throw new Error("raw/labeled 发布事务成员的项目上下文、变体、允许根或路径不合法。 ");
    }
    const alreadyBound = resolved.every((member) => member.intent.bundleId === bundleId && member.intent.bundleMember === member.member);
    if (alreadyBound) return { bundleId, primary: structuredClone(primary.intent), companion: structuredClone(companion.intent), changed: false };
    if (resolved.some((member) => member.intent.bundleId || member.intent.bundleMember)) throw new Error("发布事务出现单边绑定，拒绝修补损坏状态。 ");
    const now = new Date().toISOString();
    for (const member of resolved) {
      member.intent.bundleId = bundleId;
      member.intent.bundleMember = member.member;
      member.intent.revision += 1;
      member.intent.updatedAt = now;
    }
    store.revision += 1;
    store.updatedAt = now;
    await writeJsonAtomic(getPublicationStorePath(projectRoot), store);
    return { bundleId, primary: structuredClone(primary.intent), companion: structuredClone(companion.intent), changed: true };
  });
  if (result.changed) {
    await appendEvent(projectRoot, {
      actor: actorEvent(actor),
      type: "publication.bundle-bound",
      itemId: result.primary.context.itemId,
      data: { bundleId, primaryIntentId: result.primary.id, companionIntentId: result.companion.id },
    });
  }
  return { bundleId, primary: result.primary, companion: result.companion };
}

export async function extendPublicationToBundle(
  projectRoot: string,
  input: ExtendPublicationToBundleInput,
  actor: ProjectEvent["actor"] = "codex",
): Promise<PreflightPublicationBundleResult> {
  const bundleId = validateBundleId(input.bundleId);
  const idempotencyKey = validateIdempotencyKey(input.idempotencyKey ?? getOperationContext()?.idempotencyKey ?? "");
  const companionRequestedPath = path.resolve(input.companionRequestedPath);
  if (!path.isAbsolute(input.companionRequestedPath)) throw new Error("companion 发布目标必须使用绝对路径。 ");
  const result = await withProjectLock(projectRoot, "publications", async (): Promise<PreflightPublicationBundleResult & { changed: boolean }> => {
    const store = await loadStore(projectRoot);
    const primary = store.intents.find((intent) => intent.id === input.primaryIntentId);
    if (!primary) throw new Error(`找不到 primary 发布意图：${input.primaryIntentId}`);
    if (primary.reservationToken !== input.primaryReservationToken) throw new Error("primary 发布预留令牌不匹配。 ");
    if (!Number.isInteger(input.primaryExpectedRevision) || input.primaryExpectedRevision < 1 || primary.revision !== input.primaryExpectedRevision) {
      throw new Error(`primary 发布意图已更新（当前修订 ${primary.revision}）。`);
    }
    const existingBundleMembers = store.intents.filter((intent) => intent.bundleId === bundleId);
    if (primary.bundleId) {
      if (primary.bundleId !== bundleId || primary.bundleMember !== "primary" || existingBundleMembers.length !== 2) throw new Error("primary 已绑定不同或损坏的发布事务。 ");
      const companion = existingBundleMembers.find((intent) => intent.bundleMember === "companion");
      if (!companion) throw new Error("已绑定发布事务缺少 companion。 ");
      return { bundleId, primary: structuredClone(primary), companion: structuredClone(companion), changed: false };
    }
    if (existingBundleMembers.length) throw new Error(`bundleId ${bundleId} 已被其他发布意图占用。`);
    if (primary.status !== "reserved" || primary.receiptId || primary.kind !== "raw-image") throw new Error("只有尚未登记的 raw-image primary 可以扩展为 raw/labeled 事务。 ");
    if (!isWithin(primary.allowedRoot, companionRequestedPath) || isWithin(getSidecarPaths(projectRoot).root, companionRequestedPath)) throw new Error("companion 目标不在 primary 的允许输出根中。 ");
    await canonicalDirectoryWithin(primary.allowedRoot, companionRequestedPath);
    const primaryName = parsePairedImagePath(primary.targetPath, "primary");
    const companionName = parsePairedImagePath(companionRequestedPath, "companion");
    if (path.resolve(primaryName.directory) !== path.resolve(companionName.directory)
      || primaryName.base !== companionName.base
      || primaryName.extension.toLowerCase() !== companionName.extension.toLowerCase()
      || primaryName.version !== companionName.version) {
      throw new Error("companion 路径必须与已预留 primary 使用相同基础名和版本。 ");
    }
    if (path.resolve(primary.targetPath) === companionRequestedPath) throw new Error("primary 与 companion 不能使用同一路径。 ");
    const occupied = store.intents.some((intent) => ["reserved", "registered"].includes(intent.status) && path.resolve(intent.targetPath) === companionRequestedPath);
    if (occupied || await exists(companionRequestedPath)) throw new Error("companion 目标已被文件或发布意图占用，禁止覆盖。 ");
    const companionIdempotencyKey = validateIdempotencyKey(`${idempotencyKey}:companion`);
    if (store.intents.some((intent) => intent.idempotencyKey === companionIdempotencyKey)) throw new Error("companion 发布幂等键已被占用。 ");
    const now = new Date().toISOString();
    const note = input.note?.trim().slice(0, 4_000) || undefined;
    const companion: PublicationIntent = {
      schemaVersion: 1,
      id: `publication-${randomUUID()}`,
      projectId: primary.projectId,
      revision: 1,
      status: "reserved",
      idempotencyKey: companionIdempotencyKey,
      requestHash: requestHash({
        requestedPath: companionRequestedPath,
        allowedRoot: primary.allowedRoot,
        kind: "labeled-image",
        variant: primary.variant,
        context: primary.context,
        bundleId,
        bundleMember: "companion",
        note,
      }),
      reservationToken: randomUUID(),
      requestedPath: companionRequestedPath,
      targetPath: companionRequestedPath,
      allowedRoot: primary.allowedRoot,
      kind: "labeled-image",
      variant: primary.variant,
      context: primary.context,
      bundleId,
      bundleMember: "companion",
      note,
      createdAt: now,
      updatedAt: now,
    };
    primary.bundleId = bundleId;
    primary.bundleMember = "primary";
    primary.revision += 1;
    primary.updatedAt = now;
    store.intents.unshift(companion);
    store.revision += 1;
    store.updatedAt = now;
    await writeJsonAtomic(getPublicationStorePath(projectRoot), store);
    return { bundleId, primary: structuredClone(primary), companion, changed: true };
  });
  if (result.changed) {
    await appendEvent(projectRoot, {
      actor: actorEvent(actor),
      type: "publication.bundle-extended",
      itemId: result.primary.context.itemId,
      data: { bundleId, primaryIntentId: result.primary.id, companionIntentId: result.companion.id, companionTargetPath: result.companion.targetPath },
    });
  }
  return { bundleId, primary: result.primary, companion: result.companion };
}

export async function registerPublication(
  projectRoot: string,
  input: { intentId: string; reservationToken: string; expectedRevision: number },
  actor: ProjectEvent["actor"] = "codex",
  options: PublicationRegistrationOptions = {},
): Promise<PublicationReceipt> {
  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1) throw new Error("发布注册必须携带当前正整数 expectedRevision。 ");
  const snapshot = await withProjectLock(projectRoot, "publications", async (): Promise<RegistrationSnapshot> => {
    const store = await loadStore(projectRoot);
    const intent = store.intents.find((candidate) => candidate.id === input.intentId);
    if (!intent) throw new Error(`找不到发布意图：${input.intentId}`);
    if (intent.reservationToken !== input.reservationToken) throw new Error("发布预留令牌不匹配。 ");
    if (intent.bundleId) throw new Error(`发布意图属于事务 ${intent.bundleId}，必须使用 registerPublicationBundle 原子登记。`);
    const concurrentRegisteredReplay = intent.status === "registered" && intent.revision === input.expectedRevision + 1;
    if (intent.revision !== input.expectedRevision && !concurrentRegisteredReplay) throw new Error(`发布意图已更新（当前修订 ${intent.revision}）。`);
    let receipt: PublicationReceipt | undefined;
    if (intent.status === "registered") {
      receipt = store.receipts.find((candidate) => candidate.id === intent.receiptId);
      if (!receipt) throw new Error("发布意图已注册但回执缺失，已停止以保留现场。 ");
    } else if (intent.status !== "reserved") throw new Error(`发布意图已是 ${intent.status}，不能注册。`);
    const identity = await captureValidationIdentity(intent);
    return { intent: structuredClone(intent), receipt: receipt ? structuredClone(receipt) : undefined, identity };
  });

  const hookSnapshot = { intentId: snapshot.intent.id, revision: snapshot.intent.revision, status: snapshot.intent.status as "reserved" | "registered", targetPath: snapshot.intent.targetPath };
  await options.afterSnapshot?.(hookSnapshot);
  const validation = await validateRegistrationSnapshot(projectRoot, snapshot, options);
  await options.beforeCommit?.(hookSnapshot);

  return withProjectLock(projectRoot, "publications", async () => {
    const store = await loadStore(projectRoot);
    const intent = store.intents.find((candidate) => candidate.id === snapshot.intent.id);
    if (!intent) throw new Error(`发布意图在校验后消失：${snapshot.intent.id}`);
    if (intent.reservationToken !== snapshot.intent.reservationToken || intent.reservationToken !== input.reservationToken) throw new Error("发布预留令牌在校验期间发生变化，CAS 未提交。 ");
    const currentIdentity = await captureValidationIdentity(intent);
    assertStableIdentity(validation.identity, currentIdentity, "最终发布文件或路径在机械校验后发生变化，CAS 未提交；发布意图仍保留原终态。 ");

    if (intent.status === "registered") {
      const receipt = store.receipts.find((candidate) => candidate.id === intent.receiptId);
      if (!receipt) throw new Error("发布意图已注册但回执缺失，已停止以保留现场。 ");
      if (validation.kind === "failure") throw new Error(`已注册文件当前无法通过机械校验：${validation.reason}`);
      if (validation.check.sha256 !== receipt.check.sha256 || validation.check.size !== receipt.check.size) throw new Error("已注册文件内容发生变化，拒绝把幂等重放当作成功。 ");
      return receipt;
    }
    if (intent.status !== "reserved") throw new Error(`发布意图状态已变化为 ${intent.status}，旧校验结果未提交。`);
    if (intent.revision !== snapshot.intent.revision) throw new Error(`发布意图已更新（当前修订 ${intent.revision}），旧校验结果未提交。`);
    if (intent.targetPath !== snapshot.intent.targetPath
      || intent.allowedRoot !== snapshot.intent.allowedRoot
      || intent.kind !== snapshot.intent.kind
      || intent.variant !== snapshot.intent.variant
      || intent.projectId !== snapshot.intent.projectId) {
      throw new Error("发布意图不可变字段在校验期间发生变化，CAS 未提交。 ");
    }

    const now = new Date().toISOString();
    if (validation.kind === "failure") {
      const reason = validation.reason.slice(0, 4_000);
      intent.status = "failed";
      intent.terminal = { reason, at: now };
      intent.revision += 1;
      intent.updatedAt = now;
      store.revision += 1;
      store.updatedAt = now;
      await writeJsonAtomic(getPublicationStorePath(projectRoot), store);
      const result = { intentId: intent.id, status: "failed" as const, revision: intent.revision, reason };
      const message = `发布注册失败：${reason}`;
      try {
        await appendEvent(projectRoot, { actor: actorEvent(actor), type: "publication.failed", itemId: intent.context.itemId, idempotencyKey: intent.idempotencyKey, data: { intentId: intent.id, targetPath: intent.targetPath, reason } });
      } catch (error) {
        const auditFailure = error instanceof Error ? error.message : String(error);
        throw new ConfirmedCommandFailure(`${message}（失败终态已持久化，但审计事件追加失败：${auditFailure}）`, result);
      }
      throw new ConfirmedCommandFailure(message, result);
    }

    const receipt: PublicationReceipt = {
      schemaVersion: 1,
      id: `receipt-${randomUUID()}`,
      intentId: intent.id,
      projectId: intent.projectId,
      targetPath: intent.targetPath,
      kind: intent.kind,
      variant: intent.variant,
      context: intent.context,
      check: validation.check,
      registeredAt: now,
    };
    intent.status = "registered";
    intent.receiptId = receipt.id;
    intent.revision += 1;
    intent.updatedAt = now;
    store.receipts.unshift(receipt);
    store.revision += 1;
    store.updatedAt = now;
    await writeJsonAtomic(getPublicationStorePath(projectRoot), store);
    await appendEvent(projectRoot, { actor: actorEvent(actor), type: "publication.registered", itemId: intent.context.itemId, idempotencyKey: intent.idempotencyKey, data: { intentId: intent.id, receiptId: receipt.id, targetPath: receipt.targetPath, sha256: receipt.check.sha256, size: receipt.check.size } });
    return receipt;
  });
}

export async function registerPublicationBundle(
  projectRoot: string,
  input: PublicationBundleRegistrationInput,
  actor: ProjectEvent["actor"] = "codex",
  options: PublicationBundleRegistrationOptions = {},
): Promise<PublicationBundleRegistrationResult> {
  const bundleId = validateBundleId(input.bundleId);
  const [primaryInput, companionInput] = normalizeBundleMembers(input.members);
  const normalizedInputs = [primaryInput, companionInput];
  if (new Set(normalizedInputs.map((member) => member.intentId)).size !== 2) throw new Error("发布事务不能重复使用同一发布意图。 ");
  for (const member of normalizedInputs) {
    if (!Number.isInteger(member.expectedRevision) || member.expectedRevision < 1) throw new Error("发布事务成员必须携带当前正整数 expectedRevision。 ");
  }

  type BundleSnapshotMember = {
    member: PublicationBundleMember;
    input: PublicationBundleRegistrationInput["members"][number];
    snapshot: RegistrationSnapshot;
  };
  const snapshots = await withProjectLock(projectRoot, "publications", async (): Promise<BundleSnapshotMember[]> => {
    const store = await loadStore(projectRoot);
    const boundIntents = store.intents.filter((intent) => intent.bundleId === bundleId);
    if (boundIntents.length !== 2 || new Set(boundIntents.map((intent) => intent.id)).size !== 2) {
      throw new Error(`发布事务 ${bundleId} 必须在预检或迁移阶段原子绑定恰好两个成员。`);
    }
    const boundIds = new Set(boundIntents.map((intent) => intent.id));
    if (normalizedInputs.some((member) => !boundIds.has(member.intentId))) throw new Error(`发布事务 ${bundleId} 输入成员与已绑定意图不一致。`);
    const members: BundleSnapshotMember[] = [];
    for (const memberInput of normalizedInputs) {
      const intent = store.intents.find((candidate) => candidate.id === memberInput.intentId);
      if (!intent) throw new Error(`找不到发布意图：${memberInput.intentId}`);
      if (intent.reservationToken !== memberInput.reservationToken) throw new Error(`发布事务 ${memberInput.member} 预留令牌不匹配。`);
      const concurrentRegisteredReplay = intent.status === "registered" && intent.revision === memberInput.expectedRevision + 1;
      if (intent.revision !== memberInput.expectedRevision && !concurrentRegisteredReplay) throw new Error(`发布事务 ${memberInput.member} 意图已更新（当前修订 ${intent.revision}）。`);
      if (intent.bundleId !== bundleId || intent.bundleMember !== memberInput.member) throw new Error(`发布事务 ${memberInput.member} 与预绑定身份不一致。`);
      let receipt: PublicationReceipt | undefined;
      if (intent.status === "registered") {
        receipt = store.receipts.find((candidate) => candidate.id === intent.receiptId);
        if (!receipt) throw new Error("发布事务成员已注册但回执缺失，已停止以保留现场。 ");
      } else if (intent.status !== "reserved") {
        throw new Error(`发布事务 ${memberInput.member} 意图已是 ${intent.status}，不能注册。`);
      }
      members.push({
        member: memberInput.member,
        input: memberInput,
        snapshot: {
          intent: structuredClone(intent),
          receipt: receipt ? structuredClone(receipt) : undefined,
          identity: await captureValidationIdentity(intent),
        },
      });
    }
    const statuses = new Set(members.map((member) => member.snapshot.intent.status));
    if (statuses.size !== 1) throw new Error("发布事务出现单边注册状态，拒绝把不完整 pair 当作成功。 ");
    const primary = members.find((member) => member.member === "primary")!.snapshot.intent;
    const companion = members.find((member) => member.member === "companion")!.snapshot.intent;
    if (primary.kind !== "raw-image" || companion.kind !== "labeled-image") throw new Error("raw/labeled 发布事务的 primary 必须是 raw-image，companion 必须是 labeled-image。 ");
    if (primary.projectId !== companion.projectId
      || primary.variant !== companion.variant
      || primary.allowedRoot !== companion.allowedRoot
      || primary.context.purpose !== companion.context.purpose
      || primary.context.itemId !== companion.context.itemId
      || primary.context.taskId !== companion.context.taskId
      || primary.context.jobId !== companion.context.jobId
      || path.resolve(primary.targetPath) === path.resolve(companion.targetPath)) {
      throw new Error("raw/labeled 发布事务成员的项目上下文、变体、允许根或目标路径不合法。 ");
    }
    return members;
  });

  const hookSnapshot = {
    bundleId,
    members: snapshots.map((member) => ({
      member: member.member,
      intentId: member.snapshot.intent.id,
      revision: member.snapshot.intent.revision,
      status: member.snapshot.intent.status as "reserved" | "registered",
      targetPath: member.snapshot.intent.targetPath,
    })),
  };
  await options.afterSnapshot?.(hookSnapshot);
  let validations: Array<{
    member: BundleSnapshotMember;
    validation: PublicationValidationOutcome;
  }>;
  try {
    validations = await Promise.all(snapshots.map(async (member) => ({
      member,
      validation: await validateRegistrationSnapshot(projectRoot, member.snapshot, { hashTimeoutMs: options.hashTimeoutMs }),
    })));
  } catch (error) {
    if (error instanceof PublicationValidationConflict) {
      throw new RejectedCommandFailure(error.message, { schemaVersion: 1, applied: false, reason: "publication_bundle_identity_conflict", bundleId });
    }
    throw error;
  }
  await options.beforeCommit?.(hookSnapshot);

  type BundleCommit =
    | { outcome: "replayed" | "registered"; result: PublicationBundleRegistrationResult }
    | { outcome: "missing"; message: string }
    | { outcome: "failed"; message: string; result: { schemaVersion: 1; applied: true; status: "failed"; bundleId: string; intentIds: string[]; reason: string } };
  let committed: BundleCommit;
  try {
    committed = await withProjectLock(projectRoot, "publications", async (): Promise<BundleCommit> => {
      const store = await loadStore(projectRoot);
      const boundIntents = store.intents.filter((intent) => intent.bundleId === bundleId);
      if (boundIntents.length !== 2) throw new Error(`发布事务 ${bundleId} 在提交前成员数量发生变化。`);
      const currentMembers = validations.map(({ member, validation }) => {
        const intent = store.intents.find((candidate) => candidate.id === member.snapshot.intent.id);
        if (!intent) throw new Error(`发布事务成员在校验后消失：${member.snapshot.intent.id}`);
        if (intent.reservationToken !== member.snapshot.intent.reservationToken || intent.reservationToken !== member.input.reservationToken) {
          throw new Error(`发布事务 ${member.member} 预留令牌在校验期间发生变化，CAS 未提交。`);
        }
        if (intent.bundleId !== bundleId || intent.bundleMember !== member.member) throw new Error(`发布事务 ${member.member} 绑定在校验期间发生变化。`);
        return { member, validation, intent };
      });
      for (const current of currentMembers) {
        const observedIdentity = await captureValidationIdentity(current.intent);
        assertStableIdentity(current.validation.identity, observedIdentity, `发布事务 ${current.member.member} 文件或路径在机械校验后发生变化，CAS 未提交。`);
      }
      const statuses = new Set(currentMembers.map((current) => current.intent.status));
      if (statuses.size !== 1) throw new Error("发布事务在提交前出现单边终态，旧校验结果未提交。 ");

      if (currentMembers.every((current) => current.intent.status === "registered")) {
        const receipts = currentMembers.map((current) => {
          const receipt = store.receipts.find((candidate) => candidate.id === current.intent.receiptId);
          if (!receipt) throw new Error("发布事务成员已注册但回执缺失，已停止以保留现场。 ");
          if (current.validation.kind === "failure") throw new Error(`已注册的 ${current.member.member} 当前无法通过机械校验：${current.validation.reason}`);
          if (receipt.bundleId !== bundleId || receipt.bundleMember !== current.member.member) throw new Error("已注册回执缺少精确 bundle 成员身份。 ");
          if (receipt.check.sha256 !== current.validation.check.sha256 || receipt.check.size !== current.validation.check.size) {
            throw new Error(`已注册的 ${current.member.member} 内容发生变化，拒绝把幂等重放当作成功。`);
          }
          return receipt;
        });
        const [primaryReceipt, companionReceipt] = normalizeBundleMembers(receipts.map((receipt) => ({ member: receipt.bundleMember!, receipt })));
        if (primaryReceipt.receipt.check.width !== companionReceipt.receipt.check.width || primaryReceipt.receipt.check.height !== companionReceipt.receipt.check.height) {
          throw new Error("已注册 raw/labeled 图片尺寸已经漂移。 ");
        }
        return {
          outcome: "replayed",
          result: { bundleId, receipts: [primaryReceipt.receipt, companionReceipt.receipt], registeredAt: primaryReceipt.receipt.registeredAt },
        };
      }

      for (const current of currentMembers) {
        const snapshotIntent = current.member.snapshot.intent;
        if (current.intent.status !== "reserved") throw new Error(`发布事务 ${current.member.member} 状态已变化为 ${current.intent.status}，旧校验结果未提交。`);
        if (current.intent.revision !== snapshotIntent.revision) throw new Error(`发布事务 ${current.member.member} 已更新（当前修订 ${current.intent.revision}），旧校验结果未提交。`);
        if (current.intent.targetPath !== snapshotIntent.targetPath
          || current.intent.allowedRoot !== snapshotIntent.allowedRoot
          || current.intent.kind !== snapshotIntent.kind
          || current.intent.variant !== snapshotIntent.variant
          || current.intent.projectId !== snapshotIntent.projectId) {
          throw new Error(`发布事务 ${current.member.member} 不可变字段在校验期间发生变化，CAS 未提交。`);
        }
      }
      const missing = currentMembers.find((current) => current.validation.kind === "failure" && current.validation.identity.file.state === "missing");
      if (missing?.validation.kind === "failure") {
        return { outcome: "missing", message: `发布事务 ${missing.member.member} 文件尚未落盘；两个意图保持 reserved：${missing.validation.reason}` };
      }
      const invalid = currentMembers.find((current) => current.validation.kind === "failure");
      const successful = currentMembers.filter((current): current is typeof current & { validation: Extract<PublicationValidationOutcome, { kind: "success" }> } => current.validation.kind === "success");
      const dimensionsMismatch = successful.length === 2
        && (successful[0]!.validation.check.width !== successful[1]!.validation.check.width
          || successful[0]!.validation.check.height !== successful[1]!.validation.check.height);
      if (invalid || dimensionsMismatch) {
        const reason = (invalid?.validation.kind === "failure"
          ? `发布事务 ${invalid.member.member} 机械校验失败：${invalid.validation.reason}`
          : "raw/labeled 图片宽高不一致。").slice(0, 4_000);
        const now = new Date().toISOString();
        for (const current of currentMembers) {
          current.intent.status = "failed";
          current.intent.terminal = { reason, at: now };
          current.intent.revision += 1;
          current.intent.updatedAt = now;
        }
        store.revision += 1;
        store.updatedAt = now;
        await writeJsonAtomic(getPublicationStorePath(projectRoot), store);
        return { outcome: "failed", message: `发布事务注册失败：${reason}`, result: { schemaVersion: 1, applied: true, status: "failed", bundleId, intentIds: currentMembers.map((current) => current.intent.id), reason } };
      }

      const now = new Date().toISOString();
      const receipts = currentMembers.map((current): PublicationReceipt => {
        if (current.validation.kind !== "success") throw new Error("发布事务机械校验结果不完整。 ");
        return {
          schemaVersion: 1,
          id: `receipt-${randomUUID()}`,
          intentId: current.intent.id,
          projectId: current.intent.projectId,
          targetPath: current.intent.targetPath,
          kind: current.intent.kind,
          variant: current.intent.variant,
          context: current.intent.context,
          bundleId,
          bundleMember: current.member.member,
          check: current.validation.check,
          registeredAt: now,
        };
      });
      const [primaryReceipt, companionReceipt] = normalizeBundleMembers(receipts.map((receipt) => ({ member: receipt.bundleMember!, receipt })));
      for (const [index, current] of currentMembers.entries()) {
        const receipt = receipts[index]!;
        current.intent.status = "registered";
        current.intent.receiptId = receipt.id;
        current.intent.revision += 1;
        current.intent.updatedAt = now;
      }
      store.receipts.unshift(primaryReceipt.receipt, companionReceipt.receipt);
      store.revision += 1;
      store.updatedAt = now;
      await writeJsonAtomic(getPublicationStorePath(projectRoot), store);
      return { outcome: "registered", result: { bundleId, receipts: [primaryReceipt.receipt, companionReceipt.receipt], registeredAt: now } };
    });
  } catch (error) {
    if (error instanceof PublicationValidationConflict) {
      throw new RejectedCommandFailure(error.message, { schemaVersion: 1, applied: false, reason: "publication_bundle_identity_conflict", bundleId });
    }
    throw error;
  }

  if (committed.outcome === "missing") {
    throw new RejectedCommandFailure(committed.message, { schemaVersion: 1, applied: false, reason: "publication_bundle_member_missing", bundleId });
  }
  if (committed.outcome === "failed") {
    try {
      await appendEvent(projectRoot, {
        actor: actorEvent(actor),
        type: "publication.bundle-failed",
        itemId: snapshots.find((member) => member.member === "primary")?.snapshot.intent.context.itemId,
        data: { bundleId, reason: committed.result.reason, intentIds: committed.result.intentIds },
      });
    } catch (error) {
      const auditFailure = error instanceof Error ? error.message : String(error);
      throw new ConfirmedCommandFailure(`${committed.message}（失败终态已持久化，但审计事件追加失败：${auditFailure}）`, committed.result);
    }
    throw new ConfirmedCommandFailure(committed.message, committed.result);
  }
  if (committed.outcome === "registered") {
    try {
    await appendEvent(projectRoot, {
      actor: actorEvent(actor),
      type: "publication.bundle-registered",
      itemId: snapshots.find((member) => member.member === "primary")?.snapshot.intent.context.itemId,
      data: {
        bundleId,
          members: committed.result.receipts.map((receipt) => ({
          member: receipt.bundleMember,
          intentId: receipt.intentId,
          receiptId: receipt.id,
          targetPath: receipt.targetPath,
          sha256: receipt.check.sha256,
          size: receipt.check.size,
        })),
      },
    });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ConfirmedCommandFailure(`发布事务已原子注册，但审计事件追加失败：${message}`, committed.result);
    }
  }
  return committed.result;
}

function validatedGenerationTerminalProvenance(
  intent: PublicationIntent,
  status: "cancelled" | "failed",
  provenance: GenerationPublicationTerminalProvenance | undefined,
): GenerationPublicationTerminalProvenance | undefined {
  if (!provenance) return undefined;
  const parsed = generationPublicationTerminalProvenanceSchema.parse(provenance) as GenerationPublicationTerminalProvenance;
  if (intent.context.purpose !== "generation-output" || intent.context.jobId !== parsed.generationJobId) throw new Error("生成 Publication 终态来源与发布上下文不匹配。 ");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,199}$/.test(parsed.generationJobId) || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,199}$/.test(parsed.clientJobId)) throw new Error("生成 Publication 终态来源包含非法任务标识。 ");
  if (parsed.externalTaskId && !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/.test(parsed.externalTaskId)) throw new Error("生成 Publication 终态来源包含非法远端任务标识。 ");
  const failedCauses = new Set<GenerationPublicationTerminalCause>(["http_submission_not_found", "browser_submission_not_found", "remote_confirmed_failed", "local_pre_submit_failure", "local_execution_failed", "visual_rejected"]);
  if ((status === "failed") !== failedCauses.has(parsed.cause)) throw new Error(`生成 Publication ${status} 与结构化来源 ${parsed.cause} 不匹配。`);
  const reconciliationCause = parsed.cause === "http_submission_not_found" || parsed.cause === "browser_submission_not_found";
  if (reconciliationCause) {
    const reconciliation = parsed.reconciliation;
    if (!reconciliation || reconciliation.result !== "not_found" || reconciliation.confirmNoRemoteResult !== true || reconciliation.externalTaskId || !parsed.checkpointRevision) throw new Error("提交未找到终态必须携带匹配修订的结构化 not_found 证据。 ");
    if (reconciliation.clientJobId !== parsed.clientJobId || reconciliation.attempt !== parsed.attempt) throw new Error("提交未找到证据与提交意图不匹配。 ");
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,199}$/.test(reconciliation.evidenceReference)) throw new Error("提交对账 evidenceReference 必须是稳定、无 URL 的引用标识。 ");
    if (/https?:\/\/|\bBearer\b|(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|password|secret|signature|sig)\s*[:=]/i.test(reconciliation.note)) throw new Error("提交对账说明不能包含 URL 或凭据。 ");
    if (parsed.cause === "http_submission_not_found" && reconciliation.method === "browser_history") throw new Error("HTTP 提交对账不能使用 browser_history 作为证据方法。 ");
  } else if (parsed.reconciliation) throw new Error(`结构化来源 ${parsed.cause} 不应携带提交未找到证据。`);
  if (parsed.comfyUi) {
    if (!(parsed.cause === "remote_confirmed_failed" || parsed.cause === "remote_cancel_confirmed") || !parsed.checkpointRevision || parsed.externalTaskId !== parsed.comfyUi.promptId) throw new Error("ComfyUI 终态证据只能绑定带 promptId 与检查点修订的远端失败/取消。 ");
    if (parsed.cause === "remote_confirmed_failed" && (!parsed.comfyUi.historySha256 || parsed.comfyUi.eventName !== "execution_error" || parsed.comfyUi.confirmationKind)) throw new Error("ComfyUI 失败终态必须携带 exact execution_error history 哈希。 ");
    if (parsed.cause === "remote_cancel_confirmed" && !parsed.comfyUi.confirmationKind) throw new Error("ComfyUI 取消终态必须携带确认类型。 ");
    if (parsed.comfyUi.confirmationKind === "history_interrupted" && (!parsed.comfyUi.historySha256 || parsed.comfyUi.eventName !== "execution_interrupted")) throw new Error("ComfyUI history 中断确认必须携带 exact execution_interrupted 哈希。 ");
    if (parsed.comfyUi.confirmationKind === "pending_deleted" && (!parsed.comfyUi.cancellationResponseSha256 || parsed.comfyUi.historySha256 || parsed.comfyUi.eventName)) throw new Error("ComfyUI pending 删除确认必须携带原子取消响应哈希且不能伪造 history 事件。 ");
  }
  return structuredClone(parsed);
}

async function finishIntent(
  projectRoot: string,
  input: FinishPublicationInput,
  status: "cancelled" | "failed",
  actor: ProjectEvent["actor"],
): Promise<PublicationIntent> {
  return withProjectLock(projectRoot, "publications", async () => {
    const store = await loadStore(projectRoot);
    const intent = store.intents.find((candidate) => candidate.id === input.intentId);
    if (!intent) throw new Error(`找不到发布意图：${input.intentId}`);
    if (intent.reservationToken !== input.reservationToken) throw new Error("发布预留令牌不匹配。 ");
    if (intent.bundleId) throw new Error(`发布意图属于事务 ${intent.bundleId}，不能单边取消或失败。`);
    if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1) throw new Error("发布终止必须携带当前正整数 expectedRevision。 ");
    if (intent.revision !== input.expectedRevision) throw new Error(`发布意图已更新（当前修订 ${intent.revision}）。`);
    if (intent.status !== "reserved") throw new Error(`发布意图已是 ${intent.status}，不能改为 ${status}。`);
    const reason = input.reason.trim();
    if (reason.length < 3) throw new Error("取消或失败必须记录真实原因。 ");
    const provenance = validatedGenerationTerminalProvenance(intent, status, input.provenance);
    const now = new Date().toISOString();
    intent.status = status;
    intent.terminal = { reason: reason.slice(0, 4_000), at: now, provenance };
    intent.revision += 1;
    intent.updatedAt = now;
    store.revision += 1;
    store.updatedAt = now;
    await writeJsonAtomic(getPublicationStorePath(projectRoot), store);
    await appendEvent(projectRoot, { actor: actorEvent(actor), type: `publication.${status}`, itemId: intent.context.itemId, idempotencyKey: intent.idempotencyKey, data: { intentId: intent.id, targetPath: intent.targetPath, reason: intent.terminal.reason, generationTerminal: provenance ? { generationJobId: provenance.generationJobId, cause: provenance.cause, clientJobId: provenance.clientJobId, attempt: provenance.attempt, externalTaskId: provenance.externalTaskId, checkpointRevision: provenance.checkpointRevision, reconciliationResult: provenance.reconciliation?.result, evidenceReference: provenance.reconciliation?.evidenceReference, comfyUiEvent: provenance.comfyUi?.eventName, comfyUiHistorySha256: provenance.comfyUi?.historySha256, comfyUiConfirmationKind: provenance.comfyUi?.confirmationKind } : undefined } });
    return intent;
  });
}

async function finishPublicationBundle(
  projectRoot: string,
  input: FinishPublicationBundleInput,
  status: "cancelled" | "failed",
  actor: ProjectEvent["actor"],
): Promise<PublicationIntent[]> {
  const bundleId = validateBundleId(input.bundleId);
  const [primaryInput, companionInput] = normalizeBundleMembers(input.members);
  const reason = input.reason.trim().slice(0, 4_000);
  if (reason.length < 3) throw new Error("取消或失败发布事务必须记录真实原因。 ");
  const result = await withProjectLock(projectRoot, "publications", async (): Promise<{ intents: PublicationIntent[]; changed: boolean }> => {
    const store = await loadStore(projectRoot);
    const bound = store.intents.filter((intent) => intent.bundleId === bundleId);
    if (bound.length !== 2) throw new Error(`发布事务 ${bundleId} 必须恰好包含两个预绑定成员。`);
    const resolved = [primaryInput, companionInput].map((member) => {
      if (!Number.isInteger(member.expectedRevision) || member.expectedRevision < 1) throw new Error("发布事务终态必须携带当前正整数 expectedRevision。 ");
      const intent = store.intents.find((candidate) => candidate.id === member.intentId);
      if (!intent) throw new Error(`找不到发布意图：${member.intentId}`);
      if (intent.bundleId !== bundleId || intent.bundleMember !== member.member) throw new Error(`发布事务 ${member.member} 绑定不一致。`);
      if (intent.reservationToken !== member.reservationToken) throw new Error(`发布事务 ${member.member} 预留令牌不匹配。`);
      const terminalReplay = intent.status === status && intent.revision === member.expectedRevision + 1;
      if (intent.revision !== member.expectedRevision && !terminalReplay) throw new Error(`发布事务 ${member.member} 意图已更新（当前修订 ${intent.revision}）。`);
      return { member, intent, terminalReplay };
    });
    if (resolved.every((member) => member.terminalReplay)) {
      return { intents: resolved.map((member) => structuredClone(member.intent)), changed: false };
    }
    if (resolved.some((member) => member.terminalReplay) || resolved.some((member) => member.intent.status !== "reserved")) {
      throw new Error("发布事务出现单边终态或已离开 reserved，拒绝继续。 ");
    }
    const now = new Date().toISOString();
    for (const member of resolved) {
      const provenance = validatedGenerationTerminalProvenance(member.intent, status, input.provenance);
      member.intent.status = status;
      member.intent.terminal = { reason, at: now, provenance };
      member.intent.revision += 1;
      member.intent.updatedAt = now;
    }
    store.revision += 1;
    store.updatedAt = now;
    await writeJsonAtomic(getPublicationStorePath(projectRoot), store);
    return { intents: resolved.map((member) => structuredClone(member.intent)), changed: true };
  });
  if (result.changed) {
    await appendEvent(projectRoot, {
      actor: actorEvent(actor),
      type: `publication.bundle-${status}`,
      itemId: result.intents.find((intent) => intent.bundleMember === "primary")?.context.itemId,
      data: {
        bundleId,
        reason,
        intentIds: result.intents.map((intent) => intent.id),
        generationTerminal: input.provenance ? {
          generationJobId: input.provenance.generationJobId,
          cause: input.provenance.cause,
          clientJobId: input.provenance.clientJobId,
          attempt: input.provenance.attempt,
          checkpointRevision: input.provenance.checkpointRevision,
        } : undefined,
      },
    });
  }
  const [primary, companion] = normalizeBundleMembers(result.intents.map((intent) => ({ member: intent.bundleMember!, intent })));
  return [primary.intent, companion.intent];
}

export async function cancelPublication(
  projectRoot: string,
  input: FinishPublicationInput,
  actor: ProjectEvent["actor"] = "codex",
): Promise<PublicationIntent> {
  return finishIntent(projectRoot, input, "cancelled", actor);
}

export async function failPublication(
  projectRoot: string,
  input: FinishPublicationInput,
  actor: ProjectEvent["actor"] = "codex",
): Promise<PublicationIntent> {
  return finishIntent(projectRoot, input, "failed", actor);
}

export async function cancelPublicationBundle(
  projectRoot: string,
  input: FinishPublicationBundleInput,
  actor: ProjectEvent["actor"] = "codex",
): Promise<PublicationIntent[]> {
  return finishPublicationBundle(projectRoot, input, "cancelled", actor);
}

export async function failPublicationBundle(
  projectRoot: string,
  input: FinishPublicationBundleInput,
  actor: ProjectEvent["actor"] = "codex",
): Promise<PublicationIntent[]> {
  return finishPublicationBundle(projectRoot, input, "failed", actor);
}

export async function listPublicationIntents(projectRoot: string, status?: PublicationStatus): Promise<PublicationIntent[]> {
  const intents = (await loadStore(projectRoot)).intents;
  return intents.filter((intent) => !status || intent.status === status).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function listPublicationReceipts(projectRoot: string): Promise<PublicationReceipt[]> {
  return (await loadStore(projectRoot)).receipts.sort((a, b) => b.registeredAt.localeCompare(a.registeredAt));
}

export async function getPublicationIntent(projectRoot: string, intentId: string): Promise<PublicationIntent | undefined> {
  return (await loadStore(projectRoot)).intents.find((intent) => intent.id === intentId);
}

export async function getPublicationReceipt(projectRoot: string, receiptId: string): Promise<PublicationReceipt | undefined> {
  return (await loadStore(projectRoot)).receipts.find((receipt) => receipt.id === receiptId);
}

export async function publicationTargetExists(intent: PublicationIntent): Promise<boolean> {
  return lstat(intent.targetPath).then((metadata) => metadata.isFile() && !metadata.isSymbolicLink()).catch(() => false);
}
