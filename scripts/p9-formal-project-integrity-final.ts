/**
 * P9 最终正式工程只读完整性检查：
 * - 所有 SQLite 事实源 quick_check；
 * - CAS 对象路径、大小和 SHA-256；
 * - 图片完整像素解码、音视频 ffprobe；
 * - agent-imagegen raw/labeled 成对与媒体登记交叉检查。
 *
 * 只读取正式工程，证据写入仓库 output/evidence。
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";

const execFileAsync = promisify(execFile);
const workspace = process.cwd();
const projectRoot = path.resolve(
  process.argv[2] ?? path.join(workspace, "projects/local-import-dudu-world-prologue-b8bfcf14"),
);
const evidencePath = path.resolve(
  process.argv[3] ?? path.join(workspace, "output/evidence/p9-formal-project-integrity-final-20260727.json"),
);
const startedAt = new Date().toISOString();

interface StudioMediaRow {
  sha256: string;
  kind: "image" | "video" | "audio";
  size_bytes: number;
  mime_type: string;
  object_relpath: string;
}

interface GenerationResultRow {
  generation_run_id: string;
  result_id: string;
  variant: "raw" | "labeled";
  status: "pending" | "approved" | "rejected";
  media_sha256: string;
  input_current: number;
  promotion_eligible: number;
  unit_id: string;
  panel_id: string;
  panel_index: number;
}

async function sqliteJson<T>(databasePath: string, sql: string): Promise<T[]> {
  const uri = `file:${databasePath}?mode=ro&immutable=1`;
  const result = await execFileAsync("sqlite3", ["-json", uri, sql], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: 30_000,
  });
  const text = result.stdout.trim();
  return text ? JSON.parse(text) as T[] : [];
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  operation: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await operation(items[index]!, index);
    }
  }));
  return results;
}

const databaseNames = [
  "cache.sqlite",
  "command-ledger.sqlite",
  "material-studio.sqlite",
  "studio-generation-ledger.sqlite",
  "studio-production.sqlite",
  "studio.sqlite",
] as const;
const databaseChecks = await Promise.all(databaseNames.map(async (name) => {
  const databasePath = path.join(projectRoot, ".aicanvas", name);
  const rows = await sqliteJson<{ quick_check: string }>(databasePath, "PRAGMA quick_check;");
  return { name, result: rows.map((row) => row.quick_check), ok: rows.length === 1 && rows[0]?.quick_check === "ok" };
}));

const materialDatabase = path.join(projectRoot, ".aicanvas", "material-studio.sqlite");
const mediaRows = await sqliteJson<StudioMediaRow>(materialDatabase, `
  SELECT sha256, kind, size_bytes, mime_type, object_relpath
  FROM studio_media
  ORDER BY kind, sha256;
`);
const mediaBySha = new Map(mediaRows.map((row) => [row.sha256, row]));
const projectPrefix = `${projectRoot}${path.sep}`;

const mediaChecks = await mapLimited(mediaRows, 3, async (row) => {
  const objectPath = path.resolve(projectRoot, row.object_relpath);
  if (!objectPath.startsWith(projectPrefix)) {
    throw new Error(`CAS 对象逃逸工程根：${row.sha256} -> ${row.object_relpath}`);
  }
  const metadata = await stat(objectPath);
  if (!metadata.isFile()) throw new Error(`CAS 对象不是文件：${row.sha256}`);
  if (metadata.size !== row.size_bytes) {
    throw new Error(`CAS 大小不一致：${row.sha256} db=${row.size_bytes} actual=${metadata.size}`);
  }
  const actualSha256 = await sha256File(objectPath);
  if (actualSha256 !== row.sha256) {
    throw new Error(`CAS SHA-256 不一致：expected=${row.sha256} actual=${actualSha256}`);
  }

  if (row.kind === "image") {
    const decoded = await sharp(objectPath, { failOn: "error" }).raw().toBuffer({ resolveWithObject: true });
    if (decoded.info.width <= 0 || decoded.info.height <= 0 || decoded.data.byteLength <= 0) {
      throw new Error(`图片完整解码为空：${row.sha256}`);
    }
    return {
      sha256: row.sha256,
      kind: row.kind,
      bytes: metadata.size,
      decoded: {
        width: decoded.info.width,
        height: decoded.info.height,
        channels: decoded.info.channels,
        rawBytes: decoded.data.byteLength,
      },
    };
  }

  const probe = await execFileAsync("/opt/homebrew/bin/ffprobe", [
    "-v", "error",
    "-show_streams",
    "-show_format",
    "-of", "json",
    objectPath,
  ], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    timeout: 30_000,
  });
  const parsed = JSON.parse(probe.stdout) as {
    streams?: Array<{ codec_type?: string; codec_name?: string; duration?: string }>;
    format?: { duration?: string };
  };
  const expectedStream = parsed.streams?.find((stream) => stream.codec_type === row.kind);
  if (!expectedStream) throw new Error(`${row.kind} 缺少可探测流：${row.sha256}`);
  return {
    sha256: row.sha256,
    kind: row.kind,
    bytes: metadata.size,
    decoded: {
      codec: expectedStream.codec_name ?? null,
      durationSeconds: Number(expectedStream.duration ?? parsed.format?.duration ?? 0),
      streamCount: parsed.streams?.length ?? 0,
    },
  };
});

const generationDatabase = path.join(projectRoot, ".aicanvas", "studio-generation-ledger.sqlite");
const generationRows = await sqliteJson<GenerationResultRow>(generationDatabase, `
  SELECT generation_run_id, result_id, variant, status, media_sha256,
         input_current, promotion_eligible, unit_id, panel_id, panel_index
  FROM studio_generation_results
  ORDER BY generation_run_id, variant;
`);
const runGroups = new Map<string, GenerationResultRow[]>();
for (const row of generationRows) {
  const group = runGroups.get(row.generation_run_id) ?? [];
  group.push(row);
  runGroups.set(row.generation_run_id, group);
  const media = mediaBySha.get(row.media_sha256);
  if (!media) throw new Error(`生成结果未登记到 material studio：${row.result_id}`);
  if (media.kind !== "image") throw new Error(`生成结果不是图片：${row.result_id}`);
}
const generationPairs = [...runGroups.entries()].map(([generationRunId, rows]) => {
  const variants = new Set(rows.map((row) => row.variant));
  if (rows.length !== 2 || !variants.has("raw") || !variants.has("labeled")) {
    throw new Error(`生成结果未形成唯一 raw/labeled 对：${generationRunId}`);
  }
  const raw = rows.find((row) => row.variant === "raw")!;
  const labeled = rows.find((row) => row.variant === "labeled")!;
  return {
    generationRunId,
    unitId: raw.unit_id,
    panelId: raw.panel_id,
    panelIndex: raw.panel_index,
    raw: { resultId: raw.result_id, sha256: raw.media_sha256, status: raw.status },
    labeled: { resultId: labeled.result_id, sha256: labeled.media_sha256, status: labeled.status },
    current: raw.input_current === 1 && labeled.input_current === 1,
    promotionEligible: raw.promotion_eligible === 1 && labeled.promotion_eligible === 1,
  };
});
const reviewRows = await sqliteJson<{ generation_run_id: string; decision: string; reviewer: string }>(
  generationDatabase,
  `
    SELECT heads.generation_run_id, events.decision, events.reviewer
    FROM studio_generation_review_heads AS heads
    JOIN studio_generation_review_events AS events ON events.review_id = heads.review_id
    ORDER BY heads.generation_run_id;
  `,
);

const imageChecks = mediaChecks.filter((row) => row.kind === "image");
const imageWidths = imageChecks.map((row) => "width" in row.decoded ? row.decoded.width : 0);
const imageHeights = imageChecks.map((row) => "height" in row.decoded ? row.decoded.height : 0);
const evidence = {
  schemaVersion: 1,
  kind: "p9-formal-project-integrity-final",
  status: databaseChecks.every((entry) => entry.ok) ? "PASS" : "FAIL",
  projectRoot,
  startedAt,
  endedAt: new Date().toISOString(),
  readOnly: true,
  externalCalls: 0,
  databaseChecks,
  media: {
    registered: mediaRows.length,
    totalBytes: mediaRows.reduce((sum, row) => sum + row.size_bytes, 0),
    byKind: Object.fromEntries(["image", "video", "audio"].map((kind) => [
      kind,
      mediaRows.filter((row) => row.kind === kind).length,
    ])),
    allExist: mediaChecks.length === mediaRows.length,
    allSizesMatch: true,
    allSha256Match: true,
    allFullyDecodedOrProbed: true,
    imageDimensions: {
      minimumWidth: Math.min(...imageWidths),
      maximumWidth: Math.max(...imageWidths),
      minimumHeight: Math.min(...imageHeights),
      maximumHeight: Math.max(...imageHeights),
    },
    nonImage: mediaChecks.filter((row) => row.kind !== "image"),
  },
  generation: {
    resultCount: generationRows.length,
    runCount: generationPairs.length,
    allRawLabeledPaired: generationRows.length === generationPairs.length * 2,
    pairs: generationPairs,
    reviewHeadCount: reviewRows.length,
    reviewHeads: reviewRows,
    note: reviewRows.length
      ? "Review head 只记录实际账本裁决。"
      : "当前无 Review head；生成结果仍按账本状态报告，不冒充人工审片通过。",
  },
  assertions: {
    allDatabaseQuickChecksPass: databaseChecks.every((entry) => entry.ok),
    allRegisteredMediaVerified: mediaChecks.length === mediaRows.length,
    allGenerationResultsRegistered: generationRows.every((row) => mediaBySha.has(row.media_sha256)),
    allGenerationRunsPaired: generationRows.length === generationPairs.length * 2,
  },
};
if (Object.values(evidence.assertions).some((value) => !value)) evidence.status = "FAIL";

await mkdir(path.dirname(evidencePath), { recursive: true });
await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({
  status: evidence.status,
  evidencePath,
  databases: databaseChecks.length,
  media: evidence.media,
  generation: {
    resultCount: evidence.generation.resultCount,
    runCount: evidence.generation.runCount,
    allRawLabeledPaired: evidence.generation.allRawLabeledPaired,
    reviewHeadCount: evidence.generation.reviewHeadCount,
  },
  assertions: evidence.assertions,
}, null, 2)}\n`);
if (evidence.status !== "PASS") process.exitCode = 1;
