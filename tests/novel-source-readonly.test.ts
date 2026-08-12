import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { createServer, type Server } from "node:net";
import {
  copyFile,
  link,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  preflightNovelImport,
  readNovelPreflightSourceForCommit,
} from "../src/core/novel-import.js";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const mammothEntry = require.resolve("mammoth");
const mammothRoot = mammothEntry.slice(0, mammothEntry.lastIndexOf(`${path.sep}lib${path.sep}`));
const docxFixture = path.join(mammothRoot, "test", "test-data", "single-paragraph.docx");
const temporaryRoots: string[] = [];
const servers: Server[] = [];

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function bytewiseCompare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

async function createFixture(): Promise<{ base: string; source: string }> {
  // Unix-domain socket paths have a small platform limit; use the canonical
  // short temporary root so the socket fixture exercises the node type itself.
  const base = await realpath(await mkdtemp(path.join(await realpath("/tmp"), "novel-source-")));
  temporaryRoots.push(base);
  const source = path.join(base, "source");
  await mkdir(source);
  return { base, source };
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function sourceSnapshot(root: string): Promise<string> {
  const rows: Array<Record<string, string | null>> = [];
  async function visit(absolutePath: string, relativePath: string): Promise<void> {
    const metadata = await lstat(absolutePath, { bigint: true });
    const type = metadata.isSymbolicLink()
      ? "symlink"
      : metadata.isDirectory()
        ? "directory"
        : metadata.isFile()
          ? "file"
          : "special";
    let contentSha256: string | null = null;
    if (type === "file") contentSha256 = sha256(await readFile(absolutePath));
    if (type === "symlink") contentSha256 = sha256(await readlink(absolutePath, { encoding: "buffer" }));
    rows.push({
      relativePath: relativePath || ".",
      type,
      mode: metadata.mode.toString(),
      nlink: metadata.nlink.toString(),
      size: metadata.size.toString(),
      mtimeNs: metadata.mtimeNs.toString(),
      ctimeNs: metadata.ctimeNs.toString(),
      contentSha256,
    });
    if (type !== "directory") return;
    for (const name of (await readdir(absolutePath)).sort(bytewiseCompare)) {
      await visit(path.join(absolutePath, name), relativePath ? `${relativePath}/${name}` : name);
    }
  }
  await visit(root, "");
  rows.sort((left, right) => bytewiseCompare(String(left.relativePath), String(right.relativePath)));
  return JSON.stringify(rows);
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(closeServer));
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe.sequential("小说来源只读预检", () => {
  it("稳定预检单个 UTF-8 TXT，并由 commit 只读入口重新核对完整字节 SHA", async () => {
    const { source } = await createFixture();
    const filePath = path.join(source, "单章.txt");
    const content = "第一章 树下的鱼\n嘟嘟在树根旁醒来。";
    await writeFile(filePath, content, "utf8");
    const before = await sourceSnapshot(source);

    const preflight = await preflightNovelImport(filePath);

    expect(preflight).toMatchObject({
      schemaVersion: 1,
      kind: "novel-import-preflight",
      selectionKind: "file",
      sourcePath: filePath,
      sourceRoot: source,
      eligible: true,
      summary: { entries: 1, supportedFiles: 1, unsupportedEntries: 0, duplicateFiles: 0, chapterCount: 1 },
    });
    expect(preflight.preflightId).toMatch(/^novel-preflight-[a-f0-9]{24}$/u);
    expect(preflight.sourceTreeAggregateSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(preflight.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(preflight.files[0]).toMatchObject({
      relativePath: "单章.txt",
      kind: "text",
      encoding: "utf-8",
      byteLength: Buffer.byteLength(content),
      sha256: sha256(Buffer.from(content, "utf8")),
      decodedTextSha256: sha256(Buffer.from(content, "utf8")),
      charCount: content.length,
      chapterCount: 1,
    });

    const reread = await readNovelPreflightSourceForCommit(preflight, preflight.files[0]!);
    expect(reread.text).toBe(content);
    expect(reread.sourceBytes).toEqual(Buffer.from(content, "utf8"));
    expect(reread.sha256).toBe(preflight.files[0]!.sha256);
    expect(await sourceSnapshot(source)).toBe(before);

    await writeFile(filePath, `${content}\n源文件已变化`, "utf8");
    await expect(readNovelPreflightSourceForCommit(preflight, preflight.files[0]!))
      .rejects.toThrow(/SHA|byteLength|变化|全树状态|不一致/u);
  });

  it("目录预检识别 MD/MARKDOWN 与 GB18030，标注重复 SHA，并把 unsupported 普通文件纳入 aggregate", async () => {
    const { source } = await createFixture();
    const markdown = Buffer.from("# 第一章\n青铜神树下起了雾。", "utf8");
    const gb18030 = Buffer.from("b5dad2bbd5c20ab9c5caf1a1a3", "hex");
    await Promise.all([
      writeFile(path.join(source, "a.md"), markdown),
      writeFile(path.join(source, "z.MARKDOWN"), markdown),
      writeFile(path.join(source, "编码.txt"), gb18030),
      writeFile(path.join(source, "notes.bin"), Buffer.from("unsupported-v1", "utf8")),
      mkdir(path.join(source, "空目录")),
    ]);
    const before = await sourceSnapshot(source);

    const first = await preflightNovelImport(source);
    const repeated = await preflightNovelImport(source);

    expect(repeated).toEqual(first);
    expect(first.eligible).toBe(true);
    expect(first.summary).toMatchObject({ entries: 5, supportedFiles: 3, unsupportedEntries: 1, duplicateFiles: 1, chapterCount: 3 });
    expect(first.files.map((file) => file.relativePath)).toEqual(["a.md", "z.MARKDOWN", "编码.txt"].sort(bytewiseCompare));
    expect(first.files.find((file) => file.relativePath === "编码.txt")).toMatchObject({
      encoding: "gb18030",
      charCount: "第一章\n古蜀。".length,
      chapterCount: 1,
    });
    expect(first.files.find((file) => file.relativePath === "z.MARKDOWN")?.duplicateOf).toBe("a.md");
    expect(first.unsupported).toEqual([
      expect.objectContaining({ relativePath: "notes.bin", entryType: "file", fatal: false }),
    ]);
    expect(first.warnings.join("\n")).toContain("全树 aggregate");
    expect(await sourceSnapshot(source)).toBe(before);

    const gbFile = first.files.find((file) => file.relativePath === "编码.txt")!;
    const gbReread = await readNovelPreflightSourceForCommit(first, gbFile);
    expect(gbReread.text).toBe("第一章\n古蜀。");
    expect(gbReread.sourceBytes).toEqual(gb18030);

    await writeFile(path.join(source, "notes.bin"), Buffer.from("unsupported-v2", "utf8"));
    const unsupportedChanged = await preflightNovelImport(source);
    expect(unsupportedChanged.sourceTreeAggregateSha256).not.toBe(first.sourceTreeAggregateSha256);
    expect(unsupportedChanged.files.map((file) => file.sha256)).toEqual(first.files.map((file) => file.sha256));
  });

  it("通过隔离解析器预检真实 DOCX，commit 复验仍返回原始 DOCX 字节", async () => {
    const { source } = await createFixture();
    const filePath = path.join(source, "章节.docx");
    await copyFile(docxFixture, filePath);
    const original = await readFile(filePath);
    const before = await sourceSnapshot(source);

    const preflight = await preflightNovelImport(filePath);

    expect(preflight.eligible).toBe(true);
    expect(preflight.files[0]).toMatchObject({
      relativePath: "章节.docx",
      kind: "docx",
      encoding: "docx",
      byteLength: original.byteLength,
      sha256: sha256(original),
      decodedTextSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      docx: {
        outputSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        memberCount: expect.any(Number),
        expandedBytes: expect.any(Number),
        converter: { name: "mammoth", version: expect.any(String), contractVersion: 1 },
      },
    });
    expect(preflight.files[0]!.charCount).toBeGreaterThan(0);
    expect(preflight.files[0]!.chapterCount).toBeGreaterThan(0);
    const reread = await readNovelPreflightSourceForCommit(preflight, preflight.files[0]!);
    expect(reread.sourceBytes).toEqual(original);
    expect(reread.text.length).toBe(preflight.files[0]!.charCount);
    expect(reread.sha256).toBe(sha256(original));
    expect(preflight.files[0]!.decodedTextSha256).toBe(sha256(Buffer.from(reread.text, "utf8")));
    expect(preflight.files[0]!.docx?.outputSha256).toBe(preflight.files[0]!.decodedTextSha256);
    expect(await sourceSnapshot(source)).toBe(before);
  });

  it("不跟随 symlink，也不打开 FIFO/socket/device；这些节点全部作为 fatal 报告", async () => {
    const { base, source } = await createFixture();
    const outside = path.join(base, "outside-secret.md");
    await writeFile(outside, "不得被预检读取的外部秘密", "utf8");
    await writeFile(path.join(source, "正文.md"), "# 第一章\n安全正文", "utf8");
    await symlink(outside, path.join(source, "越界.md"));
    await link(outside, path.join(source, "硬链接.md"));
    await execFileAsync("mkfifo", [path.join(source, "管道.txt")]);
    const socketPath = path.join(source, "服务.sock");
    const server = createServer();
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    const before = await sourceSnapshot(source);

    const preflight = await preflightNovelImport(source);

    expect(preflight.eligible).toBe(false);
    expect(preflight.files).toHaveLength(1);
    expect(preflight.unsupported).toEqual(expect.arrayContaining([
      expect.objectContaining({ relativePath: "越界.md", entryType: "symlink", fatal: true }),
      expect.objectContaining({ relativePath: "硬链接.md", entryType: "file", fatal: true }),
      expect.objectContaining({ relativePath: "管道.txt", entryType: "special", fatal: true }),
      expect.objectContaining({ relativePath: "服务.sock", entryType: "special", fatal: true }),
    ]));
    expect(JSON.stringify(preflight)).not.toContain("不得被预检读取的外部秘密");
    expect(await sourceSnapshot(source)).toBe(before);
    await expect(readNovelPreflightSourceForCommit(preflight, preflight.files[0]!))
      .rejects.toThrow(/eligible|fatal/u);

    const device = await preflightNovelImport("/dev/null");
    expect(device.eligible).toBe(false);
    expect(device.unsupported).toEqual([
      expect.objectContaining({ relativePath: "null", entryType: "special", fatal: true }),
    ]);
  });

  it("预检期拒绝 locator 不可表达的路径以及 NUL/UTF-16 伪装文本", async () => {
    const { source } = await createFixture();
    await Promise.all([
      writeFile(path.join(source, "反\\斜.md"), "# 第一章\n安全正文", "utf8"),
      writeFile(path.join(source, "nul.txt"), Buffer.from("第一章\0正文", "utf8")),
      writeFile(path.join(source, "utf16.txt"), Buffer.from("Chapter 1\nbody", "utf16le")),
      writeFile(path.join(source, "utf16-bom.txt"), Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.from("Chapter 1\nbody", "utf16le"),
      ])),
    ]);
    const before = await sourceSnapshot(source);

    const preflight = await preflightNovelImport(source);

    expect(preflight.eligible).toBe(false);
    expect(preflight.files).toHaveLength(0);
    expect(preflight.unsupported).toEqual(expect.arrayContaining([
      expect.objectContaining({ relativePath: "反\\斜.md", fatal: true, reason: expect.stringMatching(/locator/u) }),
      expect.objectContaining({ relativePath: "nul.txt", fatal: true, reason: expect.stringMatching(/NUL/u) }),
      expect.objectContaining({ relativePath: "utf16.txt", fatal: true, reason: expect.stringMatching(/NUL|UTF-16/u) }),
      expect.objectContaining({ relativePath: "utf16-bom.txt", fatal: true, reason: expect.stringMatching(/UTF-16/u) }),
    ]));
    expect(await sourceSnapshot(source)).toBe(before);
  });

  it("支持格式的零字节/超限文件失败关闭，条目和总字节上限停止无界扫描", async () => {
    const { source } = await createFixture();
    await writeFile(path.join(source, "empty.txt"), Buffer.alloc(0));
    await writeFile(path.join(source, "large.md"), "# 第一章\n1234567890", "utf8");

    const report = await preflightNovelImport(source, { limits: { maximumSingleFileBytes: 8 } });
    expect(report.eligible).toBe(false);
    expect(report.files).toHaveLength(0);
    expect(report.unsupported).toEqual(expect.arrayContaining([
      expect.objectContaining({ relativePath: "empty.txt", fatal: true }),
      expect.objectContaining({ relativePath: "large.md", fatal: true }),
    ]));
    await expect(preflightNovelImport(source, { limits: { maximumEntries: 1 } }))
      .rejects.toThrow(/条目超过/u);
    await expect(preflightNovelImport(source, { limits: { maximumTotalBytes: 4 } }))
      .rejects.toThrow(/总字节超过/u);
  });

  it("commit 只读复验拒绝伪造的文件元数据和 relativePath", async () => {
    const { source } = await createFixture();
    const filePath = path.join(source, "正文.md");
    await writeFile(filePath, "# 第一章\n正文", "utf8");
    const preflight = await preflightNovelImport(filePath);
    const file = preflight.files[0]!;

    await expect(readNovelPreflightSourceForCommit(preflight, { ...file, sha256: "0".repeat(64) }))
      .rejects.toThrow(/不属于|篡改/u);
    await expect(readNovelPreflightSourceForCommit(preflight, { ...file, relativePath: "../正文.md" }))
      .rejects.toThrow(/不属于|篡改/u);
    await expect(readNovelPreflightSourceForCommit({ ...preflight, sourceRoot: path.dirname(source) }, file))
      .rejects.toThrow(/fingerprint/u);
    await expect(readNovelPreflightSourceForCommit(preflight, { ...file, decodedTextSha256: "0".repeat(64) }))
      .rejects.toThrow(/不属于|篡改/u);
  });

  it("目录在 DOCX 隔离解析期间被换成新 inode 时整次预检失败关闭", async () => {
    const { base, source } = await createFixture();
    await copyFile(docxFixture, path.join(source, "a.docx"));
    await writeFile(path.join(source, "z.txt"), "第一章\n尾部文件", "utf8");
    const operation = preflightNovelImport(source);
    const rejection = expect(operation).rejects.toThrow(/身份已变化|发生变化|ENOENT|no such file/iu);
    await delay(10);
    await rename(source, path.join(base, "source-original"));
    await mkdir(source);

    await rejection;
  });
});
