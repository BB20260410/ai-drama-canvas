import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  stat,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import {
  assertPathInsidePackageRoot,
  assertTemporaryPackageRoot,
} from "./isolated-package-guards.js";

interface FileManifestEntry {
  relativePath: string;
  bytes: number;
  mtimeMs: number;
  sha256: string;
}

interface CommandEvidence {
  label: string;
  executable: string;
  args: string[];
  durationMs: number;
  stdoutTail: string;
  stderrTail: string;
}

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspaceDistMcp = path.join(workspace, "dist-mcp");
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-t23-source-build-"));
const temporaryDirectory = path.join(tempRoot, "tmp");
const buildOutput = path.join(tempRoot, "out");
const vitestExecutable = path.join(workspace, "node_modules", ".bin", "vitest");
const tscExecutable = path.join(workspace, "node_modules", ".bin", "tsc");
const electronViteExecutable = path.join(workspace, "node_modules", ".bin", "electron-vite");
const commandEvidence: CommandEvidence[] = [];

function tail(value: string, maxLines = 12, maxCharacters = 4_000): string {
  const selected = value.trim().split(/\r?\n/u).slice(-maxLines).join("\n");
  return selected.length > maxCharacters ? selected.slice(-maxCharacters) : selected;
}

async function exists(candidate: string): Promise<boolean> {
  return access(candidate).then(() => true, () => false);
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function fileManifest(root: string): Promise<FileManifestEntry[]> {
  if (!(await exists(root))) return [];
  const manifest: FileManifestEntry[] = [];
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, "en"))) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
      } else if (entry.isFile()) {
        const fileStat = await stat(entryPath);
        manifest.push({
          relativePath: path.relative(root, entryPath).split(path.sep).join("/"),
          bytes: fileStat.size,
          mtimeMs: fileStat.mtimeMs,
          sha256: await sha256File(entryPath),
        });
      }
    }
  }
  await visit(root);
  return manifest;
}

function manifestFingerprint(manifest: FileManifestEntry[]): string {
  return createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
}

async function runCommand(
  label: string,
  executable: string,
  args: string[],
): Promise<void> {
  const startedAt = performance.now();
  await new Promise<void>((resolvePromise, rejectPromise) => {
    execFile(
      executable,
      args,
      {
        cwd: workspace,
        env: {
          ...process.env,
          TMPDIR: temporaryDirectory,
        },
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
        timeout: 10 * 60_000,
      },
      (error, stdout, stderr) => {
        const evidence: CommandEvidence = {
          label,
          executable: path.relative(workspace, executable),
          args,
          durationMs: Number((performance.now() - startedAt).toFixed(3)),
          stdoutTail: tail(stdout),
          stderrTail: tail(stderr),
        };
        commandEvidence.push(evidence);
        if (error) {
          rejectPromise(new Error(
            `${label} 失败：${error.message}\n${evidence.stderrTail || evidence.stdoutTail}`,
          ));
        } else {
          resolvePromise();
        }
      },
    );
  });
}

assertTemporaryPackageRoot(tempRoot, workspace);
assertPathInsidePackageRoot(temporaryDirectory, tempRoot, "T23 隔离 TMPDIR");
assertPathInsidePackageRoot(buildOutput, tempRoot, "T23 隔离源码构建输出");
await mkdir(temporaryDirectory, { recursive: true });

const distMcpBefore = await fileManifest(workspaceDistMcp);
let distMcpAfter: FileManifestEntry[] = [];
let buildManifest: FileManifestEntry[] = [];
let runError: unknown;

try {
  await runCommand(
    "IPC duration focused tests",
    vitestExecutable,
    ["run", "tests/t23-ipc-performance-probe.test.ts"],
  );
  await runCommand(
    "IPC probe focused typecheck",
    tscExecutable,
    [
      "--noEmit",
      "--target",
      "ES2023",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--strict",
      "--noUncheckedIndexedAccess",
      "--esModuleInterop",
      "--skipLibCheck",
      "--types",
      "node",
      "src/preload/t23-ipc-performance-probe.ts",
    ],
  );
  await runCommand(
    "isolated current-source Electron build",
    electronViteExecutable,
    ["build", "--outDir", buildOutput, "--logLevel", "error"],
  );

  for (const requiredOutput of [
    path.join(buildOutput, "main", "index.js"),
    path.join(buildOutput, "preload", "index.mjs"),
    path.join(buildOutput, "renderer", "index.html"),
  ]) {
    if (!(await exists(requiredOutput))) {
      throw new Error(`隔离源码构建缺少产物：${requiredOutput}`);
    }
  }
  buildManifest = await fileManifest(buildOutput);
} catch (error) {
  runError = error;
} finally {
  distMcpAfter = await fileManifest(workspaceDistMcp);
  if (JSON.stringify(distMcpBefore) !== JSON.stringify(distMcpAfter)) {
    runError = new Error(
      `工作区 dist-mcp 在隔离源码构建期间发生变化：${JSON.stringify({
        before: manifestFingerprint(distMcpBefore),
        after: manifestFingerprint(distMcpAfter),
      })}`,
    );
  }
  await rm(tempRoot, { recursive: true, force: true });
}

if (runError) throw runError;
if (await exists(tempRoot)) throw new Error(`T23 隔离临时目录未清理：${tempRoot}`);

const buildBytes = buildManifest.reduce((sum, entry) => sum + entry.bytes, 0);
console.log(JSON.stringify({
  schemaVersion: 1,
  status: "passed",
  scope: "t23-ipc-duration-and-isolated-current-source-build",
  commandEvidence,
  isolatedBuild: {
    fileCount: buildManifest.length,
    bytes: buildBytes,
    temporaryRootRemoved: true,
  },
  liveDistMcp: {
    unchanged: true,
    fileCount: distMcpAfter.length,
    manifestFingerprint: manifestFingerprint(distMcpAfter),
  },
}, null, 2));
