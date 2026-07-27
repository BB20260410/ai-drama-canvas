/**
 * SSL-2 阅读投影实跑：导入的 S1E2_立约 + earliest 高亮
 * npx tsx scripts/s1e2-ssl2-reader-view.ts
 */
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { activateProject } from "../src/core/service.js";
import { listStudioTextDocuments } from "../src/core/studio-production.js";
import { getStudioScriptReaderView } from "../src/core/studio-script-library-reader.js";

const ROOT = "/Users/hxx/Documents/无限画布/projects/dudu-gaiden-lock-20260723-12a6516c";
const OUT =
  "/Users/hxx/Documents/无限画布/productions/dudu-gaiden/s1e2-grok-canvas-loop-20260723/05_canvas";
const EVIDENCE = OUT;

async function main() {
  await activateProject(ROOT);
  const docs = await listStudioTextDocuments(ROOT, { kind: "script", search: "S1E2_立约", limit: 20 });
  const doc = docs.items.find((d) => d.title === "S1E2_立约") ?? docs.items[0];
  if (!doc) throw new Error("未找到 S1E2_立约 剧本 document（先跑 SSL-1 import）");

  const view = await getStudioScriptReaderView(ROOT, {
    documentId: doc.id,
    season: "S1",
    episode: "S1E2",
    includeBody: true,
  });

  // 重跑 earliest 时带 evidenceDir（reader 内部 earliest 未传 evidence——补一版对照）
  const { getStudioEpisodeEarliest } = await import("../src/core/studio-episode-earliest.js");
  const earliest = await getStudioEpisodeEarliest(ROOT, {
    season: "S1",
    episode: "S1E2",
    evidenceDir: EVIDENCE,
  });

  mkdirSync(OUT, { recursive: true });
  const viewPath = path.join(OUT, "ssl2-reader-view-s1e2-liyao-20260724.json");
  // 截断 body 写盘以免过大；完整 body 长度保留
  const stored = {
    ...view,
    body: view.body.slice(0, 4000),
    bodyTruncated: view.body.length > 4000,
  };
  writeFileSync(viewPath, JSON.stringify(stored, null, 2));
  const report = {
    ok: true,
    viewPath,
    documentId: view.documentId,
    documentTitle: view.documentTitle,
    revisionId: view.revisionId,
    bodyCharCount: view.bodyCharCount,
    outlineCount: view.outline.length,
    outlineSample: view.outline.slice(0, 8),
    episodeUnitHighlights: view.episode?.unitHighlights.length ?? 0,
    earliestUnitId: earliest.earliestUnitId,
    earliestStatusLine: earliest.statusLine,
    formalCompleted: earliest.completedUnitIds.length,
    pending: earliest.pendingUnitIds.length,
    builtAt: new Date().toISOString(),
  };
  writeFileSync(path.join(OUT, "ssl2-reader-report-20260724.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
