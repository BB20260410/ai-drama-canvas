import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import {
  backfillLocalCreativeProjectContentSummary,
  importLocalCreativeProjectContent,
  readValidatedLocalCreativeImportedMediaIdentityIndex,
  type LocalCreativeProjectContentImportSummary,
  type LocalCreativeProjectContentImportProgressEvent,
  type LocalCreativeProjectContentImportProgress,
} from "../src/core/local-creative-project-content-import.js";
import { inspectLocalCreativeProject } from "../src/core/local-creative-project-ingest.js";
import { createManagedProject } from "../src/core/managed-project.js";
import {
  getMaterialStudioState,
  getStudioCanonicalAsset,
  listStudioCanonicalAssets,
  listStudioMediaImportOrigins,
} from "../src/core/material-studio.js";
import { listStudioTextDocuments } from "../src/core/studio-production.js";

const roots: string[] = [];
const mp4Fixture = () => Buffer.from("\u0000\u0000\u0000\u0018ftypisom\u0000\u0000\u0000\u0000isom", "binary");
const wavFixture = (label = "") => Buffer.concat([
  Buffer.from("RIFF\u0000\u0000\u0000\u0000WAVEfmt ", "binary"),
  Buffer.from(label),
]);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{ parent: string; projectRoot: string; sourceRoot: string }> {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "local-content-import-")));
  roots.push(parent);
  const sourceRoot = path.join(parent, "source");
  await mkdir(sourceRoot);
  const project = await createManagedProject({ parentRoot: parent, name: "本机创作导入测试", slug: "managed" });
  return { parent, projectRoot: project.paths.root, sourceRoot };
}

async function writePng(root: string, relativePath: string, color = "#536b57"): Promise<string> {
  const target = path.join(root, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await sharp({ create: { width: 48, height: 32, channels: 3, background: color } }).png().toFile(target);
  return target;
}

describe.sequential("本机创作项目内容导入", () => {
  it("首次顺序导入真实 PNG/视频/音频，重跑不重复 origin，并只建立 pending 资产版本", async () => {
    const { projectRoot, sourceRoot } = await fixture();
    await writePng(sourceRoot, "角色/char-hero.png");
    await writeFile(path.join(sourceRoot, "clip.mp4"), mp4Fixture());
    await writeFile(path.join(sourceRoot, "voice.wav"), wavFixture("audio"));
    await writeFile(
      path.join(sourceRoot, "权威资产.md"),
      "参考资产：角色/char-hero.png\n状态: APPROVED_LOCK\n唯一权威角色锁\nReview / QC: PASS\n",
    );
    const preview = await inspectLocalCreativeProject({
      projectKey: "hero-story",
      projectName: "英雄故事",
      projectType: "ai-drama",
      sourceLayers: [{ role: "PRIMARY_AUTHORITY", rootPath: sourceRoot }],
      computeSha256: true,
    });
    const first = await importLocalCreativeProjectContent({
      projectRoot,
      preview,
      authorityPolicy: "CREATE_PENDING_FROM_APPROVED_LOCKS",
    });
    expect(first.status).toBe("completed");
    expect(first.runSummary).toMatchObject({
      mediaEligible: 3,
      mediaImported: 3,
      pendingAssetsCreated: 1,
      authorityPromotions: 0,
    });
    expect(first.completionBaselineFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    const firstBaselinePath = path.join(
      projectRoot,
      ".aicanvas",
      "local-creative-content-import-completion-baselines",
      `${first.completionBaselineFingerprint}.json`,
    );
    const firstBaseline = JSON.parse(await readFile(firstBaselinePath, "utf8")) as Record<string, any>;
    expect(firstBaseline).toMatchObject({
      kind: "local-creative-content-import-completion-baseline",
      fingerprint: first.completionBaselineFingerprint,
      project: { root: projectRoot, sourceProject: { key: "hero-story" } },
      previewFingerprint: preview.previewFingerprint,
      sourceInventory: { fingerprint: first.sourceInventory?.fingerprint, contentIdentity: "sha256" },
      completion: { status: "completed", runSummary: { mediaImported: 3 } },
    });
    const state = await getMaterialStudioState(projectRoot);
    expect(state.counts).toMatchObject({
      media: 3,
      mediaImports: 3,
      canonicalAssets: 1,
      assetVersions: 1,
      primaryAuthorities: 0,
      versionReviews: 0,
    });
    const asset = (await listStudioCanonicalAssets(projectRoot)).items[0]!;
    const detail = await getStudioCanonicalAsset(projectRoot, asset.id);
    expect(detail).toMatchObject({
      category: "character",
      versions: [{ reviewStatus: "pending" }],
    });
    expect(detail?.primaryAuthority).toBeUndefined();

    const second = await importLocalCreativeProjectContent({
      projectRoot,
      preview,
      authorityPolicy: "CREATE_PENDING_FROM_APPROVED_LOCKS",
    });
    expect(second.runSummary).toMatchObject({
      mediaImported: 0,
      mediaSkippedRecorded: 3,
      pendingAssetsReconciled: 1,
      authorityPromotions: 0,
    });
    const secondState = await getMaterialStudioState(projectRoot);
    expect(secondState.counts).toMatchObject({ media: 3, mediaImports: 3, canonicalAssets: 1, assetVersions: 1 });
    for (const item of Object.values(second.mediaByFileId)) {
      expect((await listStudioMediaImportOrigins(projectRoot, item.sha256)).items).toHaveLength(1);
    }
  });

  it("进度记录丢失但 origin 已存在时按 SHA 和来源路径恢复，不重复登记", async () => {
    const { projectRoot, sourceRoot } = await fixture();
    await writePng(sourceRoot, "场景/scene-river.png");
    const preview = await inspectLocalCreativeProject({
      projectKey: "river-story",
      projectName: "河岸",
      projectType: "ai-drama",
      sourceLayers: [{ role: "ACTIVE_PRODUCTION", rootPath: sourceRoot }],
      computeSha256: true,
    });
    const first = await importLocalCreativeProjectContent({
      projectRoot,
      preview,
      authorityPolicy: "CREATE_PENDING_FROM_APPROVED_LOCKS",
    });
    const imported = Object.values(first.mediaByFileId)[0]!;
    const progressPath = path.join(projectRoot, ".aicanvas", "local-creative-project-content-import.json");
    const persisted = JSON.parse(await readFile(progressPath, "utf8")) as LocalCreativeProjectContentImportProgress;
    persisted.mediaByFileId = {};
    await writeFile(progressPath, `${JSON.stringify(persisted, null, 2)}\n`);

    const recovered = await importLocalCreativeProjectContent({
      projectRoot,
      preview,
      authorityPolicy: "CREATE_PENDING_FROM_APPROVED_LOCKS",
    });
    expect(recovered.runSummary).toMatchObject({ mediaImported: 0, mediaReconciled: 1 });
    expect(Object.values(recovered.mediaByFileId)[0]).toMatchObject({ lastAction: "reconciled-existing" });
    expect((await listStudioMediaImportOrigins(projectRoot, imported.sha256)).items).toHaveLength(1);
    expect((await getMaterialStudioState(projectRoot)).counts.mediaImports).toBe(1);
  });

  it("受信媒体索引逐条复核来源层、CAS 与 origin，不直接信任进度 JSON", async () => {
    const { projectRoot, sourceRoot } = await fixture();
    const sourcePath = await writePng(sourceRoot, "角色/char-trusted.png");
    const preview = await inspectLocalCreativeProject({
      projectKey: "trusted-media-story",
      projectName: "受信媒体",
      projectType: "ai-drama",
      sourceLayers: [{ role: "PRIMARY_AUTHORITY", rootPath: sourceRoot }],
      computeSha256: true,
    });
    const imported = await importLocalCreativeProjectContent({
      projectRoot,
      preview,
      authorityPolicy: "FORBID_ALL",
    });
    const record = Object.values(imported.mediaByFileId)[0]!;
    const trusted = await readValidatedLocalCreativeImportedMediaIdentityIndex(projectRoot, {
      expectedSourceFingerprint: imported.sourceInventory!.fingerprint,
      sourcePaths: [sourcePath],
    });
    expect(trusted.get(sourcePath)).toMatchObject({
      fileId: record.fileId,
      sha256: record.sha256,
      kind: "image",
      sourceLayerRole: "PRIMARY_AUTHORITY",
    });

    const progressPath = path.join(projectRoot, ".aicanvas", "local-creative-project-content-import.json");
    const persisted = JSON.parse(await readFile(progressPath, "utf8")) as LocalCreativeProjectContentImportProgress;
    persisted.mediaByFileId[record.fileId]!.sha256 = "f".repeat(64);
    await writeFile(progressPath, `${JSON.stringify(persisted, null, 2)}\n`);
    await expect(readValidatedLocalCreativeImportedMediaIdentityIndex(projectRoot, {
      expectedSourceFingerprint: imported.sourceInventory!.fingerprint,
      sourcePaths: [sourcePath],
    })).rejects.toThrow(/当前来源文件身份|CAS 元数据缺失或漂移/u);
  });

  it("来源删除媒体并重新同步后会剪除旧记录，受信索引不返回历史 SHA", async () => {
    const { projectRoot, sourceRoot } = await fixture();
    const sourcePath = await writePng(sourceRoot, "场景/deleted-ref.png");
    const inspect = () => inspectLocalCreativeProject({
      projectKey: "deleted-reference-story",
      projectName: "删除参考",
      projectType: "ai-drama",
      sourceLayers: [{ role: "PRIMARY_AUTHORITY" as const, rootPath: sourceRoot }],
      computeSha256: true,
    });
    const firstPreview = await inspect();
    const first = await importLocalCreativeProjectContent({
      projectRoot,
      preview: firstPreview,
      authorityPolicy: "FORBID_ALL",
    });
    expect(Object.keys(first.mediaByFileId)).toHaveLength(1);
    const firstFileId = Object.keys(first.mediaByFileId)[0]!;
    const progressPath = path.join(projectRoot, ".aicanvas", "local-creative-project-content-import.json");
    const withHistoricalDecision = JSON.parse(await readFile(progressPath, "utf8")) as LocalCreativeProjectContentImportProgress;
    withHistoricalDecision.canonicalDecisionsByFileId[firstFileId] = {
      fileId: firstFileId,
      sourcePath,
      sourceStatus: "FORMAL_MEDIA",
      decision: "forbidden-by-policy",
      authorityPromoted: false,
      sourceApprovalEvidence: [],
      updatedAt: new Date().toISOString(),
    };
    await writeFile(progressPath, `${JSON.stringify(withHistoricalDecision, null, 2)}\n`, "utf8");
    await rm(sourcePath);
    const secondPreview = await inspect();
    const second = await importLocalCreativeProjectContent({
      projectRoot,
      preview: secondPreview,
      authorityPolicy: "FORBID_ALL",
    });
    expect(second.mediaByFileId).toEqual({});
    expect(second.canonicalDecisionsByFileId).toEqual({});
    await expect(readValidatedLocalCreativeImportedMediaIdentityIndex(projectRoot, {
      expectedSourceFingerprint: second.sourceInventory!.fingerprint,
      sourcePaths: [sourcePath],
    })).resolves.toEqual(new Map());
  });

  it("新增文件后的恢复只导入新媒体，已记录内容保持幂等", async () => {
    const { projectRoot, sourceRoot } = await fixture();
    await writePng(sourceRoot, "U01_raw.png");
    const firstPreview = await inspectLocalCreativeProject({
      projectKey: "resume-story",
      projectName: "恢复测试",
      projectType: "ai-drama",
      sourceLayers: [{ role: "ACTIVE_PRODUCTION", rootPath: sourceRoot }],
    });
    await importLocalCreativeProjectContent({
      projectRoot,
      preview: firstPreview,
      authorityPolicy: "FORBID_ALL",
    });
    await writePng(sourceRoot, "U02_raw.png", "#7a5d42");
    const secondPreview = await inspectLocalCreativeProject({
      projectKey: "resume-story",
      projectName: "恢复测试",
      projectType: "ai-drama",
      sourceLayers: [{ role: "ACTIVE_PRODUCTION", rootPath: sourceRoot }],
    });
    const resumed = await importLocalCreativeProjectContent({
      projectRoot,
      preview: secondPreview,
      authorityPolicy: "FORBID_ALL",
    });
    expect(resumed.runSummary).toMatchObject({ mediaEligible: 2, mediaImported: 1, mediaSkippedRecorded: 1 });
    expect((await getMaterialStudioState(projectRoot)).counts).toMatchObject({ media: 2, mediaImports: 2, canonicalAssets: 0 });
    expect(resumed.previewFingerprints).toHaveLength(2);
  });

  it("UNASSIGNED_INBOX 即使含 APPROVED_LOCK 文本也禁止创建 canonical asset", async () => {
    const { projectRoot, sourceRoot } = await fixture();
    await writePng(sourceRoot, "角色/char-inbox.png");
    await writeFile(path.join(sourceRoot, "确认.md"), "char-inbox.png\n状态: APPROVED_LOCK\n唯一权威角色锁\nQC: PASS\n");
    const preview = await inspectLocalCreativeProject({
      projectKey: "inbox-story",
      projectName: "收件箱",
      projectType: "ai-drama",
      sourceLayers: [{ role: "UNASSIGNED_INBOX", rootPath: sourceRoot }],
    });
    expect(preview.files.find((file) => file.basename === "char-inbox.png")?.status).toBe("APPROVED_LOCK");
    const result = await importLocalCreativeProjectContent({
      projectRoot,
      preview,
      authorityPolicy: "CREATE_PENDING_FROM_APPROVED_LOCKS",
    });
    const file = preview.files.find((entry) => entry.basename === "char-inbox.png")!;
    expect(result.canonicalDecisionsByFileId[file.fileId]).toMatchObject({
      decision: "forbidden-inbox",
      authorityPromoted: false,
    });
    expect((await getMaterialStudioState(projectRoot)).counts).toMatchObject({ media: 1, canonicalAssets: 0, assetVersions: 0 });
  });

  it("REJECTED 媒体不进入 CAS 或 origins", async () => {
    const { projectRoot, sourceRoot } = await fixture();
    await writePng(sourceRoot, "REJECTED/bad.png");
    const preview = await inspectLocalCreativeProject({
      projectKey: "rejected-story",
      projectName: "拒绝素材",
      projectType: "ai-drama",
      sourceLayers: [{ role: "LEGACY_HISTORY", rootPath: sourceRoot }],
    });
    const result = await importLocalCreativeProjectContent({
      projectRoot,
      preview,
      authorityPolicy: "FORBID_ALL",
    });
    expect(result.runSummary).toMatchObject({ mediaEligible: 0, mediaRejected: 1, mediaImported: 0 });
    expect(result.mediaByFileId).toEqual({});
    expect((await getMaterialStudioState(projectRoot)).counts).toMatchObject({ media: 0, mediaImports: 0, canonicalAssets: 0 });
  });

  it("已处理媒体后来变为 REJECTED 时剪除当前 canonical decision", async () => {
    const { projectRoot, sourceRoot } = await fixture();
    const sourcePath = await writePng(sourceRoot, "will-be-rejected.png");
    const inspect = () => inspectLocalCreativeProject({
      projectKey: "rejected-decision-story",
      projectName: "拒绝决策剪枝",
      projectType: "ai-drama",
      sourceLayers: [{ role: "ACTIVE_PRODUCTION" as const, rootPath: sourceRoot }],
      computeSha256: true,
    });
    const first = await importLocalCreativeProjectContent({
      projectRoot,
      preview: await inspect(),
      authorityPolicy: "FORBID_ALL",
    });
    const firstFileId = Object.keys(first.mediaByFileId)[0]!;
    const progressPath = path.join(projectRoot, ".aicanvas", "local-creative-project-content-import.json");
    const withHistoricalDecision = JSON.parse(await readFile(progressPath, "utf8")) as LocalCreativeProjectContentImportProgress;
    withHistoricalDecision.canonicalDecisionsByFileId[firstFileId] = {
      fileId: firstFileId,
      sourcePath,
      sourceStatus: "FORMAL_MEDIA",
      decision: "forbidden-by-policy",
      authorityPromoted: false,
      sourceApprovalEvidence: [],
      updatedAt: new Date().toISOString(),
    };
    await writeFile(progressPath, `${JSON.stringify(withHistoricalDecision, null, 2)}\n`, "utf8");
    await writeFile(sourcePath, "<?xml version=\"1.0\"?><Error>placeholder</Error>", "utf8");
    const rejectedPreview = await inspect();
    expect(rejectedPreview.files.find((file) => file.absolutePath === sourcePath)?.status)
      .toBe("REJECTED_OR_FORBIDDEN");
    const second = await importLocalCreativeProjectContent({
      projectRoot,
      preview: rejectedPreview,
      authorityPolicy: "FORBID_ALL",
    });
    expect(second.mediaByFileId).toEqual({});
    expect(second.canonicalDecisionsByFileId).toEqual({});
    expect(second.runSummary.mediaRejected).toBe(1);
  });

  it("只导入明确剧本/提示词，设定与随笔进入可追溯盘点且不冒充剧本", async () => {
    const { projectRoot, sourceRoot } = await fixture();
    await mkdir(path.join(sourceRoot, "deep", "notes"), { recursive: true });
    await writeFile(path.join(sourceRoot, "S1E1_剧本.md"), "第一场：河岸。\n");
    await writeFile(path.join(sourceRoot, "S1E1_生图提示词.md"), "角色站在河岸，禁止新增人物。\n");
    await writeFile(path.join(sourceRoot, "01_设定圣经.txt"), "角色：阿航。\n");
    await writeFile(path.join(sourceRoot, "deep", "notes", "随笔.md"), "低优先级笔记。\n");
    const preview = await inspectLocalCreativeProject({
      projectKey: "docs-story",
      projectName: "文档上限",
      projectType: "ai-drama",
      sourceLayers: [{ role: "UPSTREAM_SCRIPT", rootPath: sourceRoot }],
    });
    const result = await importLocalCreativeProjectContent({
      projectRoot,
      preview,
      authorityPolicy: "FORBID_ALL",
      documentLimit: 2,
    });
    expect(result.documents.selected).toHaveLength(2);
    expect(result.documents.selected.map((entry) => path.basename(entry.path))).toEqual(["S1E1_剧本.md", "S1E1_生图提示词.md"]);
    expect(result.documents.selected.map((entry) => entry.documentKind)).toEqual(["script", "prompt"]);
    expect(result.runSummary).toMatchObject({ documentsSelected: 2, documentsImported: 2, documentsFailed: 0 });
    expect((await listStudioTextDocuments(projectRoot, { kind: "script", limit: 10 })).items).toHaveLength(1);
    expect((await listStudioTextDocuments(projectRoot, { kind: "prompt", limit: 10 })).items).toHaveLength(1);
    expect(result.documents.coverage).toMatchObject({
      sourceDocuments: 4,
      importEligibleDocuments: 2,
      inventoryOnlyDocuments: 2,
      selectedDocuments: 2,
    });
  });

  it("文档只导入预览冻结的 SHA，拒绝预览后的原地替换与符号链接越界", async () => {
    const { parent, projectRoot, sourceRoot } = await fixture();
    const scriptPath = path.join(sourceRoot, "S1E1_剧本.md");
    const promptPath = path.join(sourceRoot, "S1E1_生图提示词.md");
    const outsidePath = path.join(parent, "outside-secret.md");
    await Promise.all([
      writeFile(scriptPath, "预览时的锁版剧本。\n"),
      writeFile(promptPath, "预览时的锁版提示词。\n"),
      writeFile(outsidePath, "不得经符号链接导入的源根外正文。\n"),
    ]);
    const preview = await inspectLocalCreativeProject({
      projectKey: "document-snapshot-race",
      projectName: "文档快照竞态",
      projectType: "ai-drama",
      sourceLayers: [{ role: "UPSTREAM_SCRIPT", rootPath: sourceRoot }],
    });
    expect(preview.files.filter((file) => file.mediaKind === "document").every((file) => file.sha256)).toBe(true);

    await writeFile(scriptPath, "预览后被替换的不同剧本正文。\n");
    await rm(promptPath);
    await symlink(outsidePath, promptPath);

    const result = await importLocalCreativeProjectContent({
      projectRoot,
      preview,
      authorityPolicy: "FORBID_ALL",
    });
    expect(result.status).toBe("completed-with-failures");
    expect(result.runSummary).toMatchObject({
      documentsSelected: 2,
      documentsImported: 0,
      documentsFailed: 2,
    });
    expect(result.documents.results).toEqual([
      expect.objectContaining({ sourcePath: scriptPath, status: "failed" }),
      expect.objectContaining({ sourcePath: promptPath, status: "failed" }),
    ]);
    expect((await listStudioTextDocuments(projectRoot, { kind: "script", limit: 10 })).items).toHaveLength(0);
    expect((await listStudioTextDocuments(projectRoot, { kind: "prompt", limit: 10 })).items).toHaveLength(0);
  });

  it("checkpointEvery 按批落盘并持续报告可观察进度，结束批不足间隔仍强制落盘", async () => {
    const { projectRoot, sourceRoot } = await fixture();
    for (let index = 1; index <= 5; index += 1) {
      await writeFile(path.join(sourceRoot, `voice-${index}.wav`), wavFixture(`audio-${index}`));
    }
    const preview = await inspectLocalCreativeProject({
      projectKey: "checkpoint-story",
      projectName: "批量检查点",
      projectType: "ai-drama",
      sourceLayers: [{ role: "ACTIVE_PRODUCTION", rootPath: sourceRoot }],
    });
    const events: LocalCreativeProjectContentImportProgressEvent[] = [];
    const result = await importLocalCreativeProjectContent({
      projectRoot,
      preview,
      authorityPolicy: "FORBID_ALL",
      checkpointEvery: 2,
      onProgress: (event) => { events.push(event); },
    });
    const mediaEvents = events.filter((event) => event.phase === "media");
    expect(mediaEvents).toHaveLength(5);
    expect(mediaEvents.map((event) => [event.completedMedia, event.checkpointWritten])).toEqual([
      [1, false],
      [2, true],
      [3, false],
      [4, true],
      [5, false],
    ]);
    expect(events.at(-1)).toMatchObject({
      phase: "completed",
      completedMedia: 5,
      totalMedia: 5,
      remainingMedia: 0,
      checkpointWritten: true,
      action: "completed",
    });
    expect(result).toMatchObject({ checkpointEvery: 2, status: "completed" });
    const persisted = JSON.parse(await readFile(
      path.join(projectRoot, ".aicanvas", "local-creative-project-content-import.json"),
      "utf8",
    )) as LocalCreativeProjectContentImportProgress;
    expect(Object.keys(persisted.mediaByFileId)).toHaveLength(5);
    expect(persisted.status).toBe("completed");
    const summaryPath = path.join(projectRoot, ".aicanvas", "local-creative-project-content-summary.json");
    const summary = JSON.parse(await readFile(summaryPath, "utf8")) as LocalCreativeProjectContentImportSummary;
    expect(summary).toMatchObject({
      kind: "local-creative-project-content-import-summary",
      status: "completed",
      processedCounts: { media: 5, eligibleMedia: 5, documents: 0, pendingAssets: 0 },
      failureCounts: { total: 0, media: 0 },
    });

    await rm(summaryPath);
    const backfilled = await backfillLocalCreativeProjectContentSummary(projectRoot);
    expect(backfilled.summaryPath).toBe(summaryPath);
    expect(backfilled.summary).toEqual(summary);
  });

  it("失败与权威决策不等待普通 checkpoint，均先落盘再发进度事件", async () => {
    const { projectRoot, sourceRoot } = await fixture();
    await writePng(sourceRoot, "角色/char-checkpoint.png");
    const missingPath = path.join(sourceRoot, "missing.wav");
    await writeFile(missingPath, wavFixture("will disappear"));
    await writeFile(
      path.join(sourceRoot, "权威.md"),
      "char-checkpoint.png\n状态: APPROVED_LOCK\n唯一权威角色锁\nQC: PASS\n",
    );
    const preview = await inspectLocalCreativeProject({
      projectKey: "forced-checkpoint-story",
      projectName: "强制检查点",
      projectType: "ai-drama",
      sourceLayers: [{ role: "PRIMARY_AUTHORITY", rootPath: sourceRoot }],
    });
    await rm(missingPath);
    const observations: Array<{ event: LocalCreativeProjectContentImportProgressEvent; persisted: LocalCreativeProjectContentImportProgress }> = [];
    const result = await importLocalCreativeProjectContent({
      projectRoot,
      preview,
      authorityPolicy: "CREATE_PENDING_FROM_APPROVED_LOCKS",
      checkpointEvery: 100,
      onProgress: async (event) => {
        if (event.phase !== "media" && event.phase !== "canonical-asset") return;
        const persisted = JSON.parse(await readFile(
          path.join(projectRoot, ".aicanvas", "local-creative-project-content-import.json"),
          "utf8",
        )) as LocalCreativeProjectContentImportProgress;
        observations.push({ event, persisted });
      },
    });
    const failed = observations.find((entry) => entry.event.action === "failed" && entry.event.phase === "media");
    expect(failed).toBeDefined();
    expect(failed?.event.checkpointWritten).toBe(true);
    expect(failed?.persisted.failures.some((failure) => failure.path === missingPath)).toBe(true);
    const authority = observations.find((entry) => entry.event.phase === "canonical-asset");
    expect(authority?.event).toMatchObject({ checkpointWritten: true, action: "pending-version-created" });
    expect(Object.values(authority?.persisted.canonicalDecisionsByFileId ?? {})).toEqual([
      expect.objectContaining({ decision: "pending-version-created", authorityPromoted: false }),
    ]);
    expect(result.status).toBe("completed-with-failures");
  });

  it("重跑只保留当前媒体失败：成功恢复或新扫描已拒绝时清理旧 failure", async () => {
    const { projectRoot, sourceRoot } = await fixture();
    const recoverPath = path.join(sourceRoot, "recover.wav");
    await writeFile(recoverPath, wavFixture("recover"));
    const firstPreview = await inspectLocalCreativeProject({
      projectKey: "failure-recovery-story",
      projectName: "失败恢复",
      projectType: "ai-drama",
      sourceLayers: [{ role: "ACTIVE_PRODUCTION", rootPath: sourceRoot }],
    });
    await rm(recoverPath);
    const failed = await importLocalCreativeProjectContent({
      projectRoot,
      preview: firstPreview,
      authorityPolicy: "FORBID_ALL",
    });
    expect(failed.status).toBe("completed-with-failures");
    expect(failed.failures).toContainEqual(expect.objectContaining({ phase: "media", path: recoverPath }));

    await writeFile(recoverPath, wavFixture("recover"));
    const recoveredPreview = await inspectLocalCreativeProject({
      projectKey: "failure-recovery-story",
      projectName: "失败恢复",
      projectType: "ai-drama",
      sourceLayers: [{ role: "ACTIVE_PRODUCTION", rootPath: sourceRoot }],
    });
    const recovered = await importLocalCreativeProjectContent({
      projectRoot,
      preview: recoveredPreview,
      authorityPolicy: "FORBID_ALL",
    });
    expect(recovered.status).toBe("completed");
    expect(recovered.failures.some((failure) => failure.phase === "media" && failure.path === recoverPath)).toBe(false);

    const rejectedPath = await writePng(sourceRoot, "will-reject.png");
    const beforeRejectedPreview = await inspectLocalCreativeProject({
      projectKey: "failure-recovery-story",
      projectName: "失败恢复",
      projectType: "ai-drama",
      sourceLayers: [{ role: "ACTIVE_PRODUCTION", rootPath: sourceRoot }],
    });
    await rm(rejectedPath);
    const failedBeforeRejection = await importLocalCreativeProjectContent({
      projectRoot,
      preview: beforeRejectedPreview,
      authorityPolicy: "FORBID_ALL",
    });
    expect(failedBeforeRejection.failures).toContainEqual(expect.objectContaining({ phase: "media", path: rejectedPath }));

    await writeFile(rejectedPath, "<?xml version=\"1.0\"?><Error>placeholder</Error>");
    const rejectedPreview = await inspectLocalCreativeProject({
      projectKey: "failure-recovery-story",
      projectName: "失败恢复",
      projectType: "ai-drama",
      sourceLayers: [{ role: "ACTIVE_PRODUCTION", rootPath: sourceRoot }],
    });
    expect(rejectedPreview.files.find((file) => file.absolutePath === rejectedPath)?.status).toBe("REJECTED_OR_FORBIDDEN");
    const cleaned = await importLocalCreativeProjectContent({
      projectRoot,
      preview: rejectedPreview,
      authorityPolicy: "FORBID_ALL",
    });
    expect(cleaned.status).toBe("completed");
    expect(cleaned.runSummary).toMatchObject({ mediaRejected: 1, mediaFailed: 0 });
    expect(cleaned.failures.some((failure) => failure.phase === "media" && failure.path === rejectedPath)).toBe(false);
    const compact = JSON.parse(await readFile(
      path.join(projectRoot, ".aicanvas", "local-creative-project-content-summary.json"),
      "utf8",
    )) as LocalCreativeProjectContentImportSummary;
    expect(compact.failureCounts.media).toBe(0);
  });
});
