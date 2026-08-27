/**
 * 只读投影的 generation ledger 失败关闭闸：只检查文件与 schema_version，不建库。
 * 版本号必须与 studio-generation-ledger-storage SCHEMA_VERSION 对齐。
 */
import { existsSync, lstatSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

export const GENERATION_LEDGER_REQUIRED_SCHEMA_VERSION = 7;
export const GENERATION_LEDGER_UNINITIALIZED_MESSAGE = "generation ledger 未初始化，只读投影失败关闭。";
export const GENERATION_LEDGER_SCHEMA_UNREADY_MESSAGE = "generation ledger schema 未就绪，只读投影失败关闭。";
export const GENERATION_LEDGER_NOT_REGULAR_FILE_MESSAGE = "generation ledger 数据库必须是无符号链接的普通文件。";

export function assertGenerationLedgerSchemaFileReady(databasePath: string): void {
  if (!existsSync(databasePath)) {
    throw new Error(GENERATION_LEDGER_UNINITIALIZED_MESSAGE);
  }
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const version = db.prepare(
      "SELECT value FROM studio_generation_ledger_meta WHERE key = 'schema_version'",
    ).get() as { value?: string } | undefined;
    if (version?.value !== String(GENERATION_LEDGER_REQUIRED_SCHEMA_VERSION)) {
      throw new Error(GENERATION_LEDGER_SCHEMA_UNREADY_MESSAGE);
    }
  } catch (error) {
    if (error instanceof Error && error.message === GENERATION_LEDGER_SCHEMA_UNREADY_MESSAGE) throw error;
    throw new Error(GENERATION_LEDGER_SCHEMA_UNREADY_MESSAGE, { cause: error });
  } finally {
    db.close();
  }
}

/**
 * 时间线账本批读专用：只读打开已有 generation ledger。
 * 不 ensure、不建库、不迁移、不改 WAL、不复制整库。
 * 不得替代 listStudioGenerationLatestUnitGridRuns 的可写入口（驾驶舱 / T23 / unit-grid）。
 */
export function openGenerationLedgerReadOnly(databasePath: string): DatabaseSync {
  if (!existsSync(databasePath)) {
    throw new Error(GENERATION_LEDGER_UNINITIALIZED_MESSAGE);
  }
  const metadata = lstatSync(databasePath);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(GENERATION_LEDGER_NOT_REGULAR_FILE_MESSAGE);
  }
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    db.exec("PRAGMA query_only = ON");
    const version = db.prepare(
      "SELECT value FROM studio_generation_ledger_meta WHERE key = 'schema_version'",
    ).get() as { value?: string } | undefined;
    if (version?.value !== String(GENERATION_LEDGER_REQUIRED_SCHEMA_VERSION)) {
      throw new Error(GENERATION_LEDGER_SCHEMA_UNREADY_MESSAGE);
    }
    return db;
  } catch (error) {
    db.close();
    if (
      error instanceof Error
      && (
        error.message === GENERATION_LEDGER_SCHEMA_UNREADY_MESSAGE
        || error.message === GENERATION_LEDGER_UNINITIALIZED_MESSAGE
        || error.message === GENERATION_LEDGER_NOT_REGULAR_FILE_MESSAGE
      )
    ) {
      throw error;
    }
    throw new Error(GENERATION_LEDGER_SCHEMA_UNREADY_MESSAGE, { cause: error });
  }
}
