import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  analyzeAdaptationChangeImpact,
  analyzeNovelChapters,
  exportAdaptation,
  generateAdaptationPlans,
  getAdaptationWorkspace,
  materializeSelectedAdaptationPlan,
  regenerateAdaptationScope,
  selectAdaptationPlan,
  upsertNovelFact,
  validateAdaptationPlan,
} from "../src/core/adaptation.js";
import { commitProjectImport, prepareProjectImport } from "../src/core/importer.js";
import { getConfirmedStoryboardContracts, getStoryboard, upsertStoryboardRow } from "../src/core/production.js";
import { getSidecarPaths, writeJsonAtomic } from "../src/core/sidecar.js";
import { getProjectIndex } from "../src/core/service.js";
import { importStoryFile } from "../src/core/story.js";
import { executeIdempotentCommand } from "../src/core/command-bus.js";
import { createNovelAnalysisTask, listNovelAnalysisReviews, reviewNovelAnalysisBatch, reviewNovelAnalysisItem, submitNovelAnalysisProposal } from "../src/core/novel-analysis.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-adaptation-"));
  roots.push(root);
  const novelPath = path.join(root, "小说.md");
  await writeFile(novelPath, `# 第一章 雾中祭坛
清晨，阿航穿着黑袍进入古老祭坛，浓雾贴着石阶流动。
嘟嘟守在门外，低声说：“别碰那副完整黄金面具。”
阿航的师父曾警告他，完整黄金面具不得改成半面具。
忽然火光熄灭，阿航心中害怕，却仍伸手拿起黄金面具。
石门轰然关闭，嘟嘟冲进祭坛，阿航回头看向她。`, "utf8");
  const preview = await prepareProjectImport({ primaryRoot: root, projectMode: "story_first", name: "小说自动分镜测试" });
  await commitProjectImport({ previewId: preview.previewId, config: preview.config, projectMode: "story_first" });
  await importStoryFile(root, novelPath, "雾中祭坛");
  return { root, novelPath };
}

describe("中文小说自动改编与15秒多镜头分镜", () => {
  it("批量审核原子化执行并自动先接受事实再接受节拍", async () => {
    const { root } = await fixture();
    const created = await createNovelAnalysisTask(root, { expectedRevision: 0, providerId: "codex", providerKind: "codex" });
    const chapter = created.task.chapterRefs[0]!;
    const content = await readFile(chapter.path, "utf8");
    const evidence = "清晨，阿航穿着黑袍进入古老祭坛，浓雾贴着石阶流动。";
    const startOffset = content.indexOf(evidence);
    const span = { sourceId: chapter.sourceId, chapterId: chapter.chapterId, chapterRevision: chapter.revision, chapterSha256: chapter.sha256, startOffset, endOffset: startOffset + evidence.length, text: evidence };
    const submitted = await submitNovelAnalysisProposal(root, { taskId: created.task.id, expectedRevision: created.workspace.revision, facts: [{ id: "batch-fact", kind: "event", epistemicStatus: "confirmed", statement: evidence, sourceSpans: [span], tags: [] }], beats: [{ id: "batch-beat", order: 1, title: "进入祭坛", summary: evidence, narrativePurpose: "建立空间", visualAction: "阿航进入祭坛", emotionalShift: "平静转警觉", mustKeep: [evidence], estimatedDurationSeconds: 4, factIds: ["batch-fact"], sourceSpans: [span], intensity: 2 }] });
    const factReview = submitted.reviews.find((review) => review.kind === "fact")!;
    const beatReview = submitted.reviews.find((review) => review.kind === "beat")!;
    const result = await reviewNovelAnalysisBatch(root, { expectedRevision: submitted.workspace.revision, decisions: [{ reviewId: beatReview.id, decision: "accepted", reviewExpectedRevision: beatReview.revision }, { reviewId: factReview.id, decision: "accepted", reviewExpectedRevision: factReview.revision }] });
    expect(result.workspace.revision).toBe(submitted.workspace.revision + 1);
    expect(result.workspace.facts).toHaveLength(1);
    expect(result.workspace.beats).toHaveLength(1);
    expect(result.workspace.analysisTasks[0]?.status).toBe("completed");
    expect(result.reviews.every((review) => review.status === "accepted")).toBe(true);
    await expect(reviewNovelAnalysisBatch(root, { expectedRevision: result.workspace.revision, decisions: [{ reviewId: factReview.id, decision: "accepted", reviewExpectedRevision: factReview.revision }] })).rejects.toThrow("修订冲突");
  });

  it("模型分析先进入证据确认队列，接受后才写入事实和节拍", async () => {
    const { root } = await fixture();
    const created = await createNovelAnalysisTask(root, { expectedRevision: 0, providerId: "codex", providerKind: "codex" });
    await expect(access(created.task.taskJsonPath)).resolves.toBeUndefined();
    await expect(access(created.task.taskMarkdownPath)).resolves.toBeUndefined();
    const chapter = created.task.chapterRefs[0]!;
    const content = await readFile(chapter.path, "utf8");
    const evidenceText = "清晨，阿航穿着黑袍进入古老祭坛，浓雾贴着石阶流动。";
    const startOffset = content.indexOf(evidenceText);
    const span = { sourceId: chapter.sourceId, chapterId: chapter.chapterId, chapterRevision: chapter.revision, chapterSha256: chapter.sha256, startOffset, endOffset: startOffset + evidenceText.length, text: evidenceText };
    const submitted = await submitNovelAnalysisProposal(root, {
      taskId: created.task.id,
      expectedRevision: created.workspace.revision,
      facts: [
        { id: "fact-arrival", kind: "event", epistemicStatus: "confirmed", statement: evidenceText, sourceSpans: [span], tags: ["模型提案"] },
        { id: "fact-bad", kind: "event", epistemicStatus: "confirmed", statement: "不存在的原文", sourceSpans: [{ ...span, text: "不匹配" }], tags: [] },
      ],
      beats: [{ id: "beat-arrival", order: 1, title: "进入祭坛", summary: evidenceText, narrativePurpose: "建立人物与场景", visualAction: "阿航走入祭坛", emotionalShift: "平静转警觉", mustKeep: [evidenceText], estimatedDurationSeconds: 4, factIds: ["fact-arrival"], sourceSpans: [span], intensity: 2 }],
    });
    expect(submitted.workspace.facts).toEqual([]);
    expect(submitted.workspace.beats).toEqual([]);
    expect(submitted.reviews).toHaveLength(3);
    const goodFact = submitted.reviews.find((review) => review.kind === "fact" && review.fact?.statement === evidenceText)!;
    const badFact = submitted.reviews.find((review) => review.kind === "fact" && review.fact?.statement === "不存在的原文")!;
    const beat = submitted.reviews.find((review) => review.kind === "beat")!;
    expect(goodFact.evidenceIssues).toEqual([]);
    expect(badFact.evidenceIssues.some((issue) => issue.includes("不匹配"))).toBe(true);
    await expect(reviewNovelAnalysisItem(root, { reviewId: beat.id, decision: "accepted", expectedRevision: submitted.workspace.revision, reviewExpectedRevision: beat.revision })).rejects.toThrow("先接受");
    await expect(reviewNovelAnalysisItem(root, { reviewId: badFact.id, decision: "accepted", expectedRevision: submitted.workspace.revision, reviewExpectedRevision: badFact.revision })).rejects.toThrow("证据校验未通过");
    const acceptedFact = await reviewNovelAnalysisItem(root, { reviewId: goodFact.id, decision: "accepted", expectedRevision: submitted.workspace.revision, reviewExpectedRevision: goodFact.revision, note: "原文逐字核验通过" });
    expect(acceptedFact.workspace.facts).toHaveLength(1);
    const acceptedBeat = await reviewNovelAnalysisItem(root, { reviewId: beat.id, decision: "accepted", expectedRevision: acceptedFact.workspace.revision, reviewExpectedRevision: beat.revision });
    expect(acceptedBeat.workspace.beats).toHaveLength(1);
    const rejected = await reviewNovelAnalysisItem(root, { reviewId: badFact.id, decision: "rejected", expectedRevision: acceptedBeat.workspace.revision, reviewExpectedRevision: badFact.revision, note: "原文不匹配" });
    expect(rejected.workspace.analysisTasks.find((task) => task.id === created.task.id)?.status).toBe("completed");
    expect((await listNovelAnalysisReviews(root, { status: "pending" }))).toHaveLength(0);
    expect((await getAdaptationWorkspace(root)).analysisReviews).toHaveLength(3);
  });

  it("从真实章节提取可追溯事实与节拍，并提供精简/拆分方案", async () => {
    const { root } = await fixture();
    const analyzed = await analyzeNovelChapters(root, { expectedRevision: 0 });
    expect(analyzed.facts.length).toBeGreaterThan(analyzed.beats.length);
    expect(analyzed.facts.some((fact) => fact.kind === "character" && fact.statement.includes("阿航"))).toBe(true);
    expect(analyzed.facts.some((fact) => fact.kind === "dialogue" && fact.statement.includes("别碰"))).toBe(true);
    expect(analyzed.facts.some((fact) => fact.kind === "weather" && fact.statement.includes("浓雾"))).toBe(true);
    expect(analyzed.facts.some((fact) => fact.kind === "costume" && fact.statement.includes("黑袍"))).toBe(true);
    expect(analyzed.facts.every((fact) => fact.epistemicStatus === "confirmed" && fact.sourceSpans.length > 0)).toBe(true);
    expect(analyzed.beats.every((beat) => beat.narrativePurpose && beat.visualAction && beat.estimatedDurationSeconds > 0)).toBe(true);

    const generated = await generateAdaptationPlans(root, { expectedRevision: analyzed.revision, episode: 1, startUnit: 1 });
    const concise = generated.plans.find((plan) => plan.mode === "concise")!;
    const split = generated.plans.find((plan) => plan.mode === "split")!;
    expect(concise.units).toHaveLength(1);
    expect(concise.units[0]!.storyboardRows.length).toBeLessThanOrEqual(6);
    expect(split.units.length).toBeGreaterThanOrEqual(2);
    for (const plan of generated.plans) {
      expect(plan.validation.hardErrors).toEqual([]);
      for (const unit of plan.units) {
        expect(unit.durationSeconds).toBeLessThanOrEqual(15);
        expect(unit.storyboardRows.length).toBeLessThanOrEqual(6);
        expect(unit.storyboardRows.reduce((sum, row) => sum + row.durationSeconds, 0)).toBeCloseTo(unit.durationSeconds, 2);
        expect(unit.storyboardRows.every((row) => row.cameraAngle && row.lens && row.composition && row.sourceSpans?.length)).toBe(true);
      }
    }
  });

  it("事实局部编辑要求修订，不重写其他事实或节拍", async () => {
    const { root } = await fixture();
    const analyzed = await analyzeNovelChapters(root, { expectedRevision: 0 });
    const target = analyzed.facts.find((fact) => fact.kind === "event")!;
    const other = analyzed.facts.find((fact) => fact.id !== target.id)!;
    const beatSnapshot = analyzed.beats.map((beat) => ({ id: beat.id, revision: beat.revision }));
    await expect(upsertNovelFact(root, { ...target, statement: `${target.statement}（人工确认）` })).rejects.toThrow("expectedRevision");
    const saved = await upsertNovelFact(root, { ...target, statement: `${target.statement}（人工确认）`, expectedRevision: target.revision });
    expect(saved.revision).toBe(target.revision + 1);
    const reloaded = await getAdaptationWorkspace(root);
    expect(reloaded.facts.find((fact) => fact.id === other.id)?.revision).toBe(other.revision);
    expect(reloaded.beats.map((beat) => ({ id: beat.id, revision: beat.revision }))).toEqual(beatSnapshot);
  });

  it("先计算影响范围，再只重生成并重新物化受影响单元", async () => {
    const { root } = await fixture();
    const analyzed = await analyzeNovelChapters(root, { expectedRevision: 0 });
    const generated = await generateAdaptationPlans(root, { expectedRevision: analyzed.revision, episode: 3, startUnit: 1 });
    const split = generated.plans.find((plan) => plan.mode === "split")!;
    const selected = await selectAdaptationPlan(root, split.id, generated.workspace.revision);
    const materialized = await materializeSelectedAdaptationPlan(root, { expectedRevision: selected.revision });
    const beforePlan = materialized.plan;
    const beforeStoryboard = await getStoryboard(root);
    const firstBeat = analyzed.beats[0]!;
    const changedFact = analyzed.facts.find((fact) => fact.id === firstBeat.factIds[0])!;
    await upsertNovelFact(root, { ...changedFact, statement: `${changedFact.statement}（仅影响首个节拍）`, expectedRevision: changedFact.revision });
    const current = await getAdaptationWorkspace(root);
    const impact = await analyzeAdaptationChangeImpact(root, { factIds: [changedFact.id] });
    const planImpact = impact.plans.find((candidate) => candidate.planId === split.id)!;
    expect(planImpact.unitIds.length).toBeGreaterThan(0);
    expect(planImpact.unitIds.length).toBeLessThan(beforePlan.units.length);
    const unaffected = beforePlan.units.find((unit) => !planImpact.unitIds.includes(unit.id))!;

    const regenerated = await regenerateAdaptationScope(root, { planId: split.id, expectedRevision: current.revision, factIds: [changedFact.id] });
    expect(regenerated.plan.status).toBe("selected");
    expect(regenerated.plan.pendingUnitIds).toEqual(planImpact.unitIds);
    expect(regenerated.plan.units.find((unit) => unit.id === unaffected.id)).toEqual(unaffected);
    const applied = await materializeSelectedAdaptationPlan(root, { expectedRevision: regenerated.workspace.revision });
    expect(applied.plan.status).toBe("materialized");
    expect(applied.plan.pendingUnitIds).toBeUndefined();

    const afterStoryboard = await getStoryboard(root);
    const affectedSet = new Set(planImpact.unitIds);
    for (const before of beforeStoryboard.rows) {
      const after = afterStoryboard.rows.find((row) => row.id === before.id)!;
      if (affectedSet.has(before.adaptationUnitId!)) expect(after.revision).toBeGreaterThan(before.revision);
      else expect(after).toEqual(before);
    }
  });

  it("程序校验识别对白过快、证据失效和完整黄金面具禁项", async () => {
    const { root } = await fixture();
    const analyzed = await analyzeNovelChapters(root, { expectedRevision: 0 });
    const generated = await generateAdaptationPlans(root, { expectedRevision: analyzed.revision });
    const plan = structuredClone(generated.plans.find((candidate) => candidate.mode === "concise")!);
    const configPath = getSidecarPaths(root).config;
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.hardLocks = [{ id: "gold-mask", name: "完整黄金面具", path: path.join(root, "黄金面具.png"), note: "完整黄金面具不得改成半面具" }];
    await writeFile(path.join(root, "黄金面具.png"), "reference", "utf8");
    await writeJsonAtomic(configPath, config);
    expect((await validateAdaptationPlan(root, plan)).hardErrors.some((issue) => issue.includes("半面具"))).toBe(false);
    const row = plan.units[0]!.storyboardRows[0]!;
    row.dialogue = "这是一段明显无法在当前镜头时长内自然说完的超长对白。".repeat(12);
    row.firstFramePrompt += "，改成半面具";
    row.upstreamFactRefs = [{ id: "missing-fact", revision: 1 }];
    const validation = await validateAdaptationPlan(root, plan);
    expect(validation.hardErrors.some((issue) => issue.includes("对白速率"))).toBe(true);
    expect(validation.hardErrors.some((issue) => issue.includes("事实引用已失效"))).toBe(true);
    expect(validation.hardErrors.some((issue) => issue.includes("半面具"))).toBe(true);
  });

  it("选定拆分方案后物化真实单元与草稿分镜，重启读取并导出JSON/Markdown", async () => {
    const { root } = await fixture();
    const analyzed = await analyzeNovelChapters(root, { expectedRevision: 0 });
    const generated = await generateAdaptationPlans(root, { expectedRevision: analyzed.revision, episode: 2, startUnit: 1 });
    const split = generated.plans.find((plan) => plan.mode === "split")!;
    const selected = await selectAdaptationPlan(root, split.id, generated.workspace.revision);
    await expect(materializeSelectedAdaptationPlan(root, { expectedRevision: selected.revision, confirmRows: true })).rejects.toThrow("不能在物化时直接标记 confirmed");
    const result = await materializeSelectedAdaptationPlan(root, { expectedRevision: selected.revision });
    expect(result.unitPaths.length).toBe(split.units.length);
    await Promise.all(result.unitPaths.map((filePath) => expect(access(filePath)).resolves.toBeUndefined()));
    expect(result.storyboardRows.length).toBeGreaterThan(0);
    expect(result.storyboardRows.every((row) => row.status === "draft" && row.adaptationPlanId === split.id)).toBe(true);
    const index = await getProjectIndex(root);
    expect(index.items.filter((item) => item.type === "unit" && item.episode === 2)).toHaveLength(split.units.length);
    const storyboard = await getStoryboard(root);
    expect(storyboard.valid).toBe(true);
    expect(storyboard.rows.length).toBe(result.storyboardRows.length);

    const jsonPath = path.join(root, "导出_分镜_v001.json");
    const markdownPath = path.join(root, "导出_分镜_v001.md");
    await exportAdaptation(root, { format: "json", outputPath: jsonPath, planId: split.id });
    await exportAdaptation(root, { format: "markdown", outputPath: markdownPath, planId: split.id });
    expect(JSON.parse(await readFile(jsonPath, "utf8")).plan.id).toBe(split.id);
    expect(await readFile(markdownPath, "utf8")).toContain("镜头");
    await expect(exportAdaptation(root, { format: "json", outputPath: jsonPath, planId: split.id })).rejects.toThrow("不能静默覆盖");

    const reloaded = await getAdaptationWorkspace(root);
    expect(reloaded.selectedPlanId).toBe(split.id);
    expect(reloaded.plans.find((plan) => plan.id === split.id)?.status).toBe("materialized");
    expect(reloaded.plans.find((plan) => plan.id === split.id)?.units.flatMap((unit) => unit.storyboardRows).length).toBe(result.storyboardRows.length);
    const row = result.storyboardRows[0]!;
    const { id, revision, createdAt: _createdAt, updatedAt: _updatedAt, ...rowInput } = row;
    const confirmed = await upsertStoryboardRow(root, { ...rowInput, id, expectedRevision: revision, status: "confirmed" });
    await expect(getConfirmedStoryboardContracts(root, [confirmed.itemId])).resolves.toBeDefined();
    const referencedFact = reloaded.facts.find((fact) => fact.id === confirmed.upstreamFactRefs?.[0]?.id)!;
    await upsertNovelFact(root, { ...referencedFact, statement: `${referencedFact.statement}（导演修订）`, expectedRevision: referencedFact.revision });
    await expect(getConfirmedStoryboardContracts(root, [confirmed.itemId])).rejects.toThrow("旧合同不能继续生产");
    await expect(upsertStoryboardRow(root, { ...rowInput, id, expectedRevision: confirmed.revision, status: "confirmed" })).rejects.toThrow("上游证据已变化");
  });

  it("损坏 adaptation JSON 时停止读取，不会当成空数据覆盖", async () => {
    const { root } = await fixture();
    await analyzeNovelChapters(root, { expectedRevision: 0 });
    const sidecar = getSidecarPaths(root).storyAdaptation;
    await writeFile(sidecar, '{"schemaVersion":1,"revision":"broken"}', "utf8");
    await expect(getAdaptationWorkspace(root)).rejects.toThrow("结构损坏");
    expect(await readFile(sidecar, "utf8")).toContain('"broken"');
  });

  it("Codex 幂等命令重试不会重复分析或递增工作区修订", async () => {
    const { root } = await fixture();
    const first = await executeIdempotentCommand(root, { requestId: "adaptation-analyze-request-001", idempotencyKey: "adaptation-analyze-idempotent-v1", request: { command: "analyze_novel_chapters", payload: { expectedRevision: 0 } } });
    const replay = await executeIdempotentCommand(root, { requestId: "adaptation-analyze-request-002", idempotencyKey: "adaptation-analyze-idempotent-v1", request: { command: "analyze_novel_chapters", payload: { expectedRevision: 0 } } });
    expect(first.status).toBe("succeeded");
    expect(replay.replayed).toBe(true);
    expect((await getAdaptationWorkspace(root)).revision).toBe(1);
  });
});
