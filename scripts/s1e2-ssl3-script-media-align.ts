/**
 * SSL-3 一键图文对照实跑
 * npx tsx scripts/s1e2-ssl3-script-media-align.ts
 */
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { activateProject } from "../src/core/service.js";
import { listStudioTextDocuments } from "../src/core/studio-production.js";
import { getStudioScriptMediaAlignBoard } from "../src/core/studio-script-media-align.js";

const ROOT = "/Users/hxx/Documents/无限画布/projects/dudu-gaiden-lock-20260723-12a6516c";
const OUT =
  "/Users/hxx/Documents/无限画布/productions/dudu-gaiden/s1e2-grok-canvas-loop-20260723/05_canvas";

async function main() {
  await activateProject(ROOT);
  const docs = await listStudioTextDocuments(ROOT, { kind: "script", search: "S1E2_立约", limit: 10 });
  const doc = docs.items.find((d) => d.title === "S1E2_立约");

  const board = await getStudioScriptMediaAlignBoard(ROOT, {
    season: "S1",
    episode: "S1E2",
    ...(doc ? { documentId: doc.id } : {}),
    evidenceDir: OUT,
    includeOutline: true,
  });

  mkdirSync(OUT, { recursive: true });
  const boardPath = path.join(OUT, "ssl3-script-media-align-s1e2-20260724.json");
  writeFileSync(boardPath, JSON.stringify(board, null, 2));

  const report = {
    ok: true,
    boardPath,
    unitCount: board.unitCount,
    coveredCount: board.coveredCount,
    partialCount: board.partialCount,
    missingAllCount: board.missingAllCount,
    documentTitle: board.documentTitle,
    earliestStatusLine: board.earliestStatusLine,
    sampleRows: board.rows.slice(0, 3).map((r) => ({
      unitId: r.unitId,
      status: r.status,
      rawSha256: r.rawSha256?.slice(0, 16),
      packId: r.packId,
      outlineAnchors: r.outlineAnchors.length,
      trace: r.trace,
    })),
    lastRow: board.rows[board.rows.length - 1]
      ? {
          unitId: board.rows[board.rows.length - 1]!.unitId,
          status: board.rows[board.rows.length - 1]!.status,
          formalCommitted: board.rows[board.rows.length - 1]!.formalCommitted,
          outlineAnchors: board.rows[board.rows.length - 1]!.outlineAnchors.length,
        }
      : null,
    oneClickClaim:
      "打开 script-media-align 即可知每单元有无图、SHA、pack/run 点穿钥匙与缺图清单，无需手翻 SQLite/quarantine。",
    builtAt: new Date().toISOString(),
  };
  writeFileSync(path.join(OUT, "ssl3-align-report-20260724.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
