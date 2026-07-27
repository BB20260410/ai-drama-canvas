/**
 * S1E2 MCP-only 产线 runner（唯一写入口路径）。
 *
 * 与 per-unit / ordered-runner 半旁路不同：生图写全部经 executeIdempotentCommand + 写租约。
 * 禁止把 formal PASS 写成「与无限画布产品完美契合」。
 *
 * 用法：
 *   npx tsx scripts/s1e2-mcp-only-runner.ts prepare --unit S1E2-U15
 *   npx tsx scripts/s1e2-mcp-only-runner.ts commit --state <state.json>
 *   npx tsx scripts/s1e2-mcp-only-runner.ts attest-batch --batch 2
 *   npx tsx scripts/s1e2-mcp-only-runner.ts earliest
 *   npx tsx scripts/s1e2-mcp-only-runner.ts acquire|release|status
 *
 * create/bind 仍可用 per-unit 脚本（非 lease 闸命令）；prepare 起强制租约。
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { activateProject } from "../src/core/service.js";
import { getActiveManagedStudioContext } from "../src/core/active-managed-studio-context.js";
import { getStudioGenerationControlEnvelope } from "../src/core/codex.js";
import { executeIdempotentCommand } from "../src/core/command-bus.js";
import {
  acquireStudioProjectWriteLease,
  getStudioProjectWriteLease,
  releaseStudioProjectWriteLease,
} from "../src/core/studio-project-write-lease.js";
import { getStudioEpisodeEarliest } from "../src/core/studio-episode-earliest.js";
import { getStudioGenerationCheckpointControl } from "../src/core/studio-generation-checkpoint.js";
import { getStudioMedia } from "../src/core/material-studio.js";
import { readAnyStudioGenerationFrozenPack } from "../src/core/studio-generation-ledger.js";
import { getStudioProductionUnitSnapshot } from "../src/core/studio-production.js";
import { spawn } from "node:child_process";

const ROOT = "/Users/hxx/Documents/无限画布/projects/dudu-gaiden-lock-20260723-12a6516c";
const PROD = "/Users/hxx/Documents/无限画布/productions/dudu-gaiden/s1e2-grok-canvas-loop-20260723";
const SCRATCH = path.join(PROD, "05_canvas/_scratch");
const EVIDENCE = path.join(PROD, "05_canvas");
const HOLDER = "s1e2-mcp-only-runner";

// 本 runner 强制 require 写租约
process.env.AI_CANVAS_WRITE_LEASE_MODE = process.env.AI_CANVAS_WRITE_LEASE_MODE || "require";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function has(flag: string): boolean {
  return process.argv.includes(flag);
}
function log(m: string) {
  console.log(`[${new Date().toISOString()}] ${m}`);
}
async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}
function rid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

async function withRaceRetry<T>(label: string, fn: () => Promise<T>, max = 12): Promise<T> {
  let last: unknown;
  for (let i = 0; i < max; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      const msg = e instanceof Error ? e.message : String(e);
      const race = /snapshot|WAL|冻结|隔离|identity|changed while|safe regular|database is locked|ledger|lease-held/i.test(msg);
      log(`${label} fail ${i} race=${race}: ${msg.slice(0, 160)}`);
      if (!race && i >= 3) throw e;
      await sleep(700 * Math.pow(1.35, i));
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

async function acquireLease(note: string) {
  // 同 holder 已有租约：读盘续租；否则新获
  let existingToken: string | undefined;
  try {
    const proj = await getStudioProjectWriteLease(ROOT);
    if (proj.held && proj.lease?.holderId === HOLDER) {
      existingToken = proj.lease.leaseToken;
    }
  } catch { /* ignore */ }
  try {
    const lease = await acquireStudioProjectWriteLease(ROOT, {
      holderId: HOLDER,
      holderKind: "script",
      ttlSeconds: 30 * 60,
      note,
      ...(existingToken ? { leaseToken: existingToken } : {}),
    });
    log(`LEASE ${lease.leaseToken.slice(0, 18)}… exp=${lease.expiresAt}`);
    return lease;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes(HOLDER) || /lease-held/i.test(msg)) {
      const lease = await acquireStudioProjectWriteLease(ROOT, {
        holderId: HOLDER,
        holderKind: "script",
        ttlSeconds: 30 * 60,
        forceTakeover: true,
        takeoverReason: "mcp-only-runner 本机续跑接管自有写租约",
        note,
      });
      log(`LEASE takeover ${lease.leaseToken.slice(0, 18)}…`);
      return lease;
    }
    throw e;
  }
}

async function execCmd(
  command: string,
  payload: Record<string, unknown>,
  lease: { leaseToken: string },
  /** 稳定幂等键：race 重试必须同一 key，禁止每次 rid() */
  stableIdempotencyKey: string,
) {
  return executeIdempotentCommand(
    ROOT,
    {
      requestId: rid(`mcp-only-${command}`),
      idempotencyKey: stableIdempotencyKey.slice(0, 200),
      request: { command, payload } as any,
    },
    {
      writeLeaseHolderId: HOLDER,
      writeLeaseToken: lease.leaseToken,
    },
  );
}

async function resolveControlLocalPaths(packId: string) {
  const pack = await readAnyStudioGenerationFrozenPack(ROOT, packId);
  if (!pack) throw new Error("pack missing");
  const refs = (pack as any).request?.controlReferences ?? (pack as any).controlReferences ?? [];
  const out: Array<{ mediaSha256: string; localPath: string }> = [];
  for (const ref of refs) {
    const media = await getStudioMedia(ROOT, ref.mediaSha256);
    const alt = (media as any)?.objectPath;
    if (alt && existsSync(alt)) {
      out.push({ mediaSha256: ref.mediaSha256, localPath: alt });
      continue;
    }
    const localPath = path.join(ROOT, ".aicanvas/objects/sha256", ref.mediaSha256.slice(0, 2), ref.mediaSha256);
    if (!existsSync(localPath)) throw new Error(`CAS missing ${ref.mediaSha256}`);
    out.push({ mediaSha256: ref.mediaSha256, localPath });
  }
  return out;
}

async function cmdStatus() {
  await activateProject(ROOT);
  const [lease, gate, earliest] = await Promise.all([
    getStudioProjectWriteLease(ROOT),
    getStudioGenerationCheckpointControl(ROOT),
    getStudioEpisodeEarliest(ROOT, { season: "S1", episode: "S1E2", evidenceDir: EVIDENCE }),
  ]);
  console.log(JSON.stringify({
    writeLease: {
      held: lease.held,
      holderId: lease.lease?.holderId ?? null,
      expiresAt: lease.lease?.expiresAt ?? null,
      denialHint: lease.denialHint,
    },
    checkpoint: { newSlotDispatchAllowed: (gate as any).newSlotDispatchAllowed },
    earliest: {
      earliestUnitId: earliest.earliestUnitId,
      statusLine: earliest.statusLine,
      completedCount: earliest.completedUnitIds.length,
    },
    mode: process.env.AI_CANVAS_WRITE_LEASE_MODE,
    note: "formal PASS ≠ 产品完美契合",
  }, null, 2));
}

async function cmdPrepare(unitId: string) {
  mkdirSync(SCRATCH, { recursive: true });
  await activateProject(ROOT);
  const lease = await acquireLease(`mcp-only prepare ${unitId}`);
  try {
    const gate = await withRaceRetry("gate", () => getStudioGenerationCheckpointControl(ROOT));
    if ((gate as any).newSlotDispatchAllowed === false) {
      throw new Error(`six-image blocked batch=${(gate as any).blockingBatchNumber}`);
    }
    log(`GATE allowed=${(gate as any).newSlotDispatchAllowed}`);

    await withRaceRetry("readiness", async () => {
      const r = await getStudioGenerationControlEnvelope(ROOT, {
        operation: "readiness",
        targetKind: "unit-grid",
        unitId,
      });
      if ((r as any).status === "blocked") throw new Error(JSON.stringify(r).slice(0, 500));
      log(`READINESS ${(r as any).status}`);
      return r;
    });

    const unitSnap = await getStudioProductionUnitSnapshot(ROOT, unitId);
    if (!unitSnap) throw new Error(`unit missing ${unitId}`);
    const unitRevision = Math.max(1, Number(unitSnap.unit.revision) || 1);
    log(`UNIT rev=${unitRevision}`);

    const freezeRec = await withRaceRetry("freeze", () =>
      execCmd("freeze_studio_generation_pack", {
        targetKind: "unit-grid",
        unitId,
        expectedRevision: unitRevision,
      }, lease, `ik-freeze-${unitId}-rev${unitRevision}`),
    );
    const freeze = (freezeRec as any).result ?? freezeRec;
    const packId = freeze.pack?.id ?? freeze.id;
    const packFingerprint = freeze.pack?.fingerprint ?? freeze.fingerprint;
    const frozenUnitRevision = freeze.pack?.target?.unitRevision ?? unitRevision;
    if (!packId || !packFingerprint) throw new Error(`freeze missing: ${JSON.stringify(freezeRec).slice(0, 400)}`);
    log(`FREEZE ${packId}`);

    const controlRefs = await resolveControlLocalPaths(packId);
    // unitId 已是 S1E2-U17 → 用 u17 段，避免 s1e2-s1e2- 双前缀
    const unitSlug = unitId.replace(/^S1E2-/i, "").toLowerCase();
    const runId = `s1e2-${unitSlug}-mcp-grok-${Date.now().toString(36)}`;
    await withRaceRetry("dispatch", () =>
      execCmd("dispatch_studio_generation_pack", {
        packId,
        packFingerprint,
        generationRunId: runId,
        provider: "grok",
        expectedRevision: frozenUnitRevision,
      }, lease, `ik-dispatch-${runId}`),
    );
    log(`DISPATCH ${runId}`);

    await sleep(1000);
    let ctx = await withRaceRetry("context", () => getActiveManagedStudioContext());
    const preparedRec = await withRaceRetry("prepare", async () => {
      ctx = await getActiveManagedStudioContext();
      // schema: 仅 token/pack/run/provider/expectedRevision=0（strict，禁 commandRequestId）
      return execCmd("prepare_studio_imagegen_call", {
        packId,
        packFingerprint,
        generationRunId: runId,
        provider: "grok",
        projectContextToken: ctx.projectContextToken,
        expectedRevision: 0,
      }, lease, `ik-prepare-${runId}`);
    }, 16);
    const prepared = (preparedRec as any).result ?? preparedRec;
    if (!prepared.callId) throw new Error(`prepare missing callId: ${JSON.stringify(preparedRec).slice(0, 400)}`);
    log(`PREPARE ${prepared.callId}`);

    const reportName = `s1e2-${unitId.slice(5).toLowerCase()}-symbiosis-report.json`;
    const state = {
      preparedAt: new Date().toISOString(),
      projectRoot: ROOT,
      projectContextToken: ctx.projectContextToken,
      unitId,
      packId,
      packFingerprint,
      unitRevision: frozenUnitRevision,
      generationRunId: runId,
      callId: prepared.callId,
      inputFingerprint: prepared.inputFingerprint,
      quarantine: prepared.quarantine,
      controlRefs,
      writeLease: { holderId: HOLDER, leaseToken: lease.leaseToken },
      writePath: "mcp-only-executeIdempotentCommand",
      candidateOut: path.join(PROD, `02_candidates/${unitId}_宫格_A1_CANDIDATE.jpg`),
      reportOut: path.join(EVIDENCE, reportName),
    };
    const statePath = path.join(SCRATCH, `s1e2-${unitId.slice(5).toLowerCase()}-ordered-state.json`);
    writeFileSync(statePath, JSON.stringify(state, null, 2));
    console.log(JSON.stringify({ ok: true, statePath, callId: prepared.callId, controlRefs, writePath: "mcp-only" }, null, 2));
  } finally {
    if (has("--release")) {
      await releaseStudioProjectWriteLease(ROOT, { holderId: HOLDER, leaseToken: lease.leaseToken });
      log("LEASE released");
    }
  }
}

async function cmdCommit(statePath: string) {
  if (!existsSync(statePath)) throw new Error(`missing ${statePath}`);
  const state = JSON.parse(readFileSync(statePath, "utf8")) as {
    writeLease?: { holderId: string; leaseToken: string };
    writePath?: string;
  };
  // 续租并 **使用返回的新 token** 注入子进程（禁止用过期 state token）
  let leaseToken = state.writeLease?.leaseToken || "";
  let holderId = state.writeLease?.holderId || HOLDER;
  try {
    if (leaseToken) {
      const renewed = await acquireStudioProjectWriteLease(ROOT, {
        holderId,
        holderKind: "script",
        leaseToken,
        ttlSeconds: 30 * 60,
        note: "mcp-only commit renew",
      });
      leaseToken = renewed.leaseToken;
      holderId = renewed.holderId;
    } else {
      const lease = await acquireLease("mcp-only commit");
      leaseToken = lease.leaseToken;
      holderId = lease.holderId;
    }
  } catch {
    const lease = await acquireLease("mcp-only commit re-acquire");
    leaseToken = lease.leaseToken;
    holderId = lease.holderId;
  }
  // 回写 state 上的租约，避免下次再丢
  state.writeLease = { holderId, leaseToken };
  writeFileSync(statePath, JSON.stringify(state, null, 2));

  process.env.AI_CANVAS_WRITE_LEASE_MODE = "require";
  await new Promise<void>((resolve, reject) => {
    const child = spawn("npx", ["tsx", "scripts/s1e2-commit-prepared-state.ts", statePath], {
      cwd: process.cwd(),
      stdio: "inherit",
      env: {
        ...process.env,
        AI_CANVAS_WRITE_LEASE_HOLDER: holderId,
        AI_CANVAS_WRITE_LEASE_TOKEN: leaseToken,
        AI_CANVAS_WRITE_LEASE_MODE: "require",
        AI_CANVAS_REQUIRE_BUS_COMMIT: "1",
      },
    });
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`commit exit ${code}`))));
  });
}

async function cmdAttestBatch(batchNumber: number) {
  await activateProject(ROOT);
  const lease = await acquireLease(`mcp-only attest batch ${batchNumber}`);
  try {
    // 委托 ordered-runner 的 attest 逻辑但带租约环境
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        "npx",
        ["tsx", "scripts/s1e2-ordered-runner.ts", "attest-batch", "--batch", String(batchNumber)],
        {
          cwd: process.cwd(),
          stdio: "inherit",
          env: {
            ...process.env,
            AI_CANVAS_WRITE_LEASE_MODE: "require",
            S1E2_ORDERED_LEASE_TOKEN: lease.leaseToken,
            S1E2_ORDERED_LEASE_HOLDER: HOLDER,
          },
        },
      );
      child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`attest exit ${code}`))));
    });
  } finally {
    if (has("--release")) {
      await releaseStudioProjectWriteLease(ROOT, { holderId: HOLDER, leaseToken: lease.leaseToken });
    }
  }
}

async function cmdEarliest() {
  await activateProject(ROOT);
  const e = await getStudioEpisodeEarliest(ROOT, {
    season: "S1",
    episode: "S1E2",
    evidenceDir: EVIDENCE,
  });
  console.log(JSON.stringify(e, null, 2));
}

async function main() {
  const mode = process.argv[2];
  if (mode === "status") {
    await cmdStatus();
    return;
  }
  if (mode === "acquire") {
    await activateProject(ROOT);
    const lease = await acquireLease(arg("--note") || "manual");
    console.log(JSON.stringify({ ok: true, holderId: HOLDER, leaseToken: lease.leaseToken, expiresAt: lease.expiresAt }, null, 2));
    return;
  }
  if (mode === "release") {
    await activateProject(ROOT);
    const token = arg("--token");
    if (!token) throw new Error("release --token lease-...");
    await releaseStudioProjectWriteLease(ROOT, { holderId: HOLDER, leaseToken: token });
    console.log(JSON.stringify({ ok: true, released: true }, null, 2));
    return;
  }
  if (mode === "prepare") {
    const unit = arg("--unit");
    if (!unit) throw new Error("prepare --unit S1E2-U15");
    await cmdPrepare(unit);
    return;
  }
  if (mode === "commit") {
    const state = arg("--state");
    if (!state) throw new Error("commit --state <path>");
    await cmdCommit(state);
    return;
  }
  if (mode === "attest-batch") {
    await cmdAttestBatch(Number(arg("--batch") || "2"));
    return;
  }
  if (mode === "earliest") {
    await cmdEarliest();
    return;
  }
  console.error(`usage:
  npx tsx scripts/s1e2-mcp-only-runner.ts status|acquire|release|earliest
  npx tsx scripts/s1e2-mcp-only-runner.ts prepare --unit S1E2-U15 [--release]
  npx tsx scripts/s1e2-mcp-only-runner.ts commit --state <state.json>
  npx tsx scripts/s1e2-mcp-only-runner.ts attest-batch --batch 2 [--release]
  # create/bind: scripts/s1e2-uNN-run.ts（半旁路）；生图写必须本 runner 或 MCP execute_command + 租约
  # formal PASS ≠ 产品完美契合`);
  process.exit(2);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
