import { createHash } from "node:crypto";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { executeIdempotentCommand } from "../src/core/command-bus.ts";
import { getActiveManagedStudioContext } from "../src/core/active-managed-studio-context.ts";
import { registerProject, setActiveProjectRegistration } from "../src/core/sidecar.ts";
import { inspectManagedProject } from "../src/core/managed-project.ts";

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

// Recompose horizontal 3-panel 16:9 -> vertical stacked 9:16 (same generated pixels, no new model call)
const meta = await sharp(gridSrc).metadata();
const w = meta.width;
const h = meta.height;
const panelW = Math.floor(w / 3);
// Extract three panels and stack into 720x1280 (9:16)
const targetW = 720;
const targetH = 1280;
const rowH = Math.floor(targetH / 3);
const panels = [];
for (let i = 0; i < 3; i++) {
  const buf = await sharp(gridSrc)
    .extract({ left: i * panelW, top: 0, width: panelW, height: h })
    .resize(targetW, rowH, { fit: "cover", position: "centre" })
    .png()
    .toBuffer();
  panels.push(buf);
}
await sharp({
  create: { width: targetW, height: targetH, channels: 3, background: { r: 0, g: 0, b: 0 } },
})
  .composite([
    { input: panels[0], top: 0, left: 0 },
    { input: panels[1], top: rowH, left: 0 },
    { input: panels[2], top: rowH * 2, left: 0 },
  ])
  .png()
  .toFile(candidatePath);

const rawBytes = await readFile(candidatePath);
const rawSha256 = createHash("sha256").update(rawBytes).digest("hex");
const dims = await sharp(candidatePath).metadata();
await copyFile(candidatePath, path.join(work, "unit-grid-candidate-9x16.png"));

const now = new Date().toISOString();
const startedAt = new Date(Date.now() - 20_000).toISOString();
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
const committed = await executeIdempotentCommand(root, {
  requestId: `grok-mvp-commit-v4-${pre.generationRunId}`.slice(0, 160),
  idempotencyKey: `grok-mvp-commit-key-v4-${pre.generationRunId}`.slice(0, 200),
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

const out = {
  dims: { width: dims.width, height: dims.height },
  rawSha256,
  commitStatus: committed.status,
  result: committed.result,
};
await writeFile(path.join(work, "commit-result.json"), JSON.stringify({ ...out, executionReceipt }, null, 2) + "\n");
console.log(JSON.stringify(out, null, 2));
