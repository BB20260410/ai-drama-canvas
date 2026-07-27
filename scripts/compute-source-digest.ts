import { computeSourceDigest } from "../src/core/build-identity.js";

/**
 * 重算当前工作区 sourceDigest（冻结证据复算路径）。
 * 用法：npx tsx scripts/compute-source-digest.ts [workspaceRoot]
 */
const workspace = process.argv[2] ?? process.cwd();
const result = await computeSourceDigest(workspace);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
