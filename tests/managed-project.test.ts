import { createHash } from "node:crypto";
import { access, chmod, link, lstat, mkdir, mkdtemp, readFile, realpath, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __setAttachNovelManifestTestHooksForTests,
  attachNovelManifest,
  createManagedProject,
  inspectManagedProject,
  inspectManagedProjectReadOnly,
  isManagedProject,
  managedProjectSlug,
  readManagedProjectBootstrapClaim,
  resumeManagedProjectBootstrap,
  resumeManagedProjectBootstrapFromQuarantine,
  upgradeEmptyProjectToManaged,
} from "../src/core/managed-project.js";
import { listProjectLocks, withProjectLock } from "../src/core/locks.js";

const roots: string[] = [];
let resetAttachNovelManifestHooks: () => void = () => undefined;

afterEach(async () => {
  resetAttachNovelManifestHooks();
  resetAttachNovelManifestHooks = () => undefined;
  delete process.env.AI_CANVAS_TEST_MANAGED_BOOTSTRAP_INTERRUPT;
  vi.doUnmock("node:crypto");
  vi.doUnmock("../src/core/sidecar.js");
  vi.doUnmock("../src/core/scanner.js");
  vi.resetModules();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryParent(): Promise<string> {
  const created = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-managed-parent-"));
  const root = await realpath(created);
  roots.push(root);
  return root;
}

async function optionalFile(filePath: string): Promise<Buffer | null> {
  return readFile(filePath).catch(() => null);
}

function stableManifestValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableManifestValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, stableManifestValue(entry)]));
}

async function rewriteManagedManifest(
  manifestPath: string,
  mutate: (manifest: Record<string, unknown>) => void,
): Promise<void> {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  mutate(manifest);
  delete manifest.fingerprint;
  manifest.fingerprint = createHash("sha256")
    .update(JSON.stringify(stableManifestValue(manifest)))
    .digest("hex");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

async function writeNovelWorkspaceManifest(
  projectRoot: string,
  projectId: string,
  mutate?: (manifest: Record<string, unknown>) => void,
): Promise<{ path: string; bytes: Buffer }> {
  const manifestPath = path.join(projectRoot, ".aicanvas", "novel", "manifest.json");
  const semantic: Record<string, unknown> = {
    schemaVersion: 1,
    kind: "novel-workspace-manifest",
    projectId,
    sourceMode: "managed_markdown",
    chapterManifest: "manuscript/chapters.json",
    sourceReceiptIds: [],
    revision: 1,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
  mutate?.(semantic);
  const manifest = {
    ...semantic,
    fingerprint: createHash("sha256")
      .update(JSON.stringify(stableManifestValue(semantic)))
      .digest("hex"),
  };
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await mkdir(path.dirname(manifestPath), { recursive: true, mode: 0o700 });
  await writeFile(manifestPath, bytes);
  return { path: manifestPath, bytes };
}

async function removeGenerationLedger(projectRoot: string): Promise<void> {
  await rm(path.join(projectRoot, ".aicanvas", "studio-generation-ledger.sqlite"), { force: true });
  await rm(path.join(projectRoot, ".aicanvas", "studio-generation"), { recursive: true, force: true });
}

async function snapshotTree(root: string): Promise<string[]> {
  const snapshot: string[] = [];
  async function visit(directory: string, relativeDirectory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        snapshot.push(`directory:${relativePath}`);
        await visit(absolutePath, relativePath);
      } else if (entry.isFile()) {
        snapshot.push(`file:${relativePath}:${createHash("sha256").update(await readFile(absolutePath)).digest("hex")}`);
      } else {
        snapshot.push(`other:${relativePath}`);
      }
    }
  }
  await visit(root, "");
  return snapshot;
}

describe("受管隔离工程 bootstrap", () => {
  it("在真实父目录下建立空索引、本地 CAS 和内容寻址 manifest，不登记全局项目", async () => {
    const parent = await temporaryParent();
    const registryPath = path.resolve(process.env.AI_CANVAS_REGISTRY_PATH ?? path.join(parent, "unused-registry.json"));
    const activeProjectPath = path.join(path.dirname(registryPath), "active-project.json");
    const registryBefore = await optionalFile(registryPath);
    const activeProjectBefore = await optionalFile(activeProjectPath);

    const shell = await createManagedProject({ parentRoot: parent, name: "Codex AI 短剧素材库" });

    expect(path.dirname(shell.paths.root)).toBe(parent);
    expect(path.basename(shell.paths.root)).toMatch(/^codex-ai-短剧素材库-[a-f0-9]{8}$/u);
    expect(shell.project).toMatchObject({
      name: "Codex AI 短剧素材库",
      primaryRoot: shell.paths.root,
      sourceRoots: [],
      outputRoots: [shell.paths.root],
    });
    expect(shell.counts).toEqual({ total: 0, items: 0, artifacts: 0, images: 0, videos: 0, audio: 0 });
    expect(shell.nextAction).toContain("角色、场景、道具");
    expect(shell.manifest).toMatchObject({
      storageMode: "managed",
      startupPolicy: "no-filesystem-scan",
      mediaMode: "project-local-cas",
      legacyRoots: [],
    });
    expect(shell.manifestFingerprint).toMatch(/^[a-f0-9]{64}$/);
    await Promise.all([
      access(shell.paths.config),
      access(shell.paths.index),
      access(shell.paths.cache),
      access(shell.paths.manifest),
      access(shell.paths.materialDatabase),
      access(shell.paths.productionDatabase),
      access(shell.paths.textCas),
      access(shell.paths.generationDatabase),
      access(shell.paths.generationPackCas),
      access(shell.paths.progressMarkdown),
      access(shell.paths.mediaCas),
      access(shell.paths.mediaPreviews),
      access(shell.paths.mediaProxies),
      access(shell.paths.mediaWaveforms),
    ]);
    await expect(access(path.join(shell.paths.sidecar, ".managed-bootstrap-registry"))).rejects.toThrow();
    expect(await optionalFile(registryPath)).toEqual(registryBefore);
    expect(await optionalFile(activeProjectPath)).toEqual(activeProjectBefore);

    const index = JSON.parse(await readFile(shell.paths.index, "utf8")) as { items: unknown[]; artifacts: unknown[]; scanStats: Record<string, number> };
    expect(index.items).toEqual([]);
    expect(index.artifacts).toEqual([]);
    expect(index.scanStats).toMatchObject({ discoveredFiles: 0, candidateFiles: 0, textFilesRead: 0 });
  });

  it("可把既有空隔离工程原地升级，拒绝接管已有内容", async () => {
    const parent = await temporaryParent();
    const empty = await createManagedProject({ parentRoot: parent, name: "待升级空工程" });
    await rm(empty.paths.manifest);
    await rm(empty.paths.materialDatabase);
    await rm(empty.paths.generationDatabase);
    await rm(path.join(empty.paths.sidecar, "studio-generation"), { recursive: true, force: true });
    await rm(path.join(empty.paths.sidecar, "objects"), { recursive: true, force: true });
    await rm(path.join(empty.paths.sidecar, "derived"), { recursive: true, force: true });

    const upgraded = await upgradeEmptyProjectToManaged(empty.paths.root);
    expect(upgraded.project.id).toBe(empty.project.id);
    expect(await isManagedProject(empty.paths.root)).toBe(true);
    await Promise.all([access(upgraded.paths.generationDatabase), access(upgraded.paths.generationPackCas)]);
    await expect(upgradeEmptyProjectToManaged(empty.paths.root)).resolves.toMatchObject({ project: { id: empty.project.id } });

    const nonEmpty = await createManagedProject({ parentRoot: parent, name: "已有内容工程" });
    await rm(nonEmpty.paths.manifest);
    const indexPath = nonEmpty.paths.index;
    const index = JSON.parse(await readFile(indexPath, "utf8")) as { summary: { total: number }; items: unknown[] };
    index.summary.total = 1;
    index.items = [{ id: "user-data" }];
    await writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
    await expect(upgradeEmptyProjectToManaged(nonEmpty.paths.root)).rejects.toThrow("空工程");
    await expect(access(nonEmpty.paths.manifest)).rejects.toThrow();
  });

  it("同名创建使用安全确定性 slug 与短随机 ID，互不接管", async () => {
    const parent = await temporaryParent();
    expect(managedProjectSlug("  ../我的剧集 · 2026  ")).toBe("我的剧集-2026");

    const first = await createManagedProject({ parentRoot: parent, name: "金沙剧集", slug: "  ../我的剧集  " });
    const second = await createManagedProject({ parentRoot: parent, name: "金沙剧集", slug: "  ../我的剧集  " });

    expect(first.paths.root).not.toBe(second.paths.root);
    expect(path.basename(first.paths.root)).toMatch(/^我的剧集-[a-f0-9]{8}$/u);
    expect(path.basename(second.paths.root)).toMatch(/^我的剧集-[a-f0-9]{8}$/u);
    await expect(inspectManagedProject(first.paths.root)).resolves.toMatchObject({ project: { id: first.project.id } });
    await expect(inspectManagedProject(second.paths.root)).resolves.toMatchObject({ project: { id: second.project.id } });
  });

  it("随机 ID 碰到已有非空目录时失败关闭，绝不覆盖或删除", async () => {
    const parent = await temporaryParent();
    const occupied = path.join(parent, "已有项目-deadbeef");
    await mkdir(occupied);
    await writeFile(path.join(occupied, "用户文件.txt"), "必须保留", "utf8");

    const actualCrypto = await vi.importActual<typeof import("node:crypto")>("node:crypto");
    vi.resetModules();
    vi.doMock("node:crypto", () => ({ ...actualCrypto, randomBytes: () => Buffer.from("deadbeef", "hex") }));
    const isolated = await import("../src/core/managed-project.js");

    await expect(isolated.createManagedProject({ parentRoot: parent, name: "碰撞测试", slug: "已有项目" }))
      .rejects.toThrow("避免接管既有目录");
    expect(await readFile(path.join(occupied, "用户文件.txt"), "utf8")).toBe("必须保留");
    expect(await readdir(parent)).toEqual(["已有项目-deadbeef"]);
  });

  it("拒绝符号链接父目录与被替换为符号链接的项目根", async () => {
    const outer = await temporaryParent();
    const actualParent = path.join(outer, "actual");
    const linkedParent = path.join(outer, "linked");
    await mkdir(actualParent);
    await symlink(actualParent, linkedParent, "dir");

    await expect(createManagedProject({ parentRoot: linkedParent, name: "不允许" })).rejects.toThrow("符号链接");
    const created = await createManagedProject({ parentRoot: actualParent, name: "安全项目" });
    const moved = `${created.paths.root}-moved`;
    await rename(created.paths.root, moved);
    await symlink(moved, created.paths.root, "dir");
    await expect(inspectManagedProject(created.paths.root)).rejects.toThrow("符号链接");
  });

  it("打开时拒绝 generation 账本目录符号链接，不向项目外初始化", async () => {
    const parent = await temporaryParent();
    const created = await createManagedProject({ parentRoot: parent, name: "账本路径隔离" });
    const outside = path.join(parent, "outside-generation-ledger");
    await mkdir(outside);
    await rm(created.paths.generationDatabase, { force: true });
    await rm(path.join(created.paths.sidecar, "studio-generation"), { recursive: true, force: true });
    await symlink(outside, path.join(created.paths.sidecar, "studio-generation"), "dir");

    await expect(inspectManagedProject(created.paths.root)).rejects.toThrow("Studio generation 账本目录类型无效或是符号链接");
    expect(await readdir(outside)).toEqual([]);
  });

  it("事务中途失败只回滚本次新建根，不伤及既有兄弟目录", async () => {
    const parent = await temporaryParent();
    const existing = path.join(parent, "既有工程");
    await mkdir(existing);
    await writeFile(path.join(existing, "sentinel.txt"), "keep", "utf8");

    vi.resetModules();
    vi.doMock("../src/core/sidecar.js", async () => {
      const actual = await vi.importActual<typeof import("../src/core/sidecar.js")>("../src/core/sidecar.js");
      return { ...actual, saveIndex: async () => { throw new Error("注入的 saveIndex 失败"); } };
    });
    const isolated = await import("../src/core/managed-project.js");

    await expect(isolated.createManagedProject({ parentRoot: parent, name: "应回滚" })).rejects.toThrow("注入的 saveIndex 失败");
    expect(await readFile(path.join(existing, "sentinel.txt"), "utf8")).toBe("keep");
    expect(await readdir(parent)).toEqual(["既有工程"]);
  });

  it("inspect 对配置外部根和 manifest fingerprint 漂移失败关闭", async () => {
    const parent = await temporaryParent();
    const configDrift = await createManagedProject({ parentRoot: parent, name: "配置漂移" });
    const config = JSON.parse(await readFile(configDrift.paths.config, "utf8")) as Record<string, unknown>;
    config.sourceRoots = [path.join(parent, "legacy")];
    await writeFile(configDrift.paths.config, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    await expect(inspectManagedProject(configDrift.paths.root)).rejects.toThrow("SHA-256 不匹配");

    const manifestDrift = await createManagedProject({ parentRoot: parent, name: "manifest 漂移" });
    const manifest = JSON.parse(await readFile(manifestDrift.paths.manifest, "utf8")) as Record<string, unknown>;
    manifest.projectName = "被篡改";
    await writeFile(manifestDrift.paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await expect(inspectManagedProject(manifestDrift.paths.root)).rejects.toThrow("fingerprint 不匹配");

    const indexDrift = await createManagedProject({ parentRoot: parent, name: "索引漂移" });
    const index = JSON.parse(await readFile(indexDrift.paths.index, "utf8")) as { summary: { total: number } };
    index.summary.total = 1;
    await writeFile(indexDrift.paths.index, `${JSON.stringify(index, null, 2)}\n`, "utf8");
    await expect(inspectManagedProject(indexDrift.paths.root)).rejects.toThrow("bootstrap 索引 SHA-256 不匹配");
  });

  it("多次重启检查只读固定侧车，不调用 scanProject 或扫描旧根", async () => {
    const parent = await temporaryParent();
    const created = await createManagedProject({ parentRoot: parent, name: "O1 重启" });
    await rm(created.paths.generationDatabase, { force: true });
    await rm(path.join(created.paths.sidecar, "studio-generation"), { recursive: true, force: true });
    const scanProject = vi.fn(() => { throw new Error("不应调用扫描器"); });

    vi.resetModules();
    vi.doMock("../src/core/scanner.js", () => ({ scanProject }));
    const isolated = await import("../src/core/managed-project.js");
    const [first, second] = await Promise.all([
      isolated.inspectManagedProject(created.paths.root),
      isolated.inspectManagedProject(created.paths.root),
    ]);

    expect(first.counts.total).toBe(0);
    expect(second.manifestFingerprint).toBe(first.manifestFingerprint);
    expect(scanProject).not.toHaveBeenCalled();
    expect(first.project.sourceRoots).toEqual([]);
    expect(first.project.outputRoots).toEqual([created.paths.root]);
    await Promise.all([access(first.paths.generationDatabase), access(first.paths.generationPackCas)]);
  });

  it("即使绕过 UI 直接调用 Core，也拒绝对受管项目执行旧扫描", async () => {
    const parent = await temporaryParent();
    const created = await createManagedProject({ parentRoot: parent, name: "Core 扫描门禁" });
    const { previewProjectScan, scanAndPersist } = await import("../src/core/service.js");

    await expect(scanAndPersist(created.paths.root)).rejects.toThrow("禁止启动旧文件系统扫描");
    await expect(previewProjectScan(created.paths.root)).rejects.toThrow("禁止预览旧文件系统扫描");
    await expect(inspectManagedProject(created.paths.root)).resolves.toMatchObject({
      manifest: { startupPolicy: "no-filesystem-scan" },
      counts: { total: 0 },
    });
  });
});

describe("受管工程 workspace schema", () => {
  it("旧版和新建 drama 都保持 schema v1 字节合同，只在内存投影 workspaceMode", async () => {
    const parent = await temporaryParent();
    const implicit = await createManagedProject({ parentRoot: parent, name: "旧版兼容 drama" });
    const originalBytes = await readFile(implicit.paths.manifest);
    const persisted = JSON.parse(originalBytes.toString("utf8")) as Record<string, unknown>;
    const dramaConfigBytes = await readFile(implicit.paths.config);
    const dramaConfig = JSON.parse(dramaConfigBytes.toString("utf8")) as Record<string, unknown>;
    const dramaIndex = JSON.parse(await readFile(implicit.paths.index, "utf8")) as { project: Record<string, unknown> };

    expect(persisted.schemaVersion).toBe(1);
    expect(persisted).not.toHaveProperty("workspaceMode");
    expect(persisted).not.toHaveProperty("minimumWriterSchemaVersion");
    expect(persisted).not.toHaveProperty("novelManifest");
    expect(dramaConfig.schemaVersion).toBe(1);
    expect(dramaConfig).not.toHaveProperty("workspaceMode");
    expect(dramaConfig).not.toHaveProperty("minimumWriterSchemaVersion");
    expect(dramaIndex.project).toEqual(dramaConfig);
    expect(implicit.workspaceMode).toBe("drama");
    expect(implicit.manifest).toMatchObject({ schemaVersion: 1, workspaceMode: "drama" });

    const projected = await inspectManagedProjectReadOnly(implicit.paths.root);
    expect(projected.workspaceMode).toBe("drama");
    expect(await readFile(implicit.paths.manifest)).toEqual(originalBytes);

    const upgraded = await upgradeEmptyProjectToManaged(implicit.paths.root);
    expect(upgraded.workspaceMode).toBe("drama");
    expect(await readFile(implicit.paths.manifest)).toEqual(originalBytes);
    expect(await readFile(implicit.paths.config)).toEqual(dramaConfigBytes);

    const explicit = await createManagedProject({
      parentRoot: parent,
      name: "显式新建 drama",
      workspaceMode: "drama",
    });
    const explicitPersisted = JSON.parse(await readFile(explicit.paths.manifest, "utf8")) as Record<string, unknown>;
    expect(explicitPersisted.schemaVersion).toBe(1);
    expect(explicitPersisted).not.toHaveProperty("workspaceMode");
    expect(explicitPersisted).not.toHaveProperty("minimumWriterSchemaVersion");
    expect(explicit.workspaceMode).toBe("drama");
  });

  it.each(["novel", "hybrid"] as const)("新建 %s 只写 schema v2 和最低 writer 声明", async (workspaceMode) => {
    const parent = await temporaryParent();
    const shell = await createManagedProject({ parentRoot: parent, name: `${workspaceMode} 工程`, workspaceMode });
    const persisted = JSON.parse(await readFile(shell.paths.manifest, "utf8")) as Record<string, unknown>;
    const projectConfig = JSON.parse(await readFile(shell.paths.config, "utf8")) as Record<string, unknown>;
    const projectIndex = JSON.parse(await readFile(shell.paths.index, "utf8")) as { project: Record<string, unknown> };

    expect(persisted).toMatchObject({
      schemaVersion: 2,
      workspaceMode,
      minimumWriterSchemaVersion: 2,
    });
    expect(persisted).not.toHaveProperty("novelManifest");
    expect(projectConfig).toMatchObject({
      schemaVersion: 2,
      workspaceMode,
      minimumWriterSchemaVersion: 2,
    });
    expect(projectIndex.project).toEqual(projectConfig);
    expect(path.basename(shell.paths.cache)).toBe("cache-v2.sqlite");
    await access(shell.paths.cache);
    const legacyCache = path.join(shell.paths.sidecar, "cache.sqlite");
    const legacyCacheMetadata = await lstat(legacyCache);
    expect(legacyCacheMetadata.isFile()).toBe(true);
    expect(legacyCacheMetadata.mode & 0o222).toBe(0);
    expect(shell.workspaceMode).toBe(workspaceMode);
    expect(shell.manifest).toMatchObject({
      schemaVersion: 2,
      workspaceMode,
      minimumWriterSchemaVersion: 2,
    });
    await expect(inspectManagedProjectReadOnly(shell.paths.root)).resolves.toMatchObject({ workspaceMode });

    const fencePath = path.join(shell.paths.sidecar, "locks");
    const fenceBytes = await readFile(fencePath);
    const fence = JSON.parse(fenceBytes.toString("utf8")) as Record<string, unknown>;
    expect((await lstat(fencePath)).isFile()).toBe(true);
    expect(fence).toMatchObject({
      schemaVersion: 1,
      kind: "ai-canvas-managed-writer-fence",
      projectId: shell.project.id,
      rootRealpath: shell.paths.root,
      minimumWriterSchemaVersion: 2,
      lockDirectory: ".aicanvas/locks-v2",
    });
    expect(fence.fingerprint).toMatch(/^[a-f0-9]{64}$/u);

    await withProjectLock(shell.paths.root, "v2-writer", async () => {
      expect(await listProjectLocks(shell.paths.root)).toEqual([
        expect.objectContaining({ name: "v2-writer", stale: false }),
      ]);
      expect((await lstat(path.join(shell.paths.sidecar, "locks-v2"))).isDirectory()).toBe(true);
    });
    expect(await readFile(fencePath)).toEqual(fenceBytes);
    expect(await readdir(path.join(shell.paths.sidecar, "locks-v2"))).toEqual([]);
  });

  it("current writer 拒绝通过旧设置页降级或改写 v2 配置且项目树零写", async () => {
    const parent = await temporaryParent();
    const shell = await createManagedProject({ parentRoot: parent, name: "v2 设置页门禁", workspaceMode: "novel" });
    const { saveProjectConfig } = await import("../src/core/service.js");
    const before = await snapshotTree(shell.paths.root);

    const downgraded = { ...shell.project, schemaVersion: 1 as const };
    delete downgraded.workspaceMode;
    delete downgraded.minimumWriterSchemaVersion;
    await expect(saveProjectConfig(downgraded)).rejects.toThrow(/writer schema/u);
    expect(await snapshotTree(shell.paths.root)).toEqual(before);

    await expect(saveProjectConfig({ ...shell.project, workspaceMode: "hybrid" })).rejects.toThrow(/writer schema/u);
    expect(await snapshotTree(shell.paths.root)).toEqual(before);

    await expect(saveProjectConfig(shell.project)).rejects.toThrow(/只读工作区壳/u);
    expect(await snapshotTree(shell.paths.root)).toEqual(before);
  });

  it.each(["missing", "writable", "tampered"] as const)("v2 legacy cache fence %s 时 current 布局写入失败关闭", async (failureMode) => {
    const parent = await temporaryParent();
    const shell = await createManagedProject({ parentRoot: parent, name: `cache fence ${failureMode}`, workspaceMode: "hybrid" });
    const legacyCache = path.join(shell.paths.sidecar, "cache.sqlite");
    if (failureMode === "missing") await rm(legacyCache);
    if (failureMode === "writable") await chmod(legacyCache, 0o600);
    if (failureMode === "tampered") {
      await chmod(legacyCache, 0o600);
      await writeFile(legacyCache, "{}\n", "utf8");
      await chmod(legacyCache, 0o400);
    }
    const before = await snapshotTree(shell.paths.root);
    const { saveCanvasPositions } = await import("../src/core/service.js");

    expect(() => saveCanvasPositions(shell.paths.root, "must-not-write", { node: { x: 1, y: 2 } })).toThrow();
    expect(await snapshotTree(shell.paths.root)).toEqual(before);
  });

  it("v2 writer fence 损坏时当前写锁失败关闭且不创建替代锁目录", async () => {
    const parent = await temporaryParent();
    const shell = await createManagedProject({ parentRoot: parent, name: "fence 损坏", workspaceMode: "novel" });
    const fencePath = path.join(shell.paths.sidecar, "locks");
    const fence = JSON.parse(await readFile(fencePath, "utf8")) as Record<string, unknown>;
    fence.projectId = "forged-project-id";
    await writeFile(fencePath, `${JSON.stringify(fence, null, 2)}\n`, "utf8");
    const before = await snapshotTree(shell.paths.sidecar);

    await expect(inspectManagedProjectReadOnly(shell.paths.root)).rejects.toThrow(/writer fence/u);
    await expect(withProjectLock(shell.paths.root, "must-not-enter", async () => {
      throw new Error("不得进入临界区");
    })).rejects.toThrow(/writer fence/u);
    await expect(access(path.join(shell.paths.sidecar, "locks-v2"))).rejects.toThrow();
    expect(await snapshotTree(shell.paths.sidecar)).toEqual(before);
  });

  it.each(["missing", "directory"] as const)("v2 writer fence %s 时不静默退回旧锁协议", async (failureMode) => {
    const parent = await temporaryParent();
    const shell = await createManagedProject({ parentRoot: parent, name: `fence ${failureMode}`, workspaceMode: "hybrid" });
    const fencePath = path.join(shell.paths.sidecar, "locks");
    await rm(fencePath);
    if (failureMode === "directory") await mkdir(fencePath);
    const before = await snapshotTree(shell.paths.sidecar);
    let entered = false;

    await expect(withProjectLock(shell.paths.root, "must-not-fallback", async () => {
      entered = true;
    })).rejects.toThrow(/writer fence|旧锁协议/u);
    expect(entered).toBe(false);
    await expect(access(path.join(shell.paths.sidecar, "locks-v2"))).rejects.toThrow();
    expect(await snapshotTree(shell.paths.sidecar)).toEqual(before);
  });

  it("拒绝 schema v1 夹带任何 v2 字段，且不会补写 generation ledger", async () => {
    const parent = await temporaryParent();
    const shell = await createManagedProject({ parentRoot: parent, name: "v1 字段走私" });
    const baseline = JSON.parse(await readFile(shell.paths.manifest, "utf8")) as Record<string, unknown>;
    await removeGenerationLedger(shell.paths.root);
    const fields: Array<[string, unknown]> = [
      ["workspaceMode", "drama"],
      ["minimumWriterSchemaVersion", 2],
      ["novelManifest", ".aicanvas/novel/manifest.json"],
    ];

    for (const [field, value] of fields) {
      await writeFile(shell.paths.manifest, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
      await rewriteManagedManifest(shell.paths.manifest, (manifest) => { manifest[field] = value; });
      const before = await snapshotTree(shell.paths.sidecar);
      await expect(inspectManagedProject(shell.paths.root), field).rejects
        .toThrow("schema v1 manifest 不得夹带 v2 工作区字段");
      await expect(access(shell.paths.generationDatabase), field).rejects.toThrow();
      await expect(access(path.join(shell.paths.sidecar, "studio-generation")), field).rejects.toThrow();
      expect(await snapshotTree(shell.paths.sidecar), field).toEqual(before);
    }
  });

  it("未知 future schema 和非法 v2 声明都在 generation ledger 写入前失败关闭", async () => {
    const parent = await temporaryParent();
    const shell = await createManagedProject({ parentRoot: parent, name: "v2 失败关闭", workspaceMode: "novel" });
    const baseline = JSON.parse(await readFile(shell.paths.manifest, "utf8")) as Record<string, unknown>;
    await removeGenerationLedger(shell.paths.root);

    const cases: Array<{
      label: string;
      expected: string;
      mutate: (manifest: Record<string, unknown>) => void;
    }> = [
      {
        label: "future schema",
        expected: "高于当前 writer",
        mutate: (manifest) => {
          manifest.schemaVersion = 3;
          manifest.minimumWriterSchemaVersion = 3;
        },
      },
      {
        label: "future minimum writer",
        expected: "最低 writer v3 高于当前 writer",
        mutate: (manifest) => { manifest.minimumWriterSchemaVersion = 3; },
      },
      {
        label: "v2 drama",
        expected: "工作区声明无效",
        mutate: (manifest) => { manifest.workspaceMode = "drama"; },
      },
      {
        label: "v2 missing writer",
        expected: "工作区声明无效",
        mutate: (manifest) => { delete manifest.minimumWriterSchemaVersion; },
      },
      {
        label: "v2 locator escape",
        expected: "工作区声明无效",
        mutate: (manifest) => { manifest.novelManifest = "../novel/manifest.json"; },
      },
    ];

    for (const testCase of cases) {
      await writeFile(shell.paths.manifest, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
      await rewriteManagedManifest(shell.paths.manifest, testCase.mutate);
      const before = await snapshotTree(shell.paths.sidecar);
      await expect(inspectManagedProject(shell.paths.root), testCase.label).rejects.toThrow(testCase.expected);
      await expect(access(shell.paths.generationDatabase), testCase.label).rejects.toThrow();
      await expect(access(path.join(shell.paths.sidecar, "studio-generation")), testCase.label).rejects.toThrow();
      expect(await snapshotTree(shell.paths.sidecar), testCase.label).toEqual(before);
    }
  });

  it.each([
    ["drama", 1],
    ["novel", 2],
    ["hybrid", 2],
  ] as const)("bootstrap claim 签名显式绑定 %s 和最低 writer v%s", async (workspaceMode, minimumWriterSchemaVersion) => {
    const parent = await temporaryParent();
    const shell = await createManagedProject({
      parentRoot: parent,
      name: `${workspaceMode} claim 工程`,
      workspaceMode,
      bootstrapClaim: { purpose: "novel-import", payload: { receiptId: "fixture-1" } },
    });
    const claim = await readManagedProjectBootstrapClaim(shell.paths.root);

    expect(claim).toMatchObject({
      schemaVersion: 3,
      kind: "managed-project-bootstrap-claim",
      projectRoot: shell.paths.root,
      workspaceMode,
      minimumWriterSchemaVersion,
      purpose: "novel-import",
      payload: { receiptId: "fixture-1" },
    });
    expect(claim?.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(shell.workspaceMode).toBe(workspaceMode);
  });

  it("novel bootstrap 中断后从 quarantine 按原 mode 确定性恢复，mode 漂移零写失败", async () => {
    const parent = await temporaryParent();
    const projectRoot = path.join(parent, "resume-novel");
    const bootstrapClaim = { purpose: "novel-import", payload: { receiptId: "fixture-recovery" } };
    await mkdir(projectRoot, { mode: 0o700 });

    process.env.AI_CANVAS_TEST_MANAGED_BOOTSTRAP_INTERRUPT = "after-storage";
    await expect(resumeManagedProjectBootstrap(projectRoot, {
      name: "可恢复 novel",
      workspaceMode: "novel",
      bootstrapClaim,
    })).rejects.toThrow(/after-storage/u);
    delete process.env.AI_CANVAS_TEST_MANAGED_BOOTSTRAP_INTERRUPT;

    const partialBefore = await snapshotTree(projectRoot);
    await expect(resumeManagedProjectBootstrap(projectRoot, {
      name: "可恢复 novel",
      workspaceMode: "hybrid",
      bootstrapClaim,
    })).rejects.toThrow(/claim 与恢复请求不一致/u);
    expect(await snapshotTree(projectRoot)).toEqual(partialBefore);

    process.env.AI_CANVAS_TEST_MANAGED_BOOTSTRAP_INTERRUPT = "after-quarantine-rename";
    await expect(resumeManagedProjectBootstrap(projectRoot, {
      name: "可恢复 novel",
      workspaceMode: "novel",
      bootstrapClaim,
    })).rejects.toThrow(/after-quarantine-rename/u);
    delete process.env.AI_CANVAS_TEST_MANAGED_BOOTSTRAP_INTERRUPT;
    await expect(lstat(projectRoot)).rejects.toMatchObject({ code: "ENOENT" });

    const recovered = await resumeManagedProjectBootstrapFromQuarantine(parent, {
      name: "可恢复 novel",
      slug: "resume-novel",
      workspaceMode: "novel",
      bootstrapClaim,
    });
    expect(recovered).toMatchObject({ workspaceMode: "novel", manifest: { schemaVersion: 2 } });
    const recoveredClaim = await readManagedProjectBootstrapClaim(projectRoot);
    expect(recoveredClaim).toMatchObject({ workspaceMode: "novel", minimumWriterSchemaVersion: 2 });

    const quarantine = path.join(parent, ".aicanvas-managed-bootstrap-quarantine");
    const owner = (await readdir(quarantine)).find((name) => /^owner-[a-f0-9]{64}$/u.test(name));
    expect(owner).toBeTruthy();
    const recordName = (await readdir(path.join(quarantine, owner!)))
      .find((name) => /^recovery-[a-f0-9]{64}\.json$/u.test(name));
    const record = JSON.parse(await readFile(path.join(quarantine, owner!, recordName!), "utf8")) as Record<string, unknown>;
    expect(record).toMatchObject({
      schemaVersion: 2,
      kind: "managed-project-bootstrap-recovery",
      workspaceMode: "novel",
      minimumWriterSchemaVersion: 2,
    });
  });

  it.each(["novel", "hybrid"] as const)("attachNovelManifest 用 CAS 为 %s 安全重签名固定 locator", async (workspaceMode) => {
    const parent = await temporaryParent();
    const shell = await createManagedProject({
      parentRoot: parent,
      name: `${workspaceMode} manifest attach`,
      workspaceMode,
    });
    const managedBefore = await readFile(shell.paths.manifest);
    const novelManifest = await writeNovelWorkspaceManifest(shell.paths.root, shell.project.id);

    const attached = await attachNovelManifest(shell.paths.root, {
      expectedManagedFingerprint: shell.manifestFingerprint,
    });
    expect(attached.manifest).toMatchObject({
      schemaVersion: 2,
      workspaceMode,
      novelManifest: ".aicanvas/novel/manifest.json",
    });
    expect(attached.manifestFingerprint).not.toBe(shell.manifestFingerprint);
    expect(await readFile(novelManifest.path)).toEqual(novelManifest.bytes);
    expect(await readFile(shell.paths.manifest)).not.toEqual(managedBefore);

    const attachedBytes = await readFile(shell.paths.manifest);
    await expect(attachNovelManifest(shell.paths.root, {
      expectedManagedFingerprint: shell.manifestFingerprint,
    })).rejects.toThrow(/fingerprint CAS 失败/u);
    expect(await readFile(shell.paths.manifest)).toEqual(attachedBytes);

    await expect(attachNovelManifest(shell.paths.root, {
      expectedManagedFingerprint: attached.manifestFingerprint,
    })).resolves.toMatchObject({ manifestFingerprint: attached.manifestFingerprint });
    expect(await readFile(shell.paths.manifest)).toEqual(attachedBytes);
  });

  it("attachNovelManifest 在 replace 前目标文件 inode 被替换时失败且不写替换 inode", async () => {
    const parent = await temporaryParent();
    const shell = await createManagedProject({
      parentRoot: parent,
      name: "attach file inode race",
      workspaceMode: "novel",
    });
    await writeNovelWorkspaceManifest(shell.paths.root, shell.project.id);
    const managedBefore = await readFile(shell.paths.manifest);
    const displacedManifest = path.join(shell.paths.sidecar, "managed-project.displaced.json");
    const replacementBytes = Buffer.from("replacement-inode-sentinel\n", "utf8");
    let replacementInode = 0;
    resetAttachNovelManifestHooks = __setAttachNovelManifestTestHooksForTests({
      beforeManagedManifestReplace: async ({ manifestPath }) => {
        await rename(manifestPath, displacedManifest);
        await writeFile(manifestPath, replacementBytes);
        replacementInode = (await lstat(manifestPath)).ino;
      },
    });

    await expect(attachNovelManifest(shell.paths.root, {
      expectedManagedFingerprint: shell.manifestFingerprint,
    })).rejects.toThrow();
    expect((await lstat(shell.paths.manifest)).ino).toBe(replacementInode);
    expect(await readFile(shell.paths.manifest)).toEqual(replacementBytes);
    expect(await readFile(displacedManifest)).toEqual(managedBefore);
  });

  it("attachNovelManifest 在 replace 前父目录被换为项目外 symlink 时失败且外部 sentinel 零写", async () => {
    const parent = await temporaryParent();
    const shell = await createManagedProject({
      parentRoot: parent,
      name: "attach parent symlink race",
      workspaceMode: "novel",
    });
    await writeNovelWorkspaceManifest(shell.paths.root, shell.project.id);
    const managedBefore = await readFile(shell.paths.manifest);
    const displacedSidecar = path.join(shell.paths.root, ".aicanvas-displaced");
    const outsideDirectory = path.join(parent, "outside-attach-target");
    await mkdir(outsideDirectory);
    const outsideManifest = path.join(outsideDirectory, "managed-project.json");
    const outsideSentinel = Buffer.from("outside-sentinel-must-survive\n", "utf8");
    await writeFile(outsideManifest, outsideSentinel);
    resetAttachNovelManifestHooks = __setAttachNovelManifestTestHooksForTests({
      beforeManagedManifestReplace: async () => {
        await rename(shell.paths.sidecar, displacedSidecar);
        await symlink(outsideDirectory, shell.paths.sidecar, "dir");
      },
    });

    await expect(attachNovelManifest(shell.paths.root, {
      expectedManagedFingerprint: shell.manifestFingerprint,
    })).rejects.toThrow();
    expect(await readFile(outsideManifest)).toEqual(outsideSentinel);
    expect(await readFile(path.join(displacedSidecar, "managed-project.json"))).toEqual(managedBefore);
  });

  it("attachNovelManifest 拒绝 drama、错 projectId、坏签名和 symlink，且 managed manifest 零写", async () => {
    const parent = await temporaryParent();
    const drama = await createManagedProject({ parentRoot: parent, name: "drama attach blocked" });
    const dramaBefore = await readFile(drama.paths.manifest);
    await expect(attachNovelManifest(drama.paths.root, {
      expectedManagedFingerprint: drama.manifestFingerprint,
    })).rejects.toThrow(/drama\/schema v1/u);
    expect(await readFile(drama.paths.manifest)).toEqual(dramaBefore);

    const wrongProject = await createManagedProject({
      parentRoot: parent,
      name: "wrong project novel manifest",
      workspaceMode: "novel",
    });
    await writeNovelWorkspaceManifest(wrongProject.paths.root, "not-the-managed-project");
    const wrongProjectBefore = await readFile(wrongProject.paths.manifest);
    await expect(attachNovelManifest(wrongProject.paths.root, {
      expectedManagedFingerprint: wrongProject.manifestFingerprint,
    })).rejects.toThrow(/projectId/u);
    expect(await readFile(wrongProject.paths.manifest)).toEqual(wrongProjectBefore);

    const badSignature = await createManagedProject({
      parentRoot: parent,
      name: "bad signature novel manifest",
      workspaceMode: "hybrid",
    });
    const badSignatureFile = await writeNovelWorkspaceManifest(badSignature.paths.root, badSignature.project.id);
    const badManifest = JSON.parse(badSignatureFile.bytes.toString("utf8")) as Record<string, unknown>;
    badManifest.fingerprint = "0".repeat(64);
    await writeFile(badSignatureFile.path, `${JSON.stringify(badManifest, null, 2)}\n`, "utf8");
    const badSignatureBefore = await readFile(badSignature.paths.manifest);
    await expect(attachNovelManifest(badSignature.paths.root, {
      expectedManagedFingerprint: badSignature.manifestFingerprint,
    })).rejects.toThrow(/fingerprint 无效/u);
    expect(await readFile(badSignature.paths.manifest)).toEqual(badSignatureBefore);

    const linked = await createManagedProject({
      parentRoot: parent,
      name: "linked novel manifest",
      workspaceMode: "novel",
    });
    const outsideNovel = path.join(parent, "outside-novel");
    await mkdir(outsideNovel);
    const outsideSemantic: Record<string, unknown> = {
      schemaVersion: 1,
      kind: "novel-workspace-manifest",
      projectId: linked.project.id,
      sourceMode: "managed_markdown",
      chapterManifest: "manuscript/chapters.json",
      sourceReceiptIds: [],
      revision: 1,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    };
    await writeFile(path.join(outsideNovel, "manifest.json"), `${JSON.stringify({
      ...outsideSemantic,
      fingerprint: createHash("sha256")
        .update(JSON.stringify(stableManifestValue(outsideSemantic)))
        .digest("hex"),
    }, null, 2)}\n`, "utf8");
    await symlink(outsideNovel, path.join(linked.paths.sidecar, "novel"), "dir");
    const linkedBefore = await readFile(linked.paths.manifest);
    await expect(attachNovelManifest(linked.paths.root, {
      expectedManagedFingerprint: linked.manifestFingerprint,
    })).rejects.toThrow(/父目录不是项目内安全/u);
    expect(await readFile(linked.paths.manifest)).toEqual(linkedBefore);
  });

  it.each([
    {
      label: "managed_markdown 缺 chapterManifest",
      mutate: (manifest: Record<string, unknown>) => { delete manifest.chapterManifest; },
    },
    {
      label: "external_snapshot 夹带 chapterManifest",
      mutate: (manifest: Record<string, unknown>) => { manifest.sourceMode = "external_snapshot"; },
    },
    {
      label: "revision 为 0",
      mutate: (manifest: Record<string, unknown>) => { manifest.revision = 0; },
    },
    {
      label: "createdAt 仅日期",
      mutate: (manifest: Record<string, unknown>) => { manifest.createdAt = "2026-08-01"; },
    },
    {
      label: "updatedAt 使用时区偏移",
      mutate: (manifest: Record<string, unknown>) => { manifest.updatedAt = "2026-08-01T08:00:00.000+08:00"; },
    },
  ])("attachNovelManifest 拒绝语义无效 manifest：$label", async ({ mutate }) => {
    const parent = await temporaryParent();
    const shell = await createManagedProject({
      parentRoot: parent,
      name: "invalid novel workspace semantics",
      workspaceMode: "novel",
    });
    await writeNovelWorkspaceManifest(shell.paths.root, shell.project.id, mutate);
    const managedBefore = await readFile(shell.paths.manifest);
    await expect(attachNovelManifest(shell.paths.root, {
      expectedManagedFingerprint: shell.manifestFingerprint,
    })).rejects.toThrow(/novel workspace manifest 结构无效/u);
    expect(await readFile(shell.paths.manifest)).toEqual(managedBefore);
  });

  it("attachNovelManifest 拒绝多硬链接 novel manifest", async () => {
    const parent = await temporaryParent();
    const shell = await createManagedProject({
      parentRoot: parent,
      name: "hardlinked novel workspace manifest",
      workspaceMode: "novel",
    });
    const novel = await writeNovelWorkspaceManifest(shell.paths.root, shell.project.id);
    await link(novel.path, path.join(parent, "novel-manifest-hardlink.json"));
    const managedBefore = await readFile(shell.paths.manifest);
    await expect(attachNovelManifest(shell.paths.root, {
      expectedManagedFingerprint: shell.manifestFingerprint,
    })).rejects.toThrow(/不是安全普通文件/u);
    expect(await readFile(shell.paths.manifest)).toEqual(managedBefore);
  });

  it("attachNovelManifest 拒绝多硬链接 managed manifest", async () => {
    const parent = await temporaryParent();
    const shell = await createManagedProject({
      parentRoot: parent,
      name: "hardlinked managed manifest",
      workspaceMode: "novel",
    });
    await writeNovelWorkspaceManifest(shell.paths.root, shell.project.id);
    await link(shell.paths.manifest, path.join(parent, "managed-manifest-hardlink.json"));
    const managedBefore = await readFile(shell.paths.manifest);

    await expect(attachNovelManifest(shell.paths.root, {
      expectedManagedFingerprint: shell.manifestFingerprint,
    })).rejects.toThrow(/单链接普通文件/u);
    expect(await readFile(shell.paths.manifest)).toEqual(managedBefore);
  });

  it("novel/hybrid 不进入旧空工程升级写路径", async () => {
    const parent = await temporaryParent();
    const shell = await createManagedProject({ parentRoot: parent, name: "禁止旧升级", workspaceMode: "hybrid" });
    await removeGenerationLedger(shell.paths.root);
    const before = await snapshotTree(shell.paths.sidecar);

    await expect(upgradeEmptyProjectToManaged(shell.paths.root)).rejects.toThrow("不得进入旧空工程升级写路径");
    await expect(access(shell.paths.generationDatabase)).rejects.toThrow();
    await expect(access(path.join(shell.paths.sidecar, "studio-generation"))).rejects.toThrow();
    expect(await snapshotTree(shell.paths.sidecar)).toEqual(before);
  });
});
