import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import process from "node:process";
import fg from "fast-glob";

type TestPartition = "fast" | "medium" | "integration" | "heavy";

/**
 * 2026-07-26T15:12:00.214Z 的完整 fast JSON reporter 基线中，
 * 单文件耗时严格大于 5 秒的测试。名单必须通过新的基线显式审核更新，
 * 不能在普通测试运行时按机器负载动态漂移。
 */
const MEDIUM_TEST_FILES = [
  "tests/active-managed-studio-context.test.ts",
  "tests/adaptation.test.ts",
  "tests/advanced.test.ts",
  "tests/asset-registry.test.ts",
  "tests/asset-review.test.ts",
  "tests/canonical-assets.test.ts",
  "tests/canvas-state.test.ts",
  "tests/codex.test.ts",
  "tests/comfyui-local.test.ts",
  "tests/command-bus.test.ts",
  "tests/command-ledger-store.test.ts",
  "tests/continuation.test.ts",
  "tests/editor-effect-transition.test.ts",
  "tests/editor-nested-continuation.test.ts",
  "tests/editor-nested.test.ts",
  "tests/editor.test.ts",
  "tests/existing-production-recovery.test.ts",
  "tests/full-workflow.test.ts",
  "tests/fusion-asset-consistency.test.ts",
  "tests/fusion-production.test.ts",
  "tests/fusion-storyboard-sheet.test.ts",
  "tests/fusion-visual-generation.test.ts",
  "tests/goal-managed-studio-loop.test.ts",
  "tests/http-submission-reconciliation.test.ts",
  "tests/immutable-mcp-runtime-candidate.test.ts",
  "tests/local-creative-approved-reference-manifest.test.ts",
  "tests/local-creative-production-unit-preview.test.ts",
  "tests/local-creative-project-content-import.test.ts",
  "tests/local-creative-project-ingest-status.test.ts",
  "tests/local-creative-project-list-summary.test.ts",
  "tests/local-creative-project-materializer.test.ts",
  "tests/locks.test.ts",
  "tests/managed-project.test.ts",
  "tests/material-studio.test.ts",
  "tests/media-runtime.test.ts",
  "tests/novel-analysis-run.test.ts",
  "tests/p14-real-canary-orchestrator.test.ts",
  "tests/production.test.ts",
  "tests/project-backup.test.ts",
  "tests/publication.test.ts",
  "tests/real-imagegen-canary-v2.test.ts",
  "tests/reviews.test.ts",
  "tests/s1e1-readonly-snapshot.test.ts",
  "tests/scanner.test.ts",
  "tests/service.test.ts",
  "tests/sidecar.test.ts",
  "tests/story.test.ts",
  "tests/studio-agent-imagegen-result-bundle.test.ts",
  "tests/studio-binding-atomic-receipts.test.ts",
  "tests/studio-binding-command-bus.test.ts",
  "tests/studio-binding-control.test.ts",
  "tests/studio-canvas-projection-outbox.test.ts",
  "tests/studio-canvas-workflow-runner.test.ts",
  "tests/studio-command-bus.test.ts",
  "tests/studio-confirmed-empty.test.ts",
  "tests/studio-consistency-review-control-consistency.test.ts",
  "tests/studio-continuation-waiver-receipt.test.ts",
  "tests/studio-continuity-command-bus.test.ts",
  "tests/studio-continuity-review-control.test.ts",
  "tests/studio-dashboard-unit-selection.test.ts",
  "tests/studio-episode-unit-grid-rollup.test.ts",
  "tests/studio-generation-active-runs.test.ts",
  "tests/studio-generation-continuity-gate.test.ts",
  "tests/studio-generation-dispatch-gate-matrix.test.ts",
  "tests/studio-generation-ledger-watcher.test.ts",
  "tests/studio-generation-ledger.test.ts",
  "tests/studio-generation-plan-review-rework-retry.test.ts",
  "tests/studio-generation-plan.test.ts",
  "tests/studio-generation-review-annotations.test.ts",
  "tests/studio-generation-review-stale.test.ts",
  "tests/studio-generation-review.test.ts",
  "tests/studio-generation-target-state.test.ts",
  "tests/studio-generation.test.ts",
  "tests/studio-imagegen-active-project-fence.test.ts",
  "tests/studio-imagegen-call-command-bus.test.ts",
  "tests/studio-media-derivatives.test.ts",
  "tests/studio-media-protocol.test.ts",
  "tests/studio-multimedia-timeline.test.ts",
  "tests/studio-panel-source-spans.test.ts",
  "tests/studio-post-result-observation-command-bus.test.ts",
  "tests/studio-production-dashboard.test.ts",
  "tests/studio-production-p20-schema.test.ts",
  "tests/studio-production.test.ts",
  "tests/studio-project-write-lease.test.ts",
  "tests/studio-script-section-command-bus.test.ts",
  "tests/studio-sqlite-busy.test.ts",
  "tests/studio-storyboard-draft.test.ts",
  "tests/studio-trace.test.ts",
  "tests/t24-full-chain-drill.test.ts",
  "tests/timeline.test.ts",
] as const;

const INTEGRATION_PATTERNS = [
  "tests/p30-*.test.ts",
  "tests/mcp-*.test.ts",
  "tests/studio-production-dashboard-scale.test.ts",
  "tests/studio-scale-fixture.test.ts",
  "tests/studio-trace-golden.test.ts",
  "tests/studio-generation-checkpoint.test.ts",
  "tests/studio-imagegen-formal-gate-audit.test.ts",
  "tests/studio-post-result-observation.test.ts",
  "tests/studio-approved-timeline-projection.test.ts",
  "tests/studio-approved-timeline-media-verify.test.ts",
] as const;

const HEAVY_TEST_FILES = [
  "tests/studio-video-package-non-dudu-canary.test.ts",
  "tests/studio-video-package.test.ts",
  "tests/studio-video-package-provider.test.ts",
  "tests/studio-video-package-source-adapter.test.ts",
  "tests/studio-unit-grid-continuation-source.test.ts",
] as const;

function sorted(values: Iterable<string>): string[] {
  return [...values].sort((left, right) => left.localeCompare(right, "en"));
}

function chunked<T>(values: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

async function runVitest(
  root: string,
  vitestEntry: string,
  files: readonly string[],
  passthrough: readonly string[],
  maxWorkersOne: boolean,
): Promise<number> {
  const args = [
    vitestEntry,
    "run",
    ...files,
    ...(maxWorkersOne ? ["--maxWorkers=1"] : []),
    ...passthrough,
  ];
  return new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: root,
      env: process.env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`Vitest 被信号 ${signal} 终止。`));
      } else {
        resolve(code ?? 1);
      }
    });
  });
}

async function resolvePartitions(root: string): Promise<Record<TestPartition, string[]>> {
  const all = sorted(await fg("tests/**/*.test.ts", { cwd: root, onlyFiles: true }));
  const allSet = new Set(all);
  const integration = sorted(await fg([...INTEGRATION_PATTERNS], {
    cwd: root,
    onlyFiles: true,
    unique: true,
  }));
  const heavy = sorted(HEAVY_TEST_FILES.filter((file) => allSet.has(file)));
  const medium = sorted(MEDIUM_TEST_FILES.filter((file) => allSet.has(file)));
  const claimed = new Set([...medium, ...integration, ...heavy]);
  const fast = all.filter((file) => !claimed.has(file));
  return { fast, medium, integration, heavy };
}

function auditPartitions(
  partitions: Record<TestPartition, string[]>,
  allFiles: string[],
): { counts: Record<TestPartition | "all", number>; fingerprint: string } {
  const owners = new Map<string, TestPartition[]>();
  for (const [partition, files] of Object.entries(partitions) as Array<[TestPartition, string[]]>) {
    for (const file of files) {
      const current = owners.get(file) ?? [];
      current.push(partition);
      owners.set(file, current);
    }
  }
  const overlaps = sorted([...owners.entries()]
    .filter(([, partitionOwners]) => partitionOwners.length !== 1)
    .map(([file, partitionOwners]) => `${file}:${partitionOwners.join(",")}`));
  const missing = allFiles.filter((file) => !owners.has(file));
  const staleMedium = MEDIUM_TEST_FILES.filter((file) => !allFiles.includes(file));
  const staleHeavy = HEAVY_TEST_FILES.filter((file) => !allFiles.includes(file));
  if (overlaps.length > 0 || missing.length > 0 || staleMedium.length > 0 || staleHeavy.length > 0) {
    throw new Error(JSON.stringify({
      message: "测试分层未闭合。",
      overlaps,
      missing,
      staleMedium,
      staleHeavy,
    }, null, 2));
  }
  return {
    counts: {
      all: allFiles.length,
      fast: partitions.fast.length,
      medium: partitions.medium.length,
      integration: partitions.integration.length,
      heavy: partitions.heavy.length,
    },
    fingerprint: createHash("sha256")
      .update(JSON.stringify(partitions), "utf8")
      .digest("hex"),
  };
}

async function run(): Promise<void> {
  const root = process.cwd();
  const action = process.argv[2];
  const allFiles = sorted(await fg("tests/**/*.test.ts", { cwd: root, onlyFiles: true }));
  const partitions = await resolvePartitions(root);
  const audit = auditPartitions(partitions, allFiles);
  if (action === "audit") {
    process.stdout.write(`${JSON.stringify({
      schemaVersion: 1,
      kind: "vitest-partition-audit",
      thresholdMilliseconds: 5_000,
      baselineStartedAt: "2026-07-26T15:12:00.214Z",
      ...audit,
    }, null, 2)}\n`);
    return;
  }
  if (action !== "fast" && action !== "medium" && action !== "integration" && action !== "heavy") {
    throw new Error("用法：tsx scripts/run-test-partition.ts <fast|medium|integration|heavy|audit> [vitest 参数]");
  }
  const passthrough = process.argv.slice(3);
  const selectors = passthrough.filter((argument) => (
    !argument.startsWith("-") && argument.includes("tests/") && argument.includes(".test.ts")
  ));
  const selectedByCaller = selectors.length > 0
    ? sorted(await fg(selectors, { cwd: root, onlyFiles: true, unique: true }))
    : [];
  const partitionSet = new Set(partitions[action]);
  const outsidePartition = selectedByCaller.filter((file) => !partitionSet.has(file));
  if (outsidePartition.length > 0) {
    throw new Error(`${action} 层不能运行其他分层的文件：${outsidePartition.join(", ")}`);
  }
  const files = selectors.length > 0 ? selectedByCaller : partitions[action];
  if (files.length === 0) throw new Error(`${action} 测试层为空。`);
  const vitestEntry = path.join(root, "node_modules/vitest/vitest.mjs");
  const childPassthrough = passthrough.filter((argument) => !selectors.includes(argument));
  // 长分区不能把数十个重型 SQLite/媒体夹具压进同一个 Vitest 主进程：
  // 即使 worker 隔离，主进程与工具链状态长时间累计后也会放大延迟，让首个
  // 超时异步任务污染同文件后续用例。批次仍严格串行，只在边界重启 Vitest。
  const batchSize = action === "medium"
    ? 10
    : action === "integration"
      ? 8
      : action === "heavy"
        ? 1
        : files.length;
  const batches = chunked(files, batchSize);
  const batchResults: Array<{
    batch: number;
    fileCount: number;
    firstFile: string;
    lastFile: string;
    exitCode: number;
  }> = [];
  for (const [index, batch] of batches.entries()) {
    process.stdout.write(`[${action}] batch ${index + 1}/${batches.length} · ${batch.length} files\n`);
    const exitCode = await runVitest(
      root,
      vitestEntry,
      batch,
      childPassthrough,
      action !== "fast",
    );
    batchResults.push({
      batch: index + 1,
      fileCount: batch.length,
      firstFile: batch[0]!,
      lastFile: batch.at(-1)!,
      exitCode,
    });
  }
  const failedBatches = batchResults.filter((result) => result.exitCode !== 0);
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    kind: "vitest-partition-run",
    partition: action,
    fileCount: files.length,
    batchSize,
    batchCount: batches.length,
    status: failedBatches.length === 0 ? "PASS" : "FAIL",
    failedBatches,
  }, null, 2)}\n`);
  process.exitCode = failedBatches.length === 0 ? 0 : 1;
}

await run();
