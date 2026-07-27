import { getProductionWorkflow, getStoryboard, upsertStoryboardRow } from "../src/core/production.js";
import { getProjectIndex } from "../src/core/service.js";
import { getSidecarPaths, writeJsonAtomic } from "../src/core/sidecar.js";
import type { ProductionWorkflowStageId } from "../src/core/types.js";

/** 测试夹具专用：用结构化正式分镜和已完成阶段准备媒体生产门禁。 */
export async function seedProductionReady(projectRoot: string, through: ProductionWorkflowStageId = "frames"): Promise<void> {
  const index = await getProjectIndex(projectRoot);
  const existing = await getStoryboard(projectRoot);
  const units = index.items.filter((item) => item.type === "unit");
  for (const unit of units) {
    const shots = index.items.filter((item) => item.type === "shot" && item.parentId === unit.id);
    const targets = shots.length ? shots : [undefined];
    for (const [position, shot] of targets.entries()) {
      if (existing.rows.some((row) => row.status === "confirmed" && row.itemId === unit.id && (shot ? row.shotItemId === shot.id : true))) continue;
      await upsertStoryboardRow(projectRoot, {
        itemId: unit.id,
        shotItemId: shot?.id,
        order: position + 1,
        durationSeconds: 15 / targets.length,
        shotSize: "中景",
        cameraMovement: "稳定推进",
        action: shot ? `执行 ${shot.title}` : `执行 ${unit.title}`,
        firstFramePrompt: `${shot?.title ?? unit.title} 首帧，电影写实，角色与资产连续。`,
        endFramePrompt: `${shot?.title ?? unit.title} 尾帧，电影写实，保持角色一致。`,
        videoPrompt: `${shot?.title ?? unit.title} 动作连续完成，保持镜头与角色一致。`,
        referencePaths: [],
        referenceArtifactIds: [],
        status: "confirmed",
      });
    }
  }
  const workflow = await getProductionWorkflow(projectRoot);
  const throughIndex = workflow.stages.findIndex((stage) => stage.id === through);
  const now = new Date().toISOString();
  workflow.stages = workflow.stages.map((stage, index_) => ({ ...stage, status: index_ <= throughIndex ? "completed" as const : "not_started" as const, updatedAt: now }));
  workflow.revision += 1;
  workflow.updatedAt = now;
  await writeJsonAtomic(getSidecarPaths(projectRoot).productionWorkflow, workflow);
}
