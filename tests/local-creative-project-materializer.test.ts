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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { materializeLocalCreativeProject } from "../src/core/local-creative-project-materializer.js";
import {
  createManagedProject,
  readManagedProjectBootstrapClaim,
  resumeManagedProjectBootstrap,
} from "../src/core/managed-project.js";
import { listEvents, listRegisteredProjects } from "../src/core/sidecar.js";

let temporaryRoot = "";
let projectsRoot = "";
let sourceRoot = "";
let priorRegistryPath: string | undefined;
let priorBootstrapInterrupt: string | undefined;
let priorMaterializerInterrupt: string | undefined;

interface TreeEntry {
  type: "directory" | "file";
  size: number;
  mtimeMs: number;
  sha256?: string;
}

async function treeSnapshot(root: string): Promise<Record<string, TreeEntry>> {
  const snapshot: Record<string, TreeEntry> = {};
  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
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
        throw new Error(`测试快照出现非普通节点：${absolute}`);
      }
    }
  }
  await walk(root);
  return snapshot;
}

function descriptor(overrides: Record<string, unknown> = {}) {
  return {
    key: "test-story",
    name: "测试剧情工程",
    projectType: "story-production",
    resolution: "CREATE_MANAGED" as const,
    sources: [
      {
        root: sourceRoot,
        role: "PRIMARY_AUTHORITY",
        excludeRelativePrefixes: ["废稿"],
      },
    ],
    authorityPolicy: "EVIDENCE_REQUIRED",
    scanSummary: { discoveredFiles: 2, images: 1, documents: 1 },
    ...overrides,
  };
}

beforeEach(async () => {
  temporaryRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "ai-canvas-local-materializer-")));
  projectsRoot = path.join(temporaryRoot, "projects");
  sourceRoot = path.join(temporaryRoot, "source");
  await Promise.all([mkdir(projectsRoot), mkdir(sourceRoot)]);
  await mkdir(path.join(sourceRoot, "剧本"));
  await writeFile(path.join(sourceRoot, "剧本", "EP01.md"), "# 第一集\n", "utf8");
  await writeFile(path.join(sourceRoot, "角色锁.png"), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  priorRegistryPath = process.env.AI_CANVAS_REGISTRY_PATH;
  priorBootstrapInterrupt = process.env.AI_CANVAS_TEST_MANAGED_BOOTSTRAP_INTERRUPT;
  priorMaterializerInterrupt = process.env.AI_CANVAS_TEST_LOCAL_PROJECT_MATERIALIZER_INTERRUPT;
  process.env.AI_CANVAS_REGISTRY_PATH = path.join(temporaryRoot, "registry", "projects.json");
});

afterEach(async () => {
  if (priorRegistryPath === undefined) delete process.env.AI_CANVAS_REGISTRY_PATH;
  else process.env.AI_CANVAS_REGISTRY_PATH = priorRegistryPath;
  if (priorBootstrapInterrupt === undefined) delete process.env.AI_CANVAS_TEST_MANAGED_BOOTSTRAP_INTERRUPT;
  else process.env.AI_CANVAS_TEST_MANAGED_BOOTSTRAP_INTERRUPT = priorBootstrapInterrupt;
  if (priorMaterializerInterrupt === undefined) delete process.env.AI_CANVAS_TEST_LOCAL_PROJECT_MATERIALIZER_INTERRUPT;
  else process.env.AI_CANVAS_TEST_LOCAL_PROJECT_MATERIALIZER_INTERRUPT = priorMaterializerInterrupt;
  await rm(temporaryRoot, { recursive: true, force: true });
});

describe("本机剧情/生图项目受管物化", () => {
  it("新建 local-import 工程、登记创建事实与清单，保持活动指针和源目录不变", async () => {
    const registryPath = process.env.AI_CANVAS_REGISTRY_PATH!;
    const activePath = path.join(path.dirname(registryPath), "active-project.json");
    const anchorRoot = path.join(temporaryRoot, "active-anchor");
    await mkdir(path.dirname(registryPath), { recursive: true });
    await mkdir(anchorRoot);
    await writeFile(registryPath, `${JSON.stringify([{
      id: "anchor-project",
      name: "既有活动工程",
      primaryRoot: anchorRoot,
      updatedAt: "2026-07-25T00:00:00.000Z",
    }], null, 2)}\n`, "utf8");
    await writeFile(activePath, `${JSON.stringify({
      schemaVersion: 2,
      primaryRoot: anchorRoot,
      activationId: "12345678-1234-1234-1234-123456789abc",
      activatedAt: "2026-07-25T00:00:00.000Z",
      updatedAt: "2026-07-25T00:00:00.000Z",
    }, null, 2)}\n`, "utf8");
    const [activeBefore, sourceBefore] = await Promise.all([readFile(activePath), treeSnapshot(sourceRoot)]);

    const result = await materializeLocalCreativeProject({
      projectsRoot,
      project: descriptor(),
    });

    expect(result.disposition).toBe("created");
    expect(path.dirname(result.projectRoot)).toBe(projectsRoot);
    expect(path.basename(result.projectRoot)).toMatch(/^local-import-test-story-[a-f0-9]{8}$/u);
    expect(result.registered).toBe(true);
    expect(result.ingestManifestPath).toBe(path.join(result.projectRoot, ".aicanvas/local-creative-project-ingest.json"));
    expect(await readFile(activePath)).toEqual(activeBefore);
    expect(await treeSnapshot(sourceRoot)).toEqual(sourceBefore);

    const [manifest, claim, events, registry] = await Promise.all([
      readFile(result.ingestManifestPath!, "utf8").then((content) => JSON.parse(content) as Record<string, any>),
      readManagedProjectBootstrapClaim(result.projectRoot),
      listEvents(result.projectRoot),
      listRegisteredProjects(),
    ]);
    expect(claim).toMatchObject({
      purpose: "local-creative-import",
      payload: {
        schemaVersion: 1,
        projectKey: "test-story",
        projectName: "测试剧情工程",
        projectType: "story-production",
        resolution: "CREATE_MANAGED",
      },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "project.managed_created" });
    expect(registry).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: result.projectId, primaryRoot: result.projectRoot }),
      expect.objectContaining({ id: "anchor-project", primaryRoot: anchorRoot }),
    ]));
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      kind: "local-creative-project-ingest",
      project: {
        key: "test-story",
        name: "测试剧情工程",
        type: "story-production",
        resolution: "CREATE_MANAGED",
        projectId: result.projectId,
        projectRoot: result.projectRoot,
      },
      sourceLayers: [{
        order: 0,
        root: sourceRoot,
        role: "PRIMARY_AUTHORITY",
        excludeRelativePrefixes: ["废稿"],
      }],
      authorityPolicy: "EVIDENCE_REQUIRED",
      scanSummary: { discoveredFiles: 2, documents: 1, images: 1 },
      bootstrapClaimFingerprint: claim!.fingerprint,
    });
    expect(manifest.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("ingest manifest 原子复验完成前不注册；中断后可幂等续跑", async () => {
    await mkdir(path.dirname(process.env.AI_CANVAS_REGISTRY_PATH!), { recursive: true });
    await writeFile(process.env.AI_CANVAS_REGISTRY_PATH!, "[]\n", "utf8");
    process.env.AI_CANVAS_TEST_LOCAL_PROJECT_MATERIALIZER_INTERRUPT = "after-ingest-before-register";

    await expect(materializeLocalCreativeProject({
      projectsRoot,
      project: descriptor(),
    })).rejects.toThrow(/after-ingest-before-register/u);
    delete process.env.AI_CANVAS_TEST_LOCAL_PROJECT_MATERIALIZER_INTERRUPT;

    const projectName = (await readdir(projectsRoot))
      .find((name) => /^local-import-test-story-[a-f0-9]{8}$/u.test(name));
    expect(projectName).toBeTruthy();
    const projectRoot = path.join(projectsRoot, projectName!);
    const ingestPath = path.join(projectRoot, ".aicanvas/local-creative-project-ingest.json");
    const ingest = JSON.parse(await readFile(ingestPath, "utf8")) as {
      kind: string;
      project: { projectRoot: string };
    };
    expect(ingest).toMatchObject({
      kind: "local-creative-project-ingest",
      project: { projectRoot },
    });
    expect(await listRegisteredProjects()).toEqual([]);
    expect(await listEvents(projectRoot)).toEqual([]);

    const recovered = await materializeLocalCreativeProject({
      projectsRoot,
      project: descriptor(),
    });
    expect(recovered).toMatchObject({
      projectRoot,
      disposition: "reused",
      registered: true,
      ingestManifestPath: ingestPath,
    });
    expect(await listRegisteredProjects()).toEqual([
      expect.objectContaining({ id: recovered.projectId, primaryRoot: projectRoot }),
    ]);
    expect(await listEvents(projectRoot)).toHaveLength(1);
  });

  it("相同描述幂等复用同一根，恢复 claim-only 中断且不重复事件或注册", async () => {
    const sourceBefore = await treeSnapshot(sourceRoot);
    const first = await materializeLocalCreativeProject({ projectsRoot, project: descriptor() });
    const firstManifest = await readFile(first.ingestManifestPath!);
    const firstRegistry = await readFile(process.env.AI_CANVAS_REGISTRY_PATH!);
    const replay = await materializeLocalCreativeProject({ projectsRoot, project: descriptor() });
    expect(replay).toMatchObject({
      projectRoot: first.projectRoot,
      projectId: first.projectId,
      disposition: "reused",
    });
    expect(await readFile(replay.ingestManifestPath!)).toEqual(firstManifest);
    expect(await readFile(process.env.AI_CANVAS_REGISTRY_PATH!)).toEqual(firstRegistry);
    expect(await listEvents(first.projectRoot)).toHaveLength(1);

    const sidecar = path.join(first.projectRoot, ".aicanvas");
    const entries = await readdir(sidecar);
    await Promise.all(entries
      .filter((entry) => entry !== "managed-bootstrap-claim.json")
      .map((entry) => rm(path.join(sidecar, entry), { recursive: true, force: true })));
    await Promise.all((await readdir(first.projectRoot))
      .filter((entry) => entry !== ".aicanvas")
      .map((entry) => rm(path.join(first.projectRoot, entry), { recursive: true, force: true })));
    await writeFile(process.env.AI_CANVAS_REGISTRY_PATH!, "[]\n", "utf8");

    const resumed = await materializeLocalCreativeProject({ projectsRoot, project: descriptor() });
    expect(resumed).toMatchObject({
      projectRoot: first.projectRoot,
      projectId: first.projectId,
      disposition: "resumed",
      registered: true,
    });
    expect(await listEvents(first.projectRoot)).toHaveLength(1);
    expect(await listRegisteredProjects()).toEqual([
      expect.objectContaining({ id: first.projectId, primaryRoot: first.projectRoot }),
    ]);
    expect(await treeSnapshot(sourceRoot)).toEqual(sourceBefore);
  });

  it("匹配 claim 的 DB 中段半成品可反复隔离恢复，旧文件永久保留且隐藏区不污染候选", async () => {
    const sourceBefore = await treeSnapshot(sourceRoot);
    const projectRoot = path.join(projectsRoot, "local-import-test-story-deadbeef");
    await mkdir(projectRoot, { mode: 0o700 });
    const bootstrapOptions = {
      name: "测试剧情工程",
      bootstrapClaim: {
        purpose: "local-creative-import",
        payload: {
          schemaVersion: 1,
          projectKey: "test-story",
          projectName: "测试剧情工程",
          projectType: "story-production",
          resolution: "CREATE_MANAGED",
        },
      },
    };

    // 第一次确定性中断发生在 config/index/cache/素材库/生产库均已落盘、最终 manifest 尚未写入时。
    process.env.AI_CANVAS_TEST_MANAGED_BOOTSTRAP_INTERRUPT = "after-storage";
    await expect(resumeManagedProjectBootstrap(projectRoot, bootstrapOptions))
      .rejects.toThrow(/after-storage/u);
    delete process.env.AI_CANVAS_TEST_MANAGED_BOOTSTRAP_INTERRUPT;

    const partialFiles = [
      ".aicanvas/project.json",
      ".aicanvas/index.json",
      ".aicanvas/cache.sqlite",
      ".aicanvas/material-studio.sqlite",
      ".aicanvas/studio-production.sqlite",
    ];
    const partialBytes = new Map<string, Buffer>();
    for (const relative of partialFiles) {
      partialBytes.set(relative, await readFile(path.join(projectRoot, relative)));
    }
    await expect(lstat(path.join(projectRoot, ".aicanvas/managed-project.json")))
      .rejects.toMatchObject({ code: "ENOENT" });

    // 同 slug 但 claim 语义不匹配时必须在隔离前失败关闭，原半成品不动。
    await expect(materializeLocalCreativeProject({
      projectsRoot,
      project: descriptor({ projectType: "different-story-type" }),
    })).rejects.toThrow(/claim 与项目描述不一致/u);
    for (const relative of partialFiles) {
      expect(await readFile(path.join(projectRoot, relative))).toEqual(partialBytes.get(relative));
    }
    await expect(lstat(path.join(projectsRoot, ".aicanvas-managed-bootstrap-quarantine")))
      .rejects.toMatchObject({ code: "ENOENT" });

    // 第二次中断落在“旧根已原子移动、原路径尚未重建”的最危险窗口。
    process.env.AI_CANVAS_TEST_MANAGED_BOOTSTRAP_INTERRUPT = "after-quarantine-rename";
    await expect(materializeLocalCreativeProject({ projectsRoot, project: descriptor() }))
      .rejects.toThrow(/after-quarantine-rename/u);
    delete process.env.AI_CANVAS_TEST_MANAGED_BOOTSTRAP_INTERRUPT;
    await expect(lstat(projectRoot)).rejects.toMatchObject({ code: "ENOENT" });

    const quarantine = path.join(projectsRoot, ".aicanvas-managed-bootstrap-quarantine");
    const ownerNames = (await readdir(quarantine))
      .filter((name) => /^owner-[a-f0-9]{64}$/u.test(name));
    expect(ownerNames).toHaveLength(1);
    const ownerRoot = path.join(quarantine, ownerNames[0]!);
    const firstCaseName = (await readdir(ownerRoot)).find((name) => /^case-[a-f0-9]{32}$/u.test(name));
    expect(firstCaseName).toBeTruthy();
    const firstQuarantinedRoot = path.join(ownerRoot, firstCaseName!, "project-root");
    for (const relative of partialFiles) {
      expect(await readFile(path.join(firstQuarantinedRoot, relative))).toEqual(partialBytes.get(relative));
    }

    // 第三次中断证明 recovery journal 能从“原路径缺失”状态重建 claim，
    // 并在再次形成半成品后继续下一轮恢复，而不是永久卡死同一 project key。
    process.env.AI_CANVAS_TEST_MANAGED_BOOTSTRAP_INTERRUPT = "after-storage";
    await expect(materializeLocalCreativeProject({ projectsRoot, project: descriptor() }))
      .rejects.toThrow(/after-storage/u);
    delete process.env.AI_CANVAS_TEST_MANAGED_BOOTSTRAP_INTERRUPT;
    expect((await readManagedProjectBootstrapClaim(projectRoot))?.purpose).toBe("local-creative-import");

    const recovered = await materializeLocalCreativeProject({ projectsRoot, project: descriptor() });
    expect(recovered).toMatchObject({
      projectRoot,
      disposition: "resumed",
      registered: true,
      projectFormat: "managed",
    });
    expect(recovered.shell?.paths.root).toBe(projectRoot);
    expect(await treeSnapshot(sourceRoot)).toEqual(sourceBefore);

    const quarantineEntries = await readdir(ownerRoot);
    const caseNames = quarantineEntries.filter((name) => /^case-[a-f0-9]{32}$/u.test(name));
    expect(caseNames).toHaveLength(2);
    for (const caseName of caseNames) {
      expect((await lstat(path.join(ownerRoot, caseName, "project-root"))).isDirectory()).toBe(true);
    }
    const recordName = quarantineEntries.find((name) => /^recovery-[a-f0-9]{64}\.json$/u.test(name));
    expect(recordName).toBeTruthy();
    const recoveryRecord = JSON.parse(await readFile(path.join(ownerRoot, recordName!), "utf8")) as {
      originalProjectRoot: string;
      attempts: Array<{
        replacementClaimFingerprint?: string;
        completedAt?: string;
        rebuiltProjectId?: string;
      }>;
    };
    expect(recoveryRecord.originalProjectRoot).toBe(projectRoot);
    expect(recoveryRecord.attempts).toHaveLength(2);
    expect(recoveryRecord.attempts[0]!.replacementClaimFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(recoveryRecord.attempts[0]!.completedAt).toBeUndefined();
    expect(recoveryRecord.attempts[1]).toMatchObject({
      replacementClaimFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
      completedAt: expect.any(String),
      rebuiltProjectId: recovered.projectId,
    });

    // 隐藏 quarantine 不会被普通候选扫描误算成第二个工程。
    const replay = await materializeLocalCreativeProject({ projectsRoot, project: descriptor() });
    expect(replay).toMatchObject({ projectRoot, projectId: recovered.projectId, disposition: "reused" });
  }, 120_000);

  it.each([
    "after-quarantine-replacement-root",
    "after-quarantine-replacement-claim",
  ] as const)("replacement 窗口 %s 中断后由普通候选续跑，并终结陈旧 journal", async (phase) => {
    const projectRoot = path.join(projectsRoot, "local-import-test-story-deadbeef");
    await mkdir(projectRoot, { mode: 0o700 });
    const bootstrapOptions = {
      name: "测试剧情工程",
      bootstrapClaim: {
        purpose: "local-creative-import",
        payload: {
          schemaVersion: 1,
          projectKey: "test-story",
          projectName: "测试剧情工程",
          projectType: "story-production",
          resolution: "CREATE_MANAGED",
        },
      },
    };
    process.env.AI_CANVAS_TEST_MANAGED_BOOTSTRAP_INTERRUPT = "after-storage";
    await expect(resumeManagedProjectBootstrap(projectRoot, bootstrapOptions))
      .rejects.toThrow(/after-storage/u);
    process.env.AI_CANVAS_TEST_MANAGED_BOOTSTRAP_INTERRUPT = phase;
    await expect(materializeLocalCreativeProject({ projectsRoot, project: descriptor() }))
      .rejects.toThrow(new RegExp(phase, "u"));
    delete process.env.AI_CANVAS_TEST_MANAGED_BOOTSTRAP_INTERRUPT;

    const recovered = await materializeLocalCreativeProject({ projectsRoot, project: descriptor() });
    expect(recovered).toMatchObject({
      projectRoot,
      disposition: "resumed",
      registered: true,
    });
    const claim = await readManagedProjectBootstrapClaim(projectRoot);
    expect(claim).not.toBeNull();

    const quarantine = path.join(projectsRoot, ".aicanvas-managed-bootstrap-quarantine");
    const ownerNames = (await readdir(quarantine))
      .filter((name) => /^owner-[a-f0-9]{64}$/u.test(name));
    expect(ownerNames).toHaveLength(1);
    const ownerRoot = path.join(quarantine, ownerNames[0]!);
    const recordName = (await readdir(ownerRoot))
      .find((name) => /^recovery-[a-f0-9]{64}\.json$/u.test(name));
    expect(recordName).toBeTruthy();
    const record = JSON.parse(await readFile(path.join(ownerRoot, recordName!), "utf8")) as {
      attempts: Array<{
        completedAt?: string;
        reconciledAt?: string;
        reconciledProjectId?: string;
        reconciledClaimFingerprint?: string;
      }>;
    };
    expect(record.attempts.at(-1)).toMatchObject({
      reconciledAt: expect.any(String),
      reconciledProjectId: recovered.projectId,
      reconciledClaimFingerprint: claim!.fingerprint,
    });
    expect(record.attempts.at(-1)!.completedAt).toBeUndefined();

    await rm(projectRoot, { recursive: true });
    await expect(materializeLocalCreativeProject({ projectsRoot, project: descriptor() }))
      .rejects.toThrow(/已重建/u);
  }, 120_000);

  it("坏 A owner recovery 不阻塞同父目录下 B owner 的 bootstrap 恢复", async () => {
    const descriptorA = descriptor({ key: "story-a", name: "剧情 A" });
    const descriptorB = descriptor({ key: "story-b", name: "剧情 B" });
    const rootA = path.join(projectsRoot, "local-import-story-a-deadbeef");
    const rootB = path.join(projectsRoot, "local-import-story-b-cafebabe");
    await Promise.all([mkdir(rootA, { mode: 0o700 }), mkdir(rootB, { mode: 0o700 })]);
    const bootstrapOptions = (projectKey: string, projectName: string) => ({
      name: projectName,
      bootstrapClaim: {
        purpose: "local-creative-import",
        payload: {
          schemaVersion: 1,
          projectKey,
          projectName,
          projectType: "story-production",
          resolution: "CREATE_MANAGED",
        },
      },
    });

    process.env.AI_CANVAS_TEST_MANAGED_BOOTSTRAP_INTERRUPT = "after-storage";
    await expect(resumeManagedProjectBootstrap(rootA, bootstrapOptions("story-a", "剧情 A")))
      .rejects.toThrow(/after-storage/u);
    process.env.AI_CANVAS_TEST_MANAGED_BOOTSTRAP_INTERRUPT = "after-quarantine-rename";
    await expect(materializeLocalCreativeProject({ projectsRoot, project: descriptorA }))
      .rejects.toThrow(/after-quarantine-rename/u);
    delete process.env.AI_CANVAS_TEST_MANAGED_BOOTSTRAP_INTERRUPT;

    const quarantine = path.join(projectsRoot, ".aicanvas-managed-bootstrap-quarantine");
    const ownerA = (await readdir(quarantine))
      .find((name) => /^owner-[a-f0-9]{64}$/u.test(name));
    expect(ownerA).toBeTruthy();
    const ownerARoot = path.join(quarantine, ownerA!);
    const recordA = (await readdir(ownerARoot))
      .find((name) => /^recovery-[a-f0-9]{64}\.json$/u.test(name));
    expect(recordA).toBeTruthy();
    await writeFile(path.join(ownerARoot, recordA!), "{\"corrupted\":true}\n", "utf8");

    process.env.AI_CANVAS_TEST_MANAGED_BOOTSTRAP_INTERRUPT = "after-storage";
    await expect(resumeManagedProjectBootstrap(rootB, bootstrapOptions("story-b", "剧情 B")))
      .rejects.toThrow(/after-storage/u);
    delete process.env.AI_CANVAS_TEST_MANAGED_BOOTSTRAP_INTERRUPT;
    const recoveredB = await materializeLocalCreativeProject({ projectsRoot, project: descriptorB });
    expect(recoveredB).toMatchObject({
      disposition: "resumed",
      registered: true,
    });
    expect(recoveredB.projectRoot).toMatch(/local-import-story-b-[a-f0-9]{8}$/u);
    expect(await readFile(path.join(ownerARoot, recordA!), "utf8"))
      .toBe("{\"corrupted\":true}\n");
  }, 120_000);

  it("受管项目 NFKC 名称规范化后仍可幂等复用", async () => {
    const project = descriptor({
      key: "unicode-story",
      name: "《三星堆：时空回响》",
    });
    const first = await materializeLocalCreativeProject({ projectsRoot, project });
    const second = await materializeLocalCreativeProject({ projectsRoot, project });
    expect(first.shell?.project.name).toBe("《三星堆:时空回响》");
    expect(second).toMatchObject({
      projectRoot: first.projectRoot,
      projectId: first.projectId,
      disposition: "reused",
    });
    expect(second.shell?.project.name).toBe("《三星堆:时空回响》");
  });

  it("REUSE_READONLY 只读复用既有受管根，不写工程、注册表、活动指针或来源", async () => {
    const existing = await createManagedProject({
      parentRoot: projectsRoot,
      name: "既有只读工程",
      slug: "existing-readonly",
    });
    const registryPath = process.env.AI_CANVAS_REGISTRY_PATH!;
    const activePath = path.join(path.dirname(registryPath), "active-project.json");
    await mkdir(path.dirname(registryPath), { recursive: true });
    await writeFile(registryPath, "[]\n", "utf8");
    await writeFile(activePath, "{\"sentinel\":\"unchanged\"}\n", "utf8");
    const [projectBefore, registryBefore, activeBefore, sourceBefore] = await Promise.all([
      treeSnapshot(existing.paths.root),
      readFile(registryPath),
      readFile(activePath),
      treeSnapshot(sourceRoot),
    ]);

    const result = await materializeLocalCreativeProject({
      projectsRoot,
      project: descriptor({
        key: "existing-readonly",
        name: "既有只读工程",
        resolution: "REUSE_READONLY",
        managedProjectRoot: existing.paths.root,
      }),
    });

    expect(result).toMatchObject({
      projectRoot: existing.paths.root,
      projectId: existing.project.id,
      resolution: "REUSE_READONLY",
      disposition: "reused-readonly",
      registered: false,
      ingestManifestPath: null,
      projectFormat: "managed",
    });
    expect(await treeSnapshot(existing.paths.root)).toEqual(projectBefore);
    expect(await readFile(registryPath)).toEqual(registryBefore);
    expect(await readFile(activePath)).toEqual(activeBefore);
    expect(await treeSnapshot(sourceRoot)).toEqual(sourceBefore);
  });

  it("REUSE_READONLY 可只读复用既有 legacy 画布工程，不要求 managed manifest", async () => {
    const legacyRoot = path.join(temporaryRoot, "legacy-project");
    await mkdir(path.join(legacyRoot, ".aicanvas"), { recursive: true });
    const project = {
      schemaVersion: 1,
      id: "legacy-project",
      name: "既有 Legacy 工程",
      primaryRoot: legacyRoot,
      sourceRoots: [],
      outputRoots: [legacyRoot],
      ignoreSegments: [],
      namingRules: { patterns: [], manualMappings: [] },
      hardLocks: [],
      automation: {
        imageBatchSize: 1,
        videoBatchSize: 1,
        pauseAfterVisualBatch: true,
        allowOverwriteAuthoritative: false,
      },
      createdAt: "2026-07-25T00:00:00.000Z",
      updatedAt: "2026-07-25T00:00:00.000Z",
    };
    const index = {
      schemaVersion: 1,
      project,
      scanId: "legacy-readonly-fixture",
      scannedAt: "2026-07-25T00:00:00.000Z",
      scanDurationMs: 1,
      warnings: [],
      items: [],
      artifacts: [],
      summary: { total: 0, pending: 0, inProgress: 0, awaitingReview: 0, approved: 0, failed: 0, skipped: 0 },
    };
    await writeFile(path.join(legacyRoot, ".aicanvas", "project.json"), `${JSON.stringify(project, null, 2)}\n`);
    await writeFile(path.join(legacyRoot, ".aicanvas", "index.json"), `${JSON.stringify(index, null, 2)}\n`);
    const before = await treeSnapshot(legacyRoot);

    const result = await materializeLocalCreativeProject({
      projectsRoot,
      project: descriptor({
        key: "legacy-project",
        name: "既有 Legacy 工程",
        resolution: "REUSE_READONLY",
        managedProjectRoot: legacyRoot,
      }),
    });

    expect(result).toMatchObject({
      projectRoot: legacyRoot,
      projectId: "legacy-project",
      resolution: "REUSE_READONLY",
      disposition: "reused-readonly",
      registered: false,
      ingestManifestPath: null,
      projectFormat: "legacy",
      shell: null,
    });
    expect(await treeSnapshot(legacyRoot)).toEqual(before);
  });
});
