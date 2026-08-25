/**
 * Wave 1-B：显式 full 时间线投影 + 耗时。
 * 用法：npx tsx scripts/report-approved-timeline-full.ts --project <root> [--season S1] [--episode S1E1]
 * 只读。拒绝正式工程路径。日常 UI / earliest 不得调用本脚本。
 */
import path from "node:path";
import { getApprovedTimelineProjection } from "../src/core/studio-approved-timeline-projection.js";

const OFFICIAL_PROJECT_MARKERS = ["codex-ai-drama-studio"];

export function parseApprovedTimelineFullArgs(argv: readonly string[]): {
  projectRoot: string;
  season: string;
  episode: string;
} {
  let projectRoot: string | undefined;
  let season = "S1";
  let episode = "S1E1";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = argv[i + 1];
    if (arg === "--project" && next) {
      projectRoot = next;
      i++;
    } else if (arg === "--season" && next) {
      season = next;
      i++;
    } else if (arg === "--episode" && next) {
      episode = next;
      i++;
    }
  }
  if (!projectRoot) {
    throw new Error("必须提供 --project <受管工程根>。禁止省略后扫正式库。");
  }
  return { projectRoot, season, episode };
}

export function assertApprovedTimelineFullProjectAllowed(projectRoot: string): void {
  const normalized = path.resolve(projectRoot).replaceAll("\\", "/");
  for (const marker of OFFICIAL_PROJECT_MARKERS) {
    if (normalized.split("/").includes(marker)) {
      throw new Error(`拒绝探测正式工程 ${marker}。请用隔离夹具或 --project 指向副本。`);
    }
  }
}

async function main(): Promise<void> {
  const args = parseApprovedTimelineFullArgs(process.argv.slice(2));
  assertApprovedTimelineFullProjectAllowed(args.projectRoot);
  const projection = await getApprovedTimelineProjection(args.projectRoot, {
    season: args.season,
    episode: args.episode,
    fastMode: false,
  });
  if (projection.fastMode !== false) {
    throw new Error("full CLI 必须显式 fastMode:false，投影却回报快路径。");
  }
  process.stdout.write(`${JSON.stringify({
    kind: "approved-timeline-full-report",
    projectId: projection.projectId,
    season: projection.season,
    episode: projection.episode,
    unitCount: projection.unitCount,
    summary: projection.summary,
    fastMode: projection.fastMode,
    durationMs: projection.durationMs,
    hint: `full 投影耗时 ${projection.durationMs}ms；日常刷新应走 fastMode:true`,
  }, null, 2)}\n`);
}

const invokedDirectly = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);

if (invokedDirectly) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
