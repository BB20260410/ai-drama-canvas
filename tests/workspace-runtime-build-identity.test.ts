import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  assertWorkspaceRuntimeBuildIdentityValues,
  type WorkspaceRuntimeBuildIdentityInputs,
} from "../scripts/lib/workspace-runtime-build-identity.js";

const SOURCE_DIGEST = "a".repeat(64);
const BUILD_ID = "b".repeat(32);
const IDENTITY_FINGERPRINT = "c".repeat(64);

function validInputs(): WorkspaceRuntimeBuildIdentityInputs {
  return {
    liveSource: {
      sourceDigest: SOURCE_DIGEST,
      sourceFiles: 1055,
      sourceBytes: 20_000_000,
    },
    manifest: {
      sourceDigest: SOURCE_DIGEST,
      buildId: BUILD_ID,
      buildIdentityFingerprint: IDENTITY_FINGERPRINT,
      mcpToolCount: 220,
      source: { files: 1055, bytes: 20_000_000 },
    },
    runtime: {
      identity: {
        schemaVersion: 1,
        kind: "build-identity",
        sourceDigest: SOURCE_DIGEST,
        buildId: BUILD_ID,
        fingerprint: IDENTITY_FINGERPRINT,
        capabilities: { mcpToolCount: 220 },
        roots: { sourceFiles: 1055, sourceBytes: 20_000_000 },
      },
      gate: {
        sourceIdentityMode: "workspace",
        artifactSourceDigest: SOURCE_DIGEST,
        bootSourceDigest: SOURCE_DIGEST,
        currentSourceDigest: SOURCE_DIGEST,
        allowed: true,
        restartRequired: false,
        reasons: [],
      },
    },
  };
}

describe("workspace Electron 构建身份门", () => {
  it("只接受 live source、manifest、runtime identity 与 artifact gate 四方完全一致", () => {
    expect(assertWorkspaceRuntimeBuildIdentityValues(validInputs())).toEqual({
      schemaVersion: 1,
      kind: "workspace-runtime-build-identity-evidence",
      sourceDigest: SOURCE_DIGEST,
      buildId: BUILD_ID,
      buildIdentityFingerprint: IDENTITY_FINGERPRINT,
      mcpToolCount: 220,
      sourceFiles: 1055,
      sourceBytes: 20_000_000,
      artifactSourceDigest: SOURCE_DIGEST,
      runtimeGateAllowed: true,
    });
  });

  it("旧 out 工件的内嵌摘要即使 runtime identity 读取 live source 也失败关闭", () => {
    const input = validInputs();
    input.runtime.gate.artifactSourceDigest = "d".repeat(64);
    expect(() => assertWorkspaceRuntimeBuildIdentityValues(input)).toThrow(/artifactSourceDigest/u);
  });

  it("manifest 漂移、工具数漂移或 runtime gate 拒绝都不得生成 PASS 证据", () => {
    const manifestDrift = validInputs();
    manifestDrift.manifest.sourceDigest = "e".repeat(64);
    expect(() => assertWorkspaceRuntimeBuildIdentityValues(manifestDrift)).toThrow(/live source.*manifest/u);

    const toolDrift = validInputs();
    toolDrift.runtime.identity.capabilities.mcpToolCount = 219;
    expect(() => assertWorkspaceRuntimeBuildIdentityValues(toolDrift)).toThrow(/mcpToolCount/u);

    const gateDenied = validInputs();
    gateDenied.runtime.gate.allowed = false;
    gateDenied.runtime.gate.restartRequired = true;
    gateDenied.runtime.gate.reasons = ["source-changed"];
    expect(() => assertWorkspaceRuntimeBuildIdentityValues(gateDenied)).toThrow(/runtime gate/u);
  });

  it("P5、P17 与 T23 build 三条真实 Electron 验收必须复用同一身份门并落证据", async () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const sources = await Promise.all([
      "scripts/ui-p5-multimedia-formal-smoke.ts",
      "scripts/ui-p17-navigation-support-smoke.ts",
      "scripts/t23-scale-performance-dev-smoke.ts",
    ].map((relativePath) => readFile(path.join(root, relativePath), "utf8")));
    for (const source of sources) {
      expect(source).toContain("assertWorkspaceRuntimeBuildIdentity");
      expect(source).toContain("runtimeBuildIdentity");
    }
  });
});
