import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  executeIdempotentCommand,
  listCommandLedger,
  reconcileCommand,
} from "../src/core/command-bus.js";
import { listStudioMultimediaTimelineBindingHistory } from "../src/core/studio-multimedia-timeline.js";
import { getStudioProductionUnitSnapshot } from "../src/core/studio-production.js";
import {
  createUnitGridFixtureProject,
  createUnitGridTestImage,
} from "./helpers/studio-unit-grid-fixture.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  delete process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE;
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("四媒体时间线 attach 命令的崩溃恢复", () => {
  it("生产单元纯时长校验失败明确落 failed，不污染 unknown", async () => {
    const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "studio-unit-command-rejected-")));
    temporaryRoots.push(parent);
    const fixture = await createUnitGridFixtureProject(parent, {
      unitId: "studio-unit-command-rejected-001",
      season: "S09",
      episode: "EP01",
    });
    const snapshot = await getStudioProductionUnitSnapshot(fixture.root, fixture.unitId);
    if (!snapshot) throw new Error("缺少测试单元快照。");
    const input = {
      requestId: "studio-unit-command-request-rejected-0001",
      idempotencyKey: "studio-unit-command-key-rejected-0001",
      request: {
        command: "revise_studio_production_unit" as const,
        payload: {
          unitId: snapshot.unit.id,
          expectedRevision: snapshot.unit.revision,
          season: snapshot.unit.season,
          episode: snapshot.unit.episode,
          sequence: snapshot.unit.sequence,
          title: snapshot.unit.title,
          durationSeconds: 5,
          scriptRevisionId: snapshot.scriptRevision.id,
          panels: snapshot.panels.map((panel) => ({
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
            sourceSpans: panel.sourceSpans.map((span) => ({
              startOffsetUtf16: span.startOffsetUtf16,
              endOffsetUtf16: span.endOffsetUtf16,
            })),
            assets: panel.assets.map((asset) => ({
              assetId: asset.assetId,
              category: asset.category,
              presence: asset.presence,
              role: asset.role,
              continuityState: asset.continuityState,
              evidence: asset.evidence.map((item) => ({
                kind: item.kind,
                reference: item.reference,
                note: item.note,
              })),
            })),
            transition: panel.transition,
            costumeState: panel.costumeState,
            sceneLighting: panel.sceneLighting,
            shotType: panel.shotType,
            negativePrompt: panel.negativePrompt,
          })),
        },
      },
    };

    await expect(executeIdempotentCommand(fixture.root, input)).rejects.toThrow(
      "生产单元宫格总时长必须严格等于声明时长 5 秒",
    );
    expect((await listCommandLedger(fixture.root)).find((entry) => entry.idempotencyKey === input.idempotencyKey))
      .toMatchObject({
        status: "failed",
        result: { applied: false, entityType: "studio_production_unit", reason: "validation_failed" },
      });
    expect((await getStudioProductionUnitSnapshot(fixture.root, fixture.unitId))?.unit.revision)
      .toBe(snapshot.unit.revision);
  });

  it("storyboard 缺少 panelIndex 时明确失败，不留下 unknown", async () => {
    const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "studio-multimedia-command-rejected-")));
    temporaryRoots.push(parent);
    const fixture = await createUnitGridFixtureProject(parent, {
      unitId: "timeline-command-unit-rejected-001",
      season: "S09",
      episode: "EP01",
    });
    const snapshot = await getStudioProductionUnitSnapshot(fixture.root, fixture.unitId);
    if (!snapshot) throw new Error("缺少测试单元快照。");
    const media = await createUnitGridTestImage(fixture.root, "timeline-command-rejected-storyboard", "#365b71");
    const input = {
      requestId: "timeline-command-request-rejected-0001",
      idempotencyKey: "timeline-command-key-rejected-0001",
      request: {
        command: "attach_studio_multimedia_timeline_media" as const,
        payload: {
          unitId: fixture.unitId,
          unitRevision: snapshot.unit.revision,
          expectedUnitFingerprint: snapshot.fingerprint,
          slotId: "storyboard-missing-panel",
          expectedHeadRevision: 0,
          startSeconds: 0,
          endSeconds: 15,
          role: "storyboard" as const,
          mediaSha256: media.sha256,
          note: "故意缺少 panelIndex 的失败样本。",
        },
      },
    };

    await expect(executeIdempotentCommand(fixture.root, input)).rejects.toThrow("storyboard 绑定必须显式提供 panelIndex");
    expect((await listCommandLedger(fixture.root)).find((entry) => entry.idempotencyKey === input.idempotencyKey))
      .toMatchObject({ status: "failed", error: { message: "storyboard 绑定必须显式提供 panelIndex。" } });
    expect(await listStudioMultimediaTimelineBindingHistory(fixture.root, {
      unitId: fixture.unitId,
      unitRevision: snapshot.unit.revision,
      slotId: input.request.payload.slotId,
    })).toHaveLength(0);
  });

  it("storyboard 时码越出目标 panel 时明确失败，不留下 unknown", async () => {
    const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "studio-multimedia-command-range-rejected-")));
    temporaryRoots.push(parent);
    const fixture = await createUnitGridFixtureProject(parent, {
      unitId: "timeline-command-unit-range-rejected-001",
      season: "S09",
      episode: "EP01",
    });
    const snapshot = await getStudioProductionUnitSnapshot(fixture.root, fixture.unitId);
    if (!snapshot) throw new Error("缺少测试单元快照。");
    const media = await createUnitGridTestImage(fixture.root, "timeline-command-range-rejected-storyboard", "#365b71");
    const input = {
      requestId: "timeline-command-request-range-rejected-0001",
      idempotencyKey: "timeline-command-key-range-rejected-0001",
      request: {
        command: "attach_studio_multimedia_timeline_media" as const,
        payload: {
          unitId: fixture.unitId,
          unitRevision: snapshot.unit.revision,
          expectedUnitFingerprint: snapshot.fingerprint,
          slotId: "storyboard-invalid-panel-range",
          expectedHeadRevision: 0,
          panelIndex: snapshot.panels[0]!.index,
          startSeconds: snapshot.panels[0]!.startSeconds,
          endSeconds: snapshot.panels[1]!.endSeconds,
          role: "storyboard" as const,
          mediaSha256: media.sha256,
          note: "故意越出第一格时间范围的失败样本。",
        },
      },
    };

    await expect(executeIdempotentCommand(fixture.root, input)).rejects.toThrow("媒体时码越出 panel");
    expect((await listCommandLedger(fixture.root)).find((entry) => entry.idempotencyKey === input.idempotencyKey))
      .toMatchObject({ status: "failed", error: { message: expect.stringContaining("媒体时码越出 panel") } });
    expect(await listStudioMultimediaTimelineBindingHistory(fixture.root, {
      unitId: fixture.unitId,
      unitRevision: snapshot.unit.revision,
      slotId: input.request.payload.slotId,
    })).toHaveLength(0);
  });

  it("成功、同键重放、业务提交后崩溃对账和参数不匹配均不重复绑定", async () => {
    const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "studio-multimedia-command-recovery-")));
    temporaryRoots.push(parent);
    const fixture = await createUnitGridFixtureProject(parent, {
      unitId: "timeline-command-unit-001",
      season: "S09",
      episode: "EP01",
    });
    const snapshot = await getStudioProductionUnitSnapshot(fixture.root, fixture.unitId);
    if (!snapshot) throw new Error("缺少测试单元快照。");
    const media = await createUnitGridTestImage(fixture.root, "timeline-command-storyboard", "#365b71");
    const payload = {
      unitId: fixture.unitId,
      unitRevision: snapshot.unit.revision,
      expectedUnitFingerprint: snapshot.fingerprint,
      slotId: "storyboard-panel-01",
      expectedHeadRevision: 0,
      panelIndex: 1,
      startSeconds: 0,
      endSeconds: 7,
      role: "storyboard" as const,
      mediaSha256: media.sha256,
      note: "真实 CAS 图片：第一格故事板。",
    };
    const first = {
      requestId: "timeline-command-request-0001",
      idempotencyKey: "timeline-command-key-0001",
      request: { command: "attach_studio_multimedia_timeline_media" as const, payload },
    };

    const created = await executeIdempotentCommand(fixture.root, first);
    expect(created).toMatchObject({ status: "succeeded", replayed: false, result: { binding: { revision: 1, mediaSha256: media.sha256 } } });
    const sameKeyReplay = await executeIdempotentCommand(fixture.root, {
      ...first,
      requestId: "timeline-command-request-0001-replay",
    });
    expect(sameKeyReplay).toMatchObject({ status: "succeeded", replayed: true });
    expect(await listStudioMultimediaTimelineBindingHistory(fixture.root, {
      unitId: fixture.unitId,
      unitRevision: snapshot.unit.revision,
      slotId: payload.slotId,
    })).toHaveLength(1);

    const crashed = {
      requestId: "timeline-command-request-0002",
      idempotencyKey: "timeline-command-key-0002",
      request: {
        command: "attach_studio_multimedia_timeline_media" as const,
        payload: { ...payload, slotId: "storyboard-panel-02", panelIndex: 2, startSeconds: 7, endSeconds: 15 },
      },
    };
    process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE = crashed.request.command;
    try {
      await expect(executeIdempotentCommand(fixture.root, crashed)).rejects.toThrow("执行结果未确认");
    } finally {
      delete process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE;
    }
    expect((await listCommandLedger(fixture.root)).find((entry) => entry.idempotencyKey === crashed.idempotencyKey))
      .toMatchObject({
        status: "unknown",
        durableReconciliation: { schemaVersion: 1, request: crashed.request },
      });
    expect(await listStudioMultimediaTimelineBindingHistory(fixture.root, {
      unitId: fixture.unitId,
      unitRevision: snapshot.unit.revision,
      slotId: crashed.request.payload.slotId,
    })).toHaveLength(1);

    const reconciled = await reconcileCommand(fixture.root, { idempotencyKey: crashed.idempotencyKey });
    expect(reconciled).toMatchObject({
      status: "succeeded",
      replayed: true,
      result: {
        replayed: true,
        reconciled: true,
        binding: { slotId: crashed.request.payload.slotId, revision: 1, mediaSha256: media.sha256 },
      },
    });
    const reconciledReplay = await executeIdempotentCommand(fixture.root, {
      ...crashed,
      requestId: "timeline-command-request-0002-replay",
    });
    expect(reconciledReplay).toMatchObject({ status: "succeeded", replayed: true });
    expect(await listStudioMultimediaTimelineBindingHistory(fixture.root, {
      unitId: fixture.unitId,
      unitRevision: snapshot.unit.revision,
      slotId: crashed.request.payload.slotId,
    })).toHaveLength(1);

    await expect(executeIdempotentCommand(fixture.root, {
      ...crashed,
      requestId: "timeline-command-request-0002-mismatch",
      request: {
        ...crashed.request,
        payload: { ...crashed.request.payload, note: "不允许替换已绑定收据。" },
      },
    })).rejects.toThrow("幂等键已用于不同参数");
    expect(await listStudioMultimediaTimelineBindingHistory(fixture.root, {
      unitId: fixture.unitId,
      unitRevision: snapshot.unit.revision,
      slotId: crashed.request.payload.slotId,
    })).toHaveLength(1);
  });
});
