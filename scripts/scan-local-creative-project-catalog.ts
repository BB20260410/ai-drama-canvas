import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  inspectLocalCreativeProject,
  LOCAL_CREATIVE_SOURCE_LAYER_ROLES,
  type LocalCreativeSourceLayerInput,
} from "../src/core/local-creative-project-ingest.js";

interface CatalogSource {
  root: string;
  role: string;
  label?: string;
  maxDepth?: number;
  excludeRelativePrefixes?: string[];
}

interface CatalogProject {
  key: string;
  name: string;
  projectType: string;
  resolution: "REUSE_READONLY" | "CREATE_MANAGED" | "CREATE_INBOX";
  managedProjectRoot?: string;
  authorityPolicy?: string;
  sources: CatalogSource[];
}

interface CatalogDocument {
  schemaVersion: number;
  projects: CatalogProject[];
}

function compactPreview(preview: Awaited<ReturnType<typeof inspectLocalCreativeProject>>) {
  const warningCounts = Object.fromEntries(
    [...new Set(preview.warnings.map((warning) => warning.code))]
      .sort()
      .map((code) => [code, preview.warnings.filter((warning) => warning.code === code).length]),
  );
  const warningSamples = Object.keys(warningCounts).flatMap((code) => (
    preview.warnings
      .filter((warning) => warning.code === code)
      .slice(0, 10)
      .map((warning) => ({
        code: warning.code,
        path: warning.path,
        message: warning.message,
        ...("ledgerPath" in warning ? { ledgerPath: warning.ledgerPath } : {}),
        ...("basename" in warning ? { basename: warning.basename } : {}),
      }))
  ));
  return {
    schemaVersion: preview.schemaVersion,
    kind: "local-creative-project-ingest-compact-preview",
    project: preview.project,
    sourceLayers: preview.sourceLayers,
    inventoryPolicy: {
      persisted: "summary-only",
      detailRecovery: "rerun inspectLocalCreativeProject for a single project; do not load the full-machine inventory into the UI",
    },
    lockSummary: {
      approved: preview.lockCandidates.filter((candidate) => candidate.status === "APPROVED_LOCK").length,
      candidate: preview.lockCandidates.filter((candidate) => candidate.status === "CANDIDATE_LOCK").length,
      approvedSamples: preview.lockCandidates.filter((candidate) => candidate.status === "APPROVED_LOCK").slice(0, 10),
      candidateSamples: preview.lockCandidates.filter((candidate) => candidate.status === "CANDIDATE_LOCK").slice(0, 10),
    },
    referenceSummary: {
      total: preview.references.length,
      locksWithReferences: preview.lockReferenceIndex.filter((entry) => entry.referencedBy.length > 0).length,
      approvedLockSamples: preview.lockReferenceIndex
        .filter((entry) => entry.status === "APPROVED_LOCK" && entry.referencedBy.length > 0)
        .slice(0, 10),
    },
    warnings: {
      total: preview.warnings.length,
      byCode: warningCounts,
      samples: warningSamples,
      detailPolicy: "counts-and-first-10-per-code; rerun a single project for complete transient evidence",
    },
    statistics: preview.statistics,
    previewFingerprint: preview.previewFingerprint,
    scannedAt: preview.scannedAt,
    readOnly: true,
  };
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function validateCatalog(value: unknown): CatalogDocument {
  if (!value || typeof value !== "object") throw new Error("项目目录不是 JSON 对象。");
  const input = value as Partial<CatalogDocument>;
  if (input.schemaVersion !== 1 || !Array.isArray(input.projects)) throw new Error("项目目录 schemaVersion/projects 无效。");
  const seen = new Set<string>();
  for (const project of input.projects) {
    if (!project.key?.trim() || !project.name?.trim() || !project.projectType?.trim()) throw new Error("项目目录存在缺失 key/name/projectType 的项目。");
    if (seen.has(project.key)) throw new Error(`项目 key 重复：${project.key}`);
    seen.add(project.key);
    if (!["REUSE_READONLY", "CREATE_MANAGED", "CREATE_INBOX"].includes(project.resolution)) {
      throw new Error(`项目 ${project.key} 的 resolution 无效。`);
    }
    if (!Array.isArray(project.sources) || !project.sources.length) throw new Error(`项目 ${project.key} 没有 source。`);
    for (const source of project.sources) {
      if (!source.root?.trim() || !LOCAL_CREATIVE_SOURCE_LAYER_ROLES.includes(source.role as never)) {
        throw new Error(`项目 ${project.key} 的 source root/role 无效。`);
      }
    }
  }
  return input as CatalogDocument;
}

async function writeJsonAtomic(targetPath: string, value: unknown): Promise<void> {
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  const temporaryPath = `${targetPath}.tmp-${process.pid}`;
  await writeFile(temporaryPath, bytes, { flag: "wx" });
  await rename(temporaryPath, targetPath);
}

async function main(): Promise<void> {
  const catalogPath = path.resolve(process.argv[2] ?? ".planning/2026-07-25-local-story-image-project-ingestion/project-catalog.source.json");
  const outputPath = path.resolve(process.argv[3] ?? path.join(path.dirname(catalogPath), "local-creative-project-scan-report.json"));
  const catalog = validateCatalog(JSON.parse(await readFile(catalogPath, "utf8")));
  const results: Array<{
    key: string;
    name: string;
    resolution: CatalogProject["resolution"];
    managedProjectRoot?: string;
    authorityPolicy?: string;
    status: "scanned" | "failed";
    preview?: ReturnType<typeof compactPreview>;
    error?: string;
  }> = [];

  for (const project of catalog.projects) {
    try {
      const sourceLayers: LocalCreativeSourceLayerInput[] = project.sources.map((source) => ({
        role: source.role as LocalCreativeSourceLayerInput["role"],
        rootPath: source.root,
        ...(source.label ? { label: source.label } : {}),
        ...(source.maxDepth !== undefined ? { maxDepth: source.maxDepth } : {}),
        ...(source.excludeRelativePrefixes ? { excludeRelativePrefixes: source.excludeRelativePrefixes } : {}),
      }));
      const fullPreview = await inspectLocalCreativeProject({
        projectKey: project.key,
        projectName: project.name,
        projectType: project.projectType,
        sourceLayers,
        computeSha256: false,
      });
      const preview = compactPreview(fullPreview);
      results.push({
        key: project.key,
        name: project.name,
        resolution: project.resolution,
        ...(project.managedProjectRoot ? { managedProjectRoot: project.managedProjectRoot } : {}),
        ...(project.authorityPolicy ? { authorityPolicy: project.authorityPolicy } : {}),
        status: "scanned",
        preview,
      });
      process.stderr.write(
        `${project.key}\t${preview.statistics.totalFiles}\t${preview.statistics.totalBytes}\t${preview.lockSummary.approved + preview.lockSummary.candidate}\n`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({
        key: project.key,
        name: project.name,
        resolution: project.resolution,
        ...(project.managedProjectRoot ? { managedProjectRoot: project.managedProjectRoot } : {}),
        ...(project.authorityPolicy ? { authorityPolicy: project.authorityPolicy } : {}),
        status: "failed",
        error: message,
      });
      process.stderr.write(`${project.key}\tFAILED\t${message}\n`);
    }
  }

  const totals = results.reduce((summary, result) => {
    if (result.status === "failed" || !result.preview) {
      summary.failedProjects += 1;
      return summary;
    }
    summary.scannedProjects += 1;
    summary.files += result.preview.statistics.totalFiles;
    summary.bytes += result.preview.statistics.totalBytes;
    summary.locks += result.preview.lockSummary.approved;
    summary.candidateLocks += result.preview.lockSummary.candidate;
    return summary;
  }, {
    scannedProjects: 0,
    failedProjects: 0,
    files: 0,
    bytes: 0,
    locks: 0,
    candidateLocks: 0,
  });
  const fingerprintPayload = results.map((result) => (
    result.status === "scanned" && result.preview
      ? { key: result.key, resolution: result.resolution, previewFingerprint: result.preview.previewFingerprint }
      : { key: result.key, resolution: result.resolution, error: result.error }
  ));
  const report = {
    schemaVersion: 1,
    kind: "local-creative-project-catalog-scan-report",
    sourceCatalogPath: catalogPath,
    scannedAt: new Date().toISOString(),
    readOnly: true,
    totals,
    reportFingerprint: `local-creative-catalog-${createHash("sha256").update(stableStringify(fingerprintPayload)).digest("hex")}`,
    projects: results,
  };
  await writeJsonAtomic(outputPath, report);
  process.stdout.write(`${JSON.stringify({ outputPath, totals, reportFingerprint: report.reportFingerprint }, null, 2)}\n`);
  if (totals.failedProjects) process.exitCode = 2;
}

await main();
