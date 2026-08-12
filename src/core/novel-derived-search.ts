import { createHash, randomUUID } from "node:crypto";
import { watch as watchFileSystem, type FSWatcher } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { studioSqliteBusyTimeoutMs } from "./studio-sqlite-busy.js";
import {
  ensureConfinedDirectory,
  inspectExistingConfinedDirectory,
  revalidateConfinedDirectory,
} from "./confined-project-storage.js";
import {
  inspectExistingNovelFile,
  type NovelRegularFileIdentity,
} from "./novel-path-policy.js";
import type {
  NovelChapterRecord,
  NovelSearchFallbackReason,
  NovelSearchIndexGeneration,
  NovelSearchIndexStatus,
} from "./novel-types.js";

export const NOVEL_DERIVED_SEARCH_DATABASE_LOCATOR = ".aicanvas/novel/novel-derived.sqlite" as const;
const NOVEL_DERIVED_SEARCH_DIRECTORY_LOCATOR = ".aicanvas/novel";
const SEARCH_SCHEMA_VERSION = 1;
const SEARCH_TOKENIZER = "fts5-trigram-case-sensitive-v1" as const;
const BUSY_TIMEOUT_MS = 5_000;
const MAX_FAILURE_MESSAGE_LENGTH = 1_000;
const SEARCH_IDENTITY_VERIFY_CONCURRENCY = 24;
const MAX_SEARCH_IDENTITY_WATCH_DIRECTORIES = 256;
const MAX_SEARCH_IDENTITY_CACHE_PROJECTS = 16;

let beforeActivationTestHook: (() => Promise<void>) | undefined;

interface SearchIdentityCacheEntry {
  generationId: string;
  manifestDigest: string;
  identities: Map<string, SearchDocumentIdentityRow>;
  dirty: boolean;
  epoch: number;
  watchers: FSWatcher[];
  touchedAt: number;
}

const searchIdentityCache = new Map<string, SearchIdentityCacheEntry>();
const searchIdentityMetrics = {
  fullScans: 0,
  fullIdentityChecks: 0,
  hotCacheHits: 0,
  candidateIdentityChecks: 0,
  watcherInvalidations: 0,
};

function closeSearchIdentityCacheEntry(entry: SearchIdentityCacheEntry): void {
  for (const watcher of entry.watchers.splice(0)) watcher.close();
}

function invalidateSearchIdentityCache(projectRoot: string): void {
  const key = path.resolve(projectRoot);
  const entry = searchIdentityCache.get(key);
  if (!entry) return;
  closeSearchIdentityCacheEntry(entry);
  searchIdentityCache.delete(key);
}

export function resetNovelDerivedSearchIdentityCacheForTests(): void {
  for (const entry of searchIdentityCache.values()) closeSearchIdentityCacheEntry(entry);
  searchIdentityCache.clear();
  for (const key of Object.keys(searchIdentityMetrics) as Array<keyof typeof searchIdentityMetrics>) searchIdentityMetrics[key] = 0;
}

export function getNovelDerivedSearchIdentityCacheMetricsForTests(): typeof searchIdentityMetrics {
  return { ...searchIdentityMetrics };
}

/** 仅供 Vitest 构造激活窗口；生产进程拒绝安装测试屏障。 */
export function setNovelDerivedSearchBeforeActivationHookForTests(
  hook: (() => Promise<void>) | undefined,
): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("小说派生搜索测试屏障只能在 NODE_ENV=test 中使用。");
  }
  beforeActivationTestHook = hook;
}

interface SearchIndexDocument {
  chapter: NovelChapterRecord;
  content: string;
  identity: NovelRegularFileIdentity;
}

interface SearchIndexExpectation {
  projectId: string;
  manifestRevision: number;
  manifestDigest: string;
  chapters: readonly NovelChapterRecord[];
}

interface SearchGenerationRow {
  generation_id: string;
  project_id: string;
  manifest_revision: number | bigint;
  manifest_digest: string;
  tokenizer: string;
  status: string;
  chapter_count: number | bigint;
  indexed_chapter_count: number | bigint;
  coverage_fingerprint: string | null;
  created_at: string;
  activated_at: string | null;
}

interface SearchDocumentIdentityRow {
  chapter_id: string;
  relative_path: string;
  dev: string;
  ino: string;
  nlink: string;
  size: string;
  mtime_ns: string;
  ctime_ns: string;
}

export interface NovelDerivedSearchCandidateResult {
  status: NovelSearchIndexStatus;
  candidateChapterIds?: string[];
  fallbackReason?: NovelSearchFallbackReason;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function safeCount(value: number | bigint, label: string): number {
  const numberValue = Number(value);
  if (!Number.isSafeInteger(numberValue) || numberValue < 0) {
    throw new Error(`${label} 不是非负安全整数。`);
  }
  return numberValue;
}

function sqlitePath(projectRoot: string): string {
  return path.join(projectRoot, ...NOVEL_DERIVED_SEARCH_DATABASE_LOCATOR.split("/"));
}

function sqliteDirectory(projectRoot: string): string {
  return path.join(projectRoot, ...NOVEL_DERIVED_SEARCH_DIRECTORY_LOCATOR.split("/"));
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error
    ? String((error as NodeJS.ErrnoException).code ?? "")
    : undefined;
}

function boundedFailure(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, MAX_FAILURE_MESSAGE_LENGTH);
}

function generationFromRow(row: SearchGenerationRow): NovelSearchIndexGeneration {
  if (row.tokenizer !== SEARCH_TOKENIZER
    || !["building", "active", "inactive", "failed", "stale"].includes(row.status)) {
    throw new Error("小说派生搜索 generation 合同损坏。 ");
  }
  return {
    generationId: row.generation_id,
    projectId: row.project_id,
    manifestRevision: safeCount(row.manifest_revision, "manifest revision"),
    manifestDigest: row.manifest_digest,
    tokenizer: SEARCH_TOKENIZER,
    status: row.status as NovelSearchIndexGeneration["status"],
    chapterCount: safeCount(row.chapter_count, "chapter count"),
    indexedChapterCount: safeCount(row.indexed_chapter_count, "indexed chapter count"),
    ...(row.coverage_fingerprint ? { coverageFingerprint: row.coverage_fingerprint } : {}),
    createdAt: row.created_at,
    ...(row.activated_at ? { activatedAt: row.activated_at } : {}),
  };
}

export function novelSearchManifestDigest(
  projectId: string,
  manifestRevision: number,
  chapters: readonly NovelChapterRecord[],
): string {
  return digest({
    schemaVersion: 1,
    projectId,
    manifestRevision,
    chapters: chapters.map((chapter) => ({
      chapterId: chapter.chapterId,
      volumeId: chapter.volumeId,
      order: chapter.order,
      revision: chapter.revision,
      relativePath: chapter.relativePath,
      sha256: chapter.sha256,
      byteLength: chapter.byteLength,
      charCount: chapter.charCount,
    })),
  });
}

async function assertSafeExistingDatabase(databasePath: string): Promise<void> {
  const metadata = await lstat(databasePath, { bigint: true });
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1n) {
    throw new Error("小说派生搜索库必须是无符号链接、非硬链接的普通文件。 ");
  }
  if (await realpath(databasePath) !== databasePath) {
    throw new Error("小说派生搜索库真实路径与约定路径不一致。 ");
  }
}

function initializeSchema(database: DatabaseSync): void {
  database.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS novel_search_meta(
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS novel_search_generations(
      generation_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      manifest_revision INTEGER NOT NULL CHECK(manifest_revision > 0),
      manifest_digest TEXT NOT NULL CHECK(length(manifest_digest) = 64),
      tokenizer TEXT NOT NULL CHECK(tokenizer = '${SEARCH_TOKENIZER}'),
      status TEXT NOT NULL CHECK(status IN ('building', 'active', 'inactive', 'failed', 'stale')),
      chapter_count INTEGER NOT NULL CHECK(chapter_count >= 0),
      indexed_chapter_count INTEGER NOT NULL CHECK(indexed_chapter_count >= 0),
      coverage_fingerprint TEXT CHECK(coverage_fingerprint IS NULL OR length(coverage_fingerprint) = 64),
      created_at TEXT NOT NULL,
      activated_at TEXT,
      failure_message TEXT
    ) STRICT;
    CREATE TABLE IF NOT EXISTS novel_search_documents(
      generation_id TEXT NOT NULL REFERENCES novel_search_generations(generation_id) ON DELETE CASCADE,
      chapter_id TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      chapter_revision INTEGER NOT NULL CHECK(chapter_revision > 0),
      chapter_sha256 TEXT NOT NULL CHECK(length(chapter_sha256) = 64),
      dev TEXT NOT NULL,
      ino TEXT NOT NULL,
      nlink TEXT NOT NULL,
      size TEXT NOT NULL,
      mtime_ns TEXT NOT NULL,
      ctime_ns TEXT NOT NULL,
      PRIMARY KEY(generation_id, chapter_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS novel_search_active(
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      generation_id TEXT NOT NULL UNIQUE REFERENCES novel_search_generations(generation_id)
    ) STRICT;
    CREATE VIRTUAL TABLE IF NOT EXISTS novel_search_fts USING fts5(
      generation_id UNINDEXED,
      chapter_id UNINDEXED,
      body,
      tokenize='trigram case_sensitive 1'
    );
  `);
  const existing = database.prepare("SELECT value FROM novel_search_meta WHERE key = 'schema_version'").get() as { value?: string } | undefined;
  if (!existing) {
    database.prepare("INSERT INTO novel_search_meta(key, value) VALUES('schema_version', ?)").run(String(SEARCH_SCHEMA_VERSION));
  } else if (existing.value !== String(SEARCH_SCHEMA_VERSION)) {
    throw new Error(`不支持的小说派生搜索 schema：${existing.value}`);
  }
}

function assertSchema(database: DatabaseSync): void {
  const marker = database.prepare("SELECT value FROM novel_search_meta WHERE key = 'schema_version'").get() as { value?: string } | undefined;
  if (marker?.value !== String(SEARCH_SCHEMA_VERSION)) throw new Error("小说派生搜索 schema marker 缺失或无效。 ");
  const required = ["novel_search_active", "novel_search_documents", "novel_search_fts", "novel_search_generations", "novel_search_meta"];
  const rows = database.prepare("SELECT name, sql FROM sqlite_schema WHERE name IN (?, ?, ?, ?, ?)")
    .all(...required) as Array<{ name: string; sql: string | null }>;
  if (rows.length !== required.length || required.some((name) => !rows.some((row) => row.name === name))) {
    throw new Error("小说派生搜索 schema 不完整。 ");
  }
  const ftsSql = rows.find((row) => row.name === "novel_search_fts")?.sql ?? "";
  if (!ftsSql.includes("trigram case_sensitive 1")) throw new Error("小说派生搜索 tokenizer 漂移。 ");
}

function openWritableDatabase(databasePath: string): DatabaseSync {
  const busyTimeoutMs = studioSqliteBusyTimeoutMs(BUSY_TIMEOUT_MS);
  const database = new DatabaseSync(databasePath, { timeout: busyTimeoutMs });
  try {
    database.exec(`PRAGMA busy_timeout=${busyTimeoutMs}; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;`);
    initializeSchema(database);
    assertSchema(database);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

function openReadOnlyDatabase(databasePath: string): DatabaseSync {
  const busyTimeoutMs = studioSqliteBusyTimeoutMs(BUSY_TIMEOUT_MS);
  const database = new DatabaseSync(databasePath, { readOnly: true, timeout: busyTimeoutMs });
  try {
    database.exec(`PRAGMA busy_timeout=${busyTimeoutMs}; PRAGMA foreign_keys=ON; PRAGMA query_only=ON;`);
    assertSchema(database);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

function emptyStatus(expectation: SearchIndexExpectation, state: NovelSearchIndexStatus["state"], reason?: string): NovelSearchIndexStatus {
  return {
    schemaVersion: 1,
    databaseLocator: NOVEL_DERIVED_SEARCH_DATABASE_LOCATOR,
    state,
    expectedManifestRevision: expectation.manifestRevision,
    expectedManifestDigest: expectation.manifestDigest,
    pendingGenerationCount: 0,
    ...(reason ? { reason } : {}),
  };
}

export async function getNovelDerivedSearchStatus(
  projectRoot: string,
  expectation: SearchIndexExpectation,
): Promise<NovelSearchIndexStatus> {
  const directory = sqliteDirectory(projectRoot);
  const databasePath = sqlitePath(projectRoot);
  try {
    const directoryIdentity = await inspectExistingConfinedDirectory(projectRoot, directory);
    await assertSafeExistingDatabase(databasePath);
    const database = openReadOnlyDatabase(databasePath);
    try {
      const pending = database.prepare("SELECT COUNT(*) AS count FROM novel_search_generations WHERE status = 'building'")
        .get() as { count: number | bigint };
      const pendingGenerationCount = safeCount(pending.count, "pending generation count");
      const row = database.prepare(`
        SELECT generation_id, project_id, manifest_revision, manifest_digest, tokenizer,
               status, chapter_count, indexed_chapter_count, coverage_fingerprint,
               created_at, activated_at
        FROM novel_search_generations
        WHERE generation_id = (SELECT generation_id FROM novel_search_active WHERE singleton = 1)
      `).get() as SearchGenerationRow | undefined;
      await revalidateConfinedDirectory(directoryIdentity);
      await assertSafeExistingDatabase(databasePath);
      if (!row) {
        return {
          ...emptyStatus(expectation, pendingGenerationCount ? "building" : "missing"),
          pendingGenerationCount,
        };
      }
      const activeGeneration = generationFromRow(row);
      const fresh = activeGeneration.status === "active"
        && activeGeneration.projectId === expectation.projectId
        && activeGeneration.manifestRevision === expectation.manifestRevision
        && activeGeneration.manifestDigest === expectation.manifestDigest
        && activeGeneration.chapterCount === expectation.chapters.length
        && activeGeneration.indexedChapterCount === expectation.chapters.length;
      return {
        ...emptyStatus(expectation, fresh ? "fresh" : "stale", fresh ? undefined : "active_generation_does_not_match_current_manifest"),
        activeGeneration,
        pendingGenerationCount,
      };
    } finally {
      database.close();
    }
  } catch (error) {
    if (errorCode(error) === "ENOENT") return emptyStatus(expectation, "missing");
    return emptyStatus(expectation, "corrupt", boundedFailure(error));
  }
}

function identityPayload(identity: NovelRegularFileIdentity): {
  dev: string;
  ino: string;
  nlink: string;
  size: string;
  mtimeNs: string;
  ctimeNs: string;
} {
  return {
    dev: identity.dev.toString(),
    ino: identity.ino.toString(),
    nlink: identity.nlink.toString(),
    size: identity.size.toString(),
    mtimeNs: identity.mtimeNs.toString(),
    ctimeNs: identity.ctimeNs.toString(),
  };
}

function sameStoredIdentity(row: SearchDocumentIdentityRow, identity: NovelRegularFileIdentity): boolean {
  return row.relative_path === identity.locator
    && row.dev === identity.dev.toString()
    && row.ino === identity.ino.toString()
    && row.nlink === identity.nlink.toString()
    && row.size === identity.size.toString()
    && row.mtime_ns === identity.mtimeNs.toString()
    && row.ctime_ns === identity.ctimeNs.toString();
}

export async function rebuildNovelDerivedSearchIndex(
  projectRoot: string,
  expectation: SearchIndexExpectation,
  documents: readonly SearchIndexDocument[],
): Promise<NovelSearchIndexStatus> {
  if (documents.length !== expectation.chapters.length
    || documents.some((document, index) => document.chapter.chapterId !== expectation.chapters[index]?.chapterId)) {
    throw new Error("小说派生搜索构建文档与 manifest 顺序/覆盖不一致。 ");
  }
  const directoryIdentity = await ensureConfinedDirectory(projectRoot, sqliteDirectory(projectRoot));
  const databasePath = sqlitePath(projectRoot);
  try {
    await assertSafeExistingDatabase(databasePath);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  const database = openWritableDatabase(databasePath);
  const generationId = `novel-search-${expectation.manifestDigest.slice(0, 16)}-${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  const createdAt = new Date().toISOString();
  try {
    database.exec("BEGIN IMMEDIATE");
    try {
      database.prepare("UPDATE novel_search_generations SET status = 'stale', failure_message = ? WHERE status = 'building'")
        .run("interrupted_before_next_rebuild");
      database.prepare(`
        INSERT INTO novel_search_generations(
          generation_id, project_id, manifest_revision, manifest_digest, tokenizer, status,
          chapter_count, indexed_chapter_count, coverage_fingerprint, created_at, activated_at, failure_message
        ) VALUES(?, ?, ?, ?, ?, 'building', ?, 0, NULL, ?, NULL, NULL)
      `).run(
        generationId,
        expectation.projectId,
        expectation.manifestRevision,
        expectation.manifestDigest,
        SEARCH_TOKENIZER,
        expectation.chapters.length,
        createdAt,
      );
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }

    if (process.env.AI_CANVAS_TEST_NOVEL_SEARCH_INTERRUPT === "after-building-generation") {
      throw new Error("test-only novel search index interruption after building generation");
    }

    database.exec("BEGIN IMMEDIATE");
    try {
      const insertDocument = database.prepare(`
        INSERT INTO novel_search_documents(
          generation_id, chapter_id, relative_path, chapter_revision, chapter_sha256,
          dev, ino, nlink, size, mtime_ns, ctime_ns
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insertFts = database.prepare("INSERT INTO novel_search_fts(generation_id, chapter_id, body) VALUES(?, ?, ?)");
      const coverage: unknown[] = [];
      for (const document of documents) {
        const identity = identityPayload(document.identity);
        insertDocument.run(
          generationId,
          document.chapter.chapterId,
          document.chapter.relativePath,
          document.chapter.revision,
          document.chapter.sha256,
          identity.dev,
          identity.ino,
          identity.nlink,
          identity.size,
          identity.mtimeNs,
          identity.ctimeNs,
        );
        insertFts.run(generationId, document.chapter.chapterId, document.content);
        coverage.push({
          chapterId: document.chapter.chapterId,
          revision: document.chapter.revision,
          sha256: document.chapter.sha256,
          relativePath: document.chapter.relativePath,
          ...identity,
        });
      }
      const documentCount = database.prepare("SELECT COUNT(*) AS count FROM novel_search_documents WHERE generation_id = ?")
        .get(generationId) as { count: number | bigint };
      const ftsCount = database.prepare("SELECT COUNT(*) AS count FROM novel_search_fts WHERE generation_id = ?")
        .get(generationId) as { count: number | bigint };
      if (safeCount(documentCount.count, "indexed document count") !== documents.length
        || safeCount(ftsCount.count, "indexed FTS count") !== documents.length) {
        throw new Error("小说派生搜索构建覆盖计数不完整。 ");
      }
      await beforeActivationTestHook?.();
      const activatedAt = new Date().toISOString();
      const coverageFingerprint = digest({ schemaVersion: 1, generationId, coverage });
      database.prepare("UPDATE novel_search_generations SET status = 'inactive' WHERE status = 'active'").run();
      database.prepare(`
        UPDATE novel_search_generations
        SET status = 'active', indexed_chapter_count = ?, coverage_fingerprint = ?, activated_at = ?
        WHERE generation_id = ? AND status = 'building'
      `).run(documents.length, coverageFingerprint, activatedAt, generationId);
      database.prepare(`
        INSERT INTO novel_search_active(singleton, generation_id) VALUES(1, ?)
        ON CONFLICT(singleton) DO UPDATE SET generation_id = excluded.generation_id
      `).run(generationId);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      database.exec("BEGIN IMMEDIATE");
      try {
        database.prepare("UPDATE novel_search_generations SET status = 'failed', failure_message = ? WHERE generation_id = ? AND status = 'building'")
          .run(boundedFailure(error), generationId);
        database.exec("COMMIT");
      } catch {
        database.exec("ROLLBACK");
      }
      throw error;
    }
    database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    database.close();
  }
  await revalidateConfinedDirectory(directoryIdentity);
  await assertSafeExistingDatabase(databasePath);
  invalidateSearchIdentityCache(projectRoot);
  return getNovelDerivedSearchStatus(projectRoot, expectation);
}

function globLiteral(value: string): string {
  return value.replaceAll("[", "[[]").replaceAll("*", "[*]").replaceAll("?", "[?]");
}

function fallbackForState(state: NovelSearchIndexStatus["state"]): NovelSearchFallbackReason {
  if (state === "building") return "index_building";
  if (state === "stale") return "index_stale";
  if (state === "corrupt") return "index_corrupt";
  return "index_missing";
}

async function verifyStoredChapterIdentities(
  projectRoot: string,
  chapters: readonly NovelChapterRecord[],
  identities: ReadonlyMap<string, SearchDocumentIdentityRow>,
): Promise<boolean> {
  let cursor = 0;
  let valid = true;
  const workers = Array.from({ length: Math.min(SEARCH_IDENTITY_VERIFY_CONCURRENCY, Math.max(1, chapters.length)) }, async () => {
    while (valid) {
      const index = cursor;
      cursor += 1;
      const chapter = chapters[index];
      if (!chapter) return;
      const stored = identities.get(chapter.chapterId);
      if (!stored) { valid = false; return; }
      try {
        const actual = await inspectExistingNovelFile(projectRoot, chapter.relativePath);
        searchIdentityMetrics.fullIdentityChecks += 1;
        if (!sameStoredIdentity(stored, actual)) valid = false;
      } catch {
        valid = false;
      }
    }
  });
  await Promise.all(workers);
  return valid;
}

function installSearchIdentityWatchers(
  projectRoot: string,
  generationId: string,
  manifestDigest: string,
  identities: Map<string, SearchDocumentIdentityRow>,
  chapters: readonly NovelChapterRecord[],
): SearchIdentityCacheEntry | null {
  const directories = [...new Set(chapters.map((chapter) => path.resolve(projectRoot, path.dirname(chapter.relativePath))))];
  if (!directories.length || directories.length > MAX_SEARCH_IDENTITY_WATCH_DIRECTORIES) return null;
  const entry: SearchIdentityCacheEntry = {
    generationId,
    manifestDigest,
    identities,
    dirty: false,
    epoch: 0,
    watchers: [],
    touchedAt: Date.now(),
  };
  try {
    for (const directory of directories) {
      const watcher = watchFileSystem(directory, { persistent: false }, () => {
        if (!entry.dirty) searchIdentityMetrics.watcherInvalidations += 1;
        entry.dirty = true;
        entry.epoch += 1;
      });
      watcher.on("error", () => {
        if (!entry.dirty) searchIdentityMetrics.watcherInvalidations += 1;
        entry.dirty = true;
        entry.epoch += 1;
      });
      entry.watchers.push(watcher);
    }
    return entry;
  } catch {
    closeSearchIdentityCacheEntry(entry);
    return null;
  }
}

function rememberSearchIdentityCache(projectRoot: string, entry: SearchIdentityCacheEntry): void {
  const key = path.resolve(projectRoot);
  invalidateSearchIdentityCache(key);
  searchIdentityCache.set(key, entry);
  if (searchIdentityCache.size <= MAX_SEARCH_IDENTITY_CACHE_PROJECTS) return;
  const oldest = [...searchIdentityCache.entries()]
    .sort((left, right) => left[1].touchedAt - right[1].touchedAt)[0];
  if (oldest) invalidateSearchIdentityCache(oldest[0]);
}

function currentSearchIdentityCache(
  projectRoot: string,
  generationId: string,
  manifestDigest: string,
): SearchIdentityCacheEntry | null {
  const entry = searchIdentityCache.get(path.resolve(projectRoot));
  if (!entry || entry.generationId !== generationId || entry.manifestDigest !== manifestDigest || entry.dirty) return null;
  entry.touchedAt = Date.now();
  searchIdentityMetrics.hotCacheHits += 1;
  return entry;
}

async function flushSearchWatcherEvents(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

export async function queryNovelDerivedSearchCandidates(
  projectRoot: string,
  expectation: SearchIndexExpectation,
  query: string,
  allowedChapterIds: ReadonlySet<string> | null,
): Promise<NovelDerivedSearchCandidateResult> {
  const status = await getNovelDerivedSearchStatus(projectRoot, expectation);
  if (Array.from(query).length < 3) {
    return { status, fallbackReason: "query_too_short" };
  }
  if (status.state !== "fresh" || !status.activeGeneration) {
    return { status, fallbackReason: fallbackForState(status.state) };
  }
  const databasePath = sqlitePath(projectRoot);
  const directoryIdentity = await inspectExistingConfinedDirectory(projectRoot, sqliteDirectory(projectRoot));
  await assertSafeExistingDatabase(databasePath);
  const database = openReadOnlyDatabase(databasePath);
  try {
    await flushSearchWatcherEvents();
    const cacheKey = path.resolve(projectRoot);
    const priorCache = searchIdentityCache.get(cacheKey);
    if (priorCache?.generationId === status.activeGeneration.generationId
      && priorCache.manifestDigest === expectation.manifestDigest
      && priorCache.dirty) {
      return { status, fallbackReason: "chapter_identity_changed" };
    }
    let cache = currentSearchIdentityCache(projectRoot, status.activeGeneration.generationId, expectation.manifestDigest);
    if (!cache) {
      const identityRows = database.prepare(`
        SELECT chapter_id, relative_path, dev, ino, nlink, size, mtime_ns, ctime_ns
        FROM novel_search_documents WHERE generation_id = ?
      `).all(status.activeGeneration.generationId) as unknown as SearchDocumentIdentityRow[];
      const identities = new Map(identityRows.map((row) => [row.chapter_id, row]));
      if (identities.size !== expectation.chapters.length) return { status, fallbackReason: "index_stale" };
      const candidateCache = installSearchIdentityWatchers(projectRoot, status.activeGeneration.generationId, expectation.manifestDigest, identities, expectation.chapters);
      if (!candidateCache) return { status, fallbackReason: "chapter_identity_changed" };
      searchIdentityMetrics.fullScans += 1;
      const epoch = candidateCache.epoch;
      const valid = await verifyStoredChapterIdentities(projectRoot, expectation.chapters, identities);
      await flushSearchWatcherEvents();
      if (!valid || candidateCache.dirty || candidateCache.epoch !== epoch) {
        closeSearchIdentityCacheEntry(candidateCache);
        return { status, fallbackReason: "chapter_identity_changed" };
      }
      rememberSearchIdentityCache(projectRoot, candidateCache);
      cache = candidateCache;
    }
    const rows = database.prepare(`
      SELECT chapter_id
      FROM novel_search_fts
      WHERE generation_id = ? AND body GLOB ?
      ORDER BY rowid
    `).all(status.activeGeneration.generationId, `*${globLiteral(query)}*`) as Array<{ chapter_id: string }>;
    const seen = new Set<string>();
    const candidateChapterIds: string[] = [];
    for (const row of rows) {
      if (seen.has(row.chapter_id) || (allowedChapterIds && !allowedChapterIds.has(row.chapter_id))) continue;
      seen.add(row.chapter_id);
      candidateChapterIds.push(row.chapter_id);
    }
    const chapterById = new Map(expectation.chapters.map((chapter) => [chapter.chapterId, chapter]));
    for (const chapterId of candidateChapterIds) {
      const chapter = chapterById.get(chapterId);
      const stored = cache.identities.get(chapterId);
      if (!chapter || !stored) return { status, fallbackReason: "index_stale" };
      try {
        const actual = await inspectExistingNovelFile(projectRoot, chapter.relativePath);
        searchIdentityMetrics.candidateIdentityChecks += 1;
        if (!sameStoredIdentity(stored, actual)) {
          cache.dirty = true;
          return { status, fallbackReason: "chapter_identity_changed" };
        }
      } catch {
        cache.dirty = true;
        return { status, fallbackReason: "chapter_identity_changed" };
      }
    }
    await flushSearchWatcherEvents();
    if (cache.dirty) return { status, fallbackReason: "chapter_identity_changed" };
    await revalidateConfinedDirectory(directoryIdentity);
    await assertSafeExistingDatabase(databasePath);
    return { status, candidateChapterIds };
  } catch (error) {
    return {
      status: { ...status, state: "corrupt", reason: boundedFailure(error) },
      fallbackReason: "index_corrupt",
    };
  } finally {
    database.close();
  }
}
