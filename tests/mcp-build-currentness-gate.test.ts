import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";
import { createBuildIdentity } from "../src/core/build-identity.js";
import { createManagedProject } from "../src/core/managed-project.js";
import { listCommandLedger } from "../src/core/command-bus.js";

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createClient(
  runtimeRoot: string,
  recordedSourceDigest: string,
  identityWorkspace = workspace,
  recordedRuntimeArtifactSha256?: string,
): Promise<Client> {
  const runtimeSourcePath = path.join(workspace, "src", "mcp", "server.ts");
  const runtimeArtifactSha256 = recordedRuntimeArtifactSha256
    ?? createHash("sha256").update(await readFile(runtimeSourcePath)).digest("hex");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/mcp/server.ts"],
    cwd: workspace,
    env: {
      ...process.env,
      AI_CANVAS_REGISTRY_PATH: path.join(runtimeRoot, "projects.json"),
      AI_CANVAS_WORKSPACE: identityWorkspace,
      AI_CANVAS_RECORDED_SOURCE_DIGEST: recordedSourceDigest,
      AI_CANVAS_RECORDED_RUNTIME_ARTIFACT_SHA256: runtimeArtifactSha256,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "build-currentness-gate-test", version: "0.1.0" });
  await client.connect(transport);
  return client;
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
  await writeFile(path.join(identityWorkspace, "src", "identity-probe.ts"), "export const probe = 1;\n", "utf8");
  return identityWorkspace;
}

function parseText(result: unknown): Record<string, unknown> {
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content ?? [];
  return JSON.parse(content.find((entry) => entry.type === "text")?.text ?? "{}") as Record<string, unknown>;
}

describe("MCP 运行时构建 currentness 失败关闭", () => {
  it("摘要不一致时仅保留 capabilities 诊断并拒绝 dashboard", async () => {
    const runtimeRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "ai-canvas-build-gate-denied-")));
    roots.push(runtimeRoot);
    const projectRoot = (await createManagedProject({ parentRoot: runtimeRoot, name: "旧构建拒绝夹具" })).paths.root;
    const client = await createClient(runtimeRoot, "0".repeat(64));
    try {
      const capabilities = parseText(await client.callTool({ name: "get_capabilities", arguments: {} }));
      expect(capabilities.buildCurrentness).toMatchObject({ allowed: false });

      const denied = await client.callTool({
        name: "get_studio_production_dashboard",
        arguments: { projectRoot, query: { operation: "overview" } },
      }) as { isError?: boolean; content?: Array<{ type?: string; text?: string }> };
      expect(denied.isError).toBe(true);
      expect(denied.content?.find((entry) => entry.type === "text")?.text).toMatch(/BUILD_CURRENTNESS_MISMATCH|get_capabilities/u);
    } finally {
      await client.close();
    }
  }, 120_000);

  it("摘要一致时 dashboard 正常可调用", async () => {
    const runtimeRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "ai-canvas-build-gate-allowed-")));
    roots.push(runtimeRoot);
    const projectRoot = (await createManagedProject({ parentRoot: runtimeRoot, name: "当前构建允许夹具" })).paths.root;
    const identity = await createBuildIdentity(workspace);
    const client = await createClient(runtimeRoot, identity.sourceDigest);
    try {
      const capabilities = parseText(await client.callTool({ name: "get_capabilities", arguments: {} }));
      expect(capabilities.buildCurrentness).toMatchObject({ allowed: true, sourceDigest: identity.sourceDigest });

      const overview = await client.callTool({
        name: "get_studio_production_dashboard",
        arguments: { projectRoot, query: { operation: "overview" } },
      }) as { isError?: boolean; content?: Array<{ type?: string; text?: string }> };
      expect(overview.isError).not.toBe(true);
      expect(parseText(overview)).toMatchObject({ operation: "overview" });
    } finally {
      await client.close();
    }
  }, 120_000);

  it("源码摘要一致但 runtime artifact SHA 不一致时仍失败关闭", async () => {
    const runtimeRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "ai-canvas-artifact-gate-denied-")));
    roots.push(runtimeRoot);
    const projectRoot = (await createManagedProject({ parentRoot: runtimeRoot, name: "旧运行文件拒绝夹具" })).paths.root;
    const identity = await createBuildIdentity(workspace);
    const client = await createClient(runtimeRoot, identity.sourceDigest, workspace, "0".repeat(64));
    try {
      const capabilities = parseText(await client.callTool({ name: "get_capabilities", arguments: {} }));
      expect(capabilities.runtimeArtifactCurrentness).toMatchObject({
        allowed: false,
        restartRequired: true,
      });

      const denied = await client.callTool({
        name: "get_studio_production_dashboard",
        arguments: { projectRoot, query: { operation: "overview" } },
      }) as { isError?: boolean; content?: Array<{ type?: string; text?: string }> };
      expect(denied.isError).toBe(true);
      expect(denied.content?.find((entry) => entry.type === "text")?.text).toMatch(/BUILD_ARTIFACT_MISMATCH|get_capabilities/u);
    } finally {
      await client.close();
    }
  }, 120_000);

  it("同一源码态 MCP 首次通过后源码漂移，下一工具调用无需重启即失败关闭", async () => {
    const runtimeRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "ai-canvas-build-gate-drift-")));
    roots.push(runtimeRoot);
    const projectRoot = (await createManagedProject({ parentRoot: runtimeRoot, name: "源码漂移拒绝夹具" })).paths.root;
    const identityWorkspace = await createMutableIdentityWorkspace(runtimeRoot);
    const identity = await createBuildIdentity(identityWorkspace);
    const client = await createClient(runtimeRoot, identity.sourceDigest, identityWorkspace);
    try {
      const first = await client.callTool({
        name: "get_studio_production_dashboard",
        arguments: { projectRoot, query: { operation: "overview" } },
      }) as { isError?: boolean };
      expect(first.isError).not.toBe(true);

      await writeFile(path.join(identityWorkspace, "src", "identity-probe.ts"), "export const probe = 2;\n", "utf8");
      const capabilities = parseText(await client.callTool({ name: "get_capabilities", arguments: {} }));
      expect(capabilities.buildCurrentness).toMatchObject({ allowed: false });

      const denied = await client.callTool({
        name: "execute_command",
        arguments: {
          projectRoot,
          requestId: "build-drift-request-0001",
          idempotencyKey: "build-drift-key-0001",
          request: {
            command: "create_studio_asset",
            payload: {
              id: "character-build-drift-probe",
              category: "character",
              name: "不得写入",
              expectedRevision: 0,
            },
          },
        },
      }) as { isError?: boolean; content?: Array<{ type?: string; text?: string }> };
      expect(denied.isError).toBe(true);
      expect(denied.content?.find((entry) => entry.type === "text")?.text).toMatch(/BUILD_CURRENTNESS_MISMATCH/u);
      expect(await listCommandLedger(projectRoot)).toEqual([]);
    } finally {
      await client.close();
    }
  }, 120_000);
});
