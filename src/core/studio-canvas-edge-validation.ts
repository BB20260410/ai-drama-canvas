/**
 * 画布节点连线类型校验。
 *
 * 源码依据（TwitCanva pin 9705b26，仓库外 clone）：
 * - `src/types.ts` NodeType: Text/Image/Video/Audio/Image Editor/…
 * - `src/hooks/useNodeManagement.ts` connector 允许从 source 挂任意 NodeType 为子（parentIds）
 * - `src/hooks/useGeneration.ts` 实际生成约束：
 *   - VIDEO 可消费 TEXT prompt 父节点 + IMAGE 父节点（i2v）
 *   - VIDEO frame-to-frame 需 ≥2 IMAGE 父
 *   - IMAGE 可链式吃 TEXT / IMAGE
 *   - VIDEO 可链式吃 VIDEO lastFrame
 *
 * 映射到本库生产画布 kind 后固化 ALLOWED（非任意 NodeType 全开，避免脏边）。
 */
export type StudioCanvasNodeKind =
  | "asset"
  | "unit"
  | "panel"
  | "raw"
  | "labeled"
  | "review"
  | "script"
  | "prompt"
  | "media"
  | "unknown";

export interface StudioCanvasEdgeCandidate {
  sourceId: string;
  targetId: string;
  sourceKind: StudioCanvasNodeKind | string;
  targetKind: StudioCanvasNodeKind | string;
}

export interface StudioCanvasEdgeValidationIssue {
  code: "kind-mismatch" | "self-loop" | "missing-endpoint" | "duplicate-edge";
  message: string;
  sourceId?: string;
  targetId?: string;
}

export interface StudioCanvasEdgeValidationResult {
  schemaVersion: 1;
  kind: "studio-canvas-edge-validation";
  ok: boolean;
  accepted: StudioCanvasEdgeCandidate[];
  rejected: Array<StudioCanvasEdgeCandidate & { issue: StudioCanvasEdgeValidationIssue }>;
  issues: StudioCanvasEdgeValidationIssue[];
}

/**
 * TwitCanva NodeType → 本库 kind 对照（研究证据）。
 * Text→script, Image→raw, Video→media, Image Editor→labeled
 */
export const TWITCANVA_NODE_TYPE_TO_STUDIO_KIND: Readonly<Record<string, StudioCanvasNodeKind>> = {
  Text: "script",
  Image: "raw",
  Video: "media",
  Audio: "media",
  "Image Editor": "labeled",
  "Video Editor": "media",
  "Storyboard Manager": "panel",
  "Camera Angle": "panel",
  "Local Image Model": "raw",
  "Local Video Model": "media",
};

/**
 * 允许的有向边（source → target）。
 * 含：本库 pipeline 生产边 + TwitCanva 生成约束映射边。
 */
const ALLOWED: ReadonlySet<string> = new Set([
  // 本库驾驶舱/流水线
  "asset→unit",
  "asset→panel",
  "asset→raw", // 角色/场景参考作图输入（Twit IMAGE ref）
  "unit→unit", // 剧情时间线：上一 15s 单元 → 下一单元
  "unit→raw", // 该 15 秒单元已通过人工审片的整板 raw
  "unit→panel",
  "panel→panel",
  "panel→raw",
  "panel→labeled",
  "panel→review",
  "panel→media",
  "raw→labeled", // Image Editor 链
  "raw→media", // Image → Video (i2v)
  "raw→raw", // Image → Image 链式
  "labeled→review",
  "labeled→media",
  "script→panel",
  "script→raw", // Text → Image
  "script→media", // Text → Video
  "prompt→panel",
  "prompt→raw",
  "media→review",
  "media→media", // Video → Video 续镜/lastFrame
]);

/** 研究证据：TwitCanva 源码允许的「语义」连接（用于测试与报告） */
export function listTwitCanvaGroundedSemanticEdges(): string[] {
  return [
    "Text→Image",
    "Text→Video",
    "Image→Image",
    "Image→Video",
    "Image→Image Editor",
    "Video→Video",
    "Video→Video Editor",
  ];
}

function pairKey(sourceKind: string, targetKind: string): string {
  return `${sourceKind.trim().toLowerCase()}→${targetKind.trim().toLowerCase()}`;
}

function normalizeKind(value: string): StudioCanvasNodeKind {
  const k = value.trim().toLowerCase();
  if (
    k === "asset" || k === "unit" || k === "panel" || k === "raw" || k === "labeled"
    || k === "review" || k === "script" || k === "prompt" || k === "media"
  ) {
    return k;
  }
  // 允许直接传 TwitCanva NodeType 显示名
  const mapped = TWITCANVA_NODE_TYPE_TO_STUDIO_KIND[value.trim()];
  if (mapped) return mapped;
  return "unknown";
}

/**
 * 校验边列表；self-loop / 非法 kind 对 / 重复边 进入 rejected。
 */
export function validateStudioCanvasEdges(
  edges: readonly StudioCanvasEdgeCandidate[] | undefined | null,
): StudioCanvasEdgeValidationResult {
  const accepted: StudioCanvasEdgeCandidate[] = [];
  const rejected: Array<StudioCanvasEdgeCandidate & { issue: StudioCanvasEdgeValidationIssue }> = [];
  const issues: StudioCanvasEdgeValidationIssue[] = [];
  const seen = new Set<string>();

  for (const edge of edges ?? []) {
    const sourceId = String(edge.sourceId ?? "").trim();
    const targetId = String(edge.targetId ?? "").trim();
    if (!sourceId || !targetId) {
      const issue: StudioCanvasEdgeValidationIssue = {
        code: "missing-endpoint",
        message: "边缺少 sourceId 或 targetId。",
        sourceId: sourceId || undefined,
        targetId: targetId || undefined,
      };
      issues.push(issue);
      rejected.push({ ...edge, sourceId, targetId, issue });
      continue;
    }
    if (sourceId === targetId) {
      const issue: StudioCanvasEdgeValidationIssue = {
        code: "self-loop",
        message: "禁止自环。",
        sourceId,
        targetId,
      };
      issues.push(issue);
      rejected.push({ ...edge, sourceId, targetId, issue });
      continue;
    }
    const edgeKey = `${sourceId}=>${targetId}`;
    if (seen.has(edgeKey)) {
      const issue: StudioCanvasEdgeValidationIssue = {
        code: "duplicate-edge",
        message: "重复边。",
        sourceId,
        targetId,
      };
      issues.push(issue);
      rejected.push({ ...edge, sourceId, targetId, issue });
      continue;
    }
    seen.add(edgeKey);

    const sk = normalizeKind(String(edge.sourceKind ?? "unknown"));
    const tk = normalizeKind(String(edge.targetKind ?? "unknown"));
    if (!ALLOWED.has(pairKey(sk, tk))) {
      const issue: StudioCanvasEdgeValidationIssue = {
        code: "kind-mismatch",
        message: `不允许的连接：${sk} → ${tk}`,
        sourceId,
        targetId,
      };
      issues.push(issue);
      rejected.push({
        sourceId,
        targetId,
        sourceKind: sk,
        targetKind: tk,
        issue,
      });
      continue;
    }

    accepted.push({
      sourceId,
      targetId,
      sourceKind: sk,
      targetKind: tk,
    });
  }

  return {
    schemaVersion: 1,
    kind: "studio-canvas-edge-validation",
    ok: rejected.length === 0,
    accepted,
    rejected,
    issues,
  };
}

export function listStudioCanvasAllowedEdgeKinds(): string[] {
  return [...ALLOWED].sort();
}

export function isStudioCanvasEdgeKindAllowed(sourceKind: string, targetKind: string): boolean {
  return ALLOWED.has(pairKey(normalizeKind(sourceKind), normalizeKind(targetKind)));
}
