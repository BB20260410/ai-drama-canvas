import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  parseLocalCreativeContentCatalogArgs,
  runLocalCreativeContentCatalogImport,
} from "../scripts/import-local-creative-project-content-catalog.js";
import { createManagedProject } from "../src/core/managed-project.js";
import { getMaterialStudioState } from "../src/core/material-studio.js";

let temporaryRoot = "";
let registryPath = "";
let priorRegistryPath: string | undefined;
const cleanups: string[] = [];

interface SnapshotEntry {
  type: "directory" | "file";
  size: number;
  mtimeMs: number;
  sha256?: string;
}

async function treeSnapshot(root: string): Promise<Record<string, SnapshotEntry>> {
  const snapshot: Record<string, SnapshotEntry> = {};
  async function walk(directory: string): Promise<void> {
    for (const entry of (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute);
      const metadata = await lstat(absolute);
      if (entry.isDirectory()) {
        snapshot[relative] = { type: "directory", size: metadata.size, mtimeMs: metadata.mtimeMs };
        await walk(absolute);
      } else if (entry.isFile()) {
        const bytes = await readFile(absolute);
        snapshot[relative] = {
          type: "file",
          size: metadata.size,
          mtimeMs: metadata.mtimeMs,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        };
      } else {
        throw new Error(`测试源含非普通节点：${absolute}`);
      }
    }
  }
  await walk(root);
  return snapshot;
}

async function writePng(root: string, relative: string, color: string): Promise<void> {
  const target = path.join(root, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await sharp({ create: { width: 36, height: 24, channels: 3, background: color } }).png().toFile(target);
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

beforeEach(async () => {
  temporaryRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "local-content-catalog-")));
  cleanups.push(temporaryRoot);
  registryPath = path.join(temporaryRoot, "registry", "projects.json");
  priorRegistryPath = process.env.AI_CANVAS_REGISTRY_PATH;
  process.env.AI_CANVAS_REGISTRY_PATH = registryPath;
  await mkdir(path.dirname(registryPath), { recursive: true });
  await writeFile(registryPath, "[]\n", "utf8");
  await writeFile(path.join(path.dirname(registryPath), "active-project.json"), "{\"active\":\"sentinel\"}\n", "utf8");
});

afterEach(async () => {
  if (priorRegistryPath === undefined) delete process.env.AI_CANVAS_REGISTRY_PATH;
  else process.env.AI_CANVAS_REGISTRY_PATH = priorRegistryPath;
  await Promise.all(cleanups.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe.sequential("本机创作项目 catalog 内容串行编排", () => {
  it("只处理 CREATE 项目、逐项落报告并保持 REUSE、活动指针和创作源不变", async () => {
    const projectsRoot = path.join(temporaryRoot, "projects");
    const sourcesRoot = path.join(temporaryRoot, "sources");
    await Promise.all([mkdir(projectsRoot), mkdir(sourcesRoot)]);
    const managedSource = path.join(sourcesRoot, "managed");
    const inboxSource = path.join(sourcesRoot, "inbox");
    const reuseSource = path.join(sourcesRoot, "reuse");
    await Promise.all([mkdir(managedSource), mkdir(inboxSource), mkdir(reuseSource)]);
    await writePng(managedSource, "角色/char-hero.png", "#536b57");
    await writeFile(
      path.join(managedSource, "角色锁定.md"),
      "参考资产：角色/char-hero.png\n状态: APPROVED_LOCK\n唯一权威角色锁\nReview / QC: PASS\n",
      "utf8",
    );
    await writePng(inboxSource, "candidate.png", "#7b6350");
    await writeFile(path.join(reuseSource, "只读.txt"), "不可写\n", "utf8");
    const [managed, inbox, reuse] = await Promise.all([
      createManagedProject({ parentRoot: projectsRoot, name: "剧情工程", slug: "managed" }),
      createManagedProject({ parentRoot: projectsRoot, name: "媒体收件箱", slug: "inbox" }),
      createManagedProject({ parentRoot: projectsRoot, name: "既有只读工程", slug: "reuse" }),
    ]);
    const catalogPath = path.join(temporaryRoot, "catalog.json");
    const materializationPath = path.join(temporaryRoot, "materialization.json");
    const outputPath = path.join(temporaryRoot, "content-report.json");
    const catalog = {
      schemaVersion: 1,
      projects: [
        {
          key: "managed-story",
          name: "剧情工程",
          projectType: "story-production",
          resolution: "CREATE_MANAGED",
          sources: [{ root: managedSource, role: "PRIMARY_AUTHORITY" }],
        },
        {
          key: "media-inbox",
          name: "媒体收件箱",
          projectType: "unassigned-inbox",
          resolution: "CREATE_INBOX",
          authorityPolicy: "FORBID_ALL",
          sources: [{ root: inboxSource, role: "UNASSIGNED_INBOX" }],
        },
        {
          key: "reuse-project",
          name: "既有只读工程",
          projectType: "story-production",
          resolution: "REUSE_READONLY",
          managedProjectRoot: reuse.paths.root,
          sources: [{ root: reuseSource, role: "PRIMARY_AUTHORITY" }],
        },
      ],
    };
    const materialization = {
      schemaVersion: 1,
      kind: "local-creative-project-materialization-report",
      fingerprint: "a".repeat(64),
      summary: { activePointerUnchanged: true },
      results: [
        { key: "managed-story", name: "剧情工程", status: "materialized", resolution: "CREATE_MANAGED", projectRoot: managed.paths.root },
        { key: "media-inbox", name: "媒体收件箱", status: "materialized", resolution: "CREATE_INBOX", projectRoot: inbox.paths.root },
        { key: "reuse-project", name: "既有只读工程", status: "materialized", resolution: "REUSE_READONLY", projectRoot: reuse.paths.root },
      ],
    };
    await Promise.all([writeJson(catalogPath, catalog), writeJson(materializationPath, materialization)]);
    const activePath = path.join(path.dirname(registryPath), "active-project.json");
    const [activeBefore, managedSourceBefore, inboxSourceBefore, reuseSourceBefore, reuseProjectBefore] = await Promise.all([
      readFile(activePath),
      treeSnapshot(managedSource),
      treeSnapshot(inboxSource),
      treeSnapshot(reuseSource),
      treeSnapshot(reuse.paths.root),
    ]);
    const messages: string[] = [];

    const report = await runLocalCreativeContentCatalogImport({
      catalogPath,
      materializationReportPath: materializationPath,
      outputPath,
      registryPath,
      progressIntervalMs: 100,
      onProgress: (message) => messages.push(message),
    });

    expect(report.status).toBe("completed");
    expect(report.summary).toMatchObject({
      selected: 3,
      completed: 2,
      completedWithFailures: 0,
      failed: 0,
      skippedReadonly: 1,
      mediaImported: 2,
      pendingAssetsCreated: 1,
      authorityPromotions: 0,
    });
    expect(report.activePointer.unchanged).toBe(true);
    expect(report.projects.map((project) => [project.key, project.status])).toEqual([
      ["managed-story", "completed"],
      ["media-inbox", "completed"],
      ["reuse-project", "skipped-readonly"],
    ]);
    expect(messages.some((message) => message.includes("SCAN_START"))).toBe(true);
    expect(messages.some((message) => message.includes("FILE 1/1"))).toBe(true);
    expect(messages.some((message) => message.includes("SKIP REUSE_READONLY"))).toBe(true);
    expect(await readFile(outputPath, "utf8").then((content) => JSON.parse(content))).toMatchObject({
      kind: "local-creative-project-content-import-report",
      status: "completed",
      activePointer: { unchanged: true },
    });
    expect((await getMaterialStudioState(managed.paths.root)).counts).toMatchObject({
      media: 1,
      canonicalAssets: 1,
      primaryAuthorities: 0,
      versionReviews: 0,
    });
    expect((await getMaterialStudioState(inbox.paths.root)).counts).toMatchObject({ media: 1, canonicalAssets: 0 });
    expect(await treeSnapshot(reuse.paths.root)).toEqual(reuseProjectBefore);
    expect(await readFile(activePath)).toEqual(activeBefore);
    expect(await treeSnapshot(managedSource)).toEqual(managedSourceBefore);
    expect(await treeSnapshot(inboxSource)).toEqual(inboxSourceBefore);
    expect(await treeSnapshot(reuseSource)).toEqual(reuseSourceBefore);
  });

  it("支持 --project/--fail-fast；默认继续失败项目，fail-fast 则保留未执行项并清晰终止", async () => {
    const parsed = parseLocalCreativeContentCatalogArgs([
      "--project", "good-story",
      "--project=good-story",
      "--fail-fast",
      "--document-limit", "12",
      "--output=reports/out.json",
    ], temporaryRoot);
    expect(parsed).toMatchObject({
      projectKeys: ["good-story"],
      failFast: true,
      documentLimit: 12,
      outputPath: path.join(temporaryRoot, "reports/out.json"),
    });

    const projectsRoot = path.join(temporaryRoot, "projects");
    const goodSource = path.join(temporaryRoot, "good-source");
    await Promise.all([mkdir(projectsRoot), mkdir(goodSource)]);
    await writePng(goodSource, "good.png", "#526a78");
    const badSource = path.join(temporaryRoot, "missing-source");
    const [bad, good] = await Promise.all([
      createManagedProject({ parentRoot: projectsRoot, name: "坏项目", slug: "bad" }),
      createManagedProject({ parentRoot: projectsRoot, name: "好项目", slug: "good" }),
    ]);
    const catalogPath = path.join(temporaryRoot, "failure-catalog.json");
    const materializationPath = path.join(temporaryRoot, "failure-materialization.json");
    const catalog = {
      schemaVersion: 1,
      projects: [
        {
          key: "bad-story",
          name: "坏项目",
          projectType: "story-production",
          resolution: "CREATE_MANAGED",
          sources: [{ root: badSource, role: "PRIMARY_AUTHORITY" }],
        },
        {
          key: "good-story",
          name: "好项目",
          projectType: "story-production",
          resolution: "CREATE_MANAGED",
          sources: [{ root: goodSource, role: "PRIMARY_AUTHORITY" }],
        },
      ],
    };
    const materialization = {
      schemaVersion: 1,
      kind: "local-creative-project-materialization-report",
      fingerprint: "b".repeat(64),
      summary: { activePointerUnchanged: true },
      results: [
        { key: "bad-story", name: "坏项目", status: "materialized", resolution: "CREATE_MANAGED", projectRoot: bad.paths.root },
        { key: "good-story", name: "好项目", status: "materialized", resolution: "CREATE_MANAGED", projectRoot: good.paths.root },
      ],
    };
    await Promise.all([writeJson(catalogPath, catalog), writeJson(materializationPath, materialization)]);

    const continued = await runLocalCreativeContentCatalogImport({
      catalogPath,
      materializationReportPath: materializationPath,
      outputPath: path.join(temporaryRoot, "continued.json"),
      registryPath,
      onProgress: () => undefined,
    });
    expect(continued).toMatchObject({
      status: "completed-with-failures",
      summary: { completed: 1, failed: 1, pending: 0 },
      activePointer: { unchanged: true },
    });
    expect((await getMaterialStudioState(good.paths.root)).counts.media).toBe(1);

    const freshGood = await createManagedProject({ parentRoot: projectsRoot, name: "好项目二", slug: "good-two" });
    materialization.results[1]!.projectRoot = freshGood.paths.root;
    await writeJson(materializationPath, materialization);
    const stopped = await runLocalCreativeContentCatalogImport({
      catalogPath,
      materializationReportPath: materializationPath,
      outputPath: path.join(temporaryRoot, "stopped.json"),
      registryPath,
      failFast: true,
      onProgress: () => undefined,
    });
    expect(stopped).toMatchObject({
      status: "aborted",
      summary: { failed: 1, pending: 1 },
      activePointer: { unchanged: true },
    });
    expect(stopped.abortReason).toContain("fail-fast");
    expect((await getMaterialStudioState(freshGood.paths.root)).counts.media).toBe(0);

    const selectedOnly = await runLocalCreativeContentCatalogImport({
      catalogPath,
      materializationReportPath: materializationPath,
      outputPath: path.join(temporaryRoot, "selected.json"),
      registryPath,
      projectKeys: ["good-story"],
      onProgress: () => undefined,
    });
    expect(selectedOnly.summary).toMatchObject({ selected: 1, completed: 1, failed: 0 });
    expect(selectedOnly.projects.map((project) => project.key)).toEqual(["good-story"]);
  });
});
