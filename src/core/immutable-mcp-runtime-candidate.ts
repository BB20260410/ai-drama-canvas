/**
 * 不可变 MCP 候选工件身份。
 *
 * `src/mcp/server.ts` 的在线门禁会核对入口 server.js，但 tsc 产物还会加载
 * `dist-mcp/core/**`。这里为完整 dist-mcp 树建立内容指纹与 receipt，避免只验
 * 入口文件时遗漏传递模块漂移。该 receipt 是构建证据，不替代 release manifest
 * 或运行时 currentness owner。
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  lstat,
  readFile,
  readdir,
  realpath,
} from "node:fs/promises";
import path from "node:path";
import {
  readReleaseManifest,
  type ReleaseManifest,
} from "./release-manifest.js";

export const IMMUTABLE_MCP_CANDIDATE_RECEIPT_FILE = "receipt.json" as const;
export const IMMUTABLE_MCP_CANDIDATE_ENTRY = "dist-mcp/mcp/server.js" as const;
export const IMMUTABLE_MCP_RUNTIME_TREE_ROOT = "dist-mcp" as const;

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const BUILD_ID_PATTERN = /^[a-f0-9]{32}$/u;
const CANDIDATE_ID_PATTERN = /^mcp-candidate-[a-f0-9]{16}-[a-f0-9]{16}-[a-f0-9]{8}$/u;
const MAX_RECEIPT_BYTES = 128 * 1024;

export interface ImmutableMcpRuntimeTreeEntry {
  relativePath: string;
  sizeBytes: number;
  sha256: string;
}

export interface ImmutableMcpRuntimeTreeIdentity {
  schemaVersion: 1;
  kind: "immutable-mcp-runtime-tree";
  relativeRoot: typeof IMMUTABLE_MCP_RUNTIME_TREE_ROOT;
  files: number;
  bytes: number;
  entries: ImmutableMcpRuntimeTreeEntry[];
  fingerprint: string;
}

export interface ImmutableMcpRuntimeCandidateReceipt {
  schemaVersion: 1;
  kind: "immutable-mcp-runtime-candidate-receipt";
  candidateId: string;
  sourceDigest: string;
  sourceFiles: number;
  sourceBytes: number;
  buildId: string;
  buildIdentityFingerprint: string;
  mcpToolCount: number;
  builtAt: string;
  releaseManifestFingerprint: string;
  entryRelativePath: typeof IMMUTABLE_MCP_CANDIDATE_ENTRY;
  entrySha256: string;
  runtimeTree: {
    relativeRoot: typeof IMMUTABLE_MCP_RUNTIME_TREE_ROOT;
    files: number;
    bytes: number;
    fingerprint: string;
  };
  fingerprint: string;
}

export interface VerifyImmutableMcpRuntimeCandidateOptions {
  requireDirectoryName?: boolean;
  requireReadOnly?: boolean;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([key, entry]) => [key, stableValue(entry)]));
  }
  return value;
}

function digest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(stableValue(value)), "utf8")
    .digest("hex");
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

function normalizedRelativePath(root: string, candidate: string): string {
  const relative = path.relative(root, candidate);
  if (!relative
    || relative === ".."
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)) {
    throw new Error(`MCP runtime tree 路径逃逸：${candidate}`);
  }
  return relative.split(path.sep).join("/");
}

async function assertCanonicalDirectory(directoryValue: string, label: string): Promise<string> {
  const directory = path.resolve(directoryValue);
  const metadata = await lstat(directory);
  if (!metadata.isDirectory()
    || metadata.isSymbolicLink()
    || await realpath(directory) !== directory) {
    throw new Error(`${label} 必须是规范绝对真实目录：${directory}`);
  }
  return directory;
}

export async function inspectImmutableMcpRuntimeTree(
  distMcpRootValue: string,
): Promise<ImmutableMcpRuntimeTreeIdentity> {
  const distMcpRoot = await assertCanonicalDirectory(distMcpRootValue, "dist-mcp");
  const entries: ImmutableMcpRuntimeTreeEntry[] = [];

  async function visit(directory: string): Promise<void> {
    const children = await readdir(directory, { withFileTypes: true });
    for (const child of children.sort((left, right) => left.name.localeCompare(right.name, "en"))) {
      const absolutePath = path.join(directory, child.name);
      const metadata = await lstat(absolutePath);
      if (metadata.isSymbolicLink()) {
        throw new Error(`MCP runtime tree 禁止符号链接：${normalizedRelativePath(distMcpRoot, absolutePath)}`);
      }
      if (metadata.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      if (!metadata.isFile() || metadata.nlink !== 1) {
        throw new Error(`MCP runtime tree 只接受单链接普通文件：${normalizedRelativePath(distMcpRoot, absolutePath)}`);
      }
      entries.push({
        relativePath: normalizedRelativePath(distMcpRoot, absolutePath),
        sizeBytes: metadata.size,
        sha256: await sha256File(absolutePath),
      });
    }
  }

  await visit(distMcpRoot);
  entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath, "en"));
  if (entries.length === 0) throw new Error("MCP runtime tree 为空。");
  if (!entries.some((entry) => entry.relativePath === "mcp/server.js")) {
    throw new Error("MCP runtime tree 缺少 mcp/server.js。");
  }
  const bytes = entries.reduce((sum, entry) => sum + entry.sizeBytes, 0);
  const semantic = {
    schemaVersion: 1 as const,
    kind: "immutable-mcp-runtime-tree" as const,
    relativeRoot: IMMUTABLE_MCP_RUNTIME_TREE_ROOT,
    files: entries.length,
    bytes,
    entries,
  };
  return {
    ...semantic,
    fingerprint: digest(semantic),
  };
}

function receiptBody(
  receipt: ImmutableMcpRuntimeCandidateReceipt,
): Omit<ImmutableMcpRuntimeCandidateReceipt, "fingerprint"> {
  const { fingerprint: _fingerprint, ...body } = receipt;
  return body;
}

function candidateId(
  manifest: ReleaseManifest,
  tree: ImmutableMcpRuntimeTreeIdentity,
): string {
  return [
    "mcp-candidate",
    manifest.sourceDigest.slice(0, 16),
    tree.fingerprint.slice(0, 16),
    manifest.fingerprint.slice(0, 8),
  ].join("-");
}

function assertReceipt(value: unknown): asserts value is ImmutableMcpRuntimeCandidateReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("MCP candidate receipt 必须是对象。");
  }
  const receipt = value as Partial<ImmutableMcpRuntimeCandidateReceipt>;
  if (receipt.schemaVersion !== 1
    || receipt.kind !== "immutable-mcp-runtime-candidate-receipt"
    || !CANDIDATE_ID_PATTERN.test(receipt.candidateId ?? "")
    || !SHA256_PATTERN.test(receipt.sourceDigest ?? "")
    || !Number.isSafeInteger(receipt.sourceFiles)
    || (receipt.sourceFiles ?? 0) < 1
    || !Number.isSafeInteger(receipt.sourceBytes)
    || (receipt.sourceBytes ?? 0) < 1
    || !BUILD_ID_PATTERN.test(receipt.buildId ?? "")
    || !SHA256_PATTERN.test(receipt.buildIdentityFingerprint ?? "")
    || !Number.isSafeInteger(receipt.mcpToolCount)
    || (receipt.mcpToolCount ?? 0) < 1
    || typeof receipt.builtAt !== "string"
    || Number.isNaN(Date.parse(receipt.builtAt))
    || !SHA256_PATTERN.test(receipt.releaseManifestFingerprint ?? "")
    || receipt.entryRelativePath !== IMMUTABLE_MCP_CANDIDATE_ENTRY
    || !SHA256_PATTERN.test(receipt.entrySha256 ?? "")
    || !receipt.runtimeTree
    || receipt.runtimeTree.relativeRoot !== IMMUTABLE_MCP_RUNTIME_TREE_ROOT
    || !Number.isSafeInteger(receipt.runtimeTree.files)
    || receipt.runtimeTree.files < 1
    || !Number.isSafeInteger(receipt.runtimeTree.bytes)
    || receipt.runtimeTree.bytes < 1
    || !SHA256_PATTERN.test(receipt.runtimeTree.fingerprint ?? "")
    || !SHA256_PATTERN.test(receipt.fingerprint ?? "")) {
    throw new Error("MCP candidate receipt 字段不完整或格式无效。");
  }
  if (digest(receiptBody(receipt as ImmutableMcpRuntimeCandidateReceipt)) !== receipt.fingerprint) {
    throw new Error("MCP candidate receipt fingerprint 与内容不一致。");
  }
}

export async function createImmutableMcpRuntimeCandidateReceipt(
  candidateRootValue: string,
): Promise<ImmutableMcpRuntimeCandidateReceipt> {
  const candidateRoot = await assertCanonicalDirectory(candidateRootValue, "MCP candidate root");
  const manifest = await readReleaseManifest(path.join(candidateRoot, "release-manifest.json"));
  const tree = await inspectImmutableMcpRuntimeTree(path.join(candidateRoot, IMMUTABLE_MCP_RUNTIME_TREE_ROOT));
  const entry = tree.entries.find((item) => item.relativePath === "mcp/server.js");
  if (!entry) throw new Error("MCP candidate entry 未进入 runtime tree。");
  const body: Omit<ImmutableMcpRuntimeCandidateReceipt, "fingerprint"> = {
    schemaVersion: 1,
    kind: "immutable-mcp-runtime-candidate-receipt",
    candidateId: candidateId(manifest, tree),
    sourceDigest: manifest.sourceDigest,
    sourceFiles: manifest.source.files,
    sourceBytes: manifest.source.bytes,
    buildId: manifest.buildId,
    buildIdentityFingerprint: manifest.buildIdentityFingerprint,
    mcpToolCount: manifest.mcpToolCount,
    builtAt: manifest.builtAt,
    releaseManifestFingerprint: manifest.fingerprint,
    entryRelativePath: IMMUTABLE_MCP_CANDIDATE_ENTRY,
    entrySha256: entry.sha256,
    runtimeTree: {
      relativeRoot: IMMUTABLE_MCP_RUNTIME_TREE_ROOT,
      files: tree.files,
      bytes: tree.bytes,
      fingerprint: tree.fingerprint,
    },
  };
  return { ...body, fingerprint: digest(body) };
}

export function serializeImmutableMcpRuntimeCandidateReceipt(
  receipt: ImmutableMcpRuntimeCandidateReceipt,
): string {
  assertReceipt(receipt);
  return `${JSON.stringify(receipt, null, 2)}\n`;
}

export async function readImmutableMcpRuntimeCandidateReceipt(
  candidateRootValue: string,
): Promise<ImmutableMcpRuntimeCandidateReceipt> {
  const candidateRoot = await assertCanonicalDirectory(candidateRootValue, "MCP candidate root");
  const receiptPath = path.join(candidateRoot, IMMUTABLE_MCP_CANDIDATE_RECEIPT_FILE);
  const metadata = await lstat(receiptPath);
  if (!metadata.isFile()
    || metadata.isSymbolicLink()
    || metadata.nlink !== 1
    || metadata.size < 2
    || metadata.size > MAX_RECEIPT_BYTES) {
    throw new Error("MCP candidate receipt 不是受限单链接普通文件。");
  }
  const value = JSON.parse(await readFile(receiptPath, "utf8")) as unknown;
  assertReceipt(value);
  return value;
}

async function assertCandidateReadOnly(candidateRoot: string): Promise<void> {
  async function visit(absolutePath: string): Promise<void> {
    const metadata = await lstat(absolutePath);
    if (metadata.isSymbolicLink()) {
      throw new Error(`不可变 MCP candidate 禁止符号链接：${absolutePath}`);
    }
    if ((metadata.mode & 0o222) !== 0) {
      throw new Error(`不可变 MCP candidate 仍可写：${absolutePath}`);
    }
    if (!metadata.isDirectory()) return;
    for (const child of await readdir(absolutePath)) {
      await visit(path.join(absolutePath, child));
    }
  }
  await visit(candidateRoot);
}

export async function sealImmutableMcpRuntimeCandidate(
  candidateRootValue: string,
): Promise<void> {
  const candidateRoot = await assertCanonicalDirectory(candidateRootValue, "MCP candidate root");
  async function seal(absolutePath: string): Promise<void> {
    const metadata = await lstat(absolutePath);
    if (metadata.isSymbolicLink()) {
      throw new Error(`不可变 MCP candidate 禁止符号链接：${absolutePath}`);
    }
    if (metadata.isDirectory()) {
      for (const child of await readdir(absolutePath)) {
        await seal(path.join(absolutePath, child));
      }
      await chmod(absolutePath, 0o555);
      return;
    }
    if (!metadata.isFile() || metadata.nlink !== 1) {
      throw new Error(`不可变 MCP candidate 只接受单链接普通文件：${absolutePath}`);
    }
    const relative = path.relative(candidateRoot, absolutePath).split(path.sep).join("/");
    await chmod(absolutePath, relative === IMMUTABLE_MCP_CANDIDATE_ENTRY ? 0o555 : 0o444);
  }
  await seal(candidateRoot);
}

export async function verifyImmutableMcpRuntimeCandidate(
  candidateRootValue: string,
  options: VerifyImmutableMcpRuntimeCandidateOptions = {},
): Promise<ImmutableMcpRuntimeCandidateReceipt> {
  const candidateRoot = await assertCanonicalDirectory(candidateRootValue, "MCP candidate root");
  const receipt = await readImmutableMcpRuntimeCandidateReceipt(candidateRoot);
  if (options.requireDirectoryName !== false && path.basename(candidateRoot) !== receipt.candidateId) {
    throw new Error("MCP candidate 目录名与 receipt candidateId 不一致。");
  }
  const manifest = await readReleaseManifest(path.join(candidateRoot, "release-manifest.json"));
  if (manifest.sourceDigest !== receipt.sourceDigest
    || manifest.source.files !== receipt.sourceFiles
    || manifest.source.bytes !== receipt.sourceBytes
    || manifest.buildId !== receipt.buildId
    || manifest.buildIdentityFingerprint !== receipt.buildIdentityFingerprint
    || manifest.mcpToolCount !== receipt.mcpToolCount
    || manifest.builtAt !== receipt.builtAt
    || manifest.fingerprint !== receipt.releaseManifestFingerprint) {
    throw new Error("MCP candidate release manifest 与 receipt 身份不一致。");
  }
  const tree = await inspectImmutableMcpRuntimeTree(path.join(candidateRoot, IMMUTABLE_MCP_RUNTIME_TREE_ROOT));
  const entry = tree.entries.find((item) => item.relativePath === "mcp/server.js");
  if (!entry
    || entry.sha256 !== receipt.entrySha256
    || tree.files !== receipt.runtimeTree.files
    || tree.bytes !== receipt.runtimeTree.bytes
    || tree.fingerprint !== receipt.runtimeTree.fingerprint) {
    throw new Error("MCP candidate runtime tree fingerprint 不一致；入口或传递 core 工件已漂移。");
  }
  const expectedId = candidateId(manifest, tree);
  if (expectedId !== receipt.candidateId) {
    throw new Error("MCP candidateId 与 release/runtime tree 内容不一致。");
  }
  if (options.requireReadOnly !== false) await assertCandidateReadOnly(candidateRoot);
  return receipt;
}
