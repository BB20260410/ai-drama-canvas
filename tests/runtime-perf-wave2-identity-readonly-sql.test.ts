/**
 * Wave 2 §1.3 残差：时间线身份旁路对已有 sqlite 只读打开。
 * 不建受管工程、不走 Darwin dirfd / P7 fixture、不改 T23 热路径。
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  STUDIO_PRODUCTION_UNITS_UNINITIALIZED_MESSAGE,
  listStudioProductionUnitIdentities,
  listStudioProductionUnitIdentitiesByIds,
} from "../src/core/studio-production.js";

const SEASON = "S1";
const EPISODE = "S1E1";

let tempRoot: string | undefined;

afterEach(async () => {
  if (!tempRoot) return;
  await rm(tempRoot, { recursive: true, force: true });
  tempRoot = undefined;
});

async function seedIdentityDatabase(unitCount: number): Promise<string> {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), "runtime-perf-identity-"));
  const sidecar = path.join(tempRoot, ".aicanvas");
  await mkdir(sidecar, { recursive: true });
  const databasePath = path.join(sidecar, "studio-production.sqlite");
  const db = new DatabaseSync(databasePath);
  try {
    db.exec(`
      CREATE TABLE studio_production_units (
        id TEXT PRIMARY KEY,
        season TEXT NOT NULL,
        episode TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        title TEXT NOT NULL,
        revision INTEGER NOT NULL,
        panel_count INTEGER NOT NULL
      );
    `);
    const insert = db.prepare(`
      INSERT INTO studio_production_units(id, season, episode, sequence, title, revision, panel_count)
      VALUES(?, ?, ?, ?, ?, 1, 4)
    `);
    for (let index = 0; index < unitCount; index += 1) {
      insert.run(
        `${EPISODE}-U${String(index).padStart(4, "0")}`,
        SEASON,
        EPISODE,
        index + 1,
        `unit-${index + 1}`,
      );
    }
  } finally {
    db.close();
  }
  return tempRoot;
}

describe("runtime-perf wave2 identity readonly sql", () => {
  it("缺库失败关闭，不建生产库", async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "runtime-perf-identity-missing-"));
    await expect(listStudioProductionUnitIdentities(tempRoot, {
      season: SEASON,
      episode: EPISODE,
      limit: 1,
    })).rejects.toThrow(STUDIO_PRODUCTION_UNITS_UNINITIALIZED_MESSAGE);
    await expect(listStudioProductionUnitIdentitiesByIds(tempRoot, {
      season: SEASON,
      episode: EPISODE,
      unitIds: [`${EPISODE}-U0000`],
    })).rejects.toThrow(STUDIO_PRODUCTION_UNITS_UNINITIALIZED_MESSAGE);
  });

  it("2500 行末页 36 只读 by-id；lean 顶 2500；limit 36 只回前 36", async () => {
    const root = await seedIdentityDatabase(2500);
    const lastPageIds = Array.from({ length: 36 }, (_, index) => (
      `${EPISODE}-U${String(2464 + index).padStart(4, "0")}`
    ));

    const byId = await listStudioProductionUnitIdentitiesByIds(root, {
      season: SEASON,
      episode: EPISODE,
      unitIds: lastPageIds,
    });
    expect(byId.map((unit) => unit.id)).toEqual(lastPageIds);
    expect(byId).toHaveLength(36);
    expect(byId[0]?.sequence).toBe(2465);
    expect(byId[35]?.sequence).toBe(2500);

    const leanAll = await listStudioProductionUnitIdentities(root, {
      season: SEASON,
      episode: EPISODE,
    });
    expect(leanAll).toHaveLength(2500);
    expect(leanAll[0]?.id).toBe(`${EPISODE}-U0000`);
    expect(leanAll[2499]?.id).toBe(`${EPISODE}-U2499`);

    const leanLimit = await listStudioProductionUnitIdentities(root, {
      season: SEASON,
      episode: EPISODE,
      limit: 36,
    });
    expect(leanLimit).toHaveLength(36);
    expect(leanLimit.map((unit) => unit.id)).toEqual(
      Array.from({ length: 36 }, (_, index) => `${EPISODE}-U${String(index).padStart(4, "0")}`),
    );
  });

  it("跨季集 id 省略；空库表失败关闭", async () => {
    const root = await seedIdentityDatabase(2);
    const crossed = await listStudioProductionUnitIdentitiesByIds(root, {
      season: SEASON,
      episode: EPISODE,
      unitIds: [`${EPISODE}-U0000`, "S2E1-U0000"],
    });
    expect(crossed.map((unit) => unit.id)).toEqual([`${EPISODE}-U0000`]);

    const emptyRoot = await mkdtemp(path.join(os.tmpdir(), "runtime-perf-identity-empty-"));
    try {
      const sidecar = path.join(emptyRoot, ".aicanvas");
      await mkdir(sidecar, { recursive: true });
      const db = new DatabaseSync(path.join(sidecar, "studio-production.sqlite"));
      db.close();
      await expect(listStudioProductionUnitIdentities(emptyRoot, {
        season: SEASON,
        episode: EPISODE,
      })).rejects.toThrow(STUDIO_PRODUCTION_UNITS_UNINITIALIZED_MESSAGE);
    } finally {
      await rm(emptyRoot, { recursive: true, force: true });
    }
  });
});
