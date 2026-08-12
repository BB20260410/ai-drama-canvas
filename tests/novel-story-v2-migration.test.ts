import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { access, copyFile, cp, link, mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createManagedProject } from "../src/core/managed-project.js";
import { parseNovelDocxIsolated } from "../src/core/novel-docx.js";
import { getSidecarPaths } from "../src/core/sidecar.js";
import {
  __setStoryMigrationTestHooksForTests,
  connectStoryEvents,
  importStoryFile,
  importStoryText,
  listStoryChapters,
  listStoryEvents,
  listStorySources,
  migrateStoryLibraryV1ToV2,
  readStoryChapter,
  splitStoryChapters,
  upsertStoryEvent,
} from "../src/core/story.js";
import type { StoryV1ToV2MigrationReceipt } from "../src/core/story.js";
import type { StoryEventGraph, StoryLibrary } from "../src/core/types.js";

const roots: string[] = [];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const require = createRequire(import.meta.url);
const mammothEntry = require.resolve("mammoth");
const mammothRoot = mammothEntry.slice(0, mammothEntry.lastIndexOf(`${path.sep}lib${path.sep}`));
const fixtureDocx = path.join(mammothRoot, "test", "test-data", "single-paragraph.docx");
let resetMigrationHooks: () => void = () => undefined;

afterEach(async () => {
  resetMigrationHooks();
  resetMigrationHooks = () => undefined;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function resignReceipt(receipt: StoryV1ToV2MigrationReceipt): void {
  const { fingerprint: _fingerprint, ...semantic } = receipt;
  receipt.fingerprint = sha256(stableJson(semantic));
}

interface Fixture {
  parent: string;
  root: string;
  originalPath: string;
  legacy: StoryLibrary;
  graph: StoryEventGraph;
}

function normalizeStoryText(value: string): string {
  return value.replace(/^\uFEFF/, "").replace(/\0/g, "").replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").replace(/\n{5,}/g, "\n\n\n").trim();
}

async function legacyStoryFixture(
  workspaceMode: "novel" | "hybrid" = "novel",
  sourceKind: "text" | "markdown" | "docx" = "markdown",
): Promise<Fixture> {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), `novel-story-v2-${workspaceMode}-`)));
  roots.push(parent);
  const shell = await createManagedProject({ parentRoot: parent, name: `${workspaceMode} Story 迁移`, workspaceMode });
  const root = shell.paths.root;
  const paths = getSidecarPaths(root);
  const extension = sourceKind === "docx" ? "docx" : sourceKind === "text" ? "txt" : "md";
  const originalPath = path.join(parent, `legacy-source.${extension}`);
  let sourceText = "第一章 神落\n阿航从雾河醒来。\n\n第二章 祭坛\n完整黄金面具发光。";
  if (sourceKind === "docx") {
    await copyFile(fixtureDocx, originalPath);
    sourceText = normalizeStoryText((await parseNovelDocxIsolated(originalPath)).text);
  } else {
    await writeFile(originalPath, sourceText, "utf8");
  }
  const drafts = splitStoryChapters(sourceText);
  const sourceId = "legacy-source-001";
  const timestamp = "2026-07-31T12:00:00.000Z";
  await mkdir(path.join(paths.storyChapters, sourceId), { recursive: true });
  await mkdir(paths.storySnapshots, { recursive: true });
  const snapshotPath = path.join(paths.storySnapshots, `${sourceId}.txt`);
  await writeFile(snapshotPath, `${sourceText}\n`, "utf8");
  const chapters = await Promise.all(drafts.map(async (draft, index) => {
    const id = `legacy-chapter-${index + 1}`;
    const chapterPath = path.join(paths.storyChapters, sourceId, `${String(index + 1).padStart(4, "0")}-${id}.txt`);
    await writeFile(chapterPath, `${draft.content}\n`, "utf8");
    return {
      id,
      sourceId,
      index: index + 1,
      title: draft.title,
      path: chapterPath,
      charCount: draft.content.length,
      sha256: sha256(draft.content),
      startOffset: draft.startOffset,
      endOffset: draft.endOffset,
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
  }));
  const legacy: StoryLibrary = {
    schemaVersion: 1,
    revision: 3,
    sources: [{
      id: sourceId,
      title: "古蜀十三相",
      originalPath,
      snapshotPath,
      kind: sourceKind,
      encoding: sourceKind === "docx" ? "docx" : "utf-8",
      sha256: sha256(sourceText),
      size: (await readFile(originalPath)).byteLength,
      charCount: sourceText.length,
      chapterIds: chapters.map((chapter) => chapter.id),
      revision: 1,
      importedAt: timestamp,
      updatedAt: timestamp,
    }],
    chapters,
    updatedAt: timestamp,
  };
  const graph: StoryEventGraph = {
    schemaVersion: 1,
    revision: 1,
    events: [{
      id: "legacy-event-1",
      chapterId: chapters[0]!.id,
      order: 1,
      title: "阿航苏醒",
      description: "阿航从雾河醒来。",
      sourceExcerpt: "阿航从雾河醒来。",
      characters: ["阿航"],
      locations: ["雾河"],
      props: [],
      tags: [],
      itemIds: [],
      dependencyIds: [],
      status: "confirmed",
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    }],
    updatedAt: timestamp,
  };
  await writeFile(paths.storyIndex, `${JSON.stringify(legacy, null, 2)}\n`, "utf8");
  await writeFile(paths.storyEvents, `${JSON.stringify(graph, null, 2)}\n`, "utf8");
  return { parent, root, originalPath, legacy, graph };
}

async function allReceiptFiles(root: string): Promise<string[]> {
  const migrations = getSidecarPaths(root).storyMigrations;
  return readdir(migrations, { recursive: true })
    .then((entries) => entries.filter((entry) => entry.endsWith("receipt.json")))
    .catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? [] : Promise.reject(error));
}

describe("story v1 → v2 安全迁移", () => {
  it.each(["novel", "hybrid"] as const)("schema v2 %s 在显式迁移前拒绝 legacy v1 读取且全树零写", async (workspaceMode) => {
    const fixture = await legacyStoryFixture(workspaceMode);
    const before = await Promise.all([
      readFile(getSidecarPaths(fixture.root).storyIndex),
      readFile(getSidecarPaths(fixture.root).storyEvents),
    ]);

    await expect(listStorySources(fixture.root)).rejects.toThrow("请先显式运行 story v1→v2 迁移");
    await expect(readStoryChapter(fixture.root, fixture.legacy.chapters[0]!.id)).rejects.toThrow("请先显式运行 story v1→v2 迁移");
    expect(await Promise.all([
      readFile(getSidecarPaths(fixture.root).storyIndex),
      readFile(getSidecarPaths(fixture.root).storyEvents),
    ])).toEqual(before);
    expect(await allReceiptFiles(fixture.root)).toEqual([]);
  });

  it.each(["novel", "hybrid"] as const)("%s 显式迁移只落相对 locator、稳定 UUID、完整镜像与可恢复回执", async (workspaceMode) => {
    const fixture = await legacyStoryFixture(workspaceMode);
    const paths = getSidecarPaths(fixture.root);
    const sourceIndexBytes = await readFile(paths.storyIndex);
    const externalSourceBytes = await readFile(fixture.originalPath);
    expect(path.relative(fixture.root, fixture.originalPath).startsWith(`..${path.sep}`)).toBe(true);

    const result = await migrateStoryLibraryV1ToV2(fixture.root);
    expect(result.status).toBe("migrated");
    expect(result.receipt.sourceIndexSha256).toBe(sha256(sourceIndexBytes));
    expect(result.receipt.mappings.sources[0]?.stableId).toMatch(UUID_PATTERN);
    expect(result.receipt.mappings.chapters.every((entry) => UUID_PATTERN.test(entry.stableId))).toBe(true);

    const rawText = await readFile(paths.storyIndex, "utf8");
    const raw = JSON.parse(rawText) as {
      schemaVersion: number;
      sources: Array<Record<string, unknown>>;
      chapters: Array<Record<string, unknown>>;
      migration: { receiptLocator: string };
    };
    expect(raw.schemaVersion).toBe(2);
    expect(rawText).not.toContain(fixture.root);
    expect(raw.sources[0]).not.toHaveProperty("originalPath");
    expect(raw.sources[0]).not.toHaveProperty("snapshotPath");
    expect(raw.chapters[0]).not.toHaveProperty("path");
    const locators = [
      ...raw.sources.flatMap((source) => [source.originalLocator, source.snapshotLocator]),
      ...raw.chapters.map((chapter) => chapter.locator),
      raw.migration.receiptLocator,
    ] as string[];
    expect(locators.every((locator) => !path.isAbsolute(locator) && !locator.split("/").includes(".."))).toBe(true);

    const receiptPath = path.resolve(fixture.root, ...result.receipt.receiptLocator.split("/"));
    const mirrorIndexPath = path.resolve(fixture.root, ...result.receipt.mirrorLocator.split("/"), "story-index-v1.json");
    await expect(access(receiptPath)).resolves.toBeUndefined();
    expect(await readFile(mirrorIndexPath)).toEqual(sourceIndexBytes);
    expect(await readFile(fixture.originalPath)).toEqual(externalSourceBytes);
    expect(await allReceiptFiles(fixture.root)).toHaveLength(1);

    const sources = await listStorySources(fixture.root);
    const chapters = await listStoryChapters(fixture.root);
    const events = await listStoryEvents(fixture.root);
    expect(sources[0]?.id).toBe(result.receipt.mappings.sources[0]?.stableId);
    expect(chapters.map((chapter) => chapter.id)).toEqual(result.receipt.mappings.chapters.map((entry) => entry.stableId));
    expect(events[0]?.chapterId).toBe(result.receipt.mappings.chapters[0]?.stableId);
    expect((await readStoryChapter(fixture.root, chapters[1]!.id)).content).toContain("完整黄金面具");

    const replay = await migrateStoryLibraryV1ToV2(fixture.root);
    expect(replay.status).toBe("already_migrated");
    expect(replay.receipt.fingerprint).toBe(result.receipt.fingerprint);
    expect(await allReceiptFiles(fixture.root)).toHaveLength(1);

    const restoredParent = await mkdtemp(path.join(os.tmpdir(), "novel-story-v2-restored-"));
    roots.push(restoredParent);
    const restored = path.join(restoredParent, "restored-project");
    await cp(fixture.root, restored, { recursive: true, preserveTimestamps: true });
    const restoredChapters = await listStoryChapters(restored);
    expect((await readStoryChapter(restored, restoredChapters[0]!.id)).content).toContain("阿航从雾河醒来");
  });

  it.each(["text", "docx"] as const)("项目外 %s 原稿经对应正文解码/隔离解析复验 SHA 后只读迁移", async (sourceKind) => {
    const fixture = await legacyStoryFixture("novel", sourceKind);
    const paths = getSidecarPaths(fixture.root);
    const beforeSource = await readFile(fixture.originalPath);

    const migrated = await migrateStoryLibraryV1ToV2(fixture.root);

    expect(migrated.status).toBe("migrated");
    expect(await readFile(fixture.originalPath)).toEqual(beforeSource);
    const originalRecord = migrated.receipt.files.find((entry) => entry.role === "source-original");
    expect(originalRecord?.locator.endsWith(sourceKind === "docx" ? ".docx" : ".txt")).toBe(true);
    expect(originalRecord?.sha256).toBe(sha256(beforeSource));
    const raw = JSON.parse(await readFile(paths.storyIndex, "utf8")) as { sources: Array<{ sha256: string }> };
    expect(raw.sources[0]?.sha256).toBe(fixture.legacy.sources[0]?.sha256);
  });

  it("项目外 original symlink、同大小错误正文和冻结后替换均失败关闭", async () => {
    const linked = await legacyStoryFixture();
    const linkedPaths = getSidecarPaths(linked.root);
    const linkedBefore = await readFile(linkedPaths.storyIndex);
    const linkedTarget = path.join(linked.parent, "linked-target.md");
    await writeFile(linkedTarget, await readFile(linked.originalPath));
    await unlink(linked.originalPath);
    await symlink(linkedTarget, linked.originalPath);
    await expect(migrateStoryLibraryV1ToV2(linked.root)).rejects.toThrow("单链接非空普通文件");
    expect(await readFile(linkedPaths.storyIndex)).toEqual(linkedBefore);

    const mismatched = await legacyStoryFixture();
    const mismatchedPaths = getSidecarPaths(mismatched.root);
    const mismatchedBefore = await readFile(mismatchedPaths.storyIndex);
    const originalText = await readFile(mismatched.originalPath, "utf8");
    const wrongText = originalText.replace("阿航", "阿港");
    expect(Buffer.byteLength(wrongText)).toBe(Buffer.byteLength(originalText));
    await writeFile(mismatched.originalPath, wrongText, "utf8");
    await expect(migrateStoryLibraryV1ToV2(mismatched.root)).rejects.toThrow("内容与快照身份不一致");
    expect(await readFile(mismatchedPaths.storyIndex)).toEqual(mismatchedBefore);

    const replaced = await legacyStoryFixture();
    const replacedPaths = getSidecarPaths(replaced.root);
    const replacedBefore = await readFile(replacedPaths.storyIndex);
    const replacementPath = path.join(replaced.parent, "replacement.md");
    await writeFile(replacementPath, await readFile(replaced.originalPath));
    resetMigrationHooks = __setStoryMigrationTestHooksForTests({
      afterExternalSourceFreeze: async ({ sourcePath }) => {
        await rename(replacementPath, sourcePath);
      },
    });
    await expect(migrateStoryLibraryV1ToV2(replaced.root)).rejects.toThrow("身份或内容已变化");
    expect(await readFile(replacedPaths.storyIndex)).toEqual(replacedBefore);
  });

  it.each(["directory", "symlink"] as const)("发布目标被竞态创建为 %s 时 no-replace 失败且不切换 v1 index", async (targetKind) => {
    const fixture = await legacyStoryFixture();
    const paths = getSidecarPaths(fixture.root);
    const indexBefore = await readFile(paths.storyIndex);
    const outside = path.join(fixture.parent, `publish-race-${targetKind}`);
    await mkdir(outside);
    resetMigrationHooks = __setStoryMigrationTestHooksForTests({
      beforePublish: async ({ finalRoot }) => {
        if (targetKind === "directory") await mkdir(finalRoot);
        else await symlink(outside, finalRoot);
      },
    });

    await expect(migrateStoryLibraryV1ToV2(fixture.root)).rejects.toThrow();
    expect(await readFile(paths.storyIndex)).toEqual(indexBefore);
    expect(JSON.parse(await readFile(paths.storyIndex, "utf8"))).toHaveProperty("schemaVersion", 1);
  });

  it("staging 父目录被替换为外部 symlink 时失败保留隔离证据且绝不路径式递归删除外部 sentinel", async () => {
    const fixture = await legacyStoryFixture();
    const paths = getSidecarPaths(fixture.root);
    const indexBefore = await readFile(paths.storyIndex);
    const externalStaging = path.join(fixture.parent, "attacker-controlled-staging");
    const sentinelBytes = Buffer.from("不得删除的外部证据", "utf8");
    let sentinelPath = "";
    await mkdir(externalStaging);
    resetMigrationHooks = __setStoryMigrationTestHooksForTests({
      beforePublish: async ({ stagingRoot }) => {
        const stagingParent = path.dirname(stagingRoot);
        const quarantinedParent = `${stagingParent}-frozen-owned`;
        await rename(stagingParent, quarantinedParent);
        const attackerMigration = path.join(externalStaging, path.basename(stagingRoot));
        await mkdir(attackerMigration);
        sentinelPath = path.join(attackerMigration, "sentinel.txt");
        await writeFile(sentinelPath, sentinelBytes);
        await symlink(externalStaging, stagingParent);
      },
    });

    await expect(migrateStoryLibraryV1ToV2(fixture.root)).rejects.toThrow(/ENOENT|符号链接|身份/u);
    expect(await readFile(paths.storyIndex)).toEqual(indexBefore);
    expect(await readFile(sentinelPath)).toEqual(sentinelBytes);
  });

  it.each(["duplicate-mapping", "cross-migration-locator", "duplicate-locator", "project-id"] as const)(
    "首次发布前 receipt 闭包篡改 %s 失败且 v1 index 不切换",
    async (mutation) => {
      const fixture = await legacyStoryFixture();
      const paths = getSidecarPaths(fixture.root);
      const indexBefore = await readFile(paths.storyIndex);
      resetMigrationHooks = __setStoryMigrationTestHooksForTests({
        beforePublish: async ({ stagingRoot }) => {
          const receiptPath = path.join(stagingRoot, "receipt.json");
          const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as StoryV1ToV2MigrationReceipt;
          if (mutation === "duplicate-mapping") {
            receipt.mappings.sources.push({ ...receipt.mappings.sources[0]! });
          } else if (mutation === "cross-migration-locator") {
            receipt.files[0]!.locator = receipt.files[0]!.locator.replace(
              receipt.migrationId,
              "story-migration-00000000-0000-4000-8000-000000000000",
            );
          } else if (mutation === "duplicate-locator") {
            receipt.files[1]!.locator = receipt.files[0]!.locator;
          } else {
            receipt.projectId = "different-project-id";
          }
          resignReceipt(receipt);
          await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
        },
      });

      await expect(migrateStoryLibraryV1ToV2(fixture.root)).rejects.toThrow(/迁移闭包/u);
      expect(await readFile(paths.storyIndex)).toEqual(indexBefore);
      expect(JSON.parse(await readFile(paths.storyIndex, "utf8"))).toHaveProperty("schemaVersion", 1);
    },
  );

  it.each(["tamper", "hardlink"] as const)("首次发布前 source-original %s 被闭包验证拦截且 v1 index 不切换", async (mutation) => {
    const fixture = await legacyStoryFixture();
    const paths = getSidecarPaths(fixture.root);
    const indexBefore = await readFile(paths.storyIndex);
    resetMigrationHooks = __setStoryMigrationTestHooksForTests({
      beforePublish: async ({ stagingRoot }) => {
        const receipt = JSON.parse(await readFile(path.join(stagingRoot, "receipt.json"), "utf8")) as StoryV1ToV2MigrationReceipt;
        const record = receipt.files.find((file) => file.role === "source-original")!;
        const suffix = record.locator.slice(record.locator.indexOf(`${receipt.migrationId}/`) + receipt.migrationId.length + 1);
        const sourceOriginal = path.join(stagingRoot, ...suffix.split("/"));
        if (mutation === "tamper") await writeFile(sourceOriginal, "闭包外篡改", "utf8");
        else await link(sourceOriginal, `${sourceOriginal}.hardlink`);
      },
    });

    await expect(migrateStoryLibraryV1ToV2(fixture.root)).rejects.toThrow(/迁移闭包|单链接/u);
    expect(await readFile(paths.storyIndex)).toEqual(indexBefore);
  });

  it.each(["duplicate-mapping", "cross-migration-locator", "duplicate-locator", "project-id"] as const)(
    "已发布 receipt %s 被正常 load 与 replay 同时失败关闭",
    async (mutation) => {
      const fixture = await legacyStoryFixture();
      const migrated = await migrateStoryLibraryV1ToV2(fixture.root);
      const receiptPath = path.resolve(fixture.root, ...migrated.receipt.receiptLocator.split("/"));
      const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as StoryV1ToV2MigrationReceipt;
      if (mutation === "duplicate-mapping") {
        receipt.mappings.chapters.push({ ...receipt.mappings.chapters[0]! });
      } else if (mutation === "cross-migration-locator") {
        receipt.files[0]!.locator = receipt.files[0]!.locator.replace(
          receipt.migrationId,
          "story-migration-00000000-0000-4000-8000-000000000000",
        );
      } else if (mutation === "duplicate-locator") {
        receipt.files[1]!.locator = receipt.files[0]!.locator;
      } else {
        receipt.projectId = "different-project-id";
      }
      resignReceipt(receipt);
      await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");

      await expect(listStorySources(fixture.root)).rejects.toThrow(/迁移闭包/u);
      await expect(migrateStoryLibraryV1ToV2(fixture.root)).rejects.toThrow(/迁移闭包/u);
    },
  );

  it.each(["tamper", "hardlink"] as const)("已发布 source-original %s 后正常 load 与 replay 都按 receipt SHA/长度失败关闭", async (mutation) => {
    const fixture = await legacyStoryFixture();
    const migrated = await migrateStoryLibraryV1ToV2(fixture.root);
    const record = migrated.receipt.files.find((file) => file.role === "source-original")!;
    const sourceOriginal = path.resolve(fixture.root, ...record.locator.split("/"));
    if (mutation === "tamper") await writeFile(sourceOriginal, "发布后篡改", "utf8");
    else await link(sourceOriginal, `${sourceOriginal}.hardlink`);

    await expect(listStorySources(fixture.root)).rejects.toThrow(/迁移闭包|单链接/u);
    await expect(migrateStoryLibraryV1ToV2(fixture.root)).rejects.toThrow(/迁移闭包|单链接/u);
  });

  it.each(["chapter", "source-snapshot", "source-original"] as const)(
    "已发布 %s 被改写并重算 receipt fingerprint 后仍因 v2 语义绑定失败关闭",
    async (role) => {
      const fixture = await legacyStoryFixture("novel", "text");
      const migrated = await migrateStoryLibraryV1ToV2(fixture.root);
      const receiptPath = path.resolve(fixture.root, ...migrated.receipt.receiptLocator.split("/"));
      const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as StoryV1ToV2MigrationReceipt;
      const record = receipt.files.find((file) => file.role === role)!;
      const artifactPath = path.resolve(fixture.root, ...record.locator.split("/"));
      const before = await readFile(artifactPath, "utf8");
      const changed = before.replace("阿航", "阿港");
      expect(changed).not.toBe(before);
      expect(Buffer.byteLength(changed)).toBe(Buffer.byteLength(before));
      await writeFile(artifactPath, changed, "utf8");
      record.sha256 = sha256(Buffer.from(changed, "utf8"));
      record.byteLength = Buffer.byteLength(changed);
      resignReceipt(receipt);
      await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");

      await expect(listStorySources(fixture.root)).rejects.toThrow(/语义绑定|章节未语义|来源快照/u);
      await expect(migrateStoryLibraryV1ToV2(fixture.root)).rejects.toThrow(/语义绑定|章节未语义|来源快照/u);
    },
  );

  it("DOCX original 被同长改写并重签 receipt 后仍必须通过隔离解析的正文语义绑定", async () => {
    const fixture = await legacyStoryFixture("novel", "docx");
    const migrated = await migrateStoryLibraryV1ToV2(fixture.root);
    const receiptPath = path.resolve(fixture.root, ...migrated.receipt.receiptLocator.split("/"));
    const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as StoryV1ToV2MigrationReceipt;
    const record = receipt.files.find((file) => file.role === "source-original")!;
    const artifactPath = path.resolve(fixture.root, ...record.locator.split("/"));
    const changed = Buffer.from(await readFile(artifactPath));
    changed[Math.max(0, changed.length - 8)] = changed[Math.max(0, changed.length - 8)]! ^ 0x01;
    await writeFile(artifactPath, changed);
    record.sha256 = sha256(changed);
    record.byteLength = changed.byteLength;
    resignReceipt(receipt);
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");

    await expect(listStorySources(fixture.root)).rejects.toThrow(/DOCX|隔离解析|语义/u);
  });

  it.each(["v2-to-v1-swap", "hardlink", "symlink"] as const)("权威 story index 遭遇 %s 时从首次冻结读取起失败关闭", async (mutation) => {
    const fixture = await legacyStoryFixture();
    const paths = getSidecarPaths(fixture.root);
    await migrateStoryLibraryV1ToV2(fixture.root);
    const frozenV2 = await readFile(paths.storyIndex);
    const replacementPath = path.join(path.dirname(paths.storyIndex), `index-${mutation}-replacement.json`);
    if (mutation === "v2-to-v1-swap") {
      await writeFile(replacementPath, `${JSON.stringify(fixture.legacy, null, 2)}\n`, "utf8");
      resetMigrationHooks = __setStoryMigrationTestHooksForTests({
        afterLibraryIndexFreeze: async ({ indexPath, schemaVersion }) => {
          expect(schemaVersion).toBe(2);
          await rename(replacementPath, indexPath);
        },
      });
      await expect(listStorySources(fixture.root)).rejects.toThrow(/索引.*替换/u);
      expect(JSON.parse(await readFile(paths.storyIndex, "utf8"))).toHaveProperty("schemaVersion", 1);
      return;
    }
    await writeFile(replacementPath, frozenV2);
    await unlink(paths.storyIndex);
    if (mutation === "hardlink") await link(replacementPath, paths.storyIndex);
    else await symlink(replacementPath, paths.storyIndex);
    await expect(listStorySources(fixture.root)).rejects.toThrow(/单链接|无符号链接/u);
  });

  it("v2 novel/hybrid 在迁移前后都拒绝全部 legacy Story mutation 且不改索引/事件图", async () => {
    const fixture = await legacyStoryFixture("hybrid");
    const paths = getSidecarPaths(fixture.root);
    const assertBlockedWithoutWrites = async (operation: () => Promise<unknown>) => {
      const before = await Promise.all([readFile(paths.storyIndex), readFile(paths.storyEvents)]);
      await expect(operation()).rejects.toThrow("禁止 legacy Story 写入");
      const after = await Promise.all([readFile(paths.storyIndex), readFile(paths.storyEvents)]);
      expect(after).toEqual(before);
    };

    await assertBlockedWithoutWrites(() => importStoryFile(fixture.root, fixture.originalPath));
    await assertBlockedWithoutWrites(() => importStoryText(fixture.root, { title: "禁止", content: "第一章 禁止\n不得写入。" }));
    await assertBlockedWithoutWrites(() => upsertStoryEvent(fixture.root, {
      chapterId: fixture.legacy.chapters[0]!.id,
      title: "禁止",
      description: "不得写入",
    }));
    await assertBlockedWithoutWrites(() => connectStoryEvents(fixture.root, "legacy-event-1", "legacy-event-1"));

    const migrated = await migrateStoryLibraryV1ToV2(fixture.root);
    await assertBlockedWithoutWrites(() => importStoryText(fixture.root, { title: "仍禁止", content: "不得写入" }));
    await assertBlockedWithoutWrites(() => upsertStoryEvent(fixture.root, {
      chapterId: migrated.receipt.mappings.chapters[0]!.stableId,
      title: "仍禁止",
      description: "不得写入",
    }));
  });

  it("越根章节、symlink 和孤儿事件逐项失败关闭，原 v1 index 字节不被替换", async () => {
    const outsideParent = await mkdtemp(path.join(os.tmpdir(), "novel-story-v2-outside-"));
    roots.push(outsideParent);
    const outside = path.join(outsideParent, "outside.txt");
    await writeFile(outside, "越根内容", "utf8");

    const escaped = await legacyStoryFixture();
    const escapedPaths = getSidecarPaths(escaped.root);
    const escapedRaw = JSON.parse(await readFile(escapedPaths.storyIndex, "utf8")) as StoryLibrary;
    escapedRaw.chapters[1]!.path = outside;
    await writeFile(escapedPaths.storyIndex, `${JSON.stringify(escapedRaw, null, 2)}\n`, "utf8");
    const escapedBefore = await readFile(escapedPaths.storyIndex);
    await expect(migrateStoryLibraryV1ToV2(escaped.root)).rejects.toThrow("越出项目根");
    expect(await readFile(escapedPaths.storyIndex)).toEqual(escapedBefore);
    expect(await allReceiptFiles(escaped.root)).toEqual([]);

    const linked = await legacyStoryFixture();
    const linkedPaths = getSidecarPaths(linked.root);
    const linkedChapter = linked.legacy.chapters[1]!.path;
    await unlink(linkedChapter);
    await symlink(outside, linkedChapter);
    const linkedBefore = await readFile(linkedPaths.storyIndex);
    await expect(migrateStoryLibraryV1ToV2(linked.root)).rejects.toThrow("无符号链接的普通文件");
    expect(await readFile(linkedPaths.storyIndex)).toEqual(linkedBefore);
    expect(await allReceiptFiles(linked.root)).toEqual([]);

    const orphaned = await legacyStoryFixture();
    const orphanedPaths = getSidecarPaths(orphaned.root);
    const graph = JSON.parse(await readFile(orphanedPaths.storyEvents, "utf8")) as StoryEventGraph;
    graph.events[0]!.chapterId = "missing-chapter";
    await writeFile(orphanedPaths.storyEvents, `${JSON.stringify(graph, null, 2)}\n`, "utf8");
    const orphanedBefore = await readFile(orphanedPaths.storyIndex);
    await expect(migrateStoryLibraryV1ToV2(orphaned.root)).rejects.toThrow("引用不存在章节");
    expect(await readFile(orphanedPaths.storyIndex)).toEqual(orphanedBefore);
    expect(await allReceiptFiles(orphaned.root)).toEqual([]);
  });

  it("迁移后 locator 被篡改为绝对路径时所有读取失败关闭", async () => {
    const fixture = await legacyStoryFixture();
    const paths = getSidecarPaths(fixture.root);
    await migrateStoryLibraryV1ToV2(fixture.root);
    const raw = JSON.parse(await readFile(paths.storyIndex, "utf8")) as {
      sources: Array<{ originalLocator: string }>;
    };
    raw.sources[0]!.originalLocator = path.join(os.tmpdir(), "outside-secret.txt");
    await writeFile(paths.storyIndex, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
    await expect(listStorySources(fixture.root)).rejects.toThrow("必须是项目内");
  });

  it("迁移镜像章节内容被外部篡改后读取因 SHA/字数不一致失败关闭", async () => {
    const fixture = await legacyStoryFixture();
    const paths = getSidecarPaths(fixture.root);
    const migrated = await migrateStoryLibraryV1ToV2(fixture.root);
    const raw = JSON.parse(await readFile(paths.storyIndex, "utf8")) as {
      chapters: Array<{ id: string; locator: string }>;
    };
    const chapter = raw.chapters[0]!;
    const chapterPath = path.resolve(fixture.root, ...chapter.locator.split("/"));
    await writeFile(chapterPath, "被篡改的章节内容。\n", "utf8");
    await expect(readStoryChapter(fixture.root, chapter.id)).rejects.toThrow(/迁移闭包文件 SHA\/长度|SHA\/字数与索引不一致/u);
    expect(migrated.receipt.targetIndexSha256).toBe(sha256(await readFile(paths.storyIndex)));
  });
});
