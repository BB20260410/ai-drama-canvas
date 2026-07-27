import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { withProjectLock } from "./locks.js";
import { getSidecarPaths, readJson, writeJsonAtomic, writeJsonAtomicExclusive } from "./sidecar.js";
import type {
  FusionStoryboardSheetOverflowReport,
  FusionStoryboardSheetPanelCropAudit,
} from "./fusion-storyboard-sheet.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const CONTENT_ADDRESS = /^sha256:[a-f0-9]{64}$/u;
const SHEET_ID = /^sheet-v2-[a-f0-9]{32}$/u;
const LEGACY_SHEET_ID = /^legacy-sheet-[a-f0-9]{32}$/u;

export const FUSION_STORYBOARD_SHEET_RENDER_POLICY_VERSION = "fusion-storyboard-sheet-render-policy-v2" as const;

export type FusionStoryboardSheetArtifactRole = "png" | "svg" | "receipt";
export type FusionStoryboardSheetDerivedStatus = "current" | "stale" | "invalid" | "legacy-invalid";

export type FusionStoryboardSheetCropEvidence = {
  kind: "normalized-focus";
  x: number;
  y: number;
} | {
  kind: "normalized-rect";
  x: number;
  y: number;
  width: number;
  height: number;
};

export interface FusionStoryboardSheetRenderPolicySnapshot {
  policyVersion: typeof FUSION_STORYBOARD_SHEET_RENDER_POLICY_VERSION;
  renderer: "svg-sharp-v2";
  locale: "zh-CN";
  defaultImageFit: "contain";
  textMeasurement: "deterministic-character-units-v2";
  overflowPolicy: "long-sheet";
  rowHeightPolicy: "dynamic-content-measured";
  silentTruncation: false;
  pageWidth: number;
  basePageHeight: number;
  maximumPageHeight: number;
  panelImagePolicies: Record<string, { fit: "contain" } | { fit: "crop"; reason: string; evidence: FusionStoryboardSheetCropEvidence }>;
}

export interface FusionStoryboardSheetContractEvidence {
  contractId: string;
  sourceFingerprint: string;
  productionFingerprint: string;
  contractFingerprint: string;
}

export interface FusionStoryboardSheetRequirementEvidence {
  requirementId: string;
  requirementFingerprint: string;
  complete: true;
}

export interface FusionStoryboardSheetReviewEvidence {
  reviewId: string;
  reviewFingerprint: string;
  decision: "pass";
}

export interface FusionStoryboardSheetSourceArtifactEvidence {
  artifactId: string;
  path: string;
  sha256: string;
  bytes: number;
}

export interface FusionStoryboardSheetPanelEvidence {
  panelId: string;
  panelIndex: number;
  panelCount: number;
  generationJobId: string;
  generationJobFingerprint: string;
  publicationReceiptId: string;
  publicationReceiptFingerprint: string;
  companionPublicationReceiptId?: string;
  companionPublicationReceiptFingerprint?: string;
  raw: FusionStoryboardSheetSourceArtifactEvidence;
  labeled: FusionStoryboardSheetSourceArtifactEvidence;
}

export interface FusionStoryboardSheetCurrentEvidence {
  projectId: string;
  sourceContentAddress: `sha256:${string}`;
  itemId: string;
  contract: FusionStoryboardSheetContractEvidence;
  requirement: FusionStoryboardSheetRequirementEvidence;
  review: FusionStoryboardSheetReviewEvidence;
  panels: FusionStoryboardSheetPanelEvidence[];
  renderPolicy: FusionStoryboardSheetRenderPolicySnapshot;
}

export interface FusionStoryboardSheetOutputArtifact {
  role: Exclude<FusionStoryboardSheetArtifactRole, "receipt">;
  path: string;
  sha256: string;
  bytes: number;
  width: number;
  height: number;
  pageIndex: number;
  pageCount: number;
}

export interface FusionStoryboardSheetRenderEvidence {
  renderFingerprint: string;
  cropAudit: FusionStoryboardSheetPanelCropAudit[];
  overflowReport: FusionStoryboardSheetOverflowReport;
}

export interface FusionStoryboardSheetRegistrationInput extends FusionStoryboardSheetCurrentEvidence {
  renderEvidence: FusionStoryboardSheetRenderEvidence;
  outputs: FusionStoryboardSheetOutputArtifact[];
}

export interface FusionStoryboardSheetRecord extends FusionStoryboardSheetRegistrationInput {
  schemaVersion: 2;
  kind: "fusion-storyboard-sheet-record";
  sheetId: string;
  inputFingerprint: string;
  fingerprint: string;
  registrationFingerprint: string;
  receiptPath: string;
  createdAt: string;
}

export interface FusionStoryboardSheetIndexEntry {
  sheetId: string;
  itemId: string;
  contractId: string;
  requirementId: string;
  reviewId: string;
  inputFingerprint: string;
  fingerprint: string;
  registrationFingerprint: string;
  receiptPath: string;
  receiptSha256: string;
  outputs: FusionStoryboardSheetOutputArtifact[];
  createdAt: string;
}

export interface FusionStoryboardSheetCurrentSelection {
  sheetId: string;
  inputFingerprint: string;
  selectedAt: string;
}

export interface FusionStoryboardSheetLegacyRecordInput {
  itemId: string;
  status?: "stale" | "legacy-invalid";
  contractId?: string;
  requirementId?: string;
  reviewId?: string;
  receiptPath?: string;
  artifacts: Array<{
    role: FusionStoryboardSheetArtifactRole;
    path: string;
    pageIndex?: number;
    pageCount: number;
    sha256?: string;
    bytes?: number;
  }>;
  reason: string;
}

export interface FusionStoryboardSheetLegacyRecord extends FusionStoryboardSheetLegacyRecordInput {
  status: "stale" | "legacy-invalid";
  sheetId: string;
  registeredAt: string;
}

export interface FusionStoryboardSheetStore {
  schemaVersion: 1;
  kind: "fusion-storyboard-sheet-index";
  revision: number;
  records: Record<string, FusionStoryboardSheetIndexEntry>;
  legacyRecords: Record<string, FusionStoryboardSheetLegacyRecord>;
  currentByItemId: Record<string, FusionStoryboardSheetCurrentSelection>;
  updatedAt: string;
}

export interface FusionStoryboardSheetArtifactSnapshot {
  path: string;
  itemId: string;
  sheetId: string;
  inputFingerprint?: string;
  role: FusionStoryboardSheetArtifactRole;
  pageIndex?: number;
  pageCount: number;
  status: FusionStoryboardSheetDerivedStatus;
  reasons: string[];
  contractId: string;
  requirementId?: string;
  reviewId?: string;
  createdAt: string;
}

export interface FusionStoryboardSheetSnapshot {
  storeRevision: number;
  items: FusionStoryboardSheetArtifactSnapshot[];
  byPath: Record<string, FusionStoryboardSheetArtifactSnapshot>;
}

export interface FusionStoryboardSheetStatusContext {
  selectedSheetId?: string;
  currentEvidence?: FusionStoryboardSheetCurrentEvidence;
  integrityReasons?: string[];
}

export interface FusionStoryboardSheetRegistrationResult {
  record: FusionStoryboardSheetRecord;
  store: FusionStoryboardSheetStore;
  created: boolean;
  selected: boolean;
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
  return createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
}

function assertNonEmpty(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} 不能为空。`);
  return normalized;
}

function assertSafeSegment(value: string, label: string): string {
  const normalized = assertNonEmpty(value, label);
  if (!/^[\p{L}\p{N}][\p{L}\p{N}._:-]{0,199}$/u.test(normalized) || normalized === "." || normalized === "..") {
    throw new Error(`${label} 不能越出内容寻址侧车目录。`);
  }
  return normalized;
}

function assertSha(value: string, label: string): string {
  const normalized = value.trim().toLowerCase().replace(/^sha256:/u, "");
  if (!SHA256.test(normalized) || value !== normalized) throw new Error(`${label} 必须是小写完整 SHA-256。`);
  return normalized;
}

function assertAbsolute(value: string, label: string): string {
  if (!path.isAbsolute(value)) throw new Error(`${label} 必须是绝对路径。`);
  return path.normalize(value);
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${label} 必须是正整数。`);
}

function normalizedCoordinate(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${label} 必须位于 [0,1]。`);
}

function validateCropEvidence(value: FusionStoryboardSheetCropEvidence, label: string): void {
  normalizedCoordinate(value.x, `${label}.x`);
  normalizedCoordinate(value.y, `${label}.y`);
  if (value.kind === "normalized-rect") {
    normalizedCoordinate(value.width, `${label}.width`);
    normalizedCoordinate(value.height, `${label}.height`);
    if (value.width <= 0 || value.height <= 0 || value.x + value.width > 1 || value.y + value.height > 1) {
      throw new Error(`${label} 裁切矩形必须完整位于归一化画布内。`);
    }
  }
}

function validateRenderPolicy(policy: FusionStoryboardSheetRenderPolicySnapshot, panelIds: string[]): void {
  if (policy.policyVersion !== FUSION_STORYBOARD_SHEET_RENDER_POLICY_VERSION
    || policy.renderer !== "svg-sharp-v2"
    || policy.locale !== "zh-CN"
    || policy.defaultImageFit !== "contain"
    || policy.textMeasurement !== "deterministic-character-units-v2"
    || policy.overflowPolicy !== "long-sheet"
    || policy.rowHeightPolicy !== "dynamic-content-measured"
    || policy.silentTruncation !== false) {
    throw new Error("P4 正式分镜板渲染策略版本或失败关闭策略无效。");
  }
  assertPositiveInteger(policy.pageWidth, "renderPolicy.pageWidth");
  assertPositiveInteger(policy.basePageHeight, "renderPolicy.basePageHeight");
  assertPositiveInteger(policy.maximumPageHeight, "renderPolicy.maximumPageHeight");
  if (policy.maximumPageHeight < policy.basePageHeight) throw new Error("maximumPageHeight 不能小于 basePageHeight。");
  const expected = [...panelIds].sort();
  const actual = Object.keys(policy.panelImagePolicies).sort();
  if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error("渲染策略必须逐格冻结 contain/crop 决策。");
  for (const [panelId, entry] of Object.entries(policy.panelImagePolicies)) {
    if (entry.fit === "crop") {
      if (entry.reason !== entry.reason.trim() || entry.reason.trim().length < 3) throw new Error(`panel ${panelId} crop 必须冻结至少 3 字的审计理由。`);
      validateCropEvidence(entry.evidence, `panel ${panelId} crop evidence`);
    }
    else if (entry.fit !== "contain") throw new Error(`panel ${panelId} image fit 无效。`);
  }
}

function samePoint(left: { x: number; y: number } | undefined, right: { x: number; y: number }): boolean {
  return Boolean(left && left.x === right.x && left.y === right.y);
}

function sameRect(
  left: { x: number; y: number; width: number; height: number } | undefined,
  right: { x: number; y: number; width: number; height: number },
): boolean {
  return Boolean(left
    && left.x === right.x
    && left.y === right.y
    && left.width === right.width
    && left.height === right.height);
}

function validateNormalizedRect(value: { x: number; y: number; width: number; height: number } | undefined, label: string): void {
  if (!value) throw new Error(`${label} 缺失。`);
  validateCropEvidence({ kind: "normalized-rect", ...value }, label);
}

function validatePixelRect(value: { left: number; top: number; width: number; height: number } | undefined, label: string): void {
  if (!value
    || !Number.isInteger(value.left) || value.left < 0
    || !Number.isInteger(value.top) || value.top < 0
    || !Number.isInteger(value.width) || value.width < 1
    || !Number.isInteger(value.height) || value.height < 1) {
    throw new Error(`${label} 必须是有效正整数像素矩形。`);
  }
}

function validateCropAudit(input: FusionStoryboardSheetRegistrationInput): void {
  if (!Array.isArray(input.renderEvidence.cropAudit)) throw new Error("renderEvidence.cropAudit 必须是逐格数组。");
  const expectedPanelIds = input.panels.map((panel) => panel.panelId).sort();
  const actualPanelIds = input.renderEvidence.cropAudit.map((entry) => entry.panelId).sort();
  if (new Set(actualPanelIds).size !== actualPanelIds.length
    || JSON.stringify(expectedPanelIds) !== JSON.stringify(actualPanelIds)) {
    throw new Error("renderEvidence.cropAudit 必须逐格一一覆盖当前全部宫格。 ");
  }
  for (const audit of input.renderEvidence.cropAudit) {
    const policy = input.renderPolicy.panelImagePolicies[audit.panelId];
    if (!policy || audit.fit !== policy.fit) throw new Error(`宫格 ${audit.panelId} cropAudit 与冻结渲染策略不一致。`);
    for (const [key, value] of Object.entries({
      sourceWidth: audit.sourceWidth,
      sourceHeight: audit.sourceHeight,
      orientedWidth: audit.orientedWidth,
      orientedHeight: audit.orientedHeight,
      targetWidth: audit.targetWidth,
      targetHeight: audit.targetHeight,
    })) assertPositiveInteger(value, `cropAudit ${audit.panelId}.${key}`);
    if (policy.fit === "contain") {
      if (audit.geometry !== "none" || audit.cropApplied !== false
        || audit.focalPoint || audit.requestedRect || audit.appliedRect || audit.appliedPixelRect) {
        throw new Error(`宫格 ${audit.panelId} contain 策略禁止任何裁切证据。`);
      }
      continue;
    }
    if (audit.cropApplied !== true) throw new Error(`宫格 ${audit.panelId} 显式 crop 必须证明实际裁切。`);
    validateNormalizedRect(audit.appliedRect, `cropAudit ${audit.panelId}.appliedRect`);
    validatePixelRect(audit.appliedPixelRect, `cropAudit ${audit.panelId}.appliedPixelRect`);
    if (policy.evidence.kind === "normalized-focus") {
      if (audit.geometry !== "focal-point" || !samePoint(audit.focalPoint, policy.evidence) || audit.requestedRect) {
        throw new Error(`宫格 ${audit.panelId} focal crop 审计与冻结策略不一致。`);
      }
    } else if (audit.geometry !== "rect" || !sameRect(audit.requestedRect, policy.evidence) || audit.focalPoint) {
      throw new Error(`宫格 ${audit.panelId} rect crop 审计与冻结策略不一致。`);
    }
  }
}

const REQUIRED_TEXT_FIELDS = ["imageContentAction", "shotComposition", "shootingMethod", "continuitySound", "dialogueSubtitle"] as const;

function validateOverflowReport(input: FusionStoryboardSheetRegistrationInput): void {
  const report = input.renderEvidence.overflowReport;
  if (!report
    || report.policy !== "long-sheet"
    || report.basePageHeight !== input.renderPolicy.basePageHeight
    || !Number.isInteger(report.actualPageHeight) || report.actualPageHeight < input.renderPolicy.basePageHeight
    || report.actualPageHeight > input.renderPolicy.maximumPageHeight
    || report.expanded !== (report.actualPageHeight > report.basePageHeight)
    || report.overflowPixels !== Math.max(0, report.actualPageHeight - report.basePageHeight)
    || report.allRequiredTextVisible !== true
    || report.silentTruncation !== false
    || !Array.isArray(report.truncatedFields)
    || report.truncatedFields.length !== 0) {
    throw new Error("正式分镜板 overflow report 未严格证明无静默截断。 ");
  }
  const expectedPanelIds = input.panels.map((panel) => panel.panelId).sort();
  const rowIds = Array.isArray(report.rows) ? report.rows.map((row) => row.panelId).sort() : [];
  if (new Set(rowIds).size !== rowIds.length || JSON.stringify(expectedPanelIds) !== JSON.stringify(rowIds)) {
    throw new Error("overflow rows 必须逐格一一覆盖当前全部宫格。 ");
  }
  for (const row of report.rows) {
    if (!Number.isFinite(row.top) || row.top < 0 || !Number.isFinite(row.height) || row.height <= 0) {
      throw new Error(`overflow row ${row.panelId} 几何无效。`);
    }
    const fieldNames = row.textFields.map((field) => field.field).sort();
    if (new Set(fieldNames).size !== fieldNames.length
      || JSON.stringify(fieldNames) !== JSON.stringify([...REQUIRED_TEXT_FIELDS].sort())) {
      throw new Error(`overflow row ${row.panelId} 必须完整证明五项中文字段。`);
    }
    for (const field of row.textFields) {
      if (field.panelId !== row.panelId
        || !SHA256.test(field.contentSha256)
        || !Number.isInteger(field.lineCount) || field.lineCount < 1
        || !Number.isFinite(field.requiredHeight) || field.requiredHeight <= 0
        || !Number.isFinite(field.allocatedHeight) || field.allocatedHeight < field.requiredHeight
        || field.complete !== true) {
        throw new Error(`overflow row ${row.panelId}.${field.field} 完整性审计无效。`);
      }
    }
  }
}

function evidencePayload(input: FusionStoryboardSheetCurrentEvidence): FusionStoryboardSheetCurrentEvidence {
  assertNonEmpty(input.projectId, "projectId");
  if (!CONTENT_ADDRESS.test(input.sourceContentAddress)) throw new Error("sourceContentAddress 必须是 sha256 内容地址。");
  assertSafeSegment(input.itemId, "itemId");
  assertNonEmpty(input.contract.contractId, "contractId");
  assertSha(input.contract.sourceFingerprint, "contract.sourceFingerprint");
  assertSha(input.contract.productionFingerprint, "contract.productionFingerprint");
  assertSha(input.contract.contractFingerprint, "contract.contractFingerprint");
  assertNonEmpty(input.requirement.requirementId, "requirementId");
  assertSha(input.requirement.requirementFingerprint, "requirementFingerprint");
  if (input.requirement.complete !== true) throw new Error("正式分镜板只接受 complete requirement。");
  assertNonEmpty(input.review.reviewId, "reviewId");
  assertSha(input.review.reviewFingerprint, "reviewFingerprint");
  if (input.review.decision !== "pass") throw new Error("正式分镜板只接受有效 pass Review。");
  if (input.panels.length < 2 || input.panels.length > 6) throw new Error("正式分镜板必须冻结 2–6 格。");
  const panelIds = new Set<string>();
  for (const panel of input.panels) {
    assertNonEmpty(panel.panelId, "panelId");
    if (panelIds.has(panel.panelId)) throw new Error(`panelId 重复：${panel.panelId}`);
    panelIds.add(panel.panelId);
    assertPositiveInteger(panel.panelIndex, `panel ${panel.panelId} index`);
    if (panel.panelCount !== input.panels.length) throw new Error(`panel ${panel.panelId} panelCount 与记录不一致。`);
    assertNonEmpty(panel.generationJobId, `panel ${panel.panelId} generationJobId`);
    assertSha(panel.generationJobFingerprint, `panel ${panel.panelId} generationJobFingerprint`);
    assertNonEmpty(panel.publicationReceiptId, `panel ${panel.panelId} publicationReceiptId`);
    assertSha(panel.publicationReceiptFingerprint, `panel ${panel.panelId} publicationReceiptFingerprint`);
    if (Boolean(panel.companionPublicationReceiptId) !== Boolean(panel.companionPublicationReceiptFingerprint)) {
      throw new Error(`panel ${panel.panelId} companion Publication ID/fingerprint 必须成对。`);
    }
    if (panel.companionPublicationReceiptFingerprint) assertSha(panel.companionPublicationReceiptFingerprint, `panel ${panel.panelId} companionPublicationReceiptFingerprint`);
    for (const [role, artifact] of [["raw", panel.raw], ["labeled", panel.labeled]] as const) {
      assertNonEmpty(artifact.artifactId, `panel ${panel.panelId} ${role} artifactId`);
      assertAbsolute(artifact.path, `panel ${panel.panelId} ${role} path`);
      assertSha(artifact.sha256, `panel ${panel.panelId} ${role} sha256`);
      assertPositiveInteger(artifact.bytes, `panel ${panel.panelId} ${role} bytes`);
    }
  }
  const indexes = input.panels.map((panel) => panel.panelIndex).sort((a, b) => a - b);
  if (indexes.some((value, index) => value !== index + 1)) throw new Error("panelIndex 必须从 1 连续到 panelCount。");
  validateRenderPolicy(input.renderPolicy, [...panelIds]);
  return input;
}

function outputIdentity(output: FusionStoryboardSheetOutputArtifact): Omit<FusionStoryboardSheetOutputArtifact, "path"> {
  return {
    role: output.role,
    sha256: output.sha256,
    bytes: output.bytes,
    width: output.width,
    height: output.height,
    pageIndex: output.pageIndex,
    pageCount: output.pageCount,
  };
}

function validateRegistrationInput(input: FusionStoryboardSheetRegistrationInput): void {
  evidencePayload(input);
  assertSha(input.renderEvidence.renderFingerprint, "renderFingerprint");
  validateCropAudit(input);
  validateOverflowReport(input);
  if (!Array.isArray(input.outputs) || input.outputs.length < 2) throw new Error("正式分镜板必须同时登记 PNG 和 SVG。");
  const paths = new Set<string>();
  let pageCount: number | undefined;
  for (const output of input.outputs) {
    if (output.role !== "png" && output.role !== "svg") throw new Error("正式分镜板输出只支持 PNG/SVG。");
    const normalizedPath = assertAbsolute(output.path, `${output.role} output path`);
    if (paths.has(normalizedPath)) throw new Error(`输出路径重复：${normalizedPath}`);
    paths.add(normalizedPath);
    assertSha(output.sha256, `${output.role} output sha256`);
    assertPositiveInteger(output.bytes, `${output.role} output bytes`);
    assertPositiveInteger(output.width, `${output.role} output width`);
    assertPositiveInteger(output.height, `${output.role} output height`);
    assertPositiveInteger(output.pageIndex, `${output.role} pageIndex`);
    assertPositiveInteger(output.pageCount, `${output.role} pageCount`);
    if (output.width !== input.renderPolicy.pageWidth || output.height !== input.renderEvidence.overflowReport.actualPageHeight) {
      throw new Error(`${output.role.toUpperCase()} 输出尺寸与冻结 page/overflow 证据不一致。`);
    }
    pageCount ??= output.pageCount;
    if (pageCount !== output.pageCount || output.pageIndex > output.pageCount) throw new Error("输出页数身份不一致。");
  }
  for (const role of ["png", "svg"] as const) {
    const pages = input.outputs.filter((output) => output.role === role).map((output) => output.pageIndex).sort((a, b) => a - b);
    if (pages.length !== pageCount || pages.some((value, index) => value !== index + 1)) throw new Error(`${role.toUpperCase()} 输出必须完整覆盖全部页。`);
  }
}

export function fusionStoryboardSheetInputFingerprint(input: FusionStoryboardSheetCurrentEvidence): string {
  const value = evidencePayload(input);
  return digest({
    projectId: value.projectId,
    sourceContentAddress: value.sourceContentAddress,
    itemId: value.itemId,
    contract: value.contract,
    requirement: value.requirement,
    review: value.review,
    panels: [...value.panels].sort((left, right) => left.panelIndex - right.panelIndex),
    renderPolicy: value.renderPolicy,
  });
}

export function fusionStoryboardSheetFingerprint(input: FusionStoryboardSheetRegistrationInput): string {
  validateRegistrationInput(input);
  return digest({
    inputFingerprint: fusionStoryboardSheetInputFingerprint(input),
    renderEvidence: input.renderEvidence,
    outputs: [...input.outputs]
      .sort((left, right) => left.role.localeCompare(right.role, "en") || left.pageIndex - right.pageIndex)
      .map(outputIdentity),
  });
}

export function buildFusionStoryboardSheetId(input: FusionStoryboardSheetCurrentEvidence): string {
  evidencePayload(input);
  return `sheet-v2-${fusionStoryboardSheetInputFingerprint(input).slice(0, 32)}`;
}

function registrationFingerprint(input: FusionStoryboardSheetRegistrationInput, sheetId: string, receiptPath: string): string {
  return digest({
    sheetId,
    inputFingerprint: fusionStoryboardSheetInputFingerprint(input),
    fingerprint: fusionStoryboardSheetFingerprint(input),
    receiptPath,
    outputPaths: [...input.outputs].sort((left, right) => left.role.localeCompare(right.role, "en") || left.pageIndex - right.pageIndex)
      .map((output) => ({ role: output.role, pageIndex: output.pageIndex, path: path.normalize(output.path) })),
  });
}

function emptyStore(): FusionStoryboardSheetStore {
  return {
    schemaVersion: 1,
    kind: "fusion-storyboard-sheet-index",
    revision: 0,
    records: {},
    legacyRecords: {},
    currentByItemId: {},
    updatedAt: new Date(0).toISOString(),
  };
}

function validateStore(store: FusionStoryboardSheetStore): void {
  if (store.schemaVersion !== 1 || store.kind !== "fusion-storyboard-sheet-index"
    || !Number.isInteger(store.revision) || store.revision < 0
    || !store.records || !store.legacyRecords || !store.currentByItemId) {
    throw new Error("P4 分镜板索引 schema 无效，已失败关闭。");
  }
  for (const [sheetId, entry] of Object.entries(store.records)) {
    if (!SHEET_ID.test(sheetId) || entry.sheetId !== sheetId || !path.isAbsolute(entry.receiptPath) || !SHA256.test(entry.receiptSha256)) {
      throw new Error(`P4 分镜板索引项无效：${sheetId}`);
    }
  }
  for (const [itemId, selection] of Object.entries(store.currentByItemId)) {
    const entry = store.records[selection.sheetId];
    if (!entry || entry.itemId !== itemId || selection.inputFingerprint !== entry.inputFingerprint) {
      throw new Error(`P4 当前分镜板选择指向无效：${itemId}`);
    }
  }
}

export async function loadFusionStoryboardSheetStore(projectRoot: string): Promise<FusionStoryboardSheetStore> {
  const paths = getSidecarPaths(projectRoot);
  const store = await readJson<FusionStoryboardSheetStore>(paths.storyboardSheetIndex, emptyStore());
  validateStore(store);
  const receiptRoot = path.resolve(paths.storyboardSheets);
  for (const entry of Object.values(store.records)) {
    const relative = path.relative(receiptRoot, path.resolve(entry.receiptPath));
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`P4 receipt 路径越出侧车目录：${entry.sheetId}`);
  }
  return store;
}

function recordSemanticMatch(left: FusionStoryboardSheetRecord, right: FusionStoryboardSheetRecord): boolean {
  return left.sheetId === right.sheetId
    && left.inputFingerprint === right.inputFingerprint
    && left.fingerprint === right.fingerprint
    && left.registrationFingerprint === right.registrationFingerprint
    && left.receiptPath === right.receiptPath;
}

function indexEntryMatchesRecord(entry: FusionStoryboardSheetIndexEntry, record: FusionStoryboardSheetRecord): boolean {
  return record.sheetId === entry.sheetId
    && record.itemId === entry.itemId
    && record.contract.contractId === entry.contractId
    && record.requirement.requirementId === entry.requirementId
    && record.review.reviewId === entry.reviewId
    && record.inputFingerprint === entry.inputFingerprint
    && record.fingerprint === entry.fingerprint
    && record.registrationFingerprint === entry.registrationFingerprint
    && record.receiptPath === entry.receiptPath
    && digest(record.outputs) === digest(entry.outputs);
}

function validateRecord(record: FusionStoryboardSheetRecord): void {
  if (record.schemaVersion !== 2 || record.kind !== "fusion-storyboard-sheet-record" || !SHEET_ID.test(record.sheetId)) {
    throw new Error("P4 分镜板 receipt schema/sheetId 无效。");
  }
  validateRegistrationInput(record);
  const expectedInput = fusionStoryboardSheetInputFingerprint(record);
  const expectedFingerprint = fusionStoryboardSheetFingerprint(record);
  if (record.inputFingerprint !== expectedInput || record.fingerprint !== expectedFingerprint
    || record.sheetId !== `sheet-v2-${expectedInput.slice(0, 32)}`
    || record.registrationFingerprint !== registrationFingerprint(record, record.sheetId, record.receiptPath)) {
    throw new Error(`P4 分镜板 ${record.sheetId} 内容寻址身份无效。`);
  }
  if (!path.isAbsolute(record.receiptPath)) throw new Error("P4 分镜板 receiptPath 必须是绝对路径。");
  for (const output of record.outputs) {
    const basename = path.basename(output.path);
    if (!basename.includes(record.sheetId) && !output.path.split(path.sep).includes(record.sheetId)) {
      throw new Error(`P4 输出路径未包含 sheetId：${output.path}`);
    }
  }
}

async function safeFileDigest(filePath: string): Promise<{ sha256: string; bytes: number }> {
  const metadata = await lstat(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`文件必须是非符号链接普通文件：${filePath}`);
  const content = await readFile(filePath);
  return { sha256: createHash("sha256").update(content).digest("hex"), bytes: content.length };
}

function assertDescendantPath(root: string, candidate: string, label: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`${label} 越出允许根目录：${candidate}`);
}

async function assertExistingFileInside(root: string, filePath: string, label: string): Promise<void> {
  assertDescendantPath(root, filePath, label);
  const [rootReal, fileReal] = await Promise.all([realpath(root), realpath(filePath)]);
  assertDescendantPath(rootReal, fileReal, label);
}

async function assertOutputPathsInside(projectRoot: string, input: FusionStoryboardSheetRegistrationInput): Promise<void> {
  for (const output of input.outputs) {
    await assertExistingFileInside(projectRoot, output.path, `${output.role.toUpperCase()} 输出`);
  }
}

async function assertOutputFiles(projectRoot: string, input: FusionStoryboardSheetRegistrationInput): Promise<void> {
  await assertOutputPathsInside(projectRoot, input);
  for (const output of input.outputs) {
    const observed = await safeFileDigest(output.path).catch((error) => {
      throw new Error(`无法验证 ${output.role.toUpperCase()} 输出：${error instanceof Error ? error.message : String(error)}`);
    });
    if (observed.sha256 !== output.sha256 || observed.bytes !== output.bytes) {
      throw new Error(`${output.role.toUpperCase()} 输出 SHA/大小与登记证据不一致：${output.path}`);
    }
  }
}

async function readRecordWithSha(receiptPath: string): Promise<{ record: FusionStoryboardSheetRecord; sha256: string }> {
  const metadata = await lstat(receiptPath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`receipt 必须是非符号链接普通文件：${receiptPath}`);
  const content = await readFile(receiptPath);
  let record: FusionStoryboardSheetRecord;
  try {
    record = JSON.parse(content.toString("utf8")) as FusionStoryboardSheetRecord;
  } catch {
    throw new Error(`P4 receipt JSON 已损坏：${receiptPath}`);
  }
  return { record, sha256: createHash("sha256").update(content).digest("hex") };
}

export async function loadFusionStoryboardSheetRecord(projectRoot: string, sheetId: string): Promise<FusionStoryboardSheetRecord> {
  const store = await loadFusionStoryboardSheetStore(projectRoot);
  const entry = store.records[sheetId];
  if (!entry) throw new Error(`P4 分镜板索引中不存在：${sheetId}`);
  return loadFusionStoryboardSheetRecordFromEntry(projectRoot, entry);
}

async function loadFusionStoryboardSheetRecordFromEntry(projectRoot: string, entry: FusionStoryboardSheetIndexEntry): Promise<FusionStoryboardSheetRecord> {
  assertDescendantPath(getSidecarPaths(projectRoot).storyboardSheets, entry.receiptPath, "P4 receipt");
  await assertExistingFileInside(getSidecarPaths(projectRoot).storyboardSheets, entry.receiptPath, "P4 receipt");
  const loaded = await readRecordWithSha(entry.receiptPath);
  if (loaded.sha256 !== entry.receiptSha256) throw new Error(`P4 receipt SHA 与索引不一致：${entry.sheetId}`);
  validateRecord(loaded.record);
  if (!indexEntryMatchesRecord(entry, loaded.record)) throw new Error(`P4 receipt 与索引身份冲突：${entry.sheetId}`);
  await assertOutputPathsInside(projectRoot, loaded.record);
  return loaded.record;
}

export async function registerFusionStoryboardSheetRecord(
  projectRoot: string,
  input: FusionStoryboardSheetRegistrationInput,
  options: { expectedRevision: number; selectCurrent?: boolean; createdAt?: string },
): Promise<FusionStoryboardSheetRegistrationResult> {
  validateRegistrationInput(input);
  const sheetId = buildFusionStoryboardSheetId(input);
  const paths = getSidecarPaths(projectRoot);
  const receiptPath = path.join(paths.storyboardSheets, input.itemId, sheetId, "receipt.json");
  const inputFingerprint = fusionStoryboardSheetInputFingerprint(input);
  const fingerprint = fusionStoryboardSheetFingerprint(input);
  const candidate: FusionStoryboardSheetRecord = {
    schemaVersion: 2,
    kind: "fusion-storyboard-sheet-record",
    ...structuredClone(input),
    sheetId,
    inputFingerprint,
    fingerprint,
    registrationFingerprint: registrationFingerprint(input, sheetId, receiptPath),
    receiptPath,
    createdAt: options.createdAt ?? new Date().toISOString(),
  };
  validateRecord(candidate);
  assertDescendantPath(paths.storyboardSheets, receiptPath, "P4 receipt");
  await assertOutputFiles(projectRoot, candidate);
  return withProjectLock(projectRoot, "storyboard-sheet-index", async () => {
    const store = await loadFusionStoryboardSheetStore(projectRoot);
    const existing = store.records[sheetId];
    if (existing) {
      const record = await loadFusionStoryboardSheetRecord(projectRoot, sheetId);
      if (!recordSemanticMatch(record, candidate)) throw new Error(`sheetId ${sheetId} 已登记为不同路径或记录，拒绝覆盖。`);
      await assertOutputFiles(projectRoot, record);
      return { record, store, created: false, selected: store.currentByItemId[input.itemId]?.sheetId === sheetId };
    }
    if (store.revision !== options.expectedRevision) {
      throw new Error(`P4 分镜板索引已变化（期望 r${options.expectedRevision}，实际 r${store.revision}），CAS 拒绝覆盖。`);
    }
    let persisted = candidate;
    let receiptStatus: "created" | "existing";
    try {
      const orphan = await readRecordWithSha(receiptPath);
      validateRecord(orphan.record);
      if (!recordSemanticMatch(orphan.record, candidate)) {
        throw new Error(`孤立 receipt 与当前登记输入冲突，拒绝覆盖：${receiptPath}`);
      }
      persisted = orphan.record;
      receiptStatus = "existing";
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String((error as NodeJS.ErrnoException).code) : undefined;
      if (code !== "ENOENT") throw error;
      receiptStatus = await writeJsonAtomicExclusive(receiptPath, candidate);
    }
    const receiptBytes = Buffer.from(`${JSON.stringify(persisted, null, 2)}\n`, "utf8");
    const receiptSha256 = createHash("sha256").update(receiptBytes).digest("hex");
    if (receiptStatus === "existing") {
      const observed = await safeFileDigest(receiptPath);
      if (observed.sha256 !== receiptSha256) throw new Error(`已有 receipt 与候选内容冲突：${receiptPath}`);
    }
    store.records[sheetId] = {
      sheetId,
      itemId: input.itemId,
      contractId: input.contract.contractId,
      requirementId: input.requirement.requirementId,
      reviewId: input.review.reviewId,
      inputFingerprint,
      fingerprint,
      registrationFingerprint: persisted.registrationFingerprint,
      receiptPath,
      receiptSha256,
      outputs: structuredClone(input.outputs),
      createdAt: persisted.createdAt,
    };
    const selectCurrent = options.selectCurrent !== false;
    if (selectCurrent) {
      store.currentByItemId[input.itemId] = { sheetId, inputFingerprint, selectedAt: persisted.createdAt };
    }
    store.revision += 1;
    store.updatedAt = persisted.createdAt;
    await writeJsonAtomic(paths.storyboardSheetIndex, store);
    return { record: persisted, store, created: true, selected: selectCurrent };
  });
}

export async function selectFusionStoryboardSheetRecord(projectRoot: string, input: {
  itemId: string;
  sheetId: string;
  expectedRevision: number;
  expectedInputFingerprint: string;
  selectedAt?: string;
}): Promise<FusionStoryboardSheetStore> {
  return withProjectLock(projectRoot, "storyboard-sheet-index", async () => {
    const store = await loadFusionStoryboardSheetStore(projectRoot);
    const entry = store.records[input.sheetId];
    if (!entry || entry.itemId !== input.itemId) throw new Error(`不存在可选择的 P4 分镜板：${input.sheetId}`);
    if (entry.inputFingerprint !== input.expectedInputFingerprint) throw new Error("P4 分镜板 inputFingerprint 已变化，拒绝选择。");
    const previous = store.currentByItemId[input.itemId];
    if (previous?.sheetId === input.sheetId && previous.inputFingerprint === input.expectedInputFingerprint) return store;
    if (store.revision !== input.expectedRevision) throw new Error(`P4 分镜板索引已变化（期望 r${input.expectedRevision}，实际 r${store.revision}）。`);
    await loadFusionStoryboardSheetRecord(projectRoot, input.sheetId);
    const selectedAt = input.selectedAt ?? new Date().toISOString();
    store.currentByItemId[input.itemId] = { sheetId: input.sheetId, inputFingerprint: input.expectedInputFingerprint, selectedAt };
    store.revision += 1;
    store.updatedAt = selectedAt;
    await writeJsonAtomic(getSidecarPaths(projectRoot).storyboardSheetIndex, store);
    return store;
  });
}

function validateLegacyRecordInput(input: FusionStoryboardSheetLegacyRecordInput): void {
  assertSafeSegment(input.itemId, "legacy itemId");
  assertNonEmpty(input.reason, "legacy reason");
  for (const artifact of input.artifacts) {
    assertAbsolute(artifact.path, "legacy artifact path");
    assertPositiveInteger(artifact.pageCount, "legacy pageCount");
    if (artifact.pageIndex !== undefined) assertPositiveInteger(artifact.pageIndex, "legacy pageIndex");
    if (artifact.sha256 !== undefined) assertSha(artifact.sha256, "legacy sha256");
    if (artifact.bytes !== undefined) assertPositiveInteger(artifact.bytes, "legacy bytes");
  }
}

export function buildFusionStoryboardSheetLegacyRecord(
  input: FusionStoryboardSheetLegacyRecordInput,
  registeredAt: string,
): FusionStoryboardSheetLegacyRecord {
  validateLegacyRecordInput(input);
  const reason = assertNonEmpty(input.reason, "legacy reason");
  const status = input.status ?? "legacy-invalid";
  const sheetId = `legacy-sheet-${digest({ ...input, status, reason }).slice(0, 32)}`;
  return { ...structuredClone(input), status, reason, sheetId, registeredAt };
}

export function fusionStoryboardSheetLegacyRecordMatches(
  left: FusionStoryboardSheetLegacyRecord,
  right: FusionStoryboardSheetLegacyRecord,
): boolean {
  return left.sheetId === right.sheetId
    && digest({ ...left, registeredAt: undefined }) === digest({ ...right, registeredAt: undefined });
}

export async function registerLegacyFusionStoryboardSheetRecord(projectRoot: string, input: FusionStoryboardSheetLegacyRecordInput, options: {
  expectedRevision: number;
  registeredAt?: string;
}): Promise<{ record: FusionStoryboardSheetLegacyRecord; store: FusionStoryboardSheetStore; created: boolean }> {
  const record = buildFusionStoryboardSheetLegacyRecord(input, options.registeredAt ?? new Date().toISOString());
  const { sheetId } = record;
  for (const artifact of record.artifacts) {
    await assertExistingFileInside(projectRoot, artifact.path, `legacy ${artifact.role} Artifact`);
    const observed = await safeFileDigest(artifact.path);
    if ((artifact.sha256 && observed.sha256 !== artifact.sha256)
      || (artifact.bytes !== undefined && observed.bytes !== artifact.bytes)) {
      throw new Error(`legacy ${artifact.role} Artifact SHA/大小与登记证据不一致：${artifact.path}`);
    }
  }
  return withProjectLock(projectRoot, "storyboard-sheet-index", async () => {
    const store = await loadFusionStoryboardSheetStore(projectRoot);
    const existing = store.legacyRecords[sheetId];
    if (existing) {
      if (!fusionStoryboardSheetLegacyRecordMatches(existing, record)) throw new Error(`legacy sheetId 冲突：${sheetId}`);
      return { record: existing, store, created: false };
    }
    if (store.revision !== options.expectedRevision) throw new Error(`P4 分镜板索引已变化（期望 r${options.expectedRevision}，实际 r${store.revision}）。`);
    store.legacyRecords[sheetId] = record;
    store.revision += 1;
    store.updatedAt = record.registeredAt;
    await writeJsonAtomic(getSidecarPaths(projectRoot).storyboardSheetIndex, store);
    return { record, store, created: true };
  });
}

function compareCurrentEvidence(record: FusionStoryboardSheetRecord, current: FusionStoryboardSheetCurrentEvidence): string[] {
  const reasons: string[] = [];
  if (record.projectId !== current.projectId) reasons.push("project-id-drift");
  if (record.sourceContentAddress !== current.sourceContentAddress) reasons.push("source-content-address-drift");
  if (record.itemId !== current.itemId) reasons.push("item-id-drift");
  if (record.contract.contractId !== current.contract.contractId) reasons.push("contract-id-drift");
  if (record.contract.sourceFingerprint !== current.contract.sourceFingerprint) reasons.push("contract-source-fingerprint-drift");
  if (record.contract.productionFingerprint !== current.contract.productionFingerprint) reasons.push("contract-production-fingerprint-drift");
  if (record.contract.contractFingerprint !== current.contract.contractFingerprint) reasons.push("contract-fingerprint-drift");
  if (record.requirement.requirementId !== current.requirement.requirementId) reasons.push("requirement-id-drift");
  if (record.requirement.requirementFingerprint !== current.requirement.requirementFingerprint) reasons.push("requirement-fingerprint-drift");
  if (record.review.reviewId !== current.review.reviewId) reasons.push("review-id-drift");
  if (record.review.reviewFingerprint !== current.review.reviewFingerprint) reasons.push("review-fingerprint-drift");
  if (digest(record.panels) !== digest(current.panels)) reasons.push("panel-evidence-drift");
  if (digest(record.renderPolicy) !== digest(current.renderPolicy)) reasons.push("render-policy-drift");
  if (record.inputFingerprint !== fusionStoryboardSheetInputFingerprint(current)) reasons.push("input-fingerprint-drift");
  return [...new Set(reasons)];
}

export function deriveFusionStoryboardSheetStatus(record: FusionStoryboardSheetRecord, context: FusionStoryboardSheetStatusContext): {
  status: FusionStoryboardSheetDerivedStatus;
  reasons: string[];
} {
  const invalidReasons = [...new Set(context.integrityReasons ?? [])];
  try {
    validateRecord(record);
  } catch (error) {
    invalidReasons.push(error instanceof Error ? `record-invalid:${error.message}` : "record-invalid");
  }
  if (invalidReasons.length) return { status: "invalid", reasons: invalidReasons.sort() };
  const staleReasons: string[] = [];
  if (!context.selectedSheetId) staleReasons.push("no-current-selection");
  else if (context.selectedSheetId !== record.sheetId) staleReasons.push("superseded-by-current-selection");
  if (!context.currentEvidence) staleReasons.push("current-evidence-unavailable");
  else staleReasons.push(...compareCurrentEvidence(record, context.currentEvidence));
  return staleReasons.length
    ? { status: "stale", reasons: [...new Set(staleReasons)].sort() }
    : { status: "current", reasons: [] };
}

async function outputIntegrityReasons(record: FusionStoryboardSheetRecord): Promise<string[]> {
  const reasons: string[] = [];
  for (const output of record.outputs) {
    try {
      const observed = await safeFileDigest(output.path);
      if (observed.sha256 !== output.sha256) reasons.push(`${output.role}-page-${output.pageIndex}-sha-drift`);
      if (observed.bytes !== output.bytes) reasons.push(`${output.role}-page-${output.pageIndex}-size-drift`);
    } catch {
      reasons.push(`${output.role}-page-${output.pageIndex}-missing-or-unsafe`);
    }
  }
  return reasons;
}

function snapshotForPath(input: {
  filePath: string;
  itemId: string;
  sheetId: string;
  inputFingerprint?: string;
  role: FusionStoryboardSheetArtifactRole;
  pageIndex?: number;
  pageCount: number;
  status: FusionStoryboardSheetDerivedStatus;
  reasons: string[];
  contractId: string;
  requirementId?: string;
  reviewId?: string;
  createdAt: string;
}): FusionStoryboardSheetArtifactSnapshot {
  return {
    path: path.resolve(input.filePath),
    itemId: input.itemId,
    sheetId: input.sheetId,
    inputFingerprint: input.inputFingerprint,
    role: input.role,
    ...(input.pageIndex === undefined ? {} : { pageIndex: input.pageIndex }),
    pageCount: input.pageCount,
    status: input.status,
    reasons: [...input.reasons],
    contractId: input.contractId,
    requirementId: input.requirementId,
    reviewId: input.reviewId,
    createdAt: input.createdAt,
  };
}

export async function listFusionStoryboardSheetArtifactSnapshot(projectRoot: string, options: {
  currentEvidenceByItemId?: Record<string, FusionStoryboardSheetCurrentEvidence | undefined>;
  verifyFiles?: boolean;
  store?: FusionStoryboardSheetStore;
} = {}): Promise<FusionStoryboardSheetSnapshot> {
  const store = options.store ?? await loadFusionStoryboardSheetStore(projectRoot);
  const items: FusionStoryboardSheetArtifactSnapshot[] = [];
  for (const entry of Object.values(store.records).sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.sheetId.localeCompare(right.sheetId))) {
    let record: FusionStoryboardSheetRecord | undefined;
    const integrityReasons: string[] = [];
    try {
      record = await loadFusionStoryboardSheetRecordFromEntry(projectRoot, entry);
    } catch (error) {
      integrityReasons.push(error instanceof Error ? `receipt-invalid:${error.message}` : "receipt-invalid");
    }
    if (record && options.verifyFiles !== false) integrityReasons.push(...await outputIntegrityReasons(record));
    const derived = record
      ? deriveFusionStoryboardSheetStatus(record, {
          selectedSheetId: store.currentByItemId[entry.itemId]?.sheetId,
          currentEvidence: options.currentEvidenceByItemId?.[entry.itemId],
          integrityReasons,
        })
      : { status: "invalid" as const, reasons: [...new Set(integrityReasons)].sort() };
    const outputs = record?.outputs ?? entry.outputs;
    const pageCount = outputs[0]?.pageCount ?? 1;
    for (const output of outputs) {
      items.push(snapshotForPath({
        filePath: output.path,
        itemId: entry.itemId,
        sheetId: entry.sheetId,
        inputFingerprint: entry.inputFingerprint,
        role: output.role,
        pageIndex: output.pageIndex,
        pageCount: output.pageCount,
        status: derived.status,
        reasons: derived.reasons,
        contractId: entry.contractId,
        requirementId: entry.requirementId,
        reviewId: entry.reviewId,
        createdAt: entry.createdAt,
      }));
    }
    items.push(snapshotForPath({
      filePath: entry.receiptPath,
      itemId: entry.itemId,
      sheetId: entry.sheetId,
      inputFingerprint: entry.inputFingerprint,
      role: "receipt",
      pageCount,
      status: derived.status,
      reasons: derived.reasons,
      contractId: entry.contractId,
      requirementId: entry.requirementId,
      reviewId: entry.reviewId,
      createdAt: entry.createdAt,
    }));
  }
  for (const record of Object.values(store.legacyRecords).sort((left, right) => left.registeredAt.localeCompare(right.registeredAt) || left.sheetId.localeCompare(right.sheetId))) {
    const reasons = [record.status === "legacy-invalid"
      ? "pre-p4-receipt-does-not-freeze-current-p3-evidence"
      : "legacy-v1-never-promotable-under-p4", record.reason];
    if (options.verifyFiles !== false) {
      for (const artifact of record.artifacts) {
        try {
          await assertExistingFileInside(projectRoot, artifact.path, `legacy ${artifact.role} Artifact`);
          const observed = await safeFileDigest(artifact.path);
          if (artifact.sha256 && observed.sha256 !== artifact.sha256) reasons.push(`${artifact.role}-sha-drift`);
          if (artifact.bytes !== undefined && observed.bytes !== artifact.bytes) reasons.push(`${artifact.role}-size-drift`);
        } catch {
          reasons.push(`${artifact.role}-missing-or-unsafe`);
        }
      }
    }
    const legacyStatus = reasons.some((reason) => /(?:sha-drift|size-drift|missing-or-unsafe)$/u.test(reason))
      ? "invalid" as const
      : record.status;
    for (const artifact of record.artifacts) {
      items.push(snapshotForPath({
        filePath: artifact.path,
        itemId: record.itemId,
        sheetId: record.sheetId,
        role: artifact.role,
        pageIndex: artifact.pageIndex,
        pageCount: artifact.pageCount,
        status: legacyStatus,
        reasons: [...new Set(reasons)].sort(),
        contractId: record.contractId ?? "legacy-unknown-contract",
        requirementId: record.requirementId,
        reviewId: record.reviewId,
        createdAt: record.registeredAt,
      }));
    }
  }
  items.sort((left, right) => left.path.localeCompare(right.path, "en") || left.sheetId.localeCompare(right.sheetId, "en"));
  const sheetIdsByPath = new Map<string, Set<string>>();
  for (const item of items) {
    const owners = sheetIdsByPath.get(item.path) ?? new Set<string>();
    owners.add(item.sheetId);
    sheetIdsByPath.set(item.path, owners);
  }
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]!;
    if ((sheetIdsByPath.get(item.path)?.size ?? 0) <= 1) continue;
    items[index] = {
      ...item,
      status: "invalid",
      reasons: [...new Set([...item.reasons, "artifact-path-claimed-by-multiple-sheets"])].sort(),
    };
  }
  const byPath: Record<string, FusionStoryboardSheetArtifactSnapshot> = {};
  for (const item of items) {
    byPath[item.path] = item;
  }
  return { storeRevision: store.revision, items, byPath };
}

export const listFusionStoryboardSheetSnapshot = listFusionStoryboardSheetArtifactSnapshot;
