import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AI_CANVAS_APPLICATION_VERSION,
  AI_CANVAS_PROTOCOL_VERSION,
  releaseManifestDigest,
} from "../src/core/release-manifest.js";
import {
  installedApplicationReleaseManifestPath,
  readInstalledApplicationReleaseIdentity,
} from "../scripts/p14-installed-runtime-identity-guards.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function installedFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "p14-installed-identity-"));
  roots.push(root);
  const appRoot = path.join(root, "AI 漫剧画布.app");
  const executablePath = path.join(appRoot, "Contents", "MacOS", "AI 漫剧画布");
  const manifestPath = path.join(appRoot, "Contents", "Resources", "release-manifest.json");
  await Promise.all([mkdir(path.dirname(executablePath), { recursive: true }), mkdir(path.dirname(manifestPath), { recursive: true })]);
  await writeFile(executablePath, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(executablePath, 0o755);
  const body = {
    schemaVersion: 1 as const,
    kind: "ai-drama-canvas-release-manifest" as const,
    version: AI_CANVAS_APPLICATION_VERSION,
    architecture: process.arch,
    sourceDigest: "a".repeat(64),
    buildId: "b".repeat(32),
    buildIdentityFingerprint: "c".repeat(64),
    protocolVersion: AI_CANVAS_PROTOCOL_VERSION,
    mcpToolCount: 183,
    builtAt: "2026-07-18T00:00:00.000Z",
    distribution: "local-only" as const,
    localOnly: true as const,
    source: { files: 10, bytes: 1_000 },
  };
  const manifest = { ...body, fingerprint: releaseManifestDigest(body) };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { executablePath, manifestPath, manifest };
}

describe("P14 installed scale/soak release identity guards", () => {
  it("身份只来自被启动 App 自身 Resources manifest，并保留版本与双 fingerprint", async () => {
    const fixture = await installedFixture();
    expect(installedApplicationReleaseManifestPath(fixture.executablePath)).toBe(fixture.manifestPath);
    await expect(readInstalledApplicationReleaseIdentity(fixture.executablePath)).resolves.toEqual({
      source: "installed-app-resources-release-manifest",
      executablePath: fixture.executablePath,
      manifestPath: fixture.manifestPath,
      version: fixture.manifest.version,
      sourceDigest: fixture.manifest.sourceDigest,
      buildId: fixture.manifest.buildId,
      fingerprint: fixture.manifest.buildIdentityFingerprint,
      releaseManifestFingerprint: fixture.manifest.fingerprint,
    });
    expect(() => installedApplicationReleaseManifestPath("/usr/bin/electron")).toThrow(/\.app\/Contents\/MacOS/);
  });

  it("Resources manifest 被篡改时失败关闭，不能退回工作区身份", async () => {
    const fixture = await installedFixture();
    const manifest = JSON.parse(await readFile(fixture.manifestPath, "utf8")) as Record<string, unknown>;
    await writeFile(fixture.manifestPath, `${JSON.stringify({ ...manifest, sourceDigest: "d".repeat(64) }, null, 2)}\n`, "utf8");
    await expect(readInstalledApplicationReleaseIdentity(fixture.executablePath)).rejects.toThrow(/fingerprint/);
  });

  it("installed scale 与 soak 均使用同一 Resources guard，不以 workspace identity 记录安装版", async () => {
    const workspace = path.resolve(import.meta.dirname, "..");
    const [scale, soak] = await Promise.all([
      readFile(path.join(workspace, "scripts/ui-managed-studio-scale-canvas-smoke.ts"), "utf8"),
      readFile(path.join(workspace, "scripts/ui-p14-installed-soak-smoke.ts"), "utf8"),
    ]);
    expect(scale).toContain("readInstalledApplicationReleaseIdentity(installedExecutable)");
    expect(scale).toContain("installedBuildIdentity");
    expect(soak).toContain("readInstalledApplicationReleaseIdentity(executable)");
    expect(soak).not.toContain("createBuildIdentity(workspace)");
    for (const source of [scale, soak]) {
      for (const field of ["version", "sourceDigest", "buildId", "fingerprint", "releaseManifestFingerprint"]) {
        expect(source).toContain(field);
      }
    }
  });
});
