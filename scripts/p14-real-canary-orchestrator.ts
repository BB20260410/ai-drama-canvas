/**
 * P14 真实单图 canary 本地编排器。
 *
 * prepare 只创建并激活隔离验收工程、制造一次显式歧义裁决、冻结并派发 Codex pack；
 * finalize 只接收已存在的 raw，通过 command bus 原子写回 raw/labeled pending pair；
 * review 只在调用方明示 --confirmed-by-user 后以 user owner 追加审片事件。
 *
 * 本脚本会把调用方明确提交的只读权威图内容寻址导入隔离工程，但不调用任何生图模型。
 */
import { createHash, randomUUID } from "node:crypto";
import { access, lstat, mkdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import sharp from "sharp";
import {
  getActiveManagedStudioContext,
  type ActiveManagedStudioContext,
} from "../src/core/active-managed-studio-context.js";
import {
  executeIdempotentCommand,
  type IdempotentCommandResult,
  type StudioCommandRequest,
} from "../src/core/command-bus.js";
import { getStudioCanonicalAsset } from "../src/core/material-studio.js";
import { inspectManagedProject } from "../src/core/managed-project.js";
import {
  registerProject,
  setActiveProjectRegistration,
  setActiveStudioContext,
  writeJsonAtomic,
} from "../src/core/sidecar.js";
import {
  getStudioBindingControl,
  type StudioBindingProposal,
} from "../src/core/studio-binding-control.js";
import {
  readPersistedStudioGenerationPack,
  readStudioGenerationDispatch,
  readStudioGenerationResultBundle,
  type StudioGenerationDispatchRecord,
  type StudioGenerationResultBundleRecord,
} from "../src/core/studio-generation-ledger.js";
import {
  getStudioGenerationReviewControl,
  type StudioGenerationReviewDecision,
  type StudioGenerationReviewProjection,
} from "../src/core/studio-generation-review.js";
import type { StudioAgentImagegenResultBundleOutcome } from "../src/core/studio-agent-imagegen-result-bundle.js";
import {
  getStudioProductionUnitSnapshot,
  type StudioProductionUnitSnapshot,
} from "../src/core/studio-production.js";
import { STUDIO_CONTINUITY_FIELDS } from "../src/core/studio-continuity.js";
import {
  createStudioP7Fixture,
  seedStudioP7ResolvedPanelContinuity,
} from "../tests/helpers/studio-p7-fixture.js";

const WORKSPACE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FORMAL_PROJECT_ROOT = path.join(WORKSPACE_ROOT, "projects", "codex-ai-drama-studio");
const STATE_FILENAME = "canary-state.json";
const REQUEST_FILENAME = "imagegen-request-envelope.json";
const REVIEW_REQUEST_FILENAME = "review-request-envelope.json";
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const REVIEW_CRITERIA = [
  "character_identity",
  "hard_lock",
  "prop_costume",
  "scene_continuity",
  "composition",
  "image_quality",
  "raw_labeled_pair",
] as const;

type ReviewCriterionCode = typeof REVIEW_CRITERIA[number];

export interface PrepareP14CanaryInput {
  outputRoot?: string;
  runName?: string;
  authorityReferences?: {
    characterAhangPath: string;
    sceneStoneRoomPath: string;
    completeGoldenMaskPath: string;
  };
  /** 仅供单元测试验证编排，不得进入真实 Codex canary 或安装版审片。 */
  allowFixtureAuthoritiesForTest?: boolean;
}

export interface FinalizeP14CanaryInput {
  statePath: string;
  rawPath: string;
  rawSha256: string;
  callId: string;
  model: string;
  generatedAt?: string;
  executionSource?: "codex-imagegen" | "fixture-canary";
}

export interface ReviewP14CanaryInput {
  statePath: string;
  decision: StudioGenerationReviewDecision;
  note: string;
  confirmedByUser: boolean;
  failedCriterion?: ReviewCriterionCode;
}

interface P14CanaryFinalization {
  rawPath: string;
  rawSha256: string;
  executionReceipt: {
    schemaVersion: 1;
    kind: "agent-imagegen-execution-receipt";
    provider: "codex";
    source: "codex-imagegen" | "fixture-canary";
    attestationLevel: "agent-session-direct" | "unverified-external-agent";
    cryptographicProviderReceipt: false;
    callId: string;
    model: string;
    generatedAt: string;
  };
  bundle: StudioGenerationResultBundleRecord;
  writebackAudit: {
    schemaVersion: 1;
    kind: "p14-agent-imagegen-writeback-audit";
    executionReceiptFingerprint: string;
    writebackReceiptFingerprint: string;
    outcomeFingerprint: string;
    resultBundleFingerprint: string;
  };
  evidencePath: string;
}

export interface P14CanaryState {
  schemaVersion: 1;
  kind: "p14-real-canary-orchestration-state";
  phase: "dispatched" | "writeback-pending-review" | "reviewed";
  createdAt: string;
  updatedAt: string;
  runRoot: string;
  registryPath: string;
  workspaceRoot: string;
  project: {
    root: string;
    id: string;
    manifestFingerprint: string;
  };
  target: {
    unitId: string;
    unitRevision: number;
    panelId: string;
    panelIndex: number;
    panelCount: number;
    durationSeconds: number;
    assetIds: string[];
  };
  ambiguity: {
    proposalId: string;
    surfaceText: string;
    candidateAssetIds: string[];
    selectedAssetId: string;
    reviewer: "codex";
    decisionReceiptId: string;
  };
  continuityFingerprint: string;
  pack: {
    id: string;
    fingerprint: string;
  };
  dispatch: StudioGenerationDispatchRecord;
  generationRunId: string;
  provider: "codex";
  authorityReferences: {
    mode: "real-user-assets" | "fixture-only";
    assets: Array<{
      assetId: "character-ahang" | "scene-stone-room" | "prop-complete-golden-mask";
      sourcePath: string;
      sourceBasename: string;
      sourceSha256: string;
      importedSha256: string;
      width: number;
      height: number;
      sizeBytes: number;
      sourceMtimeMs: number;
      entropy: number;
      sourceUnchanged: true;
      authorityVersionId: string;
    }>;
  };
  requestEnvelopePath: string;
  prepareEvidencePath: string;
  finalization?: P14CanaryFinalization;
  review?: {
    decision: StudioGenerationReviewDecision;
    review: StudioGenerationReviewProjection;
    evidencePath: string;
    /**
     * 桌面自动化审片时用于区分“桌面 owner 的 reviewer=user 技术标签”与真实执行者。
     * 缺失表示历史 user-confirmed review 合同；不得据 reviewer 字段反推用户亲自点击。
     */
    authorization?: {
      actor: "main-agent";
      source: "explicit-cli-decision";
      userConfirmationClaimed: false;
      ledgerReviewer: "user";
    };
  };
  fingerprint: string;
}

type P14AuthorityReferences = P14CanaryState["authorityReferences"];

const REAL_AUTHORITY_SPECS = [
  {
    key: "characterAhangPath",
    assetId: "character-ahang",
    definition: {
      description: "P14 隔离验收使用的阿航青年真实权威三视图。",
      identityFeatures: ["固定同一东方青年面孔", "高发髻与黑色长发", "左侧银白挑染", "黑色破旧古蜀长袍"],
      positiveLocks: ["保持同一张脸", "保持高发髻和左侧银白挑染", "保持黑色古蜀长袍"],
      negativeLocks: ["禁止换脸", "禁止短发现代发型", "禁止丢失银白挑染", "禁止现代服装"],
      defaultPrompt: "阿航青年，严格保持权威三视图中的同一张脸、高发髻、左侧银白挑染和黑色古蜀长袍。",
    },
  },
  {
    key: "sceneStoneRoomPath",
    assetId: "scene-stone-room",
    definition: {
      description: "P14 隔离验收使用的古蜀灰黑巨石密室真实场景参考。",
      identityFeatures: ["灰黑巨石密室", "中央石台", "左侧暖色火光", "低照度古蜀祭祀空间"],
      positiveLocks: ["保持同一密室空间布局", "保持灰黑巨石材质与左侧火光"],
      negativeLocks: ["禁止现代建筑", "禁止换成室外", "禁止增加无关人物", "禁止复制参考图中的陈列面具"],
      defaultPrompt: "古蜀灰黑巨石密室，只沿用建筑布局、石材和左侧火光；不要复制参考图中的人物或陈列面具。",
    },
  },
  {
    key: "completeGoldenMaskPath",
    assetId: "prop-complete-golden-mask",
    definition: {
      description: "P14 隔离验收使用的豆姐完整黄金面具权威三视图；外观只认提交图片的内容哈希。",
      identityFeatures: [
        "平直微内凹的额顶轮廓，无冠无角",
        "双侧深色弯眉带与杏仁形眼孔",
        "中央长而窄的直鼻梁",
        "小型闭合嘴唇与短圆下颏",
        "两侧纵向圆形铆孔与锤揲金面纹理",
        "背面中央纵向古蜀纹样与侧边固定件",
      ],
      positiveLocks: [
        "始终保持权威三视图中的同一张完整黄金面具",
        "保持平额、弯眉带、杏仁眼孔、长窄鼻梁、闭口和侧边铆孔的精确结构",
        "保持厚实锤揲黄金材质、旧化凹凸和完整左右边缘",
      ],
      negativeLocks: [
        "禁止高额冠、尖角、兽耳或外展耳翼",
        "禁止加长下颌、颈部护甲或头盔结构",
        "禁止半面具、裂面具、张口、口型、熔化或第二张面具",
        "禁止把三视图标题、标注、黑色底板或说明文字画进成片",
      ],
      defaultPrompt: "完整黄金面具，严格复现权威三视图的平额微内凹轮廓、深色弯眉带、杏仁眼孔、长窄鼻梁、小型闭口、短圆下颏、侧边圆形铆孔和锤揲旧金纹理；无冠、无角、无兽耳、无长颈。",
    },
  },
] as const;

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

function seal<T extends Record<string, unknown>>(value: T): T & { fingerprint: string } {
  return { ...value, fingerprint: digest(value) };
}

function requiredText(value: unknown, field: string, maximum = 4_000): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > maximum) throw new Error(`${field} 必须是 1-${maximum} 字符。`);
  return normalized;
}

function assertSha256(value: unknown, field: string): string {
  const normalized = requiredText(value, field, 64).toLowerCase();
  if (!SHA256_PATTERN.test(normalized)) throw new Error(`${field} 必须是 64 位小写 SHA-256。`);
  return normalized;
}

function isInside(candidate: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function assertNotFormalProject(candidate: string): void {
  if (isInside(candidate, FORMAL_PROJECT_ROOT) || isInside(FORMAL_PROJECT_ROOT, candidate)) {
    throw new Error(`P14 canary 拒绝使用正式工程路径：${candidate}`);
  }
}

async function pathExists(candidate: string): Promise<boolean> {
  return access(candidate).then(() => true).catch(() => false);
}

async function withCanaryEnvironment<T>(
  registryPath: string,
  workspaceRoot: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = {
    registry: process.env.AI_CANVAS_REGISTRY_PATH,
    workspace: process.env.AI_CANVAS_WORKSPACE,
    recorded: process.env.AI_CANVAS_RECORDED_SOURCE_DIGEST,
  };
  process.env.AI_CANVAS_REGISTRY_PATH = registryPath;
  process.env.AI_CANVAS_WORKSPACE = workspaceRoot;
  delete process.env.AI_CANVAS_RECORDED_SOURCE_DIGEST;
  try {
    return await operation();
  } finally {
    if (previous.registry === undefined) delete process.env.AI_CANVAS_REGISTRY_PATH;
    else process.env.AI_CANVAS_REGISTRY_PATH = previous.registry;
    if (previous.workspace === undefined) delete process.env.AI_CANVAS_WORKSPACE;
    else process.env.AI_CANVAS_WORKSPACE = previous.workspace;
    if (previous.recorded === undefined) delete process.env.AI_CANVAS_RECORDED_SOURCE_DIGEST;
    else process.env.AI_CANVAS_RECORDED_SOURCE_DIGEST = previous.recorded;
  }
}

async function executeStudioCommand(
  projectRoot: string,
  label: string,
  request: StudioCommandRequest,
): Promise<unknown> {
  const suffix = digest({ projectRoot: path.resolve(projectRoot), label, request }).slice(0, 32);
  const outcome: IdempotentCommandResult = await executeIdempotentCommand(projectRoot, {
    requestId: `p14-${label}-${suffix}`,
    idempotencyKey: `p14-${label}-${suffix}`,
    request,
  });
  if (outcome.status !== "succeeded" || outcome.result === undefined) {
    throw new Error(`P14 命令 ${label} 未成功：${outcome.error?.message ?? outcome.status}`);
  }
  return outcome.result;
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} 结构无效。`);
  return value as Record<string, unknown>;
}

function asString(value: unknown, field: string): string {
  return requiredText(value, field, 2_000);
}

function asSafeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${field} 必须是非负安全整数。`);
  return Number(value);
}

async function promoteRealCanaryAuthorities(
  projectRoot: string,
  references: NonNullable<PrepareP14CanaryInput["authorityReferences"]>,
): Promise<P14AuthorityReferences> {
  const assets: P14AuthorityReferences["assets"] = [];
  for (const spec of REAL_AUTHORITY_SPECS) {
    const sourceValue = requiredText(references[spec.key], `authorityReferences.${spec.key}`);
    if (!path.isAbsolute(sourceValue)) throw new Error(`${spec.key} 必须是绝对路径。`);
    const sourcePath = path.normalize(sourceValue);
    assertNotFormalProject(sourcePath);
    const linkMetadata = await lstat(sourcePath).catch(() => null);
    if (!linkMetadata?.isFile() || linkMetadata.isSymbolicLink()) {
      throw new Error(`${spec.key} 必须是存在的普通图片文件，拒绝符号链接：${sourcePath}`);
    }
    const canonicalSourcePath = await realpath(sourcePath);
    const beforeMetadata = await stat(canonicalSourcePath);
    const beforeBytes = await readFile(canonicalSourcePath);
    const sourceSha256 = createHash("sha256").update(beforeBytes).digest("hex");
    const [imageMetadata, imageStats] = await Promise.all([
      sharp(beforeBytes, { failOn: "error" }).metadata(),
      sharp(beforeBytes, { failOn: "error" }).stats(),
    ]);
    const width = imageMetadata.width ?? 0;
    const height = imageMetadata.height ?? 0;
    const entropy = imageStats.entropy;
    if (!imageMetadata.format || !["jpeg", "png", "webp"].includes(imageMetadata.format)
      || width < 512 || height < 512 || beforeMetadata.size < 10_000
      || !Number.isFinite(entropy) || entropy < 1) {
      throw new Error(`${spec.key} 不是可用于真实一致性验收的非占位权威图：${JSON.stringify({
        format: imageMetadata.format,
        width,
        height,
        sizeBytes: beforeMetadata.size,
        entropy,
      })}`);
    }

    const imported = asRecord(await executeStudioCommand(projectRoot, `import-real-authority-${spec.assetId}`, {
      command: "import_studio_media",
      payload: { sourcePath: canonicalSourcePath, kind: "image", expectedSha256: sourceSha256 },
    }), `${spec.assetId}.import`);
    const importedSha256 = assertSha256(imported.sha256, `${spec.assetId}.import.sha256`);
    if (importedSha256 !== sourceSha256) throw new Error(`${spec.assetId} 导入 SHA 与只读源文件不一致。`);

    const currentAsset = await getStudioCanonicalAsset(projectRoot, spec.assetId);
    if (!currentAsset) throw new Error(`${spec.assetId} 不存在，无法提升真实权威。`);
    let asset = asRecord(await executeStudioCommand(projectRoot, `update-real-authority-definition-${spec.assetId}`, {
      command: "update_studio_asset",
      payload: {
        assetId: spec.assetId,
        expectedRevision: currentAsset.revision,
        description: spec.definition.description,
        identityFeatures: [...spec.definition.identityFeatures],
        positiveLocks: [...spec.definition.positiveLocks],
        negativeLocks: [...spec.definition.negativeLocks],
        defaultPrompt: spec.definition.defaultPrompt,
      },
    }), `${spec.assetId}.update`);
    const appended = asRecord(await executeStudioCommand(projectRoot, `append-real-authority-version-${spec.assetId}`, {
      command: "append_studio_asset_version",
      payload: {
        assetId: spec.assetId,
        mediaSha256: importedSha256,
        reviewStatus: "pending",
        sourceNote: "P14 隔离真实 canary：只读外部权威图内容寻址导入。",
        expectedRevision: asSafeInteger(asset.revision, `${spec.assetId}.updatedRevision`),
      },
    }), `${spec.assetId}.append`);
    const version = asRecord(appended.version, `${spec.assetId}.append.version`);
    const authorityVersionId = asString(version.id, `${spec.assetId}.versionId`);
    asset = asRecord(await executeStudioCommand(projectRoot, `review-real-authority-version-${spec.assetId}`, {
      command: "review_studio_asset_version",
      payload: {
        assetId: spec.assetId,
        versionId: authorityVersionId,
        decision: "approved",
        expectedRevision: asSafeInteger(appended.assetRevision, `${spec.assetId}.assetRevision`),
        note: "P14 主 Agent显式提交的只读权威图已通过 SHA、解码、尺寸和非占位机械预检；此批准只绑定隔离验收输入，不替代视觉审片。",
      },
    }), `${spec.assetId}.review`);
    const authoritative = asRecord(await executeStudioCommand(projectRoot, `promote-real-authority-${spec.assetId}`, {
      command: "set_studio_primary_authority",
      payload: {
        assetId: spec.assetId,
        versionId: authorityVersionId,
        expectedRevision: asSafeInteger(asset.revision, `${spec.assetId}.reviewedRevision`),
        note: "P14 隔离真实 canary 当前主权威。",
      },
    }), `${spec.assetId}.authority`);
    const primaryAuthority = asRecord(authoritative.primaryAuthority, `${spec.assetId}.primaryAuthority`);
    if (asString(primaryAuthority.versionId, `${spec.assetId}.primaryAuthority.versionId`) !== authorityVersionId) {
      throw new Error(`${spec.assetId} 主权威版本未精确切换到真实参考。`);
    }

    const [afterMetadata, afterBytes] = await Promise.all([stat(canonicalSourcePath), readFile(canonicalSourcePath)]);
    const afterSha256 = createHash("sha256").update(afterBytes).digest("hex");
    if (afterSha256 !== sourceSha256 || afterMetadata.size !== beforeMetadata.size
      || afterMetadata.mtimeMs !== beforeMetadata.mtimeMs) {
      throw new Error(`${spec.assetId} 只读源文件在导入过程中发生变化。`);
    }
    assets.push({
      assetId: spec.assetId,
      sourcePath: canonicalSourcePath,
      sourceBasename: path.basename(canonicalSourcePath),
      sourceSha256,
      importedSha256,
      width,
      height,
      sizeBytes: beforeMetadata.size,
      sourceMtimeMs: beforeMetadata.mtimeMs,
      entropy,
      sourceUnchanged: true,
      authorityVersionId,
    });
  }
  return { mode: "real-user-assets", assets };
}

async function fixtureAuthoritySummary(
  fixture: Awaited<ReturnType<typeof createStudioP7Fixture>>,
): Promise<P14AuthorityReferences> {
  const fixtureAssets = [fixture.assets.ahang, fixture.assets.stoneRoom, fixture.assets.completeGoldenMask];
  const assets: P14AuthorityReferences["assets"] = [];
  for (const asset of fixtureAssets) {
    const bytes = await readFile(asset.authorityMedia.sourcePath);
    const [metadata, stats, fileMetadata] = await Promise.all([
      sharp(bytes, { failOn: "error" }).metadata(),
      sharp(bytes, { failOn: "error" }).stats(),
      stat(asset.authorityMedia.sourcePath),
    ]);
    assets.push({
      assetId: asset.id as P14AuthorityReferences["assets"][number]["assetId"],
      sourcePath: asset.authorityMedia.sourcePath,
      sourceBasename: path.basename(asset.authorityMedia.sourcePath),
      sourceSha256: asset.authorityMedia.imported.sha256,
      importedSha256: asset.authorityMedia.imported.sha256,
      width: metadata.width ?? 0,
      height: metadata.height ?? 0,
      sizeBytes: fileMetadata.size,
      sourceMtimeMs: fileMetadata.mtimeMs,
      entropy: stats.entropy,
      sourceUnchanged: true,
      authorityVersionId: asset.authorityVersionId,
    });
  }
  return { mode: "fixture-only", assets };
}

function normalizedRunName(value: string | undefined): string {
  if (value !== undefined) {
    const normalized = requiredText(value, "runName", 100);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(normalized)) throw new Error("runName 只允许字母、数字、点、下划线和短横线。");
    return normalized;
  }
  const timestamp = new Date().toISOString().replace(/[:.]/gu, "-");
  return `p14-canary-${timestamp}-${randomUUID().slice(0, 8)}`;
}

async function readState(statePathValue: string): Promise<P14CanaryState> {
  const statePath = path.resolve(requiredText(statePathValue, "statePath"));
  const parsed = JSON.parse(await readFile(statePath, "utf8")) as P14CanaryState;
  if (!parsed || parsed.schemaVersion !== 1 || parsed.kind !== "p14-real-canary-orchestration-state") {
    throw new Error("statePath 不是 P14 canary state v1。");
  }
  const { fingerprint, ...semantic } = parsed;
  if (!SHA256_PATTERN.test(fingerprint) || digest(semantic) !== fingerprint) throw new Error("P14 canary state fingerprint 校验失败。");
  if (!path.isAbsolute(parsed.runRoot) || !path.isAbsolute(parsed.registryPath) || !path.isAbsolute(parsed.project.root)) {
    throw new Error("P14 canary state 必须使用绝对路径。");
  }
  if (!isInside(parsed.registryPath, parsed.runRoot) || !isInside(parsed.project.root, parsed.runRoot)) {
    throw new Error("P14 canary state 越出隔离 runRoot。");
  }
  assertNotFormalProject(parsed.project.root);
  return parsed;
}

async function writeState(statePath: string, semantic: Omit<P14CanaryState, "fingerprint">): Promise<P14CanaryState> {
  const state = seal(semantic as unknown as Record<string, unknown>) as unknown as P14CanaryState;
  await writeJsonAtomic(statePath, state);
  return state;
}

export interface P14RealCanaryAuthorityVerification {
  authoritySourcesUnchanged: true;
  primaryAuthoritiesCurrent: true;
  packReferencesMatched: true;
  continuityReferencesMatched: true;
  fixtureAuthoritiesExcluded: true;
  goldenMaskDefinitionLocked: true;
}

/**
 * 在 prepare、finalize 与安装版审片前重复核对同一组真实权威。
 * 任一外部源、当前主权威、冻结包或连续性引用漂移都失败关闭。
 */
export async function verifyP14RealCanaryAuthorities(
  state: P14CanaryState,
): Promise<P14RealCanaryAuthorityVerification> {
  if (state.authorityReferences.mode !== "real-user-assets" || state.authorityReferences.assets.length !== 3) {
    throw new Error("P14 真实 canary 权威集合不是三项 real-user-assets。");
  }
  const pack = await readPersistedStudioGenerationPack(state.project.root, state.pack.id);
  if (!pack || pack.fingerprint !== state.pack.fingerprint) throw new Error("P14 真实 canary 冻结包漂移或不存在。");
  for (const authority of state.authorityReferences.assets) {
    if (!path.isAbsolute(authority.sourcePath)) throw new Error(`${authority.assetId} 权威源路径不是绝对路径。`);
    const metadata = await lstat(authority.sourcePath).catch(() => null);
    if (!metadata?.isFile() || metadata.isSymbolicLink()) throw new Error(`${authority.assetId} 权威源不再是普通文件。`);
    const bytes = await readFile(authority.sourcePath);
    if (createHash("sha256").update(bytes).digest("hex") !== authority.sourceSha256
      || metadata.size !== authority.sizeBytes || metadata.mtimeMs !== authority.sourceMtimeMs) {
      throw new Error(`${authority.assetId} 权威源在冻结后发生漂移。`);
    }
    const detail = await getStudioCanonicalAsset(state.project.root, authority.assetId);
    const version = detail?.versions.find((candidate) => candidate.id === authority.authorityVersionId);
    if (!detail?.primaryAuthority || detail.primaryAuthority.versionId !== authority.authorityVersionId
      || detail.primaryAuthority.mediaSha256 !== authority.importedSha256
      || version?.mediaSha256 !== authority.importedSha256 || version.reviewStatus !== "approved") {
      throw new Error(`${authority.assetId} 当前主权威、审核版本或 SHA 与 state 不一致。`);
    }
    const controlReference = pack.request.controlReferences.find((reference) => reference.assetId === authority.assetId);
    if (!controlReference || controlReference.assetVersionId !== authority.authorityVersionId
      || controlReference.mediaSha256 !== authority.importedSha256) {
      throw new Error(`${authority.assetId} 冻结包没有精确绑定当前主权威。`);
    }
    const continuity = pack.continuity.assets.find((candidate) => candidate.assetId === authority.assetId);
    const referenceHead = continuity?.heads.find((head) => head.field === "referenceSha256");
    if (!referenceHead || referenceHead.state.status !== "resolved"
      || referenceHead.state.value !== authority.importedSha256
      || continuity?.heads.some((head) => head.state.provenance.some((entry) => /fixture/iu.test(entry.kind)))) {
      throw new Error(`${authority.assetId} 连续性引用不是当前真实权威或仍含 fixture provenance。`);
    }
    if (authority.assetId === "prop-complete-golden-mask") {
      const definitionText = [
        detail.description,
        ...detail.identityFeatures,
        ...detail.positiveLocks,
        ...detail.negativeLocks,
        detail.defaultPrompt,
      ].join("\n");
      for (const required of ["平额", "杏仁", "长窄鼻梁", "闭口", "侧边", "铆孔", "无冠", "无角", "无兽耳", "无长颈"]) {
        if (!definitionText.includes(required)) throw new Error(`黄金面具硬锁缺少：${required}`);
      }
      if (detail.identityFeatures.some((entry) => /高额冠|外展双耳|完整下颌与颈部/iu.test(entry))) {
        throw new Error("黄金面具身份特征仍残留旧高冠、外耳或长颈结构。");
      }
    }
  }
  return {
    authoritySourcesUnchanged: true,
    primaryAuthoritiesCurrent: true,
    packReferencesMatched: true,
    continuityReferencesMatched: true,
    fixtureAuthoritiesExcluded: true,
    goldenMaskDefinitionLocked: true,
  };
}

async function activateStateProject(state: P14CanaryState): Promise<ActiveManagedStudioContext> {
  const shell = await inspectManagedProject(state.project.root);
  if (shell.project.id !== state.project.id || shell.manifestFingerprint !== state.project.manifestFingerprint) {
    throw new Error("P14 canary 工程身份与 state 不一致。");
  }
  await registerProject(shell.project);
  await setActiveProjectRegistration(shell.paths.root);
  await setActiveStudioContext(shell.paths.root, {
    mode: "continuity-review",
    focus: { unitId: state.target.unitId, panelId: state.target.panelId },
  });
  const context = await getActiveManagedStudioContext();
  if (context.projectId !== state.project.id || context.manifestFingerprint !== state.project.manifestFingerprint) {
    throw new Error("P14 canary 活动工程与 state 不一致。");
  }
  return context;
}

function currentPanel(
  control: Awaited<ReturnType<typeof getStudioBindingControl>>,
  panelId: string,
) {
  const panel = control.panels.find((entry) => entry.id === panelId);
  if (!panel) throw new Error(`绑定控制缺少目标宫格：${panelId}`);
  return panel;
}

async function createCanaryTargetUnit(
  projectRoot: string,
  template: StudioProductionUnitSnapshot,
): Promise<StudioProductionUnitSnapshot> {
  const unitId = "p14-canary-unit-two-panel";
  await executeStudioCommand(projectRoot, "create-canary-target-unit", {
    command: "create_studio_production_unit",
    payload: {
      id: unitId,
      expectedRevision: 0,
      season: "P14",
      episode: "CANARY",
      sequence: 1,
      title: "P14 真实单图 canary 二宫格单元",
      scriptRevisionId: template.scriptRevision.id,
      panels: template.panels.map((panel, index) => ({
        id: `p14-canary-panel-${String(index + 1).padStart(2, "0")}`,
        title: `P14 canary 宫格 ${index + 1}`,
        visualAction: panel.visualAction,
        shotComposition: panel.shotComposition,
        filmingMethod: panel.filmingMethod,
        dialogue: panel.dialogue,
        subtitle: panel.subtitle,
        startSeconds: panel.startSeconds,
        endSeconds: panel.endSeconds,
        durationSeconds: panel.durationSeconds,
        promptRevisionId: panel.promptRevisionId,
        sourceSpans: panel.sourceSpans.map((span) => ({
          startOffsetUtf16: span.startOffsetUtf16,
          endOffsetUtf16: span.endOffsetUtf16,
        })),
        assets: panel.assets.map((asset) => ({
          assetId: asset.assetId,
          category: asset.category,
          presence: asset.presence,
          role: asset.role,
          continuityState: asset.continuityState,
          evidence: asset.evidence.map((entry) => ({
            kind: entry.kind,
            reference: entry.reference,
            ...(entry.note ? { note: entry.note } : {}),
          })),
        })),
      })),
    },
  });
  const created = await getStudioProductionUnitSnapshot(projectRoot, unitId);
  if (!created || created.unit.durationSeconds !== 15 || created.unit.panelCount < 2 || created.unit.panelCount > 6) {
    throw new Error("P14 canary 目标单元未达到 15 秒 2-6 宫格合同。");
  }
  return created;
}

function p14ContinuityValue(
  assetId: P14AuthorityReferences["assets"][number]["assetId"],
  field: typeof STUDIO_CONTINUITY_FIELDS[number],
  referenceSha256: string,
): string {
  if (field === "referenceSha256") return referenceSha256;
  const values: Record<P14AuthorityReferences["assets"][number]["assetId"], Record<Exclude<typeof field, "referenceSha256">, string>> = {
    "character-ahang": {
      costume: "黑色破旧古蜀长袍，高发髻，左侧银白挑染",
      injury: "无可见新伤",
      heldObject: "双手托举一张完整黄金面具",
      position: "灰黑巨石密室中央石台前",
      facing: "面向镜头，头部略低",
      emotion: "克制、警觉、肃穆",
      layout: "单人中近景，黄金面具位于胸前中央",
      lighting: "左侧暖色火光，环境冷暗",
    },
    "prop-complete-golden-mask": {
      costume: "不适用：独立刚性道具",
      injury: "完整无裂损、无缺口",
      heldObject: "由阿航双手托举",
      position: "画面胸前中央",
      facing: "正面朝向镜头",
      emotion: "不适用：无生命刚性道具",
      layout: "仅一张完整面具，不复制、不与人物融合",
      lighting: "左侧暖火光勾勒锤揲金面纹理",
    },
    "scene-stone-room": {
      costume: "不适用：固定古蜀场景",
      injury: "巨石结构完整，无现代改造",
      heldObject: "不适用：场景不持物",
      position: "固定灰黑巨石密室",
      facing: "镜头朝向中央石台",
      emotion: "肃穆、压抑、低照度",
      layout: "中央石台、左侧火光、背景灰黑巨石墙",
      lighting: "左侧暖火光与冷暗石室对比",
    },
  };
  return values[assetId][field];
}

/** 真实 canary 只写明确的生产连续性事实，禁止沿用 test-fixture provenance。 */
async function seedP14RealCanaryContinuity(
  projectRoot: string,
  input: {
    unit: StudioProductionUnitSnapshot;
    panelId: string;
    authorityReferences: P14AuthorityReferences;
  },
): Promise<void> {
  const panel = input.unit.panels.find((candidate) => candidate.id === input.panelId);
  if (!panel) throw new Error(`P14 canary 连续性目标宫格不存在：${input.panelId}`);
  const scope = {
    kind: "panel" as const,
    scopeId: panel.id,
    unitId: input.unit.unit.id,
    unitRevision: input.unit.unit.revision,
    startMilliseconds: Math.round(panel.startSeconds * 1_000),
    endMilliseconds: Math.round(panel.endSeconds * 1_000),
  };
  for (const authority of input.authorityReferences.assets) {
    for (const field of STUDIO_CONTINUITY_FIELDS) {
      const value = p14ContinuityValue(authority.assetId, field, authority.importedSha256);
      await executeStudioCommand(projectRoot, `real-continuity-${authority.assetId}-${field}`, {
        command: "append_studio_continuity_observation",
        payload: {
          expectedHeadRevision: 0,
          scope,
          subjectId: authority.assetId,
          field,
          state: {
            status: "resolved",
            value,
            provenance: [{
              kind: "p14-real-authority-contract",
              reference: `${authority.assetId}@${authority.authorityVersionId}`,
              sourceFingerprint: authority.importedSha256,
              note: "由当前主权威和主 Agent明确连续性约束建立；不代表结果图已通过视觉审片。",
            }],
          },
        },
      });
    }
  }
}

async function resolveTargetBindingWithAmbiguity(
  projectRoot: string,
  unitId: string,
  panelId: string,
): Promise<P14CanaryState["ambiguity"]> {
  await executeStudioCommand(projectRoot, "create-ambiguity-candidate", {
    command: "create_studio_asset",
    payload: {
      id: "character-ahang-ambiguity-candidate",
      expectedRevision: 0,
      category: "character",
      // 与权威资产使用同一 formal-name，确保 exact identity index
      // 真正进入 ambiguous，而不是被 formal-name > alias 优先级规则消解。
      name: "阿航",
      aliases: ["P14 验收候选替身"],
      description: "P14 隔离验收工程中的显式歧义候选，不允许进入正式生成绑定。",
      identityFeatures: ["仅用于验证歧义门禁"],
      positiveLocks: ["禁止自动选中"],
      negativeLocks: ["禁止作为权威生图参考"],
      defaultPrompt: "不用于生图。",
    },
  });

  let control = await getStudioBindingControl(projectRoot, { unitId });
  await executeStudioCommand(projectRoot, "analyze-with-ambiguity", {
    command: "analyze_studio_script_entities",
    payload: {
      unitId,
      panelId,
      expectedRevisionToken: control.revisionToken,
    },
  });
  control = await getStudioBindingControl(projectRoot, { unitId });
  const analyzedPanel = currentPanel(control, panelId);
  const ambiguity = analyzedPanel.proposals.find((proposal) => proposal.entityText === "阿航" && proposal.status === "ambiguous");
  if (!ambiguity || !ambiguity.candidates.some((candidate) => candidate.assetId === "character-ahang")
    || !ambiguity.candidates.some((candidate) => candidate.assetId === "character-ahang-ambiguity-candidate")) {
    throw new Error("P14 canary 未制造出可验证的阿航双候选歧义。");
  }

  let ambiguityDecisionReceiptId = "";
  const proposals: StudioBindingProposal[] = [...analyzedPanel.proposals]
    .sort((left, right) => left.id.localeCompare(right.id, "en"));
  for (const proposal of proposals) {
    control = await getStudioBindingControl(projectRoot, { unitId });
    const liveProposal = currentPanel(control, panelId).proposals.find((entry) => entry.id === proposal.id);
    if (!liveProposal) throw new Error(`P14 canary 提议在裁决前漂移：${proposal.id}`);
    const ambiguousAhang = liveProposal.id === ambiguity.id;
    if (!ambiguousAhang && (!liveProposal.matchedAssetId || liveProposal.status !== "matched")) {
      throw new Error(`P14 canary 存在无法安全裁决的提议：${liveProposal.entityText}/${liveProposal.status}`);
    }
    const result = asRecord(await executeStudioCommand(projectRoot, `resolve-${liveProposal.id}`, {
      command: "resolve_studio_entity_proposal",
      payload: {
        unitId,
        panelId,
        proposalId: liveProposal.id,
        decision: ambiguousAhang ? "select" : "accept",
        selectedAssetId: ambiguousAhang ? "character-ahang" : liveProposal.matchedAssetId!,
        presence: liveProposal.presence,
        role: liveProposal.role,
        expectedRevisionToken: control.revisionToken,
        reviewer: "codex",
        note: ambiguousAhang
          ? "P14 隔离 canary 显式歧义验收：选择已审核且有主权威图的 character-ahang，不允许静默选首项。"
          : "P14 隔离 canary 显式确认唯一 exact 资产。",
      },
    }), "resolve result");
    if (ambiguousAhang) ambiguityDecisionReceiptId = asString(result.receiptId, "ambiguity receiptId");
  }

  control = await getStudioBindingControl(projectRoot, { unitId });
  const resolvedPanel = currentPanel(control, panelId);
  if (!resolvedPanel.freezeAllowed || resolvedPanel.proposals.some((proposal) => !proposal.resolvedAssetId)) {
    throw new Error(`P14 canary 歧义裁决后仍不允许冻结：${resolvedPanel.statusReason ?? resolvedPanel.status}`);
  }
  await executeStudioCommand(projectRoot, "freeze-target-binding", {
    command: "freeze_studio_asset_binding_set",
    payload: { unitId, panelId, expectedRevisionToken: control.revisionToken },
  });
  control = await getStudioBindingControl(projectRoot, { unitId });
  const readyPanel = currentPanel(control, panelId);
  if (readyPanel.status !== "generation-ready" || readyPanel.bindingSet?.currentness !== "current") {
    throw new Error("P14 canary 目标宫格绑定未达 generation-ready。");
  }
  if (!ambiguityDecisionReceiptId) throw new Error("P14 canary 歧义决策回执缺失。");
  return {
    proposalId: ambiguity.id,
    surfaceText: ambiguity.entityText,
    candidateAssetIds: ambiguity.candidates.map((candidate) => candidate.assetId)
      .sort((left, right) => left.localeCompare(right, "en")),
    selectedAssetId: "character-ahang",
    reviewer: "codex",
    decisionReceiptId: ambiguityDecisionReceiptId,
  };
}

export async function prepareP14RealCanary(input: PrepareP14CanaryInput = {}): Promise<P14CanaryState> {
  if (input.authorityReferences && input.allowFixtureAuthoritiesForTest) {
    throw new Error("真实 authorityReferences 与测试夹具开关不可同时使用。");
  }
  if (!input.authorityReferences && !input.allowFixtureAuthoritiesForTest) {
    throw new Error("P14 真实 canary 必须显式提供阿航、石室和完整黄金面具三张真实权威参考；纯色 fixture 仅允许单元测试显式启用。");
  }
  const outputParent = path.resolve(input.outputRoot ?? path.join(WORKSPACE_ROOT, "output", "p14-real-canary"));
  assertNotFormalProject(outputParent);
  await mkdir(outputParent, { recursive: true });
  const canonicalOutputParent = await realpath(outputParent);
  const runRoot = path.join(canonicalOutputParent, normalizedRunName(input.runName));
  if (await pathExists(runRoot)) throw new Error(`P14 canary run 已存在，拒绝覆盖：${runRoot}`);
  await mkdir(runRoot);
  const registryPath = path.join(runRoot, "registry", "projects.json");
  const projectsParent = path.join(runRoot, "acceptance-projects");
  const statePath = path.join(runRoot, STATE_FILENAME);
  await mkdir(path.dirname(registryPath), { recursive: true });

  return withCanaryEnvironment(registryPath, WORKSPACE_ROOT, async () => {
    try {
      const fixture = await createStudioP7Fixture({ parentDirectory: projectsParent });
      assertNotFormalProject(fixture.root);
      if (!isInside(fixture.root, runRoot)) throw new Error("P14 canary fixture 越出 runRoot。");
      const authorityReferences = input.authorityReferences
        ? await promoteRealCanaryAuthorities(fixture.root, input.authorityReferences)
        : await fixtureAuthoritySummary(fixture);
      await registerProject(fixture.shell.project);
      await setActiveProjectRegistration(fixture.root);

      // fixture 原有单元已冻结 BindingSet；验收目标另建同一真实
      // owner 下的二宫格单元，避免用旧 binding 遮蔽新歧义裁决。
      const unit = await createCanaryTargetUnit(fixture.root, fixture.units.twoPanel);
      const panel = unit.panels[0]!;
      await setActiveStudioContext(fixture.root, {
        mode: "binding",
        focus: { unitId: unit.unit.id, panelId: panel.id },
      });
      const ambiguity = await resolveTargetBindingWithAmbiguity(fixture.root, unit.unit.id, panel.id);
      const assetIds = panel.assets
        .filter((asset) => asset.presence !== "forbidden")
        .map((asset) => asset.assetId)
        .sort((left, right) => left.localeCompare(right, "en"));
      if (authorityReferences.mode === "real-user-assets") {
        await seedP14RealCanaryContinuity(fixture.root, {
          unit,
          panelId: panel.id,
          authorityReferences,
        });
      } else {
        await seedStudioP7ResolvedPanelContinuity(fixture.root, {
          unitId: unit.unit.id,
          panelId: panel.id,
          assetIds,
        });
      }

      const freezeResult = asRecord(await executeStudioCommand(fixture.root, "freeze-generation-pack", {
        command: "freeze_studio_generation_pack",
        payload: {
          unitId: unit.unit.id,
          panelId: panel.id,
          expectedRevision: unit.unit.revision,
        },
      }), "freeze result");
      const packId = asString(freezeResult.packId, "freeze.packId");
      const packFingerprint = assertSha256(freezeResult.fingerprint, "freeze.fingerprint");
      const pack = await readPersistedStudioGenerationPack(fixture.root, packId);
      if (!pack || pack.fingerprint !== packFingerprint) throw new Error("P14 canary 持久冻结包无法精确读回。");
      const authorityByAsset = new Map(authorityReferences.assets.map((asset) => [asset.assetId, asset] as const));
      if (pack.request.controlReferences.length !== authorityReferences.assets.length
        || pack.request.controlReferences.some((reference) => {
          const authority = authorityByAsset.get(reference.assetId as P14AuthorityReferences["assets"][number]["assetId"]);
          return !authority || reference.mediaSha256 !== authority.importedSha256
            || reference.assetVersionId !== authority.authorityVersionId;
        })) {
        throw new Error("P14 canary 冻结包没有精确绑定当前三项主权威参考。");
      }
      const generationRunId = `p14-codex-canary-${digest({ runRoot, packId, packFingerprint }).slice(0, 24)}`;
      await executeStudioCommand(fixture.root, "dispatch-codex", {
        command: "dispatch_studio_generation_pack",
        payload: {
          packId,
          packFingerprint,
          generationRunId,
          provider: "codex",
          expectedRevision: unit.unit.revision,
        },
      });
      const dispatch = await readStudioGenerationDispatch(fixture.root, generationRunId);
      if (!dispatch || dispatch.provider !== "codex" || dispatch.packFingerprint !== packFingerprint) {
        throw new Error("P14 canary Codex dispatch 读回不一致。");
      }
      await setActiveStudioContext(fixture.root, {
        mode: "continuity-review",
        focus: { unitId: unit.unit.id, panelId: panel.id },
      });
      const context = await getActiveManagedStudioContext();
      const shell = await inspectManagedProject(fixture.root);
      const requestEnvelopePath = path.join(runRoot, REQUEST_FILENAME);
      const prepareEvidencePath = path.join(runRoot, "prepare-evidence.json");
      const suggestedRawPath = path.join(runRoot, "incoming", `${generationRunId}_raw.png`);
      const requestEnvelope = seal({
        schemaVersion: 1,
        kind: "p14-codex-imagegen-request-envelope",
        createdAt: new Date().toISOString(),
        warning: "此文件是本地 dispatch intent，不是供应商回执；编排脚本未调用生图模型。",
        project: {
          id: context.projectId,
          manifestFingerprint: context.manifestFingerprint,
          contextToken: context.projectContextToken,
        },
        generation: {
          provider: "codex",
          generationRunId,
          packId,
          packFingerprint,
          dispatchId: dispatch.dispatchId,
          dispatchProvenance: dispatch.dispatchProvenance,
        },
        authorityReferences,
        orchestration: {
          statePath,
          registryPath,
          finalizeMode: "npm run p14:canary:finalize -- --state <state> --raw-path <absolute.png> --raw-sha256 <sha> --call-id <id> --model <model>",
          reviewMode: "npm run p14:canary:review -- --state <state> --decision <pass|rework|reject> --note <text> --confirmed-by-user",
        },
        request: pack.request,
        outputContract: {
          exactlyOneImage: true,
          orientation: "portrait-9:16",
          variant: "raw",
          suggestedRawPath,
          doNotRenderLocalLabel: true,
          maxCalls: 1,
        },
        finalizeCommandTemplate: {
          command: "commit_agent_imagegen_result_bundle",
          payload: {
            projectContextToken: "<FINALIZE_MODE_REFRESHES_THIS_TOKEN>",
            packId,
            packFingerprint,
            generationRunId,
            provider: "codex",
            rawPath: "<ABSOLUTE_RAW_PATH>",
            rawSha256: "<SHA256>",
            expectedRevision: pack.target.unitRevision,
            executionReceipt: {
              schemaVersion: 1,
              kind: "agent-imagegen-execution-receipt",
              provider: "codex",
              source: "codex-imagegen",
              attestationLevel: "agent-session-direct",
              cryptographicProviderReceipt: false,
              callId: "<CALL_ID>",
              model: "<MODEL>",
              generatedAt: "<ISO_UTC>",
            },
          },
        },
      });
      await writeJsonAtomic(requestEnvelopePath, requestEnvelope);

      const now = new Date().toISOString();
      const semantic: Omit<P14CanaryState, "fingerprint"> = {
        schemaVersion: 1,
        kind: "p14-real-canary-orchestration-state",
        phase: "dispatched",
        createdAt: now,
        updatedAt: now,
        runRoot,
        registryPath,
        workspaceRoot: WORKSPACE_ROOT,
        project: {
          root: fixture.root,
          id: shell.project.id,
          manifestFingerprint: shell.manifestFingerprint,
        },
        target: {
          unitId: unit.unit.id,
          unitRevision: unit.unit.revision,
          panelId: panel.id,
          panelIndex: panel.index,
          panelCount: unit.unit.panelCount,
          durationSeconds: unit.unit.durationSeconds,
          assetIds,
        },
        ambiguity,
        continuityFingerprint: pack.continuity.fingerprint,
        pack: { id: packId, fingerprint: packFingerprint },
        dispatch,
        generationRunId,
        provider: "codex",
        authorityReferences,
        requestEnvelopePath,
        prepareEvidencePath,
      };
      const state = await writeState(statePath, semantic);
      const authorityVerification = authorityReferences.mode === "real-user-assets"
        ? await verifyP14RealCanaryAuthorities(state)
        : null;
      const prepareEvidence = seal({
        schemaVersion: 1,
        kind: "p14-real-canary-prepare-evidence",
        status: "PASS",
        createdAt: now,
        statement: "隔离验收工程已完成歧义裁决、绑定、连续性、冻结与 Codex 本地派发；未调用生图模型。",
        statePath,
        requestEnvelopePath,
        project: state.project,
        activeContext: {
          projectId: context.projectId,
          manifestFingerprint: context.manifestFingerprint,
          buildId: context.build.buildId,
          sourceDigest: context.build.sourceDigest,
          counts: context.counts,
        },
        target: state.target,
        ambiguity,
        pack: state.pack,
        dispatch,
        authorityReferences,
        gates: {
          independentRegistry: isInside(registryPath, runRoot),
          isolatedProject: isInside(fixture.root, runRoot) && !isInside(fixture.root, FORMAL_PROJECT_ROOT),
          assetCategoriesPresent: context.counts.characters >= 1 && context.counts.scenes >= 1 && context.counts.props >= 1,
          scriptAndPromptFrozen: pack.scriptRevision.bodySha256.length === 64 && pack.promptRevision.bodySha256.length === 64,
          unitIsFifteenSeconds: unit.unit.durationSeconds === 15,
          panelCountWithinTwoToSix: unit.unit.panelCount >= 2 && unit.unit.panelCount <= 6,
          bindingCurrent: pack.assetBinding.currentness.current,
          continuityReady: pack.continuity.assets.every((asset) => asset.heads.length >= pack.continuity.requiredFields.length),
          ambiguityExplicitlyResolved: ambiguity.selectedAssetId === "character-ahang",
          dispatchedToCodex: dispatch.provider === "codex",
          realAuthorityReferences: authorityReferences.mode === "real-user-assets",
          authoritySourcesUnchanged: authorityReferences.assets.length === 3
            && authorityReferences.assets.every((asset) => asset.sourceUnchanged && asset.sourceSha256 === asset.importedSha256),
          authorityReferencesNonPlaceholder: authorityReferences.assets.length === 3
            && authorityReferences.assets.every((asset) => asset.width >= 512 && asset.height >= 512
              && asset.sizeBytes >= 10_000 && asset.entropy >= 1),
          primaryAuthoritiesCurrent: authorityVerification?.primaryAuthoritiesCurrent ?? false,
          packReferencesMatched: authorityVerification?.packReferencesMatched ?? false,
          continuityReferencesMatched: authorityVerification?.continuityReferencesMatched ?? false,
          fixtureAuthoritiesExcluded: authorityVerification?.fixtureAuthoritiesExcluded ?? false,
          goldenMaskDefinitionLocked: authorityVerification?.goldenMaskDefinitionLocked ?? false,
          fixtureAuthoritiesExplicitlyAllowedForTest: authorityReferences.mode === "fixture-only"
            && input.allowFixtureAuthoritiesForTest === true,
          imagegenInvokedByOrchestrator: false,
        },
      });
      await writeJsonAtomic(prepareEvidencePath, prepareEvidence);
      return state;
    } catch (error) {
      await writeJsonAtomic(path.join(runRoot, "prepare-failure.json"), seal({
        schemaVersion: 1,
        kind: "p14-real-canary-prepare-failure",
        status: "FAIL",
        observedAt: new Date().toISOString(),
        message: error instanceof Error ? error.message : String(error),
        imagegenInvokedByOrchestrator: false,
      })).catch(() => undefined);
      throw error;
    }
  });
}

export async function finalizeP14RealCanary(input: FinalizeP14CanaryInput): Promise<P14CanaryState> {
  const statePath = path.resolve(requiredText(input.statePath, "statePath"));
  const state = await readState(statePath);
  if (state.phase === "reviewed") throw new Error("P14 canary 已审片，拒绝重绑 raw。");
  const rawPath = path.resolve(requiredText(input.rawPath, "rawPath"));
  if (!path.isAbsolute(input.rawPath)) throw new Error("rawPath 必须是绝对路径。");
  const rawSha256 = assertSha256(input.rawSha256, "rawSha256");
  const callId = requiredText(input.callId, "callId", 255);
  const model = requiredText(input.model, "model", 200);
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  if (new Date(generatedAt).toISOString() !== generatedAt) throw new Error("generatedAt 必须是规范 ISO-8601 UTC 时间。");
  const source = input.executionSource ?? "codex-imagegen";
  if (source === "codex-imagegen" && state.authorityReferences.mode !== "real-user-assets") {
    throw new Error("真实 Codex canary 拒绝使用 fixture-only 权威参考。");
  }

  return withCanaryEnvironment(state.registryPath, state.workspaceRoot, async () => {
    const context = await activateStateProject(state);
    if (state.authorityReferences.mode === "real-user-assets") {
      await verifyP14RealCanaryAuthorities(state);
    }
    if (state.finalization) {
      const receipt = state.finalization.executionReceipt;
      const sameRequest = path.resolve(state.finalization.rawPath) === rawPath
        && state.finalization.rawSha256 === rawSha256
        && receipt.callId === callId
        && receipt.model === model
        && receipt.source === source
        && (input.generatedAt === undefined || receipt.generatedAt === generatedAt);
      if (!sameRequest) throw new Error("P14 canary 已写回的 generation run 拒绝改绑不同 raw 或执行回执。");
      const existing = await readStudioGenerationResultBundle(state.project.root, state.generationRunId);
      const reviewControl = await getStudioGenerationReviewControl(state.project.root, state.generationRunId);
      if (!existing || existing.fingerprint !== state.finalization.bundle.fingerprint
        || existing.raw.mediaSha256 !== rawSha256 || !existing.pairComplete
        || reviewControl.status !== "unreviewed") {
        throw new Error("P14 canary finalize 幂等重试时发现结果对或 Review 状态漂移。");
      }
      return state;
    }
    const pack = await readPersistedStudioGenerationPack(state.project.root, state.pack.id);
    if (!pack || pack.fingerprint !== state.pack.fingerprint || pack.continuity.fingerprint !== state.continuityFingerprint) {
      throw new Error("P14 canary 冻结包或连续性已漂移。");
    }
    const executionReceipt: P14CanaryFinalization["executionReceipt"] = {
      schemaVersion: 1,
      kind: "agent-imagegen-execution-receipt",
      provider: "codex",
      source,
      attestationLevel: source === "codex-imagegen" ? "agent-session-direct" : "unverified-external-agent",
      cryptographicProviderReceipt: false,
      callId,
      model,
      generatedAt,
    };
    const writebackOutcome = await executeStudioCommand(state.project.root, "commit-result-bundle", {
      command: "commit_agent_imagegen_result_bundle",
      payload: {
        projectContextToken: context.projectContextToken,
        packId: state.pack.id,
        packFingerprint: state.pack.fingerprint,
        generationRunId: state.generationRunId,
        provider: "codex",
        rawPath,
        rawSha256,
        expectedRevision: state.target.unitRevision,
        executionReceipt,
      },
    }) as StudioAgentImagegenResultBundleOutcome;
    if (writebackOutcome.schemaVersion !== 4
      || writebackOutcome.kind !== "studio-agent-imagegen-result-bundle-outcome"
      || writebackOutcome.projectId !== state.project.id
      || writebackOutcome.manifestFingerprint !== state.project.manifestFingerprint
      || writebackOutcome.generationRunId !== state.generationRunId
      || writebackOutcome.packId !== state.pack.id
      || writebackOutcome.packFingerprint !== state.pack.fingerprint
      || writebackOutcome.provider !== "codex"
      || writebackOutcome.media.raw.sha256 !== rawSha256
      || writebackOutcome.review.status !== "pending"
      || writebackOutcome.review.autoApproved !== false
      || !SHA256_PATTERN.test(writebackOutcome.executionReceiptFingerprint)
      || !SHA256_PATTERN.test(writebackOutcome.writebackReceiptFingerprint)
      || !SHA256_PATTERN.test(writebackOutcome.fingerprint)) {
      throw new Error("P14 canary command bus 未返回可审计的 v4 原子写回 outcome。");
    }
    const bundle = await readStudioGenerationResultBundle(state.project.root, state.generationRunId);
    if (!bundle || !bundle.pairComplete || bundle.raw.mediaSha256 !== rawSha256
      || bundle.provider !== "codex" || bundle.status !== "pending-review") {
      throw new Error("P14 canary raw/labeled bundle 未原子成对读回。");
    }
    const reviewControl = await getStudioGenerationReviewControl(state.project.root, state.generationRunId);
    if (reviewControl.status !== "unreviewed" || reviewControl.headRevision !== 0) {
      throw new Error("P14 canary finalize 禁止自动通过视觉 Review。");
    }
    const evidencePath = path.join(state.runRoot, "finalize-evidence.json");
    const finalizedAt = new Date().toISOString();
    const finalization: P14CanaryFinalization = {
      rawPath,
      rawSha256,
      executionReceipt,
      bundle,
      writebackAudit: {
        schemaVersion: 1,
        kind: "p14-agent-imagegen-writeback-audit",
        executionReceiptFingerprint: writebackOutcome.executionReceiptFingerprint,
        writebackReceiptFingerprint: writebackOutcome.writebackReceiptFingerprint,
        outcomeFingerprint: writebackOutcome.fingerprint,
        resultBundleFingerprint: writebackOutcome.results.fingerprint,
      },
      evidencePath,
    };
    const { fingerprint: _fingerprint, ...prior } = state;
    const next = await writeState(statePath, {
      ...prior,
      phase: "writeback-pending-review",
      updatedAt: finalizedAt,
      finalization,
    });
    const reviewRequestPath = path.join(state.runRoot, REVIEW_REQUEST_FILENAME);
    await writeJsonAtomic(reviewRequestPath, seal({
      schemaVersion: 1,
      kind: "p14-user-review-request-envelope",
      createdAt: finalizedAt,
      statePath,
      generationRunId: state.generationRunId,
      rawPath,
      rawSha256,
      labeledSha256: bundle.labeled.mediaSha256,
      reviewStatus: "pending",
      instruction: "请用原尺寸检查 raw，再在明确的用户确认后执行 review 模式。机械验收不等于视觉通过。",
      requiredCriteria: REVIEW_CRITERIA,
      reviewCommandExample: {
        mode: "review",
        decision: "pass|rework|reject",
        confirmedByUserRequired: true,
      },
    }));
    await writeJsonAtomic(evidencePath, seal({
      schemaVersion: 1,
      kind: "p14-real-canary-finalize-evidence",
      status: "PASS",
      createdAt: finalizedAt,
      statePath,
      project: state.project,
      generationRunId: state.generationRunId,
      provider: bundle.provider,
      pack: state.pack,
      pair: {
        raw: { resultId: bundle.raw.resultId, sha256: bundle.raw.mediaSha256, status: bundle.raw.status },
        labeled: { resultId: bundle.labeled.resultId, sha256: bundle.labeled.mediaSha256, status: bundle.labeled.status },
        pairComplete: bundle.pairComplete,
      },
      review: {
        status: reviewControl.status,
        headRevision: reviewControl.headRevision,
        autoApproved: false,
        requestEnvelopePath: reviewRequestPath,
      },
    }));
    return next;
  });
}

export async function reviewP14RealCanary(input: ReviewP14CanaryInput): Promise<P14CanaryState> {
  if (!input.confirmedByUser) throw new Error("review 模式必须明示 --confirmed-by-user，禁止 Agent 冒充用户审片。");
  const note = requiredText(input.note, "note", 8_000);
  if (!REVIEW_CRITERIA.includes((input.failedCriterion ?? "character_identity") as ReviewCriterionCode)) {
    throw new Error("failedCriterion 不在固定审片维度中。");
  }
  if (input.decision !== "pass" && input.decision !== "rework" && input.decision !== "reject") {
    throw new Error("decision 必须是 pass|rework|reject。");
  }
  if (input.decision !== "pass" && !input.failedCriterion) {
    throw new Error("rework/reject 必须指定 failedCriterion。");
  }
  const statePath = path.resolve(requiredText(input.statePath, "statePath"));
  const state = await readState(statePath);
  if (state.phase === "reviewed" && state.review) {
    const recordedFailed = state.review.review.criteria.find((criterion) => criterion.status === "fail")?.code;
    if (state.review.decision !== input.decision || state.review.review.note !== note
      || (input.decision === "pass" ? recordedFailed !== undefined : recordedFailed !== input.failedCriterion)) {
      throw new Error("P14 canary 已审片，拒绝用同一 run 改绑不同审片决策。");
    }
    return withCanaryEnvironment(state.registryPath, state.workspaceRoot, async () => {
      await activateStateProject(state);
      if (state.authorityReferences.mode === "real-user-assets") await verifyP14RealCanaryAuthorities(state);
      const control = await getStudioGenerationReviewControl(state.project.root, state.generationRunId);
      if (control.head?.fingerprint !== state.review!.review.fingerprint
        || control.status !== input.decision || control.head.reviewer !== "user") {
        throw new Error("P14 canary Review 幂等重试时发现 Head 漂移。");
      }
      return state;
    });
  }
  if (state.phase !== "writeback-pending-review" || !state.finalization) {
    throw new Error("P14 canary 尚未完成 raw/labeled 原子写回，不能审片。");
  }

  return withCanaryEnvironment(state.registryPath, state.workspaceRoot, async () => {
    await activateStateProject(state);
    if (state.authorityReferences.mode === "real-user-assets") await verifyP14RealCanaryAuthorities(state);
    const bundle = await readStudioGenerationResultBundle(state.project.root, state.generationRunId);
    if (!bundle || bundle.fingerprint !== state.finalization!.bundle.fingerprint || !bundle.pairComplete) {
      throw new Error("P14 canary Review 前结果对身份漂移。");
    }
    const control = await getStudioGenerationReviewControl(state.project.root, state.generationRunId);
    const failedCriterion = input.failedCriterion;
    const criteria = REVIEW_CRITERIA.map((code) => ({
      code,
      status: input.decision === "pass" || code !== failedCriterion ? "pass" as const : "fail" as const,
      note: input.decision === "pass"
        ? "用户已完成原尺寸 canary 审片并确认该项。"
        : code === failedCriterion ? note : "本项未观察到阻断。",
    }));
    const review = asRecord(await executeStudioCommand(state.project.root, "submit-user-review", {
      command: "submit_studio_generation_review",
      payload: {
        generationRunId: state.generationRunId,
        kind: control.headRevision === 0 ? "observation" : "correction",
        expectedHeadRevision: control.headRevision,
        ...(control.head ? { supersedesReviewId: control.head.reviewId } : {}),
        rawResultId: bundle.raw.resultId,
        rawSha256: bundle.raw.mediaSha256,
        labeledResultId: bundle.labeled.resultId,
        labeledSha256: bundle.labeled.mediaSha256,
        expectedPackFingerprint: state.pack.fingerprint,
        continuityFingerprint: state.continuityFingerprint,
        decision: input.decision,
        criteria,
        reviewer: "user",
        note,
      },
    }), "review result") as unknown as StudioGenerationReviewProjection;
    const current = await getStudioGenerationReviewControl(state.project.root, state.generationRunId);
    if (current.status !== input.decision || current.head?.reviewer !== "user") {
      throw new Error("P14 canary user Review 未成为当前 Head。");
    }
    const evidencePath = path.join(state.runRoot, "review-evidence.json");
    const reviewedAt = new Date().toISOString();
    const { fingerprint: _fingerprint, ...prior } = state;
    const next = await writeState(statePath, {
      ...prior,
      phase: "reviewed",
      updatedAt: reviewedAt,
      review: { decision: input.decision, review, evidencePath },
    });
    await writeJsonAtomic(evidencePath, seal({
      schemaVersion: 1,
      kind: "p14-real-canary-review-evidence",
      status: "PASS",
      createdAt: reviewedAt,
      statePath,
      project: state.project,
      generationRunId: state.generationRunId,
      decision: input.decision,
      reviewer: "user",
      reviewId: review.reviewId,
      reviewFingerprint: review.fingerprint,
      headRevision: current.headRevision,
      currentStatus: current.status,
      approvedRawEligible: current.head?.approvedRawEligible ?? false,
      criteria,
      note,
    }));
    return next;
  });
}

function usage(): string {
  return [
    "P14 真实单图 canary 本地编排（本脚本不调用生图）",
    "",
    "prepare  --character-reference <absolute-image> --scene-reference <absolute-image> --prop-reference <absolute-image> [--output-root <dir>] [--run-name <safe-name>]",
    "finalize --state <canary-state.json> --raw-path <absolute.png> --raw-sha256 <sha> --call-id <id> --model <name> [--generated-at <ISO>] [--execution-source codex-imagegen|fixture-canary]",
    "review   --state <canary-state.json> --decision pass|rework|reject --note <text> --confirmed-by-user [--failed-criterion <code>]",
  ].join("\n");
}

async function main(argv: string[]): Promise<void> {
  const mode = argv[0];
  if (mode !== "prepare" && mode !== "finalize" && mode !== "review") throw new Error(usage());
  const { values } = parseArgs({
    args: argv.slice(1),
    strict: true,
    allowPositionals: false,
    options: {
      "output-root": { type: "string" },
      "run-name": { type: "string" },
      "character-reference": { type: "string" },
      "scene-reference": { type: "string" },
      "prop-reference": { type: "string" },
      state: { type: "string" },
      "raw-path": { type: "string" },
      "raw-sha256": { type: "string" },
      "call-id": { type: "string" },
      model: { type: "string" },
      "generated-at": { type: "string" },
      "execution-source": { type: "string" },
      decision: { type: "string" },
      note: { type: "string" },
      "confirmed-by-user": { type: "boolean", default: false },
      "failed-criterion": { type: "string" },
    },
  });
  let state: P14CanaryState;
  if (mode === "prepare") {
    state = await prepareP14RealCanary({
      outputRoot: values["output-root"],
      runName: values["run-name"],
      authorityReferences: {
        characterAhangPath: requiredText(values["character-reference"], "--character-reference"),
        sceneStoneRoomPath: requiredText(values["scene-reference"], "--scene-reference"),
        completeGoldenMaskPath: requiredText(values["prop-reference"], "--prop-reference"),
      },
    });
  } else if (mode === "finalize") {
    const source = values["execution-source"];
    if (source !== undefined && source !== "codex-imagegen" && source !== "fixture-canary") {
      throw new Error("execution-source 必须是 codex-imagegen|fixture-canary。");
    }
    state = await finalizeP14RealCanary({
      statePath: requiredText(values.state, "--state"),
      rawPath: requiredText(values["raw-path"], "--raw-path"),
      rawSha256: requiredText(values["raw-sha256"], "--raw-sha256"),
      callId: requiredText(values["call-id"], "--call-id"),
      model: requiredText(values.model, "--model"),
      generatedAt: values["generated-at"],
      executionSource: source,
    });
  } else {
    const decision = values.decision;
    if (decision !== "pass" && decision !== "rework" && decision !== "reject") {
      throw new Error("--decision 必须是 pass|rework|reject。");
    }
    const failed = values["failed-criterion"];
    if (failed !== undefined && !REVIEW_CRITERIA.includes(failed as ReviewCriterionCode)) {
      throw new Error(`--failed-criterion 必须是：${REVIEW_CRITERIA.join(", ")}`);
    }
    state = await reviewP14RealCanary({
      statePath: requiredText(values.state, "--state"),
      decision,
      note: requiredText(values.note, "--note"),
      confirmedByUser: values["confirmed-by-user"] ?? false,
      failedCriterion: failed as ReviewCriterionCode | undefined,
    });
  }
  process.stdout.write(`${JSON.stringify({
    status: "ok",
    mode,
    phase: state.phase,
    statePath: path.join(state.runRoot, STATE_FILENAME),
    projectRoot: state.project.root,
    requestEnvelopePath: state.requestEnvelopePath,
    prepareEvidencePath: state.prepareEvidencePath,
    finalizeEvidencePath: state.finalization?.evidencePath,
    reviewEvidencePath: state.review?.evidencePath,
    imagegenInvokedByOrchestrator: false,
  }, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
