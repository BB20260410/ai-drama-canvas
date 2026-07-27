import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createManagedProject,
  readManagedProjectBootstrapClaim,
  resumeManagedProjectBootstrap,
} from "../src/core/managed-project.js";
import {
  createManagedStudioProject,
  ensureManagedProjectCreatedEvent,
  getActiveProject,
  getActiveProjectReadOnly,
} from "../src/core/service.js";
import { getMaterialStudioState } from "../src/core/material-studio.js";
import { getStudioProductionState } from "../src/core/studio-production.js";
import { getStudioGenerationLedgerState } from "../src/core/studio-generation-ledger.js";
import { appendEvent, listEvents } from "../src/core/sidecar.js";

let temporaryRoot = "";
let priorRegistryPath: string | undefined;

beforeEach(async () => {
  temporaryRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "ai-canvas-managed-service-")));
  priorRegistryPath = process.env.AI_CANVAS_REGISTRY_PATH;
  process.env.AI_CANVAS_REGISTRY_PATH = path.join(temporaryRoot, "registry", "projects.json");
});

afterEach(async () => {
  if (priorRegistryPath === undefined) delete process.env.AI_CANVAS_REGISTRY_PATH;
  else process.env.AI_CANVAS_REGISTRY_PATH = priorRegistryPath;
  await rm(temporaryRoot, { recursive: true, force: true });
});

describe("受管工程创建事实", () => {
  it("活动项目 UI 投影不创建 registry lock 或改写登记文件", async () => {
    const shell = await createManagedStudioProject({
      parentRoot: temporaryRoot,
      name: "活动项目物理只读测试",
      slug: "active-readonly",
    });
    const registryPath = process.env.AI_CANVAS_REGISTRY_PATH!;
    const registryRoot = path.dirname(registryPath);
    const activeProjectPath = path.join(registryRoot, "active-project.json");
    const locksRoot = path.join(registryRoot, "locks");
    await mkdir(locksRoot, { recursive: true });
    const [registryBefore, activeBefore, lockNamesBefore, lockStatBefore] = await Promise.all([
      readFile(registryPath),
      readFile(activeProjectPath),
      readdir(locksRoot),
      stat(locksRoot, { bigint: true }),
    ]);

    await expect(getActiveProjectReadOnly()).resolves.toMatchObject({
      id: shell.project.id,
      primaryRoot: shell.paths.root,
      available: true,
    });

    const [registryAfter, activeAfter, lockNamesAfter, lockStatAfter] = await Promise.all([
      readFile(registryPath),
      readFile(activeProjectPath),
      readdir(locksRoot),
      stat(locksRoot, { bigint: true }),
    ]);
    expect(registryAfter).toEqual(registryBefore);
    expect(activeAfter).toEqual(activeBefore);
    expect(lockNamesAfter).toEqual(lockNamesBefore);
    expect(lockStatAfter.mtimeNs).toBe(lockStatBefore.mtimeNs);

    await rm(locksRoot, { recursive: true, force: true });
    await expect(getActiveProjectReadOnly()).resolves.toMatchObject({
      id: shell.project.id,
      primaryRoot: shell.paths.root,
    });
    await expect(stat(locksRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("服务成功创建时只写 managed_created，并保持三库与活动指针为空且隔离", async () => {
    const shell = await createManagedStudioProject({ parentRoot: temporaryRoot, name: "受管工程事实测试", slug: "managed-event" });
    const [events, active, material, production, generation] = await Promise.all([
      listEvents(shell.paths.root),
      getActiveProject(),
      getMaterialStudioState(shell.paths.root),
      getStudioProductionState(shell.paths.root),
      getStudioGenerationLedgerState(shell.paths.root),
    ]);

    expect(active).toMatchObject({ id: shell.project.id, primaryRoot: shell.paths.root, available: true });
    expect(shell.project.sourceRoots).toEqual([]);
    expect(shell.project.outputRoots).toEqual([shell.paths.root]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: `project-managed-created-${shell.project.id}`,
      idempotencyKey: `project-managed-created-${shell.project.id}`,
      actor: "app",
      type: "project.managed_created",
      data: {
        projectMode: "story_first",
        projectId: shell.project.id,
        name: shell.project.name,
        sourceRoots: [],
        outputRoots: [shell.paths.root],
        startupPolicy: "no-filesystem-scan",
        manifestFingerprint: shell.manifestFingerprint,
      },
    });
    expect(events.some((event) => event.type === "project.imported")).toBe(false);
    expect(Object.values(material.counts).every((count) => count === 0)).toBe(true);
    expect(Object.values(production.counts).every((count) => count === 0)).toBe(true);
    expect(generation.counts).toEqual({
      packs: 0,
      dispatches: 0,
      results: 0,
      pendingResults: 0,
      staleAtRegistrationResults: 0,
      plans: 0,
      runEvents: 0,
      targetExtensions: 0,
      callIntents: 0,
      callEvents: 0,
      historicalImports: 0,
      detachedUnknownObservations: 0,
      detachedUnknownDispositions: 0,
    });

    const replay = await ensureManagedProjectCreatedEvent(shell);
    expect(replay.replayed).toBe(true);
    expect(await listEvents(shell.paths.root)).toHaveLength(1);
  });

  it("并发首次记录只追加一条，冲突的同 key 历史失败关闭", async () => {
    const shell = await createManagedProject({ parentRoot: temporaryRoot, name: "并发重放", slug: "managed-replay" });
    const receipts = await Promise.all([
      ensureManagedProjectCreatedEvent(shell),
      ensureManagedProjectCreatedEvent(shell),
      ensureManagedProjectCreatedEvent(shell),
    ]);
    expect(receipts.filter((receipt) => !receipt.replayed)).toHaveLength(1);
    expect(receipts.filter((receipt) => receipt.replayed)).toHaveLength(2);
    expect(await listEvents(shell.paths.root)).toHaveLength(1);

    const conflict = await createManagedProject({ parentRoot: temporaryRoot, name: "冲突历史", slug: "managed-conflict" });
    const idempotencyKey = `project-managed-created-${conflict.project.id}`;
    await appendEvent(conflict.paths.root, {
      id: idempotencyKey,
      idempotencyKey,
      actor: "app",
      type: "project.managed_created",
      data: { projectMode: "filesystem", projectId: conflict.project.id },
    });
    await expect(ensureManagedProjectCreatedEvent(conflict)).rejects.toThrow("与当前 manifest 冲突");
    expect(await listEvents(conflict.paths.root)).toHaveLength(1);
  });

  it("只恢复空的专属 bootstrap 根，claim/工程身份幂等且不污染注册表", async () => {
    const projectRoot = path.join(temporaryRoot, "bootstrap-orphan");
    await mkdir(projectRoot, { mode: 0o700 });
    const options = {
      name: "Bootstrap 恢复测试",
      bootstrapClaim: {
        purpose: "p30-bootstrap-test",
        payload: { schemaVersion: 1, sourceFingerprint: "a".repeat(64) },
      },
    };
    const first = await resumeManagedProjectBootstrap(projectRoot, options);
    const firstClaim = await readManagedProjectBootstrapClaim(projectRoot);
    const manifestBefore = await readFile(first.paths.manifest);
    const replay = await resumeManagedProjectBootstrap(projectRoot, options);
    const replayClaim = await readManagedProjectBootstrapClaim(projectRoot);
    expect(replay).toMatchObject({
      project: { id: first.project.id, name: first.project.name },
      paths: { root: first.paths.root },
      counts: { total: 0, items: 0, artifacts: 0 },
    });
    expect(replayClaim).toEqual(firstClaim);
    expect(await readFile(replay.paths.manifest)).toEqual(manifestBefore);
    expect(await getActiveProject()).toBeNull();
  });

  it("bootstrap 恢复拒绝接管含外来内容或非 claim 临时文件的根", async () => {
    const options = {
      name: "Bootstrap 拒绝测试",
      bootstrapClaim: {
        purpose: "p30-bootstrap-test",
        payload: { schemaVersion: 1, sourceFingerprint: "b".repeat(64) },
      },
    };
    const foreignRoot = path.join(temporaryRoot, "foreign-root");
    await mkdir(foreignRoot, { mode: 0o700 });
    await writeFile(path.join(foreignRoot, "user-file.txt"), "do not touch\n");
    await expect(resumeManagedProjectBootstrap(foreignRoot, options)).rejects.toThrow(/并非可证明空 bootstrap orphan/u);
    expect(await readFile(path.join(foreignRoot, "user-file.txt"), "utf8")).toBe("do not touch\n");

    const sidecarRoot = path.join(temporaryRoot, "foreign-sidecar-root");
    await mkdir(path.join(sidecarRoot, ".aicanvas"), { recursive: true, mode: 0o700 });
    await writeFile(path.join(sidecarRoot, ".aicanvas", "foreign.db"), "do not touch\n");
    await expect(resumeManagedProjectBootstrap(sidecarRoot, options)).rejects.toThrow(/含非临时内容/u);
    expect(await readFile(path.join(sidecarRoot, ".aicanvas", "foreign.db"), "utf8")).toBe("do not touch\n");

    const claimedRoot = path.join(temporaryRoot, "claimed-then-damaged-root");
    await mkdir(claimedRoot, { mode: 0o700 });
    const claimed = await resumeManagedProjectBootstrap(claimedRoot, options);
    const configBefore = await readFile(claimed.paths.config);
    await writeFile(path.join(claimedRoot, "user-file.txt"), "preserve me\n");
    await rm(claimed.paths.manifest);
    await expect(resumeManagedProjectBootstrap(claimedRoot, options)).rejects.toThrow(/不是可证明安全/u);
    expect(await readFile(path.join(claimedRoot, "user-file.txt"), "utf8")).toBe("preserve me\n");
    expect(await readFile(claimed.paths.config)).toEqual(configBefore);
  });
});
