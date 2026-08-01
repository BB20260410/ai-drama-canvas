/**
 * P14 本机安装版独立验收。
 *
 * 只从 /Applications 中被签名 App 的 Resources 读取构建身份，并使用
 * App 自带 Electron runtime 启动 MCP。不从工作区源码推导安装版身份。
 */
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, link, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { _electron as electron } from "playwright";
import { readReleaseManifest } from "../src/core/release-manifest.js";

const execFileAsync = promisify(execFile);
const EXPECTED_APP = "/Applications/AI 漫剧画布.app";
const EXPECTED_IDENTITY = "Developer ID Application: YIHANG LI (3JS43BTTJ3)";
const EXPECTED_TEAM = "3JS43BTTJ3";
const EXPECTED_IDENTIFIER = "com.hxx.aidramacanvas";

function requiredAbsolute(value: string | undefined, label: string): string {
  if (!value?.trim() || !path.isAbsolute(value)) throw new Error(`${label} 必须是绝对路径。`);
  return path.normalize(value);
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function writeExclusiveAtomic(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await access(filePath).then(
    () => { throw new Error(`验收证据已存在，拒绝覆盖：${filePath}`); },
    () => undefined,
  );
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await link(temporary, filePath);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function plistValue(infoPlist: string, key: string): Promise<string> {
  const result = await execFileAsync("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", infoPlist], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  return String(result.stdout).trim();
}

function signatureField(details: string, name: string): string | undefined {
  return details.split(/\r?\n/u).find((line) => line.startsWith(`${name}=`))?.slice(name.length + 1).trim();
}

async function listPackagedMcpTools(input: {
  executablePath: string;
  serverPath: string;
  manifestPath: string;
  sourceDigest: string;
  runtimeArtifactSha256: string;
  builtAt: string;
  resourcesPath: string;
  registryPath: string;
}): Promise<string[]> {
  const transport = new StdioClientTransport({
    command: "/usr/bin/env",
    args: ["ELECTRON_RUN_AS_NODE=1", input.executablePath, input.serverPath],
    cwd: path.dirname(input.serverPath),
    env: {
      HOME: os.homedir(),
      PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
      AI_CANVAS_RELEASE_MANIFEST_PATH: input.manifestPath,
      AI_CANVAS_WORKSPACE: input.resourcesPath,
      AI_CANVAS_RECORDED_SOURCE_DIGEST: input.sourceDigest,
      AI_CANVAS_RECORDED_RUNTIME_ARTIFACT_SHA256: input.runtimeArtifactSha256,
      AI_CANVAS_BUILD_TIMESTAMP: input.builtAt,
      AI_CANVAS_REGISTRY_PATH: input.registryPath,
      // 安装验收使用隔离 registry 且只读取工具清单；不得与用户正在使用的
      // MCP owner 争夺全局单进程锁，也不要求结束现有连接。
      AI_CANVAS_MCP_ALLOW_MULTI: "1",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "p14-installed-release-verifier", version: "0.2.0" });
  const stderr: Buffer[] = [];
  transport.stderr?.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
  try {
    await client.connect(transport);
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    if (!names.length || new Set(names).size !== names.length) {
      throw new Error("安装版 MCP 工具清单为空或含重复项。");
    }
    return names;
  } catch (error) {
    const diagnosticHash = sha256(Buffer.concat(stderr));
    throw new Error(`安装版 MCP 启动失败（stderr sha256=${diagnosticHash}）：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await client.close().catch(() => undefined);
  }
}

const appPath = requiredAbsolute(process.argv[2] ?? EXPECTED_APP, "App 路径");
const evidencePath = requiredAbsolute(process.argv[3], "证据路径");
if (appPath !== EXPECTED_APP) throw new Error(`P14 只验收固定安装位置：${EXPECTED_APP}`);
const appStat = await stat(appPath).catch(() => null);
if (!appStat?.isDirectory()) throw new Error(`安装版 App 不存在：${appPath}`);

const contents = path.join(appPath, "Contents");
const resourcesPath = path.join(contents, "Resources");
const infoPlist = path.join(contents, "Info.plist");
const executableName = await plistValue(infoPlist, "CFBundleExecutable");
const executablePath = path.join(contents, "MacOS", executableName);
const manifestPath = path.join(resourcesPath, "release-manifest.json");
const serverPath = path.join(resourcesPath, "app.asar.unpacked", "dist-mcp", "mcp", "server.js");
await Promise.all([
  access(executablePath, constants.X_OK),
  access(manifestPath, constants.R_OK),
  access(serverPath, constants.R_OK),
]);
const manifest = await readReleaseManifest(manifestPath);

await execFileAsync("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath], {
  encoding: "utf8",
  maxBuffer: 4 * 1024 * 1024,
});
const signatureResult = await execFileAsync("/usr/bin/codesign", ["-d", "--verbose=4", appPath], {
  encoding: "utf8",
  maxBuffer: 4 * 1024 * 1024,
});
const signatureDetails = `${signatureResult.stdout ?? ""}\n${signatureResult.stderr ?? ""}`;
const authority = signatureField(signatureDetails, "Authority");
const teamIdentifier = signatureField(signatureDetails, "TeamIdentifier");
const identifier = signatureField(signatureDetails, "Identifier");
if (authority !== EXPECTED_IDENTITY || teamIdentifier !== EXPECTED_TEAM || identifier !== EXPECTED_IDENTIFIER) {
  throw new Error(`安装版签名身份不匹配：${JSON.stringify({ authority, teamIdentifier, identifier })}`);
}

const [bundleIdentifier, bundleVersion, bundleName, architectureResult] = await Promise.all([
  plistValue(infoPlist, "CFBundleIdentifier"),
  plistValue(infoPlist, "CFBundleShortVersionString"),
  plistValue(infoPlist, "CFBundleName"),
  execFileAsync("/usr/bin/lipo", ["-archs", executablePath], { encoding: "utf8", maxBuffer: 1024 * 1024 }),
]);
const architectures = String(architectureResult.stdout).trim().split(/\s+/u).filter(Boolean);
if (bundleIdentifier !== EXPECTED_IDENTIFIER || bundleVersion !== manifest.version
  || bundleName !== "AI 漫剧画布" || !architectures.includes("arm64")) {
  throw new Error(`安装版 bundle 身份不一致：${JSON.stringify({ bundleIdentifier, bundleVersion, bundleName, architectures })}`);
}

const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-installed-release-verify-"));
let launched = false;
let windowReady = false;
try {
  const registryPath = path.join(runtimeRoot, "registry", "projects.json");
  const userDataPath = path.join(runtimeRoot, "user-data");
  const homePath = path.join(runtimeRoot, "home");
  const tmpPath = path.join(runtimeRoot, "tmp");
  await Promise.all([path.dirname(registryPath), userDataPath, homePath, tmpPath].map((directory) => mkdir(directory, { recursive: true })));
  const toolNames = await listPackagedMcpTools({
    executablePath,
    serverPath,
    manifestPath,
    sourceDigest: manifest.sourceDigest,
    runtimeArtifactSha256: sha256(await readFile(serverPath)),
    builtAt: manifest.builtAt,
    resourcesPath,
    registryPath,
  });
  if (toolNames.length !== manifest.mcpToolCount) {
    throw new Error(`安装版 MCP 实际 ${toolNames.length} 项，与 release manifest ${manifest.mcpToolCount} 不一致。`);
  }

  const application = await electron.launch({
    executablePath,
    args: [`--user-data-dir=${userDataPath}`],
    cwd: runtimeRoot,
    env: {
      ...process.env,
      HOME: homePath,
      TMPDIR: tmpPath,
      AI_CANVAS_REGISTRY_PATH: registryPath,
      AI_CANVAS_MEDIA_RUNTIME_DIR: path.join(runtimeRoot, "media-runtime"),
      AI_CANVAS_WINDOW_WIDTH: "1280",
      AI_CANVAS_WINDOW_HEIGHT: "800",
      ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
    },
  });
  launched = true;
  try {
    const page = await application.firstWindow();
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.locator('[data-testid="first-run-screen"]').waitFor({ timeout: 60_000 });
    windowReady = true;
  } finally {
    await application.close();
  }

  const evidence = {
    schemaVersion: 1,
    kind: "p14-installed-signature-evidence",
    status: "pass",
    createdAt: new Date().toISOString(),
    release: {
      version: manifest.version,
      sourceDigest: manifest.sourceDigest,
      buildId: manifest.buildId,
      releaseManifestFingerprint: manifest.fingerprint,
      mcpToolCount: manifest.mcpToolCount,
    },
    bundle: {
      identifier: bundleIdentifier,
      version: bundleVersion,
      name: bundleName,
      architecture: architectures.length === 1 ? architectures[0]! : architectures.join(" "),
    },
    signing: {
      verified: true,
      deepStrict: true,
      identityCommonName: authority,
      teamIdentifier,
    },
    installation: {
      path: appPath,
      launchWithoutSystemNode: launched && windowReady,
      packagedMcpStartedWithAppElectronRuntime: true,
      actualMcpToolCount: toolNames.length,
    },
    distribution: "local-only",
    notarization: { performed: false },
    boundaries: {
      systemNodeRequired: false,
      uploaded: false,
      published: false,
      autoUpdateConfigured: false,
    },
  };
  await writeExclusiveAtomic(evidencePath, evidence);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    evidencePath,
    sourceDigest: manifest.sourceDigest,
    buildId: manifest.buildId,
    mcpToolCount: toolNames.length,
  }, null, 2)}\n`);
} finally {
  await rm(runtimeRoot, { recursive: true, force: true });
}
