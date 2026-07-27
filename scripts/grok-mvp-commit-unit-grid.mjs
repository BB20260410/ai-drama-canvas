import { createHash } from "node:crypto";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { executeIdempotentCommand } from "../src/core/command-bus.ts";
import { getActiveManagedStudioContext } from "../src/core/active-managed-studio-context.ts";
import { registerProject, setActiveProjectRegistration } from "../src/core/sidecar.ts";
import { inspectManagedProject } from "../src/core/managed-project.ts";
import { submitStudioGenerationReview } from "../src/core/studio-generation-review.ts";
import { getStudioProductionDashboard } from "../src/core/studio-production-dashboard.ts";

const workspace = "/Users/hxx/Documents/无限画布";
const root = "/Users/hxx/Documents/无限画布/projects/grok-mvp-qingdeng-mrwc97mu-d0aea463";
const work = path.join(root, ".aicanvas/mvp-work");
const pre = JSON.parse(await readFile(path.join(work, "precall-state.json"), "utf8"));
const gridSrc = "/Users/hxx/.grok/sessions/%2FUsers%2Fhxx/019f8ac9-c47c-7da2-a0fb-3133c65d1f49/images/2.jpg";

process.env.AI_CANVAS_WORKSPACE = workspace;
process.env.AI_CANVAS_RECORDED_SOURCE_DIGEST = "9d650d4df5fde6fdd13ba2e8460ce9ffb66350a63e1c2f3511090df5676a0798";
process.env.AI_CANVAS_RELEASE_MANIFEST_PATH = path.join(workspace, "release-manifest.json");
process.env.AI_CANVAS_REGISTRY_PATH = path.join(process.env.HOME, ".aicanvas/projects.json");

const shell = await inspectManagedProject(root);
await registerProject(shell.project);
await setActiveProjectRegistration(root);

const candidatePath = pre.prepare.quarantine.candidatePath;
const receiptPath = pre.prepare.quarantine.receiptPath;
await sharp(gridSrc).png().toFile(candidatePath);
const rawBytes = await readFile(candidatePath);
const rawSha256 = createHash("sha256").update(rawBytes).digest("hex");
await copyFile(candidatePath, path.join(work, "unit-grid-candidate.png"));

const now = new Date().toISOString();
const startedAt = new Date(Date.now() - 15_000).toISOString();
const executionReceipt = {
  schemaVersion: 1,
  kind: "agent-imagegen-execution-receipt",
  provider: "grok",
  source: "grok-build-imagine",
  attestationLevel: "agent-session-direct",
  cryptographicProviderReceipt: false,
  callId: pre.prepare.callId,
  model: "grok-4.5",
  agentSessionId: "019f8ac9-c47c-7da2-a0fb-3133c65d1f49",
  toolCallId: "image-edit-unit-grid-1",
  toolName: "image_edit",
  toolInvocationCount: 1,
  inputFingerprint: pre.prepare.inputFingerprint,
  candidateSha256: rawSha256,
  startedAt,
  generatedAt: now,
};
await writeFile(receiptPath, `${JSON.stringify(executionReceipt, null, 2)}\n`);

const context = await getActiveManagedStudioContext();
if (context.projectContextToken !== pre.projectContextToken) {
  console.error("WARN projectContextToken changed", { old: pre.projectContextToken, new: context.projectContextToken });
}

const committed = await executeIdempotentCommand(root, {
  requestId: `grok-mvp-commit-v2-${pre.generationRunId}`.slice(0, 160),
  idempotencyKey: `grok-mvp-commit-key-v2-${pre.generationRunId}`.slice(0, 200),
  request: {
    command: "commit_agent_imagegen_result_bundle",
    payload: {
      projectContextToken: context.projectContextToken,
      packId: pre.pack.packId,
      packFingerprint: pre.pack.packFingerprint,
      generationRunId: pre.generationRunId,
      provider: "grok",
      rawPath: candidatePath,
      rawSha256,
      executionReceiptPath: receiptPath,
      expectedRevision: pre.pack.unitRevision,
      executionReceipt,
    },
  },
});

const commitResult = committed.result;
console.log(JSON.stringify({
  commitStatus: committed.status,
  generationRunId: pre.generationRunId,
  rawSha256,
  pairComplete: commitResult?.results?.pairComplete,
  reviewPending: commitResult?.review,
  rawResultId: commitResult?.results?.raw?.resultId || commitResult?.rawResultId,
  labeledResultId: commitResult?.results?.labeled?.resultId || commitResult?.labeledResultId,
  commitResultKeys: Object.keys(commitResult || {}),
  commitResult,
}, null, 2));

await writeFile(path.join(work, "commit-result.json"), JSON.stringify({ committed, rawSha256, executionReceipt }, null, 2) + "\n");
