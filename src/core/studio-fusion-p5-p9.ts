/**
 * P5–P9 画布性能 / 队列 / 导出 / 改编 / 运维 合同层（纯函数）。
 */

// —— P5 ——
export function layoutNewNodeBeside(
  viewport: { x: number; y: number; w: number; h: number },
  last?: { x: number; y: number; w: number },
): { x: number; y: number } {
  if (!(viewport.w > 0 && viewport.h > 0)) throw new Error("layout: viewport 非法。");
  if (!last) return { x: viewport.x + 40, y: viewport.y + 40 };
  return { x: last.x + last.w + 24, y: last.y };
}

export function snapToGrid(value: number, grid = 8): number {
  if (!(grid > 0)) throw new Error("snap: grid 非法。");
  return Math.round(value / grid) * grid;
}

export type HistoryDelta = { id: string; before: unknown; after: unknown };

export function applyHistoryDeltas(
  state: Record<string, unknown>,
  deltas: HistoryDelta[],
  direction: "undo" | "redo",
): Record<string, unknown> {
  const next = { ...state };
  const list = direction === "undo" ? [...deltas].reverse() : deltas;
  for (const d of list) {
    next[d.id] = direction === "undo" ? d.before : d.after;
  }
  return next;
}

export function serializeCanvasContextForAgent(input: {
  selectedNodeIds: string[];
  viewport: { x: number; y: number; w: number; h: number };
  nodeSummaries: Array<{ id: string; kind: string; label: string }>;
}): string {
  if (input.selectedNodeIds.length > 32) throw new Error("canvas-ctx: 选中过多。");
  return JSON.stringify({
    selected: input.selectedNodeIds,
    viewport: input.viewport,
    nodes: input.nodeSummaries.slice(0, 50),
  });
}

export type LruPutResult<V> = { map: Map<string, V>; evicted: string | null };

/** 简易 LRU 语义（P5.2） */
export function lruPut<V>(map: Map<string, V>, key: string, value: V, maxSize: number): LruPutResult<V> {
  if (maxSize < 1) throw new Error("lru: maxSize 非法。");
  const next = new Map(map);
  if (next.has(key)) next.delete(key);
  next.set(key, value);
  let evicted: string | null = null;
  if (next.size > maxSize) {
    const first = next.keys().next().value as string;
    next.delete(first);
    evicted = first;
  }
  return { map: next, evicted };
}

// —— P6 ——
export type QueueItemMeta = { origin?: string; destination?: string; jobKey?: string };

export function assertQueueRouting(meta: QueueItemMeta): void {
  if (meta.destination && !meta.destination.trim()) throw new Error("queue: destination 空。");
}

export function expandBatchCartesian(fields: Record<string, unknown[]>): Record<string, unknown>[] {
  const keys = Object.keys(fields);
  if (!keys.length) return [{}];
  let rows: Record<string, unknown>[] = [{}];
  for (const k of keys) {
    const vals = fields[k]!;
    if (!vals.length) throw new Error(`batch: ${k} 空。`);
    const next: Record<string, unknown>[] = [];
    for (const row of rows) for (const v of vals) next.push({ ...row, [k]: v });
    rows = next;
    if (rows.length > 64) throw new Error("batch: 组合爆炸 >64。");
  }
  return rows;
}

export type Lease = { lockedAt: number; lockedBy: string; expiresAt: number };

export function acquireLease(now: number, owner: string, ttlMs = 60_000): Lease {
  if (!owner.trim()) throw new Error("lease: owner 空。");
  return { lockedAt: now, lockedBy: owner, expiresAt: now + ttlMs };
}

export function isLeaseExpired(lease: Lease, now: number): boolean {
  return now >= lease.expiresAt;
}

export type DurableEvent = { id: string; step: string; payload: unknown };

export function replayDurableEvents(events: DurableEvent[]): Set<string> {
  const done = new Set<string>();
  for (const e of events) {
    if (!e.id || !e.step) throw new Error("durable: 事件非法。");
    done.add(e.step);
  }
  return done;
}

export function shouldSkipStep(done: Set<string>, step: string): boolean {
  return done.has(step);
}

export type ProgressUpdate = { token: string; progress: number; total?: number };

export function assertProgress(p: ProgressUpdate): void {
  if (!p.token.trim()) throw new Error("progress: token 空。");
  if (!(p.progress >= 0)) throw new Error("progress: 非法。");
  if (p.total !== undefined && p.progress > p.total) throw new Error("progress: 超过 total。");
}

export function jobKeyFor(parts: string[]): string {
  if (!parts.length || parts.some((p) => !p.trim())) throw new Error("jobKey: 部件空。");
  return parts.join(":");
}

export type RunMode = "explore" | "formal";

export function quarantineRequiredForMode(mode: RunMode): boolean {
  return mode === "explore";
}

// —— P7 ——
export type OtioExportPlan = { tracks: number; clips: number; format: "otio" };

export function planOtioExport(clipCount: number): OtioExportPlan {
  if (!(clipCount >= 0)) throw new Error("otio: clipCount 非法。");
  return { tracks: clipCount > 0 ? 1 : 0, clips: clipCount, format: "otio" };
}

export function planProjectPackage(files: string[]): { manifestCount: number; include: string[] } {
  if (!files.length) throw new Error("package: 无文件。");
  return { manifestCount: files.length, include: [...files] };
}

export function clusterSetupsByCamera(
  shots: Array<{ id: string; fov: number; height: number }>,
  tolerance = 2,
): Array<{ setup: number; shotIds: string[] }> {
  const groups: Array<{ fov: number; height: number; shotIds: string[] }> = [];
  for (const s of shots) {
    const g = groups.find(
      (x) => Math.abs(x.fov - s.fov) <= tolerance && Math.abs(x.height - s.height) <= tolerance,
    );
    if (g) g.shotIds.push(s.id);
    else groups.push({ fov: s.fov, height: s.height, shotIds: [s.id] });
  }
  return groups.map((g, i) => ({ setup: i + 1, shotIds: g.shotIds }));
}

// —— P8 ——
export function compressLongTextLayers(text: string, maxChunk = 800): {
  summary: string;
  chunks: string[];
} {
  const t = text.trim();
  if (!t) throw new Error("compress: 空文本。");
  const chunks: string[] = [];
  for (let i = 0; i < t.length; i += maxChunk) chunks.push(t.slice(i, i + maxChunk));
  const summary = t.length <= 200 ? t : `${t.slice(0, 200)}…`;
  return { summary, chunks };
}

export const BEAT_TEMPLATES = ["开场钩子", "冲突升级", "反转", "悬念断章"] as const;

export function pickBeatTemplate(index: number): string {
  if (index < 0 || index >= BEAT_TEMPLATES.length) throw new Error("beat: index 非法。");
  return BEAT_TEMPLATES[index]!;
}

export function assertFragmentDuration(seconds: number, max = 15): void {
  if (!(seconds > 0 && seconds <= max)) throw new Error(`fragment: 时长须 (0,${max}]。`);
}

export type AliasOverride = { canonical: string; aliases: string[] };

export function resolveAlias(name: string, table: AliasOverride[]): string {
  const n = name.trim();
  for (const row of table) {
    if (row.canonical === n || row.aliases.includes(n)) return row.canonical;
  }
  return n;
}

export type PromptRegistryEntry = { name: string; version: number; body: string };

export function registerPromptVersion(
  existing: PromptRegistryEntry[],
  name: string,
  body: string,
): PromptRegistryEntry {
  if (!name.trim() || !body.trim()) throw new Error("prompt-reg: 空。");
  const prev = existing.filter((e) => e.name === name);
  const version = prev.length ? Math.max(...prev.map((p) => p.version)) + 1 : 1;
  return { name, version, body };
}

export function estimateWorkload(chars: number): { approxPanels: number; approxUnits: number } {
  if (!(chars >= 0)) throw new Error("workload: 非法。");
  const approxPanels = Math.max(1, Math.ceil(chars / 400));
  return { approxPanels, approxUnits: Math.max(1, Math.ceil(approxPanels / 4)) };
}

export function validateShotContinuityRule(shots: Array<{ shotType: string }>): string[] {
  const issues: string[] = [];
  if (!shots.length) return ["无镜头"];
  if (shots[0]!.shotType === "close_up" || shots[0]!.shotType === "extreme_close_up") {
    issues.push("开场不宜直接特写（FilmAgent 启发式）");
  }
  return issues;
}

// —— P9 ——
export function publicationPreflightLocal(input: {
  width: number;
  height: number;
  durationSeconds: number;
  lufs?: number;
}): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (input.width < 720 || input.height < 720) errors.push("分辨率过低");
  if (!(input.durationSeconds > 0 && input.durationSeconds <= 180)) errors.push("时长异常");
  if (input.lufs !== undefined && input.lufs > -10) errors.push("响度可能过响");
  return { ok: errors.length === 0, errors };
}

export function maskSecret(value: string): string {
  if (!value) return "";
  if (value.length <= 8) return "****";
  return `${value.slice(0, 3)}…${value.slice(-2)}`;
}

export function i18nToolDescription(zh: string, en: string, locale: "zh" | "en"): string {
  if (!zh.trim() || !en.trim()) throw new Error("i18n: 空描述。");
  return locale === "zh" ? zh : en;
}

export function structuredTaskLog(entry: {
  task: string;
  phase: string;
  ok: boolean;
  detail?: string;
}): string {
  if (!entry.task || !entry.phase) throw new Error("log: 缺字段。");
  return JSON.stringify({
    ts: new Date(0).toISOString(),
    ...entry,
  });
}
