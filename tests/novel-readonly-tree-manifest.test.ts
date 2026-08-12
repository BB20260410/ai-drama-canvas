import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, lstat, mkdtemp, mkdir, readFile, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  captureNovelReadonlyTreeManifest,
  type NovelReadonlyTreeManifest,
} from "../scripts/capture-novel-readonly-tree-manifest.js";

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{ workspace: string; source: string; evidence: string }> {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "novel-readonly-tree-")));
  temporaryRoots.push(parent);
  const workspace = path.join(parent, "workspace");
  const source = path.join(parent, "source");
  await Promise.all([mkdir(workspace), mkdir(path.join(source, "nested"), { recursive: true })]);
  await Promise.all([
    writeFile(path.join(source, "章二.md"), "第二章\n", "utf8"),
    writeFile(path.join(source, "nested", "章一.md"), "第一章\n", "utf8"),
  ]);
  return {
    workspace,
    source,
    evidence: path.join(workspace, "docs", "evidence", "novel-mode-v1", "real-project"),
  };
}

async function readManifest(filePath: string): Promise<NovelReadonlyTreeManifest> {
  return JSON.parse(await readFile(filePath, "utf8")) as NovelReadonlyTreeManifest;
}

describe.sequential("小说正式源只读树证据", () => {
  it("相同树两次得到完全相同的排序条目和 aggregate，且不持久化绝对 root", async () => {
    const data = await fixture();
    const firstPath = path.join(data.evidence, "deterministic-a.json");
    const secondPath = path.join(data.evidence, "deterministic-b.json");
    const first = await captureNovelReadonlyTreeManifest({ workspaceRoot: data.workspace, root: data.source, label: "deterministic", output: firstPath });
    const second = await captureNovelReadonlyTreeManifest({ workspaceRoot: data.workspace, root: data.source, label: "deterministic", output: secondPath });
    expect(second).toEqual(first);
    expect(await readManifest(firstPath)).toEqual(first);
    expect(await readManifest(secondPath)).toEqual(first);
    expect(first.entries.map((entry) => entry.path)).toEqual([".", "nested", "nested/章一.md", "章二.md"]);
    expect(first.summary).toMatchObject({ entries: 4, directories: 2, files: 2, symlinks: 0 });
    expect(first.aggregateSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(first)).not.toContain(data.source);
    expect(first.rootPersisted).toBe(false);
  });

  it("正文内容变化与纯 mtime 变化分别产生新的文件证据和 aggregate", async () => {
    const data = await fixture();
    const chapter = path.join(data.source, "章二.md");
    await utimes(chapter, new Date("2025-01-01T00:00:00.000Z"), new Date("2025-01-01T00:00:00.000Z"));
    const before = await captureNovelReadonlyTreeManifest({ workspaceRoot: data.workspace, root: data.source, label: "before", output: path.join(data.evidence, "before.json") });
    await writeFile(chapter, "第二章已变化\n", "utf8");
    await utimes(chapter, new Date("2025-01-01T00:00:00.000Z"), new Date("2025-01-01T00:00:00.000Z"));
    const contentChanged = await captureNovelReadonlyTreeManifest({ workspaceRoot: data.workspace, root: data.source, label: "content-changed", output: path.join(data.evidence, "content-changed.json") });
    const beforeFile = before.entries.find((entry) => entry.path === "章二.md")!;
    const contentChangedFile = contentChanged.entries.find((entry) => entry.path === "章二.md")!;
    expect(contentChangedFile.sha256).not.toBe(beforeFile.sha256);
    expect(contentChangedFile.mtimeNs).toBe(beforeFile.mtimeNs);
    expect(contentChanged.aggregateSha256).not.toBe(before.aggregateSha256);

    await utimes(chapter, new Date("2026-01-01T00:00:00.000Z"), new Date("2026-01-01T00:00:00.000Z"));
    const mtimeChanged = await captureNovelReadonlyTreeManifest({ workspaceRoot: data.workspace, root: data.source, label: "mtime-changed", output: path.join(data.evidence, "mtime-changed.json") });
    const mtimeChangedFile = mtimeChanged.entries.find((entry) => entry.path === "章二.md")!;
    expect(mtimeChangedFile.sha256).toBe(contentChangedFile.sha256);
    expect(mtimeChangedFile.mtimeNs).not.toBe(contentChangedFile.mtimeNs);
    expect(mtimeChanged.aggregateSha256).not.toBe(contentChanged.aggregateSha256);
  });

  it("记录 symlink 本身但绝不跟随，外部目标内容变化不改变清单", async () => {
    const data = await fixture();
    const outside = path.join(path.dirname(data.source), "outside-secret.md");
    await writeFile(outside, "外部秘密 A\n", "utf8");
    const link = path.join(data.source, "external-link.md");
    await symlink(outside, link);
    const first = await captureNovelReadonlyTreeManifest({ workspaceRoot: data.workspace, root: data.source, label: "symlink", output: path.join(data.evidence, "symlink-a.json") });
    const linkEntry = first.entries.find((entry) => entry.path === "external-link.md")!;
    expect(linkEntry.type).toBe("symlink");
    expect(linkEntry.sha256).toBe(createHash("sha256").update(Buffer.from(outside, "utf8")).digest("hex"));
    expect(linkEntry.sha256).not.toBe(createHash("sha256").update("外部秘密 A\n").digest("hex"));
    await writeFile(outside, "外部秘密 B，长度也改变\n", "utf8");
    const second = await captureNovelReadonlyTreeManifest({ workspaceRoot: data.workspace, root: data.source, label: "symlink", output: path.join(data.evidence, "symlink-b.json") });
    expect(second).toEqual(first);
  });

  it("限制输出边界、拒绝覆盖，并拒绝把 symlink 当作 root", async () => {
    const data = await fixture();
    const outsideOutput = path.join(data.workspace, "outside.json");
    await expect(captureNovelReadonlyTreeManifest({ workspaceRoot: data.workspace, root: data.source, label: "boundary", output: outsideOutput })).rejects.toThrow("只能是 docs/evidence/novel-mode-v1/real-project");
    await expect(access(outsideOutput)).rejects.toMatchObject({ code: "ENOENT" });

    const output = path.join(data.evidence, "immutable.json");
    await captureNovelReadonlyTreeManifest({ workspaceRoot: data.workspace, root: data.source, label: "immutable", output });
    const original = await readFile(output);
    await expect(captureNovelReadonlyTreeManifest({ workspaceRoot: data.workspace, root: data.source, label: "immutable", output })).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(output)).toEqual(original);

    const linkedRoot = path.join(path.dirname(data.source), "linked-root");
    await symlink(data.source, linkedRoot, "dir");
    await expect(captureNovelReadonlyTreeManifest({ workspaceRoot: data.workspace, root: linkedRoot, label: "linked", output: path.join(data.evidence, "linked.json") })).rejects.toThrow("--root 必须是非符号链接真实目录");
    await expect(access(path.join(data.evidence, "linked.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("二次枚举发现扫描期间变化时失败且不落证据", async () => {
    const data = await fixture();
    const output = path.join(data.evidence, "race-must-not-land.json");
    await expect(captureNovelReadonlyTreeManifest({
      workspaceRoot: data.workspace,
      root: data.source,
      label: "race",
      output,
      betweenScans: async () => {
        await writeFile(path.join(data.source, "扫描中新增.md"), "不得落证据\n", "utf8");
      },
    })).rejects.toThrow("二次枚举发现条目新增或删除");
    await expect(access(output)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("CLI 接受 --root/--label/--output 并只输出紧凑摘要", async () => {
    const data = await fixture();
    const relativeOutput = "docs/evidence/novel-mode-v1/real-project/cli.json";
    const script = path.resolve("scripts/capture-novel-readonly-tree-manifest.ts");
    const tsxExecutable = path.resolve("node_modules", ".bin", "tsx");
    const { stdout } = await execFileAsync(tsxExecutable, [script,
      "--root", data.source,
      "--label", "cli",
      "--output", relativeOutput,
    ], { cwd: data.workspace, encoding: "utf8", timeout: 20_000, maxBuffer: 64 * 1024 });
    const lines = stdout.trim().split(/\r?\n/u);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ kind: "novel-readonly-tree-manifest", label: "cli", entries: 4 });
    await expect(readManifest(path.join(data.workspace, relativeOutput))).resolves.toMatchObject({ label: "cli", rootPersisted: false });
    expect((await lstat(path.join(data.workspace, relativeOutput))).isFile()).toBe(true);
  });
});
