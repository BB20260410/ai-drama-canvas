import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  getStudioGenerationTrace,
  getStudioScriptRevisionImpact,
  StudioTraceError,
} from "../src/core/studio-trace.js";
import {
  listStudioGenerationPacksByUnit,
  listStudioGenerationResultsByPack,
  listStudioGenerationRunsByPack,
  readStudioGenerationFrozenPack,
} from "../src/core/studio-generation-ledger.js";
import { listStudioUnitRevisionsByScriptRevision } from "../src/core/studio-production.js";
import { buildStudioAssetBindingCurrentContext } from "../src/core/studio-binding-control.js";
import { submitStudioGenerationReview } from "../src/core/studio-generation-review.js";
import {
  advanceP24PromptRevision,
  advanceP24ScriptRevision,
  createStudioP24TraceFixture,
  dispatchAndRegisterP24Pair,
  freezeP24Pack,
  rebindP24PanelToNewHead,
  reviseP24UnitToNewRevisions,
  reversionP24AssetAuthority,
  type StudioP24TraceFixture,
} from "./helpers/studio-p24-trace-fixture.js";

/** P24 追溯 Core 行为测试（规范 §4-1..4、§4-8；全部 mkdtemp 隔离）。 */

let fixture: StudioP24TraceFixture | undefined;

afterEach(async () => {
  await fixture?.p7.cleanup();
  fixture = undefined;
});

async function p24(): Promise<StudioP24TraceFixture> {
  fixture = await createStudioP24TraceFixture();
  return fixture;
}

describe("P24 §4-1/2 selector 校验与 not-found", () => {
  it("selector 必须恰好其一；不存在的对象按类报 not-found", async () => {
    const f = await p24();
    await expect(getStudioGenerationTrace(f.root, { packId: "pack-x", runId: "run-y" } as never))
      .rejects.toMatchObject({ code: "trace-selector-invalid" });
    await expect(getStudioGenerationTrace(f.root, {} as never))
      .rejects.toMatchObject({ code: "trace-selector-invalid" });
    await expect(getStudioGenerationTrace(f.root, { packId: "pack-no-such" }))
      .rejects.toMatchObject({ code: "pack-not-found" });
    await expect(getStudioGenerationTrace(f.root, { runId: "run-no-such" }))
      .rejects.toMatchObject({ code: "run-not-found" });
    await expect(getStudioGenerationTrace(f.root, { resultId: "result-no-such" }))
      .rejects.toMatchObject({ code: "result-not-found" });
  });

  it("非受管工程 → 各入口 fail-closed", async () => {
    const bogus = await mkdtemp(path.join("/tmp", "p24-unmanaged-"));
    try {
      await expect(getStudioGenerationTrace(bogus, { packId: "pack-x" })).rejects.toThrow();
      await expect(getStudioScriptRevisionImpact(bogus, { scriptRevisionId: "rev-x" })).rejects.toThrow();
    } finally {
      await rm(bogus, { recursive: true, force: true });
    }
  });
});

describe("P24 §4-2 当时值还原与分类输入", () => {
  it("推进提示词/剧本后，trace 仍返回包内旧修订身份（不读 head），分类来自 BindingSet 实时重算", async () => {
    const f = await p24();
    const pack = await freezeP24Pack(f, f.units.four, 1);
    await dispatchAndRegisterP24Pair(f, pack, "p24-behavior-run-0001");
    const before = await getStudioGenerationTrace(f.root, { packId: pack.packId });
    const promptBefore = before.prompt!.revisionId;
    const scriptBefore = before.script.revisionId;
    expect(before.changeClassification.classification).toBe("current");
    expect(before.bindingSetStaleReasons).toEqual([]);

    const advancedPrompt = await advanceP24PromptRevision(f);
    const advancedScript = await advanceP24ScriptRevision(f);
    // 真实用户流：修订文档后把单元推进到新修订（绑定 currentness 才对旧集产出 prompt-changed/script-changed）。
    await reviseP24UnitToNewRevisions(f, f.units.four, {
      scriptRevisionId: advancedScript.revision.id,
      promptRevisionId: advancedPrompt.revision.id,
    });
    const after = await getStudioGenerationTrace(f.root, { packId: pack.packId });
    expect(after.prompt!.revisionId).toBe(promptBefore);
    expect(after.script.revisionId).toBe(scriptBefore);
    // 分类输入=BindingSet 词表实时重算：prompt-changed/script-changed/unit-changed 均为预期白名单词
    expect(after.changeClassification.classification).toBe("expected");
    expect(after.changeClassification.expectedReasons).toContain("prompt-changed");
    expect(after.changeClassification.expectedReasons).toContain("script-changed");
    expect(after.changeClassification.unexpectedReasons).toEqual([]);
    // 结果面 storedStaleReasons 为冻结码原文（`${code}: ${message}`），不进 classify
    for (const result of after.results) {
      for (const reason of result.storedStaleReasons) expect(reason).toMatch(/^[a-z-]+: /u);
    }
  });

  it("资产再版本 → asset-semantic-changed 归 unexpected（fail-safe，权威资产不自动归预期）", async () => {
    const f = await p24();
    const pack = await freezeP24Pack(f, f.units.four, 2);
    await dispatchAndRegisterP24Pair(f, pack, "p24-behavior-run-0002");
    await reversionP24AssetAuthority(f, "character-ahang");
    const trace = await getStudioGenerationTrace(f.root, { packId: pack.packId });
    expect(trace.changeClassification.classification).toBe("unexpected");
    expect(trace.changeClassification.unexpectedReasons).toContain("asset-semantic-changed:character-ahang");
  });

  it("资产退化（不再适用目标宫格）→ trace/impact fail-safe 归 unexpected 继续返回，不硬抛（盲审 P1 回归）", async () => {
    const f = await p24();
    const pack = await freezeP24Pack(f, f.units.four, 1);
    await dispatchAndRegisterP24Pair(f, pack, "p24-behavior-run-degraded");
    // 真实用户流：把被绑定资产的适用范围改到不含目标宫格（command-bus 可达路径），
    // metadataBindingSource 抛错 → buildBindingContext 无 context → binding-context-incomplete。
    const { getStudioCanonicalAsset, updateStudioCanonicalAsset } = await import("../src/core/material-studio.js");
    const detail = await getStudioCanonicalAsset(f.root, "character-ahang");
    expect(detail).toBeTruthy();
    await updateStudioCanonicalAsset(f.root, {
      assetId: "character-ahang",
      expectedRevision: detail!.revision,
      applicability: { seasons: ["season-nine"] },
    });

    const trace = await getStudioGenerationTrace(f.root, { packId: pack.packId });
    expect(trace.changeClassification.classification).toBe("unexpected");
    expect(trace.changeClassification.unexpectedReasons).toContain("asset-context-incomplete:binding-context-incomplete");
    expect(trace.bindingSetStaleReasons).toEqual(["asset-context-incomplete:binding-context-incomplete"]);
    // 投影其余部分照常返回（runs/results 不丢）。
    expect(trace.runs.length).toBeGreaterThan(0);
    expect(trace.results.length).toBeGreaterThan(0);

    // 反向 impact 同路径 fail-safe：整页不炸，该 pack 行分类 unexpected。
    const impact = await getStudioScriptRevisionImpact(f.root, { scriptRevisionId: f.units.four.scriptRevision.id });
    const rows = impact.items.flatMap((item) => item.rows).filter((row) => row.packId === pack.packId);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.changeClassification).toBe("unexpected");
  });

  it("run terminal 语义：仅派发/raw 单边=false，raw+labeled 成对（succeeded）=true（盲审 P2 回归）", async () => {
    const f = await p24();
    const pack = await freezeP24Pack(f, f.units.two, 1);
    const { dispatchStudioGenerationPack, registerStudioGenerationResult } = await import("../src/core/studio-generation-ledger.js");
    await dispatchStudioGenerationPack(f.root, {
      packId: pack.packId,
      packFingerprint: pack.fingerprint,
      generationRunId: "p24-terminal-run-0001",
      provider: "codex",
    });
    const media = f.p7.panelMediaPairs[0]!;

    const dispatched = await getStudioGenerationTrace(f.root, { packId: pack.packId });
    expect(dispatched.runs).toHaveLength(1);
    expect(dispatched.runs[0]!.terminal).toBe(false);

    await registerStudioGenerationResult(f.root, {
      packId: pack.packId,
      packFingerprint: pack.fingerprint,
      generationRunId: "p24-terminal-run-0001",
      variant: "raw",
      mediaSha256: media.raw.imported.sha256,
      provider: "codex",
    });
    const rawOnly = await getStudioGenerationTrace(f.root, { packId: pack.packId });
    expect(rawOnly.runs[0]!.terminal).toBe(false);

    await registerStudioGenerationResult(f.root, {
      packId: pack.packId,
      packFingerprint: pack.fingerprint,
      generationRunId: "p24-terminal-run-0001",
      variant: "labeled",
      mediaSha256: media.labeled.imported.sha256,
      provider: "codex",
    });
    const succeeded = await getStudioGenerationTrace(f.root, { packId: pack.packId });
    expect(succeeded.runs[0]!.terminal).toBe(true);
  });

  it("run terminal 分支：failed/cancelled → terminal=true（盲审 F4-2 补强）", async () => {
    const f = await p24();
    const pack = await freezeP24Pack(f, f.units.six, 1);
    const { dispatchStudioGenerationPack, failStudioGenerationRun, cancelStudioGenerationRun } =
      await import("../src/core/studio-generation-ledger.js");
    await dispatchStudioGenerationPack(f.root, {
      packId: pack.packId,
      packFingerprint: pack.fingerprint,
      generationRunId: "p24-terminal-run-failed",
      provider: "codex",
    });
    // 先落终态再派第二个 run（panel-run-in-flight 互斥闸不允许两个非终态 run 并存）。
    await failStudioGenerationRun(f.root, { generationRunId: "p24-terminal-run-failed", errorClass: "provider-timeout", detail: "smoke 机械注入" });
    await dispatchStudioGenerationPack(f.root, {
      packId: pack.packId,
      packFingerprint: pack.fingerprint,
      generationRunId: "p24-terminal-run-cancelled",
      provider: "codex",
    });
    await cancelStudioGenerationRun(f.root, { generationRunId: "p24-terminal-run-cancelled", reason: "smoke 机械注入" });

    const trace = await getStudioGenerationTrace(f.root, { packId: pack.packId });
    const byRunId = new Map(trace.runs.map((run) => [run.runId, run]));
    expect(byRunId.get("p24-terminal-run-failed")!.terminal).toBe(true);
    expect(byRunId.get("p24-terminal-run-failed")!.latestEventKind).toBe("failed");
    expect(byRunId.get("p24-terminal-run-cancelled")!.terminal).toBe(true);
    expect(byRunId.get("p24-terminal-run-cancelled")!.latestEventKind).toBe("cancelled");
  });

  it("runs/results/reviews 组合投影与身份字段齐备", async () => {
    const f = await p24();
    const pack = await freezeP24Pack(f, f.units.six, 1);
    const { rawResultId, labeledResultId } = await dispatchAndRegisterP24Pair(f, pack, "p24-behavior-run-0003");
    const frozen = await readStudioGenerationFrozenPack(f.root, pack.packId);
    const rawMedia = f.p7.panelMediaPairs[0]!;
    await submitStudioGenerationReview(f.root, {
      generationRunId: "p24-behavior-run-0003",
      kind: "observation",
      expectedHeadRevision: 0,
      rawResultId,
      rawSha256: rawMedia.raw.imported.sha256,
      labeledResultId,
      labeledSha256: rawMedia.labeled.imported.sha256,
      expectedPackFingerprint: pack.fingerprint,
      continuityFingerprint: frozen!.continuity.fingerprint,
      decision: "rework",
      criteria: [{ code: "face", status: "fail", note: "脸型不一致" }],
      reviewer: "user",
      note: "P24 trace reviews 组合测试",
      operationId: "p24-trace-review-op-0001",
    });
    const trace = await getStudioGenerationTrace(f.root, { runId: "p24-behavior-run-0003" });
    expect(trace.runs).toHaveLength(1);
    expect(trace.runs[0]!.runId).toBe("p24-behavior-run-0003");
    expect(trace.runs[0]!.eventCount).toBeGreaterThanOrEqual(1);
    expect(trace.runsTruncated).toBe(false);
    expect(trace.results.map((entry) => entry.variant).sort()).toEqual(["labeled", "raw"]);
    expect(trace.resultsTruncated).toBe(false);
    expect(trace.reviews).toHaveLength(1);
    expect(trace.reviews[0]).toMatchObject({
      generationRunId: "p24-behavior-run-0003",
      packId: pack.packId,
      packFingerprint: pack.fingerprint,
      decision: "rework",
    });
    expect(trace.reviewsTruncated).toBe(false);
    // by-result selector 解析同一 pack
    const byResult = await getStudioGenerationTrace(f.root, { resultId: rawResultId });
    expect(byResult.pack.packId).toBe(pack.packId);
  });
});

describe("P24 §4-3 反向影响（两层分页+empty+fail-closed）", () => {
  it("按剧本 revision 反查：命中单元修订与 pack 行；未知 revision → empty 合法形态", async () => {
    const f = await p24();
    const pack = await freezeP24Pack(f, f.units.two, 1);
    await dispatchAndRegisterP24Pair(f, pack, "p24-impact-run-0001");
    const scriptRevisionId = f.units.two.scriptRevision.id;
    const impact = await getStudioScriptRevisionImpact(f.root, { scriptRevisionId });
    expect(impact.empty).toBe(false);
    const hit = impact.items.find((item) => item.unitId === f.units.two.unit.id);
    expect(hit).toBeDefined();
    expect(hit!.rows.some((row) => row.packId === pack.packId && row.resultId)).toBe(true);
    const empty = await getStudioScriptRevisionImpact(f.root, { scriptRevisionId: "rev-no-such-revision" });
    expect(empty.empty).toBe(true);
    expect(empty.items).toEqual([]);
  });

  it("两层分页：limit=1 翻页连续不漏不重；非法 cursor fail-closed", async () => {
    const f = await p24();
    // 同一剧本 revision 上制造第二单元修订（推进单元修订，spans 不变）。
    const unit = f.units.two;
    const { reviseStudioProductionUnit } = await import("../src/core/studio-production.js");
    const revised = await reviseStudioProductionUnit(f.root, {
      unitId: unit.unit.id,
      expectedRevision: unit.unit.revision,
      season: unit.unit.season,
      episode: unit.unit.episode,
      sequence: unit.unit.sequence,
      title: unit.unit.title,
      scriptRevisionId: unit.scriptRevision.id,
      panels: unit.panels.map((panel) => ({
        id: panel.id,
        title: panel.title,
        visualAction: panel.visualAction,
        shotComposition: panel.shotComposition,
        filmingMethod: panel.filmingMethod,
        dialogue: panel.dialogue,
        subtitle: panel.subtitle,
        startSeconds: panel.startSeconds,
        endSeconds: panel.endSeconds,
        durationSeconds: panel.durationSeconds,
        promptRevisionId: panel.promptRevisionId,
        sourceSpans: panel.sourceSpans.map((span) => ({ ...span })),
        assets: panel.assets.map((asset) => ({ ...asset })),
      })),
    });
    expect(revised.unit.revision).toBe(unit.unit.revision + 1);
    const scriptRevisionId = unit.scriptRevision.id;
    const first = await listStudioUnitRevisionsByScriptRevision(f.root, { scriptRevisionId, limit: 1 });
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toBeTruthy();
    const seen = new Set(first.items.map((item) => `${item.unitId}#${item.revision}`));
    let cursor: string | undefined = first.nextCursor;
    let pages = 1;
    while (cursor) {
      const next: Awaited<ReturnType<typeof listStudioUnitRevisionsByScriptRevision>> = await listStudioUnitRevisionsByScriptRevision(f.root, { scriptRevisionId, limit: 1, cursor });
      for (const item of next.items) {
        const key = `${item.unitId}#${item.revision}`;
        expect(seen.has(key)).toBe(false);
        seen.add(key);
      }
      cursor = next.nextCursor;
      pages += 1;
      expect(pages).toBeLessThan(20);
    }
    // 该工程同一剧本 revision 至少有 two/four/six 三单元首修订 + two 的第二修订
    expect(seen.size).toBeGreaterThanOrEqual(4);
    await expect(listStudioUnitRevisionsByScriptRevision(f.root, { scriptRevisionId, cursor: "bogus-cursor" }))
      .rejects.toThrow();
  });
});

describe("P24 §4-4 新只读导出与错误形态", () => {
  it("runs/results/packs 三导出有界分页", async () => {
    const f = await p24();
    const pack = await freezeP24Pack(f, f.units.four, 3);
    await dispatchAndRegisterP24Pair(f, pack, "p24-exports-run-0001");
    const runs = await listStudioGenerationRunsByPack(f.root, { packId: pack.packId });
    expect(runs.items.map((item) => item.generationRunId)).toEqual(["p24-exports-run-0001"]);
    const results = await listStudioGenerationResultsByPack(f.root, { packId: pack.packId });
    expect(results.items).toHaveLength(2);
    const packs = await listStudioGenerationPacksByUnit(f.root, { unitId: f.units.four.unit.id });
    expect(packs.items.some((item) => item.packId === pack.packId)).toBe(true);
    const packsByPanel = await listStudioGenerationPacksByUnit(f.root, { unitId: f.units.four.unit.id, panelId: pack.panel.id });
    expect(packsByPanel.items.map((item) => item.packId)).toEqual([pack.packId]);
  });

  it("packs-by-unit 的 unitRevision 过滤下推 SQL（F-R1-01 防回归：目标修订 pack 不被 LIMIT 挤出）", async () => {
    const f = await p24();
    const packR1 = await freezeP24Pack(f, f.units.four, 4);
    await reviseP24UnitToNewRevisions(f, f.units.four, {});
    const current = await import("../src/core/studio-production.js").then((module) => module.readStudioProductionUnitSnapshot(f.root, f.units.four.unit.id));
    expect(current!.unit.revision).toBe(f.units.four.unit.revision + 1);
    // 修订过滤为 SQL WHERE 下推（源码锚点），不是 LIMIT 后内存过滤。
    const ledgerSource = await import("node:fs/promises").then((fs) => fs.readFile("src/core/studio-generation-ledger.ts", "utf8"));
    const packsQuery = ledgerSource.slice(ledgerSource.indexOf("listStudioGenerationPacksByUnit"));
    expect(packsQuery).toContain("unit_revision = ?");
    // r1 命中旧包；r2 为空（真实"从未冻结"）；不带修订过滤可见全部。
    const r1Only = await listStudioGenerationPacksByUnit(f.root, { unitId: f.units.four.unit.id, unitRevision: f.units.four.unit.revision });
    expect(r1Only.items.map((item) => item.packId)).toEqual([packR1.packId]);
    const r2Only = await listStudioGenerationPacksByUnit(f.root, { unitId: f.units.four.unit.id, unitRevision: current!.unit.revision });
    expect(r2Only.items).toEqual([]);
    const all = await listStudioGenerationPacksByUnit(f.root, { unitId: f.units.four.unit.id, panelId: packR1.panel.id });
    expect(all.items.map((item) => item.packId)).toEqual([packR1.packId]);
    // impact：r1 行命中 pack；r2 为真实空行（pack/run/result 全 null，非误报）。
    const impact = await getStudioScriptRevisionImpact(f.root, { scriptRevisionId: f.units.four.scriptRevision.id });
    const r1Rows = impact.items.find((item) => item.unitId === f.units.four.unit.id && item.unitRevision === f.units.four.unit.revision);
    expect(r1Rows?.rows.some((row) => row.packId === packR1.packId)).toBe(true);
    const r2Rows = impact.items.find((item) => item.unitId === f.units.four.unit.id && item.unitRevision === current!.unit.revision);
    expect(r2Rows?.rows).toEqual([{ panelId: null, packId: null, runId: null, resultId: null, inputCurrent: null, changeClassification: null }]);
  });

  it("buildStudioAssetBindingCurrentContext：不存在 BindingSet → binding-set-not-found", async () => {
    const f = await p24();
    await expect(buildStudioAssetBindingCurrentContext(f.root, "bs-no-such"))
      .rejects.toMatchObject({ code: "binding-set-not-found" });
  });

  it("冻结包 CAS 损坏 → pack-cas-drift 抛错穿透（trace 不兜底伪造投影）", async () => {
    const f = await p24();
    const pack = await freezeP24Pack(f, f.units.two, 2);
    const db = new DatabaseSync(path.join(f.root, ".aicanvas", "studio-generation-ledger.sqlite"));
    const row = db.prepare("SELECT content_relpath FROM studio_generation_packs WHERE pack_id = ?").get(pack.packId) as { content_relpath: string };
    db.close();
    await writeFile(path.join(f.root, ...row.content_relpath.split("/")), "{\"corrupt\":true}\n", "utf8");
    await expect(getStudioGenerationTrace(f.root, { packId: pack.packId }))
      .rejects.toMatchObject({ code: "pack-cas-drift" });
  });

  it("rebind 产生新 head → binding-set-not-head 归 expected（资产差异的预期承载路径）", async () => {
    const f = await p24();
    const pack = await freezeP24Pack(f, f.units.two, 1);
    await dispatchAndRegisterP24Pair(f, pack, "p24-rebind-run-0001");
    await rebindP24PanelToNewHead(f, f.units.two, 1);
    const trace = await getStudioGenerationTrace(f.root, { packId: pack.packId });
    expect(trace.changeClassification.classification).toBe("expected");
    expect(trace.changeClassification.expectedReasons).toContain("binding-set-not-head");
    // 绑定集身份仍是包内旧集（不读 head）
    expect(trace.bindingSet!.id).not.toBe("");
  });
});
