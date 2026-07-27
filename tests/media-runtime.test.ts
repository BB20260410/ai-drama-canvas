import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readMachineMediaRuntimeSnapshot, reapMachineMediaRuntime, runMediaProcess } from "../src/core/media-runtime.js";

const temporaryRoots: string[] = [];
const workerPath = path.join(process.cwd(), "node_modules", ".bin", "tsx");

async function wait(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function alive(pid: number | undefined): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitUntil(check: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error(`等待条件超过 ${timeoutMs}ms`);
    await wait(25);
  }
}

async function events(filePath: string): Promise<Array<Record<string, unknown>>> {
  const content = await readFile(filePath, "utf8").catch(() => "");
  return content.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

function startWorker(args: string[]): { child: ChildProcess; completion: Promise<void> } {
  const child = spawn(workerPath, ["scripts/media-runtime-worker.ts", ...args], { cwd: process.cwd(), env: process.env, stdio: ["ignore", "ignore", "pipe"] });
  let errorOutput = "";
  child.stderr?.on("data", (chunk: Buffer) => { errorOutput = `${errorOutput}${chunk.toString("utf8")}`.slice(-8_000); });
  const completion = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(errorOutput || `媒体 worker 退出码 ${code}`)));
  });
  return { child, completion };
}

beforeEach(async () => {
  process.env.AI_CANVAS_MEDIA_CAPACITY = "4";
  await rm(process.env.AI_CANVAS_MEDIA_RUNTIME_DIR!, { recursive: true, force: true });
});

afterEach(async () => {
  await rm(process.env.AI_CANVAS_MEDIA_RUNTIME_DIR!, { recursive: true, force: true });
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("机器级媒体运行时", () => {
  it("高并发毫秒级子进程不会在租约绑定前退出并泄漏容量", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-media-fast-exit-"));
    temporaryRoots.push(root);
    const results = await Promise.all(Array.from({ length: 20 }, (_, index) => runMediaProcess(process.execPath, ["-e", ""], {
      projectRoot: root,
      tool: "ffprobe",
      stage: `fast-exit-${index}`,
      weight: 1,
      timeoutMs: 5_000,
    })));
    expect(results.every((result) => result.status === "succeeded")).toBe(true);
    const snapshot = await readMachineMediaRuntimeSnapshot();
    expect(snapshot.activeWeight).toBe(0);
    expect(snapshot.queueDepth).toBe(0);
    expect(snapshot.metrics.granted).toBe(20);
    expect(snapshot.metrics.succeeded).toBe(20);
  });

  it("跨项目跨进程按权重严格 FIFO，且活动权重不超过机器容量", async () => {
    process.env.AI_CANVAS_MEDIA_CAPACITY = "3";
    const root = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-media-fifo-"));
    temporaryRoots.push(root);
    const eventPath = path.join(root, "events.jsonl");
    const projects = await Promise.all(["a", "b", "c"].map(async (id) => {
      const project = await mkdtemp(path.join(root, `${id}-`));
      return project;
    }));

    const first = startWorker(["hold", "A", projects[0]!, "2", "2000", eventPath]);
    await waitUntil(async () => (await events(eventPath)).some((entry) => entry.event === "acquired" && entry.id === "A"));
    const second = startWorker(["hold", "B", projects[1]!, "2", "180", eventPath]);
    await waitUntil(async () => (await readMachineMediaRuntimeSnapshot()).queued.some((entry) => entry.stage === "worker-B"));
    const third = startWorker(["hold", "C", projects[2]!, "1", "80", eventPath]);
    await waitUntil(async () => (await readMachineMediaRuntimeSnapshot()).queueDepth === 2);

    await Promise.all([first.completion, second.completion, third.completion]);
    const acquired = (await events(eventPath)).filter((entry) => entry.event === "acquired").map((entry) => entry.id);
    expect(acquired).toEqual(["A", "B", "C"]);
    const snapshot = await readMachineMediaRuntimeSnapshot();
    expect(snapshot.activeWeight).toBe(0);
    expect(snapshot.queueDepth).toBe(0);
    expect(snapshot.metrics.maxObservedWeight).toBe(3);
    expect(snapshot.metrics.granted).toBe(3);
  });

  it("阶段超时会终止忽略 SIGTERM 的完整进程组，并限制日志体积", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-media-timeout-"));
    temporaryRoots.push(root);
    const pidPath = path.join(root, "pids.json");
    const grandchildScript = "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)";
    const parentScript = [
      "const {spawn}=require('node:child_process')",
      "const {writeFileSync}=require('node:fs')",
      "process.on('SIGTERM',()=>{})",
      `const child=spawn(process.execPath,['-e',${JSON.stringify(grandchildScript)}],{stdio:'ignore'})`,
      `writeFileSync(${JSON.stringify(pidPath)},JSON.stringify({parent:process.pid,child:child.pid}))`,
      "process.stdout.write('x'.repeat(200000))",
      "setInterval(()=>{},1000)",
    ].join(";");
    const result = await runMediaProcess(process.execPath, ["-e", parentScript], {
      projectRoot: root,
      tool: "ffmpeg",
      stage: "timeout-tree-test",
      weight: 2,
      timeoutMs: 250,
      terminationGraceMs: 100,
      maxOutputBytes: 4_096,
    });
    const pids = JSON.parse(await readFile(pidPath, "utf8")) as { parent: number; child: number };
    await waitUntil(() => !alive(pids.parent) && !alive(pids.child), 3_000);
    expect(result.status).toBe("timed_out");
    expect(Buffer.byteLength(result.output, "utf8")).toBeLessThanOrEqual(4_096);
    const snapshot = await readMachineMediaRuntimeSnapshot();
    expect(snapshot.activeWeight).toBe(0);
    expect(snapshot.metrics.timedOut).toBe(1);
    expect(snapshot.recentTerminals[0]).toEqual(expect.objectContaining({ stage: "timeout-tree-test", status: "timed_out", weight: 2 }));
  });

  it("宿主异常退出后回收孤儿租约和遗留进程组", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-media-orphan-"));
    temporaryRoots.push(root);
    const eventPath = path.join(root, "events.jsonl");
    const worker = startWorker(["orphan", "D", root, "3", "60000", eventPath]);
    await worker.completion;
    const orphanEvent = (await events(eventPath)).find((entry) => entry.event === "orphaned");
    const childPid = Number(orphanEvent?.childPid);
    expect(alive(childPid)).toBe(true);
    const before = await readMachineMediaRuntimeSnapshot();
    expect(before.active).toEqual([expect.objectContaining({ stage: "worker-D", ownerAlive: false, childPid })]);
    const after = await reapMachineMediaRuntime();
    await waitUntil(() => !alive(childPid), 3_000);
    expect(after.activeWeight).toBe(0);
    expect(after.metrics.orphanedLeasesReaped).toBe(1);
  });
});
