import { execFile } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { electronExecutablePath } from "../scripts/lib/ensure-test-runtime.js";

const execFileAsync = promisify(execFile);
const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const probePath = path.join(workspace, "scripts", "probe-novel-fts5-runtime.mjs");
const electronExecutable = electronExecutablePath(workspace);
const temporaryRoots: string[] = [];

interface ProbeResult {
  schemaVersion: 1;
  kind: "novel-fts5-runtime-probe";
  ok: boolean;
  runtime: "system-node" | "electron-run-as-node" | "electron-main";
  inMemory?: boolean;
  parameterBinding?: boolean;
  query?: string;
  matchIds?: string[];
  versions: { node: string; electron: string | null; sqlite: string | null };
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function withoutElectronRunAsNode(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

async function runProbe(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<ProbeResult> {
  const { stdout } = await execFileAsync(command, args, {
    cwd: workspace,
    env,
    encoding: "utf8",
    timeout: 20_000,
    maxBuffer: 64 * 1024,
  });
  const lines = stdout.trim().split(/\r?\n/u);
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0] ?? "{}") as ProbeResult;
}

function expectPass(result: ProbeResult, runtime: ProbeResult["runtime"]): void {
  expect(result).toMatchObject({
    schemaVersion: 1,
    kind: "novel-fts5-runtime-probe",
    ok: true,
    runtime,
    inMemory: true,
    parameterBinding: true,
    query: "嘟嘟",
    matchIds: ["chapter-001"],
  });
  expect(result.versions.node).toMatch(/^\d+\.\d+\.\d+$/u);
  expect(result.versions.sqlite).toMatch(/^\d+\.\d+\.\d+$/u);
}

describe("小说 FTS5 runtime 内存探针", () => {
  it("系统 Node 可创建内存 FTS5 并用参数绑定唯一命中中文", async () => {
    await access(probePath);
    const result = await runProbe(process.execPath, [probePath], withoutElectronRunAsNode());
    expectPass(result, "system-node");
    expect(result.versions.electron).toBeNull();
  });

  it("项目 node_modules Electron 的 run-as-node runtime 同样通过", async () => {
    await access(electronExecutable);
    const result = await runProbe(electronExecutable, [probePath], { ...process.env, ELECTRON_RUN_AS_NODE: "1" });
    expectPass(result, "electron-run-as-node");
    expect(result.versions.electron).toBeTruthy();
  });

  it.runIf(process.platform === "darwin")("真实 Electron main runtime 无窗口运行并确定性退出", async () => {
    await access(electronExecutable);
    const userData = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-novel-fts5-electron-main-"));
    temporaryRoots.push(userData);
    const result = await runProbe(electronExecutable, [
      `--user-data-dir=${userData}`,
      "--disable-gpu",
      probePath,
    ], withoutElectronRunAsNode());
    expectPass(result, "electron-main");
    expect(result.versions.electron).toBeTruthy();
  });
});
