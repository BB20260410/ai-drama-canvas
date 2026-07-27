import path from "node:path";
import { enqueueGeneration } from "../src/core/generation.js";

const projectRoot = path.resolve(process.argv[2] ?? "");
const assetIds = process.argv.slice(3).map((value) => value.trim().toUpperCase()).filter(Boolean);
if (!projectRoot || assetIds.length < 1 || assetIds.length > 6) {
  throw new Error("用法：tsx scripts/enqueue-fusion-assets.ts <projectRoot> <assetId...>；每批 1–6 项。 ");
}
if (new Set(assetIds).size !== assetIds.length || assetIds.some((assetId) => !/^[CSP]\d{2}[A-Z]?$/u.test(assetId))) {
  throw new Error("资产 ID 必须唯一且符合 C01/S01/P01/C04A 格式。 ");
}
const jobs = await enqueueGeneration(projectRoot, { itemIds: assetIds.map((assetId) => `asset-${assetId.replace(/([A-Z])$/u, (suffix) => suffix.toLowerCase())}`), kind: "image" });
process.stdout.write(`${JSON.stringify(jobs.map((job) => ({
  id: job.id,
  itemId: job.itemId,
  purpose: job.purpose,
  providerId: job.providerId,
  model: job.model,
  parameters: job.parameters,
  references: job.references?.length ?? 0,
  expectedOutputPath: job.expectedOutputPath,
  publicationIntentId: job.publicationIntentId,
  status: job.status,
})), null, 2)}\n`);
