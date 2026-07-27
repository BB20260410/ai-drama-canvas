import { createHash } from "node:crypto";
import { constants as fsConstants, createReadStream } from "node:fs";
import {
  access,
  copyFile,
  lstat,
  mkdir,
  readFile,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import {
  auditFusionPanelVisualConstraints,
  inspectFusionPanelVisualConstraintCurrentness,
  loadFusionPanelVisualConstraintStore,
  materializeFusionPanelVisualConstraints,
} from "../src/core/fusion-visual-constraint-store.js";
import { loadFusionProjectManifest } from "../src/core/fusion-production.js";
import {
  FUSION_SUBAGENT_GENERIC_INSTRUCTIONS,
  getGenerationSettings,
  upsertGenerationProvider,
  type GenerationProviderUpsert,
} from "../src/core/generation.js";
import { getSidecarPaths, readJson } from "../src/core/sidecar.js";
import type { GenerationJob, GenerationSettings, ReviewStore } from "../src/core/types.js";
import type { PublicationStore } from "../src/core/publication.js";

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
const SIDE_CAR_MUTATION_ALLOWLIST = [
  "generation.json",
  "events.jsonl",
  "panel-visual-constraints.json",
  "backups/**",
  "locks/**",
];

interface CliOptions {
  workspace: string;
  projectRoot: string;
  sourceRoot: string;
  evidencePath?: string;
  apply: boolean;
}

interface FileEvidence {
  path: string;
  bytes: number;
  sha256: string;
}

interface InventorySnapshot {
  root: string;
  files: number;
  bytes: number;
  aggregateSha256: string;
}

interface ProtectedSnapshot {
  generationJobs: FileEvidence;
  publications: FileEvidence;
  reviews: FileEvidence;
  p2PanelReferenceStore: FileEvidence;
  rawLabeled: InventorySnapshot;
  historicalRequests: InventorySnapshot;
  immutableSidecar: InventorySnapshot;
  counts: {
    generationJobs: number;
    generationByStatus: Record<string, number>;
    publicationIntents: number;
    publicationReceipts: number;
    reviews: number;
  };
  identitySha256: string;
}

interface BackupEntry {
  relativePath: string;
  existed: boolean;
  bytes?: number;
  sha256?: string;
  blobPath?: string;
}

interface ContentAddressedBackup {
  root: string;
  address: string;
  reused: boolean;
  entries: BackupEntry[];
  manifestSha256: string;
}

function backupEntryIdentity(entry: BackupEntry): Omit<BackupEntry, "blobPath"> {
  return {
    relativePath: entry.relativePath,
    existed: entry.existed,
    ...(entry.bytes !== undefined ? { bytes: entry.bytes } : {}),
    ...(entry.sha256 ? { sha256: entry.sha256 } : {}),
  };
}

interface P3StateSummary {
  exists: boolean;
  current: boolean;
  revision?: number;
  storeFingerprint?: string;
  auditFingerprint?: string;
  constraints?: number;
  contracts?: number;
  legacyGenerationJobEvidence?: number;
}

function usage(): string {
  return `P3 结构化剧情与视觉硬锁安全迁移（默认只读预检）

用法：
  npx tsx scripts/migrate-p3-visual-constraints.ts [参数]

参数：
  --workspace <path>       工作区，默认 ${DEFAULT_WORKSPACE}
  --project-root <path>    隔离工程，默认 <workspace>/${DEFAULT_PROJECT_RELATIVE_PATH}
  --source-root <path>     第三季只读源，默认 ${DEFAULT_SOURCE_ROOT}
  --evidence <path>        可选机器可读摘要；必须位于 <workspace>/docs/evidence 且不得覆盖
  --apply                  显式执行；不带时只读预检并输出计划
  --help                   显示帮助

迁移只允许：把 codex-subagent-imagegen 的全局说明替换为 Core 的通用安全说明、
物化 panel-visual-constraints.json，以及写入相应 events/内容寻址备份。
不会改写 Job、Publication、Review、P2 引用仓、raw/labeled 或历史 request。
`;
}

function optionValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} 缺少路径参数。`);
  return value;
}

function parseOptions(argv: string[]): CliOptions {
  const workspace = path.resolve(optionValue(argv, "--workspace") ?? DEFAULT_WORKSPACE);
  const evidenceValue = optionValue(argv, "--evidence");
  return {
    workspace,
    projectRoot: path.resolve(optionValue(argv, "--project-root") ?? path.join(workspace, DEFAULT_PROJECT_RELATIVE_PATH)),
    sourceRoot: path.resolve(optionValue(argv, "--source-root") ?? DEFAULT_SOURCE_ROOT),
    ...(evidenceValue ? { evidencePath: path.resolve(evidenceValue) } : {}),
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

function isInside(parentPath: string, childPath: string): boolean {
  const relative = path.relative(path.resolve(parentPath), path.resolve(childPath));
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

async function exists(filePath: string): Promise<boolean> {
  return access(filePath).then(() => true).catch(() => false);
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const input = createReadStream(filePath);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("error", reject);
    input.on("end", resolve);
  });
  return hash.digest("hex");
}

async function fileEvidence(filePath: string): Promise<FileEvidence> {
  const linkMetadata = await lstat(filePath);
  if (linkMetadata.isSymbolicLink() || !linkMetadata.isFile()) throw new Error(`只接受普通文件：${filePath}`);
  const before = await stat(filePath);
  const fileSha256 = await sha256File(filePath);
  const after = await stat(filePath);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
    throw new Error(`计算 SHA 期间文件发生变化：${filePath}`);
  }
  return { path: filePath, bytes: before.size, sha256: fileSha256 };
}

async function listRegularFiles(
  root: string,
  patterns: string | string[] = "**/*",
  ignore: string[] = [],
): Promise<string[]> {
  const entries = (await fg(patterns, {
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
    if (metadata.isSymbolicLink()) throw new Error(`受保护清单包含符号链接，拒绝迁移：${absolutePath}`);
    if (metadata.isDirectory()) continue;
    if (!metadata.isFile()) throw new Error(`受保护清单包含非普通文件，拒绝迁移：${absolutePath}`);
    files.push(relativePath);
  }
  return files;
}

async function mapLimit<T, R>(values: readonly T[], limit: number, mapper: (value: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, Math.max(1, values.length)) }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
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
  const relativePaths = await listRegularFiles(root, options.patterns, options.ignore);
  const records = await mapLimit(relativePaths, 8, async (relativePath) => {
    const absolutePath = path.join(root, ...relativePath.split("/"));
    const before = await stat(absolutePath);
    const fileSha256 = await sha256File(absolutePath);
    const after = await stat(absolutePath);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error(`冻结清单期间文件发生变化：${absolutePath}`);
    }
    return {
      relativePath,
      bytes: before.size,
      sha256: fileSha256,
      ...(options.includeMtime ? { mtimeMs: before.mtimeMs } : {}),
    };
  });
  return {
    root,
    files: records.length,
    bytes: records.reduce((sum, entry) => sum + entry.bytes, 0),
    aggregateSha256: sha256(records.map((entry) => `${entry.relativePath}\0${entry.bytes}\0${"mtimeMs" in entry ? `${entry.mtimeMs}\0` : ""}${entry.sha256}`).join("\n")),
  };
}

function countByStatus(jobs: GenerationJob[]): Record<string, number> {
  return Object.fromEntries([...new Set(jobs.map((job) => job.status))]
    .sort((left, right) => left.localeCompare(right, "en"))
    .map((status) => [status, jobs.filter((job) => job.status === status).length]));
}

async function protectedSnapshot(projectRoot: string): Promise<ProtectedSnapshot> {
  const sidecar = getSidecarPaths(projectRoot);
  const [
    generationJobs,
    publications,
    reviews,
    p2PanelReferenceStore,
    rawLabeled,
    historicalRequests,
    immutableSidecar,
    jobsValue,
    publicationValue,
    reviewValue,
  ] = await Promise.all([
    fileEvidence(sidecar.generationJobs),
    fileEvidence(sidecar.publications),
    fileEvidence(sidecar.reviews),
    fileEvidence(sidecar.panelReferenceResolutions),
    inventorySnapshot(projectRoot, { patterns: RAW_LABELED_PATTERNS, ignore: RAW_LABELED_IGNORES }),
    inventorySnapshot(sidecar.generationRequests),
    inventorySnapshot(sidecar.root, { ignore: SIDE_CAR_MUTATION_ALLOWLIST }),
    readJson<GenerationJob[]>(sidecar.generationJobs, []),
    readJson<PublicationStore | null>(sidecar.publications, null),
    readJson<ReviewStore | null>(sidecar.reviews, null),
  ]);
  if (!Array.isArray(jobsValue) || !publicationValue || !reviewValue) throw new Error("正式工程 Job/Publication/Review 存储结构无效。");
  if (!rawLabeled.files) throw new Error("正式工程没有 raw/labeled，拒绝把空清单误当作保护成功。");
  if (!historicalRequests.files) throw new Error("正式工程没有历史 generation request，拒绝迁移。");
  const base = {
    generationJobs,
    publications,
    reviews,
    p2PanelReferenceStore,
    rawLabeled,
    historicalRequests,
    immutableSidecar,
    counts: {
      generationJobs: jobsValue.length,
      generationByStatus: countByStatus(jobsValue),
      publicationIntents: publicationValue.intents.length,
      publicationReceipts: publicationValue.receipts.length,
      reviews: reviewValue.records.length,
    },
  };
  return { ...base, identitySha256: digest(base) };
}

async function sourceSnapshot(sourceRoot: string): Promise<InventorySnapshot> {
  return inventorySnapshot(sourceRoot, { includeMtime: true });
}

function assertDefaultSourceBaseline(options: CliOptions, snapshot: InventorySnapshot): void {
  if (path.resolve(options.sourceRoot) !== path.resolve(DEFAULT_SOURCE_ROOT)) return;
  if (snapshot.files !== DEFAULT_SOURCE_BASELINE.files
    || snapshot.bytes !== DEFAULT_SOURCE_BASELINE.bytes
    || snapshot.aggregateSha256 !== DEFAULT_SOURCE_BASELINE.aggregateSha256) {
    throw new Error(`第三季只读源已偏离已验收基线：${JSON.stringify(snapshot)}`);
  }
}

async function assertSafePaths(options: CliOptions): Promise<void> {
  const [workspaceCanonical, projectCanonical, sourceCanonical, productionsCanonical] = await Promise.all([
    realpath(options.workspace),
    realpath(options.projectRoot),
    realpath(options.sourceRoot),
    realpath(path.join(options.workspace, "productions")),
  ]);
  if (!isInside(productionsCanonical, projectCanonical)) throw new Error("project-root 必须是 workspace/productions 内的隔离工程。");
  if (projectCanonical === sourceCanonical || isInside(sourceCanonical, projectCanonical) || isInside(projectCanonical, sourceCanonical)) {
    throw new Error("隔离工程与只读源目录不得相同或互相嵌套。");
  }
  const sidecar = getSidecarPaths(projectCanonical);
  const sidecarCanonical = await realpath(sidecar.root);
  if (!isInside(projectCanonical, sidecarCanonical)) throw new Error(".aicanvas 经符号链接解析后越出隔离工程。");
  if (options.evidencePath) {
    const evidenceRoot = path.join(workspaceCanonical, "docs", "evidence");
    const evidenceRootCanonical = await realpath(evidenceRoot);
    if (path.dirname(options.evidencePath) !== evidenceRootCanonical) throw new Error("evidence 必须是 workspace/docs/evidence 下的直接文件。");
    if (await exists(options.evidencePath)) throw new Error(`证据文件已存在，禁止覆盖：${options.evidencePath}`);
  }
}

function providerUpsert(provider: GenerationSettings["providers"][number]): GenerationProviderUpsert {
  const { createdAt: _createdAt, updatedAt: _updatedAt, workflowHash: _workflowHash, ...input } = provider;
  return input;
}

function settingsSemanticIdentity(
  settings: GenerationSettings,
  genericProviderIds: ReadonlySet<string>,
): string {
  return digest({
    ...settings,
    revision: 0,
    updatedAt: "<bookkeeping>",
    providers: settings.providers.map((provider) => ({
      ...provider,
      updatedAt: "<bookkeeping>",
      ...(genericProviderIds.has(provider.id) ? { subagentInstructions: FUSION_SUBAGENT_GENERIC_INSTRUCTIONS } : {}),
    })),
  });
}

async function p3State(projectRoot: string): Promise<P3StateSummary> {
  const store = await loadFusionPanelVisualConstraintStore(projectRoot);
  if (!store) return { exists: false, current: false };
  const currentness = await inspectFusionPanelVisualConstraintCurrentness(projectRoot);
  return {
    exists: true,
    current: currentness.current && currentness.storeRevision === store.revision && currentness.storeFingerprint === store.storeFingerprint,
    revision: store.revision,
    storeFingerprint: store.storeFingerprint,
    auditFingerprint: store.audit.auditFingerprint,
    constraints: store.audit.constraints,
    contracts: store.audit.contracts,
    legacyGenerationJobEvidence: Object.keys(store.legacyGenerationJobEvidence).length,
  };
}

async function snapshotAllowedFiles(projectRoot: string): Promise<{ identitySha256: string; files: Array<FileEvidence | { path: string; absent: true }> }> {
  const sidecar = getSidecarPaths(projectRoot);
  const candidates = [sidecar.generationSettings, sidecar.events, sidecar.panelVisualConstraints];
  const files = [] as Array<FileEvidence | { path: string; absent: true }>;
  for (const candidate of candidates) {
    files.push(await exists(candidate) ? await fileEvidence(candidate) : { path: candidate, absent: true });
  }
  return { files, identitySha256: digest(files) };
}

async function createContentAddressedBackup(
  projectRoot: string,
  candidates: string[],
): Promise<ContentAddressedBackup> {
  const sidecar = getSidecarPaths(projectRoot);
  const entries: BackupEntry[] = [];
  for (const candidate of [...new Set(candidates.map((entry) => path.resolve(entry)))].sort((left, right) => left.localeCompare(right, "en"))) {
    if (candidate !== sidecar.root && !isInside(sidecar.root, candidate)) throw new Error(`备份候选越出 .aicanvas：${candidate}`);
    const relativePath = path.relative(sidecar.root, candidate).split(path.sep).join("/");
    if (!await exists(candidate)) {
      entries.push({ relativePath, existed: false });
      continue;
    }
    const evidence = await fileEvidence(candidate);
    entries.push({ relativePath, existed: true, bytes: evidence.bytes, sha256: evidence.sha256 });
  }
  const address = digest({ schemaVersion: 1, kind: "p3-visual-constraints-preimage", entries: entries.map(backupEntryIdentity) });
  const sidecarCanonical = await realpath(sidecar.root);
  const backupFamilyRoot = path.join(sidecar.root, "backups", "p3-visual-constraints");
  await mkdir(backupFamilyRoot, { recursive: true });
  const backupFamilyCanonical = await realpath(backupFamilyRoot);
  if (!isInside(sidecarCanonical, backupFamilyCanonical)) throw new Error("P3 备份目录经符号链接解析后越出 .aicanvas。");
  const backupRoot = path.join(backupFamilyCanonical, address);
  const manifestPath = path.join(backupRoot, "manifest.json");
  if (await exists(backupRoot)) {
    if (!await exists(manifestPath)) throw new Error(`内容寻址备份目录不完整，保留现场并停止：${backupRoot}`);
    const manifestEvidence = await fileEvidence(manifestPath);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { address?: string; entries?: BackupEntry[] };
    if (manifest.address !== address
      || digest((manifest.entries ?? []).map(backupEntryIdentity)) !== digest(entries.map(backupEntryIdentity))) {
      throw new Error(`既有内容寻址备份 manifest 与当前前镜像不一致：${backupRoot}`);
    }
    for (const entry of entries.filter((candidate) => candidate.existed)) {
      const blobPath = path.join(backupRoot, "blobs", "sha256", entry.sha256!);
      const blob = await fileEvidence(blobPath);
      if (blob.bytes !== entry.bytes || blob.sha256 !== entry.sha256) throw new Error(`既有 P3 备份 blob 已漂移：${blobPath}`);
      entry.blobPath = blobPath;
    }
    return { root: backupRoot, address, reused: true, entries, manifestSha256: manifestEvidence.sha256 };
  }
  await mkdir(backupRoot, { recursive: false });
  for (const entry of entries.filter((candidate) => candidate.existed)) {
    const sourcePath = path.join(sidecar.root, ...entry.relativePath.split("/"));
    const sourceBefore = await fileEvidence(sourcePath);
    const blobPath = path.join(backupRoot, "blobs", "sha256", entry.sha256!);
    await mkdir(path.dirname(blobPath), { recursive: true });
    if (!await exists(blobPath)) await copyFile(sourcePath, blobPath, fsConstants.COPYFILE_EXCL);
    const [sourceAfter, blob] = await Promise.all([fileEvidence(sourcePath), fileEvidence(blobPath)]);
    if (sourceBefore.bytes !== sourceAfter.bytes
      || sourceBefore.sha256 !== sourceAfter.sha256
      || sourceBefore.bytes !== blob.bytes
      || sourceBefore.sha256 !== blob.sha256) {
      throw new Error(`创建 P3 备份期间源文件变化或 blob 不一致：${sourcePath}`);
    }
    entry.blobPath = blobPath;
  }
  const manifest = {
    schemaVersion: 1,
    kind: "p3-visual-constraints-content-addressed-backup",
    address,
    createdAt: new Date().toISOString(),
    projectRoot,
    entries: entries.map(backupEntryIdentity),
    restorationPolicy: "仅供人工核验/回滚；不得覆盖 Job、Publication、Review、P2、raw/labeled 或历史 request。",
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  return {
    root: backupRoot,
    address,
    reused: false,
    entries,
    manifestSha256: (await fileEvidence(manifestPath)).sha256,
  };
}

async function writeEvidence(filePath: string | undefined, value: unknown): Promise<void> {
  if (!filePath) return;
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(usage());
    return;
  }
  const options = parseOptions(argv);
  await assertSafePaths(options);
  const sidecar = getSidecarPaths(options.projectRoot);
  const [sourceBefore, protectedBefore, settingsBeforeRaw, settingsBefore, p3Before, manifest] = await Promise.all([
    sourceSnapshot(options.sourceRoot),
    protectedSnapshot(options.projectRoot),
    readJson<GenerationSettings | null>(sidecar.generationSettings, null),
    getGenerationSettings(options.projectRoot),
    p3State(options.projectRoot),
    loadFusionProjectManifest(options.projectRoot),
  ]);
  assertDefaultSourceBaseline(options, sourceBefore);
  if (!manifest || !manifest.source.readOnly) throw new Error("正式工程缺少只读融合 manifest，拒绝迁移。");
  if (await realpath(manifest.source.root) !== await realpath(options.sourceRoot)) {
    throw new Error("source-root 与正式融合 manifest 冻结的只读源不一致。");
  }
  if (!settingsBeforeRaw) throw new Error("正式工程缺少 generation.json，拒绝迁移。");
  const subagentProviders = settingsBefore.providers.filter((provider) => provider.adapter === "codex-subagent-imagegen");
  if (!subagentProviders.length) throw new Error("正式工程没有 codex-subagent-imagegen provider，拒绝把其他 provider 当作替代目标。");
  if (settingsBefore.concurrency !== 1) throw new Error("存在子代理生图 provider 时并发必须已经冻结为 1；P3 迁移不代改并发配置。");
  const providerIdsToUpdate = subagentProviders
    .filter((provider) => provider.subagentInstructions !== FUSION_SUBAGENT_GENERIC_INSTRUCTIONS)
    .map((provider) => provider.id)
    .sort((left, right) => left.localeCompare(right, "en"));
  const needsP3Materialization = !p3Before.current;
  const plannedCandidates = [
    ...(providerIdsToUpdate.length ? [sidecar.generationSettings, sidecar.events] : []),
    ...(needsP3Materialization ? [sidecar.panelVisualConstraints] : []),
  ];
  const dryRun = {
    schemaVersion: 1,
    kind: "p3-visual-constraints-migration-dry-run",
    createdAt: new Date().toISOString(),
    apply: false,
    workspace: options.workspace,
    projectRoot: options.projectRoot,
    sourceRoot: options.sourceRoot,
    source: sourceBefore,
    protected: {
      identitySha256: protectedBefore.identitySha256,
      counts: protectedBefore.counts,
      rawLabeled: protectedBefore.rawLabeled,
      historicalRequests: protectedBefore.historicalRequests,
      p2StoreSha256: protectedBefore.p2PanelReferenceStore.sha256,
    },
    plan: {
      providerIdsToUpdate,
      providerInstructionSha256: sha256(FUSION_SUBAGENT_GENERIC_INSTRUCTIONS),
      needsP3Materialization,
      plannedSidecarFiles: plannedCandidates.map((filePath) => path.relative(sidecar.root, filePath).split(path.sep).join("/")),
      p3Before,
      productionFreeze: true,
    },
    next: providerIdsToUpdate.length || needsP3Materialization
      ? "只读预检通过；确认后显式追加 --apply。"
      : "正式工程已经满足 P3 provider 与视觉约束物化要求；--apply 将只做幂等核验。",
  };
  if (!options.apply) {
    await writeEvidence(options.evidencePath, dryRun);
    process.stdout.write(`${JSON.stringify(dryRun, null, 2)}\n`);
    return;
  }

  const backup = plannedCandidates.length
    ? await createContentAddressedBackup(options.projectRoot, plannedCandidates)
    : undefined;
  let settingsCurrent = settingsBefore;
  for (const providerId of providerIdsToUpdate) {
    const provider = settingsCurrent.providers.find((candidate) => candidate.id === providerId);
    if (!provider || provider.adapter !== "codex-subagent-imagegen") throw new Error(`迁移期间 provider 身份漂移：${providerId}`);
    settingsCurrent = await upsertGenerationProvider(options.projectRoot, {
      expectedRevision: settingsCurrent.revision,
      provider: providerUpsert({ ...provider, subagentInstructions: FUSION_SUBAGENT_GENERIC_INSTRUCTIONS }),
    }, "codex");
  }
  const genericProviderIds = new Set(providerIdsToUpdate);
  if (settingsSemanticIdentity(settingsBefore, genericProviderIds) !== settingsSemanticIdentity(settingsCurrent, new Set())) {
    throw new Error(`generation provider 迁移产生了说明与时间/修订之外的变化；备份位于 ${backup?.root ?? "未创建"}`);
  }
  if (settingsCurrent.revision !== settingsBefore.revision + providerIdsToUpdate.length) {
    throw new Error("generation provider 迁移 revision 增量不符合逐 provider CAS 写入次数。");
  }
  const firstStore = await materializeFusionPanelVisualConstraints(options.projectRoot);
  const firstAudit = await auditFusionPanelVisualConstraints(options.projectRoot);
  if (!firstStore.audit.closurePassed || !firstAudit.currentness.current) throw new Error("P3 视觉约束首次物化后未闭包或不 current。");

  const allowedBeforeSecond = await snapshotAllowedFiles(options.projectRoot);
  const secondStore = await materializeFusionPanelVisualConstraints(options.projectRoot);
  const allowedAfterSecond = await snapshotAllowedFiles(options.projectRoot);
  if (firstStore.revision !== secondStore.revision
    || firstStore.storeFingerprint !== secondStore.storeFingerprint
    || firstStore.audit.auditFingerprint !== secondStore.audit.auditFingerprint
    || allowedBeforeSecond.identitySha256 !== allowedAfterSecond.identitySha256) {
    throw new Error("P3 二次物化不是严格幂等：revision、fingerprint 或允许文件 SHA 发生变化。");
  }

  const [sourceAfter, protectedAfter, settingsAfterRaw, settingsAfter, p3After] = await Promise.all([
    sourceSnapshot(options.sourceRoot),
    protectedSnapshot(options.projectRoot),
    readJson<GenerationSettings | null>(sidecar.generationSettings, null),
    getGenerationSettings(options.projectRoot),
    p3State(options.projectRoot),
  ]);
  if (!settingsAfterRaw) throw new Error("迁移后 generation.json 消失。");
  assertDefaultSourceBaseline(options, sourceAfter);
  if (digest(sourceBefore) !== digest(sourceAfter)) throw new Error("P3 迁移期间第三季只读源发生变化。");
  if (protectedBefore.identitySha256 !== protectedAfter.identitySha256) {
    throw new Error(`P3 迁移改变了 Job/Publication/Review/P2/raw/labeled/request 或非白名单 sidecar；备份位于 ${backup?.root ?? "未创建"}`);
  }
  if (!p3After.exists || !p3After.current || !p3After.storeFingerprint || !p3After.auditFingerprint) {
    throw new Error("P3 迁移后视觉约束仓没有形成 current 闭包。");
  }
  const unsafeProviders = settingsAfter.providers.filter((provider) => provider.adapter === "codex-subagent-imagegen"
    && provider.subagentInstructions !== FUSION_SUBAGENT_GENERIC_INSTRUCTIONS);
  if (unsafeProviders.length) throw new Error(`仍有子代理 provider 未冻结通用安全说明：${unsafeProviders.map((provider) => provider.id).join("、")}`);

  const evidence = {
    schemaVersion: 1,
    kind: "p3-visual-constraints-migration",
    createdAt: new Date().toISOString(),
    apply: true,
    workspace: options.workspace,
    projectRoot: options.projectRoot,
    sourceRoot: options.sourceRoot,
    productionFreeze: true,
    source: { before: sourceBefore, after: sourceAfter, unchanged: true },
    protected: {
      beforeIdentitySha256: protectedBefore.identitySha256,
      afterIdentitySha256: protectedAfter.identitySha256,
      unchanged: true,
      counts: protectedAfter.counts,
      generationJobsSha256: protectedAfter.generationJobs.sha256,
      publicationsSha256: protectedAfter.publications.sha256,
      reviewsSha256: protectedAfter.reviews.sha256,
      p2StoreSha256: protectedAfter.p2PanelReferenceStore.sha256,
      rawLabeled: protectedAfter.rawLabeled,
      historicalRequests: protectedAfter.historicalRequests,
      immutableSidecarSha256: protectedAfter.immutableSidecar.aggregateSha256,
      reviewAttestationsFabricated: false,
    },
    providerMigration: {
      providerIdsUpdated: providerIdsToUpdate,
      instructionSha256: sha256(FUSION_SUBAGENT_GENERIC_INSTRUCTIONS),
      beforeRevision: settingsBeforeRaw.revision,
      afterRevision: settingsAfterRaw.revision,
      allSubagentProvidersGeneric: true,
    },
    p3: {
      before: p3Before,
      after: p3After,
      audit: firstStore.audit,
      currentness: firstAudit.currentness,
      strictSecondPass: {
        revisionUnchanged: true,
        storeFingerprintUnchanged: true,
        auditFingerprintUnchanged: true,
        allowedFilesSha256Unchanged: true,
        identitySha256: allowedAfterSecond.identitySha256,
      },
    },
    backup: backup ? {
      root: backup.root,
      address: backup.address,
      reused: backup.reused,
      manifestSha256: backup.manifestSha256,
      entries: backup.entries.map((entry) => ({
        relativePath: entry.relativePath,
        existed: entry.existed,
        ...(entry.bytes !== undefined ? { bytes: entry.bytes } : {}),
        ...(entry.sha256 ? { sha256: entry.sha256 } : {}),
      })),
    } : null,
  };
  await writeEvidence(options.evidencePath, evidence);
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
}

await main();
