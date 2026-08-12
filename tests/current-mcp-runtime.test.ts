import { execFile } from "node:child_process";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createBuildIdentity } from "../src/core/build-identity.js";
import {
  assertCurrentMcpRuntimeCapabilities,
  currentMcpRuntimeEnvironment,
  resolveCurrentMcpRuntime,
} from "../src/core/current-mcp-runtime.js";
import {
  createImmutableMcpRuntimeCandidateReceipt,
  sealImmutableMcpRuntimeCandidate,
  serializeImmutableMcpRuntimeCandidateReceipt,
} from "../src/core/immutable-mcp-runtime-candidate.js";
import {
  createImmutableMcpCandidatePublicationRecord,
  immutableMcpPublicationPath,
  serializeImmutableMcpCandidatePublicationRecord,
  sha256ImmutableMcpFile,
} from "../src/core/immutable-mcp-runtime-publication.js";
import {
  assertSafeCurrentMcpLauncherEnvironment,
  parseCurrentMcpLauncherArguments,
} from "../scripts/launch-current-mcp-candidate.js";
import {
  AI_CANVAS_APPLICATION_VERSION,
  AI_CANVAS_PROTOCOL_VERSION,
  RELEASE_MANIFEST_SCHEMA_VERSION,
  releaseManifestDigest,
} from "../src/core/release-manifest.js";

const roots: string[] = [];
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const execFileAsync = promisify(execFile);

async function makeWritable(root: string): Promise<void> {
  const metadata = await lstat(root).catch(() => null);
  if (!metadata) return;
  if (!metadata.isDirectory()) {
    await chmod(root, 0o600);
    return;
  }
  await chmod(root, 0o700);
  await Promise.all((await readdir(root)).map((entry) => makeWritable(path.join(root, entry))));
}

afterEach(async () => Promise.all(roots.splice(0).map(async (root) => {
  await makeWritable(root);
  await rm(root, { recursive: true, force: true });
})));

async function createFixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "current-mcp-runtime-test-")));
  roots.push(root);
  const workspace = path.join(root, "workspace");
  const candidatesRoot = path.join(workspace, ".aicanvas-runtime", "mcp-candidates");
  const launcherPath = path.join(workspace, ".aicanvas-runtime", "mcp-launcher", "current.mjs");
  await Promise.all([
    mkdir(path.join(workspace, "src", "mcp"), { recursive: true }),
    mkdir(candidatesRoot, { recursive: true }),
    mkdir(path.dirname(launcherPath), { recursive: true }),
  ]);
  await writeFile(path.join(workspace, "package.json"), JSON.stringify({
    name: "current-mcp-runtime-fixture",
    version: AI_CANVAS_APPLICATION_VERSION,
    type: "module",
  }), "utf8");
  await writeFile(launcherPath, "// standalone fixture launcher\n", "utf8");
  return { workspace, candidatesRoot, launcherPath };
}

async function writeToolSource(workspace: string, count: number): Promise<void> {
  await writeFile(
    path.join(workspace, "src", "mcp", "server.ts"),
    Array.from({ length: count }, (_, index) => `server.registerTool("tool-${index + 1}", {}, () => ({}));`).join("\n"),
    "utf8",
  );
}

async function publishCandidate(
  workspace: string,
  candidatesRoot: string,
  recordedToolCount?: number,
  authorize = true,
) {
  const staging = await mkdtemp(path.join(candidatesRoot, ".building-"));
  await Promise.all([
    mkdir(path.join(staging, "dist-mcp", "mcp"), { recursive: true }),
    mkdir(path.join(staging, "node_modules", "fixture-runtime"), { recursive: true }),
  ]);
  await writeFile(path.join(staging, "dist-mcp", "mcp", "server.js"), "process.stdin.resume();\n", "utf8");
  await writeFile(path.join(staging, "node_modules", "fixture-runtime", "package.json"), JSON.stringify({ name: "fixture-runtime", version: "1.0.0" }), "utf8");
  await writeFile(path.join(staging, "node_modules", "fixture-runtime", "index.js"), "export const fixture = true;\n", "utf8");
  await writeFile(path.join(staging, "package.json"), JSON.stringify({ name: "candidate-fixture", version: "1.0.0", type: "module" }), "utf8");
  await writeFile(path.join(staging, "package-lock.json"), JSON.stringify({ name: "candidate-fixture", version: "1.0.0", lockfileVersion: 3, packages: {} }), "utf8");
  await writeFile(path.join(staging, "runtime-guard.mjs"), "// fixture runtime guard\n", "utf8");
  const builtAt = "2026-08-01T18:00:00.000Z";
  const identity = await createBuildIdentity(workspace, {
    artifactBuiltAt: builtAt,
    ...(recordedToolCount ? { mcpToolCount: recordedToolCount } : {}),
  });
  const body = {
    schemaVersion: RELEASE_MANIFEST_SCHEMA_VERSION,
    kind: "ai-drama-canvas-release-manifest" as const,
    version: AI_CANVAS_APPLICATION_VERSION,
    architecture: process.arch,
    sourceDigest: identity.sourceDigest,
    buildId: identity.buildId,
    buildIdentityFingerprint: identity.fingerprint,
    protocolVersion: AI_CANVAS_PROTOCOL_VERSION,
    mcpToolCount: identity.capabilities.mcpToolCount,
    builtAt,
    distribution: "local-only" as const,
    localOnly: true as const,
    source: { files: identity.roots.sourceFiles, bytes: identity.roots.sourceBytes },
  };
  const manifest = { ...body, fingerprint: releaseManifestDigest(body) };
  await writeFile(path.join(staging, "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const receipt = await createImmutableMcpRuntimeCandidateReceipt(staging);
  await writeFile(path.join(staging, "receipt.json"), serializeImmutableMcpRuntimeCandidateReceipt(receipt), "utf8");
  const launcherPath = path.join(workspace, ".aicanvas-runtime", "mcp-launcher", "current.mjs");
  const publication = await createImmutableMcpCandidatePublicationRecord(staging, {
    launcherSha256: await sha256ImmutableMcpFile(launcherPath),
    publishedAt: builtAt,
    requireDirectoryName: false,
    requireReadOnly: false,
  });
  await sealImmutableMcpRuntimeCandidate(staging);
  const candidateRoot = path.join(candidatesRoot, receipt.candidateId);
  await rename(staging, candidateRoot);
  if (authorize) {
    await mkdir(path.join(candidatesRoot, ".published"), { recursive: true });
    await writeFile(
      immutableMcpPublicationPath(candidatesRoot, receipt.candidateId),
      serializeImmutableMcpCandidatePublicationRecord(publication),
      { encoding: "utf8", mode: 0o444 },
    );
  }
  return { candidateRoot, receipt, publication };
}

describe("当前 immutable MCP runtime 选择", () => {
  it("只选择与 live source identity 和工具数完全一致的只读候选", async () => {
    const fixture = await createFixture();
    await writeToolSource(fixture.workspace, 2);
    const published = await publishCandidate(fixture.workspace, fixture.candidatesRoot);

    const resolved = await resolveCurrentMcpRuntime(fixture);
    expect(resolved.candidateRoot).toBe(published.candidateRoot);
    expect(resolved.expected).toMatchObject({ mcpToolCount: 2 });
    expect(resolved.receipt).toEqual(published.receipt);
    expect(resolved.publication).toEqual(published.publication);
    expect(resolved.guardPath).toBe(path.join(published.candidateRoot, "runtime-guard.mjs"));
    expect(currentMcpRuntimeEnvironment(resolved, { AI_CANVAS_REGISTRY_PATH: "/tmp/registry.json" })).toMatchObject({
      AI_CANVAS_WORKSPACE: fixture.workspace,
      AI_CANVAS_RELEASE_MANIFEST_PATH: path.join(published.candidateRoot, "release-manifest.json"),
      AI_CANVAS_RECORDED_SOURCE_DIGEST: published.receipt.sourceDigest,
      AI_CANVAS_RECORDED_RUNTIME_ARTIFACT_SHA256: published.receipt.entrySha256,
      AI_CANVAS_MCP_RUNTIME_ROOT: published.candidateRoot,
      AI_CANVAS_REGISTRY_PATH: "/tmp/registry.json",
    });
  });

  it("候选内部 receipt/manifest/runtime tree 全部自洽但没有 publication 时仍拒绝", async () => {
    const fixture = await createFixture();
    await writeToolSource(fixture.workspace, 1);
    await publishCandidate(fixture.workspace, fixture.candidatesRoot, undefined, false);

    await expect(resolveCurrentMcpRuntime(fixture)).rejects.toMatchObject({
      code: "CURRENT_MCP_CANDIDATE_NOT_FOUND",
    });
  });

  it("源码升级后旧候选在 MCP handshake 前失败关闭", async () => {
    const fixture = await createFixture();
    await writeToolSource(fixture.workspace, 1);
    await publishCandidate(fixture.workspace, fixture.candidatesRoot);
    await writeToolSource(fixture.workspace, 2);

    await expect(resolveCurrentMcpRuntime(fixture)).rejects.toMatchObject({
      code: "CURRENT_MCP_CANDIDATE_NOT_FOUND",
    });
    await expect(resolveCurrentMcpRuntime(fixture)).rejects.toThrow(/拒绝启动旧版.*mcp:candidate:build/u);
  });

  it("稳定 launcher 漂移后 publication 联合验证失败关闭", async () => {
    const fixture = await createFixture();
    await writeToolSource(fixture.workspace, 1);
    await publishCandidate(fixture.workspace, fixture.candidatesRoot);
    await writeFile(fixture.launcherPath, "// tampered launcher\n", "utf8");

    await expect(resolveCurrentMcpRuntime(fixture)).rejects.toMatchObject({
      code: "CURRENT_MCP_CANDIDATE_NOT_FOUND",
    });
  });

  it("同 sourceDigest 但 manifest 工具数过期时仍拒绝", async () => {
    const fixture = await createFixture();
    await writeToolSource(fixture.workspace, 2);
    await publishCandidate(fixture.workspace, fixture.candidatesRoot, 1);

    await expect(resolveCurrentMcpRuntime(fixture)).rejects.toMatchObject({
      code: "CURRENT_MCP_CANDIDATE_NOT_FOUND",
    });
  });

  it("稳定 launcher 不接受 workspace 或 candidates root 逃逸参数", () => {
    expect(() => parseCurrentMcpLauncherArguments(["--workspace", "/tmp/fake"], "/fixed/workspace"))
      .toThrow(/未知参数：--workspace/u);
    expect(() => parseCurrentMcpLauncherArguments(["--candidates-root", "/tmp/fake"], "/fixed/workspace"))
      .toThrow(/未知参数：--candidates-root/u);
    expect(parseCurrentMcpLauncherArguments(["--check"], "/fixed/workspace"))
      .toEqual({ workspace: "/fixed/workspace", checkOnly: true });
  });

  it("正式 npm 命令经原生 clean wrapper 启动固定 launcher，不回落到 tsx/source 入口", async () => {
    const packageJson = JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    expect(packageJson.scripts?.["mcp:current"]).toBe("/bin/sh scripts/launch-current-mcp-clean.sh");
    expect(packageJson.scripts?.["mcp:current:check"]).toBe("/bin/sh scripts/launch-current-mcp-clean.sh --check");
    expect(`${packageJson.scripts?.["mcp:current"]} ${packageJson.scripts?.["mcp:current:check"]}`)
      .not.toMatch(/tsx|src\/mcp|scripts\/launch-current-mcp-candidate/u);
  });

  it("原生 clean wrapper 在 Node 启动前移除 NODE_OPTIONS 与 NODE_PATH", async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "mcp-clean-wrapper-test-")));
    roots.push(root);
    const fakeNode = path.join(root, "node");
    const observedEnvironment = path.join(root, "observed.env");
    await writeFile(fakeNode, "#!/bin/sh\n/usr/bin/env > \"$FAKE_NODE_ENV_OUTPUT\"\n", { mode: 0o755 });
    await execFileAsync("/bin/sh", [path.join(repositoryRoot, "scripts", "launch-current-mcp-clean.sh"), "--check"], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        npm_node_execpath: fakeNode,
        FAKE_NODE_ENV_OUTPUT: observedEnvironment,
        NODE_OPTIONS: "--require=/tmp/poison.cjs",
        NODE_PATH: "/tmp/poison-node-modules",
      },
    });
    const observed = await readFile(observedEnvironment, "utf8");
    expect(observed).not.toMatch(/^(NODE_OPTIONS|NODE_PATH)=/mu);
    expect(observed).toContain(`FAKE_NODE_ENV_OUTPUT=${observedEnvironment}`);
  });

  it("child 环境移除 Node loader 与动态链接器注入变量", async () => {
    const fixture = await createFixture();
    await writeToolSource(fixture.workspace, 1);
    await publishCandidate(fixture.workspace, fixture.candidatesRoot);
    const resolved = await resolveCurrentMcpRuntime(fixture);
    const environment = currentMcpRuntimeEnvironment(resolved, {
      SAFE_VALUE: "kept",
      NODE_OPTIONS: "--import=/tmp/poison.mjs",
      NODE_PATH: "/tmp/poison-node-modules",
      DYLD_INSERT_LIBRARIES: "/tmp/poison.dylib",
      DYLD_LIBRARY_PATH: "/tmp/poison-dyld",
      LD_PRELOAD: "/tmp/poison.so",
      LD_LIBRARY_PATH: "/tmp/poison-ld",
    });
    expect(environment).toMatchObject({ SAFE_VALUE: "kept" });
    expect(Object.keys(environment).filter((key) => key === "NODE_OPTIONS"
      || key === "NODE_PATH"
      || key.startsWith("DYLD_")
      || key.startsWith("LD_"))).toEqual([]);
  });

  it("launcher 对不安全继承环境失败关闭，并显式验证 registerHooks 能力", () => {
    expect(() => assertSafeCurrentMcpLauncherEnvironment({ NODE_OPTIONS: "--require=/tmp/poison.cjs" }))
      .toThrow(/NODE_OPTIONS.*拒绝启动/u);
    expect(() => assertSafeCurrentMcpLauncherEnvironment({ DYLD_INSERT_LIBRARIES: "/tmp/poison.dylib" }))
      .toThrow(/DYLD_INSERT_LIBRARIES.*拒绝启动/u);
    expect(() => assertCurrentMcpRuntimeCapabilities({
      nodeVersion: "20.18.0",
      nodeModulesAbi: "115",
      registerHooksAvailable: false,
    })).toThrow(/Node\.js 22|registerHooks/u);
    expect(() => assertCurrentMcpRuntimeCapabilities({
      nodeVersion: "22.23.2",
      nodeModulesAbi: process.versions.modules,
      registerHooksAvailable: true,
    })).not.toThrow();
  });

  it("拒绝 candidates 根、publication 根、candidate 根和 launcher 的 symlink/realpath 逃逸", async () => {
    const fixture = await createFixture();
    await writeToolSource(fixture.workspace, 1);
    const published = await publishCandidate(fixture.workspace, fixture.candidatesRoot);
    const externalRoot = path.join(path.dirname(fixture.workspace), "external");
    await mkdir(externalRoot, { recursive: true });

    const originalLauncher = path.join(externalRoot, "launcher.mjs");
    await copyFile(fixture.launcherPath, originalLauncher);
    await rm(fixture.launcherPath);
    await symlink(originalLauncher, fixture.launcherPath);
    await expect(resolveCurrentMcpRuntime(fixture)).rejects.toThrow(/launcher.*符号链接|规范真实/u);

    await rm(fixture.launcherPath);
    await copyFile(originalLauncher, fixture.launcherPath);
    const publicationRoot = path.join(fixture.candidatesRoot, ".published");
    const externalPublicationRoot = path.join(externalRoot, "published");
    await rename(publicationRoot, externalPublicationRoot);
    await symlink(externalPublicationRoot, publicationRoot);
    await expect(resolveCurrentMcpRuntime(fixture)).rejects.toThrow(/publication.*符号链接|规范真实/u);

    await rm(publicationRoot);
    await rename(externalPublicationRoot, publicationRoot);
    const externalCandidateRoot = path.join(externalRoot, published.receipt.candidateId);
    await chmod(published.candidateRoot, 0o700);
    await rename(published.candidateRoot, externalCandidateRoot);
    await chmod(externalCandidateRoot, 0o555);
    await symlink(externalCandidateRoot, published.candidateRoot);
    await expect(resolveCurrentMcpRuntime(fixture)).rejects.toMatchObject({
      code: "CURRENT_MCP_CANDIDATE_NOT_FOUND",
    });

    await rm(published.candidateRoot);
    await chmod(externalCandidateRoot, 0o700);
    await rename(externalCandidateRoot, published.candidateRoot);
    await chmod(published.candidateRoot, 0o555);
    const externalCandidatesRoot = path.join(externalRoot, "candidates");
    await rename(fixture.candidatesRoot, externalCandidatesRoot);
    await symlink(externalCandidatesRoot, fixture.candidatesRoot);
    await expect(resolveCurrentMcpRuntime(fixture)).rejects.toThrow(/candidate 根.*符号链接|规范真实/u);
    await rm(fixture.candidatesRoot);
    await rename(externalCandidatesRoot, fixture.candidatesRoot);
  });
});
