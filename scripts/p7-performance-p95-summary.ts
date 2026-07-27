/**
 * 汇总同一 packaged 构建的 P7 冷启动样本。
 *
 * 用法：
 *   npx tsx scripts/p7-performance-p95-summary.ts \
 *     --input=/abs/run-1.json --input=/abs/run-2.json ... \
 *     --report=/abs/p7-packaged-p95.json
 *
 * 统计使用 R/NumPy 默认的 Type 7 线性插值。单次越界不会被隐藏：
 * p95 结论与 individualFailures 同时落盘。
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

interface ScaleReport {
  status: "PASS" | "FAIL";
  ok: boolean;
  mode: "dev" | "build" | "packaged";
  budgetProfile: "t23-compat" | "p7-strict";
  performance?: {
    measurements: Record<string, number>;
    checks: Array<{ id: string; status: "PASS" | "FAIL"; actual: number }>;
  };
  ui?: {
    projectedUnitNodeCount: number;
    decodedRawThumbnailCount: number;
    decodedReferenceThumbnailCount: number;
    buildIdentityText: string;
    rendererProbe: {
      passRawCount: number;
      uniqueRawShaCount: number;
      uniqueReferenceShaCount: number;
    };
  };
  ipcProbe?: {
    peakOutstanding: number;
    currentOutstanding: number;
  };
  ipcDrain?: {
    durationMs: number;
    currentOutstanding: number;
    status: "PASS" | "FAIL";
  };
  consoleErrors: string[];
  pageErrors: string[];
  error?: string;
}

interface MetricSpec {
  key: string;
  budget: number;
}

const METRICS: MetricSpec[] = [
  { key: "devToolchainToCdpReadyMs", budget: 1_000 },
  { key: "rendererFirstCardMs", budget: 1_500 },
  { key: "rendererFirstRawMs", budget: 5_000 },
  { key: "rendererAllPassReferencesMs", budget: 8_000 },
  { key: "peakOutstandingProjectionIpc", budget: 4 },
];

function absoluteValues(name: string): string[] {
  return process.argv
    .filter((argument) => argument.startsWith(`--${name}=`))
    .map((argument) => argument.slice(`--${name}=`.length).trim())
    .map((value) => {
      if (!value || !path.isAbsolute(value)) {
        throw new Error(`--${name} 必须使用绝对路径。`);
      }
      return path.resolve(value);
    });
}

function percentileType7(values: readonly number[], percentile: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  if (sorted.length === 1) return sorted[0]!;
  const rank = (sorted.length - 1) * percentile;
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  const weight = rank - lower;
  return (sorted[lower] ?? 0) * (1 - weight) + (sorted[upper] ?? 0) * weight;
}

function rounded(value: number): number {
  return Math.round(value * 100) / 100;
}

async function main(): Promise<void> {
  const inputPaths = absoluteValues("input");
  const [reportPath] = absoluteValues("report");
  if (inputPaths.length < 5) throw new Error("P7 p95 至少需要 5 个独立样本。");
  if (new Set(inputPaths).size !== inputPaths.length) throw new Error("P7 p95 输入样本路径重复。");
  if (!reportPath) throw new Error("缺少 --report=<绝对路径>。");

  const samples = await Promise.all(inputPaths.map(async (inputPath) => {
    const bytes = await readFile(inputPath);
    const report = JSON.parse(bytes.toString("utf8")) as ScaleReport;
    if (report.mode !== "packaged" || report.budgetProfile !== "p7-strict") {
      throw new Error(`样本不是 packaged/p7-strict：${inputPath}`);
    }
    if (!report.performance || !report.ui || !report.ipcProbe || !report.ipcDrain) {
      throw new Error(`样本缺少 P7 机械证据：${inputPath}`);
    }
    const integrityFailures: string[] = [];
    if (report.performance.measurements.fixtureUnitCount !== 36) integrityFailures.push("fixture-unit-count");
    if (report.ui.projectedUnitNodeCount !== 36) integrityFailures.push("projected-unit-count");
    if (report.ui.rendererProbe.passRawCount !== 4) integrityFailures.push("pass-raw-count");
    if (report.ui.rendererProbe.uniqueRawShaCount !== 4) integrityFailures.push("unique-raw-sha");
    if (report.ui.rendererProbe.uniqueReferenceShaCount !== 4) integrityFailures.push("unique-reference-sha");
    if (report.ui.decodedRawThumbnailCount !== 4) integrityFailures.push("decoded-raw");
    if (report.ui.decodedReferenceThumbnailCount < 4) integrityFailures.push("decoded-reference");
    if (report.ipcProbe.currentOutstanding !== 0) integrityFailures.push("ipc-outstanding");
    if (report.ipcDrain.status !== "PASS" || report.ipcDrain.currentOutstanding !== 0) {
      integrityFailures.push("ipc-drain");
    }
    if (report.consoleErrors.length) integrityFailures.push("console-errors");
    if (report.pageErrors.length) integrityFailures.push("page-errors");
    return {
      inputPath,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      report,
      integrityFailures,
    };
  }));

  const buildIdentities = [...new Set(samples.map((sample) => sample.report.ui!.buildIdentityText))];
  const metricSummaries = Object.fromEntries(METRICS.map(({ key, budget }) => {
    const values = samples.map((sample) => sample.report.performance!.measurements[key] ?? Number.NaN);
    if (values.some((value) => !Number.isFinite(value))) {
      throw new Error(`样本缺少性能字段：${key}`);
    }
    const p95 = rounded(percentileType7(values, 0.95));
    return [key, {
      samples: values,
      sorted: [...values].sort((left, right) => left - right),
      p50: rounded(percentileType7(values, 0.5)),
      p95,
      max: Math.max(...values),
      budget,
      status: p95 <= budget ? "PASS" : "FAIL",
    }];
  }));
  const individualFailures = samples.flatMap((sample) => {
    const failedChecks = sample.report.performance!.checks
      .filter((check) => check.status === "FAIL")
      .map((check) => check.id);
    return sample.report.status === "FAIL" || sample.integrityFailures.length
      ? [{
        inputPath: sample.inputPath,
        status: sample.report.status,
        failedChecks,
        integrityFailures: sample.integrityFailures,
        ...(sample.report.error ? { error: sample.report.error } : {}),
      }]
      : [];
  });
  const p95Status = Object.values(metricSummaries)
    .every((summary) => summary.status === "PASS")
    ? "PASS"
    : "FAIL";
  const integrityStatus = buildIdentities.length === 1
    && samples.every((sample) => sample.integrityFailures.length === 0)
    ? "PASS"
    : "FAIL";
  const report = {
    schemaVersion: 1,
    kind: "p7-packaged-performance-p95",
    status: p95Status === "PASS" && integrityStatus === "PASS" ? "PASS" : "FAIL",
    createdAt: new Date().toISOString(),
    sampleCount: samples.length,
    percentileMethod: "Type 7 linear interpolation",
    p95Status,
    integrityStatus,
    buildIdentities,
    metrics: metricSummaries,
    individualFailures,
    samples: samples.map((sample) => ({
      inputPath: sample.inputPath,
      sha256: sample.sha256,
      status: sample.report.status,
      createdAt: (sample.report as unknown as { createdAt?: string }).createdAt,
    })),
    note: "p95 结论不隐藏单次越界；individualFailures 保留所有单次 FAIL 与机械完整性失败。",
  };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  process.stdout.write(`${JSON.stringify({
    status: report.status,
    reportPath,
    sampleCount: report.sampleCount,
    p95Status,
    integrityStatus,
    individualFailureCount: individualFailures.length,
  }, null, 2)}\n`);
  if (report.status !== "PASS") process.exitCode = 1;
}

void main();
