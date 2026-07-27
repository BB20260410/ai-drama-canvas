import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, lstat, mkdir, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import { getSidecarPaths, loadIndex } from "../src/core/sidecar.js";
import { previewProjectScan, scanAndPersist } from "../src/core/service.js";
import type { Artifact, ProjectIndex } from "../src/core/types.js";

const DEFAULT_WORKSPACE = "/Users/hxx/Documents/无限画布";
const DEFAULT_PROJECT = "productions/gushujuan-s3-f1a688020bfb7af6";
const DEFAULT_SOURCE = "/Users/hxx/Documents/古蜀卷第三季";
const EP01_001 = "season-三-ep01-unit001";
const EP01_008 = "season-三-ep01-unit008";
const SOURCE_BASELINE = {
  files: 3_344,
  bytes: 24_570_877,
  sha256: "649160f22663ca4c45ee4a4084e278ef0edc61ec66db01bb84da38cbea3f8d26",
} as const;
const ALLOWED_SCAN_WRITES = [
  // scanAndPersist 会调用 ensureSidecar，它会刷新工程元数据 updatedAt。
  ".aicanvas/project.json",
  ".aicanvas/index.json",
  ".aicanvas/events.jsonl",
  ".aicanvas/cache.sqlite*",
  ".aicanvas/locks/**",
  "00_画布进度.md",
];

interface Options {
  workspace: string;
  projectRoot: string;
  sourceRoot: string;
  evidencePath: string;
}

interface Inventory {
  root: string;
  files: number;
  bytes: number;
  sha256: string;
}

function usage(): string {
  return `P4 正式 Scanner 投影安全刷新

用法：
  npx tsx scripts/refresh-p4-storyboard-sheet-index.ts --evidence <json> [参数]

参数：
  --workspace <path>
  --project-root <path>
  --source-root <path>
  --evidence <json>       必须位于 workspace/docs/evidence 且不存在
  --help

只允许 Scanner 更新 index/cache/events/00_画布进度.md；其余正式工程与第三季源目录做前后全量 SHA+mtime 核对。
`;
}

function optionValue(argv: string[], name: string): string | undefined {
  const indexes = argv.flatMap((entry, index) => entry === name ? [index] : []);
  if (indexes.length > 1) throw new Error(`${name} 参数重复。`);
  if (!indexes.length) return undefined;
  const value = argv[indexes[0]! + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} 缺少值。`);
  return value;
}

function parseOptions(argv: string[]): Options {
  const allowed = new Set(["--workspace", "--project-root", "--source-root", "--evidence"]);
  for (let index = 0; index < argv.length; index += 1) {
    const entry = argv[index]!;
    if (entry === "--help" || entry === "-h") continue;
    if (!allowed.has(entry)) throw new Error(`未知参数：${entry}`);
    index += 1;
    if (index >= argv.length || argv[index]!.startsWith("--")) throw new Error(`${entry} 缺少值。`);
  }
  const workspace = path.resolve(optionValue(argv, "--workspace") ?? DEFAULT_WORKSPACE);
  const evidence = optionValue(argv, "--evidence");
  if (!evidence) throw new Error("必须显式提供 --evidence 独占证据路径。");
  return {
    workspace,
    projectRoot: path.resolve(optionValue(argv, "--project-root") ?? path.join(workspace, DEFAULT_PROJECT)),
    sourceRoot: path.resolve(optionValue(argv, "--source-root") ?? DEFAULT_SOURCE),
    evidencePath: path.resolve(evidence),
  };
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function exists(filePath: string): Promise<boolean> {
  return access(filePath).then(() => true, () => false);
}

async function fileSha(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

async function inventory(root: string, ignore: string[] = []): Promise<Inventory> {
  const entries = (await fg("**/*", {
    cwd: root,
    dot: true,
    onlyFiles: false,
    followSymbolicLinks: false,
    unique: true,
    ignore,
  })).sort((left, right) => left.localeCompare(right, "en"));
  const files: string[] = [];
  for (const relativePath of entries) {
    const absolutePath = path.join(root, ...relativePath.split("/"));
    const metadata = await lstat(absolutePath);
    if (metadata.isSymbolicLink()) throw new Error(`受保护清单含符号链接：${absolutePath}`);
    if (metadata.isFile()) files.push(relativePath);
    else if (!metadata.isDirectory()) throw new Error(`受保护清单含特殊文件：${absolutePath}`);
  }
  const rows: Array<{ path: string; bytes: number; mtimeMs: number; sha256: string }> = [];
  for (const relativePath of files) {
    const absolutePath = path.join(root, ...relativePath.split("/"));
    const before = await stat(absolutePath);
    const digest = await fileSha(absolutePath);
    const after = await stat(absolutePath);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error(`清单计算期间文件发生变化：${absolutePath}`);
    }
    rows.push({ path: relativePath, bytes: before.size, mtimeMs: before.mtimeMs, sha256: digest });
  }
  return {
    root,
    files: rows.length,
    bytes: rows.reduce((sum, row) => sum + row.bytes, 0),
    sha256: sha256(rows.map((row) => `${row.path}\0${row.bytes}\0${row.mtimeMs}\0${row.sha256}`).join("\n")),
  };
}

function sheetProjection(index: ProjectIndex): Array<Record<string, unknown>> {
  return index.artifacts
    .filter((artifact) => artifact.fusionStoryboardSheet)
    .map((artifact) => ({
      id: artifact.id,
      itemId: artifact.itemId,
      path: artifact.path,
      role: artifact.fusionStoryboardSheet!.role,
      sheetId: artifact.fusionStoryboardSheet!.sheetId,
      status: artifact.fusionStoryboardSheet!.status,
      reasons: artifact.fusionStoryboardSheet!.reasons,
      check: artifact.check,
      authoritative: artifact.authoritative,
      accepted: artifact.accepted,
      deprecated: artifact.deprecated,
    }))
    .sort((left, right) => String(left.path).localeCompare(String(right.path), "en"));
}

function assertFormalProjection(index: ProjectIndex): void {
  const artifacts = index.artifacts.filter((artifact): artifact is Artifact & { fusionStoryboardSheet: NonNullable<Artifact["fusionStoryboardSheet"]> } => Boolean(artifact.fusionStoryboardSheet));
  const unit001 = artifacts.filter((artifact) => artifact.itemId === EP01_001);
  const unit008 = artifacts.filter((artifact) => artifact.itemId === EP01_008);
  const summary = index.summary.storyboardSheets;
  if (artifacts.length !== 4 || unit001.length !== 4 || unit008.length !== 0
    || !summary || summary.current !== 0 || summary.stale !== 1 || summary.invalid !== 0
    || summary.legacyInvalid !== 1 || summary.pages !== 1
    || unit001.some((artifact) => !artifact.check.ok || artifact.authoritative || artifact.accepted || artifact.deprecated)) {
    throw new Error(`P4 正式 Scanner 投影不符合 4 个历史非权威 Artifact：${JSON.stringify({ summary, projection: sheetProjection(index) })}`);
  }
  const roles = unit001.map((artifact) => artifact.fusionStoryboardSheet.role).sort();
  const statuses = new Set(unit001.map((artifact) => artifact.fusionStoryboardSheet.status));
  if (JSON.stringify(roles) !== JSON.stringify(["png", "receipt", "receipt", "svg"]) || !statuses.has("stale") || !statuses.has("legacy-invalid")) {
    throw new Error(`P4 历史成板角色/状态不符合预期：${JSON.stringify({ roles, statuses: [...statuses] })}`);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(usage());
    return;
  }
  const options = parseOptions(argv);
  const [workspace, projectRoot, sourceRoot, evidenceRoot] = await Promise.all([
    realpath(options.workspace),
    realpath(options.projectRoot),
    realpath(options.sourceRoot),
    realpath(path.join(options.workspace, "docs", "evidence")),
  ]);
  if (!isInside(workspace, projectRoot) || path.dirname(options.evidencePath) !== evidenceRoot || await exists(options.evidencePath)) {
    throw new Error("工程/证据路径越界或证据已存在。");
  }
  if (projectRoot === sourceRoot || isInside(projectRoot, sourceRoot) || isInside(sourceRoot, projectRoot)) {
    throw new Error("正式工程与只读源不得重合或嵌套。");
  }
  const sidecar = getSidecarPaths(projectRoot);
  const [sourceBefore, protectedBefore, indexBefore] = await Promise.all([
    inventory(sourceRoot),
    inventory(projectRoot, ALLOWED_SCAN_WRITES),
    stat(sidecar.index).then(async (metadata) => ({ bytes: metadata.size, mtimeMs: metadata.mtimeMs, sha256: await fileSha(sidecar.index) })),
  ]);
  if (sourceBefore.files !== SOURCE_BASELINE.files || sourceBefore.bytes !== SOURCE_BASELINE.bytes || sourceBefore.sha256 !== SOURCE_BASELINE.sha256) {
    throw new Error(`第三季只读源基线不一致：${JSON.stringify(sourceBefore)}`);
  }
  const persisted = await scanAndPersist(projectRoot, { includeHashes: true });
  assertFormalProjection(persisted);
  const [stored, fresh, sourceAfter, protectedAfter] = await Promise.all([
    loadIndex(projectRoot),
    previewProjectScan(projectRoot),
    inventory(sourceRoot),
    inventory(projectRoot, ALLOWED_SCAN_WRITES),
  ]);
  if (!stored || stored.scanId !== persisted.scanId) throw new Error("持久 index 与本次 Scanner 提交不一致。");
  assertFormalProjection(stored);
  assertFormalProjection(fresh);
  if (JSON.stringify(sheetProjection(stored)) !== JSON.stringify(sheetProjection(fresh))) {
    throw new Error("持久 Scanner 投影与随后只读复扫不一致。");
  }
  if (JSON.stringify(sourceBefore) !== JSON.stringify(sourceAfter) || JSON.stringify(protectedBefore) !== JSON.stringify(protectedAfter)) {
    throw new Error("正式 Scanner 刷新改写了只读源或非白名单工程文件。");
  }
  const indexAfterMetadata = await stat(sidecar.index);
  const indexAfter = { bytes: indexAfterMetadata.size, mtimeMs: indexAfterMetadata.mtimeMs, sha256: await fileSha(sidecar.index) };
  const evidence = {
    schemaVersion: 1,
    kind: "p4-storyboard-sheet-index-refresh",
    createdAt: new Date().toISOString(),
    workspace,
    projectRoot,
    sourceRoot,
    source: { before: sourceBefore, after: sourceAfter, unchanged: true },
    protectedProject: { before: protectedBefore, after: protectedAfter, unchanged: true, allowedWrites: ALLOWED_SCAN_WRITES },
    index: { before: indexBefore, after: indexAfter, scanId: persisted.scanId },
    summary: persisted.summary.storyboardSheets,
    projection: sheetProjection(persisted),
    readOnlyReplayMatchesPersisted: true,
    passed: true,
  };
  await mkdir(path.dirname(options.evidencePath), { recursive: true });
  await writeFile(options.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  process.stdout.write(`${JSON.stringify({ passed: true, evidencePath: options.evidencePath, scanId: persisted.scanId, summary: persisted.summary.storyboardSheets, artifacts: evidence.projection.length, sourceUnchanged: true, protectedUnchanged: true }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
