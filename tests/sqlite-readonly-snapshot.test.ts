import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertSafeSqliteSidecars } from "../src/core/sqlite-readonly-snapshot.js";

/**
 * sidecar 绑定竞态：并发 SQLite 连接合法删除/重建 WAL/SHM 时，writable open 的
 * 前置安全校验必须按瞬态竞态退避重试，而不是把 inode 变更误判为来源篡改。
 */

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempDb(): string {
  const root = mkdtempSync(path.join(tmpdir(), "aicanvas-sqlite-binding-test-"));
  tempRoots.push(root);
  const databasePath = path.join(root, "ledger.sqlite");
  writeFileSync(databasePath, "sqlite-header-fixture");
  return databasePath;
}

describe("SQLite sidecar 绑定竞态", () => {
  it("并发重建 -shm（inode 变更）时退避重试后全部通过，不误判来源篡改", async () => {
    const databasePath = tempDb();
    const shmPath = `${databasePath}-shm`;
    writeFileSync(shmPath, "shm-v0");
    let stop = false;
    let recreations = 0;
    // 以 setImmediate 高频删除并重建 -shm：模拟并发写者 checkpoint/连接关闭的合法行为。
    const replacer = (async () => {
      while (!stop) {
        await rm(shmPath, { force: true });
        await writeFile(shmPath, `shm-v${recreations += 1}`);
        await new Promise((resolve) => setImmediate(resolve));
      }
    })();
    try {
      // 每次校验之间让出事件循环，保证重建器与校验真实并发交错：修复前任何一次
      // 撞上 inode 变更都立即失败；修复后在有界退避内重新绑定成功。
      for (let index = 0; index < 50; index++) {
        expect(() => assertSafeSqliteSidecars(databasePath, "竞态测试 ledger")).not.toThrow();
        await new Promise((resolve) => setImmediate(resolve));
      }
      expect(recreations).toBeGreaterThan(0);
    } finally {
      stop = true;
      await replacer;
    }
  }, 60_000);

  it("sidecar 缺失（ENOENT）仍按无 sidecar 通过", () => {
    const databasePath = tempDb();
    expect(() => assertSafeSqliteSidecars(databasePath, "竞态测试 ledger")).not.toThrow();
  });

  it("symlink sidecar 立即失败关闭，不重试", () => {
    const databasePath = tempDb();
    const outside = path.join(path.dirname(databasePath), "outside-shm-target");
    writeFileSync(outside, "attacker-controlled");
    symlinkSync(outside, `${databasePath}-shm`);
    expect(() => assertSafeSqliteSidecars(databasePath, "竞态测试 ledger"))
      .toThrow(/not a safe single-link regular file/);
  });
});
