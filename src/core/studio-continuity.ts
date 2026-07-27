import { createHash } from "node:crypto";

export const STUDIO_CONTINUITY_FIELDS = [
  "costume",
  "injury",
  "heldObject",
  "position",
  "facing",
  "emotion",
  "layout",
  "lighting",
  "referenceSha256",
] as const;

export const STUDIO_CONTINUITY_UNIT_DURATION_MILLISECONDS = 15_000 as const;

export type StudioContinuityField = (typeof STUDIO_CONTINUITY_FIELDS)[number];
export type StudioContinuityScopeKind = "panel" | "source-shot";
export type StudioContinuityEntryKind = "observation" | "correction";
export type StudioContinuityStateStatus = "resolved" | "unresolved" | "not-applicable";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const STABLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/u;
const MAX_TEXT_LENGTH = 10_000;

export interface StudioContinuityScopeAnchorInput {
  kind: StudioContinuityScopeKind;
  scopeId: string;
  unitId: string;
  unitRevision: number;
}

export interface StudioContinuityScopeAnchor extends StudioContinuityScopeAnchorInput {
  fingerprint: string;
}

export interface StudioContinuityScopeInput extends StudioContinuityScopeAnchorInput {
  /** 单元内毫秒；半开区间 [startMilliseconds, endMilliseconds)。 */
  startMilliseconds: number;
  endMilliseconds: number;
}

export interface StudioContinuityScope extends StudioContinuityScopeInput {
  fingerprint: string;
}

export interface StudioContinuityProvenanceInput {
  kind: string;
  reference: string;
  sourceFingerprint?: string;
  note?: string;
  fingerprint?: string;
}

export interface StudioContinuityProvenance {
  kind: string;
  reference: string;
  sourceFingerprint?: string;
  note?: string;
  fingerprint: string;
}

export type StudioContinuityFieldStateInput =
  | {
      status: "resolved";
      value: string;
      provenance: StudioContinuityProvenanceInput[];
    }
  | {
      status: "unresolved" | "not-applicable";
      reason: string;
      provenance: StudioContinuityProvenanceInput[];
    };

export type StudioContinuityFieldState =
  | {
      status: "resolved";
      value: string;
      provenance: StudioContinuityProvenance[];
      fingerprint: string;
    }
  | {
      status: "unresolved" | "not-applicable";
      reason: string;
      provenance: StudioContinuityProvenance[];
      fingerprint: string;
    };

export interface StudioContinuityEntryDraftInput {
  entryKind: StudioContinuityEntryKind;
  scope: StudioContinuityScopeInput;
  subjectId: string;
  field: StudioContinuityField;
  state: StudioContinuityFieldStateInput;
  supersedesEntryId?: string;
  resolvesConflictIds?: string[];
}

export interface StudioContinuityEntryDraft {
  schemaVersion: 1;
  kind: "studio-continuity-entry";
  entryKind: StudioContinuityEntryKind;
  id: string;
  fingerprint: string;
  headKey: string;
  scope: StudioContinuityScope;
  subjectId: string;
  field: StudioContinuityField;
  state: StudioContinuityFieldState;
  supersedesEntryId?: string;
  resolvesConflictIds: string[];
}

export interface StudioContinuityEntry extends StudioContinuityEntryDraft {
  sequence: number;
  createdAt: string;
}

export interface StudioContinuityHead {
  headKey: string;
  revision: number;
  entry: StudioContinuityEntry;
  updatedAt: string;
}

export interface StudioContinuityConflict {
  schemaVersion: 1;
  kind: "studio-continuity-conflict";
  id: string;
  fingerprint: string;
  revision: number;
  status: "open" | "resolved";
  scopeAnchor: StudioContinuityScopeAnchor;
  subjectId: string;
  field: StudioContinuityField;
  overlapStartMilliseconds: number;
  overlapEndMilliseconds: number;
  leftEntry: StudioContinuityEntry;
  rightEntry: StudioContinuityEntry;
  resolutionId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface StudioContinuityCurrentSpan {
  headKey: string;
  headRevision: number;
  entry: StudioContinuityEntry;
  openConflictIds: string[];
}

export interface StudioContinuityTimeline {
  schemaVersion: 1;
  kind: "studio-continuity-timeline";
  scopeAnchor: StudioContinuityScopeAnchor;
  subjectId?: string;
  field?: StudioContinuityField;
  items: StudioContinuityCurrentSpan[];
  openConflicts: StudioContinuityConflict[];
  fingerprint: string;
}

export type StudioContinuityBlockerCode =
  | "required-state-missing"
  | "required-state-gap"
  | "required-state-unresolved"
  | "required-state-conflict"
  | "undetected-overlap-conflict";

export interface StudioContinuityBlocker {
  code: StudioContinuityBlockerCode;
  field: StudioContinuityField;
  message: string;
  startMilliseconds?: number;
  endMilliseconds?: number;
  entryId?: string;
  conflictId?: string;
}

export interface StudioContinuityReadiness {
  schemaVersion: 1;
  kind: "studio-continuity-readiness";
  scope: StudioContinuityScope;
  subjectId: string;
  requiredFields: StudioContinuityField[];
  ready: boolean;
  blockers: StudioContinuityBlocker[];
  currentEntryIds: string[];
  openConflictIds: string[];
  fingerprint: string;
}

export function studioContinuityStableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(studioContinuityStableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([key, entry]) => [key, studioContinuityStableValue(entry)]));
}

export function studioContinuityDigest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(studioContinuityStableValue(value)), "utf8")
    .digest("hex");
}

function requiredText(value: unknown, label: string, maximum = MAX_TEXT_LENGTH): string {
  if (typeof value !== "string") throw new Error(`${label} 必须是字符串。`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) throw new Error(`${label} 必须是 1-${maximum} 个字符。`);
  return normalized;
}

export function normalizeStudioContinuityStableId(value: unknown, label: string): string {
  const normalized = requiredText(value, label, 255);
  if (!STABLE_ID_PATTERN.test(normalized)) {
    throw new Error(`${label} 只能使用稳定字母、数字、点、下划线、冒号或连字符。`);
  }
  return normalized;
}

export function normalizeStudioContinuityField(value: unknown): StudioContinuityField {
  if (typeof value !== "string" || !STUDIO_CONTINUITY_FIELDS.includes(value as StudioContinuityField)) {
    throw new Error(`连续性 field 必须是固定九字段之一：${STUDIO_CONTINUITY_FIELDS.join("、")}。`);
  }
  return value as StudioContinuityField;
}

export function normalizeStudioContinuityScopeAnchor(
  input: StudioContinuityScopeAnchorInput,
): StudioContinuityScopeAnchor {
  if (!input || typeof input !== "object") throw new Error("continuity scope anchor 结构无效。");
  if (input.kind !== "panel" && input.kind !== "source-shot") {
    throw new Error("continuity scope kind 必须是 panel 或 source-shot。");
  }
  const semantic: StudioContinuityScopeAnchorInput = {
    kind: input.kind,
    scopeId: normalizeStudioContinuityStableId(input.scopeId, "scopeId"),
    unitId: normalizeStudioContinuityStableId(input.unitId, "unitId"),
    unitRevision: input.unitRevision,
  };
  if (!Number.isSafeInteger(semantic.unitRevision) || semantic.unitRevision < 1) {
    throw new Error("scope unitRevision 必须是正整数。");
  }
  return { ...semantic, fingerprint: studioContinuityDigest(semantic) };
}

export function normalizeStudioContinuityScope(input: StudioContinuityScopeInput): StudioContinuityScope {
  const anchor = normalizeStudioContinuityScopeAnchor(input);
  if (!Number.isSafeInteger(input.startMilliseconds)
    || !Number.isSafeInteger(input.endMilliseconds)
    || input.startMilliseconds < 0
    || input.endMilliseconds <= input.startMilliseconds
    || input.endMilliseconds > STUDIO_CONTINUITY_UNIT_DURATION_MILLISECONDS) {
    throw new Error("continuity scope 必须是单元内 0..15000 的有效半开毫秒区间。");
  }
  const semantic: StudioContinuityScopeInput = {
    kind: anchor.kind,
    scopeId: anchor.scopeId,
    unitId: anchor.unitId,
    unitRevision: anchor.unitRevision,
    startMilliseconds: input.startMilliseconds,
    endMilliseconds: input.endMilliseconds,
  };
  return { ...semantic, fingerprint: studioContinuityDigest(semantic) };
}

function normalizeProvenance(input: StudioContinuityProvenanceInput[]): StudioContinuityProvenance[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > 100) {
    throw new Error("continuity state 必须携带 1-100 条 provenance。 ");
  }
  const normalized = input.map((item, index): StudioContinuityProvenance => {
    if (!item || typeof item !== "object") throw new Error(`provenance[${index}] 结构无效。`);
    const semantic = {
      kind: requiredText(item.kind, `provenance[${index}].kind`, 200),
      reference: requiredText(item.reference, `provenance[${index}].reference`, 4_096),
      ...(item.sourceFingerprint === undefined ? {} : {
        sourceFingerprint: requiredText(item.sourceFingerprint, `provenance[${index}].sourceFingerprint`, 500),
      }),
      ...(item.note === undefined || !item.note.trim() ? {} : {
        note: requiredText(item.note, `provenance[${index}].note`, 4_000),
      }),
    };
    const fingerprint = studioContinuityDigest(semantic);
    if (item.fingerprint !== undefined && item.fingerprint !== fingerprint) {
      throw new Error(`provenance[${index}] fingerprint 与内容不一致。`);
    }
    return { ...semantic, fingerprint };
  });
  return [...new Map(normalized.map((item) => [item.fingerprint, item] as const)).values()]
    .sort((left, right) => left.fingerprint.localeCompare(right.fingerprint, "en"));
}

export function normalizeStudioContinuityState(
  field: StudioContinuityField,
  input: StudioContinuityFieldStateInput,
): StudioContinuityFieldState {
  if (!input || typeof input !== "object") throw new Error("continuity state 结构无效。");
  const provenance = normalizeProvenance(input.provenance);
  if (input.status === "resolved") {
    const value = requiredText(input.value, `${field}.value`);
    if (field === "referenceSha256" && (input.value !== value || !SHA256_PATTERN.test(value))) {
      throw new Error("referenceSha256 resolved value 必须是 64 位小写 SHA-256。 ");
    }
    const semantic = { status: input.status, value, provenance } as const;
    return { ...semantic, fingerprint: studioContinuityDigest(semantic) };
  }
  if (input.status !== "unresolved" && input.status !== "not-applicable") {
    throw new Error("continuity state 必须显式为 resolved、unresolved 或 not-applicable。");
  }
  const semantic = {
    status: input.status,
    reason: requiredText(input.reason, `${field}.reason`, 4_000),
    provenance,
  } as const;
  return { ...semantic, fingerprint: studioContinuityDigest(semantic) };
}

function normalizeConflictIds(values: string[] | undefined): string[] {
  if (values === undefined) return [];
  if (!Array.isArray(values) || values.length > 1_000) throw new Error("resolvesConflictIds 最多 1000 项。");
  const ids = values.map((value) => normalizeStudioContinuityStableId(value, "conflictId"));
  if (new Set(ids).size !== ids.length) throw new Error("resolvesConflictIds 不能重复。");
  return ids.sort((left, right) => left.localeCompare(right, "en"));
}

export function normalizeStudioContinuityEntryDraft(
  input: StudioContinuityEntryDraftInput,
): StudioContinuityEntryDraft {
  if (input.entryKind !== "observation" && input.entryKind !== "correction") {
    throw new Error("continuity entryKind 必须是 observation 或 correction。");
  }
  const scope = normalizeStudioContinuityScope(input.scope);
  const subjectId = normalizeStudioContinuityStableId(input.subjectId, "subjectId");
  const field = normalizeStudioContinuityField(input.field);
  const state = normalizeStudioContinuityState(field, input.state);
  const supersedesEntryId = input.supersedesEntryId === undefined
    ? undefined
    : normalizeStudioContinuityStableId(input.supersedesEntryId, "supersedesEntryId");
  const resolvesConflictIds = normalizeConflictIds(input.resolvesConflictIds);
  if (input.entryKind === "observation" && (supersedesEntryId !== undefined || resolvesConflictIds.length > 0)) {
    throw new Error("observation 不能 supersede entry 或解决 conflict。");
  }
  if (input.entryKind === "correction" && !supersedesEntryId) {
    throw new Error("correction 必须显式携带 supersedesEntryId。");
  }
  const headKey = `continuity-head-${studioContinuityDigest({
    scopeFingerprint: scope.fingerprint,
    subjectId,
    field,
  }).slice(0, 40)}`;
  const semantic = {
    schemaVersion: 1 as const,
    kind: "studio-continuity-entry" as const,
    entryKind: input.entryKind,
    headKey,
    scope,
    subjectId,
    field,
    state,
    ...(supersedesEntryId ? { supersedesEntryId } : {}),
    resolvesConflictIds,
  };
  const fingerprint = studioContinuityDigest(semantic);
  return {
    ...semantic,
    id: `studio-continuity-${input.entryKind}-${fingerprint.slice(0, 40)}`,
    fingerprint,
  };
}

export function studioContinuityScopesShareAnchor(
  left: StudioContinuityScope,
  right: StudioContinuityScope,
): boolean {
  return left.kind === right.kind
    && left.scopeId === right.scopeId
    && left.unitId === right.unitId
    && left.unitRevision === right.unitRevision;
}

export function studioContinuitySpansOverlap(
  left: Pick<StudioContinuityScope, "startMilliseconds" | "endMilliseconds">,
  right: Pick<StudioContinuityScope, "startMilliseconds" | "endMilliseconds">,
): boolean {
  return left.startMilliseconds < right.endMilliseconds
    && right.startMilliseconds < left.endMilliseconds;
}

export function studioContinuityStatesEqual(
  left: StudioContinuityFieldState,
  right: StudioContinuityFieldState,
): boolean {
  if (left.status !== right.status) return false;
  if (left.status !== "resolved" || right.status !== "resolved") return true;
  return left.value === right.value;
}

export function studioContinuityEntriesConflict(
  left: StudioContinuityEntry,
  right: StudioContinuityEntry,
): boolean {
  return left.id !== right.id
    && studioContinuityScopesShareAnchor(left.scope, right.scope)
    && left.subjectId === right.subjectId
    && left.field === right.field
    && studioContinuitySpansOverlap(left.scope, right.scope)
    && !studioContinuityStatesEqual(left.state, right.state);
}

export interface StudioContinuityConflictDraft {
  id: string;
  fingerprint: string;
  scopeAnchor: StudioContinuityScopeAnchor;
  subjectId: string;
  field: StudioContinuityField;
  overlapStartMilliseconds: number;
  overlapEndMilliseconds: number;
  leftEntryId: string;
  rightEntryId: string;
}

export function createStudioContinuityConflictDraft(
  first: StudioContinuityEntry,
  second: StudioContinuityEntry,
): StudioContinuityConflictDraft {
  if (!studioContinuityEntriesConflict(first, second)) {
    throw new Error("只有同 scope/subject/field 的重叠异值 entry 才能形成 continuity conflict。");
  }
  const ordered = [first, second].sort((a, b) => a.id.localeCompare(b.id, "en"));
  const left = ordered[0]!;
  const right = ordered[1]!;
  const scopeAnchor = normalizeStudioContinuityScopeAnchor(left.scope);
  const semantic = {
    schemaVersion: 1 as const,
    kind: "studio-continuity-conflict" as const,
    scopeAnchor,
    subjectId: left.subjectId,
    field: left.field,
    overlapStartMilliseconds: Math.max(left.scope.startMilliseconds, right.scope.startMilliseconds),
    overlapEndMilliseconds: Math.min(left.scope.endMilliseconds, right.scope.endMilliseconds),
    leftEntryId: left.id,
    rightEntryId: right.id,
  };
  const fingerprint = studioContinuityDigest(semantic);
  return {
    ...semantic,
    id: `studio-continuity-conflict-${fingerprint.slice(0, 40)}`,
    fingerprint,
  };
}

function fieldRank(field: StudioContinuityField): number {
  return STUDIO_CONTINUITY_FIELDS.indexOf(field);
}

export function compareStudioContinuityEntries(
  left: StudioContinuityEntry,
  right: StudioContinuityEntry,
): number {
  return left.scope.startMilliseconds - right.scope.startMilliseconds
    || left.scope.endMilliseconds - right.scope.endMilliseconds
    || left.subjectId.localeCompare(right.subjectId, "en")
    || fieldRank(left.field) - fieldRank(right.field)
    || left.id.localeCompare(right.id, "en");
}

function normalizeRequiredFields(fields: StudioContinuityField[]): StudioContinuityField[] {
  if (!Array.isArray(fields) || fields.length < 1 || fields.length > STUDIO_CONTINUITY_FIELDS.length) {
    throw new Error("requiredFields 必须包含 1-9 个固定连续性字段。");
  }
  const normalized = fields.map(normalizeStudioContinuityField);
  if (new Set(normalized).size !== normalized.length) throw new Error("requiredFields 不能重复。");
  return normalized.sort((left, right) => fieldRank(left) - fieldRank(right));
}

function coverageGaps(
  start: number,
  end: number,
  entries: StudioContinuityEntry[],
): Array<{ startMilliseconds: number; endMilliseconds: number }> {
  const ranges = entries
    .filter((entry) => entry.state.status !== "unresolved" && studioContinuitySpansOverlap(entry.scope, {
      startMilliseconds: start,
      endMilliseconds: end,
    }))
    .map((entry) => ({
      startMilliseconds: Math.max(start, entry.scope.startMilliseconds),
      endMilliseconds: Math.min(end, entry.scope.endMilliseconds),
    }))
    .sort((left, right) => left.startMilliseconds - right.startMilliseconds || left.endMilliseconds - right.endMilliseconds);
  const gaps: Array<{ startMilliseconds: number; endMilliseconds: number }> = [];
  let cursor = start;
  for (const range of ranges) {
    if (range.startMilliseconds > cursor) gaps.push({ startMilliseconds: cursor, endMilliseconds: range.startMilliseconds });
    cursor = Math.max(cursor, range.endMilliseconds);
    if (cursor >= end) break;
  }
  if (cursor < end) gaps.push({ startMilliseconds: cursor, endMilliseconds: end });
  return gaps;
}

export function createStudioContinuityReadiness(input: {
  scope: StudioContinuityScopeInput;
  subjectId: string;
  requiredFields: StudioContinuityField[];
  currentEntries: StudioContinuityEntry[];
  openConflicts: StudioContinuityConflict[];
}): StudioContinuityReadiness {
  const scope = normalizeStudioContinuityScope(input.scope);
  const subjectId = normalizeStudioContinuityStableId(input.subjectId, "subjectId");
  const requiredFields = normalizeRequiredFields(input.requiredFields);
  const currentEntries = input.currentEntries
    .filter((entry) => studioContinuityScopesShareAnchor(entry.scope, scope)
      && entry.subjectId === subjectId
      && studioContinuitySpansOverlap(entry.scope, scope))
    .sort(compareStudioContinuityEntries);
  const openConflicts = input.openConflicts
    .filter((conflict) => conflict.status === "open"
      && conflict.scopeAnchor.kind === scope.kind
      && conflict.scopeAnchor.scopeId === scope.scopeId
      && conflict.scopeAnchor.unitId === scope.unitId
      && conflict.scopeAnchor.unitRevision === scope.unitRevision
      && conflict.subjectId === subjectId
      && conflict.overlapStartMilliseconds < scope.endMilliseconds
      && scope.startMilliseconds < conflict.overlapEndMilliseconds)
    .sort((left, right) => left.id.localeCompare(right.id, "en"));
  const blockers: StudioContinuityBlocker[] = [];

  for (const field of requiredFields) {
    const fieldEntries = currentEntries.filter((entry) => entry.field === field);
    const conflicts = openConflicts.filter((conflict) => conflict.field === field);
    for (const conflict of conflicts) blockers.push({
      code: "required-state-conflict",
      field,
      conflictId: conflict.id,
      startMilliseconds: conflict.overlapStartMilliseconds,
      endMilliseconds: conflict.overlapEndMilliseconds,
      message: `${field} 在 ${conflict.overlapStartMilliseconds}-${conflict.overlapEndMilliseconds}ms 存在未解决冲突。`,
    });
    for (const entry of fieldEntries.filter((candidate) => candidate.state.status === "unresolved")) blockers.push({
      code: "required-state-unresolved",
      field,
      entryId: entry.id,
      startMilliseconds: entry.scope.startMilliseconds,
      endMilliseconds: entry.scope.endMilliseconds,
      message: `${field} 在 ${entry.scope.startMilliseconds}-${entry.scope.endMilliseconds}ms 仍为 unresolved。`,
    });
    if (fieldEntries.length === 0) blockers.push({
      code: "required-state-missing",
      field,
      startMilliseconds: scope.startMilliseconds,
      endMilliseconds: scope.endMilliseconds,
      message: `${field} 缺少当前连续性状态。`,
    });
    for (const gap of coverageGaps(scope.startMilliseconds, scope.endMilliseconds, fieldEntries)) blockers.push({
      code: "required-state-gap",
      field,
      ...gap,
      message: `${field} 在 ${gap.startMilliseconds}-${gap.endMilliseconds}ms 没有显式状态，禁止填满空档。`,
    });
    for (let leftIndex = 0; leftIndex < fieldEntries.length; leftIndex += 1) {
      const left = fieldEntries[leftIndex]!;
      for (let rightIndex = leftIndex + 1; rightIndex < fieldEntries.length; rightIndex += 1) {
        const right = fieldEntries[rightIndex]!;
        if (!studioContinuityEntriesConflict(left, right)) continue;
        if (conflicts.some((conflict) => {
          const ids = new Set([conflict.leftEntry.id, conflict.rightEntry.id]);
          return ids.has(left.id) && ids.has(right.id);
        })) continue;
        blockers.push({
          code: "undetected-overlap-conflict",
          field,
          startMilliseconds: Math.max(left.scope.startMilliseconds, right.scope.startMilliseconds),
          endMilliseconds: Math.min(left.scope.endMilliseconds, right.scope.endMilliseconds),
          message: `${field} 存在未登记的重叠异值，存储完整性无效。`,
        });
      }
    }
  }

  const uniqueBlockers = [...new Map(blockers.map((blocker) => [studioContinuityDigest(blocker), blocker] as const)).values()]
    .sort((left, right) => fieldRank(left.field) - fieldRank(right.field)
      || (left.startMilliseconds ?? -1) - (right.startMilliseconds ?? -1)
      || left.code.localeCompare(right.code, "en")
      || (left.entryId ?? left.conflictId ?? "").localeCompare(right.entryId ?? right.conflictId ?? "", "en"));
  const semantic = {
    schemaVersion: 1 as const,
    kind: "studio-continuity-readiness" as const,
    scope,
    subjectId,
    requiredFields,
    ready: uniqueBlockers.length === 0,
    blockers: uniqueBlockers,
    currentEntryIds: currentEntries.map((entry) => entry.id),
    openConflictIds: openConflicts.map((conflict) => conflict.id),
  };
  return { ...semantic, fingerprint: studioContinuityDigest(semantic) };
}
