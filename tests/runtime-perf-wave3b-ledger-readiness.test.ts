import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  GENERATION_LEDGER_REQUIRED_SCHEMA_VERSION,
  GENERATION_LEDGER_SCHEMA_UNREADY_MESSAGE,
  GENERATION_LEDGER_UNINITIALIZED_MESSAGE,
  assertGenerationLedgerSchemaFileReady,
} from "../src/core/studio-generation-ledger-readiness.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = (relative: string) => readFileSync(path.join(root, relative), "utf8");

const temps: string[] = [];
function tempDbPath(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "wave3b-ledger-"));
  temps.push(dir);
  return path.join(dir, "studio-generation-ledger.sqlite");
}

afterEach(() => {
  temps.length = 0;
});

describe("Wave 3-B generation ledger 失败关闭", () => {
  it("文件不存在时抛错且不建库", () => {
    const databasePath = tempDbPath();
    expect(existsSync(databasePath)).toBe(false);
    expect(() => assertGenerationLedgerSchemaFileReady(databasePath)).toThrow(
      GENERATION_LEDGER_UNINITIALIZED_MESSAGE,
    );
    expect(existsSync(databasePath)).toBe(false);
  });

  it("空库无 schema_version 时抛错且不建 meta", () => {
    const databasePath = tempDbPath();
    const created = new DatabaseSync(databasePath);
    created.close();
    expect(existsSync(databasePath)).toBe(true);
    expect(() => assertGenerationLedgerSchemaFileReady(databasePath)).toThrow(
      GENERATION_LEDGER_SCHEMA_UNREADY_MESSAGE,
    );
    const probe = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const row = probe.prepare(
        "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'studio_generation_ledger_meta'",
      ).get() as { found?: number } | undefined;
      expect(row).toBeUndefined();
    } finally {
      probe.close();
    }
  });

  it("schema_version=7 时通过；错误版本失败关闭", () => {
    const readyPath = tempDbPath();
    const ready = new DatabaseSync(readyPath);
    ready.exec(`
      CREATE TABLE studio_generation_ledger_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT INTO studio_generation_ledger_meta(key, value) VALUES('schema_version', '7');
    `);
    ready.close();
    expect(() => assertGenerationLedgerSchemaFileReady(readyPath)).not.toThrow();

    const stalePath = tempDbPath();
    const stale = new DatabaseSync(stalePath);
    stale.exec(`
      CREATE TABLE studio_generation_ledger_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT INTO studio_generation_ledger_meta(key, value) VALUES('schema_version', '6');
    `);
    stale.close();
    expect(() => assertGenerationLedgerSchemaFileReady(stalePath)).toThrow(
      GENERATION_LEDGER_SCHEMA_UNREADY_MESSAGE,
    );
  });

  it("时间线与 earliest 在账本批读前调用失败关闭闸", () => {
    const timeline = source("src/core/studio-approved-timeline-projection.ts");
    const earliest = source("src/core/studio-episode-earliest.ts");
    const readiness = source("src/core/studio-generation-ledger-readiness.ts");
    const storage = source("src/core/studio-generation-ledger-storage.ts");
    expect(timeline).toContain("assertGenerationLedgerSchemaFileReady(shell.paths.generationDatabase)");
    expect(earliest).toContain("assertGenerationLedgerSchemaFileReady(shell.paths.generationDatabase)");
    expect(timeline.indexOf("assertGenerationLedgerSchemaFileReady")).toBeLessThan(
      timeline.indexOf("listStudioGenerationLatestUnitGridRunsReadOnly"),
    );
    expect(timeline).toContain("listStudioGenerationLatestUnitGridRunsReadOnly");
    expect(timeline).not.toMatch(/listStudioGenerationLatestUnitGridRuns\(/u);
    expect(earliest.indexOf("assertGenerationLedgerSchemaFileReady")).toBeLessThan(
      earliest.indexOf("getStudioGenerationCheckpointControl"),
    );
    expect(readiness).toContain("openGenerationLedgerReadOnly");
    expect(readiness).toContain("readOnly: true");
    expect(readiness).toContain("query_only");
    expect(readiness).not.toMatch(/inspectManagedProject\(/u);
    expect(readiness).not.toMatch(/openDatabase\s*\(/u);
    expect(readiness).not.toMatch(/initializeStudioGenerationLedger\s*\(/u);
    expect(readiness).not.toMatch(/createCurrentSchema\s*\(/u);
    expect(readiness).not.toContain("journal_mode");
    expect(readiness).not.toContain("CREATE TABLE");
    const ledger = source("src/core/studio-generation-ledger.ts");
    const writableStart = ledger.indexOf("export async function listStudioGenerationLatestUnitGridRuns(");
    const readonlyStart = ledger.indexOf("export async function listStudioGenerationLatestUnitGridRunsReadOnly(");
    expect(writableStart).toBeGreaterThan(-1);
    expect(readonlyStart).toBeGreaterThan(writableStart);
    const writableFn = ledger.slice(writableStart, readonlyStart);
    expect(writableFn).toContain("await managedLedgerPaths(projectRoot)");
    expect(writableFn).toContain("openDatabase(paths)");
    expect(writableFn).not.toContain("openGenerationLedgerReadOnly");
    const readonlyFn = ledger.slice(readonlyStart, ledger.indexOf("export type StudioUnitGridRollupBucket"));
    expect(readonlyFn).toContain("openGenerationLedgerReadOnly(databasePath)");
    expect(readonlyFn).not.toContain("await managedLedgerPaths");
    expect(readonlyFn).not.toContain("openDatabase(paths)");
    expect(readonlyFn).not.toContain("journal_mode");
    expect(readonlyFn).not.toContain("CREATE TABLE");
    expect(storage).toContain(`const SCHEMA_VERSION = ${GENERATION_LEDGER_REQUIRED_SCHEMA_VERSION}`);
  });
});
