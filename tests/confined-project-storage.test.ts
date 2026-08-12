import { lstat, mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureConfinedDirectory,
  hashConfinedRegularFileWithIdentity,
  inspectExistingConfinedDirectory,
  linkConfinedFileNoReplace,
  moveConfinedDirectoryNoReplace,
  moveConfinedFileNoReplaceCas,
  openExclusiveConfinedFile,
  persistConfinedBytesNoReplace,
  persistConfinedBytesNoReplaceBatch,
  readConfinedRegularFile,
  readConfinedRegularFileWithIdentity,
  replaceConfinedBytesCas,
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

  it("同目录批量发布先持久化工件、最后提交 intent，并支持同字节重放", async () => {
    const { projectRoot } = await fixture();
    const target = await ensureConfinedDirectory(
      projectRoot,
      path.join(projectRoot, ".aicanvas", "novel", "operations", "batch"),
    );
    const entries = [
      { name: "after-state.json", bytes: Buffer.from('{"state":1}\n', "utf8") },
      { name: "result.json", bytes: Buffer.from('{"result":1}\n', "utf8") },
      { name: "intent.json", bytes: Buffer.from('{"intent":1}\n', "utf8") },
    ];
    expect((await persistConfinedBytesNoReplaceBatch(target, entries, { commitName: "intent.json" }))
      .map((entry) => entry.created)).toEqual([true, true, true]);
    expect((await persistConfinedBytesNoReplaceBatch(target, entries, { commitName: "intent.json" }))
      .map((entry) => entry.created)).toEqual([false, false, false]);
    await expect(persistConfinedBytesNoReplaceBatch(target, [
      entries[0]!,
      { name: "result.json", bytes: Buffer.from('{"result":2}\n', "utf8") },
      entries[2]!,
    ], { commitName: "intent.json" })).rejects.toThrow(/different content|不同|EEXIST/u);
    expect(await readFile(path.join(target.directory, "result.json"), "utf8")).toBe('{"result":1}\n');
  });

  it("以 inode + SHA + size 作 CAS 原子替换，旧窗口不能后写覆盖", async () => {
    const { projectRoot } = await fixture();
    const target = await ensureConfinedDirectory(projectRoot, path.join(projectRoot, "manuscript", "volumes", "v1"));
    const original = Buffer.from("第一版正文", "utf8");
    const first = await persistConfinedBytesNoReplace(target, "c1.md", original);
    const next = Buffer.from("第二版正文", "utf8");
    const replaced = await replaceConfinedBytesCas(
      first.identity,
      first.sha256,
      first.size,
      next,
    );
    expect(replaced.sha256).not.toBe(first.sha256);
    expect(await readConfinedRegularFile(target, "c1.md")).toEqual(next);

    await expect(replaceConfinedBytesCas(
      first.identity,
      first.sha256,
      first.size,
      Buffer.from("过期窗口写入", "utf8"),
    )).rejects.toThrow(/CAS|identity|mismatch/u);
    expect(await readConfinedRegularFile(target, "c1.md")).toEqual(next);
  });

  it("在锚定目录间 no-replace 原子移动同一文件身份", async () => {
    const { projectRoot } = await fixture();
    const sourceDirectory = await ensureConfinedDirectory(projectRoot, path.join(projectRoot, "manuscript", "volumes", "v1"));
    const targetDirectory = await ensureConfinedDirectory(projectRoot, path.join(projectRoot, "manuscript", "volumes", "v2"));
    const source = await persistConfinedBytesNoReplace(
      sourceDirectory,
      "chapter.md",
      Buffer.from("移动不改正文", "utf8"),
    );
    const moved = await moveConfinedFileNoReplaceCas(
      source.identity,
      source.sha256,
      source.size,
      targetDirectory,
      "chapter.md",
    );

    await expect(readConfinedRegularFile(sourceDirectory, "chapter.md"))
      .rejects.toMatchObject({ code: "ENOENT" });
    expect(await readConfinedRegularFile(targetDirectory, "chapter.md"))
      .toEqual(Buffer.from("移动不改正文", "utf8"));
    expect(moved.identity).toMatchObject({ dev: source.identity.dev, ino: source.identity.ino });
  });

  it("以目录 inode 身份将 staging 整体 no-replace 原子发布", async () => {
    const { projectRoot } = await fixture();
    const staging = await ensureConfinedDirectory(projectRoot, path.join(projectRoot, ".aicanvas", "novel", "staging", "receipt", "publish", "manuscript"));
    const nested = await ensureConfinedDirectory(projectRoot, path.join(staging.directory, "volumes", "v1"));
    await persistConfinedBytesNoReplace(nested, "c1.md", Buffer.from("原子发布正文", "utf8"));
    const project = await inspectExistingConfinedDirectory(projectRoot, projectRoot);

    const published = await moveConfinedDirectoryNoReplace(staging, project, "manuscript");
    expect(published).toMatchObject({ dev: staging.dev, ino: staging.ino });
    expect(await readFile(path.join(projectRoot, "manuscript", "volumes", "v1", "c1.md"), "utf8"))
      .toBe("原子发布正文");
    await expect(realpath(staging.directory)).rejects.toMatchObject({ code: "ENOENT" });
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

  it.each([
    ["read", "afterOpen"],
    ["read", "afterRead"],
    ["hash", "afterOpen"],
    ["hash", "afterRead"],
  ] as const)("%s 在 %s 后遇到同字节 inode 替换时拒绝采用脱链 fd", async (operation, hookName) => {
    const { projectRoot } = await fixture();
    const target = await ensureConfinedDirectory(projectRoot, path.join(projectRoot, ".aicanvas", "objects", "sha256", "aa"));
    const bytes = Buffer.from("same-bytes-different-inode", "utf8");
    await persistConfinedBytesNoReplace(target, "race.bin", bytes);
    const targetPath = path.join(target.directory, "race.bin");
    const originalIdentity = await lstat(targetPath);
    let replaced = false;
    const replaceWithSameBytes = async (): Promise<void> => {
      if (replaced) return;
      replaced = true;
      await rename(targetPath, path.join(target.directory, `displaced-${operation}-${hookName}.bin`));
      await writeFile(targetPath, bytes, { mode: 0o600 });
    };
    const hooks = hookName === "afterOpen"
      ? { afterOpen: replaceWithSameBytes }
      : { afterRead: replaceWithSameBytes };

    const read = operation === "read"
      ? readConfinedRegularFileWithIdentity(target, "race.bin", bytes.byteLength, hooks)
      : hashConfinedRegularFileWithIdentity(target, "race.bin", bytes.byteLength, hooks);
    await expect(read).rejects.toThrow(/读取期间发生替换|最终路径与 fd 身份不一致/u);
    const replacementIdentity = await lstat(targetPath);
    expect(replacementIdentity.ino).not.toBe(originalIdentity.ino);
    expect(await readFile(targetPath)).toEqual(bytes);
  });
});
