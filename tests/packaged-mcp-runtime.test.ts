import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  readReleaseManifest,
  releaseManifestBody,
  releaseManifestDigest,
  type ReleaseManifest,
} from "../src/core/release-manifest.js";
import { EXPECTED_MCP_TOOL_COUNT } from "./helpers/mcp-tool-count.js";

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoots: string[] = [];

afterEach(async () => Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

function parsed(result: unknown): Record<string, any> {
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content ?? [];
  return JSON.parse(content.find((entry) => entry.type === "text")?.text ?? "{}") as Record<string, any>;
}

describe("P14 Electron 自带 runtime 启动编译 MCP", () => {
  it("无需系统 Node 即可读取隔离 runtime manifest 与真实工具清单", async () => {
    const electronExecutable = path.join(workspace, "node_modules", "electron", "dist", "Electron.app", "Contents", "MacOS", "Electron");
    const serverPath = path.join(workspace, "dist-mcp", "mcp", "server.js");
    const releaseManifestPath = path.join(workspace, "release-manifest.json");
    await Promise.all([access(electronExecutable), access(serverPath), access(releaseManifestPath)]);
    const releaseManifest = await readReleaseManifest(releaseManifestPath);
    const runtimeArtifactSha256 = createHash("sha256").update(await readFile(serverPath)).digest("hex");
    const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-electron-mcp-runtime-"));
    temporaryRoots.push(runtimeRoot);
    // 源码回归不得覆盖历史发布物；在隔离目录内把当前注册源工具数绑定到本次 runtime 测试。
    const manifestBody = {
      ...releaseManifestBody(releaseManifest),
      mcpToolCount: EXPECTED_MCP_TOOL_COUNT,
    };
    const manifest: ReleaseManifest = {
      ...manifestBody,
      fingerprint: releaseManifestDigest(manifestBody),
    };
    const manifestPath = path.join(runtimeRoot, "release-manifest.json");
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const transport = new StdioClientTransport({
      command: "/usr/bin/env",
      args: ["ELECTRON_RUN_AS_NODE=1", electronExecutable, serverPath],
      cwd: workspace,
      env: {
        ...process.env,
        AI_CANVAS_RELEASE_MANIFEST_PATH: manifestPath,
        AI_CANVAS_WORKSPACE: workspace,
        AI_CANVAS_RECORDED_SOURCE_DIGEST: manifest.sourceDigest,
        AI_CANVAS_RECORDED_RUNTIME_ARTIFACT_SHA256: runtimeArtifactSha256,
        AI_CANVAS_BUILD_TIMESTAMP: manifest.builtAt,
        AI_CANVAS_REGISTRY_PATH: path.join(runtimeRoot, "projects.json"),
      },
      stderr: "pipe",
    });
    const client = new Client({ name: "p14-electron-runtime-test", version: manifest.version });
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools).toHaveLength(manifest.mcpToolCount);
      const capabilities = parsed(await client.callTool({ name: "get_capabilities", arguments: {} }));
      expect(capabilities).toMatchObject({
        server: {
          version: manifest.version,
          protocolVersion: manifest.protocolVersion,
          toolCount: manifest.mcpToolCount,
        },
        buildIdentity: {
          sourceDigest: manifest.sourceDigest,
          buildId: manifest.buildId,
          builtAtSource: "artifact",
        },
        runtimeArtifactCurrentness: {
          allowed: true,
          loadedSha256: runtimeArtifactSha256,
          expectedSha256: runtimeArtifactSha256,
        },
      });
    } finally {
      await client.close();
    }
  }, 120_000);
});
