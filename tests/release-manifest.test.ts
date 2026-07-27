import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createBuildIdentity, resolveRuntimeBuildIdentity } from "../src/core/build-identity.js";
import {
  AI_CANVAS_APPLICATION_VERSION,
  AI_CANVAS_PROTOCOL_VERSION,
  RELEASE_MANIFEST_SCHEMA_VERSION,
  assertReleaseManifest,
  countDeclaredMcpTools,
  createPackagedMcpRuntimeLaunchContract,
  readReleaseManifest,
  releaseManifestDigest,
  type ReleaseManifest,
} from "../src/core/release-manifest.js";

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoots: string[] = [];

afterEach(async () => {
  delete process.env.AI_CANVAS_RELEASE_MANIFEST_PATH;
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixtureManifest(): Promise<ReleaseManifest> {
  const identity = await createBuildIdentity(workspace, {
    artifactBuiltAt: "2026-07-18T12:00:00.000Z",
    queriedAt: "2026-07-18T12:00:00.000Z",
  });
  const body: Omit<ReleaseManifest, "fingerprint"> = {
    schemaVersion: RELEASE_MANIFEST_SCHEMA_VERSION,
    kind: "ai-drama-canvas-release-manifest",
    version: AI_CANVAS_APPLICATION_VERSION,
    architecture: process.arch,
    sourceDigest: identity.sourceDigest,
    buildId: identity.buildId,
    buildIdentityFingerprint: identity.fingerprint,
    protocolVersion: AI_CANVAS_PROTOCOL_VERSION,
    mcpToolCount: identity.capabilities.mcpToolCount,
    builtAt: identity.builtAt,
    distribution: "local-only",
    localOnly: true,
    source: { files: identity.roots.sourceFiles, bytes: identity.roots.sourceBytes },
  };
  return { ...body, fingerprint: releaseManifestDigest(body) };
}

describe("P14 release manifest 与自带 Electron MCP runtime", () => {
  it("从当前 MCP 注册源得到工具数，manifest 篡改失败关闭", async () => {
    const manifest = await fixtureManifest();
    expect(manifest.version).toBe("0.2.0");
    expect(manifest.mcpToolCount).toBe(await countDeclaredMcpTools(workspace));
    expect(() => assertReleaseManifest(manifest)).not.toThrow();
    expect(() => assertReleaseManifest({ ...manifest, mcpToolCount: manifest.mcpToolCount + 1 })).toThrow(/fingerprint/u);
  }, 120_000);

  it("安装态只从显式 release manifest 恢复同一 build identity", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-release-manifest-"));
    temporaryRoots.push(root);
    const manifest = await fixtureManifest();
    const manifestPath = path.join(root, "release-manifest.json");
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    process.env.AI_CANVAS_RELEASE_MANIFEST_PATH = manifestPath;
    const runtimeIdentity = await resolveRuntimeBuildIdentity(path.join(root, "missing-source-tree"), "2026-07-18T12:30:00.000Z");
    expect(runtimeIdentity).toMatchObject({
      buildId: manifest.buildId,
      sourceDigest: manifest.sourceDigest,
      packageVersion: "0.2.0",
      builtAtSource: "artifact",
      capabilities: { mcpToolCount: manifest.mcpToolCount },
    });
  }, 120_000);

  it("生成不依赖系统 Node 的 ELECTRON_RUN_AS_NODE 安全启动合同", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-runtime-contract-"));
    temporaryRoots.push(root);
    const contentsRoot = path.join(root, "AI 漫剧画布.app", "Contents");
    const executable = path.join(contentsRoot, "MacOS", "AI 漫剧画布");
    const serverPath = path.join(contentsRoot, "Resources", "app.asar.unpacked", "dist-mcp", "mcp", "server.js");
    const manifestPath = path.join(contentsRoot, "Resources", "release-manifest.json");
    await Promise.all([mkdir(path.dirname(executable), { recursive: true }), mkdir(path.dirname(serverPath), { recursive: true })]);
    const contract = createPackagedMcpRuntimeLaunchContract({
      appExecutable: executable,
      serverPath,
      releaseManifestPath: manifestPath,
      sourceDigest: "a".repeat(64),
      runtimeArtifactSha256: "b".repeat(64),
      builtAt: "2026-07-18T12:00:00.000Z",
      registryPath: path.join(root, "projects.json"),
    });
    expect(contract).toMatchObject({
      command: "/usr/bin/env",
      args: ["ELECTRON_RUN_AS_NODE=1", path.resolve(executable), path.resolve(serverPath)],
      env: {
        AI_CANVAS_RELEASE_MANIFEST_PATH: path.resolve(manifestPath),
        AI_CANVAS_RECORDED_SOURCE_DIGEST: "a".repeat(64),
        AI_CANVAS_RECORDED_RUNTIME_ARTIFACT_SHA256: "b".repeat(64),
        AI_CANVAS_BUILD_TIMESTAMP: "2026-07-18T12:00:00.000Z",
      },
    });
    expect(JSON.stringify(contract)).not.toMatch(/"command":"node"|\/usr\/local\/bin\/node/u);
    expect(() => createPackagedMcpRuntimeLaunchContract({
      appExecutable: executable,
      serverPath: path.join(root, "outside", "server.js"),
      releaseManifestPath: manifestPath,
      sourceDigest: "a".repeat(64),
      runtimeArtifactSha256: "b".repeat(64),
      builtAt: "2026-07-18T12:00:00.000Z",
    })).toThrow(/签名边界/u);
  });

  it("读取磁盘 manifest 时验证完整字段与 fingerprint", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-release-read-"));
    temporaryRoots.push(root);
    const manifest = await fixtureManifest();
    const manifestPath = path.join(root, "release-manifest.json");
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await expect(readReleaseManifest(manifestPath)).resolves.toEqual(manifest);
  }, 120_000);
});
