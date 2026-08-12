import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getStudioMedia, type StudioMediaKind } from "./material-studio.js";
import { inspectManagedProject } from "./managed-project.js";
import { getApprovedTimelineProjection } from "./studio-approved-timeline-projection.js";
import {
  getStudioProductionState,
  readStudioProductionUnitSnapshot,
  type StudioProductionPanel,
  type StudioProductionUnitSnapshot,
} from "./studio-production.js";
import {
  studioMediaDerivativeRecipeKey,
  type StudioMediaDerivativeKind,
} from "./studio-media-derivatives.js";
import { resolveStudioMediaRequest } from "./studio-media-protocol.js";
import { STUDIO_SQLITE_WRITE_BUSY_TIMEOUT_MS, studioSqliteBusyTimeoutMs } from "./studio-sqlite-busy.js";

const SCHEMA_VERSION = 1 as const;
const DATABASE_RELATIVE_PATH = ".aicanvas/studio-production.sqlite";
const MAX_NOTE_LENGTH = 4_000;

export type StudioMultimediaTimelineRole =
  | "storyboard"
  | "video"
  | "dialogue"
  | "music"
  | "sfx";

export interface AttachStudioMultimediaTimelineMediaInput {
  operationId: string;
  unitId: string;
  unitRevision: number;
  expectedUnitFingerprint: string;
  slotId: string;
  expectedHeadRevision: number;
  panelIndex?: number;
  startSeconds: number;
  endSeconds: number;
  role: StudioMultimediaTimelineRole;
  mediaSha256: string;
  note?: string;
}

export interface StudioMultimediaTimelineBinding {
  schemaVersion: typeof SCHEMA_VERSION;
  kind: "studio-multimedia-timeline-binding";
  recordId: string;
  operationId: string;
  unitId: string;
  unitRevision: number;
  unitFingerprint: string;
  slotId: string;
  revision: number;
  panelIndex?: number;
  panelId?: string;
  startSeconds: number;
  endSeconds: number;
  role: StudioMultimediaTimelineRole;
  mediaSha256: string;
  mediaKind: StudioMediaKind;
  note: string;
  supersedesRecordId?: string;
  fingerprint: string;
  createdAt: string;
}

export interface AttachStudioMultimediaTimelineMediaResult {
  binding: StudioMultimediaTimelineBinding;
  replayed: boolean;
}

export interface StudioMultimediaDerivativeProjection {
  kind: "thumbnail" | StudioMediaDerivativeKind;
  status: "ready";
  key: string;
  mimeType: string;
  sizeBytes: number;
  etag: string;
}

export interface StudioMultimediaMediaProjection {
  sha256: string;
  kind: StudioMediaKind;
  mimeType: string;
  sizeBytes: number;
  sourceBasename: string;
  casVerified: true;
  derivatives: StudioMultimediaDerivativeProjection[];
  derivativeGaps: Array<{
    kind: "thumbnail" | StudioMediaDerivativeKind;
    reason: string;
  }>;
}

export interface StudioMultimediaTimelineTrackProjection {
  binding: StudioMultimediaTimelineBinding;
  media: StudioMultimediaMediaProjection;
}

export interface StudioApprovedStoryboardProjection {
  status: "available" | "missing" | "invalid" | "not-applicable";
  productionStatus: string | null;
  selectedResultSource: "generation-run" | "historical-import" | null;
  raw: StudioMultimediaMediaProjection | null;
  labeled: StudioMultimediaMediaProjection | null;
  issues: string[];
}

export interface StudioMultimediaTimelineProjection {
  schemaVersion: typeof SCHEMA_VERSION;
  kind: "studio-multimedia-timeline-projection";
  unit: {
    id: string;
    revision: number;
    fingerprint: string;
    season: string;
    episode: string;
    sequence: number;
    title: string;
    durationSeconds: number;
    episodeStartSeconds: number;
    episodeEndSeconds: number;
  };
  script: {
    revisionId: string;
    sha256: string;
    source: string;
    sourceVersion: string;
    body: string;
  };
  panels: Array<{
    id: string;
    index: number;
    title: string;
    startSeconds: number;
    endSeconds: number;
    visualAction: string;
    shotComposition: string;
    filmingMethod: string;
    dialogue: string;
    subtitle: string;
    sourceSurfaces: Array<{
      startOffsetUtf16: number;
      endOffsetUtf16: number;
      sha256: string;
      text: string;
    }>;
  }>;
  approvedStoryboard: StudioApprovedStoryboardProjection;
  tracks: StudioMultimediaTimelineTrackProjection[];
  availability: {
    script: "available";
    storyboard: StudioApprovedStoryboardProjection["status"] | "source-only";
    video: "available" | "missing";
    audio: "available" | "missing";
  };
  gaps: Array<{
    code: string;
    media: "storyboard" | "video" | "audio";
    required: boolean;
    reason: string;
  }>;
  fingerprint: string;
  builtAt: string;
}

export class StudioMultimediaTimelineConflictError extends Error {
  readonly expectedRevision: number;
  readonly actualRevision: number;

  constructor(slotId: string, expectedRevision: number, actualRevision: number) {
    super(`四媒体时间线 slot ${slotId} revision 冲突：期望 ${expectedRevision}，实际 ${actualRevision}。`);
    this.name = "StudioMultimediaTimelineConflictError";
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

interface TimelineBindingRow {
  record_id: string;
  operation_id: string;
  input_fingerprint: string;
  unit_id: string;
  unit_revision: number;
  unit_fingerprint: string;
  slot_id: string;
  revision: number;
  panel_index: number | null;
  panel_id: string | null;
  start_ms: number;
  end_ms: number;
  role: string;
  media_sha256: string;
  media_kind: string;
  note: string;
  supersedes_record_id: string | null;
  fingerprint: string;
  created_at: string;
}

const EXPECTED_BINDING_COLUMNS = [
  "record_id",
  "operation_id",
  "input_fingerprint",
  "unit_id",
  "unit_revision",
  "unit_fingerprint",
  "slot_id",
  "revision",
  "panel_index",
  "panel_id",
  "start_ms",
  "end_ms",
  "role",
  "media_sha256",
  "media_kind",
  "note",
  "supersedes_record_id",
  "fingerprint",
  "created_at",
] as const;

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([key, entry]) => [key, stableValue(entry)]));
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stableValue(value)), "utf8").digest("hex");
}

function normalizeStableId(value: string, field: string): string {
  if (typeof value !== "string") throw new Error(`${field} 必须是文本。`);
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/u.test(normalized)) {
    throw new Error(`${field} 格式无效。`);
  }
  return normalized;
}

function normalizeSha256(value: string, field: string): string {
  if (typeof value !== "string") throw new Error(`${field} 必须是文本。`);
  const normalized = value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(normalized)) throw new Error(`${field} 必须是完整的 64 位 SHA-256。`);
  return normalized;
}

function normalizeRole(value: string): StudioMultimediaTimelineRole {
  if (value !== "storyboard" && value !== "video" && value !== "dialogue" && value !== "music" && value !== "sfx") {
    throw new Error("role 必须是 storyboard、video、dialogue、music 或 sfx。");
  }
  return value;
}

function expectedMediaKind(role: StudioMultimediaTimelineRole): StudioMediaKind {
  if (role === "storyboard") return "image";
  if (role === "video") return "video";
  return "audio";
}

function normalizeSeconds(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${field} 必须是非负有限数字。`);
  const milliseconds = Math.round(value * 1_000);
  if (Math.abs(milliseconds - value * 1_000) > 1e-6) throw new Error(`${field} 最多支持毫秒精度。`);
  return milliseconds;
}

function normalizeNote(value: string | undefined): string {
  if (value === undefined) return "";
  if (typeof value !== "string") throw new Error("note 必须是文本。");
  const normalized = value.trim();
  if (normalized.length > MAX_NOTE_LENGTH) throw new Error(`note 不能超过 ${MAX_NOTE_LENGTH} 个字符。`);
  return normalized;
}

function assertPositiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${field} 必须是正整数。`);
  return value;
}

function assertHeadRevision(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("expectedHeadRevision 必须是非负整数。");
  return value;
}

function databasePath(projectRoot: string): string {
  return path.join(projectRoot, DATABASE_RELATIVE_PATH);
}

function configureDatabase(db: DatabaseSync, readOnly: boolean, busyTimeoutMs: number): void {
  db.exec(`PRAGMA busy_timeout=${busyTimeoutMs}; PRAGMA foreign_keys=ON;`);
  if (readOnly) db.exec("PRAGMA query_only=ON;");
  const foreignKeys = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys?: number } | undefined;
  if (foreignKeys?.foreign_keys !== 1) throw new Error("四媒体时间线数据库未启用 foreign_keys。");
}

function ensureSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS studio_multimedia_timeline_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS studio_multimedia_timeline_bindings (
      record_id TEXT PRIMARY KEY,
      operation_id TEXT NOT NULL UNIQUE,
      input_fingerprint TEXT NOT NULL CHECK(length(input_fingerprint) = 64),
      unit_id TEXT NOT NULL,
      unit_revision INTEGER NOT NULL CHECK(unit_revision >= 1),
      unit_fingerprint TEXT NOT NULL CHECK(length(unit_fingerprint) = 64),
      slot_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK(revision >= 1),
      panel_index INTEGER CHECK(panel_index IS NULL OR panel_index BETWEEN 1 AND 6),
      panel_id TEXT,
      start_ms INTEGER NOT NULL CHECK(start_ms >= 0),
      end_ms INTEGER NOT NULL CHECK(end_ms > start_ms),
      role TEXT NOT NULL CHECK(role IN ('storyboard', 'video', 'dialogue', 'music', 'sfx')),
      media_sha256 TEXT NOT NULL CHECK(length(media_sha256) = 64),
      media_kind TEXT NOT NULL CHECK(media_kind IN ('image', 'video', 'audio')),
      note TEXT NOT NULL,
      supersedes_record_id TEXT,
      fingerprint TEXT NOT NULL UNIQUE CHECK(length(fingerprint) = 64),
      created_at TEXT NOT NULL,
      UNIQUE(unit_id, unit_revision, slot_id, revision),
      CHECK((panel_index IS NULL AND panel_id IS NULL) OR (panel_index IS NOT NULL AND panel_id IS NOT NULL)),
      FOREIGN KEY(unit_id, unit_revision)
        REFERENCES studio_production_unit_revisions(unit_id, revision) ON DELETE RESTRICT,
      FOREIGN KEY(supersedes_record_id)
        REFERENCES studio_multimedia_timeline_bindings(record_id) ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS studio_multimedia_timeline_heads (
      unit_id TEXT NOT NULL,
      unit_revision INTEGER NOT NULL CHECK(unit_revision >= 1),
      slot_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK(revision >= 1),
      record_id TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(unit_id, unit_revision, slot_id),
      FOREIGN KEY(unit_id, unit_revision, slot_id, revision)
        REFERENCES studio_multimedia_timeline_bindings(unit_id, unit_revision, slot_id, revision) ON DELETE RESTRICT,
      FOREIGN KEY(record_id)
        REFERENCES studio_multimedia_timeline_bindings(record_id) ON DELETE RESTRICT
    ) STRICT;

    CREATE INDEX IF NOT EXISTS studio_multimedia_timeline_range_idx
      ON studio_multimedia_timeline_bindings(unit_id, unit_revision, start_ms, end_ms, role);
  `);
  const version = db.prepare("SELECT value FROM studio_multimedia_timeline_meta WHERE key = 'schema_version'").get() as
    | { value?: string }
    | undefined;
  if (version?.value !== undefined && version.value !== String(SCHEMA_VERSION)) {
    throw new Error(`不支持的四媒体时间线 schema_version：${String(version.value)}。`);
  }
  db.prepare(`
    INSERT INTO studio_multimedia_timeline_meta(key, value)
    VALUES('schema_version', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(String(SCHEMA_VERSION));
  assertSchema(db);
}

function hasSchema(db: DatabaseSync): boolean {
  const tables = db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name IN (
      'studio_multimedia_timeline_meta',
      'studio_multimedia_timeline_bindings',
      'studio_multimedia_timeline_heads'
    )
    ORDER BY name
  `).all() as Array<{ name?: unknown }>;
  if (tables.length === 0) return false;
  if (tables.length !== 3) throw new Error("四媒体时间线数据库 schema 不完整。");
  assertSchema(db);
  return true;
}

function assertSchema(db: DatabaseSync): void {
  const version = db.prepare("SELECT value FROM studio_multimedia_timeline_meta WHERE key = 'schema_version'").get() as
    | { value?: unknown }
    | undefined;
  if (version?.value !== String(SCHEMA_VERSION)) throw new Error("四媒体时间线 schema_version 缺失或漂移。");
  const columns = db.prepare("PRAGMA table_info(studio_multimedia_timeline_bindings)").all() as Array<{ name?: unknown }>;
  if (columns.length !== EXPECTED_BINDING_COLUMNS.length
    || columns.some((column, index) => column.name !== EXPECTED_BINDING_COLUMNS[index])) {
    throw new Error("四媒体时间线绑定表 schema 已漂移。");
  }
}

function openWriteDatabase(projectRoot: string): DatabaseSync {
  const busyTimeoutMs = studioSqliteBusyTimeoutMs(STUDIO_SQLITE_WRITE_BUSY_TIMEOUT_MS);
  const db = new DatabaseSync(databasePath(projectRoot), { timeout: busyTimeoutMs });
  try {
    configureDatabase(db, false, busyTimeoutMs);
    ensureSchema(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function openReadDatabase(projectRoot: string): DatabaseSync | null {
  const target = databasePath(projectRoot);
  if (!existsSync(target)) return null;
  const busyTimeoutMs = studioSqliteBusyTimeoutMs(STUDIO_SQLITE_WRITE_BUSY_TIMEOUT_MS);
  const db = new DatabaseSync(target, { readOnly: true, timeout: busyTimeoutMs });
  try {
    configureDatabase(db, true, busyTimeoutMs);
    if (!hasSchema(db)) {
      db.close();
      return null;
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function bindingSemanticPayload(binding: Omit<StudioMultimediaTimelineBinding, "recordId" | "fingerprint" | "createdAt">): object {
  return {
    schemaVersion: binding.schemaVersion,
    kind: binding.kind,
    operationId: binding.operationId,
    unitId: binding.unitId,
    unitRevision: binding.unitRevision,
    unitFingerprint: binding.unitFingerprint,
    slotId: binding.slotId,
    revision: binding.revision,
    panelIndex: binding.panelIndex,
    panelId: binding.panelId,
    startSeconds: binding.startSeconds,
    endSeconds: binding.endSeconds,
    role: binding.role,
    mediaSha256: binding.mediaSha256,
    mediaKind: binding.mediaKind,
    note: binding.note,
    supersedesRecordId: binding.supersedesRecordId,
  };
}

function bindingFromRow(row: TimelineBindingRow): StudioMultimediaTimelineBinding {
  const role = normalizeRole(row.role);
  const mediaKind = row.media_kind;
  if (mediaKind !== "image" && mediaKind !== "video" && mediaKind !== "audio") {
    throw new Error(`四媒体时间线记录 ${row.record_id} 的 media_kind 无效。`);
  }
  if (mediaKind !== expectedMediaKind(role)) throw new Error(`四媒体时间线记录 ${row.record_id} 的 role/kind 已漂移。`);
  const binding: StudioMultimediaTimelineBinding = {
    schemaVersion: SCHEMA_VERSION,
    kind: "studio-multimedia-timeline-binding",
    recordId: normalizeStableId(row.record_id, "recordId"),
    operationId: normalizeStableId(row.operation_id, "operationId"),
    unitId: normalizeStableId(row.unit_id, "unitId"),
    unitRevision: assertPositiveInteger(Number(row.unit_revision), "unitRevision"),
    unitFingerprint: normalizeSha256(row.unit_fingerprint, "unitFingerprint"),
    slotId: normalizeStableId(row.slot_id, "slotId"),
    revision: assertPositiveInteger(Number(row.revision), "revision"),
    ...(row.panel_index === null ? {} : { panelIndex: assertPositiveInteger(Number(row.panel_index), "panelIndex") }),
    ...(row.panel_id === null ? {} : { panelId: normalizeStableId(row.panel_id, "panelId") }),
    startSeconds: Number(row.start_ms) / 1_000,
    endSeconds: Number(row.end_ms) / 1_000,
    role,
    mediaSha256: normalizeSha256(row.media_sha256, "mediaSha256"),
    mediaKind,
    note: normalizeNote(row.note),
    ...(row.supersedes_record_id === null
      ? {}
      : { supersedesRecordId: normalizeStableId(row.supersedes_record_id, "supersedesRecordId") }),
    fingerprint: normalizeSha256(row.fingerprint, "fingerprint"),
    createdAt: row.created_at,
  };
  if ((binding.panelIndex === undefined) !== (binding.panelId === undefined)) {
    throw new Error(`四媒体时间线记录 ${row.record_id} 的 panel 锚点不完整。`);
  }
  const expected = fingerprint(bindingSemanticPayload(binding));
  if (expected !== binding.fingerprint || binding.recordId !== `timeline-binding-${expected.slice(0, 40)}`) {
    throw new Error(`四媒体时间线记录 ${row.record_id} 的内容指纹已漂移。`);
  }
  return binding;
}

function currentRows(db: DatabaseSync, unitId: string, unitRevision: number): TimelineBindingRow[] {
  const headCount = Number((db.prepare(`
    SELECT COUNT(*) AS count
    FROM studio_multimedia_timeline_heads
    WHERE unit_id = ? AND unit_revision = ?
  `).get(unitId, unitRevision) as { count: number }).count);
  const rows = db.prepare(`
    SELECT b.*
    FROM studio_multimedia_timeline_heads h
    JOIN studio_multimedia_timeline_bindings b
      ON b.record_id = h.record_id
      AND b.unit_id = h.unit_id
      AND b.unit_revision = h.unit_revision
      AND b.slot_id = h.slot_id
      AND b.revision = h.revision
    WHERE h.unit_id = ? AND h.unit_revision = ?
    ORDER BY b.start_ms, b.end_ms, b.role, b.slot_id
  `).all(unitId, unitRevision) as unknown as TimelineBindingRow[];
  if (rows.length !== headCount) throw new Error(`单元 ${unitId}#${unitRevision} 的四媒体时间线 head 已漂移。`);
  return rows;
}

function historyRows(
  db: DatabaseSync,
  unitId: string,
  unitRevision: number,
  slotId: string,
): TimelineBindingRow[] {
  return db.prepare(`
    SELECT *
    FROM studio_multimedia_timeline_bindings
    WHERE unit_id = ? AND unit_revision = ? AND slot_id = ?
    ORDER BY revision
  `).all(unitId, unitRevision, slotId) as unknown as TimelineBindingRow[];
}

function panelForInput(snapshot: StudioProductionUnitSnapshot, panelIndex: number | undefined): StudioProductionPanel | undefined {
  if (panelIndex === undefined) return undefined;
  const normalized = assertPositiveInteger(panelIndex, "panelIndex");
  const panel = snapshot.panels.find((entry) => entry.index === normalized);
  if (!panel) throw new Error(`单元 ${snapshot.unit.id}#${snapshot.unit.revision} 不存在 panel ${normalized}。`);
  return panel;
}

function inputIdentity(input: {
  operationId: string;
  unitId: string;
  unitRevision: number;
  unitFingerprint: string;
  slotId: string;
  expectedHeadRevision: number;
  panelIndex?: number;
  panelId?: string;
  startMilliseconds: number;
  endMilliseconds: number;
  role: StudioMultimediaTimelineRole;
  mediaSha256: string;
  mediaKind: StudioMediaKind;
  note: string;
}): string {
  return fingerprint({ schemaVersion: SCHEMA_VERSION, kind: "studio-multimedia-timeline-attach-input", ...input });
}

export async function initializeStudioMultimediaTimeline(projectRoot: string): Promise<{
  schemaVersion: typeof SCHEMA_VERSION;
  databasePath: string;
  bindingCount: number;
  headCount: number;
}> {
  const shell = await inspectManagedProject(projectRoot);
  await getStudioProductionState(shell.paths.root);
  const db = openWriteDatabase(shell.paths.root);
  try {
    const bindingCount = Number((db.prepare("SELECT COUNT(*) AS count FROM studio_multimedia_timeline_bindings").get() as { count: number }).count);
    const headCount = Number((db.prepare("SELECT COUNT(*) AS count FROM studio_multimedia_timeline_heads").get() as { count: number }).count);
    return { schemaVersion: SCHEMA_VERSION, databasePath: databasePath(shell.paths.root), bindingCount, headCount };
  } finally {
    db.close();
  }
}

export async function listStudioMultimediaTimelineBindingHistory(
  projectRoot: string,
  input: { unitId: string; unitRevision: number; slotId: string },
): Promise<StudioMultimediaTimelineBinding[]> {
  const shell = await inspectManagedProject(projectRoot);
  const unitId = normalizeStableId(input.unitId, "unitId");
  const unitRevision = assertPositiveInteger(input.unitRevision, "unitRevision");
  const slotId = normalizeStableId(input.slotId, "slotId");
  const snapshot = await readStudioProductionUnitSnapshot(shell.paths.root, unitId, unitRevision);
  if (!snapshot) throw new Error(`生产单元 revision 不存在：${unitId}#${unitRevision}`);
  const db = openReadDatabase(shell.paths.root);
  if (!db) return [];
  try {
    const bindings = historyRows(db, unitId, unitRevision, slotId).map(bindingFromRow);
    bindings.forEach((binding, index) => {
      if (binding.unitFingerprint !== snapshot.fingerprint) {
        throw new Error(`四媒体时间线绑定 ${binding.recordId} 的 unit fingerprint 已漂移。`);
      }
      if (binding.revision !== index + 1) throw new Error(`四媒体时间线 slot ${slotId} 的 revision 不连续。`);
      const previous = bindings[index - 1];
      if (index === 0 && binding.supersedesRecordId !== undefined) {
        throw new Error(`四媒体时间线 slot ${slotId} 的首条记录不得 supersede 其他记录。`);
      }
      if (index > 0 && binding.supersedesRecordId !== previous?.recordId) {
        throw new Error(`四媒体时间线 slot ${slotId} 的 supersession 链已漂移。`);
      }
    });
    return bindings;
  } finally {
    db.close();
  }
}

/**
 * 命令总线崩溃对账的只读收据入口。只按不可变 operationId 读取，不初始化关系表，
 * 不移动 head；调用方仍必须把返回字段与原命令逐项核对后才能认定副作用已提交。
 */
export async function readStudioMultimediaTimelineBindingByOperationId(
  projectRoot: string,
  operationIdInput: string,
): Promise<StudioMultimediaTimelineBinding | null> {
  const shell = await inspectManagedProject(projectRoot);
  const operationId = normalizeStableId(operationIdInput, "operationId");
  const db = openReadDatabase(shell.paths.root);
  if (!db) return null;
  try {
    const row = db.prepare(`
      SELECT * FROM studio_multimedia_timeline_bindings
      WHERE operation_id = ?
    `).get(operationId) as unknown as TimelineBindingRow | undefined;
    if (!row) return null;
    const binding = bindingFromRow(row);
    const snapshot = await readStudioProductionUnitSnapshot(
      shell.paths.root,
      binding.unitId,
      binding.unitRevision,
    );
    if (!snapshot || snapshot.fingerprint !== binding.unitFingerprint) {
      throw new Error(`四媒体时间线绑定 ${binding.recordId} 的 unit fingerprint 已漂移。`);
    }
    return binding;
  } finally {
    db.close();
  }
}

export async function attachStudioMultimediaTimelineMedia(
  projectRoot: string,
  input: AttachStudioMultimediaTimelineMediaInput,
): Promise<AttachStudioMultimediaTimelineMediaResult> {
  const shell = await inspectManagedProject(projectRoot);
  const root = shell.paths.root;
  const operationId = normalizeStableId(input.operationId, "operationId");
  const unitId = normalizeStableId(input.unitId, "unitId");
  const unitRevision = assertPositiveInteger(input.unitRevision, "unitRevision");
  const expectedUnitFingerprint = normalizeSha256(input.expectedUnitFingerprint, "expectedUnitFingerprint");
  const slotId = normalizeStableId(input.slotId, "slotId");
  const expectedHeadRevision = assertHeadRevision(input.expectedHeadRevision);
  const role = normalizeRole(input.role);
  const mediaSha256 = normalizeSha256(input.mediaSha256, "mediaSha256");
  const note = normalizeNote(input.note);
  const snapshot = await readStudioProductionUnitSnapshot(root, unitId, unitRevision);
  if (!snapshot) throw new Error(`生产单元 revision 不存在：${unitId}#${unitRevision}`);
  if (snapshot.fingerprint !== expectedUnitFingerprint) {
    throw new Error(`生产单元 ${unitId}#${unitRevision} 指纹不匹配，拒绝绑定媒体。`);
  }
  const panel = panelForInput(snapshot, input.panelIndex);
  const startMilliseconds = normalizeSeconds(input.startSeconds, "startSeconds");
  const endMilliseconds = normalizeSeconds(input.endSeconds, "endSeconds");
  if (endMilliseconds <= startMilliseconds) throw new Error("endSeconds 必须大于 startSeconds。");
  const unitDurationMilliseconds = normalizeSeconds(snapshot.unit.durationSeconds, "unit durationSeconds");
  if (endMilliseconds > unitDurationMilliseconds) throw new Error("媒体时码越出单元范围。");
  if (panel) {
    const panelStart = normalizeSeconds(panel.startSeconds, "panel startSeconds");
    const panelEnd = normalizeSeconds(panel.endSeconds, "panel endSeconds");
    if (startMilliseconds < panelStart || endMilliseconds > panelEnd) {
      throw new Error(`媒体时码越出 panel ${panel.index} 的范围。`);
    }
  }
  if (role === "storyboard") {
    if (!panel) throw new Error("storyboard 绑定必须显式提供 panelIndex。");
    if (startMilliseconds !== normalizeSeconds(panel.startSeconds, "panel startSeconds")
      || endMilliseconds !== normalizeSeconds(panel.endSeconds, "panel endSeconds")) {
      throw new Error("storyboard 绑定必须完整覆盖所锚定 panel 的时码。");
    }
  }
  const media = await getStudioMedia(root, mediaSha256);
  if (!media) throw new Error(`素材媒体不存在：${mediaSha256}`);
  const requiredKind = expectedMediaKind(role);
  if (media.kind !== requiredKind) {
    throw new Error(`role ${role} 只能绑定 ${requiredKind}，当前素材为 ${media.kind}。`);
  }
  await resolveStudioMediaRequest(root, { mediaSha256 });

  await getStudioProductionState(root);
  const normalizedInput = {
    operationId,
    unitId,
    unitRevision,
    unitFingerprint: snapshot.fingerprint,
    slotId,
    expectedHeadRevision,
    ...(panel ? { panelIndex: panel.index, panelId: panel.id } : {}),
    startMilliseconds,
    endMilliseconds,
    role,
    mediaSha256,
    mediaKind: media.kind,
    note,
  };
  const inputFingerprint = inputIdentity(normalizedInput);
  const db = openWriteDatabase(root);
  try {
    const existingOperation = db.prepare(`
      SELECT * FROM studio_multimedia_timeline_bindings WHERE operation_id = ?
    `).get(operationId) as unknown as TimelineBindingRow | undefined;
    if (existingOperation) {
      if (existingOperation.input_fingerprint !== inputFingerprint) {
        throw new Error(`operationId ${operationId} 已绑定不同输入。`);
      }
      return { binding: bindingFromRow(existingOperation), replayed: true };
    }

    db.exec("BEGIN IMMEDIATE");
    try {
      const replayInside = db.prepare(`
        SELECT * FROM studio_multimedia_timeline_bindings WHERE operation_id = ?
      `).get(operationId) as unknown as TimelineBindingRow | undefined;
      if (replayInside) {
        if (replayInside.input_fingerprint !== inputFingerprint) {
          throw new Error(`operationId ${operationId} 已绑定不同输入。`);
        }
        db.exec("COMMIT");
        return { binding: bindingFromRow(replayInside), replayed: true };
      }
      const head = db.prepare(`
        SELECT h.revision, h.record_id
        FROM studio_multimedia_timeline_heads h
        WHERE h.unit_id = ? AND h.unit_revision = ? AND h.slot_id = ?
      `).get(unitId, unitRevision, slotId) as { revision?: number; record_id?: string } | undefined;
      const actualHeadRevision = Number(head?.revision ?? 0);
      if (actualHeadRevision !== expectedHeadRevision) {
        throw new StudioMultimediaTimelineConflictError(slotId, expectedHeadRevision, actualHeadRevision);
      }
      const bindingBase: Omit<StudioMultimediaTimelineBinding, "recordId" | "fingerprint" | "createdAt"> = {
        schemaVersion: SCHEMA_VERSION,
        kind: "studio-multimedia-timeline-binding",
        operationId,
        unitId,
        unitRevision,
        unitFingerprint: snapshot.fingerprint,
        slotId,
        revision: actualHeadRevision + 1,
        ...(panel ? { panelIndex: panel.index, panelId: panel.id } : {}),
        startSeconds: startMilliseconds / 1_000,
        endSeconds: endMilliseconds / 1_000,
        role,
        mediaSha256,
        mediaKind: media.kind,
        note,
        ...(head?.record_id ? { supersedesRecordId: head.record_id } : {}),
      };
      const bindingFingerprint = fingerprint(bindingSemanticPayload(bindingBase));
      const recordId = `timeline-binding-${bindingFingerprint.slice(0, 40)}`;
      const createdAt = new Date().toISOString();
      db.prepare(`
        INSERT INTO studio_multimedia_timeline_bindings(
          record_id, operation_id, input_fingerprint, unit_id, unit_revision, unit_fingerprint,
          slot_id, revision, panel_index, panel_id, start_ms, end_ms, role, media_sha256,
          media_kind, note, supersedes_record_id, fingerprint, created_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        recordId,
        operationId,
        inputFingerprint,
        unitId,
        unitRevision,
        snapshot.fingerprint,
        slotId,
        bindingBase.revision,
        panel?.index ?? null,
        panel?.id ?? null,
        startMilliseconds,
        endMilliseconds,
        role,
        mediaSha256,
        media.kind,
        note,
        head?.record_id ?? null,
        bindingFingerprint,
        createdAt,
      );
      db.prepare(`
        INSERT INTO studio_multimedia_timeline_heads(
          unit_id, unit_revision, slot_id, revision, record_id, updated_at
        ) VALUES(?, ?, ?, ?, ?, ?)
        ON CONFLICT(unit_id, unit_revision, slot_id) DO UPDATE SET
          revision = excluded.revision,
          record_id = excluded.record_id,
          updated_at = excluded.updated_at
      `).run(unitId, unitRevision, slotId, bindingBase.revision, recordId, createdAt);
      db.exec("COMMIT");
      const created = db.prepare("SELECT * FROM studio_multimedia_timeline_bindings WHERE record_id = ?")
        .get(recordId) as unknown as TimelineBindingRow;
      return { binding: bindingFromRow(created), replayed: false };
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.close();
  }
}

async function derivativeProjection(
  projectRoot: string,
  mediaSha256: string,
  kind: StudioMediaDerivativeKind,
): Promise<
  | { projection: StudioMultimediaDerivativeProjection; reason?: never }
  | { projection: null; reason: string }
> {
  const key = studioMediaDerivativeRecipeKey(kind, mediaSha256);
  try {
    const resolved = await resolveStudioMediaRequest(projectRoot, { derivativeRecipeKey: key });
    return {
      projection: {
        kind,
        status: "ready",
        key,
        mimeType: resolved.mimeType,
        sizeBytes: resolved.totalSize,
        etag: resolved.etag,
      },
    };
  } catch (error) {
    return {
      projection: null,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

async function mediaProjection(
  projectRoot: string,
  mediaSha256: string,
  expectedKind?: StudioMediaKind,
): Promise<StudioMultimediaMediaProjection> {
  const metadata = await getStudioMedia(projectRoot, mediaSha256);
  if (!metadata) throw new Error(`时间线引用的素材媒体不存在：${mediaSha256}`);
  if (expectedKind && metadata.kind !== expectedKind) {
    throw new Error(`时间线引用的素材 ${mediaSha256} kind 漂移：期望 ${expectedKind}，实际 ${metadata.kind}。`);
  }
  await resolveStudioMediaRequest(projectRoot, { mediaSha256 });
  const derivatives: StudioMultimediaDerivativeProjection[] = [];
  const derivativeGaps: StudioMultimediaMediaProjection["derivativeGaps"] = [];
  if (metadata.kind === "image") {
    if (!metadata.thumbnail) {
      derivativeGaps.push({ kind: "thumbnail", reason: "冻结缩略图记录缺失。" });
    } else {
      try {
        const resolved = await resolveStudioMediaRequest(projectRoot, { thumbnailRecipeKey: metadata.thumbnail.recipeKey });
        derivatives.push({
          kind: "thumbnail",
          status: "ready",
          key: metadata.thumbnail.recipeKey,
          mimeType: resolved.mimeType,
          sizeBytes: resolved.totalSize,
          etag: resolved.etag,
        });
      } catch (error) {
        derivativeGaps.push({
          kind: "thumbnail",
          reason: `冻结缩略图不可用：${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
  } else {
    const expectedDerivatives: StudioMediaDerivativeKind[] = metadata.kind === "video"
      ? ["video_poster", "video_proxy"]
      : ["audio_waveform"];
    for (const derivativeKind of expectedDerivatives) {
      const ready = await derivativeProjection(projectRoot, mediaSha256, derivativeKind);
      if (ready.projection) derivatives.push(ready.projection);
      else derivativeGaps.push({
        kind: derivativeKind,
        reason: `${derivativeKind} 尚无可验证的 ready 派生物：${ready.reason}`,
      });
    }
  }
  return {
    sha256: metadata.sha256,
    kind: metadata.kind,
    mimeType: metadata.mimeType,
    sizeBytes: metadata.sizeBytes,
    sourceBasename: metadata.sourceBasename,
    casVerified: true,
    derivatives,
    derivativeGaps,
  };
}

async function approvedStoryboardProjection(
  projectRoot: string,
  snapshot: StudioProductionUnitSnapshot,
  currentHead: boolean,
): Promise<StudioApprovedStoryboardProjection> {
  if (!currentHead) {
    return {
      status: "not-applicable",
      productionStatus: null,
      selectedResultSource: null,
      raw: null,
      labeled: null,
      issues: ["历史 unit revision 不冒充当前正式 raw/labeled。"],
    };
  }
  const projection = await getApprovedTimelineProjection(projectRoot, {
    season: snapshot.unit.season,
    episode: snapshot.unit.episode,
    fastMode: true,
  });
  const unit = projection.units.find((entry) => entry.unitId === snapshot.unit.id);
  if (!unit || !unit.selectedRawSha256 || !unit.selectedLabeledSha256 || unit.productionStatus !== "pass") {
    return {
      status: "missing",
      productionStatus: unit?.productionStatus ?? null,
      selectedResultSource: unit?.selectedResultSource ?? null,
      raw: null,
      labeled: null,
      issues: [
        unit?.projectionError,
        unit?.candidateWarning,
        "当前单元没有成对、已选中的 PASS raw/labeled。",
      ].filter((entry): entry is string => Boolean(entry)),
    };
  }
  const issues: string[] = [];
  let raw: StudioMultimediaMediaProjection | null = null;
  let labeled: StudioMultimediaMediaProjection | null = null;
  try {
    raw = await mediaProjection(projectRoot, unit.selectedRawSha256, "image");
  } catch (error) {
    issues.push(`raw 不可验证：${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    labeled = await mediaProjection(projectRoot, unit.selectedLabeledSha256, "image");
  } catch (error) {
    issues.push(`labeled 不可验证：${error instanceof Error ? error.message : String(error)}`);
  }
  return {
    status: raw && labeled ? "available" : "invalid",
    productionStatus: unit.productionStatus,
    selectedResultSource: unit.selectedResultSource,
    raw,
    labeled,
    issues,
  };
}

function panelProjection(snapshot: StudioProductionUnitSnapshot): StudioMultimediaTimelineProjection["panels"] {
  return snapshot.panels.map((panel) => ({
    id: panel.id,
    index: panel.index,
    title: panel.title,
    startSeconds: panel.startSeconds,
    endSeconds: panel.endSeconds,
    visualAction: panel.visualAction,
    shotComposition: panel.shotComposition,
    filmingMethod: panel.filmingMethod,
    dialogue: panel.dialogue,
    subtitle: panel.subtitle,
    sourceSurfaces: panel.sourceSpans.map((span) => ({
      startOffsetUtf16: span.startOffsetUtf16,
      endOffsetUtf16: span.endOffsetUtf16,
      sha256: span.surfaceSha256,
      text: snapshot.scriptRevision.body.slice(span.startOffsetUtf16, span.endOffsetUtf16),
    })),
  }));
}

export async function getStudioMultimediaTimelineProjection(
  projectRoot: string,
  input: { unitId: string; unitRevision?: number },
): Promise<StudioMultimediaTimelineProjection | null> {
  const shell = await inspectManagedProject(projectRoot);
  const root = shell.paths.root;
  const unitId = normalizeStableId(input.unitId, "unitId");
  const unitRevision = input.unitRevision === undefined
    ? undefined
    : assertPositiveInteger(input.unitRevision, "unitRevision");
  const snapshot = await readStudioProductionUnitSnapshot(root, unitId, unitRevision);
  if (!snapshot) return null;
  const head = await readStudioProductionUnitSnapshot(root, unitId);
  if (!head) throw new Error(`生产单元 head 不存在：${unitId}`);
  const currentHead = head.unit.revision === snapshot.unit.revision && head.fingerprint === snapshot.fingerprint;
  const db = openReadDatabase(root);
  let rows: TimelineBindingRow[] = [];
  try {
    rows = db ? currentRows(db, unitId, snapshot.unit.revision) : [];
  } finally {
    db?.close();
  }
  const bindings = rows.map(bindingFromRow);
  const tracks: StudioMultimediaTimelineTrackProjection[] = [];
  for (const binding of bindings) {
    if (binding.unitFingerprint !== snapshot.fingerprint) {
      throw new Error(`四媒体时间线绑定 ${binding.recordId} 的 unit fingerprint 已漂移。`);
    }
    const panel = binding.panelIndex === undefined
      ? undefined
      : snapshot.panels.find((entry) => entry.index === binding.panelIndex);
    if ((panel?.id ?? undefined) !== binding.panelId) {
      throw new Error(`四媒体时间线绑定 ${binding.recordId} 的 panel 锚点已漂移。`);
    }
    tracks.push({
      binding,
      media: await mediaProjection(root, binding.mediaSha256, expectedMediaKind(binding.role)),
    });
  }
  const approvedStoryboard = await approvedStoryboardProjection(root, snapshot, currentHead);
  const hasStoryboardTrack = tracks.some((entry) => entry.binding.role === "storyboard");
  const hasVideo = tracks.some((entry) => entry.binding.role === "video");
  const hasAudio = tracks.some((entry) => ["dialogue", "music", "sfx"].includes(entry.binding.role));
  const gaps: StudioMultimediaTimelineProjection["gaps"] = [];
  if (approvedStoryboard.status !== "available") {
    gaps.push({
      code: "approved-storyboard-unavailable",
      media: "storyboard",
      required: true,
      reason: approvedStoryboard.issues.join("；") || `正式故事板状态：${approvedStoryboard.status}`,
    });
  }
  if (!hasVideo) gaps.push({ code: "video-track-missing", media: "video", required: false, reason: "当前 unit revision 未绑定 video 轨。" });
  if (!hasAudio) gaps.push({ code: "audio-track-missing", media: "audio", required: false, reason: "当前 unit revision 未绑定 dialogue/music/sfx 音频轨。" });
  for (const track of tracks) {
    for (const gap of track.media.derivativeGaps) {
      gaps.push({
        code: `${track.binding.slotId}-${gap.kind}-missing`,
        media: track.media.kind === "video" ? "video" : track.media.kind === "audio" ? "audio" : "storyboard",
        required: false,
        reason: gap.reason,
      });
    }
  }
  const panels = panelProjection(snapshot);
  const projectionPayload = {
    schemaVersion: SCHEMA_VERSION,
    kind: "studio-multimedia-timeline-projection" as const,
    unit: {
      id: snapshot.unit.id,
      revision: snapshot.unit.revision,
      fingerprint: snapshot.fingerprint,
      season: snapshot.unit.season,
      episode: snapshot.unit.episode,
      sequence: snapshot.unit.sequence,
      title: snapshot.unit.title,
      durationSeconds: snapshot.unit.durationSeconds,
      episodeStartSeconds: snapshot.unit.episodeStartSeconds,
      episodeEndSeconds: snapshot.unit.episodeEndSeconds,
    },
    script: {
      revisionId: snapshot.scriptRevision.id,
      sha256: snapshot.scriptRevision.bodySha256,
      source: snapshot.scriptRevision.source,
      sourceVersion: snapshot.scriptRevision.sourceVersion,
      body: snapshot.scriptRevision.body,
    },
    panels,
    approvedStoryboard,
    tracks,
    availability: {
      script: "available" as const,
      storyboard: approvedStoryboard.status === "missing" && hasStoryboardTrack
        ? "source-only" as const
        : approvedStoryboard.status,
      video: hasVideo ? "available" as const : "missing" as const,
      audio: hasAudio ? "available" as const : "missing" as const,
    },
    gaps,
  };
  return {
    ...projectionPayload,
    fingerprint: fingerprint(projectionPayload),
    builtAt: new Date().toISOString(),
  };
}
