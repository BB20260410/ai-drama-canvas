import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fg from "fast-glob";
import sharp from "sharp";
import { getSidecarPaths, readJson, writeJsonAtomicExclusive } from "../src/core/sidecar.js";
import { expectedRuntimeMcpToolCount } from "../src/core/release-manifest.js";
import type {
  FusionStoryboardGridSelectionStore,
  ProjectIndex,
  ReviewRecord,
  ReviewStore,
} from "../src/core/types.js";

const workspace = path.resolve(process.argv[2] ?? "/Users/hxx/Documents/无限画布");
const expectedMcpToolCount = await expectedRuntimeMcpToolCount(workspace);
const projectRoot = path.resolve(process.argv[3] ?? path.join(workspace, "productions/gushujuan-s3-f1a688020bfb7af6"));
const evidencePath = path.resolve(process.argv[4] ?? path.join(workspace, "docs/evidence/final-validation-20260717-p0-fusion-panel-authority.json"));
const sourceRoot = "/Users/hxx/Documents/古蜀卷第三季";
const expectedSourceAggregate = "649160f22663ca4c45ee4a4084e278ef0edc61ec66db01bb84da38cbea3f8d26";
const expectedJobsSha256 = "b958c3f54195cb709816fc11f33fe0fb8a597389c9a922f8ff6581b42264c12c";
const expectedPublicationsSha256 = "eadc1faa75bde0ff88b9142805290ca832d3a286a7f4f3573bb1a1169a0a843e";
const ep001Id = "season-三-ep01-unit001";
const ep008Id = "season-三-ep01-unit008";
const ep001ContractId = "grid-6c02035d032128e0f62a";
const ep008ContractId = "grid-76e6545a6efec0e4091b";
const ep001RequirementId = "fusion-review-7916b22425ae2df44a0a3ce895530eb21459fb256d8e0ad8524182a558ec9aff";
const legacyReviewId = "review-2026-07-16T09-53-29-114Z-5ab8a207";
const migratedReviewId = "review-2026-07-16T19-18-14-130Z-527bbafe";
const uiEvidencePath = path.join(workspace, "docs/evidence/p0-panel-review-ui-smoke-20260717.json");
const uiScreenshotPath = path.join(workspace, "docs/evidence/p0-panel-review-ui-smoke-20260717.png");
const backupRoot = path.join(projectRoot, ".aicanvas/backups/p0-panel-authority-20260717-before-migration");
const sheetReceiptPath = path.join(
  projectRoot,
  "production/蜀道山古蜀卷第三季_EP01_榜缝_9x16_漫剧/04_15秒融合分镜/EP01_15s_001_承第二季EP23彩蛋第三/AI画布生成",
  "EP01_15s_001_中文分镜故事板_grid-6c02035d032128e0f62a_review-524182a558ec9aff.json",
);

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
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

async function fileEvidence(filePath: string): Promise<{ path: string; bytes: number; sha256: string }> {
  const metadata = await stat(filePath);
  return { path: filePath, bytes: metadata.size, sha256: await sha256File(filePath) };
}

async function sourceSnapshot(root: string): Promise<{ files: number; bytes: number; aggregateSha256: string }> {
  const relativePaths = (await fg("**/*", {
    cwd: root,
    onlyFiles: true,
    followSymbolicLinks: false,
    dot: true,
  })).sort((left, right) => left.localeCompare(right, "en"));
  const records: Array<{ relativePath: string; bytes: number; mtimeMs: number; sha256: string }> = [];
  for (const relativePath of relativePaths) {
    const absolutePath = path.join(root, ...relativePath.split("/"));
    const metadata = await stat(absolutePath);
    records.push({
      relativePath,
      bytes: metadata.size,
      mtimeMs: metadata.mtimeMs,
      sha256: await sha256File(absolutePath),
    });
  }
  return {
    files: records.length,
    bytes: records.reduce((sum, record) => sum + record.bytes, 0),
    aggregateSha256: sha256(records.map((record) => `${record.relativePath}\0${record.bytes}\0${record.mtimeMs}\0${record.sha256}`).join("\n")),
  };
}

interface CommandEvidence {
  command: string;
  exitCode: number;
  durationMs: number;
  stdoutTail: string[];
  stderrTail: string[];
}

function tailLines(value: string, limit = 40): string[] {
  return value.split(/\r?\n/u).filter(Boolean).slice(-limit);
}

async function runCommand(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<CommandEvidence> {
  const startedAt = Date.now();
  process.stdout.write(`[P0 validate] ${command} ${args.join(" ")}\n`);
  const result = await new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, { cwd: workspace, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("close", (code) => resolve({ exitCode: code ?? -1, stdout, stderr }));
  });
  const evidence = {
    command: [command, ...args].join(" "),
    exitCode: result.exitCode,
    durationMs: Date.now() - startedAt,
    stdoutTail: tailLines(result.stdout),
    stderrTail: tailLines(result.stderr),
  };
  if (result.exitCode !== 0) {
    throw new Error(`验证命令失败：${evidence.command}\n${[...evidence.stdoutTail, ...evidence.stderrTail].join("\n")}`);
  }
  return evidence;
}

function parseToolResult(result: unknown): any {
  const response = result as { isError?: boolean; content?: Array<{ type: string; text?: string }> };
  const text = response.content?.find((entry) => entry.type === "text" && typeof entry.text === "string")?.text;
  if (!text) throw new Error("MCP 没有返回结构化文本。");
  const parsed = JSON.parse(text);
  if (response.isError) throw new Error(parsed?.error?.message ?? text);
  return parsed;
}

async function compiledMcpReadOnlyEvidence(): Promise<{
  toolCount: number;
  capabilities: any;
  doctor: any;
  ep001: any;
  ep008: any;
  ep008InReviewQueue: boolean;
}> {
  const registryPath = "/tmp/ai-canvas-p0-final-validator-registry-20260717.json";
  const config = await readJson<{ id: string; name: string; updatedAt: string } | null>(getSidecarPaths(projectRoot).config, null);
  if (!config) throw new Error("正式工程 project.json 缺失。");
  await writeFile(registryPath, `${JSON.stringify([{
    id: config.id,
    name: config.name,
    primaryRoot: projectRoot,
    updatedAt: config.updatedAt,
  }], null, 2)}\n`, "utf8");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(workspace, "dist-mcp/mcp/server.js")],
    cwd: workspace,
    env: {
      ...process.env,
      AI_CANVAS_PROJECT_ROOT: projectRoot,
      AI_CANVAS_REGISTRY_PATH: registryPath,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "p0-final-validator", version: "1.0.0" });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    const capabilities = parseToolResult(await client.callTool({
      name: "get_capabilities",
      arguments: { projectRoot },
    }));
    const doctor = parseToolResult(await client.callTool({
      name: "doctor_project",
      arguments: { projectRoot },
    }));
    const queue = parseToolResult(await client.callTool({
      name: "get_review_queue",
      arguments: { projectRoot, includeResolved: true, limit: 100 },
    })) as any[];
    const ep008 = parseToolResult(await client.callTool({
      name: "get_item",
      arguments: { projectRoot, itemId: ep008Id },
    }));
    return {
      toolCount: tools.tools.length,
      capabilities,
      doctor,
      ep001: queue.find((entry) => entry.item?.id === ep001Id),
      ep008,
      ep008InReviewQueue: queue.some((entry) => entry.item?.id === ep008Id),
    };
  } finally {
    await client.close();
  }
}

function findReview(store: ReviewStore, id: string): ReviewRecord {
  const record = store.records.find((candidate) => candidate.id === id);
  if (!record) throw new Error(`Review 不存在：${id}`);
  return record;
}

const sidecar = getSidecarPaths(projectRoot);
const sourceBefore = await sourceSnapshot(sourceRoot);
if (sourceBefore.files !== 3_344 || sourceBefore.bytes !== 24_570_877 || sourceBefore.aggregateSha256 !== expectedSourceAggregate) {
  throw new Error(`第三季只读源基线漂移：${JSON.stringify(sourceBefore)}`);
}

const commandEvidence = {
  typecheck: await runCommand("npm", ["run", "typecheck"]),
  targeted: await runCommand("npx", [
    "vitest",
    "run",
    "tests/fusion-production.test.ts",
    "tests/reviews.test.ts",
    "tests/scanner.test.ts",
    "tests/production.test.ts",
    "tests/mcp.test.ts",
    "tests/mcp-fusion-production.test.ts",
  ]),
  full: await runCommand("npm", ["test"]),
  build: await runCommand("npm", ["run", "build"]),
  ui: await runCommand("node", ["scripts/ui-fusion-storyboard-grid-smoke.mjs"]),
};
if (!commandEvidence.targeted.stdoutTail.some((line) => line.includes("Tests  51 passed (51)"))) {
  throw new Error("P0 定向测试未形成 51/51 通过证据。");
}
if (!commandEvidence.full.stdoutTail.some((line) => line.includes("Tests  296 passed (296)"))) {
  throw new Error("全量测试未形成 296/296 通过证据。");
}

const [
  index,
  selections,
  reviews,
  backupReviews,
  jobsEvidence,
  backupJobsEvidence,
  publicationsEvidence,
  backupPublicationsEvidence,
  uiEvidence,
  sheetReceipt,
  compiledMcp,
] = await Promise.all([
  readJson<ProjectIndex | null>(sidecar.index, null),
  readJson<FusionStoryboardGridSelectionStore | null>(sidecar.storyboardGridSelections, null),
  readJson<ReviewStore | null>(sidecar.reviews, null),
  readJson<ReviewStore | null>(path.join(backupRoot, "reviews.json"), null),
  fileEvidence(sidecar.generationJobs),
  fileEvidence(path.join(backupRoot, "generation-jobs.json")),
  fileEvidence(sidecar.publications),
  fileEvidence(path.join(backupRoot, "publications.json")),
  readJson<any | null>(uiEvidencePath, null),
  readJson<any | null>(sheetReceiptPath, null),
  compiledMcpReadOnlyEvidence(),
]);
if (!index || !selections || !reviews || !backupReviews || !uiEvidence || !sheetReceipt) {
  throw new Error("P0 最终验证缺少 index、selection、review、UI 或成板 receipt。");
}

const ep001 = index.items.find((item) => item.id === ep001Id);
const ep008 = index.items.find((item) => item.id === ep008Id);
if (index.items.filter((item) => item.type === "unit").length !== 1_288) throw new Error("正式索引不是 1288 个单元。");
if (ep001?.status !== "待视频"
  || ep001.fusionStoryboard?.contractId !== ep001ContractId
  || ep001.fusionStoryboard.panelCount !== 4
  || ep001.fusionStoryboard.completedPanelCount !== 4
  || ep001.fusionStoryboard.mechanicallyValidPanelCount !== 4
  || !ep001.fusionStoryboard.visuallyApproved
  || ep001.fusionStoryboard.panels.some((panel) => panel.state !== "approved")) {
  throw new Error(`EP01_001 P0 状态无效：${JSON.stringify(ep001?.fusionStoryboard)}`);
}
if (ep008?.status !== "待尾帧"
  || ep008.fusionStoryboard?.contractId !== ep008ContractId
  || ep008.fusionStoryboard.panelCount !== 6
  || ep008.fusionStoryboard.completedPanelCount !== 4
  || ep008.fusionStoryboard.visuallyApproved
  || ep008.fusionStoryboard.panels.slice(0, 4).some((panel) => panel.state !== "awaiting_review")
  || ep008.fusionStoryboard.panels[4]?.state !== "generating"
  || ep008.fusionStoryboard.panels[5]?.state !== "missing") {
  throw new Error(`EP01_008 P0 状态没有失败关闭：${JSON.stringify(ep008?.fusionStoryboard)}`);
}

const ep001Artifacts = index.artifacts.filter((artifact) =>
  artifact.itemId === ep001Id
  && artifact.fusionStoryboardPanel?.contractId === ep001ContractId
  && artifact.authoritative
  && !artifact.deprecated
  && ["raw-image", "labeled-image"].includes(artifact.kind));
if (ep001Artifacts.length !== 8
  || new Set(ep001Artifacts.map((artifact) => artifact.fusionStoryboardPanel?.panelId)).size !== 4
  || ep001Artifacts.some((artifact) => !artifact.check.ok || !artifact.check.sha256)) {
  throw new Error("EP01_001 没有形成 4 个独立槽位、8 个权威且机械合格的 Artifact。");
}
const staleAuthoritative = index.artifacts.filter((artifact) =>
  [ep001Id, ep008Id].includes(artifact.itemId)
  && artifact.fusionStoryboardPanel
  && artifact.authoritative
  && artifact.fusionStoryboardPanel.contractId !== selections.items[artifact.itemId]?.contractId);
if (staleAuthoritative.length) throw new Error(`历史合同仍被提升为权威：${staleAuthoritative.map((artifact) => artifact.id).join("、")}`);

if (selections.revision !== 1
  || selections.items[ep001Id]?.contractId !== ep001ContractId
  || selections.items[ep001Id]?.panelCount !== 4
  || selections.items[ep008Id]?.contractId !== ep008ContractId
  || selections.items[ep008Id]?.panelCount !== 6) {
  throw new Error(`当前合同选择 store 无效：${JSON.stringify(selections)}`);
}

const legacyBefore = findReview(backupReviews, legacyReviewId);
const legacyAfter = findReview(reviews, legacyReviewId);
if (JSON.stringify(legacyAfter) !== JSON.stringify(legacyBefore)) throw new Error("迁移修改了不可变旧 Review。");
const migrated = findReview(reviews, migratedReviewId);
if (migrated.migratedFromReviewId !== legacyReviewId
  || migrated.requirementId !== ep001RequirementId
  || migrated.requirement?.id !== ep001RequirementId
  || migrated.requirement.panelCount !== 4
  || !migrated.requirement.complete
  || migrated.artifactIds.length !== 8
  || Object.keys(migrated.requirement.artifactHashes).length !== 8) {
  throw new Error("EP01_001 派生 Review 没有精确冻结当前 4 格 8 文件。");
}
if (reviews.records.some((record) => record.itemId === ep008Id && record.requirement?.complete)) {
  throw new Error("EP01_008 未完成时错误产生了完整 Review。");
}

if (jobsEvidence.sha256 !== expectedJobsSha256
  || publicationsEvidence.sha256 !== expectedPublicationsSha256
  || jobsEvidence.sha256 !== backupJobsEvidence.sha256
  || publicationsEvidence.sha256 !== backupPublicationsEvidence.sha256) {
  throw new Error("P0 迁移或验证意外修改了 GenerationJob/Publication。");
}

if (compiledMcp.toolCount !== expectedMcpToolCount
  || compiledMcp.capabilities?.server?.toolCount !== expectedMcpToolCount
  || !compiledMcp.capabilities?.commandTypes?.includes("migrate_fusion_storyboard_evidence")
  || !compiledMcp.capabilities?.domains?.fusionProduction?.includes("migrate_fusion_storyboard_evidence")
  || compiledMcp.doctor?.summary?.errors !== 0) {
  throw new Error(`compiled MCP 能力或 Doctor 无效：${JSON.stringify({
    tools: compiledMcp.toolCount,
    capabilities: compiledMcp.capabilities?.server,
    doctor: compiledMcp.doctor?.summary,
  })}`);
}
if (compiledMcp.ep001?.item?.fusionStoryboard?.panelCount !== 4
  || compiledMcp.ep001?.reviewRequirement?.id !== ep001RequirementId
  || compiledMcp.ep001?.reviewRequirement?.artifactIds?.length !== 8
  || compiledMcp.ep008InReviewQueue
  || compiledMcp.ep008?.item?.status !== "待尾帧"
  || compiledMcp.ep008?.item?.fusionStoryboard?.panelCount !== 6
  || compiledMcp.ep008?.item?.fusionStoryboard?.completedPanelCount !== 4
  || compiledMcp.ep008?.item?.fusionStoryboard?.visuallyApproved !== false) {
  throw new Error("compiled MCP 没有公开当前全格 requirement 或 EP01_008 失败关闭状态。");
}

if (uiEvidence.kind !== "p0-fusion-panel-review-ui-smoke"
  || uiEvidence.apiState?.unitCount !== 1_288
  || uiEvidence.apiState?.ep001?.panelCount !== 4
  || uiEvidence.apiState?.ep001?.visuallyApproved !== true
  || uiEvidence.apiState?.ep008?.completedPanelCount !== 4
  || uiEvidence.reviewUi?.viewedPanelCount !== 4
  || uiEvidence.reviewUi?.requirementHint !== "视觉通过前必须查看全部 4 格"
  || uiEvidence.reviewUi?.horizontalPageOverflow
  || uiEvidence.sideEffects?.generationJobsUnchanged !== true
  || uiEvidence.sideEffects?.publicationsUnchanged !== true
  || uiEvidence.pageErrors?.length) {
  throw new Error("正式工程 P0 Electron UI 证据无效。");
}
const uiScreenshot = await fileEvidence(uiScreenshotPath);
const uiScreenshotMetadata = await sharp(uiScreenshotPath).metadata();
if (!uiScreenshotMetadata.width || !uiScreenshotMetadata.height || uiScreenshot.bytes < 100_000) {
  throw new Error("P0 UI 截图不可见或体积异常。");
}

if (sheetReceipt.kind !== "fusion-storyboard-sheet-production-receipt"
  || sheetReceipt.itemId !== ep001Id
  || sheetReceipt.contractId !== ep001ContractId
  || sheetReceipt.reviewId !== migratedReviewId
  || sheetReceipt.requirementId !== ep001RequirementId
  || sheetReceipt.panelCount !== 4
  || sheetReceipt.panelImages?.length !== 4
  || sheetReceipt.durationSeconds !== 15
  || sheetReceipt.formalProductionEligible !== true) {
  throw new Error("正式中文四格故事板 receipt 没有绑定当前合同与 Review requirement。");
}
for (const image of sheetReceipt.panelImages as Array<{ path: string; sha256: string }>) {
  if (await sha256File(image.path) !== image.sha256) throw new Error(`成板 panel SHA 漂移：${image.path}`);
}
if (await sha256File(sheetReceipt.png.path) !== sheetReceipt.png.sha256
  || await sha256File(sheetReceipt.svg.path) !== sheetReceipt.svg.sha256) {
  throw new Error("正式中文故事板 PNG/SVG 与 receipt SHA 不一致。");
}

const rawPaths = (await fg("**/*_raw.png", { cwd: projectRoot, absolute: true, onlyFiles: true })).sort();
const labeledPaths = (await fg("**/*_labeled.png", { cwd: projectRoot, absolute: true, onlyFiles: true })).sort();
if (rawPaths.length !== 26 || labeledPaths.length !== 26) throw new Error(`正式 raw/labeled 计数漂移：${rawPaths.length}/${labeledPaths.length}`);
for (const rawPath of rawPaths) {
  const labeledPath = rawPath.replace(/_raw\.png$/u, "_labeled.png");
  await access(labeledPath);
}
const mediaChecks = await Promise.all([...rawPaths, ...labeledPaths].map(async (filePath) => {
  const metadata = await sharp(filePath).metadata();
  const file = await stat(filePath);
  return {
    path: filePath,
    bytes: file.size,
    width: metadata.width,
    height: metadata.height,
    format: metadata.format,
    ok: metadata.format === "png"
      && Boolean(metadata.width && metadata.height && metadata.height > metadata.width)
      && file.size > 100_000,
  };
}));
if (mediaChecks.some((entry) => !entry.ok)) throw new Error("至少一张正式 raw/labeled 机械验收失败。");

const buildArtifacts = await Promise.all([
  fileEvidence(path.join(workspace, "out/main/index.js")),
  fileEvidence(path.join(workspace, "out/preload/index.mjs")),
  fileEvidence(path.join(workspace, "out/renderer/index.html")),
  fileEvidence(path.join(workspace, "dist-mcp/mcp/server.js")),
]);
const sourceAfter = await sourceSnapshot(sourceRoot);
if (JSON.stringify(sourceAfter) !== JSON.stringify(sourceBefore) || sourceAfter.aggregateSha256 !== expectedSourceAggregate) {
  throw new Error("P0 最终验证期间第三季只读源发生漂移。");
}

const report = {
  schemaVersion: 1,
  kind: "p0-fusion-panel-authority-final-validation",
  status: "passed",
  createdAt: new Date().toISOString(),
  workspace,
  projectRoot,
  sourceBoundary: {
    mode: "read-only",
    before: sourceBefore,
    after: sourceAfter,
    unchanged: true,
  },
  p0: {
    scope: "2–6 宫格独立权威资产模型",
    currentSelections: {
      revision: selections.revision,
      ep001: selections.items[ep001Id],
      ep008: selections.items[ep008Id],
    },
    ep001: {
      itemId: ep001Id,
      contractId: ep001ContractId,
      status: ep001.status,
      panelCount: ep001.fusionStoryboard.panelCount,
      completedPanelCount: ep001.fusionStoryboard.completedPanelCount,
      mechanicallyValidPanelCount: ep001.fusionStoryboard.mechanicallyValidPanelCount,
      visuallyApproved: ep001.fusionStoryboard.visuallyApproved,
      authoritativeArtifacts: ep001Artifacts.map((artifact) => ({
        id: artifact.id,
        kind: artifact.kind,
        panel: artifact.fusionStoryboardPanel,
        path: artifact.path,
        sha256: artifact.check.sha256,
      })),
      migratedReview: {
        id: migrated.id,
        migratedFromReviewId: migrated.migratedFromReviewId,
        requirementId: migrated.requirementId,
        artifactCount: migrated.artifactIds.length,
      },
      sheetReceipt: {
        path: sheetReceiptPath,
        reviewId: sheetReceipt.reviewId,
        requirementId: sheetReceipt.requirementId,
        png: sheetReceipt.png,
        svg: sheetReceipt.svg,
      },
    },
    ep008: {
      itemId: ep008Id,
      contractId: ep008ContractId,
      status: ep008.status,
      panelCount: ep008.fusionStoryboard.panelCount,
      completedPanelCount: ep008.fusionStoryboard.completedPanelCount,
      visuallyApproved: ep008.fusionStoryboard.visuallyApproved,
      panelStates: ep008.fusionStoryboard.panels.map((panel) => panel.state),
      completeReviewForbidden: true,
    },
    migrationSafety: {
      backupRoot,
      immutableLegacyReviewPreserved: true,
      generationJobs: jobsEvidence,
      publications: publicationsEvidence,
      generationJobsUnchanged: jobsEvidence.sha256 === backupJobsEvidence.sha256,
      publicationsUnchanged: publicationsEvidence.sha256 === backupPublicationsEvidence.sha256,
      rawImages: rawPaths.length,
      labeledImages: labeledPaths.length,
      mediaChecksPassed: mediaChecks.length,
    },
  },
  tests: {
    typecheck: commandEvidence.typecheck,
    targeted: { ...commandEvidence.targeted, files: 6, tests: 51, status: "passed" },
    full: { ...commandEvidence.full, files: 49, tests: 296, status: "passed" },
  },
  build: {
    status: "passed",
    command: commandEvidence.build,
    artifacts: buildArtifacts,
  },
  mcp: {
    status: "passed",
    transport: "compiled-stdio-read-only-formal-project",
    toolCount: compiledMcp.toolCount,
    migrationCommandAdvertised: true,
    doctor: compiledMcp.doctor.summary,
    ep001RequirementId: compiledMcp.ep001.reviewRequirement.id,
    ep008InReviewQueue: compiledMcp.ep008InReviewQueue,
    ep008Status: compiledMcp.ep008.item.status,
    ep008CompletedPanelCount: compiledMcp.ep008.item.fusionStoryboard.completedPanelCount,
  },
  ui: {
    status: "passed",
    command: commandEvidence.ui,
    evidencePath: uiEvidencePath,
    screenshot: uiScreenshot,
    screenshotSize: {
      width: uiScreenshotMetadata.width,
      height: uiScreenshotMetadata.height,
    },
    panelLabels: uiEvidence.reviewUi.panelLabels,
    allPanelsViewed: true,
    generationJobsUnchanged: true,
    publicationsUnchanged: true,
    pageErrors: [],
  },
  goal: {
    complete: false,
    completedPriority: "P0",
    nextPriority: "P1 可恢复的生图执行状态机",
    productionFreeze: "P0–P4 通过前继续冻结扩大正式生图",
  },
};

await writeJsonAtomicExclusive(evidencePath, report);
process.stdout.write(`${JSON.stringify({
  evidencePath,
  status: report.status,
  p0: {
    ep001: report.p0.ep001,
    ep008: report.p0.ep008,
    migrationSafety: report.p0.migrationSafety,
  },
  tests: {
    targeted: report.tests.targeted.status,
    full: report.tests.full.status,
  },
  mcp: report.mcp,
  ui: report.ui,
  sourceBoundary: report.sourceBoundary,
  goal: report.goal,
}, null, 2)}\n`);
