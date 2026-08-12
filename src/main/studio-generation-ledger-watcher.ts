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
  let closePromise: Promise<void> | null = null;
  let requestEpoch = 0;
  let dirty = false;
  let drainPromise: Promise<void> | null = null;
  let recoveryEpoch: number | null = null;

  const reportError = (error: unknown): void => {
    try {
      input.onError?.(error instanceof Error ? error.message : String(error));
    } catch {
      // 错误上报不得让 watcher 的 drain 留下未处理 rejection。
    }
  };

  const computeAndSend = async (epoch: number): Promise<void> => {
    const projectId = await input.resolveProjectId();
    if (closed || epoch !== requestEpoch || !projectId) return;
    const progress = await buildStudioGenerationPlanProgress(input.projectRoot);
    const reviewProjectionHash = reviewHeadsProjectionHash(input.projectRoot);
    const projectionHash = createHash("sha256")
      .update(`${progress.projectionHash}\u0000${reviewProjectionHash}`, "utf8")
      .digest("hex");
    if (closed || epoch !== requestEpoch || projectionHash === lastHash) return;
    input.send({ projectId, projectionHash });
    lastHash = projectionHash;
  };

  const requestCompute = (): Promise<void> => {
    if (closed) return Promise.resolve();
    requestEpoch += 1;
    dirty = true;
    if (drainPromise) return drainPromise;

    drainPromise = (async () => {
      while (!closed) {
        if (!dirty) {
          // 清理与复查同在 drain 内部，避免 promise 已完成但 finally 尚未执行时丢失新 dirty。
          drainPromise = null;
          if (!closed && dirty) continue;
          return;
        }
        const epoch = requestEpoch;
        dirty = false;
        try {
          await computeAndSend(epoch);
        } catch (error) {
          reportError(error);
          if (!closed && epoch === requestEpoch && recoveryEpoch !== epoch) {
            recoveryEpoch = epoch;
            dirty = true;
          }
        }
      }
      drainPromise = null;
    })();
    return drainPromise;
  };

  const emit = (): void => {
    if (closed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void requestCompute().catch(reportError);
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
    reportError(error);
  });

  return {
    async emitNow(): Promise<void> {
      if (closed) return;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      await requestCompute();
    },
    close(): Promise<void> {
      if (!closePromise) {
        closed = true;
        dirty = false;
        requestEpoch += 1;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        const watcherClose = Promise.resolve().then(() => watcher.close());
        const activeDrain = drainPromise ?? Promise.resolve();
        closePromise = Promise.allSettled([watcherClose, activeDrain]).then((results) => {
          for (const result of results) {
            if (result.status === "rejected") throw result.reason;
          }
        });
      }
      return closePromise;
    },
  };
}
