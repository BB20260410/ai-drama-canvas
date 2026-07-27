import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import sharp from "sharp";
import {
  getCanonicalAsset,
  getCanonicalAssetCatalogState,
  inspectCanonicalAssetStoreCurrentness,
  listCanonicalAssets,
  loadCanonicalAssetStore,
  type CanonicalAssetStore,
} from "../src/core/canonical-assets.js";
import {
  loadFusionPanelReferenceStoreSnapshot,
} from "../src/core/fusion-panel-references.js";
import {
  inspectFusionPanelVisualConstraintCurrentness,
  loadFusionPanelVisualConstraintStore,
} from "../src/core/fusion-visual-constraint-store.js";
import { getReviewQueue } from "../src/core/reviews.js";
import { getSidecarPaths, writeJsonAtomicExclusive } from "../src/core/sidecar.js";
import { expectedRuntimeMcpToolCount } from "../src/core/release-manifest.js";

const DEFAULT_WORKSPACE = "/Users/hxx/Documents/无限画布";
const DEFAULT_PROJECT_RELATIVE = "productions/gushujuan-s3-f1a688020bfb7af6";
const DEFAULT_SOURCE_ROOT = "/Users/hxx/Documents/古蜀卷第三季";
const EXPECTED_SOURCE = {
  fileCount: 3_344,
  totalBytes: 24_570_877,
  digest: "f62c9504da74f5873634300b85ab584d7039a1356fa3d24004d99f30e2cc9f8b",
} as const;
interface CanonicalCounts {
  assets: number;
  aliases: number;
  definitionVersions: number;
  contractVersions: number;
  versions: number;
  authorities: number;
  relations: number;
  media: number;
  assetsWithVersions: number;
  assetsWithoutVersions: number;
  primaryAuthorities: number;
  supportingAuthorities: number;
  byCategory: { character: number; scene: number; prop: number };
}
const EXPECTED_COUNTS = {
  assets: 77,
  aliases: 194,
  definitionVersions: 77,
  contractVersions: 77,
  versions: 21,
  authorities: 21,
  relations: 0,
  media: 39,
  assetsWithVersions: 20,
  assetsWithoutVersions: 57,
  primaryAuthorities: 20,
  supportingAuthorities: 1,
  byCategory: { character: 24, scene: 20, prop: 33 },
} as const satisfies CanonicalCounts;
const EXPECTED_TOOL_COUNT = await expectedRuntimeMcpToolCount(DEFAULT_WORKSPACE);
const EXPECTED_P2_LOCKS = 5_481;
const EXPECTED_P3_LOCKS = 5_481;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const TARGETED_TEST_FILES = [
  "tests/canonical-assets.test.ts",
  "tests/p5-canonical-migration-reconcile.test.ts",
  "tests/command-bus.test.ts",
  "tests/asset-registry.test.ts",
  "tests/reviews.test.ts",
  "tests/mcp-canonical-assets.test.ts",
] as const;

interface CliOptions {
  workspace: string;
  projectRoot: string;
  sourceRoot: string;
  evidencePath: string;
  migrationEvidencePath: string;
  consumerEvidencePath: string;
  mcpEvidencePath: string;
  uiEvidencePath: string;
  uiScreenshotPath: string;
  runRoot: string;
}

interface FileEvidence {
  path: string;
  bytes: number;
  sha256: string;
}

interface MigrationInventory {
  root: string;
  fileCount: number;
  totalBytes: number;
  digest: string;
}

interface TreeSnapshot {
  root: string;
  files: number;
  directories: number;
  bytes: number;
  semanticSha256: string;
  identitySha256: string;
}

interface RunEvidence {
  name: string;
  argv: string[];
  cwd: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  exitCode: number;
  termination: {
    timeoutMs: number;
    timedOut: boolean;
    signalsSent: string[];
    exitSignal?: string;
    spawnError?: string;
  };
  stdout: FileEvidence & { tail: string[] };
  stderr: FileEvidence & { tail: string[] };
  testSummary?: {
    filesPassed: number;
    testsPassed: number;
    filesSkipped: number;
    testsSkipped: number;
  };
}

interface PlanningAttestation {
  root: string;
  taskPlan: FileEvidence;
  attestation: FileEvidence;
  modeFile: FileEvidence;
  stopBlocksFile: FileEvidence;
  taskPlanSha256: string;
  attestedSha256: string;
  currentPhase: "P5" | "P6";
  p5Status: "in_progress" | "completed";
  mode: string;
  stopBlocks: number;
}

interface FormalValidation {
  canonical: {
    revision: number;
    candidateFingerprint: string;
    storeFingerprint: string;
    counts: CanonicalCounts;
    currentPrimaryAuthorityIds: string[];
    currentPrimaryVersionIds: string[];
    currentSupportingAuthorityIds: string[];
    media: FileEvidence[];
    aliasSearches: Record<string, string[]>;
    p01: Record<string, unknown>;
    legacyAssetRelations: "absent" | "empty";
    reviewQueueCount: number;
    reviewQueueCanonicalAssetCount: number;
  };
  p2: Record<string, unknown>;
  p3: Record<string, unknown>;
  semanticIdentity: string;
}

function usage(): string {
  return `P5 规范资产知识库最终关账（正式工程与第三季源只读）

用法：
  npx tsx scripts/validate-p5-canonical-assets-final.ts [参数]

参数：
  --workspace <path>
  --project-root <path>
  --source-root <path>
  --migration-evidence <json>
  --consumer-evidence <json>
  --mcp-evidence <json>
  --ui-evidence <json>
  --ui-screenshot <png>
  --evidence <json>       最终 JSON；必须位于 docs/evidence 且预先不存在
  --run-root <dir>        四项真实命令的独占日志目录；预先不得存在
  --help

验证器不迁移、不扫描落盘、不提交 Review、不启动浏览器、不调用生图或供应商。
任一门禁失败均不写 final JSON。
`;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function optionValue(argv: string[], name: string): string | undefined {
  const indexes = argv.flatMap((entry, index) => entry === name ? [index] : []);
  if (indexes.length > 1) throw new Error(`${name} 不得重复。`);
  if (!indexes.length) return undefined;
  const value = argv[indexes[0]! + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} 缺少路径参数。`);
  return value;
}

function parseOptions(argv: string[]): CliOptions {
  const names = new Set([
    "--workspace", "--project-root", "--source-root", "--evidence", "--run-root",
    "--migration-evidence", "--consumer-evidence", "--mcp-evidence", "--ui-evidence", "--ui-screenshot",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const entry = argv[index]!;
    if (entry === "--help" || entry === "-h") continue;
    if (!names.has(entry)) throw new Error(`未知参数：${entry}`);
    index += 1;
  }
  const workspace = path.resolve(optionValue(argv, "--workspace") ?? DEFAULT_WORKSPACE);
  const projectRoot = path.resolve(optionValue(argv, "--project-root") ?? path.join(workspace, DEFAULT_PROJECT_RELATIVE));
  const evidenceRoot = path.join(workspace, "docs", "evidence");
  return {
    workspace,
    projectRoot,
    sourceRoot: path.resolve(optionValue(argv, "--source-root") ?? DEFAULT_SOURCE_ROOT),
    evidencePath: path.resolve(optionValue(argv, "--evidence") ?? path.join(evidenceRoot, "final-validation-20260718-p5-canonical-assets.json")),
    migrationEvidencePath: path.resolve(optionValue(argv, "--migration-evidence") ?? path.join(evidenceRoot, "p5-canonical-migration-20260718-r3.json")),
    consumerEvidencePath: path.resolve(optionValue(argv, "--consumer-evidence") ?? path.join(evidenceRoot, "p5-canonical-consumers-20260718-r2.json")),
    mcpEvidencePath: path.resolve(optionValue(argv, "--mcp-evidence") ?? path.join(evidenceRoot, "p5-canonical-mcp-smoke-20260718-r3.json")),
    uiEvidencePath: path.resolve(optionValue(argv, "--ui-evidence") ?? path.join(evidenceRoot, "p5-canonical-assets-ui-smoke-20260718-r2.json")),
    uiScreenshotPath: path.resolve(optionValue(argv, "--ui-screenshot") ?? path.join(evidenceRoot, "p5-canonical-assets-ui-smoke-20260718-r2.png")),
    runRoot: path.resolve(optionValue(argv, "--run-root") ?? path.join(evidenceRoot, "p5-canonical-final-runs-20260718-01")),
  };
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([key, entry]) => [key, stableValue(entry)]));
}

function stableText(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableText).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableText(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function digest(value: unknown): string {
  return sha256(JSON.stringify(stableValue(value)));
}

function isInside(root: string, candidate: string, allowSame = false): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (relative === "") return allowSame;
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function exists(filePath: string): Promise<boolean> {
  return access(filePath).then(() => true, () => false);
}

async function nearestExistingRealPath(candidate: string): Promise<string> {
  const suffix: string[] = [];
  let cursor = path.resolve(candidate);
  while (!await exists(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) throw new Error(`无法定位现存父目录：${candidate}`);
    suffix.unshift(path.basename(cursor));
    cursor = parent;
  }
  return path.join(await realpath(cursor), ...suffix);
}

async function assertSafePaths(input: CliOptions): Promise<void> {
  const evidenceRootPath = path.join(input.workspace, "docs", "evidence");
  const productionsRootPath = path.join(input.workspace, "productions");
  const [workspace, projectRoot, sourceRoot, evidenceRoot, productionsRoot] = await Promise.all([
    realpath(input.workspace), realpath(input.projectRoot), realpath(input.sourceRoot),
    realpath(evidenceRootPath), realpath(productionsRootPath),
  ]);
  assert(isInside(workspace, evidenceRoot), "docs/evidence 经解析后不在工作区。 ");
  assert(isInside(productionsRoot, projectRoot), "正式工程必须位于 workspace/productions 的隔离子树。 ");
  assert(projectRoot !== sourceRoot && !isInside(projectRoot, sourceRoot, true) && !isInside(sourceRoot, projectRoot, true), "正式工程与只读源不得相同或互相嵌套。 ");
  const targets: Array<[string, string, boolean]> = [
    ["final evidence", input.evidencePath, false],
    ["run root", input.runRoot, false],
    ["migration evidence", input.migrationEvidencePath, true],
    ["consumer evidence", input.consumerEvidencePath, true],
    ["MCP evidence", input.mcpEvidencePath, true],
    ["UI evidence", input.uiEvidencePath, true],
    ["UI screenshot", input.uiScreenshotPath, true],
  ];
  const resolved = new Set<string>();
  for (const [label, target, mustExist] of targets) {
    assert(isInside(evidenceRootPath, target), `${label} 必须位于 docs/evidence。`);
    const canonical = await exists(target) ? await realpath(target) : await nearestExistingRealPath(target);
    assert(isInside(evidenceRoot, canonical) && !isInside(projectRoot, canonical, true) && !isInside(sourceRoot, canonical, true), `${label} 经符号链接解析后越界。`);
    assert(!resolved.has(canonical), `${label} 复用了另一证据或日志路径。`);
    resolved.add(canonical);
    if (mustExist) assert(await exists(target), `缺少 ${label}：${target}`);
  }
  assert(!await exists(input.evidencePath), `最终证据已存在，拒绝覆盖：${input.evidencePath}`);
  assert(!await exists(input.runRoot), `最终日志目录已存在，拒绝复用：${input.runRoot}`);
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(filePath), new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      callback();
    },
  }));
  return hash.digest("hex");
}

async function fileEvidence(filePath: string): Promise<FileEvidence> {
  const link = await lstat(filePath);
  assert(link.isFile() && !link.isSymbolicLink(), `只接受非符号链接普通文件：${filePath}`);
  const before = await stat(filePath);
  const fileSha256 = await sha256File(filePath);
  const after = await stat(filePath);
  assert(before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs, `计算摘要期间文件变化：${filePath}`);
  return { path: filePath, bytes: before.size, sha256: fileSha256 };
}

async function readJsonEvidence<T = Record<string, any>>(filePath: string): Promise<{ value: T; file: FileEvidence }> {
  const before = await stat(filePath);
  const content = await readFile(filePath);
  const after = await stat(filePath);
  assert(before.isFile() && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs, `读取 JSON 期间文件变化：${filePath}`);
  let value: T;
  try {
    value = JSON.parse(content.toString("utf8")) as T;
  } catch {
    throw new Error(`JSON 无法解析：${filePath}`);
  }
  return { value, file: { path: filePath, bytes: content.length, sha256: sha256(content) } };
}

async function mapLimit<T, R>(values: readonly T[], limit: number, mapper: (value: T) => Promise<R>): Promise<R[]> {
  const output = new Array<R>(values.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(Math.max(values.length, 1), limit) }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= values.length) return;
      output[index] = await mapper(values[index]!);
    }
  }));
  return output;
}

async function collectTree(root: string): Promise<Array<{ relativePath: string; absolutePath: string; kind: "file" | "directory"; metadata: Awaited<ReturnType<typeof lstat>> }>> {
  const rows: Array<{ relativePath: string; absolutePath: string; kind: "file" | "directory"; metadata: Awaited<ReturnType<typeof lstat>> }> = [];
  async function walk(relativeDirectory: string): Promise<void> {
    const absoluteDirectory = relativeDirectory ? path.join(root, relativeDirectory) : root;
    const entries = (await readdir(absoluteDirectory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const absolutePath = path.join(root, ...relativePath.split("/"));
      const metadata = await lstat(absolutePath);
      assert(!metadata.isSymbolicLink(), `受保护树含符号链接：${absolutePath}`);
      if (metadata.isDirectory()) {
        rows.push({ relativePath, absolutePath, kind: "directory", metadata });
        await walk(relativePath);
      } else {
        assert(metadata.isFile(), `受保护树含非普通条目：${absolutePath}`);
        rows.push({ relativePath, absolutePath, kind: "file", metadata });
      }
    }
  }
  await walk("");
  return rows;
}

async function treeSnapshot(root: string): Promise<TreeSnapshot> {
  const entries = await collectTree(root);
  const rows = await mapLimit(entries, 8, async (entry) => {
    const before = entry.metadata;
    const fileSha256 = entry.kind === "file" ? await sha256File(entry.absolutePath) : undefined;
    const after = await lstat(entry.absolutePath);
    assert(before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs, `冻结受保护树期间条目变化：${entry.absolutePath}`);
    return {
      path: entry.relativePath,
      kind: entry.kind,
      bytes: before.size,
      mode: before.mode,
      dev: before.dev,
      ino: before.ino,
      mtimeMs: before.mtimeMs,
      ctimeMs: before.ctimeMs,
      ...(fileSha256 ? { sha256: fileSha256 } : {}),
    };
  });
  const semanticRows = rows.map(({ path: relativePath, kind, bytes, sha256: fileSha256 }) => ({ path: relativePath, kind, bytes, sha256: fileSha256 }));
  return {
    root,
    files: rows.filter((entry) => entry.kind === "file").length,
    directories: rows.filter((entry) => entry.kind === "directory").length,
    bytes: rows.filter((entry) => entry.kind === "file").reduce((sum, entry) => sum + entry.bytes, 0),
    semanticSha256: digest(semanticRows),
    identitySha256: digest(rows),
  };
}

async function migrationInventory(root: string): Promise<MigrationInventory> {
  const entries = (await collectTree(root)).filter((entry) => entry.kind === "file");
  const rows = await mapLimit(entries, 8, async (entry) => {
    const before = await stat(entry.absolutePath, { bigint: true });
    const fileSha256 = await sha256File(entry.absolutePath);
    const after = await stat(entry.absolutePath, { bigint: true });
    assert(before.size === after.size && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs, `源清单期间文件变化：${entry.absolutePath}`);
    return { path: entry.relativePath, size: Number(before.size), mtimeNs: before.mtimeNs.toString(), sha256: fileSha256 };
  });
  rows.sort((left, right) => left.path.localeCompare(right.path, "en"));
  return {
    root,
    fileCount: rows.length,
    totalBytes: rows.reduce((sum, entry) => sum + entry.size, 0),
    digest: sha256(stableText(rows)),
  };
}

async function validatePlanningAttestation(workspace: string): Promise<PlanningAttestation> {
  const root = path.join(workspace, ".planning", "2026-07-17-ai-p0-p10");
  const taskPlanPath = path.join(root, "task_plan.md");
  const attestationPath = path.join(root, ".attestation");
  const modePath = path.join(root, ".mode");
  const stopBlocksPath = path.join(root, ".stop_blocks");
  const [taskPlan, attestation, modeFile, stopBlocksFile, text, attested, modeText, stopText] = await Promise.all([
    fileEvidence(taskPlanPath), fileEvidence(attestationPath), fileEvidence(modePath), fileEvidence(stopBlocksPath),
    readFile(taskPlanPath, "utf8"), readFile(attestationPath, "utf8"), readFile(modePath, "utf8"), readFile(stopBlocksPath, "utf8"),
  ]);
  const attestedSha256 = attested.trim();
  const mode = modeText.trim();
  const stopBlocks = Number(stopText.trim());
  const p5Section = text.match(/### P5:[\s\S]*?\*\*Status:\*\* (in_progress|completed)/u);
  const p6Section = text.match(/### P6:[\s\S]*?\*\*Status:\*\* (in_progress|pending)/u);
  const phaseMatch = text.match(/## Current Phase\n(P5|P6)/u);
  const currentPhase = phaseMatch?.[1] as "P5" | "P6" | undefined;
  const p5Status = p5Section?.[1] as "in_progress" | "completed" | undefined;
  assert(taskPlan.sha256 === attestedSha256 && SHA256_PATTERN.test(attestedSha256), "planning attestation 与 task_plan SHA 不一致。 ");
  assert(mode === "autonomous gate" && stopBlocks === 0, `planning mode/stop block 无效：${JSON.stringify({ mode, stopBlocks })}`);
  assert((currentPhase === "P5" && p5Status === "in_progress")
    || (currentPhase === "P6" && p5Status === "completed" && p6Section?.[1] === "in_progress"),
  `P5 最终验证只接受 P5 in_progress 或已合法切换到 P6：${JSON.stringify({ currentPhase, p5Status, p6Status: p6Section?.[1] })}`);
  assert(text.includes("P4–P10 本地软件研发期间冻结浏览器、外部生图、图生视频、上传和正式批量生产")
    && text.includes("同脸、犬纹、构图、光线、表演和像素级连续性仍须可追溯人工或视觉模型 attestation"),
  "planning 丢失外部生产冻结或视觉一致性诚实边界。 ");
  return { root, taskPlan, attestation, modeFile, stopBlocksFile, taskPlanSha256: taskPlan.sha256, attestedSha256, currentPhase, p5Status, mode, stopBlocks };
}

function plainCounts(store: CanonicalAssetStore): CanonicalCounts {
  const primaryAuthorities = store.assets.filter((asset) => Boolean(asset.primaryAuthorityId)).length;
  const supportingAuthorities = store.assets.reduce((sum, asset) => sum + (asset.currentSupportingAuthorityIds?.length ?? 0), 0);
  const assetsWithVersions = new Set(store.versions.map((version) => version.assetId)).size;
  return {
    assets: store.assets.length,
    aliases: store.aliases.length,
    definitionVersions: store.definitionVersions.length,
    contractVersions: store.contractVersions.length,
    versions: store.versions.length,
    authorities: store.authorities.length,
    relations: store.relations.length,
    media: store.versions.reduce((sum, version) => sum + version.media.length, 0),
    assetsWithVersions,
    assetsWithoutVersions: store.assets.length - assetsWithVersions,
    primaryAuthorities,
    supportingAuthorities,
    byCategory: {
      character: store.assets.filter((asset) => asset.category === "character").length,
      scene: store.assets.filter((asset) => asset.category === "scene").length,
      prop: store.assets.filter((asset) => asset.category === "prop").length,
    },
  };
}

function setEquals(left: Iterable<string>, right: Iterable<string>): boolean {
  const a = [...new Set(left)].sort((x, y) => x.localeCompare(y, "en"));
  const b = [...new Set(right)].sort((x, y) => x.localeCompare(y, "en"));
  return JSON.stringify(a) === JSON.stringify(b);
}

function legacyRelationsEmpty(value: unknown): boolean {
  if (Array.isArray(value)) return value.length === 0;
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.relations)) return record.relations.length === 0;
  if (Array.isArray(record.items)) return record.items.length === 0;
  return Object.keys(record).length === 0;
}

async function validateFormalState(input: CliOptions): Promise<FormalValidation> {
  const paths = getSidecarPaths(input.projectRoot);
  const [store, catalog, currentness, p01, aliases, p2Snapshot, p3Store, p3Currentness, reviewQueue] = await Promise.all([
    loadCanonicalAssetStore(input.projectRoot),
    getCanonicalAssetCatalogState(input.projectRoot),
    inspectCanonicalAssetStoreCurrentness(input.projectRoot),
    getCanonicalAsset(input.projectRoot, "P01"),
    Promise.all([
      listCanonicalAssets(input.projectRoot, { search: "半璧", limit: 200 }),
      listCanonicalAssets(input.projectRoot, { search: "随魂素玉", limit: 200 }),
      listCanonicalAssets(input.projectRoot, { search: "旧铜鱼挂坠", limit: 200 }),
    ]),
    loadFusionPanelReferenceStoreSnapshot(input.projectRoot),
    loadFusionPanelVisualConstraintStore(input.projectRoot),
    inspectFusionPanelVisualConstraintCurrentness(input.projectRoot),
    getReviewQueue(input.projectRoot, { includeResolved: true }),
  ]);
  assert(store, "正式规范资产 store 缺失。 ");
  assert(catalog.available && catalog.current && currentness.current
    && catalog.storeRevision === 3 && currentness.storeRevision === 3
    && catalog.storeFingerprint === store.storeFingerprint && currentness.storeFingerprint === store.storeFingerprint
    && currentness.driftedInputs.length === 0 && currentness.issues.length === 0,
  `规范资产库不是 r3 current：${JSON.stringify({ catalog, currentness })}`);
  const counts = plainCounts(store);
  assert(JSON.stringify(counts) === JSON.stringify(EXPECTED_COUNTS), `规范资产精确计数漂移：${JSON.stringify(counts)}`);
  assert(catalog.counts && JSON.stringify(catalog.counts) === JSON.stringify(EXPECTED_COUNTS), "Catalog 计数与直接 store 计数不一致。 ");

  for (const asset of store.assets) {
    assert(Object.prototype.hasOwnProperty.call(asset, "currentSupportingAuthorityIds") && Array.isArray(asset.currentSupportingAuthorityIds), `${asset.id} 缺少显式 currentSupportingAuthorityIds。`);
    assert(new Set(asset.currentSupportingAuthorityIds).size === asset.currentSupportingAuthorityIds.length, `${asset.id} 当前 supporting head 重复。`);
    assert(asset.currentSupportingAuthorityIds.length === (asset.id === "P01" ? 1 : 0), `${asset.id} 当前 supporting head 数量错误。`);
  }
  const primaryAuthorities = store.assets.flatMap((asset) => {
    if (!asset.primaryAuthorityId) return [];
    const authority = store.authorities.find((entry) => entry.id === asset.primaryAuthorityId);
    assert(authority?.assetId === asset.id && authority.exposure === "allowed" && authority.scope.usage === "generation-reference" && authority.role !== "supporting-identity", `${asset.id} 当前主权威无效。`);
    return [authority];
  });
  const supportingAuthorities = store.assets.flatMap((asset) => asset.currentSupportingAuthorityIds!.map((authorityId) => {
    const authority = store.authorities.find((entry) => entry.id === authorityId);
    assert(authority?.assetId === asset.id && authority.role === "supporting-identity", `${asset.id} supporting 权威悬空。`);
    return authority;
  }));
  assert(primaryAuthorities.length === 20 && supportingAuthorities.length === 1, "当前权威 head 不是 20 主 + 1 supporting。 ");
  const currentPrimaryVersionIds = primaryAuthorities.map((authority) => authority.assetVersionId).sort((left, right) => left.localeCompare(right, "en"));
  assert(new Set(currentPrimaryVersionIds).size === 20, "20 个当前主权威没有映射到 20 个唯一版本。 ");

  const p01Primary = p01.authorities.find((authority) => authority.id === p01.asset.primaryAuthorityId);
  const p01SupportingId = p01.asset.currentSupportingAuthorityIds?.[0];
  const p01Supporting = p01.authorities.find((authority) => authority.id === p01SupportingId);
  assert(p01Primary?.role === "production-hard-lock" && p01Primary.exposure === "allowed" && p01Primary.scope.usage === "generation-reference", "P01 当前主权威不是可用于生成的 production hard lock。 ");
  assert(p01Supporting?.role === "supporting-identity" && p01Supporting.exposure === "forbidden" && p01Supporting.scope.usage === "human-review-only"
    && p01Supporting.source.kind === "legacy-authority" && p01Supporting.source.exposeToGeneration === false,
  "P01 黄金面具 supporting 权威没有保持 forbidden/human-review-only。 ");

  const expectedSearches: Array<[string, string]> = [["半璧", "P03"], ["随魂素玉", "P03"], ["旧铜鱼挂坠", "P04"]];
  const aliasSearches: Record<string, string[]> = {};
  aliases.forEach((page, index) => {
    const [query, expectedId] = expectedSearches[index]!;
    const ids = page.items.map((asset) => asset.id);
    assert(page.available && page.storeRevision === store.revision && page.storeFingerprint === store.storeFingerprint
      && page.total === 1 && ids.length === 1 && ids[0] === expectedId,
    `别名 ${query} 未由当前 store 唯一命中 ${expectedId}。`);
    aliasSearches[query] = ids;
  });

  const mediaByPath = new Map<string, { bytes: number; sha256: string }>();
  for (const version of store.versions) for (const media of version.media) {
    const resolved = path.resolve(media.path);
    const previous = mediaByPath.get(resolved);
    if (previous) assert(previous.bytes === media.bytes && previous.sha256 === media.sha256, `同一媒体路径身份冲突：${resolved}`);
    else mediaByPath.set(resolved, { bytes: media.bytes, sha256: media.sha256 });
  }
  const media = await mapLimit([...mediaByPath.entries()], 8, async ([filePath, expected]) => {
    const evidence = await fileEvidence(filePath);
    assert(evidence.bytes === expected.bytes && evidence.sha256 === expected.sha256, `规范媒体 SHA/尺寸漂移：${filePath}`);
    return evidence;
  });
  assert(mediaByPath.size === 39 && media.length === 39, `规范媒体实际文件不是 39 项：${media.length}`);

  let legacyAssetRelations: "absent" | "empty" = "absent";
  if (await exists(paths.assetRelations)) {
    const legacy = JSON.parse(await readFile(paths.assetRelations, "utf8")) as unknown;
    assert(legacyRelationsEmpty(legacy), "legacy asset-relations.json 非空，仍构成第二可写事实源。 ");
    legacyAssetRelations = "empty";
  }
  const canonicalWorkItemIds = new Set(store.assets.map((asset) => asset.source.workItemId));
  const canonicalReviewQueueItems = reviewQueue.filter((entry) => canonicalWorkItemIds.has(entry.item.id));
  assert(canonicalReviewQueueItems.length === 0, `旧 Review queue 泄漏 ${canonicalReviewQueueItems.length} 个规范资产。`);

  assert(p2Snapshot?.currentness.current && p2Snapshot.store.revision === 3
    && p2Snapshot.currentness.storeRevision === 3
    && p2Snapshot.currentness.storeFingerprint === p2Snapshot.store.storeFingerprint
    && p2Snapshot.currentness.driftedInputs.length === 0,
  `P2 仓不是 r3 current：${JSON.stringify(p2Snapshot?.currentness)}`);
  assert(p3Store && p3Store.revision === 2 && p3Currentness.current
    && p3Currentness.storeRevision === 2 && p3Currentness.storeFingerprint === p3Store.storeFingerprint
    && p3Currentness.p2StoreRevision === 3 && p3Currentness.p2StoreFingerprint === p2Snapshot.store.storeFingerprint
    && p3Currentness.driftedInputs.length === 0,
  `P3 仓不是 r2 current 或未绑定 P2 r3：${JSON.stringify(p3Currentness)}`);

  const p2Locked = Object.values(p2Snapshot.store.resolutions).flatMap((resolution) => resolution.semanticAssets.flatMap((asset) => asset.hardLock ? [asset.hardLock] : []));
  const p2Versions = p2Locked.map((lock) => lock.referenceVersion);
  const p3Locked = Object.values(p3Store.constraints).flatMap((constraint) => constraint.identityLocks.filter((lock) => lock.status === "locked"));
  const p3Versions = p3Locked.map((lock) => lock.referenceVersion).filter((value): value is string => Boolean(value));
  assert(p2Locked.length === EXPECTED_P2_LOCKS && p2Versions.length === EXPECTED_P2_LOCKS && setEquals(p2Versions, currentPrimaryVersionIds), "P2 不是 5481 个 current-primary-only 规范锁。 ");
  assert(p3Locked.length === EXPECTED_P3_LOCKS && p3Versions.length === EXPECTED_P3_LOCKS && setEquals(p3Versions, currentPrimaryVersionIds), "P3 不是 5481 个 current-primary-only 规范锁。 ");
  assert(p2Snapshot.store.audit.closurePassed && p2Snapshot.store.audit.currentContracts === 1_288 && p2Snapshot.store.audit.panels === 4_330, "P2 闭包计数失效。 ");
  assert(p3Store.audit.closurePassed && p3Store.audit.contracts === 1_288 && p3Store.audit.constraints === 4_330, "P3 闭包计数失效。 ");

  const currentPrimarySet = new Set(currentPrimaryVersionIds);
  const disallowedVersions = store.versions.filter((version) => !currentPrimarySet.has(version.id));
  const disallowedVersionIds = disallowedVersions.map((version) => version.id);
  const disallowedPaths = new Set(disallowedVersions.flatMap((version) => version.media.map((entry) => entry.path)));
  const disallowedSha = new Set(disallowedVersions.flatMap((version) => version.media.map((entry) => entry.sha256)));
  for (const authority of store.authorities.filter((entry) => !primaryAuthorities.some((primary) => primary.id === entry.id))) {
    if (authority.source.kind === "legacy-authority") {
      disallowedPaths.add(authority.source.sourcePath);
      disallowedPaths.add(authority.source.snapshotPath);
      disallowedSha.add(authority.source.sourceSha256);
      disallowedSha.add(authority.source.snapshotSha256);
    } else {
      disallowedPaths.add(authority.source.path);
    }
  }
  const p2Serialized = JSON.stringify(p2Snapshot.store);
  const p3Serialized = JSON.stringify(p3Store);
  const leakedVersionIds = disallowedVersionIds.filter((entry) => p2Serialized.includes(entry) || p3Serialized.includes(entry));
  const leakedPaths = [...disallowedPaths].filter((entry) => p2Serialized.includes(entry) || p3Serialized.includes(entry));
  const leakedSha = [...disallowedSha].filter((entry) => p2Serialized.includes(entry) || p3Serialized.includes(entry));
  assert(leakedVersionIds.length === 0 && leakedPaths.length === 0 && leakedSha.length === 0,
    `P2/P3 泄漏 forbidden/historical 身份：${JSON.stringify({ leakedVersionIds, leakedPaths, leakedSha })}`);

  const p2 = {
    revision: p2Snapshot.store.revision,
    storeFingerprint: p2Snapshot.store.storeFingerprint,
    currentness: {
      current: p2Snapshot.currentness.current,
      storeRevision: p2Snapshot.currentness.storeRevision,
      storeFingerprint: p2Snapshot.currentness.storeFingerprint,
      driftedInputs: p2Snapshot.currentness.driftedInputs,
    },
    audit: p2Snapshot.store.audit,
    canonicalLockedBindings: p2Locked.length,
    canonicalReferenceVersions: [...new Set(p2Versions)].sort((left, right) => left.localeCompare(right, "en")),
    forbiddenOrHistoricalLeaks: { versionIds: leakedVersionIds, paths: leakedPaths, sha256: leakedSha },
  };
  const p3 = {
    revision: p3Store.revision,
    storeFingerprint: p3Store.storeFingerprint,
    currentness: {
      current: p3Currentness.current,
      storeRevision: p3Currentness.storeRevision,
      storeFingerprint: p3Currentness.storeFingerprint,
      p2StoreRevision: p3Currentness.p2StoreRevision,
      p2StoreFingerprint: p3Currentness.p2StoreFingerprint,
      driftedInputs: p3Currentness.driftedInputs,
    },
    audit: p3Store.audit,
    canonicalLockedIdentities: p3Locked.length,
    canonicalReferenceVersions: [...new Set(p3Versions)].sort((left, right) => left.localeCompare(right, "en")),
    forbiddenOrHistoricalLeaks: { versionIds: leakedVersionIds, paths: leakedPaths, sha256: leakedSha },
  };
  const canonical = {
    revision: store.revision,
    candidateFingerprint: store.candidateFingerprint,
    storeFingerprint: store.storeFingerprint,
    counts,
    currentPrimaryAuthorityIds: primaryAuthorities.map((entry) => entry.id).sort((left, right) => left.localeCompare(right, "en")),
    currentPrimaryVersionIds,
    currentSupportingAuthorityIds: supportingAuthorities.map((entry) => entry.id),
    media,
    aliasSearches,
    p01: {
      assetId: p01.asset.id,
      primaryAuthorityId: p01Primary.id,
      primaryVersionId: p01Primary.assetVersionId,
      supportingAuthorityId: p01Supporting.id,
      supportingVersionId: p01Supporting.assetVersionId,
      supportingExposure: p01Supporting.exposure,
      supportingUsage: p01Supporting.scope.usage,
      exposeToGeneration: p01Supporting.source.kind === "legacy-authority" ? p01Supporting.source.exposeToGeneration : undefined,
    },
    legacyAssetRelations,
    reviewQueueCount: reviewQueue.length,
    reviewQueueCanonicalAssetCount: canonicalReviewQueueItems.length,
  };
  return { canonical, p2, p3, semanticIdentity: digest({ canonical, p2, p3 }) };
}

function assertionsPassed(record: Record<string, unknown>): boolean {
  return Object.values(record).every((value) => value !== false
    && (!value || typeof value !== "object" || assertionsPassed(value as Record<string, unknown>)));
}

async function validateExternalEvidence(input: CliOptions): Promise<Record<string, unknown>> {
  const [migration, consumer, mcp, ui, screenshot] = await Promise.all([
    readJsonEvidence(input.migrationEvidencePath),
    readJsonEvidence(input.consumerEvidencePath),
    readJsonEvidence(input.mcpEvidencePath),
    readJsonEvidence(input.uiEvidencePath),
    fileEvidence(input.uiScreenshotPath),
  ]);
  const migrationValue = migration.value;
  const consumerValue = consumer.value;
  const mcpValue = mcp.value;
  const uiValue = ui.value;
  for (const [label, value] of [["migration", migrationValue], ["consumer", consumerValue], ["MCP", mcpValue], ["UI", uiValue]] as const) {
    assert(value.projectRoot === input.projectRoot, `${label} 证据不是当前正式工程。`);
  }
  assert(migrationValue.kind === "p5-canonical-asset-migration-evidence"
    && migrationValue.sourceRoot === input.sourceRoot
    && migrationValue.store?.revision === 3
    && migrationValue.store?.storeFingerprint === "8f1057fe11a53594cda2032d14808a730664705ad2b5b9c2e3dcdc5d7ac45964"
    && JSON.stringify(migrationValue.store?.counts) === JSON.stringify(EXPECTED_COUNTS)
    && migrationValue.sourceBefore?.digest === EXPECTED_SOURCE.digest
    && migrationValue.sourceAfter?.digest === EXPECTED_SOURCE.digest
    && assertionsPassed(migrationValue.assertions),
  "P5 migration 证据未证明 r3/精确计数/源不变/全部断言。 ");
  assert(consumerValue.kind === "p5-canonical-consumer-refresh-evidence"
    && consumerValue.sourceRoot === input.sourceRoot
    && consumerValue.canonical?.revision === 3
    && consumerValue.p2?.revision === 3 && consumerValue.p2?.canonicalLockedBindings === EXPECTED_P2_LOCKS
    && consumerValue.p3?.revision === 2 && consumerValue.p3?.canonicalLockedIdentities === EXPECTED_P3_LOCKS
    && setEquals(consumerValue.p2?.canonicalReferenceVersions ?? [], consumerValue.canonical?.currentAllowedVersionIds ?? [])
    && setEquals(consumerValue.p3?.canonicalReferenceVersions ?? [], consumerValue.canonical?.currentAllowedVersionIds ?? [])
    && (consumerValue.canonical?.disallowedPathLeaks?.length ?? -1) === 0
    && consumerValue.sourceBefore?.digest === EXPECTED_SOURCE.digest && consumerValue.sourceAfter?.digest === EXPECTED_SOURCE.digest
    && assertionsPassed(consumerValue.assertions),
  "P5 consumer 证据未证明 P2/P3 current-primary-only 闭包。 ");

  assert(mcpValue.kind === "p5-canonical-mcp-smoke" && mcpValue.passed === true
    && mcpValue.parity?.passed === true && mcpValue.parity?.responseFingerprintsEqual === true
    && mcpValue.parity?.sourceFingerprint === mcpValue.parity?.compiledFingerprint
    && Array.isArray(mcpValue.runs) && mcpValue.runs.length === 2
    && setEquals(mcpValue.runs.map((run: Record<string, unknown>) => String(run.mode)), ["source", "compiled"])
    && mcpValue.runs.every((run: any) => run.passed === true && run.toolCount === EXPECTED_TOOL_COUNT
      && run.p01?.modelSafeProjection?.returnedAuthorityCount === 1
      && run.p01?.modelSafeProjection?.returnedVersionCount === 1
      && run.p01?.modelSafeProjection?.returnedSupportingAuthorityCount === 0
      && run.p01?.modelSafeProjection?.redactions?.currentForbiddenAuthorityCount === 1
      && run.p01?.modelSafeProjection?.redactions?.currentForbiddenVersionCount === 1
      && run.p01?.modelSafeProjection?.redactions?.historicalVersionCount === 0
      && run.p01?.modelSafeProjection?.redactions?.omittedVersionCount === 1
      && run.p01?.modelSafeProjection?.generationPolicy?.currentAuthorityOnly === true
      && run.p01?.modelSafeProjection?.generationPolicy?.forbiddenAndHistoricalOmitted === true
      && run.p01?.modelSafeProjection?.forbiddenAndHistoricalSourceSnapshotShaMediaValuesAbsent === true
      && run.p01?.modelSafeProjection?.forbiddenAndHistoricalLockRowsAbsent === true
      && run.payloadSafety?.base64Payloads === 0 && run.payloadSafety?.binaryValues === 0
      && Array.isArray(run.writeToolsInvoked) && run.writeToolsInvoked.length === 0
      && run.vendorBrowserOrGenerationInvoked === false)
    && mcpValue.formalProjectGuard?.sourceUnchanged === true && mcpValue.formalProjectGuard?.compiledUnchanged === true
    && assertionsPassed(mcpValue.assertions),
  "P5 MCP source/compiled release-manifest parity 或默认脱敏门禁不成立。 ");

  assert(uiValue.kind === "p5-canonical-assets-fresh-profile-ui-smoke" && uiValue.passed === true
    && uiValue.workspace === input.workspace
    && uiValue.freshProfile?.filesBeforeLaunch === 0 && uiValue.freshProfile?.cleaned === true
    && uiValue.catalog?.storeRevision === 3 && JSON.stringify(uiValue.catalog?.counts) === JSON.stringify(EXPECTED_COUNTS)
    && uiValue.assetProtocol?.correct?.status === 200 && uiValue.assetProtocol?.correct?.bytes === uiValue.assetProtocol?.bytes
    && uiValue.assetProtocol?.correct?.cacheControl === "no-store" && uiValue.assetProtocol?.wrong?.status === 409
    && uiValue.staleCatalogGate?.staleUi?.cards === 0 && uiValue.staleCatalogGate?.staleUi?.images === 0
    && uiValue.staleCatalogGate?.staleUi?.details === 0
    && uiValue.staleCatalogGate?.callsBefore?.list === uiValue.staleCatalogGate?.callsDuring?.list
    && uiValue.staleCatalogGate?.callsBefore?.detail === uiValue.staleCatalogGate?.callsDuring?.detail
    && uiValue.staleCatalogGate?.currentRestored === true
    && uiValue.guarded?.unchanged === true && uiValue.guarded?.protectedTreesUnchanged === true
    && Object.values(uiValue.writes ?? {}).every((value) => value === false)
    && uiValue.externalWebpages === 0 && assertionsPassed(uiValue.assertions),
  "P5 fresh-profile UI、SHA 200/409 或 stale 清空门禁不成立。 ");
  assert(path.resolve(uiValue.screenshot?.path ?? "") === input.uiScreenshotPath
    && uiValue.screenshot?.bytes === screenshot.bytes && uiValue.screenshot?.sha256 === screenshot.sha256,
  "UI JSON 与截图文件身份不一致。 ");
  const [metadata, stats] = await Promise.all([
    sharp(input.uiScreenshotPath, { failOn: "error" }).metadata(),
    sharp(input.uiScreenshotPath, { failOn: "error" }).stats(),
  ]);
  const standardDeviation = stats.channels.reduce((sum, channel) => sum + channel.stdev, 0) / stats.channels.length;
  assert((metadata.width ?? 0) >= 1_000 && (metadata.height ?? 0) >= 700 && screenshot.bytes > 100_000 && standardDeviation > 5,
    `UI 截图不可解码、为空或信息量过低：${JSON.stringify({ metadata, bytes: screenshot.bytes, standardDeviation })}`);
  assert(metadata.width === uiValue.screenshot.width && metadata.height === uiValue.screenshot.height, "UI 截图解码尺寸与证据不一致。 ");
  return {
    files: { migration: migration.file, consumer: consumer.file, mcp: mcp.file, ui: ui.file, screenshot },
    migration: { revision: migrationValue.store.revision, storeFingerprint: migrationValue.store.storeFingerprint },
    consumer: { p2Revision: consumerValue.p2.revision, p3Revision: consumerValue.p3.revision },
    mcp: { toolCount: EXPECTED_TOOL_COUNT, parityFingerprint: mcpValue.parity.sourceFingerprint },
    ui: { freshProfileCleaned: true, shaProtocol: { correct: 200, mismatch: 409 }, staleCards: 0, screenshot: { width: metadata.width, height: metadata.height, standardDeviation } },
  };
}

function tailLines(value: string, limit = 60): string[] {
  return value.split(/\r?\n/u).filter(Boolean).slice(-limit);
}

function parseTestSummary(output: string): RunEvidence["testSummary"] {
  const normalized = output.replace(/\u001b\[[0-9;]*m/gu, "");
  const files = normalized.match(/Test Files\s+(\d+) passed(?:\s*\|\s*(\d+) skipped)?/u);
  const tests = normalized.match(/Tests\s+(\d+) passed(?:\s*\|\s*(\d+) skipped)?/u);
  if (!files || !tests) return undefined;
  return { filesPassed: Number(files[1]), testsPassed: Number(tests[1]), filesSkipped: Number(files[2] ?? 0), testsSkipped: Number(tests[2] ?? 0) };
}

async function runCommand(workspace: string, runRoot: string, name: string, command: string, args: string[], timeoutMs: number): Promise<RunEvidence> {
  const argv = [command, ...args];
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  process.stderr.write(`[P5 final] ${name}: ${argv.join(" ")}\n`);
  const result = await new Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean; signalsSent: string[]; exitSignal?: string; spawnError?: string }>((resolve) => {
    const child = spawn(command, args, {
      cwd: workspace,
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const signalsSent: string[] = [];
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let forceKill: ReturnType<typeof setTimeout> | undefined;
    let fallback: ReturnType<typeof setTimeout> | undefined;
    const signalTree = (signal: NodeJS.Signals): void => {
      signalsSent.push(signal);
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        try { child.kill(signal); } catch { /* 已退出 */ }
      }
    };
    const finish = (exitCode: number, exitSignal?: string, spawnError?: string): void => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      if (fallback) clearTimeout(fallback);
      resolve({ exitCode, stdout, stderr, timedOut, signalsSent, exitSignal, spawnError });
    };
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", (error) => finish(-1, undefined, error instanceof Error ? error.message : String(error)));
    child.once("close", (code, signal) => finish(code ?? -1, signal ?? undefined));
    timeout = setTimeout(() => {
      timedOut = true;
      stderr += `\n[P5 final] ${name} 超过 ${timeoutMs}ms，终止独立进程组。\n`;
      signalTree("SIGTERM");
      forceKill = setTimeout(() => {
        signalTree("SIGKILL");
        fallback = setTimeout(() => {
          child.stdout.destroy();
          child.stderr.destroy();
          finish(-1, "SIGKILL");
        }, 3_000);
      }, 5_000);
    }, timeoutMs);
  });
  const stdoutPath = path.join(runRoot, `${name}.stdout.log`);
  const stderrPath = path.join(runRoot, `${name}.stderr.log`);
  await Promise.all([
    writeFile(stdoutPath, result.stdout, { encoding: "utf8", flag: "wx" }),
    writeFile(stderrPath, result.stderr, { encoding: "utf8", flag: "wx" }),
  ]);
  const endedAt = new Date().toISOString();
  const evidence: RunEvidence = {
    name,
    argv,
    cwd: workspace,
    startedAt,
    endedAt,
    durationMs: Date.now() - startedMs,
    exitCode: result.exitCode,
    termination: { timeoutMs, timedOut: result.timedOut, signalsSent: result.signalsSent, exitSignal: result.exitSignal, spawnError: result.spawnError },
    stdout: { ...await fileEvidence(stdoutPath), tail: tailLines(result.stdout) },
    stderr: { ...await fileEvidence(stderrPath), tail: tailLines(result.stderr) },
    testSummary: parseTestSummary(`${result.stdout}\n${result.stderr}`),
  };
  if (result.exitCode !== 0 || result.timedOut || result.spawnError) {
    throw new Error(`${name} 失败（exit ${result.exitCode}${result.timedOut ? ", timeout" : ""}）：\n${[...evidence.stdout.tail, ...evidence.stderr.tail].slice(-80).join("\n")}`);
  }
  return evidence;
}

async function runCloseoutCommands(input: CliOptions): Promise<Record<string, RunEvidence>> {
  await mkdir(input.runRoot, { recursive: false });
  const runs: Record<string, RunEvidence> = {};
  runs.typecheck = await runCommand(input.workspace, input.runRoot, "01-typecheck", "npm", ["run", "typecheck"], 300_000);
  runs.targeted = await runCommand(input.workspace, input.runRoot, "02-p5-targeted-tests", "npx", [
    "vitest", "run", ...TARGETED_TEST_FILES, "--maxWorkers=1", "--reporter=verbose",
  ], 900_000);
  assert(runs.targeted.testSummary
    && runs.targeted.testSummary.filesPassed === TARGETED_TEST_FILES.length
    && runs.targeted.testSummary.testsPassed >= 61
    && runs.targeted.testSummary.filesSkipped === 0 && runs.targeted.testSummary.testsSkipped === 0,
  `P5 定向测试没有形成 6 文件、至少 61 项且零 skip 的证据：${JSON.stringify(runs.targeted.testSummary)}`);
  runs.full = await runCommand(input.workspace, input.runRoot, "03-full-tests", "npm", ["test"], 1_200_000);
  assert(runs.full.testSummary
    && runs.full.testSummary.filesPassed >= 58 && runs.full.testSummary.testsPassed >= 375
    && runs.full.testSummary.filesPassed >= runs.targeted.testSummary.filesPassed
    && runs.full.testSummary.testsPassed >= runs.targeted.testSummary.testsPassed
    && runs.full.testSummary.filesSkipped === 0 && runs.full.testSummary.testsSkipped === 0,
  `全量测试计数或 skip 状态不满足 P5 门禁：${JSON.stringify(runs.full.testSummary)}`);
  runs.build = await runCommand(input.workspace, input.runRoot, "04-production-build", "npm", ["run", "build"], 600_000);
  return runs;
}

async function runLogSnapshot(runRoot: string): Promise<{ files: number; bytes: number; aggregateSha256: string }> {
  const names = (await readdir(runRoot)).sort((left, right) => left.localeCompare(right, "en"));
  const rows = await Promise.all(names.map(async (name) => {
    const evidence = await fileEvidence(path.join(runRoot, name));
    return { name, bytes: evidence.bytes, sha256: evidence.sha256 };
  }));
  return { files: rows.length, bytes: rows.reduce((sum, row) => sum + row.bytes, 0), aggregateSha256: digest(rows) };
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    process.stdout.write(usage());
    return;
  }
  const input = parseOptions(process.argv.slice(2));
  await assertSafePaths(input);
  const startedAt = new Date().toISOString();
  const [sourceBefore, projectBefore, planningBefore, externalEvidence, formalBefore] = await Promise.all([
    migrationInventory(input.sourceRoot),
    treeSnapshot(input.projectRoot),
    validatePlanningAttestation(input.workspace),
    validateExternalEvidence(input),
    validateFormalState(input),
  ]);
  assert(sourceBefore.fileCount === EXPECTED_SOURCE.fileCount && sourceBefore.totalBytes === EXPECTED_SOURCE.totalBytes && sourceBefore.digest === EXPECTED_SOURCE.digest,
    `第三季源清单不匹配 P5 正式基线：${JSON.stringify(sourceBefore)}`);
  assert(formalBefore.canonical.storeFingerprint === (externalEvidence.migration as any).storeFingerprint, "正式规范 store 与 migration 证据不是同一指纹。 ");
  assert(formalBefore.canonical.currentPrimaryVersionIds.length === 20
    && setEquals(formalBefore.canonical.currentPrimaryVersionIds, (formalBefore.p2 as any).canonicalReferenceVersions)
    && setEquals(formalBefore.canonical.currentPrimaryVersionIds, (formalBefore.p3 as any).canonicalReferenceVersions),
  "正式 P2/P3 没有与 20 个 current primary 形成同一版本集合。 ");

  const externalFilesBefore = Object.values((externalEvidence.files as Record<string, FileEvidence>));
  const commandRuns = await runCloseoutCommands(input);
  const runLogs = await runLogSnapshot(input.runRoot);
  assert(Object.keys(commandRuns).length === 4
    && Object.values(commandRuns).every((run) => run.exitCode === 0 && !run.termination.timedOut && !run.termination.spawnError
      && isInside(input.runRoot, run.stdout.path) && isInside(input.runRoot, run.stderr.path))
    && new Set(Object.values(commandRuns).flatMap((run) => [run.stdout.path, run.stderr.path])).size === 8
    && runLogs.files === 8,
  `四项真实命令没有形成 8 个唯一成功 SHA 日志：${JSON.stringify(runLogs)}`);
  const compiledMcpServer = await fileEvidence(path.join(input.workspace, "dist-mcp", "mcp", "server.js"));
  assert(compiledMcpServer.bytes > 100_000 && SHA256_PATTERN.test(compiledMcpServer.sha256), "production build 未形成可用 compiled MCP server。 ");

  const [sourceAfter, projectAfter, planningAfter, formalAfter, ...externalFilesAfter] = await Promise.all([
    migrationInventory(input.sourceRoot),
    treeSnapshot(input.projectRoot),
    validatePlanningAttestation(input.workspace),
    validateFormalState(input),
    ...externalFilesBefore.map((entry) => fileEvidence(entry.path)),
  ]);
  assert(JSON.stringify(sourceAfter) === JSON.stringify(sourceBefore), "P5 最终验证期间第三季只读源发生变化。 ");
  assert(JSON.stringify(projectAfter) === JSON.stringify(projectBefore), "P5 最终验证期间正式工程树发生变化。 ");
  assert(JSON.stringify(planningAfter) === JSON.stringify(planningBefore), "P5 最终验证期间 gated planning/attestation 发生变化。 ");
  assert(formalAfter.semanticIdentity === formalBefore.semanticIdentity, "P5 最终验证前后规范资产/P2/P3 语义身份漂移。 ");
  assert(JSON.stringify(externalFilesAfter) === JSON.stringify(externalFilesBefore), "P5 外部 migration/consumer/MCP/UI/截图证据在关账期间变化。 ");

  const assertions = {
    source3344Files24570877BytesAndSignedDigestExact: true,
    sourceUnchangedDuringValidation: true,
    formalProjectFullTreeUnchangedDuringValidation: true,
    gatedPlanningAttestationValidForP5OrLegalP6TransitionAndStable: true,
    canonicalStoreRevision3CurrentAndExact77_194_77_77_21_21_0_39: true,
    explicitCategories24_20_33AndEverySupportingHeadFieldPresent: true,
    twentyCurrentPrimaryAndOneP01ForbiddenSupportingAuthority: true,
    explicitAliasSearchesResolveP03AndP04Uniquely: true,
    allThirtyNineCanonicalMediaFilesMatchBytesAndSha256: true,
    legacyAssetRelationSidecarAbsentOrEmpty: true,
    legacyReviewQueueContainsZeroCanonicalAssets: true,
    p2Revision3CurrentWith5481CurrentPrimaryOnlyBindings: true,
    p3Revision2CurrentWith5481CurrentPrimaryOnlyIdentities: true,
    forbiddenHistoricalVersionPathAndShaLeaksInP2P3Zero: true,
    migrationAndConsumerEvidenceBoundToCurrentFormalStore: true,
    sourceAndCompiledMcpParityExactly178WithDefaultRedaction: true,
    freshProfileUiSha200_409AndStaleZeroStatePassed: true,
    uiScreenshotDecodableNonEmptyAndEvidenceBound: true,
    allFourCommandRunsExitedZeroWithEightExclusiveShaBoundLogs: true,
    targetedAndFullTestsHaveRealCountsAndZeroSkips: true,
    productionBuildCreatedCompiledMcpServer: true,
    browserVendorGenerationUploadReviewAndFormalWritesByValidatorZero: true,
  };
  assert(Object.values(assertions).every((value) => value === true), "P5 final 仍有未通过断言。 ");
  const endedAt = new Date().toISOString();
  const evidence = {
    schemaVersion: 1,
    kind: "p5-canonical-assets-final-validation",
    createdAt: endedAt,
    validationWindow: { startedAt, endedAt },
    invocation: { argv: [process.execPath, ...process.argv.slice(1)], cwd: process.cwd() },
    workspace: input.workspace,
    projectRoot: input.projectRoot,
    sourceRoot: input.sourceRoot,
    runRoot: input.runRoot,
    source: { before: sourceBefore, after: sourceAfter, unchanged: true },
    formalProjectTree: { before: projectBefore, after: projectAfter, unchanged: true },
    planning: { before: planningBefore, after: planningAfter, unchanged: true },
    canonical: formalBefore.canonical,
    p2: formalBefore.p2,
    p3: formalBefore.p3,
    formalSemanticIdentity: { before: formalBefore.semanticIdentity, after: formalAfter.semanticIdentity, unchanged: true },
    externalEvidence,
    externalEvidenceFiles: { before: externalFilesBefore, after: externalFilesAfter, unchanged: true },
    commandRuns,
    runLogs,
    compiledMcpServer,
    productionFreeze: {
      formalProjectWritesByValidator: false,
      sourceWritesByValidator: false,
      browserOrVendorInvokedByValidator: false,
      imageGenerationInvokedByValidator: false,
      uploadInvokedByValidator: false,
      reviewSubmittedByValidator: false,
      gitStageCommitPushInvokedByValidator: false,
    },
    assertions,
  };
  const created = await writeJsonAtomicExclusive(input.evidencePath, evidence);
  assert(created === "created", `最终证据未独占创建：${input.evidencePath}`);
  process.stdout.write(`${JSON.stringify({
    passed: true,
    evidencePath: input.evidencePath,
    runRoot: input.runRoot,
    canonical: {
      revision: formalBefore.canonical.revision,
      counts: formalBefore.canonical.counts,
      currentPrimaryVersions: formalBefore.canonical.currentPrimaryVersionIds.length,
      currentSupportingAuthorities: formalBefore.canonical.currentSupportingAuthorityIds.length,
    },
    p2: { revision: (formalBefore.p2 as any).revision, locks: (formalBefore.p2 as any).canonicalLockedBindings },
    p3: { revision: (formalBefore.p3 as any).revision, locks: (formalBefore.p3 as any).canonicalLockedIdentities },
    tests: { targeted: commandRuns.targeted?.testSummary, full: commandRuns.full?.testSummary },
    mcpTools: EXPECTED_TOOL_COUNT,
    assertions,
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
