import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendEvent, assertProjectRegistryWriteIsIsolated, diagnoseProjectRegistryEntries, ensureSidecar, getActiveHybridWorkspacePreference, getActiveProjectRegistrationSnapshot, getActiveProjectRegistrationSnapshotReadOnly, getActiveProjectStateReadOnly, getProjectRegistryV2Path, getSidecarPaths, getWorkspacePreferencesV2Path, listEvents, listRegisteredProjects, listTaskPacks, pruneUnavailableRegisteredProjects, readJson, registerProject, saveRegisteredProjects, setActiveHybridWorkspacePreference, setActiveProjectRegistration, setActiveStudioContext, unregisterProject, writeJsonAtomic, writeTextAtomic } from "../src/core/sidecar.js";
import { activateProject, getActiveProject, listProjects } from "../src/core/service.js";
import { createManagedProject } from "../src/core/managed-project.js";

const roots: string[] = [];
const execFileAsync = promisify(execFile);

async function writeManagedWorkspaceManifest(
  projectRoot: string,
  projectId: string,
  workspaceMode: "drama" | "novel" | "hybrid",
): Promise<string> {
  const manifestPath = path.join(getSidecarPaths(projectRoot).root, "managed-project.json");
  await writeFile(manifestPath, `${JSON.stringify({
    schemaVersion: workspaceMode === "drama" ? 1 : 2,
    kind: "ai-canvas-managed-project",
    projectId,
    ...(workspaceMode === "drama" ? {} : {
      workspaceMode,
      minimumWriterSchemaVersion: 2,
    }),
    fingerprint: `fixture-${projectId}`,
  }, null, 2)}\n`, "utf8");
  return manifestPath;
}

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("侧车持久化", () => {
  it("临时工程只能写入显式隔离的临时注册表，诊断保持只读", () => {
    const temporaryProject = path.join(os.tmpdir(), "ai-canvas-isolated-project");
    const defaultRegistry = path.join(os.homedir(), ".aicanvas", "projects.json");
    const isolatedRegistry = path.join(os.tmpdir(), "ai-canvas-isolated-registry", "projects.json");

    expect(() => assertProjectRegistryWriteIsIsolated(temporaryProject, defaultRegistry, false))
      .toThrow("临时工程禁止写入用户全局注册表");
    expect(() => assertProjectRegistryWriteIsIsolated(temporaryProject, isolatedRegistry, true))
      .not.toThrow();

    const entries = [
      { id: "temporary", name: "测试工程", primaryRoot: temporaryProject, updatedAt: "2026-07-25T20:00:00.000Z" },
      { id: "formal", name: "正式工程", primaryRoot: "/Users/example/Documents/formal", updatedAt: "2026-07-25T20:00:00.000Z" },
    ];
    const snapshot = structuredClone(entries);
    expect(diagnoseProjectRegistryEntries(entries)).toEqual({
      total: 2,
      temporaryEntries: [entries[0]],
      cleanupPlan: [
        "先确认临时工程已无正在运行的调用或持有者。",
        "逐项核对 primaryRoot、id 与 updatedAt，不使用批量 prune 清理外接盘或暂时离线工程。",
        "仅通过显式 unregisterProject(primaryRoot) 移除已确认的临时条目，并在操作后重新运行只读诊断。",
      ],
    });
    expect(entries).toEqual(snapshot);
  });

  it("原子替换 JSON 与文本后不遗留临时文件", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-sidecar-"));
    roots.push(root);
    const jsonPath = path.join(root, "nested", "state.json");
    const textPath = path.join(root, "nested", "state.md");

    await writeJsonAtomic(jsonPath, { revision: 1, value: "旧" });
    await chmod(jsonPath, 0o640);
    await writeJsonAtomic(jsonPath, { revision: 2, value: "新" });
    await writeTextAtomic(textPath, "# 已刷盘\n");

    expect(await readJson(jsonPath, null)).toEqual({ revision: 2, value: "新" });
    expect(await readFile(textPath, "utf8")).toBe("# 已刷盘\n");
    expect((await stat(jsonPath)).mode & 0o777).toBe(0o640);
    expect((await readdir(path.dirname(jsonPath))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("并发追加的审计事件保持逐行可解析且不丢失", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-events-"));
    roots.push(root);
    await ensureSidecar(root);

    await Promise.all(Array.from({ length: 40 }, (_, index) => appendEvent(root, {
      actor: "app",
      type: "test.durable-event",
      data: { index },
    })));

    const rawLines = (await readFile(getSidecarPaths(root).events, "utf8")).trim().split("\n");
    expect(rawLines).toHaveLength(40);
    expect(rawLines.map((line) => JSON.parse(line) as unknown)).toHaveLength(40);
    const events = await listEvents(root, 100);
    expect(new Set(events.map((event) => Number(event.data?.index))).size).toBe(40);
  });

  it("只对缺失文件使用默认值，损坏 JSON 不会被伪装成空状态", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-corrupt-json-"));
    roots.push(root);
    const missing = path.join(root, "missing.json");
    const corrupt = path.join(root, "corrupt.json");
    await writeFile(corrupt, "{\"revision\":", "utf8");

    expect(await readJson(missing, { revision: 0 })).toEqual({ revision: 0 });
    await expect(readJson(corrupt, { revision: 0 })).rejects.toThrow(`侧车 JSON 已损坏，已停止写入以保留现场：${corrupt}`);
    expect(await readFile(corrupt, "utf8")).toBe("{\"revision\":");
  });

  it("损坏的任务包或事件行不会被列表接口静默忽略", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-corrupt-list-"));
    roots.push(root);
    await ensureSidecar(root);
    const paths = getSidecarPaths(root);
    await writeFile(path.join(paths.tasks, "broken.json"), "{\"id\":", "utf8");
    await writeFile(paths.events, "{not-json}\n", "utf8");

    await expect(listTaskPacks(root)).rejects.toThrow("侧车 JSON 已损坏");
    await expect(listEvents(root)).rejects.toThrow();
  });

  it("两个独立进程同时登记不同项目不会互相覆盖", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-registry-race-"));
    roots.push(base);
    const firstRoot = path.join(base, "first");
    const secondRoot = path.join(base, "second");
    const registryPath = path.join(base, "registry", "projects.json");
    const executable = path.join(process.cwd(), "node_modules", ".bin", "tsx");

    await Promise.all([
      execFileAsync(executable, ["scripts/registry-worker.ts", firstRoot], { cwd: process.cwd(), env: { ...process.env, AI_CANVAS_REGISTRY_PATH: registryPath } }),
      execFileAsync(executable, ["scripts/registry-worker.ts", secondRoot], { cwd: process.cwd(), env: { ...process.env, AI_CANVAS_REGISTRY_PATH: registryPath } }),
    ]);

    const registered = await readJson<Array<{ primaryRoot: string }>>(registryPath, []);
    expect(new Set(registered.map((project) => project.primaryRoot))).toEqual(new Set([firstRoot, secondRoot]));
    expect(await readdir(path.join(base, "registry", "locks"))).toEqual([]);
  });

  it("注册表不会因登记超过 30 个工程而淘汰长期 owner", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-registry-retention-"));
    roots.push(base);
    const registryPath = path.join(base, "registry", "projects.json");
    const previousRegistryPath = process.env.AI_CANVAS_REGISTRY_PATH;
    process.env.AI_CANVAS_REGISTRY_PATH = registryPath;
    try {
      const template = await ensureSidecar(path.join(base, "template"), { register: false });
      for (let index = 0; index < 32; index += 1) {
        const primaryRoot = path.join(base, `project-${String(index).padStart(2, "0")}`);
        await registerProject({
          ...template,
          id: `project-${String(index).padStart(2, "0")}`,
          name: `工程 ${index}`,
          primaryRoot,
          updatedAt: new Date().toISOString(),
        });
      }
      const registered = await readJson<Array<{ id: string; primaryRoot: string }>>(registryPath, []);
      expect(registered).toHaveLength(32);
      expect(registered.at(-1)).toMatchObject({
        id: "project-00",
        primaryRoot: path.join(base, "project-00"),
      });
      await saveRegisteredProjects(registered.map((project) => ({
        ...project,
        name: project.id,
        updatedAt: new Date().toISOString(),
      })));
      expect(await readJson<Array<{ id: string }>>(registryPath, [])).toHaveLength(32);
    } finally {
      if (previousRegistryPath === undefined) delete process.env.AI_CANVAS_REGISTRY_PATH;
      else process.env.AI_CANVAS_REGISTRY_PATH = previousRegistryPath;
    }
  });

  it("schema v2 novel/hybrid 只进入带 writer fence 的独立注册表，当前 writer 可合并列出、激活和注销", async () => {
    const base = await mkdtemp(path.join(await realpath(os.tmpdir()), "ai-canvas-registry-v2-fence-"));
    roots.push(base);
    const registryPath = path.join(base, "registry", "projects.json");
    const activeProjectPath = path.join(path.dirname(registryPath), "active-project.json");
    const previousRegistryPath = process.env.AI_CANVAS_REGISTRY_PATH;
    process.env.AI_CANVAS_REGISTRY_PATH = registryPath;
    try {
      const parent = path.join(base, "projects");
      await mkdir(parent, { recursive: true });
      const drama = await createManagedProject({ parentRoot: parent, name: "Legacy Drama" });
      const novel = await createManagedProject({ parentRoot: parent, name: "Novel V2", workspaceMode: "novel" });
      const hybrid = await createManagedProject({ parentRoot: parent, name: "Hybrid V2", workspaceMode: "hybrid" });

      await registerProject(drama.project);
      await setActiveProjectRegistration(drama.paths.root);
      const legacyRegistryBeforeV2 = await readFile(registryPath);
      const legacyActiveBeforeV2 = await readFile(activeProjectPath);
      expect(await readJson<Record<string, unknown>>(activeProjectPath, {})).toMatchObject({
        schemaVersion: 2,
        primaryRoot: drama.paths.root,
      });

      await registerProject(novel.project);
      await registerProject(hybrid.project);
      expect(await readFile(registryPath)).toEqual(legacyRegistryBeforeV2);
      expect(await readFile(activeProjectPath)).toEqual(legacyActiveBeforeV2);
      expect(await readJson<Array<{ primaryRoot: string }>>(registryPath, [])).toEqual([
        expect.objectContaining({ primaryRoot: drama.paths.root }),
      ]);

      const registryV2Path = getProjectRegistryV2Path();
      expect(await readJson<Record<string, unknown>>(registryV2Path, {})).toMatchObject({
        schemaVersion: 2,
        kind: "ai-canvas-project-registry",
        minimumWriterSchemaVersion: 2,
        projects: [
          expect.objectContaining({ id: hybrid.project.id, primaryRoot: hybrid.paths.root }),
          expect.objectContaining({ id: novel.project.id, primaryRoot: novel.paths.root }),
        ],
      });
      expect(new Set((await listRegisteredProjects()).map((project) => project.primaryRoot))).toEqual(
        new Set([drama.paths.root, novel.paths.root, hybrid.paths.root]),
      );

      await activateProject(novel.paths.root);
      const novelActiveRaw = await readJson<Record<string, unknown>>(activeProjectPath, {});
      expect(novelActiveRaw).toMatchObject({
        schemaVersion: 3,
        primaryRoot: novel.paths.root,
      });
      expect(novelActiveRaw).not.toHaveProperty("workspacePreferences");
      await expect(getActiveProjectRegistrationSnapshot()).resolves.toMatchObject({
        registration: { id: novel.project.id, primaryRoot: novel.paths.root },
      });
      await expect(getActiveProjectRegistrationSnapshotReadOnly()).resolves.toMatchObject({
        registration: { id: novel.project.id, primaryRoot: novel.paths.root },
      });

      const legacyBeforeV2Unregister = await readFile(registryPath);
      await unregisterProject(hybrid.paths.root);
      expect(await readFile(registryPath)).toEqual(legacyBeforeV2Unregister);
      expect(await readJson<Record<string, unknown>>(registryV2Path, {})).toMatchObject({
        projects: [expect.objectContaining({ primaryRoot: novel.paths.root })],
      });
    } finally {
      if (previousRegistryPath === undefined) delete process.env.AI_CANVAS_REGISTRY_PATH;
      else process.env.AI_CANVAS_REGISTRY_PATH = previousRegistryPath;
    }
  });

  it("清理失效项目与并发注销不会用旧快照复活已注销项目", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-registry-prune-"));
    roots.push(base);
    const registryPath = path.join(base, "registry", "projects.json");
    const previousRegistryPath = process.env.AI_CANVAS_REGISTRY_PATH;
    process.env.AI_CANVAS_REGISTRY_PATH = registryPath;
    try {
      const first = await ensureSidecar(path.join(base, "first"));
      const second = await ensureSidecar(path.join(base, "second"));
      const missingRoot = path.join(base, "missing");
      await registerProject({ ...first, id: "missing-project", name: "missing", primaryRoot: missingRoot, updatedAt: new Date().toISOString() });

      await Promise.all([pruneUnavailableRegisteredProjects(), unregisterProject(second.primaryRoot)]);

      const registered = await readJson<Array<{ primaryRoot: string }>>(registryPath, []);
      expect(registered.map((project) => project.primaryRoot)).toEqual([first.primaryRoot]);
    } finally {
      if (previousRegistryPath === undefined) delete process.env.AI_CANVAS_REGISTRY_PATH;
      else process.env.AI_CANVAS_REGISTRY_PATH = previousRegistryPath;
    }
  });

  it("只读项目列表不会因路径暂时不可用而删除登记", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-registry-readonly-"));
    roots.push(base);
    const registryPath = path.join(base, "registry", "projects.json");
    const previousRegistryPath = process.env.AI_CANVAS_REGISTRY_PATH;
    process.env.AI_CANVAS_REGISTRY_PATH = registryPath;
    try {
      const available = await ensureSidecar(path.join(base, "available"));
      const missingRoot = path.join(base, "temporarily-unmounted");
      await registerProject({ ...available, id: "temporarily-unavailable", name: "外接盘项目", primaryRoot: missingRoot, updatedAt: new Date().toISOString() });
      const listed = await listProjects();
      expect(listed.find((project) => project.primaryRoot === available.primaryRoot)?.available).toBe(true);
      expect(listed.find((project) => project.primaryRoot === missingRoot)).toEqual(expect.objectContaining({ available: false, name: "外接盘项目" }));
      const persisted = await readJson<Array<{ primaryRoot: string }>>(registryPath, []);
      expect(persisted.map((project) => project.primaryRoot)).toEqual([missingRoot, available.primaryRoot]);
    } finally {
      if (previousRegistryPath === undefined) delete process.env.AI_CANVAS_REGISTRY_PATH;
      else process.env.AI_CANVAS_REGISTRY_PATH = previousRegistryPath;
    }
  });

  it("活动项目独立于注册表排序，注销时只清理活动指针而不扫描其他工程", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-active-project-"));
    roots.push(base);
    const registryPath = path.join(base, "registry", "projects.json");
    const previousRegistryPath = process.env.AI_CANVAS_REGISTRY_PATH;
    process.env.AI_CANVAS_REGISTRY_PATH = registryPath;
    try {
      const first = await ensureSidecar(path.join(base, "first"));
      await activateProject(first.primaryRoot);
      const second = await ensureSidecar(path.join(base, "second"));

      expect((await listProjects())[0]?.primaryRoot).toBe(second.primaryRoot);
      expect(await getActiveProject()).toEqual(expect.objectContaining({ primaryRoot: first.primaryRoot, available: true }));

      await unregisterProject(first.primaryRoot);
      expect(await getActiveProject()).toBeNull();
      expect((await listProjects()).map((project) => project.primaryRoot)).toEqual([second.primaryRoot]);
    } finally {
      if (previousRegistryPath === undefined) delete process.env.AI_CANVAS_REGISTRY_PATH;
      else process.env.AI_CANVAS_REGISTRY_PATH = previousRegistryPath;
    }
  });

  it("hybrid 桌面偏好按 projectId 保存，切换、刷新读取和 Studio 更新都不丢失", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-hybrid-workspace-preference-"));
    roots.push(base);
    const registryPath = path.join(base, "registry", "projects.json");
    const activeProjectPath = path.join(path.dirname(registryPath), "active-project.json");
    const previousRegistryPath = process.env.AI_CANVAS_REGISTRY_PATH;
    process.env.AI_CANVAS_REGISTRY_PATH = registryPath;
    try {
      const first = await ensureSidecar(path.join(base, "first"));
      const second = await ensureSidecar(path.join(base, "second"));
      const drama = await ensureSidecar(path.join(base, "drama"));
      const firstManifestPath = await writeManagedWorkspaceManifest(first.primaryRoot, first.id, "hybrid");
      await writeManagedWorkspaceManifest(second.primaryRoot, second.id, "hybrid");
      await registerProject(first);
      await registerProject(second);
      await registerProject(drama);
      const firstManifestBefore = await readFile(firstManifestPath);

      await setActiveProjectRegistration(first.primaryRoot);
      const firstActiveRaw = await readJson<Record<string, unknown>>(activeProjectPath, {});
      expect(firstActiveRaw).toMatchObject({
        schemaVersion: 3,
        primaryRoot: first.primaryRoot,
      });
      expect(firstActiveRaw).not.toHaveProperty("workspacePreferences");
      const activationIdBeforePreference = (await getActiveProjectStateReadOnly())?.activationId;

      const activeBeforeGet = await readFile(activeProjectPath);
      await expect(getActiveHybridWorkspacePreference(first.id)).resolves.toBeNull();
      expect(await readFile(activeProjectPath)).toEqual(activeBeforeGet);
      await expect(setActiveHybridWorkspacePreference(second.id, "drama")).rejects.toThrow("当前活动工程");
      expect(await readFile(activeProjectPath)).toEqual(activeBeforeGet);

      await expect(setActiveHybridWorkspacePreference(first.id, "novel")).resolves.toMatchObject({
        projectId: first.id,
        mode: "novel",
      });
      expect(await readJson<Record<string, unknown>>(activeProjectPath, {})).not.toHaveProperty("workspacePreferences");
      expect(await readJson<Record<string, unknown>>(getWorkspacePreferencesV2Path(), {})).toMatchObject({
        schemaVersion: 2,
        kind: "ai-canvas-workspace-preferences",
        preferences: { [first.id]: { mode: "novel" } },
      });
      expect((await getActiveProjectStateReadOnly())?.activationId).toBe(activationIdBeforePreference);
      expect(await readFile(firstManifestPath)).toEqual(firstManifestBefore);
      await expect(stat(path.join(first.primaryRoot, "manuscript"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(path.join(first.primaryRoot, "story-bible"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(path.join(getSidecarPaths(first.primaryRoot).root, "novel"))).rejects.toMatchObject({ code: "ENOENT" });

      await setActiveStudioContext(first.primaryRoot, { mode: "dashboard", focus: { unitId: "unit-001" } });
      expect(await readJson<Record<string, unknown>>(activeProjectPath, {})).toMatchObject({
        schemaVersion: 3,
        studio: { mode: "dashboard", focus: { unitId: "unit-001" } },
      });
      expect(await readJson<Record<string, unknown>>(activeProjectPath, {})).not.toHaveProperty("workspacePreferences");

      await setActiveProjectRegistration(second.primaryRoot);
      await expect(setActiveHybridWorkspacePreference(second.id, "drama")).resolves.toMatchObject({
        projectId: second.id,
        mode: "drama",
      });
      await setActiveProjectRegistration(first.primaryRoot);
      await expect(getActiveHybridWorkspacePreference(first.id)).resolves.toMatchObject({
        projectId: first.id,
        mode: "novel",
      });
      const restartedProjection = await getActiveProjectStateReadOnly();
      expect(restartedProjection?.workspacePreferences).toEqual({
        [first.id]: expect.objectContaining({ mode: "novel" }),
        [second.id]: expect.objectContaining({ mode: "drama" }),
      });

      await setActiveProjectRegistration(drama.primaryRoot);
      const dramaActiveRaw = await readJson<Record<string, unknown>>(activeProjectPath, {});
      expect(dramaActiveRaw).toMatchObject({ schemaVersion: 2, primaryRoot: drama.primaryRoot });
      expect(dramaActiveRaw).not.toHaveProperty("workspacePreferences");
      await setActiveProjectRegistration(first.primaryRoot);
      await expect(getActiveHybridWorkspacePreference(first.id)).resolves.toMatchObject({ mode: "novel" });
    } finally {
      if (previousRegistryPath === undefined) delete process.env.AI_CANVAS_REGISTRY_PATH;
      else process.env.AI_CANVAS_REGISTRY_PATH = previousRegistryPath;
    }
  });

  it("drama/novel 工程和非法值不能写 hybrid 偏好，也不创建小说目录", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-nonhybrid-workspace-preference-"));
    roots.push(base);
    const registryPath = path.join(base, "registry", "projects.json");
    const activeProjectPath = path.join(path.dirname(registryPath), "active-project.json");
    const previousRegistryPath = process.env.AI_CANVAS_REGISTRY_PATH;
    process.env.AI_CANVAS_REGISTRY_PATH = registryPath;
    try {
      const drama = await ensureSidecar(path.join(base, "drama"));
      const novel = await ensureSidecar(path.join(base, "novel"));
      const dramaManifestPath = await writeManagedWorkspaceManifest(drama.primaryRoot, drama.id, "drama");
      const novelManifestPath = await writeManagedWorkspaceManifest(novel.primaryRoot, novel.id, "novel");
      await registerProject(drama);
      await registerProject(novel);
      const dramaManifestBefore = await readFile(dramaManifestPath);
      const novelManifestBefore = await readFile(novelManifestPath);

      await setActiveProjectRegistration(drama.primaryRoot);
      await expect(getActiveHybridWorkspacePreference(drama.id)).rejects.toThrow("只有 schema v2 hybrid");
      await expect(setActiveHybridWorkspacePreference(drama.id, "novel")).rejects.toThrow("只有 schema v2 hybrid");
      expect(await readJson<Record<string, unknown>>(activeProjectPath, {})).toMatchObject({ schemaVersion: 2 });

      await setActiveProjectRegistration(novel.primaryRoot);
      await expect(setActiveHybridWorkspacePreference(novel.id, "drama")).rejects.toThrow("只有 schema v2 hybrid");
      await expect(setActiveHybridWorkspacePreference(novel.id, "canvas" as never)).rejects.toThrow("mode 无效");
      expect(await readJson<Record<string, unknown>>(activeProjectPath, {})).toMatchObject({ schemaVersion: 3 });

      expect(await readFile(dramaManifestPath)).toEqual(dramaManifestBefore);
      expect(await readFile(novelManifestPath)).toEqual(novelManifestBefore);
      for (const projectRoot of [drama.primaryRoot, novel.primaryRoot]) {
        await expect(stat(path.join(projectRoot, "manuscript"))).rejects.toMatchObject({ code: "ENOENT" });
        await expect(stat(path.join(projectRoot, "story-bible"))).rejects.toMatchObject({ code: "ENOENT" });
        await expect(stat(path.join(getSidecarPaths(projectRoot).root, "novel"))).rejects.toMatchObject({ code: "ENOENT" });
      }
    } finally {
      if (previousRegistryPath === undefined) delete process.env.AI_CANVAS_REGISTRY_PATH;
      else process.env.AI_CANVAS_REGISTRY_PATH = previousRegistryPath;
    }
  });

  it("旧 v1/v2 sidecar 只读时保持原字节，v2 工程后续写入升级 v3，future schema 失败关闭", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-workspace-preference-schema-"));
    roots.push(base);
    const registryPath = path.join(base, "registry", "projects.json");
    const activeProjectPath = path.join(path.dirname(registryPath), "active-project.json");
    const previousRegistryPath = process.env.AI_CANVAS_REGISTRY_PATH;
    process.env.AI_CANVAS_REGISTRY_PATH = registryPath;
    try {
      const hybrid = await ensureSidecar(path.join(base, "hybrid"));
      await writeManagedWorkspaceManifest(hybrid.primaryRoot, hybrid.id, "hybrid");
      await registerProject(hybrid);
      const legacyUpdatedAt = "2026-08-01T00:00:00.000Z";
      await writeJsonAtomic(activeProjectPath, {
        schemaVersion: 1,
        primaryRoot: hybrid.primaryRoot,
        updatedAt: legacyUpdatedAt,
      });

      const legacyBeforeGet = await readFile(activeProjectPath);
      await expect(getActiveHybridWorkspacePreference(hybrid.id)).resolves.toBeNull();
      expect(await readFile(activeProjectPath)).toEqual(legacyBeforeGet);
      expect(await getActiveProjectStateReadOnly()).toMatchObject({
        schemaVersion: 3,
        primaryRoot: hybrid.primaryRoot,
        workspacePreferences: {},
      });

      await setActiveStudioContext(hybrid.primaryRoot, { mode: "canvas" });
      expect(await readJson<Record<string, unknown>>(activeProjectPath, {})).toMatchObject({
        schemaVersion: 3,
        studio: { mode: "canvas" },
      });
      expect(await readJson<Record<string, unknown>>(activeProjectPath, {})).not.toHaveProperty("workspacePreferences");

      await setActiveHybridWorkspacePreference(hybrid.id, "novel");
      const versionThree = await readJson<Record<string, unknown>>(activeProjectPath, {});
      expect(versionThree).toMatchObject({
        schemaVersion: 3,
      });
      expect(versionThree).not.toHaveProperty("workspacePreferences");
      expect(await readJson<Record<string, unknown>>(getWorkspacePreferencesV2Path(), {})).toMatchObject({
        preferences: { [hybrid.id]: { mode: "novel" } },
      });

      await writeJsonAtomic(activeProjectPath, { ...versionThree, schemaVersion: 4 });
      const futureBeforeRead = await readFile(activeProjectPath);
      await expect(getActiveProjectStateReadOnly()).rejects.toThrow("活动项目状态已损坏");
      await expect(getActiveHybridWorkspacePreference(hybrid.id)).rejects.toThrow("活动项目状态已损坏");
      await expect(setActiveHybridWorkspacePreference(hybrid.id, "drama")).rejects.toThrow("活动项目状态已损坏");
      expect(await readFile(activeProjectPath)).toEqual(futureBeforeRead);
    } finally {
      if (previousRegistryPath === undefined) delete process.env.AI_CANVAS_REGISTRY_PATH;
      else process.env.AI_CANVAS_REGISTRY_PATH = previousRegistryPath;
    }
  });
});
