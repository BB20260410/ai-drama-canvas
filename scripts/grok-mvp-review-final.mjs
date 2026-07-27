import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { inspectManagedProject } from "../src/core/managed-project.ts";
import { registerProject, setActiveProjectRegistration } from "../src/core/sidecar.ts";
import { readStudioUnitGridGenerationFrozenPack } from "../src/core/studio-generation-ledger.ts";
import { submitStudioGenerationReview } from "../src/core/studio-generation-review.ts";
import { getStudioProductionDashboard } from "../src/core/studio-production-dashboard.ts";
import { getActiveManagedStudioContext } from "../src/core/active-managed-studio-context.ts";

const workspace = "/Users/hxx/Documents/无限画布";
const root = path.join(workspace, "projects/grok-mvp-qingdeng-mrwc97mu-d0aea463");
const work = path.join(root, ".aicanvas/mvp-work");
process.env.AI_CANVAS_WORKSPACE = workspace;
process.env.AI_CANVAS_RECORDED_SOURCE_DIGEST = "9d650d4df5fde6fdd13ba2e8460ce9ffb66350a63e1c2f3511090df5676a0798";
process.env.AI_CANVAS_RELEASE_MANIFEST_PATH = path.join(workspace, "release-manifest.json");
process.env.AI_CANVAS_REGISTRY_PATH = path.join(process.env.HOME, ".aicanvas/projects.json");

const pre = JSON.parse(await readFile(path.join(work, "precall-state.json"), "utf8"));
const commit = JSON.parse(await readFile(path.join(work, "commit-result.json"), "utf8"));
const shell = await inspectManagedProject(root);
await registerProject(shell.project);
await setActiveProjectRegistration(root);

const pack = await readStudioUnitGridGenerationFrozenPack(root, pre.pack.packId);
const continuityFingerprint = pack.continuityFingerprint
  || pack.target?.continuityFingerprint
  || pack.unitContinuityFingerprint
  || pack.fingerprint;

const raw = commit.result.results.raw;
const labeled = commit.result.results.labeled;

const review = await submitStudioGenerationReview(root, {
  operationId: `grok-mvp-review-${pre.generationRunId}`,
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
  note: "Grok主代理原尺寸Review PASS（隔离MVP canary）。单次image_edit后机械叠为9:16 unit-grid合同画幅；不代表长片终审。",
});

const context = await getActiveManagedStudioContext();
const overview = await getStudioProductionDashboard(root, { operation: "overview" });
const unit = await getStudioProductionDashboard(root, { operation: "unit", unitId: "S1E01-U01" });

const out = {
  packContinuityFingerprint: continuityFingerprint,
  packTopKeys: Object.keys(pack || {}),
  review: {
    id: review.id || review.reviewId,
    decision: review.decision,
    revision: review.revision,
    fingerprint: review.fingerprint,
    keys: Object.keys(review),
  },
  activeNextAction: context.nextAction,
  overviewNextAction: overview.nextAction,
  unitNextAction: unit.nextAction,
  counts: overview.counts,
};
await writeFile(path.join(work, "review-final.json"), JSON.stringify({ out, review, pack }, null, 2) + "\n");
console.log(JSON.stringify(out, null, 2));
