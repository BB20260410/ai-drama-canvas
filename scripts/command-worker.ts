import { executeIdempotentCommand } from "../src/core/command-bus.js";

const [projectRoot, itemId, requestId, idempotencyKey] = process.argv.slice(2);
if (!projectRoot || !itemId || !requestId || !idempotencyKey) throw new Error("用法：command-worker <projectRoot> <itemId> <requestId> <idempotencyKey>");

try {
  const result = await executeIdempotentCommand(projectRoot, { requestId, idempotencyKey, request: { command: "create_task_pack", payload: { itemIds: [itemId], kind: "image", mode: "autopilot" } } });
  process.stdout.write(`${JSON.stringify({ ok: true, status: result.status, replayed: result.replayed, requestHash: result.requestHash })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
  process.exitCode = 2;
}
