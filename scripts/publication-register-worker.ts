import { writeFile } from "node:fs/promises";
import { registerPublication } from "../src/core/publication.js";

const [projectRoot, intentId, reservationToken, revisionText, mode = "normal", markerPath] = process.argv.slice(2);
if (!projectRoot || !intentId || !reservationToken || !revisionText) throw new Error("用法：publication-register-worker <projectRoot> <intentId> <token> <revision> [normal|hold-before-commit] [markerPath]");
const expectedRevision = Number(revisionText);
if (!Number.isInteger(expectedRevision) || expectedRevision < 1) throw new Error("revision 必须是正整数。");

const receipt = await registerPublication(projectRoot, { intentId, reservationToken, expectedRevision }, "codex", mode === "hold-before-commit" ? {
  beforeCommit: async () => {
    if (!markerPath) throw new Error("hold-before-commit 模式缺少 markerPath。");
    await writeFile(markerPath, `${process.pid}\n`, "utf8");
    const keepAlive = setInterval(() => undefined, 1_000);
    try { await new Promise<never>(() => undefined); }
    finally { clearInterval(keepAlive); }
  },
} : undefined);
process.stdout.write(`${JSON.stringify({ receiptId: receipt.id, intentId: receipt.intentId, sha256: receipt.check.sha256 })}\n`);
