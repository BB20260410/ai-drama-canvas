import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  finalizeIsolatedPackageTerminalEvidence,
  isolatedPackageCompletionMarkerPath,
  readCompletedIsolatedPackageTerminalEvidence,
} from "../scripts/lib/isolated-package-terminal-finalizer.mjs";

describe("隔离 package terminal evidence 两阶段终结", () => {
  async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
    const root = await mkdtemp(path.join(os.tmpdir(), "aic-terminal-finalizer-"));
    try {
      await run(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  it("PASS 先写 pending terminal，release 后才写 completion marker", async () => withRoot(async (root) => {
    const evidencePath = path.join(root, "pass.json");
    const lockPath = `${evidencePath}.lock`;
    const observed: string[] = [];
    await writeFile(lockPath, "held\n", "utf8");
    const result = await finalizeIsolatedPackageTerminalEvidence({
      evidencePath,
      lockPath,
      runId: "run-pass",
      outcome: "passed",
      terminalEvidence: { schemaVersion: 1, kind: "fixture", status: "passed" },
      async releaseLock() {
        const provisional = JSON.parse(await readFile(evidencePath, "utf8"));
        expect(provisional.status).toBe("finalization-pending");
        expect(provisional.outcome).toBe("passed");
        expect(provisional.lockPath).toBe(lockPath);
        expect(provisional.finalization).toMatchObject({ lockReleasePending: true, completed: false });
        expect(await readdir(root)).not.toContain(path.basename(isolatedPackageCompletionMarkerPath(evidencePath)));
        expect(await readFile(lockPath, "utf8")).toBe("held\n");
        await rm(lockPath);
        observed.push("release");
      },
    });

    observed.push("returned");
    expect(observed).toEqual(["release", "returned"]);
    expect(result.completion.status).toBe("passed");
    expect(result.completion.lockReleased).toBe(true);
    expect(result.completion).toMatchObject({ lockPath, lockAbsent: true });
    await expect(readCompletedIsolatedPackageTerminalEvidence(evidencePath))
      .resolves.toMatchObject({ completion: { runId: "run-pass", status: "passed", lockReleased: true } });
  }));

  it("finalizer 拒绝空 runId，且不落任何伪终态", async () => withRoot(async (root) => {
    const evidencePath = path.join(root, "empty-run-id.json");
    let releaseCalls = 0;
    await expect(finalizeIsolatedPackageTerminalEvidence({
      evidencePath,
      lockPath: `${evidencePath}.lock`,
      runId: "  ",
      outcome: "failed",
      terminalEvidence: { schemaVersion: 1, kind: "fixture", status: "failed" },
      async releaseLock() { releaseCalls += 1; },
    })).rejects.toThrow(/runId/u);

    expect(releaseCalls).toBe(0);
    expect(await readdir(root)).toEqual([]);
  }));

  it("拒绝伪 lockPath，真实 canonical lock 仍存在时不能签发 completion", async () => withRoot(async (root) => {
    const evidencePath = path.join(root, "fake-lock-path.json");
    const canonicalLockPath = `${evidencePath}.lock`;
    await writeFile(canonicalLockPath, "held\n", "utf8");

    await expect(finalizeIsolatedPackageTerminalEvidence({
      evidencePath,
      lockPath: `${evidencePath}.fake-lock`,
      runId: "run-fake-lock",
      outcome: "passed",
      terminalEvidence: { schemaVersion: 1, kind: "fixture", status: "passed" },
      async releaseLock() {},
    })).rejects.toThrow(/lockPath|canonical|规范/u);

    expect(await readFile(canonicalLockPath, "utf8")).toBe("held\n");
    await expect(readFile(isolatedPackageCompletionMarkerPath(evidencePath), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  }));

  it("FAIL 也留 terminal+completion，且不伪装 PASS", async () => withRoot(async (root) => {
    const evidencePath = path.join(root, "fail.json");
    const result = await finalizeIsolatedPackageTerminalEvidence({
      evidencePath,
      lockPath: `${evidencePath}.lock`,
      runId: "run-fail",
      outcome: "failed",
      terminalEvidence: { schemaVersion: 1, kind: "fixture", status: "failed", error: "boom" },
      async releaseLock() {},
    });

    expect(result.terminal).toMatchObject({ status: "finalization-pending", outcome: "failed" });
    expect(result.completion).toMatchObject({ status: "failed", lockReleased: true });
    await expect(readCompletedIsolatedPackageTerminalEvidence(evidencePath))
      .resolves.toMatchObject({ terminal: { error: "boom" }, completion: { status: "failed" } });
  }));

  it("release reject 时命令失败，durable terminal 保留且无可验证 PASS marker", async () => withRoot(async (root) => {
    const evidencePath = path.join(root, "release-reject.json");
    await expect(finalizeIsolatedPackageTerminalEvidence({
      evidencePath,
      lockPath: `${evidencePath}.lock`,
      runId: "run-release-reject",
      outcome: "passed",
      terminalEvidence: { schemaVersion: 1, kind: "fixture", status: "passed" },
      async releaseLock() { throw new Error("unlink lock failed"); },
    })).rejects.toThrow(/unlink lock failed/u);

    const terminal = JSON.parse(await readFile(evidencePath, "utf8"));
    expect(terminal).toMatchObject({
      status: "finalization-pending",
      outcome: "passed",
      finalization: { lockReleasePending: true, completed: false },
    });
    await expect(readFile(isolatedPackageCompletionMarkerPath(evidencePath), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(readCompletedIsolatedPackageTerminalEvidence(evidencePath))
      .rejects.toThrow(/completion marker/u);
  }));

  it("同路径 EEXIST 不覆盖旧证据，仍尝试 release 收敛本轮锁", async () => withRoot(async (root) => {
    const evidencePath = path.join(root, "existing.json");
    const sentinel = "{\"status\":\"old-pass\"}\n";
    let releaseCalls = 0;
    await writeFile(evidencePath, sentinel, "utf8");

    await expect(finalizeIsolatedPackageTerminalEvidence({
      evidencePath,
      lockPath: `${evidencePath}.lock`,
      runId: "run-eexist",
      outcome: "failed",
      terminalEvidence: { schemaVersion: 1, kind: "fixture", status: "failed" },
      async releaseLock() { releaseCalls += 1; },
    })).rejects.toMatchObject({ code: "EEXIST" });

    expect(releaseCalls).toBe(1);
    expect(await readFile(evidencePath, "utf8")).toBe(sentinel);
    expect(await readdir(root)).toEqual(["existing.json"]);
  }));

  it("completion marker 同路径 EEXIST 时不覆盖，且旧 marker 不能认证新 terminal", async () => withRoot(async (root) => {
    const evidencePath = path.join(root, "marker-existing.json");
    const completionPath = isolatedPackageCompletionMarkerPath(evidencePath);
    const sentinel = "{\"status\":\"old-marker\"}\n";
    await writeFile(completionPath, sentinel, "utf8");

    await expect(finalizeIsolatedPackageTerminalEvidence({
      evidencePath,
      lockPath: `${evidencePath}.lock`,
      runId: "run-marker-eexist",
      outcome: "passed",
      terminalEvidence: { schemaVersion: 1, kind: "fixture", status: "passed" },
      async releaseLock() {},
    })).rejects.toMatchObject({ code: "EEXIST" });

    expect(await readFile(completionPath, "utf8")).toBe(sentinel);
    await expect(readCompletedIsolatedPackageTerminalEvidence(evidencePath)).rejects.toThrow();
  }));

  it("completion marker 必须绑定 terminal hash 与 runId", async () => withRoot(async (root) => {
    const evidencePath = path.join(root, "hash-binding.json");
    await finalizeIsolatedPackageTerminalEvidence({
      evidencePath,
      lockPath: `${evidencePath}.lock`,
      runId: "run-hash-binding",
      outcome: "passed",
      terminalEvidence: { schemaVersion: 1, kind: "fixture", status: "passed" },
      async releaseLock() {},
    });
    await writeFile(evidencePath, `${JSON.stringify({
      runId: "run-tampered",
      lockPath: `${evidencePath}.lock`,
      status: "finalization-pending",
      outcome: "passed",
      finalization: {
        state: "terminal-written-lock-release-pending",
        completionMarkerPath: isolatedPackageCompletionMarkerPath(evidencePath),
        lockReleasePending: true,
        completed: false,
      },
    })}\n`, "utf8");

    await expect(readCompletedIsolatedPackageTerminalEvidence(evidencePath))
      .rejects.toThrow(/completion marker.*terminal evidence/u);
  }));

  it("回读拒绝缺失 runId 的自洽 hash/marker", async () => withRoot(async (root) => {
    const evidencePath = path.join(root, "missing-run-id.json");
    const lockPath = `${evidencePath}.lock`;
    const terminal = {
      runId: "",
      lockPath,
      status: "finalization-pending",
      outcome: "failed",
      finalization: {
        state: "terminal-written-lock-release-pending",
        completionMarkerPath: isolatedPackageCompletionMarkerPath(evidencePath),
        lockReleasePending: true,
        completed: false,
      },
    };
    const serializedTerminal = `${JSON.stringify(terminal)}\n`;
    await writeFile(evidencePath, serializedTerminal, "utf8");
    await writeFile(isolatedPackageCompletionMarkerPath(evidencePath), `${JSON.stringify({
      schemaVersion: 1,
      kind: "isolated-package-smoke-completion",
      runId: "",
      terminalEvidencePath: evidencePath,
      terminalEvidenceSha256: createHash("sha256").update(serializedTerminal).digest("hex"),
      lockPath,
      lockAbsent: true,
      status: "failed",
      lockReleased: true,
      completedAt: new Date().toISOString(),
    })}\n`, "utf8");

    await expect(readCompletedIsolatedPackageTerminalEvidence(evidencePath)).rejects.toThrow(/runId/u);
  }));
});
