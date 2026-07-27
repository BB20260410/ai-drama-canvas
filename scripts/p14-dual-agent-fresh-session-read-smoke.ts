/**
 * P14 双 Agent 全新会话读取验收。
 *
 * 只通过 execFile(shell=false) 启动全新 Codex/Grok 非交互会话；
 * 会话只允许调用 ai-drama-canvas MCP 的 get_capabilities 和
 * get_active_managed_studio_context。本脚本不接收 projectRoot、不修改
 * Agent 配置、不读取或输出密钥。
 */
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeJsonAtomicExclusive } from "../src/core/sidecar.js";

export const P14_FRESH_SESSION_MARKER = "AI_DRAMA_CANVAS_FRESH_SESSION_READ_V1" as const;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 180_000;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const BUILD_ID_PATTERN = /^[a-f0-9]{32}$/u;
const WORKSPACE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export type P14FreshSessionClient = "codex" | "grok";

const P14_REQUIRED_NATIVE_TOOL_SEQUENCE = [
  "get_capabilities",
  "get_active_managed_studio_context",
] as const;

export interface P14NativeToolTraceCall {
  serverName: "ai-drama-canvas" | string;
  toolName: string;
  argumentsEmpty: boolean;
  completed: boolean;
  succeeded: boolean;
}

export interface P14NativeToolTraceInspection {
  client: P14FreshSessionClient;
  format: "codex-jsonl" | "grok-streaming-json";
  verifiable: boolean;
  exactToolSequence: boolean;
  jsonEventCount: number;
  toolCalls: P14NativeToolTraceCall[];
  traceSha256: string;
  reason?:
    | "native-trace-missing"
    | "native-tool-events-missing"
    | "unsupported-native-tool-event"
    | "unexpected-native-tool"
    | "nonempty-tool-arguments"
    | "native-tool-incomplete"
    | "native-tool-failed"
    | "native-tool-sequence-mismatch";
}

export interface P14FreshSessionLockedAsset {
  assetId: string;
  name: string;
  category: "character" | "scene" | "prop";
  revision: number;
  currentness: string;
}

export interface P14FreshSessionResult {
  schemaVersion: 1;
  marker: typeof P14_FRESH_SESSION_MARKER;
  client: P14FreshSessionClient;
  toolCalls: ["get_capabilities", "get_active_managed_studio_context"];
  capabilities: {
    serverName: "ai-drama-canvas";
    buildId: string;
    sourceDigest: string;
    toolCount: number;
    buildIdentityFingerprint: string;
  };
  activeContext: {
    projectId: string;
    manifestFingerprint: string;
    contextFingerprint: string;
    sourceDigest: string;
    lockedAssets: P14FreshSessionLockedAsset[];
    nextAction: {
      code: string;
      label: string;
      reason: string;
      requiresWrite: boolean;
      command: string | null;
    };
    promptEntry: "managed_studio_lock_generate_writeback";
  };
  safety: {
    projectRootArgumentSupplied: false;
    secretsReadOrPrinted: false;
  };
}

export interface P14DualAgentExpectedIdentity {
  projectId: string;
  manifestFingerprint: string;
  sourceDigest: string;
}

export interface P14DualAgentFreshSessionInput extends P14DualAgentExpectedIdentity {
  codexExecutable: string;
  grokExecutable: string;
  evidencePath: string;
  workspaceRoot?: string;
  timeoutMs?: number;
}

export interface P14FreshSessionInvocation {
  kind: "help" | "session";
  client: P14FreshSessionClient;
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  finalMessagePath?: string;
}

export interface P14FreshSessionCommandResult {
  stdout: string;
  stderr: string;
  /** Codex 使用 --output-last-message 得到的最终结构化消息。 */
  finalMessage?: string;
}

export type P14FreshSessionCommandRunner = (
  invocation: P14FreshSessionInvocation,
) => Promise<P14FreshSessionCommandResult>;

export interface P14HeadlessSupportInspection {
  client: P14FreshSessionClient;
  supported: boolean;
  missing: string[];
  helpSha256: string;
}

export interface P14DualAgentFreshSessionEvidence {
  schemaVersion: 1;
  kind: "p14-dual-agent-fresh-session-read-evidence";
  status: "PASS" | "FAIL";
  startedAt: string;
  completedAt: string;
  expected: P14DualAgentExpectedIdentity;
  clients: {
    codex: {
      executable: string;
      help?: P14HeadlessSupportInspection;
      sessionStarted: boolean;
      nativeTrace?: P14NativeToolTraceInspection;
    };
    grok: {
      executable: string;
      help?: P14HeadlessSupportInspection;
      sessionStarted: boolean;
      nativeTrace?: P14NativeToolTraceInspection;
    };
  };
  results?: { codex: P14FreshSessionResult; grok: P14FreshSessionResult };
  comparisons?: {
    expectedIdentity: true;
    sameBuildIdentity: true;
    sameContextFingerprint: true;
    sameLockedAssets: true;
    sameNextAction: true;
    samePromptEntry: true;
    exactToolSequence: true;
  };
  boundaries: {
    execFileWithoutShell: true;
    freshSessions: true;
    projectRootAcceptedByScript: false;
    projectRootArgumentSupplied: false;
    agentConfigurationModified: false;
    secretEnvironmentVariablesForwarded: false;
    secretsReadOrPrinted: false;
  };
  failure?: { code: string; message: string };
  fingerprint: string;
}

export class P14FreshSessionVerificationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "P14FreshSessionVerificationError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new P14FreshSessionVerificationError(code, message);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([key, entry]) => [key, stableValue(entry)]));
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function digest(value: unknown): string {
  return createHash("sha256").update(typeof value === "string" ? value : stableJson(value), "utf8").digest("hex");
}

function sealed<T extends Record<string, unknown>>(value: T): T & { fingerprint: string } {
  return { ...value, fingerprint: digest(value) };
}

function requiredText(value: unknown, field: string, maximum = 4_000): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > maximum) fail("invalid-input", `${field} 必须是 1-${maximum} 字符。`);
  return normalized;
}

function requiredSha256(value: unknown, field: string): string {
  const normalized = requiredText(value, field, 64).toLowerCase();
  if (!SHA256_PATTERN.test(normalized)) fail("invalid-input", `${field} 必须是 64 位小写 SHA-256。`);
  return normalized;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], field: string): void {
  const actual = Object.keys(value).sort((left, right) => left.localeCompare(right, "en"));
  const expected = [...keys].sort((left, right) => left.localeCompare(right, "en"));
  if (stableJson(actual) !== stableJson(expected)) fail("marker-invalid", `${field} 字段不等于冻结 schema。`);
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("marker-invalid", `${field} 必须是对象。`);
  return value as Record<string, unknown>;
}

function stringField(value: unknown, field: string, maximum = 4_000): string {
  return requiredText(value, field, maximum);
}

function booleanField(value: unknown, expected: boolean, field: string): boolean {
  if (value !== expected) fail("marker-invalid", `${field} 必须是 ${expected}。`);
  return value;
}

function collectMarkerObjects(output: string): Record<string, unknown>[] {
  if (Buffer.byteLength(output, "utf8") > MAX_OUTPUT_BYTES) fail("output-too-large", "Agent 输出超过 2 MiB 上限。");
  const roots: unknown[] = [];
  const trimmed = output.trim();
  if (!trimmed) fail("marker-missing", "Agent 未输出结构化 marker。");
  try { roots.push(JSON.parse(trimmed)); } catch { /* JSONL/包装器继续逐行解析。 */ }
  for (const line of trimmed.split(/\r?\n/u).map((entry) => entry.trim()).filter(Boolean)) {
    try { roots.push(JSON.parse(line)); } catch { /* 非 JSON 日志不作证据。 */ }
  }
  const found = new Map<string, Record<string, unknown>>();
  const visit = (value: unknown, depth: number): void => {
    if (depth > 8) return;
    if (typeof value === "string") {
      const nested = value.trim();
      if ((nested.startsWith("{") && nested.endsWith("}")) || (nested.startsWith("[") && nested.endsWith("]"))) {
        try { visit(JSON.parse(nested), depth + 1); } catch { /* 普通文本字段。 */ }
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((entry) => visit(entry, depth + 1));
      return;
    }
    if (!value || typeof value !== "object") return;
    const candidate = value as Record<string, unknown>;
    if (candidate.marker === P14_FRESH_SESSION_MARKER) found.set(digest(candidate), candidate);
    Object.values(candidate).forEach((entry) => visit(entry, depth + 1));
  };
  roots.forEach((value) => visit(value, 0));
  return [...found.values()];
}

interface MutableNativeToolCall {
  id: string;
  serverName: string;
  toolName: string;
  argumentsEmpty: boolean;
  completed: boolean;
  succeeded: boolean;
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function optionalString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function parseNativeArguments(value: unknown): { explicit: boolean; empty: boolean } {
  if (value === undefined) return { explicit: false, empty: false };
  if (typeof value === "string") {
    try { return parseNativeArguments(JSON.parse(value)); } catch { return { explicit: true, empty: false }; }
  }
  const candidate = optionalRecord(value);
  return { explicit: true, empty: Boolean(candidate && Object.keys(candidate).length === 0) };
}

function splitNativeMcpName(value: string | undefined): { serverName?: string; toolName?: string } {
  if (!value) return {};
  const mcpDouble = /^mcp__([^_].*?)__([^_].*)$/u.exec(value);
  if (mcpDouble) return { serverName: mcpDouble[1], toolName: mcpDouble[2] };
  const slash = /^([^/]+)\/([^/]+)$/u.exec(value);
  if (slash) return { serverName: slash[1], toolName: slash[2] };
  return { toolName: value };
}

function nativeCallIdentity(value: Record<string, unknown>): {
  id?: string;
  serverName?: string;
  toolName?: string;
  argumentsExplicit: boolean;
  argumentsEmpty: boolean;
} {
  const combined = splitNativeMcpName(optionalString(value.name));
  const argumentsValue = value.arguments ?? value.input ?? value.args;
  const parsedArguments = parseNativeArguments(argumentsValue);
  return {
    id: optionalString(value.id, value.call_id, value.tool_call_id, value.toolCallId),
    serverName: optionalString(value.server, value.server_name, value.serverName, combined.serverName),
    toolName: optionalString(value.tool, value.tool_name, value.toolName, combined.toolName),
    argumentsExplicit: parsedArguments.explicit,
    argumentsEmpty: parsedArguments.empty,
  };
}

function jsonTraceRecords(output: string): unknown[] {
  if (Buffer.byteLength(output, "utf8") > MAX_OUTPUT_BYTES) fail("output-too-large", "Agent 原生 trace 超过 2 MiB 上限。");
  const records: unknown[] = [];
  for (const line of output.split(/\r?\n/u).map((entry) => entry.trim()).filter(Boolean)) {
    try {
      const parsed = JSON.parse(line) as unknown;
      if (Array.isArray(parsed)) records.push(...parsed);
      else records.push(parsed);
    } catch { /* 终端诊断文本不能成为工具调用证据。 */ }
  }
  return records;
}

function nativeToolLikeType(value: string | undefined): boolean {
  return Boolean(value && /(?:^|[._-])(tool|command|web_search|file_change)(?:$|[._-])/iu.test(value));
}

/**
 * 只审计 CLI 原生 JSON/tool-event trace。最终 marker、prompt echo 与模型声明
 * 都不会进入这里，因此不能把“我调用了两个工具”伪装成调用证据。
 */
export function inspectP14NativeToolTrace(
  client: P14FreshSessionClient,
  output: string,
): P14NativeToolTraceInspection {
  const records = jsonTraceRecords(output);
  const calls: MutableNativeToolCall[] = [];
  const callsById = new Map<string, MutableNativeToolCall>();
  let unsupportedToolEvent = false;
  let syntheticId = 0;

  const upsertCall = (
    identity: ReturnType<typeof nativeCallIdentity>,
    phase: "started" | "completed",
    succeeded: boolean,
  ): void => {
    if (!identity.id || !identity.serverName || !identity.toolName || !identity.argumentsExplicit) {
      unsupportedToolEvent = true;
      return;
    }
    let call = callsById.get(identity.id);
    if (!call) {
      call = {
        id: identity.id,
        serverName: identity.serverName,
        toolName: identity.toolName,
        argumentsEmpty: identity.argumentsEmpty,
        completed: false,
        succeeded: false,
      };
      callsById.set(identity.id, call);
      calls.push(call);
    } else if (call.serverName !== identity.serverName
      || call.toolName !== identity.toolName
      || call.argumentsEmpty !== identity.argumentsEmpty) {
      unsupportedToolEvent = true;
    }
    if (phase === "completed") {
      call.completed = true;
      call.succeeded = succeeded;
    }
  };

  for (const rawRecord of records) {
    const root = optionalRecord(rawRecord);
    if (!root) continue;
    const rootType = optionalString(root.type, root.event, root.event_type);
    if (client === "codex") {
      if (rootType !== "item.started" && rootType !== "item.completed") continue;
      const item = optionalRecord(root.item);
      const itemType = optionalString(item?.type);
      if (itemType === "mcp_tool_call" && item) {
        const failed = item.status === "failed" || item.status === "error" || item.error != null;
        upsertCall(nativeCallIdentity(item), rootType === "item.completed" ? "completed" : "started", !failed);
      } else if (nativeToolLikeType(itemType)) {
        unsupportedToolEvent = true;
      }
      continue;
    }

    if (rootType === "tool_result") {
      const id = optionalString(root.tool_call_id, root.toolCallId, root.id);
      const existing = id ? callsById.get(id) : undefined;
      if (!existing) {
        unsupportedToolEvent = true;
      } else {
        existing.completed = true;
        existing.succeeded = root.is_error !== true && root.error == null && root.status !== "failed";
      }
      continue;
    }
    if (rootType === "tool_call" || rootType === "tool_use" || rootType === "mcp_tool_call") {
      const candidate = optionalRecord(root.tool_call) ?? optionalRecord(root.call) ?? root;
      const identity = nativeCallIdentity(candidate);
      if (!identity.id) identity.id = `grok-native-${syntheticId += 1}`;
      const completed = root.status === "completed" || root.status === "succeeded";
      upsertCall(identity, completed ? "completed" : "started", root.status !== "failed" && root.error == null);
      continue;
    }
    if (nativeToolLikeType(rootType)) unsupportedToolEvent = true;
  }

  const toolCalls: P14NativeToolTraceCall[] = calls.map(({ serverName, toolName, argumentsEmpty, completed, succeeded }) => ({
    serverName,
    toolName,
    argumentsEmpty,
    completed,
    succeeded,
  }));
  const base = {
    client,
    format: client === "codex" ? "codex-jsonl" as const : "grok-streaming-json" as const,
    jsonEventCount: records.length,
    toolCalls,
    traceSha256: digest(output),
  };
  if (records.length === 0) return { ...base, verifiable: false, exactToolSequence: false, reason: "native-trace-missing" };
  if (calls.length === 0) {
    return {
      ...base,
      verifiable: false,
      exactToolSequence: false,
      reason: unsupportedToolEvent ? "unsupported-native-tool-event" : "native-tool-events-missing",
    };
  }
  if (unsupportedToolEvent) return { ...base, verifiable: true, exactToolSequence: false, reason: "unsupported-native-tool-event" };
  if (calls.some((call) => call.serverName !== "ai-drama-canvas"
    || !P14_REQUIRED_NATIVE_TOOL_SEQUENCE.includes(call.toolName as typeof P14_REQUIRED_NATIVE_TOOL_SEQUENCE[number]))) {
    return { ...base, verifiable: true, exactToolSequence: false, reason: "unexpected-native-tool" };
  }
  if (calls.some((call) => !call.argumentsEmpty)) {
    return { ...base, verifiable: true, exactToolSequence: false, reason: "nonempty-tool-arguments" };
  }
  if (calls.some((call) => !call.completed)) {
    return { ...base, verifiable: true, exactToolSequence: false, reason: "native-tool-incomplete" };
  }
  if (calls.some((call) => !call.succeeded)) {
    return { ...base, verifiable: true, exactToolSequence: false, reason: "native-tool-failed" };
  }
  if (stableJson(calls.map((call) => call.toolName)) !== stableJson(P14_REQUIRED_NATIVE_TOOL_SEQUENCE)) {
    return { ...base, verifiable: true, exactToolSequence: false, reason: "native-tool-sequence-mismatch" };
  }
  return { ...base, verifiable: true, exactToolSequence: true };
}

function requireExactNativeToolTrace(inspection: P14NativeToolTraceInspection): void {
  if (!inspection.verifiable) {
    fail("native-trace-unverifiable", `${inspection.client} CLI 原生 trace 不可审计：${inspection.reason ?? "unknown"}。`);
  }
  if (!inspection.exactToolSequence) {
    fail("native-trace-invalid", `${inspection.client} CLI 原生 trace 未精确证明两个只读 MCP 调用：${inspection.reason ?? "unknown"}。`);
  }
}

function parseLockedAsset(value: unknown, index: number): P14FreshSessionLockedAsset {
  const asset = record(value, `activeContext.lockedAssets[${index}]`);
  exactKeys(asset, ["assetId", "name", "category", "revision", "currentness"], `activeContext.lockedAssets[${index}]`);
  const category = asset.category;
  if (category !== "character" && category !== "scene" && category !== "prop") {
    fail("marker-invalid", `activeContext.lockedAssets[${index}].category 无效。`);
  }
  if (!Number.isSafeInteger(asset.revision) || Number(asset.revision) < 1) {
    fail("marker-invalid", `activeContext.lockedAssets[${index}].revision 无效。`);
  }
  return {
    assetId: stringField(asset.assetId, `activeContext.lockedAssets[${index}].assetId`, 255),
    name: stringField(asset.name, `activeContext.lockedAssets[${index}].name`, 1_000),
    category,
    revision: Number(asset.revision),
    currentness: stringField(asset.currentness, `activeContext.lockedAssets[${index}].currentness`, 200),
  };
}

/**
 * 只从最终结构化输出中取唯一 marker；不把日志、prompt echo 或
 * 模型自由文本当作验收结果。
 */
export function parseP14FreshSessionResult(
  client: P14FreshSessionClient,
  output: string,
): P14FreshSessionResult {
  const candidates = collectMarkerObjects(output);
  if (candidates.length === 0) fail("marker-missing", `${client} 未输出 ${P14_FRESH_SESSION_MARKER}。`);
  if (candidates.length !== 1) fail("marker-ambiguous", `${client} 输出了多个不同 marker。`);
  const root = candidates[0]!;
  exactKeys(root, ["schemaVersion", "marker", "client", "toolCalls", "capabilities", "activeContext", "safety"], "marker");
  if (root.schemaVersion !== 1 || root.marker !== P14_FRESH_SESSION_MARKER || root.client !== client) {
    fail("marker-invalid", `${client} marker 身份不匹配。`);
  }
  if (!Array.isArray(root.toolCalls)
    || stableJson(root.toolCalls) !== stableJson(["get_capabilities", "get_active_managed_studio_context"])) {
    fail("tool-sequence-invalid", `${client} 未按固定顺序声明两个 MCP 调用。`);
  }
  const capabilities = record(root.capabilities, "capabilities");
  exactKeys(capabilities, ["serverName", "buildId", "sourceDigest", "toolCount", "buildIdentityFingerprint"], "capabilities");
  if (capabilities.serverName !== "ai-drama-canvas") fail("marker-invalid", "capabilities.serverName 不是 ai-drama-canvas。");
  const buildId = stringField(capabilities.buildId, "capabilities.buildId", 32);
  if (!BUILD_ID_PATTERN.test(buildId)) fail("marker-invalid", "capabilities.buildId 必须是 32 位小写十六进制。");
  const capabilitySourceDigest = requiredSha256(capabilities.sourceDigest, "capabilities.sourceDigest");
  const buildIdentityFingerprint = requiredSha256(capabilities.buildIdentityFingerprint, "capabilities.buildIdentityFingerprint");
  if (!Number.isSafeInteger(capabilities.toolCount) || Number(capabilities.toolCount) < 1) {
    fail("marker-invalid", "capabilities.toolCount 必须是正整数。");
  }

  const active = record(root.activeContext, "activeContext");
  exactKeys(active, ["projectId", "manifestFingerprint", "contextFingerprint", "sourceDigest", "lockedAssets", "nextAction", "promptEntry"], "activeContext");
  if (!Array.isArray(active.lockedAssets) || active.lockedAssets.length > 6) {
    fail("marker-invalid", "activeContext.lockedAssets 必须是最多 6 项的数组。");
  }
  const lockedAssets = active.lockedAssets.map(parseLockedAsset);
  if (new Set(lockedAssets.map((asset) => asset.assetId)).size !== lockedAssets.length) {
    fail("marker-invalid", "activeContext.lockedAssets 包含重复 assetId。");
  }
  const next = record(active.nextAction, "activeContext.nextAction");
  exactKeys(next, ["code", "label", "reason", "requiresWrite", "command"], "activeContext.nextAction");
  if (next.command !== null && typeof next.command !== "string") fail("marker-invalid", "activeContext.nextAction.command 必须是 string|null。");
  if (active.promptEntry !== "managed_studio_lock_generate_writeback") {
    fail("prompt-entry-invalid", "activeContext.promptEntry 不是受管 Studio 入口。");
  }
  const safety = record(root.safety, "safety");
  exactKeys(safety, ["projectRootArgumentSupplied", "secretsReadOrPrinted"], "safety");
  booleanField(safety.projectRootArgumentSupplied, false, "safety.projectRootArgumentSupplied");
  booleanField(safety.secretsReadOrPrinted, false, "safety.secretsReadOrPrinted");

  return {
    schemaVersion: 1,
    marker: P14_FRESH_SESSION_MARKER,
    client,
    toolCalls: ["get_capabilities", "get_active_managed_studio_context"],
    capabilities: {
      serverName: "ai-drama-canvas",
      buildId,
      sourceDigest: capabilitySourceDigest,
      toolCount: Number(capabilities.toolCount),
      buildIdentityFingerprint,
    },
    activeContext: {
      projectId: stringField(active.projectId, "activeContext.projectId", 255),
      manifestFingerprint: requiredSha256(active.manifestFingerprint, "activeContext.manifestFingerprint"),
      contextFingerprint: requiredSha256(active.contextFingerprint, "activeContext.contextFingerprint"),
      sourceDigest: requiredSha256(active.sourceDigest, "activeContext.sourceDigest"),
      lockedAssets,
      nextAction: {
        code: stringField(next.code, "activeContext.nextAction.code", 255),
        label: stringField(next.label, "activeContext.nextAction.label", 1_000),
        reason: stringField(next.reason, "activeContext.nextAction.reason", 4_000),
        requiresWrite: booleanField(next.requiresWrite, Boolean(next.requiresWrite), "activeContext.nextAction.requiresWrite"),
        command: next.command === null ? null : stringField(next.command, "activeContext.nextAction.command", 255),
      },
      promptEntry: "managed_studio_lock_generate_writeback",
    },
    safety: { projectRootArgumentSupplied: false, secretsReadOrPrinted: false },
  };
}

function outputSchema(client: P14FreshSessionClient): Record<string, unknown> {
  const sha = { type: "string", pattern: "^[a-f0-9]{64}$" };
  return {
    type: "object",
    additionalProperties: false,
    required: ["schemaVersion", "marker", "client", "toolCalls", "capabilities", "activeContext", "safety"],
    properties: {
      schemaVersion: { const: 1 },
      marker: { const: P14_FRESH_SESSION_MARKER },
      client: { const: client },
      toolCalls: {
        type: "array",
        prefixItems: [{ const: "get_capabilities" }, { const: "get_active_managed_studio_context" }],
        minItems: 2,
        maxItems: 2,
      },
      capabilities: {
        type: "object",
        additionalProperties: false,
        required: ["serverName", "buildId", "sourceDigest", "toolCount", "buildIdentityFingerprint"],
        properties: {
          serverName: { const: "ai-drama-canvas" },
          buildId: { type: "string", pattern: "^[a-f0-9]{32}$" },
          sourceDigest: sha,
          toolCount: { type: "integer", minimum: 1 },
          buildIdentityFingerprint: sha,
        },
      },
      activeContext: {
        type: "object",
        additionalProperties: false,
        required: ["projectId", "manifestFingerprint", "contextFingerprint", "sourceDigest", "lockedAssets", "nextAction", "promptEntry"],
        properties: {
          projectId: { type: "string", minLength: 1, maxLength: 255 },
          manifestFingerprint: sha,
          contextFingerprint: sha,
          sourceDigest: sha,
          lockedAssets: {
            type: "array",
            maxItems: 6,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["assetId", "name", "category", "revision", "currentness"],
              properties: {
                assetId: { type: "string", minLength: 1, maxLength: 255 },
                name: { type: "string", minLength: 1, maxLength: 1_000 },
                category: { enum: ["character", "scene", "prop"] },
                revision: { type: "integer", minimum: 1 },
                currentness: { type: "string", minLength: 1, maxLength: 200 },
              },
            },
          },
          nextAction: {
            type: "object",
            additionalProperties: false,
            required: ["code", "label", "reason", "requiresWrite", "command"],
            properties: {
              code: { type: "string", minLength: 1, maxLength: 255 },
              label: { type: "string", minLength: 1, maxLength: 1_000 },
              reason: { type: "string", minLength: 1, maxLength: 4_000 },
              requiresWrite: { type: "boolean" },
              command: { type: ["string", "null"], maxLength: 255 },
            },
          },
          promptEntry: { const: "managed_studio_lock_generate_writeback" },
        },
      },
      safety: {
        type: "object",
        additionalProperties: false,
        required: ["projectRootArgumentSupplied", "secretsReadOrPrinted"],
        properties: {
          projectRootArgumentSupplied: { const: false },
          secretsReadOrPrinted: { const: false },
        },
      },
    },
  };
}

export function buildP14FreshSessionPrompt(client: P14FreshSessionClient): string {
  return [
    "P14 read-only fresh-session acceptance. Follow every rule exactly.",
    "Use only the configured MCP server named ai-drama-canvas. Do not use shell, filesystem, web, browser, memory, subagents, or any other tool.",
    "Call get_capabilities first with an empty object. Then call get_active_managed_studio_context with an empty object.",
    "Never pass, request, infer, or print projectRoot. Never inspect environment variables, configuration files, credentials, API keys, tokens, passwords, or secrets.",
    "Build the final object only from those two MCP responses. Do not use values from this prompt as project evidence.",
    "Copy capabilities.server.name, buildIdentity.buildId/sourceDigest/fingerprint and server.toolCount.",
    "Copy active projectId, manifestFingerprint, fingerprint as contextFingerprint, build.sourceDigest, lockedAssetSample as lockedAssets, nextAction, and agentExecution.prompt as promptEntry.",
    "Normalize a missing nextAction.command to null. Preserve lockedAssets order exactly.",
    `Set client to ${client}. Set toolCalls to the exact two names in actual call order.`,
    `Return only the JSON object constrained by marker ${P14_FRESH_SESSION_MARKER}. No Markdown and no explanation.`,
  ].join("\n");
}

export function inspectP14HeadlessSupport(
  client: P14FreshSessionClient,
  helpText: string,
): P14HeadlessSupportInspection {
  const required = client === "codex"
    ? ["Run Codex non-interactively", "--ephemeral", "--output-schema", "--output-last-message", "--json"]
    : ["--single", "streaming-json", "--output-format", "--session-id", "--no-memory", "--no-subagents"];
  const missing = required.filter((token) => !helpText.includes(token));
  return { client, supported: missing.length === 0, missing, helpSha256: digest(helpText) };
}

function safeChildEnvironment(): NodeJS.ProcessEnv {
  // 显式 allowlist：不展开 process.env，不读取或转发 *KEY/*TOKEN/*SECRET。
  const allowed = [
    "HOME", "PATH", "TMPDIR", "LANG", "LC_ALL", "USER", "LOGNAME", "SHELL",
    "CODEX_HOME", "GROK_HOME", "XDG_CONFIG_HOME", "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS",
  ] as const;
  const env: NodeJS.ProcessEnv = { CI: "1", NO_COLOR: "1", TERM: "dumb" };
  for (const key of allowed) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

export function buildP14FreshSessionInvocation(input: {
  client: P14FreshSessionClient;
  executable: string;
  workspaceRoot: string;
  timeoutMs: number;
  schemaPath: string;
  finalMessagePath: string;
  sessionId: string;
}): P14FreshSessionInvocation {
  const prompt = buildP14FreshSessionPrompt(input.client);
  if (input.client === "codex") {
    return {
      kind: "session",
      client: "codex",
      executable: input.executable,
      args: [
        "exec",
        "--ephemeral",
        "--sandbox", "read-only",
        "--skip-git-repo-check",
        "--color", "never",
        "--json",
        "--output-schema", input.schemaPath,
        "--output-last-message", input.finalMessagePath,
        "-C", input.workspaceRoot,
        prompt,
      ],
      cwd: input.workspaceRoot,
      env: safeChildEnvironment(),
      timeoutMs: input.timeoutMs,
      finalMessagePath: input.finalMessagePath,
    };
  }
  return {
    kind: "session",
    client: "grok",
    executable: input.executable,
    args: [
      "--single", prompt,
      "--verbatim",
      "--cwd", input.workspaceRoot,
      "--session-id", input.sessionId,
      "--no-memory",
      "--no-subagents",
      "--disable-web-search",
      "--no-plan",
      "--permission-mode", "dontAsk",
      "--output-format", "streaming-json",
    ],
    cwd: input.workspaceRoot,
    env: safeChildEnvironment(),
    timeoutMs: input.timeoutMs,
  };
}

function helpInvocation(
  client: P14FreshSessionClient,
  executable: string,
  workspaceRoot: string,
  timeoutMs: number,
): P14FreshSessionInvocation {
  return {
    kind: "help",
    client,
    executable,
    args: client === "codex" ? ["exec", "--help"] : ["--help"],
    cwd: workspaceRoot,
    env: safeChildEnvironment(),
    timeoutMs: Math.min(timeoutMs, 15_000),
  };
}

/** 默认 runner 唯一进程执行面：execFile + shell=false。 */
export function createP14ExecFileFreshSessionRunner(): P14FreshSessionCommandRunner {
  return (invocation) => new Promise((resolve, reject) => {
    execFile(invocation.executable, invocation.args, {
      cwd: invocation.cwd,
      env: invocation.env,
      encoding: "utf8",
      timeout: invocation.timeoutMs,
      maxBuffer: MAX_OUTPUT_BYTES,
      windowsHide: true,
      shell: false,
    }, async (error, stdout, stderr) => {
      if (error) {
        reject(new P14FreshSessionVerificationError(
          invocation.kind === "help" ? "headless-help-failed" : "agent-session-failed",
          `${invocation.client} ${invocation.kind} 进程未以成功状态退出。`,
        ));
        return;
      }
      try {
        const finalMessage = invocation.finalMessagePath
          ? await readFile(invocation.finalMessagePath, "utf8")
          : undefined;
        resolve({ stdout, stderr, ...(finalMessage !== undefined ? { finalMessage } : {}) });
      } catch {
        reject(new P14FreshSessionVerificationError("marker-missing", `${invocation.client} 未写入最终结构化消息。`));
      }
    });
  });
}

async function canonicalExecutable(value: string, field: string): Promise<string> {
  const requested = requiredText(value, field, 4_000);
  if (!path.isAbsolute(requested)) fail("invalid-input", `${field} 必须是绝对路径。`);
  const canonical = await realpath(requested).catch(() => fail("executable-unavailable", `${field} 不可用。`));
  const metadata = await stat(canonical).catch(() => fail("executable-unavailable", `${field} 不可用。`));
  if (!metadata.isFile()) fail("executable-unavailable", `${field} 不是普通文件。`);
  await access(canonical, fsConstants.X_OK).catch(() => fail("executable-unavailable", `${field} 不可执行。`));
  return canonical;
}

function comparisonEvidence(
  expected: P14DualAgentExpectedIdentity,
  codex: P14FreshSessionResult,
  grok: P14FreshSessionResult,
): NonNullable<P14DualAgentFreshSessionEvidence["comparisons"]> {
  for (const [client, result] of [["codex", codex], ["grok", grok]] as const) {
    if (result.activeContext.projectId !== expected.projectId
      || result.activeContext.manifestFingerprint !== expected.manifestFingerprint
      || result.capabilities.sourceDigest !== expected.sourceDigest
      || result.activeContext.sourceDigest !== expected.sourceDigest) {
      fail("expected-identity-mismatch", `${client} 未读到预期活动工程或构建摘要。`);
    }
  }
  if (stableJson(codex.capabilities) !== stableJson(grok.capabilities)) {
    fail("dual-agent-build-mismatch", "Codex 与 Grok 读到的构建身份不一致。");
  }
  if (codex.activeContext.contextFingerprint !== grok.activeContext.contextFingerprint) {
    fail("dual-agent-context-mismatch", "Codex 与 Grok 读到的活动上下文指纹不一致。");
  }
  if (stableJson(codex.activeContext.lockedAssets) !== stableJson(grok.activeContext.lockedAssets)) {
    fail("dual-agent-assets-mismatch", "Codex 与 Grok 读到的锁定资产摘要不一致。");
  }
  if (stableJson(codex.activeContext.nextAction) !== stableJson(grok.activeContext.nextAction)) {
    fail("dual-agent-next-action-mismatch", "Codex 与 Grok 读到的唯一下一动作不一致。");
  }
  if (codex.activeContext.promptEntry !== grok.activeContext.promptEntry) {
    fail("dual-agent-prompt-mismatch", "Codex 与 Grok 读到的受管提示词入口不一致。");
  }
  return {
    expectedIdentity: true,
    sameBuildIdentity: true,
    sameContextFingerprint: true,
    sameLockedAssets: true,
    sameNextAction: true,
    samePromptEntry: true,
    exactToolSequence: true,
  };
}

async function writeEvidence(pathValue: string, evidence: P14DualAgentFreshSessionEvidence): Promise<void> {
  const created = await writeJsonAtomicExclusive(pathValue, evidence);
  if (created !== "created") fail("evidence-conflict", "evidence path 已存在，拒绝覆盖。");
}

export async function runP14DualAgentFreshSessionReadSmoke(
  input: P14DualAgentFreshSessionInput,
  runner: P14FreshSessionCommandRunner = createP14ExecFileFreshSessionRunner(),
): Promise<P14DualAgentFreshSessionEvidence> {
  const startedAt = new Date().toISOString();
  const expected: P14DualAgentExpectedIdentity = {
    projectId: requiredText(input.projectId, "projectId", 255),
    manifestFingerprint: requiredSha256(input.manifestFingerprint, "manifestFingerprint"),
    sourceDigest: requiredSha256(input.sourceDigest, "sourceDigest"),
  };
  const evidencePath = path.resolve(requiredText(input.evidencePath, "evidencePath", 4_000));
  if (await access(evidencePath).then(() => true).catch(() => false)) fail("evidence-conflict", "evidence path 已存在，拒绝覆盖。");
  await mkdir(path.dirname(evidencePath), { recursive: true });
  const workspaceRoot = await realpath(path.resolve(input.workspaceRoot ?? WORKSPACE_ROOT))
    .catch(() => fail("invalid-input", "workspaceRoot 不可读。"));
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10_000 || timeoutMs > 600_000) {
    fail("invalid-input", "timeoutMs 必须在 10000..600000。");
  }
  const [codexExecutable, grokExecutable] = await Promise.all([
    canonicalExecutable(input.codexExecutable, "codexExecutable"),
    canonicalExecutable(input.grokExecutable, "grokExecutable"),
  ]);
  const clientEvidence: P14DualAgentFreshSessionEvidence["clients"] = {
    codex: { executable: path.basename(codexExecutable), sessionStarted: false },
    grok: { executable: path.basename(grokExecutable), sessionStarted: false },
  };
  const boundaries: P14DualAgentFreshSessionEvidence["boundaries"] = {
    execFileWithoutShell: true,
    freshSessions: true,
    projectRootAcceptedByScript: false,
    projectRootArgumentSupplied: false,
    agentConfigurationModified: false,
    secretEnvironmentVariablesForwarded: false,
    secretsReadOrPrinted: false,
  };
  let tempRoot: string | undefined;
  try {
    const [codexHelpResult, grokHelpResult] = await Promise.all([
      runner(helpInvocation("codex", codexExecutable, workspaceRoot, timeoutMs)),
      runner(helpInvocation("grok", grokExecutable, workspaceRoot, timeoutMs)),
    ]);
    const codexHelp = inspectP14HeadlessSupport("codex", `${codexHelpResult.stdout}\n${codexHelpResult.stderr}`);
    const grokHelp = inspectP14HeadlessSupport("grok", `${grokHelpResult.stdout}\n${grokHelpResult.stderr}`);
    clientEvidence.codex.help = codexHelp;
    clientEvidence.grok.help = grokHelp;
    if (!codexHelp.supported || !grokHelp.supported) {
      const unsupported = [codexHelp, grokHelp].filter((entry) => !entry.supported)
        .map((entry) => `${entry.client}:${entry.missing.join(",")}`).join(";");
      fail("headless-contract-unsupported", `Agent CLI 缺少可靠 headless 合同：${unsupported}`);
    }

    tempRoot = await mkdtemp(path.join(os.tmpdir(), "p14-dual-agent-fresh-session-"));
    const codexSchemaPath = path.join(tempRoot, "codex-output-schema.json");
    const codexFinalPath = path.join(tempRoot, "codex-final.json");
    await writeFile(codexSchemaPath, `${JSON.stringify(outputSchema("codex"), null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(codexSchemaPath, 0o600);
    const codexInvocation = buildP14FreshSessionInvocation({
      client: "codex",
      executable: codexExecutable,
      workspaceRoot,
      timeoutMs,
      schemaPath: codexSchemaPath,
      finalMessagePath: codexFinalPath,
      sessionId: randomUUID(),
    });
    const grokInvocation = buildP14FreshSessionInvocation({
      client: "grok",
      executable: grokExecutable,
      workspaceRoot,
      timeoutMs,
      schemaPath: codexSchemaPath,
      finalMessagePath: path.join(tempRoot, "grok-unused.json"),
      sessionId: randomUUID(),
    });
    clientEvidence.codex.sessionStarted = true;
    clientEvidence.grok.sessionStarted = true;
    const [codexRun, grokRun] = await Promise.all([runner(codexInvocation), runner(grokInvocation)]);
    const codexNativeTrace = inspectP14NativeToolTrace("codex", codexRun.stdout);
    const grokNativeTrace = inspectP14NativeToolTrace("grok", grokRun.stdout);
    clientEvidence.codex.nativeTrace = codexNativeTrace;
    clientEvidence.grok.nativeTrace = grokNativeTrace;
    requireExactNativeToolTrace(codexNativeTrace);
    requireExactNativeToolTrace(grokNativeTrace);
    const codex = parseP14FreshSessionResult("codex", codexRun.finalMessage ?? codexRun.stdout);
    const grok = parseP14FreshSessionResult("grok", grokRun.finalMessage ?? grokRun.stdout);
    const comparisons = comparisonEvidence(expected, codex, grok);
    const semantic = {
      schemaVersion: 1 as const,
      kind: "p14-dual-agent-fresh-session-read-evidence" as const,
      status: "PASS" as const,
      startedAt,
      completedAt: new Date().toISOString(),
      expected,
      clients: clientEvidence,
      results: { codex, grok },
      comparisons,
      boundaries,
    };
    const evidence = sealed(semantic as unknown as Record<string, unknown>) as unknown as P14DualAgentFreshSessionEvidence;
    await writeEvidence(evidencePath, evidence);
    return evidence;
  } catch (error) {
    const failure = error instanceof P14FreshSessionVerificationError
      ? error
      : new P14FreshSessionVerificationError("verification-failed", error instanceof Error ? error.message : "未知验收错误。");
    const semantic = {
      schemaVersion: 1 as const,
      kind: "p14-dual-agent-fresh-session-read-evidence" as const,
      status: "FAIL" as const,
      startedAt,
      completedAt: new Date().toISOString(),
      expected,
      clients: clientEvidence,
      boundaries,
      failure: { code: failure.code, message: failure.message },
    };
    const evidence = sealed(semantic as unknown as Record<string, unknown>) as unknown as P14DualAgentFreshSessionEvidence;
    await writeEvidence(evidencePath, evidence).catch(() => undefined);
    throw failure;
  } finally {
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  }
}

async function main(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: {
      "codex-executable": { type: "string" },
      "grok-executable": { type: "string" },
      "project-id": { type: "string" },
      "manifest-fingerprint": { type: "string" },
      "source-digest": { type: "string" },
      evidence: { type: "string" },
      workspace: { type: "string" },
      "timeout-ms": { type: "string" },
    },
  });
  const timeout = values["timeout-ms"] === undefined ? undefined : Number(values["timeout-ms"]);
  const evidence = await runP14DualAgentFreshSessionReadSmoke({
    codexExecutable: requiredText(values["codex-executable"], "--codex-executable"),
    grokExecutable: requiredText(values["grok-executable"], "--grok-executable"),
    projectId: requiredText(values["project-id"], "--project-id"),
    manifestFingerprint: requiredText(values["manifest-fingerprint"], "--manifest-fingerprint"),
    sourceDigest: requiredText(values["source-digest"], "--source-digest"),
    evidencePath: requiredText(values.evidence, "--evidence"),
    workspaceRoot: values.workspace,
    timeoutMs: timeout,
  });
  process.stdout.write(`${JSON.stringify({
    status: evidence.status,
    evidencePath: path.resolve(requiredText(values.evidence, "--evidence")),
    projectId: evidence.expected.projectId,
    sourceDigest: evidence.expected.sourceDigest,
    clients: ["codex", "grok"],
    projectRootArgumentSupplied: false,
    secretsReadOrPrinted: false,
  }, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  main(process.argv.slice(2)).catch((error) => {
    const code = error instanceof P14FreshSessionVerificationError ? error.code : "verification-failed";
    process.stderr.write(`P14 dual-agent fresh-session failed: ${code}\n`);
    process.exitCode = 1;
  });
}
