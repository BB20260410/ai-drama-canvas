import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  createImmutableMcpRuntimeCandidateReceipt,
  sealImmutableMcpRuntimeCandidate,
  serializeImmutableMcpRuntimeCandidateReceipt,
} from "../src/core/immutable-mcp-runtime-candidate.js";
import {
  createImmutableMcpCandidatePublicationRecord,
  readImmutableMcpCandidatePublicationRecord,
  serializeImmutableMcpCandidatePublicationRecord,
  sha256ImmutableMcpFile,
  verifyPublishedImmutableMcpRuntimeCandidate,
} from "../src/core/immutable-mcp-runtime-publication.js";
import {
  AI_CANVAS_APPLICATION_VERSION,
  AI_CANVAS_PROTOCOL_VERSION,
  RELEASE_MANIFEST_SCHEMA_VERSION,
  releaseManifestDigest,
} from "../src/core/release-manifest.js";
import { publishImmutableMcpCandidateCutover } from "../scripts/lib/immutable-mcp-candidate-cutover.js";

const execFileAsync = promisify(execFile);
const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const roots: string[] = [];

async function makeWritable(root: string): Promise<void> {
  const metadata = await lstat(root).catch(() => null);
  if (!metadata) return;
  if (metadata.isDirectory()) {
    await chmod(root, 0o700);
    for (const child of await readdir(root)) await makeWritable(path.join(root, child));
  } else if (!metadata.isSymbolicLink()) {
    await chmod(root, 0o600);
  }
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await makeWritable(root);
    await rm(root, { recursive: true, force: true });
  }
});

function releaseManifest() {
  const body = {
    schemaVersion: RELEASE_MANIFEST_SCHEMA_VERSION,
    kind: "ai-drama-canvas-release-manifest" as const,
    version: AI_CANVAS_APPLICATION_VERSION,
    architecture: process.arch,
    sourceDigest: "a".repeat(64),
    buildId: "b".repeat(32),
    buildIdentityFingerprint: "c".repeat(64),
    protocolVersion: AI_CANVAS_PROTOCOL_VERSION,
    mcpToolCount: 2,
    builtAt: "2026-08-09T08:00:00.000Z",
    distribution: "local-only" as const,
    localOnly: true as const,
    source: { files: 10, bytes: 1_024 },
  };
  return { ...body, fingerprint: releaseManifestDigest(body) };
}

async function publishedFixture() {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "mcp-publication-test-")));
  roots.push(parent);
  const staging = path.join(parent, ".building");
  const dependencyPath = path.join(staging, "node_modules", "fixture-dependency", "index.js");
  const launcherPath = path.join(parent, "current.mjs");
  await Promise.all([
    mkdir(path.join(staging, "dist-mcp", "mcp"), { recursive: true }),
    mkdir(path.dirname(dependencyPath), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(staging, "dist-mcp", "mcp", "server.js"), "process.stdin.resume();\n"),
    writeFile(path.join(staging, "node_modules", "fixture-dependency", "package.json"), JSON.stringify({ name: "fixture-dependency", version: "1.0.0" })),
    writeFile(dependencyPath, "export const value = 1;\n"),
    writeFile(path.join(staging, "package.json"), JSON.stringify({ name: "candidate", version: "1.0.0", type: "module" })),
    writeFile(path.join(staging, "package-lock.json"), JSON.stringify({ name: "candidate", version: "1.0.0", lockfileVersion: 3, packages: {} })),
    writeFile(path.join(staging, "runtime-guard.mjs"), "// guard\n"),
    writeFile(path.join(staging, "release-manifest.json"), `${JSON.stringify(releaseManifest(), null, 2)}\n`),
    writeFile(launcherPath, "// launcher\n"),
  ]);
  const receipt = await createImmutableMcpRuntimeCandidateReceipt(staging);
  await writeFile(path.join(staging, "receipt.json"), serializeImmutableMcpRuntimeCandidateReceipt(receipt));
  const publication = await createImmutableMcpCandidatePublicationRecord(staging, {
    launcherSha256: await sha256ImmutableMcpFile(launcherPath),
    publishedAt: "2026-08-09T08:01:00.000Z",
    requireDirectoryName: false,
    requireReadOnly: false,
  });
  await sealImmutableMcpRuntimeCandidate(staging);
  const candidateRoot = path.join(parent, receipt.candidateId);
  await rename(staging, candidateRoot);
  return {
    candidateRoot,
    dependencyPath: path.join(candidateRoot, "node_modules", "fixture-dependency", "index.js"),
    launcherPath,
    publication,
    receipt,
  };
}

describe("immutable MCP publication 与生产依赖闭包", () => {
  it("联合验证绑定 receipt、runtime tree、生产依赖、lockfile、guard 与 launcher", async () => {
    const fixture = await publishedFixture();
    await expect(verifyPublishedImmutableMcpRuntimeCandidate(
      fixture.candidateRoot,
      fixture.publication,
      { launcherPath: fixture.launcherPath },
    )).resolves.toMatchObject({ candidateId: fixture.publication.candidateId });

    await chmod(fixture.dependencyPath, 0o600);
    await writeFile(fixture.dependencyPath, "export const value = 2;\n");
    await chmod(fixture.dependencyPath, 0o444);
    await expect(verifyPublishedImmutableMcpRuntimeCandidate(
      fixture.candidateRoot,
      fixture.publication,
      { launcherPath: fixture.launcherPath },
    )).rejects.toThrow(/publication.*payload|依赖|身份不一致/iu);
  });

  it("候选缺失依赖时 module guard 拒绝回落到 workspace node_modules", async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "mcp-runtime-guard-test-")));
    roots.push(root);
    const candidateRoot = path.join(root, "workspace", ".aicanvas-runtime", "mcp-candidates", "candidate");
    const candidatePackage = path.join(candidateRoot, "node_modules", "guard-fixture");
    const workspacePackage = path.join(root, "workspace", "node_modules", "guard-fixture");
    await Promise.all([mkdir(candidatePackage, { recursive: true }), mkdir(workspacePackage, { recursive: true })]);
    const packageJson = JSON.stringify({ name: "guard-fixture", version: "1.0.0", type: "module", exports: "./index.js" });
    await Promise.all([
      writeFile(path.join(candidatePackage, "package.json"), packageJson),
      writeFile(path.join(candidatePackage, "index.js"), 'export const origin = "candidate";\n'),
      writeFile(path.join(workspacePackage, "package.json"), packageJson),
      writeFile(path.join(workspacePackage, "index.js"), 'export const origin = "workspace-poison";\n'),
      writeFile(path.join(candidateRoot, "runtime-guard.mjs"), await readFile(path.join(workspace, "scripts", "mcp-candidate-runtime-guard.mjs"))),
    ]);
    const args = [
      "--import",
      path.join(candidateRoot, "runtime-guard.mjs"),
      "--input-type=module",
      "--eval",
      'const { origin } = await import("guard-fixture"); process.stdout.write(origin);',
    ];
    const first = await execFileAsync(process.execPath, args, { cwd: candidateRoot, encoding: "utf8" });
    expect(first.stdout).toBe("candidate");

    await rm(candidatePackage, { recursive: true, force: true });
    await expect(execFileAsync(process.execPath, args, { cwd: candidateRoot, encoding: "utf8" }))
      .rejects.toMatchObject({ stderr: expect.stringMatching(/ERR_AI_CANVAS_RUNTIME_IMPORT_ESCAPE|模块解析逃逸候选闭包/u) });
  });

  it("publication 文件名与 candidate 目录 basename 必须等于 candidateId", async () => {
    const fixture = await publishedFixture();
    const wrongId = `mcp-candidate-${"1".repeat(16)}-${"2".repeat(16)}-${"3".repeat(8)}`;
    const wrongPublicationPath = path.join(path.dirname(fixture.launcherPath), `${wrongId}.json`);
    await writeFile(
      wrongPublicationPath,
      serializeImmutableMcpCandidatePublicationRecord(fixture.publication),
    );
    await expect(readImmutableMcpCandidatePublicationRecord(wrongPublicationPath))
      .rejects.toThrow(/文件名.*candidateId/u);

    const wrongCandidateRoot = path.join(path.dirname(fixture.candidateRoot), wrongId);
    await rename(fixture.candidateRoot, wrongCandidateRoot);
    await expect(verifyPublishedImmutableMcpRuntimeCandidate(
      wrongCandidateRoot,
      fixture.publication,
      { launcherPath: fixture.launcherPath },
    )).rejects.toThrow(/目录名.*candidateId/u);
  });

  it("candidate/publication 验证失败时最终 launcher 仍保持旧内容", async () => {
    const fixture = await publishedFixture();
    const outputRoot = path.join(path.dirname(fixture.launcherPath), "candidates");
    await mkdir(outputRoot, { recursive: true });
    const temporaryCandidateRoot = path.join(outputRoot, ".building-invalid");
    await makeWritable(fixture.candidateRoot);
    await writeFile(fixture.dependencyPath, "export const value = 'tampered';\n");
    await rename(fixture.candidateRoot, temporaryCandidateRoot);
    const launcherBefore = await readFile(fixture.launcherPath, "utf8");
    const bundlePath = path.join(path.dirname(fixture.launcherPath), "next-launcher.mjs");
    await writeFile(bundlePath, launcherBefore);

    await expect(publishImmutableMcpCandidateCutover(
      outputRoot,
      path.dirname(fixture.launcherPath),
      bundlePath,
      fixture.publication.launcherSha256,
      temporaryCandidateRoot,
      fixture.receipt,
      fixture.publication,
    )).rejects.toThrow();
    expect(await readFile(fixture.launcherPath, "utf8")).toBe(launcherBefore);
  });
});
