import { acquireMcpProcessGuard, releaseMcpProcessGuard } from "../../src/core/mcp-process-guard.js";

const lockFilePath = process.argv[2];
if (!lockFilePath || !process.send) {
  throw new Error("mcp-process-guard-worker 需要 lockFilePath 与 IPC 通道。");
}

delete process.env.AI_CANVAS_MCP_ALLOW_MULTI;
delete process.env.AI_CANVAS_MCP_SINGLETON;

const result = await acquireMcpProcessGuard({
  lockFilePath,
  note: `worker-${process.pid}`,
  registerSignalHandlers: false,
});
process.send({
  type: "result",
  pid: process.pid,
  acquired: result.acquired,
  blockedByPid: result.blockedBy?.pid ?? null,
});

if (!result.acquired) {
  process.exit(0);
}

const hold = setInterval(() => undefined, 1_000);
process.on("message", (message) => {
  if (message !== "release") return;
  clearInterval(hold);
  void releaseMcpProcessGuard({ lockFilePath }).finally(() => process.exit(0));
});
