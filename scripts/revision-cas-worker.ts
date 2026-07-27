import { executeIdempotentCommand } from "../src/core/command-bus.js";
import { isRejectedCommandFailure } from "../src/core/command-outcome.js";

const [projectRoot, contextId, revisionText, content, requestId, idempotencyKey] = process.argv.slice(2);
if (!projectRoot || !contextId || !revisionText || !content || !requestId || !idempotencyKey) {
  throw new Error("用法：revision-cas-worker <projectRoot> <contextId> <revision> <content> <requestId> <idempotencyKey>");
}

try {
  const result = await executeIdempotentCommand(projectRoot, {
    requestId,
    idempotencyKey,
    request: {
      command: "upsert_context",
      payload: {
        id: contextId,
        kind: "decision",
        title: "跨进程 CAS",
        content,
        expectedRevision: Number(revisionText),
      },
    },
  });
  process.stdout.write(`${JSON.stringify({ ok: true, status: result.status, revision: (result.result as { revision?: number } | undefined)?.revision })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ ok: false, name: error instanceof Error ? error.name : "Error", reason: isRejectedCommandFailure(error) ? (error.result as { reason?: string }).reason : undefined, error: error instanceof Error ? error.message : String(error) })}\n`);
}
