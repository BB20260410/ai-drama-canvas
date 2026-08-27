/**
 * Wave 7 运行热路径：getStudioMedia 只读旁路 + 媒体协议 derivative 单次开库。
 * 不建受管工程、不走 Darwin dirfd / P7 fixture、不改 T23 SQL。
 * 不是安装版 T23，不是 GUI 列表探针。
 */
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { getStudioMedia } from "../src/core/material-studio.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = (relative: string) => readFileSync(path.join(repoRoot, relative), "utf8");

const SHA = "a".repeat(64);
const OTHER_SHA = "b".repeat(64);

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function seedMaterialMediaDatabase(options?: {
  schemaVersion?: string;
  includeRow?: boolean;
}): Promise<string> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "runtime-perf-wave7-media-"));
  roots.push(tempRoot);
  const sidecar = path.join(tempRoot, ".aicanvas");
  await mkdir(sidecar, { recursive: true });
  const databasePath = path.join(sidecar, "material-studio.sqlite");
  const db = new DatabaseSync(databasePath);
  try {
    db.exec(`
      CREATE TABLE studio_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE studio_media (
        sha256 TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        mime_type TEXT NOT NULL,
        source_basename TEXT NOT NULL,
        object_relpath TEXT NOT NULL,
        derivative_status TEXT NOT NULL,
        thumbnail_recipe_key TEXT,
        thumbnail_relpath TEXT,
        thumbnail_width INTEGER,
        thumbnail_height INTEGER,
        created_at TEXT NOT NULL
      );
    `);
    db.prepare("INSERT INTO studio_meta(key, value) VALUES('schema_version', ?)").run(options?.schemaVersion ?? "1");
    if (options?.includeRow !== false) {
      db.prepare(`
        INSERT INTO studio_media(
          sha256, kind, size_bytes, mime_type, source_basename, object_relpath,
          derivative_status, thumbnail_recipe_key, thumbnail_relpath,
          thumbnail_width, thumbnail_height, created_at
        ) VALUES(?, 'image', 12, 'image/png', 'still.png', ?, 'ready', ?, ?, 48, 32, '2026-08-25T00:00:00.000Z')
      `).run(
        SHA,
        `.aicanvas/objects/sha256/${SHA.slice(0, 2)}/${SHA}`,
        "c".repeat(64),
        `.aicanvas/derived/thumb/${"c".repeat(64)}.webp`,
      );
    }
  } finally {
    db.close();
  }
  return tempRoot;
}

describe("runtime-perf wave7 getStudioMedia readonly", () => {
  it("源码合同：按 SHA 读取不 ensure 目录、不走可写 openDatabase", () => {
    const material = source("src/core/material-studio.ts");
    const start = material.indexOf("export async function getStudioMedia");
    const helperStart = material.indexOf("function openMaterialStudioMediaReadOnly");
    const flightsStart = material.indexOf("const studioMediaLookupFlights");
    expect(helperStart).toBeGreaterThan(-1);
    expect(flightsStart).toBeGreaterThan(-1);
    expect(start).toBeGreaterThan(helperStart);
    const slice = material.slice(flightsStart, material.indexOf("const imageThumbnailRepairFlights"));
    expect(slice).toContain("readOnly: true");
    expect(slice).toContain("PRAGMA query_only = ON");
    expect(slice).toContain("studioMediaLookupFlights");
    expect(slice).not.toContain("ensureStudioDirectories");
    expect(slice).not.toMatch(/\bopenDatabase\s*\(/u);
    expect(material).toContain('const THUMBNAIL_RECIPE = "material-studio-thumb:v1:autorotate:inside-512:no-enlarge:webp-q82"');
  });

  it("缺库返回 null，不建素材库", async () => {
    const missing = await mkdtemp(path.join(os.tmpdir(), "runtime-perf-wave7-missing-"));
    roots.push(missing);
    await expect(getStudioMedia(missing, SHA)).resolves.toBeNull();
    expect(source("src/core/material-studio.ts")).toContain("function openMaterialStudioMediaReadOnly");
  });

  it("手工 sqlite 读到行；缺行 null；并发同 SHA 单飞同一对象", async () => {
    const root = await seedMaterialMediaDatabase();
    const [first, second, third] = await Promise.all([
      getStudioMedia(root, SHA),
      getStudioMedia(root, SHA),
      getStudioMedia(root, SHA),
    ]);
    expect(first?.sha256).toBe(SHA);
    expect(first?.kind).toBe("image");
    expect(first?.sourceBasename).toBe("still.png");
    expect(first?.thumbnail?.width).toBe(48);
    expect(second).toBe(first);
    expect(third).toBe(first);
    await expect(getStudioMedia(root, OTHER_SHA)).resolves.toBeNull();
    const sequential = await getStudioMedia(root, SHA);
    expect(sequential).toEqual(first);
    expect(sequential).not.toBe(first);
  });

  it("符号链接库失败关闭；不受支持 schema 失败关闭", async () => {
    const realRoot = await seedMaterialMediaDatabase();
    const realDb = path.join(realRoot, ".aicanvas", "material-studio.sqlite");
    const linkRoot = await mkdtemp(path.join(os.tmpdir(), "runtime-perf-wave7-link-"));
    roots.push(linkRoot);
    await mkdir(path.join(linkRoot, ".aicanvas"));
    await symlink(realDb, path.join(linkRoot, ".aicanvas", "material-studio.sqlite"));
    await expect(getStudioMedia(linkRoot, SHA)).rejects.toThrow("素材库数据库必须是无符号链接的普通文件。");

    const badRoot = await seedMaterialMediaDatabase({ schemaVersion: "99" });
    await expect(getStudioMedia(badRoot, SHA)).rejects.toThrow("不支持的素材库 schema_version：99。");
  });
});

describe("runtime-perf wave7 media protocol single session", () => {
  it("derivative 同源单次只读会话；二次 assertDatabaseFiles TOCTOU 保留", () => {
    const protocol = source("src/core/studio-media-protocol.ts");
    expect(protocol).toContain("function withProtocolDatabase");
    expect(protocol).toContain("function readDerivativeAndSourceRows");
    expect(protocol).toMatch(/if \(request\.target === "derivative"\) \{\n    const \{ derivative, source \} = readDerivativeAndSourceRows/u);
    expect(protocol.match(/await assertDatabaseFiles\(canonicalRoot\)/gu)).toHaveLength(3);
    expect(protocol).not.toContain("function readDerivativeRow(");
    expect(protocol).toContain('const THUMBNAIL_RECIPE = "material-studio-thumb:v1:autorotate:inside-512:no-enlarge:webp-q82"');
    expect(protocol).toContain("VERIFIED_FILE_CACHE_LIMIT");
  });
});
