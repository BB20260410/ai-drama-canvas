/**
 * SSL-1：从 SOURCE_SCRIPT_READONLY/episodes 只读复制 md 入库到隔离工程
 * 禁止回写权威源目录。
 *
 * npx tsx scripts/s1e2-ssl1-import-episodes.ts [--limit 3]
 */
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { activateProject } from "../src/core/service.js";
import {
  importStudioScriptLibraryFiles,
  listScriptLibraryImportCandidates,
} from "../src/core/studio-script-library-import.js";
import { getStudioScriptLibraryIndex } from "../src/core/studio-script-library-projection.js";

const ROOT = "/Users/hxx/Documents/无限画布/projects/dudu-gaiden-lock-20260723-12a6516c";
const SOURCE_DIR =
  "/Users/hxx/Documents/无限画布/productions/dudu-gaiden/s1e2-grok-canvas-loop-20260723/SOURCE_SCRIPT_READONLY/episodes";
const OUT =
  "/Users/hxx/Documents/无限画布/productions/dudu-gaiden/s1e2-grok-canvas-loop-20260723/05_canvas";

function argLimit(): number | undefined {
  const i = process.argv.indexOf("--limit");
  if (i < 0) return undefined;
  const n = Number(process.argv[i + 1]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

async function main() {
  await activateProject(ROOT);
  let files = listScriptLibraryImportCandidates(SOURCE_DIR);
  // 优先 S1 再 S2
  files = files.sort((a, b) => path.basename(a).localeCompare(path.basename(b), "en"));
  const limit = argLimit();
  if (limit !== undefined) files = files.slice(0, limit);

  const result = await importStudioScriptLibraryFiles(ROOT, {
    files,
    source: "ssl1-readonly-episodes",
    sourceVersion: "20260724",
  });

  const index = await getStudioScriptLibraryIndex(ROOT, { kind: "script", limit: 100 });
  mkdirSync(OUT, { recursive: true });
  const resultPath = path.join(OUT, "ssl1-import-episodes-result-20260724.json");
  writeFileSync(resultPath, JSON.stringify(result, null, 2));
  const report = {
    ok: result.failed === 0,
    resultPath,
    sourceDir: SOURCE_DIR,
    projectRoot: ROOT,
    wroteBackToSource: false,
    imported: result.imported,
    skippedDuplicate: result.skippedDuplicate,
    skippedEmpty: result.skippedEmpty,
    failed: result.failed,
    libraryDocumentCountAfter: index.documentCount,
    sampleImported: result.files.filter((f) => f.status === "imported").slice(0, 5),
    builtAt: new Date().toISOString(),
  };
  writeFileSync(path.join(OUT, "ssl1-import-report-20260724.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (result.failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
