import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { assertElectronBinaryProvenance } from "./isolated-package-guards.js";
import { seedVerifiedElectronCache } from "./lib/electron-binary-cache.js";

const execFileAsync = promisify(execFile);
const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryBase = process.platform === "darwin" ? "/private/tmp" : os.tmpdir();
const fixtureRoot = await mkdtemp(path.join(temporaryBase, "aic-electron-fixture-"));
const stageRoot = path.join(fixtureRoot, "stage");
const home = path.join(fixtureRoot, "home");
const temporaryDirectory = path.join(fixtureRoot, "tmp");
const npmCache = path.join(fixtureRoot, "npm-cache");
const electronCache = path.join(fixtureRoot, "electron-cache");
const extractRoot = path.join(fixtureRoot, "extracted");
const commandDurations: Record<string, number> = {};

async function run(label: string, executable: string, args: string[], env: NodeJS.ProcessEnv, timeout: number): Promise<string> {
  const startedAt = Date.now();
  try {
    const result = await execFileAsync(executable, args, {
      cwd: stageRoot,
      env,
      timeout,
      maxBuffer: 32 * 1024 * 1024,
      encoding: "utf8",
    });
    commandDurations[label] = Date.now() - startedAt;
    return String(result.stdout ?? "");
  } catch (error) {
    const failure = error as Error & { stdout?: string | Buffer; stderr?: string | Buffer; code?: string | number };
    throw new Error(`${label} 失败：${JSON.stringify({
      code: failure.code,
      message: failure.message,
      stdoutTail: String(failure.stdout ?? "").trim().split(/\r?\n/u).slice(-20).join("\n"),
      stderrTail: String(failure.stderr ?? "").trim().split(/\r?\n/u).slice(-20).join("\n"),
    })}`);
  }
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

let result: Record<string, unknown> | undefined;
try {
  await Promise.all([
    mkdir(stageRoot, { recursive: true }),
    mkdir(home, { recursive: true }),
    mkdir(temporaryDirectory, { recursive: true }),
    mkdir(npmCache, { recursive: true }),
    mkdir(electronCache, { recursive: true }),
    mkdir(extractRoot, { recursive: true }),
  ]);
  await Promise.all([
    copyFile(path.join(workspace, "package.json"), path.join(stageRoot, "package.json")),
    copyFile(path.join(workspace, "package-lock.json"), path.join(stageRoot, "package-lock.json")),
  ]);
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    TMPDIR: temporaryDirectory,
    npm_config_cache: npmCache,
    npm_config_update_notifier: "false",
    npm_config_audit: "false",
    npm_config_fund: "false",
    electron_config_cache: electronCache,
    ELECTRON_INSTALL_PLATFORM: "darwin",
    ELECTRON_INSTALL_ARCH: "arm64",
  };
  for (const key of [
    "ELECTRON_OVERRIDE_DIST_PATH",
    "ELECTRON_SKIP_BINARY_DOWNLOAD",
    "npm_config_ignore_scripts",
    "NPM_CONFIG_IGNORE_SCRIPTS",
    "ELECTRON_MIRROR",
    "npm_config_electron_mirror",
  ]) delete environment[key];

  await run(
    "npmCi",
    "/usr/bin/env",
    ["npm", "ci", "--include=dev", "--no-audit", "--no-fund", "--registry=https://registry.npmjs.org"],
    environment,
    20 * 60_000,
  );
  const installedElectronPackageRoot = path.join(stageRoot, "node_modules", "electron");
  const installedElectronPackage = JSON.parse(await readFile(
    path.join(installedElectronPackageRoot, "package.json"),
    "utf8",
  )) as { version?: string };
  const cacheSeed = await seedVerifiedElectronCache({
    electronPackageRoot: installedElectronPackageRoot,
    archiveName: `electron-v${installedElectronPackage.version ?? ""}-darwin-arm64.zip`,
    sourceCacheRoots: [
      path.join(os.homedir(), "Library", "Caches", "electron"),
      path.join(os.homedir(), ".cache", "electron"),
    ],
    targetCacheRoot: electronCache,
  });
  await run(
    "installElectron",
    path.join(stageRoot, "node_modules", ".bin", "install-electron"),
    [],
    environment,
    15 * 60_000,
  );

  const [packageJson, packageLock, installedElectron] = await Promise.all([
    readFile(path.join(stageRoot, "package.json"), "utf8").then((value) => JSON.parse(value) as {
      devDependencies?: Record<string, string>;
    }),
    readFile(path.join(stageRoot, "package-lock.json"), "utf8").then((value) => JSON.parse(value) as {
      packages?: Record<string, { version?: string }>;
    }),
    readFile(path.join(stageRoot, "node_modules", "electron", "package.json"), "utf8").then((value) => JSON.parse(value) as {
      version?: string;
    }),
  ]);
  const version = installedElectron.version ?? "";
  const executableRelativePath = "Electron.app/Contents/MacOS/Electron";
  const distRoot = path.join(stageRoot, "node_modules", "electron", "dist");
  const executablePath = path.join(distRoot, ...executableRelativePath.split("/"));
  const archiveName = `electron-v${version}-darwin-arm64.zip`;
  const archivePath = path.join(distRoot, archiveName);
  const architectures = (await run("inspectArchitecture", "/usr/bin/lipo", ["-archs", executablePath], environment, 60_000))
    .trim().split(/\s+/u).filter(Boolean);
  await run(
    "createArchive",
    "/usr/bin/ditto",
    ["-c", "-k", "--sequesterRsrc", "--keepParent", path.join(distRoot, "Electron.app"), archivePath],
    environment,
    10 * 60_000,
  );
  const archiveEntries = (await run("inspectArchive", "/usr/bin/unzip", ["-Z1", archivePath], environment, 60_000))
    .split(/\r?\n/u).filter(Boolean);
  const [executableStat, archiveStat] = await Promise.all([stat(executablePath), stat(archivePath)]);
  const provenance = assertElectronBinaryProvenance({
    packageDirectSpec: packageJson.devDependencies?.electron ?? "",
    lockEntryVersion: packageLock.packages?.["node_modules/electron"]?.version ?? "",
    installedPackageVersion: version,
    distVersion: (await readFile(path.join(distRoot, "version"), "utf8")).trim(),
    executableRelativePath: (await readFile(path.join(stageRoot, "node_modules", "electron", "path.txt"), "utf8")).trim(),
    executableBytes: executableStat.size,
    executableMode: executableStat.mode,
    architectures,
    archiveName,
    archiveBytes: archiveStat.size,
    archiveEntries,
  });

  await run("extractArchive", "/usr/bin/ditto", ["-x", "-k", archivePath, extractRoot], environment, 10 * 60_000);
  const extractedExecutablePath = path.join(extractRoot, ...executableRelativePath.split("/"));
  const [sourceExecutableSha256, extractedExecutableSha256, archiveSha256] = await Promise.all([
    sha256File(executablePath),
    sha256File(extractedExecutablePath),
    sha256File(archivePath),
  ]);
  if (sourceExecutableSha256 !== extractedExecutableSha256) {
    throw new Error(`Electron ZIP 解包后的可执行文件哈希不一致：${JSON.stringify({
      sourceExecutableSha256,
      extractedExecutableSha256,
    })}`);
  }
  result = {
    ok: true,
    scope: "lockfile-electron-binary-provenance-no-app-launch",
    provenance: {
      ...provenance,
      archiveEntries: provenance.archiveEntries.length,
      archiveSha256,
      executableSha256: sourceExecutableSha256,
      extractedExecutableSha256,
    },
    commandDurations,
    cacheSeed,
    appLaunched: false,
  };
} finally {
  await rm(fixtureRoot, { recursive: true, force: true });
}

if (!result) throw new Error("Electron provenance fixture 未生成结果。");
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
