import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createManagedProject, inspectManagedProject } from "../src/core/managed-project.js";
import {
  assertRuntimeBuildCurrentness,
  createManagedProjectBackup,
  ManagedProjectRestoreError,
  refuseOldBuildAgainstNewSource,
  restoreManagedProjectBackup,
  verifyProjectTreeAgainstManifest,
} from "../src/core/project-backup.js";
import { createBuildIdentity } from "../src/core/build-identity.js";
import { executeIdempotentCommand } from "../src/core/command-bus.js";

const roots: string[] = [];
afterEach(async () => {
  delete process.env.AI_CANVAS_TEST_BACKUP_BUSY_TIMES;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function seedProject(parent: string) {
  const project = await createManagedProject({ parentRoot: parent, name: "P10-R 备份" });
  await executeIdempotentCommand(project.paths.root, {
    requestId: `request-p10-script-${Date.now()}`,
    idempotencyKey: `idem-p10-script-${Date.now()}`,
    request: {
      command: "create_studio_script_document",
      payload: { id: "script-backup", title: "备份剧本", expectedRevision: 0 },
    },
  });
  return project;
}

async function waitForWriterReady(child: ChildProcess): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => reject(new Error("并发 SQLite writer 启动超时")), 5_000);
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.includes("READY")) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.once("exit", (code) => {
      if (!output.includes("READY")) {
        clearTimeout(timeout);
        reject(new Error(`并发 SQLite writer 提前退出：${code}`));
      }
    });
  });
}

async function stopWriter(child: ChildProcess): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  if (child.exitCode === null && child.signalCode === null) {
    await Promise.race([
      once(child, "exit"),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
  }
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

function stableDigest(value: unknown): string {
  const stable = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(stable);
    if (input && typeof input === "object") {
      return Object.fromEntries(Object.entries(input as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right, "en"))
        .map(([key, entry]) => [key, stable(entry)]));
    }
    return input;
  };
  return createHash("sha256").update(JSON.stringify(stable(value)), "utf8").digest("hex");
}

function aggregateManifestFiles(files: Array<{ relativePath: string; sizeBytes: number; sha256: string }>): string {
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file.relativePath);
    hash.update("\0");
    hash.update(String(file.sizeBytes));
    hash.update("\0");
    hash.update(file.sha256);
    hash.update("\0");
  }
  return hash.digest("hex");
}

describe("P10-R 备份恢复与旧构建拒绝", () => {
  it("备份含 per-file SHA，恢复后受管壳可用；重复恢复拒绝", async () => {
    const parent = await realpath(await mkdtemp(path.join("/tmp", "p10r-backup-")));
    roots.push(parent);
    const project = await seedProject(parent);
    const backup = await createManagedProjectBackup(project.paths.root, path.join(parent, "backups"));
    expect(backup.manifest.schemaVersion).toBe(2);
    expect(backup.manifest.files.length).toBe(backup.manifest.fileCount);
    expect(backup.manifest.files[0]?.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(backup.manifest.snapshot).toMatchObject({
      strategy: "sqlite-online-backup-write-barrier-v1",
      sourceStabilityVerified: true,
    });
    expect(backup.manifest.snapshot?.sqliteDatabases).toEqual(expect.arrayContaining([
      ".aicanvas/cache.sqlite",
      ".aicanvas/command-ledger.sqlite",
      ".aicanvas/material-studio.sqlite",
      ".aicanvas/studio-generation-ledger.sqlite",
      ".aicanvas/studio-production.sqlite",
    ]));
    expect((backup.manifest.snapshot?.ordinaryFileCount ?? 0)
      + (backup.manifest.snapshot?.sqliteDatabases.length ?? 0)).toBe(backup.manifest.fileCount);
    expect(backup.manifest.files.some((entry) => /\.sqlite-(?:wal|shm|journal)$/u.test(entry.relativePath))).toBe(false);
    await verifyProjectTreeAgainstManifest(path.join(backup.backupRoot, "project"), backup.manifest);

    const restoreParent = path.join(parent, "restores");
    const restored = await restoreManagedProjectBackup(backup.backupRoot, restoreParent);
    const shell = await inspectManagedProject(restored.projectRoot);
    expect(shell.project.id).toBe(project.project.id);

    await expect(restoreManagedProjectBackup(backup.backupRoot, restoreParent))
      .rejects.toThrow(/已存在/);
  });

  it("同一目标并发恢复只允许一个原子认领，失败调用不得删除成功副本", async () => {
    const parent = await realpath(await mkdtemp(path.join("/tmp", "p28-restore-race-")));
    roots.push(parent);
    const project = await seedProject(parent);
    const backup = await createManagedProjectBackup(project.paths.root, path.join(parent, "backups"));
    const restoreParent = path.join(parent, "restores");

    const outcomes = await Promise.allSettled([
      restoreManagedProjectBackup(backup.backupRoot, restoreParent),
      restoreManagedProjectBackup(backup.backupRoot, restoreParent),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    const fulfilled = outcomes.find((outcome): outcome is PromiseFulfilledResult<Awaited<ReturnType<typeof restoreManagedProjectBackup>>> => outcome.status === "fulfilled")!;
    const shell = await inspectManagedProject(fulfilled.value.projectRoot);
    expect(shell.project.id).toBe(project.project.id);
  });

  it("落盘后的身份改写失败时保留隔离现场并写 RESTORE_FAILED，不删除目标", async () => {
    const parent = await realpath(await mkdtemp(path.join("/tmp", "p28-restore-preserve-")));
    roots.push(parent);
    const project = await seedProject(parent);
    const backup = await createManagedProjectBackup(project.paths.root, path.join(parent, "backups"));
    const manifestPath = path.join(backup.backupRoot, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as typeof backup.manifest;
    const configRelativePath = ".aicanvas/project.json";
    const invalidConfig = Buffer.from("{ invalid restored config\n", "utf8");
    await writeFile(path.join(backup.backupRoot, "project", configRelativePath), invalidConfig);
    const entry = manifest.files.find((file) => file.relativePath === configRelativePath)!;
    entry.sizeBytes = invalidConfig.byteLength;
    entry.sha256 = createHash("sha256").update(invalidConfig).digest("hex");
    manifest.aggregateSha256 = aggregateManifestFiles(manifest.files);
    const { fingerprint: _fingerprint, ...body } = manifest;
    manifest.fingerprint = stableDigest(body);
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    let failure: unknown;
    try {
      await restoreManagedProjectBackup(backup.backupRoot, path.join(parent, "restores"));
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ManagedProjectRestoreError);
    const restoreFailure = failure as ManagedProjectRestoreError;
    expect(restoreFailure.preservedForRecovery).toBe(true);
    expect((await stat(restoreFailure.projectRoot)).isDirectory()).toBe(true);
    expect(await readFile(path.join(restoreFailure.projectRoot, "RESTORE_FAILED.txt"), "utf8"))
      .toContain("原工程和备份均未修改");
  });

  it("WAL 并发写入期间以 online backup 建立可解码 SQLite 快照", async () => {
    const parent = await realpath(await mkdtemp(path.join("/tmp", "p10r-backup-wal-")));
    roots.push(parent);
    const project = await seedProject(parent);
    const databasePath = project.paths.materialDatabase;
    const setup = new DatabaseSync(databasePath);
    setup.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS backup_concurrency_probe (
        sequence INTEGER PRIMARY KEY,
        payload TEXT NOT NULL
      );
    `);
    setup.close();

    const writerSource = `
      import { DatabaseSync } from "node:sqlite";
      const db = new DatabaseSync(process.env.BACKUP_TEST_DB, { timeout: 25 });
      db.exec("PRAGMA busy_timeout=25; PRAGMA journal_mode=WAL");
      const insert = db.prepare("INSERT INTO backup_concurrency_probe(sequence, payload) VALUES(?, ?)");
      let sequence = Number((db.prepare("SELECT COALESCE(MAX(sequence), 0) AS value FROM backup_concurrency_probe").get()).value) + 1;
      insert.run(sequence, "writer-" + sequence);
      sequence += 1;
      console.log("READY");
      const timer = setInterval(() => {
        try { insert.run(sequence, "writer-" + sequence); sequence += 1; }
        catch (error) { if (!String(error).includes("locked")) { console.error(error); process.exitCode = 2; } }
      }, 1);
      const stop = () => { clearInterval(timer); try { db.close(); } catch {} process.exit(); };
      process.on("SIGTERM", stop);
      process.on("SIGINT", stop);
    `;
    const writer = spawn(process.execPath, ["--input-type=module", "--eval", writerSource], {
      env: { ...process.env, BACKUP_TEST_DB: databasePath, NODE_NO_WARNINGS: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      await waitForWriterReady(writer);
      await new Promise((resolve) => setTimeout(resolve, 30));
      const backup = await createManagedProjectBackup(project.paths.root, path.join(parent, "backups"));
      expect(backup.manifest.snapshot?.sqliteDatabases).toContain(".aicanvas/material-studio.sqlite");
      for (const relativePath of backup.manifest.snapshot?.sqliteDatabases ?? []) {
        const snapshotDb = new DatabaseSync(path.join(backup.backupRoot, "project", ...relativePath.split("/")), { readOnly: true });
        try {
          const row = snapshotDb.prepare("PRAGMA quick_check").get() as Record<string, unknown>;
          expect(Object.values(row)).toEqual(["ok"]);
        } finally {
          snapshotDb.close();
        }
      }
      const materialSnapshot = new DatabaseSync(path.join(backup.backupRoot, "project", ".aicanvas", "material-studio.sqlite"), { readOnly: true });
      let snapshotCount = 0;
      try {
        const row = materialSnapshot.prepare("SELECT COUNT(*) AS count, MAX(sequence) AS maximum FROM backup_concurrency_probe").get() as { count: number; maximum: number };
        expect(row.count).toBeGreaterThan(0);
        expect(row.maximum).toBe(row.count);
        snapshotCount = row.count;
      } finally {
        materialSnapshot.close();
      }
      await new Promise((resolve) => setTimeout(resolve, 30));
      const liveDatabase = new DatabaseSync(databasePath, { readOnly: true });
      try {
        const live = liveDatabase.prepare("SELECT COUNT(*) AS count FROM backup_concurrency_probe").get() as { count: number };
        expect(live.count).toBeGreaterThan(snapshotCount);
      } finally {
        liveDatabase.close();
      }
      expect(writer.exitCode).toBeNull();
    } finally {
      await stopWriter(writer);
    }
  }, 30_000);

  it("无法取得 SQLite 写屏障时失败关闭并清理 staging", async () => {
    const parent = await realpath(await mkdtemp(path.join("/tmp", "p10r-backup-lock-failure-")));
    roots.push(parent);
    const project = await seedProject(parent);
    const blocker = new DatabaseSync(project.paths.materialDatabase, { timeout: 50 });
    blocker.exec("BEGIN IMMEDIATE");
    const backupParent = path.join(parent, "failed-backups");
    try {
      await expect(createManagedProjectBackup(project.paths.root, backupParent, { sqliteBusyTimeoutMs: 50 }))
        .rejects.toThrow(/无法锁定 SQLite 数据库|一致性备份已停止/);
    } finally {
      blocker.exec("ROLLBACK");
      blocker.close();
    }
    expect(await readdir(backupParent)).toEqual([]);
  });

  it("写屏障获取注入 busy 后经受控重试成功，且不产生重复副作用", async () => {
    const parent = await realpath(await mkdtemp(path.join("/tmp", "p10r-backup-busy-retry-")));
    roots.push(parent);
    const project = await seedProject(parent);
    // 前 2 次写屏障获取抛 SQLITE_BUSY（errcode=5）；busy 确认未提交，可安全重试。
    process.env.AI_CANVAS_TEST_BACKUP_BUSY_TIMES = "2";
    const backupParent = path.join(parent, "backups");
    const startedAt = Date.now();
    const backup = await createManagedProjectBackup(project.paths.root, backupParent);
    // 两轮注入 → 至少一轮指数退避（120ms 基线），且不突破重试预算外的无谓等待。
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(100);
    expect(Date.now() - startedAt).toBeLessThan(30_000);
    // 副作用只产生一次：恰好一个 backup-* 目录、无 staging 残留，快照经逐文件校验。
    const entries = await readdir(backupParent);
    expect(entries.filter((entry) => entry.startsWith("backup-"))).toHaveLength(1);
    expect(entries.filter((entry) => entry.startsWith(".backup-staging-"))).toHaveLength(0);
    expect(backup.manifest.snapshot?.strategy).toBe("sqlite-online-backup-write-barrier-v1");
    await verifyProjectTreeAgainstManifest(path.join(backup.backupRoot, "project"), backup.manifest);
  }, 30_000);

  it("写屏障获取 busy 打满重试预算后失败关闭并清理 staging", async () => {
    const parent = await realpath(await mkdtemp(path.join("/tmp", "p10r-backup-busy-exhaust-")));
    roots.push(parent);
    const project = await seedProject(parent);
    // 注入 12 次（>maxAttempts）：预算内必败，原样抛出 busy，不得留下 staging。
    process.env.AI_CANVAS_TEST_BACKUP_BUSY_TIMES = "12";
    const backupParent = path.join(parent, "failed-backups");
    await mkdir(backupParent, { recursive: true });
    await expect(createManagedProjectBackup(project.paths.root, backupParent))
      .rejects.toThrow(/database is locked/);
    expect((await readdir(backupParent)).filter((entry) => !entry.startsWith("."))).toEqual([]);
    expect((await readdir(backupParent)).filter((entry) => entry.startsWith(".backup-staging-"))).toEqual([]);
  }, 30_000);

  it("拒绝把备份写进源工程内部", async () => {
    const parent = await realpath(await mkdtemp(path.join("/tmp", "p10r-backup-recursive-")));
    roots.push(parent);
    const project = await seedProject(parent);
    const nestedBackupParent = path.join(project.paths.root, "backups");
    await expect(createManagedProjectBackup(project.paths.root, nestedBackupParent))
      .rejects.toThrow(/不得位于源工程内部|真实目录/);
    await expect(stat(nestedBackupParent)).rejects.toThrow();
  });

  it("源工程含符号链接时失败关闭且不留下 staging", async () => {
    const parent = await realpath(await mkdtemp(path.join("/tmp", "p10r-backup-symlink-")));
    roots.push(parent);
    const project = await seedProject(parent);
    await symlink("/tmp", path.join(project.paths.root, "unsafe-external-link"));
    const backupParent = path.join(parent, "backups");
    await expect(createManagedProjectBackup(project.paths.root, backupParent))
      .rejects.toThrow(/禁止符号链接/);
    expect(await readdir(backupParent)).toEqual([]);
  });

  it("篡改 manifest fingerprint 失败关闭", async () => {
    const parent = await realpath(await mkdtemp(path.join("/tmp", "p10r-tamper-manifest-")));
    roots.push(parent);
    const project = await seedProject(parent);
    const backup = await createManagedProjectBackup(project.paths.root, path.join(parent, "backups"));
    const manifestPath = path.join(backup.backupRoot, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.fingerprint = "0".repeat(64);
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await expect(restoreManagedProjectBackup(backup.backupRoot, path.join(parent, "restores")))
      .rejects.toThrow(/fingerprint|篡改/);
  });

  it("拒绝缺少逐文件校验的 schema v1 旧备份", async () => {
    const parent = await realpath(await mkdtemp(path.join("/tmp", "p10r-schema-v1-")));
    roots.push(parent);
    const project = await seedProject(parent);
    const backup = await createManagedProjectBackup(project.paths.root, path.join(parent, "backups"));
    const manifestPath = path.join(backup.backupRoot, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.schemaVersion = 1;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const targetParent = path.join(parent, "restores");
    await expect(restoreManagedProjectBackup(backup.backupRoot, targetParent))
      .rejects.toThrow(/schema v1|逐文件校验/);
    await expect(stat(targetParent)).rejects.toThrow();
  });

  it("拒绝把恢复副本写进活动工程或备份目录内部", async () => {
    const parent = await realpath(await mkdtemp(path.join("/tmp", "p10r-restore-overlap-")));
    roots.push(parent);
    const project = await seedProject(parent);
    const backup = await createManagedProjectBackup(project.paths.root, path.join(parent, "backups"));
    const insideProject = path.join(project.paths.root, "restores");
    await expect(restoreManagedProjectBackup(backup.backupRoot, insideProject, {
      forbiddenProjectRoots: [project.paths.root],
    })).rejects.toThrow(/不得与备份目录或现有工程重叠/);
    await expect(stat(insideProject)).rejects.toThrow();

    const insideBackup = path.join(backup.backupRoot, "restores");
    await expect(restoreManagedProjectBackup(backup.backupRoot, insideBackup))
      .rejects.toThrow(/不得与备份目录或现有工程重叠/);
    await expect(stat(insideBackup)).rejects.toThrow();
  });

  it("拒绝通过符号链接恢复到未显示的真实目录", async () => {
    const parent = await realpath(await mkdtemp(path.join("/tmp", "p10r-restore-symlink-")));
    roots.push(parent);
    const project = await seedProject(parent);
    const backup = await createManagedProjectBackup(project.paths.root, path.join(parent, "backups"));
    const realTarget = path.join(parent, "real-target");
    await mkdir(realTarget);
    const linkedTarget = path.join(parent, "linked-target");
    await symlink(realTarget, linkedTarget);
    await expect(restoreManagedProjectBackup(backup.backupRoot, linkedTarget))
      .rejects.toThrow(/符号链接|真实目录/);
    expect(await readdir(realTarget)).toEqual([]);
  });

  it("删除备份文件后恢复失败关闭", async () => {
    const parent = await realpath(await mkdtemp(path.join("/tmp", "p10r-missing-file-")));
    roots.push(parent);
    const project = await seedProject(parent);
    const backup = await createManagedProjectBackup(project.paths.root, path.join(parent, "backups"));
    const victim = path.join(backup.backupRoot, "project", ".aicanvas", "project.json");
    await rm(victim, { force: true });
    await expect(restoreManagedProjectBackup(backup.backupRoot, path.join(parent, "restores")))
      .rejects.toThrow(/缺失|不一致|哈希/);
  });

  it("额外文件后恢复失败关闭", async () => {
    const parent = await realpath(await mkdtemp(path.join("/tmp", "p10r-extra-file-")));
    roots.push(parent);
    const project = await seedProject(parent);
    const backup = await createManagedProjectBackup(project.paths.root, path.join(parent, "backups"));
    await writeFile(path.join(backup.backupRoot, "project", "EVIL.txt"), "evil\n", "utf8");
    await expect(restoreManagedProjectBackup(backup.backupRoot, path.join(parent, "restores")))
      .rejects.toThrow(/额外|不一致/);
  });

  it("截断文件后恢复失败关闭", async () => {
    const parent = await realpath(await mkdtemp(path.join("/tmp", "p10r-truncate-")));
    roots.push(parent);
    const project = await seedProject(parent);
    const backup = await createManagedProjectBackup(project.paths.root, path.join(parent, "backups"));
    const victim = path.join(backup.backupRoot, "project", ".aicanvas", "project.json");
    const before = await stat(victim);
    expect(before.size).toBeGreaterThan(10);
    await writeFile(victim, "{}\n", "utf8");
    await expect(restoreManagedProjectBackup(backup.backupRoot, path.join(parent, "restores")))
      .rejects.toThrow(/哈希|大小|不一致/);
  });

  it("sourceDigest 不一致时拒绝旧构建；运行时入口一致", async () => {
    const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const identity = await createBuildIdentity(workspace);
    const refused = await refuseOldBuildAgainstNewSource({
      workspace,
      recordedSourceDigest: "0".repeat(64),
    });
    expect(refused.allowed).toBe(false);
    if (!refused.allowed) {
      expect(refused.currentSourceDigest).toBe(identity.sourceDigest);
    }
    const allowed = await refuseOldBuildAgainstNewSource({
      workspace,
      recordedSourceDigest: identity.sourceDigest,
    });
    expect(allowed.allowed).toBe(true);

    const runtimeDenied = await assertRuntimeBuildCurrentness({
      workspace,
      recordedSourceDigest: "1".repeat(64),
    });
    expect(runtimeDenied.allowed).toBe(false);
    const runtimeOk = await assertRuntimeBuildCurrentness({
      workspace,
      recordedSourceDigest: identity.sourceDigest,
    });
    expect(runtimeOk.allowed).toBe(true);
  }, 120_000);
});
