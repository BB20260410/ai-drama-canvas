/**
 * P9：可审计媒体 GC（默认 dry-run）。
 * 只报告可回收孤儿 CAS 对象；真正删除必须 explicitConfirm=true。
 */
import { createHash } from "node:crypto";
import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { inspectManagedProject } from "./managed-project.js";
import { getMaterialStudioState } from "./material-studio.js";
import { studioSqliteBusyTimeoutMs } from "./studio-sqlite-busy.js";

export const STUDIO_MEDIA_GC_SCHEMA_VERSION = 1 as const;

export interface StudioMediaGcCandidate {
  relativePath: string;
  sizeBytes: number;
  reason: "unreferenced-cas-object";
}

export interface StudioMediaGcReport {
  schemaVersion: typeof STUDIO_MEDIA_GC_SCHEMA_VERSION;
  kind: "studio-media-gc-report";
  projectId: string;
  dryRun: boolean;
  deleted: boolean;
  scannedObjects: number;
  referencedSha256Count: number;
  candidates: StudioMediaGcCandidate[];
  deletedCount: number;
  freedBytes: number;
  fingerprint: string;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function listFilesRecursive(root: string, prefix = ""): Promise<Array<{ relativePath: string; sizeBytes: number }>> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const out: Array<{ relativePath: string; sizeBytes: number }> = [];
  for (const entry of entries) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) {
      out.push(...await listFilesRecursive(absolute, relativePath));
    } else if (entry.isFile()) {
      const metadata = await stat(absolute);
      out.push({ relativePath, sizeBytes: metadata.size });
    }
  }
  return out;
}

function openMaterialDb(databasePath: string): DatabaseSync {
  const busyTimeoutMs = studioSqliteBusyTimeoutMs(5_000);
  const db = new DatabaseSync(databasePath, { timeout: busyTimeoutMs });
  db.exec(`PRAGMA busy_timeout=${busyTimeoutMs};`);
  return db;
}

export async function planStudioMediaGc(projectRoot: string): Promise<StudioMediaGcReport> {
  const shell = await inspectManagedProject(projectRoot);
  const material = await getMaterialStudioState(projectRoot);
  const db = openMaterialDb(material.databasePath);
  let referenced = new Set<string>();
  try {
    const rows = db.prepare("SELECT sha256 FROM studio_media").all() as Array<{ sha256: string }>;
    referenced = new Set(rows.map((row) => row.sha256.toLowerCase()));
  } finally {
    db.close();
  }
  const objects = await listFilesRecursive(material.objectRoot);
  const candidates: StudioMediaGcCandidate[] = [];
  for (const object of objects) {
    const base = path.basename(object.relativePath).replace(/\.[^.]+$/u, "").toLowerCase();
    // CAS 对象名通常包含 sha 前缀；未出现在索引中的视为候选。
    const matched = [...referenced].some((sha) => base.includes(sha.slice(0, 16)) || object.relativePath.includes(sha));
    if (!matched) {
      candidates.push({
        relativePath: object.relativePath,
        sizeBytes: object.sizeBytes,
        reason: "unreferenced-cas-object",
      });
    }
  }
  candidates.sort((left, right) => left.relativePath.localeCompare(right.relativePath, "en"));
  const body = {
    schemaVersion: STUDIO_MEDIA_GC_SCHEMA_VERSION,
    kind: "studio-media-gc-report" as const,
    projectId: shell.project.id,
    dryRun: true,
    deleted: false,
    scannedObjects: objects.length,
    referencedSha256Count: referenced.size,
    candidates: candidates.slice(0, 500),
    deletedCount: 0,
    freedBytes: 0,
  };
  return { ...body, fingerprint: digest(body) };
}

export async function executeStudioMediaGc(
  projectRoot: string,
  input: { expectedFingerprint: string; explicitConfirm: true },
): Promise<StudioMediaGcReport> {
  if (input.explicitConfirm !== true) {
    throw new Error("媒体 GC 必须 explicitConfirm=true。");
  }
  const plan = await planStudioMediaGc(projectRoot);
  if (plan.fingerprint !== input.expectedFingerprint) {
    throw new Error("GC 计划指纹已漂移；请重新 dry-run。");
  }
  const material = await getMaterialStudioState(projectRoot);
  let freedBytes = 0;
  let deletedCount = 0;
  for (const candidate of plan.candidates) {
    const absolute = path.join(material.objectRoot, candidate.relativePath);
    await rm(absolute, { force: true });
    freedBytes += candidate.sizeBytes;
    deletedCount += 1;
  }
  const body = {
    ...plan,
    dryRun: false,
    deleted: true,
    deletedCount,
    freedBytes,
    candidates: plan.candidates,
  };
  return { ...body, fingerprint: digest(body) };
}
