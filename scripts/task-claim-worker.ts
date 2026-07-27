import { claimTask } from "../src/core/service.js";

const [projectRoot, taskId, agentId, expectedRevisionText] = process.argv.slice(2);
if (!projectRoot || !taskId || !agentId || !expectedRevisionText) throw new Error("用法：task-claim-worker <projectRoot> <taskId> <agentId> <expectedRevision>");

try {
  const task = await claimTask(projectRoot, taskId, { agentId, expectedRevision: Number(expectedRevisionText) });
  process.stdout.write(`${JSON.stringify({ ok: true, taskId: task.id, revision: task.revision, leaseId: task.lease?.id, owner: task.lease?.owner })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
  process.exitCode = 2;
}
