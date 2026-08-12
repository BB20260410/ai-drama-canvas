import { link, lstat, mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAuthorizedNovelImportPreflightFromSelection,
  resetNovelImportPreflightAuthorizationsForTests,
} from "../src/core/novel-import.js";
import {
  consumeNovelSourceSelection,
  issueNovelSourceSelection,
  NOVEL_SOURCE_SELECTION_CAPACITY,
  NOVEL_SOURCE_SELECTION_TTL_MS,
  resetNovelSourceSelectionsForTests,
} from "../src/core/novel-source-selection.js";

const temporaryRoots: string[] = [];

async function fixture(label: string): Promise<{ root: string; sourcePath: string }> {
  const root = await realpath(await mkdtemp(path.join(await realpath(os.tmpdir()), `novel-source-selection-${label}-`)));
  temporaryRoots.push(root);
  const sourcePath = path.join(root, "第一卷.md");
  await writeFile(sourcePath, "# 第一章\n\n青铜树下，嘟嘟醒来。\n", "utf8");
  return { root, sourcePath };
}

function absoluteStrings(value: unknown, output: string[] = []): string[] {
  if (typeof value === "string" && (path.isAbsolute(value) || path.win32.isAbsolute(value))) output.push(value);
  else if (Array.isArray(value)) value.forEach((entry) => absoluteStrings(entry, output));
  else if (value && typeof value === "object") Object.values(value as Record<string, unknown>)
    .forEach((entry) => absoluteStrings(entry, output));
  return output;
}

afterEach(async () => {
  vi.useRealTimers();
  resetNovelSourceSelectionsForTests();
  resetNovelImportPreflightAuthorizationsForTests();
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe.sequential("native novel source selection capability", () => {
  it("只向 renderer 投影 opaque selectionId/sourceName/kind，并且一次消费与并发消费最多成功一次", async () => {
    const { sourcePath } = await fixture("single-use");
    const ticket = await issueNovelSourceSelection(sourcePath, "file");
    expect(ticket).toEqual({
      selectionId: expect.stringMatching(/^novel-source-selection-[A-Za-z0-9_-]{43}$/u),
      sourceName: "第一卷.md",
      kind: "file",
    });
    expect(Object.keys(ticket).sort()).toEqual(["kind", "selectionId", "sourceName"]);
    expect(absoluteStrings(ticket)).toEqual([]);
    const grant = await consumeNovelSourceSelection(ticket.selectionId);
    expect(grant.sourcePath).toBe(sourcePath);
    expect(grant.identity.nlink).toBe(1n);
    for (const value of Object.values(grant.identity)) expect(typeof value).toBe("bigint");
    await expect(consumeNovelSourceSelection(ticket.selectionId)).rejects.toThrow(/已消费|无效/u);
    await expect(consumeNovelSourceSelection(sourcePath)).rejects.toThrow(/selectionId.*无效/u);

    const concurrentTicket = await issueNovelSourceSelection(sourcePath, "file");
    const outcomes = await Promise.allSettled([
      consumeNovelSourceSelection(concurrentTicket.selectionId),
      consumeNovelSourceSelection(concurrentTicket.selectionId),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
  });

  it("file 只允许 txt/md/markdown/docx 的单链接真实普通文件，directory 单独放行", async () => {
    const { root, sourcePath } = await fixture("kinds");
    const unsupported = path.join(root, "正文.pdf");
    const linked = path.join(root, "正文-hardlink.md");
    const alias = path.join(root, "正文-alias.md");
    const directory = path.join(root, "整部小说");
    await writeFile(unsupported, "PDF", "utf8");
    await link(sourcePath, linked);
    await symlink(sourcePath, alias);
    await mkdir(directory);

    await expect(issueNovelSourceSelection(unsupported, "file")).rejects.toThrow(/只允许 TXT/u);
    await expect(issueNovelSourceSelection(linked, "file")).rejects.toThrow(/单链接普通文件/u);
    await expect(issueNovelSourceSelection(alias, "file")).rejects.toThrow(/符号链接/u);
    await expect(issueNovelSourceSelection(sourcePath, "directory")).rejects.toThrow(/真实目录/u);
    const directoryTicket = await issueNovelSourceSelection(directory, "directory");
    expect(directoryTicket).toMatchObject({ sourceName: "整部小说", kind: "directory" });
    expect(absoluteStrings(directoryTicket)).toEqual([]);
  });

  it("路径在签发后被替换时稳定身份复验失败，失败票据也不可重放", async () => {
    const { root, sourcePath } = await fixture("replace-before-consume");
    const ticket = await issueNovelSourceSelection(sourcePath, "file");
    await rename(sourcePath, path.join(root, "原始.md"));
    await writeFile(sourcePath, "# 第一章\n替换后的正文。\n", "utf8");

    await expect(consumeNovelSourceSelection(ticket.selectionId)).rejects.toThrow(/身份已变化/u);
    await expect(consumeNovelSourceSelection(ticket.selectionId)).rejects.toThrow(/已消费|无效/u);
  });

  it("消费后到预检之间发生路径替换时，picker 绑定身份阻止新 inode 被预检授权", async () => {
    const { root, sourcePath } = await fixture("replace-before-preflight");
    const ticket = await issueNovelSourceSelection(sourcePath, "file");
    const grant = await consumeNovelSourceSelection(ticket.selectionId);
    await rename(sourcePath, path.join(root, "原始.md"));
    await writeFile(sourcePath, "# 第一章\n不得借旧票据预检的新正文。\n", "utf8");

    await expect(createAuthorizedNovelImportPreflightFromSelection(grant))
      .rejects.toThrow(/原生选择票据.*身份不一致/u);
  });

  it("票据按短 TTL 失效且内存容量有硬上限", async () => {
    const { sourcePath } = await fixture("ttl-capacity");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T00:00:00.000Z"));
    const expiring = await issueNovelSourceSelection(sourcePath, "file");
    vi.setSystemTime(new Date(Date.now() + NOVEL_SOURCE_SELECTION_TTL_MS + 1));
    await expect(consumeNovelSourceSelection(expiring.selectionId)).rejects.toThrow(/过期|无效/u);

    resetNovelSourceSelectionsForTests();
    for (let index = 0; index < NOVEL_SOURCE_SELECTION_CAPACITY; index += 1) {
      await issueNovelSourceSelection(sourcePath, "file");
    }
    await expect(issueNovelSourceSelection(sourcePath, "file")).rejects.toThrow(/容量已满/u);
    expect((await lstat(sourcePath)).isFile()).toBe(true);
  });
});
