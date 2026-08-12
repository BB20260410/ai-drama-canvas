import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createManagedProject } from "../src/core/managed-project.js";
import { activateProject, getActiveProjectReadOnly, listProjects } from "../src/core/service.js";
import { createManagedProjectBackup } from "../src/core/project-backup.js";
import {
  getActiveProjectRegistrationSnapshotReadOnly,
  getActiveProjectStateReadOnly,
  getProjectRegistryV2Path,
  getWorkspacePreferencesV2Path,
  listRegisteredProjects,
  readJson,
  registerProject,
  setActiveHybridWorkspacePreference,
  setActiveProjectRegistration,
  writeJsonAtomic,
} from "../src/core/sidecar.js";

const execFileAsync = promisify(execFile);
const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OLD_WRITER_COMMIT = "1e8e9d9c8cb055987d53b8fa0b503fb80538b3f5";
const temporaryRoots: string[] = [];
const previousRegistryPath = process.env.AI_CANVAS_REGISTRY_PATH;

async function snapshotTree(root: string): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = path.relative(root, absolutePath);
      if (entry.isDirectory()) {
        snapshot[`${relativePath}/`] = "directory";
        await visit(absolutePath);
      } else if (entry.isFile()) {
        snapshot[relativePath] = createHash("sha256").update(await readFile(absolutePath)).digest("hex");
      } else if (entry.isSymbolicLink()) {
        snapshot[relativePath] = "symbolic-link";
      } else {
        snapshot[relativePath] = "other";
      }
    }
  };
  await visit(root);
  return snapshot;
}

afterEach(async () => {
  if (previousRegistryPath === undefined) delete process.env.AI_CANVAS_REGISTRY_PATH;
  else process.env.AI_CANVAS_REGISTRY_PATH = previousRegistryPath;
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("schema v2 项目注册表 writer compatibility fence", () => {
  it("只读入口零写，当前显式激活迁移早期泄漏，真实旧 HEAD 的 GUI 与低层写入口均失败关闭", async () => {
    const base = await mkdtemp(path.join(await realpath(os.tmpdir()), "ai-canvas-old-writer-registry-"));
    temporaryRoots.push(base);
    const registryPath = path.join(base, "registry", "projects.json");
    const activeProjectPath = path.join(path.dirname(registryPath), "active-project.json");
    process.env.AI_CANVAS_REGISTRY_PATH = registryPath;

    const projectsParent = path.join(base, "projects");
    await mkdir(projectsParent, { recursive: true });
    const drama = await createManagedProject({ parentRoot: projectsParent, name: "Legacy Drama" });
    const novel = await createManagedProject({ parentRoot: projectsParent, name: "Writer V2 Novel", workspaceMode: "novel" });
    const hybrid = await createManagedProject({ parentRoot: projectsParent, name: "Writer V2 Hybrid", workspaceMode: "hybrid" });

    await registerProject(drama.project);
    await registerProject(hybrid.project);
    await setActiveProjectRegistration(drama.paths.root);
    const earlyPreviewUpdatedAt = "2026-08-01T01:00:00.000Z";
    await writeJsonAtomic(registryPath, [
      {
        id: novel.project.id,
        name: novel.project.name,
        primaryRoot: novel.paths.root,
        updatedAt: earlyPreviewUpdatedAt,
      },
      ...await readJson<Array<{ id: string; name: string; primaryRoot: string; updatedAt: string }>>(registryPath, []),
    ]);
    await writeJsonAtomic(activeProjectPath, {
      schemaVersion: 2,
      primaryRoot: novel.paths.root,
      activationId: "0123456789abcdef0123456789abcdef",
      activatedAt: earlyPreviewUpdatedAt,
      updatedAt: earlyPreviewUpdatedAt,
    });
    expect((await readJson<Array<{ primaryRoot: string }>>(registryPath, []))[0]?.primaryRoot).toBe(novel.paths.root);
    const novelTreeBeforeRepair = await snapshotTree(novel.paths.root);

    const legacyRegistryBeforeReadOnly = await readFile(registryPath);
    const activePointerBeforeReadOnly = await readFile(activeProjectPath);
    // 项目列表与只读 active 投影必须保持物理零写，即使看见早期泄漏也只做合并投影。
    const startupProjects = await listProjects();
    expect(startupProjects.find((project) => project.primaryRoot === novel.paths.root)).toMatchObject({
      id: novel.project.id,
      available: true,
    });
    expect(await readFile(registryPath)).toEqual(legacyRegistryBeforeReadOnly);
    expect(await readFile(activeProjectPath)).toEqual(activePointerBeforeReadOnly);
    await expect(getActiveProjectReadOnly()).resolves.toMatchObject({
      id: novel.project.id,
      primaryRoot: novel.paths.root,
      available: true,
    });
    await expect(getActiveProjectRegistrationSnapshotReadOnly()).resolves.toMatchObject({
      registration: { id: novel.project.id, primaryRoot: novel.paths.root },
    });
    expect(await getActiveProjectStateReadOnly()).toMatchObject({
      schemaVersion: 3,
      primaryRoot: novel.paths.root,
      activationId: "0123456789abcdef0123456789abcdef",
      workspacePreferences: {},
    });
    expect(await readFile(registryPath)).toEqual(legacyRegistryBeforeReadOnly);
    expect(await readFile(activeProjectPath)).toEqual(activePointerBeforeReadOnly);

    // 激活是显式 mutation：先迁移登记并升级 writer fence，再继续当前 writer 激活。
    await expect(activateProject(novel.paths.root)).resolves.toMatchObject({
      id: novel.project.id,
      primaryRoot: novel.paths.root,
      available: true,
    });
    expect(await readJson<Array<{ primaryRoot: string }>>(registryPath, [])).toEqual([
      expect.objectContaining({ primaryRoot: drama.paths.root }),
    ]);
    expect(await readJson<Record<string, unknown>>(getProjectRegistryV2Path(), {})).toMatchObject({
      schemaVersion: 2,
      kind: "ai-canvas-project-registry",
      minimumWriterSchemaVersion: 2,
      projects: expect.arrayContaining([
        expect.objectContaining({ id: novel.project.id, primaryRoot: novel.paths.root }),
        expect.objectContaining({ id: hybrid.project.id, primaryRoot: hybrid.paths.root }),
      ]),
    });
    expect(await getActiveProjectStateReadOnly()).toMatchObject({
      schemaVersion: 3,
      primaryRoot: novel.paths.root,
      activationId: "0123456789abcdef0123456789abcdef",
      workspacePreferences: {},
    });
    expect(await snapshotTree(novel.paths.root)).toEqual(novelTreeBeforeRepair);
    const legacyRegistryAfterRepair = await readFile(registryPath);
    const activePointerAfterRepair = await readFile(activeProjectPath);
    const novelTreeBeforeOldAttempt = await snapshotTree(novel.paths.root);
    const globalTreeBeforeOldAttempt = await snapshotTree(path.dirname(registryPath));

    const oldWriterRoot = path.join(base, "old-writer");
    const archivePath = path.join(base, "old-writer.tar");
    await mkdir(oldWriterRoot, { recursive: true });
    await execFileAsync("git", ["cat-file", "-e", `${OLD_WRITER_COMMIT}^{commit}`], { cwd: workspace });
    await execFileAsync("git", ["archive", "--format=tar", `--output=${archivePath}`, OLD_WRITER_COMMIT], { cwd: workspace });
    await execFileAsync("tar", ["-xf", archivePath, "-C", oldWriterRoot]);
    await symlink(path.join(workspace, "node_modules"), path.join(oldWriterRoot, "node_modules"), "dir");

    const oldWriterScript = [
      "void (async () => {",
      "  const { readFile } = await import('node:fs/promises');",
      "  const { activateProject, loadCanvasPositions, saveCanvasPositions, saveProjectConfig } = await import('./src/core/service.ts');",
      "  const { prepareProjectImport, commitProjectImport } = await import('./src/core/importer.ts');",
      "  const { upsertCanvasEntity } = await import('./src/core/canvas-state.ts');",
      "  const targetConfig = JSON.parse(await readFile(`${process.env.TARGET_PROJECT_ROOT}/.aicanvas/project.json`, 'utf8'));",
      "  const results = [];",
      "  try {",
      "    await activateProject(process.env.TARGET_PROJECT_ROOT);",
      "    results.push('activate:UNEXPECTED_SUCCESS');",
      "  } catch (error) {",
      "    results.push(`activate:${error instanceof Error ? error.message : String(error)}`);",
      "  }",
      "  try {",
      "    await prepareProjectImport({ primaryRoot: process.env.TARGET_PROJECT_ROOT, projectMode: 'story_first' });",
      "    results.push('prepare:UNEXPECTED_SUCCESS');",
      "  } catch (error) {",
      "    results.push(`prepare:${error instanceof Error ? error.message : String(error)}`);",
      "  }",
      "  try {",
      "    await commitProjectImport({ previewId: 'forged-old-writer-preview', config: targetConfig, projectMode: 'story_first' });",
      "    results.push('commit:UNEXPECTED_SUCCESS');",
      "  } catch (error) {",
      "    results.push(`commit:${error instanceof Error ? error.message : String(error)}`);",
      "  }",
      "  try {",
      "    await saveProjectConfig(targetConfig);",
      "    results.push('save:UNEXPECTED_SUCCESS');",
      "  } catch (error) {",
      "    results.push(`save:${error instanceof Error ? error.message : String(error)}`);",
      "  }",
      "  try {",
      "    await loadCanvasPositions(process.env.TARGET_PROJECT_ROOT, 'old-writer-layout');",
      "    results.push('layout-load:UNEXPECTED_SUCCESS');",
      "  } catch (error) {",
      "    results.push(`layout-load:${error instanceof Error ? error.message : String(error)}`);",
      "  }",
      "  try {",
      "    await saveCanvasPositions(process.env.TARGET_PROJECT_ROOT, 'old-writer-layout', { node: { x: 1, y: 2 } });",
      "    results.push('layout:UNEXPECTED_SUCCESS');",
      "  } catch (error) {",
      "    results.push(`layout:${error instanceof Error ? error.message : String(error)}`);",
      "  }",
      "  try {",
      "    await upsertCanvasEntity(process.env.TARGET_PROJECT_ROOT, { kind: 'note', title: 'old-writer-probe' });",
      "    results.push('upsert:UNEXPECTED_SUCCESS');",
      "  } catch (error) {",
      "    results.push(`upsert:${error instanceof Error ? error.message : String(error)}`);",
      "  }",
      "  process.stdout.write(results.join('\\n'));",
      "})();",
    ].join("\n");
    const { stdout } = await execFileAsync(
      path.join(workspace, "node_modules", ".bin", "tsx"),
      ["-e", oldWriterScript],
      {
        cwd: oldWriterRoot,
        env: {
          ...process.env,
          AI_CANVAS_REGISTRY_PATH: registryPath,
          TARGET_PROJECT_ROOT: novel.paths.root,
        },
      },
    );

    expect(stdout).toContain("activate:项目尚未登记");
    expect(stdout).toMatch(/prepare:项目配置 JSON 结构无效/u);
    expect(stdout).toMatch(/commit:项目配置 JSON 结构无效/u);
    expect(stdout).toMatch(/save:项目配置 JSON 结构无效/u);
    expect(stdout).toMatch(/layout-load:.*(?:not a database|file is not a database|非数据库)/iu);
    expect(stdout).toMatch(/layout:.*(?:not a database|file is not a database|非数据库)/iu);
    expect(stdout).toMatch(/upsert:.*(?:locks|锁|EEXIST)/u);
    expect(stdout).not.toContain("UNEXPECTED_SUCCESS");
    expect(await readFile(registryPath)).toEqual(legacyRegistryAfterRepair);
    expect(await readFile(activeProjectPath)).toEqual(activePointerAfterRepair);
    expect(await snapshotTree(novel.paths.root)).toEqual(novelTreeBeforeOldAttempt);
    expect(await snapshotTree(path.dirname(registryPath))).toEqual(globalTreeBeforeOldAttempt);

    expect(new Set((await listRegisteredProjects()).map((project) => project.primaryRoot))).toEqual(
      new Set([drama.paths.root, novel.paths.root, hybrid.paths.root]),
    );
    expect((await listProjects()).find((project) => project.primaryRoot === novel.paths.root)).toMatchObject({
      id: novel.project.id,
      available: true,
    });
    expect(await getActiveProjectStateReadOnly()).toMatchObject({
      schemaVersion: 3,
      primaryRoot: novel.paths.root,
      workspacePreferences: {},
    });

    const backup = await createManagedProjectBackup(novel.paths.root, path.join(base, "backups"));
    const backupProjectRoot = path.join(backup.backupRoot, "project");
    const backupTreeBeforeOldAttempt = await snapshotTree(backupProjectRoot);
    const oldBackupCacheScript = [
      "void (async () => {",
      "  const { loadCanvasPositions, saveCanvasPositions } = await import('./src/core/service.ts');",
      "  const result = { load: null, save: null };",
      "  try { await loadCanvasPositions(process.env.TARGET_BACKUP_PROJECT_ROOT, 'old-backup-layout'); result.load = { accepted: true, error: null }; }",
      "  catch (error) { result.load = { accepted: false, error: error instanceof Error ? error.message : String(error) }; }",
      "  try { await saveCanvasPositions(process.env.TARGET_BACKUP_PROJECT_ROOT, 'old-backup-layout', { node: { x: 7, y: 9 } }); result.save = { accepted: true, error: null }; }",
      "  catch (error) { result.save = { accepted: false, error: error instanceof Error ? error.message : String(error) }; }",
      "  process.stdout.write(JSON.stringify(result));",
      "})();",
    ].join("\n");
    const oldBackupCacheRun = await execFileAsync(
      path.join(workspace, "node_modules", ".bin", "tsx"),
      ["-e", oldBackupCacheScript],
      {
        cwd: oldWriterRoot,
        env: { ...process.env, TARGET_BACKUP_PROJECT_ROOT: backupProjectRoot },
      },
    );
    expect(JSON.parse(oldBackupCacheRun.stdout)).toMatchObject({
      load: { accepted: false, error: expect.stringMatching(/not a database/iu) },
      save: { accepted: false, error: expect.stringMatching(/not a database/iu) },
    });
    expect(await snapshotTree(backupProjectRoot)).toEqual(backupTreeBeforeOldAttempt);

    // hybrid 偏好必须驻留 v2-only sidecar；切回 legacy drama 后 raw active pointer
    // 仍是旧 HEAD 可读取的 schema2，偏好则在再次激活 hybrid 后恢复。
    await setActiveProjectRegistration(hybrid.paths.root);
    await setActiveHybridWorkspacePreference(hybrid.project.id, "novel");
    await setActiveProjectRegistration(drama.paths.root);
    const dramaActiveRaw = await readJson<Record<string, unknown>>(activeProjectPath, {});
    expect(dramaActiveRaw).toMatchObject({ schemaVersion: 2, primaryRoot: drama.paths.root });
    expect(dramaActiveRaw).not.toHaveProperty("workspacePreferences");
    expect(await readJson<Record<string, unknown>>(getWorkspacePreferencesV2Path(), {})).toMatchObject({
      preferences: { [hybrid.project.id]: { mode: "novel" } },
    });

    const oldDramaScript = [
      "void (async () => {",
      "  const { activateProject, getActiveProjectReadOnly } = await import('./src/core/service.ts');",
      "  const before = await getActiveProjectReadOnly();",
      "  const activated = await activateProject(process.env.TARGET_DRAMA_ROOT);",
      "  process.stdout.write(JSON.stringify({ before, activated }));",
      "})();",
    ].join("\n");
    const oldDramaRun = await execFileAsync(
      path.join(workspace, "node_modules", ".bin", "tsx"),
      ["-e", oldDramaScript],
      {
        cwd: oldWriterRoot,
        env: {
          ...process.env,
          AI_CANVAS_REGISTRY_PATH: registryPath,
          TARGET_DRAMA_ROOT: drama.paths.root,
        },
      },
    );
    expect(JSON.parse(oldDramaRun.stdout)).toMatchObject({
      before: { id: drama.project.id, primaryRoot: drama.paths.root, available: true },
      activated: { id: drama.project.id, primaryRoot: drama.paths.root, available: true },
    });
    expect(await readJson<Record<string, unknown>>(activeProjectPath, {})).toMatchObject({
      schemaVersion: 2,
      primaryRoot: drama.paths.root,
    });
  }, 60_000);
});
