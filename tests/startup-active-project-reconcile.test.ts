import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createManagedProject } from "../src/core/managed-project.js";
import {
  __setAfterActiveManagedProjectStartupSecondPreflightHookForTests,
  activateProject,
  getActiveProjectReadOnly,
  getManagedProjectShell,
  preflightActiveManagedProjectStartupReadOnly,
  reconcileActiveManagedProjectStartup,
  reconcileActiveManagedProjectStartupWithLifecycle,
} from "../src/core/service.js";
import {
  ensureSidecar,
  getProjectRegistryV2Path,
  getWorkspacePreferencesV2Path,
  __setAfterActiveProjectStateSnapshotHookForTests,
  reconcileActiveProjectStartup,
  registerProject,
  setActiveProjectRegistration,
  writeJsonAtomic,
} from "../src/core/sidecar.js";

let temporaryRoot = "";
let priorRegistryPath: string | undefined;

async function createRegisteredManagedProject(name: string, workspaceMode: "drama" | "novel" | "hybrid" = "drama") {
  const projectsRoot = path.join(temporaryRoot, "projects");
  await mkdir(projectsRoot, { recursive: true });
  const shell = await createManagedProject({ parentRoot: projectsRoot, name, workspaceMode });
  await registerProject(shell.project);
  return shell;
}

async function activeExpectation() {
  const active = await getActiveProjectReadOnly();
  if (!active?.available) throw new Error("测试前必须存在可用活动工程。 ");
  return { projectRoot: active.primaryRoot, activationId: active.activationId };
}

async function readOrMissing(filePath: string): Promise<string> {
  return readFile(filePath, "utf8").catch((error: unknown) => {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return "<missing>";
    throw error;
  });
}

beforeEach(async () => {
  temporaryRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "ai-canvas-startup-reconcile-")));
  priorRegistryPath = process.env.AI_CANVAS_REGISTRY_PATH;
  process.env.AI_CANVAS_REGISTRY_PATH = path.join(temporaryRoot, "registry", "projects.json");
});

afterEach(async () => {
  __setAfterActiveProjectStateSnapshotHookForTests(null);
  __setAfterActiveManagedProjectStartupSecondPreflightHookForTests(null);
  if (priorRegistryPath === undefined) delete process.env.AI_CANVAS_REGISTRY_PATH;
  else process.env.AI_CANVAS_REGISTRY_PATH = priorRegistryPath;
  await rm(temporaryRoot, { recursive: true, force: true });
});

describe("同根冷启动 startup reconcile", () => {
  it("健康活动工程 preflight 为物理只读；旧 active schema 或 legacy-v2 泄漏明确要求 repair", async () => {
    const shell = await createRegisteredManagedProject("preflight 健康工程", "novel");
    await setActiveProjectRegistration(shell.paths.root);
    const registryPath = process.env.AI_CANVAS_REGISTRY_PATH!;
    const activePath = path.join(path.dirname(registryPath), "active-project.json");
    const before = await Promise.all([
      readOrMissing(registryPath),
      readOrMissing(activePath),
      readOrMissing(getProjectRegistryV2Path()),
      readOrMissing(getWorkspacePreferencesV2Path()),
    ]);
    const active = await activeExpectation();
    const locksRoot = path.join(path.dirname(registryPath), "locks");
    await rm(locksRoot, { recursive: true, force: true });

    await expect(preflightActiveManagedProjectStartupReadOnly(active)).resolves.toMatchObject({
      kind: "healthy",
      shell: { project: { id: shell.project.id }, paths: { root: shell.paths.root } },
    });
    await expect(Promise.all([
      readOrMissing(registryPath),
      readOrMissing(activePath),
      readOrMissing(getProjectRegistryV2Path()),
      readOrMissing(getWorkspacePreferencesV2Path()),
    ])).resolves.toEqual(before);
    await expect(lstat(locksRoot)).rejects.toMatchObject({ code: "ENOENT" });

    await writeJsonAtomic(activePath, {
      schemaVersion: 2,
      primaryRoot: shell.paths.root,
      activationId: active.activationId,
      activatedAt: "2026-08-14T00:00:00.000Z",
      updatedAt: "2026-08-14T00:00:00.000Z",
    });
    await expect(preflightActiveManagedProjectStartupReadOnly(active)).resolves.toMatchObject({
      kind: "repair-required",
      reason: "active-project-writer-fence",
    });

    await writeJsonAtomic(registryPath, [{
      id: shell.project.id,
      name: shell.project.name,
      primaryRoot: shell.paths.root,
      updatedAt: shell.project.updatedAt,
    }]);
    await expect(preflightActiveManagedProjectStartupReadOnly(active)).resolves.toMatchObject({
      kind: "repair-required",
      reason: "legacy-v2-registry-leak",
    });
  });

  it("preflight 在 CAS 变化时失败关闭，不能猜测健康", async () => {
    const first = await createRegisteredManagedProject("preflight CAS A");
    const second = await createRegisteredManagedProject("preflight CAS B");
    await setActiveProjectRegistration(first.paths.root);
    const active = await activeExpectation();
    __setAfterActiveProjectStateSnapshotHookForTests(async () => {
      await setActiveProjectRegistration(second.paths.root);
    });
    await expect(preflightActiveManagedProjectStartupReadOnly(active))
      .rejects.toThrow("active project startup preflight snapshot changed while reading");
  });

  it("第二次 sidecar preflight 后活动工程切换也必须失败关闭", async () => {
    const first = await createRegisteredManagedProject("preflight 尾窗 A");
    const second = await createRegisteredManagedProject("preflight 尾窗 B");
    await setActiveProjectRegistration(first.paths.root);
    const active = await activeExpectation();
    __setAfterActiveManagedProjectStartupSecondPreflightHookForTests(async () => {
      await setActiveProjectRegistration(second.paths.root);
    });
    await expect(preflightActiveManagedProjectStartupReadOnly(active))
      .rejects.toThrow("活动工程启动快照已变化");
  });

  it("稳定 schema-1 drama/legacy 受管工程也走零写快路；v2 落入 legacy 仍必须 repair", async () => {
    const shell = await createRegisteredManagedProject("preflight drama legacy", "drama");
    await setActiveProjectRegistration(shell.paths.root);
    const active = await activeExpectation();
    const registryPath = process.env.AI_CANVAS_REGISTRY_PATH!;
    const activePath = path.join(path.dirname(registryPath), "active-project.json");
    expect(JSON.parse(await readFile(activePath, "utf8"))).toMatchObject({ schemaVersion: 2 });
    const locksRoot = path.join(path.dirname(registryPath), "locks");
    const before = await Promise.all([
      readOrMissing(registryPath),
      readOrMissing(activePath),
      readOrMissing(getProjectRegistryV2Path()),
    ]);
    await rm(locksRoot, { recursive: true, force: true });

    await expect(preflightActiveManagedProjectStartupReadOnly(active)).resolves.toMatchObject({
      kind: "healthy",
      shell: {
        workspaceMode: "drama",
        manifest: { schemaVersion: 1 },
        project: { id: shell.project.id },
      },
    });
    await expect(Promise.all([
      readOrMissing(registryPath),
      readOrMissing(activePath),
      readOrMissing(getProjectRegistryV2Path()),
    ])).resolves.toEqual(before);
    await expect(lstat(locksRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("健康同根只做锁内验证，不改写活动指针、偏好或注册表", async () => {
    const shell = await createRegisteredManagedProject("同根健康工程", "hybrid");
    await setActiveProjectRegistration(shell.paths.root);
    const registryPath = process.env.AI_CANVAS_REGISTRY_PATH!;
    const activePath = path.join(path.dirname(registryPath), "active-project.json");
    const v2Path = getProjectRegistryV2Path();
    const preferencePath = getWorkspacePreferencesV2Path();
    const before = await Promise.all([
      readOrMissing(registryPath),
      readOrMissing(activePath),
      readOrMissing(v2Path),
      readOrMissing(preferencePath),
    ]);

    await expect(reconcileActiveManagedProjectStartup(await activeExpectation()))
      .resolves.toMatchObject({ project: { id: shell.project.id }, paths: { root: shell.paths.root } });

    const after = await Promise.all([
      readOrMissing(registryPath),
      readOrMissing(activePath),
      readOrMissing(v2Path),
      readOrMissing(preferencePath),
    ]);
    expect(after).toEqual(before);
  });

  it("仅修复早期 legacy 泄漏与旧 active schema，保留同一 activationId", async () => {
    const shell = await createRegisteredManagedProject("泄漏修复工程", "novel");
    await setActiveProjectRegistration(shell.paths.root);
    const registryPath = process.env.AI_CANVAS_REGISTRY_PATH!;
    const activePath = path.join(path.dirname(registryPath), "active-project.json");
    const before = await activeExpectation();
    await writeJsonAtomic(registryPath, [{
      id: shell.project.id,
      name: shell.project.name,
      primaryRoot: shell.paths.root,
      updatedAt: shell.project.updatedAt,
    }]);
    await writeJsonAtomic(activePath, {
      schemaVersion: 2,
      primaryRoot: shell.paths.root,
      activationId: before.activationId,
      activatedAt: "2026-08-11T00:00:00.000Z",
      updatedAt: "2026-08-11T00:00:00.000Z",
    });

    await expect(reconcileActiveManagedProjectStartup(before)).resolves.toMatchObject({
      project: { id: shell.project.id },
    });
    expect(JSON.parse(await readFile(registryPath, "utf8"))).toEqual([]);
    expect(JSON.parse(await readFile(activePath, "utf8"))).toMatchObject({
      schemaVersion: 3,
      primaryRoot: shell.paths.root,
      activationId: before.activationId,
    });
    expect(JSON.parse(await readFile(getProjectRegistryV2Path(), "utf8"))).toMatchObject({
      projects: [expect.objectContaining({ id: shell.project.id, primaryRoot: shell.paths.root })],
    });
  });

  it("外部切换或 A→B→A 后旧快照稳定冲突，绝不把旧 activation 重新激活", async () => {
    const first = await createRegisteredManagedProject("工程 A");
    const second = await createRegisteredManagedProject("工程 B");
    await setActiveProjectRegistration(first.paths.root);
    const staleA = await activeExpectation();

    await setActiveProjectRegistration(second.paths.root);
    await expect(reconcileActiveManagedProjectStartup(staleA)).rejects.toThrow("活动工程启动快照已变化");
    expect((await getActiveProjectReadOnly())?.primaryRoot).toBe(second.paths.root);

    await setActiveProjectRegistration(first.paths.root);
    const freshA = await activeExpectation();
    await setActiveProjectRegistration(second.paths.root);
    await setActiveProjectRegistration(first.paths.root);
    await expect(reconcileActiveManagedProjectStartup(freshA)).rejects.toThrow("活动工程启动快照已变化");
    const after = await getActiveProjectReadOnly();
    expect(after?.primaryRoot).toBe(first.paths.root);
    expect(after?.activationId).not.toBe(freshA.activationId);
  });

  it("reconcile 在 validate 期间只占 registry 锁，释放后先完成 A 对账再允许切换 B", async () => {
    const first = await createRegisteredManagedProject("对账锁工程 A");
    const second = await createRegisteredManagedProject("对账锁工程 B");
    await setActiveProjectRegistration(first.paths.root);
    const expected = await activeExpectation();

    let resolveValidateEntered!: () => void;
    const validateEntered = new Promise<void>((resolve) => {
      resolveValidateEntered = resolve;
    });
    let releaseValidate!: () => void;
    const validateRelease = new Promise<void>((resolve) => {
      releaseValidate = resolve;
    });
    const reconcile = reconcileActiveProjectStartup({
      primaryRoot: expected.projectRoot,
      activationId: expected.activationId,
    }, async (registration) => {
      resolveValidateEntered();
      await validateRelease;
      return registration.id;
    });

    await validateEntered;
    let switchSettled = false;
    const switchToSecond = setActiveProjectRegistration(second.paths.root).finally(() => {
      switchSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(switchSettled).toBe(false);
    await expect(getActiveProjectReadOnly()).resolves.toMatchObject({
      primaryRoot: first.paths.root,
      activationId: expected.activationId,
    });

    releaseValidate();
    await expect(reconcile).resolves.toMatchObject({
      registration: { id: first.project.id, primaryRoot: first.paths.root },
      value: first.project.id,
    });
    await switchToSecond;
    await expect(getActiveProjectReadOnly()).resolves.toMatchObject({ primaryRoot: second.paths.root });
  });

  it("watcher 生命周期在同一 CAS 锁内挂载，B 激活不能插入 A 的确认与挂载之间", async () => {
    const first = await createRegisteredManagedProject("watcher CAS A");
    const second = await createRegisteredManagedProject("watcher CAS B");
    await setActiveProjectRegistration(first.paths.root);
    const expected = await activeExpectation();
    let resolveMounted!: () => void;
    const mounted = new Promise<void>((resolve) => { resolveMounted = resolve; });
    let releaseMount!: () => void;
    const mountRelease = new Promise<void>((resolve) => { releaseMount = resolve; });
    let mountedRoot = "";
    const reconcile = reconcileActiveManagedProjectStartupWithLifecycle(expected, async (shell) => {
      mountedRoot = shell.paths.root;
      resolveMounted();
      await mountRelease;
    });
    await mounted;
    let switchSettled = false;
    const switchToSecond = setActiveProjectRegistration(second.paths.root).finally(() => {
      switchSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(switchSettled).toBe(false);
    expect(mountedRoot).toBe(first.paths.root);
    releaseMount();
    await expect(reconcile).resolves.toMatchObject({ project: { id: first.project.id } });
    await switchToSecond;
    await expect(getActiveProjectReadOnly()).resolves.toMatchObject({ primaryRoot: second.paths.root });
  });

  it("活动只读投影使用 state+registration 双读稳定快照，并明确 v2 必须按受管启动", async () => {
    const first = await createRegisteredManagedProject("稳定快照 A");
    const second = await createRegisteredManagedProject("稳定快照 B");
    await setActiveProjectRegistration(first.paths.root);
    __setAfterActiveProjectStateSnapshotHookForTests(async () => {
      await setActiveProjectRegistration(second.paths.root);
      await setActiveProjectRegistration(first.paths.root);
    });
    await expect(getActiveProjectReadOnly()).rejects.toThrow("active project registration snapshot changed while reading");

    const novel = await createRegisteredManagedProject("v2 受管启动", "novel");
    await setActiveProjectRegistration(novel.paths.root);
    await expect(getActiveProjectReadOnly()).resolves.toMatchObject({
      primaryRoot: novel.paths.root,
      registrationLane: "v2",
      managedStartupRequired: true,
    });
  });

  it("v1 受管工程即使 manifest 遗失，仍由专用存储证据要求受管启动", async () => {
    const managed = await createRegisteredManagedProject("v1 managed manifest 遗失", "drama");
    await setActiveProjectRegistration(managed.paths.root);
    await rm(managed.paths.manifest);

    await expect(getActiveProjectReadOnly()).resolves.toMatchObject({
      primaryRoot: managed.paths.root,
      registrationLane: "legacy",
      managedStartupRequired: true,
    });
    await expect(reconcileActiveManagedProjectStartup(await activeExpectation()))
      .rejects.toThrow();
  });

  it("显式切换同样拒绝损坏的 v2 或有 v1 受管存储证据的工程，普通 legacy 保持可切换", async () => {
    const v1 = await createRegisteredManagedProject("显式 v1 manifest 遗失", "drama");
    const v2 = await createRegisteredManagedProject("显式 v2 manifest 遗失", "novel");
    const legacyRoot = path.join(temporaryRoot, "legacy-project");
    const legacy = await ensureSidecar(legacyRoot);
    await registerProject(legacy);
    await Promise.all([rm(v1.paths.manifest), rm(v2.paths.manifest)]);

    await expect(getManagedProjectShell(v1.paths.root)).rejects.toThrow();
    await expect(getManagedProjectShell(v2.paths.root)).rejects.toThrow();
    await expect(activateProject(v1.paths.root)).rejects.toThrow();
    await expect(activateProject(v2.paths.root)).rejects.toThrow();
    await expect(getManagedProjectShell(legacyRoot)).resolves.toBeNull();
    await expect(activateProject(legacyRoot)).resolves.toMatchObject({ primaryRoot: legacyRoot });
  });

  it("取消登记、根不可访问或损坏 manifest 均失败关闭，不补写活动身份", async () => {
    const damaged = await createRegisteredManagedProject("损坏 manifest");
    const unregistered = await createRegisteredManagedProject("未登记工程");
    const inaccessible = await createRegisteredManagedProject("不可访问工程");

    await setActiveProjectRegistration(unregistered.paths.root);
    const unregisteredExpected = await activeExpectation();
    const registryPath = process.env.AI_CANVAS_REGISTRY_PATH!;
    await writeJsonAtomic(
      registryPath,
      (JSON.parse(await readFile(registryPath, "utf8")) as Array<{ primaryRoot: string }>)
        .filter((entry) => entry.primaryRoot !== unregistered.paths.root),
    );
    const activeBeforeUnregistered = await readOrMissing(path.join(path.dirname(registryPath), "active-project.json"));
    await expect(reconcileActiveManagedProjectStartup(unregisteredExpected)).rejects.toThrow("活动工程登记已丢失");
    await expect(readOrMissing(path.join(path.dirname(registryPath), "active-project.json")))
      .resolves.toBe(activeBeforeUnregistered);

    await setActiveProjectRegistration(inaccessible.paths.root);
    const inaccessibleExpected = await activeExpectation();
    const activePath = path.join(path.dirname(registryPath), "active-project.json");
    const [registryBeforeMissing, activeBeforeMissing] = await Promise.all([
      readOrMissing(registryPath),
      readOrMissing(activePath),
    ]);
    await rename(inaccessible.paths.root, `${inaccessible.paths.root}-moved`);
    await expect(reconcileActiveManagedProjectStartup(inaccessibleExpected)).rejects.toThrow();
    await expect(Promise.all([readOrMissing(registryPath), readOrMissing(activePath)]))
      .resolves.toEqual([registryBeforeMissing, activeBeforeMissing]);

    // 损坏项目放在最后：compatibility repair 正确地会拒绝继续扫描该登记，测试不把
    // “损坏后再登记其他工程”的全局失败关闭误认为 reconcile 的行为。
    await setActiveProjectRegistration(damaged.paths.root);
    const damagedExpected = await activeExpectation();
    await writeFile(path.join(damaged.paths.root, ".aicanvas", "managed-project.json"), "{broken", "utf8");
    await expect(reconcileActiveManagedProjectStartup(damagedExpected)).rejects.toThrow();
  });
});
