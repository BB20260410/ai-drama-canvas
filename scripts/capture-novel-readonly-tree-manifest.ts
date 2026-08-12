import { createHash } from "node:crypto";
import { constants as fsConstants, type BigIntStats } from "node:fs";
import { lstat, mkdir, open, readlink, readdir, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export type ReadonlyTreeEntryType = "directory" | "file" | "symlink";

export interface ReadonlyTreeManifestEntry {
  path: string;
  type: ReadonlyTreeEntryType;
  size: number;
  mtimeNs: string;
  sha256: string | null;
}

export interface NovelReadonlyTreeManifest {
  schemaVersion: 1;
  kind: "novel-readonly-tree-manifest";
  label: string;
  rootPersisted: false;
  pathEncoding: "posix-relative-utf8";
  hashAlgorithm: "sha256";
  aggregateAlgorithm: "sha256-json-lines-v1";
  summary: {
    entries: number;
    directories: number;
    files: number;
    symlinks: number;
    fileBytes: number;
  };
  entries: ReadonlyTreeManifestEntry[];
  aggregateSha256: string;
}

interface ScannedEntry {
  manifest: ReadonlyTreeManifestEntry;
  identity: string;
}

export interface CaptureNovelReadonlyTreeManifestOptions {
  workspaceRoot: string;
  root: string;
  label: string;
  output: string;
  /** Tests may inject a mutation between the two mandatory full enumerations. */
  betweenScans?: () => void | Promise<void>;
}

const EVIDENCE_SEGMENTS = ["docs", "evidence", "novel-mode-v1", "real-project"] as const;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

function sha256(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function bytewiseCompare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function portableRelative(value: string): string {
  return value.split(path.sep).join("/");
}

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function safeSize(value: bigint, entryPath: string): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`条目大小超出安全整数范围：${entryPath}`);
  }
  return Number(value);
}

function identityOf(metadata: BigIntStats): string {
  return [
    metadata.dev,
    metadata.ino,
    metadata.mode,
    metadata.nlink,
    metadata.size,
    metadata.mtimeNs,
    metadata.ctimeNs,
  ].map(String).join(":");
}

function entryType(metadata: BigIntStats): ReadonlyTreeEntryType | null {
  if (metadata.isSymbolicLink()) return "symlink";
  if (metadata.isDirectory()) return "directory";
  if (metadata.isFile()) return "file";
  return null;
}

function assertLabel(value: string): string {
  const label = value.normalize("NFC").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(label)) {
    throw new Error("--label 必须是 1–80 位 ASCII 字母数字及 ._-，且以字母或数字开头。 ");
  }
  return label;
}

async function assertRealDirectory(input: string, label: string): Promise<string> {
  const resolved = path.resolve(input);
  const metadata = await lstat(resolved, { bigint: true });
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`${label}必须是非符号链接真实目录。`);
  return realpath(resolved);
}

async function hashRegularFile(filePath: string, pathBefore: BigIntStats, displayPath: string): Promise<string> {
  if (typeof fsConstants.O_NOFOLLOW !== "number") throw new Error("当前 runtime 不支持 O_NOFOLLOW，拒绝生成只读证据。 ");
  const expectedIdentity = identityOf(pathBefore);
  const handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const handleBefore = await handle.stat({ bigint: true });
    if (!handleBefore.isFile() || identityOf(handleBefore) !== expectedIdentity) {
      throw new Error(`普通文件打开时身份变化：${displayPath}`);
    }
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      digest.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const [handleAfter, pathAfter] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(filePath, { bigint: true }),
    ]);
    if (!pathAfter.isFile() || pathAfter.isSymbolicLink()
      || identityOf(handleAfter) !== expectedIdentity
      || identityOf(pathAfter) !== expectedIdentity) {
      throw new Error(`普通文件 SHA 扫描期间身份变化：${displayPath}`);
    }
    return digest.digest("hex");
  } finally {
    await handle.close();
  }
}

async function scanTree(rootReal: string): Promise<ScannedEntry[]> {
  const rows: ScannedEntry[] = [];

  async function visit(absolute: string, relative: string): Promise<void> {
    const before = await lstat(absolute, { bigint: true });
    const type = entryType(before);
    const displayPath = relative || ".";
    if (!type) throw new Error(`只读树包含不支持的条目类型：${displayPath}`);
    const identity = identityOf(before);

    if (type === "directory") {
      rows.push({
        manifest: { path: displayPath, type, size: safeSize(before.size, displayPath), mtimeNs: before.mtimeNs.toString(), sha256: null },
        identity,
      });
      const names = (await readdir(absolute)).sort(bytewiseCompare);
      for (const name of names) {
        const childRelative = relative ? path.join(relative, name) : name;
        await visit(path.join(absolute, name), childRelative);
      }
      const after = await lstat(absolute, { bigint: true });
      if (!after.isDirectory() || after.isSymbolicLink() || identityOf(after) !== identity) {
        throw new Error(`目录枚举期间身份变化：${displayPath}`);
      }
      return;
    }

    if (type === "symlink") {
      const linkValue = await readlink(absolute, { encoding: "buffer" });
      const after = await lstat(absolute, { bigint: true });
      if (!after.isSymbolicLink() || identityOf(after) !== identity) {
        throw new Error(`符号链接读取期间身份变化：${displayPath}`);
      }
      rows.push({
        manifest: {
          path: portableRelative(displayPath),
          type,
          size: safeSize(before.size, displayPath),
          mtimeNs: before.mtimeNs.toString(),
          sha256: sha256(linkValue),
        },
        identity,
      });
      return;
    }

    const contentSha256 = await hashRegularFile(absolute, before, displayPath);
    if (!SHA256_PATTERN.test(contentSha256)) throw new Error(`普通文件 SHA-256 无效：${displayPath}`);
    rows.push({
      manifest: {
        path: portableRelative(displayPath),
        type,
        size: safeSize(before.size, displayPath),
        mtimeNs: before.mtimeNs.toString(),
        sha256: contentSha256,
      },
      identity,
    });
  }

  await visit(rootReal, "");
  rows.sort((left, right) => bytewiseCompare(left.manifest.path, right.manifest.path));
  return rows;
}

function assertSameScans(first: ScannedEntry[], second: ScannedEntry[]): void {
  if (first.length !== second.length) throw new Error("二次枚举发现条目新增或删除，拒绝落证据。 ");
  for (let index = 0; index < first.length; index += 1) {
    const left = first[index]!;
    const right = second[index]!;
    if (left.identity !== right.identity || JSON.stringify(left.manifest) !== JSON.stringify(right.manifest)) {
      throw new Error(`二次枚举发现身份或内容变化：${left.manifest.path} / ${right.manifest.path}`);
    }
  }
}

function buildManifest(label: string, scanned: ScannedEntry[]): NovelReadonlyTreeManifest {
  const entries = scanned.map((entry) => entry.manifest);
  const aggregateInput = entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
  return {
    schemaVersion: 1,
    kind: "novel-readonly-tree-manifest",
    label,
    rootPersisted: false,
    pathEncoding: "posix-relative-utf8",
    hashAlgorithm: "sha256",
    aggregateAlgorithm: "sha256-json-lines-v1",
    summary: {
      entries: entries.length,
      directories: entries.filter((entry) => entry.type === "directory").length,
      files: entries.filter((entry) => entry.type === "file").length,
      symlinks: entries.filter((entry) => entry.type === "symlink").length,
      fileBytes: entries.filter((entry) => entry.type === "file").reduce((total, entry) => total + entry.size, 0),
    },
    entries,
    aggregateSha256: sha256(aggregateInput),
  };
}

async function ensureEvidenceDirectory(workspaceReal: string): Promise<string> {
  let current = workspaceReal;
  for (const segment of EVIDENCE_SEGMENTS) {
    const next = path.join(current, segment);
    await mkdir(next, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    const metadata = await lstat(next, { bigint: true });
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || await realpath(next) !== next) {
      throw new Error(`证据目录链不安全：${portableRelative(path.relative(workspaceReal, next))}`);
    }
    current = next;
  }
  return current;
}

async function writeExclusiveEvidence(outputPath: string, manifest: NovelReadonlyTreeManifest): Promise<void> {
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let created = false;
  try {
    handle = await open(outputPath, "wx", 0o600);
    created = true;
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    const directoryHandle = await open(path.dirname(outputPath), "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (created) await unlink(outputPath).catch(() => undefined);
    throw error;
  }
}

export async function captureNovelReadonlyTreeManifest(
  options: CaptureNovelReadonlyTreeManifestOptions,
): Promise<NovelReadonlyTreeManifest> {
  const label = assertLabel(options.label);
  const workspaceReal = await assertRealDirectory(options.workspaceRoot, "工作区根");
  const rootResolved = path.resolve(options.root);
  const rootLeaf = await lstat(rootResolved, { bigint: true });
  if (!rootLeaf.isDirectory() || rootLeaf.isSymbolicLink()) throw new Error("--root 必须是非符号链接真实目录。 ");
  const rootReal = await realpath(rootResolved);

  const evidenceRoot = path.join(workspaceReal, ...EVIDENCE_SEGMENTS);
  const outputPath = path.resolve(workspaceReal, options.output);
  if (path.dirname(outputPath) !== evidenceRoot || path.extname(outputPath) !== ".json") {
    throw new Error("--output 只能是 docs/evidence/novel-mode-v1/real-project/*.json。 ");
  }
  if (isWithin(rootReal, outputPath)) throw new Error("证据输出不得位于被扫描只读根内。 ");

  const first = await scanTree(rootReal);
  await options.betweenScans?.();
  const second = await scanTree(rootReal);
  assertSameScans(first, second);
  const manifest = buildManifest(label, second);

  const evidenceReal = await ensureEvidenceDirectory(workspaceReal);
  if (evidenceReal !== evidenceRoot || path.dirname(outputPath) !== evidenceReal) {
    throw new Error("证据目录 realpath 越出允许边界。 ");
  }
  await writeExclusiveEvidence(outputPath, manifest);
  return manifest;
}

function parseCli(argv: string[]): Omit<CaptureNovelReadonlyTreeManifestOptions, "workspaceRoot"> {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key || !value || !["--root", "--label", "--output"].includes(key) || values.has(key)) {
      throw new Error("用法：tsx scripts/capture-novel-readonly-tree-manifest.ts --root <dir> --label <id> --output <allowed.json>");
    }
    values.set(key, value);
  }
  const root = values.get("--root");
  const label = values.get("--label");
  const output = values.get("--output");
  if (!root || !label || !output || values.size !== 3) {
    throw new Error("用法：tsx scripts/capture-novel-readonly-tree-manifest.ts --root <dir> --label <id> --output <allowed.json>");
  }
  return { root, label, output };
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  try {
    const manifest = await captureNovelReadonlyTreeManifest({
      workspaceRoot: process.cwd(),
      ...parseCli(process.argv.slice(2)),
    });
    process.stdout.write(`${JSON.stringify({
      schemaVersion: manifest.schemaVersion,
      kind: manifest.kind,
      label: manifest.label,
      entries: manifest.summary.entries,
      aggregateSha256: manifest.aggregateSha256,
    })}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
