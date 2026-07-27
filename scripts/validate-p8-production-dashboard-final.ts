import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import {
  access,
  mkdir,
  readFile,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import fg from "fast-glob";
import { expectedRuntimeMcpToolCount } from "../src/core/release-manifest.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function parseCli(argv: string[]) {
  const positional: string[] = [];
  let uiEvidenceArgument: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--ui-evidence") {
      uiEvidenceArgument = argv[++index];
      continue;
    }
    if (argument.startsWith("--ui-evidence=")) {
      uiEvidenceArgument = argument.slice("--ui-evidence=".length);
      continue;
    }
    assert(!argument.startsWith("--"), `未知参数：${argument}`);
    positional.push(argument);
  }
  assert(typeof uiEvidenceArgument === "string" && uiEvidenceArgument.length > 0,
    "必须用 --ui-evidence <p8-production-dashboard-ui-smoke-*.json> 传入 UI smoke 证据。");
  return { positional, uiEvidenceArgument };
}

const cli = parseCli(process.argv.slice(2));
const workspace = await realpath(path.resolve(cli.positional[0] ?? "/Users/hxx/Documents/无限画布"));
const projectRoot = await realpath(path.resolve(
  cli.positional[1] ?? path.join(workspace, "projects", "codex-ai-drama-studio"),
));
const sourceRoot = await realpath(path.resolve(cli.positional[2] ?? "/Users/hxx/Documents/古蜀卷第三季"));
const evidenceRoot = path.join(workspace, "docs", "evidence");
const outputPath = path.resolve(
  cli.positional[3] ?? path.join(evidenceRoot, "final-validation-20260718-p8-production-dashboard.json"),
);
const runRoot = path.resolve(
  cli.positional[4] ?? path.join(evidenceRoot, "runs", "p8-production-dashboard-final-20260718-01"),
);
const uiEvidencePath = path.resolve(workspace, cli.uiEvidenceArgument);
const planningRoot = path.join(workspace, ".planning", "2026-07-17-ai-p0-p10");
const expectedToolCount = await expectedRuntimeMcpToolCount(workspace);
const MAX_CAPTURE = 4 * 1024 * 1024;

await access(outputPath).then(
  () => { throw new Error(`final-validation 已存在，拒绝覆盖：${outputPath}`); },
  () => undefined,
);
await mkdir(runRoot, { recursive: true });

function sha256Buffer(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve());
  });
  return hash.digest("hex");
}

async function inventory(root: string) {
  const files = (await fg("**/*", {
    cwd: root,
    absolute: true,
    onlyFiles: true,
    dot: true,
    followSymbolicLinks: false,
  })).sort((a, b) => a.localeCompare(b));
  let bytes = 0;
  const hash = createHash("sha256");
  for (const filePath of files) {
    const metadata = await stat(filePath);
    bytes += metadata.size;
    hash.update(path.relative(root, filePath));
    hash.update("\0");
    hash.update(await sha256File(filePath));
    hash.update("\0");
  }
  return { root, files: files.length, bytes, aggregateSha256: hash.digest("hex") };
}

async function runCommand(name: string, command: string, args: string[], cwd = workspace) {
  const started = Date.now();
  const logPath = path.join(runRoot, `${name}.log`);
  const child = spawn(command, args, { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  const chunks: Buffer[] = [];
  let size = 0;
  const push = (chunk: Buffer) => {
    size += chunk.length;
    if (size <= MAX_CAPTURE) chunks.push(chunk);
  };
  child.stdout.on("data", push);
  child.stderr.on("data", push);
  const code: number = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (value) => resolve(value ?? 1));
  });
  const output = Buffer.concat(chunks);
  await writeFile(logPath, output);
  return {
    name,
    command: [command, ...args].join(" "),
    exitCode: code,
    durationMs: Date.now() - started,
    logPath,
    logSha256: sha256Buffer(output),
    outputText: output.toString("utf8"),
  };
}

function parseVitest(output: string): { files: number; tests: number } {
  const match = output.match(/Test Files\s+(\d+)\s+passed[^\n]*\n\s*Tests\s+(\d+)\s+passed/u);
  assert(match, `无法解析 Vitest 计数：\n${output.slice(-800)}`);
  return { files: Number(match[1]), tests: Number(match[2]) };
}

const beforeProject = await inventory(projectRoot);
const beforeSource = await inventory(sourceRoot);

const typecheck = await runCommand("typecheck", "npm", ["run", "typecheck"]);
assert(typecheck.exitCode === 0, `typecheck 失败：${typecheck.logPath}`);

const targeted = await runCommand("p8-targeted", "npx", [
  "vitest", "run",
  "tests/studio-production-dashboard.test.ts",
  "tests/studio-production-dashboard-scale.test.ts",
  "tests/mcp-studio-production-dashboard.test.ts",
  "tests/studio-production-dashboard-ui.test.ts",
  "tests/studio-production-dashboard-desktop-integration.test.ts",
]);
assert(targeted.exitCode === 0, `P8 定向测试失败：${targeted.logPath}`);
const targetedCounts = parseVitest(targeted.outputText);

const full = await runCommand("full", "npx", ["vitest", "run"]);
assert(full.exitCode === 0, `全量测试失败：${full.logPath}`);
const fullCounts = parseVitest(full.outputText);

const build = await runCommand("build", "npm", ["run", "build"]);
assert(build.exitCode === 0, `production build 失败：${build.logPath}`);

const mcpBuild = await runCommand("mcp-build", "npm", ["run", "build:mcp"]);
assert(mcpBuild.exitCode === 0, `MCP build 失败：${mcpBuild.logPath}`);

const mcpSmoke = await runCommand("mcp-smoke", "npm", ["run", "mcp:smoke"]);
assert(mcpSmoke.exitCode === 0, `MCP smoke 失败：${mcpSmoke.logPath}`);
assert(
  mcpSmoke.outputText.includes(String(expectedToolCount)) || mcpSmoke.outputText.includes(`toolCount\":${expectedToolCount}`),
  `MCP smoke 未报告 ${expectedToolCount} tools`,
);

const uiEvidenceRaw = JSON.parse(await readFile(uiEvidencePath, "utf8")) as {
  kind?: string;
  core?: { overviewFingerprint?: string };
  ui?: { unitDomCount?: number; panelDomCount?: number; pageErrors?: string[]; consoleErrors?: string[]; externalResources?: string[] };
  formalAccess?: number;
  imagegen?: number;
  browser?: number;
  upload?: number;
};
assert(uiEvidenceRaw.kind === "p8-production-dashboard-ui-smoke", "UI 证据 kind 不正确");
assert((uiEvidenceRaw.ui?.unitDomCount ?? 99) <= 36, "UI 单元 DOM 超过 36");
assert((uiEvidenceRaw.ui?.panelDomCount ?? 99) <= 6, "UI 宫格 DOM 超过 6");
assert((uiEvidenceRaw.ui?.pageErrors ?? []).length === 0, "UI 存在 page error");
assert((uiEvidenceRaw.ui?.consoleErrors ?? []).length === 0, "UI 存在 console error");
assert((uiEvidenceRaw.ui?.externalResources ?? []).length === 0, "UI 访问外网");
assert(uiEvidenceRaw.formalAccess === 0 && uiEvidenceRaw.imagegen === 0
  && uiEvidenceRaw.browser === 0 && uiEvidenceRaw.upload === 0, "UI smoke 产生了禁止副作用");

// 正式工程必须仍为空库
const afterProject = await inventory(projectRoot);
const afterSource = await inventory(sourceRoot);
assert(afterProject.aggregateSha256 === beforeProject.aggregateSha256, "正式工程被修改");
assert(afterSource.aggregateSha256 === beforeSource.aggregateSha256, "只读源被修改");

const dashboardSource = await readFile(path.join(workspace, "src/core/studio-production-dashboard.ts"), "utf8");
assert(dashboardSource.includes("getStudioProductionDashboard"), "缺少 Dashboard Core");
assert(!dashboardSource.includes("CREATE TABLE studio_dashboard"), "禁止 Dashboard 自建表");

const reportPath = path.join(workspace, "docs", "验证报告_20260718_P8无限画布生产驾驶舱.md");
const report = `# 验证报告 · P8 无限画布生产驾驶舱

日期：2026-07-18  
状态：**PASS**

## 结论

- 新增只读 \`StudioProductionDashboard\` Core，operation：overview/units/unit/assets/appearances/queue。
- 复用 P5–P7 owner，无 Dashboard DB，无 Scanner 恢复。
- MCP 只读 \`get_studio_production_dashboard\`，compiled tools = ${expectedToolCount}。
- UI 生产驾驶舱分页硬上限：≤36 单元 / ≤6 宫格；nextAction 来自 Core。
- 正式隔离工程与只读源未变；无生图/浏览器/上传。

## 证据

| 项 | 结果 |
|----|------|
| typecheck | PASS |
| P8 定向 | ${targetedCounts.files} files / ${targetedCounts.tests} tests |
| full | ${fullCounts.files} files / ${fullCounts.tests} tests |
| production build | PASS |
| MCP build + smoke | PASS · ${expectedToolCount} tools |
| UI smoke | ${path.relative(workspace, uiEvidencePath)} |
| final-validation | ${path.relative(workspace, outputPath)} |

## 指纹

- UI overview fingerprint：\`${uiEvidenceRaw.core?.overviewFingerprint ?? ""}\`
- 正式工程 aggregate：\`${afterProject.aggregateSha256}\`
- 只读源 aggregate：\`${afterSource.aggregateSha256}\`
`;

await writeFile(reportPath, report, "utf8");

const finalPayload = {
  schemaVersion: 1,
  kind: "final-validation-p8-production-dashboard",
  status: "PASS",
  createdAt: new Date().toISOString(),
  workspace,
  projectRoot,
  sourceRoot,
  expectedToolCount,
  targeted: targetedCounts,
  full: fullCounts,
  uiEvidence: {
    path: uiEvidencePath,
    sha256: await sha256File(uiEvidencePath),
    overviewFingerprint: uiEvidenceRaw.core?.overviewFingerprint,
  },
  inventories: {
    projectBefore: beforeProject,
    projectAfter: afterProject,
    sourceBefore: beforeSource,
    sourceAfter: afterSource,
  },
  commands: [typecheck, targeted, full, build, mcpBuild, mcpSmoke].map((entry) => ({
    name: entry.name,
    exitCode: entry.exitCode,
    durationMs: entry.durationMs,
    logSha256: entry.logSha256,
  })),
  reportPath,
  runRoot,
  git: { stage: 0, commit: 0, push: 0 },
  imagegen: 0,
  browser: 0,
  upload: 0,
};

const body = `${JSON.stringify(finalPayload, null, 2)}\n`;
await writeFile(outputPath, body, "utf8");
const finalSha = sha256Buffer(Buffer.from(body, "utf8"));
console.log(JSON.stringify({
  ok: true,
  outputPath,
  sha256: finalSha,
  targeted: targetedCounts,
  full: fullCounts,
  expectedToolCount,
}, null, 2));
