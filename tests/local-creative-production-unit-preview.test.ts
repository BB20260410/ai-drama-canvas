import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, realpath, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { executeIdempotentCommand, listCommandLedger } from "../src/core/command-bus.js";
import { importLocalCreativeProjectContent } from "../src/core/local-creative-project-content-import.js";
import { materializeLocalCreativeProductionUnits } from "../src/core/local-creative-production-unit-materializer.js";
import { materializeLocalCreativeProject } from "../src/core/local-creative-project-materializer.js";
import { previewLocalCreativeProductionUnits } from "../src/core/local-creative-production-unit-preview.js";
import { inspectLocalCreativeProject } from "../src/core/local-creative-project-ingest.js";
import {
  analyzeStudioScriptEntities,
  confirmStudioPanelEmptyFromControl,
  getStudioBindingControl,
} from "../src/core/studio-binding-control.js";
import {
  appendStudioPromptRevision,
  appendStudioScriptRevision,
  createStudioProductionUnit,
  createStudioPromptDocument,
  createStudioScriptDocument,
  getStudioProductionState,
  getStudioProductionUnitSnapshot,
} from "../src/core/studio-production.js";
import {
  prepareLocalCreativeUnitSourceContract,
  readLocalCreativeUnitSourceContract,
} from "../src/core/local-creative-unit-source-contract.js";

const roots: string[] = [];

async function directoryNamesOrEmpty(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory)).sort((left, right) => left.localeCompare(right, "en"));
  } catch (error) {
    if (error instanceof Error && "code" in error
      && (error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

afterEach(async () => {
  delete process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE;
  delete process.env.AI_CANVAS_TEST_LOCAL_UNIT_BEFORE_WRITE_DELAY_MS;
  delete process.env.AI_CANVAS_TEST_LOCAL_UNIT_AFTER_WRITE_DELAY_MS;
  delete process.env.AI_CANVAS_TEST_LOCAL_UNIT_CRASH_BEFORE_SOURCE_CONTRACT;
  delete process.env.AI_CANVAS_TEST_LOCAL_UNIT_CRASH_AFTER_INTENT_BEFORE_STUDIO;
  delete process.env.AI_CANVAS_TEST_LOCAL_UNIT_CRASH_AFTER_COMMIT_COUNT;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function duduFixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "ai-canvas-dudu-unit-preview-")));
  roots.push(root);
  const projectsRoot = path.join(root, "projects");
  const sourceRoot = path.join(root, "世界观概念序章_测试");
  await Promise.all([
    mkdir(projectsRoot),
    mkdir(path.join(sourceRoot, "02_BindingSet"), { recursive: true }),
  ]);
  const script = [
    "# 分镜",
    "",
    "## W00｜错误的星｜00:00–00:12｜2 格",
    "",
    "| 格 | 时长 | 景别／机位 | 静态故事板画面 | 运动／转场 | 声音／文字 |",
    "|---|---:|---|---|---|---|",
    "| G1 | 5s | 黑场／固定 | 一粒冷光 | 冷光出现 | 鼻息 |",
    "| G2 | 7s | 大远景／缓降 | 星痕越过群山 | 缓降落山 | 无对白 |",
    "",
  ].join("\n");
  const frames = [
    { id: "W00_G01", unit: "W00", grid: "G01", prompt: "第一格正式提示词", referenced_image_paths: [] },
    { id: "W00_G02", unit: "W00", grid: "G02", prompt: "第二格正式提示词", referenced_image_paths: ["/readonly/reference.png"] },
  ];
  await Promise.all([
    writeFile(path.join(sourceRoot, "01_分镜宫格故事版剧本.md"), script, "utf8"),
    writeFile(
      path.join(sourceRoot, "02_BindingSet", "00_逐格任务清单.json"),
      `${JSON.stringify({ schema_version: "1.0", total: frames.length, frames }, null, 2)}\n`,
      "utf8",
    ),
  ]);
  const materialized = await materializeLocalCreativeProject({
    projectsRoot,
    project: {
      key: "dudu-preview-test",
      name: "嘟嘟预览测试",
      projectType: "story-production",
      resolution: "CREATE_MANAGED",
      sources: [{ root: sourceRoot, role: "PRIMARY_AUTHORITY" }],
      authorityPolicy: "EVIDENCE_REQUIRED",
      scanSummary: {
        statistics: {
          totalFiles: 2,
          totalBytes: 1,
          byMediaKind: { document: 2, image: 0, video: 0, audio: 0 },
        },
      },
    },
  });
  return { sourceRoot, projectRoot: materialized.projectRoot };
}

async function writeTaskFrames(
  sourceRoot: string,
  frames: Array<Record<string, unknown>>,
): Promise<void> {
  await writeFile(
    path.join(sourceRoot, "02_BindingSet", "00_逐格任务清单.json"),
    `${JSON.stringify({ schema_version: "1.0", total: frames.length, frames }, null, 2)}\n`,
    "utf8",
  );
}

async function writeTwoUnitSource(sourceRoot: string): Promise<void> {
  const script = [
    "# 分镜",
    "",
    "## W00｜错误的星｜00:00–00:12｜2 格",
    "",
    "| 格 | 时长 | 景别／机位 | 静态故事板画面 | 运动／转场 | 声音／文字 |",
    "|---|---:|---|---|---|---|",
    "| G1 | 5s | 黑场／固定 | 一粒冷光 | 冷光出现 | 鼻息 |",
    "| G2 | 7s | 大远景／缓降 | 星痕越过群山 | 缓降落山 | 无对白 |",
    "",
    "## W01｜山谷回声｜00:12–00:24｜2 格",
    "",
    "| 格 | 时长 | 景别／机位 | 静态故事板画面 | 运动／转场 | 声音／文字 |",
    "|---|---:|---|---|---|---|",
    "| G1 | 6s | 远景／固定 | 山谷泛白 | 云层移动 | 风声 |",
    "| G2 | 6s | 中景／微推 | 石壁震动 | 微推石壁 | 回声 |",
    "",
  ].join("\n");
  await writeFile(path.join(sourceRoot, "01_分镜宫格故事版剧本.md"), script, "utf8");
  await writeTaskFrames(sourceRoot, [
    { id: "W00_G01", unit: "W00", grid: "G01", prompt: "W00 第一格", referenced_image_paths: [] },
    { id: "W00_G02", unit: "W00", grid: "G02", prompt: "W00 第二格", referenced_image_paths: [] },
    { id: "W01_G01", unit: "W01", grid: "G01", prompt: "W01 第一格", referenced_image_paths: [] },
    { id: "W01_G02", unit: "W01", grid: "G02", prompt: "W01 第二格", referenced_image_paths: [] },
  ]);
}

async function seedSequenceOccupant(
  projectRoot: string,
  candidate: { season: string; episode: string; sequence: number },
): Promise<void> {
  const script = await createStudioScriptDocument(projectRoot, {
    id: "script-sequence-occupant",
    title: "序号占用测试剧本",
    expectedRevision: 0,
  });
  const scriptRevision = (await appendStudioScriptRevision(projectRoot, {
    documentId: script.id,
    expectedRevision: 0,
    body: "预置单元占用同一时间线序号。",
    source: "test",
    sourceVersion: "v1",
  })).revision;
  const prompt = await createStudioPromptDocument(projectRoot, {
    id: "prompt-sequence-occupant",
    title: "序号占用测试提示词",
    expectedRevision: 0,
  });
  const promptRevision = (await appendStudioPromptRevision(projectRoot, {
    documentId: prompt.id,
    expectedRevision: 0,
    body: "测试提示词。",
    source: "test",
    sourceVersion: "v1",
  })).revision;
  await createStudioProductionUnit(projectRoot, {
    id: "unit-sequence-occupant",
    season: candidate.season,
    episode: candidate.episode,
    sequence: candidate.sequence,
    title: "预置序号占用单元",
    durationSeconds: 12,
    scriptRevisionId: scriptRevision.id,
    expectedRevision: 0,
    panels: [0, 1].map((index) => ({
      id: `occupant-panel-${index + 1}`,
      title: `占位格 ${index + 1}`,
      visualAction: "静态测试画面。",
      shotComposition: "固定中景。",
      filmingMethod: "固定机位。",
      startSeconds: index * 6,
      endSeconds: (index + 1) * 6,
      durationSeconds: 6,
      promptRevisionId: promptRevision.id,
      sourceSpans: [{ startOffsetUtf16: 0, endOffsetUtf16: scriptRevision.body.length }],
      assets: [],
    })),
  });
}

describe("本机剧情生产单元只读预览", () => {
  it("按明确嘟嘟证据解析变时长单元、逐格提示词与 UTF-16 原文范围，且预览零写入", async () => {
    const test = await duduFixture();
    const preview = await previewLocalCreativeProductionUnits(test.projectRoot);
    expect(preview).toMatchObject({
      applicability: "eligible",
      adapterId: "dudu-world-prologue-v1",
      unitCount: 1,
      panelCount: 2,
      units: [{
        sourceUnitId: "W00",
        durationSeconds: 12,
        panels: [
          { sourcePanelId: "W00_G01", startSeconds: 0, endSeconds: 5, prompt: "第一格正式提示词" },
          { sourcePanelId: "W00_G02", startSeconds: 5, endSeconds: 12, prompt: "第二格正式提示词" },
        ],
      }],
    });
    expect(preview.sourceFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(preview.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(preview.units[0]!.panels.every((panel) => panel.sourceSpan.endOffsetUtf16 > panel.sourceSpan.startOffsetUtf16)).toBe(true);
  });

  it("旧来源 fingerprint 不能在源文件变化后继续使用", async () => {
    const test = await duduFixture();
    const first = await previewLocalCreativeProductionUnits(test.projectRoot);
    await writeFile(path.join(test.sourceRoot, "新增说明.md"), "源目录已变化。\n", "utf8");
    await expect(previewLocalCreativeProductionUnits(test.projectRoot, {
      expectedSourceFingerprint: first.sourceFingerprint,
    })).rejects.toThrow(/SOURCE_FINGERPRINT_CONFLICT/u);
  });

  it("提示词超过 40000 字符时失败关闭，不生成部分预览", async () => {
    const test = await duduFixture();
    await writeTaskFrames(test.sourceRoot, [
      { id: "W00_G01", unit: "W00", grid: "G01", prompt: "甲".repeat(40_001), referenced_image_paths: [] },
      { id: "W00_G02", unit: "W00", grid: "G02", prompt: "第二格正式提示词", referenced_image_paths: [] },
    ]);
    await expect(previewLocalCreativeProductionUnits(test.projectRoot))
      .rejects.toThrow(/prompt 超过 40000 字符上限/u);
  });

  it("单格参考超过 100 项或单路径超过 4096 字符时失败关闭", async () => {
    const tooMany = await duduFixture();
    await writeTaskFrames(tooMany.sourceRoot, [
      {
        id: "W00_G01",
        unit: "W00",
        grid: "G01",
        prompt: "第一格正式提示词",
        referenced_image_paths: Array.from({ length: 101 }, (_, index) => `/readonly/reference-${index}.png`),
      },
      { id: "W00_G02", unit: "W00", grid: "G02", prompt: "第二格正式提示词", referenced_image_paths: [] },
    ]);
    await expect(previewLocalCreativeProductionUnits(tooMany.projectRoot))
      .rejects.toThrow(/referenced_image_paths 超过 100 项上限/u);

    const pathTooLong = await duduFixture();
    await writeTaskFrames(pathTooLong.sourceRoot, [
      {
        id: "W00_G01",
        unit: "W00",
        grid: "G01",
        prompt: "第一格正式提示词",
        referenced_image_paths: [`/${"a".repeat(4_096)}`],
      },
      { id: "W00_G02", unit: "W00", grid: "G02", prompt: "第二格正式提示词", referenced_image_paths: [] },
    ]);
    await expect(previewLocalCreativeProductionUnits(pathTooLong.projectRoot))
      .rejects.toThrow(/超过 4096 字符上限/u);
  });

  it("任务帧超过 1800 项时失败关闭", async () => {
    const test = await duduFixture();
    await writeTaskFrames(
      test.sourceRoot,
      Array.from({ length: 1_801 }, (_, index) => ({
        id: `W00_G${index}`,
        unit: "W00",
        grid: "G01",
        prompt: "有界提示词",
        referenced_image_paths: [],
      })),
    );
    await expect(previewLocalCreativeProductionUnits(test.projectRoot))
      .rejects.toThrow(/逐格任务帧数量超过上限 1800/u);
  });

  it("单项目超过 300 个单元或单单元超过 6 格时失败关闭", async () => {
    const tooManyUnits = await duduFixture();
    const unitSection = [
      "## W00｜错误的星｜00:00–00:12｜2 格",
      "",
      "| 格 | 时长 | 景别／机位 | 静态故事板画面 | 运动／转场 | 声音／文字 |",
      "|---|---:|---|---|---|---|",
      "| G1 | 5s | 黑场／固定 | 一粒冷光 | 冷光出现 | 鼻息 |",
      "| G2 | 7s | 大远景／缓降 | 星痕越过群山 | 缓降落山 | 无对白 |",
      "",
    ].join("\n");
    await writeFile(
      path.join(tooManyUnits.sourceRoot, "01_分镜宫格故事版剧本.md"),
      ["# 分镜", "", ...Array.from({ length: 301 }, () => unitSection)].join("\n"),
      "utf8",
    );
    await expect(previewLocalCreativeProductionUnits(tooManyUnits.projectRoot))
      .rejects.toThrow(/分镜单元数量超过上限 300/u);

    const tooManyPanels = await duduFixture();
    const rows = Array.from({ length: 7 }, (_, index) => (
      `| G${index + 1} | 1s | 固定 | 动作 ${index + 1} | 无 | 无 |`
    ));
    await writeFile(
      path.join(tooManyPanels.sourceRoot, "01_分镜宫格故事版剧本.md"),
      [
        "# 分镜",
        "",
        "## W00｜错误的星｜00:00–00:07｜7 格",
        "",
        "| 格 | 时长 | 景别／机位 | 静态故事板画面 | 运动／转场 | 声音／文字 |",
        "|---|---:|---|---|---|---|",
        ...rows,
        "",
      ].join("\n"),
      "utf8",
    );
    await writeTaskFrames(
      tooManyPanels.sourceRoot,
      Array.from({ length: 7 }, (_, index) => ({
        id: `W00_G${String(index + 1).padStart(2, "0")}`,
        unit: "W00",
        grid: `G${String(index + 1).padStart(2, "0")}`,
        prompt: `第 ${index + 1} 格提示词`,
        referenced_image_paths: [],
      })),
    );
    await expect(previewLocalCreativeProductionUnits(tooManyPanels.projectRoot))
      .rejects.toThrow(/声明 7 格，实际解析 7 格/u);
  });

  it("只在来源已同步时幂等物化明确候选，保存 12 秒 Canonical Panel 且不猜测资产权威", async () => {
    const test = await duduFixture();
    const sourcePreview = await inspectLocalCreativeProject({
      projectKey: "dudu-preview-test",
      projectName: "嘟嘟预览测试",
      projectType: "story-production",
      sourceLayers: [{ role: "PRIMARY_AUTHORITY", rootPath: test.sourceRoot }],
      computeSha256: true,
    });
    await importLocalCreativeProjectContent({
      projectRoot: test.projectRoot,
      preview: sourcePreview,
      authorityPolicy: "FORBID_ALL",
    });
    const preview = await previewLocalCreativeProductionUnits(test.projectRoot);
    const input = {
      idempotencyKey: "materialize-w00-canary",
      expectedPreviewFingerprint: preview.fingerprint,
      expectedSourceFingerprint: preview.sourceFingerprint!,
      candidateIds: [preview.units[0]!.candidateId],
    };
    const first = await materializeLocalCreativeProductionUnits(test.projectRoot, input);
    const replay = await materializeLocalCreativeProductionUnits(test.projectRoot, input);
    expect(replay).toEqual(first);
    expect(first).toMatchObject({
      sourceSnapshotAtCommit: "current",
      assetBindingReadiness: "blocked-unresolved",
      units: [{
        candidateId: preview.units[0]!.candidateId,
        disposition: "created",
        sourceSoundAndText: [
          { panelId: "W00_G01", value: "鼻息" },
          { panelId: "W00_G02", value: "无对白" },
        ],
      }],
    });
    const state = await getStudioProductionState(test.projectRoot);
    expect(state.counts).toMatchObject({
      scriptDocuments: 1,
      promptDocuments: 2,
      textRevisions: 3,
      units: 1,
      panels: 2,
      unitTimings: 1,
    });
    const snapshot = await getStudioProductionUnitSnapshot(test.projectRoot, first.units[0]!.unitId);
    expect(snapshot).toMatchObject({
      unit: { durationSeconds: 12, episodeStartSeconds: 0, episodeEndSeconds: 12 },
      panels: [
        { id: "W00_G01", startSeconds: 0, endSeconds: 5, assets: [] },
        { id: "W00_G02", startSeconds: 5, endSeconds: 12, assets: [] },
      ],
    });
    const sourceContractDirectory = path.join(
      test.projectRoot,
      ".aicanvas",
      "local-creative-unit-source-contracts",
    );
    await copyFile(
      path.join(sourceContractDirectory, `${first.units[0]!.unitId}-r1.json`),
      path.join(sourceContractDirectory, "unit-local-copied-contract-r1.json"),
    );
    await expect(readLocalCreativeUnitSourceContract(
      test.projectRoot,
      "unit-local-copied-contract",
      1,
    )).rejects.toThrow(/请求的单元修订身份不一致/u);
    const bindingBefore = await getStudioBindingControl(test.projectRoot, { unitId: first.units[0]!.unitId });
    await analyzeStudioScriptEntities(test.projectRoot, {
      unitId: first.units[0]!.unitId,
      panelId: "W00_G02",
      expectedRevisionToken: bindingBefore.revisionToken,
    }, { requestHash: "e".repeat(64), reviewer: "codex" });
    const bindingAfter = await getStudioBindingControl(test.projectRoot, { unitId: first.units[0]!.unitId });
    await expect(confirmStudioPanelEmptyFromControl(test.projectRoot, {
      unitId: first.units[0]!.unitId,
      panelId: "W00_G02",
      expectedRevisionToken: bindingAfter.revisionToken,
      reviewer: "user",
      note: "已经人工核对当前宫格。",
    }, { requestHash: "f".repeat(64), reviewer: "user" })).rejects.toMatchObject({
      code: "binding-blocked",
      message: expect.stringContaining("来源任务已声明参考图"),
    });
  });

  it("内部预览完成后来源再变化时，首次受管写之前失败关闭", async () => {
    const test = await duduFixture();
    const sourcePreview = await inspectLocalCreativeProject({
      projectKey: "dudu-preview-test",
      projectName: "嘟嘟预览测试",
      projectType: "story-production",
      sourceLayers: [{ role: "PRIMARY_AUTHORITY", rootPath: test.sourceRoot }],
      computeSha256: true,
    });
    await importLocalCreativeProjectContent({
      projectRoot: test.projectRoot,
      preview: sourcePreview,
      authorityPolicy: "FORBID_ALL",
    });
    const preview = await previewLocalCreativeProductionUnits(test.projectRoot);
    process.env.AI_CANVAS_TEST_LOCAL_UNIT_BEFORE_WRITE_DELAY_MS = "1000";
    const running = materializeLocalCreativeProductionUnits(test.projectRoot, {
      idempotencyKey: "materialize-w00-race",
      expectedPreviewFingerprint: preview.fingerprint,
      expectedSourceFingerprint: preview.sourceFingerprint!,
      candidateIds: [preview.units[0]!.candidateId],
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    await writeFile(
      path.join(test.sourceRoot, "02_BindingSet", "00_逐格任务清单.json"),
      `${JSON.stringify({
        schema_version: "1.0",
        total: 2,
        frames: [
          { id: "W00_G01", unit: "W00", grid: "G01", prompt: "第一格提示词已变化", referenced_image_paths: [] },
          { id: "W00_G02", unit: "W00", grid: "G02", prompt: "第二格正式提示词", referenced_image_paths: [] },
        ],
      }, null, 2)}\n`,
      "utf8",
    );
    await expect(running).rejects.toThrow(/SOURCE_(?:RACE_DETECTED|FINGERPRINT_CONFLICT)/u);
    const state = await getStudioProductionState(test.projectRoot);
    expect(state.counts).toMatchObject({
      units: 0,
      panels: 0,
    });
  });

  it("仅来源参考声明变化也会升单元修订并保留旧来源合同", async () => {
    const test = await duduFixture();
    const importCurrentSource = async () => {
      const source = await inspectLocalCreativeProject({
        projectKey: "dudu-preview-test",
        projectName: "嘟嘟预览测试",
        projectType: "story-production",
        sourceLayers: [{ role: "PRIMARY_AUTHORITY", rootPath: test.sourceRoot }],
        computeSha256: true,
      });
      await importLocalCreativeProjectContent({
        projectRoot: test.projectRoot,
        preview: source,
        authorityPolicy: "FORBID_ALL",
      });
      return previewLocalCreativeProductionUnits(test.projectRoot);
    };
    const firstPreview = await importCurrentSource();
    const first = await materializeLocalCreativeProductionUnits(test.projectRoot, {
      idempotencyKey: "materialize-reference-contract-v1",
      expectedPreviewFingerprint: firstPreview.fingerprint,
      expectedSourceFingerprint: firstPreview.sourceFingerprint!,
      candidateIds: [firstPreview.units[0]!.candidateId],
    });
    const firstItem = first.units[0]!;
    const oldContract = await readLocalCreativeUnitSourceContract(
      test.projectRoot,
      firstItem.unitId,
      firstItem.unitRevision!,
    );
    expect(oldContract?.fingerprint).toBe(firstItem.sourceContractFingerprint);

    await writeFile(
      path.join(test.sourceRoot, "02_BindingSet", "00_逐格任务清单.json"),
      `${JSON.stringify({
        schema_version: "1.0",
        total: 2,
        frames: [
          { id: "W00_G01", unit: "W00", grid: "G01", prompt: "第一格正式提示词", referenced_image_paths: [] },
          {
            id: "W00_G02",
            unit: "W00",
            grid: "G02",
            prompt: "第二格正式提示词",
            referenced_image_paths: ["/readonly/reference-v2.png"],
          },
        ],
      }, null, 2)}\n`,
      "utf8",
    );
    const secondPreview = await importCurrentSource();
    const second = await materializeLocalCreativeProductionUnits(test.projectRoot, {
      idempotencyKey: "materialize-reference-contract-v2",
      expectedPreviewFingerprint: secondPreview.fingerprint,
      expectedSourceFingerprint: secondPreview.sourceFingerprint!,
      candidateIds: [secondPreview.units[0]!.candidateId],
    });
    const secondItem = second.units[0]!;
    expect(secondItem).toMatchObject({
      unitId: firstItem.unitId,
      unitRevision: 2,
      disposition: "revised",
    });
    expect(secondItem.sourceContractFingerprint).not.toBe(firstItem.sourceContractFingerprint);
    await expect(readLocalCreativeUnitSourceContract(
      test.projectRoot,
      firstItem.unitId,
      firstItem.unitRevision!,
    )).resolves.toEqual(oldContract);
    await expect(readLocalCreativeUnitSourceContract(
      test.projectRoot,
      secondItem.unitId,
      secondItem.unitRevision!,
    )).resolves.toMatchObject({
      fingerprint: secondItem.sourceContractFingerprint,
      panels: expect.arrayContaining([
        expect.objectContaining({
          panelId: "W00_G02",
          declaredReferences: [{
            declaredPath: "/readonly/reference-v2.png",
            importedMediaSha256: null,
          }],
        }),
      ]),
    });
  });

  it("来源参考顺序规范化后新幂等键不会制造无意义修订", async () => {
    const test = await duduFixture();
    await writeFile(
      path.join(test.sourceRoot, "02_BindingSet", "00_逐格任务清单.json"),
      `${JSON.stringify({
        schema_version: "1.0",
        total: 2,
        frames: [
          { id: "W00_G01", unit: "W00", grid: "G01", prompt: "第一格正式提示词", referenced_image_paths: [] },
          {
            id: "W00_G02",
            unit: "W00",
            grid: "G02",
            prompt: "第二格正式提示词",
            referenced_image_paths: [" /readonly/b.png ", "/readonly/a.png"],
          },
        ],
      }, null, 2)}\n`,
      "utf8",
    );
    const source = await inspectLocalCreativeProject({
      projectKey: "dudu-preview-test",
      projectName: "嘟嘟预览测试",
      projectType: "story-production",
      sourceLayers: [{ role: "PRIMARY_AUTHORITY", rootPath: test.sourceRoot }],
      computeSha256: true,
    });
    await importLocalCreativeProjectContent({
      projectRoot: test.projectRoot,
      preview: source,
      authorityPolicy: "FORBID_ALL",
    });
    const preview = await previewLocalCreativeProductionUnits(test.projectRoot);
    const base = {
      expectedPreviewFingerprint: preview.fingerprint,
      expectedSourceFingerprint: preview.sourceFingerprint!,
      candidateIds: [preview.units[0]!.candidateId],
    };
    const first = await materializeLocalCreativeProductionUnits(test.projectRoot, {
      ...base,
      idempotencyKey: "normalized-reference-first",
    });
    const second = await materializeLocalCreativeProductionUnits(test.projectRoot, {
      ...base,
      idempotencyKey: "normalized-reference-second",
    });
    expect(first.units[0]).toMatchObject({ disposition: "created", unitRevision: 1 });
    expect(second.units[0]).toMatchObject({
      disposition: "reused",
      unitRevision: 1,
      sourceContractFingerprint: first.units[0]!.sourceContractFingerprint,
    });
    await rm(path.join(
      test.projectRoot,
      ".aicanvas",
      "local-creative-unit-source-contracts",
      `${first.units[0]!.unitId}-r1.json`,
    ), { force: true });
    await expect(materializeLocalCreativeProductionUnits(test.projectRoot, {
      ...base,
      idempotencyKey: "normalized-reference-first",
    })).rejects.toThrow(/来源合同已缺失或漂移/u);
  });

  it("无关来源文件变化不改写单元，但回执显式保留合同历史来源快照", async () => {
    const test = await duduFixture();
    const sync = async () => {
      const source = await inspectLocalCreativeProject({
        projectKey: "dudu-preview-test",
        projectName: "嘟嘟预览测试",
        projectType: "story-production",
        sourceLayers: [{ role: "PRIMARY_AUTHORITY", rootPath: test.sourceRoot }],
        computeSha256: true,
      });
      await importLocalCreativeProjectContent({
        projectRoot: test.projectRoot,
        preview: source,
        authorityPolicy: "FORBID_ALL",
      });
      return previewLocalCreativeProductionUnits(test.projectRoot);
    };
    const firstPreview = await sync();
    const first = await materializeLocalCreativeProductionUnits(test.projectRoot, {
      idempotencyKey: "materialize-unrelated-source-v1",
      expectedPreviewFingerprint: firstPreview.fingerprint,
      expectedSourceFingerprint: firstPreview.sourceFingerprint!,
      candidateIds: [firstPreview.units[0]!.candidateId],
    });
    await writeFile(path.join(test.sourceRoot, "无关制作笔记.txt"), "不属于当前单元闭包。\n", "utf8");
    const secondPreview = await sync();
    expect(secondPreview.sourceFingerprint).not.toBe(firstPreview.sourceFingerprint);
    expect(secondPreview.units[0]!.fingerprint).toBe(firstPreview.units[0]!.fingerprint);
    const second = await materializeLocalCreativeProductionUnits(test.projectRoot, {
      idempotencyKey: "materialize-unrelated-source-v2",
      expectedPreviewFingerprint: secondPreview.fingerprint,
      expectedSourceFingerprint: secondPreview.sourceFingerprint!,
      candidateIds: [secondPreview.units[0]!.candidateId],
    });
    expect(second.units[0]).toMatchObject({
      disposition: "reused",
      unitRevision: 1,
      sourceContractFingerprint: first.units[0]!.sourceContractFingerprint,
      sourceContractSourceFingerprint: firstPreview.sourceFingerprint,
    });
    expect(second.sourceFingerprint).toBe(secondPreview.sourceFingerprint);
    expect(second.units[0]!.sourceContractSourceFingerprint).not.toBe(second.sourceFingerprint);
  });

  it("受管写期间来源再变化时保留已验快照回执，新来源同步后使用新内容地址恢复", async () => {
    const test = await duduFixture();
    const firstSource = await inspectLocalCreativeProject({
      projectKey: "dudu-preview-test",
      projectName: "嘟嘟预览测试",
      projectType: "story-production",
      sourceLayers: [{ role: "PRIMARY_AUTHORITY", rootPath: test.sourceRoot }],
      computeSha256: true,
    });
    await importLocalCreativeProjectContent({
      projectRoot: test.projectRoot,
      preview: firstSource,
      authorityPolicy: "FORBID_ALL",
    });
    const firstPreview = await previewLocalCreativeProductionUnits(test.projectRoot);
    process.env.AI_CANVAS_TEST_LOCAL_UNIT_AFTER_WRITE_DELAY_MS = "1000";
    const running = materializeLocalCreativeProductionUnits(test.projectRoot, {
      idempotencyKey: "materialize-w00-post-write-race",
      expectedPreviewFingerprint: firstPreview.fingerprint,
      expectedSourceFingerprint: firstPreview.sourceFingerprint!,
      candidateIds: [firstPreview.units[0]!.candidateId],
    });
    for (let attempts = 0; attempts < 30; attempts += 1) {
      if ((await getStudioProductionState(test.projectRoot)).counts.units === 1) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await writeFile(
      path.join(test.sourceRoot, "02_BindingSet", "00_逐格任务清单.json"),
      `${JSON.stringify({
        schema_version: "1.0",
        total: 2,
        frames: [
          { id: "W00_G01", unit: "W00", grid: "G01", prompt: "第一格新来源提示词", referenced_image_paths: [] },
          { id: "W00_G02", unit: "W00", grid: "G02", prompt: "第二格正式提示词", referenced_image_paths: [] },
        ],
      }, null, 2)}\n`,
      "utf8",
    );
    const historical = await running;
    expect(historical.sourceSnapshotAtCommit).toBe("stale-after-verified-snapshot");
    delete process.env.AI_CANVAS_TEST_LOCAL_UNIT_AFTER_WRITE_DELAY_MS;

    const secondSource = await inspectLocalCreativeProject({
      projectKey: "dudu-preview-test",
      projectName: "嘟嘟预览测试",
      projectType: "story-production",
      sourceLayers: [{ role: "PRIMARY_AUTHORITY", rootPath: test.sourceRoot }],
      computeSha256: true,
    });
    await importLocalCreativeProjectContent({
      projectRoot: test.projectRoot,
      preview: secondSource,
      authorityPolicy: "FORBID_ALL",
    });
    const secondPreview = await previewLocalCreativeProductionUnits(test.projectRoot);
    const current = await materializeLocalCreativeProductionUnits(test.projectRoot, {
      idempotencyKey: "materialize-w00-after-race-recovery",
      expectedPreviewFingerprint: secondPreview.fingerprint,
      expectedSourceFingerprint: secondPreview.sourceFingerprint!,
      candidateIds: [secondPreview.units[0]!.candidateId],
    });
    expect(current.sourceSnapshotAtCommit).toBe("current");
    expect(current.units[0]!.unitId).toBe(historical.units[0]!.unitId);
    expect(current.units[0]).toMatchObject({ disposition: "revised", unitRevision: 2 });
    expect((await getStudioProductionState(test.projectRoot)).counts).toMatchObject({
      units: 1,
      panels: 2,
    });
    await expect(materializeLocalCreativeProductionUnits(test.projectRoot, {
      idempotencyKey: "materialize-w00-post-write-race",
      expectedPreviewFingerprint: firstPreview.fingerprint,
      expectedSourceFingerprint: firstPreview.sourceFingerprint!,
      candidateIds: [firstPreview.units[0]!.candidateId],
    })).resolves.toEqual(historical);
  });

  it("Canonical Unit 写入后、来源合同写入前崩溃可在原修订补齐合同", async () => {
    const test = await duduFixture();
    const sourcePreview = await inspectLocalCreativeProject({
      projectKey: "dudu-preview-test",
      projectName: "嘟嘟预览测试",
      projectType: "story-production",
      sourceLayers: [{ role: "PRIMARY_AUTHORITY", rootPath: test.sourceRoot }],
      computeSha256: true,
    });
    await importLocalCreativeProjectContent({
      projectRoot: test.projectRoot,
      preview: sourcePreview,
      authorityPolicy: "FORBID_ALL",
    });
    const preview = await previewLocalCreativeProductionUnits(test.projectRoot);
    const input = {
      idempotencyKey: "materialize-crash-before-contract",
      expectedPreviewFingerprint: preview.fingerprint,
      expectedSourceFingerprint: preview.sourceFingerprint!,
      candidateIds: [preview.units[0]!.candidateId],
    };
    process.env.AI_CANVAS_TEST_LOCAL_UNIT_CRASH_BEFORE_SOURCE_CONTRACT = "1";
    await expect(materializeLocalCreativeProductionUnits(test.projectRoot, input))
      .rejects.toThrow("TEST_CRASH_BEFORE_LOCAL_UNIT_SOURCE_CONTRACT");
    delete process.env.AI_CANVAS_TEST_LOCAL_UNIT_CRASH_BEFORE_SOURCE_CONTRACT;

    const recovered = await materializeLocalCreativeProductionUnits(test.projectRoot, input);
    expect(recovered.units[0]).toMatchObject({
      disposition: "recovered",
      unitRevision: 1,
    });
    await expect(readLocalCreativeUnitSourceContract(
      test.projectRoot,
      recovered.units[0]!.unitId,
      1,
    )).resolves.toMatchObject({
      fingerprint: recovered.units[0]!.sourceContractFingerprint,
      sourceFingerprint: recovered.units[0]!.sourceContractSourceFingerprint,
    });
    expect((await getStudioProductionState(test.projectRoot)).counts.units).toBe(1);
  });

  it("intent 写入后 Studio 尚未写入时，同语义的新幂等键可安全接管", async () => {
    const test = await duduFixture();
    const source = await inspectLocalCreativeProject({
      projectKey: "dudu-preview-test",
      projectName: "嘟嘟预览测试",
      projectType: "story-production",
      sourceLayers: [{ role: "PRIMARY_AUTHORITY", rootPath: test.sourceRoot }],
      computeSha256: true,
    });
    await importLocalCreativeProjectContent({
      projectRoot: test.projectRoot,
      preview: source,
      authorityPolicy: "FORBID_ALL",
    });
    const preview = await previewLocalCreativeProductionUnits(test.projectRoot);
    process.env.AI_CANVAS_TEST_LOCAL_UNIT_CRASH_AFTER_INTENT_BEFORE_STUDIO = "1";
    await expect(materializeLocalCreativeProductionUnits(test.projectRoot, {
      idempotencyKey: "materialize-intent-only-first-request",
      expectedPreviewFingerprint: preview.fingerprint,
      expectedSourceFingerprint: preview.sourceFingerprint!,
      candidateIds: [preview.units[0]!.candidateId],
    })).rejects.toThrow("TEST_CRASH_AFTER_LOCAL_UNIT_INTENT_BEFORE_STUDIO");
    delete process.env.AI_CANVAS_TEST_LOCAL_UNIT_CRASH_AFTER_INTENT_BEFORE_STUDIO;
    expect((await getStudioProductionState(test.projectRoot)).counts.units).toBe(0);

    const recovered = await materializeLocalCreativeProductionUnits(test.projectRoot, {
      idempotencyKey: "materialize-intent-only-second-request",
      expectedPreviewFingerprint: preview.fingerprint,
      expectedSourceFingerprint: preview.sourceFingerprint!,
      candidateIds: [preview.units[0]!.candidateId],
    });
    expect(recovered.units[0]).toMatchObject({
      disposition: "created",
      unitRevision: 1,
    });
    expect((await getStudioProductionState(test.projectRoot)).counts.units).toBe(1);
  });

  it("多单元批次先完成全部预检，后序 legacy partial 冲突时前序保持零写入", async () => {
    const test = await duduFixture();
    const script = [
      "# 分镜",
      "",
      "## W00｜错误的星｜00:00–00:12｜2 格",
      "",
      "| 格 | 时长 | 景别／机位 | 静态故事板画面 | 运动／转场 | 声音／文字 |",
      "|---|---:|---|---|---|---|",
      "| G1 | 5s | 黑场／固定 | 一粒冷光 | 冷光出现 | 鼻息 |",
      "| G2 | 7s | 大远景／缓降 | 星痕越过群山 | 缓降落山 | 无对白 |",
      "",
      "## W01｜山谷回声｜00:12–00:24｜2 格",
      "",
      "| 格 | 时长 | 景别／机位 | 静态故事板画面 | 运动／转场 | 声音／文字 |",
      "|---|---:|---|---|---|---|",
      "| G1 | 6s | 远景／固定 | 山谷泛白 | 云层移动 | 风声 |",
      "| G2 | 6s | 中景／微推 | 石壁震动 | 微推石壁 | 回声 |",
      "",
    ].join("\n");
    await writeFile(path.join(test.sourceRoot, "01_分镜宫格故事版剧本.md"), script, "utf8");
    await writeTaskFrames(test.sourceRoot, [
      { id: "W00_G01", unit: "W00", grid: "G01", prompt: "W00 第一格", referenced_image_paths: [] },
      { id: "W00_G02", unit: "W00", grid: "G02", prompt: "W00 第二格", referenced_image_paths: [] },
      { id: "W01_G01", unit: "W01", grid: "G01", prompt: "W01 第一格", referenced_image_paths: [] },
      { id: "W01_G02", unit: "W01", grid: "G02", prompt: "W01 第二格", referenced_image_paths: [] },
    ]);
    const source = await inspectLocalCreativeProject({
      projectKey: "dudu-preview-test",
      projectName: "嘟嘟预览测试",
      projectType: "story-production",
      sourceLayers: [{ role: "PRIMARY_AUTHORITY", rootPath: test.sourceRoot }],
      computeSha256: true,
    });
    await importLocalCreativeProjectContent({
      projectRoot: test.projectRoot,
      preview: source,
      authorityPolicy: "FORBID_ALL",
    });
    const preview = await previewLocalCreativeProductionUnits(test.projectRoot);
    expect(preview.units.map((unit) => unit.sourceUnitId)).toEqual(["W00", "W01"]);

    process.env.AI_CANVAS_TEST_LOCAL_UNIT_CRASH_BEFORE_SOURCE_CONTRACT = "1";
    await expect(materializeLocalCreativeProductionUnits(test.projectRoot, {
      idempotencyKey: "materialize-seed-legacy-partial",
      expectedPreviewFingerprint: preview.fingerprint,
      expectedSourceFingerprint: preview.sourceFingerprint!,
      candidateIds: [preview.units[1]!.candidateId],
    })).rejects.toThrow("TEST_CRASH_BEFORE_LOCAL_UNIT_SOURCE_CONTRACT");
    delete process.env.AI_CANVAS_TEST_LOCAL_UNIT_CRASH_BEFORE_SOURCE_CONTRACT;
    await rm(
      path.join(test.projectRoot, ".aicanvas", "local-creative-production-unit-materialization-intents"),
      { recursive: true, force: true },
    );
    const before = await getStudioProductionState(test.projectRoot);
    expect(before.counts.units).toBe(1);
    const sidecarDirectories = [
      "local-creative-production-unit-materialization-intents",
      "local-creative-unit-source-contracts",
      "local-creative-production-unit-materializations",
    ];
    const sidecarsBefore = Object.fromEntries(await Promise.all(sidecarDirectories.map(async (name) => [
      name,
      await directoryNamesOrEmpty(path.join(test.projectRoot, ".aicanvas", name)),
    ])));

    await expect(materializeLocalCreativeProductionUnits(test.projectRoot, {
      idempotencyKey: "materialize-two-phase-batch",
      expectedPreviewFingerprint: preview.fingerprint,
      expectedSourceFingerprint: preview.sourceFingerprint!,
      candidateIds: preview.units.map((unit) => unit.candidateId),
    })).rejects.toThrow(/PARTIAL_COMMIT_CONFLICT/u);
    const after = await getStudioProductionState(test.projectRoot);
    expect(after.counts).toEqual(before.counts);
    expect(after.counts.textDocuments).toBe(before.counts.textDocuments);
    expect(after.counts.textRevisions).toBe(before.counts.textRevisions);
    const sidecarsAfter = Object.fromEntries(await Promise.all(sidecarDirectories.map(async (name) => [
      name,
      await directoryNamesOrEmpty(path.join(test.projectRoot, ".aicanvas", name)),
    ])));
    expect(sidecarsAfter).toEqual(sidecarsBefore);
    const firstUnitId = `unit-local-${createHash("sha256").update(JSON.stringify({
      adapterId: "dudu-world-prologue-v1",
      candidateId: preview.units[0]!.candidateId,
    }), "utf8").digest("hex").slice(0, 40)}`;
    await expect(getStudioProductionUnitSnapshot(test.projectRoot, firstUnitId)).resolves.toBeNull();

    const w00Only = await materializeLocalCreativeProductionUnits(test.projectRoot, {
      idempotencyKey: "materialize-w00-after-batch-preflight-proof",
      expectedPreviewFingerprint: preview.fingerprint,
      expectedSourceFingerprint: preview.sourceFingerprint!,
      candidateIds: [preview.units[0]!.candidateId],
    });
    expect(w00Only.units).toEqual([
      expect.objectContaining({
        candidateId: preview.units[0]!.candidateId,
        unitId: firstUnitId,
        disposition: "created",
      }),
    ]);
  });

  it("多单元批次的后序 sequence 已被占用时，在首个文稿或 Unit 写入前整批失败", async () => {
    const test = await duduFixture();
    await writeTwoUnitSource(test.sourceRoot);
    const source = await inspectLocalCreativeProject({
      projectKey: "dudu-preview-test",
      projectName: "嘟嘟预览测试",
      projectType: "story-production",
      sourceLayers: [{ role: "PRIMARY_AUTHORITY", rootPath: test.sourceRoot }],
      computeSha256: true,
    });
    await importLocalCreativeProjectContent({
      projectRoot: test.projectRoot,
      preview: source,
      authorityPolicy: "FORBID_ALL",
    });
    const preview = await previewLocalCreativeProductionUnits(test.projectRoot);
    expect(preview.units.map((unit) => unit.sourceUnitId)).toEqual(["W00", "W01"]);
    await seedSequenceOccupant(test.projectRoot, preview.units[1]!);
    const before = await getStudioProductionState(test.projectRoot);

    await expect(materializeLocalCreativeProductionUnits(test.projectRoot, {
      idempotencyKey: "materialize-sequence-conflict-zero-write",
      expectedPreviewFingerprint: preview.fingerprint,
      expectedSourceFingerprint: preview.sourceFingerprint!,
      candidateIds: preview.units.map((unit) => unit.candidateId),
    })).rejects.toThrow(/MATERIALIZATION_SEQUENCE_CONFLICT/u);

    const after = await getStudioProductionState(test.projectRoot);
    expect(after.counts).toEqual(before.counts);
    const firstUnitId = `unit-local-${createHash("sha256").update(JSON.stringify({
      adapterId: "dudu-world-prologue-v1",
      candidateId: preview.units[0]!.candidateId,
    }), "utf8").digest("hex").slice(0, 40)}`;
    await expect(getStudioProductionUnitSnapshot(test.projectRoot, firstUnitId)).resolves.toBeNull();
  });

  it("崩溃后同路径参考图被替换时，不得把新身份补写进旧 Unit revision", async () => {
    const test = await duduFixture();
    const referencePath = path.join(test.sourceRoot, "ref.png");
    await sharp({
      create: { width: 48, height: 32, channels: 3, background: "#49382d" },
    }).png().toFile(referencePath);
    await writeTaskFrames(test.sourceRoot, [
      { id: "W00_G01", unit: "W00", grid: "G01", prompt: "第一格正式提示词", referenced_image_paths: [] },
      {
        id: "W00_G02",
        unit: "W00",
        grid: "G02",
        prompt: "第二格正式提示词",
        referenced_image_paths: [referencePath],
      },
    ]);
    const sync = async () => {
      const source = await inspectLocalCreativeProject({
        projectKey: "dudu-preview-test",
        projectName: "嘟嘟预览测试",
        projectType: "story-production",
        sourceLayers: [{ role: "PRIMARY_AUTHORITY", rootPath: test.sourceRoot }],
        computeSha256: true,
      });
      await importLocalCreativeProjectContent({
        projectRoot: test.projectRoot,
        preview: source,
        authorityPolicy: "FORBID_ALL",
      });
      return previewLocalCreativeProductionUnits(test.projectRoot);
    };
    const firstPreview = await sync();
    process.env.AI_CANVAS_TEST_LOCAL_UNIT_CRASH_BEFORE_SOURCE_CONTRACT = "1";
    await expect(materializeLocalCreativeProductionUnits(test.projectRoot, {
      idempotencyKey: "materialize-ref-crash-v1",
      expectedPreviewFingerprint: firstPreview.fingerprint,
      expectedSourceFingerprint: firstPreview.sourceFingerprint!,
      candidateIds: [firstPreview.units[0]!.candidateId],
    })).rejects.toThrow("TEST_CRASH_BEFORE_LOCAL_UNIT_SOURCE_CONTRACT");
    delete process.env.AI_CANVAS_TEST_LOCAL_UNIT_CRASH_BEFORE_SOURCE_CONTRACT;

    await sharp({
      create: { width: 48, height: 32, channels: 3, background: "#23576b" },
    }).png().toFile(referencePath);
    const secondPreview = await sync();
    expect(secondPreview.sourceFingerprint).not.toBe(firstPreview.sourceFingerprint);
    expect(secondPreview.units[0]!.fingerprint).toBe(firstPreview.units[0]!.fingerprint);
    await expect(materializeLocalCreativeProductionUnits(test.projectRoot, {
      idempotencyKey: "materialize-ref-crash-v2",
      expectedPreviewFingerprint: secondPreview.fingerprint,
      expectedSourceFingerprint: secondPreview.sourceFingerprint!,
      candidateIds: [secondPreview.units[0]!.candidateId],
    })).rejects.toThrow(/PARTIAL_COMMIT_CONFLICT/u);

    const state = await getStudioProductionState(test.projectRoot);
    expect(state.counts.units).toBe(1);
    const unitId = `unit-local-${createHash("sha256").update(JSON.stringify({
      adapterId: "dudu-world-prologue-v1",
      candidateId: firstPreview.units[0]!.candidateId,
    }), "utf8").digest("hex").slice(0, 40)}`;
    const actualUnit = (await getStudioProductionUnitSnapshot(
      test.projectRoot,
      unitId,
    ))!;
    expect(actualUnit.unit.revision).toBe(1);
    await expect(readLocalCreativeUnitSourceContract(
      test.projectRoot,
      actualUnit.unit.id,
      1,
    )).resolves.toBeNull();
  });

  it("同一 revision 存在废弃与已提交两种 intent 时，恢复必须失败关闭", async () => {
    const test = await duduFixture();
    const referencePath = path.join(test.sourceRoot, "ref.png");
    await sharp({
      create: { width: 48, height: 32, channels: 3, background: "#49382d" },
    }).png().toFile(referencePath);
    const referenceA = await readFile(referencePath);
    await writeTaskFrames(test.sourceRoot, [
      { id: "W00_G01", unit: "W00", grid: "G01", prompt: "第一格正式提示词", referenced_image_paths: [] },
      {
        id: "W00_G02",
        unit: "W00",
        grid: "G02",
        prompt: "第二格正式提示词",
        referenced_image_paths: [referencePath],
      },
    ]);
    const sync = async () => {
      const source = await inspectLocalCreativeProject({
        projectKey: "dudu-preview-test",
        projectName: "嘟嘟预览测试",
        projectType: "story-production",
        sourceLayers: [{ role: "PRIMARY_AUTHORITY", rootPath: test.sourceRoot }],
        computeSha256: true,
      });
      await importLocalCreativeProjectContent({
        projectRoot: test.projectRoot,
        preview: source,
        authorityPolicy: "FORBID_ALL",
      });
      return previewLocalCreativeProductionUnits(test.projectRoot);
    };
    const previewA = await sync();
    process.env.AI_CANVAS_TEST_LOCAL_UNIT_CRASH_AFTER_INTENT_BEFORE_STUDIO = "1";
    await expect(materializeLocalCreativeProductionUnits(test.projectRoot, {
      idempotencyKey: "materialize-abandoned-a",
      expectedPreviewFingerprint: previewA.fingerprint,
      expectedSourceFingerprint: previewA.sourceFingerprint!,
      candidateIds: [previewA.units[0]!.candidateId],
    })).rejects.toThrow("TEST_CRASH_AFTER_LOCAL_UNIT_INTENT_BEFORE_STUDIO");
    delete process.env.AI_CANVAS_TEST_LOCAL_UNIT_CRASH_AFTER_INTENT_BEFORE_STUDIO;

    await sharp({
      create: { width: 48, height: 32, channels: 3, background: "#23576b" },
    }).png().toFile(referencePath);
    const previewB = await sync();
    expect(previewB.units[0]!.fingerprint).toBe(previewA.units[0]!.fingerprint);
    const committedB = await materializeLocalCreativeProductionUnits(test.projectRoot, {
      idempotencyKey: "materialize-committed-b",
      expectedPreviewFingerprint: previewB.fingerprint,
      expectedSourceFingerprint: previewB.sourceFingerprint!,
      candidateIds: [previewB.units[0]!.candidateId],
    });
    const committedItem = committedB.units[0]!;
    await rm(path.join(
      test.projectRoot,
      ".aicanvas",
      "local-creative-unit-source-contracts",
      `${committedItem.unitId}-r${committedItem.unitRevision}.json`,
    ));

    await writeFile(referencePath, referenceA);
    const restoredA = await sync();
    expect(restoredA.sourceFingerprint).toBe(previewA.sourceFingerprint);
    await expect(materializeLocalCreativeProductionUnits(test.projectRoot, {
      idempotencyKey: "materialize-recover-abandoned-a",
      expectedPreviewFingerprint: restoredA.fingerprint,
      expectedSourceFingerprint: restoredA.sourceFingerprint!,
      candidateIds: [restoredA.units[0]!.candidateId],
    })).rejects.toThrow(/没有唯一写前来源意图/u);
    await expect(readLocalCreativeUnitSourceContract(
      test.projectRoot,
      committedItem.unitId,
      committedItem.unitRevision!,
    )).resolves.toBeNull();
  });

  it("预览层允许的最大合同在任何 Studio 写入前即可完成精确序列化预检", () => {
    const contract = prepareLocalCreativeUnitSourceContract({
      unitId: "unit-local-contract-maximum",
      unitRevision: 1,
      candidateId: "W00",
      candidateFingerprint: "a".repeat(64),
      sourceFingerprint: "b".repeat(64),
      panels: Array.from({ length: 6 }, (_, panelIndex) => ({
        panelId: `W00_G0${panelIndex + 1}`,
        soundAndText: "声".repeat(40_000),
        declaredReferences: Array.from({ length: 100 }, (_, referenceIndex) => ({
          declaredPath: `/${panelIndex}-${referenceIndex}-${"a".repeat(4_080)}`,
          importedMediaSha256: "c".repeat(64),
        })),
      })),
    });
    expect(contract.panels).toHaveLength(6);
    expect(contract.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("来源合同缺失且当前单元已与新候选不同，失败关闭而不猜测修订", async () => {
    const test = await duduFixture();
    const sync = async () => {
      const sourcePreview = await inspectLocalCreativeProject({
        projectKey: "dudu-preview-test",
        projectName: "嘟嘟预览测试",
        projectType: "story-production",
        sourceLayers: [{ role: "PRIMARY_AUTHORITY", rootPath: test.sourceRoot }],
        computeSha256: true,
      });
      await importLocalCreativeProjectContent({
        projectRoot: test.projectRoot,
        preview: sourcePreview,
        authorityPolicy: "FORBID_ALL",
      });
      return previewLocalCreativeProductionUnits(test.projectRoot);
    };
    const firstPreview = await sync();
    const first = await materializeLocalCreativeProductionUnits(test.projectRoot, {
      idempotencyKey: "materialize-partial-conflict-v1",
      expectedPreviewFingerprint: firstPreview.fingerprint,
      expectedSourceFingerprint: firstPreview.sourceFingerprint!,
      candidateIds: [firstPreview.units[0]!.candidateId],
    });
    await rm(path.join(
      test.projectRoot,
      ".aicanvas",
      "local-creative-unit-source-contracts",
      `${first.units[0]!.unitId}-r1.json`,
    ));
    await writeTaskFrames(test.sourceRoot, [
      { id: "W00_G01", unit: "W00", grid: "G01", prompt: "来源已经变化", referenced_image_paths: [] },
      { id: "W00_G02", unit: "W00", grid: "G02", prompt: "第二格正式提示词", referenced_image_paths: [] },
    ]);
    const secondPreview = await sync();
    await expect(materializeLocalCreativeProductionUnits(test.projectRoot, {
      idempotencyKey: "materialize-partial-conflict-v2",
      expectedPreviewFingerprint: secondPreview.fingerprint,
      expectedSourceFingerprint: secondPreview.sourceFingerprint!,
      candidateIds: [secondPreview.units[0]!.candidateId],
    })).rejects.toThrow(/PARTIAL_COMMIT_CONFLICT/u);
    expect((await getStudioProductionUnitSnapshot(
      test.projectRoot,
      first.units[0]!.unitId,
    ))?.unit.revision).toBe(1);
  });

  it("来源合同目录是符号链接时失败关闭且不向工程外写文件", async () => {
    const test = await duduFixture();
    const sourcePreview = await inspectLocalCreativeProject({
      projectKey: "dudu-preview-test",
      projectName: "嘟嘟预览测试",
      projectType: "story-production",
      sourceLayers: [{ role: "PRIMARY_AUTHORITY", rootPath: test.sourceRoot }],
      computeSha256: true,
    });
    await importLocalCreativeProjectContent({
      projectRoot: test.projectRoot,
      preview: sourcePreview,
      authorityPolicy: "FORBID_ALL",
    });
    const preview = await previewLocalCreativeProductionUnits(test.projectRoot);
    const outside = path.join(path.dirname(test.projectRoot), "outside-contracts");
    await mkdir(outside);
    await symlink(
      outside,
      path.join(test.projectRoot, ".aicanvas", "local-creative-unit-source-contracts"),
    );
    await expect(materializeLocalCreativeProductionUnits(test.projectRoot, {
      idempotencyKey: "materialize-contract-symlink",
      expectedPreviewFingerprint: preview.fingerprint,
      expectedSourceFingerprint: preview.sourceFingerprint!,
      candidateIds: [preview.units[0]!.candidateId],
    })).rejects.toThrow(/符号链接|受管目录/u);
    expect(await readdir(outside)).toEqual([]);
  });

  it("物化回执目录是符号链接时失败关闭且不向工程外写文件", async () => {
    const test = await duduFixture();
    const sourcePreview = await inspectLocalCreativeProject({
      projectKey: "dudu-preview-test",
      projectName: "嘟嘟预览测试",
      projectType: "story-production",
      sourceLayers: [{ role: "PRIMARY_AUTHORITY", rootPath: test.sourceRoot }],
      computeSha256: true,
    });
    await importLocalCreativeProjectContent({
      projectRoot: test.projectRoot,
      preview: sourcePreview,
      authorityPolicy: "FORBID_ALL",
    });
    const preview = await previewLocalCreativeProductionUnits(test.projectRoot);
    const outside = path.join(path.dirname(test.projectRoot), "outside-receipts");
    await mkdir(outside);
    await symlink(
      outside,
      path.join(test.projectRoot, ".aicanvas", "local-creative-production-unit-materializations"),
    );
    await expect(materializeLocalCreativeProductionUnits(test.projectRoot, {
      idempotencyKey: "materialize-receipt-symlink",
      expectedPreviewFingerprint: preview.fingerprint,
      expectedSourceFingerprint: preview.sourceFingerprint!,
      candidateIds: [preview.units[0]!.candidateId],
    })).rejects.toThrow(/符号链接|受管目录/u);
    expect(await readdir(outside)).toEqual([]);
  });

  it("物化副作用后若命令进程崩溃，可凭内容寻址回执对账，不重复建立单元", async () => {
    const test = await duduFixture();
    const sourcePreview = await inspectLocalCreativeProject({
      projectKey: "dudu-preview-test",
      projectName: "嘟嘟预览测试",
      projectType: "story-production",
      sourceLayers: [{ role: "PRIMARY_AUTHORITY", rootPath: test.sourceRoot }],
      computeSha256: true,
    });
    await importLocalCreativeProjectContent({
      projectRoot: test.projectRoot,
      preview: sourcePreview,
      authorityPolicy: "FORBID_ALL",
    });
    const preview = await previewLocalCreativeProductionUnits(test.projectRoot);
    const request = {
      command: "materialize_local_creative_production_units" as const,
      payload: {
        expectedPreviewFingerprint: preview.fingerprint,
        expectedSourceFingerprint: preview.sourceFingerprint!,
        candidateIds: [preview.units[0]!.candidateId],
      },
    };
    const envelope = {
      requestId: "materialize-local-unit-crash-request",
      idempotencyKey: "materialize-local-unit-crash-key",
      request,
    };
    process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE = request.command;
    await expect(executeIdempotentCommand(test.projectRoot, envelope))
      .rejects.toThrow(/执行结果未确认/u);
    delete process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE;
    expect(await listCommandLedger(test.projectRoot)).toEqual([
      expect.objectContaining({
        idempotencyKey: envelope.idempotencyKey,
        status: "unknown",
      }),
    ]);

    const recovered = await executeIdempotentCommand(test.projectRoot, {
      ...envelope,
      requestId: "materialize-local-unit-recovery-request",
    });
    expect(recovered).toMatchObject({
      status: "succeeded",
      replayed: true,
      result: {
        replayed: true,
        reconciled: true,
        units: [{ candidateId: preview.units[0]!.candidateId }],
      },
    });
    const state = await getStudioProductionState(test.projectRoot);
    expect(state.counts).toMatchObject({
      units: 1,
      panels: 2,
      scriptDocuments: 1,
      promptDocuments: 2,
      textRevisions: 3,
    });
  });

  it("多单元在首项提交后崩溃时，同一命令凭批 journal/checkpoint 续完且不保留 durable unknown", async () => {
    const test = await duduFixture();
    await writeTwoUnitSource(test.sourceRoot);
    const sourcePreview = await inspectLocalCreativeProject({
      projectKey: "dudu-preview-test",
      projectName: "嘟嘟预览测试",
      projectType: "story-production",
      sourceLayers: [{ role: "PRIMARY_AUTHORITY", rootPath: test.sourceRoot }],
      computeSha256: true,
    });
    await importLocalCreativeProjectContent({
      projectRoot: test.projectRoot,
      preview: sourcePreview,
      authorityPolicy: "FORBID_ALL",
    });
    const preview = await previewLocalCreativeProductionUnits(test.projectRoot);
    expect(preview.units).toHaveLength(2);
    const request = {
      command: "materialize_local_creative_production_units" as const,
      payload: {
        expectedPreviewFingerprint: preview.fingerprint,
        expectedSourceFingerprint: preview.sourceFingerprint!,
        candidateIds: preview.units.map((unit) => unit.candidateId),
      },
    };
    const envelope = {
      requestId: "materialize-mid-batch-crash-request",
      idempotencyKey: "materialize-mid-batch-crash-key",
      request,
    };

    process.env.AI_CANVAS_TEST_LOCAL_UNIT_CRASH_AFTER_COMMIT_COUNT = "1";
    await expect(executeIdempotentCommand(test.projectRoot, envelope))
      .rejects.toThrow(/执行结果未确认|TEST_CRASH_AFTER_LOCAL_UNIT_COMMIT_COUNT/u);
    delete process.env.AI_CANVAS_TEST_LOCAL_UNIT_CRASH_AFTER_COMMIT_COUNT;
    expect((await getStudioProductionState(test.projectRoot)).counts.units).toBe(1);

    const recovered = await executeIdempotentCommand(test.projectRoot, {
      ...envelope,
      requestId: "materialize-mid-batch-recovery-request",
    });
    expect(recovered).toMatchObject({
      status: "succeeded",
      replayed: true,
      result: {
        replayed: true,
        reconciled: true,
        units: [
          { candidateId: preview.units[0]!.candidateId },
          { candidateId: preview.units[1]!.candidateId },
        ],
      },
    });
    expect((await getStudioProductionState(test.projectRoot)).counts).toMatchObject({
      units: 2,
      panels: 4,
    });
    expect((await listCommandLedger(test.projectRoot))
      .find((entry) => entry.idempotencyKey === envelope.idempotencyKey)?.status)
      .toBe("succeeded");
  });
});
