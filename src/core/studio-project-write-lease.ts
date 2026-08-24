/**
 * 项目级写租约（跨代理所有权）。
 *
 * 定位：把无限画布 MCP 收成「项目生产 OS + 唯一写入口」时的所有权层。
 * - 模式 require（生产默认，MCP/桌面启动时设定）：生图相关写 **无租约不准写**
 * - 模式 compat（测试默认）：无租约放行；有租约时仅 holder+token 可写
 * - 只读查询永不要求租约
 * - AI_CANVAS_DISABLE_WRITE_LEASE=1 关闭闸门（仅测试/急救）
 *
 * 不取代 studio-mutation 文件锁；租约解决「谁有权写」，文件锁解决「同时写」。
 */
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { SIDECAR_DIR } from "./constants.js";
import { withProjectLock } from "./locks.js";
import { inspectManagedProject, inspectManagedProjectReadOnly } from "./managed-project.js";

export const STUDIO_PROJECT_WRITE_LEASE_SCHEMA_VERSION = 1 as const;

export type StudioProjectWriteLeaseErrorCode =
  | "invalid-input"
  | "lease-held"
  | "lease-required"
  | "lease-token-mismatch"
  | "lease-not-found"
  | "lease-expired"
  | "unmanaged-project"
  | "storage-invalid";

/** require = 无租约不准写；compat = 仅有租约时挡异主 */
export type StudioWriteLeaseMode = "require" | "compat";

export function getStudioWriteLeaseMode(): StudioWriteLeaseMode {
  if (process.env.AI_CANVAS_DISABLE_WRITE_LEASE === "1") return "compat";
  const raw = (process.env.AI_CANVAS_WRITE_LEASE_MODE ?? "require").trim().toLowerCase();
  return raw === "compat" ? "compat" : "require";
}

export class StudioProjectWriteLeaseError extends Error {
  readonly code: StudioProjectWriteLeaseErrorCode;
  readonly details: string[];

  constructor(code: StudioProjectWriteLeaseErrorCode, message: string, details: string[] = []) {
    super(message);
    this.name = "StudioProjectWriteLeaseError";
    this.code = code;
    this.details = details;
  }
}

export type StudioWriteLeaseHolderKind = "grok" | "codex" | "agent" | "desktop-ui" | "script";

export interface StudioProjectWriteLease {
  schemaVersion: typeof STUDIO_PROJECT_WRITE_LEASE_SCHEMA_VERSION;
  kind: "studio-project-write-lease";
  projectId: string;
  projectRoot: string;
  holderId: string;
  holderKind: StudioWriteLeaseHolderKind;
  sessionId: string;
  leaseToken: string;
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
  note?: string;
  fingerprint: string;
}

export interface StudioProjectWriteLeaseProjection {
  schemaVersion: typeof STUDIO_PROJECT_WRITE_LEASE_SCHEMA_VERSION;
  kind: "studio-project-write-lease-projection";
  held: boolean;
  expired: boolean;
  lease: StudioProjectWriteLease | null;
  /** 给其他代理的中文说明（held 时有） */
  denialHint: string | null;
}

const DEFAULT_TTL_SECONDS = 15 * 60;
const MIN_TTL_SECONDS = 30;
const MAX_TTL_SECONDS = 60 * 60;
const HOLDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const LEASE_TOKEN_PATTERN = /^lease-[a-f0-9]{32}$/u;

/** 有租约时必须校验的写命令（生图主线 + 闸门）。其余写命令仍只受 CAS/studio-mutation 保护。 */
export const STUDIO_WRITE_LEASE_ENFORCED_COMMANDS = new Set<string>([
  "freeze_studio_generation_pack",
  "dispatch_studio_generation_pack",
  "prepare_studio_imagegen_call",
  "attest_studio_higgsfield_connector_capability",
  "claim_studio_higgsfield_connector_request",
  "preflight_studio_higgsfield_connector_request",
  "authorize_studio_higgsfield_connector_request",
  "record_studio_higgsfield_connector_submission",
  "reconcile_studio_higgsfield_connector_request",
  "prepare_studio_higgsfield_video_generation",
  "record_studio_higgsfield_video_submission",
  "register_studio_generation_result",
  "commit_agent_imagegen_result_bundle",
  "rebind_studio_imagegen_call_context",
  "fail_studio_generation_run",
  "cancel_studio_generation_run",
  "retry_studio_generation_plan_nodes",
  "create_studio_generation_plan",
  "submit_studio_generation_review",
  "submit_studio_post_result_observation",
  "refresh_studio_generation_checkpoint",
  "attest_studio_generation_checkpoint",
  "abandon_studio_generation_unknown",
  "abandon_studio_detached_generation_unknown",
]);

function leasePath(projectRoot: string): string {
  return path.join(path.resolve(projectRoot), SIDECAR_DIR, "write-lease.json");
}

function nowIso(): string {
  return new Date().toISOString();
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function fail(code: StudioProjectWriteLeaseErrorCode, message: string, details: string[] = []): never {
  throw new StudioProjectWriteLeaseError(code, message, details);
}

function normalizeHolderId(value: string): string {
  const holderId = value.trim();
  if (!HOLDER_ID_PATTERN.test(holderId)) fail("invalid-input", "holderId 必须是 1–128 位稳定标识。");
  return holderId;
}

function normalizeHolderKind(value: string | undefined): StudioWriteLeaseHolderKind {
  const kind = (value ?? "agent").trim();
  if (kind === "grok" || kind === "codex" || kind === "agent" || kind === "desktop-ui" || kind === "script") {
    return kind;
  }
  fail("invalid-input", "holderKind 必须是 grok|codex|agent|desktop-ui|script。");
}

function normalizeTtlSeconds(value: number | undefined): number {
  const ttl = value === undefined ? DEFAULT_TTL_SECONDS : value;
  if (!Number.isSafeInteger(ttl) || ttl < MIN_TTL_SECONDS || ttl > MAX_TTL_SECONDS) {
    fail("invalid-input", `ttlSeconds 必须在 ${MIN_TTL_SECONDS}–${MAX_TTL_SECONDS} 之间。`);
  }
  return ttl;
}

function isExpired(lease: StudioProjectWriteLease, nowMs = Date.now()): boolean {
  return nowMs >= new Date(lease.expiresAt).getTime();
}

function fingerprintOf(lease: Omit<StudioProjectWriteLease, "fingerprint">): string {
  return digest({
    schemaVersion: lease.schemaVersion,
    kind: lease.kind,
    projectId: lease.projectId,
    projectRoot: lease.projectRoot,
    holderId: lease.holderId,
    holderKind: lease.holderKind,
    sessionId: lease.sessionId,
    leaseToken: lease.leaseToken,
    acquiredAt: lease.acquiredAt,
    heartbeatAt: lease.heartbeatAt,
    expiresAt: lease.expiresAt,
    note: lease.note ?? null,
  });
}

function parseLease(raw: unknown, projectRoot: string): StudioProjectWriteLease | null {
  if (raw == null) return null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    fail("storage-invalid", "write-lease.json 载荷损坏。");
  }
  const value = raw as Partial<StudioProjectWriteLease>;
  if (value.schemaVersion !== 1
    || value.kind !== "studio-project-write-lease"
    || typeof value.projectId !== "string"
    || typeof value.projectRoot !== "string"
    || typeof value.holderId !== "string"
    || typeof value.holderKind !== "string"
    || typeof value.sessionId !== "string"
    || typeof value.leaseToken !== "string"
    || typeof value.acquiredAt !== "string"
    || typeof value.heartbeatAt !== "string"
    || typeof value.expiresAt !== "string"
    || typeof value.fingerprint !== "string"
    || !LEASE_TOKEN_PATTERN.test(value.leaseToken)) {
    fail("storage-invalid", "write-lease.json 字段不完整或非法。");
  }
  if (path.resolve(value.projectRoot) !== path.resolve(projectRoot)) {
    fail("storage-invalid", "write-lease.json projectRoot 与当前工程不一致。");
  }
  const lease: StudioProjectWriteLease = {
    schemaVersion: 1,
    kind: "studio-project-write-lease",
    projectId: value.projectId,
    projectRoot: path.resolve(value.projectRoot),
    holderId: value.holderId,
    holderKind: value.holderKind as StudioWriteLeaseHolderKind,
    sessionId: value.sessionId,
    leaseToken: value.leaseToken,
    acquiredAt: value.acquiredAt,
    heartbeatAt: value.heartbeatAt,
    expiresAt: value.expiresAt,
    ...(typeof value.note === "string" && value.note.trim() ? { note: value.note.trim().slice(0, 500) } : {}),
    fingerprint: value.fingerprint,
  };
  const expected = fingerprintOf(lease);
  if (expected !== lease.fingerprint) fail("storage-invalid", "write-lease.json 指纹漂移。");
  return lease;
}

async function readLeaseUnlocked(projectRoot: string): Promise<StudioProjectWriteLease | null> {
  const file = leasePath(projectRoot);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (error instanceof Error
      && "code" in error
      && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > 64n * 1024n) {
      fail("storage-invalid", "write-lease.json 必须是有界、单链接的普通文件。");
    }
    const text = await handle.readFile("utf8");
    const after = await handle.stat({ bigint: true });
    if (before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs
      || before.ctimeNs !== after.ctimeNs) {
      fail("storage-invalid", "write-lease.json changed while reading");
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (error) {
      fail("storage-invalid", "write-lease.json 无法解析 JSON。", [
        error instanceof Error ? error.message : String(error),
      ]);
    }
    return parseLease(raw, projectRoot);
  } finally {
    await handle.close();
  }
}

async function writeLeaseUnlocked(projectRoot: string, lease: StudioProjectWriteLease): Promise<void> {
  const file = leasePath(projectRoot);
  const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  const body = `${JSON.stringify(lease, null, 2)}\n`;
  await writeFile(tmp, body, { encoding: "utf8", mode: 0o600 });
  await rename(tmp, file);
}

async function clearLeaseUnlocked(projectRoot: string): Promise<void> {
  await rm(leasePath(projectRoot), { force: true });
}

function denialHint(lease: StudioProjectWriteLease): string {
  return `当前项目由 ${lease.holderId}（${lease.holderKind}）持有写租约至 ${lease.expiresAt}；其他代理只能审片/只读或等待，不得提交、重试或终止对方生图任务。请调用 get_studio_project_write_lease / heartbeat_studio_project_write_lease；仅持有者可 release。`;
}

function projectLeaseProjection(lease: StudioProjectWriteLease | null): StudioProjectWriteLeaseProjection {
  if (!lease) {
    return {
      schemaVersion: 1,
      kind: "studio-project-write-lease-projection",
      held: false,
      expired: false,
      lease: null,
      denialHint: null,
    };
  }
  const expired = isExpired(lease);
  if (expired) {
    return {
      schemaVersion: 1,
      kind: "studio-project-write-lease-projection",
      held: false,
      expired: true,
      lease: null,
      denialHint: null,
    };
  }
  return {
    schemaVersion: 1,
    kind: "studio-project-write-lease-projection",
    held: true,
    expired: false,
    lease,
    denialHint: denialHint(lease),
  };
}

/**
 * 展示层物理零写租约投影：不取得 write-lease/project 锁，不创建 locks 目录。
 * write-lease.json 由写路径原子 rename，因此单次完整文件读取足以用于非授权显示；
 * 所有真正写命令仍必须在各自强一致 fence 内复核。
 */
export async function getStudioProjectWriteLeaseReadOnly(
  projectRoot: string,
): Promise<StudioProjectWriteLeaseProjection> {
  const root = path.resolve(projectRoot);
  await inspectManagedProjectReadOnly(root);
  return projectLeaseProjection(await readLeaseUnlocked(root));
}

export async function getStudioProjectWriteLease(projectRoot: string): Promise<StudioProjectWriteLeaseProjection> {
  const root = path.resolve(projectRoot);
  await inspectManagedProject(root);
  return withProjectLock(root, "write-lease", async () => {
    // 只读投影不得在另一个 Studio 写事务执行期间清除所有权文件。过期租约由
    // 下一次受 studio-mutation 串行化的 acquire/release 接管或清理。
    return projectLeaseProjection(await readLeaseUnlocked(root));
  });
}

/**
 * T15 公开投影：普通读只返回 leaseToken 指纹末段，不暴露完整 token。
 * holder 恢复用绑定 sessionId 的 resume_lease 或短期 capability。
 */
export function maskLeaseTokenForPublic(lease: StudioProjectWriteLease): StudioProjectWriteLease {
  return {
    ...lease,
    leaseToken: `lease-…${lease.leaseToken.slice(-8)}`,
  };
}

/** T15 公开投影（掩码版）：用于 MCP/前端显示，不暴露完整 leaseToken。 */
export async function getStudioProjectWriteLeasePublic(projectRoot: string): Promise<StudioProjectWriteLeaseProjection> {
  const projection = await getStudioProjectWriteLease(projectRoot);
  if (!projection.lease) return projection;
  return { ...projection, lease: maskLeaseTokenForPublic(projection.lease) };
}

export async function acquireStudioProjectWriteLease(
  projectRoot: string,
  input: {
    holderId: string;
    holderKind?: StudioWriteLeaseHolderKind | string;
    sessionId?: string;
    ttlSeconds?: number;
    note?: string;
    /** 若持有未过期租约且 token 匹配，则续租（幂等） */
    leaseToken?: string;
    forceTakeover?: boolean;
    takeoverReason?: string;
  },
): Promise<StudioProjectWriteLease> {
  const root = path.resolve(projectRoot);
  const shell = await inspectManagedProject(root);
  const holderId = normalizeHolderId(input.holderId);
  const holderKind = normalizeHolderKind(input.holderKind);
  const ttlSeconds = normalizeTtlSeconds(input.ttlSeconds);
  const sessionId = (input.sessionId?.trim() || `session-${randomUUID().replace(/-/g, "").slice(0, 16)}`);
  if (!HOLDER_ID_PATTERN.test(sessionId) && !/^session-[a-f0-9]{8,32}$/u.test(sessionId)) {
    fail("invalid-input", "sessionId 非法。");
  }
  const note = input.note?.trim().slice(0, 500);

  // 所有会改变 leaseToken 代次的 acquire/takeover 与 Studio 写事务共用同一 fence。
  // 命令在此锁内完成最终复验后，任何新 holder 都只能等待该事务结束。
  return withProjectLock(root, "studio-mutation", () =>
    withProjectLock(root, "write-lease", async () => {
      const existing = await readLeaseUnlocked(root);
      const now = Date.now();
      if (existing && !isExpired(existing, now)) {
        // 同 holder + token → 心跳续租
        if (input.leaseToken && input.leaseToken === existing.leaseToken && existing.holderId === holderId) {
          const nextBase: Omit<StudioProjectWriteLease, "fingerprint"> = {
            ...existing,
            heartbeatAt: new Date(now).toISOString(),
            expiresAt: new Date(now + ttlSeconds * 1000).toISOString(),
            ...(note ? { note } : {}),
          };
          const next: StudioProjectWriteLease = { ...nextBase, fingerprint: fingerprintOf(nextBase) };
          await writeLeaseUnlocked(root, next);
          return next;
        }
        // 同 holder 无 token：拒绝静默抢（防双会话同名）
        if (existing.holderId === holderId && !input.forceTakeover) {
          fail("lease-held", `holderId=${holderId} 已持有写租约；请传入 leaseToken 续租，或 release 后重获。`, [
            denialHint(existing),
          ]);
        }
        if (!input.forceTakeover) {
          fail("lease-held", denialHint(existing), [
            `holderId=${existing.holderId}`,
            `holderKind=${existing.holderKind}`,
            `expiresAt=${existing.expiresAt}`,
          ]);
        }
        if (!input.takeoverReason || input.takeoverReason.trim().length < 8) {
          fail("invalid-input", "forceTakeover 必须提供 ≥8 字 takeoverReason。");
        }
      }

      const acquiredAt = new Date(now).toISOString();
      const base: Omit<StudioProjectWriteLease, "fingerprint"> = {
        schemaVersion: 1,
        kind: "studio-project-write-lease",
        projectId: shell.project.id,
        projectRoot: root,
        holderId,
        holderKind,
        sessionId,
        leaseToken: `lease-${randomUUID().replace(/-/g, "")}`,
        acquiredAt,
        heartbeatAt: acquiredAt,
        expiresAt: new Date(now + ttlSeconds * 1000).toISOString(),
        ...(note ? { note } : {}),
        ...(input.forceTakeover && input.takeoverReason
          ? { note: `takeover: ${input.takeoverReason.trim().slice(0, 400)}` }
          : note
            ? { note }
            : {}),
      };
      const lease: StudioProjectWriteLease = { ...base, fingerprint: fingerprintOf(base) };
      await writeLeaseUnlocked(root, lease);
      return lease;
    }));
}

export async function heartbeatStudioProjectWriteLease(
  projectRoot: string,
  input: { holderId: string; leaseToken: string; ttlSeconds?: number },
): Promise<StudioProjectWriteLease> {
  return acquireStudioProjectWriteLease(projectRoot, {
    holderId: input.holderId,
    leaseToken: input.leaseToken,
    ttlSeconds: input.ttlSeconds,
  });
}

export async function releaseStudioProjectWriteLease(
  projectRoot: string,
  input: { holderId: string; leaseToken: string },
): Promise<{ released: true; projectRoot: string }> {
  const root = path.resolve(projectRoot);
  await inspectManagedProject(root);
  const holderId = normalizeHolderId(input.holderId);
  const leaseToken = input.leaseToken.trim();
  if (!LEASE_TOKEN_PATTERN.test(leaseToken)) fail("invalid-input", "leaseToken 非法。");

  return withProjectLock(root, "studio-mutation", () =>
    withProjectLock(root, "write-lease", async () => {
      const existing = await readLeaseUnlocked(root);
      if (!existing || isExpired(existing)) {
        await clearLeaseUnlocked(root);
        return { released: true as const, projectRoot: root };
      }
      if (existing.holderId !== holderId || existing.leaseToken !== leaseToken) {
        fail("lease-token-mismatch", "只能由当前 holder + leaseToken 释放写租约。", [
          denialHint(existing),
        ]);
      }
      await clearLeaseUnlocked(root);
      return { released: true as const, projectRoot: root };
    }));
}

/**
 * 生图相关写命令入口闸。
 * - require：必须持有未过期租约且 holderId+leaseToken 匹配
 * - compat：无租约放行；有租约时必须匹配
 */
export async function assertStudioProjectWriteLeaseForCommand(
  projectRoot: string,
  input: {
    command: string;
    holderId?: string;
    leaseToken?: string;
  },
): Promise<void> {
  if (!STUDIO_WRITE_LEASE_ENFORCED_COMMANDS.has(input.command)) return;
  if (process.env.AI_CANVAS_DISABLE_WRITE_LEASE === "1") return;

  const root = path.resolve(projectRoot);
  const mode = getStudioWriteLeaseMode();
  // 入口授权只读取原子 rename 的租约文件；不能为了判断“谁可写”而初始化或
  // 修复 generation owner。首次业务执行会在 command executor 内单独完成
  // writable managed-project 复检，终态 same-key replay 则保持物理只读。
  const projection = await getStudioProjectWriteLeaseReadOnly(root);
  const holderId = input.holderId?.trim();
  const leaseToken = input.leaseToken?.trim();

  if (!projection.held || !projection.lease) {
    if (mode === "compat") return;
    fail(
      "lease-required",
      "无写租约：生图相关写命令必须先 acquire_studio_project_write_lease，再携带 writeLeaseHolderId+writeLeaseToken。",
      [
        `command=${input.command}`,
        `mode=${mode}`,
        "hint=get_active_managed_studio_context → acquire_studio_project_write_lease → execute_command",
      ],
    );
  }

  if (!holderId || !leaseToken) {
    fail("lease-held", projection.denialHint ?? "写租约被占用；请先 acquire 或等待。", [
      `command=${input.command}`,
      "missing holderId/leaseToken",
    ]);
  }
  if (holderId !== projection.lease.holderId || leaseToken !== projection.lease.leaseToken) {
    fail("lease-held", projection.denialHint ?? "写租约被其他持有者占用。", [
      `command=${input.command}`,
      `requestedHolder=${holderId}`,
      `activeHolder=${projection.lease.holderId}`,
    ]);
  }
}

/** 给 generation_unknown 场景的只读处置建议（不派发生图）。 */
export type StudioGenerationUnknownDisposition =
  | "reconcile_only"
  | "may_fail_run"
  | "may_abandon_call"
  | "wait"
  | "clear";

// ─────────────────────────────────────────────────────────────────────
// T15: 单元级租约（在 project-level 基础上，标注当前写入的单元）
// ─────────────────────────────────────────────────────────────────────

export interface StudioUnitWriteLeaseEntry {
  unitId: string;
  /** 持有者 holderId（同 project-level）。 */
  holderId: string;
  holderKind: StudioWriteLeaseHolderKind;
  mode: "generation" | "review" | "binding";
  heartbeatAt: string;
  expiresAt: string;
}

export interface StudioUnitWriteLeaseProjection {
  kind: "studio-unit-write-lease-projection";
  entries: StudioUnitWriteLeaseEntry[];
  /** 画布顶部显示摘要："codex 正在写 U00" */
  displayHint: string | null;
}

const UNIT_LEASE_TTL_MS = 5 * 60 * 1000; // 5 分钟默认

function unitLeasePath(projectRoot: string): string {
  return path.join(path.resolve(projectRoot), SIDECAR_DIR, "unit-write-leases.json");
}

async function readUnitLeasesUnlocked(projectRoot: string): Promise<StudioUnitWriteLeaseEntry[]> {
  const file = unitLeasePath(projectRoot);
  try {
    await access(file);
  } catch {
    return [];
  }
  const text = await readFile(file, "utf8");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (entry): entry is StudioUnitWriteLeaseEntry =>
      entry && typeof entry === "object" &&
      typeof entry.unitId === "string" &&
      typeof entry.holderId === "string" &&
      typeof entry.expiresAt === "string",
  );
}

async function writeUnitLeasesUnlocked(projectRoot: string, entries: StudioUnitWriteLeaseEntry[]): Promise<void> {
  const file = unitLeasePath(projectRoot);
  const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(tmp, JSON.stringify(entries, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  await rename(tmp, file);
}

/** 清除过期条目。 */
function pruneUnitLeases(entries: StudioUnitWriteLeaseEntry[], nowMs = Date.now()): StudioUnitWriteLeaseEntry[] {
  return entries.filter((e) => new Date(e.expiresAt).getTime() > nowMs);
}

/**
 * T15: 获取 / 注册 / 释放单元级写租约。
 * 同一 unitId 同时只有一个 writer；过期自动释放。
 */
export async function acquireStudioUnitWriteLease(
  projectRoot: string,
  input: {
    unitId: string;
    holderId: string;
    holderKind?: StudioWriteLeaseHolderKind | string;
    mode?: "generation" | "review" | "binding";
    ttlMs?: number;
  },
): Promise<StudioUnitWriteLeaseEntry> {
  const root = path.resolve(projectRoot);
  const holderId = normalizeHolderId(input.holderId);
  const holderKind = normalizeHolderKind(input.holderKind);
  const mode = input.mode ?? "generation";
  const ttlMs = input.ttlMs ?? UNIT_LEASE_TTL_MS;
  const now = Date.now();

  return withProjectLock(root, "unit-write-lease", async () => {
    let entries = pruneUnitLeases(await readUnitLeasesUnlocked(root), now);
    const existing = entries.find((e) => e.unitId === input.unitId);
    if (existing && existing.holderId !== holderId) {
      fail("lease-held", `单元 ${input.unitId} 正被 ${existing.holderId}（${existing.holderKind}）写入，请等待或对账。`);
    }
    // 续租或新建
    const entry: StudioUnitWriteLeaseEntry = {
      unitId: input.unitId,
      holderId,
      holderKind,
      mode,
      heartbeatAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttlMs).toISOString(),
    };
    entries = entries.filter((e) => e.unitId !== input.unitId);
    entries.push(entry);
    await writeUnitLeasesUnlocked(root, entries);
    return entry;
  });
}

/** T15: 释放单元级写租约。 */
export async function releaseStudioUnitWriteLease(
  projectRoot: string,
  input: { unitId: string; holderId: string },
): Promise<{ released: true }> {
  const root = path.resolve(projectRoot);
  const holderId = normalizeHolderId(input.holderId);
  return withProjectLock(root, "unit-write-lease", async () => {
    let entries = pruneUnitLeases(await readUnitLeasesUnlocked(root));
    const existing = entries.find((e) => e.unitId === input.unitId);
    if (existing && existing.holderId !== holderId) {
      fail("lease-held", `单元 ${input.unitId} 的租约属于 ${existing.holderId}，无权释放。`);
    }
    entries = entries.filter((e) => e.unitId !== input.unitId);
    await writeUnitLeasesUnlocked(root, entries);
    return { released: true as const };
  });
}

/** T15: 查询所有活动单元级写租约（画布顶部显示）。 */
export async function getStudioUnitWriteLeases(projectRoot: string): Promise<StudioUnitWriteLeaseProjection> {
  const root = path.resolve(projectRoot);
  // 正式 writer 使用临时文件 + 原子 rename；显示查询无需创建 project lock。
  // 该投影只用于提示，任何写授权仍必须在命令提交时重新取得正式租约 owner。
  const entries = pruneUnitLeases(await readUnitLeasesUnlocked(root));
  const displayHint = entries.length > 0
    ? entries.map((e) => `${e.holderId}（${e.holderKind}）→ ${e.unitId} [${e.mode}]`).join("；")
    : null;
  return {
    kind: "studio-unit-write-lease-projection" as const,
    entries,
    displayHint,
  };
}

export function recommendGenerationUnknownDisposition(input: {
  hasCallIntent: boolean;
  hasCommittedResult: boolean;
  runTerminal: "failed" | "cancelled" | "succeeded" | null;
  remoteMayExist: boolean;
}): {
  disposition: StudioGenerationUnknownDisposition;
  allowRedispatch: false;
  message: string;
} {
  if (input.hasCommittedResult || input.runTerminal === "succeeded") {
    return {
      disposition: "clear",
      allowRedispatch: false,
      message: "结果已在账本；禁止重派。请走 Review/对账，不要 re-dispatch。",
    };
  }
  if (input.runTerminal === "failed" || input.runTerminal === "cancelled") {
    return {
      disposition: "clear",
      allowRedispatch: false,
      message: "run 已终态；新尝试必须新 generationRunId，不得复用不明态键自动重放。",
    };
  }
  if (input.hasCallIntent && input.remoteMayExist) {
    return {
      disposition: "reconcile_only",
      allowRedispatch: false,
      message: "generation_unknown：只能对账（reconcile_studio_imagegen_call / abandon_*），禁止 re-dispatch 与二次生图。",
    };
  }
  if (input.hasCallIntent) {
    return {
      disposition: "may_abandon_call",
      allowRedispatch: false,
      message: "有 call intent 但结果不明：先对账；确认未调用可用 reconcile not-invoked；确认不可恢复再用 abandon（需双确认字段）。",
    };
  }
  return {
    disposition: "may_fail_run",
    allowRedispatch: false,
    message: "无 call intent：可用 fail_studio_generation_run 登记失败后开新 run；禁止对同一不明态自动重试。",
  };
}
