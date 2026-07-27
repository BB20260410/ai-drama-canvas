import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { registerProject, setActiveProjectRegistration } from "../src/core/sidecar.ts";
import { inspectManagedProject } from "../src/core/managed-project.ts";
import { submitStudioGenerationReview } from "../src/core/studio-generation-review.ts";
import { getStudioProductionDashboard } from "../src/core/studio-production-dashboard.ts";
import { getActiveManagedStudioContext } from "../src/core/active-managed-studio-context.ts";
import { DatabaseSync } from "node:sqlite";

const workspace = "/Users/hxx/Documents/无限画布";
const root = "/Users/hxx/Documents/无限画布/projects/grok-mvp-qingdeng-mrwc97mu-d0aea463";
const work = path.join(root, ".aicanvas/mvp-work");
const commit = JSON.parse(await readFile(path.join(work, "commit-result.json"), "utf8"));
const pre = JSON.parse(await readFile(path.join(work, "precall-state.json"), "utf8"));

process.env.AI_CANVAS_WORKSPACE = workspace;
process.env.AI_CANVAS_RECORDED_SOURCE_DIGEST = "9d650d4df5fde6fdd13ba2e8460ce9ffb66350a63e1c2f3511090df5676a0798";
process.env.AI_CANVAS_RELEASE_MANIFEST_PATH = path.join(workspace, "release-manifest.json");
process.env.AI_CANVAS_REGISTRY_PATH = path.join(process.env.HOME, ".aicanvas/projects.json");

const shell = await inspectManagedProject(root);
await registerProject(shell.project);
await setActiveProjectRegistration(root);

const result = commit.result;
const raw = result.results.raw;
const labeled = result.results.labeled;

// Discover continuity fingerprint from generation pack JSON in CAS or sqlite columns
const genDbPath = path.join(root, ".aicanvas/studio-generation-ledger.sqlite");
const db = new DatabaseSync(genDbPath, { readOnly: true });
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name);
let packMeta = null;
let continuityFingerprint = null;
try {
  const cols = db.prepare("PRAGMA table_info(studio_generation_packs)").all().map((c) => c.name);
  const row = db.prepare("SELECT * FROM studio_generation_packs WHERE pack_id = ?").get(pre.pack.packId);
  packMeta = { cols, rowKeys: row ? Object.keys(row) : null };
  if (row) {
    continuityFingerprint = row.continuity_fingerprint || row.continuityFingerprint || null;
    // maybe payload json
    for (const k of Object.keys(row)) {
      if (typeof row[k] === "string" && row[k].includes("continuity")) {
        try {
          const parsed = JSON.parse(row[k]);
          continuityFingerprint = continuityFingerprint || parsed.continuityFingerprint || parsed.target?.continuityFingerprint;
        } catch {}
      }
    }
  }
} catch (e) {
  packMeta = { error: e.message };
}
// try generation runs
try {
  const runCols = db.prepare("PRAGMA table_info(studio_generation_runs)").all().map((c) => c.name);
  const run = db.prepare("SELECT * FROM studio_generation_runs WHERE generation_run_id = ? OR run_id = ?").get(pre.generationRunId, pre.generationRunId);
  packMeta = { ...packMeta, runCols, runKeys: run ? Object.keys(run) : null };
} catch (e) {
  packMeta = { ...packMeta, runError: e.message };
}
db.close();

// Fallback: use first continuity readiness fingerprint from precall state
if (!continuityFingerprint) {
  continuityFingerprint = pre.continuity?.[0]?.fingerprint;
}

const reviewInput = {
  generationRunId: pre.generationRunId,
  kind: "observation",
  expectedHeadRevision: 0,
  rawResultId: raw.resultId,
  rawSha256: raw.mediaSha256,
  labeledResultId: labeled.resultId,
  labeledSha256: labeled.mediaSha256,
  expectedPackFingerprint: pre.pack.packFingerprint,
  continuityFingerprint,
  decision: "pass",
  criteria: [
    { code: "identity-consistency", status: "pass", note: "三格同一青灯客脸与靛青斗篷/素白交领" },
    { code: "hard-lock", status: "pass", note: "角色Authority参考一致" },
    { code: "prop-costume", status: "pass", note: "斗篷与灯连续" },
    { code: "scene-continuity", status: "pass", note: "雨夜客栈廊下连续" },
    { code: "forbidden-content", status: "pass", note: "无字幕无串角无嘟嘟身份" },
    { code: "image-quality", status: "pass", note: "电影写实可用 canary" },
    { code: "prompt-contract", status: "pass", note: "三段叙事：护灯/听雨/入廊" },
  ],
  reviewer: "codex",
  note: "Grok主代理原尺寸Review PASS（隔离MVP canary）。候选由单次image_edit生成后机械叠为9:16 unit-grid合同画幅；不代表长片终审。",
};

let review;
try {
  review = await submitStudioGenerationReview(root, reviewInput);
} catch (e) {
  review = {
    error: e.message,
    name: e.name,
    result: e.result,
    tables,
    packMeta,
    continuityFingerprint,
  };
}

const context = await getActiveManagedStudioContext();
const overview = await getStudioProductionDashboard(root, { operation: "overview" });
const unit = await getStudioProductionDashboard(root, { operation: "unit", unitId: "S1E01-U01" });

const out = {
  reviewOk: !review?.error,
  review,
  active: {
    projectId: context.project?.id || context.projectId,
    primaryRoot: context.project?.primaryRoot || context.primaryRoot || context.projectRoot,
    nextAction: context.nextAction,
  },
  overview: {
    nextAction: overview?.nextAction,
    projectId: overview?.projectId,
    counts: overview?.counts,
  },
  unit: {
    nextAction: unit?.nextAction,
    fingerprint: unit?.fingerprint,
    keys: Object.keys(unit || {}),
  },
};
await writeFile(path.join(work, "review-verify.json"), JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify(out, null, 2));
