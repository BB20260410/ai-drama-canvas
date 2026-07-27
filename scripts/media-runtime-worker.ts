import { appendFile } from "node:fs/promises";
import { acquireMachineMediaLease, startManagedMediaProcess } from "../src/core/media-runtime.js";

const [mode, id, projectRoot, weightText, holdText, eventPath] = process.argv.slice(2);
if (!mode || !id || !projectRoot || !weightText || !holdText || !eventPath) {
  throw new Error("用法：media-runtime-worker <hold|orphan> <id> <projectRoot> <weight> <holdMs> <eventPath>");
}
const weight = Number(weightText);
const holdMs = Number(holdText);
const record = async (event: string, extra: Record<string, unknown> = {}) => {
  await appendFile(eventPath, `${JSON.stringify({ event, id, weight, pid: process.pid, at: Date.now(), ...extra })}\n`, "utf8");
};

if (mode === "hold") {
  const started = Date.now();
  const lease = await acquireMachineMediaLease({ projectRoot, tool: "ffmpeg", stage: `worker-${id}`, weight });
  await record("acquired", { leaseId: lease.id, waitMs: lease.waitMs });
  await new Promise((resolve) => setTimeout(resolve, holdMs));
  await lease.release({ status: "succeeded", code: 0, durationMs: Date.now() - started - lease.waitMs });
  await record("released", { leaseId: lease.id });
} else if (mode === "orphan") {
  const childScript = "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)";
  const managed = await startManagedMediaProcess(process.execPath, ["-e", childScript], {
    projectRoot,
    tool: "ffmpeg",
    stage: `worker-${id}`,
    weight,
    timeoutMs: Math.max(60_000, holdMs),
    terminationGraceMs: 100,
  });
  await record("orphaned", { leaseId: managed.leaseId, childPid: managed.child.pid });
  process.exit(0);
} else {
  throw new Error(`未知模式：${mode}`);
}
