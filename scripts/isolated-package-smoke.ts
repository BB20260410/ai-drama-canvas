import { constants, createReadStream } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  rm,
  stat,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import asar from "@electron/asar";
import { computeSourceDigest, listSourceDigestFiles } from "../src/core/build-identity.js";
import { assertReleaseManifest, type ReleaseManifest } from "../src/core/release-manifest.js";
import {
  assertBackgroundSmokeEvidence,
  assertDirectDependencyVersionIdentity,
  assertElectronBinaryProvenance,
  assertExactDependencyVersionIdentity,
  assertOnlyStaticPackagedResources,
  assertPackagedReviewEvidence,
  assertImmutableFileUnchanged,
  assertPathInsidePackageRoot,
  assertTemporaryPackageRoot,
  createIsolatedRuntimeEnvironment,
  type ImmutableFileSnapshot,
  type PackagedReviewEvidence,
} from "./isolated-package-guards.js";
import {
  acquireEvidenceRunLock,
  assertFreshOutputSet,
  createUniqueEvidenceStem,
} from "./lib/exclusive-evidence-output.mjs";
import { seedVerifiedElectronCache } from "./lib/electron-binary-cache.js";
import {
  finalizeIsolatedPackageTerminalEvidence,
  isolatedPackageCompletionMarkerPath,
} from "./lib/isolated-package-terminal-finalizer.mjs";
import {
  assertNpmProductionDependencyHealth,
  type NpmLsJson,
  type NpmProductionDependencyHealthSummary,
  type PackageLockJson,
} from "./lib/npm-production-dependency-health.js";

const execFileAsync = promisify(execFile);
const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runId = createUniqueEvidenceStem("isolated-package-smoke");
const startedAt = new Date().toISOString();
const evidencePath = path.resolve(
  process.argv[2] || path.join(workspace, "docs", "evidence", `${runId}.json`),
);
if (path.basename(evidencePath) === "isolated-package-smoke-latest.json") {
  throw new Error("拒绝使用已退休的 isolated-package-smoke-latest.json；每次验收必须使用唯一新文件名。");
}
const evidenceDirectory = path.dirname(evidencePath);
const evidenceStem = path.basename(evidencePath, path.extname(evidencePath));
const completionMarkerPath = isolatedPackageCompletionMarkerPath(evidencePath);
const packagedUiEvidencePath = path.join(evidenceDirectory, `${evidenceStem}-electron-ui.json`);
const packagedUiScreenshotPath = path.join(evidenceDirectory, `${evidenceStem}-electron-ui.png`);
const packagedReviewEvidencePath = path.join(evidenceDirectory, `${evidenceStem}-review-ui.json`);
const packagedReviewScreenshotPath = path.join(evidenceDirectory, `${evidenceStem}-review-ui.png`);
const oldDmgPath = path.join(workspace, "dist", "AI 漫剧画布-0.1.0-arm64.dmg");
const workspaceDistPath = path.join(workspace, "dist");
const tsxExecutable = path.join(workspace, "node_modules", ".bin", "tsx");
const vitestExecutable = path.join(workspace, "node_modules", ".bin", "vitest");
// Keep the real path short enough for tsx's Unix-domain IPC socket and
// electron-builder's generated ASAR unpack glob on macOS. The per-user cache
// TMPDIR is already long enough to overflow both limits for current packages.
const packageTempBase = process.platform === "darwin" ? "/private/tmp" : os.tmpdir();
await mkdir(evidenceDirectory, { recursive: true });
await assertFreshOutputSet([
  { label: "顶层隔离 App 证据", path: evidencePath },
  { label: "顶层隔离 App completion marker", path: completionMarkerPath },
  { label: "Effect/Transition UI 证据", path: packagedUiEvidencePath },
  { label: "Effect/Transition UI 截图", path: packagedUiScreenshotPath },
  { label: "ReviewStudio UI 证据", path: packagedReviewEvidencePath },
  { label: "ReviewStudio UI 截图", path: packagedReviewScreenshotPath },
]);
const tempRoot = await mkdtemp(path.join(packageTempBase, "aic-pkg-"));
const stageRoot = path.join(tempRoot, "stage");
const builderOutput = path.join(stageRoot, "builder-output");
const builderExecutable = path.join(stageRoot, "node_modules", ".bin", "electron-builder");
const isolatedHome = path.join(tempRoot, "home");
const isolatedTmp = path.join(tempRoot, "t");
const appBuilderTmp = path.join(tempRoot, "app-builder-tmp");
const electronBuilderCache = path.join(tempRoot, "electron-builder-cache");
const electronDownloadCache = path.join(tempRoot, "electron-download-cache");
const npmCache = path.join(tempRoot, "npm-cache");
const emptyProjectRoot = path.join(tempRoot, "empty-project");
const emptyProjectRegistryPath = path.join(tempRoot, "empty-project-registry.json");
const effectTransitionRegistryPath = path.join(tempRoot, "effect-transition-registry.json");
const packagedRegistryPath = path.join(tempRoot, "runtime", "projects.json");
const packagedMediaRuntimeDirectory = path.join(tempRoot, "runtime", "media-v1");
const packagedProjectRoot = path.join(tempRoot, "runtime", "project-root");
const packagedReviewProjectRoot = path.join(isolatedTmp, "review-project");
const packagedReviewRegistryPath = path.join(isolatedTmp, "review-project-registry.json");
const packagedReviewUserDataPath = path.join(isolatedTmp, "review-electron-user-data");
const hostRegistryPath = process.env.AI_CANVAS_REGISTRY_PATH
  ? path.resolve(process.env.AI_CANVAS_REGISTRY_PATH)
  : path.join(os.homedir(), ".aicanvas", "projects.json");
const hostMediaRuntimeDirectory = process.env.AI_CANVAS_MEDIA_RUNTIME_DIR
  ? path.resolve(process.env.AI_CANVAS_MEDIA_RUNTIME_DIR)
  : path.join(os.homedir(), ".aicanvas", "runtime", "media-v1");
const hostMediaRuntimeStatePath = path.join(hostMediaRuntimeDirectory, "state.json");

interface FileManifestEntry {
  relativePath: string;
  bytes: number;
  sha256: string;
}

interface CommandRunEvidence {
  label: string;
  executable: string;
  args: string[];
  durationMs: number;
  stdoutTail: string;
  stderrTail: string;
  productionDependencyHealth?: NpmProductionDependencyHealthSummary;
}

interface CommandRunResult {
  stdout: string;
  stderr: string;
  evidence: CommandRunEvidence;
}

interface ProbeResult {
  exitCode: number | string | null;
  stdoutTail: string;
  stderrTail: string;
}

interface TopLevelEntry {
  name: string;
  kind: "directory" | "file" | "symlink" | "other";
  bytes: number;
  mtimeMs: number;
}

const commandRuns: CommandRunEvidence[] = [];
let evidenceCore: Record<string, unknown> | undefined;
let runError: unknown;
let lingeringProcessesBeforeCleanup: Array<{ pid: number; command: string }> = [];
let lingeringProcessesAfterCleanup: Array<{ pid: number; command: string }> = [];

function tail(value: string, maxLines = 30, maxCharacters = 8_000): string {
  const selected = value.trim().split(/\r?\n/).slice(-maxLines).join("\n");
  return selected.length > maxCharacters ? selected.slice(-maxCharacters) : selected;
}

function sha256Buffer(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function exists(filePath: string): Promise<boolean> {
  return access(filePath).then(() => true, () => false);
}

async function snapshotImmutableFile(filePath: string): Promise<ImmutableFileSnapshot & { path: string }> {
  if (!(await exists(filePath))) return { path: filePath, exists: false };
  const fileStat = await stat(filePath);
  return {
    path: filePath,
    exists: true,
    bytes: fileStat.size,
    mtimeMs: fileStat.mtimeMs,
    sha256: await sha256File(filePath),
  };
}

async function topLevelSnapshot(directory: string): Promise<TopLevelEntry[]> {
  if (!(await exists(directory))) return [];
  const entries = await readdir(directory, { withFileTypes: true });
  return Promise.all(entries.sort((left, right) => left.name.localeCompare(right.name)).map(async (entry) => {
    const entryPath = path.join(directory, entry.name);
    const entryStat = await lstat(entryPath);
    return {
      name: entry.name,
      kind: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : entry.isSymbolicLink() ? "symlink" : "other",
      bytes: entryStat.size,
      mtimeMs: entryStat.mtimeMs,
    };
  }));
}

async function fileManifest(root: string): Promise<FileManifestEntry[]> {
  const manifest: FileManifestEntry[] = [];
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
      } else if (entry.isFile()) {
        const fileStat = await stat(entryPath);
        manifest.push({
          relativePath: path.relative(root, entryPath).split(path.sep).join("/"),
          bytes: fileStat.size,
          sha256: await sha256File(entryPath),
        });
      }
    }
  }
  await visit(root);
  return manifest;
}

function isPathInside(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return Boolean(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function assertNoExternalSymlinks(root: string): Promise<number> {
  let symlinkCount = 0;
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
      } else if (entry.isSymbolicLink()) {
        symlinkCount += 1;
        const target = await readlink(entryPath);
        const resolvedTarget = path.resolve(path.dirname(entryPath), target);
        if (!isPathInside(root, resolvedTarget)) {
          throw new Error(`临时 stage 含有指向外部的软链接：${entryPath} -> ${target}`);
        }
      }
    }
  }
  await visit(root);
  return symlinkCount;
}

async function findProcessesReferencing(fragment: string): Promise<Array<{ pid: number; command: string }>> {
  const result = await execFileAsync("/bin/ps", ["-axo", "pid=,command="], { maxBuffer: 8 * 1024 * 1024, encoding: "utf8" });
  return String(result.stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.includes(fragment))
    .map((line) => {
      const match = line.match(/^(\d+)\s+(.+)$/);
      return match ? { pid: Number(match[1]), command: match[2] } : undefined;
    })
    .filter((entry): entry is { pid: number; command: string } => Boolean(entry) && entry?.pid !== process.pid);
}

async function terminateProcessesReferencing(fragment: string): Promise<void> {
  lingeringProcessesBeforeCleanup = await findProcessesReferencing(fragment);
  for (const processEntry of lingeringProcessesBeforeCleanup) {
    try {
      process.kill(processEntry.pid, "SIGTERM");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  if (lingeringProcessesBeforeCleanup.length) await new Promise((resolve) => setTimeout(resolve, 500));
  lingeringProcessesAfterCleanup = await findProcessesReferencing(fragment);
  for (const processEntry of lingeringProcessesAfterCleanup) {
    try {
      process.kill(processEntry.pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  if (lingeringProcessesAfterCleanup.length) await new Promise((resolve) => setTimeout(resolve, 250));
  lingeringProcessesAfterCleanup = await findProcessesReferencing(fragment);
}

function manifestSummary(manifest: FileManifestEntry[]): { fileCount: number; bytes: number; sha256: string } {
  return {
    fileCount: manifest.length,
    bytes: manifest.reduce((total, entry) => total + entry.bytes, 0),
    sha256: sha256Buffer(JSON.stringify(manifest)),
  };
}

function assertSameManifest(expected: FileManifestEntry[], actual: FileManifestEntry[], label: string): void {
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new Error(`${label} 文件清单或内容哈希不一致。`);
  }
}

async function findAppBundles(root: string): Promise<string[]> {
  const apps: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const entryPath = path.join(directory, entry.name);
      if (entry.name.endsWith(".app")) apps.push(entryPath);
      else await visit(entryPath);
    }
  }
  await visit(root);
  return apps.sort();
}

async function findFilesWithSuffix(root: string, suffix: string): Promise<string[]> {
  const matches: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(entryPath);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(suffix.toLowerCase())) matches.push(entryPath);
    }
  }
  await visit(root);
  return matches.sort();
}

async function findFilesOutsideAppBundles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory() && !entry.name.endsWith(".app")) await visit(entryPath);
      else if (entry.isFile()) files.push(entryPath);
    }
  }
  await visit(root);
  return files.sort();
}

async function runCommand(
  label: string,
  executable: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; maxBuffer?: number; timeout?: number } = {},
): Promise<CommandRunResult> {
  const startedAt = Date.now();
  try {
    const result = await execFileAsync(executable, args, {
      cwd: options.cwd || workspace,
      env: options.env || process.env,
      maxBuffer: options.maxBuffer || 32 * 1024 * 1024,
      timeout: options.timeout,
      encoding: "utf8",
    });
    const stdout = String(result.stdout || "");
    const stderr = String(result.stderr || "");
    const evidence = {
      label,
      executable,
      args,
      durationMs: Date.now() - startedAt,
      stdoutTail: tail(stdout),
      stderrTail: tail(stderr),
    };
    commandRuns.push(evidence);
    return { stdout, stderr, evidence };
  } catch (error) {
    const failure = error as Error & { stdout?: string | Buffer; stderr?: string | Buffer; code?: number | string };
    throw new Error(`${label} 失败：${JSON.stringify({
      code: failure.code,
      message: failure.message,
      stdoutTail: tail(String(failure.stdout || "")),
      stderrTail: tail(String(failure.stderr || "")),
    })}`);
  }
}

async function probeCommand(executable: string, args: string[]): Promise<ProbeResult> {
  try {
    const result = await execFileAsync(executable, args, { cwd: workspace, maxBuffer: 2 * 1024 * 1024, encoding: "utf8" });
    return { exitCode: 0, stdoutTail: tail(String(result.stdout || "")), stderrTail: tail(String(result.stderr || "")) };
  } catch (error) {
    const failure = error as Error & { stdout?: string | Buffer; stderr?: string | Buffer; code?: number | string };
    return {
      exitCode: failure.code ?? null,
      stdoutTail: tail(String(failure.stdout || "")),
      stderrTail: tail(String(failure.stderr || "")),
    };
  }
}

function parseJson(stdout: string, label: string): Record<string, unknown> {
  try {
    return JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    throw new Error(`${label} 没有返回单一 JSON：${tail(stdout)}`);
  }
}

async function sourceHashes(relativePaths: string[]): Promise<Record<string, string>> {
  return Object.fromEntries(await Promise.all(relativePaths.map(async (relativePath) => [
    relativePath,
    await sha256File(path.join(workspace, relativePath)),
  ])));
}

assertTemporaryPackageRoot(tempRoot, workspace);
assertPathInsidePackageRoot(stageRoot, tempRoot, "临时源码 stage");
assertPathInsidePackageRoot(builderOutput, tempRoot, "electron-builder 输出目录");
assertPathInsidePackageRoot(emptyProjectRoot, tempRoot, "packaged MCP 空项目夹具");
assertPathInsidePackageRoot(emptyProjectRegistryPath, tempRoot, "packaged MCP registry");
assertPathInsidePackageRoot(effectTransitionRegistryPath, tempRoot, "Effect/Transition registry");
assertPathInsidePackageRoot(packagedRegistryPath, tempRoot, "packaged runtime registry");
assertPathInsidePackageRoot(packagedMediaRuntimeDirectory, tempRoot, "packaged media runtime");
assertPathInsidePackageRoot(packagedProjectRoot, tempRoot, "packaged default project root");
assertPathInsidePackageRoot(packagedReviewProjectRoot, tempRoot, "packaged Review project");
assertPathInsidePackageRoot(packagedReviewRegistryPath, tempRoot, "packaged Review registry");
assertPathInsidePackageRoot(packagedReviewUserDataPath, tempRoot, "packaged Review user-data");
await mkdir(evidenceDirectory, { recursive: true });

const oldDmgBefore = await snapshotImmutableFile(oldDmgPath);
// The legacy DMG is optional build history, not a prerequisite for validating
// the current package. Preserve whichever state was observed (present or
// absent) and fail later if the isolated run changes it.
const hostRegistryBefore = await snapshotImmutableFile(hostRegistryPath);
const hostMediaRuntimeStateBefore = await snapshotImmutableFile(hostMediaRuntimeStatePath);
const distBefore = await topLevelSnapshot(workspaceDistPath);
const workspaceDistManifestBefore = await fileManifest(workspaceDistPath);
const workspaceOutManifestBefore = await fileManifest(path.join(workspace, "out"));
const workspaceMcpManifestBefore = await fileManifest(path.join(workspace, "dist-mcp"));
const evidenceRunLock = await acquireEvidenceRunLock(evidencePath, runId);

try {
  await Promise.all([
    mkdir(stageRoot, { recursive: true }),
    mkdir(isolatedHome, { recursive: true }),
    mkdir(isolatedTmp, { recursive: true }),
    mkdir(appBuilderTmp, { recursive: true }),
    mkdir(electronBuilderCache, { recursive: true }),
    mkdir(electronDownloadCache, { recursive: true }),
    mkdir(npmCache, { recursive: true }),
    mkdir(path.dirname(packagedRegistryPath), { recursive: true }),
    mkdir(packagedMediaRuntimeDirectory, { recursive: true }),
    mkdir(packagedProjectRoot, { recursive: true }),
  ]);
  const rootSourceInputs = (await listSourceDigestFiles(workspace))
    .map((filePath) => path.relative(workspace, filePath))
    .filter((relativePath) => !relativePath.includes(path.sep));
  const stageInputs = [...new Set([
    ...rootSourceInputs,
    "src",
    "scripts",
    "tests",
    "build",
  ])];
  await runCommand("APFS COW clone into isolated stage", "/bin/cp", ["-cR", ...stageInputs, stageRoot], {
    cwd: workspace,
    timeout: 10 * 60_000,
  });
  const stageSourceSymlinkCount = await assertNoExternalSymlinks(stageRoot);
  const workspaceSourceManifest = await fileManifest(path.join(workspace, "src"));
  const stageSourceManifest = await fileManifest(path.join(stageRoot, "src"));
  assertSameManifest(workspaceSourceManifest, stageSourceManifest, "临时 stage 与当前 src");
  const [workspaceSourceIdentity, stageSourceIdentity] = await Promise.all([
    computeSourceDigest(workspace),
    computeSourceDigest(stageRoot),
  ]);
  if (JSON.stringify(workspaceSourceIdentity) !== JSON.stringify(stageSourceIdentity)) {
    throw new Error(`临时 stage 与当前完整源码摘要不一致：${JSON.stringify({ workspaceSourceIdentity, stageSourceIdentity })}`);
  }

  const signingEnvironmentKeys = [
    "CSC_LINK",
    "CSC_KEY_PASSWORD",
    "CSC_NAME",
    "APPLE_ID",
    "APPLE_APP_SPECIFIC_PASSWORD",
    "APPLE_TEAM_ID",
    "APPLE_API_KEY",
    "APPLE_API_KEY_ID",
    "APPLE_API_ISSUER",
    "APPLE_KEYCHAIN",
    "APPLE_KEYCHAIN_PROFILE",
  ];
  const packageEnvironment = createIsolatedRuntimeEnvironment(
    process.env,
    {
      packageRoot: tempRoot,
      home: isolatedHome,
      temporaryDirectory: isolatedTmp,
      registryPath: packagedRegistryPath,
      mediaRuntimeDirectory: packagedMediaRuntimeDirectory,
      projectRoot: packagedProjectRoot,
    },
  );
  for (const key of signingEnvironmentKeys) delete packageEnvironment[key];
  Object.assign(packageEnvironment, {
    HOME: isolatedHome,
    TMPDIR: isolatedTmp,
    APP_BUILDER_TMP_DIR: appBuilderTmp,
    ELECTRON_BUILDER_CACHE: electronBuilderCache,
    electron_config_cache: electronDownloadCache,
    ELECTRON_INSTALL_PLATFORM: "darwin",
    ELECTRON_INSTALL_ARCH: "arm64",
    npm_config_cache: npmCache,
    npm_config_update_notifier: "false",
    npm_config_audit: "false",
    npm_config_fund: "false",
    CSC_IDENTITY_AUTO_DISCOVERY: "false",
    DEBUG: "",
  });
  for (const key of ["ELECTRON_MIRROR", "npm_config_electron_mirror"]) delete packageEnvironment[key];
  const npmCiArgs = [
    "npm",
    "ci",
    "--include=dev",
    "--no-audit",
    "--no-fund",
    "--registry=https://registry.npmjs.org",
  ];
  await runCommand("isolated lockfile-faithful npm ci", "/usr/bin/env", npmCiArgs, {
    cwd: stageRoot,
    env: packageEnvironment,
    timeout: 20 * 60_000,
  });
  const [stageElectronPackage, stagePackageForElectron, stagePackageLockForElectron] = await Promise.all([
    readFile(path.join(stageRoot, "node_modules", "electron", "package.json"), "utf8")
      .then((value) => JSON.parse(value) as { version?: string }),
    readFile(path.join(stageRoot, "package.json"), "utf8")
      .then((value) => JSON.parse(value) as { devDependencies?: Record<string, string> }),
    readFile(path.join(stageRoot, "package-lock.json"), "utf8")
      .then((value) => JSON.parse(value) as {
        packages?: Record<string, { version?: string; devDependencies?: Record<string, string> }>;
      }),
  ]);
  if (!/^\d+\.\d+\.\d+$/u.test(stageElectronPackage.version ?? "")) {
    throw new Error(`隔离 Electron package 版本无效：${String(stageElectronPackage.version)}`);
  }
  const electronCacheSeed = await seedVerifiedElectronCache({
    electronPackageRoot: path.join(stageRoot, "node_modules", "electron"),
    archiveName: `electron-v${stageElectronPackage.version}-darwin-arm64.zip`,
    sourceCacheRoots: [
      path.join(os.homedir(), "Library", "Caches", "electron"),
      path.join(os.homedir(), ".cache", "electron"),
    ],
    targetCacheRoot: electronDownloadCache,
  });
  const installElectronExecutable = path.join(stageRoot, "node_modules", ".bin", "install-electron");
  await runCommand(
    "isolated lockfile Electron binary install",
    installElectronExecutable,
    [],
    { cwd: stageRoot, env: packageEnvironment, timeout: 15 * 60_000 },
  );
  const stageInstalledSymlinkCount = await assertNoExternalSymlinks(stageRoot);
  const productionDependencyRun = await runCommand(
    "isolated production dependency closure",
    "/usr/bin/env",
    ["npm", "ls", "--omit=dev", "--all", "--json"],
    { cwd: stageRoot, env: packageEnvironment, timeout: 5 * 60_000 },
  );
  const productionDependencyHealth = assertNpmProductionDependencyHealth(
    JSON.parse(productionDependencyRun.stdout) as NpmLsJson,
    JSON.parse(await readFile(path.join(stageRoot, "package-lock.json"), "utf8")) as PackageLockJson,
  );
  productionDependencyRun.evidence.productionDependencyHealth = productionDependencyHealth;
  await runCommand("isolated stage current-source build", "/usr/bin/env", ["npm", "run", "build"], {
    cwd: stageRoot,
    env: packageEnvironment,
    timeout: 15 * 60_000,
  });

  const currentOutRoot = path.join(stageRoot, "out");
  const currentMcpRoot = path.join(stageRoot, "dist-mcp");
  const currentReleaseManifestPath = path.join(stageRoot, "release-manifest.json");
  if (!(await exists(path.join(currentOutRoot, "main", "index.js"))) || !(await exists(path.join(currentMcpRoot, "mcp", "server.js")))) {
    throw new Error("临时 stage 没有生成当前源码构建产物。 ");
  }

  const currentOutManifest = await fileManifest(currentOutRoot);
  const currentMcpManifest = await fileManifest(currentMcpRoot);
  const currentReleaseManifest = JSON.parse(await readFile(currentReleaseManifestPath, "utf8")) as ReleaseManifest;
  assertReleaseManifest(currentReleaseManifest);
  const stageMcpSmokeRun = await runCommand(
    "isolated stage MCP capability baseline",
    path.join(stageRoot, "node_modules", ".bin", "tsx"),
    [path.join(stageRoot, "scripts", "mcp-smoke.ts"), path.join(currentMcpRoot, "mcp", "server.js")],
    { cwd: stageRoot, env: packageEnvironment },
  );
  const stageMcpCapabilities = parseJson(stageMcpSmokeRun.stdout, "isolated stage MCP capability baseline") as {
    toolCount?: number;
    tools?: string[];
    resourceTemplates?: string[];
    prompts?: string[];
  };
  if (stageMcpCapabilities.toolCount !== currentReleaseManifest.mcpToolCount) {
    throw new Error("隔离 stage MCP 工具数与 release manifest 不一致。");
  }
  const electronArchiveName = `electron-v${stageElectronPackage.version}-darwin-arm64.zip`;
  const electronArchivePath = path.join(stageRoot, "node_modules", "electron", "dist", electronArchiveName);
  const electronExecutableRelativePath = "Electron.app/Contents/MacOS/Electron";
  const electronExecutablePath = path.join(
    stageRoot,
    "node_modules",
    "electron",
    "dist",
    ...electronExecutableRelativePath.split("/"),
  );
  const electronArchitectureRun = await runCommand(
    "inspect lockfile Electron architecture",
    "/usr/bin/lipo",
    ["-archs", electronExecutablePath],
    { cwd: stageRoot, env: packageEnvironment, timeout: 60_000 },
  );
  await runCommand(
    "repack lockfile Electron distribution",
    "/usr/bin/ditto",
    [
      "-c",
      "-k",
      "--sequesterRsrc",
      "--keepParent",
      path.join(stageRoot, "node_modules", "electron", "dist", "Electron.app"),
      electronArchivePath,
    ],
    { cwd: stageRoot, env: packageEnvironment, timeout: 10 * 60_000 },
  );
  const electronArchive = await snapshotImmutableFile(electronArchivePath);
  if (!electronArchive.exists || !electronArchive.bytes || electronArchive.bytes < 1_000_000) {
    throw new Error(`隔离 Electron ZIP 不完整：${JSON.stringify(electronArchive)}`);
  }
  const electronArchiveEntriesRun = await runCommand(
    "inspect lockfile Electron ZIP layout",
    "/usr/bin/unzip",
    ["-Z1", electronArchivePath],
    { cwd: stageRoot, env: packageEnvironment, timeout: 60_000, maxBuffer: 16 * 1024 * 1024 },
  );
  const electronExecutableStat = await stat(electronExecutablePath);
  const electronBinaryProvenance = assertElectronBinaryProvenance({
    packageDirectSpec: stagePackageForElectron.devDependencies?.electron ?? "",
    lockEntryVersion: stagePackageLockForElectron.packages?.["node_modules/electron"]?.version ?? "",
    installedPackageVersion: stageElectronPackage.version ?? "",
    distVersion: (await readFile(
      path.join(stageRoot, "node_modules", "electron", "dist", "version"),
      "utf8",
    )).trim(),
    executableRelativePath: (await readFile(
      path.join(stageRoot, "node_modules", "electron", "path.txt"),
      "utf8",
    )).trim(),
    executableBytes: electronExecutableStat.size,
    executableMode: electronExecutableStat.mode,
    architectures: electronArchitectureRun.stdout.trim().split(/\s+/u).filter(Boolean),
    archiveName: electronArchiveName,
    archiveBytes: electronArchive.bytes,
    archiveEntries: electronArchiveEntriesRun.stdout.split(/\r?\n/u).filter(Boolean),
  });
  const builderArgs = [
    "--mac",
    "--dir",
    "--publish",
    "never",
    `-c.directories.output=${builderOutput}`,
    "-c.mac.identity=null",
    "-c.mac.notarize=false",
    "-c.forceCodeSigning=false",
    "-c.npmRebuild=false",
    `-c.electronDist=${path.join(stageRoot, "node_modules", "electron", "dist")}`,
  ];
  const builderRun = await runCommand("electron-builder 隔离 unpacked App", builderExecutable, builderArgs, {
    cwd: stageRoot,
    env: packageEnvironment,
    timeout: 15 * 60_000,
  });

  const apps = await findAppBundles(builderOutput);
  if (apps.length !== 1) throw new Error(`隔离输出必须且只能包含一个 .app，实际：${JSON.stringify(apps)}`);
  const appPath = apps[0];
  if (!appPath) throw new Error("隔离输出没有可用的 .app 路径。 ");
  assertPathInsidePackageRoot(appPath, tempRoot, "临时 App");
  const dmgOutputs = await findFilesWithSuffix(builderOutput, ".dmg");
  if (dmgOutputs.length) throw new Error(`--dir 隔离构建意外生成 DMG：${JSON.stringify(dmgOutputs)}`);
  const filesOutsideAppBundles = await findFilesOutsideAppBundles(builderOutput);
  const allowedBuilderDiagnostics = filesOutsideAppBundles.filter((filePath) => path.basename(filePath) === "builder-debug.yml");
  const forbiddenPackageOutputs = filesOutsideAppBundles.filter((filePath) =>
    /\.(?:dmg|zip|blockmap|ya?ml)$/i.test(filePath) && path.basename(filePath) !== "builder-debug.yml",
  );
  if (forbiddenPackageOutputs.length) {
    throw new Error(`隔离 dir target 意外生成发布产物或元数据：${JSON.stringify(forbiddenPackageOutputs)}`);
  }

  const executableDirectory = path.join(appPath, "Contents", "MacOS");
  const executableEntries = (await readdir(executableDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() || entry.isSymbolicLink());
  if (executableEntries.length !== 1) throw new Error(`临时 App 主可执行文件数量异常：${executableEntries.map((entry) => entry.name).join(", ")}`);
  const executableEntry = executableEntries[0];
  if (!executableEntry) throw new Error("临时 App 没有可用的主可执行文件。 ");
  const appExecutable = path.join(executableDirectory, executableEntry.name);
  await access(appExecutable, constants.X_OK);
  const binaryFileRun = await runCommand("packaged executable architecture", "/usr/bin/file", [appExecutable]);
  if (!/Mach-O.+arm64/i.test(binaryFileRun.stdout)) throw new Error(`临时 App 主二进制不是 arm64 Mach-O：${binaryFileRun.stdout}`);

  const infoPlistPath = path.join(appPath, "Contents", "Info.plist");
  const bundleIdentifierRun = await runCommand("packaged bundle identifier", "/usr/bin/plutil", ["-extract", "CFBundleIdentifier", "raw", "-o", "-", infoPlistPath]);
  const bundleVersionRun = await runCommand("packaged bundle version", "/usr/bin/plutil", ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", infoPlistPath]);
  const bundleNameRun = await runCommand("packaged bundle name", "/usr/bin/plutil", ["-extract", "CFBundleName", "raw", "-o", "-", infoPlistPath]);
  const bundleIdentity = {
    identifier: bundleIdentifierRun.stdout.trim(),
    version: bundleVersionRun.stdout.trim(),
    name: bundleNameRun.stdout.trim(),
  };
  if (bundleIdentity.identifier !== "com.hxx.aidramacanvas" || bundleIdentity.version !== currentReleaseManifest.version || bundleIdentity.name !== "AI 漫剧画布") {
    throw new Error(`临时 App Info.plist 身份错误：${JSON.stringify(bundleIdentity)}`);
  }

  const resourcesDirectory = path.join(appPath, "Contents", "Resources");
  const packagedReleaseManifestPath = path.join(resourcesDirectory, "release-manifest.json");
  const appAsarPath = path.join(resourcesDirectory, "app.asar");
  const unpackedRoot = path.join(resourcesDirectory, "app.asar.unpacked");
  const packagedMcpRoot = path.join(unpackedRoot, "dist-mcp");
  const packagedMcpServerPath = path.join(packagedMcpRoot, "mcp", "server.js");
  const packagedMcpSdkPackagePath = path.join(unpackedRoot, "node_modules", "@modelcontextprotocol", "sdk", "package.json");
  const stageMcpSdkPackagePath = path.join(stageRoot, "node_modules", "@modelcontextprotocol", "sdk", "package.json");
  await Promise.all([
    access(appAsarPath),
    access(packagedMcpServerPath),
    access(packagedMcpSdkPackagePath),
    access(stageMcpSdkPackagePath),
    access(packagedReleaseManifestPath),
  ]);
  const packagedReleaseManifest = JSON.parse(await readFile(packagedReleaseManifestPath, "utf8")) as ReleaseManifest;
  assertReleaseManifest(packagedReleaseManifest);
  if (JSON.stringify(packagedReleaseManifest) !== JSON.stringify(currentReleaseManifest)) {
    throw new Error("packaged release manifest 与隔离 stage 构建身份不一致。");
  }

  const asarEntries = new Set(asar.listPackage(appAsarPath, { isPack: false }).map((entry) => entry.replace(/^\//, "")));
  const packagedOutManifest: FileManifestEntry[] = currentOutManifest.map((entry) => {
    const asarPath = `out/${entry.relativePath}`;
    if (!asarEntries.has(asarPath)) throw new Error(`app.asar 缺少当前构建文件：${asarPath}`);
    const content = asar.extractFile(appAsarPath, asarPath);
    return { relativePath: entry.relativePath, bytes: content.byteLength, sha256: sha256Buffer(content) };
  });
  assertSameManifest(currentOutManifest, packagedOutManifest, "app.asar 与当前 out");

  const packagedMcpManifest = await fileManifest(packagedMcpRoot);
  assertSameManifest(currentMcpManifest, packagedMcpManifest, "app.asar.unpacked/dist-mcp 与当前 dist-mcp");
  const packagedPackage = JSON.parse(asar.extractFile(appAsarPath, "package.json").toString("utf8")) as {
    name?: string;
    version?: string;
    main?: string;
    dependencies?: Record<string, string>;
  };
  if (packagedPackage.name !== "ai-drama-canvas" || packagedPackage.version !== currentReleaseManifest.version || packagedPackage.main !== "out/main/index.js") {
    throw new Error(`app.asar/package.json 身份错误：${JSON.stringify(packagedPackage)}`);
  }
  const [packagedSdkPackage, stageSdkPackage, stagePackage, stagePackageLock] = await Promise.all([
    readFile(packagedMcpSdkPackagePath, "utf8").then((value) => JSON.parse(value) as { version?: string }),
    readFile(stageMcpSdkPackagePath, "utf8").then((value) => JSON.parse(value) as { version?: string }),
    readFile(path.join(stageRoot, "package.json"), "utf8").then((value) => JSON.parse(value) as {
      dependencies?: Record<string, string>;
    }),
    readFile(path.join(stageRoot, "package-lock.json"), "utf8").then((value) => JSON.parse(value) as {
      packages?: Record<string, { version?: string; dependencies?: Record<string, string> }>;
    }),
  ]);
  const mcpSdkVersionIdentity = assertExactDependencyVersionIdentity({
    dependencyName: "@modelcontextprotocol/sdk",
    packageDirectSpec: stagePackage.dependencies?.["@modelcontextprotocol/sdk"] ?? "",
    lockRootSpec: stagePackageLock.packages?.[""]?.dependencies?.["@modelcontextprotocol/sdk"] ?? "",
    lockEntryVersion: stagePackageLock.packages?.["node_modules/@modelcontextprotocol/sdk"]?.version ?? "",
    stageInstalledVersion: stageSdkPackage.version ?? "",
    packagedInstalledVersion: packagedSdkPackage.version ?? "",
  });
  if (packagedPackage.dependencies?.["@modelcontextprotocol/sdk"] !== mcpSdkVersionIdentity.packageDirectSpec) {
    throw new Error(`app.asar/package.json 的 MCP SDK direct spec 与隔离源码不一致：${JSON.stringify({
      packaged: packagedPackage.dependencies?.["@modelcontextprotocol/sdk"],
      stage: mcpSdkVersionIdentity.packageDirectSpec,
    })}`);
  }
  const directProductionDependencyIdentities = await Promise.all(
    Object.entries(stagePackage.dependencies ?? {})
      .sort(([left], [right]) => left.localeCompare(right))
      .map(async ([dependencyName, packageDirectSpec]) => {
        const packageRelativePath = path.join("node_modules", ...dependencyName.split("/"), "package.json");
        const [stageInstalledPackage, packagedInstalledPackage] = await Promise.all([
          readFile(path.join(stageRoot, packageRelativePath), "utf8").then((value) => JSON.parse(value) as { version?: string }),
          readFile(path.join(unpackedRoot, packageRelativePath), "utf8").then((value) => JSON.parse(value) as { version?: string }),
        ]);
        return assertDirectDependencyVersionIdentity({
          dependencyName,
          packageDirectSpec,
          lockRootSpec: stagePackageLock.packages?.[""]?.dependencies?.[dependencyName] ?? "",
          lockEntryVersion: stagePackageLock.packages?.[`node_modules/${dependencyName}`]?.version ?? "",
          stageInstalledVersion: stageInstalledPackage.version ?? "",
          packagedInstalledVersion: packagedInstalledPackage.version ?? "",
        });
      }),
  );
  if (JSON.stringify(packagedPackage.dependencies ?? {}) !== JSON.stringify(stagePackage.dependencies ?? {})) {
    throw new Error("app.asar/package.json 的直接生产依赖声明与隔离源码不一致。");
  }

  const codeSignature = await probeCommand("/usr/bin/codesign", ["--verify", "--deep", "--strict", appPath]);
  if (codeSignature.exitCode === 0) throw new Error("identity=null 的临时 App 意外形成了可验证签名。 ");
  const signatureDetails = await probeCommand("/usr/bin/codesign", ["-dv", "--verbose=4", appPath]);
  const signatureText = `${signatureDetails.stdoutTail}\n${signatureDetails.stderrTail}`;
  if (/YIHANG LI|3JS43BTTJ3|Developer ID Application/i.test(signatureText)) {
    throw new Error(`临时 App 意外带有 Developer ID 签名：${signatureText}`);
  }

  const packagedEnvironment: NodeJS.ProcessEnv = {
    ...packageEnvironment,
    AI_CANVAS_MCP_RUNTIME: appExecutable,
    AI_CANVAS_MCP_SERVER_PATH: packagedMcpServerPath,
    AI_CANVAS_RELEASE_MANIFEST_PATH: packagedReleaseManifestPath,
    AI_CANVAS_WORKSPACE: resourcesDirectory,
    AI_CANVAS_RECORDED_SOURCE_DIGEST: packagedReleaseManifest.sourceDigest,
    AI_CANVAS_RECORDED_RUNTIME_ARTIFACT_SHA256: createHash("sha256")
      .update(await readFile(packagedMcpServerPath))
      .digest("hex"),
    AI_CANVAS_BUILD_TIMESTAMP: packagedReleaseManifest.builtAt,
  };
  const mcpListRun = await runCommand(
    "packaged MCP capability smoke",
    tsxExecutable,
    [path.join(workspace, "scripts", "mcp-smoke.ts"), packagedMcpServerPath],
    { env: packagedEnvironment },
  );
  const mcpCapabilities = parseJson(mcpListRun.stdout, "packaged MCP capability smoke") as {
    toolCount?: number;
    resourceTemplates?: unknown[];
    prompts?: unknown[];
    resources?: string[];
    runtime?: string;
    serverPath?: string;
  };
  assertOnlyStaticPackagedResources(mcpCapabilities.resources || []);
  if (mcpCapabilities.toolCount !== currentReleaseManifest.mcpToolCount
    || JSON.stringify(mcpCapabilities.resourceTemplates) !== JSON.stringify(stageMcpCapabilities.resourceTemplates)
    || JSON.stringify(mcpCapabilities.prompts) !== JSON.stringify(stageMcpCapabilities.prompts)) {
    throw new Error(`packaged MCP capability 数量错误：${JSON.stringify({
      tools: mcpCapabilities.toolCount,
      resourceTemplates: mcpCapabilities.resourceTemplates?.length,
      prompts: mcpCapabilities.prompts?.length,
      stageResourceTemplates: stageMcpCapabilities.resourceTemplates?.length,
      stagePrompts: stageMcpCapabilities.prompts?.length,
    })}`);
  }

  const effectTransitionRun = await runCommand(
    "packaged Effect/Transition MCP integration",
    vitestExecutable,
    ["run", "tests/mcp-editor-effect-transition.test.ts", "--maxWorkers=1"],
    {
      env: {
        ...packagedEnvironment,
        AI_CANVAS_REGISTRY_PATH: effectTransitionRegistryPath,
      },
    },
  );

  const emptyWorkflowRun = await runCommand(
    "packaged MCP empty-project fresh-restart workflow",
    tsxExecutable,
    [path.join(workspace, "scripts", "mcp-empty-project-workflow-smoke.ts"), emptyProjectRoot, emptyProjectRegistryPath],
    { env: packagedEnvironment },
  );
  const emptyWorkflow = parseJson(emptyWorkflowRun.stdout, "packaged MCP empty-project workflow") as {
    transport?: string;
    toolCount?: number;
    restartVerified?: boolean;
    uncertainCommands?: number;
    storyboardRows?: number;
  };
  if (emptyWorkflow.transport !== "packaged-electron-node" || emptyWorkflow.toolCount !== currentReleaseManifest.mcpToolCount || !emptyWorkflow.restartVerified || emptyWorkflow.uncertainCommands !== 0 || !emptyWorkflow.storyboardRows) {
    throw new Error(`packaged MCP fresh-restart 结果错误：${JSON.stringify(emptyWorkflow)}`);
  }

  await runCommand(
    "packaged Effect/Transition Electron UI full-restart",
    process.execPath,
    [path.join(workspace, "scripts", "ui-editor-effect-transition-smoke.mjs"), packagedUiEvidencePath],
    {
      env: {
        ...packagedEnvironment,
        AI_CANVAS_ELECTRON_EXECUTABLE: appExecutable,
        AI_CANVAS_ELECTRON_BACKGROUND_SMOKE: "1",
        AI_CANVAS_EVIDENCE_RUN_ID: runId,
        AI_CANVAS_UI_SCREENSHOT_PATH: packagedUiScreenshotPath,
      },
      timeout: 4 * 60_000,
    },
  );
  const packagedUiEvidence = JSON.parse(await readFile(packagedUiEvidencePath, "utf8")) as {
    status?: string;
    runId?: string;
    transport?: string;
    executablePath?: string;
    userDataPath?: string;
    pageErrors?: unknown[];
    screenshot?: { path?: string; bytes?: number; sha256?: string; width?: number; height?: number };
    terminal?: { rootRemoved?: boolean; registryRemoved?: boolean; userDataRemoved?: boolean };
    revisions?: { redone?: number; afterApplicationRestart?: number };
    closeRuns?: Array<{ graceful?: boolean; forceTerminated?: boolean; forceKilled?: boolean; durationMs?: number; exitCode?: number | null; signalCode?: string | null }>;
    isolation?: { userDataOutsideProjectRoot?: boolean };
    backgroundSmoke?: Parameters<typeof assertBackgroundSmokeEvidence>[0];
  };
  assertBackgroundSmokeEvidence(packagedUiEvidence.backgroundSmoke, "packaged Effect/Transition");
  const packagedUiUserDataRemoved = packagedUiEvidence.userDataPath ? !(await exists(packagedUiEvidence.userDataPath)) : false;
  if (
    packagedUiEvidence.status !== "passed"
    || packagedUiEvidence.runId !== runId
    || packagedUiEvidence.transport !== "packaged-electron-current-source"
    || packagedUiEvidence.executablePath !== appExecutable
    || packagedUiEvidence.pageErrors?.length
    || !packagedUiEvidence.terminal?.rootRemoved
    || !packagedUiEvidence.terminal?.registryRemoved
    || !packagedUiEvidence.terminal?.userDataRemoved
    || !packagedUiUserDataRemoved
    || packagedUiEvidence.isolation?.userDataOutsideProjectRoot !== true
    || packagedUiEvidence.revisions?.redone !== packagedUiEvidence.revisions?.afterApplicationRestart
    || packagedUiEvidence.closeRuns?.length !== 2
    || !packagedUiEvidence.closeRuns.every((run) => run.graceful === true
      && run.forceTerminated === false
      && run.forceKilled === false
      && run.exitCode === 0
      && run.signalCode === null
      && typeof run.durationMs === "number"
      && run.durationMs < 20_000)
    || packagedUiEvidence.screenshot?.path !== packagedUiScreenshotPath
    || (packagedUiEvidence.screenshot?.bytes || 0) < 20_000
    || packagedUiEvidence.screenshot?.width !== 1560
    || packagedUiEvidence.screenshot?.height !== 980
  ) {
    throw new Error(`packaged Effect/Transition UI 证据错误：${JSON.stringify(packagedUiEvidence)}`);
  }

  await runCommand(
    "packaged ReviewStudio stale-submit full-restart",
    process.execPath,
    [
      path.join(workspace, "scripts", "ui-review-content-identity-smoke.mjs"),
      packagedReviewProjectRoot,
      packagedReviewRegistryPath,
      packagedReviewEvidencePath,
      packagedReviewScreenshotPath,
    ],
    {
      env: {
        ...packagedEnvironment,
        AI_CANVAS_ELECTRON_EXECUTABLE: appExecutable,
        AI_CANVAS_ELECTRON_BACKGROUND_SMOKE: "1",
        AI_CANVAS_EVIDENCE_RUN_ID: runId,
        AI_CANVAS_ELECTRON_USER_DATA_PATH: packagedReviewUserDataPath,
      },
      timeout: 4 * 60_000,
    },
  );
  const packagedReviewEvidence = JSON.parse(await readFile(packagedReviewEvidencePath, "utf8")) as PackagedReviewEvidence & {
    runId?: string;
    passed?: { latestReviewId?: string; sha256?: string; status?: string };
    restarted?: { latestReviewId?: string; sha256?: string; status?: string };
    closeRuns?: Array<{ graceful?: boolean; forceTerminated?: boolean; forceKilled?: boolean; durationMs?: number; exitCode?: number | null; signalCode?: string | null }>;
    backgroundSmoke?: Parameters<typeof assertBackgroundSmokeEvidence>[0];
  };
  assertBackgroundSmokeEvidence(packagedReviewEvidence.backgroundSmoke, "packaged ReviewStudio");
  if (packagedReviewEvidence.runId !== runId) {
    throw new Error(`packaged ReviewStudio runId 与本轮不一致：${String(packagedReviewEvidence.runId)}`);
  }
  assertPackagedReviewEvidence(packagedReviewEvidence, {
    executablePath: appExecutable,
    screenshotPath: packagedReviewScreenshotPath,
  });
  if (packagedReviewEvidence.closeRuns?.length !== 2
    || !packagedReviewEvidence.closeRuns.every((run) => run.graceful === true
      && run.forceTerminated === false
      && run.forceKilled === false
      && run.exitCode === 0
      && run.signalCode === null
      && typeof run.durationMs === "number"
      && run.durationMs < 20_000)) {
    throw new Error(`packaged ReviewStudio close 证据错误：${JSON.stringify(packagedReviewEvidence.closeRuns)}`);
  }
  if (await exists(packagedReviewProjectRoot) || await exists(packagedReviewRegistryPath) || await exists(packagedReviewUserDataPath)) {
    throw new Error(`packaged ReviewStudio 夹具仍残留：${JSON.stringify({
      project: await exists(packagedReviewProjectRoot),
      registry: await exists(packagedReviewRegistryPath),
      userData: await exists(packagedReviewUserDataPath),
    })}`);
  }

  const oldDmgAfter = await snapshotImmutableFile(oldDmgPath);
  assertImmutableFileUnchanged(oldDmgBefore, oldDmgAfter, "现有旧 DMG");
  const hostRegistryAfterRuntime = await snapshotImmutableFile(hostRegistryPath);
  const hostMediaRuntimeStateAfterRuntime = await snapshotImmutableFile(hostMediaRuntimeStatePath);
  assertImmutableFileUnchanged(hostRegistryBefore, hostRegistryAfterRuntime, "宿主项目 registry");
  assertImmutableFileUnchanged(hostMediaRuntimeStateBefore, hostMediaRuntimeStateAfterRuntime, "宿主媒体运行时状态");
  const distAfter = await topLevelSnapshot(workspaceDistPath);
  if (JSON.stringify(distBefore) !== JSON.stringify(distAfter)) {
    throw new Error(`工作区 dist 顶层在隔离打包期间发生变化：${JSON.stringify({ before: distBefore, after: distAfter })}`);
  }
  const workspaceDistManifestAfter = await fileManifest(workspaceDistPath);
  const workspaceOutManifestAfter = await fileManifest(path.join(workspace, "out"));
  const workspaceMcpManifestAfter = await fileManifest(path.join(workspace, "dist-mcp"));
  assertSameManifest(workspaceDistManifestBefore, workspaceDistManifestAfter, "工作区 dist");
  assertSameManifest(workspaceOutManifestBefore, workspaceOutManifestAfter, "工作区 out");
  assertSameManifest(workspaceMcpManifestBefore, workspaceMcpManifestAfter, "工作区 dist-mcp");
  const workspaceSourceIdentityAfter = await computeSourceDigest(workspace);
  if (JSON.stringify(workspaceSourceIdentity) !== JSON.stringify(workspaceSourceIdentityAfter)) {
    throw new Error(`隔离 App smoke 期间源码身份发生漂移：${JSON.stringify({
      before: workspaceSourceIdentity,
      after: workspaceSourceIdentityAfter,
    })}`);
  }

  const appBundleManifest = await fileManifest(appPath);
  const asarSnapshot = await snapshotImmutableFile(appAsarPath);
  const executableSnapshot = await snapshotImmutableFile(appExecutable);
  const packagedMcpServerSnapshot = await snapshotImmutableFile(packagedMcpServerPath);
  evidenceCore = {
    schemaVersion: 1,
    runId,
    startedAt,
    generatedAt: new Date().toISOString(),
    status: "passed",
    scope: "current-source-isolated-unpacked-app-validation",
    authorizationBoundary: {
      formalProjectUsed: false,
      externalWebsiteUsed: false,
      uploadUsed: false,
      paidActionUsed: false,
      installed: false,
      published: false,
      dmgGenerated: false,
      developerIdSigningRequested: false,
      notarizationRequested: false,
      workspaceDistOverwritten: false,
      closesRealProjectNleValidation: false,
    },
    package: {
      tempRoot,
      stageRoot,
      builderOutput,
      appPath,
      executablePath: appExecutable,
      builderArgs,
      stageInputs,
      stageSource: manifestSummary(stageSourceManifest),
      workspaceSource: manifestSummary(workspaceSourceManifest),
      stageSourceIdentity,
      workspaceSourceIdentity,
      workspaceSourceIdentityAfter,
      stageSourceSymlinkCount,
      stageInstalledSymlinkCount,
      lockfileInstall: {
        command: npmCiArgs,
        registry: "https://registry.npmjs.org",
        workspaceNodeModulesCopied: false,
        productionDependencyHealth,
      },
       electronArchive,
       electronBinaryProvenance,
       electronCacheSeed,
      builderEnvironment: {
        HOME: isolatedHome,
        TMPDIR: isolatedTmp,
        APP_BUILDER_TMP_DIR: appBuilderTmp,
         ELECTRON_BUILDER_CACHE: electronBuilderCache,
         electron_config_cache: electronDownloadCache,
        npm_config_cache: npmCache,
        CSC_IDENTITY_AUTO_DISCOVERY: "false",
        clearedSigningEnvironmentKeys: signingEnvironmentKeys,
      },
      packagedRuntimeEnvironment: {
        HOME: packagedEnvironment.HOME,
        TMPDIR: packagedEnvironment.TMPDIR,
        AI_CANVAS_REGISTRY_PATH: packagedEnvironment.AI_CANVAS_REGISTRY_PATH,
        AI_CANVAS_MEDIA_RUNTIME_DIR: packagedEnvironment.AI_CANVAS_MEDIA_RUNTIME_DIR,
        AI_CANVAS_PROJECT_ROOT: packagedEnvironment.AI_CANVAS_PROJECT_ROOT,
      },
      appBundle: manifestSummary(appBundleManifest),
      executable: executableSnapshot,
      executableArchitecture: binaryFileRun.stdout.trim(),
      bundleIdentity,
      appAsar: asarSnapshot,
      currentOut: manifestSummary(currentOutManifest),
      packagedOut: manifestSummary(packagedOutManifest),
      currentMcp: manifestSummary(currentMcpManifest),
      packagedMcp: manifestSummary(packagedMcpManifest),
      packagedMcpServer: packagedMcpServerSnapshot,
      packagedMcpSdkVersion: packagedSdkPackage.version,
      stageMcpSdkVersion: stageSdkPackage.version,
      mcpSdkVersionIdentity,
      directProductionDependencyIdentities,
      releaseManifest: packagedReleaseManifest,
      stageMcpCapabilities: {
        toolCount: stageMcpCapabilities.toolCount,
        resourceTemplateCount: stageMcpCapabilities.resourceTemplates?.length,
        promptCount: stageMcpCapabilities.prompts?.length,
      },
      packageJson: packagedPackage,
      dmgOutputs,
      filesOutsideAppBundles,
      allowedBuilderDiagnostics,
      forbiddenPackageOutputs,
      codeSignature,
      signatureDetails,
      builderLogTail: { stdout: builderRun.evidence.stdoutTail, stderr: builderRun.evidence.stderrTail },
    },
    packagedMcp: {
      runtime: mcpCapabilities.runtime,
      serverPath: mcpCapabilities.serverPath,
      toolCount: mcpCapabilities.toolCount,
      resourceTemplateCount: mcpCapabilities.resourceTemplates?.length,
      promptCount: mcpCapabilities.prompts?.length,
      resources: mcpCapabilities.resources,
      staticResourceCount: mcpCapabilities.resources?.length,
      effectTransitionIntegrationPassed: effectTransitionRun.evidence.label === "packaged Effect/Transition MCP integration",
      emptyProjectFreshRestart: emptyWorkflow,
    },
    packagedElectronUi: {
      evidencePath: packagedUiEvidencePath,
      evidenceSha256: await sha256File(packagedUiEvidencePath),
      screenshotPath: packagedUiScreenshotPath,
      screenshotSha256: await sha256File(packagedUiScreenshotPath),
      transport: packagedUiEvidence.transport,
      userDataPath: packagedUiEvidence.userDataPath,
      userDataRemoved: packagedUiUserDataRemoved,
      revisions: packagedUiEvidence.revisions,
      closeRuns: packagedUiEvidence.closeRuns,
      isolation: packagedUiEvidence.isolation,
      backgroundSmoke: packagedUiEvidence.backgroundSmoke,
      terminal: packagedUiEvidence.terminal,
    },
    packagedReviewStudio: {
      evidencePath: packagedReviewEvidencePath,
      evidenceSha256: await sha256File(packagedReviewEvidencePath),
      screenshotPath: packagedReviewScreenshotPath,
      screenshotSha256: await sha256File(packagedReviewScreenshotPath),
      transport: packagedReviewEvidence.transport,
      executablePath: packagedReviewEvidence.executablePath,
      assertions: packagedReviewEvidence.assertions,
      passed: packagedReviewEvidence.passed,
      restarted: packagedReviewEvidence.restarted,
      closeRuns: packagedReviewEvidence.closeRuns,
      backgroundSmoke: packagedReviewEvidence.backgroundSmoke,
      terminal: packagedReviewEvidence.terminal,
    },
    protectedWorkspaceArtifacts: {
      oldDmgBefore,
      oldDmgAfter,
      unchanged: true,
      distTopLevelBefore: distBefore,
      distTopLevelAfter: distAfter,
      distManifestBefore: manifestSummary(workspaceDistManifestBefore),
      distManifestAfter: manifestSummary(workspaceDistManifestAfter),
      outManifestBefore: manifestSummary(workspaceOutManifestBefore),
      outManifestAfter: manifestSummary(workspaceOutManifestAfter),
      mcpManifestBefore: manifestSummary(workspaceMcpManifestBefore),
      mcpManifestAfter: manifestSummary(workspaceMcpManifestAfter),
      hostRegistryBefore,
      hostRegistryAfterRuntime,
      hostMediaRuntimeStateBefore,
      hostMediaRuntimeStateAfterRuntime,
    },
    sourceHashes: await sourceHashes([
      "package.json",
      "src/core/types.ts",
      "src/core/editor.ts",
      "src/core/codex.ts",
      "src/core/reviews.ts",
      "src/main/app-close-coordinator.ts",
      "src/main/index.ts",
      "src/mcp/server.ts",
      "src/renderer/src/components/ReviewStudioView.vue",
      "src/renderer/src/components/VideoEditorView.vue",
      "scripts/create-review-fixture.ts",
      "scripts/isolated-package-guards.ts",
      "scripts/isolated-package-smoke.ts",
      "scripts/lib/electron-application-close.mjs",
      "scripts/lib/exclusive-evidence-output.mjs",
      "scripts/lib/isolated-package-terminal-finalizer.mjs",
      "scripts/ui-editor-effect-transition-smoke.mjs",
      "scripts/ui-review-content-identity-smoke.mjs",
      "tests/isolated-package-guards.test.ts",
      "tests/isolated-package-terminal-finalizer.test.ts",
      "tests/app-close-coordinator.test.ts",
      "tests/electron-application-close.test.ts",
      "tests/mcp-editor-effect-transition.test.ts",
      "tests/reviews.test.ts",
    ]),
    commands: commandRuns,
  };
} catch (error) {
  runError = error;
} finally {
  try {
    await terminateProcessesReferencing(tempRoot);
    if (lingeringProcessesBeforeCleanup.length) {
      runError ||= new Error(`隔离 stage 依赖 finally 强制清理残留进程：${JSON.stringify(lingeringProcessesBeforeCleanup)}`);
    }
    if (lingeringProcessesAfterCleanup.length) {
      runError ||= new Error(`隔离 stage 仍有残留进程：${JSON.stringify(lingeringProcessesAfterCleanup)}`);
    }
  } catch (cleanupError) {
    runError ||= cleanupError;
  }
  try {
    await rm(tempRoot, { recursive: true, force: true });
  } catch (cleanupError) {
    runError ||= new Error(`隔离打包临时根目录清理失败：${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
  }
}

async function collectIsolatedPackagePostCleanupEvidence() {
  const tempRootRemoved = !(await exists(tempRoot));
  const oldDmgPostCleanup = await snapshotImmutableFile(oldDmgPath);
  const hostRegistryPostCleanup = await snapshotImmutableFile(hostRegistryPath);
  const hostMediaRuntimeStatePostCleanup = await snapshotImmutableFile(hostMediaRuntimeStatePath);
  const distPostCleanup = await fileManifest(workspaceDistPath);
  const outPostCleanup = await fileManifest(path.join(workspace, "out"));
  const mcpPostCleanup = await fileManifest(path.join(workspace, "dist-mcp"));
  assertImmutableFileUnchanged(oldDmgBefore, oldDmgPostCleanup, "隔离烟测结束后的现有旧 DMG");
  assertImmutableFileUnchanged(hostRegistryBefore, hostRegistryPostCleanup, "隔离烟测结束后的宿主项目 registry");
  assertImmutableFileUnchanged(hostMediaRuntimeStateBefore, hostMediaRuntimeStatePostCleanup, "隔离烟测结束后的宿主媒体运行时状态");
  assertSameManifest(workspaceDistManifestBefore, distPostCleanup, "隔离烟测结束后的工作区 dist");
  assertSameManifest(workspaceOutManifestBefore, outPostCleanup, "隔离烟测结束后的工作区 out");
  assertSameManifest(workspaceMcpManifestBefore, mcpPostCleanup, "隔离烟测结束后的工作区 dist-mcp");
  return {
    tempRootRemoved,
    oldDmgPostCleanup,
    hostRegistryPostCleanup,
    hostMediaRuntimeStatePostCleanup,
    emptyProjectRemoved: !(await exists(emptyProjectRoot)),
    emptyProjectRegistryRemoved: !(await exists(emptyProjectRegistryPath)),
    effectTransitionRegistryRemoved: !(await exists(effectTransitionRegistryPath)),
    packagedRegistryRemoved: !(await exists(packagedRegistryPath)),
    packagedMediaRuntimeRemoved: !(await exists(packagedMediaRuntimeDirectory)),
    packagedProjectRootRemoved: !(await exists(packagedProjectRoot)),
    packagedReviewProjectRemoved: !(await exists(packagedReviewProjectRoot)),
    packagedReviewRegistryRemoved: !(await exists(packagedReviewRegistryPath)),
    packagedReviewUserDataRemoved: !(await exists(packagedReviewUserDataPath)),
  };
}

let postCleanupEvidence: Awaited<ReturnType<typeof collectIsolatedPackagePostCleanupEvidence>> | undefined;
try {
  postCleanupEvidence = await collectIsolatedPackagePostCleanupEvidence();
} catch (postCleanupError) {
  const previousError = runError instanceof Error ? runError.message : runError ? String(runError) : "无";
  runError = new Error(`隔离烟测 post-cleanup 证据收集或保护门禁失败；原错误：${previousError}；保护错误：${postCleanupError instanceof Error ? postCleanupError.message : String(postCleanupError)}`);
}
if (postCleanupEvidence && !postCleanupEvidence.tempRootRemoved) {
  runError ||= new Error(`隔离打包临时根目录未清理：${tempRoot}`);
}
if (!evidenceCore) {
  runError ||= new Error("隔离打包烟测未生成证据对象。 ");
}

let terminalEvidence: Record<string, unknown>;
if (runError || !evidenceCore) {
  terminalEvidence = {
    schemaVersion: 1,
    kind: "current-source-isolated-unpacked-app-validation",
    runId,
    startedAt,
    completedAt: new Date().toISOString(),
    status: "failed",
    error: runError instanceof Error ? runError.message : String(runError),
    outputPaths: {
      evidencePath,
      completionMarkerPath,
      packagedUiEvidencePath,
      packagedUiScreenshotPath,
      packagedReviewEvidencePath,
      packagedReviewScreenshotPath,
    },
    terminal: {
      tempRootRemoved: postCleanupEvidence?.tempRootRemoved ?? false,
      postCleanupEvidenceCollected: Boolean(postCleanupEvidence),
      lingeringProcessesBeforeCleanup,
      lingeringProcessesAfterCleanup,
    },
    commands: commandRuns,
  };
} else {
  const completedPostCleanup = postCleanupEvidence!;
  const oldDmgFinal = completedPostCleanup.oldDmgPostCleanup;
  evidenceCore.terminal = {
    tempRootRemoved: completedPostCleanup.tempRootRemoved,
    lingeringProcessesBeforeCleanup,
    lingeringProcessesAfterCleanup,
    emptyProjectRemoved: completedPostCleanup.emptyProjectRemoved,
    emptyProjectRegistryRemoved: completedPostCleanup.emptyProjectRegistryRemoved,
    effectTransitionRegistryRemoved: completedPostCleanup.effectTransitionRegistryRemoved,
    packagedRegistryRemoved: completedPostCleanup.packagedRegistryRemoved,
    packagedMediaRuntimeRemoved: completedPostCleanup.packagedMediaRuntimeRemoved,
    packagedProjectRootRemoved: completedPostCleanup.packagedProjectRootRemoved,
    packagedReviewProjectRemoved: completedPostCleanup.packagedReviewProjectRemoved,
    packagedReviewRegistryRemoved: completedPostCleanup.packagedReviewRegistryRemoved,
    packagedReviewUserDataRemoved: completedPostCleanup.packagedReviewUserDataRemoved,
    hostRegistryPostCleanup: completedPostCleanup.hostRegistryPostCleanup,
    hostMediaRuntimeStatePostCleanup: completedPostCleanup.hostMediaRuntimeStatePostCleanup,
    oldDmgFinal,
  };
  evidenceCore.completedAt = new Date().toISOString();
  terminalEvidence = evidenceCore;
}

let finalization: Awaited<ReturnType<typeof finalizeIsolatedPackageTerminalEvidence>>;
try {
  finalization = await finalizeIsolatedPackageTerminalEvidence({
    evidencePath,
    lockPath: evidenceRunLock.path,
    runId,
    outcome: runError ? "failed" : "passed",
    terminalEvidence,
    releaseLock: () => evidenceRunLock.release(),
  });
} catch (finalizationError) {
  if (runError) {
    throw new AggregateError(
      [runError, finalizationError],
      "隔离 package smoke 失败且 terminal finalization 未完整收敛",
    );
  }
  throw finalizationError;
}
if (runError) throw runError;

process.stdout.write(`${JSON.stringify({
  runId,
  evidencePath,
  completionMarkerPath: finalization.completionMarkerPath,
  status: finalization.completion.status,
  scope: terminalEvidence.scope,
  packagedMcp: terminalEvidence.packagedMcp,
  packagedElectronUi: terminalEvidence.packagedElectronUi,
  packagedReviewStudio: terminalEvidence.packagedReviewStudio,
  authorizationBoundary: terminalEvidence.authorizationBoundary,
  terminal: terminalEvidence.terminal,
}, null, 2)}\n`);
