import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendEvent, assertProjectRegistryWriteIsIsolated, diagnoseProjectRegistryEntries, ensureSidecar, getSidecarPaths, listEvents, listTaskPacks, pruneUnavailableRegisteredProjects, readJson, registerProject, saveRegisteredProjects, unregisterProject, writeJsonAtomic, writeTextAtomic } from "../src/core/sidecar.js";
import { activateProject, getActiveProject, listProjects } from "../src/core/service.js";

const roots: string[] = [];
const execFileAsync = promisify(execFile);

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
});
