import { createHash } from "node:crypto";
import { access, copyFile, cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { inspectFusionPackage, type FusionPackageExpectedCounts } from "../src/core/fusion-package.js";
import { materializeFusionProject } from "../src/core/fusion-production.js";
import { buildFusionReferenceBoard } from "../src/core/fusion-references.js";
import { buildFusionStoryboardGridForProject, loadCurrentFusionStoryboardGrid, materializeAllFusionStoryboardGrids, renderCompletedFusionStoryboardSheetForProject } from "../src/core/fusion-storyboard-production.js";
import { cancelGenerationJob, enqueueFusionStoryboardPanel, enqueueGeneration, getBrowserGenerationPlan, getGenerationSettings, getSubagentImageGenerationPlan, processGenerationQueue, updateBrowserGenerationJob, updateSubagentImageGenerationJob, upsertGenerationProvider } from "../src/core/generation.js";
import { cancelPublication, getPublicationIntent, listPublicationIntents, preflightPublication, registerPublication, registerPublicationBundle } from "../src/core/publication.js";
import { getSidecarPaths } from "../src/core/sidecar.js";
import { scanAndPersist } from "../src/core/service.js";
import { getReviewQueue, submitReview } from "../src/core/reviews.js";
import { migrateFusionStoryboardEvidence } from "../src/core/fusion-storyboard-migration.js";
import { loadFusionStoryboardEvidenceSnapshot } from "../src/core/fusion-storyboard-evidence.js";
import { getFusionStoryboardSheetState } from "../src/core/fusion-storyboard-sheet-evidence.js";
import { doctorProject, getProjectSnapshot } from "../src/core/codex.js";
import {
  getFusionPanelReferenceResolution,
  inspectFusionPanelReferenceCurrentness,
  materializeFusionPanelReferenceResolutions,
  registerDerivedPanelReferenceArtifact,
  upsertPanelReferenceOverride,
} from "../src/core/fusion-panel-references.js";
import { materializeFusionPanelVisualConstraints } from "../src/core/fusion-visual-constraint-store.js";

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

const IMAGE_REVIEW_CRITERIA = [
  "character_identity",
  "hard_lock",
  "prop_costume",
  "scene_continuity",
  "composition",
  "image_quality",
  "raw_labeled_pair",
] as const;

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "ai-canvas-fusion-production-")));
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
  const prompt = `# EP01 提示词

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

### 后续说明

本段承接 EP01，但不得把 EP02 文本误识别为 P01/P02 道具。

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
    writeFile(path.join(sourceRoot, "05_提示词", "第三季_EP01_提示词表.md"), prompt, "utf8"),
    writeFile(path.join(sourceRoot, "01_剧本", "第三季_EP01_测试.md"), "# EP01 测试剧本\n", "utf8"),
  ]);
  const authorityPath = path.join(root, "阿航权威.jpg");
  const pixels = Buffer.alloc(900 * 1600 * 3);
  for (let index = 0; index < pixels.length; index += 3) {
    const pixel = index / 3;
    const x = pixel % 900;
    const y = Math.floor(pixel / 900);
    pixels[index] = (x * 17 + y * 7) % 256;
    pixels[index + 1] = (x * 5 + y * 19) % 256;
    pixels[index + 2] = (x * 11 + y * 3) % 256;
  }
  const authorityBytes = await sharp(pixels, { raw: { width: 900, height: 1600, channels: 3 } })
    .jpeg({ quality: 90 })
    .toBuffer();
  await writeFile(authorityPath, authorityBytes);
  const authoritySha256 = createHash("sha256").update(authorityBytes).digest("hex");
  const inspection = await inspectFusionPackage({ packageRoot, sourceRoot, expectedCounts: EXPECTED });
  return { root, sourceRoot, packageRoot, targetParent, authorityPath, authoritySha256, inspection };
}

async function prepareMigratedSubagentJob() {
  const data = await fixture();
  const created = await materializeFusionProject({ inspection: data.inspection, targetParent: data.targetParent });
  await scanAndPersist(created.targetRoot);
  const [original] = await enqueueGeneration(created.targetRoot, { itemIds: ["asset-P01"], kind: "image" });
  await processGenerationQueue(created.targetRoot, { jobId: original!.id });
  const currentSettings = await getGenerationSettings(created.targetRoot);
  const settings = await upsertGenerationProvider(created.targetRoot, {
    expectedRevision: currentSettings.revision,
    concurrency: 1,
    provider: {
      id: "codex-subagent-gpt-image-2",
      name: "Codex 一图一子代理 · GPT Image 2",
      adapter: "codex-subagent-imagegen",
      kinds: ["image"],
      enabled: true,
      model: "GPT Image 2",
      subagentInstructions: "每张图只能由一个独立代理生成一张。完整传递人物、场景、道具、服装和电影写实风格硬锁；结果只写隔离候选路径，主代理必须查看原图。",
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
      outputRoot: created.targetRoot,
    },
  }, "codex");
  const migrated = await updateSubagentImageGenerationJob(created.targetRoot, original!.id, {
    expectedRevision: 1,
    expectedSettingsRevision: settings.revision,
    status: "migrate_plan",
    targetProviderId: "codex-subagent-gpt-image-2",
    note: "测试迁移：保持同一 Job 并建立 raw/labeled Publication 事务。",
  });
  return { data, created, original: original!, migrated, settings };
}

async function writeCandidate(filePath: string, seed = 0x7f4a7c15): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const pixels = Buffer.allocUnsafe(720 * 1280 * 3);
  let state = seed;
  for (let index = 0; index < pixels.length; index += 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    pixels[index] = state & 0xff;
  }
  await sharp(pixels, { raw: { width: 720, height: 1280, channels: 3 } }).png({ compressionLevel: 0 }).toFile(filePath);
}

function fixtureAuthorities(
  data: Awaited<ReturnType<typeof fixture>>,
  assetIds: string[] = ["C01", "S01", "P01"],
) {
  return assetIds.map((assetId) => ({
    id: `authority-${assetId.toLowerCase()}`,
    assetId,
    name: `${assetId} 测试权威图`,
    sourcePath: data.authorityPath,
    expectedSha256: data.authoritySha256,
    rules: ["回归测试硬锁"],
    exposeToGeneration: true,
  }));
}

async function submitCurrentImageReview(
  projectRoot: string,
  itemId: string,
  decision: "pass" | "rework" = "pass",
) {
  const entry = (await getReviewQueue(projectRoot, { includeResolved: true }))
    .find((candidate) => candidate.item.id === itemId);
  if (!entry) throw new Error(`测试夹具找不到验收队列节点：${itemId}`);
  const artifactIds = entry.reviewRequirement?.artifactIds ?? entry.artifacts.map((artifact) => artifact.id);
  const visualConstraintAttestations = entry.reviewRequirement?.panels.flatMap((panel) =>
    (panel.visualReviewRules ?? []).map((rule) => ({
      panelId: panel.panelId,
      constraintId: panel.panelVisualConstraintId!,
      reviewRulesFingerprint: panel.panelVisualReviewRulesFingerprint!,
      ruleId: rule.id,
      result: decision === "rework" && rule === panel.visualReviewRules?.[0] ? "fail" as const : "pass" as const,
      note: "测试人工逐条核验。",
    })),
  );
  return submitReview(projectRoot, {
    itemId,
    reviewType: "image",
    artifactIds,
    expectedScanId: entry.reviewSnapshot.scanId,
    expectedArtifactHashes: entry.reviewRequirement?.artifactHashes
      ?? Object.fromEntries(artifactIds.map((artifactId) => [artifactId, entry.reviewSnapshot.artifactHashes[artifactId]!])),
    expectedRequirementId: entry.reviewRequirement?.id,
    visualConstraintAttestations,
    decision,
    criteria: IMAGE_REVIEW_CRITERIA.map((key) => ({
      key,
      result: decision === "rework" && key === "hard_lock" ? "fail" as const : "pass" as const,
    })),
    note: decision === "pass" ? "回归测试：当前全部图片证据通过。" : "回归测试：当前硬锁视觉证据明确返工。",
  });
}

async function publishAllPanelJobs(
  projectRoot: string,
  itemId: string,
  contractId: string,
  panelCount: number,
) {
  await materializeFusionPanelVisualConstraints(projectRoot);
  const jobs = [];
  for (let panelIndex = 1; panelIndex <= panelCount; panelIndex += 1) {
    jobs.push(await enqueueFusionStoryboardPanel(projectRoot, { itemId, contractId, panelIndex }));
  }
  for (const [index, job] of jobs.entries()) {
    const raw = await sharp({
      create: {
        width: 720,
        height: 1280,
        channels: 3,
        background: ["#23445a", "#6f4e32", "#31523f", "#5d365f", "#27495f", "#72552c"][index]!,
      },
    }).png().toBuffer();
    await writeFile(job.expectedOutputPath, raw);
    await writeFile(job.expectedCompanionPath!, raw);
    const intent = await getPublicationIntent(projectRoot, job.publicationIntentId!);
    if (!intent) throw new Error(`测试夹具找不到 Publication intent：${job.id}`);
    const receipt = await registerPublication(projectRoot, {
      intentId: intent.id,
      reservationToken: intent.reservationToken,
      expectedRevision: intent.revision,
    });
    job.status = "succeeded";
    job.resultPath = job.expectedOutputPath;
    job.resultSha256 = createHash("sha256").update(raw).digest("hex");
    job.companionPath = job.expectedCompanionPath;
    job.publicationReceiptId = receipt.id;
    job.updatedAt = new Date(Date.now() + index).toISOString();
  }
  const sidecar = getSidecarPaths(projectRoot);
  const stored = JSON.parse(await readFile(sidecar.generationJobs, "utf8")) as typeof jobs;
  const completedById = new Map(jobs.map((job) => [job.id, job]));
  await writeFile(sidecar.generationJobs, `${JSON.stringify(stored.map((job) => completedById.get(job.id) ?? job), null, 2)}\n`, "utf8");
  await scanAndPersist(projectRoot, { includeHashes: true });
  return jobs;
}

type FusionGridContract = Awaited<ReturnType<typeof buildFusionStoryboardGridForProject>>;

function legacyPanelJob(input: {
  projectId: string;
  projectRoot: string;
  itemId: string;
  id: string;
  contract: FusionGridContract;
  status: import("../src/core/types.js").GenerationJob["status"];
}): import("../src/core/types.js").GenerationJob {
  const panel = input.contract.panels[0]!;
  const now = "2026-07-17T00:00:00.000Z";
  return {
    schemaVersion: 1,
    id: input.id,
    projectId: input.projectId,
    itemId: input.itemId,
    providerId: "artlist-gpt-image-2",
    kind: "image",
    purpose: "fusion_storyboard_panel",
    status: input.status,
    prompt: `legacy ledger fixture ${input.id}`,
    referencePaths: [],
    fusionStoryboardPanel: {
      contractId: input.contract.contractId,
      sourceFingerprint: input.contract.sourceFingerprint,
      panelId: panel.id,
      panelIndex: panel.index,
      panelCount: input.contract.selection.panelCount,
      frameRole: panel.frameRole,
      startSeconds: panel.startSeconds,
      endSeconds: panel.endSeconds,
    },
    storyboardRevision: input.contract.sourceStoryboardRevision,
    storyboardRows: [],
    expectedOutputPath: path.join(input.projectRoot, "production", `${input.id}_raw.png`),
    attempts: 0,
    createdAt: now,
    updatedAt: now,
  };
}

async function mixedLegacyLedgerFixture(options: {
  mutateObsoleteJob?: (job: import("../src/core/types.js").GenerationJob) => void;
  mutateCurrentJob?: (job: import("../src/core/types.js").GenerationJob) => void;
  mutatePublicationStore?: (store: Record<string, unknown>) => void;
} = {}) {
  const data = await fixture();
  const created = await materializeFusionProject({
    inspection: data.inspection,
    targetParent: data.targetParent,
    authorities: fixtureAuthorities(data),
  });
  await scanAndPersist(created.targetRoot);
  const itemId = "season-三-ep01-unit001";
  const obsoleteContract = await buildFusionStoryboardGridForProject(created.targetRoot, itemId);
  const currentContract = await buildFusionStoryboardGridForProject(created.targetRoot, itemId, {
    override: {
      panelCount: 4,
      expectedRevision: obsoleteContract.sourceStoryboardRevision,
      reason: "legacy ledger 回归：建立淘汰旧合同与当前合同",
    },
  });
  expect(currentContract.contractId).not.toBe(obsoleteContract.contractId);
  const currentJob = legacyPanelJob({
    projectId: created.assetCatalog.projectId,
    projectRoot: created.targetRoot,
    itemId,
    id: "legacy-current-contract-job",
    contract: currentContract,
    status: "queued",
  });
  const obsoleteJob = legacyPanelJob({
    projectId: created.assetCatalog.projectId,
    projectRoot: created.targetRoot,
    itemId,
    id: "legacy-obsolete-terminal-job",
    contract: obsoleteContract,
    status: "cancelled",
  });
  await mkdir(path.dirname(obsoleteJob.expectedOutputPath), { recursive: true });
  const reserved = await preflightPublication(created.targetRoot, {
    idempotencyKey: `legacy-obsolete:${obsoleteJob.id}`,
    requestedPath: obsoleteJob.expectedOutputPath,
    kind: "raw-image",
    variant: "start",
    context: { purpose: "generation-output", itemId, jobId: obsoleteJob.id },
    note: "obsolete terminal legacy 测试预留",
  }, "codex");
  const terminalIntent = await cancelPublication(created.targetRoot, {
    intentId: reserved.id,
    reservationToken: reserved.reservationToken,
    expectedRevision: reserved.revision,
    reason: "旧合同被当前合同淘汰，且从未生成输出",
  }, "codex");
  obsoleteJob.publicationIntentId = terminalIntent.id;
  obsoleteJob.publicationReservationToken = terminalIntent.reservationToken;
  options.mutateCurrentJob?.(currentJob);
  options.mutateObsoleteJob?.(obsoleteJob);
  const sidecar = getSidecarPaths(created.targetRoot);
  if (options.mutatePublicationStore) {
    const publicationStore = JSON.parse(await readFile(sidecar.publications, "utf8")) as Record<string, unknown>;
    options.mutatePublicationStore(publicationStore);
    await writeFile(sidecar.publications, `${JSON.stringify(publicationStore, null, 2)}\n`, "utf8");
  }
  await writeFile(sidecar.generationJobs, `${JSON.stringify([currentJob, obsoleteJob], null, 2)}\n`, "utf8");
  return {
    data,
    created,
    sidecar,
    itemId,
    currentContract,
    obsoleteContract,
    currentJob,
    obsoleteJob,
    terminalIntent,
  };
}

describe("融合包 CAS 隔离物化", () => {
  it("幂等建立单元、原镜、正式时间段、资产、连续性与权威快照", async () => {
    const data = await fixture();
    const beforeSource = data.inspection.inventory.aggregateSha256;
    const options = {
      inspection: data.inspection,
      targetParent: data.targetParent,
      authorities: [{
        id: "ahang",
        assetId: "C01",
        name: "阿航权威图",
        sourcePath: data.authorityPath,
        expectedSha256: data.authoritySha256,
        rules: ["同脸、黑衣、左侧银白挑染"],
        exposeToGeneration: true,
      }],
    };
    const first = await materializeFusionProject(options);
    expect(first.created).toBe(true);
    const generationSettings = JSON.parse(await readFile(path.join(first.targetRoot, ".aicanvas", "generation.json"), "utf8")) as {
      providers: Array<{ id: string; browserInstructions?: string; executionSurface?: { id: string; version: string } }>;
    };
    const artlist = generationSettings.providers.find((provider) => provider.id === "artlist-gpt-image-2");
    expect(artlist?.executionSurface).toEqual({ id: "codex-in-app-side-browser", version: "1" });
    expect(artlist?.browserInstructions).toContain("Codex 应用内侧边浏览器");
    expect(artlist?.browserInstructions).not.toContain("已登录 Chrome");
    expect(first.assetCatalog.assets).toHaveLength(3);
    expect(first.continuity.tracks).toHaveLength(3);
    expect(first.receipt.counts).toMatchObject({ units: 1, sourceShots: 2, scheduleRows: 3, assets: 3 });
    expect(first.receipt.authorities[0]).toMatchObject({ assetId: "C01", snapshotSha256: data.authoritySha256 });

    const storyboards = JSON.parse(await readFile(path.join(first.targetRoot, ".aicanvas", "storyboards.json"), "utf8")) as { rows: Array<{ shotItemId?: string; durationSeconds: number }> };
    expect(storyboards.rows).toHaveLength(3);
    expect(storyboards.rows.map((row) => row.durationSeconds)).toEqual([8, 5, 2]);
    expect(storyboards.rows.at(-1)?.shotItemId).toBeUndefined();
    expect(await readFile(path.join(first.targetRoot, "docs", "第三季视觉Bible.md"), "utf8")).toContain("EP32 前不得露出实体");
    await expect(access(path.join(first.targetRoot, "production", "蜀道山古蜀卷第三季_EP01_测试_9x16_漫剧", "04_15秒融合分镜", "EP01_15s_001_测试", "EP01_镜01.md"))).resolves.toBeUndefined();
    const index = await scanAndPersist(first.targetRoot);
    expect(index.summary.total).toBe(1);
    expect(index.items.filter((item) => item.type === "unit")).toHaveLength(1);
    expect(index.items.filter((item) => item.type === "shot")).toHaveLength(2);
    expect(index.items.filter((item) => item.type === "asset")).toHaveLength(3);
    expect(index.items.find((item) => item.id === "asset-C01")).toMatchObject({ status: "已完成", hardLockIds: ["C01"] });
    expect(index.items.filter((item) => item.type === "asset" && item.status === "待首帧")).toHaveLength(2);
    const grid = await buildFusionStoryboardGridForProject(first.targetRoot, "season-三-ep01-unit001");
    expect(grid.selection).toMatchObject({ panelCount: 3, sourceRowCount: 3, mode: "automatic" });
    expect(grid.panels.map((panel) => panel.frameRole)).toEqual(["start", "middle", "end"]);
    expect(grid.panels[0]?.tableFields.map((field) => field.label)).toEqual(["画面内容/动作", "景别/构图", "拍摄方式", "连续性/声音", "台词/字幕", "时长"]);
    expect((await loadCurrentFusionStoryboardGrid(first.targetRoot, "season-三-ep01-unit001", grid.contractId)).sourceFingerprint).toBe(grid.sourceFingerprint);
    expect(await materializeAllFusionStoryboardGrids(first.targetRoot)).toMatchObject({ contracts: 1, panelImagesRequired: 3, panelDistribution: { "3": 1 } });

    const receiptStat = await stat(path.join(first.targetRoot, "fusion-production-materialization.json"));
    const repeated = await materializeFusionProject(options);
    const repeatedStat = await stat(path.join(first.targetRoot, "fusion-production-materialization.json"));
    expect(repeated.created).toBe(false);
    expect(repeated.targetRoot).toBe(first.targetRoot);
    expect(repeatedStat.mtimeMs).toBe(receiptStat.mtimeMs);
    const after = await inspectFusionPackage({ packageRoot: data.packageRoot, sourceRoot: data.sourceRoot, expectedCounts: EXPECTED });
    expect(after.inventory.aggregateSha256).toBe(beforeSource);
  });

  it("源漂移或不可变目标文件冲突时失败关闭且不覆盖", async () => {
    const drift = await fixture();
    const sourceUnit = path.join(drift.packageRoot, drift.inspection.units[0]!.markdownPath);
    await writeFile(sourceUnit, `${await readFile(sourceUnit, "utf8")}\n漂移\n`, "utf8");
    await expect(materializeFusionProject({ inspection: drift.inspection, targetParent: drift.targetParent })).rejects.toThrow(/源快照校验失败|只读源内容漂移/u);
    await expect(access(path.join(drift.targetParent, `gushujuan-s3-${drift.inspection.inventory.aggregateSha256.slice(0, 16)}`))).rejects.toThrow();

    const conflict = await fixture();
    const created = await materializeFusionProject({ inspection: conflict.inspection, targetParent: conflict.targetParent });
    const immutable = created.receipt.ownedFiles.find((file) => file.role === "unit")!;
    await writeFile(path.join(created.targetRoot, immutable.relativePath), "被外部覆盖", "utf8");
    await expect(materializeFusionProject({ inspection: conflict.inspection, targetParent: conflict.targetParent })).rejects.toThrow("不可变基线文件发生冲突");
    expect(await readFile(path.join(created.targetRoot, immutable.relativePath), "utf8")).toBe("被外部覆盖");
  });

  it("资产节点可按冻结合同入队，已完成权威资产拒绝重复生成", async () => {
    const data = await fixture();
    const created = await materializeFusionProject({
      inspection: data.inspection,
      targetParent: data.targetParent,
      authorities: [{
        id: "ahang",
        assetId: "C01",
        name: "阿航权威图",
        sourcePath: data.authorityPath,
        expectedSha256: data.authoritySha256,
        rules: ["同脸"],
        exposeToGeneration: true,
      }],
    });
    await scanAndPersist(created.targetRoot);
    const [job] = await enqueueGeneration(created.targetRoot, { itemIds: ["asset-P01"], kind: "image" });
    expect(job).toMatchObject({
      itemId: "asset-P01",
      purpose: "asset",
      model: "GPT Image 2",
      parameters: { aspectRatio: "9:16", resolution: "Medium", quality: "Medium", imageCount: 1, mode: "text" },
      references: [],
      storyboardRows: [],
    });
    expect(job!.expectedOutputPath).toContain(`${path.sep}assets${path.sep}P01_`);
    expect(job!.expectedOutputPath).toMatch(/P01_资产_.+_raw\.png$/u);
    expect(job!.expectedCompanionPath).toMatch(/_labeled\.png$/u);
    await expect(enqueueGeneration(created.targetRoot, { itemIds: ["asset-C01"], kind: "image" })).rejects.toThrow(/不能创建新的资产生图任务/u);
  });

  it("Artlist 资产任务机械拒绝非 9:16 与占位图，仅 downloaded 身份链完整时发布有效图片", async () => {
    const data = await fixture();
    const created = await materializeFusionProject({
      inspection: data.inspection,
      targetParent: data.targetParent,
      authorities: [{
        id: "ahang",
        assetId: "C01",
        name: "阿航权威图",
        sourcePath: data.authorityPath,
        expectedSha256: data.authoritySha256,
        rules: ["同脸"],
        exposeToGeneration: true,
      }],
    });
    await scanAndPersist(created.targetRoot);
    const [job] = await enqueueGeneration(created.targetRoot, { itemIds: ["asset-P01"], kind: "image" });
    await processGenerationQueue(created.targetRoot, { jobId: job!.id });
    const plan = await getBrowserGenerationPlan(created.targetRoot, job!.id);
    const preflight = await updateBrowserGenerationJob(created.targetRoot, job!.id, {
      expectedRevision: 1,
      status: "preflight",
      note: "Artlist 页面与冻结资产任务逐项一致。",
      preflightEvidence: {
        executionSurface: plan.executionSurface,
        observedHost: "toolkit.artlist.io",
        loginVerified: true,
        pageReady: true,
        generationModeVerified: true,
        balanceChecked: true,
        paidActionRequired: false,
        paidActionAuthorized: false,
        observedGeneration: { model: "GPT Image 2", aspectRatio: "9:16", resolution: "Medium", imageCount: 1, generateEnabled: true },
      },
    });
    const uploaded = await updateBrowserGenerationJob(created.targetRoot, job!.id, {
      expectedRevision: preflight.browserCheckpoint!.revision,
      status: "uploaded",
      uploadEvidence: { files: [], observedReferenceThumbnailCount: 0 },
    });
    const submitIntent = await updateBrowserGenerationJob(created.targetRoot, job!.id, {
      expectedRevision: uploaded.browserCheckpoint!.revision,
      status: "submit_intent",
    });
    const submitted = await updateBrowserGenerationJob(created.targetRoot, job!.id, {
      expectedRevision: submitIntent.browserCheckpoint!.revision,
      status: "submitted",
      externalTaskId: "artlist-p01-test-001",
    });

    const writePattern = async (target: string, width: number, height: number, range: number) => {
      const pixels = Buffer.allocUnsafe(width * height * 3);
      let state = 0x1234abcd;
      for (let index = 0; index < pixels.length; index += 1) {
        state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
        pixels[index] = 100 + (range === 1 ? (state & 1) : state % range);
      }
      await sharp(pixels, { raw: { width, height, channels: 3 } }).png({ compressionLevel: 0 }).toFile(target);
    };
    const landscape = path.join(plan.isolatedDownloadDirectory, "landscape.png");
    await writePattern(landscape, 1280, 720, 156);
    await expect(updateBrowserGenerationJob(created.targetRoot, job!.id, {
      expectedRevision: submitted.browserCheckpoint!.revision,
      status: "downloaded",
      externalTaskId: "artlist-p01-test-001",
      downloadedPath: landscape,
    })).rejects.toThrow(/画幅/u);
    await expect(access(job!.expectedOutputPath)).rejects.toThrow();

    const placeholder = path.join(plan.isolatedDownloadDirectory, "placeholder.png");
    await writePattern(placeholder, 720, 1280, 1);
    await expect(updateBrowserGenerationJob(created.targetRoot, job!.id, {
      expectedRevision: submitted.browserCheckpoint!.revision,
      status: "downloaded",
      externalTaskId: "artlist-p01-test-001",
      downloadedPath: placeholder,
    })).rejects.toThrow(/占位图/u);
    await expect(access(job!.expectedOutputPath)).rejects.toThrow();

    const valid = path.join(plan.isolatedDownloadDirectory, "valid.png");
    await writePattern(valid, 720, 1280, 156);
    const completed = await updateBrowserGenerationJob(created.targetRoot, job!.id, {
      expectedRevision: submitted.browserCheckpoint!.revision,
      status: "downloaded",
      externalTaskId: "artlist-p01-test-001",
      downloadedPath: valid,
    });
    expect(completed).toMatchObject({ status: "succeeded", browserCheckpoint: { stage: "verified" }, externalTaskId: "artlist-p01-test-001" });
    expect(completed.publicationReceiptId).toBeTruthy();
    await expect(access(job!.expectedOutputPath)).resolves.toBeUndefined();
    await expect(access(job!.expectedCompanionPath!)).resolves.toBeUndefined();
    expect((await getPublicationIntent(created.targetRoot, job!.publicationIntentId!))?.status).toBe("registered");
  });

  it("同一 Artlist job/Publication 可 CAS 迁移到一图一子代理，并以唯一租约和隔离 SHA 完成机械发布", async () => {
    const data = await fixture();
    const created = await materializeFusionProject({ inspection: data.inspection, targetParent: data.targetParent });
    await scanAndPersist(created.targetRoot);
    const [original] = await enqueueGeneration(created.targetRoot, { itemIds: ["asset-P01"], kind: "image" });
    await processGenerationQueue(created.targetRoot, { jobId: original!.id });
    expect((await getBrowserGenerationPlan(created.targetRoot, original!.id)).currentCheckpoint?.stage).toBe("plan_ready");

    const currentSettings = await getGenerationSettings(created.targetRoot);
    const settings = await upsertGenerationProvider(created.targetRoot, {
      expectedRevision: currentSettings.revision,
      concurrency: 1,
      provider: {
        id: "codex-subagent-gpt-image-2",
        name: "Codex 一图一子代理 · GPT Image 2",
        adapter: "codex-subagent-imagegen",
        kinds: ["image"],
        enabled: true,
        model: "GPT Image 2",
        subagentInstructions: "每张图只能由一个独立代理生成一张。完整传递人物、场景、道具、服装和电影写实风格硬锁；禁止文字、水印、拼图、现代物和额外人物；结果只写候选路径，主代理必须查看原图。",
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
        outputRoot: created.targetRoot,
      },
    }, "codex");
    const migrated = await updateSubagentImageGenerationJob(created.targetRoot, original!.id, {
      expectedRevision: 1,
      expectedSettingsRevision: settings.revision,
      status: "migrate_plan",
      targetProviderId: "codex-subagent-gpt-image-2",
      note: "网页控制失效后按用户授权迁移；保留原任务与 Publication。",
    });
    expect(migrated).toMatchObject({
      id: original!.id,
      providerId: "codex-subagent-gpt-image-2",
      publicationIntentId: original!.publicationIntentId,
      publicationBundleId: expect.stringMatching(/^generation-bundle-/u),
      companionPublicationIntentId: expect.stringMatching(/^publication-/u),
      browserCheckpoint: { stage: "plan_ready", revision: 1 },
      subagentCheckpoint: { schemaVersion: 2, stage: "plan_ready", revision: 1, remoteIdentityRequired: false, oneImagePerAgent: true },
    });
    const plan = await getSubagentImageGenerationPlan(created.targetRoot, original!.id);
    expect(plan).toMatchObject({
      jobId: original!.id,
      publicationIntentId: original!.publicationIntentId,
      publicationBundleId: migrated.publicationBundleId,
      companionPublicationIntentId: migrated.companionPublicationIntentId,
      promptSha256: original!.executionSnapshot!.promptSha256,
      allowedReferences: [],
      contract: { exactlyOneImage: true, oneAgentPerImage: true, sequentialOnly: true, remoteIdentityRequired: false, persistCallIntentBeforeModel: true, recordCandidateBeforePublication: true, rawLabeledBundleRequired: true, mainAgentVisualReviewRequired: true },
    });

    const claimed = await updateSubagentImageGenerationJob(created.targetRoot, original!.id, {
      expectedRevision: 1,
      status: "claim",
      agentTaskName: "/root/generate_p01_test",
    });
    const leaseId = claimed.subagentCheckpoint!.lease!.leaseId;
    const fence = claimed.subagentCheckpoint!.lease!.fence!;
    expect(claimed.subagentCheckpoint).toMatchObject({ schemaVersion: 2, stage: "leased", revision: 2, lease: { agentTaskName: "/root/generate_p01_test", owner: "/root/generate_p01_test", fence, oneImageOnly: true, heartbeatAt: expect.any(String), leaseUntil: expect.any(String) } });
    await expect(updateSubagentImageGenerationJob(created.targetRoot, original!.id, {
      expectedRevision: 2,
      status: "claim",
      agentTaskName: "/root/generate_p01_duplicate",
    })).rejects.toThrow(/第二个并行代理|已有代理租约/u);
    const calling = await updateSubagentImageGenerationJob(created.targetRoot, original!.id, {
      expectedRevision: 2,
      status: "start_call",
      agentTaskName: "/root/generate_p01_test",
      owner: "/root/generate_p01_test",
      leaseId,
      fence,
      runId: "agent-run-p01-test",
      callId: "image-call-p01-test",
    });
    expect(calling).toMatchObject({ status: "generating", subagentCheckpoint: { stage: "generating", revision: 3, callIntent: { callId: "image-call-p01-test", runId: "agent-run-p01-test", maxCalls: 1 } } });
    await expect(updateSubagentImageGenerationJob(created.targetRoot, original!.id, {
      expectedRevision: 3,
      status: "generated",
      agentTaskName: "/root/generate_p01_test",
      agentRunId: "agent-run-p01-test",
      owner: "/root/generate_p01_test",
      runId: "agent-run-p01-test",
      callId: "image-call-p01-test",
      leaseId: "subagent-lease-wrong",
      fence,
      generatedPath: original!.expectedOutputPath,
    })).rejects.toThrow(/leaseId|租约/u);

    const candidatePath = path.join(created.targetRoot, "subagent-staging", "P01_candidate.png");
    await mkdir(path.dirname(candidatePath), { recursive: true });
    const pixels = Buffer.allocUnsafe(720 * 1280 * 3);
    let state = 0x7f4a7c15;
    for (let index = 0; index < pixels.length; index += 1) {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      pixels[index] = state & 0xff;
    }
    await sharp(pixels, { raw: { width: 720, height: 1280, channels: 3 } }).png({ compressionLevel: 0 }).toFile(candidatePath);
    const candidate = await updateSubagentImageGenerationJob(created.targetRoot, original!.id, {
      expectedRevision: 3,
      status: "generated",
      agentTaskName: "/root/generate_p01_test",
      agentRunId: "agent-run-p01-test",
      owner: "/root/generate_p01_test",
      runId: "agent-run-p01-test",
      callId: "image-call-p01-test",
      leaseId,
      fence,
      generatedPath: candidatePath,
    });
    expect(candidate).toMatchObject({
      id: original!.id,
      status: "candidate_generated",
      publicationIntentId: original!.publicationIntentId,
      subagentCheckpoint: {
        stage: "candidate_generated",
        revision: 4,
        remoteIdentityRequired: false,
        output: { leaseId, callId: "image-call-p01-test", runId: "agent-run-p01-test", owner: "/root/generate_p01_test", agentTaskName: "/root/generate_p01_test", agentRunId: "agent-run-p01-test", sourceSha256: expect.stringMatching(/^[a-f0-9]{64}$/u), isolatedSha256: expect.stringMatching(/^[a-f0-9]{64}$/u) },
      },
    });
    await expect(access(original!.expectedOutputPath)).rejects.toThrow();
    await expect(access(original!.expectedCompanionPath!)).rejects.toThrow();
    expect((await getPublicationIntent(created.targetRoot, original!.publicationIntentId!))?.status).toBe("reserved");
    expect((await getPublicationIntent(created.targetRoot, candidate.companionPublicationIntentId!))?.status).toBe("reserved");
    await copyFile(candidate.subagentCheckpoint!.output!.isolatedPath, original!.expectedOutputPath);
    expect((await getPublicationIntent(created.targetRoot, original!.publicationIntentId!))?.status).toBe("reserved");

    const completed = await updateSubagentImageGenerationJob(created.targetRoot, original!.id, {
      expectedRevision: 4,
      status: "visual_accept",
      agentTaskName: "/root/generate_p01_test",
      owner: "/root/generate_p01_test",
      runId: "agent-run-p01-test",
      callId: "image-call-p01-test",
      leaseId,
      fence,
      reviewer: "/root/review_p01_test",
      note: "人物、场景、道具、画幅与电影写实风格均通过视觉验收。",
    });
    expect(completed).toMatchObject({
      id: original!.id,
      status: "succeeded",
      publicationIntentId: original!.publicationIntentId,
      publicationReceiptId: expect.stringMatching(/^receipt-/u),
      companionPublicationReceiptId: expect.stringMatching(/^receipt-/u),
      subagentCheckpoint: {
        stage: "verified",
        revision: 6,
        remoteIdentityRequired: false,
        publicationBundle: { stage: "registered", rawReceiptId: expect.stringMatching(/^receipt-/u), labeledReceiptId: expect.stringMatching(/^receipt-/u) },
      },
    });
    expect(completed.externalTaskId).toBeUndefined();
    expect(completed.subagentCheckpoint!.output!.sourceSha256).toBe(completed.subagentCheckpoint!.output!.isolatedSha256);
    expect(completed.resultSha256).toBe(completed.subagentCheckpoint!.output!.isolatedSha256);
    await expect(access(original!.expectedOutputPath)).resolves.toBeUndefined();
    await expect(access(original!.expectedCompanionPath!)).resolves.toBeUndefined();
    expect((await getPublicationIntent(created.targetRoot, original!.publicationIntentId!))?.status).toBe("registered");
    expect((await getPublicationIntent(created.targetRoot, completed.companionPublicationIntentId!))?.status).toBe("registered");
  });

  it("零远端副作用的 queued 浏览器任务可从隐式 R0 直接迁移，且错误 R1 不会改写任务", async () => {
    const data = await fixture();
    const created = await materializeFusionProject({ inspection: data.inspection, targetParent: data.targetParent });
    await scanAndPersist(created.targetRoot);
    const [original] = await enqueueGeneration(created.targetRoot, { itemIds: ["asset-P01"], kind: "image" });
    expect(original).toMatchObject({ status: "queued", attempts: 0 });
    expect(original!.browserCheckpoint).toBeUndefined();
    expect(original!.subagentCheckpoint).toBeUndefined();

    const currentSettings = await getGenerationSettings(created.targetRoot);
    const settings = await upsertGenerationProvider(created.targetRoot, {
      expectedRevision: currentSettings.revision,
      concurrency: 1,
      provider: {
        id: "codex-subagent-gpt-image-2",
        name: "Codex 一图一子代理 · GPT Image 2",
        adapter: "codex-subagent-imagegen",
        kinds: ["image"],
        enabled: true,
        model: "GPT Image 2",
        subagentInstructions: "每张图只启动一个代理并只生成一张；冻结人物、场景、道具、时代与风格；候选图必须经主代理查看和 Publication。",
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
        outputRoot: created.targetRoot,
      },
    }, "codex");

    await expect(updateSubagentImageGenerationJob(created.targetRoot, original!.id, {
      expectedRevision: 1,
      expectedSettingsRevision: settings.revision,
      status: "migrate_plan",
      targetProviderId: "codex-subagent-gpt-image-2",
    })).rejects.toThrow(/当前 0/u);

    const migrated = await updateSubagentImageGenerationJob(created.targetRoot, original!.id, {
      expectedRevision: 0,
      expectedSettingsRevision: settings.revision,
      status: "migrate_plan",
      targetProviderId: "codex-subagent-gpt-image-2",
      note: "queued R0 尚无网页 request、检查点、提交意图或远端副作用，直接迁移并保留任务与 Publication。",
    });
    expect(migrated).toMatchObject({
      id: original!.id,
      status: "waiting_external",
      attempts: 0,
      providerId: "codex-subagent-gpt-image-2",
      publicationIntentId: original!.publicationIntentId,
      subagentCheckpoint: {
        stage: "plan_ready",
        revision: 1,
        migratedFrom: { providerId: original!.providerId, adapter: "codex-browser", executionSnapshotHash: original!.executionSnapshot!.snapshotHash },
      },
    });
    expect(migrated.browserCheckpoint).toBeUndefined();
    expect(migrated.submissionIntent).toBeUndefined();
    expect(migrated.externalTaskId).toBeUndefined();
    expect(migrated.subagentCheckpoint!.migratedFrom!.browserCheckpointRevision).toBeUndefined();
    const plan = await getSubagentImageGenerationPlan(created.targetRoot, original!.id);
    expect(plan).toMatchObject({ jobId: original!.id, publicationIntentId: original!.publicationIntentId, currentCheckpoint: { stage: "plan_ready", revision: 1 } });
    expect((await getPublicationIntent(created.targetRoot, original!.publicationIntentId!))?.status).toBe("reserved");
    await expect(access(original!.expectedOutputPath)).rejects.toThrow();
  });

  it("v2 租约支持 owner 心跳、调用前释放、过期接管，并把调用后失联投影为 generation_unknown", async () => {
    const { created, migrated } = await prepareMigratedSubagentJob();
    const first = await updateSubagentImageGenerationJob(created.targetRoot, migrated.id, {
      expectedRevision: 1,
      status: "claim",
      agentTaskName: "/root/lease_owner_a",
      leaseSeconds: 30,
    });
    const firstLease = first.subagentCheckpoint!.lease!;
    await expect(updateSubagentImageGenerationJob(created.targetRoot, migrated.id, {
      expectedRevision: 2,
      status: "heartbeat",
      agentTaskName: "/root/lease_owner_b",
      owner: "/root/lease_owner_b",
      leaseId: firstLease.leaseId,
      fence: firstLease.fence,
    })).rejects.toThrow(/leaseId|owner|canonical/u);

    const settingsBefore = await getGenerationSettings(created.targetRoot);
    const unrelated = settingsBefore.providers.find((provider) => provider.id !== migrated.providerId)!;
    await upsertGenerationProvider(created.targetRoot, {
      expectedRevision: settingsBefore.revision,
      provider: { ...unrelated, name: `${unrelated.name} · unrelated edit` },
    }, "codex");
    const heartbeat = await updateSubagentImageGenerationJob(created.targetRoot, migrated.id, {
      expectedRevision: 2,
      status: "heartbeat",
      agentTaskName: "/root/lease_owner_a",
      owner: "/root/lease_owner_a",
      leaseId: firstLease.leaseId,
      fence: firstLease.fence,
      leaseSeconds: 60,
    });
    expect(heartbeat.subagentCheckpoint).toMatchObject({ revision: 3, stage: "leased", lease: { owner: "/root/lease_owner_a", fence: firstLease.fence, leaseSeconds: 60 } });

    const released = await updateSubagentImageGenerationJob(created.targetRoot, migrated.id, {
      expectedRevision: 3,
      status: "release",
      agentTaskName: "/root/lease_owner_a",
      owner: "/root/lease_owner_a",
      leaseId: firstLease.leaseId,
      fence: firstLease.fence,
      note: "测试在模型调用前主动释放。",
    });
    expect(released.subagentCheckpoint).toMatchObject({ revision: 4, stage: "plan_ready", lastRelease: { outcome: "plan_ready", leaseId: firstLease.leaseId } });

    const second = await updateSubagentImageGenerationJob(created.targetRoot, migrated.id, {
      expectedRevision: 4,
      status: "claim",
      agentTaskName: "/root/lease_owner_b",
      leaseSeconds: 30,
    });
    const secondLease = second.subagentCheckpoint!.lease!;
    const jobsPath = getSidecarPaths(created.targetRoot).generationJobs;
    const stored = JSON.parse(await readFile(jobsPath, "utf8")) as typeof second[];
    const storedJob = stored.find((job) => job.id === migrated.id)!;
    storedJob.subagentCheckpoint!.lease!.leaseUntil = new Date(Date.now() - 1_000).toISOString();
    await writeFile(jobsPath, `${JSON.stringify(stored, null, 2)}\n`, "utf8");

    const takeover = await updateSubagentImageGenerationJob(created.targetRoot, migrated.id, {
      expectedRevision: 5,
      status: "takeover",
      agentTaskName: "/root/lease_owner_c",
      leaseSeconds: 30,
    });
    const takeoverLease = takeover.subagentCheckpoint!.lease!;
    expect(takeover.subagentCheckpoint).toMatchObject({ revision: 6, stage: "leased", lease: { owner: "/root/lease_owner_c", takeoverOf: { leaseId: secondLease.leaseId } } });
    expect(takeoverLease.fence).toBeGreaterThan(secondLease.fence!);
    await expect(updateSubagentImageGenerationJob(created.targetRoot, migrated.id, {
      expectedRevision: 6,
      status: "start_call",
      agentTaskName: "/root/lease_owner_b",
      owner: "/root/lease_owner_b",
      leaseId: secondLease.leaseId,
      fence: secondLease.fence,
      runId: "late-run-b",
      callId: "late-call-b",
    })).rejects.toThrow(/leaseId|owner|fence/u);

    const calling = await updateSubagentImageGenerationJob(created.targetRoot, migrated.id, {
      expectedRevision: 6,
      status: "start_call",
      agentTaskName: "/root/lease_owner_c",
      owner: "/root/lease_owner_c",
      leaseId: takeoverLease.leaseId,
      fence: takeoverLease.fence,
      runId: "run-owner-c",
      callId: "call-owner-c",
    });
    expect(calling.status).toBe("generating");
    const afterCall = JSON.parse(await readFile(jobsPath, "utf8")) as typeof second[];
    afterCall.find((job) => job.id === migrated.id)!.subagentCheckpoint!.lease!.leaseUntil = new Date(Date.now() - 1_000).toISOString();
    await writeFile(jobsPath, `${JSON.stringify(afterCall, null, 2)}\n`, "utf8");
    await processGenerationQueue(created.targetRoot, { jobId: migrated.id });
    const unknown = (await getSubagentImageGenerationPlan(created.targetRoot, migrated.id)).currentCheckpoint!;
    expect(unknown).toMatchObject({ stage: "generation_unknown", revision: 8, unknown: { code: "call_intent_without_receipt", callId: "call-owner-c", runId: "run-owner-c" } });
    await expect(cancelGenerationJob(created.targetRoot, migrated.id)).rejects.toThrow(/generation_unknown|释放|对账/u);
  });

  it("不同 Job 也共享项目与供应商并发 1 信号量", async () => {
    const { created, migrated } = await prepareMigratedSubagentJob();
    const first = await updateSubagentImageGenerationJob(created.targetRoot, migrated.id, {
      expectedRevision: 1,
      status: "claim",
      agentTaskName: "/root/semaphore_owner_a",
    });
    const [secondBrowser] = await enqueueGeneration(created.targetRoot, { itemIds: ["asset-C01"], kind: "image" });
    const currentSettings = await getGenerationSettings(created.targetRoot);
    const second = await updateSubagentImageGenerationJob(created.targetRoot, secondBrowser!.id, {
      expectedRevision: 0,
      expectedSettingsRevision: currentSettings.revision,
      status: "migrate_plan",
      targetProviderId: migrated.providerId,
    });
    await expect(updateSubagentImageGenerationJob(created.targetRoot, second.id, {
      expectedRevision: 1,
      status: "claim",
      agentTaskName: "/root/semaphore_owner_b",
    })).rejects.toThrow(/并发 1|信号量/u);
    const firstLease = first.subagentCheckpoint!.lease!;
    await updateSubagentImageGenerationJob(created.targetRoot, first.id, {
      expectedRevision: 2,
      status: "release",
      agentTaskName: "/root/semaphore_owner_a",
      owner: "/root/semaphore_owner_a",
      leaseId: firstLease.leaseId,
      fence: firstLease.fence,
    });
    const secondClaim = await updateSubagentImageGenerationJob(created.targetRoot, second.id, {
      expectedRevision: 1,
      status: "claim",
      agentTaskName: "/root/semaphore_owner_b",
    });
    expect(secondClaim.subagentCheckpoint).toMatchObject({ stage: "leased", lease: { owner: "/root/semaphore_owner_b" } });
  });

  it("旧协议 leased 无调用回执只迁移为 unknown，保持 attempt、候选缺失与 Publication 预留", async () => {
    const { created, migrated } = await prepareMigratedSubagentJob();
    const claimed = await updateSubagentImageGenerationJob(created.targetRoot, migrated.id, {
      expectedRevision: 1,
      status: "claim",
      agentTaskName: "/root/legacy_owner",
    });
    const jobsPath = getSidecarPaths(created.targetRoot).generationJobs;
    const beforeJobs = JSON.parse(await readFile(jobsPath, "utf8")) as typeof claimed[];
    const beforeJob = beforeJobs.find((job) => job.id === migrated.id)!;
    const attemptsBefore = beforeJob.attempts;
    const publicationsBefore = await listPublicationIntents(created.targetRoot);
    beforeJob.subagentCheckpoint!.schemaVersion = 1;
    delete beforeJob.subagentCheckpoint!.lease!.owner;
    delete beforeJob.subagentCheckpoint!.lease!.heartbeatAt;
    delete beforeJob.subagentCheckpoint!.lease!.leaseUntil;
    delete beforeJob.subagentCheckpoint!.lease!.leaseSeconds;
    delete beforeJob.subagentCheckpoint!.lease!.fence;
    await writeFile(jobsPath, `${JSON.stringify(beforeJobs, null, 2)}\n`, "utf8");

    const unknown = await updateSubagentImageGenerationJob(created.targetRoot, migrated.id, {
      expectedRevision: 2,
      status: "migrate_execution_state",
      evidenceReference: "legacy-protocol-audit-test",
    });
    expect(unknown).toMatchObject({
      id: migrated.id,
      status: "generation_unknown",
      attempts: attemptsBefore,
      subagentCheckpoint: { schemaVersion: 2, revision: 3, stage: "generation_unknown", unknown: { code: "legacy_leased_without_call_receipt", evidenceReference: "legacy-protocol-audit-test" } },
    });
    expect(await listPublicationIntents(created.targetRoot)).toHaveLength(publicationsBefore.length);
    expect((await getPublicationIntent(created.targetRoot, unknown.publicationIntentId!))?.status).toBe("reserved");
    expect((await getPublicationIntent(created.targetRoot, unknown.companionPublicationIntentId!))?.status).toBe("reserved");
    await expect(access(unknown.expectedOutputPath)).rejects.toThrow();
    await expect(access(unknown.expectedCompanionPath!)).rejects.toThrow();
    const doctor = await doctorProject(created.targetRoot);
    expect(doctor.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "generation-jobs",
        level: "warning",
        detail: expect.stringContaining("调用结果不明 1"),
        suggestedAction: expect.stringContaining("严禁 claim、取消或重生"),
      }),
    ]));
    expect(doctor.suggestedNextCalls).toEqual(["list_generation_jobs", "get_subagent_image_generation_plan", "list_publications", "doctor_project"]);
    const snapshot = await getProjectSnapshot(created.targetRoot);
    expect(snapshot.suggestedNextCalls).toEqual(["get_subagent_image_generation_plan", "list_publications", "doctor_project"]);
    expect(snapshot.generationJobs.find((job) => job.id === unknown.id)).toMatchObject({
      status: "generation_unknown",
      expectedCompanionPath: unknown.expectedCompanionPath,
      publicationBundleId: unknown.publicationBundleId,
      publicationIntentId: unknown.publicationIntentId,
      companionPublicationIntentId: unknown.companionPublicationIntentId,
      subagentCheckpoint: { schemaVersion: 2, stage: "generation_unknown" },
    });
    await expect(updateSubagentImageGenerationJob(created.targetRoot, migrated.id, {
      expectedRevision: 3,
      status: "reconcile_unknown",
      reconciliationResult: "not_invoked",
      evidenceReference: "legacy-protocol-audit-test",
      note: "只有旧租约消失，不能证明模型没有被调用。",
    })).rejects.toThrow(/confirmNoInvocation/u);
  });

  it("视觉返工保留隔离候选、零正式文件和零回执，并关闭成对 Publication", async () => {
    const { created, migrated } = await prepareMigratedSubagentJob();
    const claimed = await updateSubagentImageGenerationJob(created.targetRoot, migrated.id, {
      expectedRevision: 1,
      status: "claim",
      agentTaskName: "/root/reject_owner",
    });
    const lease = claimed.subagentCheckpoint!.lease!;
    await updateSubagentImageGenerationJob(created.targetRoot, migrated.id, {
      expectedRevision: 2,
      status: "start_call",
      agentTaskName: "/root/reject_owner",
      owner: "/root/reject_owner",
      leaseId: lease.leaseId,
      fence: lease.fence,
      runId: "run-reject-test",
      callId: "call-reject-test",
    });
    const candidatePath = path.join(created.targetRoot, "subagent-staging", "reject-candidate.png");
    await writeCandidate(candidatePath, 0x12345678);
    const candidate = await updateSubagentImageGenerationJob(created.targetRoot, migrated.id, {
      expectedRevision: 3,
      status: "generated",
      agentTaskName: "/root/reject_owner",
      owner: "/root/reject_owner",
      leaseId: lease.leaseId,
      fence: lease.fence,
      runId: "run-reject-test",
      callId: "call-reject-test",
      generatedPath: candidatePath,
    });
    const rejected = await updateSubagentImageGenerationJob(created.targetRoot, migrated.id, {
      expectedRevision: 4,
      status: "visual_rejected",
      agentTaskName: "/root/reject_owner",
      owner: "/root/reject_owner",
      leaseId: lease.leaseId,
      fence: lease.fence,
      runId: "run-reject-test",
      callId: "call-reject-test",
      reviewer: "/root/reject_reviewer",
      note: "人物脸型与权威图不一致，必须返工，禁止进入正式 raw/labeled。",
    });
    expect(rejected).toMatchObject({ status: "visual_rejected", subagentCheckpoint: { stage: "visual_rejected", visualReview: { decision: "rejected" } } });
    await expect(access(candidate.subagentCheckpoint!.output!.isolatedPath)).resolves.toBeUndefined();
    await expect(access(rejected.expectedOutputPath)).rejects.toThrow();
    await expect(access(rejected.expectedCompanionPath!)).rejects.toThrow();
    expect((await getPublicationIntent(created.targetRoot, rejected.publicationIntentId!))?.status).toBe("failed");
    expect((await getPublicationIntent(created.targetRoot, rejected.companionPublicationIntentId!))?.status).toBe("failed");
    expect(rejected.publicationReceiptId).toBeUndefined();
    expect(rejected.companionPublicationReceiptId).toBeUndefined();
  });

  it("宫格引用的任一资产未通过视觉验收硬锁时失败关闭", async () => {
    const data = await fixture();
    const created = await materializeFusionProject({
      inspection: data.inspection,
      targetParent: data.targetParent,
      authorities: [{
        id: "ahang",
        assetId: "C01",
        name: "阿航权威图",
        sourcePath: data.authorityPath,
        expectedSha256: data.authoritySha256,
        rules: ["同脸"],
        exposeToGeneration: true,
      }],
    });
    await scanAndPersist(created.targetRoot);
    const unitId = "season-三-ep01-unit001";
    const contract = await buildFusionStoryboardGridForProject(created.targetRoot, unitId);
    await materializeFusionPanelReferenceResolutions(created.targetRoot);
    await expect(enqueueFusionStoryboardPanel(created.targetRoot, {
      itemId: unitId,
      contractId: contract.contractId,
      panelIndex: 1,
    })).rejects.toThrow(/已解析但尚未生产就绪|pending-hard-lock/u);
  });

  it("逐格宫格任务各自冻结唯一参考板，首中尾可并存且同格拒绝重复", async () => {
    const data = await fixture();
    const authorities = (["C01", "S01", "P01"] as const).map((assetId) => ({
      id: `authority-${assetId.toLowerCase()}`,
      assetId,
      name: `${assetId} 权威图`,
      sourcePath: data.authorityPath,
      expectedSha256: data.authoritySha256,
      rules: ["测试硬锁"],
      exposeToGeneration: true,
    }));
    const created = await materializeFusionProject({ inspection: data.inspection, targetParent: data.targetParent, authorities });
    const index = await scanAndPersist(created.targetRoot);
    const unitId = "season-三-ep01-unit001";
    const start = await buildFusionReferenceBoard(created.targetRoot, index, unitId, "start");
    const end = await buildFusionReferenceBoard(created.targetRoot, index, unitId, "end");
    expect(start.board.assetIds).toEqual(["C01", "S01"]);
    expect(end.board.assetIds).toEqual(["C01", "P01"]);
    expect(start.board.storyboardRowId).not.toBe(end.board.storyboardRowId);
    expect(start.board.references).toHaveLength(1);
    expect(start.board.references[0]).toMatchObject({ role: "reference_board", order: 0 });
    expect(start.board.board?.path).not.toBe(end.board.board?.path);
    expect(await stat(start.board.board!.path)).toMatchObject({ size: expect.any(Number) });

    const repeated = await buildFusionReferenceBoard(created.targetRoot, index, unitId, "start");
    expect(repeated.board.board).toEqual(start.board.board);
    await expect(enqueueGeneration(created.targetRoot, { itemIds: [unitId], kind: "image" })).rejects.toThrow(/必须先建立 2–6 格宫格合同/u);
    const automaticContract = await buildFusionStoryboardGridForProject(created.targetRoot, unitId);
    const contract = await buildFusionStoryboardGridForProject(created.targetRoot, unitId, {
      override: {
        panelCount: 4,
        expectedRevision: automaticContract.sourceStoryboardRevision,
        reason: "回归两个独立中间宫格槽位",
      },
    });
    await materializeFusionPanelReferenceResolutions(created.targetRoot);
    await materializeFusionPanelVisualConstraints(created.targetRoot);
    const generationSettings = await getGenerationSettings(created.targetRoot);
    await upsertGenerationProvider(created.targetRoot, {
      expectedRevision: generationSettings.revision,
      concurrency: 1,
      setAsDefaultFor: "image",
      provider: {
        id: "codex-subagent-p4-sheet-test",
        name: "P4 raw/labeled bundle 回归供应商",
        adapter: "codex-subagent-imagegen",
        kinds: ["image"],
        enabled: true,
        model: "GPT Image 2",
        subagentInstructions: "测试仅物化本地 raw/labeled 组合发布身份，不调用外部模型。",
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
        outputRoot: created.targetRoot,
      },
    }, "codex");
    const first = await enqueueFusionStoryboardPanel(created.targetRoot, { itemId: unitId, contractId: contract.contractId, panelIndex: 1 });
    const middleA = await enqueueFusionStoryboardPanel(created.targetRoot, { itemId: unitId, contractId: contract.contractId, panelIndex: 2 });
    const middleB = await enqueueFusionStoryboardPanel(created.targetRoot, { itemId: unitId, contractId: contract.contractId, panelIndex: 3 });
    const last = await enqueueFusionStoryboardPanel(created.targetRoot, { itemId: unitId, contractId: contract.contractId, panelIndex: 4 });
    expect([first, middleA, middleB, last].map((job) => job.purpose)).toEqual(["fusion_storyboard_panel", "fusion_storyboard_panel", "fusion_storyboard_panel", "fusion_storyboard_panel"]);
    expect([first, middleA, middleB, last].map((job) => job.fusionStoryboardPanel?.frameRole)).toEqual(["start", "middle", "middle", "end"]);
    expect(first.expectedOutputPath).toMatch(/EP01_15s_001_宫格01_首帧_.+_raw\.png$/u);
    expect(middleA.expectedOutputPath).toMatch(/EP01_15s_001_宫格02_中间帧_.+_raw\.png$/u);
    expect(middleB.expectedOutputPath).toMatch(/EP01_15s_001_宫格03_中间帧_.+_raw\.png$/u);
    expect(last.expectedOutputPath).toMatch(/EP01_15s_001_宫格04_尾帧_.+_raw\.png$/u);
    expect(first.expectedCompanionPath).toMatch(/_labeled\.png$/u);
    expect(first.fusionReferenceBoard).toMatchObject({ sourceAssetIds: contract.panels[0]!.assetIds });
    expect(first.references).toHaveLength(1);
    expect(first.references?.[0]).toMatchObject({ role: "reference_board", order: 0 });
    expect(first.referencePaths).toEqual(expect.arrayContaining(start.board.sources.map((source) => source.path)));
    expect(new Set([first.fusionReferenceBoard?.path, middleA.fusionReferenceBoard?.path, middleB.fusionReferenceBoard?.path, last.fusionReferenceBoard?.path]).size).toBe(4);
    await expect(enqueueFusionStoryboardPanel(created.targetRoot, { itemId: unitId, contractId: contract.contractId, panelIndex: 1 })).rejects.toThrow(/已有未终结/u);

    const jobs = [first, middleA, middleB, last];
    for (const [index, job] of jobs.entries()) {
      const raw = await sharp({ create: { width: 720, height: 1280, channels: 3, background: ["#23445a", "#6f4e32", "#31523f", "#5d365f"][index]! } }).png().toBuffer();
      await writeFile(job.expectedOutputPath, raw);
      await writeFile(job.expectedCompanionPath!, raw);
      expect(job).toMatchObject({
        publicationBundleId: expect.any(String),
        companionPublicationIntentId: expect.any(String),
        companionPublicationReservationToken: expect.any(String),
      });
      const [intent, companionIntent] = await Promise.all([
        getPublicationIntent(created.targetRoot, job.publicationIntentId!),
        getPublicationIntent(created.targetRoot, job.companionPublicationIntentId!),
      ]);
      const publication = await registerPublicationBundle(created.targetRoot, {
        bundleId: job.publicationBundleId!,
        members: [
          { member: "primary", intentId: intent!.id, reservationToken: intent!.reservationToken, expectedRevision: intent!.revision },
          { member: "companion", intentId: companionIntent!.id, reservationToken: companionIntent!.reservationToken, expectedRevision: companionIntent!.revision },
        ],
      });
      const receipt = publication.receipts.find((candidate) => candidate.bundleMember === "primary")!;
      const companionReceipt = publication.receipts.find((candidate) => candidate.bundleMember === "companion")!;
      job.status = "succeeded";
      job.resultPath = job.expectedOutputPath;
      job.resultSha256 = createHash("sha256").update(raw).digest("hex");
      job.companionPath = job.expectedCompanionPath;
      job.publicationReceiptId = receipt.id;
      job.companionPublicationReceiptId = companionReceipt.id;
      job.updatedAt = new Date(Date.now() + index).toISOString();
    }
    const storedJobs = JSON.parse(await readFile(getSidecarPaths(created.targetRoot).generationJobs, "utf8")) as typeof jobs;
    const completedById = new Map(jobs.map((job) => [job.id, job]));
    await writeFile(getSidecarPaths(created.targetRoot).generationJobs, `${JSON.stringify(storedJobs.map((job) => completedById.get(job.id) ?? job), null, 2)}\n`, "utf8");
    await scanAndPersist(created.targetRoot);
    const indexed = await scanAndPersist(created.targetRoot, { includeHashes: true });
    const currentPanelArtifacts = indexed.artifacts.filter((artifact) => artifact.itemId === unitId && artifact.fusionStoryboardPanel?.contractId === contract.contractId && ["raw-image", "labeled-image"].includes(artifact.kind));
    expect(currentPanelArtifacts).toHaveLength(8);
    expect(currentPanelArtifacts.every((artifact) => artifact.authoritative)).toBe(true);
    expect(new Set(currentPanelArtifacts.filter((artifact) => artifact.variant === "generic").map((artifact) => artifact.fusionStoryboardPanel?.panelId)).size).toBe(2);
    await expect(renderCompletedFusionStoryboardSheetForProject(created.targetRoot, {
      itemId: unitId,
      contractId: contract.contractId,
      expectedInputFingerprint: "0".repeat(64),
    })).rejects.toThrow(/有效视觉通过 Review/u);
    const reviewEntry = (await getReviewQueue(created.targetRoot)).find((entry) => entry.item.id === unitId)!;
    expect(reviewEntry.reviewRequirement).toMatchObject({ complete: true, panelCount: 4 });
    const visualConstraintAttestations = reviewEntry.reviewRequirement!.panels.flatMap((panel) =>
      (panel.visualReviewRules ?? []).map((rule) => ({
        panelId: panel.panelId,
        constraintId: panel.panelVisualConstraintId!,
        reviewRulesFingerprint: panel.panelVisualReviewRulesFingerprint!,
        ruleId: rule.id,
        result: "pass" as const,
        note: "测试人工逐格核验通过。",
      })),
    );
    const onlyStartEnd = reviewEntry.artifacts
      .filter((artifact) => ["start", "end"].includes(artifact.fusionStoryboardPanel?.frameRole ?? ""))
      .map((artifact) => artifact.id);
    await expect(submitReview(created.targetRoot, {
      itemId: unitId,
      reviewType: "image",
      artifactIds: onlyStartEnd,
      expectedScanId: reviewEntry.reviewSnapshot.scanId,
      expectedArtifactHashes: Object.fromEntries(onlyStartEnd.map((artifactId) => [artifactId, reviewEntry.reviewSnapshot.artifactHashes[artifactId]!])),
      expectedRequirementId: reviewEntry.reviewRequirement!.id,
      visualConstraintAttestations,
      decision: "pass",
      criteria: ["character_identity", "hard_lock", "prop_costume", "scene_continuity", "composition", "image_quality", "raw_labeled_pair"].map((key) => ({ key: key as import("../src/core/types.js").ReviewCriterionKey, result: "pass" as const })),
    })).rejects.toThrow(/必须精确关联当前 4 格的 8 个/u);
    const reviewed = await submitReview(created.targetRoot, {
      itemId: unitId,
      reviewType: "image",
      artifactIds: reviewEntry.reviewRequirement!.artifactIds,
      expectedScanId: reviewEntry.reviewSnapshot.scanId,
      expectedArtifactHashes: reviewEntry.reviewRequirement!.artifactHashes,
      expectedRequirementId: reviewEntry.reviewRequirement!.id,
      visualConstraintAttestations,
      decision: "pass",
      criteria: ["character_identity", "hard_lock", "prop_costume", "scene_continuity", "composition", "image_quality", "raw_labeled_pair"].map((key) => ({ key: key as import("../src/core/types.js").ReviewCriterionKey, result: "pass" as const })),
    });
    const reviewStore = JSON.parse(await readFile(getSidecarPaths(created.targetRoot).reviews, "utf8")) as { records: Array<Record<string, unknown> & { artifactEvidence?: Array<Record<string, unknown>> }> };
    const legacy = reviewStore.records.find((record) => record.id === reviewed.record.id)!;
    delete legacy.requirementId;
    delete legacy.requirement;
    for (const evidence of legacy.artifactEvidence ?? []) delete evidence.fusionStoryboardPanel;
    await writeFile(getSidecarPaths(created.targetRoot).reviews, `${JSON.stringify(reviewStore, null, 2)}\n`, "utf8");
    await rm(getSidecarPaths(created.targetRoot).storyboardGridSelections, { force: true });
    const migration = await migrateFusionStoryboardEvidence(created.targetRoot, { itemIds: [unitId] });
    expect(migration).toMatchObject({ migratedSelections: 1, migratedReviews: 1 });
    expect(migration.items[0]).toMatchObject({ itemId: unitId, selection: "persisted", review: "migrated", migratedFromReviewId: reviewed.record.id, completedPanelCount: 4, missingPanelIndexes: [] });
    const migratedReviewId = migration.items[0]!.reviewId!;
    await materializeFusionPanelReferenceResolutions(created.targetRoot);
    const readyState = await getFusionStoryboardSheetState(created.targetRoot, { itemId: unitId, contractId: contract.contractId });
    expect(readyState.readiness).toMatchObject({ canRender: true, expectedInputFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u) });
    const renderInput = { itemId: unitId, contractId: contract.contractId, expectedInputFingerprint: readyState.readiness.expectedInputFingerprint! };

    const generationJobsPath = getSidecarPaths(created.targetRoot).generationJobs;
    const validGenerationJobs = await readFile(generationJobsPath, "utf8");

    const missingPrimaryIntentJobs = JSON.parse(validGenerationJobs) as typeof jobs;
    delete missingPrimaryIntentJobs.find((candidate) => candidate.id === first.id)!.publicationIntentId;
    await writeFile(generationJobsPath, `${JSON.stringify(missingPrimaryIntentJobs, null, 2)}\n`, "utf8");
    await scanAndPersist(created.targetRoot, { includeHashes: true });
    const missingPrimaryIntentState = await getFusionStoryboardSheetState(created.targetRoot, { itemId: unitId, contractId: contract.contractId });
    expect(missingPrimaryIntentState.readiness.canRender).toBe(false);
    expect(missingPrimaryIntentState.readiness.blockers.join("；")).toMatch(/Publication 身份|raw Publication/u);
    await writeFile(generationJobsPath, validGenerationJobs, "utf8");
    await scanAndPersist(created.targetRoot, { includeHashes: true });

    const downgradedBundleJobs = JSON.parse(validGenerationJobs) as typeof jobs;
    const downgradedBundleJob = downgradedBundleJobs.find((candidate) => candidate.id === first.id)!;
    delete downgradedBundleJob.publicationBundleId;
    delete downgradedBundleJob.companionPublicationIntentId;
    delete downgradedBundleJob.companionPublicationReservationToken;
    delete downgradedBundleJob.companionPublicationReceiptId;
    await writeFile(generationJobsPath, `${JSON.stringify(downgradedBundleJobs, null, 2)}\n`, "utf8");
    await scanAndPersist(created.targetRoot, { includeHashes: true });
    const downgradedBundleState = await getFusionStoryboardSheetState(created.targetRoot, { itemId: unitId, contractId: contract.contractId });
    expect(downgradedBundleState.readiness.canRender).toBe(false);
    expect(downgradedBundleState.readiness.blockers.join("；")).toMatch(/raw Publication 回执无效|Publication/u);
    await writeFile(generationJobsPath, validGenerationJobs, "utf8");
    await scanAndPersist(created.targetRoot, { includeHashes: true });

    const missingCompanionJobs = JSON.parse(validGenerationJobs) as typeof jobs;
    delete missingCompanionJobs.find((candidate) => candidate.id === first.id)!.companionPublicationReceiptId;
    await writeFile(generationJobsPath, `${JSON.stringify(missingCompanionJobs, null, 2)}\n`, "utf8");
    await scanAndPersist(created.targetRoot, { includeHashes: true });
    const missingCompanionState = await getFusionStoryboardSheetState(created.targetRoot, { itemId: unitId, contractId: contract.contractId });
    expect(missingCompanionState.readiness.canRender).toBe(false);
    expect(missingCompanionState.readiness.blockers.join("；")).toMatch(/labeled Publication bundle/u);
    await expect(renderCompletedFusionStoryboardSheetForProject(created.targetRoot, renderInput)).rejects.toThrow(/Review requirement|证据门禁/u);
    await writeFile(generationJobsPath, validGenerationJobs, "utf8");
    await scanAndPersist(created.targetRoot, { includeHashes: true });
    expect((await getFusionStoryboardSheetState(created.targetRoot, { itemId: unitId, contractId: contract.contractId })).readiness.canRender).toBe(true);

    const indexPath = getSidecarPaths(created.targetRoot).index;
    const validIndex = await readFile(indexPath, "utf8");
    const unsafeIndex = JSON.parse(validIndex) as { items: Array<{ id: string; infoPath?: string }> };
    const outsideStoryboardDirectory = path.join(data.root, "outside-storyboard");
    const outsideInfoPath = path.join(outsideStoryboardDirectory, "00_信息.md");
    const linkedStoryboardDirectory = path.join(created.targetRoot, "unsafe-story-link");
    await mkdir(outsideStoryboardDirectory, { recursive: true });
    await writeFile(outsideInfoPath, "# 不安全符号链接测试\n", "utf8");
    await symlink(outsideStoryboardDirectory, linkedStoryboardDirectory, "dir");
    unsafeIndex.items.find((candidate) => candidate.id === unitId)!.infoPath = path.join(linkedStoryboardDirectory, "00_信息.md");
    await writeFile(indexPath, `${JSON.stringify(unsafeIndex, null, 2)}\n`, "utf8");
    await expect(renderCompletedFusionStoryboardSheetForProject(created.targetRoot, renderInput)).rejects.toThrow(/真实路径越出|符号链接|unsafe_info_path/u);
    await expect(access(path.join(outsideStoryboardDirectory, "AI画布生成"))).rejects.toThrow();
    await writeFile(indexPath, validIndex, "utf8");
    await rm(linkedStoryboardDirectory, { force: true });

    const safeStoryboardDirectory = path.join(created.targetRoot, "safe-storyboard-output-boundary");
    const safeStoryboardInfo = path.join(safeStoryboardDirectory, "00_信息.md");
    const outsideOutputDirectory = path.join(data.root, "outside-sheet-output");
    await mkdir(safeStoryboardDirectory, { recursive: true });
    await mkdir(outsideOutputDirectory, { recursive: true });
    await writeFile(safeStoryboardInfo, "# 安全单元目录，输出子目录被篡改\n", "utf8");
    await symlink(outsideOutputDirectory, path.join(safeStoryboardDirectory, "AI画布生成"), "dir");
    const outputSymlinkIndex = JSON.parse(validIndex) as { items: Array<{ id: string; infoPath?: string }> };
    outputSymlinkIndex.items.find((candidate) => candidate.id === unitId)!.infoPath = safeStoryboardInfo;
    await writeFile(indexPath, `${JSON.stringify(outputSymlinkIndex, null, 2)}\n`, "utf8");
    await expect(renderCompletedFusionStoryboardSheetForProject(created.targetRoot, renderInput)).rejects.toThrow(/输出目录.*符号链接|输出目录真实路径/u);
    await expect(readdir(outsideOutputDirectory)).resolves.toEqual([]);
    await writeFile(indexPath, validIndex, "utf8");
    await rm(safeStoryboardDirectory, { recursive: true, force: true });

    const sheet = await renderCompletedFusionStoryboardSheetForProject(created.targetRoot, renderInput);
    expect(sheet).toMatchObject({ itemId: unitId, panelCount: 4, width: 2160, height: 3840, generationJobIds: jobs.map((job) => job.id), reviewId: migratedReviewId, requirementId: reviewEntry.reviewRequirement!.id });
    expect(await sharp(sheet.png.path).metadata()).toMatchObject({ width: 2160, height: 3840, format: "png" });
    expect((await renderCompletedFusionStoryboardSheetForProject(created.targetRoot, renderInput)).reused).toBe(true);

    const currentSheetScan = await scanAndPersist(created.targetRoot, { includeHashes: true });
    const currentSheetArtifacts = currentSheetScan.artifacts.filter((artifact) => artifact.fusionStoryboardSheet?.sheetId === sheet.sheetId);
    expect(currentSheetArtifacts).toHaveLength(3);
    expect(new Set(currentSheetArtifacts.map((artifact) => artifact.fusionStoryboardSheet?.role))).toEqual(new Set(["png", "svg", "receipt"]));
    expect(currentSheetArtifacts.every((artifact) => artifact.fusionStoryboardSheet?.status === "current"
      && artifact.authoritative
      && artifact.accepted
      && artifact.check.ok
      && Boolean(artifact.check.sha256)), JSON.stringify(currentSheetArtifacts.map((artifact) => ({
        role: artifact.fusionStoryboardSheet?.role,
        status: artifact.fusionStoryboardSheet?.status,
        reasons: artifact.fusionStoryboardSheet?.reasons,
        authoritative: artifact.authoritative,
        accepted: artifact.accepted,
        check: artifact.check,
      })))).toBe(true);
    expect(currentSheetScan.summary.storyboardSheets).toMatchObject({ current: 1, stale: 0, invalid: 0, legacyInvalid: 0, pages: 1 });

    const retry = await enqueueFusionStoryboardPanel(created.targetRoot, { itemId: unitId, contractId: contract.contractId, panelIndex: 2 });
    await processGenerationQueue(created.targetRoot, { jobId: retry.id });
    const retryScan = await scanAndPersist(created.targetRoot, { includeHashes: true });
    expect(retryScan.items.find((item) => item.id === unitId)?.status).not.toBe("待视频");
    const staleSheetArtifacts = retryScan.artifacts.filter((artifact) => artifact.fusionStoryboardSheet?.sheetId === sheet.sheetId);
    expect(staleSheetArtifacts).toHaveLength(3);
    expect(staleSheetArtifacts.every((artifact) => artifact.fusionStoryboardSheet?.status === "stale"
      && !artifact.authoritative
      && !artifact.accepted
      && artifact.check.ok), JSON.stringify(staleSheetArtifacts.map((artifact) => ({
        role: artifact.fusionStoryboardSheet?.role,
        status: artifact.fusionStoryboardSheet?.status,
        reasons: artifact.fusionStoryboardSheet?.reasons,
        authoritative: artifact.authoritative,
        accepted: artifact.accepted,
        check: artifact.check,
      })))).toBe(true);
    expect(retryScan.summary.storyboardSheets).toMatchObject({ current: 0, stale: 1, invalid: 0, legacyInvalid: 0, pages: 1 });
    const stalePng = staleSheetArtifacts.find((artifact) => artifact.fusionStoryboardSheet?.role === "png")!;
    const storedOverrides = JSON.parse(await readFile(getSidecarPaths(created.targetRoot).overrides, "utf8")) as {
      schemaVersion: number;
      items: Record<string, Record<string, unknown>>;
    };
    storedOverrides.items[unitId] = {
      ...(storedOverrides.items[unitId] ?? {}),
      authoritativePath: stalePng.path,
      authoritativeArtifactId: stalePng.id,
      updatedAt: new Date().toISOString(),
    };
    await writeFile(getSidecarPaths(created.targetRoot).overrides, `${JSON.stringify(storedOverrides, null, 2)}\n`, "utf8");
    const forcedStaleScan = await scanAndPersist(created.targetRoot, { includeHashes: true });
    const forcedStaleArtifacts = forcedStaleScan.artifacts.filter((artifact) => artifact.fusionStoryboardSheet?.sheetId === sheet.sheetId);
    expect(forcedStaleArtifacts.every((artifact) => !artifact.authoritative)).toBe(true);
    expect(forcedStaleScan.items.find((item) => item.id === unitId)?.thumbnailPath).not.toBe(stalePng.path);
    await expect(renderCompletedFusionStoryboardSheetForProject(created.targetRoot, renderInput)).rejects.toThrow(/门禁未通过|Review requirement|有效视觉通过 Review/u);
    await cancelGenerationJob(created.targetRoot, retry.id);
    const restoredSheetScan = await scanAndPersist(created.targetRoot, { includeHashes: true });
    expect(restoredSheetScan.items.find((item) => item.id === unitId)?.status).toBe("待视频");
    expect(restoredSheetScan.artifacts.filter((artifact) => artifact.fusionStoryboardSheet?.sheetId === sheet.sheetId)
      .every((artifact) => artifact.fusionStoryboardSheet?.status === "current" && artifact.authoritative)).toBe(true);

    const placements = {
      [contract.panels[0]!.id]: {
        fit: "crop" as const,
        reason: "测试保留主体焦点",
        focalPoint: { x: 0.42, y: 0.36 },
      },
    };
    const cropReadyState = await getFusionStoryboardSheetState(created.targetRoot, {
      itemId: unitId,
      contractId: contract.contractId,
      placements,
    });
    expect(cropReadyState.readiness).toMatchObject({ canRender: true, expectedInputFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u) });
    const croppedSheet = await renderCompletedFusionStoryboardSheetForProject(created.targetRoot, {
      itemId: unitId,
      contractId: contract.contractId,
      expectedInputFingerprint: cropReadyState.readiness.expectedInputFingerprint!,
      placements,
    });
    expect(croppedSheet.sheetId).not.toBe(sheet.sheetId);
    expect(croppedSheet.cropAudit.find((entry) => entry.panelId === contract.panels[0]!.id)).toMatchObject({
      fit: "crop",
      geometry: "focal-point",
      cropApplied: true,
      focalPoint: { x: 0.42, y: 0.36 },
    });
    const retainedCropState = await getFusionStoryboardSheetState(created.targetRoot, { itemId: unitId, contractId: contract.contractId });
    expect(retainedCropState).toMatchObject({
      currentSheetId: croppedSheet.sheetId,
      readiness: { canRender: true, expectedInputFingerprint: croppedSheet.inputFingerprint },
    });
    const retainedCropReplay = await renderCompletedFusionStoryboardSheetForProject(created.targetRoot, {
      itemId: unitId,
      contractId: contract.contractId,
      expectedInputFingerprint: retainedCropState.readiness.expectedInputFingerprint!,
    });
    expect(retainedCropReplay).toMatchObject({ sheetId: croppedSheet.sheetId, reused: true });
    const croppedSheetScan = await scanAndPersist(created.targetRoot, { includeHashes: true });
    expect(croppedSheetScan.summary.storyboardSheets).toMatchObject({ current: 1, stale: 1, invalid: 0, legacyInvalid: 0, pages: 2 });
    expect(croppedSheetScan.artifacts.filter((artifact) => artifact.fusionStoryboardSheet?.sheetId === croppedSheet.sheetId)
      .every((artifact) => artifact.fusionStoryboardSheet?.status === "current" && artifact.authoritative)).toBe(true);
    expect(croppedSheetScan.artifacts.filter((artifact) => artifact.fusionStoryboardSheet?.sheetId === sheet.sheetId)
      .every((artifact) => artifact.fusionStoryboardSheet?.status === "stale" && !artifact.authoritative)).toBe(true);

    const authoritySourcePath = reviewEntry.reviewRequirement!.panels[0]!.referenceBoard!.sourceAssets[0]!.path;
    const authoritySource = await readFile(authoritySourcePath);
    await sharp({ create: { width: 720, height: 1280, channels: 3, background: "#5a1321" } }).png().toFile(authoritySourcePath);
    const authorityDrift = await scanAndPersist(created.targetRoot, { includeHashes: true });
    expect(authorityDrift.items.find((item) => item.id === unitId)?.status).not.toBe("待视频");
    await expect(renderCompletedFusionStoryboardSheetForProject(created.targetRoot, renderInput)).rejects.toThrow(/门禁未通过|Review requirement|有效视觉通过 Review/u);
    await writeFile(authoritySourcePath, authoritySource);
    expect((await scanAndPersist(created.targetRoot, { includeHashes: true })).items.find((item) => item.id === unitId)?.status).toBe("待视频");

    const middleSource = await readFile(middleA.resultPath!);
    await sharp({ create: { width: 720, height: 1280, channels: 3, background: "#123456" } }).png().toFile(middleA.resultPath!);
    const drifted = await scanAndPersist(created.targetRoot, { includeHashes: true });
    expect(drifted.items.find((item) => item.id === unitId)?.status).not.toBe("待视频");
    expect((await getReviewQueue(created.targetRoot)).find((entry) => entry.item.id === unitId)?.latestReview).toBeUndefined();
    await expect(renderCompletedFusionStoryboardSheetForProject(created.targetRoot, renderInput)).rejects.toThrow(/门禁未通过|Review requirement|有效视觉通过 Review/u);
    await writeFile(middleA.resultPath!, middleSource);
    expect((await scanAndPersist(created.targetRoot, { includeHashes: true })).items.find((item) => item.id === unitId)?.status).toBe("待视频");

    const sidecar = getSidecarPaths(created.targetRoot);
    const store = JSON.parse(await readFile(sidecar.storyboards, "utf8")) as { rows: Array<{ order: number; referenceNames: string[] }> };
    store.rows.find((row) => row.order === 1)!.referenceNames = ["C01", "S01", "P01", "C02", "S02", "P02", "C03"];
    await writeFile(sidecar.storyboards, `${JSON.stringify(store, null, 2)}\n`, "utf8");
    const storyboardDrift = await scanAndPersist(created.targetRoot, { includeHashes: true });
    expect(storyboardDrift.items.find((item) => item.id === unitId)?.fusionStoryboard).toBeUndefined();
    expect(storyboardDrift.items.find((item) => item.id === unitId)?.status).not.toBe("待视频");
    await expect(buildFusionReferenceBoard(created.targetRoot, index, unitId, "start")).rejects.toThrow(/超过 6 项硬上限/u);
  }, 120_000);

  it("物化逐格引用闭包，已知资产不丢绑定，人工覆盖使用 store revision 与 resolution 双 CAS", async () => {
    const data = await fixture();
    const created = await materializeFusionProject({ inspection: data.inspection, targetParent: data.targetParent });
    await scanAndPersist(created.targetRoot);
    const first = await materializeFusionPanelReferenceResolutions(created.targetRoot);
    expect(first.audit).toMatchObject({ currentContracts: 1, unresolvedPanels: 0, knownAssetMissingBindings: 0, unhandledOverflowPanels: 0, timeSpanContinuityMismatches: 0 });
    expect(Object.values(first.resolutions).every((resolution) => resolution.referenceSlots.length <= 6)).toBe(true);
    expect(Object.values(first.resolutions).every((resolution) => resolution.semanticAssets.every((asset) => resolution.referenceSlots.some((slot) => slot.coveredAssetIds.includes(asset.assetId))))).toBe(true);
    const current = Object.values(first.resolutions)[0]!;
    expect(current.generationReady).toBe(false);
    const jobsBefore = await readFile(getSidecarPaths(created.targetRoot).generationJobs, "utf8").catch(() => "[]");
    const publicationsBefore = await listPublicationIntents(created.targetRoot);
    await expect(enqueueFusionStoryboardPanel(created.targetRoot, {
      itemId: current.unitItemId,
      contractId: current.gridContractId,
      panelIndex: current.panelIndex,
    })).rejects.toThrow(/已解析但尚未生产就绪|pending-hard-lock/u);
    expect(await readFile(getSidecarPaths(created.targetRoot).generationJobs, "utf8").catch(() => "[]")).toBe(jobsBefore);
    expect(await listPublicationIntents(created.targetRoot)).toEqual(publicationsBefore);

    const updated = await upsertPanelReferenceOverride(created.targetRoot, {
      contractId: current.gridContractId,
      panelId: current.panelId,
      expectedResolutionId: current.resolutionId,
      expectedStoreRevision: first.revision,
      includeAssetIds: ["P01"],
      reason: "测试 CAS：补入当前已知道具",
    });
    const resolved = await getFusionPanelReferenceResolution(created.targetRoot, current.gridContractId, current.panelId);
    expect(updated.revision).toBeGreaterThan(first.revision);
    expect(resolved.resolutionId).not.toBe(current.resolutionId);
    expect(resolved.closureStatus).not.toBe("unresolved");
    await expect(upsertPanelReferenceOverride(created.targetRoot, {
      contractId: current.gridContractId,
      panelId: current.panelId,
      expectedResolutionId: current.resolutionId,
      expectedStoreRevision: first.revision,
      excludeAssetIds: ["P01"],
      reason: "故意使用旧修订",
    })).rejects.toThrow(/修订冲突|resolution 已变化/u);
  });

  it("超过六项时保留完整语义集合并建立结构审核派生资产，不裁掉第七项", async () => {
    const data = await fixture();
    const created = await materializeFusionProject({
      inspection: data.inspection,
      targetParent: data.targetParent,
      authorities: [{
        id: "authority-all-test-assets",
        assetId: "C01",
        name: "组合参考测试权威图",
        sourcePath: data.authorityPath,
        expectedSha256: data.authoritySha256,
        rules: ["组合图成员硬锁测试"],
        exposeToGeneration: true,
      }],
    });
    await scanAndPersist(created.targetRoot);
    const sidecar = getSidecarPaths(created.targetRoot);
    const catalog = JSON.parse(await readFile(sidecar.productionAssets, "utf8"));
    const continuity = JSON.parse(await readFile(sidecar.continuityTracks, "utf8"));
    const storyboard = JSON.parse(await readFile(sidecar.storyboards, "utf8"));
    const template = catalog.assets.find((entry: { definition: { id: string } }) => entry.definition.id === "P01");
    const authority = catalog.assets.find((entry: { definition: { id: string } }) => entry.definition.id === "C01").authority;
    for (const entry of catalog.assets) {
      entry.workItemId = "asset-C01";
      entry.authority = structuredClone(authority);
    }
    const trackTemplate = continuity.tracks.find((track: { assetId: string }) => track.assetId === "P01");
    for (const assetId of ["P02", "P03", "P04", "P05"]) {
      catalog.assets.push({
        ...structuredClone(template),
        workItemId: "asset-C01",
        authority: structuredClone(authority),
        definition: { ...structuredClone(template.definition), id: assetId, name: `测试道具${assetId}`, sourceSectionSha256: createHash("sha256").update(assetId).digest("hex") },
      });
      continuity.tracks.push({
        ...structuredClone(trackTemplate),
        assetId,
        assetName: `测试道具${assetId}`,
        workItemId: `asset-${assetId}`,
        spans: trackTemplate.spans.map((span: Record<string, unknown>) => ({ ...structuredClone(span), id: `${assetId}:EP01_15s_001`, assetId, referenceVersion: createHash("sha256").update(assetId).digest("hex") })),
      });
    }
    // 模拟正式受控修订，而不是 revision 1 旧解析器产物。P2 只会自动排除
    // 被明确识别为初始旧解析器污染的引用，人工修订后的第七项必须保留。
    storyboard.revision += 1;
    storyboard.updatedAt = new Date().toISOString();
    for (const row of storyboard.rows) {
      row.referenceNames = ["C01", "S01", "P01", "P02", "P03", "P04", "P05"];
      row.revision += 1;
      row.updatedAt = storyboard.updatedAt;
    }
    await Promise.all([
      writeFile(sidecar.productionAssets, `${JSON.stringify(catalog, null, 2)}\n`, "utf8"),
      writeFile(sidecar.continuityTracks, `${JSON.stringify(continuity, null, 2)}\n`, "utf8"),
      writeFile(sidecar.storyboards, `${JSON.stringify(storyboard, null, 2)}\n`, "utf8"),
    ]);
    const store = await materializeFusionPanelReferenceResolutions(created.targetRoot);
    const overflow = Object.values(store.resolutions).find((resolution) => resolution.detectedOverflow)!;
    const expectedAssets = ["C01", "P01", "P02", "P03", "P04", "P05", "S01"];
    expect(overflow.semanticAssets.map((asset) => asset.assetId)).toEqual(expectedAssets);
    expect(overflow.referenceSlots).toHaveLength(1);
    expect(overflow.referenceSlots[0]).toMatchObject({ kind: "derived-composite", readiness: "pending-derived-artifact", coveredAssetIds: expectedAssets });
    expect(store.derivedAssets[overflow.overflowHandledByDerivedAssetId!]?.definitionReview.status).toBe("approved");
    expect(store.audit).toMatchObject({ unhandledOverflowPanels: 0, knownAssetMissingBindings: 0 });
    expect(store.audit.maximumReferenceSlotsPerPanel).toBeLessThanOrEqual(6);

    const compositePath = path.join(created.targetRoot, "production", "derived-reference-composite.png");
    await mkdir(path.dirname(compositePath), { recursive: true });
    await sharp({ create: { width: 1_200, height: 1_200, channels: 3, background: "#573b28" } }).png().toFile(compositePath);
    const compositeSha = createHash("sha256").update(await readFile(compositePath)).digest("hex");
    const registered = await registerDerivedPanelReferenceArtifact(created.targetRoot, {
      derivedAssetId: overflow.overflowHandledByDerivedAssetId!,
      expectedStoreRevision: store.revision,
      expectedVersion: store.derivedAssets[overflow.overflowHandledByDerivedAssetId!]!.version,
      filePath: compositePath,
      expectedSha256: compositeSha,
      reviewer: "codex",
      reviewNote: "七项成员均可辨识，构图无裁切，允许作为唯一组合参考槽。",
    });
    const visual = registered.derivedAssets[overflow.overflowHandledByDerivedAssetId!]!;
    expect(visual).toMatchObject({ status: "visual-ready", version: 2, visualArtifact: { sha256: compositeSha, reviewer: "codex", review: { decision: "pass", artifactSha256: compositeSha } } });
    expect(Object.values(registered.resolutions)
      .filter((resolution) => resolution.overflowHandledByDerivedAssetId === visual.id)
      .every((resolution) => resolution.referenceSlots.length === 1
        && resolution.referenceSlots[0]?.readiness === "ready"
        && resolution.generationReady)).toBe(true);

    // 该 P2 压力夹具通过直接改 sidecar 临时造出 P02–P05，并未把它们写入
    // 融合 manifest。P3 必须拒绝把这类非正式目录资产升级成可生成视觉约束，
    // 不能因为组合参考已经通过就绕过 manifest 事实源。
    await expect(materializeFusionPanelVisualConstraints(created.targetRoot))
      .rejects.toThrow(/manifest 不存在的资产|P02/u);

    await sharp({ create: { width: 1_200, height: 1_200, channels: 3, background: "#112233" } }).png().toFile(compositePath);
    const stale = await materializeFusionPanelReferenceResolutions(created.targetRoot);
    expect(stale.derivedAssets[visual.id]).toMatchObject({ status: "stale", version: 2 });
    const staleResolutions = Object.values(stale.resolutions)
      .filter((resolution) => resolution.overflowHandledByDerivedAssetId === visual.id)
    expect(staleResolutions
      .every((resolution) => resolution.blockerCodes.includes("stale-derived-artifact") && !resolution.generationReady)).toBe(true);
    const jobsBefore = await readFile(sidecar.generationJobs, "utf8").catch(() => "[]");
    const publicationsBefore = await listPublicationIntents(created.targetRoot);
    await expect(enqueueFusionStoryboardPanel(created.targetRoot, {
      itemId: staleResolutions[0]!.unitItemId,
      contractId: staleResolutions[0]!.gridContractId,
      panelIndex: staleResolutions[0]!.panelIndex,
    })).rejects.toThrow(/stale-derived-artifact|尚未生产就绪/u);
    expect(await readFile(sidecar.generationJobs, "utf8").catch(() => "[]")).toBe(jobsBefore);
    expect(await listPublicationIntents(created.targetRoot)).toEqual(publicationsBefore);
  });

  it("隔离 source_snapshot 的单元 Markdown 漂移会使 P2 currentness 与生图门禁失败关闭", async () => {
    const data = await fixture();
    const created = await materializeFusionProject({
      inspection: data.inspection,
      targetParent: data.targetParent,
      authorities: fixtureAuthorities(data),
    });
    await scanAndPersist(created.targetRoot);
    const store = await materializeFusionPanelReferenceResolutions(created.targetRoot);
    const resolution = Object.values(store.resolutions)[0]!;
    expect(resolution.generationReady).toBe(true);

    const packageRelative = path.relative(data.sourceRoot, data.packageRoot);
    const snapshotMarkdown = path.join(
      created.targetRoot,
      "source_snapshot",
      packageRelative,
      ...data.inspection.units[0]!.markdownPath.split("/"),
    );
    await writeFile(snapshotMarkdown, `${await readFile(snapshotMarkdown, "utf8")}\nP2 回归漂移\n`, "utf8");
    const currentness = await inspectFusionPanelReferenceCurrentness(created.targetRoot);
    expect(currentness).toMatchObject({ current: false });
    expect(currentness.driftedInputs).toContain("unit-markdowns");
    await expect(enqueueFusionStoryboardPanel(created.targetRoot, {
      itemId: resolution.unitItemId,
      contractId: resolution.gridContractId,
      panelIndex: resolution.panelIndex,
    })).rejects.toThrow(/Markdown|漂移|unit-markdowns/u);
  });

  it("连续性 orphan、track 集合和资产身份漂移均拒绝物化", async () => {
    const data = await fixture();
    const created = await materializeFusionProject({ inspection: data.inspection, targetParent: data.targetParent });
    await scanAndPersist(created.targetRoot);
    await materializeFusionPanelReferenceResolutions(created.targetRoot);
    const continuityPath = getSidecarPaths(created.targetRoot).continuityTracks;
    const originalText = await readFile(continuityPath, "utf8");
    const original = JSON.parse(originalText) as {
      tracks: Array<{
        assetId: string;
        assetName: string;
        spans: Array<{ unitItemId: string }>;
      }>;
    };

    const orphan = structuredClone(original);
    orphan.tracks[0]!.spans[0]!.unitItemId = "season-三-ep99-unit999";
    await writeFile(continuityPath, `${JSON.stringify(orphan, null, 2)}\n`, "utf8");
    await expect(materializeFusionPanelReferenceResolutions(created.targetRoot)).rejects.toThrow(/manifest 不存在|连续性轨|时间段/u);

    await writeFile(continuityPath, originalText, "utf8");
    const missingTrack = structuredClone(original);
    missingTrack.tracks.pop();
    await writeFile(continuityPath, `${JSON.stringify(missingTrack, null, 2)}\n`, "utf8");
    await expect(materializeFusionPanelReferenceResolutions(created.targetRoot)).rejects.toThrow(/资产集合|连续性轨/u);

    await writeFile(continuityPath, originalText, "utf8");
    const identityDrift = structuredClone(original);
    identityDrift.tracks[0]!.assetName = `${identityDrift.tracks[0]!.assetName}-漂移`;
    await writeFile(continuityPath, `${JSON.stringify(identityDrift, null, 2)}\n`, "utf8");
    await expect(materializeFusionPanelReferenceResolutions(created.targetRoot)).rejects.toThrow(/名称或类别|连续性轨/u);
  });

  it("连续性采用半开区间，边界结束的资产不会泄漏到下一格", async () => {
    const data = await fixture();
    const created = await materializeFusionProject({ inspection: data.inspection, targetParent: data.targetParent });
    await scanAndPersist(created.targetRoot);
    const store = await materializeFusionPanelReferenceResolutions(created.targetRoot);
    const panels = Object.values(store.resolutions).sort((left, right) => left.panelIndex - right.panelIndex);
    expect(panels.map((panel) => [panel.startSeconds, panel.endSeconds])).toEqual([[0, 8], [8, 13], [13, 15]]);
    expect(panels[0]!.semanticAssets.map((asset) => asset.assetId)).toEqual(["C01", "S01"]);
    expect(panels[1]!.semanticAssets.map((asset) => asset.assetId)).toEqual(["C01", "P01"]);
    expect(panels[2]!.semanticAssets.map((asset) => asset.assetId)).toEqual(["C01", "P01"]);
    expect(panels[1]!.timelineReconciliations.some((item) => item.assetId === "S01")).toBe(false);
    expect(panels[0]!.timelineReconciliations.some((item) => item.assetId === "P01")).toBe(false);
  });

  it("宫格 selection 路径键与 contract.unit 身份不一致时失败关闭", async () => {
    const data = await fixture();
    const created = await materializeFusionProject({ inspection: data.inspection, targetParent: data.targetParent });
    await scanAndPersist(created.targetRoot);
    await materializeAllFusionStoryboardGrids(created.targetRoot);
    const sidecar = getSidecarPaths(created.targetRoot);
    const selections = JSON.parse(await readFile(sidecar.storyboardGridSelections, "utf8")) as {
      items: Record<string, { contractId: string }>;
    };
    const [unitItemId, selection] = Object.entries(selections.items)[0]!;
    const contractPath = path.join(sidecar.storyboardGrids, unitItemId, `${selection.contractId}.json`);
    const contract = JSON.parse(await readFile(contractPath, "utf8")) as { unit: { unitId: string } };
    contract.unit.unitId = "season-三-ep99-unit999";
    await writeFile(contractPath, `${JSON.stringify(contract, null, 2)}\n`, "utf8");
    await expect(materializeFusionPanelReferenceResolutions(created.targetRoot)).rejects.toThrow(/合同|选择|冲突|不可覆盖|内容不一致|拒绝覆盖/u);
  });

  it("项目内硬锁 pass 提升后若当前图片 Review 改为 rework，P2 会退回 pending-hard-lock", async () => {
    const data = await fixture();
    const created = await materializeFusionProject({
      inspection: data.inspection,
      targetParent: data.targetParent,
      authorities: fixtureAuthorities(data, ["C01", "S01"]),
    });
    const p01 = created.assetCatalog.assets.find((entry) => entry.definition.id === "P01")!;
    await mkdir(p01.outputDirectory, { recursive: true });
    const rawPath = path.join(p01.outputDirectory, "P01_回归资产_raw.png");
    const labeledPath = path.join(p01.outputDirectory, "P01_回归资产_labeled.png");
    await writeCandidate(rawPath, 0x11223344);
    await copyFile(rawPath, labeledPath);
    await scanAndPersist(created.targetRoot, { includeHashes: true });
    const passed = await submitCurrentImageReview(created.targetRoot, "asset-P01", "pass");
    expect(passed.record.decision).toBe("pass");

    const sidecar = getSidecarPaths(created.targetRoot);
    const config = JSON.parse(await readFile(sidecar.config, "utf8")) as {
      hardLocks: Array<{ id: string; name: string; path: string; note: string }>;
    };
    config.hardLocks.push({ id: "P01", name: "P01 回归硬锁", path: rawPath, note: "回归测试显式硬锁" });
    await writeFile(sidecar.config, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    await scanAndPersist(created.targetRoot, { includeHashes: true });
    const ready = await materializeFusionPanelReferenceResolutions(created.targetRoot);
    expect(Object.values(ready.resolutions)
      .filter((resolution) => resolution.semanticAssets.some((asset) => asset.assetId === "P01"))
      .every((resolution) => resolution.semanticAssets.find((asset) => asset.assetId === "P01")?.hardLock)).toBe(true);

    const reworked = await submitCurrentImageReview(created.targetRoot, "asset-P01", "rework");
    expect(reworked.record.decision).toBe("rework");
    const staleCurrentness = await inspectFusionPanelReferenceCurrentness(created.targetRoot);
    expect(staleCurrentness.current).toBe(false);
    expect(staleCurrentness.driftedInputs).toContain("hard-locks");
    const pending = await materializeFusionPanelReferenceResolutions(created.targetRoot);
    const p01Resolutions = Object.values(pending.resolutions)
      .filter((resolution) => resolution.semanticAssets.some((asset) => asset.assetId === "P01"));
    expect(p01Resolutions.length).toBeGreaterThan(0);
    expect(p01Resolutions.every((resolution) => resolution.blockerCodes.includes("pending-hard-lock") && !resolution.generationReady)).toBe(true);
    expect(p01Resolutions.every((resolution) => !resolution.semanticAssets.find((asset) => asset.assetId === "P01")?.hardLock)).toBe(true);
  });

  it("新 P2 任务删除 resolution 字段后不得伪装成 legacy 任务继续执行", async () => {
    const data = await fixture();
    const created = await materializeFusionProject({
      inspection: data.inspection,
      targetParent: data.targetParent,
      authorities: fixtureAuthorities(data),
    });
    await scanAndPersist(created.targetRoot);
    const store = await materializeFusionPanelReferenceResolutions(created.targetRoot);
    expect(store.legacyGenerationJobIds).toEqual([]);
    await materializeFusionPanelVisualConstraints(created.targetRoot);
    const resolution = Object.values(store.resolutions)[0]!;
    const job = await enqueueFusionStoryboardPanel(created.targetRoot, {
      itemId: resolution.unitItemId,
      contractId: resolution.gridContractId,
      panelIndex: resolution.panelIndex,
    });
    const jobsPath = getSidecarPaths(created.targetRoot).generationJobs;
    const jobs = JSON.parse(await readFile(jobsPath, "utf8")) as Array<{
      id: string;
      panelReferenceEvidenceVersion?: number;
      fusionStoryboardPanel?: { panelReferenceResolutionId?: string; panelReferenceResolutionFingerprint?: string };
      fusionReferenceBoard?: { panelReferenceResolutionId?: string; panelReferenceResolutionFingerprint?: string };
    }>;
    const tampered = jobs.find((candidate) => candidate.id === job.id)!;
    delete tampered.panelReferenceEvidenceVersion;
    delete tampered.fusionStoryboardPanel?.panelReferenceResolutionId;
    delete tampered.fusionStoryboardPanel?.panelReferenceResolutionFingerprint;
    delete tampered.fusionReferenceBoard?.panelReferenceResolutionId;
    delete tampered.fusionReferenceBoard?.panelReferenceResolutionFingerprint;
    await writeFile(jobsPath, `${JSON.stringify(jobs, null, 2)}\n`, "utf8");
    await expect(processGenerationQueue(created.targetRoot, { jobId: job.id })).rejects.toThrow(/不在.*白名单|缺少 P2/u);
    const evidence = await loadFusionStoryboardEvidenceSnapshot(created.targetRoot);
    expect(evidence.validPanelJobIds.has(job.id)).toBe(false);
    expect(evidence.bindingsByPath.has(path.resolve(job.expectedOutputPath))).toBe(false);
  });

  it("P2 任务完成并通过 Review 后若人工覆盖重物化，旧 Artifact 与 Review 自动失效", async () => {
    const data = await fixture();
    const created = await materializeFusionProject({
      inspection: data.inspection,
      targetParent: data.targetParent,
      authorities: fixtureAuthorities(data),
    });
    await scanAndPersist(created.targetRoot);
    const initial = await materializeFusionPanelReferenceResolutions(created.targetRoot);
    const firstResolution = Object.values(initial.resolutions).sort((left, right) => left.panelIndex - right.panelIndex)[0]!;
    const contract = await loadCurrentFusionStoryboardGrid(created.targetRoot, firstResolution.unitItemId, firstResolution.gridContractId);
    const jobs = await publishAllPanelJobs(created.targetRoot, firstResolution.unitItemId, contract.contractId, contract.selection.panelCount);
    const reviewed = await submitCurrentImageReview(created.targetRoot, firstResolution.unitItemId, "pass");
    expect(reviewed.record.requirementId).toBeTruthy();
    expect((await scanAndPersist(created.targetRoot, { includeHashes: true })).items
      .find((item) => item.id === firstResolution.unitItemId)?.status).toBe("待视频");

    const changed = await upsertPanelReferenceOverride(created.targetRoot, {
      contractId: firstResolution.gridContractId,
      panelId: firstResolution.panelId,
      expectedResolutionId: firstResolution.resolutionId,
      expectedStoreRevision: initial.revision,
      includeAssetIds: ["P01"],
      reason: "回归测试：为首格补入布囊，必须作废旧图和旧 Review。",
    });
    expect(changed.resolutions[`${firstResolution.gridContractId}:${firstResolution.panelId}`]!.resolutionId)
      .not.toBe(firstResolution.resolutionId);
    const evidence = await loadFusionStoryboardEvidenceSnapshot(created.targetRoot);
    expect(evidence.validPanelJobIds.has(jobs[0]!.id)).toBe(false);
    expect(evidence.referenceEvidenceByJobId.get(jobs[0]!.id)?.issues.join("；")).toMatch(/resolution|P2|P3|视觉约束/u);
    expect(evidence.bindingsByPath.has(path.resolve(jobs[0]!.expectedOutputPath))).toBe(false);

    const rescanned = await scanAndPersist(created.targetRoot, { includeHashes: true });
    expect(rescanned.items.find((item) => item.id === firstResolution.unitItemId)?.status).not.toBe("待视频");
    const queue = (await getReviewQueue(created.targetRoot, { includeResolved: true }))
      .find((entry) => entry.item.id === firstResolution.unitItemId)!;
    expect(queue.latestReview).toBeUndefined();
    expect(queue.reviewRequirement?.id).not.toBe(reviewed.record.requirementId);
  });

  it("同一冻结工程的两个 fresh 副本形成相同 P2 storeFingerprint，单副本二次物化也幂等", async () => {
    const data = await fixture();
    const created = await materializeFusionProject({ inspection: data.inspection, targetParent: data.targetParent });
    await scanAndPersist(created.targetRoot);
    await materializeAllFusionStoryboardGrids(created.targetRoot);
    const cloneA = path.join(data.root, "fresh-a");
    const cloneB = path.join(data.root, "fresh-b");
    await Promise.all([
      cp(created.targetRoot, cloneA, { recursive: true, force: false, errorOnExist: true }),
      cp(created.targetRoot, cloneB, { recursive: true, force: false, errorOnExist: true }),
    ]);
    const [firstA, firstB] = await Promise.all([
      materializeFusionPanelReferenceResolutions(cloneA),
      materializeFusionPanelReferenceResolutions(cloneB),
    ]);
    const secondA = await materializeFusionPanelReferenceResolutions(cloneA);
    expect(firstA.storeFingerprint).toBe(firstB.storeFingerprint);
    expect(firstA.audit.auditFingerprint).toBe(firstB.audit.auditFingerprint);
    expect(firstA.inputSnapshot).toEqual(firstB.inputSnapshot);
    expect(secondA.storeFingerprint).toBe(firstA.storeFingerprint);
    expect(secondA.revision).toBe(firstA.revision);
  });

  it("首次 P2 物化会分别冻结当前合同 resolution 与淘汰旧合同无输出终态，旧任务永久不能执行或映射 Artifact/Review", async () => {
    const fx = await mixedLegacyLedgerFixture();
    const store = await materializeFusionPanelReferenceResolutions(fx.created.targetRoot);
    await materializeFusionPanelVisualConstraints(fx.created.targetRoot);
    expect(store.legacyGenerationJobIds).toEqual([
      fx.currentJob.id,
      fx.obsoleteJob.id,
    ].sort((left, right) => left.localeCompare(right, "en")));

    const currentEvidence = store.legacyGenerationJobEvidence[fx.currentJob.id];
    expect(currentEvidence).toMatchObject({
      kind: "current-resolution",
      contractId: fx.currentContract.contractId,
      panelId: fx.currentJob.fusionStoryboardPanel!.panelId,
    });
    expect(currentEvidence?.jobLedgerFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    if (!currentEvidence || currentEvidence.kind !== "current-resolution") {
      throw new Error("当前合同 legacy job 未冻结为 current-resolution");
    }
    const currentResolution = store.resolutions[`${currentEvidence.contractId}:${currentEvidence.panelId}`];
    expect(currentResolution).toBeDefined();
    expect(currentEvidence.resolutionId).toBe(currentResolution!.resolutionId);
    expect(currentEvidence.resolutionFingerprint).toBe(currentResolution!.resolutionFingerprint);

    const obsoleteEvidence = store.legacyGenerationJobEvidence[fx.obsoleteJob.id];
    expect(obsoleteEvidence).toMatchObject({
      kind: "obsolete-terminal",
      itemId: fx.itemId,
      contractId: fx.obsoleteContract.contractId,
      panelId: fx.obsoleteJob.fusionStoryboardPanel!.panelId,
      terminalStatus: "cancelled",
      disposition: "non-current-contract-no-output",
      publicationIntentIds: [fx.terminalIntent.id],
    });
    expect(obsoleteEvidence?.jobLedgerFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    if (!obsoleteEvidence || obsoleteEvidence.kind !== "obsolete-terminal") {
      throw new Error("淘汰合同 legacy job 未冻结为 obsolete-terminal");
    }
    expect(obsoleteEvidence.publicationLedgerFingerprint).toMatch(/^[a-f0-9]{64}$/u);

    const snapshot = await loadFusionStoryboardEvidenceSnapshot(fx.created.targetRoot);
    expect(snapshot.validPanelJobIds.has(fx.currentJob.id)).toBe(true);
    expect(snapshot.bindingsByPath.has(path.resolve(fx.currentJob.expectedOutputPath))).toBe(true);
    expect(snapshot.validPanelJobIds.has(fx.obsoleteJob.id)).toBe(false);
    expect(snapshot.bindingsByPath.has(path.resolve(fx.obsoleteJob.expectedOutputPath))).toBe(false);
    expect([
      ...snapshot.warnings,
      ...(snapshot.referenceEvidenceByJobId.get(fx.obsoleteJob.id)?.issues ?? []),
    ].join("；")).toMatch(/obsolete|淘汰|终态|非当前合同/u);
    await expect(getBrowserGenerationPlan(fx.created.targetRoot, fx.obsoleteJob.id))
      .rejects.toThrow(/obsolete|淘汰|终态|禁止.*执行/u);
  });

  it("首次 P2 冻结后 legacy job 或其 Publication 账本任一漂移都会失败关闭且 currentness=false", async () => {
    const fx = await mixedLegacyLedgerFixture();
    await materializeFusionPanelReferenceResolutions(fx.created.targetRoot);
    await materializeFusionPanelVisualConstraints(fx.created.targetRoot);
    const originalJobs = await readFile(fx.sidecar.generationJobs, "utf8");
    const originalPublications = await readFile(fx.sidecar.publications, "utf8");

    const expectJobDrift = async (
      mutate: (jobs: Array<import("../src/core/types.js").GenerationJob>) => void,
    ) => {
      const jobs = JSON.parse(originalJobs) as Array<import("../src/core/types.js").GenerationJob>;
      mutate(jobs);
      await writeFile(fx.sidecar.generationJobs, `${JSON.stringify(jobs, null, 2)}\n`, "utf8");
      const currentness = await inspectFusionPanelReferenceCurrentness(fx.created.targetRoot);
      expect(currentness.current).toBe(false);
      expect(currentness.driftedInputs.some((input) => /legacy|generation|历史|任务/u.test(input))).toBe(true);
      await expect(materializeFusionPanelReferenceResolutions(fx.created.targetRoot))
        .rejects.toThrow(/legacy|P2|历史|账本|漂移/u);
      await writeFile(fx.sidecar.generationJobs, originalJobs, "utf8");
      expect((await inspectFusionPanelReferenceCurrentness(fx.created.targetRoot)).current).toBe(true);
    };

    await expectJobDrift((jobs) => {
      jobs.find((job) => job.id === fx.obsoleteJob.id)!.status = "queued";
    });
    await expect(getBrowserGenerationPlan(fx.created.targetRoot, fx.obsoleteJob.id))
      .rejects.toThrow(/obsolete|淘汰|终态|禁止.*执行/u);

    await expectJobDrift((jobs) => {
      jobs.find((job) => job.id === fx.obsoleteJob.id)!.fusionStoryboardPanel!.panelIndex += 1;
    });
    await expectJobDrift((jobs) => {
      const job = jobs.find((candidate) => candidate.id === fx.obsoleteJob.id)!;
      job.resultPath = job.expectedOutputPath;
      job.companionPath = path.join(fx.created.targetRoot, "production", "legacy-obsolete-terminal-job_labeled.png");
      job.publicationReceiptId = "receipt-tampered";
    });
    await expectJobDrift((jobs) => {
      jobs.find((job) => job.id === fx.currentJob.id)!.prompt += " tampered";
    });

    const publications = JSON.parse(originalPublications) as {
      revision: number;
      intents: Array<{ id: string; status: string; revision: number; terminal?: unknown }>;
    };
    const terminalIntent = publications.intents.find((intent) => intent.id === fx.terminalIntent.id)!;
    terminalIntent.status = "reserved";
    terminalIntent.revision += 1;
    delete terminalIntent.terminal;
    publications.revision += 1;
    await writeFile(fx.sidecar.publications, `${JSON.stringify(publications, null, 2)}\n`, "utf8");
    const publicationDrift = await inspectFusionPanelReferenceCurrentness(fx.created.targetRoot);
    expect(publicationDrift.current).toBe(false);
    expect(publicationDrift.driftedInputs.some((input) => /legacy|publication|发布/u.test(input))).toBe(true);
    await expect(materializeFusionPanelReferenceResolutions(fx.created.targetRoot))
      .rejects.toThrow(/legacy|P2|历史|Publication|发布|账本|漂移/u);
    await writeFile(fx.sidecar.publications, originalPublications, "utf8");
    expect((await inspectFusionPanelReferenceCurrentness(fx.created.targetRoot)).current).toBe(true);
  });

  it.each([
    {
      name: "淘汰旧合同任务不是 failed/cancelled 终态",
      options: {
        mutateObsoleteJob: (job: import("../src/core/types.js").GenerationJob) => { job.status = "queued"; },
      },
    },
    {
      name: "淘汰旧合同任务已经声明 result/companion 输出",
      options: {
        mutateObsoleteJob: (job: import("../src/core/types.js").GenerationJob) => {
          job.resultPath = job.expectedOutputPath;
          job.companionPath = `${job.expectedOutputPath}.labeled.png`;
        },
      },
    },
    {
      name: "淘汰旧合同任务已经声明 Publication receipt",
      options: {
        mutateObsoleteJob: (job: import("../src/core/types.js").GenerationJob) => {
          job.publicationReceiptId = "receipt-unsafe";
          job.companionPublicationReceiptId = "receipt-companion-unsafe";
        },
      },
    },
    {
      name: "淘汰旧合同任务的宫格身份已被改写",
      options: {
        mutateObsoleteJob: (job: import("../src/core/types.js").GenerationJob) => {
          job.fusionStoryboardPanel!.panelIndex += 1;
        },
      },
    },
    {
      name: "淘汰旧合同关联 Publication 已注册并带 receipt",
      options: {
        mutatePublicationStore: (store: Record<string, unknown>) => {
          const intents = store.intents as Array<Record<string, unknown>>;
          const intent = intents[0]!;
          intent.status = "registered";
          intent.receiptId = "receipt-unsafe";
          const receipts = store.receipts as Array<Record<string, unknown>>;
          receipts.push({
            schemaVersion: 1,
            id: "receipt-unsafe",
            intentId: intent.id,
            projectId: intent.projectId,
            targetPath: intent.targetPath,
          });
        },
      },
    },
  ])("首次 P2 物化遇到 $name 时拒绝建立历史旁路", async ({ options }) => {
    const fx = await mixedLegacyLedgerFixture(options);
    await expect(materializeFusionPanelReferenceResolutions(fx.created.targetRoot))
      .rejects.toThrow(/legacy|P2|历史|淘汰|终态|输出|receipt|Publication|身份|合同/u);
    await expect(access(fx.sidecar.panelReferenceResolutions)).rejects.toThrow();
  });
});
