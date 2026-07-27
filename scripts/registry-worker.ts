import { ensureSidecar } from "../src/core/sidecar.js";

const root = process.argv[2];
if (!root) throw new Error("用法：registry-worker <projectRoot>");

const config = await ensureSidecar(root);
process.stdout.write(`${JSON.stringify({ id: config.id, primaryRoot: config.primaryRoot })}\n`);
