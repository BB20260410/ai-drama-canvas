import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { computeSourceDigest } from "../src/core/build-identity.js";
import {
  createImmutableMcpRuntimeCandidateReceipt,
  inspectImmutableMcpRuntimeTree,
  sealImmutableMcpRuntimeCandidate,
  serializeImmutableMcpRuntimeCandidateReceipt,
  verifyImmutableMcpRuntimeCandidate,
} from "../src/core/immutable-mcp-runtime-candidate.js";
import {
  AI_CANVAS_APPLICATION_VERSION,
  AI_CANVAS_PROTOCOL_VERSION,
  RELEASE_MANIFEST_SCHEMA_VERSION,
  releaseManifestDigest,
  type ReleaseManifest,
} from "../src/core/release-manifest.js";
import { buildImmutableMcpRuntimeCandidate } from "../scripts/build-immutable-mcp-candidate.js";

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const roots: string[] = [];

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
    const outputParent = await mkdtemp(path.join(os.tmpdir(), "immutable-mcp-candidate-build-test-"));
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
    expect(result.commands.map((command) => command.name)).toEqual(["build:mcp", "build:identity"]);
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
  }, 240_000);
});
