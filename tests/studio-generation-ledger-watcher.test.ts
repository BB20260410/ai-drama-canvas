import { afterEach, describe, expect, it } from "vitest";
import {
  createStudioGenerationPlan,
  dispatchStudioGenerationPack,
  freezeAndPersistStudioGenerationPack,
  getStudioGenerationLedgerState,
  registerStudioGenerationResult,
} from "../src/core/studio-generation-ledger.js";
import { submitStudioGenerationReview } from "../src/core/studio-generation-review.js";
import { createStudioGenerationLedgerWatcher } from "../src/main/studio-generation-ledger-watcher.js";
import { createStudioP7Fixture, seedStudioP7ResolvedPanelContinuity, type StudioP7Fixture } from "./helpers/studio-p7-fixture.js";

/**
 * P21 §4-10 ledger watcher 行为测试（R3-F1 回归：ignored 误杀根目录使 watcher 永不触发）。
 * 全部 mkdtemp 隔离工程；不消费外部凭证。
 */

const fixtures: StudioP7Fixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("P21 §4-10 ledger watcher", () => {
  it("close 会使仍在等待 projectId 的旧计算失效，禁止关闭后迟到发送", async () => {
    const fixture = await createStudioP7Fixture();
    fixtures.push(fixture);
    const sent: Array<{ projectId: string; projectionHash: string }> = [];
    let releaseProjectId!: (projectId: string) => void;
    const projectId = new Promise<string>((resolve) => { releaseProjectId = resolve; });
    const handle = createStudioGenerationLedgerWatcher({
      projectRoot: fixture.root,
      resolveProjectId: () => projectId,
      send: (payload) => { sent.push(payload); },
      debounceMs: 10,
    });
    const pending = handle.emitNow();
    await handle.close();
    releaseProjectId(fixture.shell.project.id);
    await pending;
    expect(sent).toEqual([]);
  });

  it("写 sqlite/-wal 触发有界失效信号；无关文件不触发；哈希去重；emitNow 快路径；close 后静默", async () => {
    const fixture = await createStudioP7Fixture();
    fixtures.push(fixture);
    const sent: Array<{ projectId: string; projectionHash: string }> = [];
    const handle = createStudioGenerationLedgerWatcher({
      projectRoot: fixture.root,
      resolveProjectId: async () => fixture.shell.project.id,
      send: (payload) => { sent.push(payload); },
      debounceMs: 30,
    });
    try {
      await sleep(200);
      // 无关文件不触发（若根目录被 ignored 误杀，则后续任何写都收不到——本测试随之变红）。
      const { writeFile } = await import("node:fs/promises");
      await writeFile(`${fixture.root}/.aicanvas/unrelated-p21-watcher.json`, "{}");
      await sleep(200);
      expect(sent).toHaveLength(0);

      // 首个真实账本变化（冻结 pack）→ 首个信号。
      const unit = fixture.units.twoPanel;
      const panel = unit.panels[0]!;
      await seedStudioP7ResolvedPanelContinuity(fixture.root, {
        unitId: unit.unit.id,
        panelId: panel.id,
        assetIds: panel.assets.filter((asset) => asset.presence !== "forbidden").map((asset) => asset.assetId),
      });
      const frozen = await freezeAndPersistStudioGenerationPack(fixture.root, {
        unitId: unit.unit.id,
        panelId: panel.id,
      });
      await sleep(400);
      expect(sent.length).toBeGreaterThanOrEqual(1);
      expect(sent[0]).toMatchObject({
        projectId: fixture.shell.project.id,
        projectionHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      });
      const baseline = sent.length;

      // 无投影变化的触碰（空追加 -wal）→ 哈希去重不连发。
      const { appendFile } = await import("node:fs/promises");
      await appendFile(`${fixture.root}/.aicanvas/studio-generation-ledger.sqlite-wal`, "");
      await sleep(300);
      expect(sent.length).toBe(baseline);

      // 真实账本变化（建 plan）→ 投影哈希变化 → 新信号。
      const plan = await createStudioGenerationPlan(fixture.root, {
        nodes: [{ unitId: unit.unit.id, panelId: panel.id }],
        sourceCommandRequestId: "p21-watcher-test-plan",
      });
      await sleep(400);
      expect(sent.length).toBeGreaterThan(baseline);
      expect(sent[sent.length - 1]!.projectionHash).not.toBe(sent[0]!.projectionHash);

      // emitNow 快路径：哈希未变时不重复发送；变化后立即可达。
      const beforeEmitNow = sent.length;
      await handle.emitNow();
      expect(sent.length).toBe(beforeEmitNow);

      // raw/labeled 登记后 plan 已 succeeded；后续 Review PASS 必须仍产生第二次
      // 失效身份，否则 Canvas 永远看不到新正式 raw 与冻结参考投影。
      const generationRunId = `${plan.planId}:node:1:attempt:1`;
      await dispatchStudioGenerationPack(fixture.root, {
        packId: frozen.packId,
        packFingerprint: frozen.fingerprint,
        generationRunId,
        provider: "codex",
      });
      const media = fixture.panelMediaPairs.find((entry) => entry.panelId === panel.id)!;
      const raw = await registerStudioGenerationResult(fixture.root, {
        packId: frozen.packId,
        packFingerprint: frozen.fingerprint,
        generationRunId,
        variant: "raw",
        mediaSha256: media.raw.imported.sha256,
        provider: "codex",
      });
      const labeled = await registerStudioGenerationResult(fixture.root, {
        packId: frozen.packId,
        packFingerprint: frozen.fingerprint,
        generationRunId,
        variant: "labeled",
        mediaSha256: media.labeled.imported.sha256,
        provider: "codex",
      });
      await sleep(400);
      const beforeReview = sent.length;
      await submitStudioGenerationReview(fixture.root, {
        operationId: "p21-watcher-review-pass",
        generationRunId,
        kind: "observation",
        expectedHeadRevision: 0,
        rawResultId: raw.resultId,
        rawSha256: raw.mediaSha256,
        labeledResultId: labeled.resultId,
        labeledSha256: labeled.mediaSha256,
        expectedPackFingerprint: frozen.fingerprint,
        continuityFingerprint: frozen.pack.continuity.fingerprint,
        decision: "pass",
        criteria: [{ code: "original-size-visual-qc", status: "pass", note: "fixture PASS。" }],
        reviewer: "p21-watcher-test",
        note: "Review Head 变化必须使动态 Canvas 投影失效。",
      });
      await sleep(400);
      expect(sent.length).toBeGreaterThan(beforeReview);

      // close 后静默。
      const beforeClose = sent.length;
      await handle.close();
      await appendFile(`${fixture.root}/.aicanvas/studio-generation-ledger.sqlite-wal`, "x");
      await sleep(250);
      expect(sent.length).toBe(beforeClose);
    } finally {
      await handle.close();
    }
  }, 60_000);
});
