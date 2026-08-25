/**
 * P10：构建身份、能力清单与统一 verify 摘要。
 * 不写入正式工程；用于审计当前源码/构建产物是否可复现。
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import {
  AI_CANVAS_PROTOCOL_VERSION,
  countDeclaredMcpTools,
  readRuntimeReleaseManifest,
  type ReleaseManifest,
} from "./release-manifest.js";

export const BUILD_IDENTITY_SCHEMA_VERSION = 1 as const;

export interface BuildCapabilityManifest {
  mcpToolCount: number;
  protocolVersion: string;
  studioDashboard: true;
  studioBinding: true;
  studioContinuity: true;
  /** 统一 Agent 执行面（冻结包 executorKind）。 */
  formalImagegenProvider: "agent-imagegen";
  /** 正式允许的 Agent 提供方。 */
  formalImagegenProviders: readonly ["codex", "grok"];
  browserGeneration: false;
  artlist: false;
}

export interface BuildIdentity {
  schemaVersion: typeof BUILD_IDENTITY_SCHEMA_VERSION;
  kind: "build-identity";
  buildId: string;
  sourceDigest: string;
  /**
   * 兼容字段：有构建工件时间时等于 artifactBuiltAt；旧的运行时调用未提供该
   * 元数据时回退为 queriedAt。新代码应结合 builtAtSource 读取。
   */
  builtAt: string;
  /** 构建流水线明确记录的工件时间；不能用运行时查询时间冒充。 */
  artifactBuiltAt?: string;
  /** 本次读取身份的时间，不参与 buildId/fingerprint。 */
  queriedAt: string;
  builtAtSource: "artifact" | "query-fallback";
  packageVersion: string;
  capabilities: BuildCapabilityManifest;
  roots: {
    workspace: string;
    sourceFiles: number;
    sourceBytes: number;
  };
  fingerprint: string;
}

export interface CreateBuildIdentityOptions {
  /** 构建工件时间。缺省时也可由 AI_CANVAS_BUILD_TIMESTAMP 提供。 */
  artifactBuiltAt?: string;
  /** 仅用于记录本次查询；不会改变 buildId/fingerprint。 */
  queriedAt?: string;
  /** 发布构建器从编译后 MCP listTools 得到的真实数量。 */
  mcpToolCount?: number;
}

export interface VerifyRunnerRecord {
  schemaVersion: 1;
  kind: "verify-runner-record";
  name: string;
  argv: string[];
  cwd: string;
  startedAt: string;
  endedAt: string;
  exitCode: number;
  logSha256?: string;
  sourceDigest?: string;
  buildId?: string;
  testCounts?: { files: number; tests: number };
}

function digest(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize);
    if (input && typeof input === "object") {
      return Object.fromEntries(Object.entries(input as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right, "en"))
        .map(([key, entry]) => [key, normalize(entry)]));
    }
    return input;
  };
  return createHash("sha256").update(JSON.stringify(normalize(value)), "utf8").digest("hex");
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve());
  });
  return hash.digest("hex");
}

export const SOURCE_DIGEST_GLOBS = [
  "src/**/*.{ts,vue,css,html}",
  "tests/**/*.{ts,json}",
  "scripts/**/*.{ts,mjs,js}",
  "package.json",
  "package-lock.json",
  "tsconfig*.json",
  "vitest.config.ts",
  "electron.vite.config.ts",
] as const;

export const SOURCE_DIGEST_IGNORES = [
  "**/node_modules/**",
  "**/dist/**",
  "**/dist-mcp/**",
  "**/out/**",
  // P24：另一会话的《嘟嘟》番外生产 QA 脚本（productions/dudu-gaiden 内容项目工具，非软件源，
  // 且处于活动迭代中）——排除出软件源码摘要，登记于 .planning/P19-P24_长期目标状态.json openFindings。
  "scripts/qa-dudu-storyboard.ts",
] as const;

const SOURCE_DIGEST_ROOT_FILES = new Set([
  "package.json",
  "package-lock.json",
  "vitest.config.ts",
  "electron.vite.config.ts",
]);
const SOURCE_DIGEST_ROOT_TSCONFIG_PATTERN = /^tsconfig.*\.json$/u;
const SOURCE_DIGEST_RECURSIVE_ROOTS = ["src", "tests", "scripts"] as const;
const SOURCE_DIGEST_WATCH_RESIDENT_ROOTS = ["src"] as const;
const SOURCE_DIGEST_IGNORED_DIRECTORY_NAMES = new Set([
  "node_modules",
  "dist",
  "dist-mcp",
  "out",
]);
const SOURCE_DIGEST_EXTENSIONS = {
  src: new Set([".ts", ".vue", ".css", ".html"]),
  tests: new Set([".ts", ".json"]),
  scripts: new Set([".ts", ".mjs", ".js"]),
} as const;

export type SourceDigestWatchScope = "resident" | "full";

/**
 * 常驻 runtime gate watcher 默认只递归订 src/。
 * 显式 AI_CANVAS_RUNTIME_GATE_WATCH_TESTS_SCRIPTS=1|true|yes|full 才把 tests/scripts 纳入递归监听。
 * 不改变 SOURCE_DIGEST_GLOBS / computeSourceDigest 身份枚举。
 */
export function resolveSourceDigestWatchScope(
  env: NodeJS.ProcessEnv = process.env,
): SourceDigestWatchScope {
  const raw = (env.AI_CANVAS_RUNTIME_GATE_WATCH_TESTS_SCRIPTS ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "full" ? "full" : "resident";
}

/**
 * chokidar v4 不再展开 glob。调用方应：
 * - 对第一个 workspace 根建立 depth=0 的浅监听，捕获新增/改名的 tsconfig；
 * - 对递归根建立递归监听（默认仅 src/；tests/scripts 见 resolveSourceDigestWatchScope）；
 * - 所有文件事件再交给 sourceDigestPathIsRelevant 精确过滤。
 */
export function sourceDigestWatchPaths(
  workspace: string,
  options?: { scope?: SourceDigestWatchScope; env?: NodeJS.ProcessEnv },
): string[] {
  const root = path.resolve(workspace);
  const scope = options?.scope ?? resolveSourceDigestWatchScope(options?.env);
  const recursiveRoots = scope === "full"
    ? SOURCE_DIGEST_RECURSIVE_ROOTS
    : SOURCE_DIGEST_WATCH_RESIDENT_ROOTS;
  return [
    root,
    ...recursiveRoots.map((relativePath) => path.join(root, relativePath)),
  ];
}

/**
 * 判断一个文件事件是否会改变 computeSourceDigest 的输入集合。
 *
 * 这是 watcher 的事件过滤器，不用于忽略目录遍历；目录 add/unlink 事件应等待
 * 其后具体文件事件，或直接触发一次防抖摘要复算。
 */
export function sourceDigestPathIsRelevant(workspace: string, candidatePath: string): boolean {
  const root = path.resolve(workspace);
  const candidate = path.resolve(candidatePath);
  const relativeNative = path.relative(root, candidate);
  if (!relativeNative
    || relativeNative === ".."
    || relativeNative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativeNative)) {
    return false;
  }
  const relativePath = relativeNative.split(path.sep).join("/");
  if (SOURCE_DIGEST_IGNORES.includes(relativePath as typeof SOURCE_DIGEST_IGNORES[number])) {
    return false;
  }
  const segments = relativePath.split("/");
  if (segments.slice(0, -1).some((segment) => SOURCE_DIGEST_IGNORED_DIRECTORY_NAMES.has(segment))) {
    return false;
  }
  if (segments.length === 1) {
    return SOURCE_DIGEST_ROOT_FILES.has(relativePath)
      || SOURCE_DIGEST_ROOT_TSCONFIG_PATTERN.test(relativePath);
  }
  const owner = segments[0] as typeof SOURCE_DIGEST_RECURSIVE_ROOTS[number];
  if (!SOURCE_DIGEST_RECURSIVE_ROOTS.includes(owner)) return false;
  return SOURCE_DIGEST_EXTENSIONS[owner].has(path.extname(relativePath));
}

/**
 * sourceDigest 与隔离候选构建共用的唯一输入枚举。
 *
 * 调用方可以把这些文件逐项复制到隔离 stage；不得自行维护第二套 glob，
 * 否则“构建所见源码”与运行时 currentness 可能产生静默分叉。
 */
export async function listSourceDigestFiles(workspace: string): Promise<string[]> {
  return (await fg([...SOURCE_DIGEST_GLOBS], {
    cwd: workspace,
    absolute: true,
    onlyFiles: true,
    dot: false,
    followSymbolicLinks: false,
    ignore: [...SOURCE_DIGEST_IGNORES],
  })).sort((a, b) => a.localeCompare(b));
}

export async function computeSourceDigest(workspace: string): Promise<{
  sourceDigest: string;
  sourceFiles: number;
  sourceBytes: number;
}> {
  const files = await listSourceDigestFiles(workspace);
  let bytes = 0;
  const hash = createHash("sha256");
  for (const filePath of files) {
    const relative = path.relative(workspace, filePath);
    const metadata = await stat(filePath);
    bytes += metadata.size;
    hash.update(relative);
    hash.update("\0");
    hash.update(await sha256File(filePath));
    hash.update("\0");
  }
  return {
    sourceDigest: hash.digest("hex"),
    sourceFiles: files.length,
    sourceBytes: bytes,
  };
}

export async function createBuildIdentity(
  workspace: string,
  optionsOrLegacyBuiltAt?: CreateBuildIdentityOptions | string,
): Promise<BuildIdentity> {
  const packageJson = JSON.parse(await readFile(path.join(workspace, "package.json"), "utf8")) as { version?: string };
  const source = await computeSourceDigest(workspace);
  const options = typeof optionsOrLegacyBuiltAt === "string"
    ? { artifactBuiltAt: optionsOrLegacyBuiltAt }
    : optionsOrLegacyBuiltAt ?? {};
  const queriedAt = options.queriedAt ?? new Date().toISOString();
  const artifactBuiltAt = options.artifactBuiltAt ?? (process.env.AI_CANVAS_BUILD_TIMESTAMP?.trim() || undefined);
  const builtAt = artifactBuiltAt ?? queriedAt;
  const builtAtSource = artifactBuiltAt ? "artifact" as const : "query-fallback" as const;
  const mcpToolCount = options.mcpToolCount ?? await countDeclaredMcpTools(workspace);
  if (!Number.isInteger(mcpToolCount) || mcpToolCount <= 0) {
    throw new Error("MCP 工具数必须是正整数。");
  }
  const capabilities: BuildCapabilityManifest = {
    mcpToolCount,
    protocolVersion: AI_CANVAS_PROTOCOL_VERSION,
    studioDashboard: true,
    studioBinding: true,
    studioContinuity: true,
    formalImagegenProvider: "agent-imagegen",
    formalImagegenProviders: ["codex", "grok"],
    browserGeneration: false,
    artlist: false,
  };
  const buildId = digest({
    sourceDigest: source.sourceDigest,
    packageVersion: packageJson.version ?? "0.0.0",
    capabilities,
  }).slice(0, 32);
  // 绝对 workspace 只用于本机诊断，不能进入可迁移的构建身份。否则同一份
  // 源码在隔离打包目录、安装资源目录和开发工作区会得到三个不同 fingerprint，
  // 破坏 release manifest 对同一工件的跨目录校验。
  const stableRoots = {
    sourceFiles: source.sourceFiles,
    sourceBytes: source.sourceBytes,
  };
  const stableBody = {
    schemaVersion: BUILD_IDENTITY_SCHEMA_VERSION,
    kind: "build-identity" as const,
    buildId,
    sourceDigest: source.sourceDigest,
    packageVersion: packageJson.version ?? "0.0.0",
    capabilities,
    roots: stableRoots,
  };
  return {
    ...stableBody,
    roots: {
      workspace: path.resolve(workspace),
      ...stableRoots,
    },
    builtAt,
    ...(artifactBuiltAt ? { artifactBuiltAt } : {}),
    queriedAt,
    builtAtSource,
    fingerprint: digest(stableBody),
  };
}

function buildIdentityFromReleaseManifest(
  manifest: ReleaseManifest,
  workspace: string,
  queriedAt = new Date().toISOString(),
): BuildIdentity {
  const capabilities: BuildCapabilityManifest = {
    mcpToolCount: manifest.mcpToolCount,
    protocolVersion: manifest.protocolVersion,
    studioDashboard: true,
    studioBinding: true,
    studioContinuity: true,
    formalImagegenProvider: "agent-imagegen",
    formalImagegenProviders: ["codex", "grok"],
    browserGeneration: false,
    artlist: false,
  };
  return {
    schemaVersion: BUILD_IDENTITY_SCHEMA_VERSION,
    kind: "build-identity",
    buildId: manifest.buildId,
    sourceDigest: manifest.sourceDigest,
    builtAt: manifest.builtAt,
    artifactBuiltAt: manifest.builtAt,
    queriedAt,
    builtAtSource: "artifact",
    packageVersion: manifest.version,
    capabilities,
    roots: {
      workspace: path.resolve(workspace),
      sourceFiles: manifest.source.files,
      sourceBytes: manifest.source.bytes,
    },
    fingerprint: manifest.buildIdentityFingerprint,
  };
}

/**
 * 开发态以当前源码计算身份；安装态优先读取 Electron Resources 中由代码签名
 * 保护的不可变 release manifest，因此不依赖安装包内不存在的源码树。
 */
export async function resolveRuntimeBuildIdentity(
  workspace: string,
  queriedAt = new Date().toISOString(),
): Promise<BuildIdentity> {
  const manifest = await readRuntimeReleaseManifest();
  return manifest
    ? buildIdentityFromReleaseManifest(manifest, workspace, queriedAt)
    : createBuildIdentity(workspace, { queriedAt });
}

export function createVerifyRunnerRecord(input: Omit<VerifyRunnerRecord, "schemaVersion" | "kind">): VerifyRunnerRecord {
  return {
    schemaVersion: 1,
    kind: "verify-runner-record",
    ...input,
  };
}
