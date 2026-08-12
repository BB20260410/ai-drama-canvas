import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("Higgsfield Seedance 视频 UI", () => {
  it("独立步骤固定展示 Unlimited-only，按钮只会写本地队列而不直接提交", async () => {
    const source = await readFile(path.join(root, "src/renderer/src/components/HiggsfieldSeedanceVideoStep.vue"), "utf8");
    expect(source).toContain("Seedance 2.5 / omni_reference");
    expect(source).toContain("20 秒输出（时间线仅绑定 0–15 秒）");
    expect(source).toContain("网页有 Unlimited，但程序化 Seedance 2.5 Unlimited 暂不可用。 ".trim());
    expect(source).toContain("@click=\"queueVideo\"");
    expect(source).toContain("不回退 credits");
    expect(source).toContain("最多预览 6 张");
    expect(source).toContain("加入 Higgsfield 视频队列");
    expect(source).toContain("不会上传、调用网页或扣 credits");
    expect(source).toContain("不在此创建第二个图片 owner");
    expect(source).toContain("重新加入 Higgsfield 视频队列");
    expect(source).toContain('status === "blocked_by_provider"');
    expect(source).toContain("control?.availability === 'ready'");
  });

  it("MCP 只暴露控制面；写入口仍是 execute_command，且不包含 credits fallback", async () => {
    const source = await readFile(path.join(root, "src/mcp/server.ts"), "utf8");
    expect(source).toContain('"get_studio_video_generation_control"');
    expect(source).toContain("不会上传参考、调用生成、消耗 credits 或回退 priority 队列");
    expect(source).not.toContain('"submit_higgsfield');
    const effect = await readFile(path.join(root, "src/core/runtime-mcp-effect.ts"), "utf8");
    expect(effect).toContain('"get_studio_video_generation_control"');
  });

  it("已派发的正式图片 run 可从画布排入 Higgsfield 队列，按钮不直接调用 connector", async () => {
    const source = await readFile(path.join(root, "src/renderer/src/components/StudioGenerationControlView.vue"), "utf8");
    expect(source).toContain("用 Higgsfield 排队");
    expect(source).toContain("queueHiggsfieldImage(node)");
    expect(source).toContain('command: "enqueue_studio_higgsfield_connector_request"');
    expect(source).toContain('kind: "image", imageGenerationRunId: node.generationRunId');
    expect(source).toContain('executionAdapter: "higgsfield-connector"');
    expect(source).not.toContain('historyTargetKind.value !== "unit-grid" || duduProject.value !== true');
  });
});
