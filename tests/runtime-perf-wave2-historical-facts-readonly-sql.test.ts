/**
 * Wave 2/3 §1.3 残差：时间线历史 PASS 对已有 sqlite 只读打开，不复制整库。
 * 不建受管工程、不走 Darwin dirfd / P7 fixture。
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { readStudioGenerationProjectionSelectionFactsReadOnly } from "../src/core/studio-generation-historical-imports-read.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = (relative: string) => readFileSync(path.join(repoRoot, relative), "utf8");

const MISSING_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER_SHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

let tempRoot: string | undefined;

afterEach(async () => {
  if (!tempRoot) return;
  await rm(tempRoot, { recursive: true, force: true });
  tempRoot = undefined;
});

async function seedHistoricalFacts(unitCount: number): Promise<{
  databasePath: string;
  projectRoot: string;
  mediaCasRoot: string;
}> {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), "runtime-perf-hist-ro-"));
  const sidecar = path.join(tempRoot, ".aicanvas");
  await mkdir(path.join(sidecar, "studio-generation"), { recursive: true });
  const databasePath = path.join(sidecar, "studio-generation", "ledger.sqlite");
  const mediaCasRoot = path.join(sidecar, "objects", "sha256");
  await mkdir(mediaCasRoot, { recursive: true });
  const db = new DatabaseSync(databasePath);
  try {
    db.exec(`
      CREATE TABLE studio_generation_historical_imports (
        unit_id TEXT NOT NULL,
        import_id TEXT NOT NULL,
        pack_id TEXT NOT NULL,
        pack_fingerprint TEXT NOT NULL,
        unit_revision INTEGER NOT NULL,
        raw_media_sha256 TEXT NOT NULL,
        labeled_media_sha256 TEXT NOT NULL,
        source_raw_sha256 TEXT NOT NULL,
        source_labeled_sha256 TEXT NOT NULL,
        external_storyboard_status TEXT NOT NULL,
        sequence INTEGER NOT NULL
      );
      CREATE TABLE studio_generation_dispatches (
        generation_run_id TEXT NOT NULL,
        pack_fingerprint TEXT NOT NULL
      );
    `);
    const insertImport = db.prepare(`
      INSERT INTO studio_generation_historical_imports(
        unit_id, import_id, pack_id, pack_fingerprint, unit_revision,
        raw_media_sha256, labeled_media_sha256, source_raw_sha256, source_labeled_sha256,
        external_storyboard_status, sequence
      ) VALUES(?, ?, ?, ?, 1, ?, ?, ?, ?, 'PASS', 1)
    `);
    const insertDispatch = db.prepare(`
      INSERT INTO studio_generation_dispatches(generation_run_id, pack_fingerprint)
      VALUES(?, ?)
    `);
    for (let index = 0; index < unitCount; index += 1) {
      const unitId = `S1E1-U${String(index).padStart(4, "0")}`;
      insertImport.run(
        unitId,
        `import-${unitId}`,
        `pack-${unitId}`,
        `fp-${unitId}`,
        MISSING_SHA,
        OTHER_SHA,
        MISSING_SHA,
        OTHER_SHA,
      );
      insertDispatch.run(`run-${unitId}`, `fp-${unitId}`);
    }
  } finally {
    db.close();
  }
  return { databasePath, projectRoot: tempRoot, mediaCasRoot };
}

describe("runtime-perf wave2 historical facts readonly sql", () => {
  it("空输入 / 缺库返回空事实，不建文件", async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "runtime-perf-hist-missing-"));
    const missing = path.join(tempRoot, "missing-ledger.sqlite");
    const empty = await readStudioGenerationProjectionSelectionFactsReadOnly({
      databasePath: missing,
      projectRoot: tempRoot,
      mediaCasRoot: path.join(tempRoot, "cas"),
    }, { units: [], generationRunIds: [] });
    expect(empty.historicalPassByUnit.size).toBe(0);
    expect(empty.packFingerprintByRunId.size).toBe(0);
    expect(existsSync(missing)).toBe(false);

    const missingDb = await readStudioGenerationProjectionSelectionFactsReadOnly({
      databasePath: missing,
      projectRoot: tempRoot,
      mediaCasRoot: path.join(tempRoot, "cas"),
    }, { units: [{ unitId: "S1E1-U0000", revision: 1 }], generationRunIds: [] });
    expect(missingDb.historicalPassByUnit.size).toBe(0);
    expect(existsSync(missing)).toBe(false);
  });

  it("36 单元只读批读回历史行 + run fingerprint；缺表返回空；不复制整库", async () => {
    const context = await seedHistoricalFacts(36);
    const units = Array.from({ length: 36 }, (_, index) => ({
      unitId: `S1E1-U${String(index).padStart(4, "0")}`,
      revision: 1,
    }));
    const runIds = units.map((unit) => `run-${unit.unitId}`);
    const facts = await readStudioGenerationProjectionSelectionFactsReadOnly(context, {
      units,
      generationRunIds: runIds,
    });
    expect(facts.historicalPassByUnit.size).toBe(36);
    expect(facts.packFingerprintByRunId.size).toBe(36);
    expect(facts.historicalPassByUnit.get("S1E1-U0000")?.importId).toBe("import-S1E1-U0000");
    expect(facts.historicalPassByUnit.get("S1E1-U0035")?.packId).toBe("pack-S1E1-U0035");
    expect(facts.historicalPassByUnit.get("S1E1-U0000")?.verified).toBe(false);
    expect(facts.historicalPassByUnit.get("S1E1-U0000")?.verificationFailures).toEqual(
      expect.arrayContaining([
        "冻结包行缺失或 pack_fingerprint 不匹配",
        "raw 媒体 CAS 对象不可读",
        "labeled 媒体 CAS 对象不可读",
      ]),
    );
    expect(facts.packFingerprintByRunId.get("run-S1E1-U0000")).toBe("fp-S1E1-U0000");
    expect(facts.packFingerprintByRunId.get("run-S1E1-U0035")).toBe("fp-S1E1-U0035");

    const emptyFile = path.join(context.projectRoot, "empty.sqlite");
    const created = new DatabaseSync(emptyFile);
    created.close();
    const emptyFacts = await readStudioGenerationProjectionSelectionFactsReadOnly({
      ...context,
      databasePath: emptyFile,
    }, { units, generationRunIds: runIds });
    expect(emptyFacts.historicalPassByUnit.size).toBe(0);
    expect(emptyFacts.packFingerprintByRunId.size).toBe(0);
  });

  it("源码合同：时间线走 ReadOnly；历史事实不再 snapshot 复制整库", () => {
    const projection = source("src/core/studio-approved-timeline-projection.ts");
    expect(projection).toContain("readStudioGenerationProjectionSelectionFactsReadOnly");
    expect(projection).not.toMatch(/readStudioGenerationProjectionSelectionFacts\(/u);

    const historical = source("src/core/studio-generation-historical-imports-read.ts");
    expect(historical).toContain("openHistoricalFactsReadOnly");
    expect(historical).toContain("readOnly: true");
    expect(historical).toContain("query_only");
    expect(historical).not.toContain("openSqliteReadOnlySnapshot");
    expect(historical).not.toContain("journal_mode");
    const helperStart = historical.indexOf("function openHistoricalFactsReadOnly");
    const helperEnd = historical.indexOf("async function casObjectReadable");
    expect(helperStart).toBeGreaterThan(-1);
    expect(helperEnd).toBeGreaterThan(helperStart);
    const helper = historical.slice(helperStart, helperEnd);
    expect(helper).not.toContain("CREATE TABLE");
    expect(helper).not.toContain("inspectManagedProject");
    expect(helper).not.toContain("ensureConfinedDirectory");
  });
});
