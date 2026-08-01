import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  __setStudioRequestSchemaCacheObserverForTests,
  clearStudioRequestSchemaCache,
  hasStudioRequestSchemaValidation,
  isStudioRequestSqliteValidationUnchanged,
  markStudioRequestSqliteValidationIfUnchanged,
  markStudioRequestSchemaValidation,
  studioRequestSqliteValidationKey,
  withFreshStudioRequestSchemaCache,
  withStudioRequestSchemaCache,
} from "../src/core/studio-request-schema-cache.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  __setStudioRequestSchemaCacheObserverForTests(null);
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Studio 请求内 schema 深验缓存", () => {
  it("同一请求只初始化一次，fresh epoch 与下一顶层请求都必须重新初始化", async () => {
    let initializationCount = 0;
    const ensure = async (key: string) => {
      if (hasStudioRequestSchemaValidation(key)) return;
      initializationCount += 1;
      markStudioRequestSchemaValidation(key);
    };

    await withStudioRequestSchemaCache(async () => {
      await ensure("schema:a");
      await ensure("schema:a");
      await withStudioRequestSchemaCache(() => ensure("schema:a"));
      expect(initializationCount).toBe(1);

      await withFreshStudioRequestSchemaCache(async () => {
        await ensure("schema:a");
        await ensure("schema:a");
      });
      expect(initializationCount).toBe(2);

      expect(hasStudioRequestSchemaValidation("schema:a")).toBe(true);
      clearStudioRequestSchemaCache();
      expect(hasStudioRequestSchemaValidation("schema:a")).toBe(false);
    });

    await withStudioRequestSchemaCache(() => ensure("schema:a"));
    expect(initializationCount).toBe(3);
  });

  it("主库或非空 WAL 漂移会换 key；空 WAL 的创建/删除不会击穿缓存", async () => {
    const root = path.join("/tmp", `studio-schema-cache-${process.pid}-${Date.now()}`);
    temporaryRoots.push(root);
    await mkdir(root, { recursive: false });
    const databasePath = path.join(root, "ledger.sqlite");
    await writeFile(databasePath, "database-v1");
    const first = studioRequestSqliteValidationKey("fixture", databasePath);

    await writeFile(`${databasePath}-wal`, "");
    const emptyWal = studioRequestSqliteValidationKey("fixture", databasePath);
    expect(emptyWal).toBe(first);

    await writeFile(`${databasePath}-wal`, "pending-transaction");
    const nonEmptyWal = studioRequestSqliteValidationKey("fixture", databasePath);
    expect(nonEmptyWal).not.toBe(first);
    expect(isStudioRequestSqliteValidationUnchanged(first, "fixture", databasePath)).toBe(false);

    await writeFile(databasePath, "database-v2-with-different-size");
    const changedDatabase = studioRequestSqliteValidationKey("fixture", databasePath);
    expect(changedDatabase).not.toBe(nonEmptyWal);

    await withStudioRequestSchemaCache(async () => {
      const beforeValidation = changedDatabase;
      await writeFile(databasePath, "database-v3-drifted-during-validation");
      expect(markStudioRequestSqliteValidationIfUnchanged(
        beforeValidation,
        "fixture",
        databasePath,
      )).toBe(false);
      expect(hasStudioRequestSchemaValidation(beforeValidation)).toBe(false);
      expect(hasStudioRequestSchemaValidation(
        studioRequestSqliteValidationKey("fixture", databasePath),
      )).toBe(false);
    });
  });
});
