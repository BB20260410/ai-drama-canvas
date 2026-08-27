import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { withEditor } from "./editor-lazy.js";
import { listGenerationJobs } from "./generation.js";
import { getProjectIndex } from "./service.js";
import { appendEvent, getSidecarPaths, listTaskPacks, loadProjectConfig, readJson, writeJsonAtomic } from "./sidecar.js";
import { withStory, type StoryModule } from "./story-lazy.js";
import { listReviewRecords } from "./reviews.js";
import { reviewCoversAnyArtifact, reviewCoversArtifacts } from "./review-evidence.js";
import {
  buildFusionStoryboardReviewRequirement,
  fusionStoryboardRequiredArtifacts,
  loadFusionStoryboardEvidenceSnapshot,
} from "./fusion-storyboard-evidence.js";
import { reviewCoversFusionStoryboardRequirement } from "./review-evidence.js";
import { listPublicationReceipts } from "./publication.js";
import { PRODUCTION_WORKFLOW_STAGE_IDS, type AdaptationStore, type CreativeBible, type CreativeBibleKind, type CreativeBibleUpsertInput, type ExistingProductionBaseline, type ExistingProductionRecoveryCommitInput, type ExistingProductionRecoveryContractInput, type ExistingProductionRecoveryEvidence, type ExistingProductionRecoveryEvidenceFile, type ExistingProductionRecoveryEvidenceItem, type ExistingProductionRecoveryInput, type ExistingProductionRecoveryPreview, type ExistingProductionRecoveryTarget, type GenerationKind, type ProductionStageEvidenceAudit, type ProductionWorkflow, type ProductionWorkflowEvidenceAudit, type ProductionWorkflowStageId, type ProductionWorkflowStageStatus, type ProductionWorkflowStageUpdateInput, type StoryboardProductionContract, type StoryboardRow, type StoryboardRowInputFields, type StoryboardRowUpsertInput, type StoryboardStore, type StoryLibrary } from "./types.js";
import { withProjectLock } from "./locks.js";
import { assertExistingRevision, assertRevisionedUpsert } from "./command-outcome.js";

const STAGE_NAMES: Record<ProductionWorkflowStageId, string> = {
  source: "原文导入",
  chapters: "章节拆分",
  events: "事件提取与确认",
  skeleton: "故事骨架",
  adaptation: "改编方案",
  episodes: "分集剧本",
  director: "导演规划",
  visual_bible: "视觉圣经",
  assets: "角色 / 场景 / 道具资产",
  storyboard: "正式分镜",
  frames: "首尾帧生产",
  video: "图生视频",
  edit: "成片剪辑",
  review: "导演总验收",
  publish: "发布版本",
};

const STAGE_CONTRACTS: Record<ProductionWorkflowStageId, Pick<ProductionWorkflow["stages"][number], "inputRequirements" | "outputRequirements" | "acceptanceCriteria" | "failurePaths" | "nextActions">> = {
  source: { inputRequirements: ["本地 TXT、Markdown、DOCX 或明确原文路径"], outputRequirements: ["可追溯原文快照"], acceptanceCriteria: ["原文件存在且快照可读", "来源路径、修改时间和哈希可追溯"], failurePaths: ["编码或格式失败时保留原文件并记录警告"], nextActions: ["import_story_file", "list_story_sources"] },
  chapters: { inputRequirements: ["已导入的原文快照"], outputRequirements: ["稳定章节 ID 和逐章文本证据"], acceptanceCriteria: ["章节顺序、标题与字数可追溯", "重导入不静默覆盖旧快照"], failurePaths: ["无法拆章时保留单章快照并标记警告"], nextActions: ["list_story_chapters", "read_story_chapter"] },
  events: { inputRequirements: ["已导入章节"], outputRequirements: ["带原文证据的故事事件"], acceptanceCriteria: ["关键事件经人工确认", "事件依赖无孤立端点"], failurePaths: ["不确定事件保持 draft", "矛盾事件进入返工"], nextActions: ["upsert_story_event", "connect_story_events"] },
  skeleton: { inputRequirements: ["confirmed 故事事件"], outputRequirements: ["落盘故事骨架"], acceptanceCriteria: ["主线、人物目标、转折和结局完整"], failurePaths: ["证据不足时退回事件确认"], nextActions: ["upsert_context", "update_production_workflow_stage"] },
  adaptation: { inputRequirements: ["故事骨架", "目标集数与时长"], outputRequirements: ["落盘改编策略"], acceptanceCriteria: ["保留核心因果", "删改有明确理由"], failurePaths: ["偏离原作时标记待导演审核"], nextActions: ["analyze_change_impact", "upsert_context"] },
  episodes: { inputRequirements: ["改编策略"], outputRequirements: ["分集 00_信息.md 与 15 秒单元"], acceptanceCriteria: ["集间连续", "节点能映射真实文件"], failurePaths: ["结构冲突时回退改编策略"], nextActions: ["save_script_document", "scan_project"] },
  director: { inputRequirements: ["分集剧本", "改编策略"], outputRequirements: ["导演意图、节奏、镜头语言和一镜到底策略"], acceptanceCriteria: ["导演 Bible 已落盘", "关键场次的情绪、节奏和视觉重心明确"], failurePaths: ["意图冲突时回退改编或分集阶段"], nextActions: ["upsert_creative_bible", "analyze_change_impact"] },
  visual_bible: { inputRequirements: ["导演规划", "角色与世界观约束"], outputRequirements: ["视觉圣经、禁项、参考路径和色彩/材质规则"], acceptanceCriteria: ["视觉 Bible 已落盘", "人物、场景、道具和完整黄金面具规则明确"], failurePaths: ["参考冲突时保留两版并进入导演审核"], nextActions: ["upsert_creative_bible", "list_creative_bibles"] },
  assets: { inputRequirements: ["分集剧本", "导演/视觉 Bible", "角色/场景/道具清单"], outputRequirements: ["权威资产、衍生关系与音色绑定"], acceptanceCriteria: ["硬锁可解码", "角色与道具身份稳定"], failurePaths: ["不合格版本标记弃用并生成新版本"], nextActions: ["promote_asset_to_hard_lock", "upsert_asset_relation", "upsert_voice_identity"] },
  storyboard: { inputRequirements: ["分集剧本", "导演/视觉 Bible", "权威角色与场景资产"], outputRequirements: ["正式结构化分镜行"], acceptanceCriteria: ["每单元最多 6 镜", "累计不超过 15 秒", "首尾帧和视频提示词齐全"], failurePaths: ["超时或连续性失败时拆镜返工"], nextActions: ["upsert_storyboard_row", "create_shot_task_pack"] },
  frames: { inputRequirements: ["正式分镜", "硬锁资产"], outputRequirements: ["首尾帧 raw/labeled 配对"], acceptanceCriteria: ["机械验收通过", "导演视觉验收通过"], failurePaths: ["失败进入返工，不推进视频"], nextActions: ["create_task_pack", "enqueue_generation", "submit_review"] },
  video: { inputRequirements: ["已通过视觉验收的首尾帧"], outputRequirements: ["新视频版本与生成来源"], acceptanceCriteria: ["ffprobe 可解码", "动作与角色连续", "停在视频视觉验收"], failurePaths: ["生成失败恢复检查点或创建新版本"], nextActions: ["produce_next_video_batch", "get_browser_generation_plan", "submit_review"] },
  edit: { inputRequirements: ["已验收镜头视频", "音频与字幕"], outputRequirements: ["剪辑工程与新成片"], acceptanceCriteria: ["整数帧时间线", "无非法空隙/重叠", "成片可解码"], failurePaths: ["撤销、Ripple 修正或重新渲染"], nextActions: ["apply_edit_operation", "start_edit_render", "export_edit_otio"] },
  review: { inputRequirements: ["成片与全部验收记录"], outputRequirements: ["导演总验收和发布候选"], acceptanceCriteria: ["无活跃待办", "关键硬锁和声音连续", "发布文件可解码"], failurePaths: ["按影响分析将节点标记返工"], nextActions: ["get_review_queue", "analyze_change_impact", "finish_batch"] },
  publish: { inputRequirements: ["已通过导演总验收的成片", "发布标题、封面、字幕与版本说明"], outputRequirements: ["不可变发布版本记录与本地成片路径"], acceptanceCriteria: ["发布文件可解码并有哈希", "来源剪辑修订和验收结论可追溯"], failurePaths: ["发布前发现问题时新建剪辑修订，不覆盖发布候选"], nextActions: ["get_project_snapshot", "create_handoff"] },
};

function emptyWorkflow(): ProductionWorkflow {
  const now = new Date(0).toISOString();
  return { schemaVersion: 1, revision: 0, stages: PRODUCTION_WORKFLOW_STAGE_IDS.map((id) => ({ id, name: STAGE_NAMES[id], status: "not_started", evidencePaths: [], itemIds: [], ...STAGE_CONTRACTS[id], updatedAt: now })), updatedAt: now };
}

export async function getProductionWorkflow(projectRoot: string, options: { includeEvidenceAudit?: boolean } = {}): Promise<ProductionWorkflow> {
  const stored = await readJson<ProductionWorkflow | null>(getSidecarPaths(projectRoot).productionWorkflow, null);
  const workflow: ProductionWorkflow = stored ? (() => {
    const byId = new Map(stored.stages.map((stage) => [stage.id, stage]));
    return { ...stored, evidenceAudit: undefined, stages: PRODUCTION_WORKFLOW_STAGE_IDS.map((id) => ({ ...STAGE_CONTRACTS[id], ...(byId.get(id) ?? { id, name: STAGE_NAMES[id], status: "not_started" as const, evidencePaths: [], itemIds: [], updatedAt: stored.updatedAt }) })) };
  })() : emptyWorkflow();
  if (options.includeEvidenceAudit) workflow.evidenceAudit = await auditProductionWorkflow(projectRoot, workflow);
  return workflow;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, candidate]) => candidate !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, candidate]) => [key, canonicalValue(candidate)]));
}

function contentDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalValue(value))).digest("hex");
}

async function fileEvidence(filePath: string, artifactId?: string): Promise<ExistingProductionRecoveryEvidenceFile> {
  const resolved = path.resolve(filePath);
  const metadata = await stat(resolved).catch(() => null);
  if (!metadata?.isFile() || metadata.size <= 0) throw new Error(`既有制作包证据文件不存在或为空：${resolved}`);
  return {
    path: resolved,
    size: metadata.size,
    sha256: await new Promise<string>((resolve, reject) => {
      const hash = createHash("sha256");
      const stream = createReadStream(resolved);
      stream.on("data", (chunk) => hash.update(chunk));
      stream.once("error", reject);
      stream.once("end", () => resolve(hash.digest("hex")));
    }),
    artifactId,
  };
}

function pathInside(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function recoveryTarget(target: GenerationKind | "next_task" | "video_continuation"): ExistingProductionRecoveryTarget | undefined {
  if (target === "image" || target === "video_continuation") return target;
  return undefined;
}

function baselineTargetItemId(contract: ExistingProductionRecoveryContractInput | StoryboardProductionContract): string {
  return contract.shotItemId ?? contract.itemId;
}

function normalizeRecoveryContract(
  input: ExistingProductionRecoveryContractInput,
  artifactPaths: Map<string, string>,
): StoryboardProductionContract {
  const required: Array<[string, string]> = [
    ["景别", input.shotSize],
    ["运镜", input.cameraMovement],
    ["动作", input.action],
    ["首帧提示词", input.firstFramePrompt],
    ["尾帧提示词", input.endFramePrompt],
    ["视频提示词", input.videoPrompt],
  ];
  const missing = required.filter(([, value]) => !value?.trim()).map(([label]) => label);
  if (missing.length) throw new Error(`既有制作包正式合同缺少：${missing.join("、")}`);
  if (!Number.isInteger(input.order) || input.order < 1 || input.order > 6) throw new Error("既有制作包正式合同 order 必须为 1–6 的整数。");
  if (!Number.isFinite(input.durationSeconds) || input.durationSeconds <= 0 || input.durationSeconds > 15.001) throw new Error("既有制作包正式合同 durationSeconds 必须大于 0 且不超过 15 秒。");
  const referenceArtifactIds = [...new Set(input.referenceArtifactIds ?? [])].sort();
  const referencePaths = [...new Set([
    ...(input.referencePaths ?? []).map((candidate) => path.resolve(candidate)),
    ...referenceArtifactIds.map((id) => artifactPaths.get(id)).filter((candidate): candidate is string => Boolean(candidate)),
  ])].sort();
  const material = {
    ...input,
    shotSize: input.shotSize.trim(),
    cameraMovement: input.cameraMovement.trim(),
    action: input.action.trim(),
    firstFramePrompt: input.firstFramePrompt.trim(),
    endFramePrompt: input.endFramePrompt.trim(),
    videoPrompt: input.videoPrompt.trim(),
    referencePaths,
    referenceArtifactIds,
  };
  return {
    ...material,
    storyboardRowId: `existing-production-row-${contentDigest(material).slice(0, 24)}`,
    storyboardRowRevision: 1,
  };
}

async function buildExistingProductionRecoveryPreview(
  projectRoot: string,
  input: ExistingProductionRecoveryInput,
  workflow: ProductionWorkflow,
): Promise<ExistingProductionRecoveryPreview> {
  if (workflow.stages.some((stage) => stage.status !== "not_started")) {
    throw new Error("既有制作包接管只适用于尚未推进正常 production workflow 的 filesystem 项目。");
  }
  const itemIds = [...new Set(input.itemIds.map((id) => id.trim()).filter(Boolean))].sort();
  if (!itemIds.length || itemIds.length > 20) throw new Error("既有制作包接管必须明确 1–20 个生产节点。");
  if (itemIds.length !== input.itemIds.length) throw new Error("既有制作包接管节点不能重复或为空。");
  const allowedTargets = [...new Set(input.allowedTargets)].sort() as ExistingProductionRecoveryTarget[];
  if (!allowedTargets.length || allowedTargets.some((target) => !["image", "video_continuation"].includes(target))) {
    throw new Error("既有制作包接管首版只允许 image 或 video_continuation。");
  }
  const [index, config] = await Promise.all([getProjectIndex(projectRoot), loadProjectConfig(projectRoot)]);
  const allowedRoots = [...new Set([config.primaryRoot, ...config.sourceRoots, ...config.outputRoots].map((candidate) => path.resolve(candidate)))];
  const artifactMap = new Map(index.artifacts.map((artifact) => [artifact.id, artifact]));
  const artifactPaths = new Map(index.artifacts.map((artifact) => [artifact.id, path.resolve(artifact.path)]));
  const contracts = input.contracts.map((contract) => normalizeRecoveryContract(contract, artifactPaths))
    .sort((left, right) => baselineTargetItemId(left).localeCompare(baselineTargetItemId(right)) || left.order - right.order);
  const contractTargets = new Set(contracts.map(baselineTargetItemId));
  const missingContracts = itemIds.filter((id) => !contractTargets.has(id));
  const outsideContracts = [...contractTargets].filter((id) => !itemIds.includes(id));
  if (missingContracts.length || outsideContracts.length) {
    throw new Error(`既有制作包正式合同与 scope 不一致：缺少 ${missingContracts.join("、") || "无"}；越界 ${outsideContracts.join("、") || "无"}。`);
  }
  const evidenceItems: ExistingProductionRecoveryEvidenceItem[] = [];
  for (const itemId of itemIds) {
    const item = index.items.find((candidate) => candidate.id === itemId);
    if (!item || (item.type !== "unit" && item.type !== "shot")) throw new Error(`既有制作包接管无法映射真实 unit/shot：${itemId}`);
    if (!item.infoPath) throw new Error(`既有制作包节点缺少 00_信息.md：${itemId}`);
    const scopedContracts = contracts.filter((contract) => baselineTargetItemId(contract) === itemId);
    if (new Set(scopedContracts.map((contract) => contract.order)).size !== scopedContracts.length) throw new Error(`既有制作包节点 ${itemId} 的正式合同 order 重复。`);
    if (scopedContracts.length > 6 || scopedContracts.reduce((sum, contract) => sum + contract.durationSeconds, 0) > 15.001) {
      throw new Error(`既有制作包节点 ${itemId} 必须满足最多 6 镜且累计不超过 15 秒。`);
    }
    const referencePaths = [...new Set(scopedContracts.flatMap((contract) => contract.referencePaths))].sort();
    const references: ExistingProductionRecoveryEvidenceFile[] = [];
    for (const referencePath of referencePaths) {
      if (!allowedRoots.some((root) => pathInside(referencePath, root))) throw new Error(`既有制作包参考文件超出项目授权根：${referencePath}`);
      const artifact = index.artifacts.find((candidate) => path.resolve(candidate.path) === referencePath);
      if (!artifact || artifact.deprecated || !artifact.check.ok || !artifact.check.decodable) throw new Error(`既有制作包参考文件没有通过当前扫描与解码验收：${referencePath}`);
      references.push(await fileEvidence(referencePath, artifact.id));
    }
    for (const contract of scopedContracts) {
      const invalidArtifactIds = contract.referenceArtifactIds.filter((id) => {
        const artifact = artifactMap.get(id);
        return !artifact || artifact.deprecated || !artifact.check.ok || !contract.referencePaths.includes(path.resolve(artifact.path));
      });
      if (invalidArtifactIds.length) throw new Error(`既有制作包正式合同引用了失效资产：${invalidArtifactIds.join("、")}`);
    }
    const info = await fileEvidence(item.infoPath);
    evidenceItems.push({
      itemId,
      itemType: item.type,
      infoPath: info.path,
      infoSize: info.size,
      infoSha256: info.sha256,
      referencePaths,
      references,
    });
  }
  const evidenceMaterial = { projectId: index.project.id, items: evidenceItems };
  const evidence: ExistingProductionRecoveryEvidence = {
    projectId: index.project.id,
    scanId: index.scanId,
    items: evidenceItems,
    fingerprint: contentDigest(evidenceMaterial),
  };
  const note = input.note?.trim().slice(0, 8_000) || undefined;
  const previewMaterial = {
    schemaVersion: 1,
    expectedWorkflowRevision: workflow.revision,
    itemIds,
    allowedTargets,
    contracts,
    evidence,
    note,
  };
  return {
    schemaVersion: 1,
    ready: true,
    previewId: contentDigest(previewMaterial),
    expectedWorkflowRevision: workflow.revision,
    itemIds,
    allowedTargets,
    contracts,
    evidence,
    warnings: ["该回执只授权列出的节点与目标，不代表 source→storyboard 历史阶段已经完成。"],
    note,
  };
}

export async function previewExistingProductionRecovery(
  projectRoot: string,
  input: ExistingProductionRecoveryInput,
): Promise<ExistingProductionRecoveryPreview> {
  return buildExistingProductionRecoveryPreview(projectRoot, input, await getProductionWorkflow(projectRoot));
}

export async function commitExistingProductionRecovery(
  projectRoot: string,
  input: ExistingProductionRecoveryCommitInput,
  actor: "user" | "codex" = "codex",
): Promise<ProductionWorkflow> {
  return withProjectLock(projectRoot, "production", async () => {
    const workflow = await getProductionWorkflow(projectRoot);
    assertExistingRevision({
      entityType: "production_workflow",
      entityLabel: "生产工作流",
      expectedRevision: input.expectedWorkflowRevision,
      currentRevision: workflow.revision,
      allowZero: true,
    });
    const preview = await buildExistingProductionRecoveryPreview(projectRoot, input, workflow);
    if (preview.previewId !== input.previewId) throw new Error("既有制作包接管预检已经过期；文件、索引、合同或 scope 已变化，请重新预检。");
    const baseline: ExistingProductionBaseline = {
      schemaVersion: 1,
      id: `existing-production-${preview.previewId.slice(0, 24)}`,
      digest: preview.previewId,
      itemIds: preview.itemIds,
      allowedTargets: preview.allowedTargets,
      contracts: preview.contracts,
      evidence: preview.evidence,
      note: preview.note,
      createdAt: new Date().toISOString(),
    };
    workflow.existingProductionBaselines = [
      baseline,
      ...(workflow.existingProductionBaselines ?? []).filter((candidate) => candidate.id !== baseline.id),
    ];
    workflow.revision += 1;
    workflow.updatedAt = baseline.createdAt;
    await writeJsonAtomic(getSidecarPaths(projectRoot).productionWorkflow, workflow);
    await appendEvent(projectRoot, {
      actor,
      type: "production.existing-package-adopted",
      data: {
        baselineId: baseline.id,
        digest: baseline.digest,
        itemIds: baseline.itemIds,
        allowedTargets: baseline.allowedTargets,
        revision: workflow.revision,
        evidenceFingerprint: baseline.evidence.fingerprint,
      },
    });
    return workflow;
  });
}

async function validateExistingProductionBaseline(projectRoot: string, baseline: ExistingProductionBaseline): Promise<string[]> {
  const issues: string[] = [];
  const index = await getProjectIndex(projectRoot);
  if (index.project.id !== baseline.evidence.projectId) issues.push("项目 ID 已变化");
  const fingerprintItems: ExistingProductionRecoveryEvidenceItem[] = [];
  for (const expected of baseline.evidence.items) {
    const item = index.items.find((candidate) => candidate.id === expected.itemId);
    if (!item || item.type !== expected.itemType) {
      issues.push(`节点不存在或类型变化：${expected.itemId}`);
      continue;
    }
    if (!item.infoPath || path.resolve(item.infoPath) !== expected.infoPath) {
      issues.push(`00_信息.md 路径变化：${expected.itemId}`);
      continue;
    }
    const info = await fileEvidence(expected.infoPath).catch(() => null);
    if (!info || info.size !== expected.infoSize || info.sha256 !== expected.infoSha256) issues.push(`00_信息.md 内容漂移：${expected.itemId}`);
    const references: ExistingProductionRecoveryEvidenceFile[] = [];
    for (const reference of expected.references) {
      const actual = await fileEvidence(reference.path, reference.artifactId).catch(() => null);
      const artifact = reference.artifactId ? index.artifacts.find((candidate) => candidate.id === reference.artifactId) : undefined;
      if (!actual || actual.size !== reference.size || actual.sha256 !== reference.sha256) {
        issues.push(`参考文件内容漂移：${reference.path}`);
        continue;
      }
      if (reference.artifactId && (!artifact || artifact.deprecated || !artifact.check.ok || path.resolve(artifact.path) !== reference.path)) {
        issues.push(`参考资产登记失效：${reference.artifactId}`);
        continue;
      }
      references.push(actual);
    }
    if (info) fingerprintItems.push({
      ...expected,
      infoSize: info.size,
      infoSha256: info.sha256,
      references,
    });
  }
  const fingerprint = contentDigest({ projectId: index.project.id, items: fingerprintItems });
  if (fingerprint !== baseline.evidence.fingerprint) issues.push("scoped 证据指纹已变化");
  return [...new Set(issues)];
}

export async function auditExistingProductionBaselines(
  projectRoot: string,
  workflowInput?: ProductionWorkflow,
): Promise<Array<{ id: string; digest: string; itemIds: string[]; allowedTargets: ExistingProductionRecoveryTarget[]; valid: boolean; issues: string[] }>> {
  const workflow = workflowInput ?? await getProductionWorkflow(projectRoot);
  return Promise.all((workflow.existingProductionBaselines ?? []).map(async (baseline) => {
    const issues = await validateExistingProductionBaseline(projectRoot, baseline);
    return {
      id: baseline.id,
      digest: baseline.digest,
      itemIds: [...baseline.itemIds],
      allowedTargets: [...baseline.allowedTargets],
      valid: issues.length === 0,
      issues,
    };
  }));
}

export async function assertExistingProductionBaselineEvidence(
  projectRoot: string,
  input: { baselineId: string; digest: string; itemIds: string[]; target: ExistingProductionRecoveryTarget },
): Promise<ExistingProductionBaseline> {
  const workflow = await getProductionWorkflow(projectRoot);
  const baseline = (workflow.existingProductionBaselines ?? []).find((candidate) => candidate.id === input.baselineId);
  if (!baseline || baseline.digest !== input.digest) throw new Error("GenerationJob 绑定的既有制作包接管回执不存在或 digest 不匹配。");
  if (!baseline.allowedTargets.includes(input.target) || input.itemIds.some((itemId) => !baseline.itemIds.includes(itemId))) {
    throw new Error("GenerationJob 已超出既有制作包接管回执冻结的 item/kind scope。");
  }
  const issues = await validateExistingProductionBaseline(projectRoot, baseline);
  if (issues.length) throw new Error(`既有制作包接管基线真实证据已失效：${issues.join("；")}；请重新预检与接管。`);
  return baseline;
}

async function matchingExistingProductionBaseline(
  projectRoot: string,
  workflow: ProductionWorkflow,
  target: GenerationKind | "next_task" | "video_continuation",
  scopeItemIds?: string[],
): Promise<{ baseline?: ExistingProductionBaseline; issues?: string[] }> {
  const allowedTarget = recoveryTarget(target);
  const scope = [...new Set(scopeItemIds ?? [])];
  if (!allowedTarget || !scope.length) return {};
  const candidate = (workflow.existingProductionBaselines ?? []).find((baseline) =>
    baseline.allowedTargets.includes(allowedTarget) && scope.every((itemId) => baseline.itemIds.includes(itemId)));
  if (!candidate) return {};
  const issues = await validateExistingProductionBaseline(projectRoot, candidate);
  return issues.length ? { baseline: candidate, issues } : { baseline: candidate };
}

export async function getExistingProductionGateEvidence(
  projectRoot: string,
  target: GenerationKind | "next_task" | "video_continuation",
  scopeItemIds?: string[],
): Promise<ExistingProductionBaseline | undefined> {
  const workflow = await getProductionWorkflow(projectRoot);
  const requiredStageId: ProductionWorkflowStageId = target === "video" ? "frames" : "storyboard";
  const requiredIndex = workflow.stages.findIndex((stage) => stage.id === requiredStageId);
  if (workflow.stages.slice(0, requiredIndex + 1).every((stage) => stage.status === "completed")) return undefined;
  const match = await matchingExistingProductionBaseline(projectRoot, workflow, target, scopeItemIds);
  if (match.issues?.length) throw new Error(`既有制作包接管基线真实证据已失效：${match.issues.join("；")}；请重新预检与接管。`);
  return match.baseline;
}

export async function assertProductionWorkflowGate(
  projectRoot: string,
  target: GenerationKind | "next_task" | "video_continuation",
  scopeItemIds?: string[],
): Promise<ProductionWorkflow> {
  const workflow = await getProductionWorkflow(projectRoot);
  const requiredStageId: ProductionWorkflowStageId = target === "video" ? "frames" : "storyboard";
  const requiredIndex = workflow.stages.findIndex((stage) => stage.id === requiredStageId);
  const incomplete = workflow.stages.slice(0, requiredIndex + 1).filter((stage) => stage.status !== "completed");
  if (incomplete.length) {
    const match = await matchingExistingProductionBaseline(projectRoot, workflow, target, scopeItemIds);
    if (match.issues?.length) throw new Error(`既有制作包接管基线真实证据已失效：${match.issues.join("；")}；请重新预检与接管。`);
    if (match.baseline) return workflow;
    throw new Error(`生产工作流门禁未通过：${incomplete.map((stage) => `${stage.name}（${stage.status}）`).join("、")}；只有 completed 才能推进。`);
  }
  const context = await loadProductionEvidenceContext(projectRoot);
  const relevant = workflow.stages.slice(0, requiredIndex + 1);
  const stale: string[] = [];
  for (const stage of relevant) {
    if (!stage.evidenceVerification && stage.id !== requiredStageId) continue;
    const audit = await evaluateProductionStage(projectRoot, workflow, stage.id, context, stage.id === requiredStageId ? scopeItemIds : undefined);
    if (!audit.ready) stale.push(`${stage.name}：${audit.issues.join("、")}`);
  }
  if (stale.length) throw new Error(`生产工作流真实证据已失效：${stale.join("；")}；请重新核验并修复，不能根据旧 completed 状态继续。`);
  return workflow;
}

type ProductionEvidenceContext = Awaited<ReturnType<typeof loadProductionEvidenceContext>>;

function storyEvidenceAuditIssue(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/story v1 来源快照 SHA\/字数与索引不一致/u.test(message)) {
    return `原文快照哈希失配：${message.split("：").at(-1) ?? "未知来源"}`;
  }
  if (/story v1 章节 SHA\/字数与索引不一致|story v1 章节区间与来源快照不一致/u.test(message)) {
    return `章节快照哈希失配：${message.split("：").at(-1) ?? "未知章节"}`;
  }
  return `原文证据闭包无法安全读取：${message}`;
}

async function loadProductionStoryEvidence(projectRoot: string) {
  try {
    const [storySources, storyChapters, storyEvents] = await withStory((story) => Promise.all([
      story.listStorySources(projectRoot),
      story.listStoryChapters(projectRoot),
      story.listStoryEvents(projectRoot, { includeOrphans: true }),
    ]));
    return { storySources, storyChapters, storyEvents, storyEvidenceReadIssue: undefined };
  } catch (error) {
    // Story Core 的普通读取必须继续 fail-closed；生产审计只把同一失败翻译成
    // 可呈现的失效证据，绝不回退 raw cast 或继续信任受损索引中的路径。
    return {
      storySources: [] as Awaited<ReturnType<StoryModule["listStorySources"]>>,
      storyChapters: [] as Awaited<ReturnType<StoryModule["listStoryChapters"]>>,
      storyEvents: [] as Awaited<ReturnType<StoryModule["listStoryEvents"]>>,
      storyEvidenceReadIssue: storyEvidenceAuditIssue(error),
    };
  }
}

async function loadProductionEvidenceContext(projectRoot: string) {
  const sidecar = getSidecarPaths(projectRoot);
  const [index, storyEvidence, storyboard, bibles, reviewRecords, editProjects, renderJobs, publicationReceipts, adaptation, library, config] = await Promise.all([
    getProjectIndex(projectRoot),
    loadProductionStoryEvidence(projectRoot),
    getStoryboard(projectRoot),
    listCreativeBibles(projectRoot),
    listReviewRecords(projectRoot, { limit: 1_000 }),
    withEditor((editor) => editor.listEditProjects(projectRoot)),
    withEditor((editor) => editor.readEditRenderJobs(projectRoot)),
    listPublicationReceipts(projectRoot),
    readJson<AdaptationStore | null>(sidecar.storyAdaptation, null),
    readJson<StoryLibrary | null>(sidecar.storyIndex, null),
    loadProjectConfig(projectRoot),
  ]);
  return { index, ...storyEvidence, storyboard, bibles, reviewRecords, editProjects, renderJobs, publicationReceipts, adaptation, library, config };
}

function normalizedStoryText(value: string): string {
  return value.replace(/^\uFEFF/, "").replace(/\0/g, "").replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").replace(/\n{5,}/g, "\n\n\n").trim();
}

const storyHashCache = new Map<string, { size: number; mtimeMs: number; ctimeMs: number; sha256: string }>();
const STORY_HASH_CACHE_LIMIT = 2_048;

async function readableNonEmpty(filePath: string): Promise<boolean> {
  return stat(filePath).then((value) => value.isFile() && value.size > 0).catch(() => false);
}

async function storyTextHash(filePath: string): Promise<string | undefined> {
  try {
    const metadata = await stat(filePath);
    const key = path.resolve(filePath);
    const cached = storyHashCache.get(key);
    if (cached && cached.size === metadata.size && cached.mtimeMs === metadata.mtimeMs && cached.ctimeMs === metadata.ctimeMs) return cached.sha256;
    const sha256 = createHash("sha256").update(normalizedStoryText(await readFile(key, "utf8"))).digest("hex");
    storyHashCache.delete(key);
    storyHashCache.set(key, { size: metadata.size, mtimeMs: metadata.mtimeMs, ctimeMs: metadata.ctimeMs, sha256 });
    while (storyHashCache.size > STORY_HASH_CACHE_LIMIT) storyHashCache.delete(storyHashCache.keys().next().value!);
    return sha256;
  } catch { return undefined; }
}

function evidenceMetrics(context: ProductionEvidenceContext): Record<string, number> {
  const { index, storySources, storyChapters, storyEvents, storyboard, bibles, reviewRecords, editProjects, renderJobs, publicationReceipts, adaptation, config } = context;
  const activeUnits = index.items.filter((item) => item.type === "unit" && item.status !== "弃用");
  return {
    sources: storySources.length,
    chapters: storyChapters.length,
    confirmedEvents: storyEvents.filter((event) => event.status === "confirmed").length,
    facts: adaptation?.facts.length ?? 0,
    beats: adaptation?.beats.length ?? 0,
    plans: adaptation?.plans.length ?? 0,
    materializedPlans: adaptation?.plans.filter((plan) => plan.status === "materialized").length ?? 0,
    directorBibles: bibles.filter((bible) => bible.kind === "director").length,
    visualBibles: bibles.filter((bible) => bible.kind === "visual").length,
    hardLocks: config.hardLocks.length,
    assetItems: index.items.filter((item) => item.type === "asset").length,
    activeUnits: activeUnits.length,
    confirmedStoryboardRows: storyboard.rows.filter((row) => row.status === "confirmed").length,
    reviewPasses: reviewRecords.filter((record) => record.decision === "pass").length,
    editProjects: editProjects.length,
    succeededRenders: renderJobs.filter((job) => job.status === "succeeded").length,
    publicationReceipts: publicationReceipts.length,
  };
}

function evidenceFingerprint(stageId: ProductionWorkflowStageId, evidencePaths: string[], itemIds: string[], issues: string[], metrics: Record<string, number>): string {
  return createHash("sha256").update(JSON.stringify({ stageId, evidencePaths: [...evidencePaths].sort(), itemIds: [...itemIds].sort(), issues, metrics })).digest("hex");
}

async function stageCompletionIssues(projectRoot: string, stageId: ProductionWorkflowStageId, evidencePaths: string[], itemIds: string[], contextInput?: ProductionEvidenceContext, scopeItemIds?: string[]): Promise<string[]> {
  const issues: string[] = [];
  const context = contextInput ?? await loadProductionEvidenceContext(projectRoot);
  const { index, storySources, storyChapters, storyEvents, storyboard, bibles, reviewRecords, editProjects, renderJobs, publicationReceipts, adaptation, library } = context;
  if (context.storyEvidenceReadIssue && ["source", "chapters", "events", "skeleton", "adaptation"].includes(stageId)) {
    issues.push(context.storyEvidenceReadIssue);
  }
  const paths = [...new Set(evidencePaths.map((candidate) => path.resolve(candidate)))];
  const missing = await Promise.all(paths.map(async (candidate) => ({ candidate, valid: await readableNonEmpty(candidate) })));
  if (missing.some((entry) => !entry.valid)) issues.push(`证据路径不存在、不是文件或为空：${missing.filter((entry) => !entry.valid).map((entry) => entry.candidate).join("、")}`);
  if (stageId === "source") {
    if (!storySources.length) issues.push("尚未通过小说导入建立可追溯原文快照");
    for (const source of storySources) {
      if (!(await readableNonEmpty(source.snapshotPath))) issues.push(`原文快照不存在或为空：${source.id}`);
      else if (await storyTextHash(source.snapshotPath) !== source.sha256) issues.push(`原文快照哈希失配：${source.id}`);
      if (!source.originalPath.startsWith("aicanvas://")) {
        if (!(await readableNonEmpty(source.originalPath))) issues.push(`原始导入文件已丢失或为空：${source.originalPath}`);
        else if (source.kind !== "docx" && await storyTextHash(source.originalPath) !== source.sha256) issues.push(`原始导入文件内容已变化，请重新导入建立新修订：${source.id}`);
      }
    }
  }
  if (stageId === "chapters") {
    if (!storyChapters.length) issues.push("尚未建立可追溯章节快照");
    const chapterIds = new Set(storyChapters.map((chapter) => chapter.id));
    for (const source of storySources) for (const chapterId of source.chapterIds) if (!chapterIds.has(chapterId)) issues.push(`原文索引引用了不存在的章节：${chapterId}`);
    for (const chapter of storyChapters) {
      if (!storySources.some((source) => source.id === chapter.sourceId)) issues.push(`章节引用了不存在的原文：${chapter.id}`);
      if (!(await readableNonEmpty(chapter.path))) issues.push(`章节快照不存在或为空：${chapter.id}`);
      else if (await storyTextHash(chapter.path) !== chapter.sha256) issues.push(`章节快照哈希失配：${chapter.id}`);
    }
  }
  if (stageId === "events") {
    const confirmed = storyEvents.filter((event) => event.status === "confirmed");
    if (!confirmed.length) issues.push("没有已确认的故事事件");
    const eventIds = new Set(storyEvents.map((event) => event.id));
    for (const event of confirmed) {
      if (!storyChapters.some((chapter) => chapter.id === event.chapterId)) issues.push(`故事事件引用了不存在的章节：${event.id}`);
      if (!event.sourceExcerpt && !event.tags.includes("改编推断")) issues.push(`已确认故事事件缺少原文证据或“改编推断”标记：${event.id}`);
      for (const dependencyId of event.dependencyIds) if (!eventIds.has(dependencyId)) issues.push(`故事事件依赖不存在：${event.id} → ${dependencyId}`);
    }
  }
  if (stageId === "skeleton") {
    if (!paths.length) issues.push("必须提供已落盘且非空的故事骨架证据文件");
    if (!storyEvents.some((event) => event.status === "confirmed")) issues.push("故事骨架缺少已确认事件作为来源");
  }
  if (stageId === "adaptation") {
    const activePlan = adaptation?.plans.find((plan) => plan.id === adaptation.selectedPlanId && ["selected", "materialized"].includes(plan.status));
    if (!adaptation?.facts.length) issues.push("改编工作区没有小说事实");
    if (!adaptation?.beats.length) issues.push("改编工作区没有剧情节拍");
    if (!activePlan) issues.push("没有已选定或已物化的精简/拆分改编方案");
    if (activePlan?.validation.hardErrors.length) issues.push(`改编方案仍有硬错误：${activePlan.validation.hardErrors.join("、")}`);
    if (activePlan && library && activePlan.sourceLibraryRevision !== library.revision) issues.push(`改编方案来源修订已过期：${activePlan.sourceLibraryRevision} → ${library.revision}`);
    const chapterMap = new Map(storyChapters.map((chapter) => [chapter.id, chapter]));
    for (const fact of adaptation?.facts ?? []) {
      if (fact.epistemicStatus === "confirmed" && !fact.sourceSpans.length) issues.push(`已确认小说事实缺少原文证据：${fact.id}`);
      for (const span of fact.sourceSpans) {
        const chapter = chapterMap.get(span.chapterId);
        if (!chapter || chapter.revision !== span.chapterRevision || chapter.sha256 !== span.chapterSha256) issues.push(`小说事实证据已失效：${fact.id} → ${span.chapterId}`);
      }
    }
    const factIds = new Set((adaptation?.facts ?? []).map((fact) => fact.id));
    const factRevisions = new Map((adaptation?.facts ?? []).map((fact) => [fact.id, fact.revision]));
    const beatRevisions = new Map((adaptation?.beats ?? []).map((beat) => [beat.id, beat.revision]));
    for (const beat of adaptation?.beats ?? []) for (const factId of beat.factIds) if (!factIds.has(factId)) issues.push(`剧情节拍引用了不存在的事实：${beat.id} → ${factId}`);
    for (const unit of activePlan?.units ?? []) for (const row of unit.storyboardRows) {
      for (const reference of row.upstreamFactRefs ?? []) if (factRevisions.get(reference.id) !== reference.revision) issues.push(`改编镜头事实引用已失效：${row.id} → ${reference.id}`);
      for (const reference of row.upstreamBeatRefs ?? []) if (beatRevisions.get(reference.id) !== reference.revision) issues.push(`改编镜头节拍引用已失效：${row.id} → ${reference.id}`);
    }
  }
  if (stageId === "episodes") {
    const plan = adaptation?.plans.find((candidate) => candidate.id === adaptation.selectedPlanId && candidate.status === "materialized");
    if (!plan) issues.push("没有已物化的改编方案");
    const materializedUnits = plan?.units ?? [];
    for (const unit of materializedUnits) {
      const item = index.items.find((candidate) => candidate.type === "unit" && candidate.episode === unit.episode && candidate.unit === unit.unit && candidate.infoPath);
      if (!item?.infoPath || !(await readableNonEmpty(item.infoPath))) issues.push(`物化单元没有真实 00_信息.md：${unit.id}`);
    }
  }
  if (stageId === "director" || stageId === "visual_bible") {
    const kind = stageId === "director" ? "director" : "visual";
    const matching = bibles.filter((bible) => bible.kind === kind);
    if (!matching.length) issues.push(stageId === "director" ? "没有导演 Bible" : "没有视觉 Bible");
    for (const bible of matching) {
      if (!bible.summary.trim() || !bible.rules.length) issues.push(`${bible.name} 缺少摘要或规则`);
      const missingReferences = await Promise.all(bible.referencePaths.map(async (candidate) => ({ candidate, valid: await readableNonEmpty(candidate) })));
      if (missingReferences.some((entry) => !entry.valid)) issues.push(`${bible.name} 的参考路径失效：${missingReferences.filter((entry) => !entry.valid).map((entry) => entry.candidate).join("、")}`);
    }
  }
  if (stageId === "storyboard") {
    if (!storyboard.rows.some((row) => row.status === "confirmed")) issues.push("没有已确认的正式分镜行");
    if (!storyboard.valid) issues.push(`正式分镜校验失败：${storyboard.issues.join("、")}`);
    const confirmedUnitIds = new Set(storyboard.rows.filter((row) => row.status === "confirmed").map((row) => row.itemId));
    const missingUnitIds = index.items.filter((item) => item.type === "unit" && !confirmedUnitIds.has(item.id)).map((item) => item.id);
    if (missingUnitIds.length) issues.push(`以下 15 秒单元没有已确认正式分镜：${missingUnitIds.join("、")}`);
  }
  if (stageId === "assets") {
    const assets = index.items.filter((item) => item.type === "asset");
    if (!assets.length) issues.push("扫描索引中没有角色、场景、道具或硬锁资产节点");
    const invalidAssets = assets.filter((item) => !index.artifacts.some((artifact) => artifact.itemId === item.id && artifact.authoritative && !artifact.deprecated && artifact.check.ok && artifact.check.size > 0 && artifact.check.decodable !== false));
    if (invalidAssets.length) issues.push(`以下资产没有当前权威且机械有效的文件：${invalidAssets.map((item) => item.id).join("、")}`);
  }
  const scope = scopeItemIds?.length ? new Set(scopeItemIds) : undefined;
  const activeUnits = index.items.filter((item) => item.type === "unit" && item.status !== "弃用" && (!scope || scope.has(item.id)));
  const authoritativeArtifacts = (itemId: string) => index.artifacts.filter((artifact) => artifact.itemId === itemId && artifact.authoritative && !artifact.deprecated);
  const mechanicallyValid = (artifact: (typeof index.artifacts)[number] | undefined) => Boolean(artifact?.check.ok && artifact.check.size > 0 && artifact.check.decodable !== false);
  const concise = (values: string[]) => `${values.slice(0, 12).join("、")}${values.length > 12 ? ` 等 ${values.length} 项` : ""}`;
  const fusionEvidence = ["frames", "video", "review"].includes(stageId)
    ? await loadFusionStoryboardEvidenceSnapshot(projectRoot)
    : undefined;
  const imageRequirementFor = (unit: (typeof activeUnits)[number], artifacts: (typeof index.artifacts)) => fusionEvidence
    ? buildFusionStoryboardReviewRequirement(unit, artifacts.filter((artifact) => artifact.itemId === unit.id), fusionEvidence)
    : undefined;
  if (stageId === "frames") {
    const incomplete: string[] = [];
    const unreviewed: string[] = [];
    for (const unit of activeUnits) {
      const artifacts = authoritativeArtifacts(unit.id);
      const requirement = imageRequirementFor(unit, index.artifacts);
      const required = unit.fusionStoryboard
        ? fusionStoryboardRequiredArtifacts(unit, index.artifacts)
        : (["start", "end"] as const).flatMap((variant) => [artifacts.find((artifact) => artifact.kind === "raw-image" && artifact.variant === variant), artifacts.find((artifact) => artifact.kind === "labeled-image" && artifact.variant === variant)]);
      if ((requirement && !requirement.complete) || required.some((artifact) => !mechanicallyValid(artifact))) {
        incomplete.push(unit.id);
        continue;
      }
      const review = reviewRecords.find((record) => record.itemId === unit.id
        && record.reviewType === "image"
        && (requirement
          ? reviewCoversFusionStoryboardRequirement(record, requirement, index.artifacts.filter((artifact) => artifact.itemId === unit.id))
          : reviewCoversArtifacts(record, required)));
      if (!review || review.decision !== "pass") unreviewed.push(unit.id);
    }
    if (!activeUnits.length) issues.push("扫描索引中没有可验收的 15 秒单元");
    if (incomplete.length) issues.push(`以下单元缺少当前权威首/尾帧 raw/labeled 配对或机械验收失败：${concise(incomplete)}`);
    if (unreviewed.length) issues.push(`以下单元没有绑定当前首尾帧版本的视觉通过记录：${concise(unreviewed)}`);
  }
  if (stageId === "video" || stageId === "review") {
    const invalidVideos: string[] = [];
    const unreviewedFrames: string[] = [];
    const unreviewedVideos: string[] = [];
    for (const unit of activeUnits) {
      const artifacts = authoritativeArtifacts(unit.id);
      const requirement = imageRequirementFor(unit, index.artifacts);
      const requiredFrames = unit.fusionStoryboard
        ? fusionStoryboardRequiredArtifacts(unit, index.artifacts)
        : (["start", "end"] as const).flatMap((variant) => [artifacts.find((artifact) => artifact.kind === "raw-image" && artifact.variant === variant), artifacts.find((artifact) => artifact.kind === "labeled-image" && artifact.variant === variant)]);
      const imageReview = reviewRecords.find((record) => record.itemId === unit.id
        && record.reviewType === "image"
        && record.decision === "pass"
        && (requirement
          ? reviewCoversFusionStoryboardRequirement(record, requirement, index.artifacts.filter((artifact) => artifact.itemId === unit.id))
          : reviewCoversArtifacts(record, requiredFrames)));
      if ((requirement && !requirement.complete) || requiredFrames.some((artifact) => !mechanicallyValid(artifact)) || !imageReview) unreviewedFrames.push(unit.id);
      const videos = authoritativeArtifacts(unit.id).filter((artifact) => artifact.kind === "video" && mechanicallyValid(artifact) && (artifact.check.duration ?? 0) > 0);
      if (!videos.length) {
        invalidVideos.push(unit.id);
        continue;
      }
      const review = reviewRecords.find((record) => record.itemId === unit.id && record.reviewType === "video" && reviewCoversAnyArtifact(record, videos));
      if (!review || review.decision !== "pass") unreviewedVideos.push(unit.id);
    }
    if (!activeUnits.length) issues.push("扫描索引中没有可验收的 15 秒单元");
    if (unreviewedFrames.length) issues.push(`以下单元的当前权威首/尾帧没有仍有效的视觉通过记录：${concise(unreviewedFrames)}`);
    if (invalidVideos.length) issues.push(`以下单元没有当前权威且可解码的有效视频：${concise(invalidVideos)}`);
    if (unreviewedVideos.length) issues.push(`以下单元没有绑定当前视频版本的视觉通过记录：${concise(unreviewedVideos)}`);
    if (stageId === "review") {
      if (index.summary.active > 0) issues.push(`仍有 ${index.summary.active} 个活跃生产单元未完成`);
      const reviewedRenders = renderJobs.filter((job) => job.status === "succeeded" && publicationReceipts.some((receipt) => receipt.context.purpose === "edit-render" && path.resolve(receipt.targetPath) === path.resolve(job.outputPath) && receipt.check.ok && receipt.check.sha256));
      if (!reviewedRenders.length) issues.push("导演总验收缺少已机械验收并登记回执的成片渲染");
    }
  }
  if (stageId === "edit") {
    if (paths.length === 0) issues.push("必须提供成片输出证据路径");
    const succeededRenders = renderJobs.filter((job) => job.status === "succeeded" && paths.some((candidate) => path.resolve(job.outputPath) === candidate));
    if (!editProjects.some((project) => project.tracks.some((track) => track.clips.length))) issues.push("没有包含真实片段的剪辑工程");
    if (!succeededRenders.length) issues.push("成片证据没有对应成功的后台渲染任务");
    const renderPaths = new Set(succeededRenders.map((job) => path.resolve(job.outputPath)));
    if (succeededRenders.length && !publicationReceipts.some((receipt) => receipt.context.purpose === "edit-render" && renderPaths.has(path.resolve(receipt.targetPath)) && receipt.check.ok && receipt.check.sha256)) issues.push("成功渲染没有对应的机械验收发布回执");
  }
  if (stageId === "publish") {
    if (paths.length === 0) issues.push("发布阶段必须提供不可变成片或发布记录路径");
    const receipt = publicationReceipts.find((candidate) => paths.includes(path.resolve(candidate.targetPath)) && candidate.kind === "video" && ["edit-render", "other"].includes(candidate.context.purpose) && candidate.check.ok && candidate.check.sha256 && (candidate.check.duration ?? 0) > 0);
    if (!receipt) issues.push("发布证据没有对应的不可变成片发布回执、SHA-256、有效时长和机械验收结果");
  }
  const unknownItems = itemIds.filter((id) => !index.items.some((item) => item.id === id));
  if (unknownItems.length) issues.push(`关联了不存在的生产节点：${unknownItems.join("、")}`);
  return issues;
}

async function evaluateProductionStage(projectRoot: string, workflow: ProductionWorkflow, stageId: ProductionWorkflowStageId, context: ProductionEvidenceContext, scopeItemIds?: string[]): Promise<ProductionStageEvidenceAudit> {
  const stage = workflow.stages.find((candidate) => candidate.id === stageId)!;
  const stageIndex = workflow.stages.findIndex((candidate) => candidate.id === stageId);
  const priorIncomplete = workflow.stages.slice(0, stageIndex).filter((candidate) => candidate.status !== "completed");
  const issues = await stageCompletionIssues(projectRoot, stageId, stage.evidencePaths, stage.itemIds, context, scopeItemIds);
  if (priorIncomplete.length) issues.unshift(`前置阶段尚未完成：${priorIncomplete.map((candidate) => candidate.name).join("、")}`);
  const metrics = evidenceMetrics(context);
  const checkedAt = new Date().toISOString();
  const fingerprint = evidenceFingerprint(stageId, stage.evidencePaths, stage.itemIds, issues, metrics);
  const ready = issues.length === 0;
  return { stageId, ready, statusEvidenceValid: stage.status !== "completed" || ready, legacyUnverified: stage.status === "completed" && !stage.evidenceVerification, issues, metrics, checkedAt, fingerprint };
}

export async function auditProductionWorkflow(projectRoot: string, workflowInput?: ProductionWorkflow): Promise<ProductionWorkflowEvidenceAudit> {
  const workflow = workflowInput ?? await getProductionWorkflow(projectRoot);
  const context = await loadProductionEvidenceContext(projectRoot);
  const stages: ProductionStageEvidenceAudit[] = [];
  for (const stage of workflow.stages) stages.push(await evaluateProductionStage(projectRoot, workflow, stage.id, context));
  const completed = workflow.stages.filter((stage) => stage.status === "completed");
  return {
    schemaVersion: 1,
    workflowRevision: workflow.revision,
    valid: stages.every((stage) => stage.statusEvidenceValid),
    readyStageCount: stages.filter((stage) => stage.ready).length,
    completedStageCount: completed.length,
    verifiedCompletedStageCount: completed.filter((stage) => stage.evidenceVerification).length,
    stages,
    checkedAt: new Date().toISOString(),
  };
}

export async function updateProductionWorkflowStage(
  projectRoot: string,
  input: ProductionWorkflowStageUpdateInput,
  actor: "user" | "codex" = "codex",
): Promise<ProductionWorkflow> {
  return withProjectLock(projectRoot, "production", async () => {
  const workflow = await getProductionWorkflow(projectRoot);
  assertExistingRevision({ entityType: "production_workflow", entityLabel: "生产工作流", expectedRevision: input.expectedRevision, currentRevision: workflow.revision, allowZero: true });
  const stageIndex = workflow.stages.findIndex((stage) => stage.id === input.stageId);
  if (stageIndex < 0) throw new Error(`未知生产阶段：${input.stageId}`);
  const previousStage = workflow.stages[stageIndex]!;
  const evidencePaths = [...new Set((input.evidencePaths ?? previousStage.evidencePaths).map((candidate) => path.resolve(candidate)))];
  const itemIds = [...new Set(input.itemIds ?? previousStage.itemIds)];
  let evidenceVerification = input.status === "completed" ? previousStage.evidenceVerification : undefined;
  if (input.status === "completed") {
    const prior = workflow.stages.slice(0, stageIndex).filter((stage) => stage.status !== "completed");
    if (prior.length) throw new Error(`前置阶段尚未完成：${prior.map((stage) => stage.name).join("、")}`);
    const context = await loadProductionEvidenceContext(projectRoot);
    const stalePrior: string[] = [];
    for (const stage of workflow.stages.slice(0, stageIndex).filter((candidate) => candidate.evidenceVerification)) {
      const priorIssues = await stageCompletionIssues(projectRoot, stage.id, stage.evidencePaths, stage.itemIds, context);
      if (priorIssues.length) stalePrior.push(`${stage.name}：${priorIssues.join("、")}`);
    }
    if (stalePrior.length) throw new Error(`前置阶段真实证据已失效：${stalePrior.join("；")}；必须先修复并重新核验，不能继续标记下游完成。`);
    const issues = await stageCompletionIssues(projectRoot, input.stageId, evidencePaths, itemIds, context);
    if (issues.length) throw new Error(`阶段完成门禁未通过：${issues.join("；")}`);
    evidenceVerification = {
      checkedAt: new Date().toISOString(),
      fingerprint: evidenceFingerprint(input.stageId, evidencePaths, itemIds, [], evidenceMetrics(context)),
      workflowRevision: workflow.revision + 1,
    };
  }
  const now = new Date().toISOString();
  const normalizeLines = (values: string[] | undefined, fallback: string[]) => values ? [...new Set(values.map((value) => value.trim()).filter(Boolean))].slice(0, 300) : fallback;
  const nextStage = { ...previousStage, status: input.status, note: input.note?.trim().slice(0, 20_000) || undefined, evidencePaths, itemIds, inputRequirements: normalizeLines(input.inputRequirements, previousStage.inputRequirements), outputRequirements: normalizeLines(input.outputRequirements, previousStage.outputRequirements), acceptanceCriteria: normalizeLines(input.acceptanceCriteria, previousStage.acceptanceCriteria), failurePaths: normalizeLines(input.failurePaths, previousStage.failurePaths), nextActions: normalizeLines(input.nextActions, previousStage.nextActions), evidenceVerification, updatedAt: now };
  const materialStage = (stage: typeof previousStage) => JSON.stringify({ status: stage.status, evidencePaths: stage.evidencePaths, itemIds: stage.itemIds, inputRequirements: stage.inputRequirements, outputRequirements: stage.outputRequirements, acceptanceCriteria: stage.acceptanceCriteria, failurePaths: stage.failurePaths, nextActions: stage.nextActions });
  const materialChanged = materialStage(previousStage) !== materialStage(nextStage);
  workflow.stages[stageIndex] = nextStage;
  const invalidatedStageIds: ProductionWorkflowStageId[] = [];
  if (materialChanged) {
    workflow.stages = workflow.stages.map((stage, index) => {
      if (index <= stageIndex || !["completed", "review", "in_progress"].includes(stage.status)) return stage;
      invalidatedStageIds.push(stage.id);
      return { ...stage, status: "blocked" as const, note: `上游阶段“${previousStage.name}”在修订 ${workflow.revision + 1} 中发生变化，必须重新验证本阶段证据。`, updatedAt: now };
    });
  }
  workflow.revision += 1;
  workflow.updatedAt = now;
  await writeJsonAtomic(getSidecarPaths(projectRoot).productionWorkflow, workflow);
  await appendEvent(projectRoot, { actor, type: "production.workflow-stage-updated", data: { stageId: input.stageId, status: input.status, revision: workflow.revision, evidencePaths, itemIds, invalidatedStageIds } });
  return workflow;
  });
}

interface BibleStore { schemaVersion: 1; revision: number; bibles: CreativeBible[]; updatedAt: string }
async function loadBibleStore(projectRoot: string): Promise<BibleStore> {
  return readJson(getSidecarPaths(projectRoot).creativeBibles, { schemaVersion: 1, revision: 0, bibles: [], updatedAt: new Date(0).toISOString() });
}

export async function listCreativeBibles(projectRoot: string, kind?: CreativeBibleKind): Promise<CreativeBible[]> {
  return (await loadBibleStore(projectRoot)).bibles.filter((bible) => !kind || bible.kind === kind).sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name, "zh-CN"));
}

export async function upsertCreativeBible(
  projectRoot: string,
  input: CreativeBibleUpsertInput,
  actor: "user" | "codex" = "codex",
): Promise<CreativeBible> {
  return withProjectLock(projectRoot, "production", async () => {
  const store = await loadBibleStore(projectRoot);
  const existing = typeof input.id === "string" && input.id.trim() ? store.bibles.find((bible) => bible.id === input.id) : undefined;
  assertRevisionedUpsert({ id: input.id, expectedRevision: input.expectedRevision, currentRevision: existing?.revision, entityType: "creative_bible", entityLabel: "创作 Bible" });
  const referencePaths = [...new Set((input.referencePaths ?? existing?.referencePaths ?? []).map((candidate) => path.resolve(candidate)))];
  const missing = await Promise.all(referencePaths.map(async (candidate) => await access(candidate).then(() => "").catch(() => candidate)));
  if (missing.some(Boolean)) throw new Error(`Bible 参考路径不存在：${missing.filter(Boolean).join("、")}`);
  const now = new Date().toISOString();
  const bible: CreativeBible = {
    schemaVersion: 1,
    id: existing?.id ?? `bible-${randomUUID()}`,
    kind: input.kind,
    name: input.name.trim().slice(0, 160),
    summary: input.summary.trim().slice(0, 30_000),
    rules: [...new Set((input.rules ?? existing?.rules ?? []).map((rule) => rule.trim()).filter(Boolean))].slice(0, 300),
    forbidden: [...new Set((input.forbidden ?? existing?.forbidden ?? []).map((rule) => rule.trim()).filter(Boolean))].slice(0, 300),
    referencePaths,
    tags: [...new Set((input.tags ?? existing?.tags ?? []).map((tag) => tag.trim()).filter(Boolean))].slice(0, 100),
    revision: (existing?.revision ?? 0) + 1,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  store.bibles = [bible, ...store.bibles.filter((candidate) => candidate.id !== bible.id)];
  store.revision += 1;
  store.updatedAt = now;
  await writeJsonAtomic(getSidecarPaths(projectRoot).creativeBibles, store);
  await appendEvent(projectRoot, { actor, type: "production.bible-upserted", data: { bibleId: bible.id, kind: bible.kind, revision: bible.revision } });
  return bible;
  });
}

async function loadStoryboardStore(projectRoot: string): Promise<StoryboardStore> {
  return readJson(getSidecarPaths(projectRoot).storyboards, { schemaVersion: 1, revision: 0, rows: [], updatedAt: new Date(0).toISOString() });
}

export async function getStoryboard(projectRoot: string, itemId?: string): Promise<{ revision: number; rows: StoryboardRow[]; totalDurationSeconds: number; valid: boolean; issues: string[] }> {
  const store = await loadStoryboardStore(projectRoot);
  const rows = store.rows.filter((row) => !itemId || row.itemId === itemId).sort((a, b) => a.itemId.localeCompare(b.itemId) || a.order - b.order);
  const active = rows.filter((row) => row.status !== "deprecated");
  const issues: string[] = [];
  const groups = new Map<string, StoryboardRow[]>();
  for (const row of active) groups.set(row.itemId, [...(groups.get(row.itemId) ?? []), row]);
  for (const [unitId, unitRows] of groups) {
    const duration = unitRows.reduce((sum, row) => sum + row.durationSeconds, 0);
    if (unitRows.length > 6) issues.push(`${unitId} 超过 6 镜`);
    if (duration > 15.001) issues.push(`${unitId} 累计 ${duration.toFixed(2)} 秒，超过 15 秒`);
    const orders = unitRows.map((row) => row.order);
    if (new Set(orders).size !== orders.length) issues.push(`${unitId} 存在重复镜头顺序`);
    for (const row of unitRows.filter((candidate) => candidate.status === "confirmed")) {
      const requiredFields: Array<[string, string]> = [
        ["景别", row.shotSize],
        ["运镜", row.cameraMovement],
        ["动作", row.action],
        ["首帧提示词", row.firstFramePrompt],
        ["尾帧提示词", row.endFramePrompt],
        ["视频提示词", row.videoPrompt],
      ];
      const missing = requiredFields.filter(([, value]) => !value.trim()).map(([label]) => label);
      if (missing.length) issues.push(`${row.id} 已确认但缺少${missing.join("、")}`);
    }
  }
  return { revision: store.revision, rows, totalDurationSeconds: active.reduce((sum, row) => sum + row.durationSeconds, 0), valid: issues.length === 0, issues };
}

export async function upsertStoryboardRow(
  projectRoot: string,
  rawInput: StoryboardRowUpsertInput,
  actor: "user" | "codex" = "codex",
): Promise<StoryboardRow> {
  return withProjectLock(projectRoot, "production", async () => {
  const [store, index] = await Promise.all([loadStoryboardStore(projectRoot), getProjectIndex(projectRoot)]);
  const existing = rawInput.id ? store.rows.find((row) => row.id === rawInput.id) : undefined;
  if (rawInput.id && !existing) throw new Error(`找不到分镜行：${rawInput.id}`);
  if (existing && rawInput.expectedRevision === undefined) throw new Error("修订正式分镜必须提供 expectedRevision。 ");
  if (existing && existing.revision !== rawInput.expectedRevision) throw new Error(`分镜行已被其他窗口更新（当前修订 ${existing.revision}）。`);
  const definedPatch = Object.fromEntries(Object.entries(rawInput).filter(([, value]) => value !== undefined)) as StoryboardRowUpsertInput;
  const mergedInput = existing ? { ...existing, ...definedPatch } : definedPatch;
  const requiredCreateFields: Array<[string, unknown]> = [
    ["真实 15 秒单元", mergedInput.itemId],
    ["镜头顺序", mergedInput.order],
    ["镜头时长", mergedInput.durationSeconds],
    ["景别", mergedInput.shotSize],
    ["运镜", mergedInput.cameraMovement],
    ["动作", mergedInput.action],
    ["首帧提示词", mergedInput.firstFramePrompt],
    ["尾帧提示词", mergedInput.endFramePrompt],
    ["视频提示词", mergedInput.videoPrompt],
    ["分镜状态", mergedInput.status],
  ];
  const missingCreateFields = requiredCreateFields.filter(([, value]) => value === undefined || value === null).map(([label]) => label);
  if (missingCreateFields.length) throw new Error(`正式分镜输入不完整：${missingCreateFields.join("、")}`);
  const input = { ...mergedInput, referencePaths: mergedInput.referencePaths ?? [] } as StoryboardRowInputFields & { id?: string; expectedRevision?: number };
  const mutableInput = input as unknown as Record<string, unknown>;
  for (const key of ["shotItemId", "cameraAngle", "lens", "composition", "staging", "expression", "emotion", "eyeline", "screenDirection", "axisSide", "dialogue", "narration", "ambience", "continuityBefore", "continuityAfter", "adaptationPlanId", "adaptationUnitId", "directorIntent", "emotionalIntent"]) {
    const value = mutableInput[key];
    if (typeof value === "string") mutableInput[key] = value.trim() || undefined;
  }
  const unit = index.items.find((item) => item.id === input.itemId && item.type === "unit");
  if (!unit) throw new Error(`正式分镜必须关联真实 15 秒单元：${input.itemId}`);
  if (input.shotItemId) {
    const shot = index.items.find((item) => item.id === input.shotItemId && item.type === "shot" && item.parentId === unit.id);
    if (!shot) throw new Error("shotItemId 不是该 15 秒单元下的真实原镜头。 ");
  }
  if (!Number.isInteger(input.order) || input.order < 1 || input.order > 999) throw new Error("分镜顺序必须是 1–999 的整数。 ");
  if (!Number.isFinite(input.durationSeconds) || input.durationSeconds <= 0 || input.durationSeconds > 15) throw new Error("单镜时长必须大于 0 且不超过 15 秒。 ");
  const referencePaths = [...new Set(input.referencePaths.map((candidate) => path.resolve(candidate)))].slice(0, 100);
  const missingReferencePaths = await Promise.all(referencePaths.map(async (candidate) => await access(candidate).then(() => "").catch(() => candidate)));
  if (missingReferencePaths.some(Boolean)) throw new Error(`分镜参考路径不存在：${missingReferencePaths.filter(Boolean).join("、")}`);
  const referenceArtifactIds = [...new Set(input.referenceArtifactIds ?? existing?.referenceArtifactIds ?? [])].slice(0, 100);
  const invalidArtifactIds = referenceArtifactIds.filter((id) => {
    const artifact = index.artifacts.find((candidate) => candidate.id === id);
    return !artifact || artifact.deprecated || !artifact.check.ok;
  });
  if (invalidArtifactIds.length) throw new Error(`分镜引用了不存在、弃用或机械验收失败的资产：${invalidArtifactIds.join("、")}`);
  if (input.status === "confirmed") {
    const requiredFields: Array<[string, string]> = [
      ["景别", input.shotSize],
      ["运镜", input.cameraMovement],
      ["动作", input.action],
      ["首帧提示词", input.firstFramePrompt],
      ["尾帧提示词", input.endFramePrompt],
      ["视频提示词", input.videoPrompt],
    ];
    const required = requiredFields.filter(([, value]) => !value.trim()).map(([label]) => label);
    if (required.length) throw new Error(`确认正式分镜前必须补齐：${required.join("、")}`);
  }
  const normalizeRefs = (values: typeof input.upstreamFactRefs | undefined) => [...new Map((values ?? []).map((entry) => [entry.id, { id: entry.id.trim(), revision: entry.revision }])).values()].filter((entry) => entry.id && Number.isInteger(entry.revision) && entry.revision > 0).slice(0, 200);
  const upstreamFactRefs = normalizeRefs(input.upstreamFactRefs ?? existing?.upstreamFactRefs);
  const upstreamBeatRefs = normalizeRefs(input.upstreamBeatRefs ?? existing?.upstreamBeatRefs);
  const sourceSpans = [...(input.sourceSpans ?? existing?.sourceSpans ?? [])].slice(0, 200);
  if (sourceSpans.some((span) => !span.sourceId || !span.chapterId || !span.chapterSha256 || !Number.isInteger(span.chapterRevision) || span.chapterRevision < 1 || !Number.isInteger(span.startOffset) || !Number.isInteger(span.endOffset) || span.startOffset < 0 || span.endOffset <= span.startOffset || !span.text.trim())) throw new Error("分镜上游来源片段结构不合法。 ");
  if (input.status === "confirmed" && (upstreamFactRefs.length || upstreamBeatRefs.length || sourceSpans.length)) {
    const paths = getSidecarPaths(projectRoot);
    const [adaptation, library] = await Promise.all([readJson<AdaptationStore | null>(paths.storyAdaptation, null), readJson<StoryLibrary | null>(paths.storyIndex, null)]);
    if (!adaptation || !library) throw new Error("确认自动改编分镜前必须保留可读取的改编工作区与章节索引。 ");
    const staleFacts = upstreamFactRefs.filter((ref) => adaptation.facts.find((fact) => fact.id === ref.id)?.revision !== ref.revision);
    const staleBeats = upstreamBeatRefs.filter((ref) => adaptation.beats.find((beat) => beat.id === ref.id)?.revision !== ref.revision);
    const staleSpans = sourceSpans.filter((span) => { const chapter = library.chapters.find((candidate) => candidate.id === span.chapterId); return !chapter || chapter.revision !== span.chapterRevision || chapter.sha256 !== span.chapterSha256; });
    if (staleFacts.length || staleBeats.length || staleSpans.length) throw new Error(`自动改编分镜的上游证据已变化，必须重新生成或人工对齐：${[...staleFacts.map((ref) => ref.id), ...staleBeats.map((ref) => ref.id), ...staleSpans.map((span) => span.chapterId)].join("、")}`);
  }
  const continuityNotes = [...new Set((input.continuityNotes ?? existing?.continuityNotes ?? []).map((value) => value.trim()).filter(Boolean))].slice(0, 100);
  const now = new Date().toISOString();
  const row: StoryboardRow = { ...input, id: existing?.id ?? `storyboard-${randomUUID()}`, referencePaths, referenceArtifactIds, upstreamFactRefs, upstreamBeatRefs, sourceSpans, continuityNotes, directorIntent: input.directorIntent?.slice(0, 2_000), emotionalIntent: input.emotionalIntent?.slice(0, 2_000), adaptationPlanId: input.adaptationPlanId, adaptationUnitId: input.adaptationUnitId, revision: (existing?.revision ?? 0) + 1, createdAt: existing?.createdAt ?? now, updatedAt: now };
  delete (row as StoryboardRow & { expectedRevision?: number }).expectedRevision;
  const candidateRows = [row, ...store.rows.filter((candidate) => candidate.id !== row.id)];
  const unitRows = candidateRows.filter((candidate) => candidate.itemId === unit.id && candidate.status !== "deprecated");
  if (unitRows.length > 6) throw new Error("同一 15 秒单元最多 6 个分镜。 ");
  if (unitRows.reduce((sum, candidate) => sum + candidate.durationSeconds, 0) > 15.001) throw new Error("同一 15 秒单元分镜累计不能超过 15 秒。 ");
  if (new Set(unitRows.map((candidate) => candidate.order)).size !== unitRows.length) throw new Error("同一 15 秒单元不能出现重复分镜顺序。 ");
  store.rows = candidateRows;
  store.revision += 1;
  store.updatedAt = now;
  await writeJsonAtomic(getSidecarPaths(projectRoot).storyboards, store);
  await appendEvent(projectRoot, { actor, type: "production.storyboard-upserted", itemId: unit.id, data: { storyboardId: row.id, shotItemId: row.shotItemId, status: row.status, revision: row.revision } });
  return row;
  });
}

export async function getConfirmedStoryboardContracts(
  projectRoot: string,
  itemIds: string[],
  target?: GenerationKind | "video_continuation",
): Promise<{ revision: number; byItemId: Map<string, StoryboardProductionContract[]> }> {
  const paths = getSidecarPaths(projectRoot);
  const [store, index, adaptation, library, workflow] = await Promise.all([loadStoryboardStore(projectRoot), getProjectIndex(projectRoot), readJson<AdaptationStore | null>(paths.storyAdaptation, null), readJson<StoryLibrary | null>(paths.storyIndex, null), getProductionWorkflow(projectRoot)]);
  const byItemId = new Map<string, StoryboardProductionContract[]>();
  const artifactMap = new Map(index.artifacts.map((artifact) => [artifact.id, artifact]));
  let usedBaseline = false;
  for (const itemId of [...new Set(itemIds)]) {
    const item = index.items.find((candidate) => candidate.id === itemId);
    if (!item || !["unit", "shot"].includes(item.type)) throw new Error(`正式分镜合同无法映射真实生产节点：${itemId}`);
    const rows = store.rows
      .filter((row) => row.status === "confirmed" && (item.type === "unit" ? row.itemId === item.id : row.shotItemId === item.id))
      .sort((a, b) => a.order - b.order);
    if (!rows.length) {
      const targets = target ? [target] : ["image", "video_continuation"] as const;
      let baseline: ExistingProductionBaseline | undefined;
      for (const candidateTarget of targets) {
        const match = await matchingExistingProductionBaseline(projectRoot, workflow, candidateTarget, [item.id]);
        if (match.issues?.length) throw new Error(`既有制作包接管基线真实证据已失效：${match.issues.join("；")}；请重新预检与接管。`);
        if (match.baseline) { baseline = match.baseline; break; }
      }
      const contracts = baseline?.contracts
        .filter((contract) => baselineTargetItemId(contract) === item.id)
        .sort((left, right) => left.order - right.order)
        .map((contract) => structuredClone(contract));
      if (!contracts?.length) throw new Error(`节点 ${item.id} 没有已确认的正式分镜，不能创建任务或加入生成队列。`);
      byItemId.set(itemId, contracts);
      usedBaseline = true;
      continue;
    }
    for (const row of rows) {
      const required = [row.shotSize, row.cameraMovement, row.action, row.firstFramePrompt, row.endFramePrompt, row.videoPrompt];
      if (required.some((value) => !value?.trim())) throw new Error(`正式分镜 ${row.id} 的生成合同字段不完整，不能创建任务或加入生成队列。`);
      const missingPaths = await Promise.all(row.referencePaths.map(async (candidate) => await access(candidate).then(() => "").catch(() => candidate)));
      if (missingPaths.some(Boolean)) throw new Error(`正式分镜 ${row.id} 的参考路径已经失效：${missingPaths.filter(Boolean).join("、")}`);
      if (row.upstreamFactRefs?.length || row.upstreamBeatRefs?.length || row.sourceSpans?.length) {
        if (!adaptation || !library) throw new Error(`正式分镜 ${row.id} 缺少可读取的自动改编上游证据。`);
        const staleFacts = (row.upstreamFactRefs ?? []).filter((ref) => adaptation.facts.find((fact) => fact.id === ref.id)?.revision !== ref.revision);
        const staleBeats = (row.upstreamBeatRefs ?? []).filter((ref) => adaptation.beats.find((beat) => beat.id === ref.id)?.revision !== ref.revision);
        const staleSpans = (row.sourceSpans ?? []).filter((span) => { const chapter = library.chapters.find((candidate) => candidate.id === span.chapterId); return !chapter || chapter.revision !== span.chapterRevision || chapter.sha256 !== span.chapterSha256; });
        if (staleFacts.length || staleBeats.length || staleSpans.length) throw new Error(`正式分镜 ${row.id} 的小说事实、节拍或章节证据已变化，旧合同不能继续生产。`);
      }
    }
    const contracts = rows.map((row): StoryboardProductionContract => {
      const referenceArtifactIds = [...new Set(row.referenceArtifactIds ?? [])];
      const invalidArtifactIds = referenceArtifactIds.filter((id) => {
        const artifact = artifactMap.get(id);
        return !artifact || artifact.deprecated || !artifact.check.ok;
      });
      if (invalidArtifactIds.length) throw new Error(`正式分镜 ${row.id} 的资产引用已经失效：${invalidArtifactIds.join("、")}`);
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
        referencePaths: [...new Set([
          ...row.referencePaths,
          ...referenceArtifactIds.map((id) => artifactMap.get(id)?.path).filter((value): value is string => Boolean(value)),
        ])],
        referenceArtifactIds,
        upstreamFactRefs: row.upstreamFactRefs,
        upstreamBeatRefs: row.upstreamBeatRefs,
        sourceSpans: row.sourceSpans,
        adaptationPlanId: row.adaptationPlanId,
        adaptationUnitId: row.adaptationUnitId,
        directorIntent: row.directorIntent,
        emotionalIntent: row.emotionalIntent,
        continuityNotes: row.continuityNotes,
      };
    });
    byItemId.set(itemId, contracts);
  }
  return { revision: usedBaseline ? Math.max(store.revision, workflow.revision) : store.revision, byItemId };
}

export async function analyzeChangeImpact(projectRoot: string, input: { targetType: "item" | "story_event" | "hard_lock" | "bible"; targetId: string }) {
  const [index, storyEvents, tasks, generationJobs, editProjects, bibles, storyboard] = await Promise.all([getProjectIndex(projectRoot), withStory((story) => story.listStoryEvents(projectRoot, { includeOrphans: true })), listTaskPacks(projectRoot), listGenerationJobs(projectRoot), withEditor((editor) => editor.listEditProjects(projectRoot)), listCreativeBibles(projectRoot), getStoryboard(projectRoot)]);
  const itemIds = new Set<string>();
  const artifactIds = new Set<string>();
  const eventIds = new Set<string>();
  if (input.targetType === "item") itemIds.add(input.targetId);
  if (input.targetType === "hard_lock") for (const item of index.items) if (item.hardLockIds.includes(input.targetId)) itemIds.add(item.id);
  if (input.targetType === "story_event") {
    const queue = [input.targetId];
    while (queue.length) {
      const current = queue.shift()!;
      if (eventIds.has(current)) continue;
      eventIds.add(current);
      const event = storyEvents.find((candidate) => candidate.id === current);
      event?.itemIds.forEach((id) => itemIds.add(id));
      storyEvents.filter((candidate) => candidate.dependencyIds.includes(current)).forEach((candidate) => queue.push(candidate.id));
    }
  }
  if (input.targetType === "bible" && !bibles.some((bible) => bible.id === input.targetId)) throw new Error(`找不到 Bible：${input.targetId}`);
  const queue = [...itemIds];
  while (queue.length) {
    const current = queue.shift()!;
    for (const item of index.items) if ((item.parentId === current || item.dependencies.includes(current)) && !itemIds.has(item.id)) { itemIds.add(item.id); queue.push(item.id); }
  }
  for (const item of index.items) if (itemIds.has(item.id)) item.artifactIds.forEach((id) => artifactIds.add(id));
  const affectedTasks = tasks.filter((task) => task.itemIds.some((id) => itemIds.has(id)));
  const affectedJobs = generationJobs.filter((job) => itemIds.has(job.itemId));
  const affectedEditClips = editProjects.flatMap((project) => project.tracks.flatMap((track) => track.clips.filter((clip) => (clip.itemId && itemIds.has(clip.itemId)) || (clip.artifactId && artifactIds.has(clip.artifactId))).map((clip) => ({ editProjectId: project.id, editProjectName: project.name, revision: project.revision, trackId: track.id, clipId: clip.id, clipName: clip.name }))));
  const affectedStoryboard = storyboard.rows.filter((row) => itemIds.has(row.itemId) || Boolean(row.shotItemId && itemIds.has(row.shotItemId)));
  return {
    target: input,
    severity: affectedEditClips.length || affectedJobs.some((job) => job.status === "succeeded") ? "high" : itemIds.size || affectedTasks.length ? "medium" : "low",
    affectedItemIds: [...itemIds],
    affectedEventIds: [...eventIds],
    affectedArtifactIds: [...artifactIds],
    taskPacks: affectedTasks.map((task) => ({ id: task.id, status: task.status, itemIds: task.itemIds })),
    generationJobs: affectedJobs.map((job) => ({ id: job.id, status: job.status, itemId: job.itemId, resultPath: job.resultPath })),
    editClips: affectedEditClips,
    storyboardRows: affectedStoryboard.map((row) => ({ id: row.id, itemId: row.itemId, shotItemId: row.shotItemId, status: row.status })),
    recommendedActions: ["不要直接覆盖已有素材或成片", "先确认变更范围，再把受影响节点标为返工", "为重新生成创建新任务包和新版本路径", "重新执行视觉验收并更新剪辑工程"],
  };
}
