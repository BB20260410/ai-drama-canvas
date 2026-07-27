import { randomUUID } from "node:crypto";
import { appendEvent, getSidecarPaths, readJson, writeJsonAtomic } from "./sidecar.js";
import { getProjectIndex } from "./service.js";
import type { CanvasEntity, CanvasEntityColor, CanvasEntityKind, CanvasHistoryInfo, CanvasLinkKind, CanvasSemanticLink, CanvasSemanticState, ProjectEvent } from "./types.js";
import { withProjectLock as withFileLock } from "./locks.js";

const COLORS = new Set<CanvasEntityColor>(["gold", "blue", "green", "red", "purple", "gray"]);
const ENTITY_KINDS = new Set<CanvasEntityKind>(["note", "group"]);
const LINK_KINDS = new Set<CanvasLinkKind>(["continuity", "reference", "dependency", "comment"]);
const MAX_HISTORY_ENTRIES = 80;
const MAX_HISTORY_BYTES = 8 * 1024 * 1024;

interface CanvasHistoryFile {
  schemaVersion: 1;
  undo: CanvasSemanticState[];
  redo: CanvasSemanticState[];
}

function emptyState(): CanvasSemanticState {
  return { schemaVersion: 1, revision: 0, entities: [], links: [], updatedAt: new Date(0).toISOString() };
}

export async function getCanvasSemanticState(projectRoot: string): Promise<CanvasSemanticState> {
  const state = await readJson(getSidecarPaths(projectRoot).canvasSemantic, emptyState());
  state.entities = (state.entities ?? []).map((entity) => ({ ...entity, memberIds: entity.memberIds ?? [], memberOffsets: entity.memberOffsets ?? {} }));
  state.links = state.links ?? [];
  return state;
}

async function withProjectLock<T>(projectRoot: string, operation: () => Promise<T>): Promise<T> {
  return withFileLock(projectRoot, "canvas", operation);
}

function cloneState(state: CanvasSemanticState): CanvasSemanticState {
  return JSON.parse(JSON.stringify(state)) as CanvasSemanticState;
}

async function loadHistory(projectRoot: string): Promise<CanvasHistoryFile> {
  return readJson(getSidecarPaths(projectRoot).canvasHistory, { schemaVersion: 1, undo: [], redo: [] });
}

function trimHistory(history: CanvasHistoryFile): void {
  history.undo = history.undo.slice(-MAX_HISTORY_ENTRIES);
  history.redo = history.redo.slice(-MAX_HISTORY_ENTRIES);
  while (history.undo.length > 1 && Buffer.byteLength(JSON.stringify(history), "utf8") > MAX_HISTORY_BYTES) history.undo.shift();
  while (history.redo.length > 1 && Buffer.byteLength(JSON.stringify(history), "utf8") > MAX_HISTORY_BYTES) history.redo.shift();
}

async function mutateState<T>(projectRoot: string, mutation: (state: CanvasSemanticState) => T | Promise<T>): Promise<{ state: CanvasSemanticState; result: T }> {
  return withProjectLock(projectRoot, async () => {
    const state = await getCanvasSemanticState(projectRoot);
    const previous = cloneState(state);
    const result = await mutation(state);
    state.revision += 1;
    state.updatedAt = new Date().toISOString();
    const history = await loadHistory(projectRoot);
    history.undo.push(previous);
    history.redo = [];
    trimHistory(history);
    await writeJsonAtomic(getSidecarPaths(projectRoot).canvasHistory, history);
    await writeJsonAtomic(getSidecarPaths(projectRoot).canvasSemantic, state);
    return { state, result };
  });
}

function finite(value: unknown, fallback: number): number {
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
}

function normalizeEntity(input: Partial<CanvasEntity> & Pick<CanvasEntity, "kind" | "title">, previous?: CanvasEntity): CanvasEntity {
  if (!ENTITY_KINDS.has(input.kind)) throw new Error("画布实体只支持批注或分组。");
  const title = input.title.normalize("NFKC").trim().slice(0, 120);
  if (!title) throw new Error("画布实体标题不能为空。");
  const body = String(input.body ?? previous?.body ?? "").slice(0, 20_000);
  const color = COLORS.has(input.color as CanvasEntityColor) ? input.color as CanvasEntityColor : previous?.color ?? "gold";
  const position = {
    x: Math.round(finite(input.position?.x, previous?.position.x ?? 0) * 100) / 100,
    y: Math.round(finite(input.position?.y, previous?.position.y ?? 0) * 100) / 100,
  };
  const defaultWidth = input.kind === "group" ? 720 : 280;
  const defaultHeight = input.kind === "group" ? 420 : 190;
  const width = Math.max(input.kind === "group" ? 300 : 220, Math.min(finite(input.width, previous?.width ?? defaultWidth), input.kind === "group" ? 2_400 : 720));
  const height = Math.max(input.kind === "group" ? 180 : 120, Math.min(finite(input.height, previous?.height ?? defaultHeight), input.kind === "group" ? 1_800 : 900));
  const now = new Date().toISOString();
  const memberIds = [...new Set((input.memberIds ?? previous?.memberIds ?? []).map((id) => String(id).trim()).filter(Boolean))].slice(0, 1_000);
  const sourceOffsets = input.memberOffsets ?? previous?.memberOffsets ?? {};
  const memberOffsets = Object.fromEntries(memberIds.flatMap((id) => {
    const offset = sourceOffsets[id];
    if (!offset) return [];
    return [[id, { x: Math.round(finite(offset.x, 0) * 100) / 100, y: Math.round(finite(offset.y, 0) * 100) / 100 }]];
  }));
  return {
    id: previous?.id ?? input.id ?? `canvas-${input.kind}-${randomUUID().slice(0, 12)}`,
    kind: input.kind,
    title,
    body,
    color,
    position,
    width,
    height,
    memberIds,
    memberOffsets,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
  };
}

export async function upsertCanvasEntity(
  projectRoot: string,
  input: Partial<CanvasEntity> & Pick<CanvasEntity, "kind" | "title">,
  actor: ProjectEvent["actor"] = "user",
): Promise<{ state: CanvasSemanticState; entity: CanvasEntity }> {
  if (input.kind === "group" && input.memberIds) {
    const validIds = new Set((await getProjectIndex(projectRoot)).items.map((item) => item.id));
    const unknown = input.memberIds.filter((id) => !validIds.has(id));
    if (unknown.length) throw new Error(`分组包含当前真实索引中不存在的生产节点：${unknown.slice(0, 5).join("、")}`);
  }
  const output = await mutateState(projectRoot, (state) => {
    const existing = input.id ? state.entities.find((entity) => entity.id === input.id) : undefined;
    if (input.id && !existing) throw new Error(`找不到画布实体：${input.id}`);
    const entity = normalizeEntity(input, existing);
    if (entity.kind === "group") {
      const duplicateMember = entity.memberIds.find((memberId) => state.entities.some((candidate) => candidate.kind === "group" && candidate.id !== entity.id && candidate.memberIds.includes(memberId)));
      if (duplicateMember) throw new Error(`生产节点 ${duplicateMember} 已属于其他自定义分组。`);
    }
    if (existing) state.entities.splice(state.entities.indexOf(existing), 1, entity);
    else state.entities.push(entity);
    return entity;
  });
  await appendEvent(projectRoot, { actor, type: "canvas.entity_upserted", data: { id: output.result.id, kind: output.result.kind } });
  return { state: output.state, entity: output.result };
}

export async function moveCanvasEntities(projectRoot: string, positions: Record<string, { x: number; y: number }>): Promise<CanvasSemanticState> {
  const output = await mutateState(projectRoot, (state) => {
    for (const [id, position] of Object.entries(positions)) {
      const entity = state.entities.find((candidate) => candidate.id === id);
      if (!entity) continue;
      entity.position = { x: Math.round(finite(position.x, entity.position.x) * 100) / 100, y: Math.round(finite(position.y, entity.position.y) * 100) / 100 };
      entity.updatedAt = new Date().toISOString();
    }
    return undefined;
  });
  return output.state;
}

export async function deleteCanvasEntity(projectRoot: string, entityId: string, actor: ProjectEvent["actor"] = "user"): Promise<CanvasSemanticState> {
  const output = await mutateState(projectRoot, (state) => {
    if (!state.entities.some((entity) => entity.id === entityId)) throw new Error(`找不到画布实体：${entityId}`);
    state.entities = state.entities.filter((entity) => entity.id !== entityId);
    state.links = state.links.filter((link) => link.sourceId !== entityId && link.targetId !== entityId);
    return undefined;
  });
  await appendEvent(projectRoot, { actor, type: "canvas.entity_deleted", data: { id: entityId } });
  return output.state;
}

export async function upsertCanvasLink(
  projectRoot: string,
  input: Partial<CanvasSemanticLink> & Pick<CanvasSemanticLink, "sourceId" | "targetId">,
  actor: ProjectEvent["actor"] = "user",
): Promise<{ state: CanvasSemanticState; link: CanvasSemanticLink }> {
  if (input.sourceId === input.targetId) throw new Error("画布关系线不能连接节点自身。");
  const index = await getProjectIndex(projectRoot);
  const output = await mutateState(projectRoot, (state) => {
    const validIds = new Set([...index.items.map((item) => item.id), ...state.entities.map((entity) => entity.id)]);
    if (!validIds.has(input.sourceId) || !validIds.has(input.targetId)) throw new Error("画布关系线端点不存在于当前索引或自定义实体中。");
    const existing = input.id ? state.links.find((link) => link.id === input.id) : undefined;
    if (input.id && !existing) throw new Error(`找不到画布关系线：${input.id}`);
    const kind = LINK_KINDS.has(input.kind as CanvasLinkKind) ? input.kind as CanvasLinkKind : existing?.kind ?? "comment";
    const now = new Date().toISOString();
    const link: CanvasSemanticLink = {
      id: existing?.id ?? input.id ?? `canvas-link-${randomUUID().slice(0, 12)}`,
      sourceId: input.sourceId,
      targetId: input.targetId,
      kind,
      label: String(input.label ?? existing?.label ?? "").trim().slice(0, 160) || undefined,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    const duplicate = state.links.find((candidate) => candidate.id !== link.id && candidate.sourceId === link.sourceId && candidate.targetId === link.targetId && candidate.kind === link.kind);
    if (duplicate) throw new Error("相同端点和类型的画布关系线已存在。");
    if (existing) state.links.splice(state.links.indexOf(existing), 1, link);
    else state.links.push(link);
    return link;
  });
  await appendEvent(projectRoot, { actor, type: "canvas.link_upserted", data: { id: output.result.id, sourceId: output.result.sourceId, targetId: output.result.targetId, kind: output.result.kind } });
  return { state: output.state, link: output.result };
}

export async function deleteCanvasLink(projectRoot: string, linkId: string, actor: ProjectEvent["actor"] = "user"): Promise<CanvasSemanticState> {
  const output = await mutateState(projectRoot, (state) => {
    if (!state.links.some((link) => link.id === linkId)) throw new Error(`找不到画布关系线：${linkId}`);
    state.links = state.links.filter((link) => link.id !== linkId);
    return undefined;
  });
  await appendEvent(projectRoot, { actor, type: "canvas.link_deleted", data: { id: linkId } });
  return output.state;
}

export async function getCanvasHistoryInfo(projectRoot: string): Promise<CanvasHistoryInfo> {
  const [state, history] = await Promise.all([getCanvasSemanticState(projectRoot), loadHistory(projectRoot)]);
  return { canUndo: history.undo.length > 0, canRedo: history.redo.length > 0, undoCount: history.undo.length, redoCount: history.redo.length, revision: state.revision };
}

export async function undoCanvasSemanticState(projectRoot: string, actor: ProjectEvent["actor"] = "user"): Promise<{ state: CanvasSemanticState; history: CanvasHistoryInfo }> {
  const result = await withProjectLock(projectRoot, async () => {
    const current = await getCanvasSemanticState(projectRoot);
    const history = await loadHistory(projectRoot);
    const previous = history.undo.pop();
    if (!previous) throw new Error("没有可撤销的画布操作。");
    history.redo.push(cloneState(current));
    const restored = cloneState(previous);
    restored.revision = current.revision + 1;
    restored.updatedAt = new Date().toISOString();
    trimHistory(history);
    await writeJsonAtomic(getSidecarPaths(projectRoot).canvasHistory, history);
    await writeJsonAtomic(getSidecarPaths(projectRoot).canvasSemantic, restored);
    return { state: restored, history: { canUndo: history.undo.length > 0, canRedo: true, undoCount: history.undo.length, redoCount: history.redo.length, revision: restored.revision } };
  });
  await appendEvent(projectRoot, { actor, type: "canvas.undo", data: { revision: result.state.revision } });
  return result;
}

export async function redoCanvasSemanticState(projectRoot: string, actor: ProjectEvent["actor"] = "user"): Promise<{ state: CanvasSemanticState; history: CanvasHistoryInfo }> {
  const result = await withProjectLock(projectRoot, async () => {
    const current = await getCanvasSemanticState(projectRoot);
    const history = await loadHistory(projectRoot);
    const next = history.redo.pop();
    if (!next) throw new Error("没有可重做的画布操作。");
    history.undo.push(cloneState(current));
    const restored = cloneState(next);
    restored.revision = current.revision + 1;
    restored.updatedAt = new Date().toISOString();
    trimHistory(history);
    await writeJsonAtomic(getSidecarPaths(projectRoot).canvasHistory, history);
    await writeJsonAtomic(getSidecarPaths(projectRoot).canvasSemantic, restored);
    return { state: restored, history: { canUndo: true, canRedo: history.redo.length > 0, undoCount: history.undo.length, redoCount: history.redo.length, revision: restored.revision } };
  });
  await appendEvent(projectRoot, { actor, type: "canvas.redo", data: { revision: result.state.revision } });
  return result;
}
