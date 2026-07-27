import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import path from "node:path";

export const AI_CANVAS_APPLICATION_VERSION = "0.2.0" as const;
export const AI_CANVAS_PROTOCOL_VERSION = "1.1" as const;
export const RELEASE_MANIFEST_SCHEMA_VERSION = 1 as const;
export const RELEASE_MANIFEST_FILE_NAME = "release-manifest.json" as const;

export interface ReleaseManifest {
  schemaVersion: typeof RELEASE_MANIFEST_SCHEMA_VERSION;
  kind: "ai-drama-canvas-release-manifest";
  version: string;
  architecture: NodeJS.Architecture;
  sourceDigest: string;
  buildId: string;
  buildIdentityFingerprint: string;
  protocolVersion: string;
  mcpToolCount: number;
  builtAt: string;
  distribution: "local-only";
  localOnly: true;
  source: {
    files: number;
    bytes: number;
  };
  fingerprint: string;
}

export interface McpRuntimeLaunchContract {
  schemaVersion: 1;
  kind: "packaged-mcp-runtime-launch-contract";
  command: "/usr/bin/env";
  args: ["ELECTRON_RUN_AS_NODE=1", string, string];
  cwd: string;
  env: {
    AI_CANVAS_RELEASE_MANIFEST_PATH: string;
    AI_CANVAS_WORKSPACE: string;
    AI_CANVAS_RECORDED_SOURCE_DIGEST: string;
    AI_CANVAS_RECORDED_RUNTIME_ARTIFACT_SHA256: string;
    AI_CANVAS_BUILD_TIMESTAMP: string;
    AI_CANVAS_REGISTRY_PATH?: string;
  };
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const BUILD_ID_PATTERN = /^[a-f0-9]{32}$/u;
const ARCHITECTURES = new Set<NodeJS.Architecture>([
  "arm", "arm64", "ia32", "loong64", "mips", "mipsel", "ppc64", "riscv64", "s390x", "x64",
]);

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([key, entry]) => [key, normalize(entry)]));
  }
  return value;
}

export function releaseManifestDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(normalize(value)), "utf8").digest("hex");
}

export function releaseManifestBody(manifest: ReleaseManifest): Omit<ReleaseManifest, "fingerprint"> {
  const { fingerprint: _fingerprint, ...body } = manifest;
  return body;
}

export function assertReleaseManifest(value: unknown): asserts value is ReleaseManifest {
  if (!value || typeof value !== "object") throw new Error("release manifest 不是对象。");
  const manifest = value as Partial<ReleaseManifest>;
  if (manifest.schemaVersion !== RELEASE_MANIFEST_SCHEMA_VERSION
    || manifest.kind !== "ai-drama-canvas-release-manifest"
    || typeof manifest.version !== "string"
    || !manifest.version.trim()
    || typeof manifest.architecture !== "string"
    || !ARCHITECTURES.has(manifest.architecture as NodeJS.Architecture)
    || !SHA256_PATTERN.test(manifest.sourceDigest ?? "")
    || !BUILD_ID_PATTERN.test(manifest.buildId ?? "")
    || !SHA256_PATTERN.test(manifest.buildIdentityFingerprint ?? "")
    || typeof manifest.protocolVersion !== "string"
    || !manifest.protocolVersion.trim()
    || !Number.isInteger(manifest.mcpToolCount)
    || (manifest.mcpToolCount ?? 0) <= 0
    || typeof manifest.builtAt !== "string"
    || Number.isNaN(Date.parse(manifest.builtAt))
    || manifest.distribution !== "local-only"
    || manifest.localOnly !== true
    || !manifest.source
    || !Number.isInteger(manifest.source.files)
    || manifest.source.files <= 0
    || !Number.isInteger(manifest.source.bytes)
    || manifest.source.bytes <= 0
    || !SHA256_PATTERN.test(manifest.fingerprint ?? "")) {
    throw new Error("release manifest 字段不完整或格式无效。");
  }
  if (manifest.version !== AI_CANVAS_APPLICATION_VERSION) {
    throw new Error(`release manifest 版本 ${manifest.version} 与应用 ${AI_CANVAS_APPLICATION_VERSION} 不一致。`);
  }
  if (manifest.protocolVersion !== AI_CANVAS_PROTOCOL_VERSION) {
    throw new Error(`release manifest 协议 ${manifest.protocolVersion} 与应用 ${AI_CANVAS_PROTOCOL_VERSION} 不一致。`);
  }
  if (releaseManifestDigest(releaseManifestBody(manifest as ReleaseManifest)) !== manifest.fingerprint) {
    throw new Error("release manifest fingerprint 与内容不一致。");
  }
}

export async function readReleaseManifest(manifestPath: string): Promise<ReleaseManifest> {
  const absolutePath = path.resolve(manifestPath);
  const parsed = JSON.parse(await readFile(absolutePath, "utf8")) as unknown;
  assertReleaseManifest(parsed);
  return parsed;
}

function electronResourcesPath(): string | undefined {
  const value = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  return typeof value === "string" && value.trim() ? path.resolve(value) : undefined;
}

/**
 * 安装态只从显式环境或 Electron Resources 读取受签名包保护的 manifest。
 * 开发态不读取工作区旧 manifest，避免把过期构建身份冒充当前源码。
 */
export async function findRuntimeReleaseManifestPath(): Promise<string | undefined> {
  const explicit = process.env.AI_CANVAS_RELEASE_MANIFEST_PATH?.trim();
  const candidates = [
    explicit ? path.resolve(explicit) : undefined,
    electronResourcesPath() ? path.join(electronResourcesPath()!, RELEASE_MANIFEST_FILE_NAME) : undefined,
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    if (await access(candidate).then(() => true, () => false)) return candidate;
  }
  return undefined;
}

export async function readRuntimeReleaseManifest(): Promise<ReleaseManifest | undefined> {
  const manifestPath = await findRuntimeReleaseManifestPath();
  return manifestPath ? readReleaseManifest(manifestPath) : undefined;
}

/**
 * 开发态工具数从注册源声明计算；发布 manifest 生成器还会用真实编译 MCP
 * listTools 对照，二者不一致即拒绝产出。
 */
export async function countDeclaredMcpTools(workspace: string): Promise<number> {
  const serverSource = await readFile(path.join(path.resolve(workspace), "src", "mcp", "server.ts"), "utf8");
  const count = serverSource.match(/\bserver\.registerTool\s*\(/gu)?.length ?? 0;
  if (count <= 0) throw new Error("无法从 MCP 注册源计算工具数。");
  return count;
}

export async function expectedRuntimeMcpToolCount(workspace: string): Promise<number> {
  const manifest = await readRuntimeReleaseManifest();
  return manifest?.mcpToolCount ?? countDeclaredMcpTools(workspace);
}

export function createPackagedMcpRuntimeLaunchContract(input: {
  appExecutable: string;
  serverPath: string;
  releaseManifestPath: string;
  sourceDigest: string;
  runtimeArtifactSha256: string;
  builtAt: string;
  workspacePath?: string;
  registryPath?: string;
}): McpRuntimeLaunchContract {
  const appExecutable = path.resolve(input.appExecutable);
  const serverPath = path.resolve(input.serverPath);
  const releaseManifestPath = path.resolve(input.releaseManifestPath);
  const contentsRoot = path.dirname(path.dirname(appExecutable));
  const resourcesRoot = path.join(contentsRoot, "Resources");
  const isInside = (parent: string, candidate: string): boolean => {
    const relative = path.relative(parent, candidate);
    return Boolean(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  };
  if (path.basename(path.dirname(appExecutable)) !== "MacOS"
    || !isInside(resourcesRoot, serverPath)
    || !isInside(resourcesRoot, releaseManifestPath)
    || path.basename(releaseManifestPath) !== RELEASE_MANIFEST_FILE_NAME) {
    throw new Error("打包 MCP runtime 路径必须全部位于同一 App 的 Contents/Resources 签名边界内。");
  }
  const workspacePath = path.resolve(input.workspacePath ?? path.dirname(releaseManifestPath));
  if (!SHA256_PATTERN.test(input.sourceDigest)
    || !SHA256_PATTERN.test(input.runtimeArtifactSha256)
    || Number.isNaN(Date.parse(input.builtAt))) {
    throw new Error("打包 MCP runtime 必须绑定 sourceDigest、runtime artifact SHA-256 与 builtAt。");
  }
  return {
    schemaVersion: 1,
    kind: "packaged-mcp-runtime-launch-contract",
    command: "/usr/bin/env",
    args: ["ELECTRON_RUN_AS_NODE=1", appExecutable, serverPath],
    cwd: path.dirname(serverPath),
    env: {
      AI_CANVAS_RELEASE_MANIFEST_PATH: releaseManifestPath,
      AI_CANVAS_WORKSPACE: workspacePath,
      AI_CANVAS_RECORDED_SOURCE_DIGEST: input.sourceDigest,
      AI_CANVAS_RECORDED_RUNTIME_ARTIFACT_SHA256: input.runtimeArtifactSha256,
      AI_CANVAS_BUILD_TIMESTAMP: input.builtAt,
      ...(input.registryPath ? { AI_CANVAS_REGISTRY_PATH: path.resolve(input.registryPath) } : {}),
    },
  };
}
