import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import path from "node:path";
import { getProjectIndex } from "./service.js";
import { appendEvent, getSidecarPaths, readJson, writeJsonAtomic } from "./sidecar.js";
import type { AssetRelation, AssetRelationKind, AssetRelationUpsertInput, VoiceIdentity, VoiceIdentityUpsertInput } from "./types.js";
import { withProjectLock } from "./locks.js";
import { assertRevisionedUpsert, RejectedCommandFailure } from "./command-outcome.js";
import {
  inspectCanonicalAssetStoreCurrentness,
  loadCanonicalAssetStore,
  type CanonicalAssetRelation,
  type CanonicalAssetStore,
} from "./canonical-assets.js";

interface RelationStore { schemaVersion: 1; revision: number; relations: AssetRelation[]; updatedAt: string }
interface VoiceStore { schemaVersion: 1; revision: number; voices: VoiceIdentity[]; updatedAt: string }

async function loadRelationStore(projectRoot: string): Promise<RelationStore> {
  return readJson(getSidecarPaths(projectRoot).assetRelations, { schemaVersion: 1, revision: 0, relations: [], updatedAt: new Date(0).toISOString() });
}

async function loadVoiceStore(projectRoot: string): Promise<VoiceStore> {
  return readJson(getSidecarPaths(projectRoot).voiceIdentities, { schemaVersion: 1, revision: 0, voices: [], updatedAt: new Date(0).toISOString() });
}

export async function listAssetRelations(projectRoot: string, options: { itemId?: string; artifactId?: string; kind?: AssetRelationKind } = {}): Promise<AssetRelation[]> {
  const canonicalStore = await loadCanonicalAssetStore(projectRoot);
  if (canonicalStore) {
    const currentness = await inspectCanonicalAssetStoreCurrentness(projectRoot);
    if (!currentness.current) {
      throw new Error(`规范资产库已漂移，禁止返回旧资产关系：${currentness.issues.join("；") || currentness.driftedInputs.join("、")}`);
    }
    return canonicalRelationsAsLegacyProjection(canonicalStore)
      .filter((relation) => !options.itemId || relation.parentItemId === options.itemId || relation.childItemId === options.itemId)
      .filter((relation) => !options.artifactId || relation.parentArtifactId === options.artifactId || relation.childArtifactId === options.artifactId)
      .filter((relation) => !options.kind || relation.kind === options.kind)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  return (await loadRelationStore(projectRoot)).relations
    .filter((relation) => !options.itemId || relation.parentItemId === options.itemId || relation.childItemId === options.itemId)
    .filter((relation) => !options.artifactId || relation.parentArtifactId === options.artifactId || relation.childArtifactId === options.artifactId)
    .filter((relation) => !options.kind || relation.kind === options.kind)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function canonicalRelationsAsLegacyProjection(store: CanonicalAssetStore): AssetRelation[] {
  const assetWorkItemById = new Map(store.assets.map((asset) => [asset.id, asset.source.workItemId]));
  const versionById = new Map(store.versions.map((version) => [version.id, version]));
  const legacyKinds = new Set<AssetRelationKind>(["derived_from", "variant_of", "reference_of"]);
  const endpoint = (value: CanonicalAssetRelation["from"]): { itemId?: string; artifactId?: string } => {
    if (value.kind === "asset") return { itemId: assetWorkItemById.get(value.id) };
    const version = versionById.get(value.id);
    const artifactId = version?.media.find((media) => media.role === "raw" && media.artifactId)?.artifactId
      ?? version?.media.find((media) => media.artifactId)?.artifactId;
    return artifactId ? { artifactId } : {};
  };
  const result: AssetRelation[] = [];
  for (const relation of store.relations) {
    if (!legacyKinds.has(relation.kind as AssetRelationKind)) continue;
    const parent = endpoint(relation.from);
    const child = endpoint(relation.to);
    if ((!parent.itemId && !parent.artifactId) || (!child.itemId && !child.artifactId)) {
      throw new Error(`规范资产关系 ${relation.id} 无法无损投影到旧关系接口。`);
    }
    result.push({
      id: relation.id,
      kind: relation.kind as AssetRelationKind,
      parentItemId: parent.itemId,
      parentArtifactId: parent.artifactId,
      childItemId: child.itemId,
      childArtifactId: child.artifactId,
      operation: relation.evidenceSource,
      note: "只读兼容投影；唯一事实源为 canonical-assets.json",
      revision: store.revision,
      createdAt: store.updatedAt,
      updatedAt: store.updatedAt,
    });
  }
  return result;
}

function relationNode(artifactId?: string, itemId?: string): string | undefined {
  return artifactId ? `artifact:${artifactId}` : itemId ? `item:${itemId}` : undefined;
}

export async function upsertAssetRelation(
  projectRoot: string,
  input: AssetRelationUpsertInput,
  actor: "user" | "codex" = "codex",
): Promise<AssetRelation> {
  return withProjectLock(projectRoot, "asset-registry", async () => {
  const canonicalStore = await loadCanonicalAssetStore(projectRoot);
  if (canonicalStore) {
    throw new RejectedCommandFailure(
      "规范资产知识库已启用；旧 asset-relations.json 写入口已停用，关系只能通过规范资产 CAS 命令追加。",
      {
        schemaVersion: 1,
        applied: false,
        reason: "canonical_asset_relation_requires_canonical_command",
        entityType: "canonical_asset_relation",
        canonicalStoreRevision: canonicalStore.revision,
      },
    );
  }
  const store = await loadRelationStore(projectRoot);
  const existing = typeof input.id === "string" && input.id.trim() ? store.relations.find((relation) => relation.id === input.id) : undefined;
  assertRevisionedUpsert({ id: input.id, expectedRevision: input.expectedRevision, currentRevision: existing?.revision, entityType: "asset_relation", entityLabel: "资产关系" });
  const parentArtifactId = input.parentArtifactId ?? existing?.parentArtifactId;
  const parentItemId = input.parentItemId ?? existing?.parentItemId;
  const childArtifactId = input.childArtifactId ?? existing?.childArtifactId;
  const childItemId = input.childItemId ?? existing?.childItemId;
  const parent = relationNode(parentArtifactId, parentItemId);
  const child = relationNode(childArtifactId, childItemId);
  if (!parent || !child) throw new Error("资产关系的父端和子端都必须提供 artifactId 或 itemId。 ");
  if (parent === child) throw new Error("资产关系不能自连接。 ");
  const index = await getProjectIndex(projectRoot);
  const artifactIds = new Set(index.artifacts.map((artifact) => artifact.id));
  const itemIds = new Set(index.items.map((item) => item.id));
  for (const artifactId of [parentArtifactId, childArtifactId].filter((value): value is string => Boolean(value))) if (!artifactIds.has(artifactId)) throw new Error(`资产关系引用不存在的素材：${artifactId}`);
  for (const itemId of [parentItemId, childItemId].filter((value): value is string => Boolean(value))) if (!itemIds.has(itemId)) throw new Error(`资产关系引用不存在的节点：${itemId}`);
  if (["derived_from", "variant_of"].includes(input.kind)) {
    const graph = new Map<string, string[]>();
    for (const relation of store.relations.filter((relation) => relation.id !== existing?.id && ["derived_from", "variant_of"].includes(relation.kind))) {
      const from = relationNode(relation.parentArtifactId, relation.parentItemId);
      const to = relationNode(relation.childArtifactId, relation.childItemId);
      if (from && to) graph.set(from, [...(graph.get(from) ?? []), to]);
    }
    graph.set(parent, [...(graph.get(parent) ?? []), child]);
    const queue = [child]; const seen = new Set<string>();
    while (queue.length) { const current = queue.shift()!; if (current === parent) throw new Error("资产衍生关系会形成循环。 "); if (seen.has(current)) continue; seen.add(current); queue.push(...(graph.get(current) ?? [])); }
  }
  const now = new Date().toISOString();
  const relation: AssetRelation = { id: existing?.id ?? `asset-relation-${randomUUID()}`, kind: input.kind, parentArtifactId, parentItemId, childArtifactId, childItemId, operation: input.operation === undefined ? existing?.operation : input.operation.trim().slice(0, 2_000) || undefined, note: input.note === undefined ? existing?.note : input.note.trim().slice(0, 8_000) || undefined, revision: (existing?.revision ?? 0) + 1, createdAt: existing?.createdAt ?? now, updatedAt: now };
  store.relations = [relation, ...store.relations.filter((candidate) => candidate.id !== relation.id)];
  store.revision += 1; store.updatedAt = now;
  await writeJsonAtomic(getSidecarPaths(projectRoot).assetRelations, store);
  await appendEvent(projectRoot, { actor, type: "asset.relation-upserted", itemId: relation.childItemId, data: { relationId: relation.id, kind: relation.kind, parentArtifactId: relation.parentArtifactId, childArtifactId: relation.childArtifactId, revision: relation.revision } });
  return relation;
  });
}

export async function listVoiceIdentities(projectRoot: string): Promise<VoiceIdentity[]> {
  return (await loadVoiceStore(projectRoot)).voices.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
}

export async function upsertVoiceIdentity(
  projectRoot: string,
  input: VoiceIdentityUpsertInput,
  actor: "user" | "codex" = "codex",
): Promise<VoiceIdentity> {
  return withProjectLock(projectRoot, "asset-registry", async () => {
  const store = await loadVoiceStore(projectRoot);
  const existing = typeof input.id === "string" && input.id.trim() ? store.voices.find((voice) => voice.id === input.id) : undefined;
  assertRevisionedUpsert({ id: input.id, expectedRevision: input.expectedRevision, currentRevision: existing?.revision, entityType: "voice_identity", entityLabel: "音色身份" });
  const samplePaths = [...new Set((input.samplePaths ?? existing?.samplePaths ?? []).map((candidate) => path.resolve(candidate)))];
  for (const samplePath of samplePaths) {
    if (!/\.(wav|mp3|m4a|aac|flac|ogg)$/i.test(samplePath)) throw new Error(`音色样本扩展名不受支持：${samplePath}`);
    await access(samplePath).catch(() => { throw new Error(`音色样本不存在：${samplePath}`); });
  }
  const index = await getProjectIndex(projectRoot);
  const itemIds = new Set(index.items.map((item) => item.id));
  const characterItemIds = [...new Set(input.characterItemIds ?? existing?.characterItemIds ?? [])];
  const missingItems = characterItemIds.filter((id) => !itemIds.has(id));
  if (missingItems.length) throw new Error(`音色绑定了不存在的角色节点：${missingItems.join("、")}`);
  const hardLockId = input.hardLockId === undefined ? existing?.hardLockId : input.hardLockId || undefined;
  if (hardLockId && !index.project.hardLocks.some((lock) => lock.id === hardLockId)) throw new Error(`音色绑定了不存在的硬锁：${hardLockId}`);
  const now = new Date().toISOString();
  const voice: VoiceIdentity = { id: existing?.id ?? `voice-${randomUUID()}`, name: input.name.trim().slice(0, 160), provider: input.provider === undefined ? existing?.provider : input.provider.trim().slice(0, 120) || undefined, providerVoiceId: input.providerVoiceId === undefined ? existing?.providerVoiceId : input.providerVoiceId.trim().slice(0, 500) || undefined, language: input.language === undefined ? existing?.language ?? "zh-CN" : input.language.trim().slice(0, 80) || "zh-CN", description: input.description === undefined ? existing?.description ?? "" : input.description.trim().slice(0, 20_000), samplePaths, characterItemIds, hardLockId, tags: [...new Set((input.tags ?? existing?.tags ?? []).map((tag) => tag.trim()).filter(Boolean))].slice(0, 100), revision: (existing?.revision ?? 0) + 1, createdAt: existing?.createdAt ?? now, updatedAt: now };
  store.voices = [voice, ...store.voices.filter((candidate) => candidate.id !== voice.id)];
  store.revision += 1; store.updatedAt = now;
  await writeJsonAtomic(getSidecarPaths(projectRoot).voiceIdentities, store);
  await appendEvent(projectRoot, { actor, type: "asset.voice-identity-upserted", data: { voiceId: voice.id, name: voice.name, provider: voice.provider, characterItemIds: voice.characterItemIds, hardLockId: voice.hardLockId, revision: voice.revision } });
  return voice;
  });
}
