import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { getActiveManagedStudioContext } from "../src/core/active-managed-studio-context.js";
import { createBuildIdentity } from "../src/core/build-identity.js";
import {
  appendStudioAssetVersion,
  createStudioCanonicalAsset,
  importStudioMedia,
  reviewStudioAssetVersion,
  setStudioPrimaryAuthority,
} from "../src/core/material-studio.js";
import { createManagedProject } from "../src/core/managed-project.js";
import {
  appendStudioPromptRevision,
  appendStudioScriptRevision,
  createStudioProductionUnit,
  createStudioPromptDocument,
  createStudioScriptDocument,
} from "../src/core/studio-production.js";
import { registerProject, setActiveProjectRegistration, setActiveStudioContext } from "../src/core/sidecar.js";

const roots: string[] = [];
const originalRegistry = process.env.AI_CANVAS_REGISTRY_PATH;
const originalWorkspace = process.env.AI_CANVAS_WORKSPACE;
const originalRecordedDigest = process.env.AI_CANVAS_RECORDED_SOURCE_DIGEST;

afterEach(async () => {
  if (originalRegistry === undefined) delete process.env.AI_CANVAS_REGISTRY_PATH;
  else process.env.AI_CANVAS_REGISTRY_PATH = originalRegistry;
  if (originalWorkspace === undefined) delete process.env.AI_CANVAS_WORKSPACE;
  else process.env.AI_CANVAS_WORKSPACE = originalWorkspace;
  if (originalRecordedDigest === undefined) delete process.env.AI_CANVAS_RECORDED_SOURCE_DIGEST;
  else process.env.AI_CANVAS_RECORDED_SOURCE_DIGEST = originalRecordedDigest;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface FilesystemEntry {
  kind: "directory" | "file";
  size: number;
  mtimeMs: number;
  sha256?: string;
}

async function filesystemSnapshot(root: string): Promise<Record<string, FilesystemEntry>> {
  const result: Record<string, FilesystemEntry> = {};
  async function visit(absolute: string, relative: string): Promise<void> {
    const metadata = await lstat(absolute);
    if (metadata.isSymbolicLink()) throw new Error(`测试目录不允许符号链接：${absolute}`);
    if (metadata.isDirectory()) {
      result[relative || "."] = {
        kind: "directory",
        size: metadata.size,
        mtimeMs: metadata.mtimeMs,
      };
      const names = await readdir(absolute);
      for (const name of names.sort((left, right) => left.localeCompare(right, "en"))) {
        await visit(path.join(absolute, name), relative ? `${relative}/${name}` : name);
      }
      return;
    }
    if (!metadata.isFile()) throw new Error(`测试目录出现非普通文件：${absolute}`);
    const bytes = await readFile(absolute);
    result[relative] = {
      kind: "file",
      size: metadata.size,
      mtimeMs: metadata.mtimeMs,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  }
  await visit(root, "");
  return result;
}

async function createProductionFacts(projectRoot: string): Promise<void> {
  const sourcePath = path.join(projectRoot, "locked-character-source.png");
  await sharp({
    create: { width: 32, height: 32, channels: 3, background: "#34495e" },
  }).png().toFile(sourcePath);
  const media = await importStudioMedia(projectRoot, { sourcePath });
  const asset = await createStudioCanonicalAsset(projectRoot, {
    id: "character-readonly-lock",
    category: "character",
    name: "只读角色锁",
    expectedRevision: 0,
  });
  const appended = await appendStudioAssetVersion(projectRoot, {
    assetId: asset.id,
    mediaSha256: media.sha256,
    reviewStatus: "pending",
    expectedRevision: asset.revision,
  });
  const reviewed = await reviewStudioAssetVersion(projectRoot, {
    assetId: asset.id,
    versionId: appended.version.id,
    decision: "approved",
    expectedRevision: appended.assetRevision,
    note: "物理零写投影测试批准。",
  });
  await setStudioPrimaryAuthority(projectRoot, {
    assetId: asset.id,
    versionId: appended.version.id,
    expectedRevision: reviewed.revision,
    note: "锁定只读投影测试母版。",
  });

  const script = await createStudioScriptDocument(projectRoot, {
    id: "script-readonly",
    title: "只读投影剧本",
    expectedRevision: 0,
  });
  const scriptRevision = await appendStudioScriptRevision(projectRoot, {
    documentId: script.id,
    expectedRevision: 0,
    body: "角色走入石室。",
    source: "tests/readonly-script.md",
    sourceVersion: "v1",
  });
  const prompt = await createStudioPromptDocument(projectRoot, {
    id: "prompt-readonly",
    title: "只读投影提示词",
    expectedRevision: 0,
  });
  const promptRevision = await appendStudioPromptRevision(projectRoot, {
    documentId: prompt.id,
    expectedRevision: 0,
    body: "保持角色身份锁。",
    source: "tests/readonly-prompt.md",
    sourceVersion: "v1",
  });
  await createStudioProductionUnit(projectRoot, {
    id: "unit-readonly",
    season: "S01",
    episode: "E01",
    sequence: 1,
    title: "只读投影单元",
    scriptRevisionId: scriptRevision.revision.id,
    panels: [
      { id: "panel-readonly-1", startSeconds: 0, endSeconds: 7, durationSeconds: 7 },
      { id: "panel-readonly-2", startSeconds: 7, endSeconds: 15, durationSeconds: 8 },
    ].map((timing, index) => ({
      ...timing,
      title: `镜头 ${index + 1}`,
      visualAction: index === 0 ? "角色入画。" : "角色停步。",
      shotComposition: "中景。",
      filmingMethod: "固定机位。",
      promptRevisionId: promptRevision.revision.id,
      sourceSpans: [{ startOffsetUtf16: 0, endOffsetUtf16: 2 }],
      assets: [],
    })),
    expectedRevision: 0,
  });
}

function checkpointDatabase(databasePath: string): void {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    database.close();
  }
}

describe("活动 Studio 上下文物理零写投影", () => {
  it("返回真实计数与锁图样本，同时不改变工程/注册表文件树、mtime、hash 或创建 lock/WAL", async () => {
    const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "ai-canvas-active-readonly-")));
    roots.push(parent);
    const registryRoot = path.join(parent, "registry");
    process.env.AI_CANVAS_REGISTRY_PATH = path.join(registryRoot, "projects.json");
    process.env.AI_CANVAS_WORKSPACE = process.cwd();
    delete process.env.AI_CANVAS_RECORDED_SOURCE_DIGEST;
    const created = await createManagedProject({
      parentRoot: parent,
      name: "活动上下文物理零写",
      slug: "readonly-context",
    });
    await createProductionFacts(created.paths.root);
    await registerProject(created.project);
    await setActiveProjectRegistration(created.paths.root);
    await rm(path.join(created.paths.root, ".aicanvas", "locks"), { recursive: true, force: true });
    await rm(path.join(registryRoot, "locks"), { recursive: true, force: true });
    checkpointDatabase(created.paths.materialDatabase);
    checkpointDatabase(created.paths.productionDatabase);
    await rm(`${created.paths.materialDatabase}-wal`, { force: true });
    await rm(`${created.paths.materialDatabase}-shm`, { force: true });
    await rm(`${created.paths.productionDatabase}-wal`, { force: true });
    await rm(`${created.paths.productionDatabase}-shm`, { force: true });
    const runtimeBuildIdentity = await createBuildIdentity(process.cwd());
    const before = await filesystemSnapshot(parent);

    const context = await getActiveManagedStudioContext({ runtimeBuildIdentity });

    const after = await filesystemSnapshot(parent);
    expect(after).toEqual(before);
    expect(context.counts).toMatchObject({
      units: 1,
      panels: 2,
      canonicalAssets: 1,
      characters: 1,
      media: 1,
      bindingSets: 0,
    });
    expect(context.lockedAssetSample).toEqual([expect.objectContaining({
      assetId: "character-readonly-lock",
      category: "character",
      currentness: "current",
    })]);
    // P2b 二级 nextAction：无聚焦单元时给真实二级指引（先选单元→聚合投影取权威值），
    // 不再返回占位话术；入口仍物理零写（本测试的文件树/零写断言即证明）。
    expect(context.nextAction).toMatchObject({
      code: "list-binding-units",
      requiresWrite: false,
      command: "get_studio_binding_control",
    });
    expect(context.queueTotals).toEqual({
      ambiguity: "bounded-partial",
      missing: "bounded-partial",
      stale: "bounded-partial",
      conflict: "bounded-partial",
      rework: "bounded-partial",
    });
  }, 120_000);

  it("记录了聚焦单元时，nextAction 给出指向聚合投影的真实二级指引", async () => {
    const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "ai-canvas-active-focus-")));
    roots.push(parent);
    const registryRoot = path.join(parent, "registry");
    process.env.AI_CANVAS_REGISTRY_PATH = path.join(registryRoot, "projects.json");
    process.env.AI_CANVAS_WORKSPACE = process.cwd();
    delete process.env.AI_CANVAS_RECORDED_SOURCE_DIGEST;
    const created = await createManagedProject({
      parentRoot: parent,
      name: "活动上下文聚焦指引",
      slug: "focus-next-action",
    });
    await createProductionFacts(created.paths.root);
    await registerProject(created.project);
    await setActiveProjectRegistration(created.paths.root);
    // fixture 准备阶段写入聚焦状态；零写窗口断言由上一个用例覆盖，本用例
    // 只锁 nextAction 的二级语义分层。
    await setActiveStudioContext(created.paths.root, {
      mode: "canvas",
      focus: { unitId: "unit-focus-0001", panelId: "P01" },
    });

    const context = await getActiveManagedStudioContext();
    expect(context.nextAction).toMatchObject({
      code: "read-projection-bundle",
      requiresWrite: false,
      command: "get_studio_production_projection_bundle",
      locator: {
        kind: "panel",
        unitId: "unit-focus-0001",
        panelId: "P01",
      },
    });
  }, 120_000);
});
