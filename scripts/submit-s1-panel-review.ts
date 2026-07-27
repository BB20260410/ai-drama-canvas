import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  executeIdempotentCommand,
  type SubmitStudioGenerationReviewCommandPayload,
} from "../src/core/command-bus.js";
import { getStudioProductionDashboard } from "../src/core/studio-production-dashboard.js";

const PROJECT = "/Users/hxx/Documents/无限画布/projects/codex-ai-drama-studio";
const OUT = path.join(PROJECT, ".aicanvas", "agent-imagegen-out");
const TAG = "s1-auth-imagegen-v1";

async function main() {
  const unitId = "unit-ep01_15s_001";
  const panelId = "panel-01";
  const reg = JSON.parse(await readFile(path.join(OUT, `register-${unitId}-${panelId}.json`), "utf8"));
  const pack = JSON.parse(await readFile(path.join(OUT, `${unitId}-${panelId}-pack.json`), "utf8"));
  const continuityFingerprint = pack.pack.continuity.fingerprint;
  const packFingerprint = pack.pack.fingerprint;

  const payload: SubmitStudioGenerationReviewCommandPayload = {
    generationRunId: reg.runId,
    kind: "observation",
    expectedHeadRevision: 0,
    rawResultId: reg.raw.resultId,
    rawSha256: reg.raw.mediaSha256,
    labeledResultId: reg.labeled.resultId,
    labeledSha256: reg.labeled.mediaSha256,
    expectedPackFingerprint: packFingerprint,
    continuityFingerprint,
    decision: "pass",
    criteria: [
      { code: "identity-consistency", status: "pass", note: "完整金面独立悬浮；与A01能量无佩戴融合；河雾渔村层次成立。" },
      { code: "hardlock-geometry", status: "pass", note: "闭口一整张刚性金面，无半面/裂面/口型说话。" },
      { code: "no-modern-leak", status: "pass", note: "无现代物、无字幕水印。" },
      { code: "raw-labeled-pair", status: "pass", note: "raw/labeled 成对登记。" },
    ],
    reviewer: "codex",
    note: "用户授权后 Grok image_edit 正式生图；硬锁 D01+A01 参考；16:9 1280x720。轻微能量环靠近金面可接受，未构成佩戴融合。",
  };

  const r = await executeIdempotentCommand(PROJECT, {
    requestId: `${TAG}:review:${unitId}:${panelId}`,
    idempotencyKey: `${TAG}:review:${unitId}:${panelId}`,
    request: { command: "submit_studio_generation_review", payload },
  });
  await writeFile(path.join(OUT, `review-${unitId}-${panelId}.json`), JSON.stringify(r, null, 2));
  const unit = await getStudioProductionDashboard(PROJECT, { operation: "unit", unitId });
  const overview = await getStudioProductionDashboard(PROJECT, { operation: "overview" });
  await writeFile(path.join(OUT, `after-review-unit.json`), JSON.stringify(unit, null, 2));
  console.log(JSON.stringify({
    reviewStatus: r.status,
    reviewResult: r.result,
    error: r.error,
    unitNext: unit.nextAction,
    overviewNext: overview.nextAction,
  }, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });
