import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { getAdaptationWorkspace } from "../src/core/adaptation.js";
import { getEditProject, listVideoContinuationPacks } from "../src/core/editor.js";
import { listGenerationJobs } from "../src/core/generation.js";
import { getProductionWorkflow, getStoryboard } from "../src/core/production.js";
import { getProjectIndex } from "../src/core/service.js";

const [projectRootArg, editProjectId, planId, jsonPathArg, markdownPathArg, continuationId] = process.argv.slice(2);
if (!projectRootArg || !editProjectId || !planId || !jsonPathArg || !markdownPathArg || !continuationId) {
  throw new Error("用法：full-workflow-verify <projectRoot> <editProjectId> <planId> <jsonPath> <markdownPath> <continuationId>");
}

const projectRoot = path.resolve(projectRootArg);
const jsonPath = path.resolve(jsonPathArg);
const markdownPath = path.resolve(markdownPathArg);
const [index, adaptation, storyboard, editProject, continuations, generationJobs, workflow] = await Promise.all([
  getProjectIndex(projectRoot),
  getAdaptationWorkspace(projectRoot),
  getStoryboard(projectRoot),
  getEditProject(projectRoot, editProjectId),
  listVideoContinuationPacks(projectRoot),
  listGenerationJobs(projectRoot),
  getProductionWorkflow(projectRoot),
]);
await Promise.all([access(jsonPath), access(markdownPath)]);
const exportedJson = JSON.parse(await readFile(jsonPath, "utf8")) as { plan?: { id?: string } };
const exportedMarkdown = await readFile(markdownPath, "utf8");
const continuation = continuations.find((entry) => entry.id === continuationId);

const result = {
  projectId: index.project.id,
  selectedPlanId: adaptation.selectedPlanId,
  planRestored: adaptation.selectedPlanId === planId && exportedJson.plan?.id === planId,
  units: index.items.filter((item) => item.type === "unit").length,
  completedUnits: index.items.filter((item) => item.type === "unit" && item.status === "已完成").length,
  storyboardRows: storyboard.rows.length,
  confirmedStoryboardRows: storyboard.rows.filter((row) => row.status === "confirmed").length,
  storyboardValid: storyboard.valid,
  editProjectId: editProject.id,
  editRevision: editProject.revision,
  editClipCount: editProject.tracks.flatMap((track) => track.clips).length,
  timebase: editProject.timebase,
  continuationStatus: continuation?.status,
  continuationOutputPath: continuation?.outputVideoPath,
  succeededGenerationJobs: generationJobs.filter((job) => job.status === "succeeded").length,
  framesStage: workflow.stages.find((stage) => stage.id === "frames")?.status,
  jsonPath,
  markdownPath,
  markdownComplete: exportedMarkdown.length > 200 && exportedMarkdown.includes("镜头") && exportedMarkdown.includes(planId),
};

if (!result.planRestored) throw new Error("重启读取后改编计划或 JSON 导出不一致。 ");
if (!result.storyboardValid || result.storyboardRows < 2 || result.confirmedStoryboardRows !== result.storyboardRows) throw new Error("重启读取后正式分镜不完整。 ");
if (result.completedUnits < 1 || result.editClipCount < 2) throw new Error("重启读取后生产完成状态或剪辑分割未恢复。 ");
if (result.continuationStatus !== "completed" || !result.continuationOutputPath) throw new Error("重启读取后视频续接包未恢复为完成状态。 ");
if (result.framesStage !== "completed" || !result.markdownComplete) throw new Error(`重启读取后生产阶段或 Markdown 导出不完整：frames=${result.framesStage}，markdown=${result.markdownComplete}。`);
await access(result.continuationOutputPath);

process.stdout.write(`${JSON.stringify(result)}\n`);
