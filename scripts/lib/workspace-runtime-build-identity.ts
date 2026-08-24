import path from "node:path";
import type { Page } from "playwright";
import { computeSourceDigest } from "../../src/core/build-identity.js";
import { readReleaseManifest } from "../../src/core/release-manifest.js";

export interface WorkspaceRuntimeBuildIdentityInputs {
  liveSource: {
    sourceDigest: string;
    sourceFiles: number;
    sourceBytes: number;
  };
  manifest: {
    sourceDigest: string;
    buildId: string;
    buildIdentityFingerprint: string;
    mcpToolCount: number;
    source: { files: number; bytes: number };
  };
  runtime: {
    identity: {
      schemaVersion: number;
      kind: string;
      sourceDigest: string;
      buildId: string;
      fingerprint: string;
      capabilities: { mcpToolCount: number };
      roots: { sourceFiles: number; sourceBytes: number };
    };
    gate: {
      sourceIdentityMode: string;
      artifactSourceDigest: string;
      bootSourceDigest: string;
      currentSourceDigest?: string;
      allowed: boolean;
      restartRequired: boolean;
      reasons: string[];
    };
  };
}

export interface WorkspaceRuntimeBuildIdentityEvidence {
  schemaVersion: 1;
  kind: "workspace-runtime-build-identity-evidence";
  sourceDigest: string;
  buildId: string;
  buildIdentityFingerprint: string;
  mcpToolCount: number;
  sourceFiles: number;
  sourceBytes: number;
  artifactSourceDigest: string;
  runtimeGateAllowed: true;
}

function exact(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    throw new Error(`workspace runtime build identity ${label} 不一致。`);
  }
}

export function assertWorkspaceRuntimeBuildIdentityValues(
  input: WorkspaceRuntimeBuildIdentityInputs,
): WorkspaceRuntimeBuildIdentityEvidence {
  const { liveSource, manifest, runtime } = input;
  exact(liveSource.sourceDigest, manifest.sourceDigest, "live source 与 manifest sourceDigest");
  exact(liveSource.sourceFiles, manifest.source.files, "live source 与 manifest sourceFiles");
  exact(liveSource.sourceBytes, manifest.source.bytes, "live source 与 manifest sourceBytes");

  exact(runtime.identity.schemaVersion, 1, "runtime identity schemaVersion");
  exact(runtime.identity.kind, "build-identity", "runtime identity kind");
  exact(runtime.identity.sourceDigest, manifest.sourceDigest, "runtime identity sourceDigest");
  exact(runtime.identity.buildId, manifest.buildId, "runtime identity buildId");
  exact(runtime.identity.fingerprint, manifest.buildIdentityFingerprint, "runtime identity fingerprint");
  exact(runtime.identity.capabilities.mcpToolCount, manifest.mcpToolCount, "runtime identity mcpToolCount");
  exact(runtime.identity.roots.sourceFiles, manifest.source.files, "runtime identity sourceFiles");
  exact(runtime.identity.roots.sourceBytes, manifest.source.bytes, "runtime identity sourceBytes");

  exact(runtime.gate.sourceIdentityMode, "workspace", "runtime gate sourceIdentityMode");
  exact(runtime.gate.artifactSourceDigest, manifest.sourceDigest, "runtime gate artifactSourceDigest");
  exact(runtime.gate.bootSourceDigest, manifest.sourceDigest, "runtime gate bootSourceDigest");
  exact(runtime.gate.currentSourceDigest, manifest.sourceDigest, "runtime gate currentSourceDigest");
  if (runtime.gate.allowed !== true
    || runtime.gate.restartRequired !== false
    || runtime.gate.reasons.length !== 0) {
    throw new Error(`workspace runtime build identity runtime gate 未放行：${runtime.gate.reasons.join(",") || "unknown"}`);
  }

  return {
    schemaVersion: 1,
    kind: "workspace-runtime-build-identity-evidence",
    sourceDigest: manifest.sourceDigest,
    buildId: manifest.buildId,
    buildIdentityFingerprint: manifest.buildIdentityFingerprint,
    mcpToolCount: manifest.mcpToolCount,
    sourceFiles: manifest.source.files,
    sourceBytes: manifest.source.bytes,
    artifactSourceDigest: runtime.gate.artifactSourceDigest,
    runtimeGateAllowed: true,
  };
}

export async function assertWorkspaceRuntimeBuildIdentity(
  workspace: string,
  page: Page,
): Promise<WorkspaceRuntimeBuildIdentityEvidence> {
  const root = path.resolve(workspace);
  const [liveSource, manifest, runtime] = await Promise.all([
    computeSourceDigest(root),
    readReleaseManifest(path.join(root, "release-manifest.json")),
    page.evaluate(async () => {
      const api = (window as Window & {
        canvasApi?: {
          getRuntimeBuildIdentity?: () => Promise<WorkspaceRuntimeBuildIdentityInputs["runtime"]["identity"]>;
          getRuntimeWriteGate?: () => Promise<WorkspaceRuntimeBuildIdentityInputs["runtime"]["gate"]>;
        };
      }).canvasApi;
      if (typeof api?.getRuntimeBuildIdentity !== "function"
        || typeof api.getRuntimeWriteGate !== "function") {
        throw new Error("workspace runtime build identity API 不可用。");
      }
      const [identity, gate] = await Promise.all([
        api.getRuntimeBuildIdentity(),
        api.getRuntimeWriteGate(),
      ]);
      return { identity, gate };
    }),
  ]);
  return assertWorkspaceRuntimeBuildIdentityValues({ liveSource, manifest, runtime });
}
