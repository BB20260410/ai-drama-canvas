/**
 * 只读投影的 generation ledger 失败关闭闸：只检查文件与 schema_version，不建库。
 * 版本号必须与 studio-generation-ledger-storage SCHEMA_VERSION 对齐。
 */
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

export const GENERATION_LEDGER_REQUIRED_SCHEMA_VERSION = 7;
export const GENERATION_LEDGER_UNINITIALIZED_MESSAGE = "generation ledger 未初始化，只读投影失败关闭。";
export const GENERATION_LEDGER_SCHEMA_UNREADY_MESSAGE = "generation ledger schema 未就绪，只读投影失败关闭。";

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
