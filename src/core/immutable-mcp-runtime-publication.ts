import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import {
  verifyImmutableMcpRuntimeCandidate,
  type ImmutableMcpRuntimeCandidateReceipt,
} from "./immutable-mcp-runtime-candidate.js";

export const IMMUTABLE_MCP_PUBLICATION_DIRECTORY = ".published" as const;
export const IMMUTABLE_MCP_DEPENDENCY_ROOT = "node_modules" as const;
export const IMMUTABLE_MCP_RUNTIME_GUARD_FILE = "runtime-guard.mjs" as const;
export const IMMUTABLE_MCP_PACKAGE_FILE = "package.json" as const;
export const IMMUTABLE_MCP_PACKAGE_LOCK_FILE = "package-lock.json" as const;

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const CANDIDATE_ID_PATTERN = /^mcp-candidate-[a-f0-9]{16}-[a-f0-9]{16}-[a-f0-9]{8}$/u;
const PUBLICATION_FILE_PATTERN = /^mcp-candidate-[a-f0-9]{16}-[a-f0-9]{16}-[a-f0-9]{8}\.json$/u;
const MAX_PUBLICATION_BYTES = 128 * 1024;

export interface ImmutableMcpDependencyTreeEntry {
  relativePath: string;
  sizeBytes: number;
  sha256: string;
}

export interface ImmutableMcpDependencyTreeIdentity {
  schemaVersion: 1;
  kind: "immutable-mcp-dependency-tree";
  relativeRoot: typeof IMMUTABLE_MCP_DEPENDENCY_ROOT;
  files: number;
  bytes: number;
  entries: ImmutableMcpDependencyTreeEntry[];
  fingerprint: string;
}

export interface ImmutableMcpCandidatePublicationRecord {
  schemaVersion: 1;
  kind: "immutable-mcp-runtime-publication";
  candidateId: string;
  sourceDigest: string;
  sourceFiles: number;
  sourceBytes: number;
  mcpToolCount: number;
  receiptFingerprint: string;
  runtimeTreeFingerprint: string;
  dependencyClosure: {
    relativeRoot: typeof IMMUTABLE_MCP_DEPENDENCY_ROOT;
    files: number;
    bytes: number;
    fingerprint: string;
  };
  packageJsonSha256: string;
  packageLockSha256: string;
  runtimeGuardSha256: string;
  launcherSha256: string;
  payloadFingerprint: string;
  platform: NodeJS.Platform;
  architecture: NodeJS.Architecture;
  nodeMajor: number;
  nodeModulesAbi: string;
  requiresModuleRegisterHooks: true;
  publishedAt: string;
  fingerprint: string;
}

export interface CreateImmutableMcpCandidatePublicationInput {
  launcherSha256: string;
  publishedAt?: string;
  requireDirectoryName?: boolean;
  requireReadOnly?: boolean;
}

export interface VerifyPublishedImmutableMcpRuntimeCandidateOptions {
  launcherPath?: string;
  launcherSha256?: string;
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
  return createHash("sha256").update(JSON.stringify(stableValue(value)), "utf8").digest("hex");
}

export async function sha256ImmutableMcpFile(filePath: string): Promise<string> {
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
    throw new Error(`MCP dependency tree 路径逃逸：${candidate}`);
  }
  return relative.split(path.sep).join("/");
}

async function assertCanonicalDirectory(directoryValue: string, label: string): Promise<string> {
  const directory = path.resolve(directoryValue);
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || await realpath(directory) !== directory) {
    throw new Error(`${label} 必须是规范绝对真实目录：${directory}`);
  }
  return directory;
}

async function assertSingleLinkFile(filePath: string, label: string): Promise<void> {
  const metadata = await lstat(filePath);
  if (!metadata.isFile()
    || metadata.isSymbolicLink()
    || metadata.nlink !== 1
    || metadata.size < 1
    || await realpath(filePath) !== path.resolve(filePath)) {
    throw new Error(`${label} 必须是非空单链接普通文件：${filePath}`);
  }
}

export async function inspectImmutableMcpDependencyTree(
  nodeModulesRootValue: string,
): Promise<ImmutableMcpDependencyTreeIdentity> {
  const nodeModulesRoot = await assertCanonicalDirectory(nodeModulesRootValue, "MCP candidate node_modules");
  const pending: Array<{ absolutePath: string; relativePath: string; sizeBytes: number }> = [];

  async function visit(directory: string): Promise<void> {
    const children = await readdir(directory, { withFileTypes: true });
    for (const child of children.sort((left, right) => left.name.localeCompare(right.name, "en"))) {
      const absolutePath = path.join(directory, child.name);
      const metadata = await lstat(absolutePath);
      const relativePath = normalizedRelativePath(nodeModulesRoot, absolutePath);
      if (metadata.isSymbolicLink()) throw new Error(`MCP dependency tree 禁止符号链接：${relativePath}`);
      if (metadata.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      if (!metadata.isFile() || metadata.nlink !== 1) {
        throw new Error(`MCP dependency tree 只接受单链接普通文件：${relativePath}`);
      }
      pending.push({ absolutePath, relativePath, sizeBytes: metadata.size });
    }
  }

  await visit(nodeModulesRoot);
  if (pending.length === 0) throw new Error("MCP candidate production node_modules 为空。");
  pending.sort((left, right) => left.relativePath.localeCompare(right.relativePath, "en"));
  const entries: ImmutableMcpDependencyTreeEntry[] = [];
  for (let offset = 0; offset < pending.length; offset += 24) {
    entries.push(...await Promise.all(pending.slice(offset, offset + 24).map(async (entry) => ({
      relativePath: entry.relativePath,
      sizeBytes: entry.sizeBytes,
      sha256: await sha256ImmutableMcpFile(entry.absolutePath),
    }))));
  }
  const bytes = entries.reduce((sum, entry) => sum + entry.sizeBytes, 0);
  const semantic = {
    schemaVersion: 1 as const,
    kind: "immutable-mcp-dependency-tree" as const,
    relativeRoot: IMMUTABLE_MCP_DEPENDENCY_ROOT,
    files: entries.length,
    bytes,
    entries,
  };
  return { ...semantic, fingerprint: digest(semantic) };
}

interface CandidatePublicationIdentity {
  dependencyTree: ImmutableMcpDependencyTreeIdentity;
  packageJsonSha256: string;
  packageLockSha256: string;
  runtimeGuardSha256: string;
  payloadFingerprint: string;
}

async function inspectCandidatePublicationIdentity(
  candidateRoot: string,
  receipt: ImmutableMcpRuntimeCandidateReceipt,
): Promise<CandidatePublicationIdentity> {
  const packageJsonPath = path.join(candidateRoot, IMMUTABLE_MCP_PACKAGE_FILE);
  const packageLockPath = path.join(candidateRoot, IMMUTABLE_MCP_PACKAGE_LOCK_FILE);
  const runtimeGuardPath = path.join(candidateRoot, IMMUTABLE_MCP_RUNTIME_GUARD_FILE);
  await Promise.all([
    assertSingleLinkFile(packageJsonPath, "MCP candidate package.json"),
    assertSingleLinkFile(packageLockPath, "MCP candidate package-lock.json"),
    assertSingleLinkFile(runtimeGuardPath, "MCP candidate runtime guard"),
  ]);
  const [dependencyTree, packageJsonSha256, packageLockSha256, runtimeGuardSha256] = await Promise.all([
    inspectImmutableMcpDependencyTree(path.join(candidateRoot, IMMUTABLE_MCP_DEPENDENCY_ROOT)),
    sha256ImmutableMcpFile(packageJsonPath),
    sha256ImmutableMcpFile(packageLockPath),
    sha256ImmutableMcpFile(runtimeGuardPath),
  ]);
  const payloadFingerprint = digest({
    receiptFingerprint: receipt.fingerprint,
    runtimeTreeFingerprint: receipt.runtimeTree.fingerprint,
    dependencyTreeFingerprint: dependencyTree.fingerprint,
    packageJsonSha256,
    packageLockSha256,
    runtimeGuardSha256,
  });
  return { dependencyTree, packageJsonSha256, packageLockSha256, runtimeGuardSha256, payloadFingerprint };
}

function publicationBody(
  receipt: ImmutableMcpRuntimeCandidateReceipt,
  identity: CandidatePublicationIdentity,
  launcherSha256: string,
  publishedAt: string,
): Omit<ImmutableMcpCandidatePublicationRecord, "fingerprint"> {
  return {
    schemaVersion: 1,
    kind: "immutable-mcp-runtime-publication",
    candidateId: receipt.candidateId,
    sourceDigest: receipt.sourceDigest,
    sourceFiles: receipt.sourceFiles,
    sourceBytes: receipt.sourceBytes,
    mcpToolCount: receipt.mcpToolCount,
    receiptFingerprint: receipt.fingerprint,
    runtimeTreeFingerprint: receipt.runtimeTree.fingerprint,
    dependencyClosure: {
      relativeRoot: IMMUTABLE_MCP_DEPENDENCY_ROOT,
      files: identity.dependencyTree.files,
      bytes: identity.dependencyTree.bytes,
      fingerprint: identity.dependencyTree.fingerprint,
    },
    packageJsonSha256: identity.packageJsonSha256,
    packageLockSha256: identity.packageLockSha256,
    runtimeGuardSha256: identity.runtimeGuardSha256,
    launcherSha256,
    payloadFingerprint: identity.payloadFingerprint,
    platform: process.platform,
    architecture: process.arch,
    nodeMajor: Number.parseInt(process.versions.node.split(".")[0] ?? "", 10),
    nodeModulesAbi: process.versions.modules,
    requiresModuleRegisterHooks: true,
    publishedAt,
  };
}

function assertPublication(value: unknown): asserts value is ImmutableMcpCandidatePublicationRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("MCP publication record 必须是对象。");
  }
  const record = value as Partial<ImmutableMcpCandidatePublicationRecord>;
  if (record.schemaVersion !== 1
    || record.kind !== "immutable-mcp-runtime-publication"
    || !CANDIDATE_ID_PATTERN.test(record.candidateId ?? "")
    || !SHA256_PATTERN.test(record.sourceDigest ?? "")
    || !Number.isSafeInteger(record.sourceFiles) || (record.sourceFiles ?? 0) < 1
    || !Number.isSafeInteger(record.sourceBytes) || (record.sourceBytes ?? 0) < 1
    || !Number.isSafeInteger(record.mcpToolCount) || (record.mcpToolCount ?? 0) < 1
    || !SHA256_PATTERN.test(record.receiptFingerprint ?? "")
    || !SHA256_PATTERN.test(record.runtimeTreeFingerprint ?? "")
    || !record.dependencyClosure
    || record.dependencyClosure.relativeRoot !== IMMUTABLE_MCP_DEPENDENCY_ROOT
    || !Number.isSafeInteger(record.dependencyClosure.files) || record.dependencyClosure.files < 1
    || !Number.isSafeInteger(record.dependencyClosure.bytes) || record.dependencyClosure.bytes < 1
    || !SHA256_PATTERN.test(record.dependencyClosure.fingerprint ?? "")
    || !SHA256_PATTERN.test(record.packageJsonSha256 ?? "")
    || !SHA256_PATTERN.test(record.packageLockSha256 ?? "")
    || !SHA256_PATTERN.test(record.runtimeGuardSha256 ?? "")
    || !SHA256_PATTERN.test(record.launcherSha256 ?? "")
    || !SHA256_PATTERN.test(record.payloadFingerprint ?? "")
    || typeof record.platform !== "string" || !record.platform
    || typeof record.architecture !== "string" || !record.architecture
    || !Number.isSafeInteger(record.nodeMajor) || (record.nodeMajor ?? 0) < 22
    || typeof record.nodeModulesAbi !== "string" || !record.nodeModulesAbi
    || record.requiresModuleRegisterHooks !== true
    || typeof record.publishedAt !== "string" || Number.isNaN(Date.parse(record.publishedAt))
    || !SHA256_PATTERN.test(record.fingerprint ?? "")) {
    throw new Error("MCP publication record 字段不完整或格式无效。");
  }
  const { fingerprint, ...body } = record as ImmutableMcpCandidatePublicationRecord;
  if (digest(body) !== fingerprint) throw new Error("MCP publication fingerprint 与内容不一致。");
}

export async function createImmutableMcpCandidatePublicationRecord(
  candidateRootValue: string,
  input: CreateImmutableMcpCandidatePublicationInput,
): Promise<ImmutableMcpCandidatePublicationRecord> {
  if (!SHA256_PATTERN.test(input.launcherSha256)) throw new Error("MCP launcher SHA-256 无效。");
  const candidateRoot = await assertCanonicalDirectory(candidateRootValue, "MCP candidate root");
  const receipt = await verifyImmutableMcpRuntimeCandidate(candidateRoot, {
    requireDirectoryName: input.requireDirectoryName,
    requireReadOnly: input.requireReadOnly,
  });
  const identity = await inspectCandidatePublicationIdentity(candidateRoot, receipt);
  const publishedAt = input.publishedAt ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(publishedAt))) throw new Error("MCP publication publishedAt 无效。");
  const body = publicationBody(receipt, identity, input.launcherSha256, publishedAt);
  return { ...body, fingerprint: digest(body) };
}

export function serializeImmutableMcpCandidatePublicationRecord(
  record: ImmutableMcpCandidatePublicationRecord,
): string {
  assertPublication(record);
  return `${JSON.stringify(record, null, 2)}\n`;
}

export function immutableMcpPublicationPath(candidatesRoot: string, candidateId: string): string {
  if (!CANDIDATE_ID_PATTERN.test(candidateId)) throw new Error(`非法 MCP candidateId：${candidateId}`);
  return path.join(candidatesRoot, IMMUTABLE_MCP_PUBLICATION_DIRECTORY, `${candidateId}.json`);
}

export async function readImmutableMcpCandidatePublicationRecord(
  publicationPathValue: string,
): Promise<ImmutableMcpCandidatePublicationRecord> {
  const publicationPath = path.resolve(publicationPathValue);
  if (!PUBLICATION_FILE_PATTERN.test(path.basename(publicationPath))) {
    throw new Error(`非法 MCP publication 文件名：${publicationPath}`);
  }
  const metadata = await lstat(publicationPath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
    || metadata.size < 2 || metadata.size > MAX_PUBLICATION_BYTES
    || await realpath(publicationPath) !== publicationPath) {
    throw new Error("MCP publication record 不是受限单链接普通文件。");
  }
  const value = JSON.parse(await readFile(publicationPath, "utf8")) as unknown;
  assertPublication(value);
  if (path.basename(publicationPath, ".json") !== value.candidateId) {
    throw new Error("MCP publication 文件名必须与 record candidateId 完全一致。");
  }
  return value;
}

export async function verifyPublishedImmutableMcpRuntimeCandidate(
  candidateRootValue: string,
  publication: ImmutableMcpCandidatePublicationRecord,
  options: VerifyPublishedImmutableMcpRuntimeCandidateOptions = {},
): Promise<ImmutableMcpRuntimeCandidateReceipt> {
  assertPublication(publication);
  if (Boolean(options.launcherPath) === Boolean(options.launcherSha256)) {
    throw new Error("MCP publication 联合验证必须且只能提供 launcherPath 或 launcherSha256 之一。");
  }
  const candidateRoot = await assertCanonicalDirectory(candidateRootValue, "MCP candidate root");
  if (path.basename(candidateRoot) !== publication.candidateId) {
    throw new Error("MCP candidate 目录名必须与 publication candidateId 完全一致。");
  }
  const receipt = await verifyImmutableMcpRuntimeCandidate(candidateRoot);
  const identity = await inspectCandidatePublicationIdentity(candidateRoot, receipt);
  const expectedBody = publicationBody(receipt, identity, publication.launcherSha256, publication.publishedAt);
  const expected = { ...expectedBody, fingerprint: digest(expectedBody) };
  if (JSON.stringify(stableValue(expected)) !== JSON.stringify(stableValue(publication))) {
    throw new Error("MCP publication 与 candidate payload/receipt 身份不一致。");
  }
  if (publication.platform !== process.platform
    || publication.architecture !== process.arch
    || publication.nodeMajor !== Number.parseInt(process.versions.node.split(".")[0] ?? "", 10)
    || publication.nodeModulesAbi !== process.versions.modules) {
    throw new Error("MCP candidate 的平台、架构、Node major 或 ABI 与当前运行时不一致。");
  }
  if (options.launcherPath) await assertSingleLinkFile(options.launcherPath, "稳定 MCP launcher");
  const launcherSha256 = options.launcherPath
    ? await sha256ImmutableMcpFile(path.resolve(options.launcherPath))
    : options.launcherSha256;
  if (launcherSha256 && launcherSha256 !== publication.launcherSha256) {
    throw new Error("MCP publication 与稳定 launcher 身份不一致。");
  }
  return receipt;
}
