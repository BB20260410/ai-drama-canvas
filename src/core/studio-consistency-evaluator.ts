import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { loadSharpDefault } from "./sharp-lazy.js";

/**
 * P19 一致性辅助门禁 · 机器四态判定器（studio-consistency-evaluator）。
 *
 * 规范：.planning/P19_差距审计与实施规范.md v2.1（三轮预审 PASS）。
 * 边界：
 * - 评分核心为纯函数、确定性、本机计算；不内嵌模型、不下载权重、不依赖外部服务。
 * - 不用一个总分冒充一致性：按资产类目逐项判定，每项输出 一致/需复核/明显漂移/无法检查。
 * - 机器永不自动 PASS：本模块不产生 Review decision，不触达 checkpoint/approvedRawEligible。
 * - 模块持有 per-process LRU 缓存（≤64 键）、并发信号量（≤2）与有界排队（pending ≤8，同 scope 可替换未开始项）。
 */

export const P19_EVALUATOR_VERSION = "p19-evaluator-1.0.0";
export const P19_EVALUATOR_CONFIG = {
  maxInputBytes: 16 * 1024 * 1024,
  maxInputPixels: 4096 * 4096,
  minEdge: 32,
  extremeRatio: 6,
  lruSize: 64,
  concurrency: 2,
  pendingLimit: 8,
  budgetMs: 15_000,
  weights: {
    character: { aHash: 0.3, dHash: 0.4, histogram: 0.15, edge: 0.15 },
    scene: { aHash: 0.2, dHash: 0.2, histogram: 0.45, edge: 0.15 },
    prop: { aHash: 0.25, dHash: 0.35, histogram: 0.15, edge: 0.25 },
    style: { aHash: 0.15, dHash: 0.2, histogram: 0.5, edge: 0.15 },
  },
  thresholds: {
    character: { consistent: 0.16, needsReview: 0.3 },
    scene: { consistent: 0.2, needsReview: 0.36 },
    prop: { consistent: 0.18, needsReview: 0.33 },
    style: { consistent: 0.2, needsReview: 0.36 },
  },
} as const;

export type P19EvaluatorConfig = typeof P19_EVALUATOR_CONFIG;
export type ConsistencyVerdict = "consistent" | "needs-review" | "drifted" | "not-checkable";
export type ConsistencyAssetCategory = "character" | "scene" | "prop" | "style";

const CONFIG_SHA = createHash("sha256").update(JSON.stringify(P19_EVALUATOR_CONFIG)).digest("hex");

const VERDICT_RANK: Record<ConsistencyVerdict, number> = { consistent: 0, "needs-review": 1, "not-checkable": 2, drifted: 3 };

export interface ConsistencyEvaluationReference {
  assetId: string;
  category: ConsistencyAssetCategory;
  /** 动物资产归入 character 权重路径（显式映射，调用方声明）。 */
  isAnimal?: boolean;
  assetVersionId: string;
  /** 现况 primaryAuthority.versionId；与冻结版本不一致 → stale（仍可判定）。 */
  currentPrimaryAuthorityVersionId?: string;
  mediaSha256: string;
  objectPath: string;
  /** 人工结构核对清单（positiveLocks/negativeLocks 文本）；机器不冒充结构判定，逐项"无法检查"。 */
  structuralChecklist?: string[];
}

export interface ConsistencyEvaluationRequest {
  projectRoot: string;
  projectId: string;
  generationRunId: string;
  packFingerprint: string;
  result: { sha256: string; objectPath: string };
  references: ConsistencyEvaluationReference[];
  signal?: AbortSignal;
  now?: () => string;
}

export interface ConsistencyCriterionEvaluation {
  code: string;
  label: string;
  verdict: ConsistencyVerdict;
  /** 综合加权距离（0..1，越小越像）；not-checkable 时缺省。 */
  distance?: number;
  note?: string;
}

export interface ConsistencyAssetEvaluation {
  assetId: string;
  category: ConsistencyAssetCategory;
  isAnimal: boolean;
  verdict: ConsistencyVerdict;
  compositeDistance?: number;
  criteria: ConsistencyCriterionEvaluation[];
  stale: boolean;
  reference: {
    assetVersionId: string;
    currentPrimaryAuthorityVersionId?: string;
    mediaSha256: string;
  };
}

export interface ConsistencyEvaluationEvidence {
  projectId: string;
  generationRunId: string;
  resultSha256: string;
  referenceSha256: string[];
  assetVersionIds: string[];
  packFingerprint: string;
  evaluatorVersion: string;
  configSha: string;
  errorClass?: string;
}

export interface ConsistencyEvaluationResult {
  schemaVersion: 1;
  kind: "studio-consistency-evaluation";
  verdict: ConsistencyVerdict;
  assets: ConsistencyAssetEvaluation[];
  evidence: ConsistencyEvaluationEvidence;
  computedAt: string;
  durationMs: number;
  frameNotes: string[];
  /** 瞬态失败（取消/超时/排队/被替换）为 true；此类结果不缓存，可重试。 */
  transient?: boolean;
}

/* ---------------------------------- 纯函数：像素归一化与信号 ---------------------------------- */

interface NormalizedImage {
  hashGridA: Buffer;
  hashGridD: Buffer;
  toneGrid: Buffer;
  edgeGrid: Buffer;
  frameNote?: string;
}

async function normalizePixels(input: string | Buffer, config: P19EvaluatorConfig): Promise<NormalizedImage> {
  const pipeline = (await loadSharpDefault())(input, { limitInputPixels: config.maxInputPixels, failOn: "error" });
  const metadata = await pipeline.metadata();
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  if (width < config.minEdge || height < config.minEdge) throw new ConsistencyInputError("image-too-small");
  const ratio = Math.max(width, height) / Math.max(1, Math.min(width, height));
  if (ratio > config.extremeRatio) throw new ConsistencyInputError("image-extreme-ratio");
  let frameNote: string | undefined;
  if ((metadata.pages ?? 1) > 1) frameNote = `animated-input-first-of-${metadata.pages}-pages`;

  const base = (await loadSharpDefault())(input, { limitInputPixels: config.maxInputPixels, failOn: "error" })
    .rotate()
    .toColourspace("srgb")
    .flatten({ background: "#808080" });

  const [hashGridA, hashGridD, toneGrid, edgeGrid] = await Promise.all([
    base.clone().resize(16, 16, { fit: "fill" }).greyscale().raw().toBuffer(),
    base.clone().resize(17, 16, { fit: "fill" }).greyscale().raw().toBuffer(),
    base.clone().resize(64, 64, { fit: "fill" }).removeAlpha().raw().toBuffer({ resolveWithObject: true }).then(({ data }) => data),
    base.clone().resize(64, 64, { fit: "fill" }).greyscale().raw().toBuffer(),
  ]);
  return { hashGridA, hashGridD, toneGrid, edgeGrid, ...(frameNote ? { frameNote } : {}) };
}

class ConsistencyInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConsistencyInputError";
  }
}

function hammingDistanceBits(left: Buffer, right: Buffer): number {
  let distance = 0;
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    let bits = (left[index] ?? 0) ^ (right[index] ?? 0);
    while (bits) {
      distance += bits & 1;
      bits >>= 1;
    }
  }
  return distance;
}

function aHash(grid: Buffer): Buffer {
  let sum = 0;
  for (const value of grid) sum += value;
  const mean = sum / grid.length;
  const bits = Buffer.alloc(Math.ceil(grid.length / 8));
  grid.forEach((value, index) => {
    if (value >= mean) bits[index >> 3] = (bits[index] ?? 0) | (1 << (index % 8));
  });
  return bits;
}

function dHash(grid: Buffer): Buffer {
  const bits = Buffer.alloc(Math.ceil((16 * 15) / 8));
  for (let row = 0; row < 16; row += 1) {
    for (let column = 0; column < 15; column += 1) {
      const index = row * 15 + column;
      if ((grid[row * 17 + column] ?? 0) > (grid[row * 17 + column + 1] ?? 0)) bits[index >> 3] = (bits[index] ?? 0) | (1 << (index % 8));
    }
  }
  return bits;
}

function hsvHistogram(grid: Buffer): number[] {
  const bins = new Array<number>(8 * 4 * 4).fill(0);
  for (let offset = 0; offset + 2 < grid.length; offset += 3) {
    const r = (grid[offset] ?? 0) / 255;
    const g = (grid[offset + 1] ?? 0) / 255;
    const b = (grid[offset + 2] ?? 0) / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;
    let hue = 0;
    if (delta > 0) {
      if (max === r) hue = 60 * (((g - b) / delta) % 6);
      else if (max === g) hue = 60 * ((b - r) / delta + 2);
      else hue = 60 * ((r - g) / delta + 4);
    }
    if (hue < 0) hue += 360;
    const saturation = max === 0 ? 0 : delta / max;
    const hueBin = Math.min(7, Math.floor(hue / 45));
    const satBin = Math.min(3, Math.floor(saturation * 4));
    const valBin = Math.min(3, Math.floor(max * 4));
    bins[hueBin * 16 + satBin * 4 + valBin] = (bins[hueBin * 16 + satBin * 4 + valBin] ?? 0) + 1;
  }
  const total = bins.reduce((sum, value) => sum + value, 0) || 1;
  return bins.map((value) => value / total);
}

function chiSquareDistance(left: number[], right: number[]): number {
  let sum = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    if (a + b > 0) sum += ((a - b) * (a - b)) / (a + b);
  }
  return sum / 2;
}

function sobelEdgeMean(grid: Buffer): number {
  const width = 64;
  const height = 64;
  let sum = 0;
  let count = 0;
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const gx =
        -(grid[(y - 1) * width + (x - 1)] ?? 0) - 2 * (grid[y * width + (x - 1)] ?? 0) - (grid[(y + 1) * width + (x - 1)] ?? 0)
        + (grid[(y - 1) * width + (x + 1)] ?? 0) + 2 * (grid[y * width + (x + 1)] ?? 0) + (grid[(y + 1) * width + (x + 1)] ?? 0);
      const gy =
        -(grid[(y - 1) * width + (x - 1)] ?? 0) - 2 * (grid[(y - 1) * width + x] ?? 0) - (grid[(y - 1) * width + (x + 1)] ?? 0)
        + (grid[(y + 1) * width + (x - 1)] ?? 0) + 2 * (grid[(y + 1) * width + x] ?? 0) + (grid[(y + 1) * width + (x + 1)] ?? 0);
      sum += Math.abs(gx) + Math.abs(gy);
      count += 1;
    }
  }
  return count ? sum / count / 1020 : 0;
}

interface ImageSignals {
  aHashBits: Buffer;
  dHashBits: Buffer;
  histogram: number[];
  edgeMean: number;
  frameNote?: string;
}

function extractSignals(normalized: NormalizedImage): ImageSignals {
  return {
    aHashBits: aHash(normalized.hashGridA),
    dHashBits: dHash(normalized.hashGridD),
    histogram: hsvHistogram(normalized.toneGrid),
    edgeMean: sobelEdgeMean(normalized.edgeGrid),
    ...(normalized.frameNote ? { frameNote: normalized.frameNote } : {}),
  };
}

function signalDistances(left: ImageSignals, right: ImageSignals): { aHash: number; dHash: number; histogram: number; edge: number } {
  return {
    aHash: hammingDistanceBits(left.aHashBits, right.aHashBits) / (16 * 16),
    dHash: hammingDistanceBits(left.dHashBits, right.dHashBits) / (16 * 15),
    histogram: chiSquareDistance(left.histogram, right.histogram),
    edge: Math.min(1, Math.abs(left.edgeMean - right.edgeMean) / Math.max(0.05, Math.max(left.edgeMean, right.edgeMean))),
  };
}

function isInsideRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

interface VerifiedFileIdentity {
  canonicalPath: string;
  sizeBytes: number;
}

interface VerifiedEvaluationInputs {
  canonicalProjectRoot: string;
  result?: VerifiedFileIdentity;
  resultError?: string;
  resultErrorTransient?: boolean;
  references: Array<{ identity?: VerifiedFileIdentity; error?: string; errorTransient?: boolean }>;
}

async function readVerifiedImageFile(
  canonicalProjectRoot: string,
  objectPath: string,
  expectedSha256: string,
  includeBytes: boolean,
): Promise<VerifiedFileIdentity & { bytes?: Buffer }> {
  if (!/^[a-f0-9]{64}$/u.test(expectedSha256)) throw new ConsistencyInputError("invalid-sha256");
  const requestedPath = path.resolve(objectPath);
  const pathBefore = await lstat(requestedPath, { bigint: true });
  if (pathBefore.isSymbolicLink()) throw new ConsistencyInputError("symbolic-link-input");
  if (!pathBefore.isFile()) throw new ConsistencyInputError("input-not-regular-file");
  const canonicalPath = await realpath(requestedPath);
  if (!isInsideRoot(canonicalProjectRoot, canonicalPath)) throw new ConsistencyInputError("cross-project-reference");
  const handle = await open(canonicalPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const descriptorBefore = await handle.stat({ bigint: true });
    if (!descriptorBefore.isFile()
      || descriptorBefore.dev !== pathBefore.dev
      || descriptorBefore.ino !== pathBefore.ino) {
      throw new ConsistencyInputError("input-identity-changed");
    }
    if (descriptorBefore.size > BigInt(P19_EVALUATOR_CONFIG.maxInputBytes)) {
      throw new ConsistencyInputError("image-file-too-large");
    }
    const hash = createHash("sha256");
    let sizeBytes = 0;
    let bytes: Buffer | undefined;
    if (includeBytes) {
      bytes = await handle.readFile();
      hash.update(bytes);
      sizeBytes = bytes.byteLength;
    } else {
      for await (const chunk of handle.createReadStream({ autoClose: false })) {
        hash.update(chunk as Buffer);
        sizeBytes += (chunk as Buffer).byteLength;
      }
    }
    const [descriptorAfter, pathAfter] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(requestedPath, { bigint: true }),
    ]);
    if (pathAfter.isSymbolicLink()
      || !pathAfter.isFile()
      || descriptorAfter.dev !== descriptorBefore.dev
      || descriptorAfter.ino !== descriptorBefore.ino
      || descriptorAfter.size !== descriptorBefore.size
      || descriptorAfter.mtimeNs !== descriptorBefore.mtimeNs
      || descriptorAfter.ctimeNs !== descriptorBefore.ctimeNs
      || pathAfter.dev !== descriptorBefore.dev
      || pathAfter.ino !== descriptorBefore.ino
      || pathAfter.size !== descriptorBefore.size
      || sizeBytes !== Number(descriptorBefore.size)) {
      throw new ConsistencyInputError("input-drifted-during-read");
    }
    if (hash.digest("hex") !== expectedSha256) throw new ConsistencyInputError("sha256-mismatch");
    return { canonicalPath, sizeBytes, ...(bytes ? { bytes } : {}) };
  } finally {
    await handle.close();
  }
}

async function verifyEvaluationInputs(request: ConsistencyEvaluationRequest): Promise<VerifiedEvaluationInputs> {
  const requestedRoot = path.resolve(request.projectRoot);
  const rootMetadata = await lstat(requestedRoot);
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new ConsistencyInputError("project-root-not-real-directory");
  }
  const canonicalProjectRoot = await realpath(requestedRoot);
  const verified: VerifiedEvaluationInputs = { canonicalProjectRoot, references: [] };
  try {
    verified.result = await readVerifiedImageFile(canonicalProjectRoot, request.result.objectPath, request.result.sha256, false);
  } catch (error) {
    verified.resultError = errorClassOf(error);
    verified.resultErrorTransient = !(error instanceof ConsistencyInputError);
  }
  for (const reference of request.references) {
    try {
      verified.references.push({
        identity: await readVerifiedImageFile(canonicalProjectRoot, reference.objectPath, reference.mediaSha256, false),
      });
    } catch (error) {
      verified.references.push({
        error: errorClassOf(error),
        errorTransient: !(error instanceof ConsistencyInputError),
      });
    }
  }
  return verified;
}

/* ---------------------------------- 判定 ---------------------------------- */

function weightedDistance(category: ConsistencyAssetCategory, distances: { aHash: number; dHash: number; histogram: number; edge: number }): number {
  const weights = P19_EVALUATOR_CONFIG.weights[category];
  return distances.aHash * weights.aHash + distances.dHash * weights.dHash + distances.histogram * weights.histogram + distances.edge * weights.edge;
}

function distanceVerdict(category: ConsistencyAssetCategory, distance: number): ConsistencyVerdict {
  const thresholds = P19_EVALUATOR_CONFIG.thresholds[category];
  if (distance < thresholds.consistent) return "consistent";
  if (distance < thresholds.needsReview) return "needs-review";
  return "drifted";
}

function worstVerdict(verdicts: ConsistencyVerdict[]): ConsistencyVerdict {
  return verdicts.reduce((worst, verdict) => (VERDICT_RANK[verdict] > VERDICT_RANK[worst] ? verdict : worst), "consistent" as ConsistencyVerdict);
}

function evaluateAsset(resultSignals: ImageSignals, reference: ConsistencyEvaluationReference, referenceSignals: ImageSignals): ConsistencyAssetEvaluation {
  const distances = signalDistances(resultSignals, referenceSignals);
  const compositionDistance = weightedDistance(reference.category, { ...distances, histogram: 0, edge: 0 }) / (1 - P19_EVALUATOR_CONFIG.weights[reference.category].histogram - P19_EVALUATOR_CONFIG.weights[reference.category].edge);
  const toneDistance = distances.histogram;
  const composite = weightedDistance(reference.category, distances);

  const criteria: ConsistencyCriterionEvaluation[] = [
    {
      code: "composition",
      label: "构图与结构",
      verdict: distanceVerdict(reference.category, compositionDistance),
      distance: Math.round(compositionDistance * 1_000_000) / 1_000_000,
    },
    {
      code: "tone-lighting",
      label: "色调与光线",
      verdict: distanceVerdict(reference.category, toneDistance),
      distance: Math.round(toneDistance * 1_000_000) / 1_000_000,
    },
  ];
  if (reference.structuralChecklist?.length) {
    criteria.push({
      code: "structural-locks",
      label: "结构硬锁（人工核对）",
      verdict: "not-checkable",
      note: reference.structuralChecklist.join("；"),
    });
  }

  const checkableVerdicts = criteria.map((criterion) => criterion.verdict).filter((verdict) => verdict !== "not-checkable");
  const stale = Boolean(reference.currentPrimaryAuthorityVersionId && reference.currentPrimaryAuthorityVersionId !== reference.assetVersionId);
  return {
    assetId: reference.assetId,
    category: reference.category,
    isAnimal: reference.isAnimal === true,
    verdict: checkableVerdicts.length ? worstVerdict(checkableVerdicts) : "not-checkable",
    /** 四信号综合加权距离（0..1）；criteria 各自的 distance 与其 verdict 同源（盲审 R1-F1/R2-F4/R4-F4 口径修正）。 */
    compositeDistance: Math.round(composite * 1_000_000) / 1_000_000,
    criteria,
    stale,
    reference: {
      assetVersionId: reference.assetVersionId,
      ...(reference.currentPrimaryAuthorityVersionId ? { currentPrimaryAuthorityVersionId: reference.currentPrimaryAuthorityVersionId } : {}),
      mediaSha256: reference.mediaSha256,
    },
  };
}

function notCheckableAsset(reference: ConsistencyEvaluationReference, note: string): ConsistencyAssetEvaluation {
  const stale = Boolean(reference.currentPrimaryAuthorityVersionId && reference.currentPrimaryAuthorityVersionId !== reference.assetVersionId);
  return {
    assetId: reference.assetId,
    category: reference.category,
    isAnimal: reference.isAnimal === true,
    verdict: "not-checkable",
    criteria: [{ code: "input", label: "输入可检查性", verdict: "not-checkable", note }],
    stale,
    reference: {
      assetVersionId: reference.assetVersionId,
      ...(reference.currentPrimaryAuthorityVersionId ? { currentPrimaryAuthorityVersionId: reference.currentPrimaryAuthorityVersionId } : {}),
      mediaSha256: reference.mediaSha256,
    },
  };
}

/* ---------------------------------- 缓存 / 并发 / 排队 ---------------------------------- */

interface CacheEntry {
  result: ConsistencyEvaluationResult;
  touchedAt: number;
}

const evaluationCache = new Map<string, CacheEntry>();
/** runId → 最近一次非瞬态评估，供对照面 peek；不触发像素。 */
const peekByRunId = new Map<string, ConsistencyEvaluationResult>();
const inflight = new Map<string, Promise<ConsistencyEvaluationResult>>();
let running = 0;
const pendingQueue: Array<{ scope: string; run: () => Promise<void>; cancel: () => void }> = [];

function cacheKeyOf(request: ConsistencyEvaluationRequest, verified?: VerifiedEvaluationInputs): string {
  return createHash("sha256")
    .update(JSON.stringify({
      projectId: request.projectId,
      generationRunId: request.generationRunId,
      resultSha256: request.result.sha256,
      resultObjectPath: verified?.result?.canonicalPath ?? request.result.objectPath,
      resultInputError: verified?.resultError ?? "",
      references: request.references.map((reference, index) => [
        reference.assetId,
        reference.category,
        reference.isAnimal ?? false,
        reference.assetVersionId,
        reference.currentPrimaryAuthorityVersionId ?? "",
        reference.mediaSha256,
        verified?.references[index]?.identity?.canonicalPath ?? reference.objectPath,
        verified?.references[index]?.error ?? "",
        reference.structuralChecklist ?? [],
      ]),
      packFingerprint: request.packFingerprint,
      evaluatorVersion: P19_EVALUATOR_VERSION,
      configSha: CONFIG_SHA,
    }))
    .digest("hex");
}

function cacheGet(key: string): ConsistencyEvaluationResult | undefined {
  const entry = evaluationCache.get(key);
  if (!entry) return undefined;
  entry.touchedAt = Date.now();
  return entry.result;
}

function rememberRunPeek(result: ConsistencyEvaluationResult): void {
  if (result.transient) return;
  peekByRunId.set(result.evidence.generationRunId, result);
}

function cacheSet(key: string, result: ConsistencyEvaluationResult): void {
  evaluationCache.set(key, { result, touchedAt: Date.now() });
  rememberRunPeek(result);
  while (evaluationCache.size > P19_EVALUATOR_CONFIG.lruSize) {
    let oldestKey: string | undefined;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [candidate, entry] of evaluationCache) {
      if (entry.touchedAt < oldestAt) {
        oldestAt = entry.touchedAt;
        oldestKey = candidate;
      }
    }
    if (oldestKey === undefined) return;
    const evicted = evaluationCache.get(oldestKey);
    evaluationCache.delete(oldestKey);
    const runId = evicted?.result.evidence.generationRunId;
    if (runId && peekByRunId.get(runId) === evicted?.result) {
      peekByRunId.delete(runId);
    }
  }
}

/** 只读：按 generationRunId 取已缓存四态。未评估返回 undefined。不验文件、不跑像素。 */
export function peekStudioConsistencyVerdictByRunId(generationRunId: string): ConsistencyVerdict | undefined {
  return peekByRunId.get(generationRunId)?.verdict;
}

/** 把已完成评估编入 runId peek（Review 评估走 cacheSet；测试可直接编入）。不触发像素。 */
export function indexStudioConsistencyPeek(result: ConsistencyEvaluationResult): void {
  rememberRunPeek(result);
}

async function acquireSlot(scope: string, signal?: AbortSignal): Promise<(() => void) | "evicted" | "aborted" | null> {
  if (signal?.aborted) return "aborted";
  if (running < P19_EVALUATOR_CONFIG.concurrency) {
    running += 1;
    return () => {
      running -= 1;
      void pumpQueue();
    };
  }
  for (let index = pendingQueue.length - 1; index >= 0; index -= 1) {
    if (pendingQueue[index]?.scope === scope) {
      const [evicted] = pendingQueue.splice(index, 1);
      evicted?.cancel();
    }
  }
  if (pendingQueue.length >= P19_EVALUATOR_CONFIG.pendingLimit) return null;
  return new Promise<(() => void) | "evicted" | "aborted" | null>((resolve) => {
    const entry: { scope: string; run: () => Promise<void>; cancel: () => void } = {
      scope,
      run: async () => {
        running += 1;
        cleanup();
        resolve(() => {
          running -= 1;
          void pumpQueue();
        });
      },
      cancel: () => {
        cleanup();
        resolve("evicted");
      },
    };
    const onAbort = () => {
      const index = pendingQueue.indexOf(entry);
      if (index >= 0) pendingQueue.splice(index, 1);
      cleanup();
      resolve("aborted");
    };
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    // 排队中也响应取消（盲审 R2-F3）：abort 即出队返回，不等被 pump。
    signal?.addEventListener("abort", onAbort, { once: true });
    pendingQueue.push(entry);
  });
}

async function pumpQueue(): Promise<void> {
  const next = pendingQueue.shift();
  if (next) await next.run();
}

/* ---------------------------------- 主入口 ---------------------------------- */

/** 只读命中检查：计算缓存键并返回缓存结果，不触发任何像素计算（盲审 R1-F2 默认模式缓存感知）。 */
export async function peekStudioConsistencyCache(request: ConsistencyEvaluationRequest): Promise<ConsistencyEvaluationResult | undefined> {
  const verified = await verifyEvaluationInputs(request).catch(() => undefined);
  if (!verified?.result || verified.references.some((reference) => !reference.identity)) return undefined;
  return cacheGet(cacheKeyOf(request, verified));
}

export async function evaluateStudioConsistency(request: ConsistencyEvaluationRequest): Promise<ConsistencyEvaluationResult> {
  const key = cacheKeyOf(request);
  const existing = inflight.get(key);
  if (existing) return existing;
  let resolvedCacheKey = key;

  const scope = `${request.projectRoot}::${request.generationRunId}`;
  let startedAt = Date.now();
  const now = request.now ?? (() => new Date().toISOString());

  const task = (async (): Promise<ConsistencyEvaluationResult> => {
    const slot = await acquireSlot(scope, request.signal);
    if (slot === "aborted") {
      return finalizeResult(request, now, startedAt, {
        verdict: "not-checkable",
        assets: request.references.map((reference) => notCheckableAsset(reference, "评估已取消（可重试）")),
        frameNotes: [],
        transient: true,
      });
    }
    if (slot === null) {
      return finalizeResult(request, now, startedAt, {
        verdict: "not-checkable",
        assets: request.references.map((reference) => notCheckableAsset(reference, "评估排队超限（可重试）")),
        frameNotes: [],
        transient: true,
      });
    }
    if (slot === "evicted") {
      return finalizeResult(request, now, startedAt, {
        verdict: "not-checkable",
        assets: request.references.map((reference) => notCheckableAsset(reference, "评估排队被同范围新请求替换（可重试）")),
        frameNotes: [],
        transient: true,
      });
    }
    const release = slot;
    // 预算钟自槽位获取起算（盲审 R2-F5）：排队等待不计入 15s 计算预算；durationMs 为槽位后的计算时长。
    startedAt = Date.now();
    const abortListener = { aborted: false };
    const onAbort = () => {
      abortListener.aborted = true;
    };
    request.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      if (request.signal?.aborted || abortListener.aborted) {
        return finalizeResult(request, now, startedAt, {
          verdict: "not-checkable",
          assets: request.references.map((reference) => notCheckableAsset(reference, "评估已取消（可重试）")),
          frameNotes: [],
          transient: true,
        });
      }
      const verified = await verifyEvaluationInputs(request);
      resolvedCacheKey = cacheKeyOf(request, verified);
      const cached = cacheGet(resolvedCacheKey);
      if (cached) return cached;
      if (verified.resultError || !verified.result) {
        return finalizeResult(request, now, startedAt, {
          verdict: "not-checkable",
          assets: request.references.map((reference) => notCheckableAsset(reference, `结果图输入未通过身份/SHA 校验：${verified.resultError ?? "unknown"}`)),
          frameNotes: [],
          errorClass: verified.resultError ?? "input-verification-failed",
          ...(verified.resultErrorTransient ? { transient: true } : {}),
        });
      }
      let resultSignals: ImageSignals;
      try {
        const resultFile = await readVerifiedImageFile(verified.canonicalProjectRoot, request.result.objectPath, request.result.sha256, true);
        resultSignals = extractSignals(await normalizePixels(resultFile.bytes!, P19_EVALUATOR_CONFIG));
      } catch (error) {
        // 确定性输入拒绝（图过小/极端比例）可缓存；运行时异常（I/O/解码抖动）标瞬态可重试。
        const deterministic = error instanceof ConsistencyInputError;
        return finalizeResult(request, now, startedAt, {
          verdict: "not-checkable",
          assets: request.references.map((reference) => notCheckableAsset(reference, `结果图不可检查：${errorClassOf(error)}`)),
          frameNotes: [],
          errorClass: errorClassOf(error),
          ...(deterministic ? {} : { transient: true }),
        });
      }
      const frameNotes: string[] = resultSignals.frameNote ? [resultSignals.frameNote] : [];
      const assets: ConsistencyAssetEvaluation[] = [];
      let transient = false;
      for (const [referenceIndex, reference] of request.references.entries()) {
        if (request.signal?.aborted || abortListener.aborted) {
          assets.push(notCheckableAsset(reference, "评估已取消（可重试）"));
          transient = true;
          continue;
        }
        if (Date.now() - startedAt > P19_EVALUATOR_CONFIG.budgetMs) {
          assets.push(notCheckableAsset(reference, "评估超时（可重试）"));
          transient = true;
          continue;
        }
        const verifiedReference = verified.references[referenceIndex];
        if (!verifiedReference?.identity) {
          assets.push(notCheckableAsset(reference, `参考图输入未通过身份/SHA 校验：${verifiedReference?.error ?? "unknown"}`));
          if (verifiedReference?.errorTransient) transient = true;
          continue;
        }
        try {
          const referenceFile = await readVerifiedImageFile(verified.canonicalProjectRoot, reference.objectPath, reference.mediaSha256, true);
          const referenceSignals = extractSignals(await normalizePixels(referenceFile.bytes!, P19_EVALUATOR_CONFIG));
          if (referenceSignals.frameNote && !frameNotes.includes(referenceSignals.frameNote)) frameNotes.push(referenceSignals.frameNote);
          assets.push(evaluateAsset(resultSignals, reference, referenceSignals));
        } catch (error) {
          // 参考图确定性拒绝可随结果缓存；运行时异常则整单标瞬态，恢复后可重试。
          if (!(error instanceof ConsistencyInputError)) transient = true;
          assets.push(notCheckableAsset(reference, `参考图不可检查：${errorClassOf(error)}`));
        }
      }
      const hasNotCheckable = assets.some((asset) => asset.verdict === "not-checkable");
      const checkable = assets.filter((asset) => asset.verdict !== "not-checkable");
      // 聚合语义（盲审 R2-F1）：存在未检查资产时总体封顶 needs-review，不得在部分资产未检查下报"一致"。
      const verdict = assets.length === 0 || checkable.length === 0
        ? "not-checkable"
        : hasNotCheckable
          ? worstVerdict([...checkable.map((asset) => asset.verdict), "needs-review"])
          : worstVerdict(checkable.map((asset) => asset.verdict));
      const referenceInputError = verified.references.find((reference) => reference.error)?.error;
      return finalizeResult(request, now, startedAt, {
        verdict,
        assets,
        frameNotes,
        ...(referenceInputError ? { errorClass: referenceInputError } : {}),
        ...(transient ? { transient: true } : {}),
      });
    } catch (error) {
      // evaluator 自身异常：fail-closed，不误判一致，异常分类计入证据；运行时异常标瞬态不缓存（恢复后可重试）。
      return finalizeResult(request, now, startedAt, {
        verdict: "not-checkable",
        assets: request.references.map((reference) => notCheckableAsset(reference, `评估器异常：${errorClassOf(error)}`)),
        frameNotes: [],
        errorClass: errorClassOf(error),
        transient: true,
      });
    } finally {
      request.signal?.removeEventListener("abort", onAbort);
      release();
    }
  })();

  inflight.set(key, task);
  // 同键 join 方共享创建方的在飞结果（含其取消结局）；join 方自身的 signal 不参与在飞去重。
  // 瞬态结果（取消/超时/排队/被替换）不缓存，join 方与后续调用方都可立即重试（盲审 R2-F2 销记）。
  try {
    const result = await task;
    // 瞬态失败（取消/超时/排队/被替换）不缓存，保证"可重试"语义真实成立。
    if (!result.transient) cacheSet(resolvedCacheKey, result);
    return result;
  } finally {
    inflight.delete(key);
  }
}

function finalizeResult(
  request: ConsistencyEvaluationRequest,
  now: () => string,
  startedAt: number,
  partial: { verdict: ConsistencyVerdict; assets: ConsistencyAssetEvaluation[]; frameNotes: string[]; errorClass?: string; transient?: boolean },
): ConsistencyEvaluationResult {
  return {
    schemaVersion: 1,
    kind: "studio-consistency-evaluation",
    verdict: partial.verdict,
    assets: partial.assets,
    evidence: {
      projectId: request.projectId,
      generationRunId: request.generationRunId,
      resultSha256: request.result.sha256,
      referenceSha256: request.references.map((reference) => reference.mediaSha256),
      assetVersionIds: request.references.map((reference) => reference.assetVersionId),
      packFingerprint: request.packFingerprint,
      evaluatorVersion: P19_EVALUATOR_VERSION,
      configSha: CONFIG_SHA,
      ...(partial.errorClass ? { errorClass: partial.errorClass } : {}),
    },
    computedAt: now(),
    durationMs: Date.now() - startedAt,
    frameNotes: partial.frameNotes,
    ...(partial.transient ? { transient: true } : {}),
  };
}

function errorClassOf(error: unknown): string {
  if (error instanceof ConsistencyInputError) return error.message;
  if (error instanceof Error) return error.name || "Error";
  return "UnknownError";
}

/** 仅供测试：清空 per-process 缓存与排队（不用于产品路径）。 */
export function resetStudioConsistencyEvaluatorForTests(): void {
  evaluationCache.clear();
  inflight.clear();
  pendingQueue.length = 0;
  running = 0;
}
