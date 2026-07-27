/**
 * P9：运行可靠性辅助合同。
 * - 写入口强制 projectId/projectRoot 与固定 provider 上下文
 * - 重复请求 / 修订冲突 / 未知状态 的标准化诊断
 * - 磁盘预检与规模门禁探针（不扫描正式大媒体）
 */
import { createHash } from "node:crypto";
import { freemem, totalmem } from "node:os";
import { statfs } from "node:fs/promises";
import path from "node:path";
import { inspectManagedProject } from "./managed-project.js";
import { getMaterialStudioState } from "./material-studio.js";
import { getStudioProductionState } from "./studio-production.js";
import { getStudioProductionDashboard } from "./studio-production-dashboard.js";

export const STUDIO_RELIABILITY_SCHEMA_VERSION = 1 as const;

export type StudioWriteFaultKind =
  | "duplicate-request"
  | "revision-conflict"
  | "cross-root-denied"
  | "provider-mismatch"
  | "timeout"
  | "cancelled"
  | "sha-drift"
  | "unknown-reconciliation";

export interface StudioWriteContext {
  projectRoot: string;
  projectId: string;
  provider: "agent-imagegen" | "codex-imagegen" | "codex" | "grok" | "fixture" | "none";
  requestId: string;
  idempotencyKey: string;
}

export interface StudioWriteFault {
  kind: StudioWriteFaultKind;
  code: string;
  message: string;
  retryable: boolean;
  requiresHuman: boolean;
}

export interface StudioDiskPreflight {
  schemaVersion: typeof STUDIO_RELIABILITY_SCHEMA_VERSION;
  kind: "studio-disk-preflight";
  projectRoot: string;
  projectId: string;
  filesystem: {
    totalBytes: number;
    freeBytes: number;
    availableBytes: number;
  };
  memory: {
    totalBytes: number;
    freeBytes: number;
  };
  blocked: boolean;
  blockers: string[];
  fingerprint: string;
}

export interface StudioScaleProbe {
  schemaVersion: typeof STUDIO_RELIABILITY_SCHEMA_VERSION;
  kind: "studio-scale-probe";
  projectRoot: string;
  projectId: string;
  counts: {
    units: number;
    canonicalAssets: number;
    media: number;
    assetBindingSets: number;
  };
  dashboard: {
    overviewFingerprint: string;
    unitsPageSize: number;
    unitsHardCap: 36;
  };
  fingerprint: string;
}

export class StudioReliabilityError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "StudioReliabilityError";
    this.code = code;
  }
}

function digest(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize);
    if (input && typeof input === "object") {
      return Object.fromEntries(Object.entries(input as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right, "en"))
        .map(([key, entry]) => [key, normalize(entry)]));
    }
    return input;
  };
  return createHash("sha256").update(JSON.stringify(normalize(value)), "utf8").digest("hex");
}

const MIN_FREE_BYTES = 512 * 1024 * 1024;

export function assertStudioWriteContext(
  expected: { projectRoot: string; projectId: string },
  actual: Partial<StudioWriteContext>,
  options: { allowProvider?: StudioWriteContext["provider"][] } = {},
): StudioWriteFault | null {
  if (!actual.projectRoot || path.resolve(actual.projectRoot) !== path.resolve(expected.projectRoot)) {
    return {
      kind: "cross-root-denied",
      code: "cross-root-denied",
      message: "写操作 projectRoot 与当前受管工程不一致，拒绝隐式跨根写入。",
      retryable: false,
      requiresHuman: true,
    };
  }
  if (!actual.projectId || actual.projectId !== expected.projectId) {
    return {
      kind: "cross-root-denied",
      code: "project-id-mismatch",
      message: "写操作 projectId 与当前工程 ID 不一致。",
      retryable: false,
      requiresHuman: true,
    };
  }
  const allowed = options.allowProvider ?? ["agent-imagegen", "codex-imagegen", "codex", "grok", "fixture", "none"];
  if (actual.provider && !allowed.includes(actual.provider)) {
    return {
      kind: "provider-mismatch",
      code: "provider-mismatch",
      message: `禁止的 provider：${actual.provider}`,
      retryable: false,
      requiresHuman: true,
    };
  }
  if (!actual.requestId?.trim() || !actual.idempotencyKey?.trim()) {
    return {
      kind: "unknown-reconciliation",
      code: "missing-request-identity",
      message: "写操作缺少 requestId 或 idempotencyKey。",
      retryable: false,
      requiresHuman: true,
    };
  }
  return null;
}

export function classifyStudioWriteFault(error: unknown): StudioWriteFault {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLocaleLowerCase("en");
  if (lower.includes("revision") || lower.includes("修订冲突") || lower.includes("cas")) {
    return {
      kind: "revision-conflict",
      code: "revision-conflict",
      message,
      retryable: true,
      requiresHuman: false,
    };
  }
  if (lower.includes("duplicate") || lower.includes("幂等") || lower.includes("already")) {
    return {
      kind: "duplicate-request",
      code: "duplicate-request",
      message,
      retryable: false,
      requiresHuman: false,
    };
  }
  if (lower.includes("cancel") || lower.includes("取消")) {
    return {
      kind: "cancelled",
      code: "cancelled",
      message,
      retryable: false,
      requiresHuman: false,
    };
  }
  if (lower.includes("timeout") || lower.includes("超时")) {
    return {
      kind: "timeout",
      code: "timeout",
      message,
      retryable: true,
      requiresHuman: false,
    };
  }
  if (lower.includes("sha") || lower.includes("漂移") || lower.includes("drift")) {
    return {
      kind: "sha-drift",
      code: "sha-drift",
      message,
      retryable: false,
      requiresHuman: true,
    };
  }
  return {
    kind: "unknown-reconciliation",
    code: "unknown",
    message,
    retryable: false,
    requiresHuman: true,
  };
}

export async function preflightStudioDisk(projectRoot: string): Promise<StudioDiskPreflight> {
  const shell = await inspectManagedProject(projectRoot);
  const stats = await statfs(projectRoot);
  const totalBytes = Number(stats.blocks) * Number(stats.bsize);
  const freeBytes = Number(stats.bfree) * Number(stats.bsize);
  const availableBytes = Number(stats.bavail) * Number(stats.bsize);
  const blockers: string[] = [];
  if (availableBytes < MIN_FREE_BYTES) {
    blockers.push(`可用磁盘低于 ${MIN_FREE_BYTES} 字节，阻断高写入操作。`);
  }
  const body = {
    schemaVersion: STUDIO_RELIABILITY_SCHEMA_VERSION,
    kind: "studio-disk-preflight" as const,
    projectRoot: shell.paths.root,
    projectId: shell.project.id,
    filesystem: { totalBytes, freeBytes, availableBytes },
    memory: { totalBytes: totalmem(), freeBytes: freemem() },
    blocked: blockers.length > 0,
    blockers,
  };
  return { ...body, fingerprint: digest(body) };
}

export async function probeStudioScale(projectRoot: string): Promise<StudioScaleProbe> {
  const shell = await inspectManagedProject(projectRoot);
  const [material, production, overview, units] = await Promise.all([
    getMaterialStudioState(projectRoot),
    getStudioProductionState(projectRoot),
    getStudioProductionDashboard(projectRoot, { operation: "overview" }),
    getStudioProductionDashboard(projectRoot, { operation: "units", limit: 36 }),
  ]);
  if (overview.operation !== "overview" || units.operation !== "units") {
    throw new StudioReliabilityError("dashboard-shape", "Dashboard 投影 operation 不匹配。");
  }
  if (units.page.items.length > 36) {
    throw new StudioReliabilityError("page-cap", "units 页超过硬上限 36。");
  }
  const body = {
    schemaVersion: STUDIO_RELIABILITY_SCHEMA_VERSION,
    kind: "studio-scale-probe" as const,
    projectRoot: shell.paths.root,
    projectId: shell.project.id,
    counts: {
      units: production.counts.units,
      canonicalAssets: material.counts.canonicalAssets,
      media: material.counts.media,
      assetBindingSets: production.counts.assetBindingSets,
    },
    dashboard: {
      overviewFingerprint: overview.fingerprint,
      unitsPageSize: units.page.items.length,
      unitsHardCap: 36 as const,
    },
  };
  return { ...body, fingerprint: digest(body) };
}

/** P9 故障矩阵：给定一组错误样本，返回分类结果用于验收。 */
export function evaluateStudioFaultMatrix(
  samples: Array<{ name: string; error: unknown }>,
): Array<{ name: string; fault: StudioWriteFault }> {
  return samples.map((sample) => ({
    name: sample.name,
    fault: classifyStudioWriteFault(sample.error),
  }));
}
