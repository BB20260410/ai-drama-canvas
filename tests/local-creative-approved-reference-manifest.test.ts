import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import {
  inspectLocalCreativeApprovedReferenceManifest,
  stageLocalCreativeApprovedReferenceManifest,
} from "../src/core/local-creative-approved-reference-manifest.js";
import { materializeLocalCreativeProject } from "../src/core/local-creative-project-materializer.js";
import {
  getMaterialStudioState,
  getStudioCanonicalAsset,
} from "../src/core/material-studio.js";

const roots: string[] = [];

interface FixtureAsset {
  id: string;
  role: string;
  path: string;
  sha256: string;
}

interface FixtureManifest {
  schema_version: string;
  project: string;
  policy: string;
  assets: FixtureAsset[];
  forbidden_reference_markers: string[];
}

interface FixtureFrame {
  id: string;
  unit: string;
  grid: string;
  prompt: string;
  referenced_image_paths: string[];
}

interface ApprovedReferenceFixture {
  sourceRoot: string;
  projectRoot: string;
  referenceRoot: string;
  manifestPath: string;
  manifest: FixtureManifest;
  frames: FixtureFrame[];
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function writeManifest(fixture: ApprovedReferenceFixture, manifest: FixtureManifest): Promise<void> {
  await writeFile(fixture.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

async function writeFrames(fixture: ApprovedReferenceFixture, frames: FixtureFrame[]): Promise<void> {
  await writeFile(
    path.join(fixture.sourceRoot, "02_BindingSet", "00_逐格任务清单.json"),
    `${JSON.stringify({ schema_version: "1.0", total: frames.length, frames }, null, 2)}\n`,
    "utf8",
  );
}

function cloneManifest(manifest: FixtureManifest): FixtureManifest {
  return structuredClone(manifest);
}

function cloneFrames(frames: FixtureFrame[]): FixtureFrame[] {
  return structuredClone(frames);
}

async function approvedReferenceFixture(): Promise<ApprovedReferenceFixture> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "ai-canvas-approved-reference-")));
  roots.push(root);
  const projectsRoot = path.join(root, "projects");
  const sourceRoot = path.join(root, "世界观概念序章_测试");
  const referenceRoot = path.join(sourceRoot, "refs");
  await Promise.all([
    mkdir(projectsRoot),
    mkdir(path.join(sourceRoot, "01_视觉资产锁"), { recursive: true }),
    mkdir(path.join(sourceRoot, "02_BindingSet"), { recursive: true }),
    mkdir(referenceRoot, { recursive: true }),
  ]);
  const definitions = [
    { id: "STYLE_CINE", role: "电影写实画风", basename: "style.png", color: "#372a21" },
    { id: "SCENE_ROOT", role: "树根场景", basename: "scene.png", color: "#31553a" },
    { id: "CHAR_DUDU", role: "嘟嘟身份", basename: "character.png", color: "#bda889" },
    { id: "PROP_TENGWO", role: "藤窝道具", basename: "prop.png", color: "#705332" },
    { id: "VFX_ZHULONG", role: "烛龙竖瞳线，不继承完整龙体", basename: "vfx.png", color: "#c98316" },
  ];
  const assets: FixtureAsset[] = [];
  for (const definition of definitions) {
    const target = path.join(referenceRoot, definition.basename);
    await sharp({
      create: {
        width: 24,
        height: 24,
        channels: 3,
        background: definition.color,
      },
    }).png().toFile(target);
    assets.push({
      id: definition.id,
      role: definition.role,
      path: target,
      sha256: sha256(await readFile(target)),
    });
  }
  const frames: FixtureFrame[] = [
    {
      id: "W00_G01",
      unit: "W00",
      grid: "G01",
      prompt: "第一格正式提示词",
      referenced_image_paths: [assets[0]!.path, assets[1]!.path, assets[2]!.path],
    },
    {
      id: "W00_G02",
      unit: "W00",
      grid: "G02",
      prompt: "第二格正式提示词",
      referenced_image_paths: [assets[0]!.path, assets[3]!.path, assets[4]!.path],
    },
  ];
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
  const manifest: FixtureManifest = {
    schema_version: "1.0",
    project: "approved-reference-fixture",
    policy: "仅允许清单内路径与哈希完全匹配的图片作为候选参考。",
    assets,
    forbidden_reference_markers: [
      "REJECTED",
      "CANDIDATE",
      "UNAPPROVED",
      "storyboard-as-identity-reference",
    ],
  };
  const manifestPath = path.join(sourceRoot, "01_视觉资产锁", "00_允许参考资产.json");
  await Promise.all([
    writeFile(path.join(sourceRoot, "01_分镜宫格故事版剧本.md"), script, "utf8"),
    writeFile(
      path.join(sourceRoot, "02_BindingSet", "00_逐格任务清单.json"),
      `${JSON.stringify({ schema_version: "1.0", total: frames.length, frames }, null, 2)}\n`,
      "utf8",
    ),
    writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
  ]);
  const materialized = await materializeLocalCreativeProject({
    projectsRoot,
    project: {
      key: "approved-reference-fixture",
      name: "允许参考资产测试",
      projectType: "story-production",
      resolution: "CREATE_MANAGED",
      sources: [{ root: sourceRoot, role: "PRIMARY_AUTHORITY" }],
      authorityPolicy: "EVIDENCE_REQUIRED",
      scanSummary: {
        statistics: {
          totalFiles: 8,
          totalBytes: 1,
          byMediaKind: { document: 3, image: assets.length, video: 0, audio: 0 },
        },
      },
    },
  });
  return {
    sourceRoot,
    projectRoot: materialized.projectRoot,
    referenceRoot,
    manifestPath,
    manifest,
    frames,
  };
}

describe("本机剧情允许参考资产清单", () => {
  it("严格核验 schema、实盘 SHA 与 declared refs 集合，并仅按显式前缀给出分类投影", async () => {
    const fixture = await approvedReferenceFixture();
    const projection = await inspectLocalCreativeApprovedReferenceManifest(fixture.projectRoot);

    expect(projection).toMatchObject({
      status: "verified",
      manifestSchemaVersion: "1.0",
      manifestProject: "approved-reference-fixture",
      unitCount: 1,
      panelCount: 2,
      declaredReferenceCount: 5,
    });
    expect(projection.assets).toHaveLength(5);
    expect(projection.assets.map((asset) => [asset.id, asset.category])).toEqual([
      ["STYLE_CINE", "style"],
      ["SCENE_ROOT", "scene"],
      ["CHAR_DUDU", "character"],
      ["PROP_TENGWO", "prop"],
      ["VFX_ZHULONG", "category-blocked"],
    ]);
    expect(projection.assets.find((asset) => asset.id === "STYLE_CINE")?.usageCount).toBe(2);
    expect(projection.assets.every((asset) => asset.actualSha256 === asset.declaredSha256)).toBe(true);
    expect(projection.assets.find((asset) => asset.id === "VFX_ZHULONG")?.canonicalAssetId).toBeUndefined();
    expect(projection.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("幂等暂存媒体与四类 pending 资产，VFX 仅进 CAS 且绝不自动审核或升权", async () => {
    const fixture = await approvedReferenceFixture();
    const first = await stageLocalCreativeApprovedReferenceManifest(fixture.projectRoot);
    const second = await stageLocalCreativeApprovedReferenceManifest(fixture.projectRoot);
    const state = await getMaterialStudioState(fixture.projectRoot);

    expect(first).toMatchObject({
      candidateCount: 5,
      mediaCount: 5,
      canonicalAssetCount: 4,
      pendingVersionCount: 4,
      blockedVfxCount: 1,
      reviewedExistingCount: 0,
      primaryAuthorityChanges: 0,
    });
    expect(first.assets.every((asset) => asset.mediaStatus === "imported")).toBe(true);
    expect(second.assets.every((asset) => asset.mediaStatus === "already-staged")).toBe(true);
    expect(second.pendingVersionCount).toBe(4);
    expect(state.counts).toMatchObject({
      media: 5,
      mediaImports: 5,
      canonicalAssets: 4,
      characters: 1,
      scenes: 1,
      props: 1,
      styles: 1,
      assetVersions: 4,
      primaryAuthorities: 0,
      authorityEvents: 0,
      versionReviews: 0,
    });
    expect(await getStudioCanonicalAsset(
      fixture.projectRoot,
      "allowed-ref:vfx-zhulong",
    )).toBeNull();
    for (const id of [
      "allowed-ref:style-cine",
      "allowed-ref:scene-root",
      "allowed-ref:char-dudu",
      "allowed-ref:prop-tengwo",
    ]) {
      const asset = await getStudioCanonicalAsset(fixture.projectRoot, id);
      expect(asset?.primaryAuthority).toBeUndefined();
      expect(asset?.versions).toHaveLength(1);
      expect(asset?.versions[0]?.reviewStatus).toBe("pending");
    }
  });

  it("inspect 后暂存必须匹配调用方核对过的 manifest SHA，漂移时保持零写入", async () => {
    const fixture = await approvedReferenceFixture();
    const inspected = await inspectLocalCreativeApprovedReferenceManifest(fixture.projectRoot);

    await expect(stageLocalCreativeApprovedReferenceManifest(fixture.projectRoot, {
      expectedSourceFingerprint: inspected.sourceFingerprint,
      expectedManifestSha256: "0".repeat(64),
    })).rejects.toThrow("允许参考资产清单 SHA 已变化");
    expect((await getMaterialStudioState(fixture.projectRoot)).counts).toMatchObject({
      media: 0,
      canonicalAssets: 0,
      assetVersions: 0,
      primaryAuthorities: 0,
    });

    const staged = await stageLocalCreativeApprovedReferenceManifest(fixture.projectRoot, {
      expectedSourceFingerprint: inspected.sourceFingerprint,
      expectedManifestSha256: inspected.manifestSha256,
    });
    expect(staged).toMatchObject({
      manifestSha256: inspected.manifestSha256,
      canonicalAssetCount: 4,
      primaryAuthorityChanges: 0,
    });
  });

  it("拒绝错误 schema 以及 ID、path、SHA 任一重复", async () => {
    const fixture = await approvedReferenceFixture();

    const wrongSchema = cloneManifest(fixture.manifest);
    wrongSchema.schema_version = "2.0";
    await writeManifest(fixture, wrongSchema);
    await expect(inspectLocalCreativeApprovedReferenceManifest(fixture.projectRoot))
      .rejects.toThrow("schema_version 必须严格为 1.0");

    const duplicateId = cloneManifest(fixture.manifest);
    duplicateId.assets[1]!.id = duplicateId.assets[0]!.id;
    await writeManifest(fixture, duplicateId);
    await expect(inspectLocalCreativeApprovedReferenceManifest(fixture.projectRoot))
      .rejects.toThrow("ID 重复");

    const duplicatePath = cloneManifest(fixture.manifest);
    duplicatePath.assets[1]!.path = duplicatePath.assets[0]!.path;
    await writeManifest(fixture, duplicatePath);
    await expect(inspectLocalCreativeApprovedReferenceManifest(fixture.projectRoot))
      .rejects.toThrow("path 重复");

    const duplicateSha = cloneManifest(fixture.manifest);
    duplicateSha.assets[1]!.sha256 = duplicateSha.assets[0]!.sha256;
    await writeManifest(fixture, duplicateSha);
    await expect(inspectLocalCreativeApprovedReferenceManifest(fixture.projectRoot))
      .rejects.toThrow("SHA-256 重复");
  });

  it("拒绝符号链接、非普通文件、SHA 漂移、禁止标记和 declared refs 集合差异", async () => {
    const fixture = await approvedReferenceFixture();

    const linkedPath = path.join(fixture.referenceRoot, "linked.png");
    await symlink(fixture.manifest.assets[0]!.path, linkedPath);
    const linkedManifest = cloneManifest(fixture.manifest);
    linkedManifest.assets[0]!.path = linkedPath;
    const linkedFrames = cloneFrames(fixture.frames);
    linkedFrames[0]!.referenced_image_paths[0] = linkedPath;
    linkedFrames[1]!.referenced_image_paths[0] = linkedPath;
    await Promise.all([
      writeManifest(fixture, linkedManifest),
      writeFrames(fixture, linkedFrames),
    ]);
    await expect(inspectLocalCreativeApprovedReferenceManifest(fixture.projectRoot))
      .rejects.toThrow("禁止符号链接");

    const directoryPath = path.join(fixture.referenceRoot, "not-a-file.png");
    await mkdir(directoryPath);
    const directoryManifest = cloneManifest(fixture.manifest);
    directoryManifest.assets[0]!.path = directoryPath;
    const directoryFrames = cloneFrames(fixture.frames);
    directoryFrames[0]!.referenced_image_paths[0] = directoryPath;
    directoryFrames[1]!.referenced_image_paths[0] = directoryPath;
    await Promise.all([
      writeManifest(fixture, directoryManifest),
      writeFrames(fixture, directoryFrames),
    ]);
    await expect(inspectLocalCreativeApprovedReferenceManifest(fixture.projectRoot))
      .rejects.toThrow("必须是普通文件");

    await writeFrames(fixture, fixture.frames);
    const driftedSha = cloneManifest(fixture.manifest);
    driftedSha.assets[0]!.sha256 = "0".repeat(64);
    await writeManifest(fixture, driftedSha);
    await expect(inspectLocalCreativeApprovedReferenceManifest(fixture.projectRoot))
      .rejects.toThrow("SHA-256 不匹配");

    const rejectedPath = path.join(fixture.referenceRoot, "REJECTED-reference.png");
    await sharp({
      create: { width: 24, height: 24, channels: 3, background: "#153357" },
    }).png().toFile(rejectedPath);
    const forbiddenManifest = cloneManifest(fixture.manifest);
    forbiddenManifest.assets[0]!.path = rejectedPath;
    forbiddenManifest.assets[0]!.sha256 = sha256(await readFile(rejectedPath));
    const forbiddenFrames = cloneFrames(fixture.frames);
    forbiddenFrames[0]!.referenced_image_paths[0] = rejectedPath;
    forbiddenFrames[1]!.referenced_image_paths[0] = rejectedPath;
    await Promise.all([
      writeManifest(fixture, forbiddenManifest),
      writeFrames(fixture, forbiddenFrames),
    ]);
    await expect(inspectLocalCreativeApprovedReferenceManifest(fixture.projectRoot))
      .rejects.toThrow("命中禁止标记 rejected");

    await writeManifest(fixture, fixture.manifest);
    const incompleteFrames = cloneFrames(fixture.frames);
    incompleteFrames[1]!.referenced_image_paths = incompleteFrames[1]!.referenced_image_paths
      .filter((entry) => entry !== fixture.manifest.assets[4]!.path);
    await writeFrames(fixture, incompleteFrames);
    await expect(inspectLocalCreativeApprovedReferenceManifest(fixture.projectRoot))
      .rejects.toThrow("declared refs 集合不相等");
  });

  it("拒绝没有受支持显式分类前缀的候选，避免文件名启发式升权", async () => {
    const fixture = await approvedReferenceFixture();
    const unknown = cloneManifest(fixture.manifest);
    unknown.assets[0]!.id = "BOARD_W00_G01";
    await writeManifest(fixture, unknown);
    await expect(inspectLocalCreativeApprovedReferenceManifest(fixture.projectRoot))
      .rejects.toThrow("显式分类前缀无效");
  });
});
