/**
 * T15 单元级写租约测试。
 * 验证：acquire/release/query/过期自动清理/同 unitId 互斥。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { access, mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  acquireStudioUnitWriteLease,
  releaseStudioUnitWriteLease,
  getStudioUnitWriteLeases,
} from "../src/core/studio-project-write-lease.js";
import { SIDECAR_DIR } from "../src/core/constants.js";

let testRoot: string;

beforeEach(async () => {
  testRoot = await mkdtemp(path.join(tmpdir(), "t15-unit-lease-"));
  // 创建受管工程最小结构
  await mkdir(path.join(testRoot, SIDECAR_DIR), { recursive: true });
  const { writeFile } = await import("node:fs/promises");
  await writeFile(
    path.join(testRoot, SIDECAR_DIR, "project.json"),
    JSON.stringify({ id: "test-project", name: "test", schemaVersion: 1 }),
  );
});

afterEach(async () => {
  await rm(testRoot, { recursive: true, force: true });
});

describe("T15 单元级写租约", () => {
  it("空查询不创建 project lock 或其它侧车", async () => {
    const locksRoot = path.join(testRoot, SIDECAR_DIR, "locks");
    await expect(access(locksRoot)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(getStudioUnitWriteLeases(testRoot)).resolves.toMatchObject({
      entries: [],
      displayHint: null,
    });
    await expect(access(locksRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("acquire 后 query 返回活动条目", async () => {
    const entry = await acquireStudioUnitWriteLease(testRoot, {
      unitId: "u-001",
      holderId: "codex-agent-1",
      holderKind: "codex",
      mode: "generation",
    });
    expect(entry.unitId).toBe("u-001");
    expect(entry.holderId).toBe("codex-agent-1");
    expect(entry.holderKind).toBe("codex");
    expect(entry.mode).toBe("generation");

    const projection = await getStudioUnitWriteLeases(testRoot);
    expect(projection.kind).toBe("studio-unit-write-lease-projection");
    expect(projection.entries).toHaveLength(1);
    expect(projection.entries[0]!.unitId).toBe("u-001");
    expect(projection.displayHint).toContain("codex-agent-1");
    expect(projection.displayHint).toContain("u-001");
  });

  it("同 holder 续租幂等", async () => {
    await acquireStudioUnitWriteLease(testRoot, {
      unitId: "u-002",
      holderId: "codex-agent-1",
      holderKind: "codex",
    });
    // 同 holder 再次 acquire → 续租（不报错）
    const renewed = await acquireStudioUnitWriteLease(testRoot, {
      unitId: "u-002",
      holderId: "codex-agent-1",
      holderKind: "codex",
    });
    expect(renewed.unitId).toBe("u-002");

    const projection = await getStudioUnitWriteLeases(testRoot);
    expect(projection.entries).toHaveLength(1);
  });

  it("不同 holder 同 unitId 拒绝", async () => {
    await acquireStudioUnitWriteLease(testRoot, {
      unitId: "u-003",
      holderId: "codex-agent-1",
      holderKind: "codex",
    });
    await expect(
      acquireStudioUnitWriteLease(testRoot, {
        unitId: "u-003",
        holderId: "grok-agent-2",
        holderKind: "grok",
      }),
    ).rejects.toThrow(/正被.*codex-agent-1/);
  });

  it("release 后他人可 acquire", async () => {
    await acquireStudioUnitWriteLease(testRoot, {
      unitId: "u-004",
      holderId: "codex-agent-1",
      holderKind: "codex",
    });
    await releaseStudioUnitWriteLease(testRoot, {
      unitId: "u-004",
      holderId: "codex-agent-1",
    });
    // 释放后其他人可获取
    const entry = await acquireStudioUnitWriteLease(testRoot, {
      unitId: "u-004",
      holderId: "grok-agent-2",
      holderKind: "grok",
    });
    expect(entry.holderId).toBe("grok-agent-2");
  });

  it("过期租约自动清理", async () => {
    // TTL 设为 1ms 使其立即过期
    await acquireStudioUnitWriteLease(testRoot, {
      unitId: "u-005",
      holderId: "codex-agent-1",
      holderKind: "codex",
      ttlMs: 1,
    });
    // 等待过期
    await new Promise((resolve) => setTimeout(resolve, 10));
    // 过期后他人可获取
    const entry = await acquireStudioUnitWriteLease(testRoot, {
      unitId: "u-005",
      holderId: "grok-agent-2",
      holderKind: "grok",
    });
    expect(entry.holderId).toBe("grok-agent-2");
  });

  it("多单元并行租约", async () => {
    await acquireStudioUnitWriteLease(testRoot, {
      unitId: "u-006",
      holderId: "codex-agent-1",
      holderKind: "codex",
      mode: "generation",
    });
    await acquireStudioUnitWriteLease(testRoot, {
      unitId: "u-007",
      holderId: "codex-agent-1",
      holderKind: "codex",
      mode: "review",
    });
    const projection = await getStudioUnitWriteLeases(testRoot);
    expect(projection.entries).toHaveLength(2);
    expect(projection.entries.map((e) => e.unitId).sort()).toEqual(["u-006", "u-007"]);
  });

  it("非 holder 不能释放", async () => {
    await acquireStudioUnitWriteLease(testRoot, {
      unitId: "u-008",
      holderId: "codex-agent-1",
      holderKind: "codex",
    });
    await expect(
      releaseStudioUnitWriteLease(testRoot, {
        unitId: "u-008",
        holderId: "grok-agent-2",
      }),
    ).rejects.toThrow(/属于.*codex-agent-1/);
  });
});
