import { createHash, randomBytes } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

export interface NovelDestinationSelectionTicket {
  destinationId: string;
  destinationName: string;
}

export interface NovelDestinationSelectionGrant extends NovelDestinationSelectionTicket {
  /** 仅限 Main/Core 内部消费，绝不能投影给 renderer。 */
  projectsRoot: string;
  identity: Readonly<{
    dev: bigint;
    ino: bigint;
    mode: bigint;
    nlink: bigint;
    size: bigint;
    mtimeNs: bigint;
    ctimeNs: bigint;
  }>;
}

interface NovelDestinationSelectionSession extends NovelDestinationSelectionGrant {
  destinationHash: string;
  expiresAtMs: number;
}

interface NovelDestinationAuthorizationBinding {
  authorizationId: string;
  authorizationHash: string;
  grant: NovelDestinationSelectionGrant;
  expiresAtMs: number;
}

export interface NovelDestinationAuthorizationReservation {
  reservationId: string;
}

interface NovelDestinationAuthorizationReservationSession {
  reservationId: string;
  reservationHash: string;
  grant: NovelDestinationSelectionGrant;
  expiresAtMs: number;
  finalizing: boolean;
}

interface PreflightAuthorizationTicketLike {
  authorizationId: string;
  expiresAt: string;
}

export const NOVEL_DESTINATION_SELECTION_TTL_MS = 5 * 60 * 1_000;
export const NOVEL_DESTINATION_SELECTION_CAPACITY = 128;
export const NOVEL_DESTINATION_AUTHORIZATION_CAPACITY = 128;
export const NOVEL_DESTINATION_SELECTION_ID_PATTERN = /^novel-destination-selection-[A-Za-z0-9_-]{43}$/u;
const NOVEL_PREFLIGHT_AUTHORIZATION_ID_PATTERN = /^novel-preflight-auth-[A-Za-z0-9_-]{43}$/u;
const NOVEL_DESTINATION_RESERVATION_ID_PATTERN = /^novel-destination-reservation-[A-Za-z0-9_-]{43}$/u;
const NOVEL_DESTINATION_RESERVATION_TTL_MS = 15 * 60 * 1_000;

const destinationSessions = new Map<string, NovelDestinationSelectionSession>();
const authorizationReservations = new Map<string, NovelDestinationAuthorizationReservationSession>();
const authorizationBindings = new Map<string, NovelDestinationAuthorizationBinding>();

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function freezeIdentity(metadata: BigIntStats): NovelDestinationSelectionGrant["identity"] {
  return Object.freeze({
    dev: metadata.dev,
    ino: metadata.ino,
    mode: metadata.mode,
    nlink: metadata.nlink,
    size: metadata.size,
    mtimeNs: metadata.mtimeNs,
    ctimeNs: metadata.ctimeNs,
  });
}

function sameIdentity(
  left: NovelDestinationSelectionGrant["identity"],
  right: NovelDestinationSelectionGrant["identity"],
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function destinationChanged(cause?: unknown): Error & { code: "NOVEL_DESTINATION_CHANGED" } {
  return Object.assign(new Error("小说导入目标自原生选择后身份已变化。", cause === undefined
    ? undefined
    : { cause }), { code: "NOVEL_DESTINATION_CHANGED" as const });
}

function pruneExpired(nowMs: number): void {
  for (const [key, session] of destinationSessions) {
    if (session.expiresAtMs <= nowMs) destinationSessions.delete(key);
  }
  for (const [key, binding] of authorizationBindings) {
    if (binding.expiresAtMs <= nowMs) authorizationBindings.delete(key);
  }
  for (const [key, reservation] of authorizationReservations) {
    if (reservation.expiresAtMs <= nowMs) authorizationReservations.delete(key);
  }
}

async function inspectDestination(
  projectsRootInput: string,
): Promise<Omit<NovelDestinationSelectionGrant, "destinationId">> {
  if (typeof projectsRootInput !== "string" || !projectsRootInput || projectsRootInput.includes("\0")
    || !path.isAbsolute(projectsRootInput)) {
    throw new Error("原生小说目标选择结果必须是非空绝对路径。");
  }
  const projectsRoot = path.resolve(projectsRootInput);
  const metadata = await lstat(projectsRoot, { bigint: true });
  if (!metadata.isDirectory()) throw new Error("小说导入目标必须是真实目录。");
  if (metadata.isSymbolicLink() || await realpath(projectsRoot) !== projectsRoot) {
    throw new Error("小说导入目标必须是无符号链接的规范真实路径。");
  }
  return {
    projectsRoot,
    destinationName: path.basename(projectsRoot) || "所选目录",
    identity: freezeIdentity(metadata),
  };
}

async function revalidateDestination(grant: NovelDestinationSelectionGrant): Promise<void> {
  let current: Awaited<ReturnType<typeof inspectDestination>>;
  try {
    current = await inspectDestination(grant.projectsRoot);
  } catch (error) {
    throw destinationChanged(error);
  }
  if (current.projectsRoot !== grant.projectsRoot
    || current.destinationName !== grant.destinationName
    || !sameIdentity(current.identity, grant.identity)) {
    throw destinationChanged();
  }
}

/** Main 在原生目录选择器返回后签发；DTO 不包含路径或 inode。 */
export async function issueNovelDestinationSelection(
  projectsRootInput: string,
): Promise<NovelDestinationSelectionTicket> {
  const inspected = await inspectDestination(projectsRootInput);
  const nowMs = Date.now();
  pruneExpired(nowMs);
  if (destinationSessions.size >= NOVEL_DESTINATION_SELECTION_CAPACITY) {
    throw new Error("小说目标选择票据容量已满，请稍后重新选择。");
  }
  const destinationId = `novel-destination-selection-${randomBytes(32).toString("base64url")}`;
  const destinationHash = sha256(destinationId);
  destinationSessions.set(destinationHash, {
    ...inspected,
    destinationId,
    destinationHash,
    expiresAtMs: nowMs + NOVEL_DESTINATION_SELECTION_TTL_MS,
  });
  return Object.freeze({ destinationId, destinationName: inspected.destinationName });
}

/** 一次性消费：在首次 await 前删除，并发/重放最多一方成功。 */
export async function consumeNovelDestinationSelection(
  destinationId: string,
): Promise<NovelDestinationSelectionGrant> {
  if (typeof destinationId !== "string" || !NOVEL_DESTINATION_SELECTION_ID_PATTERN.test(destinationId)) {
    throw new Error("小说目标 destinationId 无效、过期或已消费。");
  }
  const nowMs = Date.now();
  pruneExpired(nowMs);
  const destinationHash = sha256(destinationId);
  const session = destinationSessions.get(destinationHash);
  if (!session || session.destinationId !== destinationId || session.destinationHash !== destinationHash
    || session.expiresAtMs <= nowMs) {
    throw new Error("小说目标 destinationId 无效、过期或已消费。");
  }
  destinationSessions.delete(destinationHash);
  const grant: NovelDestinationSelectionGrant = Object.freeze({
    destinationId: session.destinationId,
    destinationName: session.destinationName,
    projectsRoot: session.projectsRoot,
    identity: session.identity,
  });
  await revalidateDestination(grant);
  return grant;
}

/**
 * 在执行可能签发 Core authorization 的预检前预留容量。因此容量已满
 * 会在 Core 签发任何 authorization 之前失败，不会留下未绑定授权。
 */
export async function reserveNovelDestinationForPreflightAuthorization(
  grant: NovelDestinationSelectionGrant,
): Promise<NovelDestinationAuthorizationReservation> {
  const nowMs = Date.now();
  pruneExpired(nowMs);
  if (authorizationReservations.size + authorizationBindings.size
    >= NOVEL_DESTINATION_AUTHORIZATION_CAPACITY) {
    throw new Error("小说目标授权容量已满，请重新预检。");
  }
  const reservationId = `novel-destination-reservation-${randomBytes(32).toString("base64url")}`;
  const reservationHash = sha256(reservationId);
  authorizationReservations.set(reservationHash, {
    reservationId,
    reservationHash,
    grant,
    expiresAtMs: nowMs + NOVEL_DESTINATION_RESERVATION_TTL_MS,
    finalizing: false,
  });
  try {
    await revalidateDestination(grant);
  } catch (error) {
    authorizationReservations.delete(reservationHash);
    throw error;
  }
  return Object.freeze({ reservationId });
}

/** 将预留的 Main 内部目标绑定到 Core 预检授权。 */
export async function bindNovelDestinationToPreflightAuthorization(
  reservation: NovelDestinationAuthorizationReservation,
  authorization: PreflightAuthorizationTicketLike,
): Promise<void> {
  if (!reservation || typeof reservation.reservationId !== "string"
    || !NOVEL_DESTINATION_RESERVATION_ID_PATTERN.test(reservation.reservationId)) {
    throw new Error("小说目标授权预留无效。");
  }
  if (!authorization || typeof authorization.authorizationId !== "string"
    || !NOVEL_PREFLIGHT_AUTHORIZATION_ID_PATTERN.test(authorization.authorizationId)) {
    throw new Error("小说预检授权 ID 无效。");
  }
  const expiresAtMs = Date.parse(authorization.expiresAt);
  const nowMs = Date.now();
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) {
    throw new Error("小说预检授权已过期。");
  }
  pruneExpired(nowMs);
  const reservationHash = sha256(reservation.reservationId);
  const session = authorizationReservations.get(reservationHash);
  if (!session || session.reservationId !== reservation.reservationId
    || session.reservationHash !== reservationHash || session.expiresAtMs <= nowMs
    || session.finalizing) {
    throw new Error("小说目标授权预留无效、过期或已消费。");
  }
  const authorizationHash = sha256(authorization.authorizationId);
  if (authorizationBindings.has(authorizationHash)) {
    throw new Error("小说预检授权已绑定目标。");
  }
  session.finalizing = true;
  try {
    await revalidateDestination(session.grant);
    authorizationBindings.set(authorizationHash, {
      authorizationId: authorization.authorizationId,
      authorizationHash,
      grant: session.grant,
      expiresAtMs,
    });
  } finally {
    authorizationReservations.delete(reservationHash);
  }
}

/** 预检不可导入或异常时释放未转换的容量预留。 */
export function releaseNovelDestinationPreflightReservation(
  reservation: NovelDestinationAuthorizationReservation,
): void {
  if (!reservation || typeof reservation.reservationId !== "string"
    || !NOVEL_DESTINATION_RESERVATION_ID_PATTERN.test(reservation.reservationId)) return;
  const reservationHash = sha256(reservation.reservationId);
  const session = authorizationReservations.get(reservationHash);
  if (session?.reservationId === reservation.reservationId && !session.finalizing) {
    authorizationReservations.delete(reservationHash);
  }
}

/** 执行前一次性解决服务端规范根，并复验原生选中目录的身份。 */
export async function consumeNovelDestinationForPreflightAuthorization(
  authorizationId: string,
): Promise<NovelDestinationSelectionGrant> {
  if (typeof authorizationId !== "string" || !NOVEL_PREFLIGHT_AUTHORIZATION_ID_PATTERN.test(authorizationId)) {
    throw new Error("小说预检授权未绑定有效目标。");
  }
  const nowMs = Date.now();
  pruneExpired(nowMs);
  const authorizationHash = sha256(authorizationId);
  const binding = authorizationBindings.get(authorizationHash);
  if (!binding || binding.authorizationId !== authorizationId
    || binding.authorizationHash !== authorizationHash || binding.expiresAtMs <= nowMs) {
    throw new Error("小说预检授权未绑定有效目标。");
  }
  authorizationBindings.delete(authorizationHash);
  await revalidateDestination(binding.grant);
  return binding.grant;
}

/** 仅测试环境可用。 */
export function resetNovelDestinationSelectionsForTests(): void {
  if (process.env.NODE_ENV !== "test") throw new Error("只允许在测试环境清理小说目标选择票据。");
  destinationSessions.clear();
  authorizationReservations.clear();
  authorizationBindings.clear();
}
