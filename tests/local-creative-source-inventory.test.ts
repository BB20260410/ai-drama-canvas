import { mkdtemp, realpath, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectLocalCreativeSourceInventory } from "../src/core/local-creative-source-inventory.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("本机创作来源内容身份", () => {
  it("同大小内容替换并恢复 mtime 仍会改变正式 SHA inventory 指纹", async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "ai-canvas-source-inventory-")));
    roots.push(root);
    const filePath = path.join(root, "剧本.md");
    await writeFile(filePath, "AAAA\n", "utf8");
    const beforeMetadata = await stat(filePath);
    const before = await inspectLocalCreativeSourceInventory(
      [{ role: "PRIMARY_AUTHORITY", rootPath: root }],
      { cache: false, hashContents: true },
    );
    await writeFile(filePath, "BBBB\n", "utf8");
    await utimes(filePath, beforeMetadata.atime, beforeMetadata.mtime);
    const after = await inspectLocalCreativeSourceInventory(
      [{ role: "PRIMARY_AUTHORITY", rootPath: root }],
      { cache: false, hashContents: true },
    );
    expect(after.totalBytes).toBe(before.totalBytes);
    expect(after.contentIdentity).toBe("sha256");
    expect(after.fingerprint).not.toBe(before.fingerprint);
  });

  it("内容未变但仅 touch 时内容身份保持稳定，扫描诊断 token 单独变化", async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "ai-canvas-source-touch-")));
    roots.push(root);
    const filePath = path.join(root, "设定.md");
    await writeFile(filePath, "身份锁内容不变\n", "utf8");
    const before = await inspectLocalCreativeSourceInventory(
      [{ role: "PRIMARY_AUTHORITY", rootPath: root }],
      { cache: false, hashContents: true },
    );
    const future = new Date(Date.now() + 5_000);
    await utimes(filePath, future, future);
    const after = await inspectLocalCreativeSourceInventory(
      [{ role: "PRIMARY_AUTHORITY", rootPath: root }],
      { cache: false, hashContents: true },
    );
    expect(after.contentIdentity).toBe("sha256");
    expect(after.fingerprint).toBe(before.fingerprint);
    expect(after.scanFingerprint).not.toBe(before.scanFingerprint);
    expect(after.maxMtimeMs).not.toBe(before.maxMtimeMs);
  });

  it("已取消的盘点在访问来源目录前以 AbortError 失败", async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "ai-canvas-source-aborted-")));
    roots.push(root);
    await writeFile(path.join(root, "剧本.md"), "不应读取\n", "utf8");
    const controller = new AbortController();
    controller.abort("用户切换了工程");

    await expect(inspectLocalCreativeSourceInventory(
      [{ role: "PRIMARY_AUTHORITY", rootPath: root }],
      { cache: false, hashContents: true, signal: controller.signal },
    )).rejects.toMatchObject({
      name: "AbortError",
      message: "用户切换了工程",
    });
  });

  it("深度 SHA 盘点可在执行中取消，且不会污染后续正常盘点", async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "ai-canvas-source-cancel-hash-")));
    roots.push(root);
    await writeFile(path.join(root, "大图.png"), Buffer.alloc(32 * 1024 * 1024, 0x5a));
    const controller = new AbortController();
    const pending = inspectLocalCreativeSourceInventory(
      [{ role: "PRIMARY_AUTHORITY", rootPath: root }],
      { cache: false, hashContents: true, signal: controller.signal },
    );
    setImmediate(() => controller.abort("停止旧工程深扫"));

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    const recovered = await inspectLocalCreativeSourceInventory(
      [{ role: "PRIMARY_AUTHORITY", rootPath: root }],
      { cache: false, hashContents: true },
    );
    expect(recovered.totalFiles).toBe(1);
    expect(recovered.totalBytes).toBe(32 * 1024 * 1024);
    expect(recovered.contentIdentity).toBe("sha256");
  });
});
