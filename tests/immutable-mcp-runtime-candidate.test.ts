import { execFile } from "node:child_process";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";
import { computeSourceDigest, listSourceDigestFiles } from "../src/core/build-identity.js";
import {
  createImmutableMcpRuntimeCandidateReceipt,
  inspectImmutableMcpRuntimeTree,
  sealImmutableMcpRuntimeCandidate,
  serializeImmutableMcpRuntimeCandidateReceipt,
  verifyImmutableMcpRuntimeCandidate,
} from "../src/core/immutable-mcp-runtime-candidate.js";
import {
  immutableMcpPublicationPath,
  inspectImmutableMcpDependencyTree,
  verifyPublishedImmutableMcpRuntimeCandidate,
} from "../src/core/immutable-mcp-runtime-publication.js";
import {
  AI_CANVAS_APPLICATION_VERSION,
  AI_CANVAS_PROTOCOL_VERSION,
  RELEASE_MANIFEST_SCHEMA_VERSION,
  releaseManifestDigest,
  type ReleaseManifest,
} from "../src/core/release-manifest.js";
import {
  assertImmutableMcpCandidateOutputBoundary,
  buildImmutableMcpRuntimeCandidate,
  parseImmutableMcpCandidateBuildArguments,
  publishImmutableMcpCandidateCutover,
} from "../scripts/build-immutable-mcp-candidate.js";
import { withImmutableMcpPublicationLock } from "../src/core/immutable-mcp-publication-lock.js";
import { sanitizedMcpChildEnvironment } from "../src/core/current-mcp-runtime.js";

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const roots: string[] = [];
const execFileAsync = promisify(execFile);

async function makeWritableForCleanup(root: string): Promise<void> {
  let metadata;
  try {
    metadata = await lstat(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (metadata.isDirectory()) {
    await chmod(root, 0o700);
    for (const child of await readdir(root)) await makeWritableForCleanup(path.join(root, child));
    return;
  }
  if (!metadata.isSymbolicLink()) await chmod(root, 0o600);
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await makeWritableForCleanup(root);
    await rm(root, { recursive: true, force: true });
  }
});

function fixtureReleaseManifest(): ReleaseManifest {
  const body: Omit<ReleaseManifest, "fingerprint"> = {
    schemaVersion: RELEASE_MANIFEST_SCHEMA_VERSION,
    kind: "ai-drama-canvas-release-manifest",
    version: AI_CANVAS_APPLICATION_VERSION,
    architecture: process.arch,
    sourceDigest: "a".repeat(64),
    buildId: "b".repeat(32),
    buildIdentityFingerprint: "c".repeat(64),
    protocolVersion: AI_CANVAS_PROTOCOL_VERSION,
    mcpToolCount: 2,
    builtAt: "2026-07-26T12:00:00.000Z",
    distribution: "local-only",
    localOnly: true,
    source: { files: 2, bytes: 128 },
  };
  return { ...body, fingerprint: releaseManifestDigest(body) };
}

async function createFixtureCandidate(): Promise<{
  parent: string;
  staging: string;
  dependencyPath: string;
}> {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "immutable-mcp-candidate-test-")));
  roots.push(parent);
  const staging = path.join(parent, ".staging");
  const dependencyPath = path.join(staging, "dist-mcp", "core", "dependency.js");
  await Promise.all([
    mkdir(path.join(staging, "dist-mcp", "mcp"), { recursive: true }),
    mkdir(path.dirname(dependencyPath), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(staging, "dist-mcp", "mcp", "server.js"), "import '../core/dependency.js';\n"),
    writeFile(dependencyPath, "export const dependency = 1;\n"),
    writeFile(
      path.join(staging, "release-manifest.json"),
      `${JSON.stringify(fixtureReleaseManifest(), null, 2)}\n`,
    ),
  ]);
  const receipt = await createImmutableMcpRuntimeCandidateReceipt(staging);
  await writeFile(
    path.join(staging, "receipt.json"),
    serializeImmutableMcpRuntimeCandidateReceipt(receipt),
  );
  return { parent, staging, dependencyPath };
}

describe("不可变 MCP candidate receipt", () => {
  it("正式构建 CLI 与 outputRoot 固定，只有测试可显式使用系统临时根", () => {
    expect(parseImmutableMcpCandidateBuildArguments([])).toEqual({});
    expect(() => parseImmutableMcpCandidateBuildArguments(["--output-root", "/tmp/escape"]))
      .toThrow(/未知参数：--output-root/u);
    expect(() => assertImmutableMcpCandidateOutputBoundary(
      workspace,
      path.join(workspace, ".aicanvas-runtime", "mcp-candidates", "nested"),
      false,
    )).toThrow(/只能写入固定根/u);
  });

  it("publication lock 回收死亡 PID，存活 PID 锁则失败关闭", async () => {
    const outputRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "mcp-publication-lock-test-")));
    roots.push(outputRoot);
    const lockPath = path.join(outputRoot, ".publish-lock");
    const lockRecord = (pid: number) => `${JSON.stringify({
      schemaVersion: 1,
      kind: "immutable-mcp-publication-lock",
      pid,
      token: randomUUID(),
      startedAt: new Date().toISOString(),
    })}\n`;
    await writeFile(lockPath, lockRecord(2_147_483_647), { mode: 0o600 });
    await expect(withImmutableMcpPublicationLock(outputRoot, async () => "recovered", {
      maxWaitMs: 50,
      pollMs: 10,
    })).resolves.toBe("recovered");

    await writeFile(lockPath, lockRecord(process.pid), { mode: 0o600 });
    await expect(withImmutableMcpPublicationLock(outputRoot, async () => "should-not-run", {
      maxWaitMs: 20,
      pollMs: 10,
    })).rejects.toThrow(/存活进程持有/u);
  });

  it("死亡锁 reaper 竞争时只有一个回收者，另一方确定性等待后串行进入", async () => {
    const outputRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "mcp-publication-reaper-race-")));
    roots.push(outputRoot);
    const lockPath = path.join(outputRoot, ".publish-lock");
    await writeFile(lockPath, `${JSON.stringify({
      schemaVersion: 1,
      kind: "immutable-mcp-publication-lock",
      pid: 2_147_483_647,
      token: randomUUID(),
      startedAt: new Date().toISOString(),
    })}\n`, { mode: 0o600 });

    let releaseFirstReaper!: () => void;
    const firstReaperGate = new Promise<void>((resolve) => { releaseFirstReaper = resolve; });
    let firstReaperAcquired!: () => void;
    const firstReaperObserved = new Promise<void>((resolve) => { firstReaperAcquired = resolve; });
    let busyObserved!: () => void;
    const secondObservedBusy = new Promise<void>((resolve) => { busyObserved = resolve; });
    const actions: string[] = [];
    const first = withImmutableMcpPublicationLock(outputRoot, async () => {
      actions.push("first");
      return "first";
    }, {
      maxWaitMs: 500,
      pollMs: 10,
      testHooks: {
        async afterDeadLockReaperAcquired() {
          firstReaperAcquired();
          await firstReaperGate;
        },
      },
    });
    await firstReaperObserved;
    const second = withImmutableMcpPublicationLock(outputRoot, async () => {
      actions.push("second");
      return "second";
    }, {
      maxWaitMs: 500,
      pollMs: 10,
      testHooks: { async onDeadLockReaperBusy() { busyObserved(); } },
    });
    await secondObservedBusy;
    expect(actions).toEqual([]);
    releaseFirstReaper();

    await expect(Promise.all([first, second])).resolves.toEqual(["first", "second"]);
    expect(actions).toEqual(["first", "second"]);
  });

  it("持有 reaper 后重新读取主锁；交错替换成存活 owner 时拒绝 rename", async () => {
    const outputRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "mcp-publication-reaper-recheck-")));
    roots.push(outputRoot);
    const lockPath = path.join(outputRoot, ".publish-lock");
    const deadRecord = {
      schemaVersion: 1,
      kind: "immutable-mcp-publication-lock",
      pid: 2_147_483_647,
      token: randomUUID(),
      startedAt: new Date().toISOString(),
    };
    const liveRecord = { ...deadRecord, pid: process.pid, token: randomUUID() };
    await writeFile(lockPath, `${JSON.stringify(deadRecord)}\n`, { mode: 0o600 });

    await expect(withImmutableMcpPublicationLock(outputRoot, async () => "must-not-run", {
      maxWaitMs: 20,
      pollMs: 10,
      testHooks: {
        async afterDeadLockReaperAcquired() {
          await writeFile(lockPath, `${JSON.stringify(liveRecord)}\n`, "utf8");
        },
      },
    })).rejects.toThrow(/存活进程持有/u);
    expect(JSON.parse(await readFile(lockPath, "utf8"))).toMatchObject({ token: liveRecord.token });
  });

  it("完整树通过；只改传递 core 文件也会被 tree fingerprint 拒绝", async () => {
    const fixture = await createFixtureCandidate();
    const receipt = await verifyImmutableMcpRuntimeCandidate(fixture.staging, {
      requireDirectoryName: false,
      requireReadOnly: false,
    });
    expect(receipt.entrySha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(receipt.runtimeTree).toMatchObject({ files: 2 });

    await writeFile(fixture.dependencyPath, "export const dependency = 2;\n");
    await expect(verifyImmutableMcpRuntimeCandidate(fixture.staging, {
      requireDirectoryName: false,
      requireReadOnly: false,
    })).rejects.toThrow(/runtime tree fingerprint|传递 core/u);
  });

  it("seal 后目录名、receipt、release 与只读权限共同通过", async () => {
    const fixture = await createFixtureCandidate();
    const receipt = await verifyImmutableMcpRuntimeCandidate(fixture.staging, {
      requireDirectoryName: false,
      requireReadOnly: false,
    });
    await sealImmutableMcpRuntimeCandidate(fixture.staging);
    const finalRoot = path.join(fixture.parent, receipt.candidateId);
    await rename(fixture.staging, finalRoot);

    await expect(verifyImmutableMcpRuntimeCandidate(finalRoot)).resolves.toEqual(receipt);
    expect((await stat(path.join(finalRoot, "dist-mcp", "core", "dependency.js"))).mode & 0o222).toBe(0);
    expect((await stat(finalRoot)).mode & 0o222).toBe(0);
  });

  it("真实隔离 stage 依次 build:mcp + build:identity，且 live dist-mcp 不变", async () => {
    const outputParent = await realpath(await mkdtemp(path.join(os.tmpdir(), "immutable-mcp-candidate-build-test-")));
    roots.push(outputParent);
    const outputRoot = path.join(outputParent, "candidates");
    await mkdir(outputRoot, { recursive: true });
    const liveEntryPath = path.join(workspace, "dist-mcp", "mcp", "server.js");
    const [sourceBefore, liveTreeBefore, entryBefore] = await Promise.all([
      computeSourceDigest(workspace),
      inspectImmutableMcpRuntimeTree(path.join(workspace, "dist-mcp")),
      stat(liveEntryPath),
    ]);

    const result = await buildImmutableMcpRuntimeCandidate({
      workspace,
      outputRoot,
      allowExternalOutputForTests: true,
    });

    const [sourceAfter, liveTreeAfter, entryAfter, landedReceipt] = await Promise.all([
      computeSourceDigest(workspace),
      inspectImmutableMcpRuntimeTree(path.join(workspace, "dist-mcp")),
      stat(liveEntryPath),
      verifyImmutableMcpRuntimeCandidate(result.candidateRoot),
    ]);
    expect(result.commands.map((command) => command.name)).toEqual([
      "npm:ci",
      "build:launcher",
      "build:mcp",
      "build:identity",
      "npm:prune-production",
      "npm:ls-production",
      "runtime:smoke",
    ]);
    expect(result.commands.every((command) => command.exitCode === 0)).toBe(true);
    expect(result.source).toMatchObject({
      before: sourceBefore.sourceDigest,
      stageBefore: sourceBefore.sourceDigest,
      stageAfter: sourceBefore.sourceDigest,
      after: sourceBefore.sourceDigest,
      unchanged: true,
    });
    expect(sourceAfter).toEqual(sourceBefore);
    expect(result.liveDistMcp).toEqual({
      beforeFingerprint: liveTreeBefore.fingerprint,
      afterFingerprint: liveTreeBefore.fingerprint,
      unchanged: true,
    });
    expect(liveTreeAfter).toEqual(liveTreeBefore);
    expect(entryAfter.mtimeMs).toBe(entryBefore.mtimeMs);
    expect(landedReceipt).toEqual(result.receipt);
    expect(landedReceipt.sourceDigest).toBe(sourceBefore.sourceDigest);
    expect(landedReceipt.entrySha256).not.toBe("");
    await expect(verifyPublishedImmutableMcpRuntimeCandidate(
      result.candidateRoot,
      result.publication,
      { launcherPath: result.launcher.path },
    )).resolves.toEqual(result.receipt);
    expect(result.launcher.externalImports.every((entry) => entry.startsWith("node:")
      || ["events", "fs", "os", "path", "stream", "util"].includes(entry))).toBe(true);
    const dependencyTree = await inspectImmutableMcpDependencyTree(path.join(result.candidateRoot, "node_modules"));
    expect(dependencyTree).toMatchObject({
      files: result.publication.dependencyClosure.files,
      fingerprint: result.publication.dependencyClosure.fingerprint,
    });

    const candidateCoreFiles = (await inspectImmutableMcpRuntimeTree(
      path.join(result.candidateRoot, "dist-mcp"),
    )).entries.filter((entry) => entry.relativePath.startsWith("core/"));
    expect(candidateCoreFiles.length).toBeGreaterThan(10);
    const manifest = JSON.parse(
      await readFile(path.join(result.candidateRoot, "release-manifest.json"), "utf8"),
    ) as { sourceDigest?: string; mcpToolCount?: number };
    expect(manifest).toMatchObject({
      sourceDigest: sourceBefore.sourceDigest,
      mcpToolCount: landedReceipt.mcpToolCount,
    });

    const launcherBeforeRejectedCutover = await stat(result.launcher.path, { bigint: true });
    const retryCandidateRoot = path.join(outputRoot, `.retry-${randomUUID()}`);
    await execFileAsync("/bin/cp", ["-cR", result.candidateRoot, retryCandidateRoot]);
    await expect(publishImmutableMcpCandidateCutover(
      outputRoot,
      path.dirname(result.launcher.path),
      result.launcher.path,
      result.launcher.sha256,
      retryCandidateRoot,
      result.receipt,
      result.publication,
      { beforeLauncherCutover: async () => { throw new Error("injected-source-drift"); } },
    )).rejects.toThrow(/injected-source-drift/u);
    const launcherAfterRejectedCutover = await stat(result.launcher.path, { bigint: true });
    expect({
      dev: launcherAfterRejectedCutover.dev,
      ino: launcherAfterRejectedCutover.ino,
      mtimeNs: launcherAfterRejectedCutover.mtimeNs,
    }).toEqual({
      dev: launcherBeforeRejectedCutover.dev,
      ino: launcherBeforeRejectedCutover.ino,
      mtimeNs: launcherBeforeRejectedCutover.mtimeNs,
    });

    const runtimeWorkspace = path.join(outputParent, "runtime-workspace");
    const runtimeCandidatesRoot = path.join(runtimeWorkspace, ".aicanvas-runtime", "mcp-candidates");
    const runtimeLauncherPath = path.join(runtimeWorkspace, ".aicanvas-runtime", "mcp-launcher", "current.mjs");
    await Promise.all([
      mkdir(path.join(runtimeCandidatesRoot, ".published"), { recursive: true }),
      mkdir(path.dirname(runtimeLauncherPath), { recursive: true }),
    ]);
    for (const sourcePath of await listSourceDigestFiles(workspace)) {
      const targetPath = path.join(runtimeWorkspace, path.relative(workspace, sourcePath));
      await mkdir(path.dirname(targetPath), { recursive: true });
      await copyFile(sourcePath, targetPath);
    }
    await chmod(result.candidateRoot, 0o700);
    const runtimeCandidateRoot = path.join(runtimeCandidatesRoot, result.receipt.candidateId);
    await rename(result.candidateRoot, runtimeCandidateRoot);
    await chmod(runtimeCandidateRoot, 0o555);
    await Promise.all([
      copyFile(
        immutableMcpPublicationPath(outputRoot, result.receipt.candidateId),
        immutableMcpPublicationPath(runtimeCandidatesRoot, result.receipt.candidateId),
      ),
      copyFile(result.launcher.path, runtimeLauncherPath),
    ]);
    const runtimeEnvironment = sanitizedMcpChildEnvironment({
      ...process.env,
      AI_CANVAS_MCP_ALLOW_MULTI: "1",
      AI_CANVAS_REGISTRY_PATH: path.join(outputParent, "runtime-registry.json"),
    });
    const check = await execFileAsync(process.execPath, [runtimeLauncherPath, "--check"], {
      cwd: runtimeWorkspace,
      env: runtimeEnvironment,
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(JSON.parse(check.stdout)).toMatchObject({
      ok: true,
      candidateId: result.receipt.candidateId,
      mcpToolCount: result.receipt.mcpToolCount,
    });

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [runtimeLauncherPath],
      cwd: runtimeWorkspace,
      env: runtimeEnvironment,
      stderr: "pipe",
    });
    const client = new Client({ name: "immutable-mcp-stable-launcher-test", version: "1.0.0" });
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools).toHaveLength(result.receipt.mcpToolCount);
      expect(tools.tools.map((entry) => entry.name)).toContain("get_capabilities");
    } finally {
      await client.close().catch(() => undefined);
      await transport.close().catch(() => undefined);
    }
  }, 240_000);
});
