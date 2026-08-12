import type { MaterialStudioState } from "../../core/material-studio.js";
import type { ProjectShell } from "../../core/managed-project.js";
import type { StudioProductionState } from "../../core/studio-production.js";
import type {
  StudioDashboardOverview,
  StudioDashboardUnitDetail,
} from "../../core/studio-production-dashboard.js";
import type { StudioBindingTimelineStatus } from "../../core/studio-binding-control.js";
import type { MaterialStudioProjectOverview } from "./material-studio-ui-contract.js";

export function materialTimelineStatus(status: StudioBindingTimelineStatus): "pending" | "current" | "complete" {
  if (status === "generation-ready") return "complete";
  if (["ambiguous", "unmatched", "bound", "stale"].includes(status)) return "current";
  return "pending";
}

export function studioPanelStatusLabel(status: StudioBindingTimelineStatus): string {
  return ({
    pending: "待处理",
    unchecked: "待分析",
    ambiguous: "待消歧",
    unmatched: "缺少资产",
    bound: "已绑定",
    stale: "需更新",
    "generation-ready": "可生成",
  } satisfies Record<StudioBindingTimelineStatus, string>)[status];
}

export interface MaterialStudioReadMapperInput {
  shell: Pick<ProjectShell, "project">;
  material: Pick<MaterialStudioState, "counts">;
  production: Pick<StudioProductionState, "counts">;
  dashboardOverview: StudioDashboardOverview;
  currentUnit: StudioDashboardUnitDetail | null;
}

/**
 * 仅把已读取的 owner 投影组装为 Material Studio 展示模型。
 * nextAction 原样透传 Core Dashboard；本函数不做 IPC、不读媒体、不排序全库。
 */
export function mapMaterialStudioProjectOverview(input: MaterialStudioReadMapperInput): MaterialStudioProjectOverview {
  const { shell, material, production, dashboardOverview, currentUnit } = input;
  const reviewedSlotCount = dashboardOverview.checkpoint.completedSlotCount;
  return {
    projectName: shell.project.name,
    nextAction: `${dashboardOverview.nextAction.label}：${dashboardOverview.nextAction.reason}`,
    nextActionControl: dashboardOverview.nextAction,
    counts: {
      textDocuments: production.counts.textDocuments,
      scripts: production.counts.scriptDocuments,
      prompts: production.counts.promptDocuments,
      character: material.counts.characters,
      scene: material.counts.scenes,
      prop: material.counts.props,
      style: material.counts.styles,
      media: material.counts.media,
      canonicalAssets: material.counts.canonicalAssets,
      total: production.counts.textDocuments + material.counts.canonicalAssets + material.counts.media,
    },
    timeline: {
      currentLabel: currentUnit
        ? `${currentUnit.unit.episodeId} · ${currentUnit.unit.label} · ${currentUnit.unit.panelCount} 宫格${reviewedSlotCount ? ` · 已审片槽位 ${reviewedSlotCount}` : ""}`
        : reviewedSlotCount ? `已审片槽位 ${reviewedSlotCount}` : "等待 Core 指定下一分镜",
      unitCount: production.counts.units,
      completedUnitCount: reviewedSlotCount,
      segments: currentUnit?.panels.map((panel) => ({
        id: panel.id,
        label: `${panel.ordinal}. ${panel.label} · ${studioPanelStatusLabel(panel.status)}`,
        durationSeconds: panel.durationSeconds,
        status: materialTimelineStatus(panel.status),
      })) ?? [],
    },
  };
}
