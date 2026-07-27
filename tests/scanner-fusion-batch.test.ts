import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { inspectFusionPackage } from "../src/core/fusion-package.js";
import { materializeFusionProject } from "../src/core/fusion-production.js";
import { materializeAllFusionStoryboardGrids } from "../src/core/fusion-storyboard-production.js";
import { loadFusionStoryboardEvidenceSnapshot } from "../src/core/fusion-storyboard-evidence.js";
import { scanProject } from "../src/core/scanner.js";
import { scanAndPersist } from "../src/core/service.js";
import { getSidecarPaths } from "../src/core/sidecar.js";
import type { StoryboardStore } from "../src/core/types.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function largeFusionFixture(unitCount: number) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "ai-canvas-scanner-fusion-batch-")));
  roots.push(root);
  const sourceRoot = path.join(root, "source");
  const targetParent = path.join(root, "targets");
  const packageRoot = path.join(sourceRoot, "07_9x16_15秒融合制作包");
  const episodeDirectory = "蜀道山古蜀卷第三季_EP01_批量扫描_9x16_漫剧/04_15秒融合分镜";
  await Promise.all([
    mkdir(path.join(packageRoot, episodeDirectory), { recursive: true }),
    mkdir(path.join(sourceRoot, "05_提示词"), { recursive: true }),
    mkdir(path.join(sourceRoot, "01_剧本"), { recursive: true }),
    mkdir(targetParent, { recursive: true }),
  ]);

  const promptSections: string[] = ["# EP01 批量扫描提示词\n"];
  const units = Array.from({ length: unitCount }, (_, offset) => {
    const sequence = offset + 1;
    const unit = String(sequence).padStart(3, "0");
    const firstShot = offset * 2 + 1;
    const lastShot = firstShot + 1;
    const unitRelative = `${episodeDirectory}/EP01_15s_${unit}_批量扫描.md`;
    promptSections.push(`#### 镜${String(firstShot).padStart(3, "0")} [8s] 【中景】（24帧）\n**参考素材**：@C01 阿航、@S01 山路\n【参考】@图片1=C01，@图片2=S01。\n`);
    promptSections.push(`#### 镜${String(lastShot).padStart(3, "0")} [5s] 【特写】（24帧）\n**参考素材**：@C01 阿航、@P01 布囊\n【参考】@图片1=C01，@图片2=P01。\n`);
    const markdown = `# EP01 15s-${unit}｜批量扫描 ${unit}

## 3. 机位 / 焦段 / 运镜

| 原镜 | 景别 | 焦段 | 机位 | 运镜 | 帧率 | 备注 |
|---|---|---|---|---|---|---|
| 镜${String(firstShot).padStart(3, "0")} | 中景 | 50mm | 平视 | 侧移 | 24 | 起幅 |
| 镜${String(lastShot).padStart(3, "0")} | 特写 | 85mm | 低机位 | 跟随 | 24 | 收束 |

## 4. 人物 / 道具站位

参考 C01、S01、P01。

## 7. 首帧生图提示词

电影级写实，9:16，阿航站在山路起幅。

## 8. 图生视频中文提示词

### 原镜${String(firstShot).padStart(3, "0")} 视频提示词

参考素材：@C01、@S01。
阿航沿山路行进。
尾帧：阿航走到山路转角。

### 原镜${String(lastShot).padStart(3, "0")} 视频提示词

参考素材：@C01、@P01。
阿航按住不透明布囊。
尾帧：布囊保持不透明，阿航停步。

## 9. 生成注意事项

禁止露出布囊内部物品。
`;
    return {
      definition: {
        id: `EP01_15s_${unit}`,
        episode: "EP01",
        episode_title: "批量扫描",
        unit_title: `批量扫描 ${unit}`,
        md_path: unitRelative,
        source_script: "01_剧本/第三季_EP01_批量扫描.md",
        source_prompt_table: "05_提示词/第三季_EP01_批量扫描提示词表.md",
        source_shots: [firstShot, lastShot],
        source_duration_seconds: 13,
        standard_duration_seconds: 15,
        aspect_ratio: "9:16",
        story_goal: `验证第 ${unit} 个单元的批量宫格扫描`,
        schedule: [
          { start: 0, end: 8, shot: `镜${String(firstShot).padStart(3, "0")}`, seconds: 8, content: `阿航沿山路行进 ${unit}` },
          { start: 8, end: 13, shot: `镜${String(lastShot).padStart(3, "0")}`, seconds: 5, content: `阿航按住布囊 ${unit}` },
          { start: 13, end: 15, shot: "扩写补足", seconds: 2, content: "动作收束，不新增剧情" },
        ],
        asset_ids: ["C01", "S01", "P01"],
        reference_image_paths: [],
        validation: { source_order_preserved: true, source_duration_lte_15: true, no_compression: true },
      },
      unitRelative,
      markdown,
    };
  });

  await Promise.all([
    writeFile(path.join(packageRoot, "15s_fused_units.json"), `${JSON.stringify(units.map((unit) => unit.definition), null, 2)}\n`, "utf8"),
    writeFile(path.join(sourceRoot, "05_提示词", "00_全季资产库.md"), `# 全季资产库

### C01 阿航
- **出场集数**：EP01
- **AI 出图提示词**：电影级写实青年。

### S01 山路
- **出场集数**：EP01
- **AI 出图提示词**：商周山路。

### P01 布囊
- **出场集数**：EP01
- **AI 出图提示词**：不透明素麻布囊。
`, "utf8"),
    writeFile(path.join(sourceRoot, "05_提示词", "第三季_EP01_批量扫描提示词表.md"), promptSections.join("\n"), "utf8"),
    writeFile(path.join(sourceRoot, "01_剧本", "第三季_EP01_批量扫描.md"), "# EP01 批量扫描剧本\n", "utf8"),
    ...units.map((unit) => writeFile(path.join(packageRoot, unit.unitRelative), unit.markdown, "utf8")),
  ]);

  const inspection = await inspectFusionPackage({
    packageRoot,
    sourceRoot,
    expectedCounts: {
      episodes: 1,
      units: unitCount,
      sourceShots: unitCount * 2,
      scheduleRows: unitCount * 3,
      assets: 3,
      characters: 1,
      scenes: 1,
      props: 1,
      standardDurationSeconds: 15,
    },
  });
  const created = await materializeFusionProject({ inspection, targetParent });
  await scanAndPersist(created.targetRoot);
  await materializeAllFusionStoryboardGrids(created.targetRoot);
  return { created };
}

describe("融合宫格大集合扫描批量验真", () => {
  it("一次批入口验真 48 个 selection，在宽松预算内只剔除其中真实 stale 的合同", async () => {
    const unitCount = 48;
    const { created } = await largeFusionFixture(unitCount);
    const selectionStore = JSON.parse(await readFile(getSidecarPaths(created.targetRoot).storyboardGridSelections, "utf8")) as { items: Record<string, unknown> };
    expect(Object.keys(selectionStore.items)).toHaveLength(unitCount);
    expect((await loadFusionStoryboardEvidenceSnapshot(created.targetRoot)).selections.size).toBe(unitCount);

    const scannerSource = await readFile(path.join(process.cwd(), "src/core/scanner.ts"), "utf8");
    expect(scannerSource).toMatch(/import\s*\{\s*materializeAllFusionStoryboardGrids\s*\}\s*from\s*"\.\/fusion-storyboard-production\.js"/u);
    expect(scannerSource).toMatch(/await\s+materializeAllFusionStoryboardGrids\(projectRoot,\s*\{\s*persist:\s*false\s*\}\)/u);
    expect(scannerSource).not.toMatch(/import\s*\{[^}]*validateFusionStoryboardGridAgainstCurrent[^}]*\}\s*from\s*"\.\/fusion-storyboard-production\.js"/u);
    expect(scannerSource).not.toMatch(/await\s+validateFusionStoryboardGridAgainstCurrent\(/u);

    const baselineStartedAt = performance.now();
    const baseline = await scanProject({ projectRoot: created.targetRoot, persist: false });
    const baselineDurationMs = performance.now() - baselineStartedAt;
    expect(baseline.items.filter((item) => item.type === "unit" && item.fusionStoryboard)).toHaveLength(unitCount);

    const sidecar = getSidecarPaths(created.targetRoot);
    const storyboardStore = JSON.parse(await readFile(sidecar.storyboards, "utf8")) as StoryboardStore;
    const staleItemId = "season-三-ep01-unit017";
    const staleRow = storyboardStore.rows.find((row) => row.itemId === staleItemId)!;
    staleRow.action += "（模拟当前 storyboard 内容漂移）";
    staleRow.updatedAt = new Date(Date.parse(staleRow.updatedAt) + 1_000).toISOString();
    await writeFile(sidecar.storyboards, `${JSON.stringify(storyboardStore, null, 2)}\n`, "utf8");

    const driftStartedAt = performance.now();
    const afterDrift = await scanProject({ projectRoot: created.targetRoot, persist: false });
    const driftDurationMs = performance.now() - driftStartedAt;
    // 这是回归分水岭而非微基准：本夹具批路径约 0.2s，旧版逐合同重建约 4.8s。
    // 3s 给本机负载保留一个数量级余量，同时仍能稳定阻止 O(selection × 全季重建)。
    expect(Math.max(baselineDurationMs, driftDurationMs)).toBeLessThan(3_000);
    expect(afterDrift.items.find((item) => item.id === staleItemId)?.fusionStoryboard).toBeUndefined();
    expect(afterDrift.items.find((item) => item.id === "season-三-ep01-unit018")?.fusionStoryboard).toBeDefined();
    expect(afterDrift.items.filter((item) => item.type === "unit" && item.fusionStoryboard)).toHaveLength(unitCount - 1);
    expect(afterDrift.warnings.some((warning) => warning.includes(staleItemId) && warning.includes("批量重建"))).toBe(true);
  }, 30_000);
});
