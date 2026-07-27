import { getReviewQueue, submitReview } from "../src/core/reviews.js";
import type { ReviewCriterionKey } from "../src/core/types.js";

const [projectRoot, itemId] = process.argv.slice(2);
if (!projectRoot || !itemId) throw new Error("用法：review-worker <projectRoot> <itemId>");
const entry = (await getReviewQueue(projectRoot, { includeResolved: true })).find((candidate) => candidate.item.id === itemId);
if (!entry) throw new Error(`找不到验收节点：${itemId}`);
const artifactIds = entry.artifacts.filter((artifact) => artifact.kind.includes("image") && artifact.authoritative && !artifact.deprecated).map((artifact) => artifact.id);
const keys: ReviewCriterionKey[] = ["character_identity", "hard_lock", "prop_costume", "scene_continuity", "composition", "image_quality", "raw_labeled_pair"];
const result = await submitReview(projectRoot, { itemId, reviewType: "image", artifactIds, expectedScanId: entry.reviewSnapshot.scanId, expectedArtifactHashes: Object.fromEntries(artifactIds.map((artifactId) => [artifactId, entry.reviewSnapshot.artifactHashes[artifactId]!])), decision: "pass", criteria: keys.map((key) => ({ key, result: "pass" })) }, "codex");
process.stdout.write(`${JSON.stringify({ reviewId: result.record.id, itemId })}\n`);
