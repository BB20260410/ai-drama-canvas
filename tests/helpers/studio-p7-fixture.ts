import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import {
  STUDIO_CONTINUITY_FIELDS,
  type StudioContinuityField,
} from "../../src/core/studio-continuity.js";
import {
  appendStudioContinuityObservation,
  getStudioContinuityReadiness,
  type StudioContinuityWriteResult,
} from "../../src/core/studio-continuity-ledger.js";
import {
  appendStudioAssetVersion,
  createStudioCanonicalAsset,
  evaluateStudioAssetApplicability,
  getStudioCanonicalAsset,
  getStudioCanonicalAssetKnowledgeSnapshot,
  importStudioMedia,
  reviewStudioAssetVersion,
  setStudioPrimaryAuthority,
  type StudioCanonicalAssetCategory,
  type StudioMediaMetadata,
} from "../../src/core/material-studio.js";
import { createManagedProject, inspectManagedProject, type ProjectShell } from "../../src/core/managed-project.js";
import { getActiveManagedStudioContext } from "../../src/core/active-managed-studio-context.js";
import {
  authorizeStudioUnitGridContinuationWaiver,
  registerStudioVerifiedHistoricalImportContinuationWaiver,
} from "../../src/core/studio-generation-ledger.js";
import {
  analyzeStudioPanelAssetMentions,
  appendStudioPromptRevision,
  appendStudioScriptRevision,
  createStudioProductionUnit,
  createStudioPromptDocument,
  createStudioScriptDocument,
  freezeStudioPanelAssetBindingSet,
  getStudioProductionUnitSnapshot,
  getStudioProductionPanelTimeContext,
  recordStudioMentionDecision,
  type StudioAssetBindingSet,
  type StudioProductionPanel,
  type StudioProductionPanelInput,
  type StudioProductionUnitSnapshot,
} from "../../src/core/studio-production.js";

/** P7 合同字段直接复用 core 单一真相源，不在测试夹具里重新发明名称。 */
export const STUDIO_P7_CONTINUITY_FIELD_NAMES = STUDIO_CONTINUITY_FIELDS;

export type StudioP7ContinuityFieldName = StudioContinuityField;

export type StudioP7ContinuityFieldValue =
  | { status: "resolved"; value: string; required: boolean; evidenceIds: string[] }
  | { status: "unresolved"; reason: string; required: boolean; evidenceIds: string[] };

export type StudioP7ContinuityFieldMap = Record<StudioP7ContinuityFieldName, StudioP7ContinuityFieldValue>;

export interface StudioP7HalfOpenSpan {
  id: string;
  scopeKind: "source-shot" | "panel";
  scopeId: string;
  startMilliseconds: number;
  endMilliseconds: number;
}

export interface StudioP7FixtureMedia {
  sourcePath: string;
  imported: StudioMediaMetadata;
}

export interface StudioP7PanelMediaPair {
  unitId: string;
  panelId: string;
  panelIndex: number;
  raw: StudioP7FixtureMedia;
  labeled: StudioP7FixtureMedia;
}

export interface StudioP7CanonicalAssetFixture {
  id: string;
  category: StudioCanonicalAssetCategory;
  name: string;
  authorityMedia: StudioP7FixtureMedia;
  currentRevision: number;
  authorityVersionId: string;
}

export interface StudioP7Fixture {
  temporaryRoot: string;
  parentRoot: string;
  root: string;
  shell: ProjectShell;
  units: {
    sixPanel: StudioProductionUnitSnapshot;
    twoPanel: StudioProductionUnitSnapshot;
  };
  assets: {
    ahang: StudioP7CanonicalAssetFixture;
    stoneRoom: StudioP7CanonicalAssetFixture;
    completeGoldenMask: StudioP7CanonicalAssetFixture;
  };
  bindings: StudioAssetBindingSet[];
  panelMediaPairs: StudioP7PanelMediaPair[];
  allMedia: StudioP7FixtureMedia[];
  /** 固定像素图片只证明本地 CAS 与合同，不代表任何画面已通过人工视觉验收。 */
  visualReviewClaimed: false;
  cleanup(): Promise<void>;
}

export interface CreateStudioP7FixtureOptions {
  /**
   * 默认仍在 /tmp 创建并由测试清理。P14 安装版 canary 可显式传入隔离目录，
   * 以便保留验收工程供退出重开 smoke；调用方仍须自行决定何时 cleanup。
   */
  parentDirectory?: string;
}

export interface StudioP7SeededContinuity {
  writes: StudioContinuityWriteResult[];
  readinessByPanelAsset: Record<string, string>;
}

/**
 * 仅供不验证跨单元实际末态的 P7 测试使用。
 *
 * sequence > 1 的生产默认门禁仍要求真实 previous-unit Observation；测试若只关心
 * dispatch、投影、样式或命令总线，必须逐调用显式携带该结构化审计豁免。
 */
export async function studioP7ContinuationWaiver(
  projectRoot: string,
  unit: StudioProductionUnitSnapshot,
  auditIdentity: string,
) {
  const receipt = await registerStudioVerifiedHistoricalImportContinuationWaiver(projectRoot, {
    unitId: unit.unit.id,
    expectedUnitRevision: unit.unit.revision,
    sourceManifestFingerprint: createHash("sha256")
      .update(requiredText(auditIdentity, "continuation waiver auditIdentity"), "utf8")
      .digest("hex"),
    authorizationEvidenceReference: `test-fixture:${auditIdentity}`,
    mode: "test-fixture",
  });
  return {
    receiptId: receipt.receiptId,
    receiptFingerprint: receipt.fingerprint,
  };
}

/** 公开 command/MCP/画布路径使用真实用户授权 receipt；调用前必须已激活 fixture 工程。 */
export async function studioP7UserContinuationWaiver(
  projectRoot: string,
  unit: StudioProductionUnitSnapshot,
  auditIdentity: string,
) {
  const normalizedAuditIdentity = requiredText(auditIdentity, "continuation waiver auditIdentity");
  const context = await getActiveManagedStudioContext();
  const authorizationText = `测试用户确认 ${normalizedAuditIdentity} 的上一镜 actual-tail 不可用，并接受重新起拍风险。`;
  const receipt = await authorizeStudioUnitGridContinuationWaiver(projectRoot, {
    unitId: unit.unit.id,
    expectedUnitRevision: unit.unit.revision,
    projectContextToken: context.projectContextToken,
    authorizationEvidenceReference: `test-user-confirmation:${normalizedAuditIdentity}`,
    authorizationText,
    authorizationTextSha256: createHash("sha256").update(authorizationText, "utf8").digest("hex"),
    reason: "公开测试路径显式确认缺少 actual-tail，并继续强制身份与场景锁。",
    acknowledgePreviousActualTailUnavailable: true,
    acknowledgeCanonicalRestartMayBreakContinuity: true,
    acknowledgeIdentityAndSceneLocksRemainMandatory: true,
  });
  return {
    receiptId: receipt.receiptId,
    receiptFingerprint: receipt.fingerprint,
  };
}

export interface SeedStudioP7ResolvedPanelContinuityInput {
  unitId: string;
  panelId: string;
  /** 只列入真实允许出画的资产；forbidden 安全约束不得伪装成画面连续性主体。 */
  assetIds: string[];
}

const SCRIPT_BODY = "阿航站在石室中央，双手捧着完整黄金面具。火光从左侧照入，所有画面必须保持身份与空间连续。";
const PROMPT_BODY = "只生成一张电影写实分镜；保持阿航、石室和完整黄金面具的规范身份，不得换脸、串景或改成半面具。";

const ASSET_FIXTURES = [
  {
    key: "ahang",
    id: "character-ahang",
    category: "character",
    name: "阿航",
    aliases: ["青年阿航"],
    color: { r: 91, g: 70, b: 52 },
    identityFeatures: ["固定东方青年面孔", "黑色束发"],
    positiveLocks: ["保持同一张脸", "保持素麻古蜀服"],
    negativeLocks: ["禁止换脸", "禁止现代服装"],
  },
  {
    key: "stoneRoom",
    id: "scene-stone-room",
    category: "scene",
    name: "石室",
    aliases: ["古蜀石室"],
    color: { r: 42, g: 47, b: 50 },
    identityFeatures: ["灰黑巨石墙", "左侧火光"],
    positiveLocks: ["保持同一石室布局"],
    negativeLocks: ["禁止现代建筑", "禁止换成室外"],
  },
  {
    key: "completeGoldenMask",
    id: "prop-complete-golden-mask",
    category: "prop",
    name: "完整黄金面具",
    aliases: ["黄金面具"],
    color: { r: 157, g: 113, b: 25 },
    identityFeatures: ["完整对称金面结构"],
    positiveLocks: ["始终保持完整黄金面具"],
    negativeLocks: ["禁止半面具", "禁止裂面具", "禁止替换道具"],
  },
] as const satisfies ReadonlyArray<{
  key: keyof StudioP7Fixture["assets"];
  id: string;
  category: StudioCanonicalAssetCategory;
  name: string;
  aliases: readonly string[];
  color: { r: number; g: number; b: number };
  identityFeatures: readonly string[];
  positiveLocks: readonly string[];
  negativeLocks: readonly string[];
}>;

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([key, entry]) => [key, stableValue(entry)]));
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stableValue(value)), "utf8").digest("hex");
}

function requiredText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} 不能为空。`);
  return normalized;
}

function assertSafeMilliseconds(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${field} 必须是非负整数毫秒。`);
  return value;
}

export function unresolvedStudioP7ContinuityFields(
  reason: string,
  requiredFields: readonly StudioP7ContinuityFieldName[] = [],
): StudioP7ContinuityFieldMap {
  const normalizedReason = requiredText(reason, "unresolved reason");
  const required = new Set(requiredFields);
  return Object.fromEntries(STUDIO_P7_CONTINUITY_FIELD_NAMES.map((name) => [name, {
    status: "unresolved" as const,
    reason: normalizedReason,
    required: required.has(name),
    evidenceIds: [],
  }])) as unknown as StudioP7ContinuityFieldMap;
}

/**
 * 只规范化并验证显式跨度；不会把 first/end 物化为连续区间，也不会合并相邻跨度。
 */
export function normalizeStudioP7DiscontinuousSpans(
  spans: readonly StudioP7HalfOpenSpan[],
): StudioP7HalfOpenSpan[] {
  const ids = new Set<string>();
  const normalized = spans.map((span, index): StudioP7HalfOpenSpan => {
    const id = requiredText(span.id, `spans[${index}].id`);
    if (ids.has(id)) throw new Error(`跨度 ID 重复：${id}`);
    ids.add(id);
    if (span.scopeKind !== "source-shot" && span.scopeKind !== "panel") {
      throw new Error(`spans[${index}].scopeKind 无效。`);
    }
    const scopeId = requiredText(span.scopeId, `spans[${index}].scopeId`);
    const startMilliseconds = assertSafeMilliseconds(span.startMilliseconds, `spans[${index}].startMilliseconds`);
    const endMilliseconds = assertSafeMilliseconds(span.endMilliseconds, `spans[${index}].endMilliseconds`);
    if (endMilliseconds <= startMilliseconds) throw new Error(`跨度 ${id} 必须是非空半开区间。`);
    return { id, scopeKind: span.scopeKind, scopeId, startMilliseconds, endMilliseconds };
  }).sort((left, right) => left.scopeKind.localeCompare(right.scopeKind, "en")
    || left.scopeId.localeCompare(right.scopeId, "en")
    || left.startMilliseconds - right.startMilliseconds
    || left.endMilliseconds - right.endMilliseconds
    || left.id.localeCompare(right.id, "en"));

  for (let index = 1; index < normalized.length; index += 1) {
    const previous = normalized[index - 1]!;
    const current = normalized[index]!;
    if (previous.scopeKind === current.scopeKind
      && previous.scopeId === current.scopeId
      && current.startMilliseconds < previous.endMilliseconds) {
      throw new Error(`跨度 ${previous.id} 与 ${current.id} 重叠。`);
    }
  }
  return normalized;
}

export function studioP7HalfOpenSpanContains(span: StudioP7HalfOpenSpan, positionMilliseconds: number): boolean {
  const position = assertSafeMilliseconds(positionMilliseconds, "positionMilliseconds");
  return position >= span.startMilliseconds && position < span.endMilliseconds;
}

export function studioP7CoverageAt(
  spans: readonly StudioP7HalfOpenSpan[],
  scopeKind: StudioP7HalfOpenSpan["scopeKind"],
  scopeId: string,
  positionMilliseconds: number,
): StudioP7HalfOpenSpan[] {
  const normalizedScopeId = requiredText(scopeId, "scopeId");
  return normalizeStudioP7DiscontinuousSpans(spans).filter((span) => span.scopeKind === scopeKind
    && span.scopeId === normalizedScopeId
    && studioP7HalfOpenSpanContains(span, positionMilliseconds));
}

export function assertStudioP7UnitPanelContract(
  panels: readonly Pick<StudioProductionPanel, "startSeconds" | "endSeconds" | "durationSeconds">[],
): void {
  if (panels.length < 2 || panels.length > 6) throw new Error("P7 单元必须是 2-6 宫格。");
  let cursor = 0;
  panels.forEach((panel, index) => {
    const start = assertSafeMilliseconds(panel.startSeconds * 1_000, `panels[${index}].startSeconds`);
    const end = assertSafeMilliseconds(panel.endSeconds * 1_000, `panels[${index}].endSeconds`);
    const duration = assertSafeMilliseconds(panel.durationSeconds * 1_000, `panels[${index}].durationSeconds`);
    if (start !== cursor) throw new Error(`P7 单元在 ${cursor}ms 处存在空档或重叠。`);
    if (end <= start || end - start !== duration) throw new Error(`panels[${index}] 起止与时长不一致。`);
    cursor = end;
  });
  if (cursor !== 15_000) throw new Error(`P7 单元总时长必须严格为 15000ms，当前为 ${cursor}ms。`);
}

export function isStudioP7TemporaryPath(candidate: string, temporaryRoot: string): boolean {
  const relative = path.relative(temporaryRoot, path.resolve(candidate));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/**
 * 为确定性 generation/Review 测试显式写入九字段。该函数不解析剧情文字，
 * 也不把 legacy continuityState 提升为事实；每个值都标注为 deterministic fixture。
 */
export async function seedStudioP7ResolvedContinuity(
  fixture: StudioP7Fixture,
): Promise<StudioP7SeededContinuity> {
  const writes: StudioContinuityWriteResult[] = [];
  const readinessByPanelAsset: Record<string, string> = {};
  const authorityShaByAsset = new Map(Object.values(fixture.assets)
    .map((asset) => [asset.id, asset.authorityMedia.imported.sha256] as const));
  for (const unit of [fixture.units.sixPanel, fixture.units.twoPanel]) {
    for (const panel of unit.panels) {
      const scope = {
        kind: "panel" as const,
        scopeId: panel.id,
        unitId: unit.unit.id,
        unitRevision: unit.unit.revision,
        startMilliseconds: Math.round(panel.startSeconds * 1_000),
        endMilliseconds: Math.round(panel.endSeconds * 1_000),
      };
      for (const mention of panel.assets) {
        for (const field of STUDIO_CONTINUITY_FIELDS) {
          const value = field === "referenceSha256"
            ? authorityShaByAsset.get(mention.assetId)!
            : `fixture:${mention.assetId}:${field}:${panel.index}`;
          writes.push(await appendStudioContinuityObservation(fixture.root, {
            operationId: `p7-seed-${unit.unit.id}-${panel.index}-${mention.assetId}-${field}`,
            expectedHeadRevision: 0,
            scope,
            subjectId: mention.assetId,
            field,
            state: {
              status: "resolved",
              value,
              provenance: [{
                kind: "deterministic-fixture",
                reference: `${unit.unit.id}/${panel.id}/${mention.assetId}/${field}`,
                sourceFingerprint: field === "referenceSha256" ? value : digest({ unitId: unit.unit.id, panelId: panel.id, assetId: mention.assetId, field, value }),
                note: "显式机械 fixture，不代表视觉验收。",
              }],
            },
          }));
        }
        const readiness = await getStudioContinuityReadiness(fixture.root, {
          scope,
          subjectId: mention.assetId,
          requiredFields: [...STUDIO_CONTINUITY_FIELDS],
        });
        if (!readiness.ready) throw new Error(`P7 fixture continuity 未 ready：${unit.unit.id}/${panel.id}/${mention.assetId}`);
        readinessByPanelAsset[`${unit.unit.id}\u0000${panel.id}\u0000${mention.assetId}`] = readiness.fingerprint;
      }
    }
  }
  return { writes, readinessByPanelAsset };
}

/**
 * 为 P7 以前的纵向测试补齐显式九字段事实。
 *
 * 该辅助函数只接受测试明确列出的允许资产，并从当前规范资产读取真实主权威 SHA；
 * 不解析 legacy continuityState，也不暗示固定像素图通过了人工视觉验收。
 */
export async function seedStudioP7ResolvedPanelContinuity(
  projectRoot: string,
  input: SeedStudioP7ResolvedPanelContinuityInput,
): Promise<StudioP7SeededContinuity> {
  const unitId = requiredText(input.unitId, "unitId");
  const panelId = requiredText(input.panelId, "panelId");
  const assetIds = [...new Set(input.assetIds.map((assetId, index) => requiredText(assetId, `assetIds[${index}]`)))]
    .sort((left, right) => left.localeCompare(right, "en"));
  if (assetIds.length === 0) throw new Error("assetIds 至少需要一个允许资产。");

  const unit = await getStudioProductionUnitSnapshot(projectRoot, unitId);
  if (!unit) throw new Error(`P7 legacy fixture 单元不存在：${unitId}`);
  const panel = unit.panels.find((candidate) => candidate.id === panelId);
  if (!panel) throw new Error(`P7 legacy fixture 宫格不存在：${unitId}/${panelId}`);
  const mentionedAssetIds = new Set(panel.assets.map((asset) => asset.assetId));
  for (const assetId of assetIds) {
    if (!mentionedAssetIds.has(assetId)) {
      throw new Error(`P7 legacy fixture 资产未出现在目标宫格：${unitId}/${panelId}/${assetId}`);
    }
  }

  const scope = {
    kind: "panel" as const,
    scopeId: panel.id,
    unitId: unit.unit.id,
    unitRevision: unit.unit.revision,
    startMilliseconds: Math.round(panel.startSeconds * 1_000),
    endMilliseconds: Math.round(panel.endSeconds * 1_000),
  };
  const writes: StudioContinuityWriteResult[] = [];
  const readinessByPanelAsset: Record<string, string> = {};
  for (const assetId of assetIds) {
    const detail = await getStudioCanonicalAsset(projectRoot, assetId);
    if (!detail?.primaryAuthority) throw new Error(`P7 legacy fixture 资产缺少主权威：${assetId}`);
    const authorityVersion = detail.versions.find((version) => version.id === detail.primaryAuthority!.versionId);
    if (!authorityVersion) throw new Error(`P7 legacy fixture 主权威版本不存在：${assetId}`);
    for (const field of STUDIO_CONTINUITY_FIELDS) {
      const value = field === "referenceSha256"
        ? authorityVersion.mediaSha256
        : `test-fixture:${assetId}:${field}:${panel.id}`;
      const operationId = `p7-panel-ready-${digest({ unitId, panelId, assetId, field }).slice(0, 40)}`;
      writes.push(await appendStudioContinuityObservation(projectRoot, {
        operationId,
        expectedHeadRevision: 0,
        scope,
        subjectId: assetId,
        field,
        state: {
          status: "resolved",
          value,
          provenance: [{
            kind: "deterministic-legacy-test-fixture",
            reference: `${unitId}/${panelId}/${assetId}/${field}`,
            sourceFingerprint: field === "referenceSha256"
              ? authorityVersion.mediaSha256
              : digest({ unitId, panelId, assetId, field, value }),
            note: "显式测试 fixture，不代表视觉验收。",
          }],
        },
      }));
    }
    const readiness = await getStudioContinuityReadiness(projectRoot, {
      scope,
      subjectId: assetId,
      requiredFields: [...STUDIO_CONTINUITY_FIELDS],
    });
    if (!readiness.ready) {
      throw new Error(`P7 legacy fixture continuity 未 ready：${unitId}/${panelId}/${assetId}`);
    }
    readinessByPanelAsset[`${unitId}\u0000${panelId}\u0000${assetId}`] = readiness.fingerprint;
  }
  return { writes, readinessByPanelAsset };
}

async function renderFixedPng(
  filePath: string,
  color: { r: number; g: number; b: number },
  dimensions: { width: number; height: number },
): Promise<void> {
  await sharp({
    create: {
      width: dimensions.width,
      height: dimensions.height,
      channels: 3,
      background: color,
    },
  }).png({ compressionLevel: 9, adaptiveFiltering: false }).toFile(filePath);
}

async function importFixedImage(
  root: string,
  sourcePath: string,
  color: { r: number; g: number; b: number },
  dimensions: { width: number; height: number },
): Promise<StudioP7FixtureMedia> {
  await renderFixedPng(sourcePath, color, dimensions);
  return {
    sourcePath,
    imported: await importStudioMedia(root, { sourcePath, kind: "image" }),
  };
}

async function createAuthoritativeAsset(
  root: string,
  inputsRoot: string,
  input: typeof ASSET_FIXTURES[number],
): Promise<StudioP7CanonicalAssetFixture> {
  const authorityMedia = await importFixedImage(
    root,
    path.join(inputsRoot, `${input.id}-authority.png`),
    input.color,
    { width: 48, height: 72 },
  );
  const created = await createStudioCanonicalAsset(root, {
    id: input.id,
    expectedRevision: 0,
    category: input.category,
    name: input.name,
    aliases: [...input.aliases],
    description: "P7 确定性机械夹具规范资产，不代表生产画面视觉验收。",
    identityFeatures: [...input.identityFeatures],
    positiveLocks: [...input.positiveLocks],
    negativeLocks: [...input.negativeLocks],
    defaultPrompt: `${input.name}，电影写实，严格保持规范身份。`,
  });
  const appended = await appendStudioAssetVersion(root, {
    assetId: created.id,
    mediaSha256: authorityMedia.imported.sha256,
    reviewStatus: "pending",
    sourceNote: "固定像素 CAS 夹具，只锁定测试身份。",
    expectedRevision: created.revision,
  });
  const approvedForAuthority = await reviewStudioAssetVersion(root, {
    assetId: created.id,
    versionId: appended.version.id,
    decision: "approved",
    expectedRevision: appended.assetRevision,
    note: "仅批准规范资产 fixture 身份/CAS，不代表任何生成画面通过视觉验收。",
  });
  const authoritative = await setStudioPrimaryAuthority(root, {
    assetId: created.id,
    versionId: appended.version.id,
    expectedRevision: approvedForAuthority.revision,
    note: "P7 fixture 当前规范权威。",
  });
  return {
    id: authoritative.id,
    category: authoritative.category,
    name: authoritative.name,
    authorityMedia,
    currentRevision: authoritative.revision,
    authorityVersionId: appended.version.id,
  };
}

function panelAssets(promptRevisionId: string): StudioProductionPanelInput["assets"] {
  return [{
    assetId: "character-ahang",
    category: "character",
    presence: "required",
    role: "画面主体，固定身份与服饰。",
    continuityState: "legacy evidence；P7 continuity 状态由独立九字段合同表达，不得据此推断未知状态。",
    evidence: [{ kind: "prompt-revision", reference: promptRevisionId, note: "P7 fixture 明确绑定。" }],
  }, {
    assetId: "scene-stone-room",
    category: "scene",
    presence: "required",
    role: "固定石室空间与左侧火光。",
    continuityState: "legacy evidence；P7 continuity 状态由独立九字段合同表达，不得跨空档外推。",
    evidence: [{ kind: "prompt-revision", reference: promptRevisionId, note: "P7 fixture 明确绑定。" }],
  }, {
    assetId: "prop-complete-golden-mask",
    category: "prop",
    presence: "required",
    role: "完整黄金面具，不得变成半面具。",
    continuityState: "legacy evidence；P7 continuity 状态由独立九字段合同表达，此处仅锁定完整道具身份。",
    evidence: [{ kind: "hard-lock", reference: "complete-golden-mask", note: "禁止半面具。" }],
  }];
}

function panelsForUnit(
  unitId: string,
  promptRevisionId: string,
  panelDurationsSeconds: readonly number[],
): StudioProductionPanelInput[] {
  let cursor = 0;
  return panelDurationsSeconds.map((durationSeconds, offset) => {
    const startSeconds = cursor;
    cursor += durationSeconds;
    const panelIndex = offset + 1;
    return {
      id: `${unitId}-panel-${String(panelIndex).padStart(2, "0")}`,
      title: `${unitId} 宫格 ${panelIndex}`,
      visualAction: panelIndex === 1
        ? "阿航在石室中捧着完整黄金面具。"
        : `阿航承接前格站位，完成第 ${panelIndex} 格动作。`,
      shotComposition: panelIndex % 2 === 1 ? "中景，主体居中。" : "近景，保留右侧空间。",
      filmingMethod: panelIndex % 2 === 1 ? "固定机位。" : "50mm 缓慢推近。",
      dialogue: panelIndex === 1 ? "阿航：不要动。" : "",
      subtitle: panelIndex === 1 ? "不要动" : "",
      startSeconds,
      endSeconds: cursor,
      durationSeconds,
      promptRevisionId,
      sourceSpans: [{ startOffsetUtf16: 0, endOffsetUtf16: SCRIPT_BODY.length }],
      assets: panelAssets(promptRevisionId),
    };
  });
}

function mentionSpecs() {
  return ASSET_FIXTURES.map((asset) => {
    const startOffsetUtf16 = SCRIPT_BODY.indexOf(asset.name);
    if (startOffsetUtf16 < 0) throw new Error(`P7 fixture 剧本缺少资产名称：${asset.name}`);
    return {
      asset,
      startOffsetUtf16,
      endOffsetUtf16: startOffsetUtf16 + asset.name.length,
    };
  });
}

async function freezePanelBindingSet(
  root: string,
  projectId: string,
  unit: StudioProductionUnitSnapshot,
  panel: StudioProductionPanel,
): Promise<StudioAssetBindingSet> {
  const specs = mentionSpecs();
  const mentions = specs.map(({ asset, startOffsetUtf16, endOffsetUtf16 }) => {
    const legacyMention = panel.assets.find((entry) => entry.assetId === asset.id);
    if (!legacyMention) throw new Error(`P7 fixture panel 缺少资产：${asset.id}`);
    return {
      id: `p7-mention-${unit.unit.id}-${panel.index}-${asset.id}`,
      surfaceText: asset.name,
      startOffsetUtf16,
      endOffsetUtf16,
      category: asset.category,
      presence: legacyMention.presence,
      role: legacyMention.role,
    };
  });
  const analysis = await analyzeStudioPanelAssetMentions(root, {
    unitId: unit.unit.id,
    unitRevision: unit.unit.revision,
    unitFingerprint: unit.fingerprint,
    panelIndex: panel.index,
    scriptRevisionId: unit.scriptRevision.id,
    scriptSha256: unit.scriptRevision.bodySha256,
    expectedHeadRevision: 0,
    mentions,
    resolverVersion: "p7-deterministic-fixture-v1",
  });
  const decisions = await Promise.all(analysis.proposals.map(async (proposal) => {
    if (proposal.status !== "matched" || proposal.candidates.filter((candidate) => candidate.kind !== "model").length !== 1) {
      throw new Error(`P7 fixture 必须得到唯一 exact matched：${proposal.mentionId}`);
    }
    return recordStudioMentionDecision(root, {
      receiptId: `p7-decision-${unit.unit.id}-${panel.index}-${proposal.mentionId}`,
      proposalId: proposal.id,
      expectedAnalysisHeadRevision: analysis.revision,
      expectedDecisionHeadRevision: 0,
      action: "accept",
      presence: proposal.presence,
      role: proposal.role,
      reviewer: "p7-fixture",
      note: "确定性 fixture 显式确认 exact 身份。",
    });
  }));
  const time = getStudioProductionPanelTimeContext(unit.unit, panel);
  const target = {
    projectId,
    seasonId: unit.unit.season,
    episodeId: unit.unit.episode,
    unitId: unit.unit.id,
    ...time,
  };
  const assetSources = await Promise.all(panel.assets.map(async (mention) => {
    const detail = await getStudioCanonicalAsset(root, mention.assetId);
    if (!detail?.primaryAuthority) throw new Error(`P7 fixture 资产缺少主权威：${mention.assetId}`);
    const definition = detail.definitionVersions.find((entry) => entry.id === detail.currentDefinitionVersionId);
    const authority = detail.authorityHistory.at(-1);
    const version = detail.versions.find((entry) => entry.id === detail.primaryAuthority!.versionId);
    const knowledge = await getStudioCanonicalAssetKnowledgeSnapshot(root, detail.id, target);
    if (!definition || !authority || !version || !knowledge) throw new Error(`P7 fixture 资产知识闭包不完整：${detail.id}`);
    return {
      assetId: detail.id,
      category: detail.category,
      assetRevision: detail.revision,
      definitionVersionId: definition.id,
      authorityEventId: authority.id,
      authorityVersionId: authority.versionId,
      assetVersionId: version.id,
      mediaSha256: version.mediaSha256,
      knowledgeFingerprint: knowledge.fingerprint,
      applicabilityFingerprint: digest(evaluateStudioAssetApplicability(definition.applicability, target)),
    };
  }));
  return freezeStudioPanelAssetBindingSet(root, {
    analysisId: analysis.id,
    expectedAnalysisHeadRevision: analysis.revision,
    expectedBindingHeadRevision: 0,
    decisionReceiptIds: decisions.map((decision) => decision.id),
    assetSources,
  });
}

function resultColor(ordinal: number, variant: "raw" | "labeled"): { r: number; g: number; b: number } {
  if (variant === "raw") {
    return { r: 24 + ordinal * 17, g: 42 + ordinal * 11, b: 67 + ordinal * 9 };
  }
  return { r: 111 + ordinal * 9, g: 31 + ordinal * 13, b: 54 + ordinal * 7 };
}

async function createPanelMediaPairs(
  root: string,
  inputsRoot: string,
  units: readonly StudioProductionUnitSnapshot[],
): Promise<StudioP7PanelMediaPair[]> {
  const panels = units.flatMap((unit) => unit.panels.map((panel) => ({ unit, panel })));
  return Promise.all(panels.map(async ({ unit, panel }, ordinal) => {
    const basename = `${unit.unit.id}_${panel.id}`;
    const raw = await importFixedImage(
      root,
      path.join(inputsRoot, `${basename}_raw.png`),
      resultColor(ordinal, "raw"),
      { width: 64, height: 96 },
    );
    const labeled = await importFixedImage(
      root,
      path.join(inputsRoot, `${basename}_labeled.png`),
      resultColor(ordinal, "labeled"),
      { width: 64, height: 96 },
    );
    return {
      unitId: unit.unit.id,
      panelId: panel.id,
      panelIndex: panel.index,
      raw,
      labeled,
    };
  }));
}

export async function createStudioP7Fixture(options: CreateStudioP7FixtureOptions = {}): Promise<StudioP7Fixture> {
  const requestedParentDirectory = options.parentDirectory
    ? path.resolve(options.parentDirectory)
    : "/tmp";
  await mkdir(requestedParentDirectory, { recursive: true });
  const temporaryRoot = await realpath(requestedParentDirectory);
  const parentRoot = await realpath(await mkdtemp(path.join(temporaryRoot, "studio-p7-fixture-")));
  try {
    const root = (await createManagedProject({
      parentRoot,
      name: "P7 确定性连续性合同夹具",
      slug: "p7-continuity-fixture",
    })).paths.root;
    if (!isStudioP7TemporaryPath(root, temporaryRoot)) throw new Error(`P7 fixture 越出隔离根目录：${root}`);
    const inputsRoot = path.join(root, "fixture-inputs");
    await mkdir(inputsRoot, { recursive: true });

    const createdAssets = await Promise.all(ASSET_FIXTURES.map((asset) => createAuthoritativeAsset(root, inputsRoot, asset)));
    const assets = Object.fromEntries(ASSET_FIXTURES.map((asset, index) => [asset.key, createdAssets[index]!])) as unknown as StudioP7Fixture["assets"];

    const scriptDocument = await createStudioScriptDocument(root, {
      id: "p7-fixture-script",
      title: "P7 确定性夹具剧本",
      expectedRevision: 0,
    });
    const script = await appendStudioScriptRevision(root, {
      documentId: scriptDocument.id,
      expectedRevision: 0,
      body: SCRIPT_BODY,
      source: "fixture/p7/EP01.md",
      sourceVersion: "p7-fixture-v1",
    });
    const promptDocument = await createStudioPromptDocument(root, {
      id: "p7-fixture-prompt",
      title: "P7 确定性夹具提示词",
      expectedRevision: 0,
    });
    const prompt = await appendStudioPromptRevision(root, {
      documentId: promptDocument.id,
      expectedRevision: 0,
      body: PROMPT_BODY,
      source: "fixture/p7/EP01.txt",
      sourceVersion: "p7-fixture-v1",
    });
    const sixPanel = await createStudioProductionUnit(root, {
      id: "p7-unit-a-six-panel",
      expectedRevision: 0,
      season: "S03",
      episode: "EP01",
      sequence: 1,
      title: "P7 六格连续性单元",
      scriptRevisionId: script.revision.id,
      panels: panelsForUnit("p7-unit-a", prompt.revision.id, [2.5, 2.5, 2.5, 2.5, 2.5, 2.5]),
    });
    const twoPanel = await createStudioProductionUnit(root, {
      id: "p7-unit-b-two-panel",
      expectedRevision: 0,
      season: "S03",
      episode: "EP01",
      sequence: 2,
      title: "P7 二格长中文单元",
      scriptRevisionId: script.revision.id,
      panels: panelsForUnit("p7-unit-b", prompt.revision.id, [7.5, 7.5]),
    });
    assertStudioP7UnitPanelContract(sixPanel.panels);
    assertStudioP7UnitPanelContract(twoPanel.panels);

    const shell = await inspectManagedProject(root);
    if (shell.project.sourceRoots.length !== 0) throw new Error("P7 fixture 必须保持 sourceRoots=[]。");
    const bindings: StudioAssetBindingSet[] = [];
    for (const unit of [sixPanel, twoPanel]) {
      for (const panel of unit.panels) bindings.push(await freezePanelBindingSet(root, shell.project.id, unit, panel));
    }
    const panelMediaPairs = await createPanelMediaPairs(root, inputsRoot, [sixPanel, twoPanel]);
    const allMedia = [
      ...createdAssets.map((asset) => asset.authorityMedia),
      ...panelMediaPairs.flatMap((pair) => [pair.raw, pair.labeled]),
    ];
    return {
      temporaryRoot,
      parentRoot,
      root,
      shell,
      units: { sixPanel, twoPanel },
      assets,
      bindings,
      panelMediaPairs,
      allMedia,
      visualReviewClaimed: false,
      cleanup: async () => rm(parentRoot, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(parentRoot, { recursive: true, force: true });
    throw error;
  }
}
