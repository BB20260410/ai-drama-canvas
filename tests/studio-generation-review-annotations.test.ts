import { createHash } from "node:crypto";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  dispatchStudioGenerationPack,
  freezeAndPersistStudioGenerationPack,
  registerStudioGenerationResult,
} from "../src/core/studio-generation-ledger.js";
import {
  getStudioGenerationReviewControl,
  listStudioGenerationReviewHistory,
  submitStudioGenerationReview,
  type StudioGenerationReviewAnnotationInput,
  type SubmitStudioGenerationReviewInput,
} from "../src/core/studio-generation-review.js";
import {
  createStudioP7Fixture,
  seedStudioP7ResolvedContinuity,
  type StudioP7Fixture,
} from "./helpers/studio-p7-fixture.js";

/**
 * P22 批注 v2 定向测试（规范 v2.1 §4-1..3）。
 * 全部 mkdtemp 隔离工程；不消费外部凭证，不声称真实生图。
 */

let fixture: StudioP7Fixture | undefined;

afterEach(async () => {
  await fixture?.cleanup();
  fixture = undefined;
});

async function registeredPair() {
  fixture = await createStudioP7Fixture();
  await seedStudioP7ResolvedContinuity(fixture);
  const panel = fixture.units.sixPanel.panels[0]!;
  const media = fixture.panelMediaPairs.find((entry) => entry.panelId === panel.id)!;
  const persisted = await freezeAndPersistStudioGenerationPack(fixture.root, {
    unitId: fixture.units.sixPanel.unit.id,
    panelId: panel.id,
  });
  const generationRunId = "p22-annotations-run-001";
  await dispatchStudioGenerationPack(fixture.root, {
    packId: persisted.packId,
    packFingerprint: persisted.fingerprint,
    generationRunId,
    provider: "codex",
  });
  const raw = await registerStudioGenerationResult(fixture.root, {
    packId: persisted.packId,
    packFingerprint: persisted.fingerprint,
    generationRunId,
    variant: "raw",
    mediaSha256: media.raw.imported.sha256,
  });
  const labeled = await registerStudioGenerationResult(fixture.root, {
    packId: persisted.packId,
    packFingerprint: persisted.fingerprint,
    generationRunId,
    variant: "labeled",
    mediaSha256: media.labeled.imported.sha256,
  });
  return { panel, persisted, generationRunId, raw, labeled };
}

function reviewInput(
  pair: Awaited<ReturnType<typeof registeredPair>>,
  overrides: Partial<SubmitStudioGenerationReviewInput> & Pick<SubmitStudioGenerationReviewInput, "operationId">,
): SubmitStudioGenerationReviewInput {
  return {
    generationRunId: pair.generationRunId,
    kind: "observation",
    expectedHeadRevision: 0,
    rawResultId: pair.raw.resultId,
    rawSha256: pair.raw.mediaSha256,
    labeledResultId: pair.labeled.resultId,
    labeledSha256: pair.labeled.mediaSha256,
    expectedPackFingerprint: pair.persisted.fingerprint,
    continuityFingerprint: pair.persisted.pack.continuity.fingerprint,
    decision: "rework",
    criteria: [{ code: "face", status: "fail", note: "脸型不一致" }],
    reviewer: "user",
    note: "批注测试",
    ...overrides,
  };
}

function annotation(overrides: Partial<StudioGenerationReviewAnnotationInput> & Pick<StudioGenerationReviewAnnotationInput, "id">): StudioGenerationReviewAnnotationInput {
  return {
    kind: "rect",
    category: "face",
    x: 0.1,
    y: 0.1,
    width: 0.2,
    height: 0.3,
    note: "区域批注",
    ...overrides,
  };
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([key, entry]) => [key, stableValue(entry)]));
}

describe("P22 §4-1 批注 v2 校验", () => {
  it("rect/point/七类 category 合法；互转/越界/超量/非法 category/缺 id/重复 id 全部拒绝", async () => {
    const pair = await registeredPair();
    const accepted = await submitStudioGenerationReview(fixture!.root, reviewInput(pair, {
      operationId: "p22-ann-accept-001",
      annotations: [
        annotation({ id: "ann-rect-0001", kind: "rect", category: "face" }),
        annotation({ id: "ann-point-0001", kind: "point", category: "golden-mask", x: 0.5, y: 0.5, width: 0, height: 0 }),
        annotation({ id: "ann-nocat-0001", kind: "rect", category: undefined }),
      ],
    }));
    expect(accepted.annotations).toHaveLength(3);
    expect(accepted.annotations[0]).toMatchObject({ id: "ann-rect-0001", kind: "rect", category: "face", x: 0.1, y: 0.1, width: 0.2, height: 0.3 });
    expect(accepted.annotations[1]).toMatchObject({ id: "ann-point-0001", kind: "point", category: "golden-mask", width: 0, height: 0 });
    expect(accepted.annotations[2]).toMatchObject({ id: "ann-nocat-0001", kind: "rect" });
    expect(accepted.annotations[2]!.category).toBeUndefined();

    await expect(submitStudioGenerationReview(fixture!.root, reviewInput(pair, {
      operationId: "p22-ann-reject-rect-zero",
      annotations: [annotation({ id: "ann-bad-0001", kind: "rect", width: 0 })],
    }))).rejects.toMatchObject({ code: "invalid-input" });
    await expect(submitStudioGenerationReview(fixture!.root, reviewInput(pair, {
      operationId: "p22-ann-reject-point-area",
      annotations: [annotation({ id: "ann-bad-0002", kind: "point", width: 0.1 })],
    }))).rejects.toMatchObject({ code: "invalid-input" });
    await expect(submitStudioGenerationReview(fixture!.root, reviewInput(pair, {
      operationId: "p22-ann-reject-oob",
      annotations: [annotation({ id: "ann-bad-0003", x: 0.9, width: 0.2 })],
    }))).rejects.toMatchObject({ code: "invalid-input" });
    await expect(submitStudioGenerationReview(fixture!.root, reviewInput(pair, {
      operationId: "p22-ann-reject-cat",
      annotations: [annotation({ id: "ann-bad-0004", category: "background" as never })],
    }))).rejects.toMatchObject({ code: "invalid-input" });
    await expect(submitStudioGenerationReview(fixture!.root, reviewInput(pair, {
      operationId: "p22-ann-reject-noid",
      annotations: [{ x: 0.1, y: 0.1, width: 0.2, height: 0.2, note: "旧形状" } as never],
    }))).rejects.toMatchObject({ code: "invalid-input" });
    await expect(submitStudioGenerationReview(fixture!.root, reviewInput(pair, {
      operationId: "p22-ann-reject-dup",
      annotations: [annotation({ id: "ann-dup-0001" }), annotation({ id: "ann-dup-0001", x: 0.3 })],
    }))).rejects.toMatchObject({ code: "invalid-input" });
    await expect(submitStudioGenerationReview(fixture!.root, reviewInput(pair, {
      operationId: "p22-ann-reject-many",
      annotations: Array.from({ length: 101 }, (_, index) => annotation({ id: `ann-m-${index}` })),
    }))).rejects.toMatchObject({ code: "invalid-input" });
    // R1 F2/R2 F3：Core 钉死 ann- 小写格式（非 ann- 前缀/大写均拒绝）。
    await expect(submitStudioGenerationReview(fixture!.root, reviewInput(pair, {
      operationId: "p22-ann-reject-idformat",
      annotations: [annotation({ id: "FooBar" })],
    }))).rejects.toMatchObject({ code: "invalid-input" });
    await expect(submitStudioGenerationReview(fixture!.root, reviewInput(pair, {
      operationId: "p22-ann-reject-idprefix",
      annotations: [annotation({ id: "xyz-0001" })],
    }))).rejects.toMatchObject({ code: "invalid-input" });
  });
});

describe("P22 §4-2/3 提交链与删除修正", () => {
  it("Review 必须绑定该 run 真实 raw/labeled resultId，伪造 ID 不得推进 Head", async () => {
    const pair = await registeredPair();
    await expect(submitStudioGenerationReview(fixture!.root, reviewInput(pair, {
      operationId: "p22-ann-fake-raw-result-id",
      rawResultId: "studio-generation-result-fake-raw",
    }))).rejects.toMatchObject({ code: "result-pair-invalid" });
    await expect(submitStudioGenerationReview(fixture!.root, reviewInput(pair, {
      operationId: "p22-ann-fake-labeled-result-id",
      labeledResultId: "studio-generation-result-fake-labeled",
    }))).rejects.toMatchObject({ code: "result-pair-invalid" });
    expect(await listStudioGenerationReviewHistory(fixture!.root, {
      generationRunId: pair.generationRunId,
      limit: 10,
    })).toEqual({ items: [] });
    expect((await getStudioGenerationReviewControl(
      fixture!.root,
      pair.generationRunId,
    )).headRevision).toBe(0);
  });

  it("批注原样写回（Core 不改写）；correction 移除批注后 Head 推进且集合正确；过期 expectedHeadRevision 拒绝", async () => {
    const pair = await registeredPair();
    const base = await submitStudioGenerationReview(fixture!.root, reviewInput(pair, {
      operationId: "p22-ann-chain-001",
      annotations: [
        annotation({ id: "ann-keep-0001", kind: "rect", category: "face", note: "保留" }),
        annotation({ id: "ann-drop-0001", kind: "point", category: "hair", x: 0.4, y: 0.4, width: 0, height: 0, note: "待移除" }),
      ],
    }));
    expect(base.annotations.map((ann) => ann.id)).toEqual(["ann-keep-0001", "ann-drop-0001"]);

    const correction = await submitStudioGenerationReview(fixture!.root, reviewInput(pair, {
      operationId: "p22-ann-chain-002",
      kind: "correction",
      expectedHeadRevision: 1,
      supersedesReviewId: base.reviewId,
      annotations: [annotation({ id: "ann-keep-0001", kind: "rect", category: "face", note: "保留" })],
      note: "移除批注 ann-drop-0001：待移除",
    }));
    expect(correction.annotations).toHaveLength(1);
    expect(correction.annotations[0]).toMatchObject({ id: "ann-keep-0001", kind: "rect", category: "face", note: "保留" });

    const control = await listStudioGenerationReviewHistory(fixture!.root, { generationRunId: pair.generationRunId, limit: 10 });
    const head = control.items.find((item) => item.head);
    expect(head?.reviewId).toBe(correction.reviewId);
    expect(head?.annotations).toHaveLength(1);
    expect(head?.note).toContain("移除批注 ann-drop-0001");
    const older = control.items.find((item) => item.reviewId === base.reviewId);
    expect(older?.annotations).toHaveLength(2);
    expect(older?.head).toBe(false);

    await expect(submitStudioGenerationReview(fixture!.root, reviewInput(pair, {
      operationId: "p22-ann-chain-003",
      kind: "correction",
      expectedHeadRevision: 1,
      supersedesReviewId: correction.reviewId,
      annotations: [],
      note: "过期 CAS",
    }))).rejects.toMatchObject({ code: "review-conflict" });

    // §4-3 明示：伪造"删除不存在 id"无法被识别为删除——仅以普通 correction 入账，不破坏不可变性。
    const forged = await submitStudioGenerationReview(fixture!.root, reviewInput(pair, {
      operationId: "p22-ann-chain-004",
      kind: "correction",
      expectedHeadRevision: 2,
      supersedesReviewId: correction.reviewId,
      annotations: [],
      note: "移除批注 ann-not-exists-0001：伪造删除",
    }));
    expect(forged.annotations).toEqual([]);
    const after = await listStudioGenerationReviewHistory(fixture!.root, { generationRunId: pair.generationRunId, limit: 10 });
    expect(after.items.find((item) => item.head)?.reviewId).toBe(forged.reviewId);
    // 旧事件完整不可变：base 的两条批注仍在历史行内。
    expect(after.items.find((item) => item.reviewId === base.reviewId)?.annotations).toHaveLength(2);
  });

  it("P22 前旧形状批注行只读兼容（id/kind/category 缺省可解析，不回写新字段）", async () => {
    const pair = await registeredPair();
    const modern = await submitStudioGenerationReview(fixture!.root, reviewInput(pair, {
      operationId: "p22-ann-legacy-001",
      annotations: [annotation({ id: "ann-modern-0001" })],
    }));
    // 用真实事件语义换旧形状批注并重算内容地址，模拟 P22 前行（镜像现代行全部语义，仅换批注）。
    const legacyAnnotations = [{ x: 0.2, y: 0.2, width: 0.3, height: 0.3, note: "旧形状批注" }];
    const semantic = {
      schemaVersion: 1,
      kind: "studio-generation-review",
      generationRunId: modern.generationRunId,
      reviewKind: modern.kind,
      baseHeadRevision: modern.baseHeadRevision,
      ...(modern.headRevision === undefined ? {} : { headRevision: modern.headRevision }),
      ...(modern.supersedesReviewId ? { supersedesReviewId: modern.supersedesReviewId } : {}),
      rawResultId: modern.rawResultId,
      rawSha256: modern.rawSha256,
      labeledResultId: modern.labeledResultId,
      labeledSha256: modern.labeledSha256,
      packId: modern.packId,
      packFingerprint: modern.packFingerprint,
      continuityFingerprint: modern.continuityFingerprint,
      decision: modern.decision,
      criteria: modern.criteria,
      annotations: legacyAnnotations,
      reviewer: modern.reviewer,
      note: modern.note,
      currentAtSubmission: modern.currentAtSubmission,
      advancesHead: modern.advancesHead,
      staleReasons: modern.staleReasons,
    };
    const fingerprint = createHash("sha256").update(JSON.stringify(stableValue(semantic)), "utf8").digest("hex");
    const legacyReviewId = `studio-generation-review-${fingerprint.slice(0, 40)}`;
    const databasePath = path.join(fixture!.root, ".aicanvas", "studio-generation-ledger.sqlite");
    const db = new DatabaseSync(databasePath);
    db.prepare(`
      INSERT INTO studio_generation_review_events(
        review_id, generation_run_id, review_kind, base_head_revision, head_revision, supersedes_review_id,
        raw_result_id, raw_sha256, labeled_result_id, labeled_sha256, pack_id, pack_fingerprint,
        continuity_fingerprint, decision, criteria_json, annotations_json, reviewer, note,
        current_at_submission, advances_head, stale_reasons_json, fingerprint, created_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      legacyReviewId,
      modern.generationRunId,
      modern.kind,
      modern.baseHeadRevision,
      modern.headRevision ?? null,
      modern.supersedesReviewId ?? null,
      modern.rawResultId,
      modern.rawSha256,
      modern.labeledResultId,
      modern.labeledSha256,
      modern.packId,
      modern.packFingerprint,
      modern.continuityFingerprint,
      modern.decision,
      JSON.stringify(modern.criteria),
      JSON.stringify(legacyAnnotations),
      modern.reviewer,
      modern.note,
      modern.currentAtSubmission ? 1 : 0,
      modern.advancesHead ? 1 : 0,
      JSON.stringify(modern.staleReasons),
      fingerprint,
      new Date().toISOString(),
    );
    db.close();

    const history = await listStudioGenerationReviewHistory(fixture!.root, { generationRunId: pair.generationRunId, limit: 10 });
    const legacy = history.items.find((item) => item.reviewId === legacyReviewId);
    expect(legacy).toBeDefined();
    expect(legacy!.annotations).toHaveLength(1);
    expect(legacy!.annotations[0]).toMatchObject({ x: 0.2, y: 0.2, width: 0.3, height: 0.3, note: "旧形状批注" });
    expect(legacy!.annotations[0]!.id).toBeUndefined();
    expect(legacy!.annotations[0]!.kind).toBeUndefined();
    expect(legacy!.annotations[0]!.category).toBeUndefined();
  });
});

describe("P22 §4-6 规模", () => {
  it("100 条批注提交与读回不卡（集合完整、逐条改写为零）", async () => {
    const pair = await registeredPair();
    const annotations = Array.from({ length: 100 }, (_, index) => annotation({
      id: `ann-scale-${String(index).padStart(3, "0")}`,
      kind: index % 2 === 0 ? "rect" : "point",
      category: (["face", "hair", "costume", "marking", "golden-mask", "scene", "prop"] as const)[index % 7],
      x: (index % 10) / 10,
      y: Math.floor(index / 10) / 10,
      width: index % 2 === 0 ? 0.05 : 0,
      height: index % 2 === 0 ? 0.05 : 0,
      note: `规模批注 ${index}`,
    }));
    const startedAt = Date.now();
    const accepted = await submitStudioGenerationReview(fixture!.root, reviewInput(pair, {
      operationId: "p22-ann-scale-001",
      annotations,
    }));
    const elapsedMs = Date.now() - startedAt;
    expect(accepted.annotations).toHaveLength(100);
    expect(new Set(accepted.annotations.map((ann) => ann.id)).size).toBe(100);
    expect(accepted.annotations[99]).toMatchObject({ id: "ann-scale-099", kind: "point", width: 0, height: 0 });
    // 逐条改写为零：100 条输入与存储逐字段一致。
    for (const [index, stored] of accepted.annotations.entries()) {
      expect(stored).toMatchObject({
        id: `ann-scale-${String(index).padStart(3, "0")}`,
        kind: index % 2 === 0 ? "rect" : "point",
        x: (index % 10) / 10,
        y: Math.floor(index / 10) / 10,
        note: `规模批注 ${index}`,
      });
    }
    const history = await listStudioGenerationReviewHistory(fixture!.root, { generationRunId: pair.generationRunId, limit: 10 });
    expect(history.items[0]?.annotations).toHaveLength(100);
    // 渲染节点数有界由 UI 合同（overlay 以集合渲染、无 per-annotation DOM 组件实例化）保证；此处记录提交耗时上限。
    expect(elapsedMs).toBeLessThan(5_000);
  }, 60_000);
});
