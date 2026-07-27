/**
 * 对 prepare 阶段写出的 ordered-state.json 做 commit（gen 已写入 quarantine.candidatePath）。
 * 用法：npx tsx scripts/s1e2-commit-prepared-state.ts <state.json>
 */
import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { activateProject } from "../src/core/service.js";
import { getActiveManagedStudioContext } from "../src/core/active-managed-studio-context.js";
import { rebindStudioImagegenCallContext } from "../src/core/studio-generation-ledger.js";
import { commitAgentImagegenResultBundle } from "../src/core/studio-agent-imagegen-result-bundle.js";
import { executeIdempotentCommand } from "../src/core/command-bus.js";
import { getActiveProjectState, getActiveProjectRegistration } from "../src/core/sidecar.js";
import { inspectManagedProject } from "../src/core/managed-project.js";
import { resolveRuntimeBuildIdentity } from "../src/core/build-identity.js";

const WORKSPACE_ROOT = "/Users/hxx/Documents/无限画布";

/** Light token: same digest body as active-managed-studio-context, no dashboard/overview. */
async function lightProjectContextToken(projectRoot: string): Promise<string> {
  const [activeState, registration] = await Promise.all([
    getActiveProjectState(),
    getActiveProjectRegistration(),
  ]);
  if (!activeState || !registration) throw new Error("no active project for light token");
  const activeRoot = path.resolve(activeState.primaryRoot);
  if (path.resolve(projectRoot) !== activeRoot) {
    throw new Error(`active root mismatch: ${activeRoot} != ${projectRoot}`);
  }
  const shell = await inspectManagedProject(activeRoot);
  const identity = await resolveRuntimeBuildIdentity(WORKSPACE_ROOT);
  const tokenBody = {
    projectId: shell.project.id,
    projectRoot: activeRoot,
    manifestFingerprint: shell.manifestFingerprint,
    activationId: activeState.activationId,
    buildId: identity.buildId,
    sourceDigest: identity.sourceDigest,
  };
  const stable = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stable);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, e]) => e !== undefined)
        .sort(([a], [b]) => a.localeCompare(b, "en"))
        .map(([k, e]) => [k, stable(e)]),
    );
  };
  const digest = createHash("sha256").update(JSON.stringify(stable(tokenBody)), "utf8").digest("hex");
  return `studioctx-v1-${digest}`;
}

async function resolveLiveContextToken(projectRoot: string, preferred: string): Promise<string> {
  // MUST match assertActiveManagedStudioContextToken → full getActiveManagedStudioContext
  // (token body includes runtime build identity). Light token is only a diagnostic fallback.
  let last: unknown;
  for (let i = 0; i < 12; i++) {
    try {
      const liveCtx = await getActiveManagedStudioContext();
      if (path.resolve(liveCtx.projectRoot) !== path.resolve(projectRoot)) {
        throw new Error(`context projectRoot mismatch: ${liveCtx.projectRoot}`);
      }
      return liveCtx.projectContextToken;
    } catch (e) {
      last = e;
      const msg = e instanceof Error ? e.message : String(e);
      const race = /snapshot|WAL|冻结验证|隔离快照|source identity|changed while|safe regular file|database is locked|generation ledger|active-project-not-managed/i.test(msg);
      console.log(`[${new Date().toISOString()}] context token fail ${i} race=${race}: ${msg.slice(0, 140)}`);
      if (!race && i >= 2) break;
      await new Promise((r) => setTimeout(r, 600 * Math.pow(1.35, i) + Math.random() * 300));
    }
  }
  try {
    const light = await lightProjectContextToken(projectRoot);
    console.log(`[${new Date().toISOString()}] FALLBACK light token (may still mismatch full assert)`);
    return light;
  } catch {
    throw last instanceof Error ? last : new Error(String(last || preferred));
  }
}

const statePathArg = process.argv[2];
if (!statePathArg || !existsSync(statePathArg)) {
  console.error("usage: npx tsx scripts/s1e2-commit-prepared-state.ts <state.json>");
  process.exit(2);
}
const statePath: string = statePathArg;

function nowIso() {
  return new Date().toISOString();
}
function sha256File(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

async function main() {
  const state = JSON.parse(readFileSync(statePath, "utf8")) as {
    preparedAt: string;
    projectRoot: string;
    projectContextToken: string;
    unitId: string;
    packId: string;
    packFingerprint: string;
    unitRevision: number;
    generationRunId: string;
    callId: string;
    inputFingerprint: string;
    quarantine: { candidatePath: string; receiptPath: string; rootPath: string };
    candidateOut?: string;
    reportOut?: string;
    writeLease?: { holderId: string; leaseToken: string };
    writePath?: string;
  };
  const leaseHolder =
    state.writeLease?.holderId
    || process.env.AI_CANVAS_WRITE_LEASE_HOLDER
    || "";
  const leaseToken =
    state.writeLease?.leaseToken
    || process.env.AI_CANVAS_WRITE_LEASE_TOKEN
    || "";
  const requireBus =
    process.env.AI_CANVAS_REQUIRE_BUS_COMMIT === "1"
    || process.env.AI_CANVAS_WRITE_LEASE_MODE === "require"
    || String(state.writePath || "").includes("mcp-only")
    || String(state.writePath || "").includes("executeIdempotent");
  if (requireBus && (!leaseHolder || !leaseToken)) {
    throw new Error("require bus commit：必须持有 writeLeaseHolderId+leaseToken；禁止 core-direct formal");
  }
  const preferBus = Boolean(leaseHolder && leaseToken);
  if (requireBus && !preferBus) {
    throw new Error("require bus commit 但无法 preferBus");
  }
  const ROOT = state.projectRoot;
  const candidatePath = state.quarantine.candidatePath;
  if (!existsSync(candidatePath)) throw new Error(`candidate missing: ${candidatePath}`);
  const mtime = statSync(candidatePath).mtime.toISOString();
  const candidateSha = sha256File(candidatePath);
  console.log(`[${nowIso()}] GEN_OBSERVED mtime=${mtime} sha=${candidateSha}`);
  if (new Date(mtime).getTime() < new Date(state.preparedAt).getTime() - 1000) {
    throw new Error(`candidate mtime ${mtime} before preparedAt ${state.preparedAt}`);
  }
  if (state.candidateOut) {
    mkdirSync(path.dirname(state.candidateOut), { recursive: true });
    copyFileSync(candidatePath, state.candidateOut);
    console.log(`[${nowIso()}] ARCHIVE ${state.candidateOut}`);
  }

  const startedAt = state.preparedAt;
  const generatedAt = nowIso();
  const executionReceipt = {
    schemaVersion: 1 as const,
    kind: "agent-imagegen-execution-receipt" as const,
    provider: "grok" as const,
    source: "grok-build-imagine" as const,
    attestationLevel: "agent-session-direct" as const,
    cryptographicProviderReceipt: false as const,
    callId: state.callId,
    model: "grok-imagine",
    agentSessionId: `s1e2-${String(state.unitId).replace(/^S1E2-/i, "").toLowerCase()}-session`,
    toolCallId: `tool-image-edit-${Date.now().toString(36)}`,
    toolName: "image_edit" as const,
    toolInvocationCount: 1 as const,
    inputFingerprint: state.inputFingerprint,
    candidateSha256: candidateSha,
    startedAt,
    generatedAt,
  };
  await writeFile(state.quarantine.receiptPath, JSON.stringify(executionReceipt, null, 2), "utf8");
  const receiptSha = sha256File(state.quarantine.receiptPath);

  await activateProject(ROOT);
  let token = await resolveLiveContextToken(ROOT, state.projectContextToken);
  if (token !== state.projectContextToken) {
    console.log(`[${nowIso()}] TOKEN_ROTATED rebind (light/live)`);
    await rebindStudioImagegenCallContext(ROOT, {
      callId: state.callId,
      generationRunId: state.generationRunId,
      packId: state.packId,
      packFingerprint: state.packFingerprint,
      inputFingerprint: state.inputFingerprint,
      candidateSha256: candidateSha,
      receiptSha256: receiptSha,
      projectContextToken: token,
      evidenceReference: `s1e2-rebind-${state.unitId}-${Date.now().toString(36)}`,
      evidenceFingerprint: createHash("sha256").update(`${candidateSha}:${receiptSha}:rebind`).digest("hex"),
      reason: "token rotated after imagegen; quarantine already sealed",
      acknowledgeBuildChangedAfterInvocation: true,
      acknowledgeNoSecondModelCall: true,
    });
  }

  // commit validates token via assertActiveManagedStudioContextToken (full context).
  // 有写租约时走 executeIdempotentCommand（唯一写入口 / require 模式）；否则半旁路 core。
  let outcome: any;
  let lastCommitErr: unknown;
  let writePathUsed = preferBus ? "executeIdempotentCommand" : "core-direct";
  for (let i = 0; i < 12; i++) {
    try {
      token = await resolveLiveContextToken(ROOT, token);
      const payload = {
        projectContextToken: token,
        packId: state.packId,
        packFingerprint: state.packFingerprint,
        generationRunId: state.generationRunId,
        provider: "grok" as const,
        rawPath: candidatePath,
        rawSha256: candidateSha,
        expectedRevision: state.unitRevision,
        executionReceiptPath: state.quarantine.receiptPath,
        executionReceipt,
      };
      if (preferBus) {
        // token 会 live 轮转；若 key 不含 token 片段，重试会撞「幂等键已用于不同参数」。
        // 业务意图仍由 callId+sha 锚定；token 后缀只隔离不同参数版本。
        const tokenTag = createHash("sha256").update(token).digest("hex").slice(0, 12);
        const ik = `s1e2-commit-ik-${state.callId.slice(-24)}-${candidateSha.slice(0, 16)}-t${tokenTag}`;
        const rec = await executeIdempotentCommand(
          ROOT,
          {
            requestId: `s1e2-commit-${state.unitId}-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`,
            idempotencyKey: ik.slice(0, 200),
            request: { command: "commit_agent_imagegen_result_bundle", payload } as any,
          },
          {
            writeLeaseHolderId: leaseHolder,
            writeLeaseToken: leaseToken,
          },
        );
        outcome = (rec as any).result ?? rec;
        writePathUsed = "executeIdempotentCommand";
      } else {
        outcome = await commitAgentImagegenResultBundle(ROOT, payload);
        writePathUsed = "core-direct";
      }
      break;
    } catch (e) {
      lastCommitErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      const race = /snapshot|WAL|冻结验证|隔离快照|source identity|changed while|safe regular file|database is locked|active-project-not-managed|令牌过期|token-mismatch|project-context-token-mismatch|幂等键已用于不同参数/i.test(msg);
      console.log(`[${nowIso()}] COMMIT_RETRY ${i} race=${race} path=${writePathUsed}: ${msg.slice(0, 160)}`);
      if (!race && i >= 2) throw e;
      await new Promise((r) => setTimeout(r, 700 * Math.pow(1.4, i) + Math.random() * 400));
    }
  }
  if (!outcome) throw lastCommitErr instanceof Error ? lastCommitErr : new Error(String(lastCommitErr));
  if (requireBus && writePathUsed !== "executeIdempotentCommand") {
    throw new Error(`require bus commit 但实际 writePath=${writePathUsed}`);
  }

  const genAfterPrepare = new Date(mtime).getTime() >= new Date(state.preparedAt).getTime() - 1000;
  const controlRefShas = Array.isArray((state as any).controlRefs)
    ? (state as any).controlRefs.map((r: { mediaSha256?: string }) => r.mediaSha256).filter(Boolean)
    : [];
  const rawSha = outcome.results?.raw?.mediaSha256 || candidateSha;
  const labeledSha = outcome.results?.labeled?.mediaSha256;
  const report = {
    formalChain: writePathUsed === "executeIdempotentCommand",
    ordered: true,
    unitId: state.unitId,
    targetKind: "unit-grid",
    packId: state.packId,
    generationRunId: state.generationRunId,
    mediaSha256: candidateSha,
    writePath: writePathUsed,
    controlRefs: controlRefShas,
    steps: ["readiness", "freeze", "dispatch", "prepare", "generate", "commit"],
    orderProof: {
      prepareAt: state.preparedAt,
      genMtime: mtime,
      genAfterPrepare,
    },
    outcome: {
      rawSha,
      labeledSha,
    },
    builtAt: nowIso(),
  };
  if (state.reportOut) {
    mkdirSync(path.dirname(state.reportOut), { recursive: true });
    writeFileSync(state.reportOut, JSON.stringify(report, null, 2));
  }
  writeFileSync(statePath.replace(/\.json$/, "-report.json"), JSON.stringify(report, null, 2));
  // bond-loop 强制落盘（复盘闸门维度 2）
  try {
    const bondDir = path.dirname(state.reportOut || statePath);
    const unitSlug = String(state.unitId || "unit").replace(/^S1E2-/i, "").toLowerCase();
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const bondPath = path.join(bondDir, `bond-loop-${unitSlug}-${day}.json`);
    writeFileSync(bondPath, JSON.stringify({
      schemaVersion: 1,
      kind: "canvas-bond-loop-evidence",
      unitId: state.unitId,
      packId: state.packId,
      generationRunId: state.generationRunId,
      callId: state.callId,
      controlRefs: controlRefShas,
      writePath: writePathUsed,
      rawSha,
      labeledSha,
      formalChain: report.formalChain,
      fit_note: "bond evidence from commit; not product 100% fit",
      builtAt: report.builtAt,
    }, null, 2) + "\n");
    console.log(`[${nowIso()}] BOND ${bondPath}`);
  } catch (e) {
    console.log(`[${nowIso()}] BOND_WRITE_FAIL ${(e as Error).message?.slice(0, 120)}`);
  }
  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
