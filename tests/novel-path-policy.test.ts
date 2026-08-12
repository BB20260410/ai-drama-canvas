import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { persistConfinedBytesNoReplace } from "../src/core/confined-project-storage.js";
import {
  ensureNovelCreateTargetParent,
  inspectExistingNovelFile,
  inspectNovelProjectRoot,
  normalizeNovelProjectLocator,
  readInspectedNovelFile,
  readNovelProjectFile,
  revalidateNovelCreateTarget,
  resolveNovelProjectLocator,
} from "../src/core/novel-path-policy.js";

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];

async function createFixture(): Promise<{ base: string; projectRoot: string }> {
  const base = await mkdtemp(path.join(await realpath(os.tmpdir()), "ai-canvas-novel-path-policy-"));
  temporaryRoots.push(base);
  const projectRoot = path.join(base, "project");
  await mkdir(projectRoot, { recursive: true });
  return { base, projectRoot };
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("novel path policy", () => {
  it("只接受使用 / 的规范项目内相对 locator", () => {
    expect(normalizeNovelProjectLocator("manuscript/volumes/卷一/第一章.md"))
      .toBe("manuscript/volumes/卷一/第一章.md");
    expect(normalizeNovelProjectLocator("story-bible/facts.jsonl"))
      .toBe("story-bible/facts.jsonl");

    for (const invalid of [
      "",
      "   ",
      "/etc/passwd",
      "../outside.md",
      "manuscript/../outside.md",
      "manuscript/./chapter.md",
      "manuscript//chapter.md",
      "manuscript/chapter.md/",
      "C:/outside.md",
      "C:\\outside.md",
      "manuscript\\chapter.md",
      "manuscript/\0chapter.md",
    ]) {
      expect(() => normalizeNovelProjectLocator(invalid), invalid).toThrow();
    }
  });

  it("只在调用内把 locator 词法投影为根内绝对路径", async () => {
    const { projectRoot } = await createFixture();
    expect(resolveNovelProjectLocator(projectRoot, "manuscript/chapter.md")).toEqual({
      locator: "manuscript/chapter.md",
      absolutePath: path.join(projectRoot, "manuscript", "chapter.md"),
    });
    expect(() => resolveNovelProjectLocator("relative-root", "manuscript/chapter.md"))
      .toThrow("绝对路径");
    expect(() => resolveNovelProjectLocator(projectRoot, "../outside.md"))
      .toThrow();
  });

  it("冻结规范真实项目根，拒绝相对根、symlink、普通文件和特殊节点", async () => {
    const { base, projectRoot } = await createFixture();
    await expect(inspectNovelProjectRoot(projectRoot)).resolves.toMatchObject({
      root: projectRoot,
      canonicalRoot: projectRoot,
    });
    await expect(inspectNovelProjectRoot("relative/project")).rejects.toThrow("绝对路径");

    const linkedRoot = path.join(base, "linked-project");
    await symlink(projectRoot, linkedRoot, "dir");
    await expect(inspectNovelProjectRoot(linkedRoot)).rejects.toThrow(/符号链接|路径别名/u);

    const fileRoot = path.join(base, "not-a-directory");
    await writeFile(fileRoot, "file", "utf8");
    await expect(inspectNovelProjectRoot(fileRoot)).rejects.toThrow("真实目录");

    const fifoRoot = path.join(base, "fifo-root");
    await execFileAsync("mkfifo", [fifoRoot]);
    await expect(inspectNovelProjectRoot(fifoRoot)).rejects.toThrow("真实目录");
  });

  it("以 lstat + realpath + O_NOFOLLOW 稳定读取现有普通文件并强制字节上限", async () => {
    const { projectRoot } = await createFixture();
    const locator = "manuscript/volumes/volume-1/chapter-1.md";
    const absolutePath = path.join(projectRoot, ...locator.split("/"));
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, "第一章\n青铜神树。", "utf8");

    const result = await readNovelProjectFile(projectRoot, locator, { maxBytes: 1024 });
    expect(result.bytes.toString("utf8")).toBe("第一章\n青铜神树。");
    expect(result.sha256).toBe(createHash("sha256").update(result.bytes).digest("hex"));
    expect(result.identity).toMatchObject({ locator, absolutePath });
    await expect(readNovelProjectFile(projectRoot, locator, { maxBytes: 4 }))
      .rejects.toThrow("字节上限");
    await expect(readNovelProjectFile(projectRoot, locator, { maxBytes: Number.MAX_SAFE_INTEGER + 1 }))
      .rejects.toThrow("maxBytes");
  });

  it("拒绝文件 symlink、目录、FIFO、硬链接和含 symlink 的父目录", async () => {
    const { base, projectRoot } = await createFixture();
    const outside = path.join(base, "outside");
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "secret.md"), "outside", "utf8");

    await symlink(path.join(outside, "secret.md"), path.join(projectRoot, "linked.md"));
    await expect(readNovelProjectFile(projectRoot, "linked.md", { maxBytes: 1024 }))
      .rejects.toThrow(/符号链接|普通文件/u);

    await mkdir(path.join(projectRoot, "directory.md"));
    await expect(readNovelProjectFile(projectRoot, "directory.md", { maxBytes: 1024 }))
      .rejects.toThrow("普通文件");

    await execFileAsync("mkfifo", [path.join(projectRoot, "pipe.md")]);
    await expect(readNovelProjectFile(projectRoot, "pipe.md", { maxBytes: 1024 }))
      .rejects.toThrow("普通文件");

    const outsideHardlinkSource = path.join(base, "hardlink-source.md");
    await writeFile(outsideHardlinkSource, "shared inode", "utf8");
    await link(outsideHardlinkSource, path.join(projectRoot, "hardlink.md"));
    await expect(readNovelProjectFile(projectRoot, "hardlink.md", { maxBytes: 1024 }))
      .rejects.toThrow("硬链接");

    await symlink(outside, path.join(projectRoot, "escaped-parent"), "dir");
    await expect(readNovelProjectFile(projectRoot, "escaped-parent/secret.md", { maxBytes: 1024 }))
      .rejects.toThrow(/符号链接|逃逸/u);
  });

  it("冻结后路径被换成新 inode 或 symlink 时在打开前失败关闭", async () => {
    const { base, projectRoot } = await createFixture();
    const locator = "manuscript/chapter.md";
    const absolutePath = path.join(projectRoot, "manuscript", "chapter.md");
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, "original", "utf8");

    const frozen = await inspectExistingNovelFile(projectRoot, locator);
    await rename(absolutePath, `${absolutePath}.old`);
    await writeFile(absolutePath, "replacement", "utf8");
    await expect(readInspectedNovelFile(frozen, { maxBytes: 1024 }))
      .rejects.toThrow(/打开前已被替换|身份/u);

    const symlinkLocator = "manuscript/symlink-race.md";
    const symlinkPath = path.join(projectRoot, "manuscript", "symlink-race.md");
    const outside = path.join(base, "outside.md");
    await writeFile(symlinkPath, "inside", "utf8");
    await writeFile(outside, "outside", "utf8");
    const frozenBeforeSymlink = await inspectExistingNovelFile(projectRoot, symlinkLocator);
    await rm(symlinkPath);
    await symlink(outside, symlinkPath);
    await expect(readInspectedNovelFile(frozenBeforeSymlink, { maxBytes: 1024 }))
      .rejects.toThrow(/打开前已被替换|身份/u);

    await writeFile(path.join(projectRoot, "root-race.md"), "root", "utf8");
    const frozenBeforeRootSwap = await inspectExistingNovelFile(projectRoot, "root-race.md");
    await rename(projectRoot, `${projectRoot}-original`);
    await mkdir(projectRoot);
    await expect(readInspectedNovelFile(frozenBeforeRootSwap, { maxBytes: 1024 }))
      .rejects.toThrow("项目根身份已变化");
  });

  it("安全创建并冻结缺失目标父目录，可直接复用 confined no-replace 写原语", async () => {
    const { projectRoot } = await createFixture();
    const locator = "manuscript/volumes/volume-1/chapter-1.md";
    const target = await ensureNovelCreateTargetParent(projectRoot, locator);

    expect(target).toMatchObject({
      locator,
      absolutePath: path.join(projectRoot, ...locator.split("/")),
      name: "chapter-1.md",
    });
    await expect(readFile(target.absolutePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(revalidateNovelCreateTarget(target)).resolves.toBeUndefined();

    await persistConfinedBytesNoReplace(target.parent, target.name, Buffer.from("受管正文", "utf8"));
    await expect(revalidateNovelCreateTarget(target)).rejects.toThrow("已经存在");
    await expect(readNovelProjectFile(projectRoot, locator, { maxBytes: 1024 })).resolves.toMatchObject({
      bytes: Buffer.from("受管正文", "utf8"),
    });
  });

  it("新建目标拒绝既有节点、symlink/特殊父节点、无效 mode 和父目录身份替换", async () => {
    const { base, projectRoot } = await createFixture();
    await writeFile(path.join(projectRoot, "exists.md"), "exists", "utf8");
    await expect(ensureNovelCreateTargetParent(projectRoot, "exists.md"))
      .rejects.toThrow("已经存在");

    const outside = path.join(base, "outside");
    await mkdir(outside);
    await symlink(outside, path.join(projectRoot, "linked-parent"), "dir");
    await expect(ensureNovelCreateTargetParent(projectRoot, "linked-parent/new.md"))
      .rejects.toThrow(/符号链接|非目录/u);

    await execFileAsync("mkfifo", [path.join(projectRoot, "special-parent")]);
    await expect(ensureNovelCreateTargetParent(projectRoot, "special-parent/new.md"))
      .rejects.toThrow(/非目录|符号链接/u);
    await expect(ensureNovelCreateTargetParent(projectRoot, "new.md", 0o1000))
      .rejects.toThrow("mode");

    const target = await ensureNovelCreateTargetParent(projectRoot, "race-parent/new.md");
    const movedParent = path.join(projectRoot, "race-parent-original");
    await rename(target.parent.directory, movedParent);
    await symlink(outside, target.parent.directory, "dir");
    await expect(revalidateNovelCreateTarget(target)).rejects.toThrow(/身份已变化|符号链接/u);
  });
});
