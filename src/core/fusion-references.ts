import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, link, mkdir, open, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { loadSharpDefault } from "./sharp-lazy.js";
import { loadFusionProductionAssets, loadFusionProjectManifest } from "./fusion-production.js";
import { getSidecarPaths, readJson, writeJsonAtomicExclusive } from "./sidecar.js";
import type {
  Artifact,
  GenerationReference,
  ProjectIndex,
  StoryboardProductionContract,
  StoryboardRow,
  StoryboardStore,
  WorkItem,
} from "./types.js";
import type { ProductionAssetCategory } from "./fusion-package.js";
import type { FusionStoryboardGridContract } from "./fusion-storyboard-grid.js";
import { assertFusionAssetConsistencyApprovedForItem } from "./fusion-asset-consistency.js";
import {
  assertFusionPanelReferenceResolutionCurrent,
  type PanelReferenceResolution,
} from "./fusion-panel-references.js";
import { assertFusionPanelVisualConstraintCurrent } from "./fusion-visual-constraint-store.js";
import { buildPanelVisualModelPayload, type PanelVisualConstraint } from "./fusion-visual-constraints.js";

export type FusionReferenceBoardVariant = "asset" | "start" | "end" | "shot" | "panel";

export interface FusionReferenceSource {
  referenceId: string;
  assetId: string;
  assetName: string;
  category: ProductionAssetCategory;
  workItemId: string;
  artifactId?: string;
  path: string;
  sha256: string;
  reviewId?: string;
  /** 派生组合槽可覆盖多个 canonical 资产；直接槽只包含自身。 */
  coveredAssetIds?: string[];
  derivedReferenceAssetId?: string;
}

export interface FusionReferenceBoardFile {
  path: string;
  metadataPath: string;
  sha256: string;
  width: number;
  height: number;
}

export interface FusionReferenceBoard {
  schemaVersion: 1;
  kind: "fusion-reference-board";
  projectId: string;
  sourceContentAddress: `sha256:${string}`;
  itemId: string;
  itemType: WorkItem["type"];
  variant: FusionReferenceBoardVariant;
  storyboardRevision: number;
  storyboardRowId?: string;
  storyboardRowRevision?: number;
  storyboardGridContractId?: string;
  storyboardPanelId?: string;
  panelReferenceResolutionId?: string;
  panelReferenceResolutionFingerprint?: string;
  panelVisualConstraintEvidenceVersion?: 1;
  panelVisualConstraintId?: string;
  panelVisualConstraintFingerprint?: string;
  panelVisualModelFingerprint?: string;
  panelVisualReviewRulesFingerprint?: string;
  assetIds: string[];
  sources: FusionReferenceSource[];
  prompt: string;
  promptSha256: string;
  board?: FusionReferenceBoardFile;
  references: GenerationReference[];
  createdAt: string;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

const SAFE_P01_ASSET_MODEL_PROMPT = "电影级写实风格，中国神话史诗质感，商周时代考据，戏剧性自然光影。9:16竖屏，只生成一张独立纯画面。纯白背景，无人物、无环境。同一只闭合不透明素麻布囊，麻布本色、粗糙旧织纹、囊口以麻绳牢固收束，配宽麻布背带；内部完全不可见、不发光、不新增金属元素。画面内不要文字、字幕、水印、界面、边框、拼图、分屏或现代物。";

function safeModelAssetLabel(source: FusionReferenceSource): string {
  if (source.assetId === "P01" || source.coveredAssetIds?.includes("P01")) return "P01 闭合不透明素麻布囊";
  return `${source.assetId} ${source.assetName}`;
}

async function digestFile(filePath: string): Promise<string> {
  const before = await stat(filePath);
  if (!before.isFile() || before.size <= 0) throw new Error(`参考素材不是可读取的非空文件：${filePath}`);
  const bytes = await readFile(filePath);
  const after = await stat(filePath);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
    throw new Error(`读取期间参考素材发生变化：${filePath}`);
  }
  return sha256(bytes);
}

function safeSegment(value: string): string {
  const normalized = value.normalize("NFKC").replace(/[^a-zA-Z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "");
  return normalized.slice(0, 120) || "item";
}

function storyboardContract(row: StoryboardRow): StoryboardProductionContract {
  return {
    storyboardRowId: row.id,
    storyboardRowRevision: row.revision,
    itemId: row.itemId,
    shotItemId: row.shotItemId,
    order: row.order,
    durationSeconds: row.durationSeconds,
    shotSize: row.shotSize,
    cameraMovement: row.cameraMovement,
    cameraAngle: row.cameraAngle,
    lens: row.lens,
    composition: row.composition,
    staging: row.staging,
    action: row.action,
    expression: row.expression,
    emotion: row.emotion,
    eyeline: row.eyeline,
    screenDirection: row.screenDirection,
    axisSide: row.axisSide,
    dialogue: row.dialogue,
    narration: row.narration,
    ambience: row.ambience,
    soundEffects: row.soundEffects,
    continuityBefore: row.continuityBefore,
    continuityAfter: row.continuityAfter,
    referenceNames: row.referenceNames,
    firstFramePrompt: row.firstFramePrompt,
    endFramePrompt: row.endFramePrompt,
    videoPrompt: row.videoPrompt,
    referencePaths: [...row.referencePaths],
    referenceArtifactIds: [...(row.referenceArtifactIds ?? [])],
    upstreamFactRefs: row.upstreamFactRefs,
    upstreamBeatRefs: row.upstreamBeatRefs,
    sourceSpans: row.sourceSpans,
    adaptationPlanId: row.adaptationPlanId,
    adaptationUnitId: row.adaptationUnitId,
    directorIntent: row.directorIntent,
    emotionalIntent: row.emotionalIntent,
    continuityNotes: row.continuityNotes,
  };
}

async function writeBufferExclusive(filePath: string, content: Buffer): Promise<"created" | "existing"> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await link(temporary, filePath);
      return "created";
    } catch (error) {
      if (!(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EEXIST")) throw error;
      const existing = await readFile(filePath);
      if (!existing.equals(content)) throw new Error(`参考板目标已存在但内容冲突，拒绝覆盖：${filePath}`);
      return "existing";
    }
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function renderReferenceBoard(projectRoot: string, identity: string, sources: FusionReferenceSource[], metadata: Omit<FusionReferenceBoard, "board" | "references" | "createdAt">): Promise<FusionReferenceBoardFile | undefined> {
  if (!sources.length) return undefined;
  if (sources.length > 6) throw new Error(`参考板包含 ${sources.length} 项资产，超过 6 项硬上限；必须先建立并审核群像或道具组合派生资产。`);
  const columns = Math.min(3, sources.length);
  const rows = Math.ceil(sources.length / columns);
  const tileWidth = 640;
  const tileHeight = 960;
  const gutter = 16;
  const width = columns * tileWidth + (columns + 1) * gutter;
  const height = rows * tileHeight + (rows + 1) * gutter;
  const tiles = await Promise.all(sources.map(async (source) => (await loadSharpDefault())(source.path, { failOn: "error" })
    .rotate()
    .resize({ width: tileWidth, height: tileHeight, fit: "contain", background: "#171411" })
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer()));
  const composite = tiles.map((input, index) => ({
    input,
    left: gutter + (index % columns) * (tileWidth + gutter),
    top: gutter + Math.floor(index / columns) * (tileHeight + gutter),
  }));
  const image = await (await loadSharpDefault())({ create: { width, height, channels: 3, background: "#28231d" } })
    .composite(composite)
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer();
  const imageSha256 = sha256(image);
  const directory = path.join(getSidecarPaths(projectRoot).referenceBoards, safeSegment(metadata.itemId));
  const base = `${safeSegment(identity)}-${imageSha256.slice(0, 20)}`;
  const imagePath = path.join(directory, `${base}.png`);
  const metadataPath = path.join(directory, `${base}.json`);
  await writeBufferExclusive(imagePath, image);
  const file: FusionReferenceBoardFile = { path: imagePath, metadataPath, sha256: imageSha256, width, height };
  await writeJsonAtomicExclusive(metadataPath, { ...metadata, board: file, references: [{ path: imagePath, role: "reference_board", order: 0, sha256: imageSha256 }] });
  return file;
}

function selectStoryboardRow(item: WorkItem, rows: StoryboardRow[], variant: FusionReferenceBoardVariant): StoryboardRow {
  const confirmed = rows.filter((row) => row.status === "confirmed").sort((left, right) => left.order - right.order);
  const sourceRows = confirmed.filter((row) => Boolean(row.shotItemId));
  let selected: StoryboardRow | undefined;
  if (item.type === "shot") selected = confirmed.find((row) => row.shotItemId === item.id);
  else if (variant === "start") selected = sourceRows[0];
  else if (variant === "end") selected = sourceRows.at(-1);
  if (!selected) throw new Error(`节点 ${item.id} 没有可用于 ${variant} 参考板的已确认原镜；扩写段不能伪造成原镜。`);
  return selected;
}

function expectedFrameVariant(item: WorkItem, requested?: FusionReferenceBoardVariant): FusionReferenceBoardVariant {
  if (item.type === "shot") return "shot";
  if (requested === "start" || requested === "end") return requested;
  return item.status === "待尾帧" ? "end" : "start";
}

function activeRawArtifact(index: ProjectIndex, item: WorkItem): Artifact | undefined {
  return index.artifacts.find((artifact) => artifact.itemId === item.id
    && artifact.kind === "raw-image"
    && artifact.variant === "generic"
    && artifact.authoritative
    && !artifact.deprecated
    && artifact.check.ok
    && artifact.check.decodable !== false);
}

async function acceptedAssetSources(
  projectRoot: string,
  index: ProjectIndex,
  assetIds: string[],
  definitions: Map<string, { name: string; category: ProductionAssetCategory; requiresBatchReview: boolean }>,
): Promise<FusionReferenceSource[]> {
  const result: FusionReferenceSource[] = [];
  for (const assetId of assetIds) {
    const definition = definitions.get(assetId);
    if (!definition) throw new Error(`正式分镜引用了资产库中不存在的资产：${assetId}`);
    const item = index.items.find((candidate) => candidate.id === `asset-${assetId}` && candidate.type === "asset");
    if (!item) throw new Error(`正式分镜资产 ${assetId} 尚未物化为真实资产节点。`);
    if (item.status !== "已完成" || item.hardLockIds.length < 1) {
      throw new Error(`资产 ${assetId} 尚未通过视觉验收并提升为硬锁，禁止依赖它生成分镜。`);
    }
    if (definition.requiresBatchReview) await assertFusionAssetConsistencyApprovedForItem(projectRoot, item.id);
    const artifact = activeRawArtifact(index, item);
    if (!artifact) throw new Error(`资产 ${assetId} 没有通过机械验收的权威 raw，禁止构建参考板。`);
    result.push({
      referenceId: assetId,
      assetId,
      assetName: definition.name,
      category: definition.category,
      workItemId: item.id,
      artifactId: artifact.id,
      path: artifact.path,
      sha256: await digestFile(artifact.path),
    });
  }
  return result;
}

export async function buildFusionReferenceBoard(
  projectRoot: string,
  index: ProjectIndex,
  itemId: string,
  requestedVariant?: FusionReferenceBoardVariant,
): Promise<{ board: FusionReferenceBoard; storyboardRows: StoryboardProductionContract[] }> {
  const [manifest, catalog] = await Promise.all([
    loadFusionProjectManifest(projectRoot),
    loadFusionProductionAssets(projectRoot),
  ]);
  if (!manifest || !catalog) throw new Error("当前工程不是已物化的融合工程，不能使用第三季参考板门禁。 ");
  if (catalog.sourceContentAddress !== manifest.contentAddress || catalog.projectId !== manifest.projectId) {
    throw new Error("融合资产目录与项目 manifest 的内容地址不一致，已停止生成。 ");
  }
  if (path.resolve(index.project.primaryRoot) !== path.resolve(projectRoot) || index.project.id !== manifest.projectId) {
    throw new Error("扫描索引与融合工程 manifest 不属于同一项目。 ");
  }
  const item = index.items.find((candidate) => candidate.id === itemId);
  if (!item) throw new Error(`找不到真实生产节点：${itemId}`);
  const createdAt = new Date().toISOString();
  let variant: FusionReferenceBoardVariant;
  let storyboardRevision: number;
  let selectedRow: StoryboardRow | undefined;
  let sources: FusionReferenceSource[] = [];
  let prompt: string;

  if (item.type === "asset") {
    variant = "asset";
    const entry = catalog.assets.find((candidate) => candidate.workItemId === item.id);
    if (!entry) throw new Error(`资产节点 ${item.id} 没有冻结的资产生成合同。`);
    if (!['待首帧', '返工'].includes(item.status)) throw new Error(`资产 ${entry.definition.id} 当前状态为 ${item.status}，不能创建新的资产生图任务。`);
    if (entry.contract.authorityReferences.length > entry.contract.referencePolicy.maximumReferences) {
      throw new Error(`资产 ${entry.definition.id} 的权威参考超过 ${entry.contract.referencePolicy.maximumReferences} 项，拒绝静默裁剪。`);
    }
    sources = await Promise.all(entry.contract.authorityReferences.map(async (reference, position) => {
      const actual = await digestFile(reference.path);
      if (actual !== reference.sha256) throw new Error(`资产 ${entry.definition.id} 的权威参考已漂移：${reference.path}`);
      return {
        referenceId: `${entry.definition.id}-authority-${position + 1}`,
        assetId: entry.definition.id,
        assetName: `${entry.definition.name}权威参考${position + 1}`,
        category: entry.definition.category,
        workItemId: item.id,
        path: reference.path,
        sha256: actual,
      };
    }));
    storyboardRevision = catalog.revision;
    // 历史 P01 合同保留完整本地审核语义；模型投影只得到安全布囊描述。
    prompt = entry.definition.id === "P01" ? SAFE_P01_ASSET_MODEL_PROMPT : entry.contract.prompt;
  } else {
    if (!['unit', 'shot'].includes(item.type)) throw new Error(`节点 ${item.id} 不支持融合图片参考板。`);
    variant = expectedFrameVariant(item, requestedVariant);
    const store = await readJson<StoryboardStore>(getSidecarPaths(projectRoot).storyboards, { schemaVersion: 1, revision: 0, rows: [], updatedAt: new Date(0).toISOString() });
    selectedRow = selectStoryboardRow(item, store.rows, variant);
    const assetIds = [...new Set((selectedRow.referenceNames ?? []).map((value) => value.trim()).filter(Boolean))];
    if (!assetIds.length) throw new Error(`正式分镜 ${selectedRow.id} 没有显式资产引用，禁止回退到全局硬锁。`);
    if (assetIds.length > 6) throw new Error(`正式分镜 ${selectedRow.id} 显式引用 ${assetIds.length} 项资产，超过 6 项硬上限；必须先建立并审核群像或道具组合派生资产。`);
    sources = await acceptedAssetSources(projectRoot, index, assetIds, new Map(catalog.assets.map((entry) => [
      entry.definition.id,
      { name: entry.definition.name, category: entry.definition.category, requiresBatchReview: !entry.authority },
    ])));
    storyboardRevision = store.revision;
    prompt = variant === "end" ? selectedRow.endFramePrompt : selectedRow.firstFramePrompt;
  }

  const mapping = sources.length
    ? `\n唯一参考板按从左到右、从上到下依次为：${sources.map((source) => `${source.assetId} ${source.assetName}`).join("；")}。参考板只用于身份、造型、道具和场景连续性，不得复制拼图布局、边框或留白。`
    : "";
  const frozenPrompt = `${prompt.trim()}${mapping}`.trim();
  if (!frozenPrompt) throw new Error(`节点 ${item.id} 的冻结生成提示词为空。`);
  const base: Omit<FusionReferenceBoard, "board" | "references" | "createdAt"> = {
    schemaVersion: 1,
    kind: "fusion-reference-board",
    projectId: manifest.projectId,
    sourceContentAddress: manifest.contentAddress,
    itemId: item.id,
    itemType: item.type,
    variant,
    storyboardRevision,
    storyboardRowId: selectedRow?.id,
    storyboardRowRevision: selectedRow?.revision,
    assetIds: [...new Set(sources.map((source) => source.assetId))],
    sources,
    prompt: frozenPrompt,
    promptSha256: sha256(frozenPrompt),
  };
  const identity = sha256(JSON.stringify({
    sourceContentAddress: base.sourceContentAddress,
    itemId: base.itemId,
    variant: base.variant,
    storyboardRevision: base.storyboardRevision,
    storyboardRowId: base.storyboardRowId,
    storyboardRowRevision: base.storyboardRowRevision,
    promptSha256: base.promptSha256,
    sources: base.sources.map((source) => [source.referenceId, source.sha256]),
    layout: "fusion-reference-board-v1",
  })).slice(0, 32);
  const file = await renderReferenceBoard(projectRoot, `${variant}-${identity}`, sources, base);
  const references: GenerationReference[] = file
    ? [{ path: file.path, role: "reference_board", order: 0, sha256: file.sha256 }]
    : [];
  const board: FusionReferenceBoard = { ...base, board: file, references, createdAt };
  return { board, storyboardRows: selectedRow ? [storyboardContract(selectedRow)] : [] };
}

export async function buildFusionStoryboardPanelReferenceBoard(
  projectRoot: string,
  index: ProjectIndex,
  itemId: string,
  contract: FusionStoryboardGridContract,
  panelIndex: number,
): Promise<{ board: FusionReferenceBoard; storyboardRows: StoryboardProductionContract[]; resolution: PanelReferenceResolution; constraint: PanelVisualConstraint }> {
  const [manifest, catalog] = await Promise.all([
    loadFusionProjectManifest(projectRoot),
    loadFusionProductionAssets(projectRoot),
  ]);
  if (!manifest || !catalog || manifest.contentAddress !== catalog.sourceContentAddress || manifest.projectId !== catalog.projectId) {
    throw new Error("融合工程 manifest 与资产目录不一致，不能构建宫格逐格参考板。 ");
  }
  if (contract.unit.unitId !== itemId || contract.sourceStoryboardRevision < 1) throw new Error("宫格合同与目标单元不一致。 ");
  const item = index.items.find((candidate) => candidate.id === itemId && candidate.type === "unit");
  if (!item) throw new Error(`宫格合同无法映射真实 15 秒单元：${itemId}`);
  const panel = contract.panels.find((candidate) => candidate.index === panelIndex);
  if (!panel || panelIndex < 1 || panelIndex > contract.selection.panelCount) throw new Error(`宫格序号无效：${panelIndex}`);
  const resolution = await assertFusionPanelReferenceResolutionCurrent(projectRoot, contract.contractId, panel.id);
  if (resolution.unitItemId !== itemId
    || resolution.gridSourceFingerprint !== contract.sourceFingerprint
    || resolution.panelIndex !== panelIndex
    || resolution.startSeconds !== panel.startSeconds
    || resolution.endSeconds !== panel.endSeconds) {
    throw new Error(`宫格 ${panel.id} 的 P2 引用解析与当前合同身份不一致。`);
  }
  const constraint = await assertFusionPanelVisualConstraintCurrent(projectRoot, contract.contractId, panel.id);
  if (constraint.unitItemId !== itemId
    || constraint.gridContractId !== contract.contractId
    || constraint.panelId !== panel.id
    || constraint.panelIndex !== panelIndex
    || constraint.inputSnapshot.resolutionId !== resolution.resolutionId
    || constraint.inputSnapshot.resolutionFingerprint !== resolution.resolutionFingerprint) {
    throw new Error(`宫格 ${panel.id} 的 P3 视觉约束与当前合同/P2 resolution 身份不一致。`);
  }
  if (constraint.generationGate.status !== "ready") {
    throw new Error(`宫格 ${panel.id} 的 P3 视觉约束尚未允许生成：${constraint.generationGate.blockerCodes.join("、")}`);
  }
  const modelPayload = buildPanelVisualModelPayload(constraint);
  const semanticById = new Map(resolution.semanticAssets.map((asset) => [asset.assetId, asset]));
  const sources: FusionReferenceSource[] = resolution.referenceSlots.map((slot) => {
    if (!slot.path || !slot.sha256) throw new Error(`宫格 ${panel.id} 引用槽 ${slot.id} 尚未绑定可上传文件。`);
    const first = semanticById.get(slot.coveredAssetIds[0]!);
    return {
      referenceId: slot.id,
      assetId: slot.kind === "canonical-asset" ? slot.assetId! : slot.derivedAssetId!,
      assetName: slot.kind === "canonical-asset"
        ? first?.assetName ?? slot.assetId!
        : `组合参考（${slot.coveredAssetIds.join("+")}）`,
      category: first?.category ?? "prop",
      workItemId: slot.kind === "canonical-asset" ? `asset-${slot.assetId}` : `derived-${slot.derivedAssetId}`,
      artifactId: slot.artifactId,
      path: slot.path,
      sha256: slot.sha256,
      reviewId: slot.reviewId,
      coveredAssetIds: [...slot.coveredAssetIds],
      derivedReferenceAssetId: slot.derivedAssetId,
    };
  });
  if (sources.length > 6) throw new Error(`宫格 ${panel.id} 的 P2 解析仍有 ${sources.length} 个上传槽，拒绝静默裁剪。`);
  const continuityReferenceIds = new Set([
    ...(panel.continuityReferenceAssetIds ?? []),
    ...resolution.timelineReconciliations
      .filter((entry) => entry.difference === "continuity-only")
      .map((entry) => entry.assetId),
  ]);
  const mapping = sources.length
    ? `\n唯一参考板按从左到右、从上到下依次为：${sources.map((source) => `${safeModelAssetLabel(source)}${source.coveredAssetIds?.some((assetId) => continuityReferenceIds.has(assetId)) ? "（仅连续性参考，未明确出镜时不得强行入画）" : ""}`).join("；")}。参考板只用于当前约束声明的身份、造型、道具和场景连续性，不得复制拼图布局、边框或留白。`
    : "";
  const prompt = `${modelPayload.prompt}\n模型负面约束：${modelPayload.negativePrompt}${mapping}`.trim();
  const store = await readJson<StoryboardStore>(getSidecarPaths(projectRoot).storyboards, { schemaVersion: 1, revision: 0, rows: [], updatedAt: new Date(0).toISOString() });
  if (store.revision !== contract.sourceStoryboardRevision) throw new Error(`宫格合同 ${contract.contractId} 的 storyboard 修订已经变化。`);
  const selectedRows = store.rows
    .filter((row) => row.status === "confirmed" && panel.storyboardRowIds.includes(row.id))
    .sort((left, right) => left.order - right.order);
  if (selectedRows.length !== panel.storyboardRowIds.length) throw new Error(`宫格 ${panel.id} 的正式分镜行已经缺失或弃用。`);
  const base: Omit<FusionReferenceBoard, "board" | "references" | "createdAt"> = {
    schemaVersion: 1,
    kind: "fusion-reference-board",
    projectId: manifest.projectId,
    sourceContentAddress: manifest.contentAddress,
    itemId,
    itemType: "unit",
    variant: "panel",
    storyboardRevision: contract.sourceStoryboardRevision,
    storyboardGridContractId: contract.contractId,
    storyboardPanelId: panel.id,
    panelReferenceResolutionId: resolution.resolutionId,
    panelReferenceResolutionFingerprint: resolution.resolutionFingerprint,
    panelVisualConstraintEvidenceVersion: 1,
    panelVisualConstraintId: constraint.constraintId,
    panelVisualConstraintFingerprint: constraint.fingerprint,
    panelVisualModelFingerprint: constraint.modelFingerprint,
    panelVisualReviewRulesFingerprint: constraint.reviewRulesFingerprint,
    assetIds: resolution.semanticAssets.map((asset) => asset.assetId),
    sources,
    prompt,
    promptSha256: sha256(prompt),
  };
  const identity = sha256(JSON.stringify({
    sourceContentAddress: base.sourceContentAddress,
    contractId: contract.contractId,
    sourceFingerprint: contract.sourceFingerprint,
    panelReferenceResolutionId: resolution.resolutionId,
    panelReferenceResolutionFingerprint: resolution.resolutionFingerprint,
    panelVisualConstraintId: constraint.constraintId,
    panelVisualConstraintFingerprint: constraint.fingerprint,
    panelVisualModelFingerprint: constraint.modelFingerprint,
    panelVisualReviewRulesFingerprint: constraint.reviewRulesFingerprint,
    panelId: panel.id,
    panelIndex,
    promptSha256: base.promptSha256,
    sources: sources.map((source) => [source.referenceId, source.sha256]),
    layout: "fusion-reference-board-v1",
  })).slice(0, 32);
  const file = await renderReferenceBoard(projectRoot, `panel-${String(panelIndex).padStart(2, "0")}-${identity}`, sources, base);
  const references: GenerationReference[] = file
    ? [{ path: file.path, role: "reference_board", order: 0, sha256: file.sha256 }]
    : [];
  return {
    board: { ...base, board: file, references, createdAt: new Date().toISOString() },
    storyboardRows: selectedRows.map(storyboardContract),
    resolution,
    constraint,
  };
}

export async function assertFusionProjectReadable(projectRoot: string): Promise<boolean> {
  const manifest = await loadFusionProjectManifest(projectRoot);
  if (!manifest) return false;
  await access(getSidecarPaths(projectRoot).productionAssets, constants.R_OK);
  await access(getSidecarPaths(projectRoot).storyboards, constants.R_OK);
  return true;
}
