import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import chokidar, { type FSWatcher } from "chokidar";
import { buildStudioGenerationPlanProgress } from "../core/studio-generation-plan-progress.js";

/**
 * P21 生成计划进度失效信号 watcher（可从 main 与单元测试共用）。
 * 对受管工程 .aicanvas/ 目录 depth 0 常驻监听（ignored 放行根目录自身——
 * chokidar 对根路径同样应用 ignored 谓词，误杀会使 watcher 永不触发）。
 * 事件仅投影：负载 {projectId, projectionHash}，去重防连发。
 */

export interface StudioGenerationLedgerWatcherHandle {
  /** 立即计算投影并按哈希去重后发送（main 本地命令提交成功的快路径）。 */
  emitNow(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Review PASS/REWORK/REJECT 不会改变已经 succeeded 的 plan 节点，因此 watcher
 * 不能只用 plan progress 去重。这里只读当前 Review Heads 的最小身份，不把完整
 * Review 内容广播给 renderer，也不创建或迁移 schema。
 */
function reviewHeadsProjectionHash(projectRoot: string): string {
  const databasePath = path.join(projectRoot, ".aicanvas", "studio-generation-ledger.sqlite");
  if (!existsSync(databasePath)) return "review-heads:none";
  const database = new DatabaseSync(databasePath, { readOnly: true, timeout: 5_000 });
  try {
    const marker = database.prepare(
      "SELECT value FROM studio_generation_ledger_meta WHERE key='p7_review_schema_version'",
    ).get() as { value?: string } | undefined;
    if (!marker) return "review-heads:uninitialized";
    if (marker.value !== "1") throw new Error(`不支持 Review schema ${marker.value ?? "缺失"}。`);
    const heads = database.prepare(`
      SELECT generation_run_id AS generationRunId,
             revision,
             review_id AS reviewId,
             review_fingerprint AS reviewFingerprint
      FROM studio_generation_review_heads
      ORDER BY generation_run_id
    `).all();
    return createHash("sha256").update(JSON.stringify(heads), "utf8").digest("hex");
  } finally {
    database.close();
  }
}

export function createStudioGenerationLedgerWatcher(input: {
  projectRoot: string;
  resolveProjectId: () => Promise<string | null>;
  send: (payload: { projectId: string; projectionHash: string }) => void;
  onError?: (message: string) => void;
  debounceMs?: number;
}): StudioGenerationLedgerWatcherHandle {
  const aicanvasDir = path.join(input.projectRoot, ".aicanvas");
  let lastHash: string | undefined;
  let timer: NodeJS.Timeout | null = null;
  let closed = false;
  let computeSequence = 0;
  let computeChain: Promise<void> = Promise.resolve();

  const computeAndSend = async (): Promise<void> => {
    const sequence = ++computeSequence;
    const projectId = await input.resolveProjectId();
    if (closed || sequence !== computeSequence || !projectId) return;
    const progress = await buildStudioGenerationPlanProgress(input.projectRoot);
    const reviewProjectionHash = reviewHeadsProjectionHash(input.projectRoot);
    const projectionHash = createHash("sha256")
      .update(`${progress.projectionHash}\u0000${reviewProjectionHash}`, "utf8")
      .digest("hex");
    if (closed || sequence !== computeSequence || projectionHash === lastHash) return;
    lastHash = projectionHash;
    input.send({ projectId, projectionHash });
  };

  const enqueueCompute = (): Promise<void> => {
    const next = computeChain.then(computeAndSend);
    computeChain = next.catch(() => undefined);
    return next;
  };

  const emit = (): void => {
    if (closed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void enqueueCompute().catch((error: unknown) => {
        input.onError?.(error instanceof Error ? error.message : String(error));
      });
    }, input.debounceMs ?? 250);
  };

  const watcher: FSWatcher = chokidar.watch(aicanvasDir, {
    ignoreInitial: true,
    persistent: true,
    depth: 0,
    awaitWriteFinish: { stabilityThreshold: 120, pollInterval: 80 },
    ignored: (candidate) => candidate !== aicanvasDir
      && !/studio-generation-ledger\.sqlite(-wal|-shm)?$/u.test(candidate.replaceAll("\\", "/")),
  });
  watcher.on("add", emit).on("change", emit).on("unlink", emit);
  watcher.on("error", (error) => {
    input.onError?.(error instanceof Error ? error.message : String(error));
  });

  return {
    async emitNow(): Promise<void> {
      if (closed) return;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      await enqueueCompute();
    },
    async close(): Promise<void> {
      closed = true;
      computeSequence += 1;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      await watcher.close();
    },
  };
}
