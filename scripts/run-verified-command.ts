/** 运行一个验收命令，并把完整日志、源码前后身份与机器可读结果写入新证据文件。 */
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createBuildIdentity } from "../src/core/build-identity.js";

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv: string[]): {
  name: string;
  recordPath: string;
  logPath: string;
  command: string;
  commandArgs: string[];
} {
  const separator = argv.indexOf("--");
  if (separator < 0 || separator === argv.length - 1) throw new Error("需要 -- <command> [args...]");
  const options = argv.slice(0, separator);
  const command = argv[separator + 1]!;
  const commandArgs = argv.slice(separator + 2);
  const read = (flag: string): string => {
    const index = options.indexOf(flag);
    const value = index >= 0 ? options[index + 1] : undefined;
    if (!value || value.startsWith("--")) throw new Error(`缺少 ${flag}`);
    return value;
  };
  return {
    name: read("--name"),
    recordPath: path.resolve(read("--record")),
    logPath: path.resolve(read("--log")),
    command,
    commandArgs,
  };
}

async function refuseOverwrite(filePath: string): Promise<void> {
  await access(filePath).then(
    () => { throw new Error(`证据已存在，拒绝覆盖：${filePath}`); },
    () => undefined,
  );
  await mkdir(path.dirname(filePath), { recursive: true });
}

const input = parseArgs(process.argv.slice(2));
await Promise.all([refuseOverwrite(input.recordPath), refuseOverwrite(input.logPath)]);
const before = await createBuildIdentity(workspace);
const startedAt = new Date().toISOString();
const started = performance.now();
const child = spawn(input.command, input.commandArgs, {
  cwd: workspace,
  env: process.env,
  stdio: ["ignore", "pipe", "pipe"],
});
const chunks: Buffer[] = [];
child.stdout.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
child.stderr.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
const exitCode = await new Promise<number>((resolve, reject) => {
  child.on("error", reject);
  child.on("close", (code) => resolve(code ?? 1));
});
const endedAt = new Date().toISOString();
const log = Buffer.concat(chunks);
await writeFile(input.logPath, log, { flag: "wx" });
const after = await createBuildIdentity(workspace);
const sourceStable = before.sourceDigest === after.sourceDigest && before.buildId === after.buildId;
const text = log.toString("utf8");
const testFiles = text.match(/Test Files\s+\d+ passed \((\d+)\)/u)?.[1];
const tests = text.match(/Tests\s+\d+ passed \((\d+)\)/u)?.[1];
const status = exitCode === 0 && sourceStable ? "pass" : "fail";
const record = {
  schemaVersion: 1,
  kind: "verified-command-record",
  name: input.name,
  status,
  startedAt,
  endedAt,
  durationMs: Math.round(performance.now() - started),
  argv: [input.command, ...input.commandArgs],
  cwd: workspace,
  exitCode,
  sourceStable,
  buildIdentity: {
    before: { buildId: before.buildId, sourceDigest: before.sourceDigest },
    after: { buildId: after.buildId, sourceDigest: after.sourceDigest },
  },
  log: {
    relativePath: path.relative(workspace, input.logPath).split(path.sep).join("/"),
    sizeBytes: log.byteLength,
    sha256: createHash("sha256").update(log).digest("hex"),
  },
  ...(testFiles && tests ? { testCounts: { files: Number(testFiles), tests: Number(tests) } } : {}),
};
await writeFile(input.recordPath, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
process.stdout.write(`${JSON.stringify({
  ok: status === "pass",
  recordPath: input.recordPath,
  logPath: input.logPath,
  exitCode,
  sourceStable,
  testCounts: record.testCounts,
}, null, 2)}\n`);
if (status !== "pass") process.exitCode = exitCode || 1;
