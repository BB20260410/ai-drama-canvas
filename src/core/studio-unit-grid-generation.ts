import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  getStudioMedia as getStudioMediaUncached,
  initializeMaterialStudio,
  verifyStudioMediaObject as verifyStudioMediaObjectUncached,
} from "./material-studio.js";
import {
  inspectManagedProject,
  inspectManagedProjectReadOnly,
} from "./managed-project.js";
import {
  StudioGenerationFreezeError,
  assertStudioGenerationFreezePackCurrent,
  buildStudioGenerationFreezePackForUnitGridReadEpoch,
  type StudioCodexControlReference,
  type StudioFrozenAssetReference,
  type StudioGenerationFreezeErrorCode,
  type StudioGenerationFreezePack,
  type StudioGenerationPanelInstruction,
  type StudioReferenceUsage,
} from "./studio-generation.js";
import {
  getStudioProductionContractProfile,
  getStudioProductionUnitSnapshot,
  initializeStudioProduction,
  listStudioProductionUnits,
  type StudioProductionContractProfile,
  type StudioProductionUnitSnapshot,
} from "./studio-production.js";
import {
  buildNextShotContinuitySnapshot,
  nextShotContinuityContinuationGaps,
  type NextShotContinuitySnapshot,
} from "./studio-next-shot-continuity.js";
import {
  clearStudioRequestSchemaCache,
  withFreshStudioRequestSchemaCache,
  withStudioRequestSchemaCache,
} from "./studio-request-schema-cache.js";
import {
  StudioUnitGridReadEpochDriftError,
  memoStudioUnitGridRead,
  verifyStudioUnitGridMediaOnce,
  withFreshStudioUnitGridReadEpoch,
  withStudioUnitGridReadEpoch,
} from "./studio-unit-grid-read-epoch.js";

/** P30：一个生产单元、一次模型调用、一张 2–6 格整板图。 */
export interface StudioUnitGridGenerationQueryInput {
  targetKind: "unit-grid";
  unitId: string;
  /**
   * @deprecated v2 起，sequence > 1 默认且强制冻结上一单元 actual-tail。
   * 保留该字段只为旧调用方源码兼容；它不再关闭或开启连续性门禁。
   */
  includePreviousUnitApprovedRaw?: true;
  /** 公开调用只能引用已在 generation ledger 追加的用户授权 receipt。 */
  continuationWaiver?: StudioUnitGridContinuationWaiverReference;
  /**
   * 仅供受管历史导入适配器使用；公开命令 schema 不接受该字段。
   * 它与用户授权 receipt 分型，不能被普通生产调用泛化复用。
   */
  verifiedHistoricalImportContinuationWaiver?: StudioUnitGridContinuationWaiverReference;
}

export interface StudioUnitGridContinuationWaiverReference {
  receiptId: string;
  receiptFingerprint: string;
}

export interface StudioUnitGridGenerationTarget {
  targetKind: "unit-grid";
  targetId: string;
  unitId: string;
  seasonId: string;
  episodeId: string;
  unitSequence: number;
  unitRevision: number;
  panelCount: number;
  durationSeconds: number;
  episodeAbsoluteStartSeconds: number;
  episodeAbsoluteEndSeconds: number;
}

export interface StudioUnitGridReferencePolicy {
  profileId: string;
  persisted: boolean;
  minControlReferences: number;
  maxControlReferences: number;
  sourceFingerprint?: string;
  fingerprint: string;
}

export interface StudioUnitGridControlReference {
  referenceId: string;
  mediaSha256: string;
  localPath: string;
  coveredAssetIds: string[];
  categories: string[];
  roles: string[];
  referenceUsages?: Array<{
    assetId: string;
    usage: StudioReferenceUsage;
  }>;
  fingerprint: string;
}

export interface StudioUnitGridContinuationSourceSnapshotV1 {
  schemaVersion: 1;
  kind: "studio-unit-grid-continuation-source";
  referenceId: string;
  referenceRole: "continuation_source";
  purpose: "continuity";
  sourceUnitId: string;
  sourceUnitSequence: number;
  sourceUnitRevision: number;
  sourceEpisodeEndSeconds: number;
  authorityKind: "generation-run-pass" | "verified-historical-pass";
  generationRunId?: string;
  reviewId?: string;
  reviewFingerprint?: string;
  rawResultId?: string;
  historicalImportId?: string;
  sourcePackId: string;
  sourcePackFingerprint: string;
  mediaSha256: string;
  labeledMediaSha256: string;
  coveredAssetIds: string[];
  fingerprint: string;
}

export interface StudioUnitGridObservedActualState {
  /** 只有 Observation 明确标为 observed 的字段才允许出现。 */
  costume?: string;
  injury?: string;
  heldObject?: string;
  position?: string;
  facing?: string;
  emotion?: string;
  layout?: string;
  lighting?: string;
  motionVector?: string;
  cameraPhase?: string;
  focusState?: string;
  audioPhase?: string;
}

/**
 * v2 连续来源以已验收的 actual-tail 证据作为模型控制图。
 * 整张 raw 只保留为 Review/构图/身份权威闭包，绝不再冒充实际尾帧。
 */
export interface StudioUnitGridContinuationSourceSnapshotV2 {
  schemaVersion: 2;
  kind: "studio-unit-grid-continuation-source";
  projectId: string;
  referenceId: string;
  referenceRole: "continuation_source";
  purpose: "continuity";
  sourceUnitId: string;
  sourceUnitSequence: number;
  sourceUnitRevision: number;
  sourceEpisodeEndSeconds: number;
  authorityKind: "generation-run-pass-observation";
  generationRunId: string;
  reviewId: string;
  reviewFingerprint: string;
  observationId: string;
  observationRevision: number;
  observationFingerprint: string;
  observationControlFingerprint: string;
  observationEvidenceContractVersion: 3;
  evidenceKind: "terminal-panel-crop";
  evidenceSha256: string;
  terminalPanelId: string;
  evidenceLineage: {
    kind: "studio-video-package-terminal-crop";
    intentId: string;
    intentFingerprint: string;
    receiptId: string;
    receiptFingerprint: string;
    manifestSha256: string;
    manifestFingerprint: string;
    filePath: string;
    fileSha256: string;
  };
  sourcePackId: string;
  sourcePackFingerprint: string;
  authorityRawResultId: string;
  authorityRawMediaSha256: string;
  authorityLabeledResultId: string;
  authorityLabeledMediaSha256: string;
  actualState: StudioUnitGridObservedActualState;
  coveredAssetIds: string[];
  fingerprint: string;
}

/**
 * v3 把 Post-result Observation v4 的逐实体连续性快照一并冻结。
 * v2 历史包保持可读；新冻结必须建立 v3，避免只传一组扁平文本而丢失
 * 角色/道具/场景/VFX 的来源粒度。
 */
export interface StudioUnitGridContinuationSourceSnapshotV3
  extends Omit<
    StudioUnitGridContinuationSourceSnapshotV2,
    "schemaVersion" | "observationEvidenceContractVersion"
  > {
  schemaVersion: 3;
  observationEvidenceContractVersion: 4;
  continuitySnapshot: NextShotContinuitySnapshot;
}

export type StudioUnitGridActualTailContinuationSourceSnapshot =
  | StudioUnitGridContinuationSourceSnapshotV2
  | StudioUnitGridContinuationSourceSnapshotV3;

export type StudioUnitGridContinuationSourceSnapshot =
  | StudioUnitGridContinuationSourceSnapshotV1
  | StudioUnitGridActualTailContinuationSourceSnapshot;

export interface StudioUnitGridContinuationWaiverSnapshot {
  schemaVersion: 2;
  kind: "studio-unit-grid-continuation-waiver";
  authorityKind: "user-authorization" | "verified-historical-import";
  receiptId: string;
  projectId: string;
  currentUnitId: string;
  currentUnitRevision: number;
  currentUnitFingerprint: string;
  previousUnitId: string;
  previousUnitRevision: number;
  previousUnitFingerprint: string;
  authorizationEvidenceReference: string;
  authorizationTextSha256: string;
  reason: string;
  acknowledgePreviousActualTailUnavailable: true;
  acknowledgeCanonicalRestartMayBreakContinuity: true;
  acknowledgeIdentityAndSceneLocksRemainMandatory: true;
  activeContext?: {
    manifestFingerprint: string;
    contextTokenHash: string;
    buildId: string;
    sourceDigest: string;
  };
  sourceManifestFingerprint?: string;
  fingerprint: string;
}

export interface StudioUnitGridPanelFreeze {
  order: number;
  panelId: string;
  panelIndex: number;
  startSeconds: number;
  endSeconds: number;
  durationSeconds: number;
  panelPackId: string;
  panelPackFingerprint: string;
  panelBindingScopeFingerprint: string;
  instruction: StudioGenerationPanelInstruction;
  /** 完整 v4 panel pack 是当前 Binding/continuity/reference closure 的不可变证据。 */
  panelPack: StudioGenerationFreezePack;
  fingerprint: string;
}

export interface StudioUnitGridCodexGenerationRequest {
  schemaVersion: 5;
  kind: "studio-codex-generation-request";
  provenance: "unit-grid-binding-sets";
  id: string;
  fingerprint: string;
  projectId: string;
  executorKind: "agent-imagegen";
  allowedProviders: readonly ["codex", "grok"];
  exactlyOneImage: true;
  maxCalls: 1;
  target: StudioUnitGridGenerationTarget;
  continuationPolicy?: "previous-unit-current-pass";
  continuationSource?: StudioUnitGridContinuationSourceSnapshot;
  continuationWaiver?: StudioUnitGridContinuationWaiverSnapshot;
  referencePolicy: StudioUnitGridReferencePolicy;
  panelPacks: Array<{
    order: number;
    panelId: string;
    panelIndex: number;
    packId: string;
    packFingerprint: string;
    bindingSetId: string;
    bindingSetFingerprint: string;
    continuityFingerprint: string;
    promptRevisionId: string;
    promptSha256: string;
  }>;
  modelPayload: {
    exactlyOneImage: true;
    layout: "9:16-vertical-ordered-grid";
    renderedPrompt: string;
    target: StudioUnitGridGenerationTarget;
    referenceUsages?: Array<{
      referenceId: string;
      assetId: string;
      usage: StudioReferenceUsage;
    }>;
    panels: Array<{
      order: number;
      panelId: string;
      startSeconds: number;
      endSeconds: number;
      instruction: StudioGenerationPanelInstruction;
      promptRevisionId: string;
      promptSha256: string;
    }>;
  };
  controlReferences: StudioUnitGridControlReference[];
  forbidden: readonly [
    "titles",
    "panel-numbers",
    "durations",
    "dialogue-text",
    "subtitles",
    "watermarks",
    "ui",
    "pseudo-text",
  ];
}

export interface StudioUnitGridGenerationFreezePack {
  schemaVersion: 5;
  kind: "studio-generation-freeze-pack";
  provenance: "unit-grid-binding-sets";
  id: string;
  fingerprint: string;
  projectId: string;
  managedManifestFingerprint: string;
  unitSnapshotFingerprint: string;
  /** 全单元逐格 continuity closure 的内容指纹，供 Review/Checkpoint 对账。 */
  continuityFingerprint: string;
  target: StudioUnitGridGenerationTarget;
  continuationPolicy?: "previous-unit-current-pass";
  continuationSource?: StudioUnitGridContinuationSourceSnapshot;
  continuationWaiver?: StudioUnitGridContinuationWaiverSnapshot;
  referencePolicy: StudioUnitGridReferencePolicy;
  panels: StudioUnitGridPanelFreeze[];
  controlReferences: StudioUnitGridControlReference[];
  request: StudioUnitGridCodexGenerationRequest;
}

export interface StudioUnitGridGenerationReadyResult {
  status: "ready";
  packId: string;
  fingerprint: string;
  pack: StudioUnitGridGenerationFreezePack;
  request: StudioUnitGridCodexGenerationRequest;
}

export interface StudioUnitGridGenerationBlockedResult {
  status: "blocked";
  code: StudioGenerationFreezeErrorCode;
  message: string;
  details: string[];
}

export type StudioUnitGridGenerationQueryResult =
  | StudioUnitGridGenerationReadyResult
  | StudioUnitGridGenerationBlockedResult;

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([key, entry]) => [key, stableValue(entry)]));
}

function stableDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stableValue(value)), "utf8").digest("hex");
}

async function inspectStudioUnitGridManagedProject(
  projectRoot: string,
): Promise<Awaited<ReturnType<typeof inspectManagedProject>>> {
  try {
    return await inspectManagedProjectReadOnly(projectRoot);
  } catch (error) {
    throw new StudioGenerationFreezeError(
      "unmanaged-project",
      "unit-grid 冻结包只允许读取通过验证的受管项目。",
      [],
      { cause: error },
    );
  }
}

async function assertStudioUnitGridPreflightFootprint(projectRoot: string): Promise<void> {
  const databaseRoot = path.join(projectRoot, ".aicanvas");
  const material = path.join(databaseRoot, "material-studio.sqlite");
  const production = path.join(databaseRoot, "studio-production.sqlite");
  const generation = path.join(databaseRoot, "studio-generation-ledger.sqlite");
  const generationTemporary = path.join(
    databaseRoot,
    "studio-generation",
    "objects",
    ".tmp",
  );
  const required = [
    [material, "file"],
    [production, "file"],
    [generation, "file"],
    [generationTemporary, "directory"],
  ] as const;
  for (const [target, kind] of required) {
    const metadata = await lstat(target).catch(() => null);
    const valid = metadata
      && !metadata.isSymbolicLink()
      && (kind === "file" ? metadata.isFile() : metadata.isDirectory());
    if (!valid) {
      throw new StudioGenerationFreezeError(
        "storage-invalid",
        `unit-grid owner preflight 缺少安全的 ${kind === "file" ? "数据库" : "临时目录"}足迹。`,
      );
    }
  }

  const markerChecks = [
    [material, "SELECT value FROM studio_meta WHERE key = 'schema_version'", "material"],
    [production, "SELECT value FROM studio_production_meta WHERE key = 'schema_version'", "production"],
    [generation, "SELECT value FROM studio_generation_ledger_meta WHERE key = 'schema_version'", "generation"],
    [
      generation,
      "SELECT value FROM studio_generation_ledger_meta WHERE key = 'studio_continuity_schema_version'",
      "continuity",
    ],
  ] as const;
  for (const [databasePath, sql, owner] of markerChecks) {
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(databasePath, { readOnly: true });
      const marker = db.prepare(sql).get() as { value?: string } | undefined;
      if (!marker?.value) {
        if (owner === "continuity") {
          const existing = db.prepare(
            "SELECT name FROM sqlite_master WHERE name GLOB 'studio_continuity_*' LIMIT 1",
          ).get() as { name?: string } | undefined;
          // 一个从未启用 continuity owner 的受管工程允许在 identity barrier
          // 之前由既有 initializer 建立首次 schema；若已经出现任何 continuity
          // 对象却丢失 marker，则仍按损坏失败关闭，禁止静默修复。
          if (!existing?.name) continue;
        }
        throw new Error("marker-missing");
      }
    } catch (error) {
      throw new StudioGenerationFreezeError(
        "storage-invalid",
        `unit-grid ${owner} owner schema marker 缺失或不可读，拒绝隐式修复。`,
        [],
        { cause: error },
      );
    } finally {
      db?.close();
    }
  }
}

async function preflightStudioUnitGridOwners(
  projectRoot: string,
): Promise<Awaited<ReturnType<typeof inspectManagedProject>>> {
  const shell = await inspectStudioUnitGridManagedProject(projectRoot);
  await assertStudioUnitGridPreflightFootprint(shell.paths.root);
  try {
    await initializeMaterialStudio(shell.paths.root);
    await initializeStudioProduction(shell.paths.root);
    const generation = await import("./studio-generation-ledger.js");
    await generation.initializeStudioGenerationLedger(shell.paths.root);
    const continuity = await import("./studio-continuity-ledger.js");
    await continuity.initializeStudioContinuityLedger(shell.paths.root);
  } catch (error) {
    if (error instanceof StudioGenerationFreezeError) throw error;
    throw new StudioGenerationFreezeError(
      "storage-invalid",
      "unit-grid owner preflight 未通过，拒绝进入只读 epoch。",
      [],
      { cause: error },
    );
  }
  return shell;
}

function readStudioMedia(
  projectRoot: string,
  mediaSha256: string,
): ReturnType<typeof getStudioMediaUncached> {
  return memoStudioUnitGridRead(
    projectRoot,
    `material:media:${mediaSha256}`,
    () => getStudioMediaUncached(projectRoot, mediaSha256),
  );
}

function verifyStudioMedia(
  projectRoot: string,
  mediaSha256: string,
  objectPath: string,
): Promise<boolean> {
  return verifyStudioUnitGridMediaOnce(
    projectRoot,
    mediaSha256,
    objectPath,
    () => verifyStudioMediaObjectUncached(projectRoot, mediaSha256),
  );
}

function readStudioProductionUnitSnapshot(
  projectRoot: string,
  unitId: string,
): ReturnType<typeof getStudioProductionUnitSnapshot> {
  return memoStudioUnitGridRead(
    projectRoot,
    `production:unit-snapshot:${unitId}`,
    () => getStudioProductionUnitSnapshot(projectRoot, unitId),
  );
}

function readStudioProductionContractProfile(
  projectRoot: string,
  input: { season: string; episode: string },
): ReturnType<typeof getStudioProductionContractProfile> {
  return memoStudioUnitGridRead(
    projectRoot,
    `production:contract-profile:${stableDigest(input)}`,
    () => getStudioProductionContractProfile(projectRoot, input),
  );
}

function fail(code: StudioGenerationFreezeErrorCode, message: string, details: string[] = []): never {
  throw new StudioGenerationFreezeError(code, message, details);
}

function requiredId(value: string, field: string): string {
  if (typeof value !== "string" || !value.trim()) fail("panel-asset-invalid", `${field} 不能为空。`);
  return value.trim();
}

function assertContinuationWaiverIntegrity(
  waiver: StudioUnitGridContinuationWaiverSnapshot,
): void {
  const { fingerprint, receiptId, ...semantic } = waiver;
  const activeContextValid = waiver.authorityKind === "user-authorization"
    && waiver.activeContext !== undefined
    && waiver.sourceManifestFingerprint === undefined;
  const historicalContextValid = waiver.authorityKind === "verified-historical-import"
    && waiver.activeContext === undefined
    && typeof waiver.sourceManifestFingerprint === "string"
    && /^[a-f0-9]{64}$/u.test(waiver.sourceManifestFingerprint);
  if (waiver.schemaVersion !== 2
    || waiver.kind !== "studio-unit-grid-continuation-waiver"
    || receiptId !== `studio-continuation-waiver-${fingerprint.slice(0, 40)}`
    || !waiver.projectId.trim()
    || !waiver.currentUnitId.trim()
    || !Number.isSafeInteger(waiver.currentUnitRevision)
    || waiver.currentUnitRevision < 1
    || !/^[a-f0-9]{64}$/u.test(waiver.currentUnitFingerprint)
    || !waiver.previousUnitId.trim()
    || !Number.isSafeInteger(waiver.previousUnitRevision)
    || waiver.previousUnitRevision < 1
    || !/^[a-f0-9]{64}$/u.test(waiver.previousUnitFingerprint)
    || !waiver.authorizationEvidenceReference.trim()
    || !/^[a-f0-9]{64}$/u.test(waiver.authorizationTextSha256)
    || !waiver.reason.trim()
    || waiver.acknowledgePreviousActualTailUnavailable !== true
    || waiver.acknowledgeCanonicalRestartMayBreakContinuity !== true
    || waiver.acknowledgeIdentityAndSceneLocksRemainMandatory !== true
    || (!activeContextValid && !historicalContextValid)
    || fingerprint !== stableDigest(semantic)) {
    fail("previous-raw-invalid", "上一单元 actual-tail 豁免内容地址无效。");
  }
}

function referencePolicy(profile: StudioProductionContractProfile | null): StudioUnitGridReferencePolicy {
  const semantic = profile
    ? {
        profileId: profile.profileId,
        persisted: true,
        minControlReferences: profile.minControlReferences,
        maxControlReferences: profile.maxControlReferences,
        sourceFingerprint: profile.sourceFingerprint,
      }
    : {
        profileId: "studio-generic-unit-grid-v1",
        persisted: false,
        minControlReferences: 0,
        maxControlReferences: 6,
      };
  return { ...semantic, fingerprint: stableDigest(semantic) };
}

function mergeControlReferences(panelPacks: StudioGenerationFreezePack[]): StudioUnitGridControlReference[] {
  const byMedia = new Map<string, {
    localPath: string;
    assetIds: Set<string>;
    categories: Set<string>;
    roles: Set<string>;
    referenceUsages: Map<string, StudioReferenceUsage>;
  }>();
  const mediaByAsset = new Map<string, string>();
  for (const pack of panelPacks) {
    for (const reference of pack.request.controlReferences as StudioCodexControlReference[]) {
      const previousMedia = mediaByAsset.get(reference.assetId);
      if (previousMedia && previousMedia !== reference.mediaSha256) {
        fail(
          "asset-binding-drift",
          `unit-grid 资产 ${reference.assetId} 在不同宫格冻结到不同媒体版本。`,
          [previousMedia, reference.mediaSha256],
        );
      }
      mediaByAsset.set(reference.assetId, reference.mediaSha256);
      const entry = byMedia.get(reference.mediaSha256) ?? {
        localPath: reference.localPath,
        assetIds: new Set<string>(),
        categories: new Set<string>(),
        roles: new Set<string>(),
        referenceUsages: new Map<string, StudioReferenceUsage>(),
      };
      if (entry.localPath !== reference.localPath) {
        fail("media-drift", `同一控制参考 SHA 指向不同 CAS 路径：${reference.mediaSha256}`);
      }
      entry.assetIds.add(reference.assetId);
      entry.categories.add(reference.category);
      entry.roles.add(reference.role);
      const usage = reference.referenceUsage ?? {
        purpose: "identity" as const,
        inheritOnly: ["all"],
        excludeFromOutput: [],
        carrierPolicy: "none" as const,
      };
      const previousUsage = entry.referenceUsages.get(reference.assetId);
      if (previousUsage && stableDigest(previousUsage) !== stableDigest(usage)) {
        fail("asset-binding-drift", `unit-grid 资产 ${reference.assetId} 在不同宫格冻结到不同 referenceUsage。`);
      }
      entry.referenceUsages.set(reference.assetId, structuredClone(usage));
      byMedia.set(reference.mediaSha256, entry);
    }
  }
  return [...byMedia.entries()]
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([mediaSha256, entry]) => {
      const semantic = {
        referenceId: `unit-grid-reference-${mediaSha256.slice(0, 32)}`,
        mediaSha256,
        localPath: entry.localPath,
        coveredAssetIds: [...entry.assetIds].sort((a, b) => a.localeCompare(b, "en")),
        categories: [...entry.categories].sort((a, b) => a.localeCompare(b, "en")),
        roles: [...entry.roles].sort((a, b) => a.localeCompare(b, "en")),
        referenceUsages: [...entry.referenceUsages.entries()]
          .sort(([left], [right]) => left.localeCompare(right, "en"))
          .map(([assetId, usage]) => ({ assetId, usage })),
      };
      return { ...semantic, fingerprint: stableDigest(semantic) };
    });
}

const UNIT_GRID_MAX_TOTAL_REFERENCE_IMAGES = 6;

async function listEpisodeUnitSnapshots(
  projectRoot: string,
  current: StudioProductionUnitSnapshot,
): Promise<StudioProductionUnitSnapshot[]> {
  const summaries: Awaited<ReturnType<typeof listStudioProductionUnits>>["items"] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 50; page += 1) {
    const query = {
      season: current.unit.season,
      episode: current.unit.episode,
      limit: 100,
      ...(cursor ? { cursor } : {}),
    };
    const batch = await memoStudioUnitGridRead(
      projectRoot,
      `production:episode-units:${stableDigest(query)}`,
      () => listStudioProductionUnits(projectRoot, query),
    );
    summaries.push(...batch.items);
    if (!batch.nextCursor) break;
    cursor = batch.nextCursor;
  }
  const snapshots = await Promise.all(
    summaries.map((unit) => readStudioProductionUnitSnapshot(projectRoot, unit.id)),
  );
  return snapshots.filter((unit): unit is StudioProductionUnitSnapshot => Boolean(unit));
}

function unitGridAssetIds(panelPacks: StudioGenerationFreezePack[]): Set<string> {
  return new Set(panelPacks.flatMap((pack) => pack.assets.map((asset) => asset.assetId)));
}

function assertContinuationSourceIntegrity(source: StudioUnitGridContinuationSourceSnapshot): void {
  if (source.schemaVersion === 2 || source.schemaVersion === 3) {
    const { fingerprint, ...semantic } = source;
    const shaFields = [
      source.reviewFingerprint,
      source.observationFingerprint,
      source.observationControlFingerprint,
      source.evidenceSha256,
      source.evidenceLineage.intentFingerprint,
      source.evidenceLineage.receiptFingerprint,
      source.evidenceLineage.manifestSha256,
      source.evidenceLineage.manifestFingerprint,
      source.evidenceLineage.fileSha256,
      source.sourcePackFingerprint,
      source.authorityRawMediaSha256,
      source.authorityLabeledMediaSha256,
    ];
    const allowedActualFields = new Set<keyof StudioUnitGridObservedActualState>([
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
    ]);
    const actualKeys = Object.keys(source.actualState) as Array<keyof StudioUnitGridObservedActualState>;
    let structuredSnapshotValid = source.schemaVersion === 2;
    if (source.schemaVersion === 3) {
      try {
        // Pack CAS 会稳定排序 JSON 对象键；NextShot v2 的历史指纹算法仍受
        // 嵌套对象插入顺序影响。这里按 Observation v4 的规范字段顺序重建，
        // 不能把 CAS 解析后的字母序对象直接 spread 给旧指纹算法。
        const characters = source.continuitySnapshot.characters.map((entry) => ({
          assetId: entry.assetId,
          ...(entry.costumeState === undefined ? {} : { costumeState: entry.costumeState }),
          position: entry.position,
          facing: entry.facing,
          gazeDirection: entry.gazeDirection,
          actionEndPose: entry.actionEndPose,
          ...(entry.nextActionStart === undefined ? {} : { nextActionStart: entry.nextActionStart }),
          expression: entry.expression,
          ...(entry.injuryState === undefined ? {} : { injuryState: entry.injuryState }),
        }));
        const props = source.continuitySnapshot.props.map((entry) => ({
          assetId: entry.assetId,
          heldBy: entry.heldBy,
          ...(entry.position === undefined ? {} : { position: entry.position }),
          physicalState: entry.physicalState,
        }));
        const scene = {
          layout: source.continuitySnapshot.scene.layout,
          axisLine: source.continuitySnapshot.scene.axisLine,
          ...(source.continuitySnapshot.scene.screenDirection === undefined
            ? {}
            : { screenDirection: source.continuitySnapshot.scene.screenDirection }),
          entryExits: source.continuitySnapshot.scene.entryExits,
          lighting: source.continuitySnapshot.scene.lighting,
          timeOfDay: source.continuitySnapshot.scene.timeOfDay,
          ...(source.continuitySnapshot.scene.weather === undefined
            ? {}
            : { weather: source.continuitySnapshot.scene.weather }),
          ...(source.continuitySnapshot.scene.cutExit === undefined
            ? {}
            : { cutExit: source.continuitySnapshot.scene.cutExit }),
        };
        const vfx = source.continuitySnapshot.vfx.map((entry) => ({
          vfxId: entry.vfxId,
          description: entry.description,
          intensity: entry.intensity,
          continuesToNext: entry.continuesToNext,
        }));
        const rebuilt = buildNextShotContinuitySnapshot({
          sourceUnitId: source.continuitySnapshot.sourceUnitId,
          sourcePanelId: source.continuitySnapshot.sourcePanelId,
          sourceRawSha256: source.continuitySnapshot.sourceRawSha256,
          characters,
          props,
          scene,
          vfx,
          referenceSha256List: source.continuitySnapshot.referenceSha256List,
        });
        structuredSnapshotValid = rebuilt.continuityFingerprint
            === source.continuitySnapshot.continuityFingerprint
          && source.continuitySnapshot.sourceUnitId === source.sourceUnitId
          && source.continuitySnapshot.sourcePanelId === source.terminalPanelId
          && source.continuitySnapshot.sourceRawSha256 === source.authorityRawMediaSha256
          && nextShotContinuityContinuationGaps(source.continuitySnapshot).length === 0;
      } catch {
        structuredSnapshotValid = false;
      }
    }
    if (source.kind !== "studio-unit-grid-continuation-source"
      || source.referenceRole !== "continuation_source"
      || source.purpose !== "continuity"
      || source.authorityKind !== "generation-run-pass-observation"
      || source.observationEvidenceContractVersion !== source.schemaVersion + 1
      || !structuredSnapshotValid
      || fingerprint !== stableDigest(semantic)
      || shaFields.some((sha256) => !/^[a-f0-9]{64}$/u.test(sha256))
      || source.authorityRawMediaSha256 === source.evidenceSha256
      || !source.projectId.trim()
      || !source.referenceId.trim()
      || !source.sourceUnitId.trim()
      || !source.generationRunId.trim()
      || !source.reviewId.trim()
      || !source.observationId.trim()
      || source.evidenceKind !== "terminal-panel-crop"
      || !source.terminalPanelId.trim()
      || source.evidenceLineage.kind !== "studio-video-package-terminal-crop"
      || !source.evidenceLineage.intentId.trim()
      || !source.evidenceLineage.receiptId.trim()
      || !source.evidenceLineage.filePath.trim()
      || source.evidenceLineage.fileSha256 !== source.evidenceSha256
      || !source.sourcePackId.trim()
      || !source.authorityRawResultId.trim()
      || !source.authorityLabeledResultId.trim()
      || !Number.isSafeInteger(source.observationRevision)
      || source.observationRevision < 1
      || !Number.isSafeInteger(source.sourceUnitSequence)
      || source.sourceUnitSequence < 1
      || !Number.isSafeInteger(source.sourceUnitRevision)
      || source.sourceUnitRevision < 1
      || !Number.isFinite(source.sourceEpisodeEndSeconds)
      || actualKeys.length === 0
      || actualKeys.some((field) => !allowedActualFields.has(field))
      || actualKeys.some((field) => !source.actualState[field]?.trim())
      || new Set(source.coveredAssetIds).size !== source.coveredAssetIds.length
      || source.coveredAssetIds.some((assetId) => !assetId.trim())) {
      fail("previous-raw-invalid", `上一单元 actual-tail 连续来源 ${source.referenceId} 内容地址无效。`);
    }
    return;
  }
  const { fingerprint, ...semantic } = source;
  const shaFields = [
    source.sourcePackFingerprint,
    source.mediaSha256,
    source.labeledMediaSha256,
    ...(source.reviewFingerprint ? [source.reviewFingerprint] : []),
  ];
  if (source.schemaVersion !== 1
    || source.kind !== "studio-unit-grid-continuation-source"
    || source.referenceRole !== "continuation_source"
    || source.purpose !== "continuity"
    || fingerprint !== stableDigest(semantic)
    || shaFields.some((sha256) => !/^[a-f0-9]{64}$/u.test(sha256))
    || source.coveredAssetIds.length === 0
    || new Set(source.coveredAssetIds).size !== source.coveredAssetIds.length
    || (source.authorityKind === "generation-run-pass"
      && (!source.generationRunId || !source.reviewId || !source.reviewFingerprint || !source.rawResultId))
    || (source.authorityKind === "verified-historical-pass" && !source.historicalImportId)) {
    fail("previous-raw-invalid", `上一单元连续来源 ${source.referenceId} 内容地址无效。`);
  }
}

async function freezePreviousUnitContinuationSource(
  projectRoot: string,
  projectId: string,
  current: StudioProductionUnitSnapshot,
  currentPanelPacks: StudioGenerationFreezePack[],
): Promise<{
  source: StudioUnitGridContinuationSourceSnapshot;
  controlReference: StudioUnitGridControlReference;
} | undefined> {
  if (current.unit.sequence <= 1) return undefined;
  const episodeUnits = await listEpisodeUnitSnapshots(projectRoot, current);
  const previous = episodeUnits.find((unit) => unit.unit.sequence === current.unit.sequence - 1);
  if (!previous) {
    fail(
      "previous-raw-invalid",
      `当前单元 ${current.unit.id} 是第 ${current.unit.sequence} 单元，但缺少上一单元快照；必须补齐时间线或提交显式豁免。`,
    );
  }
  if (previous.unit.season !== current.unit.season
    || previous.unit.episode !== current.unit.episode
    || previous.unit.episodeEndSeconds !== current.unit.episodeStartSeconds) {
    fail(
      "previous-panel-not-adjacent",
      `上一单元 ${previous.unit.id} 与当前单元 ${current.unit.id} 不是同季同集紧邻时码。`,
    );
  }

  const ledger = await import("./studio-generation-ledger.js");
  const latest = (await ledger.listStudioGenerationLatestUnitGridRuns(projectRoot, [previous.unit.id]))[0];
  if (!latest?.latestRun?.terminal
    || !latest.latestRun.hasResultPair
    || latest.latestRun.reviewStatus !== "pass"
    || !latest.rawMediaSha256
    || !latest.labeledMediaSha256) {
    fail(
      "previous-review-invalid",
      `上一单元 ${previous.unit.id} 缺少 current PASS raw/labeled；sequence > 1 默认禁止无 actual-tail 冻结。`,
    );
  }
  const reviewModule = await import("./studio-generation-review.js");
  const review = await reviewModule.getStudioGenerationReviewControl(
    projectRoot,
    latest.latestRun.generationRunId,
  );
  if (!review.head || review.status !== "pass" || !review.head.current || !review.head.approvedRawEligible) {
    fail("previous-review-invalid", `上一单元 ${previous.unit.id} 的 PASS Review Head 不是 current。`);
  }
  const observationModule = await import("./studio-post-result-observation.js");
  const observation = await observationModule.getStudioPostResultObservationControl(
    projectRoot,
    latest.latestRun.generationRunId,
  );
  if (observation.status !== "current"
    || !observation.head
    || !observation.head.current
    || !observation.head.continuationEligible
    || observation.head.evidenceContractVersion !== 4
    || observation.head.evidenceKind !== "terminal-panel-crop"
    || !observation.head.evidenceSha256
    || !observation.head.terminalPanelId
    || !observation.head.evidenceLineage
    || !observation.head.continuitySnapshot) {
    fail(
      "previous-raw-invalid",
      `上一单元 ${previous.unit.id} 缺少 current 且 eligible 的实际末态观察。`,
      observation.blockers,
    );
  }
  const authority = {
    generationRunId: latest.latestRun.generationRunId,
    reviewId: review.head.reviewId,
    reviewFingerprint: review.head.fingerprint,
    rawResultId: review.head.rawResultId,
    labeledResultId: review.head.labeledResultId,
    packId: review.head.packId,
    packFingerprint: review.head.packFingerprint,
    rawSha256: review.head.rawSha256,
    labeledSha256: review.head.labeledSha256,
  };
  if (observation.generationRunId !== authority.generationRunId
    || observation.head.reviewId !== authority.reviewId
    || observation.head.reviewFingerprint !== authority.reviewFingerprint
    || observation.head.rawResultId !== authority.rawResultId
    || observation.head.rawSha256 !== authority.rawSha256
    || observation.head.labeledResultId !== authority.labeledResultId
    || observation.head.labeledSha256 !== authority.labeledSha256
    || observation.head.packId !== authority.packId
    || observation.head.packFingerprint !== authority.packFingerprint
    || observation.head.headRevision !== observation.headRevision) {
    fail("previous-raw-invalid", `上一单元 ${previous.unit.id} 的 Review/Observation 身份闭包不一致。`);
  }

  const sourcePack = await ledger.readStudioUnitGridGenerationFrozenPack(projectRoot, authority.packId);
  if (!sourcePack
    || sourcePack.fingerprint !== authority.packFingerprint
    || sourcePack.target.unitId !== previous.unit.id
    || sourcePack.target.unitRevision !== previous.unit.revision
    || sourcePack.target.seasonId !== current.unit.season
    || sourcePack.target.episodeId !== current.unit.episode
    || sourcePack.target.unitSequence + 1 !== current.unit.sequence
    || sourcePack.target.episodeAbsoluteEndSeconds !== current.unit.episodeStartSeconds) {
    fail("previous-raw-invalid", `上一单元 ${previous.unit.id} 的 unit-grid pack 与当前时间线不一致。`);
  }
  const [raw, labeled] = await Promise.all([
    ledger.readStudioGenerationResult(projectRoot, authority.rawResultId),
    ledger.readStudioGenerationResult(projectRoot, authority.labeledResultId),
  ]);
  if (!raw
    || !labeled
    || raw.generationRunId !== authority.generationRunId
    || labeled.generationRunId !== authority.generationRunId
    || raw.variant !== "raw"
    || labeled.variant !== "labeled"
    || raw.mediaSha256 !== authority.rawSha256
    || labeled.mediaSha256 !== authority.labeledSha256
    || raw.packId !== authority.packId
    || labeled.packId !== authority.packId
    || raw.packFingerprint !== authority.packFingerprint
    || labeled.packFingerprint !== authority.packFingerprint
    || !raw.pairComplete
    || !labeled.pairComplete
    || !raw.promotionEligible
    || !labeled.promotionEligible) {
    fail("previous-raw-invalid", `上一单元 ${previous.unit.id} 的正式 raw 结果闭包无效。`);
  }

  const [rawMedia, evidenceMedia] = await Promise.all([
    readStudioMedia(projectRoot, authority.rawSha256),
    readStudioMedia(projectRoot, observation.head.evidenceSha256),
  ]);
  if (!rawMedia || rawMedia.kind !== "image" || rawMedia.derivativeStatus !== "ready"
    || !await verifyStudioMedia(projectRoot, authority.rawSha256, rawMedia.objectPath)) {
    fail("previous-raw-invalid", `上一单元 ${previous.unit.id} 的 raw 媒体 CAS/SHA 无效。`);
  }
  if (!evidenceMedia || evidenceMedia.kind !== "image" || evidenceMedia.derivativeStatus !== "ready"
    || !await verifyStudioMedia(
      projectRoot,
      observation.head.evidenceSha256,
      evidenceMedia.objectPath,
    )) {
    fail("previous-raw-invalid", `上一单元 ${previous.unit.id} 的 actual-tail 证据不是有效 image CAS。`);
  }
  const currentAssets = unitGridAssetIds(currentPanelPacks);
  const previousAssets = unitGridAssetIds(sourcePack.panels.map((panel) => panel.panelPack));
  const coveredAssetIds = [...currentAssets]
    .filter((assetId) => previousAssets.has(assetId))
    .sort((left, right) => left.localeCompare(right, "en"));
  const observed = observation.head.observedState;
  const observedFields = [
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
  ] as const satisfies readonly (keyof StudioUnitGridObservedActualState)[];
  const actualState = Object.fromEntries(observedFields
    .filter((field) => typeof observed[field] === "string" && observed[field]!.trim().length > 0)
    .map((field) => [field, observed[field]!])) as StudioUnitGridObservedActualState;
  if (Object.keys(actualState).length === 0) {
    fail("previous-raw-invalid", `上一单元 ${previous.unit.id} 的实际末态没有任何 observed 字段。`);
  }
  const referenceId = `unit-grid-actual-tail-${observation.head.evidenceSha256.slice(0, 32)}`;
  const sourceSemantic = {
    schemaVersion: 3 as const,
    kind: "studio-unit-grid-continuation-source" as const,
    projectId,
    referenceId,
    referenceRole: "continuation_source" as const,
    purpose: "continuity" as const,
    sourceUnitId: previous.unit.id,
    sourceUnitSequence: previous.unit.sequence,
    sourceUnitRevision: previous.unit.revision,
    sourceEpisodeEndSeconds: previous.unit.episodeEndSeconds,
    authorityKind: "generation-run-pass-observation" as const,
    generationRunId: authority.generationRunId,
    reviewId: authority.reviewId,
    reviewFingerprint: authority.reviewFingerprint,
    observationId: observation.head.observationId,
    observationRevision: observation.headRevision,
    observationFingerprint: observation.head.fingerprint,
    observationControlFingerprint: observation.fingerprint,
    observationEvidenceContractVersion: 4 as const,
    evidenceKind: observation.head.evidenceKind,
    evidenceSha256: observation.head.evidenceSha256,
    terminalPanelId: observation.head.terminalPanelId,
    evidenceLineage: observation.head.evidenceLineage,
    sourcePackId: authority.packId,
    sourcePackFingerprint: authority.packFingerprint,
    authorityRawResultId: authority.rawResultId,
    authorityRawMediaSha256: authority.rawSha256,
    authorityLabeledResultId: authority.labeledResultId,
    authorityLabeledMediaSha256: authority.labeledSha256,
    actualState,
    continuitySnapshot: observation.head.continuitySnapshot,
    coveredAssetIds,
  };
  const source: StudioUnitGridContinuationSourceSnapshotV3 = {
    ...sourceSemantic,
    fingerprint: stableDigest(sourceSemantic),
  };
  const referenceSemantic = {
    referenceId,
    mediaSha256: observation.head.evidenceSha256,
    localPath: evidenceMedia.objectPath,
    coveredAssetIds,
    categories: ["continuity"],
    roles: ["continuation_source"],
    referenceUsages: coveredAssetIds.map((assetId) => ({
      assetId,
      usage: {
        purpose: "continuity" as const,
        inheritOnly: ["上一镜实际尾态"],
        excludeFromOutput: ["旧剧情", "宫格边框"],
        carrierPolicy: "reference-only" as const,
      },
    })),
  };
  const controlReference: StudioUnitGridControlReference = {
    ...referenceSemantic,
    fingerprint: stableDigest(referenceSemantic),
  };
  assertContinuationSourceIntegrity(source);
  return { source, controlReference };
}

const MODEL_PROMPT_GOVERNANCE_LINE = /^当前单元没有冻结\s*BindingSet[；;].*禁止冻结或派发生成[。.]?$/u;
const SCREEN_DIRECTION_PATTERN = /(左上|右上|左下|右下|左侧|右侧|上方|下方|左|右|上|下)(?:朝|向|到|至|→|->)(左上|右上|左下|右下|左侧|右侧|上方|下方|左|右|上|下)/gu;

function modelVisualPromptBody(body: string): string {
  return body
    .split(/\r?\n/u)
    .filter((line) => !MODEL_PROMPT_GOVERNANCE_LINE.test(line.trim()))
    .join("\n")
    .trim();
}

function canonicalScreenDirection(value: string): string {
  if (value === "左侧") return "左";
  if (value === "右侧") return "右";
  if (value === "上方") return "上";
  if (value === "下方") return "下";
  return value;
}

function screenDirectionLocks(pack: StudioGenerationFreezePack, panelOrder: number): string[] {
  const source = [
    pack.panel.visualAction,
    pack.panel.shotComposition,
    ...pack.assets.flatMap((asset) => [
      asset.role,
      ...asset.definition.identityFeatures,
      ...asset.definition.positiveLocks,
    ]),
  ].join("\n");
  const pairs = new Map<string, { from: string; to: string }>();
  for (const match of source.matchAll(SCREEN_DIRECTION_PATTERN)) {
    const from = canonicalScreenDirection(match[1]!);
    const to = canonicalScreenDirection(match[2]!);
    if (from === to) continue;
    pairs.set(`${from}->${to}`, { from, to });
    if (pairs.size >= 2) break;
  }
  return [...pairs.values()].map(({ from, to }) =>
    `第${panelOrder}格屏幕方向硬锁：可见运动从画面${from}指向画面${to}，运动前端/终点位于${to}；若有光痕或拖尾，最亮头在${to}，尾迹反向延伸至${from}并由粗亮渐细渐暗；禁止镜像、反向运动或把最亮头放在${from}。`,
  );
}

function characterCastMatrix(pack: StudioGenerationFreezePack, panelOrder: number): string {
  const characters = pack.assets.filter((asset) => asset.category === "character");
  if (!characters.length) {
    return `第${panelOrder}格角色槽位硬锁：角色数为 0；必须无角色，禁止新增、复制或从其他格串入人物。`;
  }
  const required = characters.filter((asset) => asset.presence === "required");
  const optional = characters.filter((asset) => asset.presence === "optional");
  const describe = (asset: StudioFrozenAssetReference): string => {
    const identity = asset.definition.identityFeatures.slice(0, 3).join("、") || asset.role;
    return `${asset.definition.name}＝${identity}；站位/职责：${asset.role}`;
  };
  const requiredText = required.length
    ? `必须出现 ${required.length} 个唯一角色槽位：${required.map(describe).join("｜")}`
    : "无必须出现角色";
  const optionalText = optional.length
    ? `；可选角色：${optional.map(describe).join("｜")}`
    : "";
  return `第${panelOrder}格角色槽位硬锁：${requiredText}${optionalText}；每个已列角色只出现一个实体，未列角色禁止出现，禁止复制、换色、串脸或用另一角色替代。`;
}

function renderUnitGridPrompt(
  target: StudioUnitGridGenerationTarget,
  panelPacks: StudioGenerationFreezePack[],
  continuationSource?: StudioUnitGridContinuationSourceSnapshot,
): string {
  const lines = [
    `只生成一张 9:16 竖屏、电影写实的 ${target.panelCount} 宫格完整故事板；整板只是一张图片、一次生成。`,
    `按剧情时间从上到下依次排列 ${target.panelCount} 格，每格边界清晰，身份、服装、场景布局、道具、风格、光线和动作连续。`,
    "画面内禁止标题、格号、时长、对白文字、字幕、水印、UI、标识和任何伪文字；不得增加未冻结主体。",
    `本单元真实总时长 ${target.durationSeconds} 秒；以下“第N格”仅用于模型理解顺序，绝对不能画成文字。`,
  ];
  if (continuationSource) {
    if (continuationSource.schemaVersion === 2 || continuationSource.schemaVersion === 3) {
      const state = continuationSource.actualState;
      const labels: Record<keyof StudioUnitGridObservedActualState, string> = {
        costume: "服装",
        injury: "伤势",
        heldObject: "持物",
        position: "站位",
        facing: "朝向",
        emotion: "表情",
        layout: "布局",
        lighting: "光线",
        motionVector: "运动末态",
        cameraPhase: "相机末态",
        focusState: "焦点",
        audioPhase: "声音末态",
      };
      const actualStateLine = Object.entries(state)
        .map(([field, value]) => `${labels[field as keyof StudioUnitGridObservedActualState]}=${value}`)
        .join("；");
      lines.push(
        "上一单元 continuation_source 是已验收 actual-tail 证据图，不是整张旧宫格：从该证据实际可见的站位、朝向、持物、伤势、服装、表情、空间布局、光线与焦点连续起拍。",
        `actual-tail 只锁定以下已观察字段：${actualStateLine}。未列字段不得从计划值或空泛描述推断。`,
        "角色身份、脸型、毛色、服装母版、场景母版与画风仍以本单元 canonical 控制参考为最高权威；禁止复刻旧剧情或宫格边框，禁止把 actual-tail 当成替代身份锁。",
      );
      if (continuationSource.schemaVersion === 3) {
        for (const character of continuationSource.continuitySnapshot.characters) {
          lines.push(
            `上一镜角色「${character.assetId}」实际尾态：服装/外观=${character.costumeState}；位置=${character.position}；朝向=${character.facing}；视线=${character.gazeDirection}；动作终点=${character.actionEndPose}；下一镜起拍动作=${character.nextActionStart}；表情=${character.expression}；伤势=${character.injuryState ?? "未见伤势"}。`,
          );
        }
        for (const prop of continuationSource.continuitySnapshot.props) {
          lines.push(
            `上一镜道具「${prop.assetId}」实际尾态：持有者=${prop.heldBy ?? "无人持有"}；位置=${prop.position}；物理状态=${prop.physicalState}。`,
          );
        }
        const scene = continuationSource.continuitySnapshot.scene;
        lines.push(
          `上一镜场景实际尾态：布局=${scene.layout}；轴线=${scene.axisLine}；屏幕方向=${scene.screenDirection}；出入口=${scene.entryExits.join("、")}；光线=${scene.lighting}；时间=${scene.timeOfDay}；天气=${scene.weather ?? "无变化"}；剪辑出点=${scene.cutExit}。`,
        );
        for (const vfx of continuationSource.continuitySnapshot.vfx) {
          lines.push(
            `上一镜 VFX「${vfx.vfxId}」：${vfx.description}；强度=${vfx.intensity}；${vfx.continuesToNext ? "延续到下一镜" : "下一镜不得残留"}。`,
          );
        }
      }
    } else {
      // 历史 v1 pack 只保持可读与自校验；新冻结永远不会再建立整张 raw 连续来源。
      lines.push(
        "历史 continuation_source 仅用于读取旧冻结包；整张 PASS raw 不是可信 actual-tail，禁止据此创建新的连续性冻结。",
      );
    }
  }
  for (const [offset, pack] of panelPacks.entries()) {
    const instruction = pack.panel;
    lines.push(
      `第${offset + 1}格（${pack.target.unitLocalStartSeconds}–${pack.target.unitLocalEndSeconds}秒，仅作布局指令）：${instruction.title}。${instruction.visualAction}`,
      `第${offset + 1}格景别与构图：${instruction.shotComposition}`,
      `第${offset + 1}格拍摄方式：${instruction.filmingMethod}`,
      characterCastMatrix(pack, offset + 1),
      ...screenDirectionLocks(pack, offset + 1),
      `第${offset + 1}格冻结提示词：${modelVisualPromptBody(pack.promptRevision.body)}`,
      `第${offset + 1}格镜头类型：${instruction.shotType === "extension" ? "扩写延续" : "原镜"}`,
    );
    if (instruction.dialogue) lines.push(`第${offset + 1}格表演语境（不要画成文字）：${instruction.dialogue}`);
    if (instruction.transition) lines.push(`第${offset + 1}格转场：${instruction.transition}`);
    if (instruction.costumeState) lines.push(`第${offset + 1}格服装锁：${instruction.costumeState}`);
    if (instruction.sceneLighting) lines.push(`第${offset + 1}格光线锁：${instruction.sceneLighting}`);
    if (instruction.negativePrompt) lines.push(`第${offset + 1}格负提示词：${instruction.negativePrompt}`);
    for (const asset of pack.assets) {
      lines.push(
        `第${offset + 1}格${asset.category === "character" ? "角色" : asset.category === "scene" ? "场景" : asset.category === "prop" ? "道具" : "风格"}「${asset.definition.name}」：${asset.role}`,
        `身份特征：${asset.definition.identityFeatures.join("；") || "以 approved 控制参考图为准"}`,
        `必须保持：${asset.definition.positiveLocks.join("；") || "保持当前 approved 权威版本"}`,
        `禁止偏移：${asset.definition.negativeLocks.join("；") || "不得偏离当前权威版本"}`,
        `参考用途「${asset.definition.name}」：${asset.referenceUsage.purpose}`,
        `只继承「${asset.definition.name}」：${asset.referenceUsage.inheritOnly.join("；") || "none"}`,
        `禁止复制载体「${asset.definition.name}」：${asset.referenceUsage.excludeFromOutput.join("；") || "none"}`,
      );
    }
    for (const asset of pack.forbiddenAssets) {
      lines.push(`第${offset + 1}格禁止出画「${asset.definition.name}」：${asset.role}；${asset.definition.negativeLocks.join("；")}`);
    }
  }
  lines.push("严格只使用冻结控制参考；逐参考“用途/只继承/禁止复制载体”合同优先，reference-only 排除项不得被一致性要求覆盖；同一资产跨格必须保持同一身份，不得因为宫格布局而复制、换脸、串景或改变权威结构。");
  return lines.join("\n");
}

function assertPackIntegrity(pack: StudioUnitGridGenerationFreezePack): void {
  if (pack.schemaVersion !== 5 || pack.kind !== "studio-generation-freeze-pack"
    || pack.provenance !== "unit-grid-binding-sets" || pack.target.targetKind !== "unit-grid") {
    fail("input-drift", "unit-grid 冻结包必须是 schema v5 / unit-grid-binding-sets。");
  }
  const { id: _id, fingerprint: _fingerprint, ...semantic } = pack;
  const fingerprint = stableDigest(semantic);
  if (pack.fingerprint !== fingerprint || pack.id !== `studio-generation-freeze-${fingerprint.slice(0, 32)}`) {
    fail("input-drift", "unit-grid 冻结包内容地址无效。");
  }
  const request = pack.request;
  const { id: _requestId, fingerprint: _requestFingerprint, ...requestSemantic } = request;
  const requestFingerprint = stableDigest(requestSemantic);
  if (request.schemaVersion !== 5 || request.provenance !== "unit-grid-binding-sets"
    || request.fingerprint !== requestFingerprint
    || request.id !== `studio-codex-request-${requestFingerprint.slice(0, 32)}`) {
    fail("input-drift", "unit-grid Agent 请求内容地址无效。");
  }
  if (pack.panels.length < 2 || pack.panels.length > 6
    || pack.panels.length !== pack.target.panelCount
    || request.panelPacks.length !== pack.panels.length) {
    fail("input-drift", "unit-grid 必须冻结 2–6 个有序宫格。");
  }
  for (const [offset, panel] of pack.panels.entries()) {
    if (panel.order !== offset + 1 || panel.panelIndex !== offset + 1
      || panel.panelPack.id !== panel.panelPackId
      || panel.panelPack.fingerprint !== panel.panelPackFingerprint
      || panel.panelPack.target.unitId !== pack.target.unitId
      || panel.panelPack.target.panelId !== panel.panelId) {
      fail("input-drift", `unit-grid 第 ${offset + 1} 格身份或顺序无效。`);
    }
  }
  const continuityFingerprint = stableDigest(pack.panels.map((panel) => ({
    order: panel.order,
    panelId: panel.panelId,
    continuityFingerprint: panel.panelPack.continuity.fingerprint,
  })));
  if (pack.continuityFingerprint !== continuityFingerprint) {
    fail("input-drift", "unit-grid continuity closure 指纹无效。");
  }
  if (pack.controlReferences.length < pack.referencePolicy.minControlReferences) {
    fail("too-few-references", `unit-grid 控制参考少于 profile 下限 ${pack.referencePolicy.minControlReferences}。`);
  }
  if (pack.controlReferences.length > pack.referencePolicy.maxControlReferences) {
    fail("too-many-references", `unit-grid 控制参考超过 profile 上限 ${pack.referencePolicy.maxControlReferences}。`);
  }
  if (pack.continuationPolicy !== request.continuationPolicy
    || (pack.continuationSource === undefined) !== (request.continuationSource === undefined)
    || (pack.continuationSource !== undefined
      && request.continuationSource !== undefined
      && stableDigest(pack.continuationSource) !== stableDigest(request.continuationSource))
    || (pack.continuationWaiver === undefined) !== (request.continuationWaiver === undefined)
    || (pack.continuationWaiver !== undefined
      && request.continuationWaiver !== undefined
      && stableDigest(pack.continuationWaiver) !== stableDigest(request.continuationWaiver))) {
    fail("input-drift", "unit-grid pack 与 Agent request 的 continuation closure 不一致。");
  }
  if (!pack.continuationPolicy && pack.continuationSource) {
    fail("previous-raw-invalid", "未启用上一单元连续来源策略时不得注入 continuation_source。");
  }
  if (pack.continuationSource && pack.continuationWaiver) {
    fail("previous-raw-invalid", "unit-grid 不得同时冻结 actual-tail 连续来源与豁免。");
  }
  if (pack.continuationWaiver) {
    assertContinuationWaiverIntegrity(pack.continuationWaiver);
    if (pack.target.unitSequence <= 1 || pack.continuationPolicy) {
      fail("previous-raw-invalid", "actual-tail 豁免只允许用于 sequence > 1，且不得伪装成连续来源策略。");
    }
  }
  const continuationReference = pack.continuationSource
    ? request.controlReferences.find((reference) => reference.referenceId === pack.continuationSource!.referenceId)
    : undefined;
  if (pack.continuationSource) {
    assertContinuationSourceIntegrity(pack.continuationSource);
    const sourceMediaSha256 = pack.continuationSource.schemaVersion !== 1
      ? pack.continuationSource.evidenceSha256
      : pack.continuationSource.mediaSha256;
    if (!continuationReference
      || continuationReference.mediaSha256 !== sourceMediaSha256
      || stableDigest(continuationReference.coveredAssetIds) !== stableDigest(pack.continuationSource.coveredAssetIds)
      || stableDigest(continuationReference.categories) !== stableDigest(["continuity"])
      || stableDigest(continuationReference.roles) !== stableDigest(["continuation_source"])) {
      fail("previous-raw-invalid", "unit-grid continuation_source 与 Agent 控制引用不一致。");
    }
    if (pack.continuationSource.schemaVersion !== 1
      && (pack.target.unitSequence <= 1
        || pack.continuationSource.projectId !== pack.projectId
        || pack.continuationSource.sourceUnitSequence + 1 !== pack.target.unitSequence
        || pack.continuationSource.sourceEpisodeEndSeconds !== pack.target.episodeAbsoluteStartSeconds)) {
      fail("previous-raw-invalid", "unit-grid actual-tail 来源与当前项目/时间线不相邻。");
    }
  }
  const canonicalRequestReferences = request.controlReferences.filter((reference) => (
    reference.referenceId !== pack.continuationSource?.referenceId
  ));
  const referenceUsageContractPresent = request.controlReferences.some((reference) =>
    reference.referenceUsages !== undefined)
    || request.modelPayload.referenceUsages !== undefined;
  if (referenceUsageContractPresent) {
    if (request.controlReferences.some((reference) =>
      !reference.referenceUsages || reference.referenceUsages.length === 0)
      || !request.modelPayload.referenceUsages) {
      fail("input-drift", "unit-grid referenceUsage 合同不完整。");
    }
    for (const reference of request.controlReferences) {
      const covered = new Set(reference.coveredAssetIds);
      const usageIds = reference.referenceUsages!.map((entry) => entry.assetId);
      if (new Set(usageIds).size !== usageIds.length
        || usageIds.some((assetId) => !covered.has(assetId))) {
        fail("input-drift", `unit-grid 控制引用 ${reference.referenceId} 的 referenceUsage 资产闭包无效。`);
      }
    }
    const expectedModelUsages = request.controlReferences.flatMap((reference) =>
      reference.referenceUsages!.map(({ assetId, usage }) => ({
        referenceId: reference.referenceId,
        assetId,
        usage,
      })));
    if (stableDigest(request.modelPayload.referenceUsages) !== stableDigest(expectedModelUsages)) {
      fail("input-drift", "unit-grid modelPayload 与控制引用的 referenceUsage 不一致。");
    }
  }
  if (request.controlReferences.length > UNIT_GRID_MAX_TOTAL_REFERENCE_IMAGES) {
    fail("too-many-references", `unit-grid 总参考图超过模型上限 ${UNIT_GRID_MAX_TOTAL_REFERENCE_IMAGES}。`);
  }
  if (stableDigest(pack.controlReferences) !== stableDigest(canonicalRequestReferences)
    || stableDigest(pack.target) !== stableDigest(request.target)
    || pack.referencePolicy.fingerprint !== request.referencePolicy.fingerprint) {
    fail("input-drift", "unit-grid pack 与 Agent request 的 target/reference closure 不一致。");
  }
}

/**
 * 仅校验冻结包自身的内容地址与嵌套闭包，不读取当前 head。
 * generation ledger 从 CAS 还原历史包时必须先走此纯校验，再按需执行 currentness。
 */
export function assertStudioUnitGridGenerationFreezePackIntegrity(
  pack: StudioUnitGridGenerationFreezePack,
): StudioUnitGridGenerationFreezePack {
  assertPackIntegrity(pack);
  return pack;
}

interface BuildStudioUnitGridGenerationFreezePackOptions {
  /**
   * 已经创建 paid-call intent 后的迟到结果恢复专用。
   * 只允许 waiver 授权时的 active context 漂移；不放宽任何内容地址、
   * 前后单元、panel、Binding、continuity 或 reference currentness。
   */
  afterPaidCallIntent?: true;
}

async function buildStudioUnitGridGenerationFreezePackInternal(
  projectRoot: string,
  input: StudioUnitGridGenerationQueryInput,
  options: BuildStudioUnitGridGenerationFreezePackOptions = {},
  preflightShell?: Awaited<ReturnType<typeof inspectManagedProject>>,
): Promise<StudioUnitGridGenerationFreezePack> {
  const unitId = requiredId(input.unitId, "unitId");
  let shell: Awaited<ReturnType<typeof inspectManagedProject>>;
  if (preflightShell) {
    shell = preflightShell;
  } else {
    try {
      shell = await inspectManagedProject(projectRoot);
    } catch (error) {
      throw new StudioGenerationFreezeError(
        "unmanaged-project",
        "unit-grid 冻结包只允许读取通过验证的受管项目。",
        [error instanceof Error ? error.message : String(error)],
        { cause: error },
      );
    }
  }
  const snapshot = await readStudioProductionUnitSnapshot(shell.paths.root, unitId);
  if (!snapshot) fail("unit-not-found", `生产单元不存在：${unitId}`);
  if (snapshot.panels.length < 2 || snapshot.panels.length > 6
    || snapshot.panels.length !== snapshot.unit.panelCount) {
    fail("panel-asset-invalid", `生产单元 ${unitId} 不是完整 2–6 格快照。`);
  }
  const panelPacks: StudioGenerationFreezePack[] = [];
  for (const panel of [...snapshot.panels].sort((left, right) => left.index - right.index)) {
    panelPacks.push(await buildStudioGenerationFreezePackForUnitGridReadEpoch(
      shell.paths.root,
      {
        unitId,
        panelId: panel.id,
      },
      shell,
    ));
  }
  const current = await readStudioProductionUnitSnapshot(shell.paths.root, unitId);
  if (!current || current.fingerprint !== snapshot.fingerprint) {
    fail("revision-drift", `生产单元 ${unitId} 在 unit-grid 冻结期间发生修订漂移。`);
  }
  const profile = await readStudioProductionContractProfile(shell.paths.root, {
    season: snapshot.unit.season,
    episode: snapshot.unit.episode,
  });
  const policy = referencePolicy(profile);
  const controlReferences = mergeControlReferences(panelPacks);
  if (controlReferences.length < policy.minControlReferences) {
    fail("too-few-references", `unit-grid 控制参考 ${controlReferences.length} 项，少于 profile ${policy.profileId} 下限 ${policy.minControlReferences}。`);
  }
  if (controlReferences.length > policy.maxControlReferences) {
    fail("too-many-references", `unit-grid 控制参考 ${controlReferences.length} 项，超过 profile ${policy.profileId} 上限 ${policy.maxControlReferences}。`);
  }
  if (input.continuationWaiver && input.verifiedHistoricalImportContinuationWaiver) {
    fail("previous-raw-invalid", "不得同时提交用户授权 receipt 与 verified historical import receipt。");
  }
  const continuationWaiverReference = input.continuationWaiver
    ?? input.verifiedHistoricalImportContinuationWaiver;
  let continuationWaiver: StudioUnitGridContinuationWaiverSnapshot | undefined;
  if (continuationWaiverReference) {
    try {
      const { resolveStudioUnitGridContinuationWaiverReceiptForFreeze } = await import(
        "./studio-generation-ledger.js"
      );
      continuationWaiver = await resolveStudioUnitGridContinuationWaiverReceiptForFreeze(
        shell.paths.root,
        continuationWaiverReference,
        {
          currentUnitId: snapshot.unit.id,
          expectedAuthorityKind: input.continuationWaiver
            ? "user-authorization"
            : "verified-historical-import",
          validationPhase: options.afterPaidCallIntent
            ? "post-paid-call-intent"
            : "freeze-or-paid-call",
        },
      );
    } catch (error) {
      fail(
        "previous-raw-invalid",
        "上一单元 actual-tail 豁免 receipt 无效或已漂移。",
        [error instanceof Error ? error.message : String(error)],
      );
    }
  }
  if (snapshot.unit.sequence <= 1 && continuationWaiver) {
    fail("previous-raw-invalid", "首单元没有上一镜 actual-tail，不允许提交 continuationWaiver。");
  }
  const continuation = snapshot.unit.sequence > 1 && !continuationWaiver
    ? await freezePreviousUnitContinuationSource(
        shell.paths.root,
        shell.project.id,
        snapshot,
        panelPacks,
      )
    : undefined;
  if (snapshot.unit.sequence > 1 && !continuationWaiver && !continuation) {
    fail("previous-raw-invalid", "上一单元 actual-tail 冻结未建立；必须补齐 current Observation 或提交显式豁免。");
  }
  const continuationPolicy = continuation
    ? "previous-unit-current-pass" as const
    : undefined;
  const requestControlReferences = [
    ...controlReferences,
    ...(continuation ? [continuation.controlReference] : []),
  ];
  if (requestControlReferences.length > UNIT_GRID_MAX_TOTAL_REFERENCE_IMAGES) {
    fail(
      "too-many-references",
      `unit-grid canonical ${controlReferences.length} 项 + continuation ${continuation ? 1 : 0} 项，超过模型总上限 ${UNIT_GRID_MAX_TOTAL_REFERENCE_IMAGES}。`,
    );
  }
  const target: StudioUnitGridGenerationTarget = {
    targetKind: "unit-grid",
    targetId: snapshot.unit.id,
    unitId: snapshot.unit.id,
    seasonId: snapshot.unit.season,
    episodeId: snapshot.unit.episode,
    unitSequence: snapshot.unit.sequence,
    unitRevision: snapshot.unit.revision,
    panelCount: snapshot.unit.panelCount,
    durationSeconds: snapshot.unit.durationSeconds,
    episodeAbsoluteStartSeconds: snapshot.unit.episodeStartSeconds,
    episodeAbsoluteEndSeconds: snapshot.unit.episodeEndSeconds,
  };
  const panels: StudioUnitGridPanelFreeze[] = panelPacks.map((panelPack, offset) => {
    const semantic = {
      order: offset + 1,
      panelId: panelPack.target.panelId,
      panelIndex: panelPack.target.panelIndex,
      startSeconds: panelPack.target.unitLocalStartSeconds,
      endSeconds: panelPack.target.unitLocalEndSeconds,
      durationSeconds: panelPack.target.durationSeconds,
      panelPackId: panelPack.id,
      panelPackFingerprint: panelPack.fingerprint,
      panelBindingScopeFingerprint: panelPack.unitSnapshotFingerprint,
      instruction: panelPack.panel,
      panelPack,
    };
    return { ...semantic, fingerprint: stableDigest(semantic) };
  });
  const renderedPrompt = renderUnitGridPrompt(target, panelPacks, continuation?.source);
  const requestSemantic: Omit<StudioUnitGridCodexGenerationRequest, "id" | "fingerprint"> = {
    schemaVersion: 5,
    kind: "studio-codex-generation-request",
    provenance: "unit-grid-binding-sets",
    projectId: shell.project.id,
    executorKind: "agent-imagegen",
    allowedProviders: ["codex", "grok"],
    exactlyOneImage: true,
    maxCalls: 1,
    target,
    ...(continuationPolicy ? { continuationPolicy } : {}),
    ...(continuation ? { continuationSource: continuation.source } : {}),
    ...(continuationWaiver ? { continuationWaiver } : {}),
    referencePolicy: policy,
    panelPacks: panels.map((panel) => ({
      order: panel.order,
      panelId: panel.panelId,
      panelIndex: panel.panelIndex,
      packId: panel.panelPack.id,
      packFingerprint: panel.panelPack.fingerprint,
      bindingSetId: panel.panelPack.assetBinding.bindingSet.id,
      bindingSetFingerprint: panel.panelPack.assetBinding.bindingSet.fingerprint,
      continuityFingerprint: panel.panelPack.continuity.fingerprint,
      promptRevisionId: panel.panelPack.promptRevision.id,
      promptSha256: panel.panelPack.promptRevision.bodySha256,
    })),
    modelPayload: {
      exactlyOneImage: true,
      layout: "9:16-vertical-ordered-grid",
      renderedPrompt,
      target,
      referenceUsages: requestControlReferences.flatMap((reference) =>
        (reference.referenceUsages ?? []).map(({ assetId, usage }) => ({
          referenceId: reference.referenceId,
          assetId,
          usage: structuredClone(usage),
        }))),
      panels: panels.map((panel) => ({
        order: panel.order,
        panelId: panel.panelId,
        startSeconds: panel.startSeconds,
        endSeconds: panel.endSeconds,
        instruction: panel.instruction,
        promptRevisionId: panel.panelPack.promptRevision.id,
        promptSha256: panel.panelPack.promptRevision.bodySha256,
      })),
    },
    controlReferences: requestControlReferences,
    forbidden: [
      "titles",
      "panel-numbers",
      "durations",
      "dialogue-text",
      "subtitles",
      "watermarks",
      "ui",
      "pseudo-text",
    ],
  };
  const requestFingerprint = stableDigest(requestSemantic);
  const request: StudioUnitGridCodexGenerationRequest = {
    ...requestSemantic,
    id: `studio-codex-request-${requestFingerprint.slice(0, 32)}`,
    fingerprint: requestFingerprint,
  };
  const continuityFingerprint = stableDigest(panels.map((panel) => ({
    order: panel.order,
    panelId: panel.panelId,
    continuityFingerprint: panel.panelPack.continuity.fingerprint,
  })));
  const semantic: Omit<StudioUnitGridGenerationFreezePack, "id" | "fingerprint"> = {
    schemaVersion: 5,
    kind: "studio-generation-freeze-pack",
    provenance: "unit-grid-binding-sets",
    projectId: shell.project.id,
    managedManifestFingerprint: shell.manifestFingerprint,
    unitSnapshotFingerprint: snapshot.fingerprint,
    continuityFingerprint,
    target,
    ...(continuationPolicy ? { continuationPolicy } : {}),
    ...(continuation ? { continuationSource: continuation.source } : {}),
    ...(continuationWaiver ? { continuationWaiver } : {}),
    referencePolicy: policy,
    panels,
    controlReferences,
    request,
  };
  const fingerprint = stableDigest(semantic);
  const pack: StudioUnitGridGenerationFreezePack = {
    ...semantic,
    id: `studio-generation-freeze-${fingerprint.slice(0, 32)}`,
    fingerprint,
  };
  assertPackIntegrity(pack);
  return pack;
}

export async function buildStudioUnitGridGenerationFreezePack(
  projectRoot: string,
  input: StudioUnitGridGenerationQueryInput,
): Promise<StudioUnitGridGenerationFreezePack> {
  try {
    return await withStudioRequestSchemaCache(
      async () => {
        // 四个既有 owner 的初始化/迁移只允许发生在 identity barrier 之前，
        // 且与随后读 epoch 承接同一个请求级 schema cache。
        const shell = await preflightStudioUnitGridOwners(projectRoot);
        return withStudioUnitGridReadEpoch(
          shell.paths.root,
          () => buildStudioUnitGridGenerationFreezePackInternal(
            shell.paths.root,
            input,
            {},
            shell,
          ),
        );
      },
    );
  } catch (error) {
    if (error instanceof StudioGenerationFreezeError) throw error;
    if (error instanceof StudioUnitGridReadEpochDriftError) {
      throw new StudioGenerationFreezeError(
        "revision-drift",
        "unit-grid 初建只读 epoch 期间输入身份发生漂移，拒绝冻结。",
        [],
        { cause: error },
      );
    }
    throw new StudioGenerationFreezeError(
      "storage-invalid",
      "unit-grid 冻结包无法通过受管工程或只读存储验证。",
      [error instanceof Error ? error.message : String(error)],
      { cause: error },
    );
  }
}

export async function queryStudioUnitGridGenerationFreeze(
  projectRoot: string,
  input: StudioUnitGridGenerationQueryInput,
): Promise<StudioUnitGridGenerationQueryResult> {
  try {
    const pack = await buildStudioUnitGridGenerationFreezePack(projectRoot, input);
    return { status: "ready", packId: pack.id, fingerprint: pack.fingerprint, pack, request: pack.request };
  } catch (error) {
    if (!(error instanceof StudioGenerationFreezeError)) throw error;
    return { status: "blocked", code: error.code, message: error.message, details: [...error.details] };
  }
}

export async function assertStudioUnitGridGenerationFreezePackCurrent(
  projectRoot: string,
  pack: StudioUnitGridGenerationFreezePack,
  options: BuildStudioUnitGridGenerationFreezePackOptions = {},
): Promise<StudioUnitGridGenerationFreezePack> {
  assertPackIntegrity(pack);
  if (pack.continuationSource?.schemaVersion === 1
    || (pack.target.unitSequence > 1 && !pack.continuationSource && !pack.continuationWaiver)) {
    fail(
      "input-drift",
      "历史 unit-grid pack 没有 actual-tail 或显式豁免，只允许读取；正式派发前必须重新冻结。",
    );
  }
  let current: StudioUnitGridGenerationFreezePack;
  try {
    current = await withFreshStudioRequestSchemaCache(
      async () => {
        // fresh currentness 使用另一套 schema cache + owner preflight + read epoch。
        const shell = await preflightStudioUnitGridOwners(projectRoot);
        return withFreshStudioUnitGridReadEpoch(
          shell.paths.root,
          () => buildStudioUnitGridGenerationFreezePackInternal(shell.paths.root, {
            targetKind: "unit-grid",
            unitId: pack.target.unitId,
            ...(pack.continuationWaiver
              ? pack.continuationWaiver.authorityKind === "user-authorization"
                ? {
                    continuationWaiver: {
                      receiptId: pack.continuationWaiver.receiptId,
                      receiptFingerprint: pack.continuationWaiver.fingerprint,
                    },
                  }
                : {
                    verifiedHistoricalImportContinuationWaiver: {
                      receiptId: pack.continuationWaiver.receiptId,
                      receiptFingerprint: pack.continuationWaiver.fingerprint,
                    },
                  }
              : {}),
          }, options, shell),
        );
      },
    );
  } catch (error) {
    if (error instanceof StudioGenerationFreezeError) throw error;
    if (error instanceof StudioUnitGridReadEpochDriftError) {
      fail("revision-drift", "unit-grid 最终 currentness 只读 epoch 期间输入身份发生漂移。");
    }
    throw error;
  } finally {
    clearStudioRequestSchemaCache();
  }
  // current pack 的完整重建已经逐格重建并校验所有 panel pack；最终
  // unit-grid/request 指纹相等即覆盖 panel Head、连续性、actual-tail 与媒体
  // 闭包。此前在重建前再逐格 assert 会重复相同工作，并把 2–6 格 MCP
  // readiness 推过 60 秒客户端边界。
  if (current.id !== pack.id || current.fingerprint !== pack.fingerprint
    || current.request.fingerprint !== pack.request.fingerprint) {
    fail("input-drift", "unit-grid 冻结输入已漂移，必须重新冻结。");
  }
  return pack;
}

export function serializeStudioUnitGridGenerationRequest(
  request: StudioUnitGridCodexGenerationRequest,
): string {
  const { id: _id, fingerprint: _fingerprint, ...semantic } = request;
  const fingerprint = stableDigest(semantic);
  if (request.fingerprint !== fingerprint || request.id !== `studio-codex-request-${fingerprint.slice(0, 32)}`) {
    fail("input-drift", "unit-grid Agent 请求内容地址无效。");
  }
  return `${JSON.stringify(stableValue(request), null, 2)}\n`;
}
