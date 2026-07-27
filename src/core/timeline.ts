import { appendEvent, getSidecarPaths, readJson, writeJsonAtomic } from "./sidecar.js";
import { createTaskPack, getProjectIndex } from "./service.js";
import type { ShotTiming, TimelineOverrides, UnitTimeline, WorkItem } from "./types.js";
import { withProjectLock } from "./locks.js";
import { RejectedCommandFailure } from "./command-outcome.js";

function shotOrder(item: WorkItem): number {
  const match = String(item.shot ?? "").match(/^(\d+)([A-Z])?$/i);
  if (!match) return Number.MAX_SAFE_INTEGER;
  return Number(match[1]) * 100 + (match[2]?.toUpperCase().charCodeAt(0) ?? 64) - 64;
}

function inferredDuration(item: WorkItem): number | undefined {
  const text = item.infoExcerpt ?? "";
  const explicit = text.match(/(?:时长|duration)\s*[：:]?\s*(\d+(?:\.\d+)?)\s*(?:秒|s)/i);
  if (explicit) return Number(explicit[1]);
  const ranges = [...text.matchAll(/(\d+(?:\.\d+)?)\s*[–—-]\s*(\d+(?:\.\d+)?)\s*秒/g)];
  if (ranges.length) {
    const start = Math.min(...ranges.map((match) => Number(match[1])));
    const end = Math.max(...ranges.map((match) => Number(match[2])));
    if (end > start && end - start <= 15) return end - start;
  }
  return undefined;
}

function buildTimeline(unit: WorkItem, shots: WorkItem[], override?: TimelineOverrides["units"][string]): UnitTimeline {
  const overrideMap = new Map(override?.shots.map((timing) => [timing.shotId, timing]));
  const defaultDuration = shots.length ? Math.round((15 / shots.length) * 100) / 100 : 0;
  const merged = shots
    .map((item, index) => ({
      item,
      timing: overrideMap.get(item.id) ?? { shotId: item.id, order: index, durationSeconds: inferredDuration(item) ?? defaultDuration },
    }))
    .sort((a, b) => a.timing.order - b.timing.order || shotOrder(a.item) - shotOrder(b.item));
  merged.forEach((entry, index) => entry.timing.order = index);
  const total = Math.round(merged.reduce((sum, entry) => sum + entry.timing.durationSeconds, 0) * 100) / 100;
  const issues: string[] = [];
  if (merged.length > 6) issues.push(`镜头数 ${merged.length} 超过单张参考板上限 6`);
  if (total > 15.001) issues.push(`累计时长 ${total.toFixed(2)} 秒超过 15 秒`);
  if (merged.some((entry) => !Number.isFinite(entry.timing.durationSeconds) || entry.timing.durationSeconds <= 0)) issues.push("存在无效或非正数镜头时长");
  return {
    unitId: unit.id,
    title: unit.title,
    episode: unit.episode ?? 0,
    unit: unit.unit ?? 0,
    shots: merged,
    totalDurationSeconds: total,
    valid: issues.length === 0,
    issues,
    updatedAt: override?.updatedAt,
  };
}

export async function getUnitTimelines(projectRoot: string, episode?: number): Promise<UnitTimeline[]> {
  const index = await getProjectIndex(projectRoot);
  const overrides = await readJson<TimelineOverrides>(getSidecarPaths(projectRoot).timeline, { schemaVersion: 1, units: {} });
  const units = index.items.filter((item) => item.type === "unit" && (episode === undefined || item.episode === episode));
  const shots = index.items.filter((item) => item.type === "shot" && item.parentId);
  return units
    .map((unit) => buildTimeline(unit, shots.filter((shot) => shot.parentId === unit.id).sort((a, b) => shotOrder(a) - shotOrder(b)), overrides.units[unit.id]))
    .sort((a, b) => a.episode - b.episode || a.unit - b.unit);
}

export async function saveUnitTimeline(projectRoot: string, unitId: string, timings: ShotTiming[]): Promise<UnitTimeline> {
  return withProjectLock(projectRoot, "timeline", async () => {
  const timelines = await getUnitTimelines(projectRoot);
  const current = timelines.find((timeline) => timeline.unitId === unitId);
  if (!current) throw new RejectedCommandFailure(`找不到 15 秒单元：${unitId}`, { schemaVersion: 1, applied: false, reason: "not_found", unitId });
  const expectedIds = new Set(current.shots.map((entry) => entry.item.id));
  if (timings.length !== expectedIds.size || new Set(timings.map((timing) => timing.shotId)).size !== timings.length || timings.some((timing) => !expectedIds.has(timing.shotId))) {
    throw new RejectedCommandFailure("时间线镜头集合与真实文件扫描结果不一致，请重新载入。", { schemaVersion: 1, applied: false, reason: "validation_failed", unitId });
  }
  if (timings.length > 6) throw new RejectedCommandFailure("单个 15 秒参考板最多允许 6 个镜头。", { schemaVersion: 1, applied: false, reason: "validation_failed", unitId });
  const normalized = timings
    .map((timing, order) => ({ ...timing, order, durationSeconds: Math.round(Number(timing.durationSeconds) * 100) / 100 }));
  if (normalized.some((timing) => !Number.isFinite(timing.durationSeconds))) throw new RejectedCommandFailure("镜头时长必须是有效数字。", { schemaVersion: 1, applied: false, reason: "validation_failed", unitId });
  if (normalized.some((timing) => timing.durationSeconds <= 0)) throw new RejectedCommandFailure("镜头时长必须大于 0 秒。", { schemaVersion: 1, applied: false, reason: "validation_failed", unitId });
  const total = normalized.reduce((sum, timing) => sum + timing.durationSeconds, 0);
  if (total > 15.001) throw new RejectedCommandFailure(`累计时长 ${total.toFixed(2)} 秒超过 15 秒。`, { schemaVersion: 1, applied: false, reason: "validation_failed", unitId });
  const overrides = await readJson<TimelineOverrides>(getSidecarPaths(projectRoot).timeline, { schemaVersion: 1, units: {} });
  overrides.units[unitId] = { shots: normalized, updatedAt: new Date().toISOString() };
  await writeJsonAtomic(getSidecarPaths(projectRoot).timeline, overrides);
  await appendEvent(projectRoot, { actor: "user", type: "timeline.saved", itemId: unitId, data: { totalDurationSeconds: total, shots: normalized } });
  return (await getUnitTimelines(projectRoot)).find((timeline) => timeline.unitId === unitId)!;
  });
}

export async function createShotTaskPack(projectRoot: string, unitId: string, mode: "observe" | "collaborate" | "autopilot" = "autopilot") {
  const timeline = (await getUnitTimelines(projectRoot)).find((candidate) => candidate.unitId === unitId);
  if (!timeline?.shots.length) throw new Error("当前单元没有可领取的原镜头。");
  if (!timeline.valid) throw new Error(`时间线未通过约束：${timeline.issues.join("；")}`);
  return createTaskPack(projectRoot, { itemIds: timeline.shots.map((entry) => entry.item.id), mode, kind: "image" });
}
