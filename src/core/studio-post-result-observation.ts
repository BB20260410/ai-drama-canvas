/**
 * PASS 审片结果的实际末态观察账本。
 *
 * 这里记录的是人工从当前 PASS raw/labeled 中观察到的实际画面末态，不是冻结包
 * 中的计划终态。模块复用 studio-generation-ledger.sqlite，只追加内容寻址事件与
 * operation receipt；唯一可变投影是带 CAS 的 head。
 */
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { studioSqliteBusyTimeoutMs } from "./studio-sqlite-busy.js";
import { digestStudioCanonicalJson as digest } from "./studio-canonical-json.js";
import { inspectManagedProject, inspectManagedProjectReadOnly } from "./managed-project.js";
import {
  assertSafeSqliteSidecars,
  assertSqliteSourceBindingIdentity,
  openSqliteReadOnlySnapshot,
  type SqliteReadOnlySnapshot,
  type SqliteSourceBindingIdentity,
} from "./sqlite-readonly-snapshot.js";
import { assertSqliteSchemaContract } from "./sqlite-schema-contract.js";
import {
  buildNextShotContinuitySnapshot,
  nextShotContinuityContinuationGaps,
  type NextShotContinuitySnapshot,
} from "./studio-next-shot-continuity.js";
import {
  initializeStudioGenerationLedger,
  readStudioGenerationFrozenPack,
  readStudioGenerationResult,
  readStudioUnitGridGenerationFrozenPack,
  type StudioGenerationResultRecord,
} from "./studio-generation-ledger.js";
import {
  getStudioGenerationReviewControl,
  type StudioGenerationReviewProjection,
} from "./studio-generation-review.js";
import { probeStudioReviewedVideoEvidence } from "./studio-media-evidence-probe.js";
import type { StudioSeedanceObservedState } from "./studio-seedance-prompt-compiler.js";
import { withStudioGenerationLedgerReadOnlySnapshot } from "./studio-generation-ledger-storage.js";

const DATABASE_RELATIVE_PATH = ".aicanvas/studio-generation-ledger.sqlite";
const SCHEMA_VERSION = 1;
const BUSY_TIMEOUT_MS = 5_000;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/u;
const MAX_JSON_BYTES = 512 * 1024;

let afterProjectionBeforeFinalReviewHookForTests:
  | (() => Promise<void> | void)
  | undefined;

export function __setStudioPostResultObservationFinalReviewHookForTests(
  hook: (() => Promise<void> | void) | null,
): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("末态观察测试 hook 只能在 NODE_ENV=test 下设置。");
  }
  afterProjectionBeforeFinalReviewHookForTests = hook ?? undefined;
}

const OBSERVED_STATE_FIELDS = [
  "costume",
  "injury",
  "heldObject",
  "position",
  "facing",
  "emotion",
  "layout",
  "lighting",
  "referenceSha256",
  "motionVector",
  "cameraPhase",
  "focusState",
  "audioPhase",
] as const satisfies readonly (keyof StudioSeedanceObservedState)[];

const OBSERVATION_AVAILABILITY_FIELDS = [
  "costume",
  "injury",
  "heldObject",
  "position",
  "facing",
  "emotion",
  "layout",
  "lighting",
  "motionVector",
  "cameraPhase",
  "focusState",
  "audioPhase",
] as const satisfies readonly Exclude<keyof StudioSeedanceObservedState, "referenceSha256">[];

const LEGACY_V2_OBSERVATION_AVAILABILITY_FIELDS = [
  "motionVector",
  "cameraPhase",
  "audioPhase",
] as const;

export type StudioPostResultEvidenceKind =
  | "terminal-panel-crop"
  | "reviewed-video"
  | "accepted-last-frame";

export type StudioPostResultObservationAvailability =
  | "observed"
  | "unknown"
  | "not-applicable";

export type StudioPostResultObservedAvailability = Record<
  typeof OBSERVATION_AVAILABILITY_FIELDS[number],
  StudioPostResultObservationAvailability
>;

interface StudioPostResultEvidence {
  kind: StudioPostResultEvidenceKind;
  sha256: string;
  terminalPanelId?: string;
}

export interface StudioPostResultEvidenceLineage {
  kind: "studio-video-package-terminal-crop";
  intentId: string;
  intentFingerprint: string;
  receiptId: string;
  receiptFingerprint: string;
  manifestSha256: string;
  manifestFingerprint: string;
  filePath: string;
  fileSha256: string;
}

export type StudioPostResultObservedActualState =
  Pick<StudioSeedanceObservedState, "referenceSha256">
  & Partial<Omit<StudioSeedanceObservedState, "referenceSha256">>;

export type StudioPostResultObservationErrorCode =
  | "unmanaged-project"
  | "invalid-input"
  | "storage-invalid"
  | "review-ineligible"
  | "review-drift"
  | "observation-conflict"
  | "operation-conflict";

export class StudioPostResultObservationError extends Error {
  readonly code: StudioPostResultObservationErrorCode;
  readonly details: string[];

  constructor(
    code: StudioPostResultObservationErrorCode,
    message: string,
    details: string[] = [],
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "StudioPostResultObservationError";
    this.code = code;
    this.details = details;
  }
}

export interface SubmitStudioPostResultObservationInput {
  /** 业务事务内幂等键；同键异载荷必须拒绝。 */
  operationId: string;
  generationRunId: string;
  expectedHeadRevision: number;
  expectedReviewId: string;
  expectedReviewFingerprint: string;
  rawResultId: string;
  rawSha256: string;
  labeledResultId: string;
  labeledSha256: string;
  packId: string;
  packFingerprint: string;
  /** 冻结包中的计划连续性指纹，仅用于绑定来源，绝不当作 observed state。 */
  plannedContinuityFingerprint: string;
  /**
   * 实际末态的直接视觉证据。rawSha256 只绑定通过审片的整张结果，不是尾帧证据。
   */
  evidenceKind: StudioPostResultEvidenceKind;
  evidenceSha256: string;
  terminalPanelId?: string;
  /** 人工从已 PASS 结果中显式观察的实际末态。 */
  observedState: StudioSeedanceObservedState;
  /**
   * 动态字段必须逐项声明是否真的从证据中可见。unknown/not-applicable
   * 不能被下游当作已观测事实。
   */
  observedAvailability: StudioPostResultObservedAvailability;
  /**
   * P3 收编：结构化 per-entity 实际末态快照（逐角色/道具/场景轴线/VFX）。
   * 可选、向后兼容；提供时 sourceRawSha256 必须等于本次 rawSha256，
   * continuityFingerprint 经确定性重建比对（防伪造），随语义体进内容寻址指纹。
   */
  continuitySnapshot?: NextShotContinuitySnapshot;
  observer: string;
  note: string;
}

export interface StudioPostResultObservationRecord {
  sequence: number;
  observationId: string;
  generationRunId: string;
  baseHeadRevision: number;
  headRevision: number;
  reviewId: string;
  reviewFingerprint: string;
  rawResultId: string;
  rawSha256: string;
  labeledResultId: string;
  labeledSha256: string;
  packId: string;
  packFingerprint: string;
  plannedContinuityFingerprint: string;
  evidenceContractVersion: 1 | 2 | 3 | 4;
  evidenceKind?: StudioPostResultEvidenceKind;
  evidenceSha256?: string;
  terminalPanelId?: string;
  evidenceLineage?: StudioPostResultEvidenceLineage;
  continuitySnapshot?: NextShotContinuitySnapshot;
  observedState: StudioSeedanceObservedState;
  observedAvailability: StudioPostResultObservedAvailability;
  observer: string;
  note: string;
  fingerprint: string;
  createdAt: string;
}

export type StudioPostResultObservationProjection = Omit<
  StudioPostResultObservationRecord,
  "observedState"
> & {
  observedState: StudioPostResultObservedActualState;
  head: boolean;
  current: boolean;
  continuationEligible: boolean;
  currentStaleReasons: string[];
  continuationIneligibleReasons: string[];
};

export interface StudioPostResultObservationControl {
  schemaVersion: 1;
  kind: "studio-post-result-observation-control";
  generationRunId: string;
  headRevision: number;
  head?: StudioPostResultObservationProjection;
  status: "missing" | "current" | "stale";
  blockers: string[];
  nextAction:
    | "wait-for-current-pass-review"
    | "submit-observed-end-state"
    | "use-observed-end-state"
    | "reobserve-current-pass-result";
  fingerprint: string;
}

interface ObservationRow {
  sequence: number;
  observation_id: string;
  generation_run_id: string;
  base_head_revision: number;
  head_revision: number;
  review_id: string;
  review_fingerprint: string;
  raw_result_id: string;
  raw_sha256: string;
  labeled_result_id: string;
  labeled_sha256: string;
  pack_id: string;
  pack_fingerprint: string;
  planned_continuity_fingerprint: string;
  observed_state_json: string;
  observer: string;
  note: string;
  fingerprint: string;
  created_at: string;
}

interface HeadRow {
  generation_run_id: string;
  revision: number;
  observation_id: string;
  observation_fingerprint: string;
  updated_at: string;
}

interface OperationRow {
  operation_id: string;
  input_fingerprint: string;
  observation_id: string;
  outcome_fingerprint: string;
  created_at: string;
}

interface DatabaseContext {
  databasePath: string;
  readonly sourceIdentity: SqliteSourceBindingIdentity;
}

function fail(
  code: StudioPostResultObservationErrorCode,
  message: string,
  details: string[] = [],
): never {
  throw new StudioPostResultObservationError(code, message, details);
}

function requiredText(value: unknown, label: string, maximum = 8_000): string {
  if (typeof value !== "string") fail("invalid-input", `${label} 必须是字符串。`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) {
    fail("invalid-input", `${label} 必须是 1-${maximum} 个字符。`);
  }
  return normalized;
}

function isCanonicalIsoTimestamp(value: string): boolean {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function normalizedId(value: unknown, label: string): string {
  const normalized = requiredText(value, label, 255);
  if (!ID_PATTERN.test(normalized)) fail("invalid-input", `${label} 不是稳定 ID。`);
  return normalized;
}

function normalizedSha(value: unknown, label: string): string {
  const normalized = requiredText(value, label, 64);
  if (!SHA256_PATTERN.test(normalized)) fail("invalid-input", `${label} 必须是 64 位小写 SHA-256。`);
  return normalized;
}

function normalizedEvidence(
  kindValue: unknown,
  shaValue: unknown,
  terminalPanelIdValue: unknown,
  rawSha256: string,
): StudioPostResultEvidence {
  if (kindValue !== "terminal-panel-crop"
    && kindValue !== "reviewed-video"
    && kindValue !== "accepted-last-frame") {
    fail("invalid-input", "evidenceKind 必须是 terminal-panel-crop、reviewed-video 或 accepted-last-frame。");
  }
  const kind = kindValue;
  const sha256 = normalizedSha(shaValue, "evidenceSha256");
  if (sha256 === rawSha256) {
    fail("invalid-input", "evidenceSha256 不能等于整张宫格 rawSha256；必须提交真实末格/视频/尾帧证据。");
  }
  if (kind === "terminal-panel-crop") {
    return {
      kind,
      sha256,
      terminalPanelId: normalizedId(terminalPanelIdValue, "terminalPanelId"),
    };
  }
  if (terminalPanelIdValue !== undefined) {
    fail("invalid-input", `${kind} 证据不得声明 terminalPanelId。`);
  }
  return { kind, sha256 };
}

function normalizedEvidenceLineage(
  value: unknown,
  evidenceSha256: string,
): StudioPostResultEvidenceLineage {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid-input", "terminal-panel-crop evidence lineage 必须是完整对象。");
  }
  const source = value as Record<string, unknown>;
  const expectedKeys = [
    "filePath",
    "fileSha256",
    "intentFingerprint",
    "intentId",
    "kind",
    "manifestFingerprint",
    "manifestSha256",
    "receiptFingerprint",
    "receiptId",
  ];
  const actualKeys = Object.keys(source).sort((left, right) => left.localeCompare(right, "en"));
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    fail("invalid-input", "terminal-panel-crop evidence lineage 字段已漂移。", [
      `expected=${expectedKeys.join(",")}`,
      `actual=${actualKeys.join(",")}`,
    ]);
  }
  if (source.kind !== "studio-video-package-terminal-crop") {
    fail("invalid-input", "terminal-panel-crop evidence lineage kind 无效。");
  }
  const filePath = requiredText(source.filePath, "evidenceLineage.filePath", 512);
  if (path.basename(filePath) !== filePath) {
    fail("invalid-input", "evidenceLineage.filePath 必须是视频包内的单层文件名。");
  }
  const fileSha256 = normalizedSha(source.fileSha256, "evidenceLineage.fileSha256");
  if (fileSha256 !== evidenceSha256) {
    fail("invalid-input", "evidenceLineage.fileSha256 必须等于 evidenceSha256。");
  }
  return {
    kind: "studio-video-package-terminal-crop",
    intentId: normalizedId(source.intentId, "evidenceLineage.intentId"),
    intentFingerprint: normalizedSha(source.intentFingerprint, "evidenceLineage.intentFingerprint"),
    receiptId: normalizedId(source.receiptId, "evidenceLineage.receiptId"),
    receiptFingerprint: normalizedSha(source.receiptFingerprint, "evidenceLineage.receiptFingerprint"),
    manifestSha256: normalizedSha(source.manifestSha256, "evidenceLineage.manifestSha256"),
    manifestFingerprint: normalizedSha(source.manifestFingerprint, "evidenceLineage.manifestFingerprint"),
    filePath,
    fileSha256,
  };
}

function normalizedAvailabilityForFields<TField extends string>(
  value: unknown,
  fields: readonly TField[],
  message: string,
): Record<TField, StudioPostResultObservationAvailability> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid-input", "observedAvailability 必须是完整对象。");
  }
  const source = value as Record<string, unknown>;
  const actualKeys = Object.keys(source).sort((left, right) => left.localeCompare(right, "en"));
  const expectedKeys = [...fields]
    .sort((left, right) => left.localeCompare(right, "en"));
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    fail("invalid-input", message, [
      `expected=${expectedKeys.join(",")}`,
      `actual=${actualKeys.join(",")}`,
    ]);
  }
  return Object.fromEntries(fields.map((field) => {
    const availability = source[field];
    if (availability !== "observed"
      && availability !== "unknown"
      && availability !== "not-applicable") {
      fail("invalid-input", `observedAvailability.${field} 必须是 observed、unknown 或 not-applicable。`);
    }
    return [field, availability];
  })) as Record<TField, StudioPostResultObservationAvailability>;
}

function normalizedObservedAvailability(value: unknown): StudioPostResultObservedAvailability {
  return normalizedAvailabilityForFields(
    value,
    OBSERVATION_AVAILABILITY_FIELDS,
    "observedAvailability 必须且只能逐项声明全部实际末态字段的可观测性。",
  );
}

type LegacyV2ObservedAvailability = Record<
  typeof LEGACY_V2_OBSERVATION_AVAILABILITY_FIELDS[number],
  StudioPostResultObservationAvailability
>;

function normalizedLegacyV2ObservedAvailability(value: unknown): LegacyV2ObservedAvailability {
  return normalizedAvailabilityForFields(
    value,
    LEGACY_V2_OBSERVATION_AVAILABILITY_FIELDS,
    "实际末态 v2 observedAvailability 字段已漂移。",
  );
}

function unknownObservedAvailability(): StudioPostResultObservedAvailability {
  return Object.fromEntries(
    OBSERVATION_AVAILABILITY_FIELDS.map((field) => [field, "unknown"]),
  ) as StudioPostResultObservedAvailability;
}

function assertEvidenceAvailability(
  evidenceKind: StudioPostResultEvidenceKind,
  availability: StudioPostResultObservedAvailability,
): void {
  if (evidenceKind !== "terminal-panel-crop"
    && evidenceKind !== "accepted-last-frame") return;
  const unsupported = LEGACY_V2_OBSERVATION_AVAILABILITY_FIELDS
    .filter((field) => availability[field] === "observed");
  if (unsupported.length > 0) {
    fail(
      "invalid-input",
      `${evidenceKind} 是静态图片，不能把运动、相机或音频状态声明为 observed。`,
      unsupported.map((field) => `observedAvailability.${field}=observed`),
    );
  }
}

function normalizedObservedState(value: unknown, evidenceSha256: string): StudioSeedanceObservedState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid-input", "observedState 必须是完整对象。");
  }
  const actualKeys = Object.keys(value as Record<string, unknown>).sort((left, right) => left.localeCompare(right, "en"));
  const expectedKeys = [...OBSERVED_STATE_FIELDS].sort((left, right) => left.localeCompare(right, "en"));
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    fail("invalid-input", "observedState 必须且只能包含完整实际末态字段。", [
      `expected=${expectedKeys.join(",")}`,
      `actual=${actualKeys.join(",")}`,
    ]);
  }
  const source = value as Record<string, unknown>;
  const state = {
    costume: requiredText(source.costume, "observedState.costume", 2_000),
    injury: requiredText(source.injury, "observedState.injury", 2_000),
    heldObject: requiredText(source.heldObject, "observedState.heldObject", 2_000),
    position: requiredText(source.position, "observedState.position", 2_000),
    facing: requiredText(source.facing, "observedState.facing", 2_000),
    emotion: requiredText(source.emotion, "observedState.emotion", 2_000),
    layout: requiredText(source.layout, "observedState.layout", 2_000),
    lighting: requiredText(source.lighting, "observedState.lighting", 2_000),
    referenceSha256: normalizedSha(source.referenceSha256, "observedState.referenceSha256"),
    motionVector: requiredText(source.motionVector, "observedState.motionVector", 2_000),
    cameraPhase: requiredText(source.cameraPhase, "observedState.cameraPhase", 2_000),
    focusState: requiredText(source.focusState, "observedState.focusState", 2_000),
    audioPhase: requiredText(source.audioPhase, "observedState.audioPhase", 2_000),
  };
  if (state.referenceSha256 !== evidenceSha256) {
    fail("invalid-input", "observedState.referenceSha256 必须绑定显式 evidenceSha256，不能绑定整张宫格 raw。");
  }
  if (Buffer.byteLength(JSON.stringify(state), "utf8") > MAX_JSON_BYTES) {
    fail("invalid-input", `observedState 超过 ${MAX_JSON_BYTES} 字节。`);
  }
  return state;
}

function exactObject(
  value: unknown,
  expectedKeys: readonly string[],
  requiredKeys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid-input", `${label} 必须是对象。`);
  }
  const source = value as Record<string, unknown>;
  const actualKeys = Object.keys(source).sort((left, right) => left.localeCompare(right, "en"));
  const allowed = [...expectedKeys].sort((left, right) => left.localeCompare(right, "en"));
  if (actualKeys.some((key) => !allowed.includes(key))) {
    fail("invalid-input", `${label} 包含未声明字段。`);
  }
  const missing = requiredKeys.filter((key) => !Object.hasOwn(source, key));
  if (missing.length > 0) {
    fail("invalid-input", `${label} 缺少必需字段：${missing.join(", ")}。`);
  }
  return source;
}

function normalizedContinuitySnapshot(
  snapshotValue: unknown,
  rawSha256: string,
  terminalPanelId: string | undefined,
): NextShotContinuitySnapshot {
  const snapshot = exactObject(snapshotValue, [
    "schemaVersion", "kind", "sourceUnitId", "sourcePanelId", "sourceRawSha256",
    "characters", "props", "scene", "vfx", "referenceSha256List",
    "continuityFingerprint", "createdAt",
  ], [
    "schemaVersion", "kind", "sourceUnitId", "sourcePanelId", "sourceRawSha256",
    "characters", "props", "scene", "vfx", "referenceSha256List",
    "continuityFingerprint", "createdAt",
  ], "continuitySnapshot");
  if (snapshot.schemaVersion !== 2 || snapshot.kind !== "studio-next-shot-continuity") {
    fail("invalid-input", "continuitySnapshot.kind 无效。");
  }
  if (snapshot.sourceRawSha256 !== rawSha256) {
    fail("invalid-input", "continuitySnapshot.sourceRawSha256 必须等于本次观察的 rawSha256。");
  }
  if (terminalPanelId && snapshot.sourcePanelId !== terminalPanelId) {
    fail("invalid-input", "continuitySnapshot.sourcePanelId 与 terminalPanelId 不一致。");
  }
  if (!Array.isArray(snapshot.characters)
    || !Array.isArray(snapshot.props)
    || !Array.isArray(snapshot.vfx)
    || !Array.isArray(snapshot.referenceSha256List)) {
    fail("invalid-input", "continuitySnapshot 的 characters、props、vfx、referenceSha256List 必须是数组。");
  }
  const characters = snapshot.characters.map((value, index) => {
    const character = exactObject(value, [
      "assetId", "costumeState", "position", "facing", "gazeDirection", "actionEndPose",
      "nextActionStart", "expression", "injuryState",
    ], [
      "assetId", "position", "facing", "gazeDirection", "actionEndPose", "expression",
    ], `continuitySnapshot.characters[${index}]`);
    return {
      assetId: normalizedId(character.assetId, `continuitySnapshot.characters[${index}].assetId`),
      ...(character.costumeState === undefined
        ? {}
        : {
            costumeState: requiredText(
              character.costumeState,
              `continuitySnapshot.characters[${index}].costumeState`,
              2_000,
            ),
          }),
      position: requiredText(character.position, `continuitySnapshot.characters[${index}].position`, 2_000),
      facing: requiredText(character.facing, `continuitySnapshot.characters[${index}].facing`, 2_000),
      gazeDirection: requiredText(
        character.gazeDirection,
        `continuitySnapshot.characters[${index}].gazeDirection`,
        2_000,
      ),
      actionEndPose: requiredText(
        character.actionEndPose,
        `continuitySnapshot.characters[${index}].actionEndPose`,
        2_000,
      ),
      ...(character.nextActionStart === undefined
        ? {}
        : {
            nextActionStart: requiredText(
              character.nextActionStart,
              `continuitySnapshot.characters[${index}].nextActionStart`,
              2_000,
            ),
          }),
      expression: requiredText(
        character.expression,
        `continuitySnapshot.characters[${index}].expression`,
        2_000,
      ),
      ...(character.injuryState === undefined
        ? {}
        : {
            injuryState: requiredText(
              character.injuryState,
              `continuitySnapshot.characters[${index}].injuryState`,
              2_000,
            ),
          }),
    };
  });
  const props = snapshot.props.map((value, index) => {
    const prop = exactObject(value, [
      "assetId", "heldBy", "position", "physicalState",
    ], [
      "assetId", "heldBy", "physicalState",
    ], `continuitySnapshot.props[${index}]`);
    if (prop.heldBy !== null && typeof prop.heldBy !== "string") {
      fail("invalid-input", `continuitySnapshot.props[${index}].heldBy 必须是 assetId 或 null。`);
    }
    return {
      assetId: normalizedId(prop.assetId, `continuitySnapshot.props[${index}].assetId`),
      heldBy: prop.heldBy === null
        ? null
        : normalizedId(prop.heldBy, `continuitySnapshot.props[${index}].heldBy`),
      ...(prop.position === undefined
        ? {}
        : {
            position: requiredText(
              prop.position,
              `continuitySnapshot.props[${index}].position`,
              2_000,
            ),
          }),
      physicalState: requiredText(
        prop.physicalState,
        `continuitySnapshot.props[${index}].physicalState`,
        2_000,
      ),
    };
  });
  const sceneSource = exactObject(snapshot.scene, [
    "layout", "axisLine", "screenDirection", "entryExits", "lighting", "timeOfDay", "weather", "cutExit",
  ], [
    "layout", "axisLine", "entryExits", "lighting", "timeOfDay",
  ], "continuitySnapshot.scene");
  if (!Array.isArray(sceneSource.entryExits)) {
    fail("invalid-input", "continuitySnapshot.scene.entryExits 必须是数组。");
  }
  const scene = {
    layout: requiredText(sceneSource.layout, "continuitySnapshot.scene.layout", 2_000),
    axisLine: requiredText(sceneSource.axisLine, "continuitySnapshot.scene.axisLine", 2_000),
    ...(sceneSource.screenDirection === undefined
      ? {}
      : {
          screenDirection: requiredText(
            sceneSource.screenDirection,
            "continuitySnapshot.scene.screenDirection",
            2_000,
          ),
        }),
    entryExits: sceneSource.entryExits.map((value, index) => (
      requiredText(value, `continuitySnapshot.scene.entryExits[${index}]`, 2_000)
    )),
    lighting: requiredText(sceneSource.lighting, "continuitySnapshot.scene.lighting", 2_000),
    timeOfDay: requiredText(sceneSource.timeOfDay, "continuitySnapshot.scene.timeOfDay", 2_000),
    ...(sceneSource.weather === undefined
      ? {}
      : { weather: requiredText(sceneSource.weather, "continuitySnapshot.scene.weather", 2_000) }),
    ...(sceneSource.cutExit === undefined
      ? {}
      : { cutExit: requiredText(sceneSource.cutExit, "continuitySnapshot.scene.cutExit", 2_000) }),
  };
  const vfx = snapshot.vfx.map((value, index) => {
    const entry = exactObject(value, [
      "vfxId", "description", "intensity", "continuesToNext",
    ], [
      "vfxId", "description", "intensity", "continuesToNext",
    ], `continuitySnapshot.vfx[${index}]`);
    if (typeof entry.intensity !== "number" || typeof entry.continuesToNext !== "boolean") {
      fail("invalid-input", `continuitySnapshot.vfx[${index}] 的 intensity/continuesToNext 类型无效。`);
    }
    return {
      vfxId: normalizedId(entry.vfxId, `continuitySnapshot.vfx[${index}].vfxId`),
      description: requiredText(
        entry.description,
        `continuitySnapshot.vfx[${index}].description`,
        2_000,
      ),
      intensity: entry.intensity,
      continuesToNext: entry.continuesToNext,
    };
  });
  const createdAt = requiredText(snapshot.createdAt, "continuitySnapshot.createdAt", 100);
  if (!Number.isFinite(Date.parse(createdAt)) || new Date(createdAt).toISOString() !== createdAt) {
    fail("invalid-input", "continuitySnapshot.createdAt 必须是规范 ISO 时间。");
  }
  let rebuilt: NextShotContinuitySnapshot;
  try {
    rebuilt = buildNextShotContinuitySnapshot({
      sourceUnitId: normalizedId(snapshot.sourceUnitId, "continuitySnapshot.sourceUnitId"),
      sourcePanelId: normalizedId(snapshot.sourcePanelId, "continuitySnapshot.sourcePanelId"),
      sourceRawSha256: normalizedSha(snapshot.sourceRawSha256, "continuitySnapshot.sourceRawSha256"),
      characters,
      props,
      scene,
      vfx,
      referenceSha256List: snapshot.referenceSha256List,
    });
  } catch (error) {
    fail("invalid-input", `continuitySnapshot 结构无效：${error instanceof Error ? error.message : String(error)}`);
  }
  if (rebuilt.continuityFingerprint !== snapshot.continuityFingerprint) {
    fail("invalid-input", "continuitySnapshot.continuityFingerprint 与确定性重建不一致。");
  }
  // 采用重建后的规范化排序结果；createdAt 保留提交值（不进指纹）。
  return { ...rebuilt, createdAt };
}

function normalizedInput(input: SubmitStudioPostResultObservationInput) {
  if (!Number.isSafeInteger(input.expectedHeadRevision) || input.expectedHeadRevision < 0) {
    fail("invalid-input", "expectedHeadRevision 必须为非负整数。");
  }
  const rawSha256 = normalizedSha(input.rawSha256, "rawSha256");
  const evidence = normalizedEvidence(
    input.evidenceKind,
    input.evidenceSha256,
    input.terminalPanelId,
    rawSha256,
  );
  const observedAvailability = normalizedObservedAvailability(input.observedAvailability);
  assertEvidenceAvailability(evidence.kind, observedAvailability);
  return {
    operationId: normalizedId(input.operationId, "operationId"),
    generationRunId: normalizedId(input.generationRunId, "generationRunId"),
    expectedHeadRevision: input.expectedHeadRevision,
    expectedReviewId: normalizedId(input.expectedReviewId, "expectedReviewId"),
    expectedReviewFingerprint: normalizedSha(input.expectedReviewFingerprint, "expectedReviewFingerprint"),
    rawResultId: normalizedId(input.rawResultId, "rawResultId"),
    rawSha256,
    labeledResultId: normalizedId(input.labeledResultId, "labeledResultId"),
    labeledSha256: normalizedSha(input.labeledSha256, "labeledSha256"),
    packId: normalizedId(input.packId, "packId"),
    packFingerprint: normalizedSha(input.packFingerprint, "packFingerprint"),
    plannedContinuityFingerprint: normalizedSha(
      input.plannedContinuityFingerprint,
      "plannedContinuityFingerprint",
    ),
    evidenceKind: evidence.kind,
    evidenceSha256: evidence.sha256,
    ...(evidence.terminalPanelId ? { terminalPanelId: evidence.terminalPanelId } : {}),
    observedState: normalizedObservedState(input.observedState, evidence.sha256),
    observedAvailability,
    ...(input.continuitySnapshot
      ? {
        continuitySnapshot: normalizedContinuitySnapshot(
          input.continuitySnapshot,
          rawSha256,
          evidence.terminalPanelId,
        ),
      }
      : {}),
    observer: requiredText(input.observer, "observer", 500),
    note: requiredText(input.note, "note", 8_000),
  };
}

function createSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE studio_post_result_observation_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      observation_id TEXT NOT NULL UNIQUE,
      generation_run_id TEXT NOT NULL,
      base_head_revision INTEGER NOT NULL CHECK(base_head_revision >= 0),
      head_revision INTEGER NOT NULL CHECK(head_revision = base_head_revision + 1),
      review_id TEXT NOT NULL,
      review_fingerprint TEXT NOT NULL CHECK(length(review_fingerprint) = 64),
      raw_result_id TEXT NOT NULL,
      raw_sha256 TEXT NOT NULL CHECK(length(raw_sha256) = 64),
      labeled_result_id TEXT NOT NULL,
      labeled_sha256 TEXT NOT NULL CHECK(length(labeled_sha256) = 64),
      pack_id TEXT NOT NULL,
      pack_fingerprint TEXT NOT NULL CHECK(length(pack_fingerprint) = 64),
      planned_continuity_fingerprint TEXT NOT NULL CHECK(length(planned_continuity_fingerprint) = 64),
      observed_state_json TEXT NOT NULL,
      observer TEXT NOT NULL,
      note TEXT NOT NULL,
      fingerprint TEXT NOT NULL UNIQUE CHECK(length(fingerprint) = 64),
      created_at TEXT NOT NULL,
      FOREIGN KEY(review_id) REFERENCES studio_generation_review_events(review_id) ON DELETE RESTRICT,
      FOREIGN KEY(raw_result_id) REFERENCES studio_generation_results(result_id) ON DELETE RESTRICT,
      FOREIGN KEY(labeled_result_id) REFERENCES studio_generation_results(result_id) ON DELETE RESTRICT,
      FOREIGN KEY(pack_id) REFERENCES studio_generation_packs(pack_id) ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE studio_post_result_observation_heads (
      generation_run_id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL CHECK(revision >= 1),
      observation_id TEXT NOT NULL UNIQUE,
      observation_fingerprint TEXT NOT NULL CHECK(length(observation_fingerprint) = 64),
      updated_at TEXT NOT NULL,
      FOREIGN KEY(observation_id) REFERENCES studio_post_result_observation_events(observation_id) ON DELETE RESTRICT
    ) STRICT;

    CREATE TABLE studio_post_result_observation_operation_receipts (
      operation_id TEXT PRIMARY KEY,
      input_fingerprint TEXT NOT NULL CHECK(length(input_fingerprint) = 64),
      observation_id TEXT NOT NULL,
      outcome_fingerprint TEXT NOT NULL CHECK(length(outcome_fingerprint) = 64),
      created_at TEXT NOT NULL,
      FOREIGN KEY(observation_id) REFERENCES studio_post_result_observation_events(observation_id) ON DELETE RESTRICT
    ) STRICT;

    CREATE INDEX studio_post_result_observation_run_sequence_idx
      ON studio_post_result_observation_events(generation_run_id, sequence);

    CREATE TRIGGER studio_post_result_observation_events_no_update
      BEFORE UPDATE ON studio_post_result_observation_events
      BEGIN SELECT RAISE(ABORT, 'post-result observation events are append-only'); END;
    CREATE TRIGGER studio_post_result_observation_events_no_delete
      BEFORE DELETE ON studio_post_result_observation_events
      BEGIN SELECT RAISE(ABORT, 'post-result observation events are append-only'); END;
    CREATE TRIGGER studio_post_result_observation_receipts_no_update
      BEFORE UPDATE ON studio_post_result_observation_operation_receipts
      BEGIN SELECT RAISE(ABORT, 'post-result observation receipts are append-only'); END;
    CREATE TRIGGER studio_post_result_observation_receipts_no_delete
      BEFORE DELETE ON studio_post_result_observation_operation_receipts
      BEGIN SELECT RAISE(ABORT, 'post-result observation receipts are append-only'); END;
    CREATE TRIGGER studio_post_result_observation_heads_no_delete
      BEFORE DELETE ON studio_post_result_observation_heads
      BEGIN SELECT RAISE(ABORT, 'post-result observation heads cannot be deleted'); END;
  `);
}

const TABLE_COLUMNS: Record<string, string[]> = {
  studio_post_result_observation_events: [
    "sequence", "observation_id", "generation_run_id", "base_head_revision", "head_revision",
    "review_id", "review_fingerprint", "raw_result_id", "raw_sha256", "labeled_result_id",
    "labeled_sha256", "pack_id", "pack_fingerprint", "planned_continuity_fingerprint",
    "observed_state_json", "observer", "note", "fingerprint", "created_at",
  ],
  studio_post_result_observation_heads: [
    "generation_run_id", "revision", "observation_id", "observation_fingerprint", "updated_at",
  ],
  studio_post_result_observation_operation_receipts: [
    "operation_id", "input_fingerprint", "observation_id", "outcome_fingerprint", "created_at",
  ],
};
const INDEXES = ["studio_post_result_observation_run_sequence_idx"] as const;
const TRIGGERS = [
  "studio_post_result_observation_events_no_update",
  "studio_post_result_observation_events_no_delete",
  "studio_post_result_observation_receipts_no_update",
  "studio_post_result_observation_receipts_no_delete",
  "studio_post_result_observation_heads_no_delete",
] as const;

function schemaObjectExists(db: DatabaseSync, name: string, type: "index" | "trigger"): boolean {
  return Boolean(db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type=? AND name=?").get(type, name));
}

function assertBaseSchema(db: DatabaseSync): void {
  const marker = db.prepare("SELECT value FROM studio_generation_ledger_meta WHERE key='schema_version'")
    .get() as { value?: string } | undefined;
  if (!marker?.value || !["2", "3", "4", "5", "6", "7"].includes(marker.value)) {
    fail("storage-invalid", "实际末态观察要求已初始化的 generation ledger v2-v7。");
  }
}

function assertSchema(db: DatabaseSync): void {
  const marker = db.prepare(
    "SELECT value FROM studio_generation_ledger_meta WHERE key='post_result_observation_schema_version'",
  ).get() as { value?: string } | undefined;
  if (marker?.value !== String(SCHEMA_VERSION)) {
    fail("storage-invalid", `实际末态观察 schema marker 无效：${marker?.value ?? "缺失"}。`);
  }
  const actualTables = (db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type='table' AND name GLOB 'studio_post_result_observation_*'
    ORDER BY name
  `).all() as Array<{ name: string }>).map((row) => row.name);
  const expectedTables = Object.keys(TABLE_COLUMNS).sort((left, right) => left.localeCompare(right, "en"));
  if (JSON.stringify(actualTables) !== JSON.stringify(expectedTables)) {
    fail("storage-invalid", "实际末态观察 tables 与声明 schema 不一致。");
  }
  for (const [table, expectedColumns] of Object.entries(TABLE_COLUMNS)) {
    const actualColumns = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
      .map((column) => column.name);
    if (JSON.stringify(actualColumns) !== JSON.stringify(expectedColumns)) {
      fail("storage-invalid", `实际末态观察 table ${table} 列定义漂移。`);
    }
  }
  for (const index of INDEXES) {
    if (!schemaObjectExists(db, index, "index")) fail("storage-invalid", `实际末态观察 index ${index} 缺失。`);
  }
  for (const trigger of TRIGGERS) {
    if (!schemaObjectExists(db, trigger, "trigger")) fail("storage-invalid", `实际末态观察 trigger ${trigger} 缺失。`);
  }
  const expected = new DatabaseSync(":memory:");
  try {
    createSchema(expected);
    assertSqliteSchemaContract({
      actual: db,
      expected,
      objectNames: [...Object.keys(TABLE_COLUMNS), ...INDEXES, ...TRIGGERS],
      tableNames: Object.keys(TABLE_COLUMNS),
      ownedObjectPrefixes: ["studio_post_result_observation_"],
      rejectAllViews: true,
      label: "实际末态观察",
    });
  } catch (error) {
    if (error instanceof StudioPostResultObservationError) throw error;
    fail("storage-invalid", error instanceof Error ? error.message : "实际末态观察 schema 合同不一致。");
  } finally {
    expected.close();
  }
  if ((db.prepare("PRAGMA foreign_key_check").all() as unknown[]).length > 0) {
    fail("storage-invalid", "实际末态观察账本存在外键孤儿。");
  }
}

function ownedSchemaObjects(db: DatabaseSync): Array<{ type: string; name: string }> {
  return db.prepare(`
    SELECT type, name FROM sqlite_master
    WHERE name GLOB 'studio_post_result_observation_*'
    ORDER BY type, name
  `).all() as Array<{ type: string; name: string }>;
}

async function ensureSchema(databasePath: string): Promise<void> {
  let snapshot: Awaited<ReturnType<typeof openSqliteReadOnlySnapshot>> | null = null;
  let sourceIdentity: SqliteSourceBindingIdentity | null = null;
  let needsInitialization = false;
  try {
    snapshot = await openSqliteReadOnlySnapshot(databasePath, "post-result observation ledger");
    sourceIdentity = snapshot.sourceIdentity;
    assertBaseSchema(snapshot.database);
    const marker = snapshot.database.prepare(
      "SELECT value FROM studio_generation_ledger_meta WHERE key='post_result_observation_schema_version'",
    ).get() as { value?: string } | undefined;
    if (marker) {
      if (marker.value !== String(SCHEMA_VERSION)) {
        fail("storage-invalid", `不支持实际末态观察 schema ${marker.value}。`);
      }
      assertSchema(snapshot.database);
      return;
    }
    const residual = ownedSchemaObjects(snapshot.database);
    if (residual.length > 0) {
      fail(
        "storage-invalid",
        "实际末态观察 schema marker 缺失但存在残留对象，禁止静默修复。",
        residual.map((entry) => `${entry.type}:${entry.name}`),
      );
    }
    needsInitialization = true;
  } finally {
    await snapshot?.close();
  }
  if (!needsInitialization) return;
  if (!sourceIdentity) fail("storage-invalid", "实际末态观察首次初始化缺少只读预检身份。");

  assertSqliteSourceBindingIdentity(databasePath, sourceIdentity, "post-result observation ledger");
  assertSafeSqliteSidecars(databasePath, "post-result observation ledger");
  const busyTimeoutMs = studioSqliteBusyTimeoutMs(BUSY_TIMEOUT_MS);
  const db = new DatabaseSync(databasePath, { timeout: busyTimeoutMs });
  try {
    assertSafeSqliteSidecars(databasePath, "post-result observation ledger");
    assertSqliteSourceBindingIdentity(databasePath, sourceIdentity, "post-result observation ledger");
    db.exec(`PRAGMA busy_timeout=${busyTimeoutMs}; PRAGMA foreign_keys=ON; PRAGMA synchronous=NORMAL;`);
    db.exec("BEGIN IMMEDIATE");
    try {
      assertBaseSchema(db);
      const marker = db.prepare(
        "SELECT value FROM studio_generation_ledger_meta WHERE key='post_result_observation_schema_version'",
      ).get() as { value?: string } | undefined;
      if (marker) {
        if (marker.value !== String(SCHEMA_VERSION)) {
          fail("storage-invalid", `不支持实际末态观察 schema ${marker.value}。`);
        }
        assertSchema(db);
      } else {
        const residual = ownedSchemaObjects(db);
        if (residual.length > 0) {
          fail("storage-invalid", "实际末态观察首次初始化发现无 marker 残留对象。");
        }
        createSchema(db);
        db.prepare(
          "INSERT INTO studio_generation_ledger_meta(key,value) VALUES('post_result_observation_schema_version', ?)",
        ).run(String(SCHEMA_VERSION));
        assertSchema(db);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.close();
  }
}

async function databaseContextFor(projectRoot: string): Promise<DatabaseContext> {
  await initializeStudioGenerationLedger(projectRoot);
  let shell: Awaited<ReturnType<typeof inspectManagedProject>>;
  try {
    shell = await inspectManagedProject(projectRoot);
  } catch (error) {
    throw new StudioPostResultObservationError(
      "unmanaged-project",
      "实际末态观察只允许写入受管 Studio 项目。",
      [],
      { cause: error },
    );
  }
  const databasePath = path.join(shell.paths.root, DATABASE_RELATIVE_PATH);
  await ensureSchema(databasePath);
  let snapshot: Awaited<ReturnType<typeof openSqliteReadOnlySnapshot>> | null = null;
  try {
    snapshot = await openSqliteReadOnlySnapshot(databasePath, "post-result observation operation");
    assertBaseSchema(snapshot.database);
    assertSchema(snapshot.database);
    return { databasePath, sourceIdentity: snapshot.sourceIdentity };
  } finally {
    await snapshot?.close();
  }
}

function missingFile(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function openObservationReadSnapshot(
  projectRoot: string,
  label: string,
): Promise<{
  snapshot: SqliteReadOnlySnapshot | null;
  reviewSchemaPresent: boolean;
}> {
  let shell: Awaited<ReturnType<typeof inspectManagedProjectReadOnly>>;
  try {
    shell = await inspectManagedProjectReadOnly(projectRoot);
  } catch (error) {
    throw new StudioPostResultObservationError(
      "unmanaged-project",
      "实际末态观察只允许读取受管 Studio 项目。",
      [],
      { cause: error },
    );
  }
  const databasePath = path.join(shell.paths.root, DATABASE_RELATIVE_PATH);
  try {
    const metadata = await lstat(databasePath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      fail("storage-invalid", "实际末态观察账本不是安全普通文件。");
    }
  } catch (error) {
    if (missingFile(error)) return { snapshot: null, reviewSchemaPresent: false };
    throw error;
  }
  const snapshot = await openSqliteReadOnlySnapshot(databasePath, label);
  try {
    assertBaseSchema(snapshot.database);
    const reviewMarker = snapshot.database.prepare(
      "SELECT value FROM studio_generation_ledger_meta WHERE key='p7_review_schema_version'",
    ).get() as { value?: string } | undefined;
    const observationMarker = snapshot.database.prepare(
      "SELECT value FROM studio_generation_ledger_meta WHERE key='post_result_observation_schema_version'",
    ).get() as { value?: string } | undefined;
    const reviewSchemaPresent = Boolean(reviewMarker?.value);
    if (!observationMarker) {
      const residual = ownedSchemaObjects(snapshot.database);
      if (residual.length > 0) {
        fail(
          "storage-invalid",
          "实际末态观察 schema marker 缺失但存在残留对象，禁止把残留结构当作可读账本。",
          residual.map((entry) => `${entry.type}:${entry.name}`),
        );
      }
      await snapshot.close();
      return { snapshot: null, reviewSchemaPresent };
    }
    assertSchema(snapshot.database);
    return { snapshot, reviewSchemaPresent };
  } catch (error) {
    await snapshot.close();
    throw error;
  }
}

interface EvidenceMediaIdentity {
  kind: "image" | "video" | "audio";
  sha256: string;
  sizeBytes: number;
  objectPath: string;
}

async function inspectEvidenceMediaIdentity(
  projectRoot: string,
  evidenceSha256: string,
): Promise<EvidenceMediaIdentity> {
  const shell = await inspectManagedProjectReadOnly(projectRoot);
  const snapshot = await openSqliteReadOnlySnapshot(
    shell.paths.materialDatabase,
    "post-result observation evidence media",
  );
  let row: {
    sha256: string;
    kind: string;
    size_bytes: number;
    object_relpath: string;
  } | undefined;
  try {
    const marker = snapshot.database.prepare(
      "SELECT value FROM studio_meta WHERE key='schema_version'",
    ).get() as { value?: string } | undefined;
    if (marker?.value !== "1") throw new Error("素材库 schema 不可用于末态证据验证。");
    row = snapshot.database.prepare(`
      SELECT sha256,kind,size_bytes,object_relpath
      FROM studio_media WHERE sha256=?
    `).get(evidenceSha256) as typeof row;
  } finally {
    await snapshot.close();
  }
  if (!row || row.sha256 !== evidenceSha256
    || (row.kind !== "image" && row.kind !== "video" && row.kind !== "audio")
    || !Number.isSafeInteger(Number(row.size_bytes)) || Number(row.size_bytes) < 1) {
    throw new Error("末态 evidenceSha256 未命中受管素材库中的有效媒体。");
  }
  const expectedRelativePath = [
    ".aicanvas",
    "objects",
    "sha256",
    evidenceSha256.slice(0, 2),
    evidenceSha256,
  ].join("/");
  if (row.object_relpath !== expectedRelativePath) {
    throw new Error("末态证据媒体没有绑定标准受管 CAS 路径。");
  }
  const objectPath = path.join(
    shell.paths.mediaCas,
    evidenceSha256.slice(0, 2),
    evidenceSha256,
  );
  const pathBefore = await lstat(objectPath, { bigint: true });
  const canonicalPath = await realpath(objectPath);
  if (!pathBefore.isFile() || pathBefore.isSymbolicLink() || pathBefore.nlink !== 1n
    || canonicalPath !== objectPath) {
    throw new Error("末态证据 CAS 对象不是规范单链接普通文件。");
  }
  const handle = await open(
    objectPath,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  try {
    const descriptorBefore = await handle.stat({ bigint: true });
    if (!descriptorBefore.isFile() || descriptorBefore.nlink !== 1n
      || descriptorBefore.dev !== pathBefore.dev || descriptorBefore.ino !== pathBefore.ino
      || descriptorBefore.size !== BigInt(row.size_bytes)) {
      throw new Error("末态证据 CAS 路径与文件描述符身份不一致。");
    }
    const hash = createHash("sha256");
    let sizeBytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      hash.update(chunk as Buffer);
      sizeBytes += (chunk as Buffer).byteLength;
    }
    const [descriptorAfter, pathAfter] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(objectPath, { bigint: true }),
    ]);
    if (!pathAfter.isFile() || pathAfter.isSymbolicLink() || pathAfter.nlink !== 1n
      || descriptorAfter.dev !== descriptorBefore.dev
      || descriptorAfter.ino !== descriptorBefore.ino
      || descriptorAfter.size !== descriptorBefore.size
      || descriptorAfter.mtimeNs !== descriptorBefore.mtimeNs
      || descriptorAfter.ctimeNs !== descriptorBefore.ctimeNs
      || pathAfter.dev !== descriptorBefore.dev
      || pathAfter.ino !== descriptorBefore.ino
      || pathAfter.size !== descriptorBefore.size
      || sizeBytes !== Number(descriptorBefore.size)
      || hash.digest("hex") !== evidenceSha256) {
      throw new Error("末态证据 CAS 对象在验证期间漂移或内容哈希不符。");
    }
  } finally {
    await handle.close();
  }
  return {
    kind: row.kind,
    sha256: row.sha256,
    sizeBytes: Number(row.size_bytes),
    objectPath,
  };
}

function openDatabase(context: DatabaseContext): DatabaseSync {
  assertSafeSqliteSidecars(context.databasePath, "post-result observation ledger");
  assertSqliteSourceBindingIdentity(context.databasePath, context.sourceIdentity, "post-result observation ledger");
  const busyTimeoutMs = studioSqliteBusyTimeoutMs(BUSY_TIMEOUT_MS);
  const db = new DatabaseSync(context.databasePath, { timeout: busyTimeoutMs });
  try {
    assertSafeSqliteSidecars(context.databasePath, "post-result observation ledger");
    assertSqliteSourceBindingIdentity(context.databasePath, context.sourceIdentity, "post-result observation ledger");
    db.exec(`PRAGMA busy_timeout=${busyTimeoutMs}; PRAGMA foreign_keys=ON; PRAGMA synchronous=NORMAL;`);
    const journal = db.prepare("PRAGMA journal_mode").get() as { journal_mode?: string } | undefined;
    if (journal?.journal_mode?.toLowerCase() !== "wal") {
      fail("storage-invalid", "实际末态观察必须复用 WAL generation ledger。");
    }
    assertBaseSchema(db);
    assertSchema(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function transaction<T>(db: DatabaseSync, callback: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const value = callback();
    db.exec("COMMIT");
    return value;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function observationRow(db: DatabaseSync, observationId: string): ObservationRow | undefined {
  return db.prepare("SELECT * FROM studio_post_result_observation_events WHERE observation_id=?")
    .get(observationId) as unknown as ObservationRow | undefined;
}

function headRow(db: DatabaseSync, generationRunId: string): HeadRow | undefined {
  return db.prepare("SELECT * FROM studio_post_result_observation_heads WHERE generation_run_id=?")
    .get(generationRunId) as unknown as HeadRow | undefined;
}

function operationRow(db: DatabaseSync, operationId: string): OperationRow | undefined {
  return db.prepare(`
    SELECT operation_id,input_fingerprint,observation_id,outcome_fingerprint,created_at
    FROM studio_post_result_observation_operation_receipts WHERE operation_id=?
  `).get(operationId) as unknown as OperationRow | undefined;
}

interface ParsedStoredObservation {
  evidenceContractVersion: 1 | 2 | 3 | 4;
  continuitySnapshot?: NextShotContinuitySnapshot;
  evidence?: StudioPostResultEvidence;
  evidenceLineage?: StudioPostResultEvidenceLineage;
  observedState: StudioSeedanceObservedState;
  observedAvailability: StudioPostResultObservedAvailability;
  /** 旧事件必须按原始 observed_state_json 语义验指纹，不能静默改写。 */
  legacyObservedState?: StudioSeedanceObservedState;
  legacyV2ObservedAvailability?: LegacyV2ObservedAvailability;
}

type PersistedObservationInput = ReturnType<typeof normalizedInput> & {
  evidenceLineage?: StudioPostResultEvidenceLineage;
};

function encodedObservedState(input: PersistedObservationInput): string {
  if (input.continuitySnapshot) {
    return JSON.stringify({
      schemaVersion: 4,
      evidence: {
        kind: input.evidenceKind,
        sha256: input.evidenceSha256,
        ...(input.terminalPanelId ? { terminalPanelId: input.terminalPanelId } : {}),
        ...(input.evidenceLineage ? { lineage: input.evidenceLineage } : {}),
      },
      observedState: input.observedState,
      observedAvailability: input.observedAvailability,
      continuitySnapshot: input.continuitySnapshot,
    });
  }
  return JSON.stringify({
    schemaVersion: 3,
    evidence: {
      kind: input.evidenceKind,
      sha256: input.evidenceSha256,
      ...(input.terminalPanelId ? { terminalPanelId: input.terminalPanelId } : {}),
      ...(input.evidenceLineage ? { lineage: input.evidenceLineage } : {}),
    },
    observedState: input.observedState,
    observedAvailability: input.observedAvailability,
  });
}

function parsedStoredObservation(value: string, rawSha256: string): ParsedStoredObservation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new StudioPostResultObservationError(
      "storage-invalid",
      "实际末态 observedState JSON 已损坏。",
      [],
      { cause: error },
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail("storage-invalid", "实际末态 observedState 结构已损坏。");
  }
  const source = parsed as Record<string, unknown>;
  try {
    if (source.schemaVersion === 4) {
      const actualKeys = Object.keys(source).sort((left, right) => left.localeCompare(right, "en"));
      const expectedKeys = ["continuitySnapshot", "evidence", "observedAvailability", "observedState", "schemaVersion"];
      if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
        fail("storage-invalid", "实际末态 v4 存储包装字段已漂移。");
      }
      if (!source.evidence || typeof source.evidence !== "object" || Array.isArray(source.evidence)) {
        fail("storage-invalid", "实际末态 v4 evidence 已损坏。");
      }
      const evidenceSource = source.evidence as Record<string, unknown>;
      const evidence = normalizedEvidence(
        evidenceSource.kind,
        evidenceSource.sha256,
        evidenceSource.terminalPanelId,
        rawSha256,
      );
      const evidenceLineage = evidenceSource.lineage === undefined
        ? undefined
        : normalizedEvidenceLineage(evidenceSource.lineage, evidence.sha256);
      if (evidenceLineage && evidence.kind !== "terminal-panel-crop") {
        fail("storage-invalid", "非 terminal-panel-crop 事件不得携带视频包裁图血缘。");
      }
      const snapshotSource = source.continuitySnapshot;
      if (!snapshotSource || typeof snapshotSource !== "object") {
        fail("storage-invalid", "实际末态 v4 缺少 continuitySnapshot。");
      }
      let rebuiltSnapshot: NextShotContinuitySnapshot;
      try {
        rebuiltSnapshot = normalizedContinuitySnapshot(
          snapshotSource,
          rawSha256,
          evidence.terminalPanelId,
        );
      } catch (error) {
        fail("storage-invalid", `实际末态 v4 continuitySnapshot 结构已损坏：${error instanceof Error ? error.message : String(error)}`);
      }
      return {
        evidenceContractVersion: 4,
        evidence,
        ...(evidenceLineage ? { evidenceLineage } : {}),
        continuitySnapshot: rebuiltSnapshot,
        observedState: normalizedObservedState(source.observedState, evidence.sha256),
        observedAvailability: normalizedObservedAvailability(source.observedAvailability),
      };
    }
    if (source.schemaVersion === 3) {
      const actualKeys = Object.keys(source).sort((left, right) => left.localeCompare(right, "en"));
      const expectedKeys = ["evidence", "observedAvailability", "observedState", "schemaVersion"];
      if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
        fail("storage-invalid", "实际末态 v3 存储包装字段已漂移。");
      }
      if (!source.evidence || typeof source.evidence !== "object" || Array.isArray(source.evidence)) {
        fail("storage-invalid", "实际末态 v3 evidence 已损坏。");
      }
      const evidenceSource = source.evidence as Record<string, unknown>;
      const expectedEvidenceKeys = evidenceSource.kind === "terminal-panel-crop"
        ? evidenceSource.lineage === undefined
          ? ["kind", "sha256", "terminalPanelId"]
          : ["kind", "lineage", "sha256", "terminalPanelId"]
        : ["kind", "sha256"];
      const actualEvidenceKeys = Object.keys(evidenceSource)
        .sort((left, right) => left.localeCompare(right, "en"));
      if (JSON.stringify(actualEvidenceKeys) !== JSON.stringify(expectedEvidenceKeys)) {
        fail("storage-invalid", "实际末态 v3 evidence 字段已漂移。");
      }
      const evidence = normalizedEvidence(
        evidenceSource.kind,
        evidenceSource.sha256,
        evidenceSource.terminalPanelId,
        rawSha256,
      );
      const evidenceLineage = evidenceSource.lineage === undefined
        ? undefined
        : normalizedEvidenceLineage(evidenceSource.lineage, evidence.sha256);
      if (evidenceLineage && evidence.kind !== "terminal-panel-crop") {
        fail("storage-invalid", "非 terminal-panel-crop 事件不得携带视频包裁图血缘。");
      }
      return {
        evidenceContractVersion: 3,
        evidence,
        ...(evidenceLineage ? { evidenceLineage } : {}),
        observedState: normalizedObservedState(source.observedState, evidence.sha256),
        observedAvailability: normalizedObservedAvailability(source.observedAvailability),
      };
    }
    if (source.schemaVersion === 2) {
      const actualKeys = Object.keys(source).sort((left, right) => left.localeCompare(right, "en"));
      const expectedKeys = ["evidence", "observedAvailability", "observedState", "schemaVersion"];
      if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
        fail("storage-invalid", "实际末态 v2 存储包装字段已漂移。");
      }
      if (!source.evidence || typeof source.evidence !== "object" || Array.isArray(source.evidence)) {
        fail("storage-invalid", "实际末态 v2 evidence 已损坏。");
      }
      const evidenceSource = source.evidence as Record<string, unknown>;
      const expectedEvidenceKeys = evidenceSource.kind === "terminal-panel-crop"
        ? ["kind", "sha256", "terminalPanelId"]
        : ["kind", "sha256"];
      const actualEvidenceKeys = Object.keys(evidenceSource)
        .sort((left, right) => left.localeCompare(right, "en"));
      if (JSON.stringify(actualEvidenceKeys) !== JSON.stringify(expectedEvidenceKeys)) {
        fail("storage-invalid", "实际末态 v2 evidence 字段已漂移。");
      }
      const evidence = normalizedEvidence(
        evidenceSource.kind,
        evidenceSource.sha256,
        evidenceSource.terminalPanelId,
        rawSha256,
      );
      return {
        evidenceContractVersion: 2,
        evidence,
        observedState: normalizedObservedState(source.observedState, evidence.sha256),
        // v2 只对三个动态字段有显式 availability。对外投影必须保守降级，
        // 不能把其余字符串字段当成已观测事实。
        observedAvailability: unknownObservedAvailability(),
        legacyV2ObservedAvailability: normalizedLegacyV2ObservedAvailability(
          source.observedAvailability,
        ),
      };
    }
    // v1 事件只存整张 raw 绑定的 observedState。保留原事件可读性，但把动态
    // 字段全部降级为 unknown，且由 projection 明确禁止作为下一镜承接证据。
    const legacyReference = source.referenceSha256;
    const legacyObservedState = normalizedObservedState(
      source,
      typeof legacyReference === "string" ? legacyReference : "",
    );
    return {
      evidenceContractVersion: 1,
      observedState: legacyObservedState,
      observedAvailability: unknownObservedAvailability(),
      legacyObservedState,
    };
  } catch (error) {
    throw new StudioPostResultObservationError(
      "storage-invalid",
      "实际末态 observedState 合同已损坏。",
      [],
      { cause: error },
    );
  }
}

function recordFromRow(row: ObservationRow): StudioPostResultObservationRecord {
  const stored = parsedStoredObservation(row.observed_state_json, row.raw_sha256);
  const record: StudioPostResultObservationRecord = {
    sequence: Number(row.sequence),
    observationId: row.observation_id,
    generationRunId: row.generation_run_id,
    baseHeadRevision: Number(row.base_head_revision),
    headRevision: Number(row.head_revision),
    reviewId: row.review_id,
    reviewFingerprint: row.review_fingerprint,
    rawResultId: row.raw_result_id,
    rawSha256: row.raw_sha256,
    labeledResultId: row.labeled_result_id,
    labeledSha256: row.labeled_sha256,
    packId: row.pack_id,
    packFingerprint: row.pack_fingerprint,
    plannedContinuityFingerprint: row.planned_continuity_fingerprint,
    evidenceContractVersion: stored.evidenceContractVersion,
    ...(stored.evidence
      ? {
          evidenceKind: stored.evidence.kind,
          evidenceSha256: stored.evidence.sha256,
          ...(stored.evidence.terminalPanelId
            ? { terminalPanelId: stored.evidence.terminalPanelId }
            : {}),
        }
      : {}),
    ...(stored.evidenceLineage ? { evidenceLineage: stored.evidenceLineage } : {}),
    ...(stored.continuitySnapshot ? { continuitySnapshot: stored.continuitySnapshot } : {}),
    observedState: stored.observedState,
    observedAvailability: stored.observedAvailability,
    observer: row.observer,
    note: row.note,
    fingerprint: row.fingerprint,
    createdAt: row.created_at,
  };
  let semantic: ReturnType<typeof legacyObservationSemantic>
    | ReturnType<typeof legacyV2ObservationSemantic>
    | ReturnType<typeof observationSemantic>;
  if (stored.evidenceContractVersion === 1) {
    semantic = legacyObservationSemantic({
        generationRunId: record.generationRunId,
        expectedHeadRevision: record.baseHeadRevision,
        expectedReviewId: record.reviewId,
        expectedReviewFingerprint: record.reviewFingerprint,
        rawResultId: record.rawResultId,
        rawSha256: record.rawSha256,
        labeledResultId: record.labeledResultId,
        labeledSha256: record.labeledSha256,
        packId: record.packId,
        packFingerprint: record.packFingerprint,
        plannedContinuityFingerprint: record.plannedContinuityFingerprint,
        observedState: stored.legacyObservedState!,
        observer: record.observer,
        note: record.note,
      });
  } else if (stored.evidenceContractVersion === 2) {
    semantic = legacyV2ObservationSemantic({
      generationRunId: record.generationRunId,
      expectedHeadRevision: record.baseHeadRevision,
      expectedReviewId: record.reviewId,
      expectedReviewFingerprint: record.reviewFingerprint,
      rawResultId: record.rawResultId,
      rawSha256: record.rawSha256,
      labeledResultId: record.labeledResultId,
      labeledSha256: record.labeledSha256,
      packId: record.packId,
      packFingerprint: record.packFingerprint,
      plannedContinuityFingerprint: record.plannedContinuityFingerprint,
      evidenceKind: record.evidenceKind!,
      evidenceSha256: record.evidenceSha256!,
      ...(record.terminalPanelId ? { terminalPanelId: record.terminalPanelId } : {}),
      observedState: record.observedState,
      observedAvailability: stored.legacyV2ObservedAvailability!,
      observer: record.observer,
      note: record.note,
    });
  } else {
    semantic = observationSemantic({
        ...(stored.continuitySnapshot ? { continuitySnapshot: stored.continuitySnapshot } : {}),
        generationRunId: record.generationRunId,
        expectedHeadRevision: record.baseHeadRevision,
        expectedReviewId: record.reviewId,
        expectedReviewFingerprint: record.reviewFingerprint,
        rawResultId: record.rawResultId,
        rawSha256: record.rawSha256,
        labeledResultId: record.labeledResultId,
        labeledSha256: record.labeledSha256,
        packId: record.packId,
        packFingerprint: record.packFingerprint,
        plannedContinuityFingerprint: record.plannedContinuityFingerprint,
        evidenceKind: record.evidenceKind!,
        evidenceSha256: record.evidenceSha256!,
        ...(record.terminalPanelId ? { terminalPanelId: record.terminalPanelId } : {}),
        ...(record.evidenceLineage ? { evidenceLineage: record.evidenceLineage } : {}),
        observedState: record.observedState,
        observedAvailability: record.observedAvailability,
        observer: record.observer,
        note: record.note,
      });
  }
  const fingerprint = digest(semantic);
  if (record.fingerprint !== fingerprint
    || record.observationId !== `studio-post-result-observation-${fingerprint.slice(0, 40)}`) {
    fail("storage-invalid", `实际末态观察 ${record.observationId} 内容地址已损坏。`);
  }
  return record;
}

function observationSemantic(input: Omit<PersistedObservationInput, "operationId">) {
  return {
    schemaVersion: (input.continuitySnapshot ? 4 : 3) as 3 | 4,
    kind: "studio-post-result-observation" as const,
    generationRunId: input.generationRunId,
    baseHeadRevision: input.expectedHeadRevision,
    headRevision: input.expectedHeadRevision + 1,
    reviewId: input.expectedReviewId,
    reviewFingerprint: input.expectedReviewFingerprint,
    rawResultId: input.rawResultId,
    rawSha256: input.rawSha256,
    labeledResultId: input.labeledResultId,
    labeledSha256: input.labeledSha256,
    packId: input.packId,
    packFingerprint: input.packFingerprint,
    plannedContinuityFingerprint: input.plannedContinuityFingerprint,
    evidenceKind: input.evidenceKind,
    evidenceSha256: input.evidenceSha256,
    ...(input.terminalPanelId ? { terminalPanelId: input.terminalPanelId } : {}),
    ...(input.evidenceLineage ? { evidenceLineage: input.evidenceLineage } : {}),
    ...(input.continuitySnapshot ? { continuitySnapshot: input.continuitySnapshot } : {}),
    observedState: input.observedState,
    observedAvailability: input.observedAvailability,
    observer: input.observer,
    note: input.note,
  };
}

function legacyV2ObservationSemantic(input: {
  generationRunId: string;
  expectedHeadRevision: number;
  expectedReviewId: string;
  expectedReviewFingerprint: string;
  rawResultId: string;
  rawSha256: string;
  labeledResultId: string;
  labeledSha256: string;
  packId: string;
  packFingerprint: string;
  plannedContinuityFingerprint: string;
  evidenceKind: StudioPostResultEvidenceKind;
  evidenceSha256: string;
  terminalPanelId?: string;
  observedState: StudioSeedanceObservedState;
  observedAvailability: LegacyV2ObservedAvailability;
  observer: string;
  note: string;
}) {
  return {
    schemaVersion: 2 as const,
    kind: "studio-post-result-observation" as const,
    generationRunId: input.generationRunId,
    baseHeadRevision: input.expectedHeadRevision,
    headRevision: input.expectedHeadRevision + 1,
    reviewId: input.expectedReviewId,
    reviewFingerprint: input.expectedReviewFingerprint,
    rawResultId: input.rawResultId,
    rawSha256: input.rawSha256,
    labeledResultId: input.labeledResultId,
    labeledSha256: input.labeledSha256,
    packId: input.packId,
    packFingerprint: input.packFingerprint,
    plannedContinuityFingerprint: input.plannedContinuityFingerprint,
    evidenceKind: input.evidenceKind,
    evidenceSha256: input.evidenceSha256,
    ...(input.terminalPanelId ? { terminalPanelId: input.terminalPanelId } : {}),
    observedState: input.observedState,
    observedAvailability: input.observedAvailability,
    observer: input.observer,
    note: input.note,
  };
}

function legacyObservationSemantic(input: {
  generationRunId: string;
  expectedHeadRevision: number;
  expectedReviewId: string;
  expectedReviewFingerprint: string;
  rawResultId: string;
  rawSha256: string;
  labeledResultId: string;
  labeledSha256: string;
  packId: string;
  packFingerprint: string;
  plannedContinuityFingerprint: string;
  observedState: StudioSeedanceObservedState;
  observer: string;
  note: string;
}) {
  return {
    schemaVersion: 1 as const,
    kind: "studio-post-result-observation" as const,
    generationRunId: input.generationRunId,
    baseHeadRevision: input.expectedHeadRevision,
    headRevision: input.expectedHeadRevision + 1,
    reviewId: input.expectedReviewId,
    reviewFingerprint: input.expectedReviewFingerprint,
    rawResultId: input.rawResultId,
    rawSha256: input.rawSha256,
    labeledResultId: input.labeledResultId,
    labeledSha256: input.labeledSha256,
    packId: input.packId,
    packFingerprint: input.packFingerprint,
    plannedContinuityFingerprint: input.plannedContinuityFingerprint,
    observedState: input.observedState,
    observer: input.observer,
    note: input.note,
  };
}

function assertReviewMatchesInput(
  review: StudioGenerationReviewProjection | undefined,
  input: ReturnType<typeof normalizedInput>,
): StudioGenerationReviewProjection {
  if (!review || review.reviewId !== input.expectedReviewId
    || review.fingerprint !== input.expectedReviewFingerprint) {
    fail("review-drift", "当前 Review Head 与显式绑定的 PASS Review 不一致。");
  }
  if (!review.current || !review.approvedRawEligible || review.decision !== "pass") {
    fail("review-ineligible", "只有 current 且 approvedRawEligible 的 PASS Review 才能记录实际末态。");
  }
  if (review.generationRunId !== input.generationRunId
    || review.rawResultId !== input.rawResultId
    || review.rawSha256 !== input.rawSha256
    || review.labeledResultId !== input.labeledResultId
    || review.labeledSha256 !== input.labeledSha256
    || review.packId !== input.packId
    || review.packFingerprint !== input.packFingerprint
    || review.continuityFingerprint !== input.plannedContinuityFingerprint) {
    fail("review-drift", "实际末态输入与当前 PASS Review 的结果/冻结包身份不一致。");
  }
  return review;
}

async function assertCurrentPassReview(
  projectRoot: string,
  input: ReturnType<typeof normalizedInput>,
): Promise<StudioGenerationReviewProjection> {
  const control = await getStudioGenerationReviewControl(projectRoot, input.generationRunId);
  if (control.status !== "pass" || !control.head || !control.head.approvedRawEligible) {
    fail("review-ineligible", "当前 generation run 没有可承接的 PASS Review。", control.blockers);
  }
  return assertReviewMatchesInput(control.head, input);
}

function assertResultIdentity(
  result: StudioGenerationResultRecord | null,
  variant: "raw" | "labeled",
  input: ReturnType<typeof normalizedInput>,
): StudioGenerationResultRecord {
  const resultId = variant === "raw" ? input.rawResultId : input.labeledResultId;
  const sha256 = variant === "raw" ? input.rawSha256 : input.labeledSha256;
  if (!result || result.variant !== variant || result.resultId !== resultId
    || result.mediaSha256 !== sha256 || result.generationRunId !== input.generationRunId
    || result.packId !== input.packId || result.packFingerprint !== input.packFingerprint
    || !result.pairComplete || !result.inputCurrent || !result.promotionEligible) {
    fail("review-drift", `${variant} 结果不再是 Review 批准的 current/promotionEligible 结果。`);
  }
  return result;
}

async function assertFrozenPackIdentity(
  projectRoot: string,
  raw: StudioGenerationResultRecord,
  input: Pick<
    ReturnType<typeof normalizedInput>,
    "packId" | "packFingerprint" | "plannedContinuityFingerprint"
  >,
): Promise<void> {
  if (raw.targetKind === "unit-grid") {
    const pack = await readStudioUnitGridGenerationFrozenPack(projectRoot, input.packId);
    if (!pack || pack.fingerprint !== input.packFingerprint
      || pack.continuityFingerprint !== input.plannedContinuityFingerprint) {
      fail("review-drift", "unit-grid 冻结包或计划连续性指纹已漂移。");
    }
    return;
  }
  const pack = await readStudioGenerationFrozenPack(projectRoot, input.packId);
  if (!pack || pack.fingerprint !== input.packFingerprint
    || pack.continuity.fingerprint !== input.plannedContinuityFingerprint) {
    fail("review-drift", "panel 冻结包或计划连续性指纹已漂移。");
  }
}

async function assertEvidenceIdentity(
  projectRoot: string,
  raw: StudioGenerationResultRecord,
  input: Pick<
    ReturnType<typeof normalizedInput>,
    | "packId"
    | "packFingerprint"
    | "evidenceKind"
    | "evidenceSha256"
    | "terminalPanelId"
    | "observedAvailability"
  >,
): Promise<void> {
  let media: EvidenceMediaIdentity;
  try {
    media = await inspectEvidenceMediaIdentity(projectRoot, input.evidenceSha256);
  } catch (error) {
    fail(
      "invalid-input",
      "实际末态证据不是当前受管素材库中可验证的 CAS 媒体。",
      [error instanceof Error ? error.message : String(error)],
    );
  }
  const expectedKind = input.evidenceKind === "reviewed-video" ? "video" : "image";
  if (media.kind !== expectedKind) {
    fail(
      "invalid-input",
      `${input.evidenceKind} 必须绑定 ${expectedKind} 媒体，实际为 ${media.kind}。`,
    );
  }
  if (input.evidenceKind === "reviewed-video") {
    let probe: Awaited<ReturnType<typeof probeStudioReviewedVideoEvidence>>;
    try {
      probe = await probeStudioReviewedVideoEvidence(projectRoot, media.objectPath);
    } catch (error) {
      fail(
        "invalid-input",
        "reviewed-video 必须是可完整解码并含有效视频流的受管视频。",
        [error instanceof Error ? error.message : String(error)],
      );
    }
    if (input.observedAvailability.audioPhase === "observed" && !probe.audio.present) {
      fail(
        "invalid-input",
        "reviewed-video 不含可验证音频流，audioPhase 不得声明为 observed。",
      );
    }
    let mediaAfter: EvidenceMediaIdentity;
    try {
      mediaAfter = await inspectEvidenceMediaIdentity(projectRoot, input.evidenceSha256);
    } catch (error) {
      fail(
        "invalid-input",
        "reviewed-video 在解码验证期间发生漂移。",
        [error instanceof Error ? error.message : String(error)],
      );
    }
    if (mediaAfter.kind !== media.kind
      || mediaAfter.sha256 !== media.sha256
      || mediaAfter.sizeBytes !== media.sizeBytes
      || mediaAfter.objectPath !== media.objectPath) {
      fail("invalid-input", "reviewed-video 在解码验证期间身份发生漂移。");
    }
  }
  if (input.evidenceKind !== "terminal-panel-crop") return;
  if (raw.targetKind !== "unit-grid") {
    fail("invalid-input", "terminal-panel-crop 只能绑定 unit-grid PASS 结果。");
  }
  const pack = await readStudioUnitGridGenerationFrozenPack(projectRoot, input.packId);
  if (!pack || pack.fingerprint !== input.packFingerprint || pack.panels.length < 1) {
    fail("review-drift", "terminal-panel-crop 无法证明当前 unit-grid 冻结包。");
  }
  const terminalPanel = [...pack.panels].sort((left, right) =>
    left.endSeconds - right.endSeconds
    || left.order - right.order
    || left.panelId.localeCompare(right.panelId, "en")).at(-1);
  if (!terminalPanel || terminalPanel.panelId !== input.terminalPanelId) {
    fail(
      "invalid-input",
      `terminalPanelId 必须是当前冻结 unit-grid 的最后一格 ${terminalPanel?.panelId ?? "缺失"}。`,
    );
  }
}

type TerminalReceiptLineageInput = Pick<
  PersistedObservationInput,
  | "generationRunId"
  | "expectedReviewId"
  | "expectedReviewFingerprint"
  | "rawResultId"
  | "rawSha256"
  | "labeledResultId"
  | "labeledSha256"
  | "packId"
  | "packFingerprint"
  | "evidenceKind"
  | "evidenceSha256"
  | "terminalPanelId"
>;

/**
 * 复用既有视频包 owner 的机械回执，把受管 CAS 末格图片绑定到当前
 * PASS raw 的冻结裁区。这里动态导入以避免
 * observation → video-package → source-adapter → observation 的静态环。
 *
 * 缺少或漂移的回执不阻止审计事件写入，只返回 undefined；下游必须因此
 * 将事件保持为 continuation-ineligible。
 */
async function resolveTrustedTerminalCropLineage(
  projectRoot: string,
  input: TerminalReceiptLineageInput,
  expectedLineage?: StudioPostResultEvidenceLineage,
): Promise<StudioPostResultEvidenceLineage | undefined> {
  if (input.evidenceKind !== "terminal-panel-crop" || !input.terminalPanelId) return undefined;
  try {
    const pack = await readStudioUnitGridGenerationFrozenPack(projectRoot, input.packId);
    if (!pack || pack.fingerprint !== input.packFingerprint) return undefined;
    const panelOffset = pack.panels.findIndex((panel) => panel.panelId === input.terminalPanelId);
    if (panelOffset < 0) return undefined;
    const filePath = `${pack.target.unitId}-G${panelOffset + 1}_raw.png`;
    const videoPackage = await import("./studio-video-package.js");
    if (expectedLineage) {
      const verified = await videoPackage.verifyStudioVideoPackageTerminalCropReceiptLineage(
        projectRoot,
        {
          ...expectedLineage,
          reviewId: input.expectedReviewId,
          reviewFingerprint: input.expectedReviewFingerprint,
          generationRunId: input.generationRunId,
          rawResultId: input.rawResultId,
          rawSha256: input.rawSha256,
          labeledResultId: input.labeledResultId,
          labeledSha256: input.labeledSha256,
          packId: input.packId,
          packFingerprint: input.packFingerprint,
          terminalPanelId: input.terminalPanelId,
          evidenceSha256: input.evidenceSha256,
        },
      );
      return verified && expectedLineage.filePath === filePath
        ? expectedLineage
        : undefined;
    }
    const discovery = await videoPackage.discoverStudioVideoPackageTerminalCropReceiptLineage(
      projectRoot,
      {
        reviewId: input.expectedReviewId,
        reviewFingerprint: input.expectedReviewFingerprint,
        generationRunId: input.generationRunId,
        rawResultId: input.rawResultId,
        rawSha256: input.rawSha256,
        labeledResultId: input.labeledResultId,
        labeledSha256: input.labeledSha256,
        packId: input.packId,
        packFingerprint: input.packFingerprint,
        terminalPanelId: input.terminalPanelId,
        evidenceSha256: input.evidenceSha256,
      },
    );
    if (discovery.status === "conflict") {
      fail(
        "invalid-input",
        "terminal-panel-crop 存在多个同权威机械回执，禁止猜测 continuation 血缘。",
        discovery.candidateIntentIds.map((intentId) => `candidateIntentId=${intentId}`),
      );
    }
    return discovery.status === "resolved"
      ? normalizedEvidenceLineage(discovery.lineage, input.evidenceSha256)
      : undefined;
  } catch (error) {
    if (error instanceof StudioPostResultObservationError) throw error;
    return undefined;
  }
}

async function assertLiveIdentity(
  projectRoot: string,
  input: ReturnType<typeof normalizedInput>,
): Promise<void> {
  assertReviewMatchesInput(await assertCurrentPassReview(projectRoot, input), input);
  const [rawValue, labeledValue] = await Promise.all([
    readStudioGenerationResult(projectRoot, input.rawResultId),
    readStudioGenerationResult(projectRoot, input.labeledResultId),
  ]);
  const raw = assertResultIdentity(rawValue, "raw", input);
  assertResultIdentity(labeledValue, "labeled", input);
  await assertFrozenPackIdentity(projectRoot, raw, input);
  await assertEvidenceIdentity(projectRoot, raw, input);
}

function addReason(reasons: string[], reason: string): void {
  if (!reasons.includes(reason)) reasons.push(reason);
}

function immutableContinuationIneligibleReasons(record: StudioPostResultObservationRecord): string[] {
  const reasons: string[] = [];
  if (record.evidenceContractVersion === 1 || !record.evidenceKind || !record.evidenceSha256) {
    addReason(reasons, "legacy-observation-without-explicit-evidence");
  }
  if (record.evidenceContractVersion === 2) {
    addReason(reasons, "legacy-v2-observation-without-full-availability-or-lineage");
  }
  if (record.evidenceContractVersion >= 2 && record.observedState.referenceSha256 !== record.evidenceSha256) {
    addReason(reasons, "observed-reference-does-not-match-evidence");
  }
  if ((record.evidenceKind === "terminal-panel-crop" || record.evidenceKind === "accepted-last-frame")
    && LEGACY_V2_OBSERVATION_AVAILABILITY_FIELDS.some((field) => record.observedAvailability[field] === "observed")) {
    addReason(reasons, "static-evidence-claims-dynamic-observation");
  }
  if (record.evidenceKind === "terminal-panel-crop") {
    if (record.evidenceContractVersion < 3 || !record.evidenceLineage) {
      addReason(reasons, "terminal-panel-crop-without-trusted-raw-derivation-receipt");
    }
  } else if (record.evidenceContractVersion === 3
    && (record.evidenceKind === "accepted-last-frame" || record.evidenceKind === "reviewed-video")) {
    addReason(reasons, `${record.evidenceKind}-without-specialized-lineage-receipt`);
  }
  if (record.evidenceContractVersion >= 4 && record.continuitySnapshot) {
    for (const gap of nextShotContinuityContinuationGaps(record.continuitySnapshot)) {
      addReason(reasons, `structured-continuity-unknown:${gap}`);
    }
  }
  return reasons.sort((left, right) => left.localeCompare(right, "en"));
}

async function projectObservation(
  projectRoot: string,
  record: StudioPostResultObservationRecord,
): Promise<StudioPostResultObservationProjection> {
  const read = await openObservationReadSnapshot(projectRoot, "post-result observation projection");
  if (!read.snapshot) fail("storage-invalid", "实际末态事件存在但观察 schema 不可读。");
  let head: HeadRow | undefined;
  try {
    head = headRow(read.snapshot.database, record.generationRunId);
  } finally {
    await read.snapshot.close();
  }
  const reasons: string[] = [];
  let headCurrent = Boolean(head
    && head.observation_id === record.observationId
    && head.observation_fingerprint === record.fingerprint
    && Number(head.revision) === record.headRevision);
  if (!headCurrent) addReason(reasons, "not-current-observation-head");

  let review: StudioGenerationReviewProjection | undefined;
  try {
    const control = await getStudioGenerationReviewControl(projectRoot, record.generationRunId);
    review = control.head;
    if (control.status !== "pass" || !review?.approvedRawEligible) {
      addReason(reasons, "review-not-current-pass");
    }
  } catch {
    addReason(reasons, "review-currentness-unavailable");
  }
  if (!review || review.reviewId !== record.reviewId || review.fingerprint !== record.reviewFingerprint) {
    addReason(reasons, "review-head-drift");
  } else if (review.rawResultId !== record.rawResultId || review.rawSha256 !== record.rawSha256
    || review.labeledResultId !== record.labeledResultId || review.labeledSha256 !== record.labeledSha256
    || review.packId !== record.packId || review.packFingerprint !== record.packFingerprint
    || review.continuityFingerprint !== record.plannedContinuityFingerprint) {
    addReason(reasons, "review-identity-drift");
  }

  const settled = await Promise.allSettled([
    readStudioGenerationResult(projectRoot, record.rawResultId),
    readStudioGenerationResult(projectRoot, record.labeledResultId),
  ]);
  const raw = settled[0]!.status === "fulfilled" ? settled[0]!.value : null;
  const labeled = settled[1]!.status === "fulfilled" ? settled[1]!.value : null;
  if (settled[0]!.status === "rejected") addReason(reasons, "raw-currentness-unavailable");
  if (settled[1]!.status === "rejected") addReason(reasons, "labeled-currentness-unavailable");
  if (!raw || raw.variant !== "raw" || raw.mediaSha256 !== record.rawSha256
    || raw.packId !== record.packId || raw.packFingerprint !== record.packFingerprint
    || !raw.pairComplete || !raw.inputCurrent || !raw.promotionEligible) {
    addReason(reasons, "raw-result-drift");
  }
  if (!labeled || labeled.variant !== "labeled" || labeled.mediaSha256 !== record.labeledSha256
    || labeled.packId !== record.packId || labeled.packFingerprint !== record.packFingerprint
    || !labeled.pairComplete || !labeled.inputCurrent || !labeled.promotionEligible) {
    addReason(reasons, "labeled-result-drift");
  }
  if (record.evidenceContractVersion >= 2
    && record.observedState.referenceSha256 !== record.evidenceSha256) {
    addReason(reasons, "observed-reference-drift");
  }
  if (raw) {
    try {
      await assertFrozenPackIdentity(projectRoot, raw, {
        packId: record.packId,
        packFingerprint: record.packFingerprint,
        plannedContinuityFingerprint: record.plannedContinuityFingerprint,
      });
    } catch {
      addReason(reasons, "pack-or-planned-continuity-drift");
    }
    if (record.evidenceContractVersion >= 2
      && record.evidenceKind
      && record.evidenceSha256) {
      try {
        await assertEvidenceIdentity(projectRoot, raw, {
          packId: record.packId,
          packFingerprint: record.packFingerprint,
          evidenceKind: record.evidenceKind,
          evidenceSha256: record.evidenceSha256,
          ...(record.terminalPanelId ? { terminalPanelId: record.terminalPanelId } : {}),
          observedAvailability: record.observedAvailability,
        });
      } catch {
        addReason(reasons, "evidence-media-or-terminal-panel-drift");
      }
    }
    if (record.evidenceContractVersion >= 3
      && record.evidenceKind === "terminal-panel-crop"
      && record.evidenceLineage
      && record.evidenceSha256) {
      const currentLineage = await resolveTrustedTerminalCropLineage(projectRoot, {
        generationRunId: record.generationRunId,
        expectedReviewId: record.reviewId,
        expectedReviewFingerprint: record.reviewFingerprint,
        rawResultId: record.rawResultId,
        rawSha256: record.rawSha256,
        labeledResultId: record.labeledResultId,
        labeledSha256: record.labeledSha256,
        packId: record.packId,
        packFingerprint: record.packFingerprint,
        evidenceKind: record.evidenceKind,
        evidenceSha256: record.evidenceSha256,
        terminalPanelId: record.terminalPanelId,
      }, record.evidenceLineage);
      if (!currentLineage || digest(currentLineage) !== digest(record.evidenceLineage)) {
        addReason(reasons, "terminal-crop-lineage-drift");
      }
    }
  }
  // 上面的媒体/冻结包核验可能耗时；返回 current 前必须复读两个可变 head，
  // 防止并发 Review correction 或新 observation 让旧投影短暂冒充 current。
  try {
    const finalRead = await openObservationReadSnapshot(projectRoot, "post-result observation final currentness");
    let finalHead: HeadRow | undefined;
    if (finalRead.snapshot) {
      try {
        finalHead = headRow(finalRead.snapshot.database, record.generationRunId);
      } finally {
        await finalRead.snapshot.close();
      }
    }
    if (!finalHead
      || finalHead.observation_id !== record.observationId
      || finalHead.observation_fingerprint !== record.fingerprint
      || Number(finalHead.revision) !== record.headRevision) {
      headCurrent = false;
      addReason(reasons, "observation-head-changed-during-validation");
    }
  } catch {
    headCurrent = false;
    addReason(reasons, "observation-head-final-check-unavailable");
  }
  try {
    const finalReview = await getStudioGenerationReviewControl(projectRoot, record.generationRunId);
    if (finalReview.status !== "pass"
      || !finalReview.head?.approvedRawEligible
      || finalReview.head.reviewId !== record.reviewId
      || finalReview.head.fingerprint !== record.reviewFingerprint) {
      addReason(reasons, "review-head-changed-during-validation");
    }
  } catch {
    addReason(reasons, "review-head-final-check-unavailable");
  }
  const currentStaleReasons = reasons.sort((left, right) => left.localeCompare(right, "en"));
  const current = headCurrent && currentStaleReasons.length === 0;
  const continuationIneligibleReasons = immutableContinuationIneligibleReasons(record);
  const observedState: StudioPostResultObservedActualState = {
    referenceSha256: record.observedState.referenceSha256,
  };
  for (const field of OBSERVATION_AVAILABILITY_FIELDS) {
    if (record.observedAvailability[field] === "observed") {
      observedState[field] = record.observedState[field];
    }
  }
  return {
    ...record,
    observedState,
    head: headCurrent,
    current,
    continuationEligible: current && continuationIneligibleReasons.length === 0,
    currentStaleReasons,
    continuationIneligibleReasons,
  };
}

function assertTransactionalReviewAndResults(
  db: DatabaseSync,
  input: ReturnType<typeof normalizedInput>,
): void {
  const reviewHead = db.prepare(`
    SELECT review_id,review_fingerprint FROM studio_generation_review_heads WHERE generation_run_id=?
  `).get(input.generationRunId) as { review_id?: string; review_fingerprint?: string } | undefined;
  if (reviewHead?.review_id !== input.expectedReviewId
    || reviewHead.review_fingerprint !== input.expectedReviewFingerprint) {
    fail("review-drift", "提交事务内 Review Head 已漂移。");
  }
  const review = db.prepare(`
    SELECT generation_run_id,raw_result_id,raw_sha256,labeled_result_id,labeled_sha256,
           pack_id,pack_fingerprint,continuity_fingerprint,decision,current_at_submission,advances_head,fingerprint
    FROM studio_generation_review_events WHERE review_id=?
  `).get(input.expectedReviewId) as Record<string, unknown> | undefined;
  if (!review || review.generation_run_id !== input.generationRunId
    || review.raw_result_id !== input.rawResultId || review.raw_sha256 !== input.rawSha256
    || review.labeled_result_id !== input.labeledResultId || review.labeled_sha256 !== input.labeledSha256
    || review.pack_id !== input.packId || review.pack_fingerprint !== input.packFingerprint
    || review.continuity_fingerprint !== input.plannedContinuityFingerprint
    || review.decision !== "pass" || Number(review.current_at_submission) !== 1
    || Number(review.advances_head) !== 1 || review.fingerprint !== input.expectedReviewFingerprint) {
    fail("review-drift", "提交事务内 PASS Review 身份已漂移。");
  }
  const results = db.prepare(`
    SELECT result_id,variant,media_sha256,pack_id,pack_fingerprint
    FROM studio_generation_results WHERE generation_run_id=?
  `).all(input.generationRunId) as Array<Record<string, unknown>>;
  if (results.length !== 2
    || !results.some((row) => row.result_id === input.rawResultId && row.variant === "raw"
      && row.media_sha256 === input.rawSha256 && row.pack_id === input.packId
      && row.pack_fingerprint === input.packFingerprint)
    || !results.some((row) => row.result_id === input.labeledResultId && row.variant === "labeled"
      && row.media_sha256 === input.labeledSha256 && row.pack_id === input.packId
      && row.pack_fingerprint === input.packFingerprint)) {
    fail("review-drift", "提交事务内 raw/labeled 结果身份已漂移。");
  }
}

export async function submitStudioPostResultObservation(
  projectRoot: string,
  rawInput: SubmitStudioPostResultObservationInput,
): Promise<StudioPostResultObservationProjection> {
  const input = normalizedInput(rawInput);
  const inputFingerprint = digest({
    schemaVersion: input.continuitySnapshot ? 4 : 3,
    command: "submit-studio-post-result-observation",
    ...input,
  });
  const context = await databaseContextFor(projectRoot);
  const preflightDb = openDatabase(context);
  try {
    const receipt = operationRow(preflightDb, input.operationId);
    if (receipt) {
      if (receipt.input_fingerprint !== inputFingerprint) {
        fail("operation-conflict", `operationId ${input.operationId} 已绑定不同载荷。`);
      }
      const existing = observationRow(preflightDb, receipt.observation_id);
      if (!existing || existing.fingerprint !== receipt.outcome_fingerprint) {
        fail("storage-invalid", `operationId ${input.operationId} 引用孤儿或漂移的实际末态事件。`);
      }
      return projectObservation(projectRoot, recordFromRow(existing));
    }
  } finally {
    preflightDb.close();
  }

  await assertLiveIdentity(projectRoot, input);
  // 第二次读取缩小 Review/结果在预检与写入间漂移的窗口；事务内再核对 Review Head 与结果行。
  await assertLiveIdentity(projectRoot, input);

  const evidenceLineage = await resolveTrustedTerminalCropLineage(projectRoot, input);
  const persistedInput: PersistedObservationInput = {
    ...input,
    ...(evidenceLineage ? { evidenceLineage } : {}),
  };
  const semantic = observationSemantic(persistedInput);
  const fingerprint = digest(semantic);
  const observationId = `studio-post-result-observation-${fingerprint.slice(0, 40)}`;
  const db = openDatabase(context);
  let written: ObservationRow;
  try {
    written = transaction(db, () => {
      const receipt = operationRow(db, input.operationId);
      if (receipt) {
        if (receipt.input_fingerprint !== inputFingerprint) {
          fail("operation-conflict", `operationId ${input.operationId} 已绑定不同载荷。`);
        }
        const replay = observationRow(db, receipt.observation_id);
        if (!replay || replay.fingerprint !== receipt.outcome_fingerprint) {
          fail("storage-invalid", "实际末态 operation receipt 引用孤儿或漂移事件。");
        }
        return replay;
      }
      const head = headRow(db, input.generationRunId);
      const actualRevision = Number(head?.revision ?? 0);
      if (actualRevision !== input.expectedHeadRevision) {
        fail(
          "observation-conflict",
          `实际末态 Head CAS 冲突：期望 ${input.expectedHeadRevision}，当前 ${actualRevision}。`,
        );
      }
      assertTransactionalReviewAndResults(db, input);
      if (observationRow(db, observationId)) {
        fail("storage-invalid", "内容寻址实际末态事件已存在但缺少 operation receipt。");
      }
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO studio_post_result_observation_events(
          observation_id,generation_run_id,base_head_revision,head_revision,review_id,review_fingerprint,
          raw_result_id,raw_sha256,labeled_result_id,labeled_sha256,pack_id,pack_fingerprint,
          planned_continuity_fingerprint,observed_state_json,observer,note,fingerprint,created_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        observationId, input.generationRunId, input.expectedHeadRevision, input.expectedHeadRevision + 1,
        input.expectedReviewId, input.expectedReviewFingerprint,
        input.rawResultId, input.rawSha256, input.labeledResultId, input.labeledSha256,
        input.packId, input.packFingerprint, input.plannedContinuityFingerprint,
        encodedObservedState(persistedInput), input.observer, input.note, fingerprint, now,
      );
      if (!head) {
        db.prepare(`
          INSERT INTO studio_post_result_observation_heads(
            generation_run_id,revision,observation_id,observation_fingerprint,updated_at
          ) VALUES(?,?,?,?,?)
        `).run(input.generationRunId, 1, observationId, fingerprint, now);
      } else {
        const changed = db.prepare(`
          UPDATE studio_post_result_observation_heads
          SET revision=?,observation_id=?,observation_fingerprint=?,updated_at=?
          WHERE generation_run_id=? AND revision=? AND observation_id=?
        `).run(
          head.revision + 1,
          observationId,
          fingerprint,
          now,
          input.generationRunId,
          head.revision,
          head.observation_id,
        );
        if (Number(changed.changes) !== 1) {
          fail("observation-conflict", "实际末态 Head 在事务内发生 CAS 漂移。");
        }
      }
      db.prepare(`
        INSERT INTO studio_post_result_observation_operation_receipts(
          operation_id,input_fingerprint,observation_id,outcome_fingerprint,created_at
        ) VALUES(?,?,?,?,?)
      `).run(input.operationId, inputFingerprint, observationId, fingerprint, now);
      const result = observationRow(db, observationId);
      if (!result) fail("storage-invalid", "实际末态事件写入后无法读回。");
      return result;
    });
  } finally {
    db.close();
  }
  return projectObservation(projectRoot, recordFromRow(written));
}

export async function readStudioPostResultObservation(
  projectRoot: string,
  observationIdValue: string,
): Promise<StudioPostResultObservationProjection | null> {
  const observationId = normalizedId(observationIdValue, "observationId");
  const read = await openObservationReadSnapshot(projectRoot, "post-result observation read");
  if (!read.snapshot) return null;
  let row: ObservationRow | undefined;
  try {
    row = observationRow(read.snapshot.database, observationId);
  } finally {
    await read.snapshot.close();
  }
  return row ? projectObservation(projectRoot, recordFromRow(row)) : null;
}

/**
 * @deprecated 仅供 legacy diagnostic。该 API 会投影动态 Review/result/media
 * currentness，不能作为 command replay/reconcile proof；命令总线必须使用严格
 * 只读 operation record reader。
 */
export async function readStudioPostResultObservationOutcomeByOperationId(
  projectRoot: string,
  operationIdValue: string,
): Promise<StudioPostResultObservationProjection | null> {
  const operationId = normalizedId(operationIdValue, "operationId");
  const read = await openObservationReadSnapshot(projectRoot, "post-result observation outcome read");
  if (!read.snapshot) return null;
  let receipt: OperationRow | undefined;
  let row: ObservationRow | undefined;
  try {
    receipt = operationRow(read.snapshot.database, operationId);
    if (receipt) row = observationRow(read.snapshot.database, receipt.observation_id);
  } finally {
    await read.snapshot.close();
  }
  if (!receipt) return null;
  if (!row
    || row.fingerprint !== receipt.outcome_fingerprint
    || row.observation_id !== receipt.observation_id) {
    fail("storage-invalid", `operationId ${operationId} 引用孤儿或漂移的实际末态事件。`);
  }
  return projectObservation(projectRoot, recordFromRow(row));
}

/**
 * 命令公开重放专用严格只读记录。immutable observation/receipt/head 保持完整；
 * current/continuation 授权稳定 fail-closed，不调用 Review control、result、media、
 * production 或任何可能初始化 owner 的路径。
 */
export async function readStudioPostResultObservationOperationRecordReadOnly(
  projectRoot: string,
  operationIdValue: string,
): Promise<StudioPostResultObservationProjection | null> {
  const operationId = normalizedId(operationIdValue, "operationId");
  return withStudioGenerationLedgerReadOnlySnapshot(projectRoot, "post-result observation immutable operation record", (db) => {
    assertBaseSchema(db);
    assertSchema(db);
    const receipt = operationRow(db, operationId);
    if (!receipt) return null;
    const row = observationRow(db, receipt.observation_id);
    if (!row) fail("storage-invalid", `operationId ${operationId} 引用孤儿实际末态事件。`);
    const record = recordFromRow(row);
    if (receipt.operation_id !== operationId
      || !SHA256_PATTERN.test(receipt.input_fingerprint)
      || receipt.outcome_fingerprint !== record.fingerprint
      || receipt.observation_id !== record.observationId
      || !isCanonicalIsoTimestamp(receipt.created_at)) {
      fail("storage-invalid", `operationId ${operationId} 的 input/outcome 内容身份漂移。`);
    }
    if (record.evidenceContractVersion < 3) {
      fail("storage-invalid", `operationId ${operationId} 的 legacy v${record.evidenceContractVersion} 输入无法由当前 operation receipt 完整重建。`);
    } else {
      const reconstructedInput = {
        operationId,
        generationRunId: record.generationRunId,
        expectedHeadRevision: record.baseHeadRevision,
        expectedReviewId: record.reviewId,
        expectedReviewFingerprint: record.reviewFingerprint,
        rawResultId: record.rawResultId,
        rawSha256: record.rawSha256,
        labeledResultId: record.labeledResultId,
        labeledSha256: record.labeledSha256,
        packId: record.packId,
        packFingerprint: record.packFingerprint,
        plannedContinuityFingerprint: record.plannedContinuityFingerprint,
        evidenceKind: record.evidenceKind!,
        evidenceSha256: record.evidenceSha256!,
        ...(record.terminalPanelId ? { terminalPanelId: record.terminalPanelId } : {}),
        observedState: record.observedState,
        observedAvailability: record.observedAvailability,
        ...(record.continuitySnapshot ? { continuitySnapshot: record.continuitySnapshot } : {}),
        observer: record.observer,
        note: record.note,
      };
      const expectedInputFingerprint = digest({
        schemaVersion: record.continuitySnapshot ? 4 : 3,
        command: "submit-studio-post-result-observation",
        ...reconstructedInput,
      });
      if (receipt.input_fingerprint !== expectedInputFingerprint) {
        fail("storage-invalid", `operationId ${operationId} 的 inputFingerprint 无法由 immutable event 重建。`);
      }
    }
    const head = headRow(db, record.generationRunId);
    const headCurrent = Boolean(head
      && head.observation_id === record.observationId
      && head.observation_fingerprint === record.fingerprint
      && Number(head.revision) === record.headRevision);
    const observedState: StudioPostResultObservedActualState = { referenceSha256: record.observedState.referenceSha256 };
    for (const field of OBSERVATION_AVAILABILITY_FIELDS) {
      if (record.observedAvailability[field] === "observed") observedState[field] = record.observedState[field];
    }
    return {
      ...record,
      observedState,
      head: headCurrent,
      current: false,
      continuationEligible: false,
      currentStaleReasons: [
        ...(!headCurrent ? ["not-current-observation-head"] : []),
        "strict-recovery-currentness-not-proven",
      ],
      continuationIneligibleReasons: immutableContinuationIneligibleReasons(record),
    };
  });
}

/**
 * 命令恢复专用证明：同时核对 immutable operation receipt 的完整原始输入
 * 指纹，再返回只含 observed actual fields 的公开投影。这样既不泄漏审计文本，
 * 也不因公开投影过滤 unknown 字段而丢失精确幂等证明。
 */
export async function proveStudioPostResultObservationOutcome(
  projectRoot: string,
  rawInput: SubmitStudioPostResultObservationInput,
): Promise<StudioPostResultObservationProjection | null> {
  const input = normalizedInput(rawInput);
  const inputFingerprint = digest({
    schemaVersion: input.continuitySnapshot ? 4 : 3,
    command: "submit-studio-post-result-observation",
    ...input,
  });
  const read = await openObservationReadSnapshot(projectRoot, "post-result observation outcome proof");
  if (!read.snapshot) return null;
  let receipt: OperationRow | undefined;
  let row: ObservationRow | undefined;
  try {
    receipt = operationRow(read.snapshot.database, input.operationId);
    if (receipt?.input_fingerprint === inputFingerprint) {
      row = observationRow(read.snapshot.database, receipt.observation_id);
    }
  } finally {
    await read.snapshot.close();
  }
  if (!receipt || receipt.input_fingerprint !== inputFingerprint) return null;
  if (!row
    || row.fingerprint !== receipt.outcome_fingerprint
    || row.observation_id !== receipt.observation_id) {
    fail("storage-invalid", `operationId ${input.operationId} 引用孤儿或漂移的实际末态事件。`);
  }
  return projectObservation(projectRoot, recordFromRow(row));
}

export async function getStudioPostResultObservationControl(
  projectRoot: string,
  generationRunIdValue: string,
): Promise<StudioPostResultObservationControl> {
  const generationRunId = normalizedId(generationRunIdValue, "generationRunId");
  // get/read 只能读取既有 schema。首次建表属于 submit 命令的写职责，不能借
  // Electron 的 get-* 只读通道绕过 runtime write gate。
  const read = await openObservationReadSnapshot(projectRoot, "post-result observation control");
  let head: HeadRow | undefined;
  let row: ObservationRow | undefined;
  if (read.snapshot) {
    try {
      head = headRow(read.snapshot.database, generationRunId);
      if (head) row = observationRow(read.snapshot.database, head.observation_id);
    } finally {
      await read.snapshot.close();
    }
  }
  if (head && !row) fail("storage-invalid", "实际末态 Head 引用孤儿事件。");
  const projection = row ? await projectObservation(projectRoot, recordFromRow(row)) : undefined;
  const finalReviewHook = afterProjectionBeforeFinalReviewHookForTests;
  afterProjectionBeforeFinalReviewHookForTests = undefined;
  if (finalReviewHook) await finalReviewHook();
  let finalObservationHead = head;
  let observationHeadStable = true;
  let observationHeadBlockers: string[] = [];
  try {
    const finalObservationRead = await openObservationReadSnapshot(
      projectRoot,
      "post-result observation control final head",
    );
    try {
      finalObservationHead = finalObservationRead.snapshot
        ? headRow(finalObservationRead.snapshot.database, generationRunId)
        : undefined;
    } finally {
      await finalObservationRead.snapshot?.close();
    }
    observationHeadStable = (head?.observation_id ?? null)
        === (finalObservationHead?.observation_id ?? null)
      && (head?.observation_fingerprint ?? null)
        === (finalObservationHead?.observation_fingerprint ?? null)
      && Number(head?.revision ?? 0) === Number(finalObservationHead?.revision ?? 0);
    if (!observationHeadStable) {
      observationHeadBlockers = ["observation-head-changed-after-projection"];
    }
  } catch {
    observationHeadStable = false;
    observationHeadBlockers = ["observation-head-final-check-unavailable"];
  }
  let reviewEligible = false;
  let reviewBlockers: string[] = [];
  if (read.reviewSchemaPresent) {
    try {
      const review = await getStudioGenerationReviewControl(projectRoot, generationRunId);
      reviewEligible = review.status === "pass" && Boolean(review.head?.approvedRawEligible);
      reviewBlockers = reviewEligible ? [] : review.blockers.length > 0 ? review.blockers : ["review-not-current-pass"];
    } catch {
      reviewBlockers = ["review-currentness-unavailable"];
    }
  } else {
    reviewBlockers = ["review-schema-not-initialized"];
  }
  const projectionUsable = Boolean(
    observationHeadStable && projection?.continuationEligible && reviewEligible,
  );
  const status: StudioPostResultObservationControl["status"] = !observationHeadStable
    ? "stale"
    : !projection ? "missing"
    : projectionUsable ? "current" : "stale";
  const blockers = projection
    ? [...new Set([
        ...projection.currentStaleReasons,
        ...projection.continuationIneligibleReasons,
        ...observationHeadBlockers,
        ...(reviewEligible ? [] : reviewBlockers),
      ])]
      .sort((left, right) => left.localeCompare(right, "en"))
    : [...new Set([
        ...observationHeadBlockers,
        ...(reviewEligible ? [] : reviewBlockers),
      ])].sort((left, right) => left.localeCompare(right, "en"));
  const nextAction: StudioPostResultObservationControl["nextAction"] = projectionUsable
    ? "use-observed-end-state"
    : projection || !observationHeadStable ? "reobserve-current-pass-result"
      : reviewEligible ? "submit-observed-end-state"
        : "wait-for-current-pass-review";
  const semantic = {
    schemaVersion: 1 as const,
    kind: "studio-post-result-observation-control" as const,
    generationRunId,
    headRevision: Number(finalObservationHead?.revision ?? head?.revision ?? 0),
    ...(projection ? { head: projection } : {}),
    status,
    blockers,
    nextAction,
  };
  return { ...semantic, fingerprint: digest(semantic) };
}
