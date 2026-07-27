import { access, mkdir, mkdtemp, readFile, realpath, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createManagedProject, inspectManagedProject, isManagedProject, managedProjectSlug, upgradeEmptyProjectToManaged } from "../src/core/managed-project.js";

const roots: string[] = [];

afterEach(async () => {
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
