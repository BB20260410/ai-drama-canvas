import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createStudioCanonicalAsset,
  getStudioIdentityIndexSnapshot,
  listStudioIdentityIndex,
  loadStudioIdentityIndexForAnalysis,
  normalizeStudioIdentityKey,
  updateStudioCanonicalAsset,
} from "../src/core/material-studio.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function project(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-identity-index-"));
  roots.push(root);
  return root;
}

describe("P6 素材精确身份索引", () => {
  it("只按 NFKC 精确键返回 id、正式名和 alias，不使用 substring", async () => {
    const root = await project();
    await createStudioCanonicalAsset(root, {
      id: "C01",
      expectedRevision: 0,
      category: "character",
      name: "阿航",
      aliases: ["航哥", "ＡＨＡＮＧ"],
    });

    const id = await getStudioIdentityIndexSnapshot(root, ["ｃ０１"]);
    expect(id.entries.map((entry) => [entry.assetId, entry.matchKind])).toEqual([["C01", "id"]]);
    const formal = await getStudioIdentityIndexSnapshot(root, [" 阿航 "]);
    expect(formal.entries.some((entry) => entry.matchKind === "formal-name" && entry.assetId === "C01")).toBe(true);
    const alias = await getStudioIdentityIndexSnapshot(root, ["ahang"]);
    expect(alias.entries.some((entry) => entry.matchKind === "alias" && entry.matchedValue === "ＡＨＡＮＧ")).toBe(true);
    expect((await getStudioIdentityIndexSnapshot(root, ["阿"])).entries).toEqual([]);
    expect(normalizeStudioIdentityKey("  ＡＨＡＮＧ\t ")).toBe("ahang");
  });

  it("同一 confirmed alias 可保留多个候选，且无关资产变更不漂移该键 fingerprint", async () => {
    const root = await project();
    const first = await createStudioCanonicalAsset(root, {
      id: "C01",
      expectedRevision: 0,
      category: "character",
      name: "阿航",
      aliases: ["队长"],
    });
    const second = await createStudioCanonicalAsset(root, {
      id: "C02",
      expectedRevision: 0,
      category: "character",
      name: "阿仲",
      aliases: ["队长"],
    });
    const unrelated = await createStudioCanonicalAsset(root, {
      id: "S01",
      expectedRevision: 0,
      category: "scene",
      name: "封神榜缝",
    });

    const before = await getStudioIdentityIndexSnapshot(root, ["队长"]);
    expect(before.entries.filter((entry) => entry.matchKind === "alias").map((entry) => entry.assetId)).toEqual(["C01", "C02"]);
    await updateStudioCanonicalAsset(root, {
      assetId: unrelated.id,
      expectedRevision: unrelated.revision,
      description: "只修改无关场景说明",
    });
    expect((await getStudioIdentityIndexSnapshot(root, ["队长"])).fingerprint).toBe(before.fingerprint);

    await updateStudioCanonicalAsset(root, {
      assetId: first.id,
      expectedRevision: first.revision,
      aliases: ["领队"],
    });
    const stillAmbiguous = await getStudioIdentityIndexSnapshot(root, ["队长"]);
    expect(stillAmbiguous.entries.filter((entry) => entry.matchKind === "alias")).toHaveLength(2);
    const newKey = await getStudioIdentityIndexSnapshot(root, ["领队"]);
    expect(newKey.entries.map((entry) => entry.assetId)).toEqual(["C01"]);
    expect(second.revision).toBe(1);
  });

  it("身份索引使用有界 keyset 页面，换页不重复", async () => {
    const root = await project();
    for (let index = 0; index < 12; index += 1) {
      await createStudioCanonicalAsset(root, {
        id: `P${String(index).padStart(2, "0")}`,
        expectedRevision: 0,
        category: "prop",
        name: `道具${String(index).padStart(2, "0")}`,
      });
    }
    const first = await listStudioIdentityIndex(root, { limit: 10 });
    const second = await listStudioIdentityIndex(root, { cursor: first.nextCursor, limit: 10 });
    expect(first.entries).toHaveLength(10);
    expect(second.entries).toHaveLength(10);
    expect(first.nextCursor).toBeTruthy();
    expect(new Set([...first.entries, ...second.entries].map((entry) => entry.id)).size).toBe(20);
    const analyzerSnapshot = await loadStudioIdentityIndexForAnalysis(root);
    expect(analyzerSnapshot.entries).toHaveLength(36);
    expect(new Set(analyzerSnapshot.entries.map((entry) => entry.id)).size).toBe(36);
    expect(new Set(analyzerSnapshot.entries.map((entry) => entry.assetId)).size).toBe(12);
    expect(analyzerSnapshot.nextCursor).toBeUndefined();
    await expect(listStudioIdentityIndex(root, { limit: 101 })).rejects.toThrow("1-100");
  });
});
