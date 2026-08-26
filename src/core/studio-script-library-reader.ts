/**
 * SSL-2 · 剧本阅读投影（只读）
 *
 * - 正文来自 text revision CAS
 * - 大纲：md 标题启发式导航（不写 section 表）
 * - earliest 高亮：与 getStudioEpisodeEarliest 同源
 * - 编辑不在此面；修订仍走 append revision
 */
import {
  getStudioTextDocument,
  getStudioTextRevision,
  listStudioTextRevisions,
  listStudioProductionUnits,
  getStudioProductionUnitSnapshot,
} from "./studio-production.js";
import { getStudioEpisodeEarliest } from "./studio-episode-earliest.js";

export const SCRIPT_READER_SCHEMA_VERSION = 1 as const;

/** 与对照板同文案。本地排版，避免与对照模块循环依赖。 */
function readerCheckpointLine(checkpoint: {
  newSlotDispatchAllowed: boolean;
  blockingBatchNumber?: number;
}): string {
  if (checkpoint.newSlotDispatchAllowed === false) {
    return checkpoint.blockingBatchNumber != null
      ? `六图闸未放行（batch ${checkpoint.blockingBatchNumber}），先完成停检/Review（不派发）`
      : "六图闸未放行，先完成停检/Review（不派发）";
  }
  return "六图闸已放行新槽";
}

function readerWriteLeaseLine(lease: {
  held: boolean;
  holderId: string | null;
  denialHint: string | null;
}): string {
  if (lease.held) {
    return lease.holderId
      ? `写租约由 ${lease.holderId} 持有；无该租约禁止写命令（不派发）`
      : "写租约已被持有；无该租约禁止写命令（不派发）";
  }
  return lease.denialHint
    || "写租约未持有；写命令前须 acquire-lease（不派发）";
}

export interface ScriptOutlineHeading {
  level: number;
  title: string;
  lineIndex: number;
  startOffsetUtf16: number;
  endOffsetUtf16: number;
}

export interface ScriptReaderUnitHighlight {
  unitId: string;
  sequence: number;
  title: string;
  isEarliest: boolean;
  formalCommitted: boolean;
  sourceSpans: Array<{ startOffsetUtf16: number; endOffsetUtf16: number }>;
}

export interface ScriptReaderView {
  schemaVersion: typeof SCRIPT_READER_SCHEMA_VERSION;
  kind: "studio-script-reader-view";
  projectRoot: string;
  documentId: string;
  documentTitle: string;
  revisionId: string;
  revisionOrdinal: number;
  body: string;
  bodySha256: string;
  bodyCharCount: number;
  outline: ScriptOutlineHeading[];
  episode?: {
    season: string;
    episode: string;
    earliestUnitId: string | null;
    earliestStatusLine: string | null;
    earliestReason: string | null;
    checkpointLine: string;
    writeLeaseLine: string;
    unitHighlights: ScriptReaderUnitHighlight[];
  };
  builtAt: string;
}

/** 纯：从 markdown 正文提取标题大纲（UTF-16 offset）。 */
export function buildScriptOutlineFromMarkdown(body: string): ScriptOutlineHeading[] {
  const outline: ScriptOutlineHeading[] = [];
  let offset = 0;
  const lines = body.split("\n");
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex] ?? "";
    const lineLen = line.length + (lineIndex < lines.length - 1 ? 1 : 0); // + \n except last
    const m = /^(#{1,6})\s+(.+?)\s*$/u.exec(line);
    if (m) {
      const title = m[2]!.trim();
      if (title) {
        outline.push({
          level: m[1]!.length,
          title: title.slice(0, 200),
          lineIndex,
          startOffsetUtf16: offset,
          endOffsetUtf16: offset + line.length,
        });
      }
    }
    offset += lineLen;
  }
  return outline;
}

export async function getStudioScriptReaderView(
  projectRoot: string,
  query: {
    documentId?: string;
    revisionId?: string;
    season?: string;
    episode?: string;
    includeBody?: boolean;
    /** 可选：formal 证据目录，喂给 earliest 投影 */
    evidenceDir?: string;
  },
): Promise<ScriptReaderView> {
  let revisionId = query.revisionId;
  let documentId = query.documentId;

  if (!revisionId && !documentId) {
    throw new Error("reader-view 需要 documentId 或 revisionId。");
  }

  if (!revisionId && documentId) {
    const revs = await listStudioTextRevisions(projectRoot, { documentId, limit: 100 });
    const head = revs.items[revs.items.length - 1];
    if (!head) throw new Error(`文档无修订：${documentId}`);
    revisionId = head.id;
  }

  const revision = await getStudioTextRevision(projectRoot, revisionId!);
  if (!revision) throw new Error(`修订不存在：${revisionId}`);
  documentId = revision.documentId;

  const doc = await getStudioTextDocument(projectRoot, documentId);
  if (!doc) throw new Error(`文档不存在：${documentId}`);
  if (doc.kind !== "script") throw new Error(`reader-view 仅支持 script 文档，当前 kind=${doc.kind}`);

  const includeBody = query.includeBody !== false;
  const body = includeBody ? revision.body : "";
  const outline = buildScriptOutlineFromMarkdown(revision.body);

  let episode: ScriptReaderView["episode"];
  if (query.season && query.episode) {
    const earliest = await getStudioEpisodeEarliest(projectRoot, {
      season: query.season,
      episode: query.episode,
      ...(query.evidenceDir ? { evidenceDir: query.evidenceDir } : {}),
    });
    const unitHighlights: ScriptReaderUnitHighlight[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const batch = await listStudioProductionUnits(projectRoot, {
        season: query.season,
        episode: query.episode,
        limit: 50,
        cursor,
      });
      for (const u of batch.items) {
        const snap = await getStudioProductionUnitSnapshot(projectRoot, u.id);
        if (!snap) continue;
        // 仅挂载锚定到本 revision 的 unit
        if (snap.scriptRevision?.id && snap.scriptRevision.id !== revision.id) continue;
        const spans: Array<{ startOffsetUtf16: number; endOffsetUtf16: number }> = [];
        for (const p of snap.panels || []) {
          const raw = (p as { sourceSpans?: unknown }).sourceSpans;
          if (!Array.isArray(raw)) continue;
          for (const s of raw) {
            if (!s || typeof s !== "object") continue;
            const start = Number((s as { startOffsetUtf16?: number }).startOffsetUtf16);
            const end = Number((s as { endOffsetUtf16?: number }).endOffsetUtf16);
            if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
              spans.push({ startOffsetUtf16: start, endOffsetUtf16: end });
            }
          }
        }
        const slot = earliest.slots.find((s) => s.unitId === u.id);
        unitHighlights.push({
          unitId: u.id,
          sequence: Number(snap.unit.sequence),
          title: snap.unit.title,
          isEarliest: earliest.earliestUnitId === u.id,
          formalCommitted: slot?.formalCommitted === true,
          sourceSpans: spans,
        });
      }
      if (!batch.nextCursor) break;
      cursor = batch.nextCursor;
    }
    // 若库内大剧本与产线 unit 的 scriptRevision 未直接锚定，仍投影 earliest 槽位作导航高亮
    if (unitHighlights.length === 0) {
      for (const slot of earliest.slots) {
        unitHighlights.push({
          unitId: slot.unitId,
          sequence: slot.sequence,
          title: slot.title,
          isEarliest: earliest.earliestUnitId === slot.unitId,
          formalCommitted: slot.formalCommitted,
          sourceSpans: [],
        });
      }
    }
    unitHighlights.sort((a, b) => a.sequence - b.sequence);
    episode = {
      season: query.season,
      episode: query.episode,
      earliestUnitId: earliest.earliestUnitId,
      earliestStatusLine: earliest.statusLine,
      earliestReason: earliest.earliestReason ?? null,
      checkpointLine: readerCheckpointLine(earliest.checkpoint),
      writeLeaseLine: readerWriteLeaseLine(earliest.writeLease),
      unitHighlights,
    };
  }

  return {
    schemaVersion: SCRIPT_READER_SCHEMA_VERSION,
    kind: "studio-script-reader-view",
    projectRoot,
    documentId,
    documentTitle: doc.title,
    revisionId: revision.id,
    revisionOrdinal: Number(revision.ordinal),
    body,
    bodySha256: revision.bodySha256,
    bodyCharCount: revision.body.length,
    outline,
    ...(episode ? { episode } : {}),
    builtAt: new Date().toISOString(),
  };
}
