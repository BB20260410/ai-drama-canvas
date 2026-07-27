import { randomUUID } from "node:crypto";
import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { computeSourceDigest, createBuildIdentity } from "../src/core/build-identity.js";
import {
  AI_CANVAS_APPLICATION_VERSION,
  AI_CANVAS_PROTOCOL_VERSION,
  RELEASE_MANIFEST_FILE_NAME,
  RELEASE_MANIFEST_SCHEMA_VERSION,
  countDeclaredMcpTools,
  releaseManifestDigest,
  type ReleaseManifest,
} from "../src/core/release-manifest.js";

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = path.join(workspace, "dist-mcp", "mcp", "server.js");
const manifestPath = path.join(workspace, RELEASE_MANIFEST_FILE_NAME);

async function listCompiledMcpTools(): Promise<string[]> {
  const childEnvironment = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
  delete childEnvironment.AI_CANVAS_RELEASE_MANIFEST_PATH;
  delete childEnvironment.AI_CANVAS_RECORDED_SOURCE_DIGEST;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    cwd: workspace,
    env: childEnvironment,
    stderr: "pipe",
  });
  const client = new Client({ name: "ai-drama-canvas-release-builder", version: AI_CANVAS_APPLICATION_VERSION });
  transport.stderr?.on("data", (chunk) => process.stderr.write(chunk));
  try {
    await client.connect(transport);
    const tools = (await client.listTools()).tools.map((tool) => tool.name);
    if (!tools.length || new Set(tools).size !== tools.length) {
      throw new Error("编译 MCP 工具清单为空或含重复名称，拒绝生成 release manifest。");
    }
    return tools;
  } finally {
    await client.close();
  }
}

const packageJson = JSON.parse(await readFile(path.join(workspace, "package.json"), "utf8")) as { version?: string };
if (packageJson.version !== AI_CANVAS_APPLICATION_VERSION) {
  throw new Error(`package.json 版本 ${packageJson.version ?? "<missing>"} 与发布版本 ${AI_CANVAS_APPLICATION_VERSION} 不一致。`);
}

const sourceBefore = await computeSourceDigest(workspace);
const toolNames = await listCompiledMcpTools();
const declaredToolCount = await countDeclaredMcpTools(workspace);
if (declaredToolCount !== toolNames.length) {
  throw new Error(`MCP 注册源声明 ${declaredToolCount} 项，但编译后 listTools 返回 ${toolNames.length} 项。`);
}

const builtAt = new Date().toISOString();
const identity = await createBuildIdentity(workspace, {
  artifactBuiltAt: builtAt,
  queriedAt: builtAt,
  mcpToolCount: toolNames.length,
});
if (identity.sourceDigest !== sourceBefore.sourceDigest) {
  throw new Error("生成 release manifest 期间源码发生漂移，拒绝发布。");
}

const body: Omit<ReleaseManifest, "fingerprint"> = {
  schemaVersion: RELEASE_MANIFEST_SCHEMA_VERSION,
  kind: "ai-drama-canvas-release-manifest",
  version: AI_CANVAS_APPLICATION_VERSION,
  architecture: process.arch,
  sourceDigest: identity.sourceDigest,
  buildId: identity.buildId,
  buildIdentityFingerprint: identity.fingerprint,
  protocolVersion: AI_CANVAS_PROTOCOL_VERSION,
  mcpToolCount: toolNames.length,
  builtAt,
  distribution: "local-only",
  localOnly: true,
  source: {
    files: identity.roots.sourceFiles,
    bytes: identity.roots.sourceBytes,
  },
};
const manifest: ReleaseManifest = { ...body, fingerprint: releaseManifestDigest(body) };
const temporaryPath = `${manifestPath}.tmp-${randomUUID()}`;
await writeFile(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o444 });
await rename(temporaryPath, manifestPath);
await chmod(manifestPath, 0o444);

process.stdout.write(`${JSON.stringify({
  manifestPath,
  version: manifest.version,
  architecture: manifest.architecture,
  sourceDigest: manifest.sourceDigest,
  buildId: manifest.buildId,
  protocolVersion: manifest.protocolVersion,
  mcpToolCount: manifest.mcpToolCount,
  builtAt: manifest.builtAt,
  distribution: manifest.distribution,
  fingerprint: manifest.fingerprint,
}, null, 2)}\n`);
