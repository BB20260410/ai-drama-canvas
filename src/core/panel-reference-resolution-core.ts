import { createHash } from "node:crypto";
import type { PanelReferenceResolution as FusionPanelReferenceResolution } from "./fusion-panel-references.js";
import type { StudioAssetBindingSet } from "./studio-production.js";
import type {
  StudioFrozenAssetBindingProvenance,
  StudioGenerationTarget,
} from "./studio-generation.js";

export const PANEL_REFERENCE_RESOLUTION_CORE_VERSION = "panel-reference-resolution-core-v3" as const;
export const PANEL_REFERENCE_RESOLUTION_MAX_VISIBLE_CONTROLS = 6 as const;

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export type PanelReferenceAssetCategory = "character" | "scene" | "prop" | "style";
export type PanelReferenceVisiblePresence = "required" | "optional";
export type PanelReferencePresence = PanelReferenceVisiblePresence | "forbidden";
export type PanelReferenceClosure = "resolved" | "confirmed-empty" | "unresolved";
export type PanelReferenceBlockerPhase = "resolution" | "generation" | "currentness";
export type PanelReferenceControlKind = "asset" | "composite" | "continuity-frame";
export type PanelReferenceControlPurpose = "identity" | "continuity";

export type PanelReferenceJsonValue =
  | null
  | boolean
  | number
  | string
  | PanelReferenceJsonValue[]
  | { [key: string]: PanelReferenceJsonValue };

export interface PanelReferenceProjectIdentity {
  id: string;
  contentAddress?: string;
}

export interface PanelReferenceUnitIdentity {
  id: string;
  revision?: number;
  fingerprint?: string;
  seasonId?: string;
  episodeId?: string;
  sequence?: number;
}

export interface PanelReferencePanelIdentity {
  id: string;
  index: number;
  count?: number;
}

export interface PanelReferenceTimeRange {
  unitLocalStartSeconds: number;
  unitLocalEndSeconds: number;
  episodeAbsoluteStartSeconds?: number;
  episodeAbsoluteEndSeconds?: number;
}

export type PanelReferenceSourceSpanInput = {
  id?: string;
  sourceId: string;
  sourceFingerprint: string;
  provenance?: PanelReferenceProvenanceInput[];
  extensions?: Record<string, PanelReferenceJsonValue>;
} & ({
  kind: "text";
  coordinateSystem: "utf16-code-unit";
  start: number;
  end: number;
  surfaceFingerprint: string;
} | {
  kind: "evidence";
  locator: string;
});

export type PanelReferenceSourceSpan = (PanelReferenceSourceSpanInput & {
  id: string;
  occurrences: number;
  fingerprint: string;
});

export interface PanelReferenceAssetIdentitySnapshot {
  semanticRevision?: string | number;
  definitionVersionId?: string;
  authorityEventId?: string;
  authorityVersionId?: string;
  assetVersionId?: string;
  mediaSha256?: string;
  semanticFingerprint?: string;
}

export interface PanelReferenceProvenanceInput {
  source: string;
  reference: string;
  sourceFingerprint?: string;
  note?: string;
  extensions?: Record<string, PanelReferenceJsonValue>;
}

export interface PanelReferenceProvenance extends PanelReferenceProvenanceInput {
  fingerprint: string;
}

export interface PanelReferenceSemanticAssetInput {
  assetId: string;
  category: PanelReferenceAssetCategory;
  presence: PanelReferenceVisiblePresence;
  role: string;
  mentionIds?: string[];
  sourceSpanIds: string[];
  identity?: PanelReferenceAssetIdentitySnapshot;
  provenance?: PanelReferenceProvenanceInput[];
  extensions?: Record<string, PanelReferenceJsonValue>;
}

export interface PanelReferenceSemanticAsset extends Omit<PanelReferenceSemanticAssetInput, "mentionIds" | "identity" | "provenance" | "extensions"> {
  mentionIds: string[];
  identity: PanelReferenceAssetIdentitySnapshot;
  provenance: PanelReferenceProvenance[];
  extensions: Record<string, PanelReferenceJsonValue>;
  occurrences: number;
  fingerprint: string;
}

export interface PanelReferenceForbiddenAssetInput {
  assetId: string;
  category: PanelReferenceAssetCategory;
  role: string;
  mentionIds?: string[];
  sourceSpanIds: string[];
  identity?: PanelReferenceAssetIdentitySnapshot;
  provenance?: PanelReferenceProvenanceInput[];
  extensions?: Record<string, PanelReferenceJsonValue>;
}

export interface PanelReferenceForbiddenAsset extends Omit<PanelReferenceForbiddenAssetInput, "mentionIds" | "identity" | "provenance" | "extensions"> {
  presence: "forbidden";
  mentionIds: string[];
  identity: PanelReferenceAssetIdentitySnapshot;
  provenance: PanelReferenceProvenance[];
  extensions: Record<string, PanelReferenceJsonValue>;
  occurrences: number;
  fingerprint: string;
}

export interface PanelReferenceExcludedAssetInput {
  /** mention、parser reconciliation 或其他被明确裁决对象的稳定身份。 */
  subjectId: string;
  assetId?: string;
  reason: string;
  sourceSpanIds?: string[];
  provenance?: PanelReferenceProvenanceInput[];
  extensions?: Record<string, PanelReferenceJsonValue>;
}

export interface PanelReferenceExcludedAsset extends Omit<PanelReferenceExcludedAssetInput, "sourceSpanIds" | "provenance" | "extensions"> {
  sourceSpanIds: string[];
  provenance: PanelReferenceProvenance[];
  extensions: Record<string, PanelReferenceJsonValue>;
  occurrences: number;
  fingerprint: string;
}

export interface PanelReferenceUnresolvedInput {
  subjectId: string;
  status: "ambiguous" | "unmatched" | "unconfirmed";
  presence: PanelReferencePresence;
  candidateAssetIds?: string[];
  sourceSpanIds: string[];
  reason: string;
  provenance?: PanelReferenceProvenanceInput[];
  extensions?: Record<string, PanelReferenceJsonValue>;
}

export interface PanelReferenceUnresolved extends Omit<PanelReferenceUnresolvedInput, "candidateAssetIds" | "provenance" | "extensions"> {
  candidateAssetIds: string[];
  provenance: PanelReferenceProvenance[];
  extensions: Record<string, PanelReferenceJsonValue>;
  occurrences: number;
  fingerprint: string;
}

export interface PanelReferenceControlInput {
  id: string;
  kind: PanelReferenceControlKind;
  /** v2 asset/composite 调用方可省略；归一化后默认 identity。 */
  purpose?: PanelReferenceControlPurpose;
  coveredAssetIds: string[];
  readiness: "ready" | "pending" | "stale";
  contentAddress?: string;
  referenceVersion?: string;
  provenance?: PanelReferenceProvenanceInput[];
  extensions?: Record<string, PanelReferenceJsonValue>;
}

export interface PanelReferenceControl extends Omit<PanelReferenceControlInput, "purpose" | "provenance" | "extensions"> {
  purpose: PanelReferenceControlPurpose;
  provenance: PanelReferenceProvenance[];
  extensions: Record<string, PanelReferenceJsonValue>;
  occurrences: number;
  fingerprint: string;
}

export interface PanelReferenceDependencyInput {
  kind: string;
  key: string;
  fingerprint: string;
  provenance?: PanelReferenceProvenanceInput[];
}

export interface PanelReferenceDependency extends PanelReferenceDependencyInput {
  provenance: PanelReferenceProvenance[];
  occurrences: number;
  fingerprint: string;
}

export interface PanelReferenceBlockerInput {
  code: string;
  phase: PanelReferenceBlockerPhase;
  subjectId?: string;
  message: string;
  provenance?: PanelReferenceProvenanceInput[];
  extensions?: Record<string, PanelReferenceJsonValue>;
}

export interface PanelReferenceBlocker extends Omit<PanelReferenceBlockerInput, "provenance" | "extensions"> {
  provenance: PanelReferenceProvenance[];
  extensions: Record<string, PanelReferenceJsonValue>;
  fingerprint: string;
}

export interface PanelReferenceWarningInput {
  code: string;
  subjectId?: string;
  message: string;
  provenance?: PanelReferenceProvenanceInput[];
  extensions?: Record<string, PanelReferenceJsonValue>;
}

export interface PanelReferenceWarning extends Omit<PanelReferenceWarningInput, "provenance" | "extensions"> {
  provenance: PanelReferenceProvenance[];
  extensions: Record<string, PanelReferenceJsonValue>;
  fingerprint: string;
}

export interface PanelReferenceResolutionDraft {
  project: PanelReferenceProjectIdentity;
  unit: PanelReferenceUnitIdentity;
  panel: PanelReferencePanelIdentity;
  time: PanelReferenceTimeRange;
  sourceSpans?: PanelReferenceSourceSpanInput[];
  semanticAssets?: PanelReferenceSemanticAssetInput[];
  excludedAssets?: PanelReferenceExcludedAssetInput[];
  forbiddenAssets?: PanelReferenceForbiddenAssetInput[];
  unresolved?: PanelReferenceUnresolvedInput[];
  controlReferences?: PanelReferenceControlInput[];
  dependencies?: PanelReferenceDependencyInput[];
  blockers?: PanelReferenceBlockerInput[];
  warnings?: PanelReferenceWarningInput[];
  /** 空可见集合必须由上游明确确认；不得由 [] 猜成“无需引用”。 */
  confirmedEmpty?: boolean;
  claimedClosure?: PanelReferenceClosure;
  claimedGenerationReady?: boolean;
  provenance?: PanelReferenceProvenanceInput[];
  extensions?: Record<string, PanelReferenceJsonValue>;
}

export interface PanelReferenceResolutionCore {
  schemaVersion: 3;
  kind: "panel-reference-resolution";
  resolverVersion: typeof PANEL_REFERENCE_RESOLUTION_CORE_VERSION;
  id: string;
  fingerprint: string;
  project: PanelReferenceProjectIdentity;
  unit: PanelReferenceUnitIdentity;
  panel: PanelReferencePanelIdentity;
  time: PanelReferenceTimeRange;
  sourceSpans: PanelReferenceSourceSpan[];
  semanticAssets: PanelReferenceSemanticAsset[];
  excludedAssets: PanelReferenceExcludedAsset[];
  forbiddenAssets: PanelReferenceForbiddenAsset[];
  unresolved: PanelReferenceUnresolved[];
  /** 唯一允许直接投影到生成供应商的 identity + continuity 控制引用，合计永远不超过 6。 */
  controlReferences: PanelReferenceControl[];
  /** 超限时不挑前 6 项；全部候选原样移入此集合并失败关闭。 */
  overflowControlReferences: PanelReferenceControl[];
  dependencies: PanelReferenceDependency[];
  confirmedEmpty: boolean;
  closure: PanelReferenceClosure;
  blockers: PanelReferenceBlocker[];
  warnings: PanelReferenceWarning[];
  generationReady: boolean;
  provenance: PanelReferenceProvenance[];
  extensions: Record<string, PanelReferenceJsonValue>;
}

export interface PanelReferenceCurrentDependency {
  key: string;
  fingerprint: string;
}

export interface PanelReferenceDependencyDrift {
  key: string;
  reason: "missing" | "changed" | "conflicting-current-values" | "conflicting-frozen-values";
  expected?: string;
  actual?: string;
}

export interface PanelReferenceCurrentness {
  resolutionId: string;
  resolutionFingerprint: string;
  currentSnapshotFingerprint: string;
  current: boolean;
  driftedDependencies: PanelReferenceDependencyDrift[];
}

export class PanelReferenceResolutionCoreError extends Error {
  readonly code: "invalid-input" | "tampered" | "not-current";
  readonly details: string[];

  constructor(code: PanelReferenceResolutionCoreError["code"], message: string, details: string[] = []) {
    super(message);
    this.name = "PanelReferenceResolutionCoreError";
    this.code = code;
    this.details = details;
  }
}

function failInput(message: string): never {
  throw new PanelReferenceResolutionCoreError("invalid-input", message);
}

function requiredText(value: unknown, field: string, maxLength = 4_000): string {
  if (typeof value !== "string" || !value.trim()) failInput(`${field} 不能为空。`);
  const normalized = value.trim();
  if (normalized.length > maxLength) failInput(`${field} 超过 ${maxLength} 字符。`);
  return normalized;
}

function optionalText(value: unknown, field: string, maxLength = 4_000): string | undefined {
  if (value === undefined) return undefined;
  return requiredText(value, field, maxLength);
}

function finiteNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) failInput(`${field} 必须是有限数字。`);
  return Object.is(value, -0) ? 0 : value;
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) failInput(`${field} 必须是正整数。`);
  return Number(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
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

function normalizedStringSet(values: unknown, field: string): string[] {
  if (values === undefined) return [];
  if (!Array.isArray(values)) failInput(`${field} 必须是数组。`);
  return [...new Set(values.map((value, index) => requiredText(value, `${field}[${index}]`, 2_000)))]
    .sort((left, right) => left.localeCompare(right, "en"));
}

function normalizeJson(value: unknown, field: string, seen = new Set<object>()): PanelReferenceJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) failInput(`${field} 不能包含非有限数字。`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object") failInput(`${field} 必须是 JSON 安全值。`);
  if (seen.has(value)) failInput(`${field} 不能包含循环引用。`);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry, index) => normalizeJson(entry, `${field}[${index}]`, seen))
        .sort((left, right) => JSON.stringify(stableValue(left)).localeCompare(JSON.stringify(stableValue(right)), "en"));
    }
    const result: Record<string, PanelReferenceJsonValue> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right, "en"))) {
      if (entry === undefined) continue;
      result[key] = normalizeJson(entry, `${field}.${key}`, seen);
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

function normalizeExtensions(value: unknown, field: string): Record<string, PanelReferenceJsonValue> {
  if (value === undefined) return {};
  const normalized = normalizeJson(value, field);
  if (!normalized || typeof normalized !== "object" || Array.isArray(normalized)) failInput(`${field} 必须是对象。`);
  return normalized as Record<string, PanelReferenceJsonValue>;
}

function normalizeProvenance(input: PanelReferenceProvenanceInput[] | undefined, field: string): PanelReferenceProvenance[] {
  if (input === undefined) return [];
  if (!Array.isArray(input)) failInput(`${field} 必须是数组。`);
  const byFingerprint = new Map<string, PanelReferenceProvenance>();
  for (const [index, entry] of input.entries()) {
    const semantic = {
      source: requiredText(entry.source, `${field}[${index}].source`, 500),
      reference: requiredText(entry.reference, `${field}[${index}].reference`, 2_000),
      ...(optionalText(entry.sourceFingerprint, `${field}[${index}].sourceFingerprint`, 1_000)
        ? { sourceFingerprint: entry.sourceFingerprint!.trim() }
        : {}),
      ...(optionalText(entry.note, `${field}[${index}].note`, 8_000) ? { note: optionalText(entry.note, `${field}[${index}].note`, 8_000) } : {}),
      extensions: normalizeExtensions(entry.extensions, `${field}[${index}].extensions`),
    };
    const fingerprint = digest(semantic);
    byFingerprint.set(fingerprint, {
      source: semantic.source,
      reference: semantic.reference,
      ...(semantic.sourceFingerprint ? { sourceFingerprint: semantic.sourceFingerprint } : {}),
      ...(semantic.note ? { note: semantic.note } : {}),
      extensions: semantic.extensions,
    } as PanelReferenceProvenance);
  }
  return [...byFingerprint.entries()]
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([fingerprint, entry]) => ({ ...entry, fingerprint }));
}

function normalizeIdentity(input: PanelReferenceAssetIdentitySnapshot | undefined, field: string): PanelReferenceAssetIdentitySnapshot {
  if (!input) return {};
  const mediaSha256 = optionalText(input.mediaSha256, `${field}.mediaSha256`, 64);
  if (mediaSha256 && !SHA256_PATTERN.test(mediaSha256)) failInput(`${field}.mediaSha256 必须是小写 SHA-256。`);
  const semanticRevision = input.semanticRevision;
  if (semanticRevision !== undefined
    && !((typeof semanticRevision === "string" && semanticRevision.trim())
      || (typeof semanticRevision === "number" && Number.isSafeInteger(semanticRevision) && semanticRevision >= 0))) {
    failInput(`${field}.semanticRevision 无效。`);
  }
  return {
    ...(semanticRevision !== undefined ? { semanticRevision: typeof semanticRevision === "string" ? semanticRevision.trim() : semanticRevision } : {}),
    ...(optionalText(input.definitionVersionId, `${field}.definitionVersionId`, 1_000) ? { definitionVersionId: input.definitionVersionId!.trim() } : {}),
    ...(optionalText(input.authorityEventId, `${field}.authorityEventId`, 1_000) ? { authorityEventId: input.authorityEventId!.trim() } : {}),
    ...(optionalText(input.authorityVersionId, `${field}.authorityVersionId`, 1_000) ? { authorityVersionId: input.authorityVersionId!.trim() } : {}),
    ...(optionalText(input.assetVersionId, `${field}.assetVersionId`, 1_000) ? { assetVersionId: input.assetVersionId!.trim() } : {}),
    ...(mediaSha256 ? { mediaSha256 } : {}),
    ...(optionalText(input.semanticFingerprint, `${field}.semanticFingerprint`, 1_000) ? { semanticFingerprint: input.semanticFingerprint!.trim() } : {}),
  };
}

function normalizeProject(input: PanelReferenceProjectIdentity): PanelReferenceProjectIdentity {
  return {
    id: requiredText(input.id, "project.id", 1_000),
    ...(optionalText(input.contentAddress, "project.contentAddress", 2_000) ? { contentAddress: input.contentAddress!.trim() } : {}),
  };
}

function normalizeUnit(input: PanelReferenceUnitIdentity): PanelReferenceUnitIdentity {
  const revision = input.revision;
  if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 1)) failInput("unit.revision 必须是正整数。");
  const sequence = input.sequence;
  if (sequence !== undefined && (!Number.isSafeInteger(sequence) || sequence < 1)) failInput("unit.sequence 必须是正整数。");
  return {
    id: requiredText(input.id, "unit.id", 1_000),
    ...(revision !== undefined ? { revision } : {}),
    ...(optionalText(input.fingerprint, "unit.fingerprint", 1_000) ? { fingerprint: input.fingerprint!.trim() } : {}),
    ...(optionalText(input.seasonId, "unit.seasonId", 1_000) ? { seasonId: input.seasonId!.trim() } : {}),
    ...(optionalText(input.episodeId, "unit.episodeId", 1_000) ? { episodeId: input.episodeId!.trim() } : {}),
    ...(sequence !== undefined ? { sequence } : {}),
  };
}

function normalizePanel(input: PanelReferencePanelIdentity): PanelReferencePanelIdentity {
  const index = positiveInteger(input.index, "panel.index");
  const count = input.count === undefined ? undefined : positiveInteger(input.count, "panel.count");
  if (count !== undefined && index > count) failInput("panel.index 不能大于 panel.count。");
  return { id: requiredText(input.id, "panel.id", 1_000), index, ...(count !== undefined ? { count } : {}) };
}

function normalizeTime(input: PanelReferenceTimeRange): PanelReferenceTimeRange {
  const unitLocalStartSeconds = finiteNumber(input.unitLocalStartSeconds, "time.unitLocalStartSeconds");
  const unitLocalEndSeconds = finiteNumber(input.unitLocalEndSeconds, "time.unitLocalEndSeconds");
  if (unitLocalStartSeconds < 0 || unitLocalEndSeconds <= unitLocalStartSeconds) failInput("单元本地时间范围无效。");
  const hasAbsoluteStart = input.episodeAbsoluteStartSeconds !== undefined;
  const hasAbsoluteEnd = input.episodeAbsoluteEndSeconds !== undefined;
  if (hasAbsoluteStart !== hasAbsoluteEnd) failInput("集内绝对时间必须同时提供 start/end。");
  if (!hasAbsoluteStart) return { unitLocalStartSeconds, unitLocalEndSeconds };
  const episodeAbsoluteStartSeconds = finiteNumber(input.episodeAbsoluteStartSeconds, "time.episodeAbsoluteStartSeconds");
  const episodeAbsoluteEndSeconds = finiteNumber(input.episodeAbsoluteEndSeconds, "time.episodeAbsoluteEndSeconds");
  if (episodeAbsoluteStartSeconds < 0 || episodeAbsoluteEndSeconds <= episodeAbsoluteStartSeconds
    || Math.abs((episodeAbsoluteEndSeconds - episodeAbsoluteStartSeconds) - (unitLocalEndSeconds - unitLocalStartSeconds)) > 1e-6) {
    failInput("集内绝对时间与单元本地时间跨度不一致。");
  }
  return { unitLocalStartSeconds, unitLocalEndSeconds, episodeAbsoluteStartSeconds, episodeAbsoluteEndSeconds };
}

function groupedWithOccurrences<T extends { fingerprint: string; occurrences: number }>(
  items: T[],
  keyFor: (item: T) => string,
): { items: T[]; duplicateWarnings: Array<{ key: string; occurrences: number }>; conflictKeys: string[] } {
  const groups = new Map<string, Map<string, T[]>>();
  for (const item of items) {
    const key = keyFor(item);
    const variants = groups.get(key) ?? new Map<string, T[]>();
    variants.set(item.fingerprint, [...(variants.get(item.fingerprint) ?? []), item]);
    groups.set(key, variants);
  }
  const result: T[] = [];
  const duplicateWarnings: Array<{ key: string; occurrences: number }> = [];
  const conflictKeys: string[] = [];
  for (const [key, variants] of [...groups.entries()].sort(([left], [right]) => left.localeCompare(right, "en"))) {
    if (variants.size > 1) conflictKeys.push(key);
    for (const [fingerprint, copies] of [...variants.entries()].sort(([left], [right]) => left.localeCompare(right, "en"))) {
      const occurrences = copies.reduce((sum, copy) => sum + copy.occurrences, 0);
      if (occurrences > 1) duplicateWarnings.push({ key, occurrences });
      result.push({ ...copies[0]!, fingerprint, occurrences });
    }
  }
  return { items: result, duplicateWarnings, conflictKeys };
}

function normalizeSourceSpan(entry: PanelReferenceSourceSpanInput, index: number): PanelReferenceSourceSpan {
  const common = {
    kind: entry.kind,
    sourceId: requiredText(entry.sourceId, `sourceSpans[${index}].sourceId`, 2_000),
    sourceFingerprint: requiredText(entry.sourceFingerprint, `sourceSpans[${index}].sourceFingerprint`, 2_000),
    provenance: normalizeProvenance(entry.provenance, `sourceSpans[${index}].provenance`),
    extensions: normalizeExtensions(entry.extensions, `sourceSpans[${index}].extensions`),
  };
  const semantic = entry.kind === "text"
    ? (() => {
      if (entry.coordinateSystem !== "utf16-code-unit") failInput(`sourceSpans[${index}].coordinateSystem 无效。`);
      if (!Number.isSafeInteger(entry.start) || !Number.isSafeInteger(entry.end) || entry.start < 0 || entry.end <= entry.start) {
        failInput(`sourceSpans[${index}] UTF-16 范围无效。`);
      }
      return {
        ...common,
        coordinateSystem: "utf16-code-unit" as const,
        start: entry.start,
        end: entry.end,
        surfaceFingerprint: requiredText(entry.surfaceFingerprint, `sourceSpans[${index}].surfaceFingerprint`, 2_000),
      };
    })()
    : { ...common, locator: requiredText(entry.locator, `sourceSpans[${index}].locator`, 4_000) };
  const fingerprint = digest(semantic);
  return {
    ...semantic,
    id: entry.id === undefined ? `source-span-${fingerprint.slice(0, 32)}` : requiredText(entry.id, `sourceSpans[${index}].id`, 2_000),
    occurrences: 1,
    fingerprint,
  } as PanelReferenceSourceSpan;
}

function normalizeSemanticAsset(entry: PanelReferenceSemanticAssetInput, index: number): PanelReferenceSemanticAsset {
  if (entry.presence !== "required" && entry.presence !== "optional") failInput(`semanticAssets[${index}].presence 无效。`);
  if (entry.category !== "character" && entry.category !== "scene" && entry.category !== "prop" && entry.category !== "style") failInput(`semanticAssets[${index}].category 无效。`);
  const semantic = {
    assetId: requiredText(entry.assetId, `semanticAssets[${index}].assetId`, 1_000),
    category: entry.category,
    presence: entry.presence,
    role: requiredText(entry.role, `semanticAssets[${index}].role`, 4_000),
    mentionIds: normalizedStringSet(entry.mentionIds, `semanticAssets[${index}].mentionIds`),
    sourceSpanIds: normalizedStringSet(entry.sourceSpanIds, `semanticAssets[${index}].sourceSpanIds`),
    identity: normalizeIdentity(entry.identity, `semanticAssets[${index}].identity`),
    provenance: normalizeProvenance(entry.provenance, `semanticAssets[${index}].provenance`),
    extensions: normalizeExtensions(entry.extensions, `semanticAssets[${index}].extensions`),
  };
  return { ...semantic, occurrences: 1, fingerprint: digest(semantic) };
}

function normalizeForbiddenAsset(entry: PanelReferenceForbiddenAssetInput, index: number): PanelReferenceForbiddenAsset {
  if (entry.category !== "character" && entry.category !== "scene" && entry.category !== "prop" && entry.category !== "style") failInput(`forbiddenAssets[${index}].category 无效。`);
  const semantic = {
    assetId: requiredText(entry.assetId, `forbiddenAssets[${index}].assetId`, 1_000),
    category: entry.category,
    presence: "forbidden" as const,
    role: requiredText(entry.role, `forbiddenAssets[${index}].role`, 4_000),
    mentionIds: normalizedStringSet(entry.mentionIds, `forbiddenAssets[${index}].mentionIds`),
    sourceSpanIds: normalizedStringSet(entry.sourceSpanIds, `forbiddenAssets[${index}].sourceSpanIds`),
    identity: normalizeIdentity(entry.identity, `forbiddenAssets[${index}].identity`),
    provenance: normalizeProvenance(entry.provenance, `forbiddenAssets[${index}].provenance`),
    extensions: normalizeExtensions(entry.extensions, `forbiddenAssets[${index}].extensions`),
  };
  return { ...semantic, occurrences: 1, fingerprint: digest(semantic) };
}

function normalizeExcludedAsset(entry: PanelReferenceExcludedAssetInput, index: number): PanelReferenceExcludedAsset {
  const semantic = {
    subjectId: requiredText(entry.subjectId, `excludedAssets[${index}].subjectId`, 2_000),
    ...(optionalText(entry.assetId, `excludedAssets[${index}].assetId`, 1_000) ? { assetId: entry.assetId!.trim() } : {}),
    reason: requiredText(entry.reason, `excludedAssets[${index}].reason`, 8_000),
    sourceSpanIds: normalizedStringSet(entry.sourceSpanIds, `excludedAssets[${index}].sourceSpanIds`),
    provenance: normalizeProvenance(entry.provenance, `excludedAssets[${index}].provenance`),
    extensions: normalizeExtensions(entry.extensions, `excludedAssets[${index}].extensions`),
  };
  return { ...semantic, occurrences: 1, fingerprint: digest(semantic) };
}

function normalizeUnresolved(entry: PanelReferenceUnresolvedInput, index: number): PanelReferenceUnresolved {
  if (entry.status !== "ambiguous" && entry.status !== "unmatched" && entry.status !== "unconfirmed") failInput(`unresolved[${index}].status 无效。`);
  if (entry.presence !== "required" && entry.presence !== "optional" && entry.presence !== "forbidden") failInput(`unresolved[${index}].presence 无效。`);
  const semantic = {
    subjectId: requiredText(entry.subjectId, `unresolved[${index}].subjectId`, 2_000),
    status: entry.status,
    presence: entry.presence,
    candidateAssetIds: normalizedStringSet(entry.candidateAssetIds, `unresolved[${index}].candidateAssetIds`),
    sourceSpanIds: normalizedStringSet(entry.sourceSpanIds, `unresolved[${index}].sourceSpanIds`),
    reason: requiredText(entry.reason, `unresolved[${index}].reason`, 8_000),
    provenance: normalizeProvenance(entry.provenance, `unresolved[${index}].provenance`),
    extensions: normalizeExtensions(entry.extensions, `unresolved[${index}].extensions`),
  };
  return { ...semantic, occurrences: 1, fingerprint: digest(semantic) };
}

function normalizeControl(entry: PanelReferenceControlInput, index: number): PanelReferenceControl {
  if (entry.kind !== "asset" && entry.kind !== "composite" && entry.kind !== "continuity-frame") {
    failInput(`controlReferences[${index}].kind 无效。`);
  }
  if (entry.purpose !== undefined && entry.purpose !== "identity" && entry.purpose !== "continuity") {
    failInput(`controlReferences[${index}].purpose 无效。`);
  }
  if (entry.readiness !== "ready" && entry.readiness !== "pending" && entry.readiness !== "stale") failInput(`controlReferences[${index}].readiness 无效。`);
  const coveredAssetIds = normalizedStringSet(entry.coveredAssetIds, `controlReferences[${index}].coveredAssetIds`);
  if (coveredAssetIds.length === 0) failInput(`controlReferences[${index}] 必须覆盖至少一个资产。`);
  const purpose = entry.purpose ?? (entry.kind === "continuity-frame" ? "continuity" : "identity");
  if (entry.kind === "continuity-frame" && purpose !== "continuity") {
    failInput(`controlReferences[${index}] continuity-frame 的 purpose 必须是 continuity。`);
  }
  const contentAddress = optionalText(entry.contentAddress, `controlReferences[${index}].contentAddress`, 2_000);
  if (entry.kind === "continuity-frame" && contentAddress && !SHA256_PATTERN.test(contentAddress)) {
    failInput(`controlReferences[${index}].contentAddress 必须是裸 64 位小写 SHA-256。`);
  }
  const semantic = {
    id: requiredText(entry.id, `controlReferences[${index}].id`, 2_000),
    kind: entry.kind,
    purpose,
    coveredAssetIds,
    readiness: entry.readiness,
    ...(contentAddress ? { contentAddress } : {}),
    ...(optionalText(entry.referenceVersion, `controlReferences[${index}].referenceVersion`, 2_000) ? { referenceVersion: entry.referenceVersion!.trim() } : {}),
    provenance: normalizeProvenance(entry.provenance, `controlReferences[${index}].provenance`),
    extensions: normalizeExtensions(entry.extensions, `controlReferences[${index}].extensions`),
  };
  return { ...semantic, occurrences: 1, fingerprint: digest(semantic) };
}

function normalizeDependency(entry: PanelReferenceDependencyInput, index: number): PanelReferenceDependency {
  const dependencyFingerprint = requiredText(entry.fingerprint, `dependencies[${index}].fingerprint`, 64);
  if (!SHA256_PATTERN.test(dependencyFingerprint)) failInput(`dependencies[${index}].fingerprint 必须是小写 SHA-256。`);
  const semantic = {
    kind: requiredText(entry.kind, `dependencies[${index}].kind`, 500),
    key: requiredText(entry.key, `dependencies[${index}].key`, 2_000),
    dependencyFingerprint,
    provenance: normalizeProvenance(entry.provenance, `dependencies[${index}].provenance`),
  };
  return {
    kind: semantic.kind,
    key: semantic.key,
    fingerprint: semantic.dependencyFingerprint,
    provenance: semantic.provenance,
    occurrences: 1,
  };
}

function normalizeBlocker(entry: PanelReferenceBlockerInput, index: number): PanelReferenceBlocker {
  if (entry.phase !== "resolution" && entry.phase !== "generation" && entry.phase !== "currentness") failInput(`blockers[${index}].phase 无效。`);
  const semantic = {
    code: requiredText(entry.code, `blockers[${index}].code`, 500),
    phase: entry.phase,
    ...(optionalText(entry.subjectId, `blockers[${index}].subjectId`, 2_000) ? { subjectId: entry.subjectId!.trim() } : {}),
    message: requiredText(entry.message, `blockers[${index}].message`, 8_000),
    provenance: normalizeProvenance(entry.provenance, `blockers[${index}].provenance`),
    extensions: normalizeExtensions(entry.extensions, `blockers[${index}].extensions`),
  };
  return { ...semantic, fingerprint: digest(semantic) };
}

function normalizeWarning(entry: PanelReferenceWarningInput, index: number): PanelReferenceWarning {
  const semantic = {
    code: requiredText(entry.code, `warnings[${index}].code`, 500),
    ...(optionalText(entry.subjectId, `warnings[${index}].subjectId`, 2_000) ? { subjectId: entry.subjectId!.trim() } : {}),
    message: requiredText(entry.message, `warnings[${index}].message`, 8_000),
    provenance: normalizeProvenance(entry.provenance, `warnings[${index}].provenance`),
    extensions: normalizeExtensions(entry.extensions, `warnings[${index}].extensions`),
  };
  return { ...semantic, fingerprint: digest(semantic) };
}

function blocker(input: PanelReferenceBlockerInput): PanelReferenceBlocker {
  return normalizeBlocker(input, 0);
}

function warning(input: PanelReferenceWarningInput): PanelReferenceWarning {
  return normalizeWarning(input, 0);
}

function uniqueByFingerprint<T extends { fingerprint: string }>(items: T[]): T[] {
  return [...new Map(items.map((item) => [item.fingerprint, item] as const)).values()]
    .sort((left, right) => left.fingerprint.localeCompare(right.fingerprint, "en"));
}

function resolutionSemantic(resolution: Omit<PanelReferenceResolutionCore, "id" | "fingerprint">): unknown {
  return resolution;
}

/**
 * 无 I/O、无时钟、无随机数的唯一中立归一化器。调用方只能把结果作为只读投影；
 * 它不创建 Head、不写数据库，也不替代 Studio/Fusion 的现有事实源。
 */
export function createPanelReferenceResolution(
  draft: PanelReferenceResolutionDraft,
): PanelReferenceResolutionCore {
  const project = normalizeProject(draft.project);
  const unit = normalizeUnit(draft.unit);
  const panel = normalizePanel(draft.panel);
  const time = normalizeTime(draft.time);
  const rawSourceSpans = (draft.sourceSpans ?? []).map(normalizeSourceSpan);
  const sourceSpanGroups = groupedWithOccurrences(rawSourceSpans, (entry) => entry.id);
  const rawSemanticAssets = (draft.semanticAssets ?? []).map(normalizeSemanticAsset);
  const semanticGroups = groupedWithOccurrences(rawSemanticAssets, (entry) => entry.assetId);
  const rawForbiddenAssets = (draft.forbiddenAssets ?? []).map(normalizeForbiddenAsset);
  const forbiddenGroups = groupedWithOccurrences(rawForbiddenAssets, (entry) => entry.assetId);
  const rawExcludedAssets = (draft.excludedAssets ?? []).map(normalizeExcludedAsset);
  const excludedGroups = groupedWithOccurrences(rawExcludedAssets, (entry) => entry.subjectId);
  const rawUnresolved = (draft.unresolved ?? []).map(normalizeUnresolved);
  const unresolvedGroups = groupedWithOccurrences(rawUnresolved, (entry) => entry.subjectId);
  const rawControls = (draft.controlReferences ?? []).map(normalizeControl);
  const controlGroups = groupedWithOccurrences(rawControls, (entry) => entry.id);
  const rawDependencies = (draft.dependencies ?? []).map(normalizeDependency);
  const dependencyGroups = groupedWithOccurrences(rawDependencies, (entry) => entry.key);

  const sourceSpans = sourceSpanGroups.items;
  const semanticAssets = semanticGroups.items;
  const forbiddenAssets = forbiddenGroups.items;
  const excludedAssets = excludedGroups.items;
  const unresolved = unresolvedGroups.items;
  const dependencies = dependencyGroups.items;
  const normalizedControls = controlGroups.items;
  const controlReferences = normalizedControls.length <= PANEL_REFERENCE_RESOLUTION_MAX_VISIBLE_CONTROLS ? normalizedControls : [];
  const overflowControlReferences = normalizedControls.length <= PANEL_REFERENCE_RESOLUTION_MAX_VISIBLE_CONTROLS ? [] : normalizedControls;
  const blockers: PanelReferenceBlocker[] = (draft.blockers ?? []).map(normalizeBlocker);
  const warnings: PanelReferenceWarning[] = (draft.warnings ?? []).map(normalizeWarning);

  const duplicateGroups: Array<[string, Array<{ key: string; occurrences: number }>]> = [
    ["source-span", sourceSpanGroups.duplicateWarnings],
    ["semantic-asset", semanticGroups.duplicateWarnings],
    ["forbidden-asset", forbiddenGroups.duplicateWarnings],
    ["excluded-subject", excludedGroups.duplicateWarnings],
    ["unresolved-subject", unresolvedGroups.duplicateWarnings],
    ["control-reference", controlGroups.duplicateWarnings],
    ["dependency", dependencyGroups.duplicateWarnings],
  ];
  for (const [kind, duplicates] of duplicateGroups) {
    for (const duplicate of duplicates) warnings.push(warning({
      code: "duplicate-input-merged",
      subjectId: duplicate.key,
      message: `${kind} 的 ${duplicate.occurrences} 个完全相同输入已显式合并并保留 occurrences。`,
      extensions: { kind, occurrences: duplicate.occurrences },
    }));
  }
  const conflictGroups: Array<[string, string[], PanelReferenceBlockerPhase]> = [
    ["conflicting-source-span", sourceSpanGroups.conflictKeys, "resolution"],
    ["conflicting-semantic-asset", semanticGroups.conflictKeys, "resolution"],
    ["conflicting-forbidden-asset", forbiddenGroups.conflictKeys, "resolution"],
    ["conflicting-exclusion", excludedGroups.conflictKeys, "resolution"],
    ["conflicting-unresolved-reference", unresolvedGroups.conflictKeys, "resolution"],
    ["conflicting-control-reference", controlGroups.conflictKeys, "generation"],
    ["conflicting-dependency", dependencyGroups.conflictKeys, "currentness"],
  ];
  for (const [code, keys, phase] of conflictGroups) for (const key of keys) blockers.push(blocker({
    code,
    phase,
    subjectId: key,
    message: `${key} 存在多个语义不同的同键输入，拒绝静默选择任一版本。`,
  }));

  const sourceSpanIds = new Set(sourceSpans.map((span) => span.id));
  const evidenceOwners: Array<{ subjectId: string; sourceSpanIds: string[]; kind: string }> = [
    ...semanticAssets.map((asset) => ({ subjectId: asset.assetId, sourceSpanIds: asset.sourceSpanIds, kind: "semantic-asset" })),
    ...forbiddenAssets.map((asset) => ({ subjectId: asset.assetId, sourceSpanIds: asset.sourceSpanIds, kind: "forbidden-asset" })),
    ...unresolved.map((entry) => ({ subjectId: entry.subjectId, sourceSpanIds: entry.sourceSpanIds, kind: "unresolved-reference" })),
    ...excludedAssets.filter((entry) => entry.sourceSpanIds.length > 0)
      .map((entry) => ({ subjectId: entry.subjectId, sourceSpanIds: entry.sourceSpanIds, kind: "excluded-subject" })),
  ];
  if (evidenceOwners.length > 0 && sourceSpans.length === 0) blockers.push(blocker({
    code: "source-span-missing",
    phase: "resolution",
    message: "引用解析含语义对象但没有任何 source span，禁止无来源闭包。",
  }));
  for (const owner of evidenceOwners) {
    if (owner.sourceSpanIds.length === 0) blockers.push(blocker({
      code: "subject-source-span-missing",
      phase: "resolution",
      subjectId: owner.subjectId,
      message: `${owner.kind} ${owner.subjectId} 没有 source span。`,
    }));
    const missing = owner.sourceSpanIds.filter((id) => !sourceSpanIds.has(id));
    if (missing.length > 0) blockers.push(blocker({
      code: "source-span-not-found",
      phase: "resolution",
      subjectId: owner.subjectId,
      message: `${owner.kind} ${owner.subjectId} 引用了不存在的 source span：${missing.join("、")}`,
      extensions: { missing },
    }));
  }

  const visibleAssetIds = new Set(semanticAssets.map((asset) => asset.assetId));
  const forbiddenAssetIds = new Set(forbiddenAssets.map((asset) => asset.assetId));
  const excludedAssetIds = new Set(excludedAssets.flatMap((entry) => entry.assetId ? [entry.assetId] : []));
  for (const assetId of [...visibleAssetIds].filter((id) => forbiddenAssetIds.has(id))) blockers.push(blocker({
    code: "visible-forbidden-conflict",
    phase: "resolution",
    subjectId: assetId,
    message: `资产 ${assetId} 同时声明为可见与 forbidden。`,
  }));
  for (const assetId of [...visibleAssetIds].filter((id) => excludedAssetIds.has(id))) blockers.push(blocker({
    code: "visible-excluded-conflict",
    phase: "resolution",
    subjectId: assetId,
    message: `资产 ${assetId} 同时进入可见语义集合与显式排除集合。`,
  }));
  for (const assetId of [...forbiddenAssetIds].filter((id) => excludedAssetIds.has(id))) blockers.push(blocker({
    code: "forbidden-excluded-conflict",
    phase: "resolution",
    subjectId: assetId,
    message: `资产 ${assetId} 同时声明为 forbidden 与 excluded。`,
  }));

  const controlsForCoverage = normalizedControls;
  const identityCoverage = new Map<string, string[]>();
  const dependencyFingerprints = new Set(dependencies.map((entry) => entry.fingerprint));
  for (const control of controlsForCoverage) {
    for (const assetId of control.coveredAssetIds) {
      if (control.purpose === "identity") {
        identityCoverage.set(assetId, [...(identityCoverage.get(assetId) ?? []), control.id]);
      }
      if (!visibleAssetIds.has(assetId)) blockers.push(blocker({
        code: forbiddenAssetIds.has(assetId) ? "forbidden-control-reference" : "control-reference-unknown-asset",
        phase: "resolution",
        subjectId: control.id,
        message: `控制引用 ${control.id} 覆盖了非可见语义资产 ${assetId}。`,
        extensions: { assetId },
      }));
    }
    if (control.readiness !== "ready") blockers.push(blocker({
      code: control.readiness === "stale" ? "control-reference-stale" : "control-reference-pending",
      phase: "generation",
      subjectId: control.id,
      message: `控制引用 ${control.id} 尚未 ready（${control.readiness}）。`,
    }));
    if (control.readiness === "ready" && !control.contentAddress) blockers.push(blocker({
      code: "control-reference-content-missing",
      phase: "generation",
      subjectId: control.id,
      message: `ready 控制引用 ${control.id} 缺少内容地址。`,
    }));
    if (control.kind === "continuity-frame" && control.readiness === "ready") {
      if (!control.referenceVersion) blockers.push(blocker({
        code: "continuity-frame-reference-version-missing",
        phase: "generation",
        subjectId: control.id,
        message: `ready continuity-frame ${control.id} 缺少 referenceVersion。`,
      }));
      if (control.provenance.length === 0) blockers.push(blocker({
        code: "continuity-frame-provenance-missing",
        phase: "generation",
        subjectId: control.id,
        message: `ready continuity-frame ${control.id} 必须显式绑定上一格结果、Review 或冻结包 provenance。`,
      }));
      const invalidProvenance = control.provenance.filter((entry) => !entry.sourceFingerprint || !SHA256_PATTERN.test(entry.sourceFingerprint));
      if (invalidProvenance.length > 0) blockers.push(blocker({
        code: "continuity-frame-provenance-not-content-addressed",
        phase: "generation",
        subjectId: control.id,
        message: `ready continuity-frame ${control.id} 的每条 provenance 都必须携带小写 SHA-256 sourceFingerprint。`,
        extensions: { provenanceFingerprints: invalidProvenance.map((entry) => entry.fingerprint) },
      }));
      const requiredDependencyFingerprints = [
        ...(control.contentAddress ? [control.contentAddress] : []),
        ...control.provenance.flatMap((entry) => entry.sourceFingerprint && SHA256_PATTERN.test(entry.sourceFingerprint)
          ? [entry.sourceFingerprint]
          : []),
      ];
      const missingDependencyFingerprints = [...new Set(requiredDependencyFingerprints)]
        .filter((fingerprint) => !dependencyFingerprints.has(fingerprint))
        .sort((left, right) => left.localeCompare(right, "en"));
      if (missingDependencyFingerprints.length > 0) blockers.push(blocker({
        code: "continuity-frame-dependency-unverifiable",
        phase: "currentness",
        subjectId: control.id,
        message: `ready continuity-frame ${control.id} 的媒体或 provenance 未进入可验证依赖闭包。`,
        extensions: { missingDependencyFingerprints },
      }));
    }
  }
  for (const assetId of visibleAssetIds) {
    const controls = [...new Set(identityCoverage.get(assetId) ?? [])].sort((left, right) => left.localeCompare(right, "en"));
    if (controls.length === 0) blockers.push(blocker({
      code: "semantic-asset-uncovered",
      phase: "generation",
      subjectId: assetId,
      message: `可见语义资产 ${assetId} 没有 identity 控制引用，禁止以 continuity 引用替代身份闭包。`,
    }));
    if (controls.length > 1) blockers.push(blocker({
      code: "semantic-asset-multiply-covered",
      phase: "generation",
      subjectId: assetId,
      message: `可见语义资产 ${assetId} 同时被多个 identity 控制引用覆盖：${controls.join("、")}`,
      extensions: { controls },
    }));
  }
  if (overflowControlReferences.length > 0) blockers.push(blocker({
    code: "visible-control-reference-overflow",
    phase: "generation",
    message: `identity + continuity 共有 ${overflowControlReferences.length} 个控制引用，超过上限 ${PANEL_REFERENCE_RESOLUTION_MAX_VISIBLE_CONTROLS}；未选择或丢弃任何一项。`,
    extensions: { count: overflowControlReferences.length, maximum: PANEL_REFERENCE_RESOLUTION_MAX_VISIBLE_CONTROLS },
  }));

  for (const entry of unresolved) {
    if (entry.presence === "optional") warnings.push(warning({
      code: `optional-${entry.status}`,
      subjectId: entry.subjectId,
      message: `optional 引用 ${entry.subjectId} 仍为 ${entry.status}；保留为警告且不静默绑定。`,
      extensions: { candidates: entry.candidateAssetIds },
    }));
    else blockers.push(blocker({
      code: `${entry.presence}-${entry.status}`,
      phase: "resolution",
      subjectId: entry.subjectId,
      message: `${entry.presence} 引用 ${entry.subjectId} 仍为 ${entry.status}，阻断 generation-ready。`,
      extensions: { candidates: entry.candidateAssetIds },
    }));
  }

  const confirmedEmpty = draft.confirmedEmpty === true;
  if (confirmedEmpty && semanticAssets.length > 0) blockers.push(blocker({
    code: "confirmed-empty-conflict",
    phase: "resolution",
    message: "confirmed-empty 与非空可见语义资产集合冲突。",
  }));

  let normalizedBlockers = uniqueByFingerprint(blockers);
  const resolutionBlocked = () => normalizedBlockers.some((entry) => entry.phase === "resolution");
  let closure: PanelReferenceClosure;
  if (resolutionBlocked()) closure = "unresolved";
  else if (semanticAssets.length > 0) closure = "resolved";
  else if (confirmedEmpty) closure = "confirmed-empty";
  else {
    normalizedBlockers = uniqueByFingerprint([...normalizedBlockers, blocker({
      code: "empty-not-confirmed",
      phase: "resolution",
      message: "可见语义集合为空，但上游没有显式 confirmed-empty 裁决。",
    })]);
    closure = "unresolved";
  }

  if (draft.claimedClosure && draft.claimedClosure !== closure) {
    normalizedBlockers = uniqueByFingerprint([...normalizedBlockers, blocker({
      code: "source-closure-mismatch",
      phase: "resolution",
      message: `上游声明 closure=${draft.claimedClosure}，Core 归一化结果为 ${closure}。`,
      extensions: { claimed: draft.claimedClosure, computed: closure },
    })]);
    closure = "unresolved";
  }

  const preliminarilyReady = closure !== "unresolved"
    && normalizedBlockers.length === 0
    && overflowControlReferences.length === 0
    && controlReferences.every((entry) => entry.readiness === "ready");
  if (draft.claimedGenerationReady === false && preliminarilyReady) normalizedBlockers = uniqueByFingerprint([...normalizedBlockers, blocker({
    code: "source-generation-blocked",
    phase: "generation",
    message: "上游显式声明 generationReady=false；Core 保持失败关闭。",
  })]);
  if (draft.claimedGenerationReady === true && !preliminarilyReady) normalizedBlockers = uniqueByFingerprint([...normalizedBlockers, blocker({
    code: "source-generation-ready-mismatch",
    phase: "currentness",
    message: "上游声明 generationReady=true，但中立 Core 仍存在阻断。",
  })]);
  const generationReady = closure !== "unresolved"
    && normalizedBlockers.length === 0
    && overflowControlReferences.length === 0
    && controlReferences.length <= PANEL_REFERENCE_RESOLUTION_MAX_VISIBLE_CONTROLS
    && controlReferences.every((entry) => entry.readiness === "ready");

  const semantic: Omit<PanelReferenceResolutionCore, "id" | "fingerprint"> = {
    schemaVersion: 3,
    kind: "panel-reference-resolution",
    resolverVersion: PANEL_REFERENCE_RESOLUTION_CORE_VERSION,
    project,
    unit,
    panel,
    time,
    sourceSpans,
    semanticAssets,
    excludedAssets,
    forbiddenAssets,
    unresolved,
    controlReferences,
    overflowControlReferences,
    dependencies,
    confirmedEmpty,
    closure,
    blockers: normalizedBlockers,
    warnings: uniqueByFingerprint(warnings),
    generationReady,
    provenance: normalizeProvenance(draft.provenance, "provenance"),
    extensions: normalizeExtensions(draft.extensions, "extensions"),
  };
  const fingerprint = digest(resolutionSemantic(semantic));
  return { ...semantic, id: `panel-reference-resolution-${fingerprint.slice(0, 32)}`, fingerprint };
}

function recordSemantic(record: Record<string, unknown>, omitted: string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => !omitted.includes(key)));
}

function assertRecordFingerprint(record: { fingerprint: string }, omitted: string[], label: string): void {
  const expected = digest(recordSemantic(record as unknown as Record<string, unknown>, [...omitted, "fingerprint", "occurrences"]));
  if (record.fingerprint !== expected) throw new PanelReferenceResolutionCoreError("tampered", `${label} 内容与 fingerprint 不一致。`);
}

/** 验证内容地址、派生门禁与每个成员指纹；无 I/O。 */
export function assertPanelReferenceResolutionIntegrity(
  resolution: PanelReferenceResolutionCore,
): PanelReferenceResolutionCore {
  if (resolution.schemaVersion !== 3 || resolution.kind !== "panel-reference-resolution"
    || resolution.resolverVersion !== PANEL_REFERENCE_RESOLUTION_CORE_VERSION) {
    throw new PanelReferenceResolutionCoreError("tampered", "PanelReferenceResolution Core schema/version 无效。");
  }
  const { id: _id, fingerprint: _fingerprint, ...semantic } = resolution;
  const expected = digest(resolutionSemantic(semantic));
  if (resolution.fingerprint !== expected || resolution.id !== `panel-reference-resolution-${expected.slice(0, 32)}`) {
    throw new PanelReferenceResolutionCoreError("tampered", "PanelReferenceResolution 内容地址无效。");
  }
  for (const [index, entry] of resolution.sourceSpans.entries()) assertRecordFingerprint(entry, ["id"], `sourceSpans[${index}]`);
  for (const [index, entry] of resolution.semanticAssets.entries()) assertRecordFingerprint(entry, [], `semanticAssets[${index}]`);
  for (const [index, entry] of resolution.forbiddenAssets.entries()) assertRecordFingerprint(entry, [], `forbiddenAssets[${index}]`);
  for (const [index, entry] of resolution.excludedAssets.entries()) assertRecordFingerprint(entry, [], `excludedAssets[${index}]`);
  for (const [index, entry] of resolution.unresolved.entries()) assertRecordFingerprint(entry, [], `unresolved[${index}]`);
  const allControls = [...resolution.controlReferences, ...resolution.overflowControlReferences];
  for (const [index, entry] of allControls.entries()) {
    assertRecordFingerprint(entry, [], `controlReferences[${index}]`);
    if (entry.kind !== "asset" && entry.kind !== "composite" && entry.kind !== "continuity-frame") {
      throw new PanelReferenceResolutionCoreError("tampered", `controlReferences[${index}].kind 无效。`);
    }
    if (entry.purpose !== "identity" && entry.purpose !== "continuity") {
      throw new PanelReferenceResolutionCoreError("tampered", `controlReferences[${index}].purpose 无效。`);
    }
    if (entry.kind === "continuity-frame" && entry.purpose !== "continuity") {
      throw new PanelReferenceResolutionCoreError("tampered", `controlReferences[${index}] continuity-frame purpose 无效。`);
    }
    if (entry.kind === "continuity-frame" && entry.contentAddress && !SHA256_PATTERN.test(entry.contentAddress)) {
      throw new PanelReferenceResolutionCoreError("tampered", `controlReferences[${index}] continuity-frame contentAddress 无效。`);
    }
  }
  for (const [index, entry] of resolution.blockers.entries()) assertRecordFingerprint(entry, [], `blockers[${index}]`);
  for (const [index, entry] of resolution.warnings.entries()) assertRecordFingerprint(entry, [], `warnings[${index}]`);
  if (resolution.controlReferences.length > PANEL_REFERENCE_RESOLUTION_MAX_VISIBLE_CONTROLS) {
    throw new PanelReferenceResolutionCoreError("tampered", "可见控制引用超过 6 项。 ");
  }
  if (resolution.overflowControlReferences.length > 0 && resolution.controlReferences.length > 0) {
    throw new PanelReferenceResolutionCoreError("tampered", "超限引用存在时不得静默选择部分可见引用。 ");
  }
  const expectedReady = resolution.closure !== "unresolved"
    && resolution.blockers.length === 0
    && resolution.overflowControlReferences.length === 0
    && resolution.controlReferences.every((entry) => entry.readiness === "ready");
  if (resolution.generationReady !== expectedReady) {
    throw new PanelReferenceResolutionCoreError("tampered", "generationReady 与 closure/blockers/control readiness 不一致。 ");
  }
  return resolution;
}

/**
 * 对目标依赖做局部 currentness 比较。额外的无关 current dependency 不会让本格失效；
 * 冻结依赖缺失、变化或同键冲突都会失败关闭。
 */
export function inspectPanelReferenceResolutionCurrentness(
  resolution: PanelReferenceResolutionCore,
  currentDependencies: PanelReferenceCurrentDependency[],
): PanelReferenceCurrentness {
  assertPanelReferenceResolutionIntegrity(resolution);
  if (!Array.isArray(currentDependencies)) failInput("currentDependencies 必须是数组。 ");
  const currentGroups = new Map<string, Set<string>>();
  for (const [index, entry] of currentDependencies.entries()) {
    const key = requiredText(entry.key, `currentDependencies[${index}].key`, 2_000);
    const fingerprint = requiredText(entry.fingerprint, `currentDependencies[${index}].fingerprint`, 64);
    if (!SHA256_PATTERN.test(fingerprint)) failInput(`currentDependencies[${index}].fingerprint 必须是小写 SHA-256。`);
    const values = currentGroups.get(key) ?? new Set<string>();
    values.add(fingerprint);
    currentGroups.set(key, values);
  }
  const frozenGroups = new Map<string, Set<string>>();
  for (const dependency of resolution.dependencies) {
    const values = frozenGroups.get(dependency.key) ?? new Set<string>();
    values.add(dependency.fingerprint);
    frozenGroups.set(dependency.key, values);
  }
  const driftedDependencies: PanelReferenceDependencyDrift[] = [];
  for (const [key, expectedValues] of [...frozenGroups.entries()].sort(([left], [right]) => left.localeCompare(right, "en"))) {
    if (expectedValues.size !== 1) {
      driftedDependencies.push({ key, reason: "conflicting-frozen-values" });
      continue;
    }
    const expected = [...expectedValues][0]!;
    const actualValues = currentGroups.get(key);
    if (!actualValues) {
      driftedDependencies.push({ key, reason: "missing", expected });
      continue;
    }
    if (actualValues.size !== 1) {
      driftedDependencies.push({ key, reason: "conflicting-current-values", expected });
      continue;
    }
    const actual = [...actualValues][0]!;
    if (actual !== expected) driftedDependencies.push({ key, reason: "changed", expected, actual });
  }
  const normalizedCurrent = [...currentGroups.entries()]
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([key, values]) => [key, [...values].sort()] as const);
  return {
    resolutionId: resolution.id,
    resolutionFingerprint: resolution.fingerprint,
    currentSnapshotFingerprint: digest(normalizedCurrent),
    current: driftedDependencies.length === 0,
    driftedDependencies,
  };
}

export function assertPanelReferenceResolutionCurrent(
  resolution: PanelReferenceResolutionCore,
  currentDependencies: PanelReferenceCurrentDependency[],
): PanelReferenceResolutionCore {
  const currentness = inspectPanelReferenceResolutionCurrentness(resolution, currentDependencies);
  if (!currentness.current) throw new PanelReferenceResolutionCoreError(
    "not-current",
    "PanelReferenceResolution 依赖已漂移。",
    currentness.driftedDependencies.map((entry) => `${entry.key}:${entry.reason}`),
  );
  return resolution;
}

function dependencyFingerprint(value: string): string {
  return SHA256_PATTERN.test(value) ? value : digest(value);
}

function sourceSpanFromStudio(
  span: StudioFrozenAssetBindingProvenance["bindingSet"]["sourceSpans"][number],
): PanelReferenceSourceSpanInput {
  const semantic = {
    sourceId: span.scriptRevisionId,
    sourceFingerprint: span.scriptSha256,
    start: span.startOffsetUtf16,
    end: span.endOffsetUtf16,
    surfaceFingerprint: span.surfaceSha256,
  };
  return {
    id: `source-span-${digest(semantic).slice(0, 32)}`,
    kind: "text",
    coordinateSystem: "utf16-code-unit",
    ...semantic,
  };
}

function sourceSpanFromStudioProposal(
  proposal: StudioFrozenAssetBindingProvenance["analysis"]["proposals"][number],
  frozen: StudioFrozenAssetBindingProvenance,
): PanelReferenceSourceSpanInput {
  const semantic = {
    sourceId: frozen.bindingSet.scriptRevisionId,
    sourceFingerprint: frozen.bindingSet.scriptSha256,
    start: proposal.startOffsetUtf16,
    end: proposal.endOffsetUtf16,
    surfaceFingerprint: proposal.surfaceSha256,
  };
  return {
    id: `source-span-${digest(semantic).slice(0, 32)}`,
    kind: "text",
    coordinateSystem: "utf16-code-unit",
    ...semantic,
    provenance: proposal.sectionRevisionId ? [{
      source: "studio-script-section",
      reference: proposal.sectionRevisionId,
      ...(proposal.sectionFingerprint ? { sourceFingerprint: proposal.sectionFingerprint } : {}),
    }] : [],
    extensions: {
      mentionId: proposal.mentionId,
      proposalId: proposal.id,
    },
  };
}

function studioBindingSetFingerprint(
  bindingSet: StudioAssetBindingSet,
  provenance: StudioFrozenAssetBindingProvenance,
): string {
  return digest({
    analysisId: bindingSet.analysisId,
    analysisFingerprint: provenance.analysis.fingerprint,
    unitId: bindingSet.unitId,
    unitRevision: bindingSet.unitRevision,
    unitFingerprint: bindingSet.unitFingerprint,
    panelIndex: bindingSet.panelIndex,
    scriptRevisionId: bindingSet.scriptRevisionId,
    scriptSha256: bindingSet.scriptSha256,
    promptRevisionId: bindingSet.promptRevisionId,
    promptSha256: bindingSet.promptSha256,
    bindings: bindingSet.bindings,
    identityKeyFingerprints: bindingSet.identityKeyFingerprints,
    decisionReceipts: provenance.decisions
      .map((decision) => ({ id: decision.id, fingerprint: decision.fingerprint }))
      .sort((left, right) => left.id.localeCompare(right.id, "en")),
    unresolvedOptionalMentionIds: [...bindingSet.unresolvedOptionalMentionIds].sort((left, right) => left.localeCompare(right, "en")),
    ...(bindingSet.confirmedEmpty ? {
      confirmedEmpty: true,
      emptyConfirmation: {
        id: bindingSet.emptyConfirmationId,
        fingerprint: bindingSet.emptyConfirmationFingerprint,
      },
    } : {}),
  });
}

export interface StudioPanelReferenceResolutionAdapterInput {
  projectId: string;
  target: StudioGenerationTarget;
  bindingSet: StudioAssetBindingSet;
  frozen: StudioFrozenAssetBindingProvenance;
  /** P7 generation-only continuity controls; identity controls remain derived from BindingSet. */
  continuityControlReferences?: PanelReferenceControlInput[];
  /** Immutable continuity/readiness/head dependencies frozen by generation core. */
  continuityDependencies?: PanelReferenceDependencyInput[];
}

/** 将 Studio 当前 BindingSet + generation 已冻结解析投影到中立 Core；不读取或写入 Head。 */
export function adaptStudioBindingSetToPanelReferenceResolution(
  input: StudioPanelReferenceResolutionAdapterInput,
): PanelReferenceResolutionCore {
  const { bindingSet, frozen, target } = input;
  const panelSourceSpans = frozen.bindingSet.sourceSpans.map(sourceSpanFromStudio);
  const proposalSourceSpans = frozen.analysis.proposals.map((proposal) => sourceSpanFromStudioProposal(proposal, frozen));
  const sourceSpans = [...panelSourceSpans, ...proposalSourceSpans];
  const sourceSpanIds = panelSourceSpans.map((span) => span.id!);
  const proposalSourceSpanByMention = new Map(frozen.analysis.proposals.map((proposal, index) => [
    proposal.mentionId,
    proposalSourceSpans[index]!.id!,
  ] as const));
  const blockers: PanelReferenceBlockerInput[] = [];
  const warnings: PanelReferenceWarningInput[] = [];
  if (bindingSet.id !== frozen.bindingSet.id || bindingSet.fingerprint !== frozen.bindingSet.fingerprint
    || bindingSet.analysisId !== frozen.analysis.id || bindingSet.unitId !== target.unitId
    || bindingSet.panelIndex !== target.panelIndex) {
    blockers.push({
      code: "studio-source-contract-mismatch",
      phase: "resolution",
      message: "Studio BindingSet、frozen resolution 与目标宫格身份不一致。",
    });
  }
  if (studioBindingSetFingerprint(bindingSet, frozen) !== bindingSet.fingerprint) blockers.push({
    code: "studio-binding-set-fingerprint-mismatch",
    phase: "currentness",
    subjectId: bindingSet.id,
    message: "Studio BindingSet 内容与冻结 fingerprint 不一致。",
  });
  const { fingerprint: _frozenFingerprint, ...frozenSemantic } = frozen;
  if (digest(frozenSemantic) !== frozen.fingerprint) blockers.push({
    code: "studio-frozen-provenance-fingerprint-mismatch",
    phase: "currentness",
    subjectId: bindingSet.id,
    message: "Studio frozen binding provenance fingerprint 无效。",
  });
  if (!frozen.currentness.head || !frozen.currentness.current || !frozen.currentness.ready) blockers.push({
    code: "studio-binding-not-current",
    phase: "currentness",
    subjectId: bindingSet.id,
    message: "Studio BindingSet 不是 current + ready。",
    extensions: {
      blockers: [...frozen.currentness.blockers],
      staleReasons: [...frozen.currentness.staleReasons],
    },
  });
  for (const item of frozen.currentness.warnings) warnings.push({
    code: "studio-upstream-warning",
    subjectId: bindingSet.id,
    message: item,
  });

  const bindingByAsset = new Map(bindingSet.bindings.map((binding) => [binding.assetId, binding] as const));
  const semanticAssets: PanelReferenceSemanticAssetInput[] = [];
  const forbiddenAssets: PanelReferenceForbiddenAssetInput[] = [];
  const controlReferences: PanelReferenceControlInput[] = [];
  for (const resolution of frozen.assetResolutionSnapshots) {
    const { fingerprint: _resolutionFingerprint, ...resolutionSemantic } = resolution;
    if (digest(resolutionSemantic) !== resolution.fingerprint) blockers.push({
      code: "studio-reference-resolution-fingerprint-mismatch",
      phase: "currentness",
      subjectId: resolution.assetId,
      message: `Studio frozen reference resolution ${resolution.assetId} fingerprint 无效。`,
    });
    const binding = bindingByAsset.get(resolution.assetId);
    if (!binding || binding.presence !== resolution.presence || binding.category !== resolution.category
      || binding.semanticFingerprint !== resolution.bindingSemanticFingerprint
      || binding.definitionVersionId !== resolution.definitionVersionId
      || binding.authorityEventId !== resolution.authorityEventId
      || binding.authorityVersionId !== resolution.authorityVersionId
      || binding.assetVersionId !== resolution.assetVersionId
      || binding.mediaSha256 !== resolution.mediaSha256) {
      blockers.push({
        code: "studio-binding-resolution-mismatch",
        phase: "resolution",
        subjectId: resolution.assetId,
        message: `Studio BindingSet 与 frozen resolution 的资产 ${resolution.assetId} 不一致。`,
      });
    }
    const identity: PanelReferenceAssetIdentitySnapshot = {
      definitionVersionId: resolution.definitionVersionId,
      authorityEventId: resolution.authorityEventId,
      authorityVersionId: resolution.authorityVersionId,
      assetVersionId: resolution.assetVersionId,
      mediaSha256: resolution.mediaSha256,
      semanticFingerprint: resolution.bindingSemanticFingerprint,
    };
    const common = {
      assetId: resolution.assetId,
      category: resolution.category,
      role: resolution.role,
      mentionIds: [...resolution.mentionIds],
      sourceSpanIds: [...new Set(resolution.mentionIds.flatMap((mentionId) => {
        const spanId = proposalSourceSpanByMention.get(mentionId);
        return spanId ? [spanId] : [];
      }))].sort((left, right) => left.localeCompare(right, "en")),
      identity,
      provenance: [{ source: "studio-asset-binding-set", reference: bindingSet.id, sourceFingerprint: bindingSet.fingerprint }],
      extensions: {
        knowledgeFingerprint: resolution.knowledgeFingerprint,
        applicabilityFingerprint: resolution.applicabilityFingerprint,
        frozenResolutionFingerprint: resolution.fingerprint,
      },
    } satisfies Omit<PanelReferenceSemanticAssetInput, "presence">;
    if (resolution.presence === "forbidden") forbiddenAssets.push(common);
    else {
      semanticAssets.push({ ...common, presence: resolution.presence });
      controlReferences.push({
        id: `control-${digest({ assetId: resolution.assetId, mediaSha256: resolution.mediaSha256, assetVersionId: resolution.assetVersionId }).slice(0, 32)}`,
        kind: "asset",
        coveredAssetIds: [resolution.assetId],
        readiness: "ready",
        contentAddress: `sha256:${resolution.mediaSha256}`,
        referenceVersion: resolution.assetVersionId,
        provenance: [{ source: "studio-frozen-reference-resolution", reference: resolution.assetId, sourceFingerprint: resolution.fingerprint }],
      });
    }
  }
  for (const binding of bindingSet.bindings) if (!frozen.assetResolutionSnapshots.some((entry) => entry.assetId === binding.assetId)) blockers.push({
    code: "studio-binding-silent-drop",
    phase: "resolution",
    subjectId: binding.assetId,
    message: `Studio BindingSet 资产 ${binding.assetId} 未进入 frozen resolution。`,
  });

  const proposalById = new Map(frozen.analysis.proposals.map((proposal) => [proposal.id, proposal] as const));
  const decisionByProposal = new Map(frozen.decisions.map((decision) => [decision.proposalId, decision] as const));
  const excludedAssets: PanelReferenceExcludedAssetInput[] = [];
  const unresolved: PanelReferenceUnresolvedInput[] = [];
  for (const proposal of frozen.analysis.proposals) {
    const decision = decisionByProposal.get(proposal.id);
    if (decision?.action === "exclude") {
      excludedAssets.push({
        subjectId: proposal.mentionId,
        reason: decision.note || "Studio 人工 decision 显式排除。",
        sourceSpanIds: proposalSourceSpanByMention.get(proposal.mentionId)
          ? [proposalSourceSpanByMention.get(proposal.mentionId)!]
          : sourceSpanIds,
        provenance: [{ source: "studio-mention-decision", reference: decision.id, sourceFingerprint: decision.fingerprint }],
      });
      continue;
    }
    if (!decision || !proposal.resolvedAssetId) unresolved.push({
      subjectId: proposal.mentionId,
      status: proposal.status === "matched" ? "unconfirmed" : proposal.status,
      presence: proposal.presence,
      candidateAssetIds: proposal.resolvedAssetId ? [proposal.resolvedAssetId] : [],
      sourceSpanIds: proposalSourceSpanByMention.get(proposal.mentionId)
        ? [proposalSourceSpanByMention.get(proposal.mentionId)!]
        : sourceSpanIds,
      reason: proposal.unresolvedOptional ? "Studio optional mention 尚未人工确认。" : "Studio mention 缺少当前人工确认。",
      provenance: [{ source: "studio-mention-analysis", reference: frozen.analysis.id, sourceFingerprint: frozen.analysis.fingerprint }],
    });
  }
  for (const decision of frozen.decisions) if (!proposalById.has(decision.proposalId)) blockers.push({
    code: "studio-orphan-decision",
    phase: "resolution",
    subjectId: decision.id,
    message: `Studio decision ${decision.id} 不属于 frozen analysis。`,
  });

  const dependencies: PanelReferenceDependencyInput[] = [
    { kind: "binding-set", key: `studio:binding-set:${bindingSet.id}`, fingerprint: dependencyFingerprint(bindingSet.fingerprint) },
    { kind: "binding-provenance", key: `studio:binding-provenance:${bindingSet.id}`, fingerprint: dependencyFingerprint(frozen.fingerprint) },
    { kind: "analysis", key: `studio:analysis:${frozen.analysis.id}`, fingerprint: dependencyFingerprint(frozen.analysis.fingerprint) },
    { kind: "unit-scope", key: `studio:unit-scope:${bindingSet.unitId}:${bindingSet.panelIndex}`, fingerprint: dependencyFingerprint(frozen.bindingSet.panelBindingScopeFingerprint) },
    { kind: "script", key: `studio:script:${bindingSet.scriptRevisionId}`, fingerprint: dependencyFingerprint(bindingSet.scriptSha256) },
    { kind: "prompt", key: `studio:prompt:${bindingSet.promptRevisionId}`, fingerprint: dependencyFingerprint(bindingSet.promptSha256) },
    ...frozen.decisions.map((decision) => ({ kind: "decision", key: `studio:decision:${decision.id}`, fingerprint: dependencyFingerprint(decision.fingerprint) })),
    ...frozen.analysis.proposals.flatMap((proposal) => proposal.sectionRevisionId && proposal.sectionFingerprint ? [{
      kind: "script-section",
      key: `studio:script-section:${proposal.sectionRevisionId}`,
      fingerprint: dependencyFingerprint(proposal.sectionFingerprint),
    }] : []),
    ...frozen.assetResolutionSnapshots.map((resolution) => ({ kind: "asset-resolution", key: `studio:asset-resolution:${resolution.assetId}`, fingerprint: dependencyFingerprint(resolution.fingerprint) })),
    ...(bindingSet.confirmedEmpty && bindingSet.emptyConfirmationId && bindingSet.emptyConfirmationFingerprint ? [{
      kind: "entity-closure-confirmation",
      key: `studio:entity-closure-confirmation:${bindingSet.emptyConfirmationId}`,
      fingerprint: dependencyFingerprint(bindingSet.emptyConfirmationFingerprint),
    }] : []),
    ...(input.continuityDependencies ?? []).map((entry) => ({
      ...entry,
      ...(entry.provenance === undefined ? {} : { provenance: entry.provenance.map((provenance) => ({ ...provenance })) }),
    })),
  ];
  controlReferences.push(...(input.continuityControlReferences ?? []).map((entry) => ({
    ...entry,
    coveredAssetIds: [...entry.coveredAssetIds],
    provenance: (entry.provenance ?? []).map((provenance) => ({ ...provenance })),
    ...(entry.extensions === undefined ? {} : { extensions: structuredClone(entry.extensions) }),
  })));
  const allResolvedAsNonVisible = semanticAssets.length === 0
    && (forbiddenAssets.length > 0 || excludedAssets.length > 0)
    && unresolved.every((entry) => entry.presence === "optional")
    && frozen.currentness.ready;
  return createPanelReferenceResolution({
    project: { id: input.projectId },
    unit: {
      id: bindingSet.unitId,
      revision: bindingSet.unitRevision,
      fingerprint: bindingSet.unitFingerprint,
      seasonId: target.seasonId,
      episodeId: target.episodeId,
      sequence: target.unitSequence,
    },
    panel: { id: target.panelId, index: target.panelIndex, count: target.panelCount },
    time: {
      unitLocalStartSeconds: target.unitLocalStartSeconds,
      unitLocalEndSeconds: target.unitLocalEndSeconds,
      episodeAbsoluteStartSeconds: target.episodeAbsoluteStartSeconds,
      episodeAbsoluteEndSeconds: target.episodeAbsoluteEndSeconds,
    },
    sourceSpans,
    semanticAssets,
    excludedAssets,
    forbiddenAssets,
    unresolved,
    controlReferences,
    dependencies,
    blockers,
    warnings,
    // A truly empty analysis may only enter generation through the explicit,
    // content-addressed confirmation frozen into the BindingSet. Forbidden or
    // excluded-only panels remain a separate reviewed non-visible closure.
    confirmedEmpty: bindingSet.confirmedEmpty || allResolvedAsNonVisible,
    claimedGenerationReady: frozen.currentness.ready,
    provenance: [{ source: "studio-asset-binding-set", reference: bindingSet.id, sourceFingerprint: bindingSet.fingerprint }],
    extensions: {
      adapter: "studio-binding-set-and-frozen-resolution",
      analysisId: frozen.analysis.id,
      analysisResolverVersion: frozen.analysis.resolverVersion,
      ...(bindingSet.confirmedEmpty ? {
        emptyConfirmationId: bindingSet.emptyConfirmationId,
        emptyConfirmationFingerprint: bindingSet.emptyConfirmationFingerprint,
      } : {}),
    },
  });
}

function fusionResolutionSourceFingerprint(resolution: FusionPanelReferenceResolution): string {
  const {
    resolutionId: _resolutionId,
    resolutionFingerprint: _resolutionFingerprint,
    inputSnapshot: _inputSnapshot,
    ...semantic
  } = resolution;
  return digest(semantic);
}

function fusionSourceSpans(resolution: FusionPanelReferenceResolution): PanelReferenceSourceSpanInput[] {
  return [...new Set(resolution.storyboardRowIds)].sort((left, right) => left.localeCompare(right, "en")).map((rowId) => {
    const semantic = {
      sourceId: resolution.gridContractId,
      sourceFingerprint: resolution.gridSourceFingerprint,
      locator: rowId,
    };
    return {
      id: `source-span-${digest(semantic).slice(0, 32)}`,
      kind: "evidence" as const,
      ...semantic,
      provenance: [{ source: "fusion-storyboard-row", reference: rowId }],
    };
  });
}

/** 将旧 Fusion P2 resolution 只读投影到中立 Core；Fusion 字段只进入 provenance/extensions。 */
export function adaptFusionPanelReferenceResolution(
  resolution: FusionPanelReferenceResolution,
): PanelReferenceResolutionCore {
  const sourceSpans = fusionSourceSpans(resolution);
  const sourceSpanByRow = new Map(sourceSpans.map((span) => [span.kind === "evidence" ? span.locator : "", span.id!] as const));
  const allSourceSpanIds = sourceSpans.map((span) => span.id!);
  const blockers: PanelReferenceBlockerInput[] = [];
  const expectedSourceFingerprint = fusionResolutionSourceFingerprint(resolution);
  if (expectedSourceFingerprint !== resolution.resolutionFingerprint
    || resolution.resolutionId !== `panel-reference-${expectedSourceFingerprint.slice(0, 28)}`) blockers.push({
    code: "fusion-resolution-fingerprint-mismatch",
    phase: "currentness",
    subjectId: resolution.resolutionId,
    message: "Fusion PanelReferenceResolution 内容与 resolutionFingerprint/resolutionId 不一致。",
  });
  const semanticAssets: PanelReferenceSemanticAssetInput[] = resolution.semanticAssets.map((asset) => {
    const assetSourceSpanIds = asset.provenance.flatMap((entry) => entry.storyboardRowId ? [sourceSpanByRow.get(entry.storyboardRowId)] : [])
      .filter((value): value is string => Boolean(value));
    const sourceIds = assetSourceSpanIds.length > 0 ? assetSourceSpanIds : allSourceSpanIds;
    return {
      assetId: asset.assetId,
      category: asset.category,
      presence: "required",
      role: asset.assetName,
      sourceSpanIds: sourceIds,
      identity: {
        ...(asset.hardLock ? {
          semanticRevision: asset.hardLock.referenceVersion,
          authorityEventId: asset.hardLock.lockId,
          assetVersionId: asset.hardLock.referenceVersion,
          mediaSha256: asset.hardLock.sha256,
          semanticFingerprint: digest({
            assetId: asset.hardLock.assetId,
            lockId: asset.hardLock.lockId,
            authority: asset.hardLock.authority,
            sha256: asset.hardLock.sha256,
            referenceVersion: asset.hardLock.referenceVersion,
          }),
        } : {}),
      },
      provenance: asset.provenance.map((entry) => ({
        source: `fusion-${entry.kind}`,
        reference: entry.storyboardRowId ?? entry.continuitySpanIds?.join(",") ?? asset.bindingId,
        note: entry.note,
        extensions: {
          scheduleRowIndexes: [...(entry.scheduleRowIndexes ?? [])].sort((left, right) => left - right),
          sourceShotNumbers: [...(entry.sourceShotNumbers ?? [])].sort((left, right) => left - right),
          continuitySpanIds: [...(entry.continuitySpanIds ?? [])].sort((left, right) => left.localeCompare(right, "en")),
        },
      })),
      extensions: {
        adapter: "fusion-panel-reference-resolution",
        bindingId: asset.bindingId,
        assetName: asset.assetName,
        ...(asset.hardLock ? {
          hardLock: {
            workItemId: asset.hardLock.workItemId,
            lockId: asset.hardLock.lockId,
            authority: asset.hardLock.authority,
            artifactId: asset.hardLock.artifactId ?? null,
            reviewId: asset.hardLock.reviewId ?? null,
          },
        } : {}),
      },
    };
  });
  const excludedAssets: PanelReferenceExcludedAssetInput[] = resolution.excludedAssets.map((entry) => ({
    subjectId: `${entry.source}:${entry.overrideId ?? entry.assetId}`,
    assetId: entry.assetId,
    reason: entry.reason,
    sourceSpanIds: allSourceSpanIds,
    provenance: [{
      source: "fusion-exclusion",
      reference: entry.overrideId ?? entry.assetId,
      extensions: { source: entry.source },
    }],
  }));
  const controlReferences: PanelReferenceControlInput[] = resolution.referenceSlots.map((slot) => ({
    id: slot.id,
    kind: slot.kind === "derived-composite" ? "composite" : "asset",
    coveredAssetIds: [...slot.coveredAssetIds],
    readiness: slot.readiness === "ready" ? "ready" : slot.readiness === "stale" ? "stale" : "pending",
    ...(slot.sha256 ? { contentAddress: `sha256:${slot.sha256}` } : {}),
    ...(slot.assetId || slot.derivedAssetId ? { referenceVersion: slot.assetId ?? slot.derivedAssetId } : {}),
    provenance: [{ source: "fusion-reference-slot", reference: slot.id }],
    extensions: {
      adapter: "fusion-panel-reference-resolution",
      fusionKind: slot.kind,
      assetId: slot.assetId ?? null,
      derivedAssetId: slot.derivedAssetId ?? null,
      artifactId: slot.artifactId ?? null,
      reviewId: slot.reviewId ?? null,
    },
  }));
  const unresolved: PanelReferenceUnresolvedInput[] = [];
  for (const sourceCode of resolution.blockerCodes) {
    if (sourceCode === "unknown-asset" || sourceCode === "timeline-conflict") unresolved.push({
      subjectId: `fusion:${resolution.resolutionId}:${sourceCode}`,
      status: sourceCode === "unknown-asset" ? "unmatched" : "unconfirmed",
      presence: "required",
      sourceSpanIds: allSourceSpanIds,
      reason: resolution.issues.join("；") || `Fusion blocker: ${sourceCode}`,
      provenance: [{ source: "fusion-blocker", reference: sourceCode }],
    });
    else blockers.push({
      code: sourceCode === "stale-derived-artifact" ? "control-reference-stale" : "control-reference-pending",
      phase: "generation",
      subjectId: resolution.resolutionId,
      message: `Fusion 引用控制面仍有阻断：${sourceCode}`,
      extensions: { fusionCode: sourceCode },
    });
  }
  const dependencies: PanelReferenceDependencyInput[] = [
    {
      kind: "source-resolution",
      key: `fusion:resolution:${resolution.resolutionId}`,
      fingerprint: dependencyFingerprint(resolution.resolutionFingerprint),
    },
    {
      kind: "grid-source",
      key: `fusion:grid-source:${resolution.gridContractId}`,
      fingerprint: dependencyFingerprint(resolution.gridSourceFingerprint),
    },
    ...resolution.semanticAssets.flatMap((asset) => asset.hardLock ? [{
      kind: "hard-lock",
      key: `fusion:hard-lock:${asset.assetId}`,
      fingerprint: dependencyFingerprint(digest({
        lockId: asset.hardLock.lockId,
        sha256: asset.hardLock.sha256,
        referenceVersion: asset.hardLock.referenceVersion,
      })),
    }] : []),
  ];
  return createPanelReferenceResolution({
    project: { id: resolution.projectId, contentAddress: resolution.sourceContentAddress },
    unit: { id: resolution.unitItemId, fingerprint: resolution.gridSourceFingerprint },
    panel: { id: resolution.panelId, index: resolution.panelIndex, count: resolution.panelCount },
    time: {
      unitLocalStartSeconds: resolution.startSeconds,
      unitLocalEndSeconds: resolution.endSeconds,
    },
    sourceSpans,
    semanticAssets,
    excludedAssets,
    forbiddenAssets: [],
    unresolved,
    controlReferences,
    dependencies,
    blockers,
    confirmedEmpty: resolution.closureStatus === "confirmed-empty",
    claimedClosure: resolution.closureStatus,
    claimedGenerationReady: resolution.generationReady,
    provenance: [{
      source: "fusion-panel-reference-resolution",
      reference: resolution.resolutionId,
      sourceFingerprint: resolution.resolutionFingerprint,
    }],
    extensions: {
      adapter: "fusion-panel-reference-resolution",
      gridContractId: resolution.gridContractId,
      gridSourceFingerprint: resolution.gridSourceFingerprint,
      storyboardRowIds: [...resolution.storyboardRowIds].sort((left, right) => left.localeCompare(right, "en")),
      sourceShotNumbers: [...resolution.sourceShotNumbers].sort((left, right) => left - right),
      scheduleRowIndexes: [...resolution.scheduleRowIndexes].sort((left, right) => left - right),
      timelineReconciliations: resolution.timelineReconciliations
        .map((entry) => ({
          assetId: entry.assetId,
          difference: entry.difference,
          resolution: entry.resolution,
          status: entry.status,
          evidenceIds: [...entry.evidenceIds].sort((left, right) => left.localeCompare(right, "en")),
          note: entry.note,
        }))
        .sort((left, right) => left.assetId.localeCompare(right.assetId, "en") || left.difference.localeCompare(right.difference, "en")),
      detectedOverflow: resolution.detectedOverflow,
      overflowHandledByDerivedAssetId: resolution.overflowHandledByDerivedAssetId ?? null,
      issues: [...resolution.issues].sort((left, right) => left.localeCompare(right, "zh-CN")),
    },
  });
}
