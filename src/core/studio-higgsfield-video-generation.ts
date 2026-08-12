/**
 * Higgsfield Seedance 2.5（Unlimited-only）视频任务账本。
 *
 * 这里故意不调用 Higgsfield、CLI 或浏览器：应用只冻结已经机械验证的视频包，
 * 把一次性 connector 调用单交给拥有 connector 的 Agent，并把每个状态追加到
 * 既有 studio-generation-ledger.sqlite。没有明确的 Unlimited capability 时永远
 * 不会返回 callAllowed，也绝不降级到 credits/priority 队列。
 */
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { studioSqliteBusyTimeoutMs } from "./studio-sqlite-busy.js";
import {
  HIGGSFIELD_SEEDANCE25_UNLIMITED_PROFILE,
  evaluateHiggsfieldUnlimitedCapability,
  sanitizeHiggsfieldRemoteObservation,
  type HiggsfieldConnectorCapabilityObservation,
} from "./studio-higgsfield-connector-contract.js";
import { initializeStudioGenerationLedger } from "./studio-generation-ledger.js";
import { inspectManagedProjectReadOnly } from "./managed-project.js";
import {
  getStudioVideoPackageControl,
  type StudioVideoPackageControlLookup,
} from "./studio-video-package.js";
import { readStudioVideoPackageSourceClosure } from "./studio-video-package-source-closure.js";
import { getStudioHiggsfieldConnectorRequestByTarget, type StudioHiggsfieldConnectorPublicRequest } from "./studio-higgsfield-connector-queue.js";

const SCHEMA_MARKER = "studio_higgsfield_video_generation_schema_version";
const SCHEMA_VERSION = "1";
const BUSY_TIMEOUT_MS = 5_000;
const SHA256 = /^[a-f0-9]{64}$/u;
const STABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,199}$/u;
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
export {
  HIGGSFIELD_SEEDANCE25_UNLIMITED_PROFILE,
  evaluateHiggsfieldUnlimitedCapability,
  sanitizeHiggsfieldRemoteObservation,
  type HiggsfieldConnectorCapabilityObservation,
} from "./studio-higgsfield-connector-contract.js";

export type StudioHiggsfieldVideoGenerationStatus =
  | "plan_ready"
  | "preflight_blocked"
  | "preflight_ready"
  | "submit_intent"
  | "submission_unknown"
  | "submitted"
  | "waiting_remote"
  | "result_ready"
  | "verified"
  | "committed"
  | "failed"
  | "cancelled";

export interface StudioHiggsfieldVideoRun {
  runId: string;
  intentId: string;
  targetKey: string;
  requestFingerprint: string;
  status: StudioHiggsfieldVideoGenerationStatus;
  revision: number;
  remoteJobId: string | null;
  remoteStatus: string | null;
  adjustments: string[];
  blockers: string[];
  createdAt: string;
  updatedAt: string;
  fingerprint: string;
}

export interface StudioHiggsfieldVideoControl {
  schemaVersion: 1;
  kind: "studio-higgsfield-video-generation-control";
  intentId: string;
  fixedProfile: typeof HIGGSFIELD_SEEDANCE25_UNLIMITED_PROFILE;
  availability: "unavailable" | "ready";
  capabilityTrust: "legacy_untrusted";
  blockers: string[];
  availabilityReason: string;
  run: StudioHiggsfieldVideoRun | null;
  /** 画布仅可创建的本地队列请求；不含 claim、nonce、路径或 connector 凭据。 */
  connectorRequest: StudioHiggsfieldConnectorPublicRequest | null;
  referenceCount: number;
  referencePreviewCount: number;
  readOnly: true;
  fingerprint: string;
}

export interface PrepareStudioHiggsfieldVideoGenerationInput {
  intentId: string;
  expectedVideoPackageControlFingerprint: string;
  /** 仅供可信 connector adapter 注入；公开 command 不接受该字段。 */
  capabilityObservation?: HiggsfieldConnectorCapabilityObservation;
}

export interface PrepareStudioHiggsfieldVideoGenerationResult {
  run: StudioHiggsfieldVideoRun;
  replayed: boolean;
  callAllowed: boolean;
  connectorRequest?: {
    provider: "higgsfield-connector";
    model: "seedance_2_5";
    mode: "omni_reference";
    prompt: string;
    imageReferences: Array<{ order: number; sha256: string; localPath: string }>;
    aspectRatio: string;
    durationSeconds: 20;
    resolution: "720p";
    count: 1;
    generateAudio: true;
    useUnlim: true;
  };
}

export interface RecordStudioHiggsfieldSubmissionInput {
  runId: string;
  expectedRevision: number;
  /** Agent 在 connector 调用后若没有拿到 jobId，必须显式传 null，状态进入 unknown。 */
  remoteJobId: string | null;
  remoteStatus?: string;
  adjustments?: string[];
}

export interface AttestStudioHiggsfieldConnectorCapabilityInput extends HiggsfieldConnectorCapabilityObservation {
  /** Connector 的 balance/models/cost 只读观察摘要；不得包含 URL、cookie、token 或账号。 */
  evidenceFingerprint: string;
}

function digest(value: unknown): string {
  const stable = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(stable);
    if (!entry || typeof entry !== "object") return entry;
    return Object.fromEntries(Object.entries(entry as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b, "en"))
      .map(([key, item]) => [key, stable(item)]));
  };
  return createHash("sha256").update(JSON.stringify(stable(value)), "utf8").digest("hex");
}

function now(): string { return new Date().toISOString(); }

function assertStableId(value: string, field: string): string {
  if (!STABLE_ID.test(value)) throw new Error(`${field} 格式无效。`);
  return value;
}

function assertSha(value: string, field: string): string {
  if (!SHA256.test(value)) throw new Error(`${field} 必须是 SHA-256。`);
  return value;
}

function defaultCapabilityObservation(): HiggsfieldConnectorCapabilityObservation {
  // 当前已核实：connector balance/models 没有同时给出 true/true，且 Seedance
  // 2.5 use_unlim cost 预检被服务端拒绝。这里是唯一安全默认值，不能以 Ultra
  // 计划或网页开关推断为可用。
  return {
    source: "higgsfield-connector",
    observedAt: now(),
    unlimAvailable: false,
    supportsUnlim: false,
    model: "seedance_2_5",
    mode: "omni_reference",
    durationSeconds: 20,
    resolution: "720p",
    adjustments: [],
  };
}

export function projectHiggsfieldTrustedAdapterAvailability(
  _historicalObservation?: HiggsfieldConnectorCapabilityObservation | null,
): {
  availability: "unavailable";
  capabilityTrust: "legacy_untrusted";
  blockers: ["trusted-connector-adapter-unavailable"];
  availabilityReason: string;
} {
  return {
    availability: "unavailable",
    capabilityTrust: "legacy_untrusted",
    blockers: ["trusted-connector-adapter-unavailable"],
    availabilityReason: "历史 capability 为调用方自报，不能证明 Unlimited 或零扣费；受信任 connector 适配器尚未建立。",
  };
}

/** 首次外部调用前的状态裁决；同一指纹只允许从无 run 进入 submit_intent 一次。 */
export function decideHiggsfieldPrepareState(
  existingStatus: StudioHiggsfieldVideoGenerationStatus | null,
  blockers: readonly string[],
): { status: StudioHiggsfieldVideoGenerationStatus; callAllowed: boolean } {
  if (existingStatus !== null) return { status: existingStatus, callAllowed: false };
  if (blockers.length) return { status: "preflight_blocked", callAllowed: false };
  // 这里是调用许可的 durable 边界：不能返回 true 而尚未落账 submit_intent。
  return { status: "submit_intent", callAllowed: true };
}

function dbFor(databasePath: string): DatabaseSync {
  const busyTimeoutMs = studioSqliteBusyTimeoutMs(BUSY_TIMEOUT_MS);
  const db = new DatabaseSync(databasePath, { timeout: busyTimeoutMs });
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=${busyTimeoutMs}; PRAGMA synchronous=NORMAL;`);
  db.exec(`CREATE TABLE IF NOT EXISTS studio_higgsfield_video_generation_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL CHECK(length(request_fingerprint)=64),
    intent_id TEXT NOT NULL,
    target_key TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision >= 1),
    status TEXT NOT NULL CHECK(status IN ('plan_ready','preflight_blocked','preflight_ready','submit_intent','submission_unknown','submitted','waiting_remote','result_ready','verified','committed','failed','cancelled')),
    remote_job_id TEXT,
    remote_status TEXT,
    adjustments_json TEXT NOT NULL,
    blockers_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    fingerprint TEXT NOT NULL UNIQUE CHECK(length(fingerprint)=64),
    UNIQUE(run_id, revision)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS studio_higgsfield_video_generation_target_idx
    ON studio_higgsfield_video_generation_events(target_key, sequence);
  CREATE TRIGGER IF NOT EXISTS studio_higgsfield_video_generation_events_no_update
    BEFORE UPDATE ON studio_higgsfield_video_generation_events BEGIN SELECT RAISE(ABORT, 'higgsfield video events are append-only'); END;
  CREATE TRIGGER IF NOT EXISTS studio_higgsfield_video_generation_events_no_delete
    BEFORE DELETE ON studio_higgsfield_video_generation_events BEGIN SELECT RAISE(ABORT, 'higgsfield video events are append-only'); END;
  CREATE TABLE IF NOT EXISTS studio_higgsfield_connector_capability_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    observed_at TEXT NOT NULL,
    unlim_available INTEGER NOT NULL CHECK(unlim_available IN (0,1)),
    supports_unlim INTEGER NOT NULL CHECK(supports_unlim IN (0,1)),
    model TEXT NOT NULL,
    mode TEXT NOT NULL,
    duration_seconds INTEGER NOT NULL,
    resolution TEXT NOT NULL,
    adjustments_json TEXT NOT NULL,
    evidence_fingerprint TEXT NOT NULL CHECK(length(evidence_fingerprint)=64),
    fingerprint TEXT NOT NULL UNIQUE CHECK(length(fingerprint)=64)
  ) STRICT;
  CREATE TRIGGER IF NOT EXISTS studio_higgsfield_connector_capability_events_no_update
    BEFORE UPDATE ON studio_higgsfield_connector_capability_events BEGIN SELECT RAISE(ABORT, 'higgsfield capability events are append-only'); END;
  CREATE TRIGGER IF NOT EXISTS studio_higgsfield_connector_capability_events_no_delete
    BEFORE DELETE ON studio_higgsfield_connector_capability_events BEGIN SELECT RAISE(ABORT, 'higgsfield capability events are append-only'); END;
  INSERT OR IGNORE INTO studio_generation_ledger_meta(key,value) VALUES('${SCHEMA_MARKER}','${SCHEMA_VERSION}');`);
  const marker = db.prepare("SELECT value FROM studio_generation_ledger_meta WHERE key=?").get(SCHEMA_MARKER) as { value?: string } | undefined;
  if (marker?.value !== SCHEMA_VERSION) throw new Error("Higgsfield 视频账本 schema 不兼容。");
  return db;
}

type Row = {
  run_id: string; request_fingerprint: string; intent_id: string; target_key: string; revision: number;
  status: StudioHiggsfieldVideoGenerationStatus; remote_job_id: string | null; remote_status: string | null;
  adjustments_json: string; blockers_json: string; created_at: string; fingerprint: string;
};

function rowToRun(row: Row, createdAt = row.created_at): StudioHiggsfieldVideoRun {
  const semantic = {
    runId: row.run_id, intentId: row.intent_id, targetKey: row.target_key,
    requestFingerprint: row.request_fingerprint, status: row.status, revision: Number(row.revision),
    remoteJobId: row.remote_job_id, remoteStatus: row.remote_status,
    adjustments: JSON.parse(row.adjustments_json) as string[], blockers: JSON.parse(row.blockers_json) as string[],
    createdAt, updatedAt: row.created_at,
  };
  return { ...semantic, fingerprint: row.fingerprint };
}

function getRun(db: DatabaseSync, runId: string): StudioHiggsfieldVideoRun | null {
  const current = db.prepare(`SELECT * FROM studio_higgsfield_video_generation_events
    WHERE run_id=? ORDER BY revision DESC LIMIT 1`).get(runId) as Row | undefined;
  if (!current) return null;
  const first = db.prepare(`SELECT created_at FROM studio_higgsfield_video_generation_events
    WHERE run_id=? ORDER BY revision ASC LIMIT 1`).get(runId) as { created_at: string };
  return rowToRun(current, first.created_at);
}

export function isHiggsfieldVideoRunTerminalForNewAttempt(status: StudioHiggsfieldVideoGenerationStatus): boolean {
  // blocked 不是远端任务，且其 request fingerprint 包含 capability observation；
  // connector 以后真开放 Unlimited 时允许以新观察重新预检，而不是永久占 target。
  return ["preflight_blocked", "committed", "failed", "cancelled"].includes(status);
}

export function decideHiggsfieldSubmissionOutcome(input: {
  remoteJobId: string | null;
  adjustments: readonly string[];
}): { status: "submitted" | "submission_unknown"; blockers: string[] } {
  if (!input.remoteJobId) return { status: "submission_unknown", blockers: ["remote-job-id-missing-reconcile-required"] };
  if (input.adjustments.length) {
    // 提供方一旦改写 mode/duration/resolution/queue，原固定 profile 不再成立；保留
    // jobId 仅供人工核对，绝不把它推进 waiting/result/commit。
    return { status: "submission_unknown", blockers: ["provider-adjustments-reconcile-required"] };
  }
  return { status: "submitted", blockers: [] };
}

function latestCapability(db: DatabaseSync): HiggsfieldConnectorCapabilityObservation | null {
  const row = db.prepare(`SELECT observed_at,unlim_available,supports_unlim,model,mode,duration_seconds,resolution,adjustments_json,evidence_fingerprint
    FROM studio_higgsfield_connector_capability_events ORDER BY sequence DESC LIMIT 1`).get() as {
      observed_at: string; unlim_available: number; supports_unlim: number; model: string; mode: string;
      duration_seconds: number; resolution: string; adjustments_json: string; evidence_fingerprint: string;
    } | undefined;
  if (!row) return null;
  return {
    source: "higgsfield-connector", observedAt: row.observed_at,
    unlimAvailable: row.unlim_available === 1, supportsUnlim: row.supports_unlim === 1,
    model: row.model, mode: row.mode, durationSeconds: row.duration_seconds,
    resolution: row.resolution, adjustments: JSON.parse(row.adjustments_json) as string[], evidenceFingerprint: row.evidence_fingerprint,
  };
}

function openReadOnlyExistingDb(databasePath: string): DatabaseSync {
  const busyTimeoutMs = studioSqliteBusyTimeoutMs(BUSY_TIMEOUT_MS);
  const db = new DatabaseSync(databasePath, { timeout: busyTimeoutMs, readOnly: true });
  db.exec(`PRAGMA query_only=ON; PRAGMA busy_timeout=${busyTimeoutMs};`);
  return db;
}

/** 仅供可信 Codex connector adapter 通过 Codex-only command 持久化只读观察。 */
export async function attestStudioHiggsfieldConnectorCapability(
  projectRoot: string,
  input: AttestStudioHiggsfieldConnectorCapabilityInput,
): Promise<HiggsfieldConnectorCapabilityObservation> {
  assertSha(input.evidenceFingerprint, "evidenceFingerprint");
  const checked = evaluateHiggsfieldUnlimitedCapability(input);
  // 不要求 true；当前真实状态正是 false。只校验形状并确保没有秘密可落账。
  if (input.source !== "higgsfield-connector" || !input.observedAt || !Number.isInteger(input.durationSeconds)
    || input.adjustments.some((entry) => /(?:https?:\/\/|token|cookie|secret|bearer)/iu.test(entry))) {
    throw new Error("connector capability observation 无效或含敏感数据。");
  }
  const generation = await initializeStudioGenerationLedger(projectRoot);
  const db = dbFor(generation.databasePath);
  try {
    const fingerprint = digest({ ...input, adjustments: [...input.adjustments], gate: checked });
    db.prepare(`INSERT OR IGNORE INTO studio_higgsfield_connector_capability_events(
      observed_at,unlim_available,supports_unlim,model,mode,duration_seconds,resolution,adjustments_json,evidence_fingerprint,fingerprint
    ) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
      input.observedAt, input.unlimAvailable ? 1 : 0, input.supportsUnlim ? 1 : 0,
      input.model, input.mode, input.durationSeconds, input.resolution, JSON.stringify([...input.adjustments]),
      input.evidenceFingerprint, fingerprint,
    );
    return latestCapability(db)!;
  } finally { db.close(); }
}

function append(db: DatabaseSync, run: Omit<StudioHiggsfieldVideoRun, "revision" | "updatedAt" | "fingerprint"> & {
  status: StudioHiggsfieldVideoGenerationStatus; revision: number; updatedAt: string;
}): StudioHiggsfieldVideoRun {
  const semantic = {
    runId: run.runId, requestFingerprint: run.requestFingerprint, intentId: run.intentId,
    targetKey: run.targetKey, revision: run.revision, status: run.status,
    remoteJobId: run.remoteJobId, remoteStatus: run.remoteStatus,
    adjustments: run.adjustments, blockers: run.blockers, createdAt: run.updatedAt,
  };
  const fingerprint = digest(semantic);
  db.prepare(`INSERT INTO studio_higgsfield_video_generation_events(
    run_id,request_fingerprint,intent_id,target_key,revision,status,remote_job_id,remote_status,
    adjustments_json,blockers_json,created_at,fingerprint
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    run.runId, run.requestFingerprint, run.intentId, run.targetKey, run.revision, run.status,
    run.remoteJobId, run.remoteStatus, JSON.stringify(run.adjustments), JSON.stringify(run.blockers), run.updatedAt, fingerprint,
  );
  return { ...run, updatedAt: run.updatedAt, fingerprint };
}

async function verifiedIntent(projectRoot: string, intentId: string, expectedFingerprint?: string): Promise<StudioVideoPackageControlLookup> {
  const lookup = await getStudioVideoPackageControl(projectRoot, { by: "intent", intentId });
  if (expectedFingerprint && lookup.fingerprint !== assertSha(expectedFingerprint, "expectedVideoPackageControlFingerprint")) {
    throw new Error("视频包控制面已变化，请重新读取后再准备 Higgsfield 调用单。");
  }
  if (lookup.status !== "resolved" || lookup.control?.status !== "mechanically-verified"
    || lookup.control.receipt?.mechanicalStatus !== "verified"
    || !lookup.control.intent.sourceClosureFingerprint) {
    throw new Error("Higgsfield 视频生成只接受已机械验证且带 source closure 的视频包。");
  }
  return lookup;
}

export function compileStudioHiggsfieldConnectorPrompt(value: Buffer): string {
  let parsed: unknown;
  try { parsed = JSON.parse(value.toString("utf8")); } catch { return value.toString("utf8").trim(); }
  if (!parsed || typeof parsed !== "object") throw new Error("视频包 source-spec 未提供可用提示词。");
  const record = parsed as Record<string, unknown>;
  for (const key of ["video_prompt", "videoPrompt", "prompt", "prompt_text"]) {
    if (typeof record[key] === "string" && record[key].trim()) return record[key].trim();
  }
  if (Array.isArray(record.panels)) {
    const panels = record.panels.map((entry, index) => {
      if (!entry || typeof entry !== "object") throw new Error("视频包 panels 含无效项。");
      const panel = entry as Record<string, unknown>;
      const prompt = panel.positivePrompt;
      if (typeof prompt !== "string" || !prompt.trim()) throw new Error(`视频包 panels[${index}] 缺少 positivePrompt。`);
      const order = typeof panel.order === "number" ? panel.order : index + 1;
      const timecode = panel.timecode && typeof panel.timecode === "object" && !Array.isArray(panel.timecode)
        ? panel.timecode as Record<string, unknown>
        : {};
      const start = panel.startSeconds ?? panel.start_seconds ?? timecode.unitStartSeconds ?? "?";
      const end = panel.endSeconds ?? panel.end_seconds ?? timecode.unitEndSeconds ?? "?";
      return { order, text: `【${start}–${end}s】${prompt.trim()}` };
    }).sort((a, b) => a.order - b.order);
    if (panels.length) return `${panels.map((panel) => panel.text).join("\n")}\n【15–20s】保持第15秒末态，不新增叙事事件。`;
  }
  throw new Error("视频包 source-spec 未提供 video_prompt/prompt。 ");
}

function getAspect(value: Buffer): string {
  try {
    const record = JSON.parse(value.toString("utf8")) as Record<string, unknown>;
    const candidate = record.aspect_ratio ?? record.aspectRatio;
    return typeof candidate === "string" && ["auto", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"].includes(candidate) ? candidate : "16:9";
  } catch { return "16:9"; }
}

/**
 * 仅在 authorize 已一次性落账后由 Command Bus 调用，组装受控的 Connector 输入。
 * 该函数不写账本、不调用外部服务；绝对路径随后只允许首次 Codex MCP 响应投影。
 */
export async function buildStudioHiggsfieldVideoConnectorRequest(projectRoot: string, intentIdValue: string): Promise<NonNullable<PrepareStudioHiggsfieldVideoGenerationResult["connectorRequest"]>> {
  const intentId = assertStableId(intentIdValue, "intentId");
  const lookup = await getStudioVideoPackageControl(projectRoot, { by: "intent", intentId });
  const control = lookup.status === "resolved" ? lookup.control : null;
  if (!control || control.status !== "mechanically-verified" || !control.intent.sourceClosureFingerprint) {
    throw new Error("Higgsfield 视频请求必须绑定已机械验证且带 source closure 的视频包。 ");
  }
  const closure = await readStudioVideoPackageSourceClosure(projectRoot, control.intent.sourceClosureFingerprint);
  const sourceSpec = closure.files.find((file) => file.role === "source-spec");
  const references = closure.files.filter((file) => IMAGE_EXTENSIONS.has(path.extname(file.logicalPath).toLowerCase()));
  if (!sourceSpec || !references.length || references.length > 30) throw new Error("已验证视频包缺少合法的 1–30 张图片参考或 source-spec。 ");
  return {
    provider: "higgsfield-connector", model: "seedance_2_5", mode: "omni_reference",
    prompt: compileStudioHiggsfieldConnectorPrompt(sourceSpec.bytes),
    imageReferences: references.map((file, index) => ({ order: index + 1, sha256: file.sha256, localPath: file.absolutePath })),
    aspectRatio: getAspect(sourceSpec.bytes), durationSeconds: 20, resolution: "720p", count: 1, generateAudio: true, useUnlim: true,
  };
}

export async function prepareStudioHiggsfieldVideoGeneration(
  projectRoot: string,
  input: PrepareStudioHiggsfieldVideoGenerationInput,
): Promise<PrepareStudioHiggsfieldVideoGenerationResult> {
  const intentId = assertStableId(input.intentId, "intentId");
  const lookup = await verifiedIntent(projectRoot, intentId, input.expectedVideoPackageControlFingerprint);
  const closure = await readStudioVideoPackageSourceClosure(projectRoot, lookup.control!.intent.sourceClosureFingerprint!);
  const sourceSpec = closure.files.find((file) => file.role === "source-spec");
  const references = closure.files.filter((file) => IMAGE_EXTENSIONS.has(path.extname(file.logicalPath).toLowerCase()));
  if (!sourceSpec || !references.length || references.length > 30) throw new Error("已验证视频包缺少合法的 1–30 张图片参考或 source-spec。");
  // 必须在任何 ledger 写入前把 managed source-spec 编译为 connector request；
  // malformed panels 只能零 append 失败，不能留下孤立 submit_intent。
  const prompt = compileStudioHiggsfieldConnectorPrompt(sourceSpec.bytes);
  const aspectRatio = getAspect(sourceSpec.bytes);
  const targetKey = `${lookup.control!.intent.unitId}@${lookup.control!.intent.unitRevision}`;
  const generation = await initializeStudioGenerationLedger(projectRoot);
  const db = dbFor(generation.databasePath);
  try {
    db.exec("BEGIN IMMEDIATE");
    // 公共 capability attestation 只用于控制面诊断，不能授权外部调用。
    // 真正的许可必须走 connector queue 的 request-bound direct observation。
    const observation = input.capabilityObservation ?? defaultCapabilityObservation();
    const blockers = evaluateHiggsfieldUnlimitedCapability(observation).blockers;
    const requestFingerprint = digest({ profile: HIGGSFIELD_SEEDANCE25_UNLIMITED_PROFILE, intentId, sourceClosure: closure.closure.fingerprint, observation: {
      unlimAvailable: observation.unlimAvailable, supportsUnlim: observation.supportsUnlim, model: observation.model,
      mode: observation.mode, durationSeconds: observation.durationSeconds, resolution: observation.resolution, adjustments: [...observation.adjustments],
      observedAt: observation.observedAt, evidenceFingerprint: observation.evidenceFingerprint ?? null,
    } });
    const matching = db.prepare(`SELECT * FROM studio_higgsfield_video_generation_events
      WHERE request_fingerprint=? ORDER BY revision DESC LIMIT 1`).get(requestFingerprint) as Row | undefined;
    if (matching) {
      const run = getRun(db, matching.run_id)!;
      db.exec("COMMIT");
      return { run, replayed: true, callAllowed: false };
    }
    const active = db.prepare(`SELECT DISTINCT run_id FROM studio_higgsfield_video_generation_events
      WHERE target_key=? AND run_id IN (SELECT run_id FROM studio_higgsfield_video_generation_events
        GROUP BY run_id HAVING MAX(revision))`).all(targetKey) as Array<{ run_id: string }>;
    for (const row of active) {
      const run = getRun(db, row.run_id)!;
      if (!isHiggsfieldVideoRunTerminalForNewAttempt(run.status)) {
        db.exec("COMMIT");
        return { run, replayed: true, callAllowed: false };
      }
    }
    const timestamp = now();
    const runId = `higgsfield-video-${requestFingerprint.slice(0, 40)}`;
    const decision = decideHiggsfieldPrepareState(null, blockers);
    const run = append(db, {
      runId, intentId, targetKey, requestFingerprint, status: decision.status, revision: 1,
      remoteJobId: null, remoteStatus: null, adjustments: [], blockers, createdAt: timestamp, updatedAt: timestamp,
    });
    db.exec("COMMIT");
    if (!decision.callAllowed) return { run, replayed: false, callAllowed: false };
    const connectorRequest = {
      provider: "higgsfield-connector" as const, model: "seedance_2_5" as const, mode: "omni_reference" as const,
      prompt,
      imageReferences: references.map((file, index) => ({ order: index + 1, sha256: file.sha256, localPath: file.absolutePath })),
      aspectRatio, durationSeconds: 20 as const, resolution: "720p" as const,
      count: 1 as const, generateAudio: true as const, useUnlim: true as const,
    };
    return { run, replayed: false, callAllowed: true, connectorRequest };
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* no transaction */ }
    throw error;
  } finally { db.close(); }
}

export async function recordStudioHiggsfieldSubmission(
  projectRoot: string,
  input: RecordStudioHiggsfieldSubmissionInput,
): Promise<StudioHiggsfieldVideoRun> {
  const generation = await initializeStudioGenerationLedger(projectRoot);
  const db = dbFor(generation.databasePath);
  try {
    db.exec("BEGIN IMMEDIATE");
    const current = getRun(db, assertStableId(input.runId, "runId"));
    if (!current) throw new Error("Higgsfield 视频 run 不存在。");
    if (current.revision !== input.expectedRevision) throw new Error("Higgsfield 视频 run revision 已变化。");
    if (current.status !== "submit_intent") throw new Error("只有已持久化的 submit_intent 可以登记远端提交结果。");
    // 先持久化 submit_intent；若 Agent 调用 connector 后未得到 jobId，第二条事件
    // 固定为 submission_unknown，恢复时不得创建新 attempt。
    const intent = current;
    const adjustments = [...(input.adjustments ?? [])].map((entry) => entry.slice(0, 300));
    const outcome = decideHiggsfieldSubmissionOutcome({ remoteJobId: input.remoteJobId, adjustments });
    const next = append(db, {
      ...intent,
      status: outcome.status,
      revision: intent.revision + 1,
      remoteJobId: input.remoteJobId ? assertStableId(input.remoteJobId, "remoteJobId") : null,
      remoteStatus: sanitizeHiggsfieldRemoteObservation(input.remoteStatus),
      adjustments: adjustments.map((entry) => sanitizeHiggsfieldRemoteObservation(entry) ?? "[redacted-observation]"),
      blockers: outcome.blockers,
      updatedAt: now(),
    });
    db.exec("COMMIT");
    return next;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* no transaction */ }
    throw error;
  } finally { db.close(); }
}

export async function getStudioHiggsfieldVideoGenerationControl(
  projectRoot: string,
  intentIdValue: string,
): Promise<StudioHiggsfieldVideoControl> {
  const intentId = assertStableId(intentIdValue, "intentId");
  const lookup = await getStudioVideoPackageControl(projectRoot, { by: "intent", intentId });
  let references = 0;
  if (lookup.status === "resolved" && lookup.control?.intent.sourceClosureFingerprint) {
    const closure = await readStudioVideoPackageSourceClosure(projectRoot, lookup.control.intent.sourceClosureFingerprint, { roles: ["raw", "labeled"] });
    references = closure.files.filter((file) => IMAGE_EXTENSIONS.has(path.extname(file.logicalPath).toLowerCase())).length;
  }
  const shell = await inspectManagedProjectReadOnly(projectRoot);
  const db = openReadOnlyExistingDb(shell.paths.generationDatabase);
  let run: StudioHiggsfieldVideoRun | null = null;
  try {
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='studio_higgsfield_video_generation_events'").get();
    if (table) {
      const row = db.prepare(`SELECT run_id FROM studio_higgsfield_video_generation_events
        WHERE intent_id=? ORDER BY sequence DESC LIMIT 1`).get(intentId) as { run_id?: string } | undefined;
      run = row?.run_id ? getRun(db, row.run_id) : null;
    }
  } finally { db.close(); }
  const trustedAdapter = projectHiggsfieldTrustedAdapterAvailability();
  const connectorRequest = await getStudioHiggsfieldConnectorRequestByTarget(projectRoot, { kind: "video", intentId });
  const semantic = {
    schemaVersion: 1 as const, kind: "studio-higgsfield-video-generation-control" as const, intentId,
    fixedProfile: HIGGSFIELD_SEEDANCE25_UNLIMITED_PROFILE,
    ...trustedAdapter,
    run, connectorRequest, referenceCount: references, referencePreviewCount: Math.min(references, 6), readOnly: true as const,
  };
  return { ...semantic, fingerprint: digest(semantic) };
}
