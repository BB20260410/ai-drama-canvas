import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { listAssetRelations, listVoiceIdentities, upsertAssetRelation, upsertVoiceIdentity } from "../src/core/asset-registry.js";
import { executeIdempotentCommand, listCommandLedger } from "../src/core/command-bus.js";
import { getProjectIndex, scanAndPersist } from "../src/core/service.js";
import { ensureSidecar, getSidecarPaths, listEvents, loadIndex, writeJsonAtomic } from "../src/core/sidecar.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-assets-"));
  roots.push(root);
  const config = await ensureSidecar(root);
  config.sourceRoots = [];
  config.outputRoots = [root];
  await writeJsonAtomic(getSidecarPaths(root).config, config);
  for (const [number, title] of [[1, "角色母版"], [2, "角色表情版"]] as const) {
    const directory = path.join(root, `EP01_15s_00${number}_${title}`);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "00_信息.md"), `首帧提示词：${title}\n尾帧提示词：保持角色身份。\n`, "utf8");
  }
  const lockPath = path.join(root, "00_全剧资产锁定", "01_人物三视图", "P01_阿航_三视图_硬锁.png");
  await mkdir(path.dirname(lockPath), { recursive: true });
  await sharp({ create: { width: 720, height: 1280, channels: 3, background: "#7b603f" } }).png().toFile(lockPath);
  const samplePath = path.join(root, "阿航_音色样本.wav");
  await writeFile(samplePath, "RIFF-test-fixture", "utf8");
  await scanAndPersist(root);
  return { root, samplePath };
}

describe("衍生资产关系与角色音色身份", () => {
  it("资产关系与音色身份对既有事实强制 revision CAS", async () => {
    const { root } = await fixture();
    const relation = await upsertAssetRelation(root, { kind: "derived_from", parentItemId: "main-ep01-unit001", childItemId: "main-ep01-unit002", operation: "初始关系" });
    await expect(upsertAssetRelation(root, { kind: "reference_of", parentItemId: "main-ep01-unit001", childItemId: "main-ep01-unit002", expectedRevision: 1 } as any)).rejects.toMatchObject({ name: "RejectedCommandFailure", result: { reason: "invalid_create_revision", entityType: "asset_relation" } });
    await expect(upsertAssetRelation(root, { id: "asset-relation-missing", kind: relation.kind, parentItemId: relation.parentItemId, childItemId: relation.childItemId, expectedRevision: 1 })).rejects.toMatchObject({ name: "RejectedCommandFailure", result: { reason: "not_found" } });
    await expect(upsertAssetRelation(root, { id: relation.id, kind: relation.kind, parentItemId: relation.parentItemId, childItemId: relation.childItemId } as any)).rejects.toMatchObject({ name: "RejectedCommandFailure", result: { reason: "revision_required", currentRevision: relation.revision } });
    await expect(upsertAssetRelation(root, { id: relation.id, kind: relation.kind, parentItemId: relation.parentItemId, childItemId: relation.childItemId, expectedRevision: relation.revision + 1 })).rejects.toMatchObject({ name: "RejectedCommandFailure", result: { reason: "revision_conflict" } });
    const relationRace = await Promise.allSettled([
      upsertAssetRelation(root, { id: relation.id, kind: relation.kind, parentItemId: relation.parentItemId, childItemId: relation.childItemId, operation: "窗口 A", expectedRevision: relation.revision }),
      upsertAssetRelation(root, { id: relation.id, kind: relation.kind, parentItemId: relation.parentItemId, childItemId: relation.childItemId, operation: "窗口 B", expectedRevision: relation.revision }),
    ]);
    expect(relationRace.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(relationRace.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect((await listAssetRelations(root)).find((candidate) => candidate.id === relation.id)?.revision).toBe(relation.revision + 1);

    const voice = await upsertVoiceIdentity(root, { name: "阿航声线", description: "低沉", tags: ["主角"] });
    await expect(upsertVoiceIdentity(root, { name: "非法创建", expectedRevision: 1 } as any)).rejects.toMatchObject({ name: "RejectedCommandFailure", result: { reason: "invalid_create_revision", entityType: "voice_identity" } });
    await expect(upsertVoiceIdentity(root, { id: "voice-missing", name: voice.name, expectedRevision: 1 })).rejects.toMatchObject({ name: "RejectedCommandFailure", result: { reason: "not_found" } });
    await expect(upsertVoiceIdentity(root, { id: voice.id, name: voice.name } as any)).rejects.toMatchObject({ name: "RejectedCommandFailure", result: { reason: "revision_required" } });
    await expect(upsertVoiceIdentity(root, { id: voice.id, name: voice.name, expectedRevision: voice.revision + 1 })).rejects.toMatchObject({ name: "RejectedCommandFailure", result: { reason: "revision_conflict" } });
    const voiceRace = await Promise.allSettled([
      upsertVoiceIdentity(root, { id: voice.id, name: "窗口 A", expectedRevision: voice.revision }),
      upsertVoiceIdentity(root, { id: voice.id, name: "窗口 B", expectedRevision: voice.revision }),
    ]);
    expect(voiceRace.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(voiceRace.filter((result) => result.status === "rejected")).toHaveLength(1);
    const persistedVoice = (await listVoiceIdentities(root)).find((candidate) => candidate.id === voice.id)!;
    expect(persistedVoice.revision).toBe(voice.revision + 1);
    expect(persistedVoice.tags).toEqual(["主角"]);
  });

  it("CAS 写前拒绝不会隐式扫描尚未建立索引的项目", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-assets-no-index-"));
    roots.push(root);
    await ensureSidecar(root);
    const paths = getSidecarPaths(root);
    const now = new Date().toISOString();
    await writeJsonAtomic(paths.assetRelations, { schemaVersion: 1, revision: 1, updatedAt: now, relations: [{ id: "asset-relation-existing", kind: "reference_of", parentItemId: "parent", childItemId: "child", revision: 1, createdAt: now, updatedAt: now }] });
    await writeJsonAtomic(paths.voiceIdentities, { schemaVersion: 1, revision: 1, updatedAt: now, voices: [{ id: "voice-existing", name: "既有音色", language: "zh-CN", description: "", samplePaths: [], characterItemIds: [], tags: [], revision: 1, createdAt: now, updatedAt: now }] });

    await expect(upsertAssetRelation(root, { id: "asset-relation-existing", kind: "reference_of", parentItemId: "parent", childItemId: "child" } as any)).rejects.toMatchObject({ name: "RejectedCommandFailure", result: { reason: "revision_required" } });
    await expect(upsertVoiceIdentity(root, { id: "voice-existing", name: "既有音色" } as any)).rejects.toMatchObject({ name: "RejectedCommandFailure", result: { reason: "revision_required" } });
    expect(await loadIndex(root)).toBeNull();
    expect((await listEvents(root, 100)).some((event) => event.type === "project.scanned")).toBe(false);
  });

  it("保存可追溯资产血缘并阻止循环关系", async () => {
    const { root } = await fixture();
    const relation = await upsertAssetRelation(root, { kind: "derived_from", parentItemId: "main-ep01-unit001", childItemId: "main-ep01-unit002", operation: "由角色母版生成表情版" });
    expect((await listAssetRelations(root))[0]?.id).toBe(relation.id);
    await expect(upsertAssetRelation(root, { kind: "variant_of", parentItemId: "main-ep01-unit002", childItemId: "main-ep01-unit001" })).rejects.toThrow("形成循环");
    await expect(upsertAssetRelation(root, { kind: "reference_of", parentItemId: "missing", childItemId: "main-ep01-unit002" })).rejects.toThrow("不存在的节点");
  });

  it("把音色样本绑定到真实节点与硬锁，不保存供应商密钥", async () => {
    const { root, samplePath } = await fixture();
    const index = await getProjectIndex(root);
    const lock = index.project.hardLocks[0]!;
    const voice = await upsertVoiceIdentity(root, { name: "阿航成年声线", provider: "browser-provider", providerVoiceId: "voice-ahang-v1", language: "zh-CN", description: "低沉、克制", samplePaths: [samplePath], characterItemIds: ["main-ep01-unit001"], hardLockId: lock.id });
    expect(voice.samplePaths).toEqual([samplePath]);
    expect(voice.characterAssetIds).toEqual([]);
    expect(voice.sampleMediaSha256s).toEqual([]);
    expect((await listVoiceIdentities(root))[0]?.providerVoiceId).toBe("voice-ahang-v1");
    await expect(upsertVoiceIdentity(root, { name: "坏样本", samplePaths: [path.join(root, "missing.wav")] })).rejects.toThrow("音色样本不存在");
  });

  it("可以把 CAS 音频 SHA 绑到规范角色资产，供画布自动带出", async () => {
    const { root } = await fixture();
    const sha = "ab".repeat(32);
    const voice = await upsertVoiceIdentity(root, {
      name: "阿航画布声线",
      characterAssetIds: ["char-ahang"],
      sampleMediaSha256s: [sha],
    });
    expect(voice.characterAssetIds).toEqual(["char-ahang"]);
    expect(voice.sampleMediaSha256s).toEqual([sha]);
    const listed = await listVoiceIdentities(root);
    expect(listed[0]?.characterAssetIds).toEqual(["char-ahang"]);
    await expect(upsertVoiceIdentity(root, { name: "坏 SHA", sampleMediaSha256s: ["not-a-hash"] })).rejects.toThrow("无效 SHA-256");
  });

  it("Codex 经统一幂等入口写入资产关系且重复请求不二次执行", async () => {
    const { root } = await fixture();
    const input = {
      requestId: "request-asset-relation-0001",
      idempotencyKey: "asset-relation-unit001-unit002-v1",
      request: { command: "upsert_asset_relation" as const, payload: { kind: "derived_from" as const, parentItemId: "main-ep01-unit001", childItemId: "main-ep01-unit002", operation: "表情衍生" } },
    };
    const first = await executeIdempotentCommand(root, input);
    const replay = await executeIdempotentCommand(root, { ...input, requestId: "request-asset-relation-0002" });
    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(await listAssetRelations(root)).toHaveLength(1);
    expect(await listCommandLedger(root)).toHaveLength(1);
  });
});
