#!/usr/bin/env node
import {
  executeNovelAgentJsonRequest,
  NOVEL_AGENT_JSON_SCHEMA_VERSION,
  projectNovelAgentJsonError,
} from "../src/core/novel-agent-json.js";

async function readStdin(): Promise<string> {
  process.stdin.setEncoding("utf8");
  let value = "";
  for await (const chunk of process.stdin) value += chunk;
  return value;
}

function requestedOperation(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const operation = (value as { operation?: unknown }).operation;
  return typeof operation === "string" ? operation : undefined;
}

async function main(): Promise<void> {
  const raw = await readStdin();
  if (!raw.trim()) throw new Error("stdin 必须提供一个 Novel Agent JSON 请求。");
  let request: unknown;
  try {
    request = JSON.parse(raw);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      schemaVersion: NOVEL_AGENT_JSON_SCHEMA_VERSION,
      ok: false,
      error: {
        code: "INVALID_JSON",
        message: error instanceof Error ? error.message : String(error),
      },
    })}\n`);
    process.exitCode = 1;
    return;
  }

  try {
    const result = await executeNovelAgentJsonRequest(request);
    process.stdout.write(`${JSON.stringify({
      schemaVersion: NOVEL_AGENT_JSON_SCHEMA_VERSION,
      ok: true,
      operation: result.operation,
      data: result.data,
    })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      schemaVersion: NOVEL_AGENT_JSON_SCHEMA_VERSION,
      ok: false,
      ...(requestedOperation(request) ? { operation: requestedOperation(request) } : {}),
      error: projectNovelAgentJsonError(error),
    })}\n`);
    process.exitCode = 1;
  }
}

await main();
