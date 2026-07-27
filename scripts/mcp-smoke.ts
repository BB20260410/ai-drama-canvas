import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const serverPath = path.resolve(process.argv[2] ?? "dist-mcp/mcp/server.js");
const packagedRuntime = process.env.AI_CANVAS_MCP_RUNTIME?.trim();
const inheritedEnvironmentKeys = new Set([
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOGNAME",
  "PATH",
  "SHELL",
  "TMPDIR",
  "USER",
]);
const transportEnvironment = Object.fromEntries(
  Object.entries(process.env)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .filter(([key]) => inheritedEnvironmentKeys.has(key) || key.startsWith("AI_CANVAS_")),
);
const transport = new StdioClientTransport({
  command: packagedRuntime ? "/usr/bin/env" : process.execPath,
  args: packagedRuntime ? ["ELECTRON_RUN_AS_NODE=1", path.resolve(packagedRuntime), serverPath] : [serverPath],
  cwd: process.cwd(),
  env: transportEnvironment,
  stderr: "pipe",
});
const client = new Client({ name: "ai-drama-canvas-smoke", version: "0.1.0" });
transport.stderr?.on("data", (chunk) => process.stderr.write(chunk));

try {
  await client.connect(transport);
  const [result, resources, resourceTemplates, prompts] = await Promise.all([client.listTools(), client.listResources(), client.listResourceTemplates(), client.listPrompts()]);
  process.stdout.write(`${JSON.stringify({
    serverPath,
    runtime: packagedRuntime ? path.resolve(packagedRuntime) : process.execPath,
    toolCount: result.tools.length,
    tools: result.tools.map((tool) => tool.name),
    resources: resources.resources.map((resource) => resource.uri),
    resourceTemplates: resourceTemplates.resourceTemplates.map((resource) => resource.uriTemplate),
    prompts: prompts.prompts.map((prompt) => prompt.name),
  }, null, 2)}\n`);
} finally {
  await client.close();
}
