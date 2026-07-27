import { mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureConfinedDirectory,
  linkConfinedFileNoReplace,
  openExclusiveConfinedFile,
  persistConfinedBytesNoReplace,
  readConfinedRegularFile,
  revalidateConfinedDirectory,
} from "../src/core/confined-project-storage.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "ai-canvas-confined-storage-")));
  roots.push(parent);
  const projectRoot = path.join(parent, "project");
  await mkdir(projectRoot);
  return { parent, projectRoot };
}

describe("工程内受限存储基础原语", () => {
  it("按目录 fd 完成 no-replace 原子持久化与同内容幂等采用", async () => {
    const { projectRoot } = await fixture();
    const target = await ensureConfinedDirectory(projectRoot, path.join(projectRoot, ".aicanvas", "objects", "sha256", "aa"));
    const bytes = Buffer.from("managed-bytes", "utf8");
    expect((await persistConfinedBytesNoReplace(target, "asset.bin", bytes)).created).toBe(true);
    expect((await persistConfinedBytesNoReplace(target, "asset.bin", bytes)).created).toBe(false);
    expect((await readConfinedRegularFile(target, "asset.bin")).toString("utf8")).toBe("managed-bytes");
    expect((await readFile(path.join(target.directory, "asset.bin"), "utf8"))).toBe("managed-bytes");
  });

  it("拒绝逐级 symlink、目录替换和非 basename 文件名", async () => {
    const { parent, projectRoot } = await fixture();
    const outside = path.join(parent, "outside");
    await mkdir(outside);
    await mkdir(path.join(projectRoot, ".aicanvas"));
    await symlink(outside, path.join(projectRoot, ".aicanvas", "objects"), "dir");
    await expect(ensureConfinedDirectory(projectRoot, path.join(projectRoot, ".aicanvas", "objects", "sha256")))
      .rejects.toThrow(/符号链接|真实路径/u);

    await rm(path.join(projectRoot, ".aicanvas", "objects"));
    const safe = await ensureConfinedDirectory(projectRoot, path.join(projectRoot, ".aicanvas", "objects", "sha256"));
    await rm(safe.directory, { recursive: true });
    await mkdir(safe.directory);
    await expect(revalidateConfinedDirectory(safe)).rejects.toThrow(/身份已变化/u);
    await expect(openExclusiveConfinedFile(safe, "../escape.tmp")).rejects.toThrow(/basename/u);
  });

  it("最后校验后目标目录被替换时回滚本次 hard-link，工程外保持零文件", async () => {
    const { parent, projectRoot } = await fixture();
    const outside = path.join(parent, "outside-race");
    await mkdir(outside);
    const temporary = await ensureConfinedDirectory(projectRoot, path.join(projectRoot, ".aicanvas", "objects", ".tmp"));
    const target = await ensureConfinedDirectory(projectRoot, path.join(projectRoot, ".aicanvas", "objects", "sha256", "aa"));
    const opened = await openExclusiveConfinedFile(temporary, "race.tmp");
    await opened.handle.writeFile("race-managed-bytes");
    await opened.handle.sync();
    await opened.handle.close();
    const movedTarget = `${target.directory}.original`;

    await expect(linkConfinedFileNoReplace(opened.identity, target, "asset.bin", {
      async beforeLink() {
        await rename(target.directory, movedTarget);
        await symlink(outside, target.directory, "dir");
      },
    })).rejects.toThrow(/身份已变化/u);

    expect(await readdir(outside)).toEqual([]);
    expect(await readdir(movedTarget)).toEqual([]);
    expect((await readFile(path.join(temporary.directory, "race.tmp"), "utf8"))).toBe("race-managed-bytes");
  });
});
