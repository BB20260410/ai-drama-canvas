import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  materializeLocalCreativeProject,
  type LocalCreativeJsonValue,
  type LocalCreativeProjectDescriptor,
} from "../src/core/local-creative-project-materializer.js";

interface CatalogProject extends LocalCreativeProjectDescriptor {
  managedProjectRoot?: string;
}

interface Catalog {
  schemaVersion: 1;
  projects: CatalogProject[];
}

interface ScanProject {
  key: string;
  status: "scanned" | "failed";
  preview?: {
    statistics: Record<string, LocalCreativeJsonValue>;
    previewFingerprint: string;
    lockSummary: {
      approved: number;
      candidate: number;
    };
    referenceSummary: {
      total: number;
      locksWithReferences: number;
    };
    warnings: {
      total: number;
      byCode: Record<string, number>;
    };
  };
  error?: string;
}

interface ScanReport {
  schemaVersion: 1;
  kind: "local-creative-project-catalog-scan-report";
  reportFingerprint: string;
  projects: ScanProject[];
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function writeJsonAtomic(targetPath: string, value: unknown): Promise<void> {
  const temporaryPath = `${targetPath}.tmp-${process.pid}`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  await rename(temporaryPath, targetPath);
}

function scanSummaryFor(project: CatalogProject, scan: ScanProject, reportFingerprint: string): Record<string, LocalCreativeJsonValue> {
  if (scan.status !== "scanned" || !scan.preview) {
    throw new Error(`项目 ${project.key} 缺少成功的只读扫描结果：${scan.error ?? "unknown"}`);
  }
  return {
    catalogReportFingerprint: reportFingerprint,
    previewFingerprint: scan.preview.previewFingerprint,
    statistics: scan.preview.statistics,
    lockEvidence: {
      approved: scan.preview.lockSummary.approved,
      candidate: scan.preview.lockSummary.candidate,
      references: scan.preview.referenceSummary.total,
      locksWithReferences: scan.preview.referenceSummary.locksWithReferences,
    },
    warnings: {
      total: scan.preview.warnings.total,
      byCode: scan.preview.warnings.byCode,
    },
    inventoryPolicy: "summary-in-project; single-project detail is generated on demand",
  };
}

async function main(): Promise<void> {
  const catalogPath = path.resolve(process.argv[2] ?? ".planning/2026-07-25-local-story-image-project-ingestion/project-catalog.source.json");
  const scanPath = path.resolve(process.argv[3] ?? path.join(path.dirname(catalogPath), "local-creative-project-scan-report.json"));
  const outputPath = path.resolve(process.argv[4] ?? path.join(path.dirname(catalogPath), "local-creative-project-materialization-report.json"));
  const projectsRoot = path.resolve(process.argv[5] ?? "projects");
  const catalog = JSON.parse(await readFile(catalogPath, "utf8")) as Catalog;
  const scanReport = JSON.parse(await readFile(scanPath, "utf8")) as ScanReport;
  if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.projects)) throw new Error("catalog 格式无效。");
  if (scanReport.schemaVersion !== 1 || scanReport.kind !== "local-creative-project-catalog-scan-report") throw new Error("scan report 格式无效。");
  const scanByKey = new Map(scanReport.projects.map((project) => [project.key, project]));
  const activePath = path.join(path.dirname(process.env.AI_CANVAS_REGISTRY_PATH ?? path.join(process.env.HOME ?? "", ".aicanvas/projects.json")), "active-project.json");
  const activeBefore = await readFile(activePath).catch(() => null);
  const results: Array<{
    key: string;
    name: string;
    status: "materialized" | "failed";
    resolution: string;
    disposition?: string;
    projectId?: string;
    projectRoot?: string;
    ingestManifestPath?: string | null;
    error?: string;
  }> = [];

  for (const project of catalog.projects) {
    try {
      const scan = scanByKey.get(project.key);
      if (!scan) throw new Error("扫描报告缺少项目。");
      const result = await materializeLocalCreativeProject({
        projectsRoot,
        project: {
          ...project,
          scanSummary: scanSummaryFor(project, scan, scanReport.reportFingerprint),
        },
      });
      results.push({
        key: project.key,
        name: project.name,
        status: "materialized",
        resolution: project.resolution,
        disposition: result.disposition,
        projectId: result.projectId,
        projectRoot: result.projectRoot,
        ingestManifestPath: result.ingestManifestPath,
      });
      process.stderr.write(`${project.key}\t${result.disposition}\t${result.projectRoot}\n`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({
        key: project.key,
        name: project.name,
        status: "failed",
        resolution: project.resolution,
        error: message,
      });
      process.stderr.write(`${project.key}\tFAILED\t${message}\n`);
    }
  }

  const activeAfter = await readFile(activePath).catch(() => null);
  const activePointerUnchanged = activeBefore === null
    ? activeAfter === null
    : activeAfter !== null && activeBefore.equals(activeAfter);
  const summary = {
    total: results.length,
    materialized: results.filter((result) => result.status === "materialized").length,
    failed: results.filter((result) => result.status === "failed").length,
    created: results.filter((result) => result.disposition === "created").length,
    resumed: results.filter((result) => result.disposition === "resumed").length,
    reused: results.filter((result) => result.disposition === "reused").length,
    reusedReadonly: results.filter((result) => result.disposition === "reused-readonly").length,
    activePointerUnchanged,
  };
  const semantic = {
    schemaVersion: 1,
    kind: "local-creative-project-materialization-report",
    catalogPath,
    scanPath,
    scanReportFingerprint: scanReport.reportFingerprint,
    projectsRoot,
    summary,
    results,
  };
  const report = {
    ...semantic,
    materializedAt: new Date().toISOString(),
    fingerprint: sha256(JSON.stringify(semantic)),
  };
  await writeJsonAtomic(outputPath, report);
  process.stdout.write(`${JSON.stringify({ outputPath, summary, fingerprint: report.fingerprint }, null, 2)}\n`);
  if (summary.failed > 0 || !activePointerUnchanged) process.exitCode = 2;
}

await main();
