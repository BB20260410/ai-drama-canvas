import { lstat, readdir, realpath } from "node:fs/promises";
import * as nodeModule from "node:module";
import path from "node:path";
import { computeSourceDigest } from "./build-identity.js";
import {
  IMMUTABLE_MCP_CANDIDATE_ENTRY,
  type ImmutableMcpRuntimeCandidateReceipt,
} from "./immutable-mcp-runtime-candidate.js";
import {
  IMMUTABLE_MCP_PUBLICATION_DIRECTORY,
  IMMUTABLE_MCP_RUNTIME_GUARD_FILE,
  readImmutableMcpCandidatePublicationRecord,
  verifyPublishedImmutableMcpRuntimeCandidate,
  type ImmutableMcpCandidatePublicationRecord,
} from "./immutable-mcp-runtime-publication.js";
import { countDeclaredMcpTools } from "./release-manifest.js";

export const CURRENT_MCP_CANDIDATES_RELATIVE_ROOT = ".aicanvas-runtime/mcp-candidates" as const;
export const CURRENT_MCP_LAUNCHER_RELATIVE_PATH = ".aicanvas-runtime/mcp-launcher/current.mjs" as const;

export type CurrentMcpRuntimeErrorCode =
  | "CURRENT_MCP_CANDIDATES_MISSING"
  | "CURRENT_MCP_LAUNCHER_MISSING"
  | "CURRENT_MCP_CANDIDATE_NOT_FOUND";

export class CurrentMcpRuntimeError extends Error {
  readonly code: CurrentMcpRuntimeErrorCode;

  constructor(code: CurrentMcpRuntimeErrorCode, message: string) {
    super(message);
    this.name = "CurrentMcpRuntimeError";
    this.code = code;
  }
}

export interface ResolveCurrentMcpRuntimeInput {
  workspace: string;
}

export interface CurrentMcpRuntimeCapabilities {
  nodeVersion: string;
  nodeModulesAbi: string;
  registerHooksAvailable: boolean;
}

const MINIMUM_MCP_NODE_MAJOR = 22;

function isUnsafeMcpEnvironmentKey(key: string): boolean {
  return key === "NODE_OPTIONS"
    || key === "NODE_PATH"
    || key.startsWith("DYLD_")
    || key.startsWith("LD_");
}

export function sanitizedMcpChildEnvironment(
  inherited: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(inherited)) {
    if (value !== undefined && !isUnsafeMcpEnvironmentKey(key)) sanitized[key] = value;
  }
  return sanitized;
}

export function unsafeMcpEnvironmentKeys(
  inherited: NodeJS.ProcessEnv = process.env,
): string[] {
  return Object.keys(inherited).filter(isUnsafeMcpEnvironmentKey).sort((left, right) => left.localeCompare(right, "en"));
}

export function assertCurrentMcpRuntimeCapabilities(
  capabilities: CurrentMcpRuntimeCapabilities = {
    nodeVersion: process.versions.node,
    nodeModulesAbi: process.versions.modules,
    registerHooksAvailable: typeof nodeModule.registerHooks === "function",
  },
): void {
  const nodeMajor = Number.parseInt(capabilities.nodeVersion.split(".")[0] ?? "", 10);
  if (!Number.isSafeInteger(nodeMajor)
    || nodeMajor < MINIMUM_MCP_NODE_MAJOR
    || !capabilities.nodeModulesAbi
    || !capabilities.registerHooksAvailable) {
    throw new Error(
      `不可变 MCP runtime 需要 Node.js 22+ 且 node:module.registerHooks 可用；当前 Node=${capabilities.nodeVersion || "unknown"} ABI=${capabilities.nodeModulesAbi || "unknown"} registerHooks=${capabilities.registerHooksAvailable}.`,
    );
  }
}

async function assertCanonicalDirectory(directoryValue: string, label: string): Promise<string> {
  const directory = path.resolve(directoryValue);
  const metadata = await lstat(directory);
  const canonical = await realpath(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || canonical !== directory) {
    throw new Error(`${label} 必须是非符号链接的规范真实目录：${directory}`);
  }
  return directory;
}

async function assertCanonicalFile(fileValue: string, label: string): Promise<string> {
  const filePath = path.resolve(fileValue);
  const metadata = await lstat(filePath);
  const canonical = await realpath(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || canonical !== filePath) {
    throw new Error(`${label} 必须是非符号链接的单链接规范真实文件：${filePath}`);
  }
  return filePath;
}

export interface CurrentMcpRuntimeResolution {
  schemaVersion: 1;
  kind: "current-immutable-mcp-runtime";
  workspace: string;
  candidatesRoot: string;
  candidateRoot: string;
  runtimeRoot: string;
  entryPath: string;
  guardPath: string;
  launcherPath: string;
  releaseManifestPath: string;
  receipt: ImmutableMcpRuntimeCandidateReceipt;
  publication: ImmutableMcpCandidatePublicationRecord;
  expected: {
    sourceDigest: string;
    sourceFiles: number;
    sourceBytes: number;
    mcpToolCount: number;
  };
  inspectedCandidates: number;
  invalidCandidates: number;
}

function missingCandidateMessage(expected: CurrentMcpRuntimeResolution["expected"]): string {
  return [
    "没有与当前源码完全一致的不可变 MCP candidate，已拒绝启动旧版。",
    `当前 sourceDigest=${expected.sourceDigest}，tools=${expected.mcpToolCount}，files=${expected.sourceFiles}。`,
    "请在工作区执行：npm run mcp:candidate:build",
  ].join(" ");
}

/**
 * 选择当前工作区唯一可接受的不可变 MCP 工件。
 *
 * 正式选择只枚举候选根外的 publication record；candidate 自身即使 receipt、
 * manifest 与运行树完全自洽，没有受控 publication 也不会进入候选集。联合验证
 * 还绑定生产 node_modules、lockfile、module guard 与稳定 launcher。
 */
export async function resolveCurrentMcpRuntime(
  input: ResolveCurrentMcpRuntimeInput,
): Promise<CurrentMcpRuntimeResolution> {
  assertCurrentMcpRuntimeCapabilities();
  const workspace = await realpath(path.resolve(input.workspace));
  const candidatesRootValue = path.join(workspace, ...CURRENT_MCP_CANDIDATES_RELATIVE_ROOT.split("/"));
  let candidatesRoot: string;
  try {
    candidatesRoot = await assertCanonicalDirectory(candidatesRootValue, "MCP candidate 根");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new CurrentMcpRuntimeError(
        "CURRENT_MCP_CANDIDATES_MISSING",
        `MCP candidate 根不存在，已拒绝回退到 dist-mcp：${candidatesRootValue}。请执行：npm run mcp:candidate:build`,
      );
    }
    throw error;
  }
  const launcherPathValue = path.join(workspace, ...CURRENT_MCP_LAUNCHER_RELATIVE_PATH.split("/"));
  let launcherPath: string;
  try {
    launcherPath = await assertCanonicalFile(launcherPathValue, "稳定 MCP launcher");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new CurrentMcpRuntimeError(
        "CURRENT_MCP_LAUNCHER_MISSING",
        `稳定 MCP launcher 不存在，已拒绝回退到 tsx：${launcherPathValue}。请执行：npm run mcp:candidate:build`,
      );
    }
    throw error;
  }
  const publicationRootValue = path.join(candidatesRoot, IMMUTABLE_MCP_PUBLICATION_DIRECTORY);
  let publicationRoot: string;
  try {
    publicationRoot = await assertCanonicalDirectory(publicationRootValue, "MCP publication 根");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new CurrentMcpRuntimeError(
        "CURRENT_MCP_CANDIDATE_NOT_FOUND",
        "MCP publication 根不存在；旧 v1 candidate 仅保留为历史，已拒绝启动。请执行：npm run mcp:candidate:build",
      );
    }
    throw error;
  }

  const [source, mcpToolCount, entries] = await Promise.all([
    computeSourceDigest(workspace),
    countDeclaredMcpTools(workspace),
    readdir(publicationRoot, { withFileTypes: true }),
  ]);
  const expected = { ...source, mcpToolCount };
  const publicationPaths = entries
    .filter((entry) => entry.isFile() && entry.name.startsWith("mcp-candidate-") && entry.name.endsWith(".json"))
    .map((entry) => path.join(publicationRoot, entry.name));
  const readPublications = await Promise.all(publicationPaths.map(async (publicationPath) => {
    try {
      return await readImmutableMcpCandidatePublicationRecord(publicationPath);
    } catch {
      return null;
    }
  }));
  const validPublications = readPublications.filter(
    (entry): entry is ImmutableMcpCandidatePublicationRecord => entry !== null,
  );
  const matchingPublications = validPublications.filter((publication) => publication.sourceDigest === source.sourceDigest
    && publication.sourceFiles === source.sourceFiles
    && publication.sourceBytes === source.sourceBytes
    && publication.mcpToolCount === mcpToolCount);
  const inspectedMatching = await Promise.all(matchingPublications.map(async (publication) => {
    const candidateRoot = path.join(candidatesRoot, publication.candidateId);
    try {
      const receipt = await verifyPublishedImmutableMcpRuntimeCandidate(candidateRoot, publication, { launcherPath });
      return { candidateRoot: await realpath(candidateRoot), receipt, publication };
    } catch {
      return null;
    }
  }));
  const matching = inspectedMatching.filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  matching.sort((left, right) => Date.parse(right.publication.publishedAt) - Date.parse(left.publication.publishedAt)
    || right.receipt.candidateId.localeCompare(left.receipt.candidateId, "en"));
  const selected = matching[0];
  if (!selected) {
    throw new CurrentMcpRuntimeError(
      "CURRENT_MCP_CANDIDATE_NOT_FOUND",
      missingCandidateMessage(expected),
    );
  }
  return {
    schemaVersion: 1,
    kind: "current-immutable-mcp-runtime",
    workspace,
    candidatesRoot,
    candidateRoot: selected.candidateRoot,
    runtimeRoot: selected.candidateRoot,
    entryPath: path.join(selected.candidateRoot, ...IMMUTABLE_MCP_CANDIDATE_ENTRY.split("/")),
    guardPath: path.join(selected.candidateRoot, IMMUTABLE_MCP_RUNTIME_GUARD_FILE),
    launcherPath,
    releaseManifestPath: path.join(selected.candidateRoot, "release-manifest.json"),
    receipt: selected.receipt,
    publication: selected.publication,
    expected,
    inspectedCandidates: publicationPaths.length,
    invalidCandidates: readPublications.length - validPublications.length
      + inspectedMatching.length - matching.length,
  };
}

export function currentMcpRuntimeArguments(resolution: CurrentMcpRuntimeResolution): string[] {
  return ["--import", resolution.guardPath, resolution.entryPath];
}

export function currentMcpRuntimeEnvironment(
  resolution: CurrentMcpRuntimeResolution,
  inherited: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  return {
    ...sanitizedMcpChildEnvironment(inherited),
    AI_CANVAS_WORKSPACE: resolution.workspace,
    AI_CANVAS_RELEASE_MANIFEST_PATH: resolution.releaseManifestPath,
    AI_CANVAS_RECORDED_SOURCE_DIGEST: resolution.receipt.sourceDigest,
    AI_CANVAS_RECORDED_RUNTIME_ARTIFACT_SHA256: resolution.receipt.entrySha256,
    AI_CANVAS_BUILD_TIMESTAMP: resolution.receipt.builtAt,
    AI_CANVAS_MCP_RUNTIME_ROOT: resolution.runtimeRoot,
  };
}
