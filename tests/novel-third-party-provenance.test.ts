import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

interface DonorManifest {
  schemaVersion: number;
  policy: {
    allowedLicenses: string[];
    agplPolicy: string;
  };
  donors: Array<{
    name: string;
    repository: string;
    commit: string;
    tree: string;
    status: string;
    containsUpstreamImplementation: boolean;
    license: {
      spdx: string;
      upstreamPath: string;
      upstreamSha256: string;
      upstreamBytes: number;
      localPath: string;
      localSha256: string;
      localBytes: number;
      normalization: string;
    };
    sourceFiles: Array<{
      path: string;
      sha256: string;
      plannedLocalTargets: string[];
      adaptation: string;
    }>;
  }>;
  excludedImplementationSources: Array<{
    name: string;
    license: string;
    policy: string;
  }>;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeRepositoryPath(relativePath: string): string {
  expect(relativePath).not.toMatch(/^(?:\/|[A-Za-z]:[\\/])/u);
  const resolved = path.resolve(workspace, relativePath);
  const relative = path.relative(workspace, resolved);
  expect(relative).not.toBe("");
  expect(relative).not.toBe("..");
  expect(relative.startsWith(`..${path.sep}`)).toBe(false);
  expect(path.isAbsolute(relative)).toBe(false);
  return resolved;
}

describe("小说模式第三方来源与许可证门", () => {
  it("donor manifest 锁定 commit/tree/source SHA，且 P0 尚未宣称已复制实现", async () => {
    const manifest = JSON.parse(await readFile(
      path.join(workspace, "docs/third-party/novel-donors.json"),
      "utf8",
    )) as DonorManifest;

    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.policy.allowedLicenses).toEqual(["MIT", "Apache-2.0"]);
    expect(manifest.policy.agplPolicy).toMatch(/no-copy-no-link-no-translation/u);
    expect(manifest.donors.map((donor) => donor.name)).toEqual(["CharacterArc", "OpenFic"]);

    const sourceKeys = new Set<string>();
    for (const donor of manifest.donors) {
      expect(donor.repository).toMatch(/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u);
      expect(donor.commit).toMatch(/^[a-f0-9]{40}$/u);
      expect(donor.tree).toMatch(/^[a-f0-9]{40}$/u);
      expect(donor.status).toBe("audited-planned-not-copied");
      expect(donor.containsUpstreamImplementation).toBe(false);
      expect(donor.sourceFiles.length).toBeGreaterThan(0);
      for (const source of donor.sourceFiles) {
        expect(source.path).not.toMatch(/^(?:\/|\.\.?\/)/u);
        expect(source.sha256).toMatch(/^[a-f0-9]{64}$/u);
        expect(source.adaptation.trim().length).toBeGreaterThan(20);
        expect(source.plannedLocalTargets.length).toBeGreaterThan(0);
        expect(source.plannedLocalTargets.every((target) => target.startsWith("src/"))).toBe(true);
        const key = `${donor.name}:${source.path}`;
        expect(sourceKeys.has(key)).toBe(false);
        sourceKeys.add(key);
      }
    }
    expect(sourceKeys.size).toBe(11);

    const inkos = manifest.excludedImplementationSources.find((entry) => entry.name === "InkOS");
    expect(inkos).toMatchObject({ license: "AGPL-3.0" });
    expect(inkos?.policy).toMatch(/No source copy.*translation.*linking.*dependency/u);
  });

  it("本地许可证字节、标准化说明与 THIRD_PARTY_NOTICES 锁定值一致", async () => {
    const manifest = JSON.parse(await readFile(
      path.join(workspace, "docs/third-party/novel-donors.json"),
      "utf8",
    )) as DonorManifest;
    const notices = await readFile(path.join(workspace, "THIRD_PARTY_NOTICES.md"), "utf8");

    for (const donor of manifest.donors) {
      const licensePath = safeRepositoryPath(donor.license.localPath);
      const bytes = await readFile(licensePath);
      expect(bytes.byteLength).toBe(donor.license.localBytes);
      expect(sha256(bytes)).toBe(donor.license.localSha256);
      expect(notices).toContain(donor.commit);
      expect(notices).toContain(donor.tree);
      expect(notices).toContain(donor.license.localPath);
      if (donor.license.normalization === "byte-identical") {
        expect(donor.license.localBytes).toBe(donor.license.upstreamBytes);
        expect(donor.license.localSha256).toBe(donor.license.upstreamSha256);
      } else {
        expect(donor.license.normalization).toContain("one terminal LF was appended");
        expect(bytes.at(-1)).toBe(0x0a);
        const upstreamBytes = bytes.subarray(0, -1);
        expect(upstreamBytes.byteLength).toBe(donor.license.upstreamBytes);
        expect(sha256(upstreamBytes)).toBe(donor.license.upstreamSha256);
      }
    }
  });
});
