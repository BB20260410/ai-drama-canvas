import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";
import { createBuildIdentity } from "../src/core/build-identity.js";
import { createManagedProject } from "../src/core/managed-project.js";
import {
  registerProject,
  setActiveProjectRegistration,
} from "../src/core/sidecar.js";

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const roots: string[] = [];
const originalRegistryPath = process.env.AI_CANVAS_REGISTRY_PATH;

afterEach(async () => {
  if (originalRegistryPath === undefined) delete process.env.AI_CANVAS_REGISTRY_PATH;
  else process.env.AI_CANVAS_REGISTRY_PATH = originalRegistryPath;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

type ToolResult = {
  isError?: boolean;
  content?: Array<{ type?: string; text?: string }>;
};

type RuntimeGateMetrics = {
  digestCalls: number;
  readChecks: number;
  readCacheHits: number;
  readCacheMisses: number;
  mutationChecks: number;
  mutationEpochRetries: number;
  watcherHealthy: boolean;
};

type RuntimeMcpMetric = {
  tool: string;
  effect: string;
  calls: number;
  failures: number;
  maxDurationMs: number;
  maxGateDurationMs: number;
};

type CapabilitiesProjection = {
  buildCurrentness: {
    allowed: boolean;
    sourceDigest?: string;
  };
  runtimeGateMetrics: RuntimeGateMetrics;
  runtimeMcpMetrics: {
    tools: RuntimeMcpMetric[];
  };
};

interface FilesystemEntry {
  kind: "directory" | "file";
  size: number;
  mtimeMs: number;
  sha256?: string;
}

function parseToolText<T>(result: unknown): T {
  const content = (result as ToolResult).content ?? [];
  return JSON.parse(content.find((entry) => entry.type === "text")?.text ?? "{}") as T;
}

async function filesystemSnapshot(root: string): Promise<Record<string, FilesystemEntry>> {
  const result: Record<string, FilesystemEntry> = {};
  async function visit(absolute: string, relative: string): Promise<void> {
    const metadata = await lstat(absolute);
    if (metadata.isSymbolicLink()) throw new Error(`P0 测试树禁止符号链接：${absolute}`);
    if (metadata.isDirectory()) {
      result[relative || "."] = {
        kind: "directory",
        size: metadata.size,
        mtimeMs: metadata.mtimeMs,
      };
      const names = await readdir(absolute);
      for (const name of names.sort((left, right) => left.localeCompare(right, "en"))) {
        await visit(path.join(absolute, name), relative ? `${relative}/${name}` : name);
      }
      return;
    }
    if (!metadata.isFile()) throw new Error(`P0 测试树出现非普通文件：${absolute}`);
    const bytes = await readFile(absolute);
    result[relative] = {
      kind: "file",
      size: metadata.size,
      mtimeMs: metadata.mtimeMs,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  }
  await visit(root, "");
  return result;
}

function suspiciousRuntimeEntryNames(snapshot: Record<string, FilesystemEntry>): string[] {
  return Object.keys(snapshot).filter((entry) => (
    /(^|\/)locks?(\/|$)/iu.test(entry)
    || /(?:^|\/)[^/]+\.(?:lock|tmp|wal|shm)$/iu.test(entry)
    || /(?:^|\/)[^/]+-(?:wal|shm)$/iu.test(entry)
  ));
}

async function createRegisteredProject(runtimeRoot: string, name: string) {
  const registryRoot = path.join(runtimeRoot, "registry");
  const registryPath = path.join(registryRoot, "projects.json");
  const projectsRoot = path.join(runtimeRoot, "projects");
  await mkdir(projectsRoot, { recursive: true });
  process.env.AI_CANVAS_REGISTRY_PATH = registryPath;
  const created = await createManagedProject({
    parentRoot: projectsRoot,
    name,
    slug: name.replaceAll(/[^a-z0-9]+/giu, "-").toLowerCase(),
  });
  await registerProject(created.project);
  await setActiveProjectRegistration(created.paths.root);

  // 夹具准备阶段允许 owner 初始化；计时/零写窗口开始前清除这些准备痕迹。
  await rm(path.join(created.paths.root, ".aicanvas", "locks"), { recursive: true, force: true });
  await rm(path.join(registryRoot, "locks"), { recursive: true, force: true });
  for (const databasePath of [
    created.paths.materialDatabase,
    created.paths.productionDatabase,
    created.paths.generationDatabase,
  ]) {
    await rm(`${databasePath}-wal`, { force: true });
    await rm(`${databasePath}-shm`, { force: true });
  }
  return { created, registryRoot, registryPath };
}

async function createMutableIdentityWorkspace(runtimeRoot: string): Promise<string> {
  const identityWorkspace = path.join(runtimeRoot, "identity-workspace");
  await mkdir(path.join(identityWorkspace, "src", "mcp"), { recursive: true });
  await writeFile(path.join(identityWorkspace, "package.json"), JSON.stringify({
    name: "ai-drama-canvas",
    version: "0.2.0",
  }), "utf8");
  await writeFile(
    path.join(identityWorkspace, "src", "mcp", "server.ts"),
    "server.registerTool('identity-probe', {}, () => ({}));\n",
    "utf8",
  );
  await writeFile(
    path.join(identityWorkspace, "src", "identity-probe.ts"),
    "export const identityProbe = 1;\n",
    "utf8",
  );
  return identityWorkspace;
}

async function connectMcp(input: {
  registryPath: string;
  identityWorkspace: string;
  recordedSourceDigest: string;
}): Promise<{ client: Client; startupMs: number }> {
  const runtimeSourcePath = path.join(workspace, "src", "mcp", "server.ts");
  const runtimeArtifactSha256 = createHash("sha256")
    .update(await readFile(runtimeSourcePath))
    .digest("hex");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/mcp/server.ts"],
    cwd: workspace,
    env: {
      ...process.env,
      AI_CANVAS_REGISTRY_PATH: input.registryPath,
      AI_CANVAS_WORKSPACE: input.identityWorkspace,
      AI_CANVAS_RECORDED_SOURCE_DIGEST: input.recordedSourceDigest,
      AI_CANVAS_RECORDED_RUNTIME_ARTIFACT_SHA256: runtimeArtifactSha256,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "mcp-p0-runtime-gate-integration", version: "0.1.0" });
  const startedAt = performance.now();
  await client.connect(transport);
  return { client, startupMs: performance.now() - startedAt };
}

async function timedToolCall(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ result: ToolResult; durationMs: number }> {
  const startedAt = performance.now();
  const result = await client.callTool({ name, arguments: args }) as ToolResult;
  return { result, durationMs: performance.now() - startedAt };
}

describe("P0 MCP 运行门禁与物理零写集成", () => {
  it("把进程启动与工具时延分开计量，并在 2 秒 TTL 内复用活动上下文门禁且物理零写", async () => {
    const runtimeRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "ai-canvas-mcp-p0-read-")));
    roots.push(runtimeRoot);
    const { created, registryRoot, registryPath } = await createRegisteredProject(
      runtimeRoot,
      "p0-readonly-context",
    );
    const identity = await createBuildIdentity(workspace);
    const { client, startupMs } = await connectMcp({
      registryPath,
      identityWorkspace: workspace,
      recordedSourceDigest: identity.sourceDigest,
    });
    try {
      // connect() 含 tsx 装载与 watcher ready；只记录，不把它混入工具 SLA。
      expect(Number.isFinite(startupMs)).toBe(true);
      expect(startupMs).toBeGreaterThanOrEqual(0);

      const cold = await timedToolCall(client, "get_capabilities", {});
      expect(cold.result.isError).not.toBe(true);
      const coldProjection = parseToolText<CapabilitiesProjection>(cold.result);
      expect(coldProjection.buildCurrentness).toMatchObject({
        allowed: true,
        sourceDigest: identity.sourceDigest,
      });
      expect(coldProjection.runtimeGateMetrics).toMatchObject({
        digestCalls: 1,
        readChecks: 1,
        readCacheMisses: 1,
        watcherHealthy: true,
      });
      expect(cold.durationMs).toBeLessThanOrEqual(2_000);

      const before = {
        registry: await filesystemSnapshot(registryRoot),
        project: await filesystemSnapshot(created.paths.root),
      };
      expect(suspiciousRuntimeEntryNames(before.registry)).toEqual([]);
      expect(suspiciousRuntimeEntryNames(before.project)).toEqual([]);

      const firstWarm = await timedToolCall(client, "get_active_managed_studio_context", {});
      const secondWarm = await timedToolCall(client, "get_active_managed_studio_context", {});
      expect(firstWarm.result.isError).not.toBe(true);
      expect(secondWarm.result.isError).not.toBe(true);
      expect(parseToolText<{ projectRoot: string }>(firstWarm.result).projectRoot).toBe(created.paths.root);
      expect(parseToolText<{ projectRoot: string }>(secondWarm.result).projectRoot).toBe(created.paths.root);
      expect(firstWarm.durationMs).toBeLessThanOrEqual(500);
      expect(secondWarm.durationMs).toBeLessThanOrEqual(500);

      const after = {
        registry: await filesystemSnapshot(registryRoot),
        project: await filesystemSnapshot(created.paths.root),
      };
      expect(after).toEqual(before);
      expect(suspiciousRuntimeEntryNames(after.registry)).toEqual([]);
      expect(suspiciousRuntimeEntryNames(after.project)).toEqual([]);

      const diagnostics = parseToolText<CapabilitiesProjection>(
        (await timedToolCall(client, "get_capabilities", {})).result,
      );
      // 首次 capabilities 已填充健康 watcher 下的 2 秒 cache；连续活动上下文不得
      // 再做整仓摘要。第二次 capabilities 本身也应命中同一窗口。
      expect(diagnostics.runtimeGateMetrics).toMatchObject({
        digestCalls: 1,
        readChecks: 4,
        readCacheMisses: 1,
        watcherHealthy: true,
      });
      expect(diagnostics.runtimeGateMetrics.readCacheHits).toBeGreaterThanOrEqual(3);
      const activeMetric = diagnostics.runtimeMcpMetrics.tools.find(
        (entry) => entry.tool === "get_active_managed_studio_context",
      );
      expect(activeMetric).toMatchObject({
        effect: "read-only",
        calls: 2,
        failures: 0,
      });
      expect(activeMetric?.maxDurationMs).toBeLessThanOrEqual(500);
    } finally {
      await client.close();
    }
  }, 120_000);

  it("未列入物理零写白名单的 readOnlyHint 工具保持强门禁，源码漂移后写工具零业务写入", async () => {
    const runtimeRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "ai-canvas-mcp-p0-drift-")));
    roots.push(runtimeRoot);
    const { created, registryRoot, registryPath } = await createRegisteredProject(
      runtimeRoot,
      "p0-strong-gate",
    );
    const identityWorkspace = await createMutableIdentityWorkspace(runtimeRoot);
    const identity = await createBuildIdentity(identityWorkspace);
    const { client } = await connectMcp({
      registryPath,
      identityWorkspace,
      recordedSourceDigest: identity.sourceDigest,
    });
    try {
      const initial = parseToolText<CapabilitiesProjection>(
        (await timedToolCall(client, "get_capabilities", {})).result,
      );
      expect(initial.buildCurrentness.allowed).toBe(true);

      // 该工具声明 readOnlyHint，但尚未进入物理零写白名单，因此必须走 mutation 强门禁。
      for (let index = 0; index < 2; index += 1) {
        const leaseRead = await timedToolCall(client, "get_studio_project_write_lease", {
          projectRoot: created.paths.root,
        });
        expect(leaseRead.result.isError).not.toBe(true);
      }
      const afterUnclassifiedReads = parseToolText<CapabilitiesProjection>(
        (await timedToolCall(client, "get_capabilities", {})).result,
      );
      expect(afterUnclassifiedReads.runtimeGateMetrics.mutationChecks).toBe(2);
      // mutation 核验期间若发生 watcher 失效，epoch 绑定会触发有界重验并多付
      // 一次 digest；等式把重验次数计入，避免把合法重验误判为重复整仓摘要。
      expect(afterUnclassifiedReads.runtimeGateMetrics.digestCalls)
        .toBe(
          initial.runtimeGateMetrics.digestCalls
          + 2
          + afterUnclassifiedReads.runtimeGateMetrics.mutationEpochRetries,
        );
      expect(afterUnclassifiedReads.runtimeMcpMetrics.tools.find(
        (entry) => entry.tool === "get_studio_project_write_lease",
      )).toMatchObject({
        effect: "mutation",
        calls: 2,
        failures: 0,
      });

      // 门禁通过但工具体返回 toolError（isError=true）的业务失败必须计入 failures，
      // 不得因为没有抛异常而被观测面记为成功。
      const businessFailure = await timedToolCall(client, "get_studio_project_write_lease", {
        projectRoot: path.join(runtimeRoot, "not-a-managed-project"),
      });
      expect(businessFailure.result.isError).toBe(true);
      const afterBusinessFailure = parseToolText<CapabilitiesProjection>(
        (await timedToolCall(client, "get_capabilities", {})).result,
      );
      expect(afterBusinessFailure.runtimeMcpMetrics.tools.find(
        (entry) => entry.tool === "get_studio_project_write_lease",
      )).toMatchObject({
        effect: "mutation",
        calls: 3,
        failures: 1,
      });

      await writeFile(
        path.join(identityWorkspace, "src", "identity-probe.ts"),
        "export const identityProbe = 2;\n",
        "utf8",
      );
      const beforeDeniedWrite = {
        registry: await filesystemSnapshot(registryRoot),
        project: await filesystemSnapshot(created.paths.root),
      };
      const denied = await timedToolCall(client, "execute_command", {
        projectRoot: created.paths.root,
        requestId: "p0-source-drift-request-0001",
        idempotencyKey: "p0-source-drift-key-0001",
        request: {
          command: "create_studio_asset",
          payload: {
            id: "character-must-not-exist",
            category: "character",
            name: "源码漂移后不得创建",
            expectedRevision: 0,
          },
        },
      });
      expect(denied.result.isError).toBe(true);
      expect(denied.result.content?.find((entry) => entry.type === "text")?.text)
        .toMatch(/BUILD_CURRENTNESS_MISMATCH|source-changed/u);
      const afterDeniedWrite = {
        registry: await filesystemSnapshot(registryRoot),
        project: await filesystemSnapshot(created.paths.root),
      };
      expect(afterDeniedWrite).toEqual(beforeDeniedWrite);

      // 门禁拒绝也是失败，且必须记录真实 gate 耗时；此前实现会把该路径写成
      // failures 正确但 gateDurationMs=0，低报门禁成本。
      const afterDeniedMetrics = parseToolText<CapabilitiesProjection>(
        (await timedToolCall(client, "get_capabilities", {})).result,
      );
      const executeCommandMetric = afterDeniedMetrics.runtimeMcpMetrics.tools.find(
        (entry) => entry.tool === "execute_command",
      );
      expect(executeCommandMetric).toMatchObject({
        effect: "mutation",
        calls: 1,
        failures: 1,
      });
      expect(executeCommandMetric?.maxGateDurationMs).toBeGreaterThan(0);
    } finally {
      await client.close();
    }
  }, 120_000);
});
