import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { spawn } from "node:child_process";
import { access, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import fg from "fast-glob";
import sharp from "sharp";
import { getSidecarPaths, readJson, writeJsonAtomicExclusive } from "../src/core/sidecar.js";
import type { GenerationJob, ProjectIndex } from "../src/core/types.js";
import type { PublicationStore } from "../src/core/publication.js";

const workspace = path.resolve(process.argv[2] ?? "/Users/hxx/Documents/无限画布");
const projectRoot = path.resolve(process.argv[3] ?? path.join(workspace, "productions/gushujuan-s3-f1a688020bfb7af6"));
const evidencePath = path.resolve(process.argv[4] ?? path.join(workspace, "docs/evidence/final-validation-20260717-p1-generation-reliability.json"));
const sourceRoot = path.resolve(process.argv[5] ?? "/Users/hxx/Documents/古蜀卷第三季");
const jobId = process.argv[6] ?? "gen-2026-07-16T12-10-57-215Z-892023c0";
const runRoot = path.join(workspace, "docs/evidence/p1-generation-reliability-runs-20260717-01");
const uiEvidencePath = path.join(workspace, "docs/evidence/p1-generation-recovery-ui-final-20260717.json");
const uiScreenshotPath = path.join(workspace, "docs/evidence/p1-generation-recovery-ui-final-20260717.png");
const mcpEvidencePath = path.join(workspace, "docs/evidence/p1-generation-recovery-mcp-final-20260717.json");
const migrationEvidencePath = path.join(workspace, "docs/evidence/p1-generation-execution-migration-20260717.json");
const rehearsalEvidencePath = path.join(workspace, "docs/evidence/p1-generation-execution-migration-rehearsal-20260717.json");
const projectionEvidencePath = path.join(workspace, "docs/evidence/p1-generation-projection-refresh-20260717.json");
const sidecar = getSidecarPaths(projectRoot);
const targetItemId = "season-三-ep01-unit008";

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
  const relativePaths = (await fg("**/*", { cwd: root, onlyFiles: true, followSymbolicLinks: false, dot: true }))
    .sort((left, right) => left.localeCompare(right, "en"));
  const records: Array<{ relativePath: string; bytes: number; mtimeMs: number; sha256: string }> = [];
  for (const relativePath of relativePaths) {
    const absolutePath = path.join(root, ...relativePath.split("/"));
    const metadata = await stat(absolutePath);
    records.push({ relativePath, bytes: metadata.size, mtimeMs: metadata.mtimeMs, sha256: await sha256File(absolutePath) });
  }
  return {
    files: records.length,
    bytes: records.reduce((sum, record) => sum + record.bytes, 0),
    aggregateSha256: sha256(records.map((record) => `${record.relativePath}\0${record.bytes}\0${record.mtimeMs}\0${record.sha256}`).join("\n")),
  };
}

async function sourceDigest(): Promise<{ files: number; sha256: string }> {
  const relativePaths = (await fg([
    "src/**/*",
    "tests/**/*",
    "scripts/**/*",
    "package.json",
    "package-lock.json",
    "tsconfig*.json",
    "electron.vite.config.ts",
    "vitest.config.ts",
  ], { cwd: workspace, onlyFiles: true, followSymbolicLinks: false, dot: true }))
    .sort((left, right) => left.localeCompare(right, "en"));
  const records = [];
  for (const relativePath of relativePaths) {
    records.push(`${relativePath}\0${await sha256File(path.join(workspace, relativePath))}`);
  }
  return { files: relativePaths.length, sha256: sha256(records.join("\n")) };
}

function tail(value: string, limit = 40): string[] {
  return value.split(/\r?\n/u).filter(Boolean).slice(-limit);
}

interface RunEvidence {
  name: string;
  argv: string[];
  cwd: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  exitCode: number;
  stdout: { path: string; bytes: number; sha256: string; tail: string[] };
  stderr: { path: string; bytes: number; sha256: string; tail: string[] };
  testSummary?: { filesPassed: number; testsPassed: number };
}

function testSummary(output: string): { filesPassed: number; testsPassed: number } | undefined {
  const files = output.match(/Test Files\s+(\d+) passed/u);
  const tests = output.match(/Tests\s+(\d+) passed/u);
  return files && tests ? { filesPassed: Number(files[1]), testsPassed: Number(tests[1]) } : undefined;
}

async function runCommand(name: string, command: string, args: string[]): Promise<RunEvidence> {
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  process.stdout.write(`[P1 validate] ${name}\n`);
  const result = await new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, { cwd: workspace, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("close", (code) => resolve({ exitCode: code ?? -1, stdout, stderr }));
  });
  const stdoutPath = path.join(runRoot, `${name}.stdout.log`);
  const stderrPath = path.join(runRoot, `${name}.stderr.log`);
  await Promise.all([
    writeFile(stdoutPath, result.stdout, { encoding: "utf8", flag: "wx" }),
    writeFile(stderrPath, result.stderr, { encoding: "utf8", flag: "wx" }),
  ]);
  const evidence: RunEvidence = {
    name,
    argv: [command, ...args],
    cwd: workspace,
    startedAt,
    endedAt: new Date().toISOString(),
    durationMs: Date.now() - startedMs,
    exitCode: result.exitCode,
    stdout: { path: stdoutPath, bytes: Buffer.byteLength(result.stdout), sha256: sha256(result.stdout), tail: tail(result.stdout) },
    stderr: { path: stderrPath, bytes: Buffer.byteLength(result.stderr), sha256: sha256(result.stderr), tail: tail(result.stderr) },
    testSummary: testSummary(`${result.stdout}\n${result.stderr}`),
  };
  if (result.exitCode !== 0) throw new Error(`${name} 失败：\n${[...evidence.stdout.tail, ...evidence.stderr.tail].join("\n")}`);
  return evidence;
}

async function hashes(files: Record<string, string>): Promise<Record<string, string>> {
  return Object.fromEntries(await Promise.all(Object.entries(files).map(async ([name, filePath]) => [name, await sha256File(filePath)])));
}

if (await access(evidencePath).then(() => true).catch(() => false)) throw new Error(`final-validation 已存在，拒绝覆盖：${evidencePath}`);
if (await access(runRoot).then(() => true).catch(() => false)) throw new Error(`验证运行目录已存在，拒绝覆盖：${runRoot}`);
for (const outputPath of [uiEvidencePath, uiScreenshotPath, mcpEvidencePath]) {
  if (await access(outputPath).then(() => true).catch(() => false)) throw new Error(`最终烟测证据已存在，拒绝覆盖：${outputPath}`);
}
await mkdir(runRoot, { recursive: false });

const guardedFiles = {
  generationJobs: sidecar.generationJobs,
  generationSettings: sidecar.generationSettings,
  publications: sidecar.publications,
  events: sidecar.events,
  index: sidecar.index,
  overrides: sidecar.overrides,
  commandLedger: sidecar.commandLedger,
  subagentPlan: path.join(sidecar.generationRequests, `${jobId}.subagent-imagegen.json`),
};
const guardedBefore = await hashes(guardedFiles);
const sourceBefore = await sourceSnapshot(sourceRoot);
if (sourceBefore.files !== 3_344
  || sourceBefore.bytes !== 24_570_877
  || sourceBefore.aggregateSha256 !== "649160f22663ca4c45ee4a4084e278ef0edc61ec66db01bb84da38cbea3f8d26") {
  throw new Error(`第三季只读源基线漂移：${JSON.stringify(sourceBefore)}`);
}
const codeIdentity = await sourceDigest();

const runs = {
  typecheck: await runCommand("01-typecheck", "npm", ["run", "typecheck"]),
  targeted: await runCommand("02-targeted", "npx", [
    "vitest", "run",
    "tests/publication.test.ts",
    "tests/fusion-production.test.ts",
    "tests/command-bus.test.ts",
    "tests/codex.test.ts",
    "tests/continuation.test.ts",
    "tests/existing-production-recovery.test.ts",
    "tests/mcp.test.ts",
    "tests/fusion-asset-consistency.test.ts",
    "tests/scanner.test.ts",
  ]),
  full: await runCommand("03-full", "npm", ["test"]),
  build: await runCommand("04-build", "npm", ["run", "build"]),
  ui: await runCommand("05-ui", "node", [
    "scripts/ui-p1-generation-recovery-smoke.mjs",
    projectRoot,
    "/tmp/ai-canvas-p1-generation-recovery-ui-final-registry-20260717.json",
    uiEvidencePath,
    uiScreenshotPath,
    jobId,
  ]),
  mcp: await runCommand("06-mcp", "npx", [
    "tsx",
    "scripts/mcp-p1-generation-recovery-smoke.ts",
    workspace,
    projectRoot,
    jobId,
    mcpEvidencePath,
  ]),
};
if (!runs.targeted.testSummary || runs.targeted.testSummary.filesPassed !== 9 || runs.targeted.testSummary.testsPassed < 70) {
  throw new Error(`P1 定向测试数量异常：${JSON.stringify(runs.targeted.testSummary)}`);
}
if (!runs.full.testSummary || runs.full.testSummary.filesPassed < 49 || runs.full.testSummary.testsPassed < 302) {
  throw new Error(`全量测试数量异常：${JSON.stringify(runs.full.testSummary)}`);
}
if (!runs.build.stdout.tail.some((line) => line.includes("built in"))
  || !runs.build.stdout.tail.some((line) => line.includes("build:mcp"))) {
  throw new Error("production build 日志缺少 Electron/Vite 或 MCP 成功证据。");
}

const [
  jobs,
  settings,
  publications,
  index,
  eventsText,
  migrationEvidence,
  rehearsalEvidence,
  projectionEvidence,
  uiEvidence,
  mcpEvidence,
] = await Promise.all([
  readJson<GenerationJob[]>(sidecar.generationJobs, []),
  readJson<any>(sidecar.generationSettings, null),
  readJson<PublicationStore>(sidecar.publications, { schemaVersion: 1, revision: 0, intents: [], receipts: [], updatedAt: new Date(0).toISOString() }),
  readJson<ProjectIndex | null>(sidecar.index, null),
  readFile(sidecar.events, "utf8"),
  readJson<any>(migrationEvidencePath, null),
  readJson<any>(rehearsalEvidencePath, null),
  readJson<any>(projectionEvidencePath, null),
  readJson<any>(uiEvidencePath, null),
  readJson<any>(mcpEvidencePath, null),
]);
if (!settings || !index || !migrationEvidence || !rehearsalEvidence || !projectionEvidence || !uiEvidence || !mcpEvidence) {
  throw new Error("P1 最终验证缺少正式状态或前置证据。");
}

const job = jobs.find((entry) => entry.id === jobId);
if (jobs.length !== 30
  || jobs.filter((entry) => entry.status === "succeeded").length !== 26
  || jobs.filter((entry) => entry.status === "failed").length !== 3
  || !job
  || job.status !== "generation_unknown"
  || job.attempts !== 1
  || job.subagentCheckpoint?.schemaVersion !== 2
  || job.subagentCheckpoint.revision !== 3
  || job.subagentCheckpoint.stage !== "generation_unknown"
  || job.subagentCheckpoint.unknown?.code !== "legacy_leased_without_call_receipt"
  || job.subagentCheckpoint.callIntent
  || job.subagentCheckpoint.output
  || job.subagentCheckpoint.lease?.leaseId !== "subagent-lease-109aae14dd1db8b32dba07be"
  || job.subagentCheckpoint.lease?.owner
  || job.subagentCheckpoint.lease?.leaseUntil
  || job.subagentCheckpoint.lease?.heartbeatAt
  || job.subagentCheckpoint.lease?.fence
  || job.publicationBundleId !== `generation-bundle-${jobId}`
  || job.publicationIntentId !== "publication-472b11c0-0821-4ed1-8051-32d8f046f565"
  || !job.companionPublicationIntentId
  || job.publicationReceiptId
  || job.companionPublicationReceiptId
  || job.resultPath
  || job.companionPath) {
  throw new Error(`正式 P1 Job 合同异常：${JSON.stringify(job)}`);
}
const provider = settings.providers?.find((entry: any) => entry.id === "codex-subagent-gpt-image-2");
if (settings.concurrency !== 1 || provider?.adapter !== "codex-subagent-imagegen" || provider?.enabled !== true || provider?.capabilities?.maxConcurrency !== 1) {
  throw new Error(`正式项目/供应商并发不是严格 1：${JSON.stringify({ concurrency: settings.concurrency, provider })}`);
}

const bundleIntents = publications.intents
  .filter((intent) => intent.bundleId === job.publicationBundleId)
  .sort((left, right) => String(left.bundleMember).localeCompare(String(right.bundleMember)));
if (publications.intents.length !== 31
  || publications.receipts.length !== 26
  || publications.intents.filter((intent) => intent.status === "registered").length !== 26
  || publications.intents.filter((intent) => intent.status === "failed").length !== 3
  || publications.intents.filter((intent) => intent.status === "reserved").length !== 2
  || bundleIntents.length !== 2
  || bundleIntents.some((intent) => intent.status !== "reserved" || intent.receiptId)
  || bundleIntents.map((intent) => intent.bundleMember).join(",") !== "companion,primary") {
  throw new Error(`正式 Publication 账不正确：${JSON.stringify({ intents: publications.intents.length, receipts: publications.receipts.length, bundleIntents })}`);
}

for (const outputPath of [job.expectedOutputPath, job.expectedCompanionPath].filter((value): value is string => Boolean(value))) {
  if (await access(outputPath).then(() => true).catch(() => false)) throw new Error(`unknown Job 正式输出不应存在：${outputPath}`);
}
const candidateRoot = path.join(sidecar.generationDownloads, jobId);
const candidateFiles = await access(candidateRoot).then(() => readdir(candidateRoot), () => []);
if (candidateFiles.length) throw new Error(`unknown Job 隔离目录不应存在候选：${candidateFiles.join("、")}`);

const completedPairs = [];
for (const completed of jobs.filter((entry) => entry.status === "succeeded" && entry.kind === "image")) {
  if (!completed.resultPath || !completed.companionPath) throw new Error(`成功图片任务缺少 raw/labeled：${completed.id}`);
  const [raw, labeled] = await Promise.all([fileEvidence(completed.resultPath), fileEvidence(completed.companionPath)]);
  const [rawMeta, labeledMeta] = await Promise.all([sharp(completed.resultPath).metadata(), sharp(completed.companionPath).metadata()]);
  if (!rawMeta.width || !rawMeta.height || rawMeta.height <= rawMeta.width
    || !labeledMeta.width || !labeledMeta.height || labeledMeta.height <= labeledMeta.width
    || completed.resultSha256 !== raw.sha256) {
    throw new Error(`成功图片任务机械证据漂移：${completed.id}`);
  }
  completedPairs.push({ jobId: completed.id, raw, labeled, dimensions: { raw: [rawMeta.width, rawMeta.height], labeled: [labeledMeta.width, labeledMeta.height] } });
}
if (completedPairs.length !== 26) throw new Error(`成功 raw/labeled 对不是 26：${completedPairs.length}`);

const ep008 = index.items.find((item) => item.id === targetItemId);
if (index.items.filter((item) => item.type === "unit").length !== 1_288
  || ep008?.status !== "待尾帧"
  || ep008.fusionStoryboard?.contractId !== "grid-76e6545a6efec0e4091b"
  || ep008.fusionStoryboard.panelCount !== 6
  || ep008.fusionStoryboard.completedPanelCount !== 4
  || ep008.fusionStoryboard.panels.slice(0, 4).some((panel) => panel.state !== "awaiting_review")
  || ep008.fusionStoryboard.panels[4]?.state !== "generation_unknown"
  || ep008.fusionStoryboard.panels[4].generationStatus !== "generation_unknown"
  || ep008.fusionStoryboard.panels[4].generationJobId !== jobId
  || !ep008.fusionStoryboard.panels[4].issues.some((issue) => issue.includes("禁止重试"))
  || ep008.fusionStoryboard.panels[5]?.state !== "missing") {
  throw new Error(`EP01_008 正式画布投影异常：${JSON.stringify(ep008?.fusionStoryboard)}`);
}

const targetEvents = eventsText.split(/\r?\n/u).filter(Boolean)
  .map((line) => JSON.parse(line) as { type: string; data?: { jobId?: string } })
  .filter((event) => event.data?.jobId === jobId);
const supplierEvents = targetEvents.filter((event) => [
  "generation.subagent-call-intent",
  "generation.subagent-candidate-recorded",
  "generation.subagent-bundle-verified",
  "generation.succeeded",
].includes(event.type));
if (supplierEvents.length
  || !targetEvents.some((event) => event.type === "generation.subagent-execution-migrated-unknown")) {
  throw new Error(`正式迁移出现供应商调用/结果事件或缺迁移事件：${JSON.stringify(targetEvents)}`);
}

if (migrationEvidence.kind !== "p1-generation-execution-migration"
  || rehearsalEvidence.kind !== "p1-generation-execution-migration"
  || Object.values(migrationEvidence.assertions ?? {}).some((value) => value !== true)
  || Object.values(rehearsalEvidence.assertions ?? {}).some((value) => value !== true)
  || projectionEvidence.kind !== "p1-generation-projection-refresh"
  || Object.values(projectionEvidence.assertions ?? {}).some((value) => value !== true)) {
  throw new Error("迁移演练、正式迁移或画布投影刷新证据未全部通过。");
}
if (uiEvidence.kind !== "p1-generation-recovery-ui-smoke"
  || uiEvidence.guardedFiles?.unchanged !== true
  || uiEvidence.rendered?.status !== "调用结果不明"
  || JSON.stringify(uiEvidence.rendered?.actions) !== JSON.stringify(["请求单"])
  || uiEvidence.settingsUi?.providerConcurrency !== "1"
  || uiEvidence.settingsUi?.projectConcurrency !== "1"
  || uiEvidence.pageErrors?.length) {
  throw new Error(`P1 最终 UI 证据无效：${JSON.stringify(uiEvidence)}`);
}
if (mcpEvidence.kind !== "p1-generation-recovery-mcp-smoke"
  || mcpEvidence.guardedFiles?.unchanged !== true
  || mcpEvidence.job?.status !== "generation_unknown"
  || mcpEvidence.doctor?.summary?.errors !== 0
  || mcpEvidence.secretExposure !== false
  || Object.values(mcpEvidence.assertions ?? {}).some((value) => value !== true)) {
  throw new Error(`P1 最终 MCP 证据无效：${JSON.stringify(mcpEvidence)}`);
}

const screenshot = await fileEvidence(uiScreenshotPath);
const screenshotMeta = await sharp(uiScreenshotPath).metadata();
if (screenshot.sha256 !== uiEvidence.screenshot?.sha256
  || !screenshotMeta.width
  || !screenshotMeta.height
  || screenshotMeta.width < 1_500
  || screenshotMeta.height < 900) {
  throw new Error(`P1 UI 截图机械检查失败：${JSON.stringify({ screenshot, screenshotMeta })}`);
}

const buildFiles = (await fg([
  "out/main/index.js",
  "out/preload/index.mjs",
  "out/renderer/index.html",
  "out/renderer/assets/*",
  "dist-mcp/mcp/server.js",
], { cwd: workspace, onlyFiles: true })).sort();
const buildIdentity = {
  source: codeIdentity,
  files: await Promise.all(buildFiles.map((relativePath) => fileEvidence(path.join(workspace, relativePath)))),
};
if (buildIdentity.files.length < 6) throw new Error("production build 产物不完整。");

const guardedAfter = await hashes(guardedFiles);
if (JSON.stringify(guardedAfter) !== JSON.stringify(guardedBefore)) {
  throw new Error(`最终测试/UI/MCP 改写了正式状态：${JSON.stringify({ guardedBefore, guardedAfter })}`);
}
const sourceAfter = await sourceSnapshot(sourceRoot);
if (JSON.stringify(sourceAfter) !== JSON.stringify(sourceBefore)) throw new Error("最终验证期间只读第三季源目录发生变化。");

const gitStatus = await runCommand("07-git-status", "git", ["status", "--short"]);
const finalValidation = {
  schemaVersion: 1,
  kind: "p1-generation-reliability-final-validation",
  status: "passed",
  createdAt: new Date().toISOString(),
  workspace,
  projectRoot,
  scope: "P1 可恢复的生图执行状态机",
  sourceBoundary: { mode: "read-only", before: sourceBefore, after: sourceAfter, unchanged: true },
  formalGuard: { before: guardedBefore, after: guardedAfter, unchanged: true },
  runs: { ...runs, gitStatus },
  buildIdentity,
  migration: {
    rehearsal: await fileEvidence(rehearsalEvidencePath),
    formal: await fileEvidence(migrationEvidencePath),
    projectionRefresh: await fileEvidence(projectionEvidencePath),
    backupRoot: migrationEvidence.backupRoot,
    projectionBackupRoot: projectionEvidence.backupRoot,
    noSupplierCall: migrationEvidence.assertions.noSupplierCall,
  },
  formalState: {
    generationJobs: {
      total: jobs.length,
      byStatus: Object.fromEntries(["succeeded", "failed", "generation_unknown"].map((status) => [status, jobs.filter((entry) => entry.status === status).length])),
    },
    targetJob: {
      id: job.id,
      status: job.status,
      attempts: job.attempts,
      checkpoint: job.subagentCheckpoint,
      publicationBundleId: job.publicationBundleId,
      publicationIntentId: job.publicationIntentId,
      companionPublicationIntentId: job.companionPublicationIntentId,
      expectedOutputPath: job.expectedOutputPath,
      expectedCompanionPath: job.expectedCompanionPath,
      formalOutputsPresent: false,
      isolatedCandidateFiles: candidateFiles,
    },
    publications: {
      intents: publications.intents.length,
      receipts: publications.receipts.length,
      bundleIntents: bundleIntents.map(({ reservationToken: _token, ...intent }) => intent),
    },
    completedImagePairs: completedPairs,
    ep01_008: {
      status: ep008.status,
      contractId: ep008.fusionStoryboard.contractId,
      panelCount: ep008.fusionStoryboard.panelCount,
      completedPanelCount: ep008.fusionStoryboard.completedPanelCount,
      panelStates: ep008.fusionStoryboard.panels.map((panel) => panel.state),
    },
    targetEventTypes: targetEvents.map((event) => event.type),
    supplierCallOrResultEvents: supplierEvents.length,
  },
  ui: { evidence: await fileEvidence(uiEvidencePath), screenshot, dimensions: [screenshotMeta.width, screenshotMeta.height] },
  mcp: { evidence: await fileEvidence(mcpEvidencePath), doctor: mcpEvidence.doctor, assertions: mcpEvidence.assertions },
  acceptance: {
    leaseOwnerHeartbeatTtlFenceAndSafeTakeover: true,
    projectAndProviderSemaphoreOne: true,
    callIntentBeforeModel: true,
    generationUnknownNoReplay: true,
    candidateIsolation: true,
    visualReviewBeforePublication: true,
    rawLabeledAtomicNoClobberBundle: true,
    crashRecoveryAndConflictTests: true,
    legacyJobMigratedWithoutNewAttempt: true,
    currentFormalCanvasProjectionUnknown: true,
    formalJobAndPublicationsTraceable: true,
    uiAndMcpRecoveryRoutesVerified: true,
    sourceUnchanged: true,
    noSupplierCall: true,
    noGitStageCommitPush: true,
  },
  deferredByPlan: {
    productionFreezeStillActive: "P0–P4 未全部通过，继续禁止扩大正式生图。",
    nextPriority: "P2 逐宫格引用闭包",
  },
};
await writeJsonAtomicExclusive(evidencePath, finalValidation);
process.stdout.write(`${JSON.stringify({
  evidencePath,
  status: finalValidation.status,
  tests: { targeted: runs.targeted.testSummary, full: runs.full.testSummary },
  formalState: {
    jobs: finalValidation.formalState.generationJobs,
    targetJob: { id: job.id, status: job.status, attempts: job.attempts },
    publications: { intents: publications.intents.length, receipts: publications.receipts.length },
    ep01_008: finalValidation.formalState.ep01_008,
  },
  ui: finalValidation.ui,
  mcp: { doctor: finalValidation.mcp.doctor.summary, assertions: finalValidation.mcp.assertions },
  sourceBoundary: finalValidation.sourceBoundary,
  nextPriority: finalValidation.deferredByPlan.nextPriority,
}, null, 2)}\n`);
