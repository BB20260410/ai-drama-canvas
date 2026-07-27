import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { enqueueGeneration, getBrowserGenerationPlan, processGenerationQueue, updateBrowserGenerationJob, upsertGenerationProvider } from "../src/core/generation.js";
import { doctorProject } from "../src/core/codex.js";
import { executeIdempotentCommand } from "../src/core/command-bus.js";
import {
  commitExistingProductionRecovery,
  getProductionWorkflow,
  previewExistingProductionRecovery,
} from "../src/core/production.js";
import { createTaskPack, getProjectIndex, scanAndPersist } from "../src/core/service.js";
import { ensureSidecar, getSidecarPaths, writeJsonAtomic } from "../src/core/sidecar.js";
import type { ExistingProductionRecoveryInput } from "../src/core/types.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-existing-production-"));
  roots.push(root);
  const config = await ensureSidecar(root);
  config.sourceRoots = [];
  config.outputRoots = [root];
  await writeJsonAtomic(getSidecarPaths(root).config, config);
  const directory = path.join(root, "EP01_15s_001_既有制作包");
  await mkdir(directory, { recursive: true });
  const infoPath = path.join(directory, "00_信息.md");
  await writeFile(infoPath, [
    "# 既有制作包",
    "首帧提示词：城门外的大远景，角色站在风中。",
    "尾帧提示词：镜头推进，角色回头。",
    "视频提示词：保持角色一致，缓慢推进。",
  ].join("\n"), "utf8");
  const referencePath = path.join(directory, "EP01_15s_001_首帧_raw.png");
  await sharp({ create: { width: 1280, height: 720, channels: 3, background: "#65503d" } }).png().toFile(referencePath);
  await scanAndPersist(root);
  const index = await getProjectIndex(root);
  const item = index.items.find((candidate) => candidate.id === "main-ep01-unit001")!;
  const reference = index.artifacts.find((artifact) => artifact.path === referencePath)!;
  const recovery: ExistingProductionRecoveryInput = {
    itemIds: [item.id],
    allowedTargets: ["image"],
    contracts: [{
      itemId: item.id,
      order: 1,
      durationSeconds: 15,
      shotSize: "大远景",
      cameraMovement: "缓慢推进",
      action: "角色站在城门外的风中，随后回头",
      firstFramePrompt: "城门外的大远景，角色站在风中。",
      endFramePrompt: "镜头推进，角色回头。",
      videoPrompt: "保持角色一致，缓慢推进。",
      referencePaths: [referencePath],
      referenceArtifactIds: [reference.id],
    }],
    note: "采用已有制作包中的单个真实单元，仅授权图片返工。",
  };
  return { root, item, reference, referencePath, infoPath, recovery };
}

describe("既有制作包 scoped recovery", () => {
  it("普通 revision 0 项目继续被硬门禁拒绝；预检零写入，提交后仅冻结 scope 可入队", async () => {
    const { root, item, referencePath, recovery } = await fixture();
    const workflowPath = getSidecarPaths(root).productionWorkflow;

    await expect(enqueueGeneration(root, { itemIds: [item.id], kind: "image", prompt: "显式返工提示词" }))
      .rejects.toThrow("生产工作流门禁未通过");
    await expect(access(workflowPath)).rejects.toThrow();
    const doctorBefore = await doctorProject(root);
    expect(doctorBefore.healthy).toBe(false);
    expect(doctorBefore.checks).toContainEqual(expect.objectContaining({ id: "existing-production-recovery", level: "error" }));
    expect(doctorBefore.suggestedNextCalls).toContain("preview_existing_production_recovery");

    const preview = await previewExistingProductionRecovery(root, recovery);
    expect(preview).toMatchObject({
      schemaVersion: 1,
      ready: true,
      expectedWorkflowRevision: 0,
      itemIds: [item.id],
      allowedTargets: ["image"],
    });
    expect(preview.previewId).toMatch(/^[a-f0-9]{64}$/);
    expect(preview.evidence.items[0]).toMatchObject({ itemId: item.id, infoPath: expect.any(String), referencePaths: [referencePath] });
    await expect(access(workflowPath)).rejects.toThrow();

    const committed = await commitExistingProductionRecovery(root, {
      ...recovery,
      previewId: preview.previewId,
      expectedWorkflowRevision: preview.expectedWorkflowRevision,
    });
    expect(committed.revision).toBe(1);
    expect(committed.existingProductionBaselines).toHaveLength(1);
    expect(committed.existingProductionBaselines?.[0]).toMatchObject({
      digest: preview.previewId,
      itemIds: [item.id],
      allowedTargets: ["image"],
    });
    expect(committed.stages.every((stage) => stage.status === "not_started")).toBe(true);
    const doctorAfter = await doctorProject(root);
    expect(doctorAfter.healthy).toBe(true);
    expect(doctorAfter.checks).toContainEqual(expect.objectContaining({ id: "existing-production-recovery", level: "warning" }));
    expect(doctorAfter.suggestedNextCalls).toContain("enqueue_generation");
    const { task } = await createTaskPack(root, { itemIds: [item.id], kind: "image" });
    expect(task.itemSnapshots[0]?.storyboardRows[0]).toMatchObject({ shotSize: "大远景", cameraMovement: "缓慢推进" });

    const [job] = await enqueueGeneration(root, { itemIds: [item.id], kind: "image", prompt: "显式返工提示词" });
    expect(job).toMatchObject({
      itemId: item.id,
      kind: "image",
      prompt: "显式返工提示词",
      existingProductionBaselineId: committed.existingProductionBaselines?.[0]?.id,
      existingProductionBaselineDigest: preview.previewId,
    });
    expect(job?.storyboardRows).toHaveLength(1);
    expect(job?.storyboardRows[0]).toMatchObject({ shotSize: "大远景", cameraMovement: "缓慢推进" });
    expect(job?.referencePaths).toContain(referencePath);
  });

  it("预检后证据漂移会拒绝提交，提交后的参考图漂移会拒绝真正入队", async () => {
    const first = await fixture();
    const firstPreview = await previewExistingProductionRecovery(first.root, first.recovery);
    await writeFile(first.infoPath, `${await readFile(first.infoPath, "utf8")}\n新增但未复核的现场修改。\n`, "utf8");
    await expect(commitExistingProductionRecovery(first.root, {
      ...first.recovery,
      previewId: firstPreview.previewId,
      expectedWorkflowRevision: firstPreview.expectedWorkflowRevision,
    })).rejects.toThrow("接管预检已经过期");
    expect((await getProductionWorkflow(first.root)).revision).toBe(0);

    const second = await fixture();
    const secondPreview = await previewExistingProductionRecovery(second.root, second.recovery);
    await commitExistingProductionRecovery(second.root, {
      ...second.recovery,
      previewId: secondPreview.previewId,
      expectedWorkflowRevision: secondPreview.expectedWorkflowRevision,
    });
    await sharp({ create: { width: 1280, height: 720, channels: 3, background: "#992f2f" } }).png().toFile(second.referencePath);
    await expect(enqueueGeneration(second.root, { itemIds: [second.item.id], kind: "image" }))
      .rejects.toThrow("既有制作包接管基线真实证据已失效");
  });

  it("scope 不会扩张到未接管节点或普通视频，workflow CAS 拒绝旧修订提交", async () => {
    const { root, item, recovery } = await fixture();
    const secondDirectory = path.join(root, "EP01_15s_002_未接管单元");
    await mkdir(secondDirectory, { recursive: true });
    await writeFile(path.join(secondDirectory, "00_信息.md"), "首帧提示词：未接管。\n尾帧提示词：未接管。\n", "utf8");
    await scanAndPersist(root);
    const preview = await previewExistingProductionRecovery(root, recovery);
    await commitExistingProductionRecovery(root, { ...recovery, previewId: preview.previewId, expectedWorkflowRevision: 0 });

    await expect(commitExistingProductionRecovery(root, { ...recovery, previewId: preview.previewId, expectedWorkflowRevision: 0 }))
      .rejects.toMatchObject({ name: "RejectedCommandFailure", result: { reason: "revision_conflict", currentRevision: 1 } });
    await expect(enqueueGeneration(root, { itemIds: ["main-ep01-unit002"], kind: "image" }))
      .rejects.toThrow("生产工作流门禁未通过");
    await expect(createTaskPack(root, { itemIds: ["main-ep01-unit002"], kind: "image" }))
      .rejects.toThrow("生产工作流门禁未通过");
    await expect(enqueueGeneration(root, { itemIds: [item.id], kind: "video" }))
      .rejects.toThrow("生产工作流门禁未通过");
  });

  it("提交经命令账本幂等重放，且同一幂等键拒绝不同 recovery 参数", async () => {
    const { root, recovery } = await fixture();
    const preview = await previewExistingProductionRecovery(root, recovery);
    const request = {
      command: "commit_existing_production_recovery" as const,
      payload: {
        ...recovery,
        previewId: preview.previewId,
        expectedWorkflowRevision: preview.expectedWorkflowRevision,
      },
    };
    const first = await executeIdempotentCommand(root, {
      requestId: "request-existing-recovery-0001",
      idempotencyKey: "existing-recovery-main-ep01-unit001-v1",
      request,
    });
    const replay = await executeIdempotentCommand(root, {
      requestId: "request-existing-recovery-0002",
      idempotencyKey: "existing-recovery-main-ep01-unit001-v1",
      request,
    });
    expect(first).toMatchObject({ status: "succeeded", replayed: false });
    expect(replay).toMatchObject({ status: "succeeded", replayed: true, requestHash: first.requestHash });
    expect((await getProductionWorkflow(root)).revision).toBe(1);
    await expect(executeIdempotentCommand(root, {
      requestId: "request-existing-recovery-0003",
      idempotencyKey: "existing-recovery-main-ep01-unit001-v1",
      request: { ...request, payload: { ...request.payload, note: "不同参数不得复用旧键" } },
    })).rejects.toThrow("幂等键已用于不同参数");
  });

  it("网页计划与每个检查点都会复验 Job 冻结的 baseline，漂移后禁止远端副作用", async () => {
    const { root, item, referencePath, recovery } = await fixture();
    const preview = await previewExistingProductionRecovery(root, recovery);
    await commitExistingProductionRecovery(root, { ...recovery, previewId: preview.previewId, expectedWorkflowRevision: 0 });
    await upsertGenerationProvider(root, {
      expectedRevision: 0,
      provider: {
        id: "existing-recovery-browser",
        name: "既有制作包网页校准",
        adapter: "codex-browser",
        kinds: ["image"],
        enabled: true,
        siteUrl: "https://example.com/generate",
        browserInstructions: "只上传 baseline 白名单文件。",
        outputRoot: root,
      },
    });
    const [queued] = await enqueueGeneration(root, {
      itemIds: [item.id],
      kind: "image",
      providerId: "existing-recovery-browser",
      prompt: "网页 baseline 复验",
    });
    await processGenerationQueue(root, { jobId: queued!.id });
    const plan = await getBrowserGenerationPlan(root, queued!.id);
    expect(plan.currentCheckpoint).toMatchObject({ stage: "plan_ready", revision: 1 });
    expect(plan.parameters.mode).toBe("first_frame");
    expect(plan.allowedUploads).toEqual([
      expect.objectContaining({
        path: referencePath,
        role: "first_frame",
        order: 0,
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    ]);
    expect(plan.allowedUploadPaths).toEqual([referencePath]);

    await sharp({ create: { width: 1280, height: 720, channels: 3, background: "#27191f" } }).png().toFile(referencePath);
    await expect(getBrowserGenerationPlan(root, queued!.id)).rejects.toThrow("既有制作包接管基线真实证据已失效");
    await expect(updateBrowserGenerationJob(root, queued!.id, {
      expectedRevision: 1,
      status: "preflight",
      note: "域名与登录态已核对",
      preflightEvidence: {
        observedHost: "example.com",
        loginVerified: true,
        pageReady: true,
        generationModeVerified: true,
        balanceChecked: true,
        paidActionRequired: false,
        paidActionAuthorized: false,
      },
    })).rejects.toThrow("既有制作包接管基线真实证据已失效");
  });
});
