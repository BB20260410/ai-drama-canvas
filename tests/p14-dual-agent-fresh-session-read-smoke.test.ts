import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  P14_FRESH_SESSION_MARKER,
  P14FreshSessionVerificationError,
  buildP14FreshSessionInvocation,
  inspectP14HeadlessSupport,
  inspectP14NativeToolTrace,
  parseP14FreshSessionResult,
  runP14DualAgentFreshSessionReadSmoke,
  type P14FreshSessionClient,
  type P14FreshSessionCommandRunner,
  type P14FreshSessionInvocation,
  type P14FreshSessionResult,
} from "../scripts/p14-dual-agent-fresh-session-read-smoke.js";

const roots: string[] = [];
const PROJECT_ID = "p14-dual-agent-project";
const MANIFEST = "a".repeat(64);
const SOURCE_DIGEST = "b".repeat(64);
const CONTEXT_FINGERPRINT = "c".repeat(64);
const BUILD_FINGERPRINT = "d".repeat(64);
const BUILD_ID = "e".repeat(32);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function result(client: P14FreshSessionClient, override: Partial<P14FreshSessionResult> = {}): P14FreshSessionResult {
  const base: P14FreshSessionResult = {
    schemaVersion: 1,
    marker: P14_FRESH_SESSION_MARKER,
    client,
    toolCalls: ["get_capabilities", "get_active_managed_studio_context"],
    capabilities: {
      serverName: "ai-drama-canvas",
      buildId: BUILD_ID,
      sourceDigest: SOURCE_DIGEST,
      toolCount: 183,
      buildIdentityFingerprint: BUILD_FINGERPRINT,
    },
    activeContext: {
      projectId: PROJECT_ID,
      manifestFingerprint: MANIFEST,
      contextFingerprint: CONTEXT_FINGERPRINT,
      sourceDigest: SOURCE_DIGEST,
      lockedAssets: [{
        assetId: "character-ahang",
        name: "阿航",
        category: "character",
        revision: 4,
        currentness: "current",
      }],
      nextAction: {
        code: "review-generation",
        label: "继续审片",
        reason: "存在待审 raw/labeled 结果对。",
        requiresWrite: false,
        command: null,
      },
      promptEntry: "managed_studio_lock_generate_writeback",
    },
    safety: { projectRootArgumentSupplied: false, secretsReadOrPrinted: false },
  };
  return { ...base, ...override };
}

async function fixture(): Promise<{ root: string; codex: string; grok: string; evidence: string }> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "p14-dual-agent-read-test-")));
  roots.push(root);
  const codex = path.join(root, "codex-fixture");
  const grok = path.join(root, "grok-fixture");
  await Promise.all([
    writeFile(codex, "injected-runner-fixture-not-executed\n", { mode: 0o700 }),
    writeFile(grok, "injected-runner-fixture-not-executed\n", { mode: 0o700 }),
  ]);
  await Promise.all([chmod(codex, 0o700), chmod(grok, 0o700)]);
  return { root, codex, grok, evidence: path.join(root, "evidence.json") };
}

const CODEX_HELP = "Run Codex non-interactively --ephemeral --output-schema --output-last-message --json";
const GROK_HELP = "--single --output-format plain|json|streaming-json --session-id --no-memory --no-subagents";

function nativeTrace(client: P14FreshSessionClient): string {
  if (client === "codex") {
    return [
      { type: "item.completed", item: { id: "call-1", type: "mcp_tool_call", server: "ai-drama-canvas", tool: "get_capabilities", arguments: {}, status: "completed" } },
      { type: "item.completed", item: { id: "call-2", type: "mcp_tool_call", server: "ai-drama-canvas", tool: "get_active_managed_studio_context", arguments: {}, status: "completed" } },
    ].map((entry) => JSON.stringify(entry)).join("\n");
  }
  return [
    { type: "tool_call", id: "call-1", name: "mcp__ai-drama-canvas__get_capabilities", input: {} },
    { type: "tool_result", tool_call_id: "call-1", content: "redacted" },
    { type: "tool_call", id: "call-2", name: "mcp__ai-drama-canvas__get_active_managed_studio_context", input: {} },
    { type: "tool_result", tool_call_id: "call-2", content: "redacted" },
  ].map((entry) => JSON.stringify(entry)).join("\n");
}

function successfulRunner(
  calls: P14FreshSessionInvocation[],
  overrides: Partial<Record<P14FreshSessionClient, P14FreshSessionResult>> = {},
): P14FreshSessionCommandRunner {
  return async (invocation) => {
    calls.push(invocation);
    if (invocation.kind === "help") {
      return { stdout: invocation.client === "codex" ? CODEX_HELP : GROK_HELP, stderr: "" };
    }
    const marker = overrides[invocation.client] ?? result(invocation.client);
    return invocation.client === "codex"
      ? { stdout: nativeTrace("codex"), stderr: "", finalMessage: JSON.stringify(marker) }
      : { stdout: `${nativeTrace("grok")}\n${JSON.stringify({ type: "result", content: JSON.stringify(marker) })}`, stderr: "" };
  };
}

describe("P14 双 Agent 全新会话读取 smoke", () => {
  it("解析唯一稳定 marker，拒绝额外 projectRoot 字段和错序工具声明", () => {
    const codex = result("codex");
    expect(parseP14FreshSessionResult("codex", JSON.stringify(codex))).toEqual(codex);
    expect(parseP14FreshSessionResult("codex", JSON.stringify({ wrapper: { result: JSON.stringify(codex) } }))).toEqual(codex);

    const withProjectRoot = { ...codex, projectRoot: "/forbidden" };
    expect(() => parseP14FreshSessionResult("codex", JSON.stringify(withProjectRoot)))
      .toThrow("schema");
    expect(() => parseP14FreshSessionResult("codex", JSON.stringify({
      ...codex,
      toolCalls: ["get_active_managed_studio_context", "get_capabilities"],
    }))).toThrow("固定顺序");
  });

  it("根据 help 冻结可靠 headless 合同，调用参数不包含 resume/project identity/密钥环境", async () => {
    expect(inspectP14HeadlessSupport("codex", CODEX_HELP)).toMatchObject({ supported: true, missing: [] });
    expect(inspectP14HeadlessSupport("grok", GROK_HELP)).toMatchObject({ supported: true, missing: [] });
    expect(inspectP14HeadlessSupport("codex", "Run Codex non-interactively")).toMatchObject({ supported: false });

    const invocation = buildP14FreshSessionInvocation({
      client: "grok",
      executable: "/tmp/grok",
      workspaceRoot: "/tmp/workspace",
      timeoutMs: 30_000,
      schemaPath: "/tmp/schema.json",
      finalMessagePath: "/tmp/final.json",
      sessionId: "00000000-0000-4000-8000-000000000001",
    });
    expect(invocation.args).toContain("--single");
    expect(invocation.args).toContain("--session-id");
    expect(invocation.args).toContain("--no-memory");
    expect(invocation.args).toContain("streaming-json");
    expect(invocation.args).not.toContain("--resume");
    expect(invocation.args).not.toContain("--continue");
    expect(JSON.stringify(invocation.args)).not.toContain(PROJECT_ID);
    expect(JSON.stringify(invocation.args)).not.toContain(MANIFEST);
    expect(Object.keys(invocation.env).some((key) => /(api.?key|token|secret|password)/iu.test(key))).toBe(false);
  });

  it("只认 CLI 原生工具事件；marker 不能挽救缺失、额外工具或非空参数", () => {
    expect(inspectP14NativeToolTrace("codex", nativeTrace("codex"))).toMatchObject({
      verifiable: true,
      exactToolSequence: true,
      toolCalls: [{ toolName: "get_capabilities" }, { toolName: "get_active_managed_studio_context" }],
    });
    expect(inspectP14NativeToolTrace("grok", nativeTrace("grok"))).toMatchObject({ verifiable: true, exactToolSequence: true });
    expect(inspectP14NativeToolTrace("codex", JSON.stringify(result("codex")))).toMatchObject({
      verifiable: false,
      exactToolSequence: false,
      reason: "native-tool-events-missing",
    });
    const extra = `${nativeTrace("codex")}\n${JSON.stringify({ type: "item.completed", item: { id: "call-3", type: "command_execution", command: "pwd", status: "completed" } })}`;
    expect(inspectP14NativeToolTrace("codex", extra)).toMatchObject({ exactToolSequence: false, reason: "unsupported-native-tool-event" });
    const nonempty = nativeTrace("codex").replace('"arguments":{}', '"arguments":{"projectRoot":"/forbidden"}');
    expect(inspectP14NativeToolTrace("codex", nonempty)).toMatchObject({ exactToolSequence: false, reason: "nonempty-tool-arguments" });
  });

  it("两个注入的全新会话精确读到同一工程、锁定资产、下一动作与提示词入口", async () => {
    const files = await fixture();
    const calls: P14FreshSessionInvocation[] = [];
    const evidence = await runP14DualAgentFreshSessionReadSmoke({
      codexExecutable: files.codex,
      grokExecutable: files.grok,
      projectId: PROJECT_ID,
      manifestFingerprint: MANIFEST,
      sourceDigest: SOURCE_DIGEST,
      evidencePath: files.evidence,
      workspaceRoot: files.root,
      timeoutMs: 30_000,
    }, successfulRunner(calls));

    expect(evidence).toMatchObject({
      status: "PASS",
      expected: { projectId: PROJECT_ID, manifestFingerprint: MANIFEST, sourceDigest: SOURCE_DIGEST },
      comparisons: {
        expectedIdentity: true,
        sameBuildIdentity: true,
        sameContextFingerprint: true,
        sameLockedAssets: true,
        sameNextAction: true,
        samePromptEntry: true,
        exactToolSequence: true,
      },
      boundaries: {
        execFileWithoutShell: true,
        freshSessions: true,
        projectRootAcceptedByScript: false,
        projectRootArgumentSupplied: false,
        agentConfigurationModified: false,
        secretEnvironmentVariablesForwarded: false,
        secretsReadOrPrinted: false,
      },
    });
    expect(calls.filter((call) => call.kind === "help")).toHaveLength(2);
    expect(calls.filter((call) => call.kind === "session")).toHaveLength(2);
    expect(calls.filter((call) => call.kind === "session").every((call) => !JSON.stringify(call.args).includes(PROJECT_ID))).toBe(true);
    const landed = JSON.parse(await readFile(files.evidence, "utf8"));
    expect(landed.fingerprint).toBe(evidence.fingerprint);
    expect(JSON.stringify(landed)).not.toMatch(/api.?key|password|projectContextToken/iu);
  });

  it("双端锁定资产不一致时失败关闭并只落 FAIL 摘要", async () => {
    const files = await fixture();
    const calls: P14FreshSessionInvocation[] = [];
    const grok = result("grok");
    grok.activeContext.lockedAssets = [{ ...grok.activeContext.lockedAssets[0]!, name: "另一个阿航" }];
    await expect(runP14DualAgentFreshSessionReadSmoke({
      codexExecutable: files.codex,
      grokExecutable: files.grok,
      projectId: PROJECT_ID,
      manifestFingerprint: MANIFEST,
      sourceDigest: SOURCE_DIGEST,
      evidencePath: files.evidence,
      workspaceRoot: files.root,
      timeoutMs: 30_000,
    }, successfulRunner(calls, { grok }))).rejects.toMatchObject({
      name: "P14FreshSessionVerificationError",
      code: "dual-agent-assets-mismatch",
    });
    const failure = JSON.parse(await readFile(files.evidence, "utf8"));
    expect(failure).toMatchObject({ status: "FAIL", failure: { code: "dual-agent-assets-mismatch" } });
    expect(failure).not.toHaveProperty("results");
  });

  it("CLI help 缺少可靠 headless 能力时不启动任何 Agent 会话", async () => {
    const files = await fixture();
    const calls: P14FreshSessionInvocation[] = [];
    const runner: P14FreshSessionCommandRunner = async (invocation) => {
      calls.push(invocation);
      return { stdout: invocation.client === "codex" ? "Run Codex non-interactively" : GROK_HELP, stderr: "" };
    };
    await expect(runP14DualAgentFreshSessionReadSmoke({
      codexExecutable: files.codex,
      grokExecutable: files.grok,
      projectId: PROJECT_ID,
      manifestFingerprint: MANIFEST,
      sourceDigest: SOURCE_DIGEST,
      evidencePath: files.evidence,
      workspaceRoot: files.root,
      timeoutMs: 30_000,
    }, runner)).rejects.toBeInstanceOf(P14FreshSessionVerificationError);
    expect(calls.every((call) => call.kind === "help")).toBe(true);
    const failure = JSON.parse(await readFile(files.evidence, "utf8"));
    expect(failure).toMatchObject({ status: "FAIL", failure: { code: "headless-contract-unsupported" } });
  });

  it("最终 marker 即使声明正确，原生 trace 缺失仍失败关闭", async () => {
    const files = await fixture();
    const runner: P14FreshSessionCommandRunner = async (invocation) => {
      if (invocation.kind === "help") return { stdout: invocation.client === "codex" ? CODEX_HELP : GROK_HELP, stderr: "" };
      const marker = JSON.stringify(result(invocation.client));
      return invocation.client === "codex"
        ? { stdout: "", stderr: "", finalMessage: marker }
        : { stdout: JSON.stringify({ type: "result", content: marker }), stderr: "" };
    };
    await expect(runP14DualAgentFreshSessionReadSmoke({
      codexExecutable: files.codex,
      grokExecutable: files.grok,
      projectId: PROJECT_ID,
      manifestFingerprint: MANIFEST,
      sourceDigest: SOURCE_DIGEST,
      evidencePath: files.evidence,
      workspaceRoot: files.root,
      timeoutMs: 30_000,
    }, runner)).rejects.toMatchObject({ code: "native-trace-unverifiable" });
    expect(JSON.parse(await readFile(files.evidence, "utf8"))).toMatchObject({
      status: "FAIL",
      clients: { codex: { nativeTrace: { verifiable: false } }, grok: { nativeTrace: { verifiable: false } } },
      failure: { code: "native-trace-unverifiable" },
    });
  });
});
