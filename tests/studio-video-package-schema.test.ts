import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createManagedProject } from "../src/core/managed-project.js";
import { initializeStudioGenerationLedger } from "../src/core/studio-generation-ledger.js";
import {
  getStudioVideoPackageControl,
  getStudioVideoPackageExportControl,
  initializeStudioVideoPackageLedger,
  prepareStudioVideoPackagePublication,
} from "../src/core/studio-video-package.js";

const roots: string[] = [];

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([key, entry]) => [key, stableValue(entry)]));
}

function stableDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stableValue(value)), "utf8").digest("hex");
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function managedFixture() {
  const root = await mkdtemp("/private/tmp/p30-video-schema-");
  roots.push(root);
  const projectsRoot = path.join(root, "projects");
  await mkdir(projectsRoot, { mode: 0o700 });
  const shell = await createManagedProject({ parentRoot: projectsRoot, name: "P30 视频账本测试", slug: "p30-video-schema" });
  const generation = await initializeStudioGenerationLedger(shell.paths.root);
  return { shell, databasePath: generation.databasePath };
}

type LegacyMigrationGraph = {
  intents: Array<Record<string, unknown>>;
  receipts: Array<Record<string, unknown>>;
  aliases: Array<Record<string, unknown>>;
};

function readLegacyMigrationGraph(db: DatabaseSync): LegacyMigrationGraph {
  return {
    intents: db.prepare(`
      SELECT sequence,intent_id,operation_id,input_fingerprint,supersedes_intent_id,fingerprint
      FROM studio_video_package_export_intents ORDER BY sequence
    `).all() as Array<Record<string, unknown>>,
    receipts: db.prepare(`
      SELECT sequence,receipt_id,intent_id,fingerprint
      FROM studio_video_package_verify_receipts ORDER BY sequence
    `).all() as Array<Record<string, unknown>>,
    aliases: db.prepare(`
      SELECT sequence,operation_id,input_fingerprint,intent_id,fingerprint
      FROM studio_video_package_operation_aliases ORDER BY sequence
    `).all() as Array<Record<string, unknown>>,
  };
}

function seedLegacyMigrationGraph(
  db: DatabaseSync,
  projectId: string,
  schemaVersion: 3 | 4,
): LegacyMigrationGraph {
  const suffix = `v${schemaVersion}`;
  const packId = `studio-generation-pack-migration-${suffix}`;
  const packFingerprint = stableDigest(`${suffix}:pack`);
  const unitId = schemaVersion === 3 ? "S1E01-U23" : "S1E01-U24";
  const createdAt = "2026-07-22T00:00:00.000Z";
  db.prepare(`INSERT INTO studio_generation_packs(
    pack_id,fingerprint,content_sha256,content_relpath,content_size_bytes,
    project_id,unit_id,unit_revision,panel_id,panel_index,created_at
  ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    packId,
    packFingerprint,
    stableDigest(`${suffix}:pack-content`),
    `.aicanvas/${suffix}-pack.json`,
    1,
    projectId,
    unitId,
    1,
    `${unitId}-G1`,
    1,
    createdAt,
  );
  const intentColumns = [
    "intent_id", "operation_id", "input_fingerprint", "project_id",
    "authority_kind", "authority_id", "authority_fingerprint",
    "pack_id", "pack_fingerprint", "target_kind", "target_key", "unit_id", "unit_revision",
    "generation_run_id", "raw_result_id", "raw_sha256", "labeled_result_id", "labeled_sha256",
    "dudu_import_receipt_fingerprint", "dudu_registration_fingerprint",
    "source_manifest_fingerprint", "production_scope_fingerprint", "contract_sha256",
    "production_root", "builder_relative_path", "builder_sha256",
    "source_spec_relative_path", "source_spec_sha256",
    "output_root_relative_path", "package_relative_path",
    "supersedes_intent_id", "created_at", "fingerprint",
    ...(schemaVersion === 4 ? ["intent_schema_version"] : []),
  ];
  const insertIntent = (
    role: "prior" | "successor",
    supersedesIntentId: string | null,
  ): { intentId: string; operationId: string; inputFingerprint: string; fingerprint: string } => {
    const operationId = `video-migration-${suffix}-${role}`;
    const inputFingerprint = stableDigest(`${suffix}:${role}:input`);
    const intentId = `studio-video-package-intent-${stableDigest(`${suffix}:${role}:id`).slice(0, 40)}`;
    const fingerprint = stableDigest(`${suffix}:${role}:fingerprint`);
    const values: SQLInputValue[] = [
      intentId,
      operationId,
      inputFingerprint,
      projectId,
      "historical-import",
      `historical-${suffix}-${role}`,
      stableDigest(`${suffix}:${role}:authority`),
      packId,
      packFingerprint,
      "unit-grid",
      `unit-grid:${unitId}`,
      unitId,
      1,
      null,
      `raw-${suffix}-${role}`,
      stableDigest(`${suffix}:${role}:raw`),
      `labeled-${suffix}-${role}`,
      stableDigest(`${suffix}:${role}:labeled`),
      stableDigest(`${suffix}:${role}:import`),
      stableDigest(`${suffix}:${role}:registration`),
      stableDigest(`${suffix}:${role}:manifest`),
      stableDigest(`${suffix}:${role}:scope`),
      stableDigest(`${suffix}:${role}:contract`),
      `/private/tmp/${suffix}-production`,
      "tools/build_video_submission_pack.py",
      stableDigest(`${suffix}:${role}:builder`),
      `05_提示词/${unitId}_视频规格.json`,
      stableDigest(`${suffix}:${role}:spec`),
      "06_图生视频提交包/S1E1",
      `06_图生视频提交包/S1E1/${unitId}`,
      supersedesIntentId,
      createdAt,
      fingerprint,
      ...(schemaVersion === 4 ? [4] : []),
    ];
    db.prepare(`INSERT INTO studio_video_package_export_intents(
      ${intentColumns.join(", ")}
    ) VALUES(${intentColumns.map(() => "?").join(", ")})`).run(...values);
    return { intentId, operationId, inputFingerprint, fingerprint };
  };
  const prior = insertIntent("prior", null);
  const successor = insertIntent("successor", prior.intentId);
  for (const [index, intent] of [prior, successor].entries()) {
    const receiptId = `studio-video-package-receipt-${stableDigest(`${suffix}:${index}:receipt-id`).slice(0, 40)}`;
    db.prepare(`INSERT INTO studio_video_package_verify_receipts(
      receipt_id,intent_id,storage_kind,storage_relative_path,manifest_relative_path,
      manifest_sha256,manifest_fingerprint,files_json,spec_schema_version,
      package_status,i2v_readiness,mechanical_status,i2v_static_status,
      dynamic_model_status,verified_at,fingerprint
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      receiptId,
      intent.intentId,
      index === 0 ? "external-production" : "managed-evidence",
      `.aicanvas/migration-${suffix}-${index}`,
      `.aicanvas/migration-${suffix}-${index}/manifest.json`,
      stableDigest(`${suffix}:${index}:manifest-sha`),
      stableDigest(`${suffix}:${index}:manifest-fingerprint`),
      "[]",
      "2.0",
      "PASS",
      "NOT_TESTED",
      "verified",
      "ready",
      "not-run",
      createdAt,
      stableDigest(`${suffix}:${index}:receipt-fingerprint`),
    );
  }
  db.prepare(`INSERT INTO studio_video_package_operation_aliases(
    operation_id,input_fingerprint,intent_id,created_at,fingerprint
  ) VALUES(?, ?, ?, ?, ?)`).run(
    successor.operationId,
    successor.inputFingerprint,
    successor.intentId,
    createdAt,
    stableDigest(`${suffix}:alias-fingerprint`),
  );
  return readLegacyMigrationGraph(db);
}

describe.sequential("P30 视频包 schema", () => {
  it("创建精确 STRICT v5、受管来源与 closure 身份、换代 FK、存储身份和 append-only trigger，并可幂等重开", async () => {
    const fixture = await managedFixture();
    const first = await initializeStudioVideoPackageLedger(fixture.shell.paths.root);
    const replay = await initializeStudioVideoPackageLedger(fixture.shell.paths.root);
    expect(first).toEqual(replay);
    expect(first).toMatchObject({ schemaVersion: 1, generationLedgerReused: true, counts: { intents: 0, verifyReceipts: 0 } });
    const db = new DatabaseSync(fixture.databasePath, { readOnly: true });
    try {
      const marker = db.prepare(`SELECT value FROM studio_generation_ledger_meta
        WHERE key='studio_video_package_schema_version'`).get() as { value: string };
      const tables = db.prepare(`SELECT name, sql FROM sqlite_master
        WHERE type='table' AND name LIKE 'studio_video_package_%' ORDER BY name`).all() as Array<{ name: string; sql: string }>;
      const triggers = db.prepare(`SELECT name FROM sqlite_master
        WHERE type='trigger' AND name LIKE 'studio_video_package_%' ORDER BY name`).all() as Array<{ name: string }>;
      const foreignKeys = db.prepare("PRAGMA foreign_key_list(studio_video_package_export_intents)").all() as Array<{
        id: number; seq: number; table: string; from: string; to: string; on_delete: string;
      }>;
      const intentColumns = db.prepare("PRAGMA table_info(studio_video_package_export_intents)").all() as Array<{ name: string }>;
      const receiptColumns = db.prepare("PRAGMA table_info(studio_video_package_verify_receipts)").all() as Array<{ name: string }>;
      const destinationIndex = db.prepare(`SELECT sql FROM sqlite_master
        WHERE type='index' AND name='studio_video_package_intents_destination'`).get() as { sql: string };
      expect(marker.value).toBe("5");
      expect(tables.map((row) => row.name)).toEqual([
        "studio_video_package_export_intents",
        "studio_video_package_operation_aliases",
        "studio_video_package_publication_intents",
        "studio_video_package_publication_receipts",
        "studio_video_package_verify_receipts",
      ]);
      expect(tables.every((row) => row.sql.toLowerCase().replace(/\s+/gu, " ").trim().endsWith(") strict"))).toBe(true);
      expect(triggers.map((row) => row.name)).toEqual([
        "studio_video_package_aliases_no_delete",
        "studio_video_package_aliases_no_update",
        "studio_video_package_intents_no_delete",
        "studio_video_package_intents_no_update",
        "studio_video_package_publication_intents_no_delete",
        "studio_video_package_publication_intents_no_update",
        "studio_video_package_publication_receipts_no_delete",
        "studio_video_package_publication_receipts_no_update",
        "studio_video_package_receipts_no_delete",
        "studio_video_package_receipts_no_update",
      ]);
      expect(intentColumns.map((row) => row.name)).toEqual(expect.arrayContaining([
        "supersedes_intent_id",
        "intent_schema_version",
        "managed_source_fingerprint",
        "managed_source_unit_snapshot_fingerprint",
        "observation_control_fingerprint",
        "observation_control_status",
        "observation_head_revision",
        "observation_id",
        "observation_head_fingerprint",
        "observation_evidence_contract_version",
        "observation_evidence_kind",
        "observation_evidence_sha256",
        "observation_evidence_lineage_fingerprint",
        "intent_contract_version",
        "source_closure_fingerprint",
      ]));
      expect(receiptColumns.map((row) => row.name)).toEqual(expect.arrayContaining([
        "storage_kind",
        "storage_relative_path",
      ]));
      expect(destinationIndex.sql.replace(/\s+/gu, " ")).toContain(
        "(production_root, package_relative_path, sequence)",
      );
      expect(foreignKeys.sort((left, right) => left.id - right.id || left.seq - right.seq).map((row) => ({
        table: row.table,
        from: row.from,
        to: row.to,
        onDelete: row.on_delete,
      }))).toEqual([
        { table: "studio_video_package_export_intents", from: "supersedes_intent_id", to: "intent_id", onDelete: "RESTRICT" },
        { table: "studio_generation_packs", from: "pack_id", to: "pack_id", onDelete: "RESTRICT" },
        { table: "studio_generation_packs", from: "pack_fingerprint", to: "fingerprint", onDelete: "RESTRICT" },
      ]);
    } finally {
      db.close();
    }
  });

  it("只读控制面在未迁移账本上失败关闭且不创建任何视频对象", async () => {
    const fixture = await managedFixture();
    await expect(getStudioVideoPackageControl(fixture.shell.paths.root, {
      by: "authority-latest",
      authority: { kind: "historical-import", packId: "studio-generation-pack-not-prepared" },
    })).resolves.toMatchObject({
      status: "not-prepared",
      selectedIntentId: null,
      control: null,
      nextAction: "prepare-via-authorized-core-orchestration",
      readOnly: true,
    });
    await expect(getStudioVideoPackageExportControl(
      fixture.shell.paths.root,
      "studio-video-package-intent-missing",
    )).rejects.toMatchObject({ code: "storage-invalid" });
    const db = new DatabaseSync(fixture.databasePath, { readOnly: true });
    try {
      expect(db.prepare(`SELECT name FROM sqlite_master
        WHERE (type='table' OR type='trigger') AND name LIKE 'studio_video_package_%'`).all()).toEqual([]);
      expect(db.prepare(`SELECT value FROM studio_generation_ledger_meta
        WHERE key='studio_video_package_schema_version'`).get()).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("把非空 v3 owner 原子迁移为 v5，保留 intent/receipt/alias/后继地址与外键", async () => {
    const fixture = await managedFixture();
    await initializeStudioVideoPackageLedger(fixture.shell.paths.root);
    const db = new DatabaseSync(fixture.databasePath);
    let beforeGraph: LegacyMigrationGraph;
    try {
      db.exec("PRAGMA foreign_keys=OFF");
      const currentSql = (db.prepare(`SELECT sql FROM sqlite_master
        WHERE type='table' AND name='studio_video_package_export_intents'`).get() as { sql: string }).sql;
      const legacySql = currentSql
        .replace(
          /CREATE TABLE studio_video_package_export_intents/iu,
          "CREATE TABLE studio_video_package_export_intents_v3",
        )
        .replace(
          /,\s*intent_schema_version[\s\S]*?(?=,\s*UNIQUE\(intent_id,\s*input_fingerprint\))/iu,
          "",
        );
      db.exec(`
        DROP TRIGGER studio_video_package_intents_no_update;
        DROP TRIGGER studio_video_package_intents_no_delete;
        DROP INDEX studio_video_package_intents_destination;
        ${legacySql};
        DROP TABLE studio_video_package_export_intents;
        ALTER TABLE studio_video_package_export_intents_v3
          RENAME TO studio_video_package_export_intents;
        CREATE INDEX studio_video_package_intents_destination
          ON studio_video_package_export_intents(production_root, package_relative_path, sequence);
        CREATE TRIGGER studio_video_package_intents_no_update
          BEFORE UPDATE ON studio_video_package_export_intents
          BEGIN SELECT RAISE(ABORT, 'video package intents are append-only'); END;
        CREATE TRIGGER studio_video_package_intents_no_delete
          BEFORE DELETE ON studio_video_package_export_intents
          BEGIN SELECT RAISE(ABORT, 'video package intents are append-only'); END;
        UPDATE studio_generation_ledger_meta
          SET value='3' WHERE key='studio_video_package_schema_version';
      `);
      beforeGraph = seedLegacyMigrationGraph(db, fixture.shell.project.id, 3);
    } finally {
      db.close();
    }

    await expect(initializeStudioVideoPackageLedger(fixture.shell.paths.root)).resolves.toMatchObject({
      counts: { intents: 2, verifyReceipts: 2 },
    });
    const audit = new DatabaseSync(fixture.databasePath, { readOnly: true });
    try {
      const marker = audit.prepare(`SELECT value FROM studio_generation_ledger_meta
        WHERE key='studio_video_package_schema_version'`).get() as { value: string };
      const columns = audit.prepare("PRAGMA table_info(studio_video_package_export_intents)")
        .all() as Array<{ name: string; dflt_value: string | null }>;
      expect(marker.value).toBe("5");
      expect(columns.find((column) => column.name === "intent_schema_version"))
        .toMatchObject({ dflt_value: "3" });
      expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
        "managed_source_fingerprint",
        "observation_control_fingerprint",
        "observation_evidence_lineage_fingerprint",
        "intent_contract_version",
        "source_closure_fingerprint",
      ]));
      expect(readLegacyMigrationGraph(audit)).toEqual(beforeGraph!);
      expect(audit.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      audit.close();
    }
  });

  it("把非空 v4 owner 原子追加为 v5 shadow contract，保留 intent/receipt/alias/后继地址与外键", async () => {
    const fixture = await managedFixture();
    await initializeStudioVideoPackageLedger(fixture.shell.paths.root);
    const db = new DatabaseSync(fixture.databasePath);
    let beforeGraph: LegacyMigrationGraph;
    try {
      db.exec("PRAGMA foreign_keys=OFF");
      const currentSql = (db.prepare(`SELECT sql FROM sqlite_master
        WHERE type='table' AND name='studio_video_package_export_intents'`).get() as { sql: string }).sql;
      const v4Sql = currentSql
        .replace(
          /CREATE TABLE studio_video_package_export_intents/iu,
          "CREATE TABLE studio_video_package_export_intents_v4",
        )
        .replace(
          /,\s*intent_contract_version[\s\S]*?(?=,\s*UNIQUE\(intent_id,\s*input_fingerprint\))/iu,
          "",
        );
      db.exec(`
        DROP TRIGGER studio_video_package_intents_no_update;
        DROP TRIGGER studio_video_package_intents_no_delete;
        DROP INDEX studio_video_package_intents_destination;
        ${v4Sql};
        DROP TABLE studio_video_package_export_intents;
        ALTER TABLE studio_video_package_export_intents_v4
          RENAME TO studio_video_package_export_intents;
        CREATE INDEX studio_video_package_intents_destination
          ON studio_video_package_export_intents(production_root, package_relative_path, sequence);
        CREATE TRIGGER studio_video_package_intents_no_update
          BEFORE UPDATE ON studio_video_package_export_intents
          BEGIN SELECT RAISE(ABORT, 'video package intents are append-only'); END;
        CREATE TRIGGER studio_video_package_intents_no_delete
          BEFORE DELETE ON studio_video_package_export_intents
          BEGIN SELECT RAISE(ABORT, 'video package intents are append-only'); END;
        UPDATE studio_generation_ledger_meta
          SET value='4' WHERE key='studio_video_package_schema_version';
      `);
      beforeGraph = seedLegacyMigrationGraph(db, fixture.shell.project.id, 4);
    } finally {
      db.close();
    }

    await expect(initializeStudioVideoPackageLedger(fixture.shell.paths.root)).resolves.toMatchObject({
      counts: { intents: 2, verifyReceipts: 2 },
    });
    const audit = new DatabaseSync(fixture.databasePath, { readOnly: true });
    try {
      const marker = audit.prepare(`SELECT value FROM studio_generation_ledger_meta
        WHERE key='studio_video_package_schema_version'`).get() as { value: string };
      const columns = audit.prepare("PRAGMA table_info(studio_video_package_export_intents)")
        .all() as Array<{ name: string; dflt_value: string | null }>;
      const tableSql = (audit.prepare(`SELECT sql FROM sqlite_master
        WHERE type='table' AND name='studio_video_package_export_intents'`).get() as { sql: string }).sql;
      expect(marker.value).toBe("5");
      expect(columns.find((column) => column.name === "intent_schema_version"))
        .toMatchObject({ dflt_value: "3" });
      expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
        "intent_contract_version",
        "source_closure_fingerprint",
      ]));
      expect(tableSql.replace(/\s+/gu, " ")).toContain(
        "CHECK(intent_schema_version IN (3, 4))",
      );
      expect(readLegacyMigrationGraph(audit)).toEqual(beforeGraph!);
      expect(audit.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      audit.close();
    }
  });

  it("以轻量账本证明 v3 external prior 可冻结 v4 publication，且同目标 pending publication 拒绝后继", async () => {
    const fixture = await managedFixture();
    await initializeStudioVideoPackageLedger(fixture.shell.paths.root);
    const db = new DatabaseSync(fixture.databasePath);
    const unitId = "S1E01-U29";
    const productionRoot = path.join(fixture.shell.paths.root, "fixture-production");
    const outputRootRelativePath = "06_图生视频提交包/S1E1";
    const packageRelativePath = `${outputRootRelativePath}/${unitId}`;
    const packId = "studio-generation-pack-video-schema-fixture";
    const packFingerprint = "1".repeat(64);
    const createdAt = "2026-07-22T00:00:00.000Z";
    type FixtureIntent = {
      schemaVersion: 3 | 4;
      intentId: string;
      operationId: string;
      inputFingerprint: string;
      supersedesIntentId: string | null;
      fingerprint: string;
    };
    const insertIntent = (
      database: DatabaseSync,
      schemaVersion: 3 | 4,
      operationId: string,
      inputFingerprint: string,
      supersedesIntentId: string | null,
      suffix: string,
    ): FixtureIntent => {
      const identityInput = {
        ...(schemaVersion === 4 ? { schemaVersion: 4 as const } : {}),
        kind: "studio-video-package-export-intent" as const,
        operationId,
        inputFingerprint,
        projectId: fixture.shell.project.id,
        authorityKind: "historical-import" as const,
        authorityId: `historical-${suffix}`,
        authorityFingerprint: "2".repeat(64),
        packId,
        packFingerprint,
        targetKind: "unit-grid" as const,
        targetKey: `unit-grid:${unitId}`,
        unitId,
        unitRevision: 1,
        generationRunId: null,
        rawResultId: `raw-${suffix}`,
        rawSha256: "3".repeat(64),
        labeledResultId: `labeled-${suffix}`,
        labeledSha256: "4".repeat(64),
        duduImportReceiptFingerprint: "5".repeat(64),
        duduRegistrationFingerprint: "6".repeat(64),
        sourceManifestFingerprint: "7".repeat(64),
        productionScopeFingerprint: "8".repeat(64),
        contractSha256: "9".repeat(64),
        productionRoot,
        builderRelativePath: "tools/build_video_submission_pack.py",
        builderSha256: "a".repeat(64),
        sourceSpecRelativePath: `05_提示词/${unitId}_视频规格.json`,
        sourceSpecSha256: "b".repeat(64),
        outputRootRelativePath,
        packageRelativePath,
        supersedesIntentId,
        createdAt,
      };
      const intentId = `studio-video-package-intent-${stableDigest(identityInput).slice(0, 40)}`;
      const semantic = { ...identityInput, intentId };
      const fingerprint = stableDigest(semantic);
      database.prepare(`INSERT INTO studio_video_package_export_intents(
        intent_id, operation_id, input_fingerprint, project_id,
        authority_kind, authority_id, authority_fingerprint,
        pack_id, pack_fingerprint, target_kind, target_key, unit_id, unit_revision, generation_run_id,
        raw_result_id, raw_sha256, labeled_result_id, labeled_sha256,
        dudu_import_receipt_fingerprint, dudu_registration_fingerprint, source_manifest_fingerprint,
        production_scope_fingerprint, contract_sha256,
        production_root, builder_relative_path, builder_sha256,
        source_spec_relative_path, source_spec_sha256, output_root_relative_path, package_relative_path,
        supersedes_intent_id, created_at, fingerprint, intent_schema_version
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        intentId,
        operationId,
        inputFingerprint,
        fixture.shell.project.id,
        "historical-import",
        `historical-${suffix}`,
        "2".repeat(64),
        packId,
        packFingerprint,
        "unit-grid",
        `unit-grid:${unitId}`,
        unitId,
        1,
        null,
        `raw-${suffix}`,
        "3".repeat(64),
        `labeled-${suffix}`,
        "4".repeat(64),
        "5".repeat(64),
        "6".repeat(64),
        "7".repeat(64),
        "8".repeat(64),
        "9".repeat(64),
        productionRoot,
        "tools/build_video_submission_pack.py",
        "a".repeat(64),
        `05_提示词/${unitId}_视频规格.json`,
        "b".repeat(64),
        outputRootRelativePath,
        packageRelativePath,
        supersedesIntentId,
        createdAt,
        fingerprint,
        schemaVersion,
      );
      return { schemaVersion, intentId, operationId, inputFingerprint, supersedesIntentId, fingerprint };
    };
    const insertReceipt = (
      database: DatabaseSync,
      intent: FixtureIntent,
      storageKind: "external-production" | "managed-evidence",
      suffix: string,
    ) => {
      const storageRelativePath = storageKind === "external-production"
        ? packageRelativePath
        : `.aicanvas/studio-video-package-evidence/${intent.intentId}/${unitId}`;
      const identityInput = {
        schemaVersion: 3 as const,
        kind: "studio-video-package-verify-receipt" as const,
        intentId: intent.intentId,
        storageKind,
        storageRelativePath,
        manifestRelativePath: `${storageRelativePath}/manifest.json`,
        manifestSha256: "c".repeat(64),
        manifestFingerprint: "d".repeat(64),
        files: [{ path: `${unitId}_labeled.png`, sha256: "4".repeat(64) }],
        specSchemaVersion: "2.0" as const,
        packageStatus: "PASS",
        i2vReadiness: "NOT_TESTED",
        mechanicalStatus: "verified" as const,
        i2vStaticStatus: "ready" as const,
        dynamicModelStatus: "not-run" as const,
        verifiedAt: `2026-07-22T00:00:0${suffix}.000Z`,
      };
      const receiptId = `studio-video-package-receipt-${stableDigest(identityInput).slice(0, 40)}`;
      const semantic = { ...identityInput, receiptId };
      database.prepare(`INSERT INTO studio_video_package_verify_receipts(
        receipt_id, intent_id, storage_kind, storage_relative_path, manifest_relative_path,
        manifest_sha256, manifest_fingerprint, files_json, spec_schema_version,
        package_status, i2v_readiness, mechanical_status, i2v_static_status,
        dynamic_model_status, verified_at, fingerprint
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        receiptId,
        intent.intentId,
        storageKind,
        storageRelativePath,
        `${storageRelativePath}/manifest.json`,
        "c".repeat(64),
        "d".repeat(64),
        JSON.stringify(identityInput.files),
        "2.0",
        "PASS",
        "NOT_TESTED",
        "verified",
        "ready",
        "not-run",
        identityInput.verifiedAt,
        stableDigest(semantic),
      );
    };
    try {
      db.prepare(`INSERT INTO studio_generation_packs(
        pack_id, fingerprint, content_sha256, content_relpath, content_size_bytes,
        project_id, unit_id, unit_revision, panel_id, panel_index, created_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        packId,
        packFingerprint,
        "e".repeat(64),
        ".aicanvas/fixture-pack.json",
        1,
        fixture.shell.project.id,
        unitId,
        1,
        `${unitId}-G1`,
        1,
        createdAt,
      );
      const prior = insertIntent(db, 3, "video-schema-prior-v3", "f".repeat(64), null, "prior");
      insertReceipt(db, prior, "external-production", "1");
      const firstSuccessor = insertIntent(
        db,
        4,
        "video-schema-successor-v4-a",
        "0".repeat(64),
        prior.intentId,
        "successor-a",
      );
      insertReceipt(db, firstSuccessor, "managed-evidence", "2");
      const intentColumnNames = (db.prepare(
        "PRAGMA table_info(studio_video_package_export_intents)",
      ).all() as Array<{ name: string }>)
        .map((column) => column.name)
        .filter((name) => name !== "sequence");
      const quotedIntentColumns = intentColumnNames.map((name) => `"${name}"`);
      const invalidShadowSelect = intentColumnNames.map((name) => {
        if (name === "intent_id") return "?";
        if (name === "operation_id") return "?";
        if (name === "input_fingerprint") return "?";
        if (name === "fingerprint") return "?";
        if (name === "supersedes_intent_id") return "NULL";
        if (name === "intent_contract_version") return "5";
        if (name === "source_closure_fingerprint") return "NULL";
        return `"${name}"`;
      });
      expect(() => db.prepare(`
        INSERT INTO studio_video_package_export_intents(${quotedIntentColumns.join(", ")})
        SELECT ${invalidShadowSelect.join(", ")}
        FROM studio_video_package_export_intents
        WHERE intent_id=?
      `).run(
        "studio-video-package-intent-invalid-v5-null-closure",
        "video-schema-invalid-v5-null-closure",
        "1".repeat(64),
        "2".repeat(64),
        firstSuccessor.intentId,
      )).toThrow(/CHECK constraint failed/u);
      db.close();

      const prepared = await prepareStudioVideoPackagePublication(fixture.shell.paths.root, {
        operationId: "video-schema-publication-a",
        successorIntentId: firstSuccessor.intentId,
      });
      expect(prepared.publication).toMatchObject({
        successorIntentId: firstSuccessor.intentId,
        priorExternalIntentId: prior.intentId,
      });

      const append = new DatabaseSync(fixture.databasePath);
      let secondSuccessor: FixtureIntent;
      try {
        secondSuccessor = insertIntent(
          append,
          4,
          "video-schema-successor-v4-b",
          "1".repeat(63) + "0",
          firstSuccessor.intentId,
          "successor-b",
        );
        insertReceipt(append, secondSuccessor, "managed-evidence", "3");
      } finally {
        append.close();
      }
      await expect(prepareStudioVideoPackagePublication(fixture.shell.paths.root, {
        operationId: "video-schema-publication-b",
        successorIntentId: secondSuccessor.intentId,
      })).rejects.toMatchObject({
        code: "destination-conflict",
      });
    } finally {
      try { db.close(); } catch {}
    }
  });

  it("marker 已声明时缺失 trigger 不会被静默修补", async () => {
    const fixture = await managedFixture();
    await initializeStudioVideoPackageLedger(fixture.shell.paths.root);
    const db = new DatabaseSync(fixture.databasePath);
    try {
      db.exec("DROP TRIGGER studio_video_package_receipts_no_delete");
    } finally {
      db.close();
    }
    await expect(initializeStudioVideoPackageLedger(fixture.shell.paths.root)).rejects.toMatchObject({ code: "storage-invalid" });
    const audit = new DatabaseSync(fixture.databasePath, { readOnly: true });
    try {
      expect(audit.prepare(`SELECT name FROM sqlite_master
        WHERE type='trigger' AND name='studio_video_package_receipts_no_delete'`).get()).toBeUndefined();
    } finally {
      audit.close();
    }
  });

  it("marker 缺失但已有残留业务表时拒绝接管", async () => {
    const fixture = await managedFixture();
    const db = new DatabaseSync(fixture.databasePath);
    try {
      db.exec("CREATE TABLE studio_video_package_export_intents(dummy TEXT) STRICT");
    } finally {
      db.close();
    }
    await expect(initializeStudioVideoPackageLedger(fixture.shell.paths.root)).rejects.toMatchObject({ code: "storage-invalid" });
    const audit = new DatabaseSync(fixture.databasePath, { readOnly: true });
    try {
      expect(audit.prepare("PRAGMA table_info(studio_video_package_export_intents)").all()).toMatchObject([{ name: "dummy" }]);
      expect(audit.prepare(`SELECT value FROM studio_generation_ledger_meta
        WHERE key='studio_video_package_schema_version'`).get()).toBeUndefined();
    } finally {
      audit.close();
    }
  });
});
