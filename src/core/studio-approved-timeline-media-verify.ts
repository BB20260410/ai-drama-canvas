/**
 * T10 批量媒体与参考闭包核验：verifyApprovedTimelineMedia()
 *
 * 批量验 raw/labeled/参考 CAS 文件完整性。
 * - 按 SHA 去重（同一文件只验一次）
 * - 有界并发 4
 * - SHA+mtime+size 已验证缓存（进程内存级，重启失效，不持久化）
 * - 单单元失败不影响其他
 * - 返回失败阶段与耗时
 * - 分级超时（轻量 1–2s、raw 媒体 5s、参考闭包 8–15s）
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { inspectManagedProject } from "./managed-project.js";

export const VERIFY_MEDIA_SCHEMA_VERSION = 1 as const;

/** 有界并发限制。 */
const CONCURRENCY_LIMIT = 4;
/** 分级超时（毫秒）。 */
const TIMEOUT_LIGHTWEIGHT_MS = 2_000;
const TIMEOUT_RAW_MEDIA_MS = 5_000;
const TIMEOUT_REFERENCE_CLOSURE_MS = 12_000;

/** 已验证缓存条目：SHA+mtime+size 三元组命中则跳过重验。 */
interface VerifiedCacheEntry {
  sha256: string;
  mtimeMs: number;
  sizeBytes: number;
  verifiedAt: string;
}

/** 模块级缓存（进程生命周期内复用，重启失效）。 */
const verifiedCache = new Map<string, VerifiedCacheEntry>();

/** 合法 SHA-256（64 位小写十六进制）；占位符/null 等非法值一律跳过，不验、不冒充通过。 */
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

export interface MediaVerificationUnitResult {
  unitId: string;
  /** 该单元需要验证的 SHA 列表。 */
  sha256List: string[];
  /** 验证通过的 SHA。 */
  passed: string[];
  /** 验证失败的条目。 */
  failures: Array<{
    sha256: string;
    stage: "stat" | "read" | "hash-mismatch" | "timeout";
    error: string;
    durationMs: number;
  }>;
  /** 该单元总耗时。 */
  durationMs: number;
}

export interface MediaVerificationResult {
  schemaVersion: typeof VERIFY_MEDIA_SCHEMA_VERSION;
  kind: "studio-approved-timeline-media-verification";
  /** 去重后需验证的总 SHA 数。 */
  totalUniqueSha: number;
  /** 缓存命中数。 */
  cacheHits: number;
  /** 实际验证数。 */
  verified: number;
  /** 通过数。 */
  passed: number;
  /** 失败数。 */
  failed: number;
  /** 逐单元结果。 */
  units: MediaVerificationUnitResult[];
  /** 总耗时。 */
  totalDurationMs: number;
  builtAt: string;
}

/**
 * 验证单个 CAS 对象的完整性。
 * 分级超时：轻量（stat only）/ raw 媒体（read+hash）/ 参考闭包。
 */
async function verifyCasObject(
  casRoot: string,
  sha256: string,
  timeoutMs: number,
): Promise<{ passed: boolean; stage?: string; error?: string; durationMs: number }> {
  const start = Date.now();
  const objectPath = path.join(casRoot, sha256.slice(0, 2), sha256);

  try {
    // 检查缓存
    const cacheKey = objectPath;
    const stat = await lstat(objectPath);
    const cached = verifiedCache.get(cacheKey);
    if (cached
      && cached.sha256 === sha256
      && cached.mtimeMs === stat.mtimeMs
      && cached.sizeBytes === stat.size) {
      return { passed: true, durationMs: Date.now() - start };
    }

    // 流式读取并计算 SHA（带超时）：不整文件进内存；
    // 超时立即销毁流并触发 pipeline 拒绝，确保底层读取真正停止（无后台残留 readFile）。
    const hash = createHash("sha256");
    const stream = createReadStream(objectPath);
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    const sink = new Transform({
      transform(_chunk, _encoding, callback) {
        callback();
      },
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        pipeline(stream, counter, sink),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            const error = new Error(`超时 ${timeoutMs}ms`);
            stream.destroy(error);
            reject(error);
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
      if (!stream.destroyed) stream.destroy();
    }
    const actualSha = hash.digest("hex");
    if (actualSha !== sha256) {
      return {
        passed: false,
        stage: "hash-mismatch",
        error: `SHA 不一致：期望 ${sha256}，实际 ${actualSha}`,
        durationMs: Date.now() - start,
      };
    }

    // 写入缓存
    verifiedCache.set(cacheKey, {
      sha256,
      mtimeMs: stat.mtimeMs,
      sizeBytes: stat.size,
      verifiedAt: new Date().toISOString(),
    });
    return { passed: true, durationMs: Date.now() - start };
  } catch (error) {
    const stage = error instanceof Error && error.message.startsWith("超时")
      ? "timeout"
      : error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT"
        ? "stat"
        : "read";
    return {
      passed: false,
      stage,
      error: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - start,
    };
  }
}

/**
 * 有界并发执行器：最多同时运行 limit 个任务。
 */
async function boundedConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await fn(items[index]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

/**
 * 批量验证时间线投影中所有单元的媒体 CAS 完整性。
 * 输入为 unitId → sha256 列表的映射（由 getApprovedTimelineProjection 结果构建）。
 */
export async function verifyApprovedTimelineMedia(
  projectRoot: string,
  input: {
    /** 每单元需验证的 SHA 列表（raw/labeled/参考）。 */
    unitShaMap: Array<{ unitId: string; sha256List: string[]; tier?: "lightweight" | "raw" | "reference" }>;
  },
): Promise<MediaVerificationResult> {
  const shell = await inspectManagedProject(projectRoot);
  const casRoot = shell.paths.mediaCas;
  const totalStart = Date.now();

  // 1. 按 SHA 去重（全局）
  const uniqueShas = new Map<string, "lightweight" | "raw" | "reference">();
  for (const unit of input.unitShaMap) {
    const tier = unit.tier ?? "raw";
    for (const sha of unit.sha256List) {
      // 投影未解析出正式 SHA 时以 null 表达；占位符/非法值跳过（不参与验证，也不计入通过）
      if (typeof sha !== "string" || !SHA256_HEX_PATTERN.test(sha)) continue;
      if (!uniqueShas.has(sha)) uniqueShas.set(sha, tier);
    }
  }

  // 2. 有界并发验证
  const shaEntries = [...uniqueShas.entries()];
  let cacheHits = 0;
  const verificationResults = new Map<string, { passed: boolean; stage?: string; error?: string; durationMs: number }>();

  await boundedConcurrency(shaEntries, CONCURRENCY_LIMIT, async ([sha, tier]) => {
    const timeoutMs = tier === "lightweight" ? TIMEOUT_LIGHTWEIGHT_MS
      : tier === "reference" ? TIMEOUT_REFERENCE_CLOSURE_MS
        : TIMEOUT_RAW_MEDIA_MS;
    // 检查缓存命中
    const objectPath = path.join(casRoot, sha.slice(0, 2), sha);
    const cached = verifiedCache.get(objectPath);
    if (cached && cached.sha256 === sha) {
      try {
        const stat = await lstat(objectPath);
        if (cached.mtimeMs === stat.mtimeMs && cached.sizeBytes === stat.size) {
          cacheHits++;
          verificationResults.set(sha, { passed: true, durationMs: 0 });
          return;
        }
      } catch { /* 缓存失效，重新验证 */ }
    }
    const result = await verifyCasObject(casRoot, sha, timeoutMs);
    verificationResults.set(sha, result);
  });

  // 3. 组装逐单元结果
  const units: MediaVerificationUnitResult[] = input.unitShaMap.map((unit) => {
    const unitStart = Date.now();
    const passed: string[] = [];
    const failures: MediaVerificationUnitResult["failures"] = [];
    for (const sha of unit.sha256List) {
      // 与去重阶段同口径：非法 SHA（占位符/null）跳过，不进 passed 也不进 failures
      if (typeof sha !== "string" || !SHA256_HEX_PATTERN.test(sha)) continue;
      const result = verificationResults.get(sha);
      if (!result || result.passed) {
        passed.push(sha);
      } else {
        failures.push({
          sha256: sha,
          stage: (result.stage ?? "read") as "stat" | "read" | "hash-mismatch" | "timeout",
          error: result.error ?? "未知错误",
          durationMs: result.durationMs,
        });
      }
    }
    return {
      unitId: unit.unitId,
      sha256List: unit.sha256List,
      passed,
      failures,
      durationMs: Date.now() - unitStart,
    };
  });

  const allResults = [...verificationResults.values()];
  return {
    schemaVersion: VERIFY_MEDIA_SCHEMA_VERSION,
    kind: "studio-approved-timeline-media-verification",
    totalUniqueSha: uniqueShas.size,
    cacheHits,
    verified: uniqueShas.size - cacheHits,
    passed: allResults.filter((r) => r.passed).length,
    failed: allResults.filter((r) => !r.passed).length,
    units,
    totalDurationMs: Date.now() - totalStart,
    builtAt: new Date().toISOString(),
  };
}
