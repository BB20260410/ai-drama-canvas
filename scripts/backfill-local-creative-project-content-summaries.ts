import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { backfillLocalCreativeProjectContentSummary } from "../src/core/local-creative-project-content-import.js";
import { writeJsonAtomic } from "../src/core/sidecar.js";

interface MaterializationReport {
  schemaVersion: 1;
  kind: "local-creative-project-materialization-report";
  results: Array<{
    key: string;
    name: string;
    status: "materialized" | "failed";
    resolution?: "REUSE_READONLY" | "CREATE_MANAGED" | "CREATE_INBOX";
    projectRoot?: string;
  }>;
}

export async function backfillLocalCreativeProjectContentSummariesFromCatalog(
  materializationReportPath: string,
  outputPath: string,
): Promise<void> {
  const reportPath = path.resolve(materializationReportPath);
  const targetPath = path.resolve(outputPath);
  const report = JSON.parse(await readFile(reportPath, "utf8")) as MaterializationReport;
  if (report.schemaVersion !== 1
    || report.kind !== "local-creative-project-materialization-report"
    || !Array.isArray(report.results)) {
    throw new Error(`本机创作项目 materialization report 无效：${reportPath}`);
  }

  const results: Array<{
    key: string;
    name: string;
    projectRoot?: string;
    status: "backfilled" | "skipped" | "failed";
    summaryPath?: string;
    error?: string;
  }> = [];
  for (const project of report.results) {
    if (project.status !== "materialized"
      || project.resolution === "REUSE_READONLY"
      || !project.projectRoot) {
      results.push({ key: project.key, name: project.name, status: "skipped" });
      continue;
    }
    try {
      const backfilled = await backfillLocalCreativeProjectContentSummary(project.projectRoot);
      results.push({
        key: project.key,
        name: project.name,
        projectRoot: backfilled.projectRoot,
        status: "backfilled",
        summaryPath: backfilled.summaryPath,
      });
    } catch (error) {
      results.push({
        key: project.key,
        name: project.name,
        projectRoot: project.projectRoot,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  await writeJsonAtomic(targetPath, {
    schemaVersion: 1,
    kind: "local-creative-project-content-summary-backfill-report",
    materializationReportPath: reportPath,
    outputPath: targetPath,
    activeProjectPointerTouched: false,
    sourceMediaScannedOrHashed: false,
    summary: {
      selected: report.results.length,
      backfilled: results.filter((result) => result.status === "backfilled").length,
      skipped: results.filter((result) => result.status === "skipped").length,
      failed: results.filter((result) => result.status === "failed").length,
    },
    results,
    completedAt: new Date().toISOString(),
  });
}

async function main(): Promise<void> {
  const reportPath = path.resolve(process.argv[2]
    ?? ".planning/2026-07-25-local-story-image-project-ingestion/local-creative-project-materialization-report.json");
  const outputPath = path.resolve(process.argv[3]
    ?? path.join(path.dirname(reportPath), "local-creative-project-content-summary-backfill-report.json"));
  await backfillLocalCreativeProjectContentSummariesFromCatalog(reportPath, outputPath);
  process.stdout.write(`${outputPath}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
