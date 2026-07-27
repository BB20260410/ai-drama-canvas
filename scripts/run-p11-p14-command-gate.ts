/** P11–P14 固定命令门禁：固定 argv、源码漂移关断、独占日志与 PASS/FAIL 证据。 */
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { computeSourceDigest, createBuildIdentity } from "../src/core/build-identity.js";

export const P11_P14_COMMAND_GATE_MODES = ["typecheck", "targeted", "full", "production-build"] as const;
export type P11P14CommandGateMode = typeof P11_P14_COMMAND_GATE_MODES[number];

export const P11_P14_TARGETED_TESTS = [
  "tests/build-identity.test.ts",
  "tests/active-managed-studio-context.test.ts",
  "tests/mcp-build-currentness-gate.test.ts",
  "tests/studio-agent-imagegen-result-bundle.test.ts",
  "tests/agent-connection-config.test.ts",
  "tests/p13-desktop-production-loop-ui.test.ts",
  "tests/studio-continuity-review-ui.test.ts",
  "tests/studio-continuity-review-desktop-integration.test.ts",
  "tests/studio-continuity-command-bus.test.ts",
  "tests/p13-p14-installed-ui-smoke-guards.test.ts",
  "tests/p14-dual-agent-fresh-session-read-smoke.test.ts",
  "tests/p14-real-canary-orchestrator.test.ts",
  "tests/p14-installed-real-canary-ui-guards.test.ts",
  "tests/p14-installed-runtime-identity-guards.test.ts",
  "tests/p14-installed-agent-repair-ui-smoke-guards.test.ts",
  "tests/validate-p11-p14-desktop-loop-final.test.ts",
  "tests/p11-p14-command-gate.test.ts",
] as const;

export interface FixedGateCommand {
  command: "npm" | "npx";
  args: string[];
  expectsTestCounts: boolean;
}

export interface ParsedVitestCounts {
  applicable: true;
  files: { total: number; passed: number; failed: number };
  tests: { total: number; passed: number; failed: number };
}

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function parseP11P14CommandGateMode(argv: readonly string[]): P11P14CommandGateMode {
  if (argv.length !== 1 || !P11_P14_COMMAND_GATE_MODES.includes(argv[0] as P11P14CommandGateMode)) {
    throw new Error("用法：tsx scripts/run-p11-p14-command-gate.ts <typecheck|targeted|full|production-build>");
  }
  return argv[0] as P11P14CommandGateMode;
}

export function fixedP11P14GateCommand(mode: P11P14CommandGateMode): FixedGateCommand {
  switch (mode) {
    case "typecheck": return { command: "npm", args: ["run", "typecheck"], expectsTestCounts: false };
    case "targeted": return { command: "npx", args: ["--no-install", "vitest", "run", ...P11_P14_TARGETED_TESTS], expectsTestCounts: true };
    case "full": return { command: "npm", args: ["test", "--", "--maxWorkers=1"], expectsTestCounts: true };
    case "production-build": return { command: "npm", args: ["run", "build"], expectsTestCounts: false };
  }
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "");
}

function summaryLineCounts(line: string): { total: number; passed: number; failed: number } | null {
  const total = Number(line.match(/\((\d+)\)/u)?.[1]);
  if (!Number.isSafeInteger(total) || total < 0) return null;
  const passed = Number(line.match(/(?:^|\s)(\d+)\s+passed\b/u)?.[1] ?? 0);
  const failed = Number(line.match(/(?:^|\s)(\d+)\s+failed\b/u)?.[1] ?? 0);
  return { total, passed, failed };
}

export function parseVitestCounts(log: string): ParsedVitestCounts | null {
  const lines = stripAnsi(log).split(/\r?\n/u).map((line) => line.trim());
  const files = summaryLineCounts(lines.find((line) => line.startsWith("Test Files")) ?? "");
  const tests = summaryLineCounts(lines.find((line) => line.startsWith("Tests")) ?? "");
  return files && tests ? { applicable: true, files, tests } : null;
}

export function evaluateP11P14Gate(input: {
  exitCode: number;
  sourceBefore: string;
  sourceAfter: string;
  expectsTestCounts: boolean;
  testCounts: ParsedVitestCounts | null;
  spawnError?: string;
}): { status: "PASS" | "FAIL"; sourceStable: boolean; failureReasons: string[] } {
  const sourceStable = input.sourceBefore === input.sourceAfter;
  const failureReasons: string[] = [];
  if (input.spawnError) failureReasons.push("spawn-error");
  if (input.exitCode !== 0) failureReasons.push(`exit-code-${input.exitCode}`);
  if (!sourceStable) failureReasons.push("source-digest-drift");
  if (input.expectsTestCounts && !input.testCounts) failureReasons.push("test-counts-missing");
  if (input.testCounts && (input.testCounts.files.failed !== 0 || input.testCounts.tests.failed !== 0
    || input.testCounts.files.passed !== input.testCounts.files.total
    || input.testCounts.tests.passed !== input.testCounts.tests.total)) failureReasons.push("tests-not-all-passed");
  return { status: failureReasons.length ? "FAIL" : "PASS", sourceStable, failureReasons };
}

function safeChildEnvironment(): NodeJS.ProcessEnv {
  const allowed = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TERM", "CI", "NO_COLOR", "FORCE_COLOR"] as const;
  return Object.fromEntries(allowed.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]])) as NodeJS.ProcessEnv;
}

async function runCommand(command: FixedGateCommand): Promise<{ exitCode: number; log: Buffer; spawnError?: string }> {
  const chunks: Buffer[] = [];
  let spawnError: string | undefined;
  const child = spawn(command.command, command.args, {
    cwd: workspace,
    env: safeChildEnvironment(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  const exitCode = await new Promise<number>((resolve) => {
    child.on("error", (error) => {
      spawnError = error.message;
      chunks.push(Buffer.from(`\n[command-gate spawn error] ${error.message}\n`, "utf8"));
      resolve(127);
    });
    child.on("close", (code) => resolve(code ?? 1));
  });
  return { exitCode, log: Buffer.concat(chunks), ...(spawnError ? { spawnError } : {}) };
}

async function main(argv: string[]): Promise<void> {
  const mode = parseP11P14CommandGateMode(argv);
  const command = fixedP11P14GateCommand(mode);
  const evidenceParent = path.join(workspace, "docs", "evidence", "runs");
  await mkdir(evidenceParent, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const runDirectory = path.join(evidenceParent, `${stamp}-${mode}-${randomUUID().slice(0, 8)}`);
  await mkdir(runDirectory, { recursive: false });
  const logPath = path.join(runDirectory, "command.log");
  const evidencePath = path.join(runDirectory, "evidence.json");
  const startedAt = new Date().toISOString();
  const started = performance.now();
  let exitCode = 1;
  let commandLog: Buffer = Buffer.alloc(0);
  let spawnError: string | undefined;
  let sourceBefore: Awaited<ReturnType<typeof computeSourceDigest>> | undefined;
  let sourceAfter: Awaited<ReturnType<typeof computeSourceDigest>> | undefined;
  let buildBefore: Awaited<ReturnType<typeof createBuildIdentity>> | undefined;
  let buildAfter: Awaited<ReturnType<typeof createBuildIdentity>> | undefined;
  let unexpectedError: string | undefined;
  try {
    sourceBefore = await computeSourceDigest(workspace);
    buildBefore = await createBuildIdentity(workspace);
    if (sourceBefore.sourceDigest !== buildBefore.sourceDigest) throw new Error("命令前 sourceDigest 与 build identity 不一致。");
    const result = await runCommand(command);
    exitCode = result.exitCode;
    commandLog = result.log;
    spawnError = result.spawnError;
  } catch (error) {
    unexpectedError = error instanceof Error ? error.message : String(error);
    commandLog = Buffer.from(`[command-gate failure] ${unexpectedError}\n`, "utf8");
  }
  try {
    sourceAfter = await computeSourceDigest(workspace);
    buildAfter = await createBuildIdentity(workspace);
    if (sourceAfter.sourceDigest !== buildAfter.sourceDigest) throw new Error("命令后 sourceDigest 与 build identity 不一致。");
  } catch (error) {
    unexpectedError = [unexpectedError, error instanceof Error ? error.message : String(error)].filter(Boolean).join("；");
  }
  await writeFile(logPath, commandLog, { flag: "wx", mode: 0o600 });
  const testCounts = command.expectsTestCounts ? parseVitestCounts(commandLog.toString("utf8")) : null;
  const evaluated = evaluateP11P14Gate({
    exitCode,
    sourceBefore: sourceBefore?.sourceDigest ?? "missing-before",
    sourceAfter: sourceAfter?.sourceDigest ?? "missing-after",
    expectsTestCounts: command.expectsTestCounts,
    testCounts,
    ...(spawnError || unexpectedError ? { spawnError: [spawnError, unexpectedError].filter(Boolean).join("；") } : {}),
  });
  const endedAt = new Date().toISOString();
  const evidence = {
    schemaVersion: 1,
    kind: "p11-p14-command-gate-record",
    status: evaluated.status,
    mode,
    startedAt,
    endedAt,
    durationMs: Math.round(performance.now() - started),
    argv: [command.command, ...command.args],
    cwd: workspace,
    exitCode,
    sourceStable: evaluated.sourceStable,
    failureReasons: evaluated.failureReasons,
    sourceDigest: {
      before: sourceBefore?.sourceDigest ?? null,
      after: sourceAfter?.sourceDigest ?? null,
      beforeFiles: sourceBefore?.sourceFiles ?? null,
      afterFiles: sourceAfter?.sourceFiles ?? null,
    },
    buildIdentity: {
      before: buildBefore ? { buildId: buildBefore.buildId, sourceDigest: buildBefore.sourceDigest, fingerprint: buildBefore.fingerprint } : null,
      after: buildAfter ? { buildId: buildAfter.buildId, sourceDigest: buildAfter.sourceDigest, fingerprint: buildAfter.fingerprint } : null,
    },
    testCounts: testCounts ?? { applicable: false, files: null, tests: null },
    log: {
      relativePath: path.relative(workspace, logPath).split(path.sep).join("/"),
      sizeBytes: commandLog.byteLength,
      sha256: createHash("sha256").update(commandLog).digest("hex"),
    },
    security: { environmentRecorded: false, childEnvironmentAllowlisted: true },
  };
  await access(evidencePath).then(
    () => { throw new Error(`证据已存在，拒绝覆盖：${evidencePath}`); },
    () => undefined,
  );
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ ok: evaluated.status === "PASS", mode, evidencePath, logPath, exitCode, sourceStable: evaluated.sourceStable, testCounts }, null, 2)}\n`);
  if (evaluated.status !== "PASS") process.exitCode = exitCode || 1;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await main(process.argv.slice(2));
}
