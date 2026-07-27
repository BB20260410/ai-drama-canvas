import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, lstat, mkdir, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import { executeIdempotentCommand, type IdempotentCommandInput } from "../src/core/command-bus.js";
import { loadFusionProjectManifest } from "../src/core/fusion-production.js";
import {
  previewFusionStoryboardSheetMigration,
  type FusionStoryboardSheetMigrationResult,
} from "../src/core/fusion-storyboard-sheet-migration.js";
import { getSidecarPaths } from "../src/core/sidecar.js";

const DEFAULT_WORKSPACE = "/Users/hxx/Documents/无限画布";
const DEFAULT_PROJECT_RELATIVE_PATH = "productions/gushujuan-s3-f1a688020bfb7af6";
const DEFAULT_SOURCE_ROOT = "/Users/hxx/Documents/古蜀卷第三季";
const DEFAULT_SOURCE_BASELINE = {
  files: 3_344,
  bytes: 24_570_877,
  aggregateSha256: "649160f22663ca4c45ee4a4084e278ef0edc61ec66db01bb84da38cbea3f8d26",
} as const;
const RAW_LABELED_PATTERNS = ["**/*_raw.png", "**/*_labeled.png"];
const RAW_LABELED_IGNORES = [
  ".aicanvas/backups/**",
  ".aicanvas/generation-downloads/**",
  ".aicanvas/subagent-staging/**",
];

interface CliOptions {
  workspace: string;
  projectRoot: string;
  sourceRoot: string;
  evidencePath?: string;
  itemIds?: string[];
  apply: boolean;
}

interface FileIdentity {
  path: string;
  exists: boolean;
  bytes?: number;
  sha256?: string;
}

interface InventorySnapshot {
  root: string;
  files: number;
  bytes: number;
  aggregateSha256: string;
}

interface ProtectedSnapshot {
  generationJobs: FileIdentity;
  publications: FileIdentity;
  reviews: FileIdentity;
  generationRequests: InventorySnapshot;
  generationDownloads: InventorySnapshot;
  rawLabeled: InventorySnapshot;
  identitySha256: string;
}

function usage(): string {
  return `P4 旧中文分镜故事板安全登记（默认只读预检）

用法：
  npm run fusion:migrate-p4-storyboard-sheets -- [参数]

参数：
  --workspace <path>       工作区，默认 ${DEFAULT_WORKSPACE}
  --project-root <path>    隔离工程，默认 <workspace>/${DEFAULT_PROJECT_RELATIVE_PATH}
  --source-root <path>     第三季只读源，默认 ${DEFAULT_SOURCE_ROOT}
  --item-id <id>           可重复，仅登记明确单元；省略代表全部候选
  --evidence <path>        机器证据；必须是 workspace/docs/evidence 下未存在的直接文件
  --apply                  执行 CAS 登记；不带时仅预览
  --help                   显示帮助

只允许新增/修订 storyboard-sheet-index、命令账本与事件。Jobs、Publications、Reviews、
generation requests/downloads、raw/labeled 及第三季源目录均做前后 SHA 核对；不渲染、不生图。
`;
}

function optionValue(argv: string[], name: string): string | undefined {
  const indexes = argv.flatMap((entry, index) => entry === name ? [index] : []);
  if (indexes.length > 1 && name !== "--item-id") throw new Error(`${name} 参数重复。`);
  const index = indexes[0];
  if (index === undefined) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} 缺少值。`);
  return value;
}

function parseOptions(argv: string[]): CliOptions {
  const valueOptions = new Set(["--workspace", "--project-root", "--source-root", "--evidence", "--item-id"]);
  for (let index = 0; index < argv.length; index += 1) {
    const entry = argv[index]!;
    if (entry === "--apply" || entry === "--help" || entry === "-h") continue;
    if (!valueOptions.has(entry)) throw new Error(`未知参数：${entry}`);
    index += 1;
    if (index >= argv.length || argv[index]!.startsWith("--")) throw new Error(`${entry} 缺少值。`);
  }
  const workspace = path.resolve(optionValue(argv, "--workspace") ?? DEFAULT_WORKSPACE);
  const evidence = optionValue(argv, "--evidence");
  const itemIds = argv.flatMap((entry, index) => entry === "--item-id" ? [argv[index + 1]!] : []);
  return {
    workspace,
    projectRoot: path.resolve(optionValue(argv, "--project-root") ?? path.join(workspace, DEFAULT_PROJECT_RELATIVE_PATH)),
    sourceRoot: path.resolve(optionValue(argv, "--source-root") ?? DEFAULT_SOURCE_ROOT),
    ...(evidence ? { evidencePath: path.resolve(evidence) } : {}),
    ...(itemIds.length ? { itemIds } : {}),
    apply: argv.includes("--apply"),
  };
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([key, entry]) => [key, stableValue(entry)]));
}

function digest(value: unknown): string {
  return sha256(JSON.stringify(stableValue(value)));
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

async function exists(filePath: string): Promise<boolean> {
  return access(filePath).then(() => true, () => false);
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

async function fileIdentity(filePath: string): Promise<FileIdentity> {
  if (!await exists(filePath)) return { path: filePath, exists: false };
  const link = await lstat(filePath);
  if (link.isSymbolicLink() || !link.isFile()) throw new Error(`受保护路径不是普通文件：${filePath}`);
  const before = await stat(filePath);
  const fileSha = await sha256File(filePath);
  const after = await stat(filePath);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
    throw new Error(`计算 SHA 期间文件发生变化：${filePath}`);
  }
  return { path: filePath, exists: true, bytes: before.size, sha256: fileSha };
}

async function mapLimit<T, R>(values: readonly T[], limit: number, mapper: (value: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, Math.max(values.length, 1)) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= values.length) return;
      results[index] = await mapper(values[index]!);
    }
  }));
  return results;
}

async function inventorySnapshot(
  root: string,
  options: { patterns?: string | string[]; ignore?: string[]; includeMtime?: boolean } = {},
): Promise<InventorySnapshot> {
  if (!await exists(root)) return { root, files: 0, bytes: 0, aggregateSha256: sha256("") };
  const rootLink = await lstat(root);
  if (rootLink.isSymbolicLink() || !rootLink.isDirectory()) throw new Error(`冻结清单根目录不安全：${root}`);
  const entries = (await fg(options.patterns ?? "**/*", {
    cwd: root,
    dot: true,
    onlyFiles: false,
    followSymbolicLinks: false,
    unique: true,
    ignore: options.ignore ?? [],
  })).sort((left, right) => left.localeCompare(right, "en"));
  const files: string[] = [];
  for (const relativePath of entries) {
    const absolutePath = path.join(root, ...relativePath.split("/"));
    const metadata = await lstat(absolutePath);
    if (metadata.isSymbolicLink()) throw new Error(`受保护清单包含符号链接：${absolutePath}`);
    if (metadata.isFile()) files.push(relativePath);
    else if (!metadata.isDirectory()) throw new Error(`受保护清单包含特殊文件：${absolutePath}`);
  }
  const records = await mapLimit(files, 8, async (relativePath) => {
    const absolutePath = path.join(root, ...relativePath.split("/"));
    const before = await stat(absolutePath);
    const fileSha = await sha256File(absolutePath);
    const after = await stat(absolutePath);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error(`冻结清单期间文件发生变化：${absolutePath}`);
    }
    return { relativePath, bytes: before.size, sha256: fileSha, ...(options.includeMtime ? { mtimeMs: before.mtimeMs } : {}) };
  });
  return {
    root,
    files: records.length,
    bytes: records.reduce((sum, entry) => sum + entry.bytes, 0),
    aggregateSha256: sha256(records.map((entry) => `${entry.relativePath}\0${entry.bytes}\0${"mtimeMs" in entry ? `${entry.mtimeMs}\0` : ""}${entry.sha256}`).join("\n")),
  };
}

async function protectedSnapshot(projectRoot: string): Promise<ProtectedSnapshot> {
  const sidecar = getSidecarPaths(projectRoot);
  const [generationJobs, publications, reviews, generationRequests, generationDownloads, rawLabeled] = await Promise.all([
    fileIdentity(sidecar.generationJobs),
    fileIdentity(sidecar.publications),
    fileIdentity(sidecar.reviews),
    inventorySnapshot(sidecar.generationRequests),
    inventorySnapshot(sidecar.generationDownloads),
    inventorySnapshot(projectRoot, { patterns: RAW_LABELED_PATTERNS, ignore: RAW_LABELED_IGNORES }),
  ]);
  if (!generationJobs.exists || !publications.exists || !reviews.exists) throw new Error("正式工程缺少 Job/Publication/Review 存储。 ");
  if (rawLabeled.files === 0) throw new Error("正式工程 raw/labeled 清单为空，拒绝误报保护成功。 ");
  const base = { generationJobs, publications, reviews, generationRequests, generationDownloads, rawLabeled };
  return { ...base, identitySha256: digest(base) };
}

async function assertSafePaths(options: CliOptions): Promise<void> {
  const [workspace, projectRoot, sourceRoot, productionsRoot, evidenceRoot] = await Promise.all([
    realpath(options.workspace),
    realpath(options.projectRoot),
    realpath(options.sourceRoot),
    realpath(path.join(options.workspace, "productions")),
    realpath(path.join(options.workspace, "docs", "evidence")),
  ]);
  if (!isInside(productionsRoot, projectRoot)) throw new Error("project-root 必须是 workspace/productions 内的隔离工程。 ");
  if (projectRoot === sourceRoot || isInside(projectRoot, sourceRoot) || isInside(sourceRoot, projectRoot)) {
    throw new Error("隔离工程与只读源目录不得相同或互相嵌套。 ");
  }
  if (options.evidencePath && (path.dirname(options.evidencePath) !== evidenceRoot || await exists(options.evidencePath))) {
    throw new Error(`证据路径越界或已存在：${options.evidencePath}`);
  }
  const sidecar = await realpath(getSidecarPaths(projectRoot).root);
  if (!isInside(projectRoot, sidecar)) throw new Error(".aicanvas 经解析后越出隔离工程。 ");
  if (!isInside(workspace, evidenceRoot)) throw new Error("docs/evidence 越出工作区。 ");
}

async function writeEvidence(filePath: string | undefined, value: unknown): Promise<void> {
  if (!filePath) return;
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
}

function migrationResult(record: Awaited<ReturnType<typeof executeIdempotentCommand>>): FusionStoryboardSheetMigrationResult {
  if (record.status !== "succeeded" || !record.result || typeof record.result !== "object") {
    throw new Error(`P4 migration 命令未成功：${record.status}`);
  }
  const result = record.result as FusionStoryboardSheetMigrationResult;
  if (result.schemaVersion !== 1 || result.kind !== "fusion-storyboard-sheet-migration-result") {
    throw new Error("P4 migration 命令结果 schema 无效。 ");
  }
  return result;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(usage());
    return;
  }
  const options = parseOptions(argv);
  await assertSafePaths(options);
  const [manifest, sourceBefore, protectedBefore, previewBefore] = await Promise.all([
    loadFusionProjectManifest(options.projectRoot),
    inventorySnapshot(options.sourceRoot, { includeMtime: true }),
    protectedSnapshot(options.projectRoot),
    previewFusionStoryboardSheetMigration(options.projectRoot, options.itemIds ? { itemIds: options.itemIds } : {}),
  ]);
  if (!manifest?.source.readOnly || await realpath(manifest.source.root) !== await realpath(options.sourceRoot)) {
    throw new Error("正式融合 manifest 未绑定当前只读源。 ");
  }
  if (path.resolve(options.sourceRoot) === path.resolve(DEFAULT_SOURCE_ROOT)
    && (sourceBefore.files !== DEFAULT_SOURCE_BASELINE.files
      || sourceBefore.bytes !== DEFAULT_SOURCE_BASELINE.bytes
      || sourceBefore.aggregateSha256 !== DEFAULT_SOURCE_BASELINE.aggregateSha256)) {
    throw new Error(`第三季只读源已偏离验收基线：${JSON.stringify(sourceBefore)}`);
  }
  if (previewBefore.blockers.length) throw new Error(`P4 migration 预检失败：${previewBefore.blockers.join("；")}`);

  const payload = {
    ...(options.itemIds ? { itemIds: [...new Set(options.itemIds)].sort((a, b) => a.localeCompare(b, "en")) } : {}),
    expectedStoreRevision: previewBefore.storeRevision,
    expectedCandidateFingerprint: previewBefore.candidateFingerprint,
  };
  const identity = digest({ projectRoot: options.projectRoot, command: "migrate_fusion_storyboard_sheets", payload }).slice(0, 48);
  const command: IdempotentCommandInput = {
    requestId: `p4-sheet-migration-${identity}`,
    idempotencyKey: `p4-sheet-migration-${identity}`,
    request: { command: "migrate_fusion_storyboard_sheets", payload },
  };
  if (!options.apply) {
    const evidence = {
      schemaVersion: 1,
      kind: "p4-fusion-storyboard-sheet-migration-preview",
      createdAt: new Date().toISOString(),
      apply: false,
      workspace: options.workspace,
      projectRoot: options.projectRoot,
      sourceRoot: options.sourceRoot,
      source: sourceBefore,
      protected: protectedBefore,
      preview: previewBefore,
      command,
      vendorOrGenerationInvoked: false,
      next: previewBefore.canMigrate ? "预检通过；显式追加 --apply 执行。" : "没有待登记候选；--apply 只会进行幂等核验。",
    };
    await writeEvidence(options.evidencePath, evidence);
    process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
    return;
  }

  const firstRecord = await executeIdempotentCommand(options.projectRoot, command);
  const firstResult = migrationResult(firstRecord);
  const secondRecord = await executeIdempotentCommand(options.projectRoot, { ...command, requestId: `${command.requestId}-replay` });
  const secondResult = migrationResult(secondRecord);
  if (!secondRecord.replayed || secondResult.candidateFingerprint !== firstResult.candidateFingerprint
    || secondResult.storeRevision !== firstResult.storeRevision) {
    throw new Error("P4 migration 二次命令没有严格重放同一结果。 ");
  }

  const [sourceAfter, protectedAfter, previewAfter] = await Promise.all([
    inventorySnapshot(options.sourceRoot, { includeMtime: true }),
    protectedSnapshot(options.projectRoot),
    previewFusionStoryboardSheetMigration(options.projectRoot, options.itemIds ? { itemIds: options.itemIds } : {}),
  ]);
  if (digest(sourceBefore) !== digest(sourceAfter)) throw new Error("P4 migration 期间第三季只读源发生变化。 ");
  if (protectedBefore.identitySha256 !== protectedAfter.identitySha256) {
    throw new Error("P4 migration 改写了 Job/Publication/Review/request/download/raw/labeled。 ");
  }
  if (previewAfter.candidateFingerprint !== previewBefore.candidateFingerprint || previewAfter.pendingCount !== 0) {
    throw new Error(`P4 migration 后候选身份或 pending 异常：${JSON.stringify(previewAfter)}`);
  }
  if (previewBefore.pendingCount > 0 && (!firstResult.applied || firstResult.created !== previewBefore.pendingCount)) {
    throw new Error("P4 migration 首次执行没有登记全部待迁移候选。 ");
  }
  if (previewBefore.pendingCount === 0 && (!firstResult.replayed || firstResult.applied)) {
    throw new Error("P4 migration 已完成状态没有保持 Core 幂等。 ");
  }

  const evidence = {
    schemaVersion: 1,
    kind: "p4-fusion-storyboard-sheet-migration",
    createdAt: new Date().toISOString(),
    apply: true,
    workspace: options.workspace,
    projectRoot: options.projectRoot,
    sourceRoot: options.sourceRoot,
    source: { before: sourceBefore, after: sourceAfter, unchanged: true },
    protected: { before: protectedBefore, after: protectedAfter, unchanged: true },
    command,
    first: { record: firstRecord, result: firstResult },
    replay: { record: secondRecord, result: secondResult, strict: true },
    preview: { before: previewBefore, after: previewAfter },
    vendorOrGenerationInvoked: false,
    passed: true,
  };
  await writeEvidence(options.evidencePath, evidence);
  process.stdout.write(`${JSON.stringify({
    passed: true,
    evidencePath: options.evidencePath,
    storeRevision: previewAfter.storeRevision,
    candidateFingerprint: previewAfter.candidateFingerprint,
    created: firstResult.created,
    replayed: secondRecord.replayed,
    protectedUnchanged: true,
    sourceUnchanged: true,
  }, null, 2)}\n`);
}

await main();
