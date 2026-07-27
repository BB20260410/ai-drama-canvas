import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { createManagedProject } from "../src/core/managed-project.js";
import {
  appendStudioAssetVersion,
  createStudioCanonicalAsset,
  importStudioMedia,
  reviewStudioAssetVersion,
  setStudioPrimaryAuthority,
} from "../src/core/material-studio.js";
import {
  appendStudioPromptRevision,
  appendStudioScriptRevision,
  createStudioProductionUnit,
  createStudioPromptDocument,
  createStudioScriptDocument,
} from "../src/core/studio-production.js";
import {
  STUDIO_DASHBOARD_UNIT_PAGE_LIMIT,
  getStudioProductionDashboard,
  type StudioDashboardAppearancesPage,
  type StudioDashboardOverview,
  type StudioDashboardUnitDetail,
  type StudioDashboardUnitsPage,
} from "../src/core/studio-production-dashboard.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function solidPng(filePath: string, color: { r: number; g: number; b: number }): Promise<void> {
  await sharp({
    create: { width: 32, height: 32, channels: 3, background: color },
  }).png().toFile(filePath);
}

describe("P8 Dashboard 规模与分页硬上限", () => {
  it("大量单元元数据下单页最多 36，翻页不累积，不暴露路径", async () => {
    const temporaryRoot = await realpath("/tmp");
    const parentRoot = await realpath(await mkdtemp(path.join(temporaryRoot, "studio-p8-scale-")));
    roots.push(parentRoot);
    const project = await createManagedProject({ parentRoot, name: "P8 规模", slug: "p8-scale" });
    const root = project.paths.root;
    const inputsRoot = path.join(root, "fixture-inputs");
    await mkdir(inputsRoot, { recursive: true });

    const mediaPath = path.join(inputsRoot, "authority.png");
    await solidPng(mediaPath, { r: 40, g: 80, b: 120 });
    const media = await importStudioMedia(root, { sourcePath: mediaPath, kind: "image" });
    const asset = await createStudioCanonicalAsset(root, {
      id: "character-scale-lead",
      category: "character",
      name: "规模主角",
      description: "规模测试角色",
      aliases: ["主角"],
      identityFeatures: ["固定面孔"],
      positiveLocks: ["保持同一张脸"],
      negativeLocks: ["禁止换脸"],
      defaultPrompt: "写实人物",
      applicability: { seasons: ["S1"], episodes: [], units: [] },
      expectedRevision: 0,
    });
    const version = await appendStudioAssetVersion(root, {
      assetId: asset.id,
      mediaSha256: media.sha256,
      reviewStatus: "pending",
      sourceNote: "scale",
      expectedRevision: asset.revision,
    });
    const reviewed = await reviewStudioAssetVersion(root, {
      assetId: asset.id,
      versionId: version.version.id,
      decision: "approved",
      note: "fixture",
      expectedRevision: version.assetRevision,
    });
    await setStudioPrimaryAuthority(root, {
      assetId: asset.id,
      versionId: version.version.id,
      expectedRevision: reviewed.revision,
    });

    const scriptBody = "规模主角站在大厅中央，准备进入下一场戏。";
    const scriptDocument = await createStudioScriptDocument(root, {
      id: "p8-scale-script",
      title: "规模剧本",
      expectedRevision: 0,
    });
    const script = await appendStudioScriptRevision(root, {
      documentId: scriptDocument.id,
      body: scriptBody,
      source: "fixture/p8/scale.md",
      sourceVersion: "p8-scale-v1",
      expectedRevision: 0,
    });
    const promptDocument = await createStudioPromptDocument(root, {
      id: "p8-scale-prompt",
      title: "规模提示词",
      expectedRevision: 0,
    });
    const prompt = await appendStudioPromptRevision(root, {
      documentId: promptDocument.id,
      body: "只生成一张电影写实分镜。",
      source: "fixture/p8/scale.txt",
      sourceVersion: "p8-scale-v1",
      expectedRevision: 0,
    });

    const unitCount = 128;
    for (let index = 1; index <= unitCount; index += 1) {
      const episodeIndex = Math.ceil(index / 8);
      const sequence = ((index - 1) % 8) + 1;
      await createStudioProductionUnit(root, {
        id: `p8-scale-unit-${String(index).padStart(4, "0")}`,
        expectedRevision: 0,
        season: "S1",
        episode: `EP${String(episodeIndex).padStart(2, "0")}`,
        sequence,
        title: `单元 ${index}`,
        scriptRevisionId: script.revision.id,
        panels: [
          {
            title: "格1",
            visualAction: "建立场景",
            shotComposition: "全景",
            filmingMethod: "固定",
            dialogue: "",
            subtitle: "",
            startSeconds: 0,
            endSeconds: 7.5,
            durationSeconds: 7.5,
            promptRevisionId: prompt.revision.id,
            sourceSpans: [{ startOffsetUtf16: 0, endOffsetUtf16: scriptBody.length }],
            assets: [{
              assetId: asset.id,
              category: "character",
              presence: "required",
              role: "lead",
              continuityState: "unknown",
              evidence: [{ kind: "prompt-revision", reference: prompt.revision.id, note: "scale" }],
            }],
          },
          {
            title: "格2",
            visualAction: "推进动作",
            shotComposition: "中景",
            filmingMethod: "缓推",
            dialogue: "",
            subtitle: "",
            startSeconds: 7.5,
            endSeconds: 15,
            durationSeconds: 7.5,
            promptRevisionId: prompt.revision.id,
            sourceSpans: [{ startOffsetUtf16: 0, endOffsetUtf16: scriptBody.length }],
            assets: [{
              assetId: asset.id,
              category: "character",
              presence: "required",
              role: "lead",
              continuityState: "unknown",
              evidence: [{ kind: "prompt-revision", reference: prompt.revision.id, note: "scale" }],
            }],
          },
        ],
      });
    }

    const overview = await getStudioProductionDashboard(root, { operation: "overview" }) as StudioDashboardOverview;
    expect(overview.counts.units).toBe(unitCount);
    expect(overview.counts.panelsEstimated).toBeGreaterThanOrEqual(unitCount * 2);

    const page1 = await getStudioProductionDashboard(root, { operation: "units", limit: 36 }) as StudioDashboardUnitsPage;
    expect(page1.page.items).toHaveLength(STUDIO_DASHBOARD_UNIT_PAGE_LIMIT);
    expect(page1.page.nextCursor).toBeTruthy();

    const page2 = await getStudioProductionDashboard(root, {
      operation: "units",
      limit: 36,
      cursor: page1.page.nextCursor,
    }) as StudioDashboardUnitsPage;
    expect(page2.page.items).toHaveLength(STUDIO_DASHBOARD_UNIT_PAGE_LIMIT);
    const ids1 = new Set(page1.page.items.map((item) => item.id));
    expect(page2.page.items.every((item) => !ids1.has(item.id))).toBe(true);

    const unitDetail = await getStudioProductionDashboard(root, {
      operation: "unit",
      unitId: page1.page.items[0]!.id,
    }) as StudioDashboardUnitDetail;
    expect(unitDetail.panels.length).toBeLessThanOrEqual(6);

    const appearances = await getStudioProductionDashboard(root, {
      operation: "appearances",
      assetId: asset.id,
      limit: 36,
    }) as StudioDashboardAppearancesPage;
    expect(appearances.page.items.length).toBeLessThanOrEqual(36);
    expect(appearances.page.items[0]?.locator.panelId).toBeTruthy();

    const serialized = JSON.stringify({ overview, page1, page2, unitDetail, appearances });
    expect(serialized).not.toMatch(/\.sqlite|objectPath|bodyPath|databasePath/u);
    const overview2 = await getStudioProductionDashboard(root, { operation: "overview" }) as StudioDashboardOverview;
    expect(overview2.fingerprint).toBe(overview.fingerprint);
    expect(createHash("sha256").update(serialized).digest("hex")).toMatch(/^[a-f0-9]{64}$/u);
  }, 300_000);
});
