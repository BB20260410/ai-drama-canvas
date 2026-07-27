import { createHash } from "node:crypto";
import {
  listStudioGenerationPlanProjections,
  type StudioGenerationPlanNodeStatus,
  type StudioGenerationPlanProjection,
} from "./studio-generation-ledger.js";

/**
 * P21 生成计划进度投影（纯投影，不写账本）。
 * 供 main 广播失效信号（projectionHash 去重）与 renderer 全量拉取共用：
 * plans ≤36、节点 ≤216（36×6），retry-superseded 节点不进桶计数。
 */

export type StudioGenerationPlanProgressNode = ({
  targetKind: "panel";
  targetKey: string;
  panelId: string;
} | {
  targetKind: "unit-grid";
  targetKey: string;
}) & {
  planId: string;
  nodeIndex: number;
  unitId: string;
  packId: string;
  packFingerprint: string;
  status: StudioGenerationPlanNodeStatus;
  bucket: "active" | "done" | "failed";
  attempt: number;
  adopted: boolean;
  packStale: boolean;
  generationRunId: string;
  lastEventAt: string | null;
  resultId: string | null;
  errorClass: string | null;
  errorDetail: string | null;
};

export interface StudioGenerationPlanProgress {
  schemaVersion: 1;
  kind: "studio-generation-plan-progress";
  planCount: number;
  counts: { active: number; done: number; failed: number };
  nodes: StudioGenerationPlanProgressNode[];
  projectionHash: string;
}

const MAX_PLANS = 36;

function bucketOfNodeStatus(status: StudioGenerationPlanNodeStatus): "active" | "done" | "failed" | null {
  if (status === "planned" || status === "dispatched") return "active";
  if (status === "succeeded") return "done";
  if (status === "failed" || status === "cancelled") return "failed";
  return null; // retry-superseded 不进桶
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b, "en")).map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export async function buildStudioGenerationPlanProgress(projectRoot: string): Promise<StudioGenerationPlanProgress> {
  const plans: StudioGenerationPlanProjection[] = await listStudioGenerationPlanProjections(projectRoot, { limit: MAX_PLANS });
  const nodes: StudioGenerationPlanProgressNode[] = [];
  const counts = { active: 0, done: 0, failed: 0 };
  for (const plan of plans) {
    for (const node of plan.nodes) {
      const bucket = bucketOfNodeStatus(node.status);
      if (!bucket) continue;
      counts[bucket] += 1;
      const common = {
        planId: plan.planId,
        nodeIndex: node.nodeIndex,
        unitId: node.unitId,
        packId: node.packId,
        packFingerprint: node.packFingerprint,
        status: node.status,
        bucket,
        attempt: node.attempt,
        adopted: node.adopted,
        packStale: node.packStale,
        generationRunId: node.generationRunId,
        lastEventAt: node.lastEventAt,
        resultId: node.resultId,
        errorClass: node.errorClass,
        errorDetail: node.errorDetail,
      };
      nodes.push(node.targetKind === "panel"
        ? { ...common, targetKind: "panel", targetKey: node.targetKey, panelId: node.panelId }
        : { ...common, targetKind: "unit-grid", targetKey: node.targetKey });
    }
  }
  const semantic = {
    schemaVersion: 1 as const,
    kind: "studio-generation-plan-progress" as const,
    planCount: plans.length,
    counts,
    nodes,
  };
  return {
    ...semantic,
    projectionHash: createHash("sha256").update(stableStringify(semantic), "utf8").digest("hex"),
  };
}
