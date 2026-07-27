import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import {
  analyzeNovelChapters,
  exportAdaptation,
  generateAdaptationPlans,
  materializeSelectedAdaptationPlan,
  selectAdaptationPlan,
} from "../src/core/adaptation.js";
import { commitProjectImport, prepareProjectImport } from "../src/core/importer.js";
import { getStoryboard } from "../src/core/production.js";
import { getSidecarPaths } from "../src/core/sidecar.js";
import { getProjectIndex } from "../src/core/service.js";
import { importStoryFile } from "../src/core/story.js";
import { createNovelAnalysisTask, submitNovelAnalysisProposal } from "../src/core/novel-analysis.js";
import { executeNextNovelAnalysisRunTask, planNovelAnalysisRun, upsertNovelAnalysisProvider } from "../src/core/novel-analysis-provider.js";
import { resetOwnedFixtureRoot } from "./lib/owned-fixture-root.js";

const defaultSuffix = `${process.pid}-${randomUUID()}`;
const root = path.resolve(process.argv[2] || path.join(os.tmpdir(), `ai-canvas-novel-storyboard-${defaultSuffix}`));
const registryPath = path.resolve(process.argv[3] || path.join(os.tmpdir(), `ai-canvas-novel-storyboard-registry-${defaultSuffix}.json`));
process.env.AI_CANVAS_REGISTRY_PATH = registryPath;

await Promise.all([resetOwnedFixtureRoot(root, "create-novel-storyboard-fixture"), rm(registryPath, { force: true })]);
const novelPath = path.join(root, "01_测试小说.md");
await writeFile(novelPath, `# 第一章 雾河来客

清晨，阿航穿着黑袍走进雾河边的古老祭坛，浓雾贴着石阶缓慢流动。
嘟嘟守在门外，低声说：“别碰那副完整黄金面具。”
阿航想起师父的警告：完整黄金面具不得改成半面具，也不能遮掉一半脸。
忽然火光熄灭，水声从地底传来。阿航心中害怕，却仍伸手拿起黄金面具。
石门轰然关闭，嘟嘟冲进祭坛。阿航回头看向她，面具表面的金光照亮两人的脸。

# 第二章 门后回声

门后的黑暗里传来脚步声。嘟嘟举起火把，阿航将完整黄金面具护在胸前。
两人沿着右侧石壁前进，始终没有跨过中央裂缝。远处，一个披着祭司袍的人影停在雾中。
`, "utf8");

const preview = await prepareProjectImport({ primaryRoot: root, projectMode: "story_first", name: "雾河来客 · 小说自动分镜验收" });
if (!preview.canImport) throw new Error(`小说起步项目预检失败：${preview.issues.map((issue) => issue.message).join("；")}`);
await commitProjectImport({ previewId: preview.previewId, config: preview.config, projectMode: "story_first" });
const imported = await importStoryFile(root, novelPath, "雾河来客");
const analyzed = await analyzeNovelChapters(root, { expectedRevision: 0 });
const generated = await generateAdaptationPlans(root, { expectedRevision: analyzed.revision, episode: 1, startUnit: 1 });
const split = generated.plans.find((plan) => plan.mode === "split");
if (!split) throw new Error("没有生成拆分模式计划。 ");
const selected = await selectAdaptationPlan(root, split.id, generated.workspace.revision);
const materialized = await materializeSelectedAdaptationPlan(root, { expectedRevision: selected.revision });
const exportDirectory = path.join(root, "导出");
await mkdir(exportDirectory, { recursive: true });
const jsonPath = path.join(exportDirectory, "雾河来客_分镜_v001.json");
const markdownPath = path.join(exportDirectory, "雾河来客_分镜_v001.md");
await exportAdaptation(root, { format: "json", outputPath: jsonPath, planId: split.id });
await exportAdaptation(root, { format: "markdown", outputPath: markdownPath, planId: split.id });
let modelPendingReviews = 0;
let modelExecutionOutcome: string | undefined;
let modelRun: { runId: string; totalBatches: number; status: string } | undefined;
let currentRevision = materialized.workspace.revision;
if (process.env.AI_CANVAS_EXECUTE_MODEL_MOCK === "1") {
  await upsertNovelAnalysisProvider(root, { expectedRevision: 0, setAsDefault: true, provider: { id: "fixture-mock", name: "验收用本地模拟模型", adapter: "mock", enabled: true, model: "deterministic-fixture", allowPrivateNetwork: false, allowStoryUpload: false, useJsonResponseFormat: true, timeoutSeconds: 30, maxInputCharacters: 200_000, temperature: 0 } });
  const taskResult = await planNovelAnalysisRun(root, { expectedRevision: currentRevision, providerId: "fixture-mock", targetCharacters: 24_000 });
  const executed = await executeNextNovelAnalysisRunTask(root, { runId: taskResult.runId, expectedRevision: taskResult.workspace.revision });
  currentRevision = executed.workspace.revision;
  modelPendingReviews += executed.reviewCount;
  modelExecutionOutcome = executed.outcome;
  modelRun = { runId: taskResult.runId, totalBatches: taskResult.tasks.length, status: executed.progress.status };
}
if (process.env.AI_CANVAS_INCLUDE_MODEL_REVIEWS === "1") {
  const taskResult = await createNovelAnalysisTask(root, { expectedRevision: currentRevision, providerId: "codex", providerKind: "codex" });
  const chapter = taskResult.task.chapterRefs[0]!;
  const content = await readFile(chapter.path, "utf8");
  const evidenceText = "清晨，阿航穿着黑袍走进雾河边的古老祭坛，浓雾贴着石阶缓慢流动。";
  const startOffset = content.indexOf(evidenceText);
  const span = { sourceId: chapter.sourceId, chapterId: chapter.chapterId, chapterRevision: chapter.revision, chapterSha256: chapter.sha256, startOffset, endOffset: startOffset + evidenceText.length, text: evidenceText };
  const proposal = await submitNovelAnalysisProposal(root, {
    taskId: taskResult.task.id,
    expectedRevision: taskResult.workspace.revision,
    facts: [
      { id: "codex-arrival", kind: "event", epistemicStatus: "confirmed", statement: evidenceText, sourceSpans: [span], tags: ["Codex提案"] },
      { id: "codex-unsupported", kind: "event", epistemicStatus: "confirmed", statement: "阿航已经知道门后人物的身份。", sourceSpans: [{ ...span, text: "与原文不匹配的证据" }], tags: ["证据异常示例"] },
    ],
    beats: [],
  });
  modelPendingReviews += proposal.reviews.length;
  currentRevision = proposal.workspace.revision;
}
const [index, storyboard] = await Promise.all([getProjectIndex(root), getStoryboard(root)]);
const exported = JSON.parse(await readFile(jsonPath, "utf8"));

process.stdout.write(`${JSON.stringify({
  root,
  registryPath,
  sidecar: getSidecarPaths(root).root,
  novelPath,
  sourceId: imported.source.id,
  chapters: imported.chapters.length,
  facts: analyzed.facts.length,
  beats: analyzed.beats.length,
  conciseUnits: generated.plans.find((plan) => plan.mode === "concise")?.units.length ?? 0,
  splitUnits: split.units.length,
  materializedUnits: index.items.filter((item) => item.type === "unit").length,
  shots: storyboard.rows.length,
  storyboardValid: storyboard.valid,
  exportedPlanId: exported.plan.id,
  jsonPath,
  markdownPath,
  modelPendingReviews,
  modelExecutionOutcome,
  modelRun,
}, null, 2)}\n`);
