import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { executeIdempotentCommand, getNovelImportCommandOwnerRoot } from "../src/core/command-bus.js";
import { createAuthorizedNovelImportPreflight } from "../src/core/novel-import.js";
import { NovelRepository } from "../src/core/novel-manuscript.js";
import { runWithOperationContext } from "../src/core/operation-context.js";
import { listRegisteredProjects } from "../src/core/sidecar.js";
import type { NovelCommandRequest } from "../src/core/novel-command-runtime.js";

interface ScaleCase {
  label: "chapters-500" | "chapters-1000";
  chapterCount: number;
  charactersPerChapter: number;
  anchorChapter: number;
  anchor: string;
}

const CASES: ScaleCase[] = [
  {
    label: "chapters-500",
    chapterCount: 500,
    charactersPerChapter: 2_000,
    anchorChapter: 377,
    anchor: "规模检索锚点五百章唯一证据",
  },
  {
    label: "chapters-1000",
    chapterCount: 1_000,
    charactersPerChapter: 2_000,
    anchorChapter: 811,
    anchor: "规模检索锚点一千章唯一证据",
  },
];

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function percentile95(values: number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(ordered.length * 0.95) - 1)] ?? 0;
}

function percentile50(values: number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(ordered.length * 0.5) - 1)] ?? 0;
}

function buildCorpus(scale: ScaleCase): string {
  const pattern = "雾河风过青铜树，守卷人逐页核对旧案与责任链。";
  const chapters: string[] = [];
  for (let index = 1; index <= scale.chapterCount; index += 1) {
    const heading = `# 第${String(index).padStart(4, "0")}章 规模验收\n\n`;
    const anchor = index === scale.anchorChapter ? `${scale.anchor}。` : "";
    const bodyCharacters = scale.charactersPerChapter - heading.length - anchor.length;
    if (bodyCharacters < 1) throw new Error(`${scale.label} 章节字符预算不足。`);
    const body = pattern.repeat(Math.ceil(bodyCharacters / pattern.length)).slice(0, bodyCharacters);
    chapters.push(`${heading}${anchor}${body}`);
  }
  return chapters.join("\n\n");
}

function chapterIdentityDigest(chapters: Array<{
  chapterId: string;
  volumeId: string;
  order: number;
  revision: number;
  sha256: string;
  byteLength: number;
  charCount: number;
}>): string {
  return sha256(JSON.stringify(chapters.map((chapter) => ({
    chapterId: chapter.chapterId,
    volumeId: chapter.volumeId,
    order: chapter.order,
    revision: chapter.revision,
    sha256: chapter.sha256,
    byteLength: chapter.byteLength,
    charCount: chapter.charCount,
  }))));
}

async function measured<T>(work: () => Promise<T>): Promise<{
  value: T;
  durationMs: number;
  rssBeforeBytes: number;
  rssPeakBytes: number;
  rssAfterBytes: number;
}> {
  const rssBeforeBytes = process.memoryUsage().rss;
  let rssPeakBytes = rssBeforeBytes;
  const sampler = setInterval(() => {
    rssPeakBytes = Math.max(rssPeakBytes, process.memoryUsage().rss);
  }, 10);
  const startedAt = performance.now();
  try {
    const value = await work();
    const rssAfterBytes = process.memoryUsage().rss;
    rssPeakBytes = Math.max(rssPeakBytes, rssAfterBytes);
    return {
      value,
      durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
      rssBeforeBytes,
      rssPeakBytes,
      rssAfterBytes,
    };
  } finally {
    clearInterval(sampler);
  }
}

async function runScaleCase(baseRoot: string, scale: ScaleCase) {
  const sourceRoot = path.join(baseRoot, scale.label, "source");
  const projectsRoot = path.join(baseRoot, scale.label, "projects");
  await Promise.all([mkdir(sourceRoot, { recursive: true }), mkdir(projectsRoot, { recursive: true })]);
  const sourcePath = path.join(sourceRoot, `${scale.label}.md`);
  const corpus = buildCorpus(scale);
  await writeFile(sourcePath, corpus, { encoding: "utf8", flag: "wx", mode: 0o600 });
  const sourceBefore = { byteLength: (await stat(sourcePath)).size, sha256: sha256(await readFile(sourcePath)) };

  const preflight = await measured(() => createAuthorizedNovelImportPreflight(sourcePath));
  if (!preflight.value.authorization || !preflight.value.preflight.eligible) {
    throw new Error(`${scale.label} 导入预检未授权。`);
  }
  if (preflight.value.preflight.summary.chapterCount !== scale.chapterCount) {
    throw new Error(`${scale.label} 预检章节数错误：${preflight.value.preflight.summary.chapterCount}`);
  }
  const request: Extract<NovelCommandRequest, { command: "novel_import_external_snapshot" }> = {
    command: "novel_import_external_snapshot",
    payload: {
      projectsRoot,
      projectName: `派生检索压测-${scale.label}`,
      preflightId: preflight.value.preflight.preflightId,
      preflightFingerprint: preflight.value.preflight.fingerprint,
      sourceTreeAggregateSha256: preflight.value.preflight.sourceTreeAggregateSha256,
      duplicateResolution: "include_all",
      convertToManagedMarkdown: true,
      preflightAuthorization: preflight.value.authorization.authorizationId,
    },
  };
  const imported = await measured(() => executeIdempotentCommand(getNovelImportCommandOwnerRoot(), {
    requestId: `novel-search-benchmark-${scale.label}-${randomUUID()}`,
    idempotencyKey: `novel-search-benchmark-${scale.label}-${preflight.value.preflight.fingerprint.slice(0, 40)}`,
    request,
  }));
  if (imported.value.status !== "succeeded") throw new Error(`${scale.label} 导入失败：${imported.value.status}`);
  const projectId = (imported.value.result as { receipt?: { projectId?: string } }).receipt?.projectId;
  if (!projectId) throw new Error(`${scale.label} 导入结果缺少 projectId。`);
  const registration = (await listRegisteredProjects()).find((entry) => entry.id === projectId);
  if (!registration) throw new Error(`${scale.label} 隔离工程未注册。`);
  const projectRoot = await realpath(registration.primaryRoot);
  const repository = new NovelRepository(projectRoot);
  const snapshotBefore = await repository.snapshot();
  if (snapshotBefore.chapters?.chapters.length !== scale.chapterCount) {
    throw new Error(`${scale.label} 受管章节数错误。`);
  }
  const identityBefore = chapterIdentityDigest(snapshotBefore.chapters.chapters);

  const requestHash = sha256(`${scale.label}:${identityBefore}`);
  const rebuilt = await measured(() => runWithOperationContext({
    requestId: randomUUID(),
    idempotencyKey: randomUUID(),
    requestHash,
    command: "novel_rebuild_search_index",
  }, () => repository.rebuildSearchIndex()));
  if (rebuilt.value.state !== "fresh"
    || rebuilt.value.activeGeneration?.indexedChapterCount !== scale.chapterCount) {
    throw new Error(`${scale.label} 索引 generation 未完整激活。`);
  }

  const indexedSamples: number[] = [];
  const indexedRssPeaks: number[] = [];
  let indexedResult: Awaited<ReturnType<NovelRepository["searchChapters"]>> | undefined;
  for (let iteration = 0; iteration < 7; iteration += 1) {
    const result = await measured(() => repository.searchChapters({
      query: scale.anchor,
      limit: 20,
      maxHitsPerChapter: 5,
    }));
    indexedSamples.push(result.durationMs);
    indexedRssPeaks.push(result.rssPeakBytes);
    indexedResult = result.value;
  }
  if (!indexedResult
    || indexedResult.engine !== "fts5_trigram"
    || indexedResult.scannedChapters !== 1
    || indexedResult.hits.length !== 1
    || !indexedResult.hits[0]?.snippet.includes(scale.anchor)) {
    throw new Error(`${scale.label} 索引查询未唯一命中或退化：${JSON.stringify(indexedResult)}`);
  }
  const linear = await measured(() => repository.searchChapters({ query: "玄星", limit: 20, maxHitsPerChapter: 1 }));
  if (linear.value.engine !== "linear_scan"
    || linear.value.fallbackReason !== "query_too_short"
    || linear.value.scannedChapters !== scale.chapterCount) {
    throw new Error(`${scale.label} 线性基线诊断不符合预期。`);
  }

  const snapshotAfter = await repository.snapshot();
  const identityAfter = chapterIdentityDigest(snapshotAfter.chapters!.chapters);
  const sourceAfter = { byteLength: (await stat(sourcePath)).size, sha256: sha256(await readFile(sourcePath)) };
  if (identityAfter !== identityBefore || JSON.stringify(sourceAfter) !== JSON.stringify(sourceBefore)) {
    throw new Error(`${scale.label} 性能测试改写了来源或受管正文身份。`);
  }
  const database = await stat(path.join(projectRoot, ".aicanvas", "novel", "novel-derived.sqlite"));
  const thresholds = {
    rebuildMs: scale.chapterCount === 500 ? 60_000 : 120_000,
    indexedP95Ms: 2_000,
    linearBaselineMs: 30_000,
  };
  const measurements = {
    preflightMs: preflight.durationMs,
    importMs: imported.durationMs,
    rebuildMs: rebuilt.durationMs,
    indexedQueryMs: indexedSamples,
    indexedP50Ms: percentile50(indexedSamples),
    indexedP95Ms: percentile95(indexedSamples),
    linearBaselineMs: linear.durationMs,
    observedRssBytes: {
      rebuildBefore: rebuilt.rssBeforeBytes,
      rebuildPeak: rebuilt.rssPeakBytes,
      rebuildAfter: rebuilt.rssAfterBytes,
      indexedPeak: Math.max(...indexedRssPeaks),
      linearBefore: linear.rssBeforeBytes,
      linearPeak: linear.rssPeakBytes,
      linearAfter: linear.rssAfterBytes,
    },
  };
  const checks = {
    rebuildWithinBudget: measurements.rebuildMs <= thresholds.rebuildMs,
    indexedP95WithinBudget: measurements.indexedP95Ms <= thresholds.indexedP95Ms,
    linearBaselineWithinBudget: measurements.linearBaselineMs <= thresholds.linearBaselineMs,
    indexedRecallExact: true,
    manuscriptIdentityUnchanged: identityBefore === identityAfter,
    sourceUnchanged: JSON.stringify(sourceBefore) === JSON.stringify(sourceAfter),
  };
  return {
    scale,
    projectId,
    sourceBefore,
    sourceAfter,
    manuscriptIdentityBefore: identityBefore,
    manuscriptIdentityAfter: identityAfter,
    searchDatabaseBytes: database.size,
    index: rebuilt.value,
    indexedQuery: {
      engine: indexedResult.engine,
      indexState: indexedResult.indexState,
      indexedChapters: indexedResult.indexedChapters,
      scannedChapters: indexedResult.scannedChapters,
      hitCount: indexedResult.hits.length,
    },
    linearBaseline: {
      engine: linear.value.engine,
      fallbackReason: linear.value.fallbackReason,
      scannedChapters: linear.value.scannedChapters,
      hitCount: linear.value.hits.length,
    },
    thresholds,
    measurements,
    checks,
    status: Object.values(checks).every(Boolean) ? "PASS" as const : "FAIL" as const,
  };
}

const outputFlagIndex = process.argv.indexOf("--output");
const outputPath = outputFlagIndex >= 0 ? process.argv[outputFlagIndex + 1] : undefined;
if (!outputPath) throw new Error("必须通过 --output 指定全新的性能证据 JSON 路径。");
const resolvedOutput = path.resolve(outputPath);
await mkdir(path.dirname(resolvedOutput), { recursive: true });
await stat(resolvedOutput).then(
  () => { throw new Error(`性能证据已存在，拒绝覆盖：${resolvedOutput}`); },
  () => undefined,
);

const temporaryRoot = await realpath(await mkdtemp(path.join(await realpath(os.tmpdir()), "ai-canvas-novel-search-benchmark-")));
const previousRegistryPath = process.env.AI_CANVAS_REGISTRY_PATH;
process.env.AI_CANVAS_REGISTRY_PATH = path.join(temporaryRoot, "registry", "projects.json");
await mkdir(path.dirname(process.env.AI_CANVAS_REGISTRY_PATH), { recursive: true });
let report: Record<string, unknown>;
try {
  const cases = [];
  for (const scale of CASES) cases.push(await runScaleCase(temporaryRoot, scale));
  report = {
    schemaVersion: 1,
    kind: "novel-derived-search-performance",
    generatedAt: new Date().toISOString(),
    runtime: { node: process.version, platform: process.platform, architecture: process.arch },
    isolation: {
      temporaryRootRemovedAfterRun: true,
      formalNovelTouched: false,
      note: "全部来源、受管工程、registry 与派生数据库均位于独立临时根。",
    },
    cases,
    status: cases.every((entry) => entry.status === "PASS") ? "PASS" : "FAIL",
    limitation: "该结果是本机一次确定性基准，不构成任意硬件、任意文风或未来百万字任务的无限期性能保证。",
  };
  await writeFile(resolvedOutput, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
} finally {
  if (previousRegistryPath === undefined) delete process.env.AI_CANVAS_REGISTRY_PATH;
  else process.env.AI_CANVAS_REGISTRY_PATH = previousRegistryPath;
  await rm(temporaryRoot, { recursive: true, force: true });
}

process.stdout.write(`${JSON.stringify({ output: resolvedOutput, status: report!.status }, null, 2)}\n`);
