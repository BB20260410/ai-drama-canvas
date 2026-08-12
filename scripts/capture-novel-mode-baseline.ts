import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createBuildIdentity } from "../src/core/build-identity.js";

interface CliOptions {
  outputPath: string;
}

function parseArgs(argv: string[]): CliOptions {
  const outputIndex = argv.indexOf("--output");
  const value = outputIndex >= 0 ? argv[outputIndex + 1]?.trim() : "";
  if (!value) {
    throw new Error("用法：tsx scripts/capture-novel-mode-baseline.ts --output <repo-relative-json-path>");
  }
  const outputPath = path.resolve(process.cwd(), value);
  const workspace = path.resolve(process.cwd());
  const relative = path.relative(workspace, outputPath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("基线输出必须位于当前工作区内。 ");
  }
  if (!relative.startsWith(`docs${path.sep}evidence${path.sep}novel-mode-v1${path.sep}baseline${path.sep}`)) {
    throw new Error("基线输出只能写入 docs/evidence/novel-mode-v1/baseline/。 ");
  }
  if (path.extname(outputPath).toLowerCase() !== ".json") {
    throw new Error("基线输出必须是 JSON 文件。 ");
  }
  return { outputPath };
}

function run(command: string, args: string[]): string {
  try {
    return execFileSync(command, args, {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return "";
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sortedNonEmptyLines(value: string): string[] {
  return value
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right, "en"));
}

function gitStatusCategory(line: string): "untracked" | "tracked" {
  return line.startsWith("??") ? "untracked" : "tracked";
}

const options = parseArgs(process.argv.slice(2));
const workspace = process.cwd();
const packageJson = JSON.parse(await readFile(path.join(workspace, "package.json"), "utf8")) as {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
const statusLines = sortedNonEmptyLines(run("git", ["status", "--porcelain=v1", "--untracked-files=all"]));
const tracked = statusLines.filter((line) => gitStatusCategory(line) === "tracked");
const untracked = statusLines.filter((line) => gitStatusCategory(line) === "untracked");
const identity = await createBuildIdentity(workspace);
const cpuModels = [...new Set(os.cpus().map((cpu) => cpu.model.trim()).filter(Boolean))];
const overlapCandidates = [
  "src/core/command-bus.ts",
  "src/main/index.ts",
  "src/preload/index.ts",
  "src/renderer/src/App.vue",
  "src/renderer/src/components/MaterialStudioView.vue",
];
const dirtyPaths = statusLines.map((line) => line.slice(3).replace(/^"|"$/gu, ""));
const highOverlapDirtyPaths = overlapCandidates.filter((candidate) => dirtyPaths.some((entry) => entry === candidate));
const capturedAt = new Date().toISOString();
const stableIdentity = {
  schemaVersion: identity.schemaVersion,
  kind: identity.kind,
  buildId: identity.buildId,
  sourceDigest: identity.sourceDigest,
  packageVersion: identity.packageVersion,
  capabilities: identity.capabilities,
  fingerprint: identity.fingerprint,
  roots: {
    sourceFiles: identity.roots.sourceFiles,
    sourceBytes: identity.roots.sourceBytes,
  },
};

const report = {
  schemaVersion: 1,
  kind: "novel-mode-v1-baseline",
  capturedAt,
  workspace: ".",
  repository: {
    head: run("git", ["rev-parse", "HEAD"]) || null,
    branch: run("git", ["branch", "--show-current"]) || null,
    dirty: statusLines.length > 0,
    statusCount: statusLines.length,
    trackedStatusCount: tracked.length,
    untrackedStatusCount: untracked.length,
    statusSha256: sha256(`${statusLines.join("\n")}\n`),
    statusEntries: statusLines,
    highOverlapDirtyPaths,
  },
  runtime: {
    node: process.version,
    electronDeclared: packageJson.devDependencies?.electron ?? packageJson.dependencies?.electron ?? null,
    platform: process.platform,
    architecture: process.arch,
    osType: os.type(),
    osRelease: os.release(),
    macosProductVersion: run("sw_vers", ["-productVersion"]) || null,
    cpuModels,
    logicalCpuCount: os.cpus().length,
    totalMemoryBytes: os.totalmem(),
  },
  package: {
    name: packageJson.name ?? null,
    version: packageJson.version ?? null,
  },
  buildIdentity: stableIdentity,
  safety: {
    activeProductionProjectWasOpened: false,
    formalNovelSourceWasWritten: false,
    gitMutationPerformed: false,
    externalNetworkRequestPerformed: false,
  },
};

await mkdir(path.dirname(options.outputPath), { recursive: true });
await writeFile(options.outputPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
process.stdout.write(`${JSON.stringify({
  outputPath: path.relative(workspace, options.outputPath),
  capturedAt,
  sourceDigest: identity.sourceDigest,
  buildId: identity.buildId,
  statusCount: statusLines.length,
  highOverlapDirtyPaths,
}, null, 2)}\n`);
