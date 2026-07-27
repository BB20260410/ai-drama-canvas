import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import {
  ensureConfinedDirectory,
  hashConfinedRegularFileWithIdentity,
  importConfinedFileToSha256Cas,
  inspectExistingConfinedDirectory,
  persistConfinedBytesNoReplace,
  readConfinedRegularFileWithIdentity,
} from "./confined-project-storage.js";

const SOURCE_CLOSURE_RELATIVE_ROOT =
  ".aicanvas/studio-video-package-source-closure";
const OBJECTS_RELATIVE_ROOT =
  `${SOURCE_CLOSURE_RELATIVE_ROOT}/objects/sha256`;
const MANIFESTS_RELATIVE_ROOT =
  `${SOURCE_CLOSURE_RELATIVE_ROOT}/manifests`;
const BINDINGS_RELATIVE_ROOT =
  `${SOURCE_CLOSURE_RELATIVE_ROOT}/bindings`;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const ROLE_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;
const MAX_ENTRY_COUNT = 128;
const MAX_ENTRY_BYTES = 128 * 1024 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_BINDING_BYTES = 64 * 1024;

export type StudioVideoPackageSourceClosureJson =
  | null
  | boolean
  | number
  | string
  | StudioVideoPackageSourceClosureJson[]
  | { [key: string]: StudioVideoPackageSourceClosureJson };

interface SourceClosureInputEntryBase {
  role: string;
  logicalPath: string;
  expectedSha256?: string;
}

export type StudioVideoPackageSourceClosureInputEntry =
  | (SourceClosureInputEntryBase & {
      sourcePath: string;
      bytes?: never;
    })
  | (SourceClosureInputEntryBase & {
      bytes: Buffer;
      sourcePath?: never;
    });

export interface FreezeStudioVideoPackageSourceClosureInput {
  entries: StudioVideoPackageSourceClosureInputEntry[];
  metadata?: Record<string, unknown>;
}

export interface StudioVideoPackageSourceClosureEntry {
  role: string;
  logicalPath: string;
  sha256: string;
  sizeBytes: number;
}

export interface StudioVideoPackageSourceClosure {
  schemaVersion: 1;
  kind: "studio-video-package-source-closure";
  entries: StudioVideoPackageSourceClosureEntry[];
  metadata: { [key: string]: StudioVideoPackageSourceClosureJson };
  fingerprint: string;
}

export interface FrozenStudioVideoPackageSourceClosure {
  closure: StudioVideoPackageSourceClosure;
  manifestPath: string;
  createdManifest: boolean;
}

export interface ReadStudioVideoPackageSourceClosure {
  closure: StudioVideoPackageSourceClosure;
  manifestPath: string;
  files: Array<StudioVideoPackageSourceClosureEntry & {
    absolutePath: string;
    bytes: Buffer;
  }>;
}

export interface ReadStudioVideoPackageSourceClosureOptions {
  /**
   * 只读取指定角色；省略时读取全部对象，空数组只验证 manifest。
   * 角色筛选不改变 closure 指纹或 manifest 语义。
   */
  roles?: readonly string[];
}

export interface VerifiedStudioVideoPackageSourceClosure {
  closure: StudioVideoPackageSourceClosure;
  manifestPath: string;
  files: Array<StudioVideoPackageSourceClosureEntry & {
    absolutePath: string;
  }>;
}

export interface StudioVideoPackageSourceClosureBinding {
  schemaVersion: 1;
  kind: "studio-video-package-source-closure-binding";
  inputFingerprint: string;
  sourceClosureFingerprint: string;
  fingerprint: string;
}

interface NormalizedInputEntry {
  role: string;
  logicalPath: string;
  expectedSha256?: string;
  sourcePath?: string;
  bytes?: Buffer;
}

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function normalizeSha256(value: string, field: string): string {
  const normalized = value.trim().toLowerCase();
  if (!SHA256_PATTERN.test(normalized)) {
    throw new Error(`${field} 必须是 64 位 SHA-256。`);
  }
  return normalized;
}

function normalizeRole(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!ROLE_PATTERN.test(normalized)) {
    throw new Error("source closure role 格式无效。");
  }
  return normalized;
}

function normalizeRequestedRoles(
  roles: readonly string[] | undefined,
): Set<string> | null {
  if (roles === undefined) return null;
  if (!Array.isArray(roles) || roles.length > MAX_ENTRY_COUNT) {
    throw new Error(`source closure roles 最多允许 ${MAX_ENTRY_COUNT} 项。`);
  }
  const normalized = roles.map((role) => normalizeRole(role));
  if (new Set(normalized).size !== normalized.length) {
    throw new Error("source closure roles 不得重复。");
  }
  return new Set(normalized);
}

function normalizeLogicalPath(value: string): string {
  const normalized = value.normalize("NFC").trim();
  if (!normalized
    || normalized.includes("\\")
    || path.posix.isAbsolute(normalized)
    || path.posix.normalize(normalized) !== normalized
    || normalized === "."
    || normalized === ".."
    || normalized.startsWith("../")
    || normalized.endsWith("/")) {
    throw new Error("source closure logicalPath 必须是规范、不可逃逸的 POSIX 相对路径。");
  }
  return normalized;
}

function stableJsonValue(
  value: unknown,
  field = "metadata",
): StudioVideoPackageSourceClosureJson {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${field} 含非有限数字。`);
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => stableJsonValue(entry, `${field}[${index}]`));
  }
  if (!value || typeof value !== "object" || Buffer.isBuffer(value)) {
    throw new Error(`${field} 必须是 JSON 值。`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${field} 必须是普通 JSON 对象。`);
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([key, entry]) => {
        if (entry === undefined) throw new Error(`${field}.${key} 不得为 undefined。`);
        return [key, stableJsonValue(entry, `${field}.${key}`)];
      }),
  );
}

function canonicalJsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(stableJsonValue(value))}\n`, "utf8");
}

function closureSemantic(
  entries: StudioVideoPackageSourceClosureEntry[],
  metadata: { [key: string]: StudioVideoPackageSourceClosureJson },
): Omit<StudioVideoPackageSourceClosure, "fingerprint"> {
  return {
    schemaVersion: 1,
    kind: "studio-video-package-source-closure",
    entries,
    metadata,
  };
}

function bindingSemantic(
  inputFingerprint: string,
  sourceClosureFingerprint: string,
): Omit<StudioVideoPackageSourceClosureBinding, "fingerprint"> {
  return {
    schemaVersion: 1,
    kind: "studio-video-package-source-closure-binding",
    inputFingerprint,
    sourceClosureFingerprint,
  };
}

function normalizeInputEntries(
  entries: StudioVideoPackageSourceClosureInputEntry[],
): NormalizedInputEntry[] {
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > MAX_ENTRY_COUNT) {
    throw new Error(`source closure entries 必须包含 1-${MAX_ENTRY_COUNT} 项。`);
  }
  const normalized = entries.map((entry, index): NormalizedInputEntry => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`source closure entries[${index}] 结构无效。`);
    }
    const role = normalizeRole(entry.role);
    const logicalPath = normalizeLogicalPath(entry.logicalPath);
    const expectedSha256 = entry.expectedSha256 === undefined
      ? undefined
      : normalizeSha256(entry.expectedSha256, `entries[${index}].expectedSha256`);
    const hasBytes = Buffer.isBuffer(entry.bytes);
    const hasSourcePath = typeof entry.sourcePath === "string";
    if (hasBytes === hasSourcePath) {
      throw new Error(`source closure entries[${index}] 必须且只能提供 bytes 或 sourcePath。`);
    }
    if (hasBytes) {
      const bytes = Buffer.from(entry.bytes as Buffer);
      if (bytes.byteLength < 1 || bytes.byteLength > MAX_ENTRY_BYTES) {
        throw new Error(`source closure entries[${index}] 大小超限。`);
      }
      const actualSha256 = sha256(bytes);
      if (expectedSha256 && actualSha256 !== expectedSha256) {
        throw new Error(`source closure entries[${index}] bytes SHA 与 expectedSha256 不一致。`);
      }
      return { role, logicalPath, expectedSha256, bytes };
    }
    const sourcePath = path.resolve(entry.sourcePath as string);
    if (!path.isAbsolute(entry.sourcePath as string) || sourcePath !== entry.sourcePath) {
      throw new Error(`source closure entries[${index}].sourcePath 必须是规范绝对路径。`);
    }
    return { role, logicalPath, expectedSha256, sourcePath };
  }).sort((left, right) =>
    `${left.role}\0${left.logicalPath}`.localeCompare(
      `${right.role}\0${right.logicalPath}`,
      "en",
    ));
  const identities = normalized.map((entry) => `${entry.role}\0${entry.logicalPath}`);
  if (new Set(identities).size !== identities.length) {
    throw new Error("source closure 含重复 role/logicalPath。");
  }
  return normalized;
}

function parseJsonObject(bytes: Buffer, label: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new Error(`${label} 不是合法 JSON。`, { cause: error });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} 顶层必须是对象。`);
  }
  return value as Record<string, unknown>;
}

function parseClosure(
  bytes: Buffer,
  expectedFingerprint: string,
): StudioVideoPackageSourceClosure {
  const value = parseJsonObject(bytes, "source closure manifest");
  if (value.schemaVersion !== 1
    || value.kind !== "studio-video-package-source-closure"
    || !Array.isArray(value.entries)
    || !value.metadata
    || typeof value.metadata !== "object"
    || Array.isArray(value.metadata)
    || value.fingerprint !== expectedFingerprint) {
    throw new Error("source closure manifest 结构无效。");
  }
  const metadata = stableJsonValue(value.metadata, "manifest.metadata");
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error("source closure manifest metadata 无效。");
  }
  const entries = value.entries.map((entry, index): StudioVideoPackageSourceClosureEntry => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`source closure manifest entries[${index}] 无效。`);
    }
    const record = entry as Record<string, unknown>;
    const role = normalizeRole(String(record.role ?? ""));
    const logicalPath = normalizeLogicalPath(String(record.logicalPath ?? ""));
    const entrySha256 = normalizeSha256(String(record.sha256 ?? ""), `entries[${index}].sha256`);
    const sizeBytes = Number(record.sizeBytes);
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > MAX_ENTRY_BYTES) {
      throw new Error(`source closure manifest entries[${index}].sizeBytes 无效。`);
    }
    return { role, logicalPath, sha256: entrySha256, sizeBytes };
  }).sort((left, right) =>
    `${left.role}\0${left.logicalPath}`.localeCompare(
      `${right.role}\0${right.logicalPath}`,
      "en",
    ));
  if (entries.length < 1 || entries.length > MAX_ENTRY_COUNT
    || new Set(entries.map((entry) => `${entry.role}\0${entry.logicalPath}`)).size !== entries.length
    || entries.reduce((total, entry) => total + entry.sizeBytes, 0) > MAX_TOTAL_BYTES) {
    throw new Error("source closure manifest entries 闭包无效。");
  }
  const semantic = closureSemantic(
    entries,
    metadata as { [key: string]: StudioVideoPackageSourceClosureJson },
  );
  const fingerprint = sha256(JSON.stringify(stableJsonValue(semantic)));
  if (fingerprint !== expectedFingerprint) {
    throw new Error("source closure manifest 内容指纹无效。");
  }
  const closure = { ...semantic, fingerprint };
  if (!canonicalJsonBytes(closure).equals(bytes)) {
    throw new Error("source closure manifest 不是规范 JSON。");
  }
  return closure;
}

function parseBinding(
  bytes: Buffer,
  expectedInputFingerprint: string,
): StudioVideoPackageSourceClosureBinding {
  const value = parseJsonObject(bytes, "source closure binding");
  const inputFingerprint = normalizeSha256(
    String(value.inputFingerprint ?? ""),
    "binding.inputFingerprint",
  );
  const sourceClosureFingerprint = normalizeSha256(
    String(value.sourceClosureFingerprint ?? ""),
    "binding.sourceClosureFingerprint",
  );
  if (value.schemaVersion !== 1
    || value.kind !== "studio-video-package-source-closure-binding"
    || inputFingerprint !== expectedInputFingerprint) {
    throw new Error("source closure binding 结构无效。");
  }
  const semantic = bindingSemantic(inputFingerprint, sourceClosureFingerprint);
  const fingerprint = sha256(JSON.stringify(stableJsonValue(semantic)));
  if (value.fingerprint !== fingerprint) {
    throw new Error("source closure binding 内容指纹无效。");
  }
  const binding = { ...semantic, fingerprint };
  if (!canonicalJsonBytes(binding).equals(bytes)) {
    throw new Error("source closure binding 不是规范 JSON。");
  }
  return binding;
}

async function existingDirectoryOrNull(
  projectRoot: string,
  directory: string,
) {
  try {
    return await inspectExistingConfinedDirectory(projectRoot, directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function canonicalProjectRoot(projectRootValue: string): Promise<string> {
  if (!path.isAbsolute(projectRootValue)) {
    throw new Error("source closure projectRoot 必须是规范绝对真实目录。");
  }
  const projectRoot = path.resolve(projectRootValue);
  const projectMetadata = await lstat(projectRoot);
  if (projectRoot !== projectRootValue
    || !projectMetadata.isDirectory()
    || projectMetadata.isSymbolicLink()
    || await realpath(projectRoot) !== projectRoot) {
    throw new Error("source closure projectRoot 必须是规范绝对真实目录。");
  }
  return projectRoot;
}

export async function freezeStudioVideoPackageSourceClosure(
  projectRootValue: string,
  input: FreezeStudioVideoPackageSourceClosureInput,
): Promise<FrozenStudioVideoPackageSourceClosure> {
  const projectRoot = await canonicalProjectRoot(projectRootValue);
  const normalizedEntries = normalizeInputEntries(input.entries);
  const normalizedMetadata = stableJsonValue(input.metadata ?? {}, "metadata");
  if (!normalizedMetadata || typeof normalizedMetadata !== "object" || Array.isArray(normalizedMetadata)) {
    throw new Error("source closure metadata 必须是 JSON 对象。");
  }
  const objectRoot = await ensureConfinedDirectory(
    projectRoot,
    path.join(projectRoot, ...OBJECTS_RELATIVE_ROOT.split("/")),
  );
  const persistedEntries: StudioVideoPackageSourceClosureEntry[] = [];
  let totalBytes = 0;
  for (const entry of normalizedEntries) {
    let imported: { sha256: string; size: number };
    if (entry.sourcePath) {
      imported = await importConfinedFileToSha256Cas(
        objectRoot,
        entry.sourcePath,
        entry.expectedSha256,
      );
    } else {
      const bytes = entry.bytes as Buffer;
      const entrySha256 = sha256(bytes);
      const prefixDirectory = await ensureConfinedDirectory(
        projectRoot,
        path.join(objectRoot.directory, entrySha256.slice(0, 2)),
      );
      const persisted = await persistConfinedBytesNoReplace(
        prefixDirectory,
        entrySha256,
        bytes,
      );
      imported = { sha256: persisted.sha256, size: persisted.size };
    }
    if (imported.size < 1 || imported.size > MAX_ENTRY_BYTES) {
      throw new Error(`source closure ${entry.role}:${entry.logicalPath} 大小超限。`);
    }
    totalBytes += imported.size;
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error("source closure 总大小超限。");
    persistedEntries.push({
      role: entry.role,
      logicalPath: entry.logicalPath,
      sha256: imported.sha256,
      sizeBytes: imported.size,
    });
  }
  const semantic = closureSemantic(
    persistedEntries,
    normalizedMetadata as { [key: string]: StudioVideoPackageSourceClosureJson },
  );
  const fingerprint = sha256(JSON.stringify(stableJsonValue(semantic)));
  const closure: StudioVideoPackageSourceClosure = { ...semantic, fingerprint };
  const manifestBytes = canonicalJsonBytes(closure);
  if (manifestBytes.byteLength > MAX_MANIFEST_BYTES) {
    throw new Error("source closure manifest 大小超限。");
  }
  const manifestRoot = await ensureConfinedDirectory(
    projectRoot,
    path.join(projectRoot, ...MANIFESTS_RELATIVE_ROOT.split("/")),
  );
  const persistedManifest = await persistConfinedBytesNoReplace(
    manifestRoot,
    `${fingerprint}.json`,
    manifestBytes,
  );
  const verified = await verifyStudioVideoPackageSourceClosure(projectRoot, fingerprint);
  if (verified.closure.fingerprint !== fingerprint) {
    throw new Error("source closure 持久化后验证失败。");
  }
  return {
    closure,
    manifestPath: verified.manifestPath,
    createdManifest: persistedManifest.created,
  };
}

async function readSourceClosureManifest(
  projectRootValue: string,
  fingerprintValue: string,
): Promise<{
  projectRoot: string;
  closure: StudioVideoPackageSourceClosure;
  manifestPath: string;
  objectRoot: string;
}> {
  const projectRoot = await canonicalProjectRoot(projectRootValue);
  const fingerprint = normalizeSha256(fingerprintValue, "sourceClosureFingerprint");
  const manifestRoot = await inspectExistingConfinedDirectory(
    projectRoot,
    path.join(projectRoot, ...MANIFESTS_RELATIVE_ROOT.split("/")),
  );
  const manifestRead = await readConfinedRegularFileWithIdentity(
    manifestRoot,
    `${fingerprint}.json`,
    MAX_MANIFEST_BYTES,
  );
  if (manifestRead.nlink !== 1) throw new Error("source closure manifest 链接数无效。");
  return {
    projectRoot,
    closure: parseClosure(manifestRead.bytes, fingerprint),
    manifestPath: path.join(manifestRoot.directory, `${fingerprint}.json`),
    objectRoot: path.join(projectRoot, ...OBJECTS_RELATIVE_ROOT.split("/")),
  };
}

function selectedClosureEntries(
  closure: StudioVideoPackageSourceClosure,
  options: ReadStudioVideoPackageSourceClosureOptions,
): StudioVideoPackageSourceClosureEntry[] {
  const requestedRoles = normalizeRequestedRoles(options.roles);
  if (requestedRoles === null) return closure.entries;
  return closure.entries.filter((entry) => requestedRoles.has(entry.role));
}

export async function readStudioVideoPackageSourceClosure(
  projectRootValue: string,
  fingerprintValue: string,
  options: ReadStudioVideoPackageSourceClosureOptions = {},
): Promise<ReadStudioVideoPackageSourceClosure> {
  const manifest = await readSourceClosureManifest(projectRootValue, fingerprintValue);
  const files = [];
  for (const entry of selectedClosureEntries(manifest.closure, options)) {
    const prefixDirectory = await inspectExistingConfinedDirectory(
      manifest.projectRoot,
      path.join(manifest.objectRoot, entry.sha256.slice(0, 2)),
    );
    const read = await readConfinedRegularFileWithIdentity(
      prefixDirectory,
      entry.sha256,
      entry.sizeBytes,
    );
    if (read.nlink !== 1
      || read.bytes.byteLength !== entry.sizeBytes
      || sha256(read.bytes) !== entry.sha256) {
      throw new Error(`source closure 对象校验失败：${entry.role}:${entry.logicalPath}`);
    }
    files.push({
      ...entry,
      absolutePath: path.join(prefixDirectory.directory, entry.sha256),
      bytes: read.bytes,
    });
  }
  return {
    closure: manifest.closure,
    manifestPath: manifest.manifestPath,
    files,
  };
}

/**
 * 顺序、流式验证所选对象；返回值只保留身份元数据，不累积对象 Buffer。
 */
export async function verifyStudioVideoPackageSourceClosure(
  projectRootValue: string,
  fingerprintValue: string,
  options: ReadStudioVideoPackageSourceClosureOptions = {},
): Promise<VerifiedStudioVideoPackageSourceClosure> {
  const manifest = await readSourceClosureManifest(projectRootValue, fingerprintValue);
  const files = [];
  for (const entry of selectedClosureEntries(manifest.closure, options)) {
    const prefixDirectory = await inspectExistingConfinedDirectory(
      manifest.projectRoot,
      path.join(manifest.objectRoot, entry.sha256.slice(0, 2)),
    );
    const verified = await hashConfinedRegularFileWithIdentity(
      prefixDirectory,
      entry.sha256,
      entry.sizeBytes,
    );
    if (verified.nlink !== 1
      || verified.size !== entry.sizeBytes
      || verified.sha256 !== entry.sha256) {
      throw new Error(`source closure 对象校验失败：${entry.role}:${entry.logicalPath}`);
    }
    files.push({
      ...entry,
      absolutePath: path.join(prefixDirectory.directory, entry.sha256),
    });
  }
  return {
    closure: manifest.closure,
    manifestPath: manifest.manifestPath,
    files,
  };
}

export async function bindStudioVideoPackageSourceClosure(
  projectRootValue: string,
  inputFingerprintValue: string,
  sourceClosureFingerprintValue: string,
): Promise<StudioVideoPackageSourceClosureBinding> {
  const projectRoot = await canonicalProjectRoot(projectRootValue);
  const inputFingerprint = normalizeSha256(inputFingerprintValue, "inputFingerprint");
  const sourceClosureFingerprint = normalizeSha256(
    sourceClosureFingerprintValue,
    "sourceClosureFingerprint",
  );
  await verifyStudioVideoPackageSourceClosure(projectRoot, sourceClosureFingerprint);
  const semantic = bindingSemantic(inputFingerprint, sourceClosureFingerprint);
  const binding: StudioVideoPackageSourceClosureBinding = {
    ...semantic,
    fingerprint: sha256(JSON.stringify(stableJsonValue(semantic))),
  };
  const bytes = canonicalJsonBytes(binding);
  const bindingRoot = await ensureConfinedDirectory(
    projectRoot,
    path.join(projectRoot, ...BINDINGS_RELATIVE_ROOT.split("/")),
  );
  await persistConfinedBytesNoReplace(
    bindingRoot,
    `${inputFingerprint}.json`,
    bytes,
  );
  const rebound = await readStudioVideoPackageSourceClosureBinding(
    projectRoot,
    inputFingerprint,
  );
  if (!rebound) throw new Error("source closure binding 持久化后不可读。");
  return rebound;
}

export async function readStudioVideoPackageSourceClosureBinding(
  projectRootValue: string,
  inputFingerprintValue: string,
): Promise<StudioVideoPackageSourceClosureBinding | null> {
  const projectRoot = await canonicalProjectRoot(projectRootValue);
  const inputFingerprint = normalizeSha256(inputFingerprintValue, "inputFingerprint");
  const bindingRoot = await existingDirectoryOrNull(
    projectRoot,
    path.join(projectRoot, ...BINDINGS_RELATIVE_ROOT.split("/")),
  );
  if (!bindingRoot) return null;
  let read;
  try {
    read = await readConfinedRegularFileWithIdentity(
      bindingRoot,
      `${inputFingerprint}.json`,
      MAX_BINDING_BYTES,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (read.nlink !== 1) throw new Error("source closure binding 链接数无效。");
  return parseBinding(read.bytes, inputFingerprint);
}
