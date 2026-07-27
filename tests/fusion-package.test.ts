import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertFusionSourceInventoryUnchanged,
  createAssetGenerationContract,
  createFusionProjectManifest,
  inspectFusionPackage,
  type FusionPackageExpectedCounts,
} from "../src/core/fusion-package.js";

const roots: string[] = [];

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

const FIXTURE_COUNTS: FusionPackageExpectedCounts = {
  episodes: 1,
  units: 2,
  sourceShots: 3,
  scheduleRows: 4,
  assets: 3,
  characters: 1,
  scenes: 1,
  props: 1,
  standardDurationSeconds: 15,
};

const ASSET_LIBRARY = `# 测试资产库

### C01 阿航

- **出场集数**：EP01
- **AI 出图提示词**：
  电影级写实青年，纯白背景。

### S01 封神榜场景

- **出场集数**：EP01
- **正打提示词**：
  电影级写实封神榜空间，无人物。
- **反打提示词**：
  电影级写实封神台反打，无人物。

### P01 素麻布囊

- **出场集数**：EP01
- **AI 出图提示词**：
  素麻布囊，纯白背景，不露出内部物品。
`;

const PROMPT_TABLE = `# EP01 逐镜提示词表

#### 镜01 [15s] 【固定】（24帧）
**参考素材**：@C01 阿航、@S01 场景
【参考】@图片1=C01，@图片2=S01。

#### 镜02 [7s] 【固定】（24帧）
**参考素材**：@C01 阿航、@P01 布囊
【参考】@图片1=C01，@图片2=P01。

#### 镜03 [5s] 【固定】（24帧）
**参考素材**：@S01 场景、@P01 布囊
【参考】@图片1=S01，@图片2=P01。
`;

interface Fixture {
  sourceRoot: string;
  packageRoot: string;
  indexPath: string;
  units: Array<Record<string, unknown>>;
}

function unit(
  id: string,
  sequence: number,
  sourceShots: number[],
  sourceDuration: number,
  schedule: Array<Record<string, unknown>>,
  assetIds: string[],
): Record<string, unknown> {
  return {
    id,
    episode: "EP01",
    episode_title: "测试集",
    unit_title: `测试单元${sequence}`,
    md_path: `EP01/04_15秒融合分镜/${id}_测试.md`,
    source_script: "01_剧本/第三季_EP01_测试.md",
    source_prompt_table: "05_提示词/第三季_EP01_提示词表.md",
    source_shots: sourceShots,
    source_duration_seconds: sourceDuration,
    standard_duration_seconds: 15,
    aspect_ratio: "9:16",
    story_goal: "测试",
    schedule,
    asset_ids: assetIds,
    reference_image_paths: [],
    validation: {
      source_order_preserved: true,
      source_duration_lte_15: true,
      no_compression: true,
    },
  };
}

async function createFixture(): Promise<Fixture> {
  const created = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-fusion-package-"));
  const sourceRoot = await realpath(created);
  roots.push(sourceRoot);
  const packageRoot = path.join(sourceRoot, "07_9x16_15秒融合制作包");
  const unitRoot = path.join(packageRoot, "EP01", "04_15秒融合分镜");
  await Promise.all([
    mkdir(path.join(sourceRoot, "01_剧本"), { recursive: true }),
    mkdir(path.join(sourceRoot, "05_提示词"), { recursive: true }),
    mkdir(unitRoot, { recursive: true }),
  ]);
  const units = [
    unit("EP01_15s_001", 1, [1], 15, [
      { start: 0, end: 15, shot: "镜01", seconds: 15, content: "第一镜" },
    ], ["C01", "S01"]),
    unit("EP01_15s_002", 2, [2, 3], 12, [
      { start: 0, end: 7, shot: "镜02", seconds: 7, content: "第二镜" },
      { start: 7, end: 12, shot: "镜03", seconds: 5, content: "第三镜" },
      { start: 12, end: 15, shot: "扩写补足", seconds: 3, content: "延展收束" },
    ], ["P01"]),
  ];
  const indexPath = path.join(packageRoot, "15s_fused_units.json");
  await Promise.all([
    writeFile(indexPath, `${JSON.stringify(units, null, 2)}\n`, "utf8"),
    writeFile(path.join(sourceRoot, "05_提示词", "00_全季资产库.md"), ASSET_LIBRARY, "utf8"),
    writeFile(path.join(sourceRoot, "05_提示词", "第三季_EP01_提示词表.md"), PROMPT_TABLE, "utf8"),
    writeFile(path.join(sourceRoot, "01_剧本", "第三季_EP01_测试.md"), "# EP01 测试剧本\n", "utf8"),
    writeFile(path.join(unitRoot, "EP01_15s_001_测试.md"), "# EP01 15s-001｜测试一\n", "utf8"),
    writeFile(path.join(unitRoot, "EP01_15s_002_测试.md"), "# EP01 15s-002｜测试二\n", "utf8"),
  ]);
  return { sourceRoot, packageRoot, indexPath, units };
}

describe("第三季 15 秒融合包核心", () => {
  it("只读核验单元、原镜、时间段、资产全集并建立连续性轨", async () => {
    const fixture = await createFixture();
    const first = await inspectFusionPackage({
      packageRoot: fixture.packageRoot,
      sourceRoot: fixture.sourceRoot,
      expectedCounts: FIXTURE_COUNTS,
    });
    const repeated = await inspectFusionPackage({
      packageRoot: fixture.packageRoot,
      sourceRoot: fixture.sourceRoot,
      expectedCounts: FIXTURE_COUNTS,
    });

    expect(first).toMatchObject({
      readOnly: true,
      counts: {
        episodes: 1,
        units: 2,
        sourceShots: 3,
        scheduleRows: 4,
        assets: 3,
        characters: 1,
        scenes: 1,
        props: 1,
        promptReferencedAssets: 3,
        indexReferencedAssets: 3,
      },
    });
    expect(first.inventory.files).toHaveLength(6);
    expect(first.inventory.aggregateSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(repeated.inventory.aggregateSha256).toBe(first.inventory.aggregateSha256);
    expect(first.assets.map((asset) => [asset.id, asset.category])).toEqual([
      ["C01", "character"],
      ["S01", "scene"],
      ["P01", "prop"],
    ]);
    expect(first.assets.find((asset) => asset.id === "S01")?.generationPrompts).toHaveLength(2);
    expect(first.units[1]?.schedule.map((row) => row.kind)).toEqual([
      "source-shot",
      "source-shot",
      "extension",
    ]);
    expect(first.continuityTracks.find((track) => track.assetId === "C01")?.spans).toMatchObject([
      { unitId: "EP01_15s_001", sourceShots: [1], startSeconds: 0, endSeconds: 15 },
      { unitId: "EP01_15s_002", sourceShots: [2], startSeconds: 0, endSeconds: 7 },
    ]);

    const manifest = createFusionProjectManifest(first);
    expect(manifest).toMatchObject({
      kind: "fusion-project-manifest",
      contentAddress: `sha256:${first.inventory.aggregateSha256}`,
      directoryName: `gushujuan-s3-${first.inventory.aggregateSha256.slice(0, 16)}`,
      source: { readOnly: true },
    });
    expect(manifest.manifestSha256).toMatch(/^[a-f0-9]{64}$/u);

    const c01 = first.assets.find((asset) => asset.id === "C01");
    expect(c01).toBeDefined();
    const contract = createAssetGenerationContract(c01!, {
      authorityReferences: [{ path: "/authority/ahang.jpg", sha256: "a".repeat(64), role: "authority" }],
    });
    expect(contract).toMatchObject({
      assetId: "C01",
      provider: "artlist",
      model: "GPT Image 2",
      aspectRatio: "9:16",
      quality: "Medium",
      imageCount: 1,
      concurrency: 1,
      hardLockPromotion: { automatic: false, visualReviewRequired: true },
    });
  });

  it("失败关闭：拒绝重复 ID、倒序原镜、非法秒段、未定义资产和缺失 md_path", async () => {
    const duplicate = await createFixture();
    duplicate.units.push({ ...duplicate.units[0] });
    await writeFile(duplicate.indexPath, JSON.stringify(duplicate.units), "utf8");
    await expect(inspectFusionPackage({
      packageRoot: duplicate.packageRoot,
      sourceRoot: duplicate.sourceRoot,
      expectedCounts: FIXTURE_COUNTS,
    })).rejects.toThrow("重复单元 ID");

    const invalid = await createFixture();
    const second = invalid.units[1] as Record<string, unknown>;
    second.source_shots = [3, 2];
    second.asset_ids = ["P99"];
    second.md_path = "EP01/04_15秒融合分镜/不存在.md";
    const schedule = second.schedule as Array<Record<string, unknown>>;
    schedule[0]!.start = 1;
    await writeFile(invalid.indexPath, JSON.stringify(invalid.units), "utf8");
    await expect(inspectFusionPackage({
      packageRoot: invalid.packageRoot,
      sourceRoot: invalid.sourceRoot,
      expectedCounts: FIXTURE_COUNTS,
    })).rejects.toThrow(/source_shots 必须严格递增|未定义资产|秒段不连续|缺失或不可读/u);
  });

  it("通过规范化文件摘要检测预检后的源内容漂移", async () => {
    const fixture = await createFixture();
    const before = await inspectFusionPackage({
      packageRoot: fixture.packageRoot,
      sourceRoot: fixture.sourceRoot,
      expectedCounts: FIXTURE_COUNTS,
    });
    const unitPath = path.join(fixture.packageRoot, "EP01", "04_15秒融合分镜", "EP01_15s_001_测试.md");
    const current = await readFile(unitPath, "utf8");
    await writeFile(unitPath, `${current}\n源漂移\n`, "utf8");
    const after = await inspectFusionPackage({
      packageRoot: fixture.packageRoot,
      sourceRoot: fixture.sourceRoot,
      expectedCounts: FIXTURE_COUNTS,
    });

    expect(() => assertFusionSourceInventoryUnchanged(before.inventory, after.inventory)).toThrow("只读源内容漂移");
  });
});

const REAL_PACKAGE_ROOT = "/Users/hxx/Documents/古蜀卷第三季/07_9x16_15秒融合制作包";
const realSourceTest = existsSync(path.join(REAL_PACKAGE_ROOT, "15s_fused_units.json")) ? it : it.skip;

realSourceTest("真实第三季源包精确通过 32/1288/1472/2640/77 核验且不产生源写入", async () => {
  const beforeIndex = await readFile(path.join(REAL_PACKAGE_ROOT, "15s_fused_units.json"));
  const inspection = await inspectFusionPackage({ packageRoot: REAL_PACKAGE_ROOT });
  const afterIndex = await readFile(path.join(REAL_PACKAGE_ROOT, "15s_fused_units.json"));

  expect(inspection.counts).toEqual({
    episodes: 32,
    units: 1_288,
    sourceShots: 1_472,
    scheduleRows: 2_640,
    assets: 77,
    characters: 24,
    scenes: 20,
    props: 33,
    standardDurationSeconds: 15,
    promptReferencedAssets: 77,
    indexReferencedAssets: 77,
  });
  expect(inspection.units.every((unit) => unit.schedule.at(-1)?.endSeconds === 15)).toBe(true);
  expect(inspection.continuityTracks).toHaveLength(77);
  expect(inspection.inventory.files).toHaveLength(1_354);
  expect(afterIndex.equals(beforeIndex)).toBe(true);
}, 120_000);
