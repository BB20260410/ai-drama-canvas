/**
 * 集级 earliest 单元投影：与 STATUS「下一步」对齐的机械真相（只读）。
 * UI 不推导业务规则；仅按 sequence 扫描 unit-grid 账本终态。
 */
import { createHash } from "node:crypto";
import path from "node:path";
import { inspectManagedProject } from "./managed-project.js";
import { listStudioProductionUnits, getStudioProductionUnitSnapshot } from "./studio-production.js";
import { getStudioGenerationCheckpointControl } from "./studio-generation-checkpoint.js";
import { getStudioProjectWriteLease } from "./studio-project-write-lease.js";
import { projectStudioUnitGridNextAction } from "./studio-unit-grid-next-action.js";
import { getApprovedTimelineProjection } from "./studio-approved-timeline-projection.js";

export const STUDIO_EPISODE_EARLIEST_SCHEMA_VERSION = 1 as const;

export interface StudioEpisodeUnitSlotProjection {
  unitId: string;
  sequence: number;
  title: string;
  revision: number;
  formalCommitted: boolean;
  reviewDecision: "pass" | "rework" | "reject" | "pending" | null;
  generationRunId: string | null;
  phase: string;
  code: string;
  label: string;
}

export interface StudioEpisodeEarliestProjection {
  schemaVersion: typeof STUDIO_EPISODE_EARLIEST_SCHEMA_VERSION;
  kind: "studio-episode-earliest";
  projectId: string;
  projectRoot: string;
  season: string;
  episode: string;
  /** 第一个未 formal commit 或未 Review pass 的单元（按 sequence） */
  earliestUnitId: string | null;
  earliestSequence: number | null;
  earliestReason: string | null;
  completedUnitIds: string[];
  pendingUnitIds: string[];
  slots: StudioEpisodeUnitSlotProjection[];
  checkpoint: {
    newSlotDispatchAllowed: boolean;
    blockingBatchNumber: number | undefined;
  };
  writeLease: {
    held: boolean;
    holderId: string | null;
    denialHint: string | null;
  };
  /** 人机同一真相：给 STATUS 镜像用的一句话 */
  statusLine: string;
  fingerprint: string;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/**
 * 从有序 productions 证据目录补强 formalCommitted（半旁路产线真相）。
 * 不读 STATUS 文件本身，避免循环依赖。
 */
async function loadExternalFormalSet(
  evidenceDir: string | undefined,
  episode: string,
): Promise<Set<string>> {
  const set = new Set<string>();
  if (!evidenceDir) return set;
  try {
    const { readdir, readFile } = await import("node:fs/promises");
    const files = await readdir(evidenceDir);
    for (const name of files) {
      if (!name.startsWith(`${episode.toLowerCase()}-u`) && !name.match(/^s1e2-u\d+-symbiosis-report\.json$/i)) {
        if (!name.includes("symbiosis-report")) continue;
      }
      if (!name.endsWith("-symbiosis-report.json") && !name.endsWith("symbiosis-report.json")) continue;
      try {
        const raw = JSON.parse(await readFile(path.join(evidenceDir, name), "utf8")) as {
          unitId?: string;
          formalChain?: boolean;
          outcome?: { rawSha?: string };
        };
        if (raw.unitId && (raw.formalChain || raw.outcome?.rawSha)) set.add(raw.unitId);
      } catch { /* skip */ }
    }
  } catch { /* skip */ }
  return set;
}

export async function getStudioEpisodeEarliest(
  projectRoot: string,
  input: {
    season?: string;
    episode?: string;
    /** 可选：productions/.../05_canvas 证据目录，用于半旁路 formal 补强 */
    evidenceDir?: string;
  } = {},
): Promise<StudioEpisodeEarliestProjection> {
  const root = path.resolve(projectRoot);
  const shell = await inspectManagedProject(root);
  const season = input.season ?? "S1";
  const episode = input.episode ?? "S1E2";
  const formalExternal = await loadExternalFormalSet(input.evidenceDir, episode);

  const units: Array<{ id: string; sequence: number; title: string; revision: number }> = [];
  let cursor: string | undefined;
  for (let page = 0; page < 50; page++) {
    const batch = await listStudioProductionUnits(root, {
      season,
      episode,
      limit: 50,
      cursor,
    });
    for (const item of batch.items) {
      units.push({
        id: item.id,
        sequence: item.sequence,
        title: item.title,
        revision: item.revision,
      });
    }
    if (!batch.nextCursor) break;
    cursor = batch.nextCursor;
  }
  units.sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id));

  // 与诊断/画布同源：正式时间线投影（当前修订 PASS > 已核验历史 PASS）决定 formalCommitted。
  // 禁止只靠外部 evidence 或忽略历史 PASS 导致 earliest 卡在已 PASS 单元上。
  const timeline = await getApprovedTimelineProjection(root, {
    season,
    episode,
    fastMode: true,
  });
  const timelineByUnit = new Map(timeline.units.map((unit) => [unit.unitId, unit]));

  const slots: StudioEpisodeUnitSlotProjection[] = [];
  for (const unit of units) {
    const snap = await getStudioProductionUnitSnapshot(root, unit.id);
    const approved = timelineByUnit.get(unit.id);
    const approvedPass = approved?.productionStatus === "pass";
    let generationRunId: string | null = approved?.selectedGenerationRunId
      ?? approved?.latestRunId
      ?? null;
    let formalCommitted = formalExternal.has(unit.id) || approvedPass;
    let reviewDecision: StudioEpisodeUnitSlotProjection["reviewDecision"] = approvedPass
      ? "pass"
      : approved?.productionStatus === "rework"
        ? "rework"
        : approved?.productionStatus === "result_pending_review"
          ? "pending"
          : approved?.reviewStatus === "reject"
            ? "reject"
            : null;
    let pairComplete = formalCommitted || Boolean(approved?.selectedRawSha256 && approved?.selectedLabeledSha256);
    let callStatus: Parameters<typeof projectStudioUnitGridNextAction>[0]["callStatus"] = formalCommitted
      ? "result-committed"
      : approved?.productionStatus === "generation_unknown"
        ? "generation_unknown"
        : null;

    const next = projectStudioUnitGridNextAction({
      hasCurrentPack: false,
      callStatus,
      pairComplete,
      reviewDecision,
    });

    slots.push({
      unitId: unit.id,
      sequence: unit.sequence,
      title: unit.title,
      revision: snap?.unit.revision ?? unit.revision,
      formalCommitted,
      reviewDecision,
      generationRunId,
      phase: next.phase,
      code: next.code,
      label: next.label,
    });
  }

  const completedUnitIds = slots.filter((s) => s.formalCommitted).map((s) => s.unitId);
  const pendingUnitIds = slots.filter((s) => !s.formalCommitted).map((s) => s.unitId);
  const earliest = slots.find((s) => !s.formalCommitted) ?? null;

  const [checkpoint, writeLease] = await Promise.all([
    getStudioGenerationCheckpointControl(root).catch(() => null),
    getStudioProjectWriteLease(root).catch(() => null),
  ]);

  const earliestReason = earliest
    ? checkpoint && (checkpoint as any).newSlotDispatchAllowed === false
      ? `earliest=${earliest.unitId} 但六图闸未放行（batch ${(checkpoint as any).blockingBatchNumber}）`
      : `下一有序 unit-grid：${earliest.unitId}（seq ${earliest.sequence}）`
    : units.length === 0
      ? `工程内尚无 ${season}/${episode} 单元`
      : `${season}/${episode} 列表内 formal 证据已齐（未必整集关账）`;

  const statusLine = earliest
    ? `earliest 下一步：${earliest.unitId}；已 formal ${completedUnitIds.length}/${slots.length}`
    : `earliest：无待 formal 单元（列表内 ${completedUnitIds.length} 齐）`;

  const body = {
    schemaVersion: 1 as const,
    kind: "studio-episode-earliest" as const,
    projectId: shell.project.id,
    projectRoot: root,
    season,
    episode,
    earliestUnitId: earliest?.unitId ?? null,
    earliestSequence: earliest?.sequence ?? null,
    earliestReason,
    completedUnitIds,
    pendingUnitIds,
    slots,
    checkpoint: {
      newSlotDispatchAllowed: (checkpoint as any)?.newSlotDispatchAllowed !== false,
      blockingBatchNumber: (checkpoint as any)?.blockingBatchNumber,
    },
    writeLease: {
      held: writeLease?.held ?? false,
      holderId: writeLease?.lease?.holderId ?? null,
      denialHint: writeLease?.denialHint ?? null,
    },
    statusLine,
  };
  return { ...body, fingerprint: digest(body) };
}
