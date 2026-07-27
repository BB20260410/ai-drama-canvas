/**
 * P24 NOT_RUN 规模实测：反向影响查询与无索引首跳在 1288 单元规模的耗时。
 * 隔离目录建 1288 单元规模夹具（轻媒体），实测：
 * 1) listStudioUnitRevisionsByScriptRevision（script_revision_id 无索引，键集分页扫描）单页耗时；
 * 2) getStudioScriptRevisionImpact（两层分页，页内 packs/runs/results 扇出）首页耗时；
 * 3) 翻页累计耗时（前 5 页）。
 * 结果落 docs/evidence（与终验同一 sourceDigest）。
 */
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { computeSourceDigest } from "../src/core/build-identity.js";
import { getStudioScriptRevisionImpact } from "../src/core/studio-trace.js";
import {
  getLatestStudioTextRevisionMetadata,
  listStudioTextDocuments,
  listStudioUnitRevisionsByScriptRevision,
} from "../src/core/studio-production.js";
import { createStudioScaleMetadataFixture } from "../src/core/studio-scale-fixture.js";

const workspace = path.resolve(process.cwd());
const evidencePath = path.resolve(process.argv[2] ?? path.join(workspace, "docs/evidence/p24-trace-scale-measure-20260720.json"));
const parentRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "p24-scale-")));

async function timeIt<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const started = performance.now();
  const value = await fn();
  return { value, ms: Math.round((performance.now() - started) * 100) / 100 };
}

const fixture = await createStudioScaleMetadataFixture({
  parentRoot,
  mediaMetaCount: 8,
  seedProductionPath: true,
  realAvDerivatives: false,
  name: "P24 追溯规模实测",
});

const documents = await listStudioTextDocuments(fixture.root, {});
const scriptDocument = documents.items.find((doc) => doc.kind === "script");
if (!scriptDocument) throw new Error("规模夹具缺少剧本文档。");
const latestRevision = await getLatestStudioTextRevisionMetadata(fixture.root, scriptDocument.id);
if (!latestRevision) throw new Error("规模夹具缺少剧本修订。");
const scriptRevisionId = latestRevision.id;

const firstHop = await timeIt(() => listStudioUnitRevisionsByScriptRevision(fixture.root, { scriptRevisionId, limit: 100 }));
const impactFirstPage = await timeIt(() => getStudioScriptRevisionImpact(fixture.root, { scriptRevisionId, limit: 50 }));

// 翻页累计（前 5 页，每页 50 单元修订）。
let cursor: string | undefined = impactFirstPage.value.nextCursor;
const pageMs: number[] = [impactFirstPage.ms];
for (let page = 1; page < 5 && cursor; page += 1) {
  const next = await timeIt(() => getStudioScriptRevisionImpact(fixture.root, { scriptRevisionId, limit: 50, cursor: cursor! }));
  pageMs.push(next.ms);
  cursor = next.value.nextCursor;
}

const digest = await computeSourceDigest(workspace);
const evidence = {
  schemaVersion: 1,
  kind: "p24-trace-scale-measure",
  sourceDigest: digest.sourceDigest,
  sourceFiles: digest.sourceFiles,
  sourceBytes: digest.sourceBytes,
  fixture: { root: fixture.root, unitCount: fixture.counts.units, scriptRevisionId },
  measurements: {
    firstHopLimit100Ms: firstHop.ms,
    firstHopItems: firstHop.value.items.length,
    impactFirstPageLimit50Ms: impactFirstPage.ms,
    impactFirstPageUnits: impactFirstPage.value.items.length,
    impactPageMs: pageMs,
    impactTotalRowsFirstPage: impactFirstPage.value.items.reduce((sum, item) => sum + item.rows.length, 0),
  },
};
await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
await rm(fixture.root, { recursive: true, force: true }).catch(() => undefined);
process.stdout.write(`${JSON.stringify({ ok: true, evidencePath, measurements: evidence.measurements }, null, 2)}\n`);
