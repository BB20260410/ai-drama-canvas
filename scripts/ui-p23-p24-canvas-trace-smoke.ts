/**
 * P23/P24 GLOBAL_VALIDATING 真实 Electron 验收（规范 NOT_RUN 项）：
 * 相位1（full）：画布单拖吸附参考线/松手清零、undo/redo、组拖不出线+队形保持、U1 冻结包身份/U2 分类/U3 Review 身份/U4 修订历史。
 * 相位2（undo-empty，重启）：undo/redo 按钮禁用（栈不跨会话）。
 * 相位3（undo-empty，切工程）：激活另一工程，undo/redo 按钮禁用。
 * 全部隔离目录+隔离 userData；不写正式工程；结果落 docs/evidence（同一 sourceDigest）。
 */
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const workspace = path.resolve(process.cwd());
const electron = path.join(workspace, "node_modules", ".bin", "electron");
const evidencePath = path.resolve(process.argv[2] ?? path.join(workspace, "docs/evidence/p23-p24-electron-smoke-20260720.json"));
const screenshotPath = path.resolve(process.argv[3] ?? path.join(workspace, "docs/evidence/p23-p24-electron-smoke-20260720.png"));
const registryPath = path.join(os.tmpdir(), `p23-p24-smoke-registry-${process.pid}.json`);
const userDataDir = path.join(os.tmpdir(), `p23-p24-smoke-userdata-${process.pid}`);

// 注册表路径必须在任何 core 模块求值前设定（sidecar/managed-project 于 import 时读取）。
process.env.AI_CANVAS_REGISTRY_PATH = registryPath;

const { createManagedProject, inspectManagedProject } = await import("../src/core/managed-project.js");
const { submitStudioGenerationReview } = await import("../src/core/studio-generation-review.js");
const { readStudioGenerationFrozenPack } = await import("../src/core/studio-generation-ledger.js");
const { registerProject, setActiveProjectRegistration } = await import("../src/core/sidecar.js");
const { computeSourceDigest } = await import("../src/core/build-identity.js");
const {
  createStudioP24TraceFixture,
  dispatchAndRegisterP24Pair,
  freezeP24Pack,
} = await import("../tests/helpers/studio-p24-trace-fixture.js");

interface ProbeDebug {
  p2324Probe?: {
    ok?: boolean;
    checks?: Record<string, boolean>;
    notes?: Record<string, unknown>;
    error?: string;
  };
}

async function launchProbe(mode: "full" | "undo-empty", delayMs: number): Promise<ProbeDebug> {
  const env = {
    ...process.env,
    AI_CANVAS_REGISTRY_PATH: registryPath,
    AI_CANVAS_SCREENSHOT: screenshotPath,
    AI_CANVAS_SCREENSHOT_DELAY_MS: String(delayMs),
    AI_CANVAS_P23_P24_PROBE: "1",
    AI_CANVAS_P23_P24_MODE: mode,
    AI_CANVAS_WINDOW_WIDTH: "1560",
    AI_CANVAS_WINDOW_HEIGHT: "980",
  };
  await execFileAsync(electron, [".", `--user-data-dir=${userDataDir}`], {
    cwd: workspace,
    env,
    timeout: delayMs + 90_000,
    maxBuffer: 4_000_000,
  });
  return JSON.parse(await readFile(`${screenshotPath}.debug.json`, "utf8")) as ProbeDebug;
}

function assertProbeOk(debug: ProbeDebug, phase: string): void {
  const probe = debug.p2324Probe;
  if (!probe) throw new Error(`${phase}：Electron 未写出 p2324Probe。`);
  if (!probe.ok) {
    const failed = Object.entries(probe.checks ?? {}).filter(([, value]) => !value).map(([name]) => name);
    throw new Error(`${phase} 探针失败：${probe.error ?? failed.join("、")}；notes=${JSON.stringify(probe.notes).slice(0, 800)}`);
  }
}

// ---- 相位 0：夹具（受管工程+冻结包+派发登记+Review） ----
const fixture = await createStudioP24TraceFixture();
const pack = await freezeP24Pack(fixture, fixture.units.two, 1);
const { rawResultId, labeledResultId } = await dispatchAndRegisterP24Pair(fixture, pack, "p23-p24-smoke-run-0001");
const frozen = await readStudioGenerationFrozenPack(fixture.root, pack.packId);
if (!frozen) throw new Error("冻结包读取失败。");
const media = fixture.p7.panelMediaPairs[0]!;
await submitStudioGenerationReview(fixture.root, {
  generationRunId: "p23-p24-smoke-run-0001",
  kind: "observation",
  expectedHeadRevision: 0,
  rawResultId,
  rawSha256: media.raw.imported.sha256,
  labeledResultId,
  labeledSha256: media.labeled.imported.sha256,
  expectedPackFingerprint: pack.fingerprint,
  continuityFingerprint: frozen.continuity.fingerprint,
  decision: "rework",
  criteria: [{ code: "face", status: "fail", note: "smoke 机械批注，不代表视觉验收" }],
  reviewer: "user",
  note: "P23/P24 GLOBAL_VALIDATING smoke 批注",
  operationId: "p23-p24-smoke-review-op-0001",
});
// 第二工程（相位3切工程用）：仅建空受管工程。
const secondRoot = (await createManagedProject({ parentRoot: fixture.p7.parentRoot, name: "P23P24-smoke-second", slug: "p23p24-smoke-second" })).paths.root;
// 两工程登记进本 smoke 专用注册表（setActiveProjectRegistration 的前置条件）。
await registerProject(fixture.p7.shell.project);
await registerProject((await inspectManagedProject(secondRoot)).project);

const digest = await computeSourceDigest(workspace);
const evidence: Record<string, unknown> = {
  schemaVersion: 1,
  kind: "p23-p24-electron-smoke",
  sourceDigest: digest.sourceDigest,
  sourceFiles: digest.sourceFiles,
  sourceBytes: digest.sourceBytes,
  fixtureRoot: fixture.root,
  registryPath,
  phases: {},
};

// ---- 相位 1：full ----
await setActiveProjectRegistration(fixture.root);
const full = await launchProbe("full", 60_000);
assertProbeOk(full, "相位1 full");
(evidence.phases as Record<string, unknown>).full = full.p2324Probe;

// ---- 相位 2：重启后 undo 空 ----
await setActiveProjectRegistration(fixture.root);
const restart = await launchProbe("undo-empty", 15_000);
assertProbeOk(restart, "相位2 重启 undo 空");
(evidence.phases as Record<string, unknown>).restart = restart.p2324Probe;

// ---- 相位 3：切工程后 undo 空 ----
await setActiveProjectRegistration(secondRoot);
const switched = await launchProbe("undo-empty", 15_000);
assertProbeOk(switched, "相位3 切工程 undo 空");
(evidence.phases as Record<string, unknown>).switched = switched.p2324Probe;

await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
await fixture.p7.cleanup().catch(() => undefined);
process.stdout.write(`${JSON.stringify({ ok: true, evidencePath, screenshotPath, phases: Object.keys(evidence.phases as object) }, null, 2)}\n`);
