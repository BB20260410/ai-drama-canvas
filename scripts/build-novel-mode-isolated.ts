/**
 * 在显式系统临时目录中构建当前源码，并证明 live release-manifest / dist-mcp
 * 及指定只读观察 PID 未被触碰。调用方负责在后续 UI smoke 完成后处置临时快照。
 */
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  stat,
  symlink,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { computeSourceDigest } from "../src/core/build-identity.js";

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const requestedRoot = argument("--snapshot-root");
if (!requestedRoot || !path.isAbsolute(requestedRoot)) {
  throw new Error("需要 --snapshot-root <系统临时目录中的绝对空目录>。");
}
const snapshotRoot = await realpath(requestedRoot);
const allowedTemporaryRoots = [...new Set(await Promise.all([os.tmpdir(), "/tmp"].map((candidate) => realpath(candidate))))];
const isInsideAllowedTemporaryRoot = allowedTemporaryRoots.some((temporaryRoot) => {
  const relative = path.relative(temporaryRoot, snapshotRoot);
  return Boolean(relative)
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
});
if (!isInsideAllowedTemporaryRoot
  || !path.basename(snapshotRoot).startsWith("novel-mode-isolated-build.")) {
  throw new Error(`隔离构建根必须是系统临时目录中的 novel-mode-isolated-build.*：${snapshotRoot}`);
}
if (!(await stat(snapshotRoot)).isDirectory() || (await readdir(snapshotRoot)).length !== 0) {
  throw new Error(`隔离构建根必须是空目录：${snapshotRoot}`);
}

const protectedPidText = argument("--protected-pid");
const protectedPid = protectedPidText && /^\d+$/u.test(protectedPidText) ? Number(protectedPidText) : undefined;
if (protectedPidText && !protectedPid) throw new Error(`--protected-pid 无效：${protectedPidText}`);

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function fileIdentity(filePath: string): Promise<{ bytes: number; sha256: string }> {
  const bytes = await readFile(filePath);
  return { bytes: bytes.byteLength, sha256: sha256(bytes) };
}

async function directoryIdentity(root: string, relativeBase: string): Promise<{ files: number; bytes: number; sha256: string }> {
  const records: string[] = [];
  let files = 0;
  let bytes = 0;
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute);
      } else if (entry.isFile()) {
        const contents = await readFile(absolute);
        const relative = path.relative(relativeBase, absolute).split(path.sep).join("/");
        files += 1;
        bytes += contents.byteLength;
        records.push(`${sha256(contents)}  ${relative}`);
      } else {
        throw new Error(`构建身份目录包含非普通文件：${absolute}`);
      }
    }
  }
  await visit(root);
  return { files, bytes, sha256: sha256(`${records.join("\n")}\n`) };
}

async function run(command: string, args: string[], options: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  capture?: boolean;
} = {}): Promise<{ exitCode: number; output: string }> {
  const child = spawn(command, args, {
    cwd: options.cwd ?? workspace,
    env: options.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const chunks: Buffer[] = [];
  const forward = (chunk: Buffer, stderr: boolean): void => {
    chunks.push(Buffer.from(chunk));
    if (!options.capture) (stderr ? process.stderr : process.stdout).write(chunk);
  };
  child.stdout.on("data", (chunk: Buffer) => forward(chunk, false));
  child.stderr.on("data", (chunk: Buffer) => forward(chunk, true));
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
  return { exitCode, output: Buffer.concat(chunks).toString("utf8") };
}

async function processCommand(pid: number | undefined): Promise<string | null> {
  if (!pid) return null;
  const result = await run("ps", ["-p", String(pid), "-o", "command="], { capture: true });
  return result.exitCode === 0 ? result.output.trim() || null : null;
}

const liveReleasePath = path.join(workspace, "release-manifest.json");
const liveDistRoot = path.join(workspace, "dist-mcp");
const before = {
  releaseManifest: await fileIdentity(liveReleasePath),
  distMcp: await directoryIdentity(liveDistRoot, workspace),
  protectedProcessCommand: await processCommand(protectedPid),
};
if (protectedPid && !before.protectedProcessCommand) throw new Error(`保护 PID ${protectedPid} 在构建前不存在。`);

const snapshot = path.join(snapshotRoot, "workspace");
const runtime = path.join(snapshotRoot, "runtime");
await Promise.all([
  mkdir(snapshot, { recursive: true }),
  mkdir(path.join(runtime, "home"), { recursive: true }),
  mkdir(path.join(runtime, "tmp"), { recursive: true }),
  mkdir(path.join(runtime, "registry"), { recursive: true }),
]);

const copy = await run("rsync", [
  "-a",
  "--",
  "src",
  "tests",
  "scripts",
  "package.json",
  "package-lock.json",
  "vitest.config.ts",
  "electron.vite.config.ts",
  ...((await readdir(workspace)).filter((name) => /^tsconfig.*\.json$/u.test(name)).sort()),
  `${snapshot}${path.sep}`,
]);
if (copy.exitCode !== 0) throw new Error(`隔离源码复制失败，exit=${copy.exitCode}`);

const liveNodeModules = path.join(workspace, "node_modules");
if (!(await lstat(liveNodeModules)).isDirectory()) throw new Error("工作区 node_modules 不可用。");
await symlink(liveNodeModules, path.join(snapshot, "node_modules"), "dir");

const childEnvironment: NodeJS.ProcessEnv = {
  ...process.env,
  HOME: path.join(runtime, "home"),
  TMPDIR: path.join(runtime, "tmp"),
  AI_CANVAS_REGISTRY_PATH: path.join(runtime, "registry", "projects.json"),
  AI_CANVAS_WORKSPACE: snapshot,
  AI_CANVAS_WRITE_LEASE_MODE: "require",
};
delete childEnvironment.AI_CANVAS_MCP_ALLOW_MULTI;
delete childEnvironment.AI_CANVAS_MCP_SINGLETON;

const built = await run("npm", ["run", "build"], { cwd: snapshot, env: childEnvironment });
if (built.exitCode !== 0) throw new Error(`隔离 npm run build 失败，exit=${built.exitCode}`);

const [snapshotSource, releaseManifest] = await Promise.all([
  computeSourceDigest(snapshot),
  readFile(path.join(snapshot, "release-manifest.json"), "utf8").then((text) => JSON.parse(text) as {
    sourceDigest?: string;
    buildId?: string;
    buildIdentityFingerprint?: string;
  }),
]);
if (releaseManifest.sourceDigest !== snapshotSource.sourceDigest) {
  throw new Error(`隔离构建 manifest/source 不一致：${releaseManifest.sourceDigest} != ${snapshotSource.sourceDigest}`);
}
for (const required of ["out/main/index.js", "out/preload/index.mjs", "out/renderer/index.html", "dist-mcp/mcp/server.js"]) {
  const metadata = await stat(path.join(snapshot, required));
  if (!metadata.isFile() || metadata.size === 0) throw new Error(`隔离构建工件缺失：${required}`);
}

const after = {
  releaseManifest: await fileIdentity(liveReleasePath),
  distMcp: await directoryIdentity(liveDistRoot, workspace),
  protectedProcessCommand: await processCommand(protectedPid),
};
if (JSON.stringify(before) !== JSON.stringify(after)) {
  throw new Error(`隔离构建触碰 live runtime：${JSON.stringify({ before, after })}`);
}

process.stdout.write(`${JSON.stringify({
  verdict: "PASS",
  snapshot,
  snapshotSource: {
    sourceDigest: snapshotSource.sourceDigest,
    sourceFiles: snapshotSource.sourceFiles,
    sourceBytes: snapshotSource.sourceBytes,
  },
  releaseManifest,
  liveRuntimeStable: true,
  protectedPid: protectedPid ?? null,
  protectedProcessStable: before.protectedProcessCommand === after.protectedProcessCommand,
}, null, 2)}\n`);
