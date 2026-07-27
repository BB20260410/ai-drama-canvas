/**
 * P9-R 规模夹具：
 * - 精确单元/宫格元数据（默认 1288 单元 / 精确 panel SUM）
 * - 可解码图片（sharp 真 PNG，非 8 字节签名）
 * - 可选真实短视频/音频 + ffmpeg 派生
 * - 首个六宫格单元走完整生产路径：BindingSet + 九字段 + freeze + dispatch + register + Review
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import sharp from "sharp";
import { createManagedProject, inspectManagedProject, type ProjectShell } from "./managed-project.js";
import {
  appendStudioAssetVersion,
  createStudioCanonicalAsset,
  evaluateStudioAssetApplicability,
  getMaterialStudioState,
  getStudioCanonicalAsset,
  getStudioCanonicalAssetKnowledgeSnapshot,
  importStudioMedia,
  reviewStudioAssetVersion,
  setStudioPrimaryAuthority,
} from "./material-studio.js";
import {
  analyzeStudioPanelAssetMentions,
  appendStudioPromptRevision,
  appendStudioScriptRevision,
  createStudioProductionUnit,
  createStudioPromptDocument,
  createStudioScriptDocument,
  freezeStudioPanelAssetBindingSet,
  getStudioProductionPanelTimeContext,
  getStudioProductionState,
  getStudioProductionUnitSnapshot,
  recordStudioMentionDecision,
} from "./studio-production.js";
import { getStudioProductionDashboard } from "./studio-production-dashboard.js";
import { STUDIO_CONTINUITY_FIELDS } from "./studio-continuity.js";
import { appendStudioContinuityObservation, getStudioContinuityReadiness } from "./studio-continuity-ledger.js";
import {
  dispatchStudioGenerationPack,
  freezeAndPersistStudioGenerationPack,
  registerStudioGenerationResult,
} from "./studio-generation-ledger.js";
import { submitStudioGenerationReview } from "./studio-generation-review.js";
import { materializeStudioMediaDerivatives } from "./studio-media-derivatives.js";

export const P9_SCALE_UNIT_COUNT = 1_288;
export const P9_SCALE_ASSET_COUNT = 77;
export const P9_SCALE_ASSET_CATEGORY_COUNTS = {
  character: 24,
  scene: 20,
  prop: 33,
} as const;
/** 1288 单元下精确宫格：unit1=6 + 其余 cycle → 见 expectedPanelCountForUnits */
export const P9_SCALE_TARGET_PANELS = expectedPanelCountForUnits(P9_SCALE_UNIT_COUNT);
export const P9_SCALE_MEDIA_META = 10_000;
export const P9_SCALE_THUMBNAILS = 1_000;
export const P9_SCALE_VIDEO_PROXIES = 100;
export const P9_SCALE_AUDIO_WAVEFORMS = 100;

export function scaleAssetCategoryForIndex(
  index: number,
  assetCount: number,
): "character" | "scene" | "prop" {
  if (!Number.isSafeInteger(index) || index < 0 || index >= assetCount) {
    throw new Error("规模资产索引越界。");
  }
  if (index < 3) return index === 0 ? "character" : index === 1 ? "scene" : "prop";
  const additionalIndex = index - 3;
  if (assetCount === P9_SCALE_ASSET_COUNT) {
    if (additionalIndex < P9_SCALE_ASSET_CATEGORY_COUNTS.character - 1) return "character";
    if (additionalIndex < P9_SCALE_ASSET_CATEGORY_COUNTS.character + P9_SCALE_ASSET_CATEGORY_COUNTS.scene - 2) {
      return "scene";
    }
    return "prop";
  }
  return additionalIndex % 3 === 0 ? "character" : additionalIndex % 3 === 1 ? "scene" : "prop";
}

export interface StudioScaleFixtureResult {
  root: string;
  shell: ProjectShell;
  counts: {
    units: number;
    panels: number;
    assets: number;
    assetCategories: {
      characters: number;
      scenes: number;
      props: number;
    };
    media: number;
    assetBindingSets: number;
    productionPath: {
      unitId: string;
      panelCount: number;
      bindingSets: number;
      continuityReady: boolean;
      generationRuns: number;
      reviews: number;
      videoDerivativesReady: number;
      audioDerivativesReady: number;
    };
  };
  dashboard: {
    unitsPageSize: number;
    panelsExact: number;
    panelsEstimated: number;
    panelsMatchExact: boolean;
  };
  mediaQuality: {
    imageWidth: number;
    imageHeight: number;
    realVideoCount: number;
    realAudioCount: number;
    placeholderSignatureOnly: false;
  };
  cleanup: () => Promise<void>;
}

function digest(value: unknown): string {
  const stable = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(stable);
    if (!v || typeof v !== "object") return v;
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .filter(([, e]) => e !== undefined)
        .sort(([a], [b]) => a.localeCompare(b, "en"))
        .map(([k, e]) => [k, stable(e)]),
    );
  };
  return createHash("sha256").update(JSON.stringify(stable(value)), "utf8").digest("hex");
}

/** 真 PNG，可解码（64×96，非 8 字节魔数占位）。 */
async function realPng(filePath: string, seed: number, width = 64, height = 96): Promise<void> {
  const r = (seed * 37) % 200 + 20;
  const g = (seed * 17) % 200 + 20;
  const b = (seed * 53) % 200 + 20;
  await sharp({
    create: { width, height, channels: 3, background: { r, g, b } },
  }).png({ compressionLevel: 6 }).toFile(filePath);
}

function panelPlan(unitIndex: number): number {
  // 首单元固定 6 格，便于生产路径/六图 checkpoint 切片
  if (unitIndex === 1) return 6;
  const cycle = [2, 3, 3, 3, 4, 4, 4];
  return cycle[unitIndex % cycle.length]!;
}

export function expectedPanelCountForUnits(unitCount: number): number {
  let total = 0;
  for (let index = 1; index <= unitCount; index += 1) total += panelPlan(index);
  return total;
}

function runCommand(bin: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${bin} failed (${code}): ${stderr.slice(0, 400)}`));
    });
  });
}

async function writeRealVideo(filePath: string, seconds = 1): Promise<void> {
  await runCommand("ffmpeg", [
    "-y", "-f", "lavfi", "-i", `color=c=0x2a3b4c:s=320x180:d=${seconds}`,
    "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
    "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "64k",
    "-movflags", "+faststart", filePath,
  ]);
}

async function writeRealAudio(filePath: string): Promise<void> {
  await runCommand("ffmpeg", [
    "-y", "-f", "lavfi", "-i", "sine=frequency=660:duration=1",
    "-c:a", "pcm_s16le", filePath,
  ]);
}

async function seedProductionPath(
  root: string,
  projectId: string,
  unitId: string,
  characterId: string,
  sceneId: string,
  propId: string,
  scriptBody: string,
): Promise<StudioScaleFixtureResult["counts"]["productionPath"]> {
  const unit = await getStudioProductionUnitSnapshot(root, unitId);
  if (!unit) throw new Error(`scale production unit missing: ${unitId}`);
  if (unit.panels.length !== 6) throw new Error(`scale production unit must be 6 panels, got ${unit.panels.length}`);

  let bindingSets = 0;
  for (const panel of unit.panels) {
    const mentions = [
      { id: `scale-m-${panel.index}-char`, surfaceText: "阿航", start: scriptBody.indexOf("阿航"), len: 2, assetId: characterId, category: "character" as const },
      { id: `scale-m-${panel.index}-scene`, surfaceText: "石室", start: scriptBody.indexOf("石室"), len: 2, assetId: sceneId, category: "scene" as const },
      { id: `scale-m-${panel.index}-prop`, surfaceText: "黄金面具", start: scriptBody.indexOf("黄金面具"), len: 4, assetId: propId, category: "prop" as const },
    ].map((entry) => {
      if (entry.start < 0) throw new Error(`script missing ${entry.surfaceText}`);
      const legacy = panel.assets.find((asset) => asset.assetId === entry.assetId);
      return {
        id: entry.id,
        surfaceText: entry.surfaceText,
        startOffsetUtf16: entry.start,
        endOffsetUtf16: entry.start + entry.len,
        category: entry.category,
        presence: legacy?.presence ?? "required",
        role: legacy?.role ?? entry.surfaceText,
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
      resolverVersion: "p9-scale-production-v1",
    });
    const decisions = await Promise.all(analysis.proposals.map(async (proposal) => {
      const exact = proposal.candidates.filter((candidate) => candidate.kind !== "model");
      if (proposal.status !== "matched" || exact.length !== 1) {
        throw new Error(`scale binding must exact-match ${proposal.mentionId}`);
      }
      return recordStudioMentionDecision(root, {
        receiptId: `scale-decision-${panel.index}-${proposal.mentionId}`,
        proposalId: proposal.id,
        expectedAnalysisHeadRevision: analysis.revision,
        expectedDecisionHeadRevision: 0,
        action: "accept",
        presence: proposal.presence,
        role: proposal.role,
        reviewer: "p9-scale",
        note: "规模夹具生产路径显式确认。",
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
      if (!detail?.primaryAuthority) throw new Error(`no authority ${mention.assetId}`);
      const definition = detail.definitionVersions.find((entry) => entry.id === detail.currentDefinitionVersionId);
      const authority = detail.authorityHistory.at(-1);
      const version = detail.versions.find((entry) => entry.id === detail.primaryAuthority!.versionId);
      const knowledge = await getStudioCanonicalAssetKnowledgeSnapshot(root, detail.id, target);
      if (!definition || !authority || !version || !knowledge) throw new Error(`incomplete ${detail.id}`);
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
    await freezeStudioPanelAssetBindingSet(root, {
      analysisId: analysis.id,
      expectedAnalysisHeadRevision: analysis.revision,
      expectedBindingHeadRevision: 0,
      decisionReceiptIds: decisions.map((decision) => decision.id),
      assetSources,
    });
    bindingSets += 1;

    const scope = {
      kind: "panel" as const,
      scopeId: panel.id,
      unitId: unit.unit.id,
      unitRevision: unit.unit.revision,
      startMilliseconds: Math.round(panel.startSeconds * 1000),
      endMilliseconds: Math.round(panel.endSeconds * 1000),
    };
    for (const asset of panel.assets) {
      const detail = await getStudioCanonicalAsset(root, asset.assetId);
      const mediaSha = detail!.versions.find((entry) => entry.id === detail!.primaryAuthority!.versionId)!.mediaSha256;
      for (const field of STUDIO_CONTINUITY_FIELDS) {
        const value = field === "referenceSha256" ? mediaSha : `p9-scale:${unitId}:${panel.id}:${asset.assetId}:${field}`;
        await appendStudioContinuityObservation(root, {
          operationId: `p9-scale-cont-${panel.id}-${asset.assetId}-${field}`,
          expectedHeadRevision: 0,
          scope,
          subjectId: asset.assetId,
          field,
          state: {
            status: "resolved",
            value,
            provenance: [{
              kind: "deterministic-fixture",
              reference: `${unitId}/${panel.id}/${asset.assetId}/${field}`,
              sourceFingerprint: field === "referenceSha256" ? value : digest({ unitId, panelId: panel.id, assetId: asset.assetId, field, value }),
              note: "P9-R 规模夹具显式连续性。",
            }],
          },
        });
      }
      const readiness = await getStudioContinuityReadiness(root, {
        scope,
        subjectId: asset.assetId,
        requiredFields: [...STUDIO_CONTINUITY_FIELDS],
      });
      if (!readiness.ready) throw new Error(`continuity not ready ${asset.assetId}`);
    }
  }

  let generationRuns = 0;
  let reviews = 0;
  for (const panel of unit.panels) {
    const mediaPair = {
      rawPath: path.join(root, "scale-inputs", `result-${panel.id}-raw.png`),
      labeledPath: path.join(root, "scale-inputs", `result-${panel.id}-labeled.png`),
    };
    await realPng(mediaPair.rawPath, 900 + panel.index, 72, 128);
    await realPng(mediaPair.labeledPath, 1900 + panel.index, 80, 136);
    const rawMedia = await importStudioMedia(root, { sourcePath: mediaPair.rawPath, kind: "image" });
    const labeledMedia = await importStudioMedia(root, { sourcePath: mediaPair.labeledPath, kind: "image" });
    const persisted = await freezeAndPersistStudioGenerationPack(root, {
      unitId: unit.unit.id,
      panelId: panel.id,
    });
    const generationRunId = `p9-scale-run-${panel.index}`;
    await dispatchStudioGenerationPack(root, {
      packId: persisted.packId,
      packFingerprint: persisted.fingerprint,
      generationRunId,
      provider: "codex",
    });
    const raw = await registerStudioGenerationResult(root, {
      packId: persisted.packId,
      packFingerprint: persisted.fingerprint,
      generationRunId,
      variant: "raw",
      mediaSha256: rawMedia.sha256,
      provider: "codex",
    });
    const labeled = await registerStudioGenerationResult(root, {
      packId: persisted.packId,
      packFingerprint: persisted.fingerprint,
      generationRunId,
      variant: "labeled",
      mediaSha256: labeledMedia.sha256,
      provider: "codex",
    });
    await submitStudioGenerationReview(root, {
      operationId: `p9-scale-review-${panel.index}`,
      generationRunId,
      kind: "observation",
      expectedHeadRevision: 0,
      rawResultId: raw.resultId,
      rawSha256: raw.mediaSha256,
      labeledResultId: labeled.resultId,
      labeledSha256: labeled.mediaSha256,
      expectedPackFingerprint: persisted.fingerprint,
      continuityFingerprint: persisted.pack.continuity.fingerprint,
      decision: "pass",
      criteria: [
        { code: "identity-consistency", status: "pass", note: "scale fixture" },
        { code: "raw-labeled-pair", status: "pass", note: "scale fixture" },
      ],
      reviewer: "p9-scale",
      note: "P9-R 规模夹具 Review pass。",
    });
    generationRuns += 1;
    reviews += 1;
  }

  return {
    unitId,
    panelCount: unit.panels.length,
    bindingSets,
    continuityReady: true,
    generationRuns,
    reviews,
    videoDerivativesReady: 0,
    audioDerivativesReady: 0,
  };
}

export async function createStudioScaleMetadataFixture(input: {
  parentRoot: string;
  unitCount?: number;
  assetCount?: number;
  mediaMetaCount?: number;
  /** 是否走首单元完整生产路径（Binding/连续性/生成/Review）。默认 true。 */
  seedProductionPath?: boolean;
  /** 是否生成真实短视频/音频并物化派生。默认 true（本机有 ffmpeg）。 */
  realAvDerivatives?: boolean;
  name?: string;
}): Promise<StudioScaleFixtureResult> {
  const unitCount = input.unitCount ?? P9_SCALE_UNIT_COUNT;
  const assetCount = input.assetCount ?? P9_SCALE_ASSET_COUNT;
  const mediaMetaCount = input.mediaMetaCount ?? Math.min(50, P9_SCALE_MEDIA_META);
  const seedProduction = input.seedProductionPath !== false;
  const realAv = input.realAvDerivatives !== false;
  const project = await createManagedProject({
    parentRoot: input.parentRoot,
    name: input.name ?? "P9-R 规模夹具",
    slug: `p9-scale-${createHash("sha256").update(String(Date.now())).digest("hex").slice(0, 8)}`,
  });
  const root = project.paths.root;
  const inputs = path.join(root, "scale-inputs");
  await mkdir(inputs, { recursive: true });

  const scriptBody = "阿航走进石室，举起完整黄金面具。旁白：旧约重开。";
  const scriptDoc = await createStudioScriptDocument(root, {
    id: "p9-scale-script",
    title: "规模剧本",
    expectedRevision: 0,
  });
  const script = await appendStudioScriptRevision(root, {
    documentId: scriptDoc.id,
    expectedRevision: 0,
    body: scriptBody,
    source: "fixture/p9/scale.md",
    sourceVersion: "p9-v1",
  });
  const promptDoc = await createStudioPromptDocument(root, {
    id: "p9-scale-prompt",
    title: "规模提示词",
    expectedRevision: 0,
  });
  const prompt = await appendStudioPromptRevision(root, {
    documentId: promptDoc.id,
    expectedRevision: 0,
    body: "单张写实分镜，保持身份硬锁。",
    source: "fixture/p9/scale.txt",
    sourceVersion: "p9-v1",
  });

  // 固定三件套：人物/场景/道具（生产路径依赖）
  const coreDefs = [
    { id: "character-ahang", category: "character" as const, name: "阿航", aliases: ["青年阿航"] },
    { id: "scene-stone-room", category: "scene" as const, name: "石室", aliases: ["古蜀石室"] },
    { id: "prop-complete-golden-mask", category: "prop" as const, name: "完整黄金面具", aliases: ["黄金面具"] },
  ];
  const assetIds: string[] = [];
  for (const [index, def] of coreDefs.entries()) {
    const mediaPath = path.join(inputs, `${def.id}.png`);
    await realPng(mediaPath, index + 1, 128, 192);
    const media = await importStudioMedia(root, { sourcePath: mediaPath, kind: "image" });
    const asset = await createStudioCanonicalAsset(root, {
      id: def.id,
      category: def.category,
      name: def.name,
      description: "P9-R 规模规范资产",
      aliases: def.aliases,
      identityFeatures: ["固定特征"],
      positiveLocks: ["保持身份"],
      negativeLocks: ["禁止换脸"],
      defaultPrompt: "写实",
      applicability: { seasons: ["S1"], episodes: [], units: [] },
      expectedRevision: 0,
    });
    const version = await appendStudioAssetVersion(root, {
      assetId: asset.id,
      mediaSha256: media.sha256,
      reviewStatus: "pending",
      sourceNote: "scale",
      expectedRevision: asset.revision,
    });
    const reviewed = await reviewStudioAssetVersion(root, {
      assetId: asset.id,
      versionId: version.version.id,
      decision: "approved",
      note: "scale",
      expectedRevision: version.assetRevision,
    });
    await setStudioPrimaryAuthority(root, {
      assetId: asset.id,
      versionId: version.version.id,
      expectedRevision: reviewed.revision,
    });
    assetIds.push(asset.id);
  }

  for (let index = coreDefs.length; index < assetCount; index += 1) {
    const category = scaleAssetCategoryForIndex(index, assetCount);
    const id = `${category}-scale-${String(index).padStart(3, "0")}`;
    const mediaPath = path.join(inputs, `${id}.png`);
    await realPng(mediaPath, index + 1);
    const media = await importStudioMedia(root, { sourcePath: mediaPath, kind: "image" });
    const asset = await createStudioCanonicalAsset(root, {
      id,
      category,
      name: `规模资产${index + 1}`,
      description: "P9-R 规模元数据",
      aliases: [`别名${index + 1}`],
      identityFeatures: ["固定特征"],
      positiveLocks: ["保持身份"],
      negativeLocks: ["禁止换脸"],
      defaultPrompt: "写实",
      applicability: { seasons: ["S1"], episodes: [], units: [] },
      expectedRevision: 0,
    });
    const version = await appendStudioAssetVersion(root, {
      assetId: asset.id,
      mediaSha256: media.sha256,
      reviewStatus: "pending",
      sourceNote: "scale",
      expectedRevision: asset.revision,
    });
    const reviewed = await reviewStudioAssetVersion(root, {
      assetId: asset.id,
      versionId: version.version.id,
      decision: "approved",
      note: "scale",
      expectedRevision: version.assetRevision,
    });
    await setStudioPrimaryAuthority(root, {
      assetId: asset.id,
      versionId: version.version.id,
      expectedRevision: reviewed.revision,
    });
    assetIds.push(asset.id);
  }

  for (let index = 0; index < mediaMetaCount; index += 1) {
    const mediaPath = path.join(inputs, `media-extra-${index}.png`);
    await realPng(mediaPath, 10_000 + index, 48, 64);
    await importStudioMedia(root, { sourcePath: mediaPath, kind: "image" });
  }

  let videoDerivativesReady = 0;
  let audioDerivativesReady = 0;
  let realVideoCount = 0;
  let realAudioCount = 0;
  if (realAv) {
    try {
      const videoPath = path.join(inputs, "scale-sample.mp4");
      const audioPath = path.join(inputs, "scale-sample.wav");
      await writeRealVideo(videoPath, 1);
      await writeRealAudio(audioPath);
      const videoMedia = await importStudioMedia(root, { sourcePath: videoPath, kind: "video" });
      const audioMedia = await importStudioMedia(root, { sourcePath: audioPath, kind: "audio" });
      realVideoCount = 1;
      realAudioCount = 1;
      const videoDeriv = await materializeStudioMediaDerivatives(root, { mediaSha256: videoMedia.sha256 });
      const audioDeriv = await materializeStudioMediaDerivatives(root, { mediaSha256: audioMedia.sha256 });
      if (videoDeriv.status === "ready") videoDerivativesReady = videoDeriv.derivatives.length;
      if (audioDeriv.status === "ready") audioDerivativesReady = audioDeriv.derivatives.length;
    } catch (error) {
      // 无 ffmpeg 或派生失败时不阻断规模元数据；证据中如实记录 0
      void error;
    }
  }

  let plannedPanels = 0;
  for (let index = 1; index <= unitCount; index += 1) {
    const panelCount = panelPlan(index);
    plannedPanels += panelCount;
    const duration = 15 / panelCount;
    const episodeIndex = Math.ceil(index / 40);
    const sequence = ((index - 1) % 40) + 1;
    // 首单元固定绑定三件套，便于生产路径
    const useCoreTrio = index === 1;
    await createStudioProductionUnit(root, {
      id: `p9-unit-${String(index).padStart(4, "0")}`,
      expectedRevision: 0,
      season: "S1",
      episode: `EP${String(episodeIndex).padStart(2, "0")}`,
      sequence,
      title: `规模单元 ${index}`,
      scriptRevisionId: script.revision.id,
      panels: Array.from({ length: panelCount }, (_, panelOffset) => {
        const start = panelOffset * duration;
        const end = (panelOffset + 1) * duration;
        const assets = useCoreTrio
          ? coreDefs.map((def) => ({
            assetId: def.id,
            category: def.category,
            presence: "required" as const,
            role: def.name,
            continuityState: "unknown",
            evidence: [{ kind: "prompt-revision" as const, reference: prompt.revision.id, note: "scale" }],
          }))
          : [{
            assetId: assetIds[(index - 1) % assetIds.length]!,
            category: (assetIds[(index - 1) % assetIds.length]!.startsWith("character")
              ? "character"
              : assetIds[(index - 1) % assetIds.length]!.startsWith("scene")
                ? "scene"
                : "prop") as "character" | "scene" | "prop",
            presence: "required" as const,
            role: "scale",
            continuityState: "unknown",
            evidence: [{ kind: "prompt-revision" as const, reference: prompt.revision.id, note: "scale" }],
          }];
        return {
          title: `格${panelOffset + 1}`,
          visualAction: useCoreTrio
            ? "阿航在石室中捧着完整黄金面具。"
            : "规模动作",
          shotComposition: "中景",
          filmingMethod: "固定",
          dialogue: panelOffset === 0 ? "长中文对白：旧约重开，石室回响。" : "",
          subtitle: panelOffset === 0 ? "旧约重开" : "",
          startSeconds: start,
          endSeconds: end,
          durationSeconds: duration,
          promptRevisionId: prompt.revision.id,
          sourceSpans: [{ startOffsetUtf16: 0, endOffsetUtf16: scriptBody.length }],
          assets,
        };
      }),
    });
  }

  let productionPath: StudioScaleFixtureResult["counts"]["productionPath"] = {
    unitId: "p9-unit-0001",
    panelCount: 0,
    bindingSets: 0,
    continuityReady: false,
    generationRuns: 0,
    reviews: 0,
    videoDerivativesReady,
    audioDerivativesReady,
  };
  if (seedProduction && unitCount >= 1) {
    const shell = await inspectManagedProject(root);
    productionPath = await seedProductionPath(
      root,
      shell.project.id,
      "p9-unit-0001",
      "character-ahang",
      "scene-stone-room",
      "prop-complete-golden-mask",
      scriptBody,
    );
    productionPath.videoDerivativesReady = videoDerivativesReady;
    productionPath.audioDerivativesReady = audioDerivativesReady;
  }

  const material = await getMaterialStudioState(root);
  const production = await getStudioProductionState(root);
  if (production.counts.panels !== plannedPanels) {
    throw new Error(`panel SQL 精确计数不一致：db=${production.counts.panels} planned=${plannedPanels}`);
  }
  const overview = await getStudioProductionDashboard(root, { operation: "overview" });
  if (overview.operation !== "overview") throw new Error("dashboard overview 失败");
  if (overview.counts.panels !== production.counts.panels || overview.counts.panelsEstimated !== production.counts.panels) {
    throw new Error(`dashboard 宫格计数未精确对齐：panels=${overview.counts.panels} estimated=${overview.counts.panelsEstimated} db=${production.counts.panels}`);
  }
  const unitsPage = await getStudioProductionDashboard(root, { operation: "units", limit: 36 });
  if (unitsPage.operation !== "units") throw new Error("dashboard units 失败");
  const shell = await inspectManagedProject(root);
  return {
    root,
    shell,
    counts: {
      units: production.counts.units,
      panels: production.counts.panels,
      assets: material.counts.canonicalAssets,
      assetCategories: {
        characters: material.counts.characters,
        scenes: material.counts.scenes,
        props: material.counts.props,
      },
      media: material.counts.media,
      assetBindingSets: production.counts.assetBindingSets,
      productionPath,
    },
    dashboard: {
      unitsPageSize: unitsPage.page.items.length,
      panelsExact: overview.counts.panels,
      panelsEstimated: overview.counts.panelsEstimated,
      panelsMatchExact: overview.counts.panels === production.counts.panels
        && overview.counts.panelsEstimated === production.counts.panels,
    },
    mediaQuality: {
      imageWidth: 64,
      imageHeight: 96,
      realVideoCount,
      realAudioCount,
      placeholderSignatureOnly: false,
    },
    cleanup: async () => {
      const { rm } = await import("node:fs/promises");
      await rm(path.dirname(root), { recursive: true, force: true }).catch(() => undefined);
    },
  };
}
