import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  acquireEvidenceRunLock,
  assertFreshOutputSet,
  createEvidenceRunLockOwner,
  createUniqueEvidenceStem,
  writeBytesAtomicExclusive,
  writeJsonAtomicExclusive,
} from "../scripts/lib/exclusive-evidence-output.mjs";

describe("隔离验收证据独占发布", () => {
  it("默认 stem 唯一且不再使用 latest", () => {
    const first = createUniqueEvidenceStem();
    const second = createUniqueEvidenceStem();
    expect(first).not.toBe(second);
    expect(first).toMatch(/^isolated-package-smoke-/u);
    expect(first).not.toContain("latest");
  });

  it("原子独占写只允许首次发布，既存证据内容不变且不残留 tmp", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "aic-exclusive-evidence-"));
    const target = path.join(root, "evidence.json");
    try {
      await assertFreshOutputSet([{ label: "证据", path: target }]);
      await writeJsonAtomicExclusive(target, { status: "passed", runId: "one" });
      const first = await readFile(target, "utf8");
      await expect(writeJsonAtomicExclusive(target, { status: "passed", runId: "two" }))
        .rejects.toMatchObject({ code: "EEXIST" });
      expect(await readFile(target, "utf8")).toBe(first);
      expect((await readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("同一 evidence stem 的并发 run 只有一个能持有 lock", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "aic-evidence-lock-"));
    const target = path.join(root, "evidence.json");
    try {
      const first = await acquireEvidenceRunLock(target, "run-one");
      expect(first.path).toBe(`${path.resolve(target)}.lock`);
      await expect(acquireEvidenceRunLock(target, "run-two")).rejects.toMatchObject({ code: "EEXIST" });
      await first.release();
      expect(await readdir(root)).toEqual([]);
      const retry = await acquireEvidenceRunLock(target, "run-three");
      await retry.release();
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("release 删除失败时不伪装成功，重试只重做删除而不重复 close", async () => {
    let closeCalls = 0;
    let removeCalls = 0;
    const lock = createEvidenceRunLockOwner("/tmp/evidence.lock", {
      async close() { closeCalls += 1; },
    }, async () => {
      removeCalls += 1;
      if (removeCalls === 1) throw new Error("unlink failed");
    });

    await expect(lock.release()).rejects.toThrow(/unlink failed/u);
    await expect(lock.release()).resolves.toBeUndefined();
    expect(closeCalls).toBe(1);
    expect(removeCalls).toBe(2);
  });

  it("lock 初始化写入失败时关闭句柄并删除本轮 lock", async () => {
    let closeCalls = 0;
    let removeCalls = 0;
    await expect(acquireEvidenceRunLock("/tmp/never-created-evidence.json", "run-fail", {
      async openFile() {
        return {
          async writeFile() { throw new Error("write failed"); },
          async sync() {},
          async close() { closeCalls += 1; },
        };
      },
      async removeFile() { removeCalls += 1; },
    })).rejects.toThrow(/write failed/u);
    expect(closeCalls).toBe(1);
    expect(removeCalls).toBe(1);
  });

  it("目标已存在时二进制发布不覆盖 sentinel", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "aic-evidence-bytes-"));
    const target = path.join(root, "shot.png");
    try {
      await writeFile(target, "sentinel", "utf8");
      await expect(writeBytesAtomicExclusive(target, Buffer.from("new"))).rejects.toMatchObject({ code: "EEXIST" });
      expect(await readFile(target, "utf8")).toBe("sentinel");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
