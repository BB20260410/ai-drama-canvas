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
