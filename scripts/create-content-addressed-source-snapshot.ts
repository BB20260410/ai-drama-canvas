import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  readlink,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

type SnapshotEntry = {
  path: string;
  kind: "file" | "symlink";
  bytes: number;
  mode: number;
  sha256: string;
  linkTarget?: string;
};

const workspace = path.resolve(process.argv[2] ?? process.cwd());
const snapshotFamily = path.join(workspace, "docs", "evidence", "source-snapshots");
const formalProject = path.join(workspace, "productions", "gushujuan-s3-f1a688020bfb7af6");
const sourceRoots = ["src", "tests", "scripts", "docs", ".planning"];
const rootFiles = [
  ".gitignore",
  "README.md",
  "package.json",
  "package-lock.json",
  "electron.vite.config.ts",
  "vitest.config.ts",
  "tsconfig.json",
  "tsconfig.mcp.json",
  "tsconfig.node.json",
  "tsconfig.web.json",
];
const excludedPrefixes = [
  "docs/evidence/source-snapshots/",
  "node_modules/",
  "out/",
  "dist-mcp/",
  "build/",
  "output/",
  "productions/",
];

function normalize(relativePath: string): string {
  return relativePath.split(path.sep).join("/");
}

function sha256Bytes(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256File(filePath: string): Promise<string> {
  return sha256Bytes(await readFile(filePath));
}

function excluded(relativePath: string): boolean {
  const normalized = normalize(relativePath);
  return excludedPrefixes.some((prefix) => normalized === prefix.slice(0, -1) || normalized.startsWith(prefix));
}

async function collectPath(relativePath: string, entries: SnapshotEntry[]): Promise<void> {
  if (excluded(relativePath)) return;
  const absolutePath = path.join(workspace, relativePath);
  const fileStat = await lstat(absolutePath);
  if (fileStat.isDirectory()) {
    const children = await readdir(absolutePath);
    for (const child of children.sort((left, right) => left.localeCompare(right, "zh-CN"))) {
      await collectPath(path.join(relativePath, child), entries);
    }
    return;
  }
  if (fileStat.isSymbolicLink()) {
    const linkTarget = await readlink(absolutePath);
    entries.push({
      path: normalize(relativePath),
      kind: "symlink",
      bytes: Buffer.byteLength(linkTarget),
      mode: fileStat.mode & 0o777,
      sha256: sha256Bytes(linkTarget),
      linkTarget,
    });
    return;
  }
  if (!fileStat.isFile()) return;
  entries.push({
    path: normalize(relativePath),
    kind: "file",
    bytes: fileStat.size,
    mode: fileStat.mode & 0o777,
    sha256: await sha256File(absolutePath),
  });
}

async function collectSourceEntries(): Promise<SnapshotEntry[]> {
  const entries: SnapshotEntry[] = [];
  for (const relativePath of [...rootFiles, ...sourceRoots]) {
    try {
      await collectPath(relativePath, entries);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return entries.sort((left, right) => left.path.localeCompare(right.path, "zh-CN"));
}

async function collectFormalGuardEntries(): Promise<SnapshotEntry[]> {
  const candidates = new Set<string>();
  const exactPaths = [
    "fusion-production-materialization.json",
    "fusion-project-manifest.json",
    ".aicanvas/generation-jobs.json",
    ".aicanvas/publications.json",
    ".aicanvas/reviews.json",
  ];
  const recursiveRoots = [
    "source_snapshot",
    "authorities",
    ".aicanvas/generation-requests",
    ".aicanvas/generation-downloads",
    ".aicanvas/subagent-staging",
  ];

  async function walk(absolutePath: string): Promise<void> {
    let fileStat;
    try {
      fileStat = await lstat(absolutePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (fileStat.isDirectory()) {
      for (const child of (await readdir(absolutePath)).sort((left, right) => left.localeCompare(right, "zh-CN"))) {
        await walk(path.join(absolutePath, child));
      }
      return;
    }
    if (fileStat.isFile() || fileStat.isSymbolicLink()) candidates.add(path.relative(workspace, absolutePath));
  }

  for (const relativePath of exactPaths) await walk(path.join(formalProject, relativePath));
  for (const relativePath of recursiveRoots) await walk(path.join(formalProject, relativePath));
  await walk(path.join(formalProject, "assets"));

  async function findRawLabeled(absolutePath: string): Promise<void> {
    let fileStat;
    try {
      fileStat = await lstat(absolutePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (fileStat.isDirectory()) {
      const relative = normalize(path.relative(formalProject, absolutePath));
      if (relative.startsWith("source_snapshot") || relative.startsWith(".aicanvas/backups")) return;
      for (const child of await readdir(absolutePath)) await findRawLabeled(path.join(absolutePath, child));
      return;
    }
    if (fileStat.isFile() && /_(?:raw|labeled)\.(?:png|jpe?g|webp)$/i.test(path.basename(absolutePath))) {
      candidates.add(path.relative(workspace, absolutePath));
    }
  }
  await findRawLabeled(formalProject);

  const entries: SnapshotEntry[] = [];
  for (const relativePath of [...candidates].sort((left, right) => left.localeCompare(right, "zh-CN"))) {
    const absolutePath = path.join(workspace, relativePath);
    const fileStat = await lstat(absolutePath);
    if (fileStat.isSymbolicLink()) {
      const linkTarget = await readlink(absolutePath);
      entries.push({ path: normalize(relativePath), kind: "symlink", bytes: Buffer.byteLength(linkTarget), mode: fileStat.mode & 0o777, sha256: sha256Bytes(linkTarget), linkTarget });
    } else {
      entries.push({ path: normalize(relativePath), kind: "file", bytes: fileStat.size, mode: fileStat.mode & 0o777, sha256: await sha256File(absolutePath) });
    }
  }
  return entries;
}

async function verifyExtractedEntries(extractedRoot: string, entries: SnapshotEntry[]): Promise<void> {
  for (const entry of entries) {
    const extractedPath = path.join(extractedRoot, ...entry.path.split("/"));
    const extractedStat = await lstat(extractedPath);
    if (entry.kind === "symlink") {
      const target = await readlink(extractedPath);
      if (sha256Bytes(target) !== entry.sha256) throw new Error(`恢复校验失败（符号链接）：${entry.path}`);
    } else if (!extractedStat.isFile() || extractedStat.size !== entry.bytes || await sha256File(extractedPath) !== entry.sha256) {
      throw new Error(`恢复校验失败（文件）：${entry.path}`);
    }
  }
}

const sourceEntries = await collectSourceEntries();
if (sourceEntries.length === 0) throw new Error("没有找到可快照的源码文件。 ");
const formalGuardEntries = await collectFormalGuardEntries();
const canonicalManifest = {
  schemaVersion: 1,
  kind: "content-addressed-source-safety-snapshot",
  workspace,
  include: { sourceRoots, rootFiles },
  exclude: excludedPrefixes,
  entries: sourceEntries,
};
const manifestSha256 = sha256Bytes(JSON.stringify(canonicalManifest));
const snapshotId = `source-${manifestSha256.slice(0, 24)}`;
const snapshotDirectory = path.join(snapshotFamily, snapshotId);
const archivePath = path.join(snapshotDirectory, `${snapshotId}.tar.gz`);
const manifestPath = path.join(snapshotDirectory, "manifest.json");
const guardPath = path.join(snapshotDirectory, "formal-production-guard.json");
const receiptPath = path.join(snapshotDirectory, "receipt.json");
const recoveryPath = path.join(snapshotDirectory, "RECOVERY.md");

await mkdir(snapshotDirectory, { recursive: true });
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-source-snapshot-"));
try {
  const listPath = path.join(tempRoot, "files.txt");
  if (sourceEntries.some((entry) => entry.path.includes("\n"))) throw new Error("快照路径包含换行，拒绝生成 tar 文件。 ");
  await writeFile(listPath, `${sourceEntries.map((entry) => entry.path).join("\n")}\n`, "utf8");
  try {
    await stat(archivePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    execFileSync("tar", ["-czf", archivePath, "-T", listPath], {
      cwd: workspace,
      env: { ...process.env, COPYFILE_DISABLE: "1" },
      stdio: "pipe",
    });
  }

  const extractedRoot = path.join(tempRoot, "extracted");
  await mkdir(extractedRoot, { recursive: true });
  execFileSync("tar", ["-xzf", archivePath, "-C", extractedRoot], { stdio: "pipe" });
  await verifyExtractedEntries(extractedRoot, sourceEntries);

  const archiveStat = await stat(archivePath);
  const archiveSha256 = await sha256File(archivePath);
  const formalGuardCanonical = {
    schemaVersion: 1,
    kind: "formal-production-protected-state-guard",
    projectRoot: formalProject,
    protectedScope: [
      "source_snapshot/**",
      "authorities/**",
      "assets/**",
      ".aicanvas/generation-jobs.json",
      ".aicanvas/publications.json",
      ".aicanvas/reviews.json",
      ".aicanvas/generation-requests/**",
      ".aicanvas/generation-downloads/**",
      ".aicanvas/subagent-staging/**",
      "**/*_raw.{png,jpg,jpeg,webp}",
      "**/*_labeled.{png,jpg,jpeg,webp}",
    ],
    entries: formalGuardEntries,
  };
  const formalGuardSha256 = sha256Bytes(JSON.stringify(formalGuardCanonical));
  const createdAt = new Date().toISOString();
  const manifest = { ...canonicalManifest, snapshotId, manifestSha256 };
  const formalGuard = { ...formalGuardCanonical, aggregateSha256: formalGuardSha256 };
  const receipt = {
    schemaVersion: 1,
    snapshotId,
    createdAt,
    manifestPath,
    manifestSha256,
    sourceFileCount: sourceEntries.length,
    sourceBytes: sourceEntries.reduce((total, entry) => total + entry.bytes, 0),
    archivePath,
    archiveBytes: archiveStat.size,
    archiveSha256,
    extractionVerified: true,
    verifiedFileCount: sourceEntries.length,
    formalGuardPath: guardPath,
    formalGuardFileCount: formalGuardEntries.length,
    formalGuardBytes: formalGuardEntries.reduce((total, entry) => total + entry.bytes, 0),
    formalGuardSha256,
    gitHeadPresent: false,
    boundaries: {
      sourceSnapshotOnly: true,
      formalProjectCopied: false,
      formalProjectMutated: false,
      browserUsed: false,
      externalGenerationUsed: false,
    },
  };
  const recovery = `# 源码安全快照恢复清单\n\n- 快照 ID：\`${snapshotId}\`\n- 清单 SHA-256：\`${manifestSha256}\`\n- 归档 SHA-256：\`${archiveSha256}\`\n- 源文件：${sourceEntries.length} 个，${receipt.sourceBytes} 字节\n- 正式工程保护清单：${formalGuardEntries.length} 个文件，聚合 SHA-256 \`${formalGuardSha256}\`\n\n## 恢复方法\n\n1. 先确认目标目录为空，避免覆盖现有用户修改。\n2. 校验归档：\`shasum -a 256 ${archivePath}\`。\n3. 解包到隔离目录：\`mkdir -p /tmp/ai-canvas-source-restore && tar -xzf ${archivePath} -C /tmp/ai-canvas-source-restore\`。\n4. 按 \`manifest.json\` 逐文件核对字节数与 SHA-256；本次生成时已完成一次完整解包复验。\n5. 正式工程未复制进归档；\`formal-production-guard.json\` 仅用于核对受保护生产状态是否漂移。\n`;

  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx" }).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST" || await sha256File(manifestPath) !== sha256Bytes(`${JSON.stringify(manifest, null, 2)}\n`)) throw error;
  });
  await writeFile(guardPath, `${JSON.stringify(formalGuard, null, 2)}\n`, { encoding: "utf8", flag: "wx" }).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST" || await sha256File(guardPath) !== sha256Bytes(`${JSON.stringify(formalGuard, null, 2)}\n`)) throw error;
  });
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", flag: "wx" }).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST" || await sha256File(receiptPath) !== sha256Bytes(`${JSON.stringify(receipt, null, 2)}\n`)) throw error;
  });
  await writeFile(recoveryPath, recovery, { encoding: "utf8", flag: "wx" }).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST" || await readFile(recoveryPath, "utf8") !== recovery) throw error;
  });

  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
