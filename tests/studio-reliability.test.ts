import { mkdtemp, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createManagedProject } from "../src/core/managed-project.js";
import {
  assertStudioWriteContext,
  classifyStudioWriteFault,
  evaluateStudioFaultMatrix,
  preflightStudioDisk,
  probeStudioScale,
} from "../src/core/studio-reliability.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("P9 运行可靠性", () => {
  it("写上下文强制 projectId/projectRoot，拒绝跨根与错误 provider", async () => {
    const parent = await realpath(await mkdtemp(path.join("/tmp", "studio-p9-ctx-")));
    roots.push(parent);
    const project = await createManagedProject({ parentRoot: parent, name: "P9 上下文" });
    const expected = { projectRoot: project.paths.root, projectId: project.project.id };

    expect(assertStudioWriteContext(expected, {
      projectRoot: project.paths.root,
      projectId: project.project.id,
      provider: "codex-imagegen",
      requestId: "req-1",
      idempotencyKey: "idem-1",
    })).toBeNull();

    expect(assertStudioWriteContext(expected, {
      projectRoot: "/tmp/other",
      projectId: project.project.id,
      provider: "none",
      requestId: "req-2",
      idempotencyKey: "idem-2",
    })?.kind).toBe("cross-root-denied");

    expect(assertStudioWriteContext(expected, {
      projectRoot: project.paths.root,
      projectId: project.project.id,
      provider: "artlist" as any,
      requestId: "req-3",
      idempotencyKey: "idem-3",
    })?.kind).toBe("provider-mismatch");
  });

  it("故障矩阵覆盖 revision/duplicate/cancel/timeout/sha/unknown", () => {
    const matrix = evaluateStudioFaultMatrix([
      { name: "rev", error: new Error("修订冲突 expectedRevision") },
      { name: "dup", error: new Error("幂等键 duplicate") },
      { name: "cancel", error: new Error("任务已取消") },
      { name: "timeout", error: new Error("timeout after 30s") },
      { name: "sha", error: new Error("SHA 漂移") },
      { name: "unk", error: new Error("weird failure") },
    ]);
    expect(matrix.map((item) => item.fault.kind)).toEqual([
      "revision-conflict",
      "duplicate-request",
      "cancelled",
      "timeout",
      "sha-drift",
      "unknown-reconciliation",
    ]);
    expect(classifyStudioWriteFault(new Error("CAS mismatch")).retryable).toBe(true);
  });

  it("磁盘预检与规模探针在空工程上可运行且不改库", async () => {
    const parent = await realpath(await mkdtemp(path.join("/tmp", "studio-p9-probe-")));
    roots.push(parent);
    const project = await createManagedProject({ parentRoot: parent, name: "P9 探针" });
    const preflight = await preflightStudioDisk(project.paths.root);
    expect(preflight.kind).toBe("studio-disk-preflight");
    expect(preflight.filesystem.availableBytes).toBeGreaterThan(0);
    expect(preflight.fingerprint).toMatch(/^[a-f0-9]{64}$/u);

    const scale = await probeStudioScale(project.paths.root);
    expect(scale.counts.units).toBe(0);
    expect(scale.dashboard.unitsHardCap).toBe(36);
    expect(scale.dashboard.unitsPageSize).toBeLessThanOrEqual(36);
  });
});
