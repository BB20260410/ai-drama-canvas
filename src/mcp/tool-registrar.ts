import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export type McpToolRegistrarRaw = McpServer["registerTool"];

type ToolConfig = {
  description?: string;
  inputSchema?: unknown;
  annotations?: Record<string, unknown>;
};
type ToolHandler = (...args: unknown[]) => unknown;
type RuntimeEffect = "diagnostic-read" | "read-only" | "mutation" | "external-side-effect";

type GuardedCommandSchema = {
  safeParse(input: unknown):
    | { success: true }
    | { success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> } };
};

export type GuardedWriteExecution = {
  command: string;
  projectRoot: unknown;
  requestId: unknown;
  idempotencyKey: unknown;
  writeLeaseHolderId: unknown;
  writeLeaseToken: unknown;
  payload: Record<string, unknown>;
  extra: unknown;
  bridge: unknown;
};

export interface McpToolRegistrarDependencies {
  rawRegisterTool: McpToolRegistrarRaw;
  runtimeMcpEffect(name: string): RuntimeEffect;
  runtimeMcpGateMode(name: string): "bypass" | "cached-read" | "strong";
  assertRuntimeCurrent(name: string): Promise<void>;
  recordRuntimePerformance(entry: {
    tool: string;
    effect: RuntimeEffect;
    durationMs: number;
    gateDurationMs: number;
    failed: boolean;
  }): void;
  toolError(error: unknown): unknown;
  guardedWriteCommands: Readonly<Partial<Record<string, string>>>;
  guardedPayloadNormalizers: Readonly<Partial<Record<string, (payload: Record<string, unknown>) => Record<string, unknown>>>>;
  getCommandRequestSchema(): GuardedCommandSchema;
  createGuardedWriteBridge(command: string, extra: unknown): { flush(): Promise<void> };
  executeGuardedWrite(execution: GuardedWriteExecution): Promise<unknown>;
}

const GUARDED_WRITE_DESCRIPTION_SUFFIX = " 必须携带稳定 requestId 与 idempotencyKey；执行前写入跨进程命令账本。生产 require 模式：生图相关写必须先 acquire 并带 writeLeaseHolderId+writeLeaseToken（无租约不准写）。";

function extendInputSchema(inputSchema: unknown, shape: Record<string, unknown>): unknown {
  if (inputSchema && typeof inputSchema === "object" && "safeExtend" in inputSchema
    && typeof (inputSchema as { safeExtend?: unknown }).safeExtend === "function") {
    return (inputSchema as { safeExtend(shape: Record<string, unknown>): unknown }).safeExtend(shape);
  }
  return { ...(inputSchema as Record<string, unknown> | undefined), ...shape };
}

/** The sole SDK-generic narrowing boundary; all server calls keep McpServer's raw registrar type. */
function registerRawTool(
  rawRegisterTool: McpToolRegistrarRaw,
  name: string,
  config: ToolConfig,
  callback: ToolHandler,
): unknown {
  return rawRegisterTool(name, config as never, callback as never);
}

/**
 * Explicit registration pipeline for every MCP tool.
 *
 * Runtime currentness/effect/metrics stays outside guarded writes, which in turn
 * remain outside the command bus. This mirrors the previous two registration
 * wrappers without mutating McpServer.registerTool.
 */
export function createMcpToolRegistrar(deps: McpToolRegistrarDependencies): {
  registerTool: McpServer["registerTool"];
} {
  const registerTool = ((name: string, config: ToolConfig, handler: ToolHandler) => {
    const command = deps.guardedWriteCommands[name];
    const guardedConfig = command
      ? (() => {
        const guardShape = { requestId: z.string().min(8).max(160), idempotencyKey: z.string().min(8).max(200) };
        const leaseShape = {
          writeLeaseHolderId: z.string().trim().min(1).max(128).optional(),
          writeLeaseToken: z.string().trim().regex(/^lease-[a-f0-9]{32}$/u).optional(),
        };
        const guardedInputSchema = extendInputSchema(config.inputSchema, guardShape);
        const guardedWithLease = extendInputSchema(guardedInputSchema, leaseShape);
        return {
          ...config,
          description: `${config.description ?? ""}${GUARDED_WRITE_DESCRIPTION_SUFFIX}`,
          inputSchema: guardedWithLease,
          annotations: { ...(config.annotations ?? {}), readOnlyHint: false, idempotentHint: true },
        };
      })()
      : config;

    const guardedHandler: ToolHandler = command
      ? async (args: unknown, extra: unknown) => {
        const input = args && typeof args === "object" ? args as Record<string, unknown> : {};
        const {
          projectRoot,
          requestId,
          idempotencyKey,
          writeLeaseHolderId,
          writeLeaseToken,
          ...rawPayload
        } = input;
        const bridge = deps.createGuardedWriteBridge(command, extra);
        try {
          const payload = deps.guardedPayloadNormalizers[command]?.(rawPayload) ?? rawPayload;
          // Deliberately only inspect success: command execution keeps the original raw payload,
          // rather than Zod's parsed.data, so request hashes and command semantics remain stable.
          const parsed = deps.getCommandRequestSchema().safeParse({ command, payload });
          if (!parsed.success) {
            return deps.toolError(new Error(`命令 ${command} 的载荷不符合合同：${parsed.error.issues.map((issue) => `${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`).join("；")}`));
          }
          return await deps.executeGuardedWrite({
            command,
            projectRoot,
            requestId,
            idempotencyKey,
            writeLeaseHolderId,
            writeLeaseToken,
            payload,
            extra,
            bridge,
          });
        } catch (error) {
          return deps.toolError(error);
        } finally {
          await bridge.flush();
        }
      }
      : handler;

    const runtimeHandler: ToolHandler = async (...args: unknown[]) => {
      const effect = deps.runtimeMcpEffect(name);
      const mode = deps.runtimeMcpGateMode(name);
      const startedAt = performance.now();
      let gateDurationMs = 0;
      let failed = false;
      try {
        if (mode !== "bypass") {
          const gateStartedAt = performance.now();
          try {
            await deps.assertRuntimeCurrent(name);
          } finally {
            gateDurationMs = performance.now() - gateStartedAt;
          }
        }
        const result = await guardedHandler(...args);
        if (typeof result === "object" && result !== null && (result as { isError?: unknown }).isError === true) failed = true;
        return result;
      } catch (error) {
        failed = true;
        return deps.toolError(error);
      } finally {
        deps.recordRuntimePerformance({
          tool: name,
          effect,
          durationMs: performance.now() - startedAt,
          gateDurationMs,
          failed,
        });
      }
    };

    return registerRawTool(deps.rawRegisterTool, name, guardedConfig, runtimeHandler);
  }) as McpServer["registerTool"];

  return { registerTool };
}
