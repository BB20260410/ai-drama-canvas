import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { inspectFusionPackage, type FusionPackageExpectedCounts } from "../src/core/fusion-package.js";
import { materializeFusionPanelReferenceResolutions } from "../src/core/fusion-panel-references.js";
import { materializeFusionProject } from "../src/core/fusion-production.js";
import { buildFusionStoryboardGridForProject } from "../src/core/fusion-storyboard-production.js";
import {
  getFusionPanelVisualConstraint,
  materializeFusionPanelVisualConstraints,
  upsertFusionPanelVisualPresenceOverride,
} from "../src/core/fusion-visual-constraint-store.js";
import {
  FUSION_BROWSER_GENERIC_INSTRUCTIONS,
  FUSION_SUBAGENT_GENERIC_INSTRUCTIONS,
  enqueueFusionStoryboardPanel,
  getBrowserGenerationPlan,
  getGenerationSettings,
  getSubagentImageGenerationPlan,
  listGenerationJobs,
  processGenerationQueue,
  updateSubagentImageGenerationJob,
  upsertGenerationProvider,
  type GenerationProviderUpsert,
} from "../src/core/generation.js";
import { scanAndPersist } from "../src/core/service.js";
import { getSidecarPaths } from "../src/core/sidecar.js";
import type { BrowserGenerationPlan, GenerationJob, SubagentImageGenerationPlan } from "../src/core/types.js";

const roots: string[] = [];

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

const EXPECTED: FusionPackageExpectedCounts = {
  episodes: 1,
  units: 1,
  sourceShots: 2,
  scheduleRows: 3,
  assets: 3,
  characters: 1,
  scenes: 1,
  props: 1,
  standardDurationSeconds: 15,
};

const FINGERPRINT_DRIFT = "f".repeat(64);
const HIDDEN_MASK_IDENTITY_OR_APPEARANCE = /(?:黄金面具|完整面具|半面具|裂面具|面具口型|青铜面具|金色面具|面具)/iu;
const LOCAL_PATH = /(?:file:\/\/|\/(?:Users|private|tmp|var|read-only)\/)/iu;

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([key, entry]) => [key, stableValue(entry)]));
}

function stableFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
}

function assertSafeModelText(prompt: string, instructions: string | undefined): void {
  const modelText = `${prompt}\n${instructions ?? ""}`;
  expect(modelText).not.toMatch(HIDDEN_MASK_IDENTITY_OR_APPEARANCE);
  expect(modelText).not.toMatch(LOCAL_PATH);
  expect(modelText).not.toMatch(/[a-f0-9]{64}/iu);
}

function subagentProvider(projectRoot: string, instructions: string): GenerationProviderUpsert {
  return {
    id: "codex-subagent-gpt-image-2-p3",
    name: "P3 一图一子代理",
    adapter: "codex-subagent-imagegen",
    kinds: ["image"],
    enabled: true,
    model: "GPT Image 2",
    subagentInstructions: instructions,
    capabilities: {
      referenceModes: ["text", "multi_image"],
      maxReferenceImages: 6,
      maxReferenceVideos: 0,
      supportedDurations: [],
      supportedAspectRatios: ["9:16"],
      supportedResolutions: ["Medium"],
      models: ["GPT Image 2"],
      maxConcurrency: 1,
      supportsCancel: false,
    },
    outputRoot: projectRoot,
  };
}

async function writeAuthorityImage(filePath: string): Promise<string> {
  const pixels = Buffer.allocUnsafe(720 * 1280 * 3);
  let state = 0x754a2d31;
  for (let index = 0; index < pixels.length; index += 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    pixels[index] = state & 0xff;
  }
  const bytes = await sharp(pixels, { raw: { width: 720, height: 1280, channels: 3 } })
    .png({ compressionLevel: 0 })
    .toBuffer();
  await writeFile(filePath, bytes);
  return createHash("sha256").update(bytes).digest("hex");
}

async function createFusionSourceFixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "ai-canvas-p3-generation-")));
  roots.push(root);
  const sourceRoot = path.join(root, "source");
  const targetParent = path.join(root, "targets");
  const packageRoot = path.join(sourceRoot, "07_9x16_15秒融合制作包");
  const unitRelative = "蜀道山古蜀卷第三季_EP01_测试_9x16_漫剧/04_15秒融合分镜/EP01_15s_001_测试.md";
  await Promise.all([
    mkdir(path.join(packageRoot, path.dirname(unitRelative)), { recursive: true }),
    mkdir(path.join(sourceRoot, "05_提示词"), { recursive: true }),
    mkdir(path.join(sourceRoot, "01_剧本"), { recursive: true }),
    mkdir(targetParent, { recursive: true }),
  ]);
  const assets = `# 全季资产库

### C01 阿航

- **出场集数**：EP01
- **AI 出图提示词**：
  电影级写实青年。

### S01 山路

- **出场集数**：EP01
- **AI 出图提示词**：
  商周山路。

### P01 布囊

- **出场集数**：EP01
- **AI 出图提示词**：
  不透明素麻布囊。
`;
  const promptTable = `# EP01 提示词

#### 镜01 [8s] 【中景】（24帧）
**参考素材**：@C01 阿航、@S01 山路
【参考】@图片1=C01，@图片2=S01。

#### 镜02 [5s] 【特写】（24帧）
**参考素材**：@C01 阿航、@P01 布囊
【参考】@图片1=C01，@图片2=P01。
`;
  const unitMarkdown = `# EP01 15s-001｜测试

## 3. 机位 / 焦段 / 运镜

| 原镜 | 景别 | 焦段 | 机位 | 运镜 | 帧率 | 备注 |
|---|---|---|---|---|---|---|
| 镜01 | 中景 | 50mm | 平视 | 侧移 | 24 | 起幅 |
| 镜02 | 特写 | 85mm | 低机位 | 跟随 | 24 | 收束 |

## 4. 人物 / 道具站位

参考 C01、S01、P01。

## 7. 首帧生图提示词

电影级写实，9:16，阿航站在山路起幅。

## 8. 图生视频中文提示词

按时间段执行。

### 原镜01 视频提示词

参考素材：@C01、@S01。
电影级写实，阿航沿山路行进。
尾帧：阿航走到山路转角。

### 原镜02 视频提示词

参考素材：@C01、@P01。
电影级写实，阿航按住不透明布囊。
尾帧：布囊保持不透明，阿航停步。

## 9. 生成注意事项

禁止露出内部物品。
`;
  const units = [{
    id: "EP01_15s_001",
    episode: "EP01",
    episode_title: "测试",
    unit_title: "测试",
    md_path: unitRelative,
    source_script: "01_剧本/第三季_EP01_测试.md",
    source_prompt_table: "05_提示词/第三季_EP01_提示词表.md",
    source_shots: [1, 2],
    source_duration_seconds: 13,
    standard_duration_seconds: 15,
    aspect_ratio: "9:16",
    story_goal: "测试连续性",
    schedule: [
      { start: 0, end: 8, shot: "镜01", seconds: 8, content: "阿航沿山路行进" },
      { start: 8, end: 13, shot: "镜02", seconds: 5, content: "阿航按住布囊" },
      { start: 13, end: 15, shot: "扩写补足", seconds: 2, content: "动作收束，不新增剧情" },
    ],
    asset_ids: ["C01", "S01", "P01"],
    reference_image_paths: [],
    validation: { source_order_preserved: true, source_duration_lte_15: true, no_compression: true },
  }];
  await Promise.all([
    writeFile(path.join(packageRoot, "15s_fused_units.json"), `${JSON.stringify(units, null, 2)}\n`, "utf8"),
    writeFile(path.join(packageRoot, unitRelative), unitMarkdown, "utf8"),
    writeFile(path.join(sourceRoot, "05_提示词", "00_全季资产库.md"), assets, "utf8"),
    writeFile(path.join(sourceRoot, "05_提示词", "第三季_EP01_提示词表.md"), promptTable, "utf8"),
    writeFile(path.join(sourceRoot, "01_剧本", "第三季_EP01_测试.md"), "# EP01 测试剧本\n", "utf8"),
  ]);
  const authorityPath = path.join(root, "测试权威图.png");
  const authoritySha256 = await writeAuthorityImage(authorityPath);
  const inspection = await inspectFusionPackage({ packageRoot, sourceRoot, expectedCounts: EXPECTED });
  return { root, sourceRoot, packageRoot, targetParent, authorityPath, authoritySha256, inspection };
}

async function setupP3Project() {
  const fixture = await createFusionSourceFixture();
  const created = await materializeFusionProject({
    inspection: fixture.inspection,
    targetParent: fixture.targetParent,
    authorities: ["C01", "S01", "P01"].map((assetId) => ({
      id: `authority-${assetId.toLowerCase()}`,
      assetId,
      name: `${assetId} 测试权威图`,
      sourcePath: fixture.authorityPath,
      expectedSha256: fixture.authoritySha256,
      rules: ["P3 生图安全定向测试硬锁"],
      exposeToGeneration: true,
    })),
  });
  await scanAndPersist(created.targetRoot);
  const itemId = "season-三-ep01-unit001";
  const contract = await buildFusionStoryboardGridForProject(created.targetRoot, itemId);
  await materializeFusionPanelReferenceResolutions(created.targetRoot);
  const store = await materializeFusionPanelVisualConstraints(created.targetRoot);
  const panel = contract.panels.find((candidate) => candidate.assetIds.includes("P01"));
  if (!panel) throw new Error("P3 定向夹具缺少含 P01 的宫格。");
  const constraint = await getFusionPanelVisualConstraint(created.targetRoot, contract.contractId, panel.id);
  expect(constraint.generationGate.status).toBe("ready");
  expect(constraint.hiddenMaskPolicy.status).toBe("concealed");
  return { fixture, created, itemId, contract, panel, constraint, store };
}

async function addSubagentProvider(projectRoot: string, instructions = FUSION_SUBAGENT_GENERIC_INSTRUCTIONS) {
  const settings = await getGenerationSettings(projectRoot);
  return upsertGenerationProvider(projectRoot, {
    expectedRevision: settings.revision,
    concurrency: 1,
    provider: subagentProvider(projectRoot, instructions),
  }, "codex");
}

async function createBrowserPlan(project: Awaited<ReturnType<typeof setupP3Project>>) {
  const enqueued = await enqueueFusionStoryboardPanel(project.created.targetRoot, {
    itemId: project.itemId,
    contractId: project.contract.contractId,
    panelIndex: project.panel.index,
  });
  await processGenerationQueue(project.created.targetRoot, { jobId: enqueued.id });
  const job = (await listGenerationJobs(project.created.targetRoot)).find((candidate) => candidate.id === enqueued.id)!;
  return { job, plan: await getBrowserGenerationPlan(project.created.targetRoot, job.id) };
}

function requestPlanWithFreshFingerprint<T extends BrowserGenerationPlan | SubagentImageGenerationPlan>(plan: T): T {
  const { requestPlanFingerprint: _old, ...base } = plan;
  return { ...plan, requestPlanFingerprint: stableFingerprint(base) };
}

describe("P3 生图安全载荷与漂移失败关闭", () => {
  it("browser 与 subagent 计划只暴露安全模型载荷，EP32 前不泄露本地路径或隐藏身份", async () => {
    const project = await setupP3Project();
    const { job, plan: browserPlan } = await createBrowserPlan(project);
    expect(browserPlan.instructions).toBe(FUSION_BROWSER_GENERIC_INSTRUCTIONS);
    expect(browserPlan).toMatchObject({
      panelVisualConstraintId: project.constraint.constraintId,
      panelVisualConstraintFingerprint: project.constraint.fingerprint,
      panelVisualModelFingerprint: project.constraint.modelFingerprint,
      panelVisualReviewRulesFingerprint: project.constraint.reviewRulesFingerprint,
    });
    assertSafeModelText(browserPlan.prompt, browserPlan.instructions);
    expect(browserPlan.allowedUploads.length).toBeGreaterThan(0);
    for (const upload of browserPlan.allowedUploads) {
      expect(browserPlan.prompt).not.toContain(upload.path);
      expect(browserPlan.instructions).not.toContain(upload.path);
    }

    const settings = await addSubagentProvider(project.created.targetRoot);
    await updateSubagentImageGenerationJob(project.created.targetRoot, job.id, {
      expectedRevision: 1,
      expectedSettingsRevision: settings.revision,
      status: "migrate_plan",
      targetProviderId: "codex-subagent-gpt-image-2-p3",
      note: "P3 载荷安全测试：零网页副作用迁移。",
    });
    const subagentPlan = await getSubagentImageGenerationPlan(project.created.targetRoot, job.id);
    expect(subagentPlan.subagentInstructions).toBe(FUSION_SUBAGENT_GENERIC_INSTRUCTIONS);
    expect(subagentPlan).toMatchObject({
      panelVisualConstraintId: project.constraint.constraintId,
      panelVisualConstraintFingerprint: project.constraint.fingerprint,
      panelVisualModelFingerprint: project.constraint.modelFingerprint,
      panelVisualReviewRulesFingerprint: project.constraint.reviewRulesFingerprint,
    });
    assertSafeModelText(subagentPlan.prompt, subagentPlan.subagentInstructions);
    for (const reference of subagentPlan.allowedReferences) {
      expect(subagentPlan.prompt).not.toContain(reference.path);
      expect(subagentPlan.subagentInstructions).not.toContain(reference.path);
    }
  });

  it("计划、checkpoint、Job 或当前 constraint/model 指纹漂移均拒绝继续", async () => {
    const project = await setupP3Project();
    const { job, plan } = await createBrowserPlan(project);
    const paths = getSidecarPaths(project.created.targetRoot);
    const originalPlanText = await readFile(job.requestPath!, "utf8");
    const originalJobsText = await readFile(paths.generationJobs, "utf8");

    const driftedPlan = requestPlanWithFreshFingerprint({ ...plan, panelVisualModelFingerprint: FINGERPRINT_DRIFT });
    await writeFile(job.requestPath!, `${JSON.stringify(driftedPlan, null, 2)}\n`, "utf8");
    await expect(getBrowserGenerationPlan(project.created.targetRoot, job.id))
      .rejects.toThrow(/P3|模型约束|视觉约束|身份/u);
    await writeFile(job.requestPath!, originalPlanText, "utf8");

    const checkpointJobs = JSON.parse(originalJobsText) as GenerationJob[];
    checkpointJobs.find((candidate) => candidate.id === job.id)!.browserCheckpoint!.panelVisualReviewRulesFingerprint = FINGERPRINT_DRIFT;
    await writeFile(paths.generationJobs, `${JSON.stringify(checkpointJobs, null, 2)}\n`, "utf8");
    await expect(getBrowserGenerationPlan(project.created.targetRoot, job.id))
      .rejects.toThrow(/检查点|P3|视觉约束/u);
    await writeFile(paths.generationJobs, originalJobsText, "utf8");

    const jobDrift = JSON.parse(originalJobsText) as GenerationJob[];
    jobDrift.find((candidate) => candidate.id === job.id)!.fusionStoryboardPanel!.panelVisualConstraintFingerprint = FINGERPRINT_DRIFT;
    await writeFile(paths.generationJobs, `${JSON.stringify(jobDrift, null, 2)}\n`, "utf8");
    await expect(getBrowserGenerationPlan(project.created.targetRoot, job.id))
      .rejects.toThrow(/P3|视觉约束|失效|执行快照/u);
    await writeFile(paths.generationJobs, originalJobsText, "utf8");

    const p01 = project.constraint.assetPresence.find((entry) => entry.assetId === "P01")!;
    expect(p01.presence).toBe("on-screen");
    const nextStore = await upsertFusionPanelVisualPresenceOverride(project.created.targetRoot, {
      contractId: project.contract.contractId,
      panelId: project.panel.id,
      assetId: "P01",
      expectedStoreRevision: project.store.revision,
      expectedConstraintId: project.constraint.constraintId,
      expectedResolutionId: project.constraint.inputSnapshot.resolutionId,
      expectedBindingId: p01.bindingId,
      presence: "continuity-only",
      reason: "定向测试：模拟经审核的入画状态修订",
    });
    const current = nextStore.constraints[`${project.contract.contractId}:${project.panel.id}`]!;
    expect(current.fingerprint).not.toBe(project.constraint.fingerprint);
    expect(current.modelFingerprint).not.toBe(project.constraint.modelFingerprint);
    await expect(getBrowserGenerationPlan(project.created.targetRoot, job.id))
      .rejects.toThrow(/P3|视觉约束|失效|漂移/u);
  });

  it("lease 与 call intent 任一 P3 指纹漂移都会在模型执行面失败关闭", async () => {
    const project = await setupP3Project();
    await addSubagentProvider(project.created.targetRoot);
    const job = await enqueueFusionStoryboardPanel(project.created.targetRoot, {
      itemId: project.itemId,
      contractId: project.contract.contractId,
      panelIndex: project.panel.index,
      providerId: "codex-subagent-gpt-image-2-p3",
    });
    await processGenerationQueue(project.created.targetRoot, { jobId: job.id });
    const claimed = await updateSubagentImageGenerationJob(project.created.targetRoot, job.id, {
      expectedRevision: 1,
      status: "claim",
      agentTaskName: "/root/p3_generation_guard",
    });
    const lease = claimed.subagentCheckpoint!.lease!;
    await updateSubagentImageGenerationJob(project.created.targetRoot, job.id, {
      expectedRevision: 2,
      status: "start_call",
      agentTaskName: "/root/p3_generation_guard",
      owner: "/root/p3_generation_guard",
      leaseId: lease.leaseId,
      fence: lease.fence,
      runId: "p3-run-fingerprint-guard",
      callId: "p3-call-fingerprint-guard",
    });

    const jobsPath = getSidecarPaths(project.created.targetRoot).generationJobs;
    const originalJobsText = await readFile(jobsPath, "utf8");
    const leaseDrift = JSON.parse(originalJobsText) as GenerationJob[];
    leaseDrift.find((candidate) => candidate.id === job.id)!.subagentCheckpoint!.lease!.panelVisualModelFingerprint = FINGERPRINT_DRIFT;
    await writeFile(jobsPath, `${JSON.stringify(leaseDrift, null, 2)}\n`, "utf8");
    await expect(getSubagentImageGenerationPlan(project.created.targetRoot, job.id))
      .rejects.toThrow(/租约|调用意图|P3|视觉约束/u);
    await writeFile(jobsPath, originalJobsText, "utf8");

    const callDrift = JSON.parse(originalJobsText) as GenerationJob[];
    callDrift.find((candidate) => candidate.id === job.id)!.subagentCheckpoint!.callIntent!.panelVisualReviewRulesFingerprint = FINGERPRINT_DRIFT;
    await writeFile(jobsPath, `${JSON.stringify(callDrift, null, 2)}\n`, "utf8");
    await expect(getSubagentImageGenerationPlan(project.created.targetRoot, job.id))
      .rejects.toThrow(/租约|调用意图|P3|视觉约束/u);
  });

  it("项目级不安全供应商说明在迁移与领取调用租约之前均失败关闭", async () => {
    const project = await setupP3Project();
    const { job } = await createBrowserPlan(project);
    const unsafe = "固定阿航与黄金面具外观，并读取 /Users/hxx/Desktop/authorities/C01.png 后再调用模型。";
    const unsafeSettings = await addSubagentProvider(project.created.targetRoot, unsafe);
    await expect(updateSubagentImageGenerationJob(project.created.targetRoot, job.id, {
      expectedRevision: 1,
      expectedSettingsRevision: unsafeSettings.revision,
      status: "migrate_plan",
      targetProviderId: "codex-subagent-gpt-image-2-p3",
      note: "不安全迁移应在写入前失败。",
    })).rejects.toThrow(/项目级|人物|道具|路径|身份|P3/u);
    const unchanged = (await listGenerationJobs(project.created.targetRoot)).find((candidate) => candidate.id === job.id)!;
    expect(unchanged).toMatchObject({ providerId: job.providerId, browserCheckpoint: { stage: "plan_ready", revision: 1 } });
    expect(unchanged.subagentCheckpoint).toBeUndefined();

    const safeSettings = await upsertGenerationProvider(project.created.targetRoot, {
      expectedRevision: unsafeSettings.revision,
      concurrency: 1,
      provider: subagentProvider(project.created.targetRoot, FUSION_SUBAGENT_GENERIC_INSTRUCTIONS),
    }, "codex");
    await updateSubagentImageGenerationJob(project.created.targetRoot, job.id, {
      expectedRevision: 1,
      expectedSettingsRevision: safeSettings.revision,
      status: "migrate_plan",
      targetProviderId: "codex-subagent-gpt-image-2-p3",
      note: "安全通用合同允许迁移。",
    });
    const reconfigured = await upsertGenerationProvider(project.created.targetRoot, {
      expectedRevision: safeSettings.revision,
      concurrency: 1,
      provider: subagentProvider(project.created.targetRoot, unsafe),
    }, "codex");
    expect(reconfigured.revision).toBeGreaterThan(safeSettings.revision);
    await expect(updateSubagentImageGenerationJob(project.created.targetRoot, job.id, {
      expectedRevision: 1,
      status: "claim",
      agentTaskName: "/root/unsafe_provider_must_not_call",
    })).rejects.toThrow(/项目级|人物|道具|路径|身份|P3/u);
    const blocked = (await listGenerationJobs(project.created.targetRoot)).find((candidate) => candidate.id === job.id)!;
    expect(blocked).toMatchObject({
      providerId: "codex-subagent-gpt-image-2-p3",
      subagentCheckpoint: { stage: "plan_ready", revision: 1 },
    });
    expect(blocked.subagentCheckpoint?.lease).toBeUndefined();
    expect(blocked.subagentCheckpoint?.callIntent).toBeUndefined();
  });
});
