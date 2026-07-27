#!/usr/bin/env node
/**
 * L33: parameterized Codex CLI image generation for prepared unit-grid call.
 *
 * Usage:
 *   node scripts/l31-w1-codex-image-exec.mjs \
 *     --precall /path/to/codex-precall.json \
 *     [--workdir /path/to/mvp-work/dir] \
 *     [--workspace /path/to/repo]
 *
 * Env fallbacks: CODEX_PRECALL_JSON, CODEX_IMAGE_WORKDIR, AI_CANVAS_WORKSPACE
 *
 * Hard gates:
 * - prompt delivered via stdin
 * - candidate acceptance only at exact quarantine.candidatePath
 */
import { spawn } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--precall" || a === "-p") out.precall = argv[++i];
    else if (a === "--workdir" || a === "-w") out.workdir = argv[++i];
    else if (a === "--workspace" || a === "-C") out.workspace = argv[++i];
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

function loadGate() {
  try {
    return require("../dist-mcp/core/studio-imagegen-candidate-gate.js");
  } catch {
    return null;
  }
}

const gate = loadGate();

function acceptCandidateBytes(grant, observedPath, sizeBytes) {
  if (gate?.acceptStudioImagegenCandidateBytes) {
    return gate.acceptStudioImagegenCandidateBytes(grant, observedPath, sizeBytes);
  }
  const expected = path.resolve(grant.candidatePath);
  const observed = path.resolve(observedPath);
  if (expected !== observed) throw new Error(`candidate-path-mismatch: ${observed} !== ${expected}`);
  if (!sizeBytes || sizeBytes < 20_000) throw new Error(`candidate-too-small-or-missing: ${sizeBytes}`);
  return { accepted: true, candidatePath: expected, bytes: sizeBytes };
}

const argsCli = parseArgs(process.argv.slice(2));
if (argsCli.help) {
  console.log(`Usage: node scripts/l31-w1-codex-image-exec.mjs --precall <codex-precall.json> [--workdir dir] [--workspace repo]`);
  process.exit(0);
}

const defaultWorkspace = path.resolve(__dirname, "..");
const workspace = path.resolve(
  argsCli.workspace
    || process.env.AI_CANVAS_WORKSPACE
    || defaultWorkspace,
);
const prePath = path.resolve(
  argsCli.precall
    || process.env.CODEX_PRECALL_JSON
    || path.join(
      workspace,
      "projects/grok-mvp-qingdeng-mrwc97mu-d0aea463/.aicanvas/mvp-work/codex-connect-20260723/codex-precall.json",
    ),
);
if (!existsSync(prePath)) {
  console.error(JSON.stringify({ error: "precall-missing", prePath }, null, 2));
  process.exit(2);
}
const work = path.resolve(
  argsCli.workdir
    || process.env.CODEX_IMAGE_WORKDIR
    || path.dirname(prePath),
);

const pre = JSON.parse(readFileSync(prePath, "utf8"));
const quarantine = pre.prepare?.quarantine;
if (!quarantine?.candidatePath || !quarantine?.rootPath) {
  console.error(JSON.stringify({ error: "precall-missing-quarantine", prePath }, null, 2));
  process.exit(2);
}
const cand = quarantine.candidatePath;
const grant = {
  rootPath: quarantine.rootPath,
  candidatePath: cand,
  receiptPath: quarantine.receiptPath,
};
const refs = (pre.pack?.controlReferences || []).map((r) => r.localPath).filter(Boolean);
if (refs.length < 1) {
  console.error(JSON.stringify({ error: "precall-missing-control-references", prePath }, null, 2));
  process.exit(2);
}
mkdirSync(work, { recursive: true });
mkdirSync(path.dirname(cand), { recursive: true });

const prompt = [
  "你是无限画布受管 Studio 的 Codex 生图执行面。只做一件事：用 image generation 生成一张图。",
  "",
  "硬要求：",
  "1. 严格只调用一次生图工具，只产出一张 PNG。",
  "2. 画幅 9:16 竖屏；整板为上中下有序宫格完整故事板（单图）。",
  `3. 生成后把最终 PNG 复制到绝对路径（覆盖）：${cand}`,
  "4. 完成后只打印：CODEX_IMAGE_OK path=... bytes=...",
  "5. 禁止浏览器、ComfyUI、Artlist；禁止第二张图。",
  "6. 禁止把 authority/prop 参考图复制为候选；候选只能是新生成图。",
  "",
  pre.renderedPrompt ? `冻结提示词：\n${pre.renderedPrompt}` : "参考图已用 -i 附加。",
].join("\n");

const promptPath = path.join(work, "codex-image-prompt.txt");
writeFileSync(promptPath, prompt);
writeFileSync(path.join(work, "codex-paths.json"), `${JSON.stringify({
  cand,
  refs,
  prePath,
  work,
  workspace,
  promptDelivery: "stdin",
}, null, 2)}\n`);

const logPath = path.join(work, "codex-exec-log.txt");
const codexArgs = [
  "exec",
  "--skip-git-repo-check",
  "--ephemeral",
  "--enable",
  "image_generation",
  "-s",
  "workspace-write",
  "--add-dir",
  path.dirname(path.dirname(cand)), // quarantine parent under .aicanvas/studio-generation
  "-C",
  workspace,
];
for (const ref of refs.slice(0, 3)) {
  codexArgs.push("-i", ref);
}
codexArgs.push("-"); // prompt via stdin

console.error("spawning codex", codexArgs.slice(0, 14).join(" "), "... stdin-prompt");
const child = spawn("codex", codexArgs, {
  cwd: workspace,
  env: process.env,
  stdio: ["pipe", "pipe", "pipe"],
});
child.stdin.write(prompt);
child.stdin.end();

let out = "";
child.stdout.on("data", (d) => {
  out += d.toString();
  process.stderr.write(d);
});
child.stderr.on("data", (d) => {
  out += d.toString();
  process.stderr.write(d);
});

const exitCode = await new Promise((resolve) => {
  child.on("close", resolve);
  child.on("error", (err) => {
    out += `\nspawn error: ${err.message}\n`;
    resolve(1);
  });
});
writeFileSync(logPath, out);

let candidateOk = false;
let candidateBytes = 0;
let gateError = null;
try {
  if (existsSync(cand)) {
    const size = statSync(cand).size;
    const accepted = acceptCandidateBytes(grant, cand, size);
    candidateOk = true;
    candidateBytes = accepted.bytes;
  } else {
    gateError = "candidate-missing";
  }
} catch (e) {
  gateError = e?.message || String(e);
  candidateOk = false;
}

const summary = {
  exitCode,
  candidateOk,
  candidatePath: cand,
  candidateBytes,
  logPath,
  prePath,
  work,
  workspace,
  promptDelivery: "stdin",
  quarantineOnly: true,
  parameterized: true,
  gateError,
  matchedLine: (out.match(/CODEX_IMAGE_OK[^\n]*/)?.[0]) || null,
};
writeFileSync(path.join(work, "codex-image-exec-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
process.exit(candidateOk ? 0 : 1);
