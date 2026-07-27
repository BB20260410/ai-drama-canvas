/**
 * P10-R final-validation：新证据路径，不覆盖历史 final。
 */
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { access, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createBuildIdentity } from "../src/core/build-identity.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const workspace = await realpath(path.resolve(process.argv[2] ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")));
const evidenceRoot = path.join(workspace, "docs", "evidence");
const stamp = "20260718-p10r";
const outputPath = path.resolve(process.argv[3] ?? path.join(evidenceRoot, `final-validation-${stamp}-build-identity.json`));
const runRoot = path.resolve(process.argv[4] ?? path.join(evidenceRoot, "runs", `p10r-build-identity-final-${stamp}`));
const canaryPath = path.join(evidenceRoot, `p10-canary-e2e-${stamp}.json`);

await access(outputPath).then(
  () => { throw new Error(`final 已存在：${outputPath}`); },
  () => undefined,
);
await mkdir(runRoot, { recursive: true });

async function run(name: string, command: string, args: string[]) {
  const logPath = path.join(runRoot, `${name}.log`);
  const child = spawn(command, args, { cwd: workspace, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  const chunks: Buffer[] = [];
  child.stdout.on("data", (c) => chunks.push(c));
  child.stderr.on("data", (c) => chunks.push(c));
  const code: number = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (v) => resolve(v ?? 1));
  });
  const output = Buffer.concat(chunks);
  await writeFile(logPath, output);
  return { name, exitCode: code, logSha256: createHash("sha256").update(output).digest("hex"), argv: [command, ...args] };
}

const typecheck = await run("typecheck", "npm", ["run", "typecheck"]);
assert(typecheck.exitCode === 0, "typecheck 失败");

const targeted = await run("p10-targeted", "npx", [
  "vitest", "run",
  "tests/build-identity.test.ts",
  "tests/project-backup.test.ts",
  "tests/mcp-managed-studio.test.ts",
]);
assert(targeted.exitCode === 0, "P10 定向测试失败");

const buildMcp = await run("build-mcp", "npm", ["run", "build:mcp"]);
assert(buildMcp.exitCode === 0, "build:mcp 失败");

const build = await run("build", "npm", ["run", "build"]);
assert(build.exitCode === 0, "build 失败");

try {
  await access(canaryPath);
} catch {
  const canary = await run("p10-canary", "npx", ["tsx", "scripts/run-p10-canary-e2e.ts", canaryPath]);
  assert(canary.exitCode === 0, "P10 金丝雀失败");
}

const canary = JSON.parse(await readFile(canaryPath, "utf8")) as any;
assert(canary.status === "pass", "canary 非 pass");
const identity = await createBuildIdentity(workspace);
assert(canary.mcp?.toolCount === identity.capabilities.mcpToolCount, "toolCount 不匹配");
assert(canary.canary?.restartFingerprintMatch === true, "重启 fingerprint 不一致");
assert(canary.dualProvider?.sameAllowedProviders === true, "双供应方 allowedProviders 不一致");
assert(canary.dualProvider?.codex?.provider === "codex", "缺 codex 路径");
assert(canary.dualProvider?.grok?.provider === "grok", "缺 grok 路径");
assert(canary.backupRestore?.hasPerFileSha === true, "备份无 per-file sha");
assert(canary.backupRestore?.duplicateRestoreRejected === true, "重复恢复未拒绝");
assert(canary.canary?.readinessNoLocalPath === true, "readiness 泄漏 localPath");
assert(canary.boundaries?.formalImageGenerationCalls === 0, "canary 声称正式生图");
assert(canary.boundaries?.realImagegenCanary === false, "不得把夹具写成真实生图");

assert(canary.buildIdentity?.sourceDigest === identity.sourceDigest, "canary sourceDigest 与当前源码不一致");
assert(identity.capabilities.formalImagegenProvider === "agent-imagegen", "能力清单非 agent-imagegen");
assert(JSON.stringify(identity.capabilities.formalImagegenProviders) === JSON.stringify(["codex", "grok"]), "能力清单缺双供应方");

const full = await run("full", "npx", ["vitest", "run"]);
assert(full.exitCode === 0, "全量测试失败");

const finalBody = {
  schemaVersion: 2,
  kind: "final-validation-p10r-build-identity",
  status: "PARTIAL",
  note: "双供应方合同/MCP/备份破坏性/构建身份/全量测试已过；真实 Codex/Grok 付费生图 canary 未执行（fixture 媒体登记）。",
  createdAt: new Date().toISOString(),
  buildIdentity: {
    buildId: identity.buildId,
    sourceDigest: identity.sourceDigest,
    sourceFiles: identity.roots.sourceFiles,
    sourceBytes: identity.roots.sourceBytes,
    capabilities: identity.capabilities,
    fingerprint: identity.fingerprint,
  },
  mcp: { toolCount: identity.capabilities.mcpToolCount },
  canaryPath,
  runs: { typecheck, targeted, buildMcp, build, full },
  boundaries: {
    realImagegenCanary: false,
    formalBatchProduction: false,
    gitStage: false,
  },
};
const content = `${JSON.stringify(finalBody, null, 2)}\n`;
await writeFile(outputPath, content, "utf8");
console.log(JSON.stringify({
  ok: true,
  status: "PARTIAL",
  outputPath,
  sha256: createHash("sha256").update(content).digest("hex"),
  buildId: identity.buildId,
  sourceDigest: identity.sourceDigest,
}, null, 2));
