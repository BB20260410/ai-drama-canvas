import { link, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createManagedProject } from "../src/core/managed-project.js";
import {
  __setBeforeCommandLedgerWritableOpenHookForTests,
  listCommandLedgerEntries,
  loadCommandLedger,
  getCommandLedgerEntryByIdempotencyKey,
  getCommandLedgerEntryByRequestId,
  upsertCommandLedgerEntry,
} from "../src/core/command-ledger-store.js";
import { executeIdempotentCommand, listCommandLedger } from "../src/core/command-bus.js";

const roots: string[] = [];
afterEach(async () => {
  __setBeforeCommandLedgerWritableOpenHookForTests(null);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("P9 增量 command ledger", () => {
  it("纯读 API 在空工程不建库、不迁移且不创建 SQLite sidecar", async () => {
    const parent = await realpath(await mkdtemp(path.join("/tmp", "p9-ledger-readonly-")));
    roots.push(parent);
    const project = await createManagedProject({ parentRoot: parent, name: "P9 Readonly" });
    const sidecar = path.join(project.paths.root, ".aicanvas");
    const before = await readdir(sidecar);

    expect(await loadCommandLedger(project.paths.root)).toMatchObject({ entries: [], backend: "sqlite" });
    expect(await listCommandLedgerEntries(project.paths.root, 10)).toEqual([]);
    expect(await getCommandLedgerEntryByIdempotencyKey(project.paths.root, "missing-idem")).toBeNull();
    expect(await getCommandLedgerEntryByRequestId(project.paths.root, "missing-request")).toBeNull();

    expect(await readdir(sidecar)).toEqual(before);
    expect((await readdir(sidecar)).filter((name) => name.startsWith("command-ledger.sqlite"))).toEqual([]);
  });

  it("旧 JSON 在纯读路径只投影，不静默迁移为 SQLite", async () => {
    const parent = await realpath(await mkdtemp(path.join("/tmp", "p9-ledger-legacy-read-")));
    roots.push(parent);
    const project = await createManagedProject({ parentRoot: parent, name: "P9 Legacy Read" });
    const entry = {
      schemaVersion: 1 as const,
      requestId: "request-legacy-read-001",
      idempotencyKey: "idem-legacy-read-001",
      command: "legacy_read_probe",
      status: "succeeded" as const,
      replayed: false,
      requestHash: "b".repeat(64),
      startedAt: "2026-07-22T00:00:00.000Z",
    };
    await writeFile(path.join(project.paths.root, ".aicanvas", "command-ledger.json"), JSON.stringify({
      schemaVersion: 1,
      entries: [entry],
      updatedAt: entry.startedAt,
    }));

    expect(await loadCommandLedger(project.paths.root)).toMatchObject({ backend: "json-legacy", entries: [entry] });
    expect(await listCommandLedgerEntries(project.paths.root, 10)).toEqual([entry]);
    expect(await getCommandLedgerEntryByIdempotencyKey(project.paths.root, entry.idempotencyKey)).toEqual(entry);
    expect((await readdir(path.join(project.paths.root, ".aicanvas")))
      .filter((name) => name.startsWith("command-ledger.sqlite"))).toEqual([]);
  });

  it("future schema 在写打开前失败关闭且不创建新 sidecar", async () => {
    const parent = await realpath(await mkdtemp(path.join("/tmp", "p9-ledger-future-")));
    roots.push(parent);
    const project = await createManagedProject({ parentRoot: parent, name: "P9 Future" });
    await upsertCommandLedgerEntry(project.paths.root, {
      schemaVersion: 1,
      requestId: "request-future-001",
      idempotencyKey: "idem-future-001",
      command: "future_probe",
      status: "succeeded",
      replayed: false,
      requestHash: "c".repeat(64),
      startedAt: "2026-07-22T00:00:00.000Z",
    });
    const sidecar = path.join(project.paths.root, ".aicanvas");
    const databasePath = path.join(sidecar, "command-ledger.sqlite");
    const tamper = new DatabaseSync(databasePath);
    tamper.prepare("UPDATE command_ledger_meta SET value='999' WHERE key='schema_version'").run();
    tamper.close();
    const beforeBytes = await readFile(databasePath);
    const beforeNames = (await readdir(sidecar)).sort();

    await expect(listCommandLedgerEntries(project.paths.root, 10)).rejects.toThrow("schema_version：999");
    await expect(upsertCommandLedgerEntry(project.paths.root, {
      schemaVersion: 1,
      requestId: "request-future-002",
      idempotencyKey: "idem-future-002",
      command: "must_not_write",
      status: "running",
      replayed: false,
      requestHash: "d".repeat(64),
      startedAt: "2026-07-22T00:00:01.000Z",
    })).rejects.toThrow("schema_version：999");

    expect(await readFile(databasePath)).toEqual(beforeBytes);
    expect((await readdir(sidecar)).sort()).toEqual(beforeNames);
  });

  it("只读预检后数据库被 future inode 替换时拒绝且替换库保持原字节", async () => {
    const parent = await realpath(await mkdtemp(path.join("/tmp", "p9-ledger-race-")));
    roots.push(parent);
    const project = await createManagedProject({ parentRoot: parent, name: "P9 Race" });
    await upsertCommandLedgerEntry(project.paths.root, {
      schemaVersion: 1,
      requestId: "request-race-001",
      idempotencyKey: "idem-race-001",
      command: "race_probe",
      status: "succeeded",
      replayed: false,
      requestHash: "e".repeat(64),
      startedAt: "2026-07-22T00:00:00.000Z",
    });
    const databasePath = path.join(project.paths.root, ".aicanvas", "command-ledger.sqlite");
    const displacedPath = `${databasePath}.preflight-original`;
    const replacementPath = `${databasePath}.future-replacement`;
    const future = new DatabaseSync(replacementPath);
    future.exec(`CREATE TABLE command_ledger_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO command_ledger_meta(key, value) VALUES('schema_version', '999');`);
    future.close();
    const originalBytes = await readFile(databasePath);
    const replacementBytes = await readFile(replacementPath);

    __setBeforeCommandLedgerWritableOpenHookForTests(async ({ databasePath: openedPath }) => {
      expect(openedPath).toBe(databasePath);
      await rename(databasePath, displacedPath);
      await rename(replacementPath, databasePath);
    });

    await expect(upsertCommandLedgerEntry(project.paths.root, {
      schemaVersion: 1,
      requestId: "request-race-002",
      idempotencyKey: "idem-race-002",
      command: "must_not_write",
      status: "running",
      replayed: false,
      requestHash: "f".repeat(64),
      startedAt: "2026-07-22T00:00:01.000Z",
    })).rejects.toThrow(/changed after read-only preflight/u);
    expect(await readFile(displacedPath)).toEqual(originalBytes);
    expect(await readFile(databasePath)).toEqual(replacementBytes);
  });

  it("主库 hardlink 或额外 trigger/view 均在正式读写前失败关闭", async () => {
    const parent = await realpath(await mkdtemp(path.join("/tmp", "p9-ledger-hardlink-schema-")));
    roots.push(parent);
    const project = await createManagedProject({ parentRoot: parent, name: "P9 Hardlink Schema" });
    const entry = {
      schemaVersion: 1 as const,
      requestId: "request-hardlink-schema-001",
      idempotencyKey: "idem-hardlink-schema-001",
      command: "hardlink_schema_probe",
      status: "succeeded" as const,
      replayed: false,
      requestHash: "1".repeat(64),
      startedAt: "2026-07-22T00:00:00.000Z",
    };
    await upsertCommandLedgerEntry(project.paths.root, entry);
    const databasePath = path.join(project.paths.root, ".aicanvas", "command-ledger.sqlite");
    const aliasPath = `${databasePath}.hardlink-alias`;
    await link(databasePath, aliasPath);
    const before = await readFile(databasePath);
    await expect(listCommandLedgerEntries(project.paths.root, 10)).rejects.toThrow(/safe regular file|单链接/u);
    expect(await readFile(databasePath)).toEqual(before);
    await rm(aliasPath);

    const tamper = new DatabaseSync(databasePath);
    tamper.exec(`
      CREATE TRIGGER command_ledger_extra_trigger
        AFTER INSERT ON command_ledger_entries BEGIN DELETE FROM command_ledger_entries; END;
      CREATE VIEW command_ledger_extra_view AS SELECT request_id FROM command_ledger_entries;
    `);
    tamper.close();
    const tamperedBytes = await readFile(databasePath);
    await expect(listCommandLedgerEntries(project.paths.root, 10)).rejects.toThrow("完整 schema 合同不一致");
    expect(await readFile(databasePath)).toEqual(tamperedBytes);
  });

  it("upsert 单行后 list 有界返回，重复幂等键重放成功", async () => {
    const parent = await realpath(await mkdtemp(path.join("/tmp", "p9-ledger-")));
    roots.push(parent);
    const project = await createManagedProject({ parentRoot: parent, name: "P9 Ledger" });
    const root = project.paths.root;

    await upsertCommandLedgerEntry(root, {
      schemaVersion: 1,
      requestId: "request-ledger-001",
      idempotencyKey: "idem-ledger-001",
      command: "create_studio_script_document",
      status: "succeeded",
      replayed: false,
      requestHash: "a".repeat(64),
      startedAt: new Date().toISOString(),
      executedAt: new Date().toISOString(),
      result: { ok: true },
    });

    const listed = await listCommandLedgerEntries(root, 10);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.idempotencyKey).toBe("idem-ledger-001");

    const snapshot = await loadCommandLedger(root);
    expect(snapshot.backend).toBe("sqlite");
    expect(snapshot.entries).toHaveLength(1);
    const markerDb = new DatabaseSync(path.join(root, ".aicanvas", "command-ledger.sqlite"), { readOnly: true });
    expect(markerDb.prepare("SELECT value FROM command_ledger_meta WHERE key='schema_version'").get()).toEqual({ value: "1" });
    markerDb.close();

    // 真实 command-bus：成功后同幂等键重放
    const first = await executeIdempotentCommand(root, {
      requestId: "request-create-script-001",
      idempotencyKey: "idem-create-script-001",
      request: {
        command: "create_studio_script_document",
        payload: { id: "script-p9-1", title: "账本剧本", expectedRevision: 0 },
      },
    });
    expect(first.status).toBe("succeeded");
    expect(first.replayed).toBe(false);

    const replay = await executeIdempotentCommand(root, {
      requestId: "request-create-script-002",
      idempotencyKey: "idem-create-script-001",
      request: {
        command: "create_studio_script_document",
        payload: { id: "script-p9-1", title: "账本剧本", expectedRevision: 0 },
      },
    });
    expect(replay.status).toBe("succeeded");
    expect(replay.replayed).toBe(true);

    const busList = await listCommandLedger(root, 20);
    expect(busList.some((entry) => entry.idempotencyKey === "idem-create-script-001")).toBe(true);
  });

  it("拒绝跨根 storageRoot 与 projectId 漂移", async () => {
    const parent = await realpath(await mkdtemp(path.join("/tmp", "p9-crossroot-")));
    roots.push(parent);
    const project = await createManagedProject({ parentRoot: parent, name: "P9 Cross" });
    await expect(executeIdempotentCommand(project.paths.root, {
      requestId: "request-cross-001",
      idempotencyKey: "idem-cross-001",
      request: {
        command: "create_studio_script_document",
        payload: {
          id: "script-cross",
          title: "跨根",
          expectedRevision: 0,
          projectId: "project-not-this-one",
        } as any,
      },
    })).rejects.toThrow(/projectId|跨工程/);
  });
});
