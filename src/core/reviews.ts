import { randomUUID } from "node:crypto";
import { appendEvent, getSidecarPaths, loadOverrides, readJson, writeJsonAtomic } from "./sidecar.js";
import { getProjectIndex, previewProjectScan, reconcileTaskReviews, scanAndPersist, updateStatus } from "./service.js";
import {
  artifactReviewEvidence,
  fusionVisualReviewRuleRequirements,
  reviewCoversArtifacts,
  reviewCoversFusionStoryboardRequirement,
} from "./review-evidence.js";
import { buildFusionStoryboardReviewRequirement, fusionStoryboardRequiredArtifacts, loadFusionStoryboardEvidenceSnapshot } from "./fusion-storyboard-evidence.js";
import { REVIEW_ANNOTATION_TYPES, REVIEW_CRITERIA_KEYS, type Artifact, type FusionStoryboardReviewRequirement, type FusionVisualReviewRuleAttestation, type ProjectEvent, type ReviewAnnotation, type ReviewAnnotationInput, type ReviewCriterion, type ReviewCriterionKey, type ReviewDecision, type ReviewRecord, type ReviewStore, type SubmitReviewInput, type WorkItem, type WorkItemStatus } from "./types.js";
import { withProjectLock } from "./locks.js";
import { ConfirmedCommandFailure, RejectedCommandFailure } from "./command-outcome.js";
import { loadCanonicalAssetStore } from "./canonical-assets.js";

const IMAGE_CRITERIA: ReviewCriterionKey[] = ["character_identity", "hard_lock", "prop_costume", "scene_continuity", "composition", "image_quality", "raw_labeled_pair"];
const VIDEO_CRITERIA: ReviewCriterionKey[] = ["character_identity", "hard_lock", "prop_costume", "scene_continuity", "motion_continuity", "duration_audio", "image_quality"];

export interface ReviewSubmissionOptions {
  /** 测试与并发门禁：首次内容快照完成后、最终 CAS 扫描前执行。 */
  beforeCommit?: (snapshot: { itemId: string; scanId: string; artifactHashes: Record<string, string> }) => void | Promise<void>;
  /** 测试门禁：最终扫描完成后、ReviewRecord 原子写入前模拟外部文件替换。 */
  afterFinalScanBeforeRecord?: (snapshot: { itemId: string; scanId: string; artifactHashes: Record<string, string> }) => void | Promise<void>;
}

async function loadStore(projectRoot: string): Promise<ReviewStore> {
  return readJson(getSidecarPaths(projectRoot).reviews, { schemaVersion: 1, records: [] });
}

export async function listReviewRecords(
  projectRoot: string,
  options: { itemId?: string; decision?: ReviewDecision; limit?: number } = {},
): Promise<ReviewRecord[]> {
  const store = await loadStore(projectRoot);
  return store.records
    .filter((record) => !options.itemId || record.itemId === options.itemId)
    .filter((record) => !options.decision || record.decision === options.decision)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, Math.max(1, Math.min(options.limit ?? 200, 1_000)));
}

function requiredArtifactIssues(
  item: WorkItem,
  artifacts: Artifact[],
  reviewType: "image" | "video",
  requirement?: FusionStoryboardReviewRequirement,
): string[] {
  if (reviewType === "image" && requirement) return requirement.complete ? [] : requirement.issues.length ? requirement.issues : ["当前宫格合同图片 requirement 不完整"];
  const active = artifacts.filter((artifact) => artifact.authoritative && !artifact.deprecated);
  const issues: string[] = [];
  const requireOne = (label: string, kind: Artifact["kind"], variants?: Artifact["variant"][]) => {
    const match = active.find((artifact) => artifact.kind === kind && (!variants || variants.includes(artifact.variant)));
    if (!match) issues.push(`缺少${label}`);
    else if (!match.check.ok) issues.push(`${label}机械验收失败`);
  };
  if (reviewType === "image" && item.type === "asset") {
    requireOne("权威资产 raw", "raw-image", ["generic"]);
    const labeled = active.find((artifact) => artifact.kind === "labeled-image" && artifact.variant === "generic");
    if (labeled && !labeled.check.ok) issues.push("权威资产 labeled 机械验收失败");
  } else if (reviewType === "image" && item.type === "shot") {
    requireOne("原镜头 raw", "raw-image", ["generic", "start"]);
    requireOne("原镜头 labeled", "labeled-image", ["generic", "start"]);
  } else {
    requireOne("首帧 raw", "raw-image", ["start"]);
    requireOne("首帧 labeled", "labeled-image", ["start"]);
    requireOne("尾帧 raw", "raw-image", ["end"]);
    requireOne("尾帧 labeled", "labeled-image", ["end"]);
    if (reviewType === "video") requireOne("可解码视频", "video");
  }
  return issues;
}

function passSelectionIssues(
  item: WorkItem,
  artifacts: Artifact[],
  reviewType: "image" | "video",
  selectedIds: Set<string>,
  requirement?: FusionStoryboardReviewRequirement,
): string[] {
  const active = artifacts.filter((artifact) => artifact.authoritative && !artifact.deprecated);
  if (reviewType === "video") {
    const videos = active.filter((artifact) => artifact.kind === "video" && artifact.check.ok && artifact.check.decodable !== false);
    return videos.some((artifact) => selectedIds.has(artifact.id)) ? [] : ["视频通过验收必须关联当前权威视频版本"];
  }
  if (requirement) {
    if (!requirement.complete) return requirement.issues.length ? requirement.issues : ["当前宫格合同图片 requirement 不完整"];
    const expected = [...requirement.artifactIds].sort();
    const selected = [...selectedIds].sort();
    return JSON.stringify(expected) === JSON.stringify(selected)
      ? []
      : [`宫格通过验收必须精确关联当前 ${requirement.panelCount} 格的 ${requirement.panelCount * 2} 个 raw/labeled 文件`];
  }
  const requirements = item.type === "asset"
    ? [
        { kind: "raw-image" as const, variants: ["generic"] as Artifact["variant"][] },
        ...(active.some((artifact) => artifact.kind === "labeled-image" && artifact.variant === "generic")
          ? [{ kind: "labeled-image" as const, variants: ["generic"] as Artifact["variant"][] }]
          : []),
      ]
    : item.type === "shot"
    ? [{ kind: "raw-image" as const, variants: ["generic", "start"] as Artifact["variant"][] }, { kind: "labeled-image" as const, variants: ["generic", "start"] as Artifact["variant"][] }]
    : [
        { kind: "raw-image" as const, variants: ["start"] as Artifact["variant"][] },
        { kind: "labeled-image" as const, variants: ["start"] as Artifact["variant"][] },
        { kind: "raw-image" as const, variants: ["end"] as Artifact["variant"][] },
        { kind: "labeled-image" as const, variants: ["end"] as Artifact["variant"][] },
      ];
  const missing = requirements
    .map((requirement) => active.find((artifact) => artifact.kind === requirement.kind && requirement.variants.includes(artifact.variant)))
    .filter((artifact) => !artifact || !selectedIds.has(artifact.id));
  return missing.length ? [
    item.type === "asset"
      ? "资产通过验收必须关联当前权威 generic raw，存在 generic labeled 时必须成对关联"
      : item.type === "shot"
        ? "原镜头通过验收必须关联当前权威 raw/labeled 配对版本"
        : "首尾帧通过验收必须关联当前权威首/尾帧 raw/labeled 配对版本",
  ] : [];
}

function currentImageArtifacts(item: WorkItem, artifacts: Artifact[]): Array<Artifact | undefined> {
  if (item.fusionStoryboard) return fusionStoryboardRequiredArtifacts(item, artifacts);
  const active = artifacts.filter((artifact) => artifact.authoritative && !artifact.deprecated);
  const find = (kind: Artifact["kind"], variants: Artifact["variant"][]) => active.find((artifact) => artifact.kind === kind && variants.includes(artifact.variant));
  if (item.type === "asset") {
    const raw = find("raw-image", ["generic"]);
    const labeled = find("labeled-image", ["generic"]);
    return labeled ? [raw, labeled] : [raw];
  }
  if (item.type === "shot") return [find("raw-image", ["generic", "start"]), find("labeled-image", ["generic", "start"])];
  return [find("raw-image", ["start"]), find("labeled-image", ["start"]), find("raw-image", ["end"]), find("labeled-image", ["end"])];
}

function currentImagePass(
  item: WorkItem,
  artifacts: Artifact[],
  records: ReviewRecord[],
  requirement?: FusionStoryboardReviewRequirement,
  explicitEvidenceId?: string,
): ReviewRecord | undefined {
  const required = currentImageArtifacts(item, artifacts);
  const candidates = records
    .filter((record) => record.itemId === item.id && record.reviewType === "image" && record.decision === "pass")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const explicit = explicitEvidenceId ? candidates.find((record) => record.id === explicitEvidenceId) : undefined;
  if (explicitEvidenceId) {
    if (!explicit) return undefined;
    return requirement
      ? reviewCoversFusionStoryboardRequirement(explicit, requirement, artifacts) ? explicit : undefined
      : reviewCoversArtifacts(explicit, required) ? explicit : undefined;
  }
  return requirement
    ? candidates.find((record) => reviewCoversFusionStoryboardRequirement(record, requirement, artifacts))
    : candidates.find((record) => reviewCoversArtifacts(record, required));
}

function queueReviewType(item: WorkItem, records: ReviewRecord[], currentEvidenceId?: string): "image" | "video" {
  if (item.status === "待视频验收" || item.status === "已完成") return item.type === "unit" ? "video" : "image";
  if (item.status !== "返工") return "image";
  const current = currentEvidenceId ? records.find((record) => record.id === currentEvidenceId && record.itemId === item.id) : undefined;
  const latestRework = records.find((record) => record.itemId === item.id && record.resultingStatus === "返工");
  return current?.reviewType ?? latestRework?.reviewType ?? "image";
}

function normalizeCriteria(reviewType: "image" | "video", criteria: ReviewCriterion[]): ReviewCriterion[] {
  const allowed = new Set<ReviewCriterionKey>(reviewType === "image" ? IMAGE_CRITERIA : VIDEO_CRITERIA);
  const normalized = new Map<ReviewCriterionKey, ReviewCriterion>();
  for (const criterion of criteria) {
    if (!REVIEW_CRITERIA_KEYS.includes(criterion.key) || !allowed.has(criterion.key)) continue;
    normalized.set(criterion.key, { key: criterion.key, result: criterion.result, note: criterion.note?.trim().slice(0, 2_000) || undefined });
  }
  return [...normalized.values()];
}

function normalizeAnnotations(annotations: ReviewAnnotationInput[] | undefined, artifacts: Artifact[], actor: "user" | "codex"): ReviewAnnotation[] {
  if (!annotations?.length) return [];
  if (annotations.length > 100) throw new Error("单次视觉验收最多提交 100 条画面批注。");
  const artifactMap = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  const createdAt = new Date().toISOString();
  return annotations.map((annotation, index) => {
    const artifact = artifactMap.get(annotation.artifactId);
    if (!artifact) throw new Error(`第 ${index + 1} 条批注必须绑定本次验收 artifactIds 中的真实素材版本。`);
    if (!REVIEW_ANNOTATION_TYPES.includes(annotation.type)) throw new Error(`第 ${index + 1} 条批注类型无效。`);
    if (![annotation.x, annotation.y].every(Number.isFinite) || annotation.x < 0 || annotation.x > 1 || annotation.y < 0 || annotation.y > 1) {
      throw new Error(`第 ${index + 1} 条批注的画面坐标必须在 0..1 范围内。`);
    }
    let timeSeconds: number | undefined;
    if (annotation.timeSeconds !== undefined) {
      if (artifact.kind !== "video") throw new Error(`第 ${index + 1} 条图片批注不能携带视频时间码。`);
      if (!Number.isFinite(annotation.timeSeconds) || annotation.timeSeconds < 0) throw new Error(`第 ${index + 1} 条批注时间码必须是非负秒数。`);
      const duration = artifact.check.duration;
      if (duration !== undefined && annotation.timeSeconds > duration + .001) throw new Error(`第 ${index + 1} 条批注时间码 ${annotation.timeSeconds.toFixed(3)}s 超出素材时长 ${duration.toFixed(3)}s。`);
      timeSeconds = Math.round(annotation.timeSeconds * 1_000) / 1_000;
    }
    const text = annotation.text.trim().slice(0, 2_000);
    if (!text) throw new Error(`第 ${index + 1} 条批注必须填写内容。`);
    return {
      id: `annotation-${randomUUID()}`,
      artifactId: artifact.id,
      type: annotation.type,
      timeSeconds,
      x: Math.round(annotation.x * 1_000_000) / 1_000_000,
      y: Math.round(annotation.y * 1_000_000) / 1_000_000,
      text,
      createdBy: actor,
      createdAt,
    };
  });
}

function visualAttestationKey(value: Pick<FusionVisualReviewRuleAttestation, "panelId" | "constraintId" | "reviewRulesFingerprint" | "ruleId">): string {
  return [value.panelId, value.constraintId, value.reviewRulesFingerprint, value.ruleId].join("\0");
}

export function normalizeVisualConstraintAttestations(
  input: SubmitReviewInput,
  requirement: FusionStoryboardReviewRequirement | undefined,
): FusionVisualReviewRuleAttestation[] | undefined {
  const submitted = input.visualConstraintAttestations ?? [];
  if (input.reviewType !== "image") {
    if (submitted.length) throw new Error("视频验收不能提交宫格图片的 P3 人工视觉规则确认。");
    return undefined;
  }
  const expected = fusionVisualReviewRuleRequirements(requirement);
  const hasP3Panels = Boolean(requirement?.panels.some((panel) => panel.panelVisualConstraintEvidenceVersion === 1));
  if (!hasP3Panels) {
    if (submitted.length) throw new Error("当前项目没有 P3 PanelVisualConstraint，不能提交无来源的人工视觉规则确认。");
    return undefined;
  }
  if (!requirement?.complete || expected.length === 0) {
    if (input.decision === "pass") throw new Error("P3 宫格人工视觉规则清单不完整，禁止判定通过。");
  }
  const expectedKeys = new Set(expected.map(visualAttestationKey));
  if (expectedKeys.size !== expected.length) throw new Error("P3 requirement 含重复人工视觉规则身份，已失败关闭。");
  const seen = new Set<string>();
  const normalized = submitted.map((attestation, index) => {
    if (attestation.result !== "pass" && attestation.result !== "fail") {
      throw new Error(`第 ${index + 1} 条 P3 人工视觉确认结果无效。`);
    }
    const key = visualAttestationKey(attestation);
    if (!expectedKeys.has(key)) throw new Error(`第 ${index + 1} 条 P3 人工视觉确认不属于当前 requirement，约束或规则可能已漂移。`);
    if (seen.has(key)) throw new Error(`第 ${index + 1} 条 P3 人工视觉确认重复，禁止用重复项补足清单。`);
    seen.add(key);
    return {
      panelId: attestation.panelId,
      constraintId: attestation.constraintId,
      reviewRulesFingerprint: attestation.reviewRulesFingerprint,
      ruleId: attestation.ruleId,
      result: attestation.result,
      note: attestation.note?.trim().slice(0, 2_000) || undefined,
    } satisfies FusionVisualReviewRuleAttestation;
  });
  if (input.decision === "pass") {
    if (normalized.length !== expected.length || seen.size !== expectedKeys.size) {
      throw new Error(`P3 宫格图片通过前必须逐格逐条完成人工视觉确认：需要 ${expected.length} 条，当前 ${normalized.length} 条。`);
    }
    if (normalized.some((attestation) => attestation.result !== "pass")) {
      throw new Error("P3 人工视觉规则存在 fail，不能判定通过；机械检查不能替代人工视觉结论。");
    }
  }
  return normalized.length ? normalized : undefined;
}

function nextStatus(item: WorkItem, reviewType: "image" | "video", decision: ReviewDecision): WorkItemStatus {
  if (decision === "rework") return "返工";
  if (decision === "pending") return reviewType === "video" ? "待视频验收" : "待视觉验收";
  if (reviewType === "video" || item.type === "shot" || item.type === "asset") return "已完成";
  return "待视频";
}

export async function getReviewQueue(projectRoot: string, options: { episode?: number; includeResolved?: boolean } = {}) {
  const canonicalStore = await loadCanonicalAssetStore(projectRoot);
  const canonicalAssetWorkItemIds = new Set(canonicalStore?.assets.map((asset) => asset.source.workItemId) ?? []);
  const previous = await getProjectIndex(projectRoot);
  const records = await listReviewRecords(projectRoot, { limit: 1_000 });
  const overrides = await loadOverrides(projectRoot);
  const preliminaryStatuses = options.includeResolved
    ? new Set<WorkItemStatus>(["待视觉验收", "待视频验收", "返工", "待视频", "已完成"])
    : new Set<WorkItemStatus>(["待视觉验收", "待视频验收", "返工"]);
  const preliminaryItemIds = new Set(previous.items
    .filter((item) => ["unit", "shot", "asset"].includes(item.type) && preliminaryStatuses.has(item.status))
    .filter((item) => !canonicalAssetWorkItemIds.has(item.id))
    .map((item) => item.id));
  const includeHashPaths = previous.artifacts
    .filter((artifact) => preliminaryItemIds.has(artifact.itemId) && !artifact.deprecated && ["raw-image", "labeled-image", "video"].includes(artifact.kind))
    .map((artifact) => artifact.path);
  const preliminary = await previewProjectScan(projectRoot, { includeHashPaths });
  const statuses = options.includeResolved
    ? new Set<WorkItemStatus>(["待视觉验收", "待视频验收", "返工", "待视频", "已完成"])
    : new Set<WorkItemStatus>(["待视觉验收", "待视频验收", "返工"]);
  const finalItemIds = new Set(preliminary.items
    .filter((item) => ["unit", "shot", "asset"].includes(item.type) && statuses.has(item.status))
    .filter((item) => !canonicalAssetWorkItemIds.has(item.id))
    .filter((item) => options.episode === undefined || item.episode === options.episode)
    .map((item) => item.id));
  // 第一次 preview 可能让 legacy completed override 回落到待验收。必须按回落后的
  // 最终队列再补一次内容哈希，否则旧记录会形成“永远缺 SHA、永远不能重验”的死循环。
  const finalHashPaths = preliminary.artifacts
    .filter((artifact) => finalItemIds.has(artifact.itemId) && !artifact.deprecated && ["raw-image", "labeled-image", "video"].includes(artifact.kind))
    .map((artifact) => artifact.path);
  const index = await previewProjectScan(projectRoot, { includeHashPaths: finalHashPaths });
  const fusionEvidence = await loadFusionStoryboardEvidenceSnapshot(projectRoot);
  return index.items
    .filter((item) => ["unit", "shot", "asset"].includes(item.type) && statuses.has(item.status))
    .filter((item) => !canonicalAssetWorkItemIds.has(item.id))
    .filter((item) => options.episode === undefined || item.episode === options.episode)
    .map((item) => {
      const reviewType = queueReviewType(item, records, overrides.items[item.id]?.statusEvidenceId);
      const artifacts = item.artifactIds.map((id) => index.artifacts.find((artifact) => artifact.id === id)).filter((artifact): artifact is Artifact => Boolean(artifact));
      const reviewRequirement = reviewType === "image"
        ? buildFusionStoryboardReviewRequirement(item, artifacts, fusionEvidence)
        : undefined;
      const latestReview = records.find((record) => {
        if (record.itemId !== item.id || record.reviewType !== reviewType) return false;
        if (reviewRequirement) return reviewCoversFusionStoryboardRequirement(record, reviewRequirement, artifacts);
        const selected = record.artifactIds.map((artifactId) => artifacts.find((artifact) => artifact.id === artifactId));
        return reviewCoversArtifacts(record, selected);
      });
      return {
        item,
        reviewType,
        artifacts,
        reviewSnapshot: {
          scanId: index.scanId,
          artifactHashes: Object.fromEntries(artifacts.filter((artifact) => artifact.check.sha256).map((artifact) => [artifact.id, artifact.check.sha256!])),
        },
        latestReview,
        reviewRequirement,
      };
    })
    .sort((a, b) => {
      const needsAttention = (entry: { item: WorkItem }) => ["待视觉验收", "待视频验收", "返工"].includes(entry.item.status);
      const queueRank = (entry: { item: WorkItem; latestReview?: ReviewRecord }) => needsAttention(entry) ? 0 : entry.latestReview ? 1 : 2;
      const rankDifference = queueRank(a) - queueRank(b);
      if (rankDifference) return rankDifference;
      if (queueRank(a) === 1) {
        const recentDifference = (b.latestReview?.createdAt ?? "").localeCompare(a.latestReview?.createdAt ?? "");
        if (recentDifference) return recentDifference;
      }
      return a.item.priority - b.item.priority || (a.item.episode ?? 0) - (b.item.episode ?? 0) || (a.item.unit ?? 0) - (b.item.unit ?? 0);
    });
}

export async function submitReview(
  projectRoot: string,
  input: SubmitReviewInput,
  actor: Extract<ProjectEvent["actor"], "user" | "codex"> = "user",
  options: ReviewSubmissionOptions = {},
): Promise<{ record: ReviewRecord; item: WorkItem }> {
  return withProjectLock(projectRoot, "reviews", async () => {
  let reviewRecordCommitted = false;
  try {
  // P5 之后，规范资产的 Review 必须通过追加式规范资产命令写回，不能再先写
  // reviews.json、再尝试推进旧 WorkItem 状态。这个守卫必须早于任何扫描或业务写入，
  // 否则失败会留下孤立 Review，并把命令幂等键锁成 unknown。
  const canonicalStore = await loadCanonicalAssetStore(projectRoot);
  const canonicalAsset = canonicalStore?.assets.find((asset) => asset.source.workItemId === input.itemId);
  if (canonicalAsset) {
    throw new RejectedCommandFailure(
      `资产 ${canonicalAsset.id} 已进入规范资产知识库；旧 submit_review 写入口已停用，请使用追加式规范资产 Review 写回。`,
      {
        schemaVersion: 1,
        submitted: false,
        applied: false,
        reason: "canonical_asset_review_requires_append_only_command",
        entityType: "canonical_asset",
        assetId: canonicalAsset.id,
        itemId: input.itemId,
      },
    );
  }
  const artifactIds = [...new Set(input.artifactIds)];
  if (!artifactIds.length) throw new Error("视觉验收至少要关联一个真实素材版本。");
  if (!input.expectedScanId?.trim()) throw new Error("视觉验收必须携带 get_review_queue 返回的 expectedScanId。");
  let previous = await getProjectIndex(projectRoot);
  let previousItem = previous.items.find((item) => item.id === input.itemId);
  let previousArtifacts = previous.artifacts.filter((artifact) => artifact.itemId === input.itemId);
  if (!previousItem || artifactIds.some((id) => !previousArtifacts.some((artifact) => artifact.id === id))) {
    previous = await previewProjectScan(projectRoot);
    previousItem = previous.items.find((item) => item.id === input.itemId);
    previousArtifacts = previous.artifacts.filter((artifact) => artifact.itemId === input.itemId);
  }
  if (!previousItem) throw new Error(`找不到节点：${input.itemId}`);
  const requestedPaths = artifactIds.map((id) => previousArtifacts.find((artifact) => artifact.id === id)?.path);
  if (requestedPaths.some((candidate) => !candidate)) throw new Error("验收包含不属于当前节点的素材版本。");
  const scanned = await scanAndPersist(projectRoot, { includeHashPaths: requestedPaths.filter((candidate): candidate is string => Boolean(candidate)) });
  const currentItem = scanned.items.find((item) => item.id === input.itemId);
  if (!currentItem) throw new Error(`重新扫描后找不到节点：${input.itemId}`);
  const currentArtifacts = scanned.artifacts.filter((artifact) => artifact.itemId === input.itemId);
  const current = { item: currentItem, artifacts: currentArtifacts };
  const currentFusionEvidence = await loadFusionStoryboardEvidenceSnapshot(projectRoot);
  const currentRequirement = buildFusionStoryboardReviewRequirement(current.item, current.artifacts, currentFusionEvidence);
  const hasFusionStoryboardArtifacts = current.artifacts.some((artifact) => artifact.fusionStoryboardPanel);
  const store = await loadStore(projectRoot);
  const currentOverrides = await loadOverrides(projectRoot);
  if (!["unit", "shot", "asset"].includes(current.item.type)) throw new Error("只有 15 秒单元、原镜头或资产节点可以提交视觉验收。");
  if (input.reviewType === "video" && current.item.type !== "unit") throw new Error("原镜头和资产节点不支持视频验收。");
  if (input.reviewType === "image" && currentRequirement && input.expectedRequirementId !== currentRequirement.id) {
    throw new Error("当前宫格合同或任一槽位内容已变化，请重新读取验收队列并逐格检查。");
  }
  if (input.reviewType === "image" && hasFusionStoryboardArtifacts && !currentRequirement) {
    throw new Error("当前宫格合同未选定或已与实时 storyboard 失配，禁止按旧首尾帧模型提交验收。");
  }
  if (input.reviewType === "video" && !currentImagePass(current.item, current.artifacts, store.records, currentRequirement, currentOverrides.items[input.itemId]?.reviewEvidenceIds?.image)) {
    throw new Error("当前全部宫格图片视觉通过证据已失效，请重新验收图片后再验收视频。");
  }
  const visualConstraintAttestations = normalizeVisualConstraintAttestations(input, currentRequirement);
  const selected = artifactIds.map((id) => current.artifacts.find((artifact) => artifact.id === id));
  if (selected.some((artifact) => !artifact)) throw new Error("验收包含不属于当前节点的素材版本。");
  if (selected.some((artifact) => artifact?.deprecated)) throw new Error("弃用或备份素材不能作为当前视觉验收对象。");
  const selectedArtifacts = selected.filter((artifact): artifact is Artifact => Boolean(artifact));
  for (const artifact of selectedArtifacts) {
    const expectedHash = input.expectedArtifactHashes?.[artifact.id];
    if (!expectedHash || !/^[a-f0-9]{64}$/.test(expectedHash)) throw new Error(`视觉验收快照缺少 ${artifact.id} 的有效 SHA-256。`);
    if (artifact.check.sha256 !== expectedHash) throw new Error(`${artifact.id} 的内容在读取验收队列后已变化，请重新读取队列并重新检查。`);
  }
  const criteria = normalizeCriteria(input.reviewType, input.criteria);
  const annotations = normalizeAnnotations(input.annotations, selectedArtifacts, actor);
  const expected = input.reviewType === "image" ? IMAGE_CRITERIA : VIDEO_CRITERIA;
  if (input.decision === "pass") {
    const missing = expected.filter((key) => !criteria.some((criterion) => criterion.key === key));
    if (missing.length) throw new Error(`通过验收前必须完成全部检查项：${missing.join("、")}`);
    if (criteria.some((criterion) => criterion.result === "fail")) throw new Error("存在失败检查项，不能判定通过。");
    if (currentRequirement && criteria.find((criterion) => criterion.key === "hard_lock")?.result !== "pass") {
      throw new Error("宫格图片引用了冻结资产，硬锁检查项必须明确判定通过，不能使用 N/A。");
    }
    if (annotations.some((annotation) => ["issue", "question"].includes(annotation.type))) throw new Error("存在问题或疑问批注，不能判定视觉通过。");
    const issues = requiredArtifactIssues(current.item, current.artifacts, input.reviewType, input.reviewType === "image" ? currentRequirement : undefined);
    if (issues.length) throw new Error(`机械门禁未通过：${issues.join("；")}`);
    const selectionIssues = passSelectionIssues(current.item, current.artifacts, input.reviewType, new Set(artifactIds), input.reviewType === "image" ? currentRequirement : undefined);
    if (selectionIssues.length) throw new Error(selectionIssues.join("；"));
  }
  const note = input.note?.trim().slice(0, 8_000) || undefined;
  if (input.decision === "rework" && !note && !criteria.some((criterion) => criterion.result === "fail") && !annotations.some((annotation) => annotation.type === "issue")) throw new Error("返工验收必须填写原因、标记失败检查项或添加问题批注。");
  const resultingStatus = nextStatus(current.item, input.reviewType, input.decision);
  const artifactEvidence = selectedArtifacts.map(artifactReviewEvidence);
  await options.beforeCommit?.({
    itemId: input.itemId,
    scanId: scanned.scanId,
    artifactHashes: Object.fromEntries(artifactEvidence.map((evidence) => [evidence.artifactId, evidence.sha256])),
  });
  const commitIndex = await scanAndPersist(projectRoot, { includeHashPaths: artifactEvidence.map((evidence) => evidence.path) });
  const commitItem = commitIndex.items.find((item) => item.id === input.itemId);
  const commitArtifacts = commitIndex.artifacts.filter((artifact) => artifact.itemId === input.itemId);
  const commitFusionEvidence = await loadFusionStoryboardEvidenceSnapshot(projectRoot);
  const commitRequirement = commitItem ? buildFusionStoryboardReviewRequirement(commitItem, commitArtifacts, commitFusionEvidence) : undefined;
  if (currentRequirement?.id !== commitRequirement?.id) throw new Error("宫格合同、任务、Publication 或任一图片在提交窗口内已变化，未写入验收记录。");
  const commitSelected = artifactIds.map((id) => commitArtifacts.find((artifact) => artifact.id === id));
  if (!commitItem || commitSelected.some((artifact) => !artifact || artifact.deprecated)) throw new Error("视觉验收素材在提交窗口内已删除、弃用或改变归属，请重新读取队列。");
  const committedEvidence = commitSelected.filter((artifact): artifact is Artifact => Boolean(artifact)).map(artifactReviewEvidence);
  if (JSON.stringify(committedEvidence) !== JSON.stringify(artifactEvidence)) throw new Error("视觉验收素材内容在提交窗口内已变化，未写入验收记录；请重新读取队列并重新检查。");
  if (input.decision === "pass") {
    const commitSelectionIssues = passSelectionIssues(commitItem, commitArtifacts, input.reviewType, new Set(artifactIds), input.reviewType === "image" ? commitRequirement : undefined);
    if (commitSelectionIssues.length) throw new Error(`视觉验收提交时权威版本已变化：${commitSelectionIssues.join("；")}`);
  }
  if (input.reviewType === "video") {
    const commitOverrides = await loadOverrides(projectRoot);
    if (!currentImagePass(commitItem, commitArtifacts, store.records, commitRequirement, commitOverrides.items[input.itemId]?.reviewEvidenceIds?.image)) {
      throw new Error("当前全部宫格图片视觉通过证据在视频验收提交前已失效，未写入验收记录；请重新验收图片后再验收视频。");
    }
  }
  await options.afterFinalScanBeforeRecord?.({
    itemId: input.itemId,
    scanId: commitIndex.scanId,
    artifactHashes: Object.fromEntries(committedEvidence.map((evidence) => [evidence.artifactId, evidence.sha256])),
  });
  const recordIndex = await scanAndPersist(projectRoot, { includeHashPaths: committedEvidence.map((evidence) => evidence.path) });
  const recordItem = recordIndex.items.find((item) => item.id === input.itemId);
  const recordArtifacts = recordIndex.artifacts.filter((artifact) => artifact.itemId === input.itemId);
  const recordSelected = artifactIds.map((id) => recordArtifacts.find((artifact) => artifact.id === id));
  if (!recordItem || recordSelected.some((artifact) => !artifact || artifact.deprecated)) throw new Error("视觉验收素材在最终写入前已删除、弃用或改变归属。");
  const recordEvidence = recordSelected.filter((artifact): artifact is Artifact => Boolean(artifact)).map(artifactReviewEvidence);
  if (JSON.stringify(recordEvidence) !== JSON.stringify(committedEvidence)) throw new Error("视觉验收素材内容在最终写入前已变化，未写入验收记录。");
  const recordFusionEvidence = await loadFusionStoryboardEvidenceSnapshot(projectRoot);
  const recordRequirement = buildFusionStoryboardReviewRequirement(recordItem, recordArtifacts, recordFusionEvidence);
  if (commitRequirement?.id !== recordRequirement?.id) throw new Error("宫格 requirement 在最终写入前已变化，未写入验收记录。");
  const record: ReviewRecord = {
    id: `review-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`,
    itemId: input.itemId,
    reviewType: input.reviewType,
    artifactIds,
    sourceScanId: input.expectedScanId,
    artifactEvidence: recordEvidence,
    requirementId: input.reviewType === "image" ? recordRequirement?.id : undefined,
    requirement: input.reviewType === "image" ? recordRequirement : undefined,
    visualConstraintAttestations: input.reviewType === "image" ? visualConstraintAttestations : undefined,
    decision: input.decision,
    criteria,
    annotations: annotations.length ? annotations : undefined,
    note,
    reviewer: actor,
    resultingStatus,
    createdAt: new Date().toISOString(),
  };
  // 先持久化不可变验收证据，再推进派生状态。即使进程在两步之间退出，
  // 最坏也只是“已有验收证据但仍待推进”，不会出现“已完成但没有验收记录”。
  store.records.push(record);
  await writeJsonAtomic(getSidecarPaths(projectRoot).reviews, store);
  reviewRecordCommitted = true;
  if (process.env.AI_CANVAS_TEST_REVIEW_CRASH_AFTER_RECORD === "1") throw new Error("TEST_ONLY_CRASH_AFTER_REVIEW_RECORD");
  const updated = await updateStatus(projectRoot, input.itemId, resultingStatus, note || `视觉验收：${input.decision}`, undefined, actor, "review", record.id, record.reviewType, record.requirementId);
  if (updated.status !== resultingStatus) {
    await appendEvent(projectRoot, { actor, type: "review.invalidated_during_status_commit", itemId: input.itemId, data: { reviewId: record.id, reviewType: record.reviewType, expectedStatus: resultingStatus, actualStatus: updated.status } });
    await reconcileTaskReviews(projectRoot, input.itemId);
    throw new ConfirmedCommandFailure("验收记录已保存，但素材在状态提交时发生变化，结论未推进；请重新读取队列并重新检查。", { schemaVersion: 1, submitted: true, statusApplied: false, reason: "review_evidence_changed_during_status_commit", record, item: updated });
  }
  await appendEvent(projectRoot, { actor, type: "review.submitted", itemId: input.itemId, data: { reviewId: record.id, reviewType: record.reviewType, decision: record.decision, resultingStatus, annotationCount: annotations.length } });
  await reconcileTaskReviews(projectRoot, input.itemId);
  return { record, item: updated };
  } catch (error) {
    if (!reviewRecordCommitted && !(error instanceof RejectedCommandFailure)) {
      const message = error instanceof Error ? error.message : String(error);
      throw new RejectedCommandFailure(message, { schemaVersion: 1, submitted: false, reason: "review_rejected" });
    }
    throw error;
  }
  });
}
