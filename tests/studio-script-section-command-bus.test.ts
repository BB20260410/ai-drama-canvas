import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  executeIdempotentCommand,
  listCommandLedger,
  reconcileCommand,
  type StudioCommandRequest,
} from "../src/core/command-bus.js";
import { createManagedProject } from "../src/core/managed-project.js";

const roots: string[] = [];

afterEach(async () => {
  delete process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function managedRoot(): Promise<string> {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "studio-script-section-command-")));
  roots.push(parent);
  return (await createManagedProject({ parentRoot: parent, name: "Studio 章节修订命令" })).paths.root;
}

function envelope(index: number, request: StudioCommandRequest) {
  return {
    requestId: `studio-section-request-${String(index).padStart(4, "0")}`,
    idempotencyKey: `studio-section-key-${String(index).padStart(4, "0")}`,
    request,
  };
}

describe("Studio 剧本章节修订命令总线", () => {
  it("严格限定公开 payload，保留语义幂等并将 Head CAS 冲突记为明确未落地", async () => {
    const root = await managedRoot();
    const body = "序章😀：阿航踏入石室。\n第二场：黄金面具发出微光。";

    await executeIdempotentCommand(root, envelope(1, {
      command: "create_studio_script_document",
      payload: { id: "script-ep01", title: "EP01", expectedRevision: 0 },
    }));
    const appended = await executeIdempotentCommand(root, envelope(2, {
      command: "append_studio_script_revision",
      payload: {
        documentId: "script-ep01",
        expectedRevision: 0,
        body,
        source: "command-test",
        sourceVersion: "v1",
      },
    }));
    const scriptRevision = (appended.result as {
      revision: { id: string; bodySha256: string };
    }).revision;
    const firstLineEnd = body.indexOf("\n");
    const firstPayload = {
      sectionId: "chapter-ep01-01",
      expectedRevision: 0,
      kind: "chapter" as const,
      title: "第一章",
      scriptRevisionId: scriptRevision.id,
      scriptSha256: scriptRevision.bodySha256,
      startOffsetUtf16: 0,
      endOffsetUtf16: firstLineEnd,
    };
    const firstInput = envelope(3, {
      command: "append_studio_script_section_revision",
      payload: firstPayload,
    });

    const first = await executeIdempotentCommand(root, firstInput);
    expect(first).toMatchObject({
      status: "succeeded",
      replayed: false,
      result: {
        sectionId: "chapter-ep01-01",
        revision: 1,
        kind: "chapter",
        title: "第一章",
        scriptRevisionId: scriptRevision.id,
        scriptSha256: scriptRevision.bodySha256,
        startOffsetUtf16: 0,
        endOffsetUtf16: firstLineEnd,
      },
    });
    const firstSection = first.result as { id: string; fingerprint: string; surfaceSha256: string };
    expect(firstSection.id).toMatch(/^script-section-[a-f0-9]{40}$/u);
    expect(firstSection.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(firstSection.surfaceSha256).toMatch(/^[a-f0-9]{64}$/u);

    const ledgerReplay = await executeIdempotentCommand(root, {
      ...firstInput,
      requestId: "studio-section-request-replay-0003",
    });
    expect(ledgerReplay).toMatchObject({ replayed: true, result: { id: firstSection.id, revision: 1 } });

    const semanticRetry = await executeIdempotentCommand(root, envelope(4, {
      command: "append_studio_script_section_revision",
      payload: firstPayload,
    }));
    expect(semanticRetry).toMatchObject({ replayed: false, result: { id: firstSection.id, revision: 1 } });

    const second = await executeIdempotentCommand(root, envelope(5, {
      command: "append_studio_script_section_revision",
      payload: {
        ...firstPayload,
        expectedRevision: 1,
        title: "第一章（扩展）",
        endOffsetUtf16: body.length,
      },
    }));
    const secondSection = second.result as { id: string; revision: number };
    expect(secondSection).toMatchObject({ revision: 2 });
    expect(secondSection.id).not.toBe(firstSection.id);

    const lineageInput = envelope(9, {
      command: "append_studio_script_section_revision",
      payload: {
        ...firstPayload,
        expectedRevision: 2,
        kind: "scene",
        title: "禁止把章节改为场景",
      },
    });
    await expect(executeIdempotentCommand(root, lineageInput)).rejects.toMatchObject({
      name: "RejectedCommandFailure",
      result: {
        schemaVersion: 1,
        applied: false,
        entityType: "studio_script_section",
        sectionId: "chapter-ep01-01",
        reason: "lineage_conflict",
        invariant: "kind",
        expectedValue: "chapter",
        actualValue: "scene",
      },
    });

    const staleInput = envelope(6, {
      command: "append_studio_script_section_revision",
      payload: {
        ...firstPayload,
        expectedRevision: 1,
        title: "第一章（过期窗口）",
      },
    });
    await expect(executeIdempotentCommand(root, staleInput)).rejects.toMatchObject({
      name: "RejectedCommandFailure",
      result: {
        schemaVersion: 1,
        applied: false,
        entityType: "studio_script_section",
        sectionId: "chapter-ep01-01",
        reason: "revision_conflict",
        expectedRevision: 1,
        currentRevision: 2,
      },
    });

    await expect(executeIdempotentCommand(root, {
      requestId: "studio-section-request-strict-0007",
      idempotencyKey: "studio-section-key-strict-0007",
      request: {
        command: "append_studio_script_section_revision",
        payload: { ...firstPayload, expectedRevision: 2, body: "不允许注入原文" },
      } as unknown as StudioCommandRequest,
    })).rejects.toThrow(/载荷不符合合同.*body/u);
    const missingTitlePayload: Record<string, unknown> = { ...firstPayload, expectedRevision: 2 };
    delete missingTitlePayload.title;
    await expect(executeIdempotentCommand(root, {
      requestId: "studio-section-request-missing-0008",
      idempotencyKey: "studio-section-key-missing-0008",
      request: {
        command: "append_studio_script_section_revision",
        payload: missingTitlePayload,
      } as unknown as StudioCommandRequest,
    })).rejects.toThrow(/载荷不符合合同.*title/u);

    const ledger = await listCommandLedger(root);
    expect(ledger).toHaveLength(7);
    expect(ledger.find((entry) => entry.idempotencyKey === lineageInput.idempotencyKey)).toMatchObject({
      status: "failed",
      result: { applied: false, reason: "lineage_conflict", invariant: "kind" },
    });
    expect(ledger.find((entry) => entry.idempotencyKey === staleInput.idempotencyKey)).toMatchObject({
      status: "failed",
      result: { applied: false, reason: "revision_conflict", currentRevision: 2 },
    });
    expect(ledger.some((entry) => entry.idempotencyKey === "studio-section-key-strict-0007")).toBe(false);
    expect(ledger.some((entry) => entry.idempotencyKey === "studio-section-key-missing-0008")).toBe(false);

    const db = new DatabaseSync(path.join(root, ".aicanvas", "studio-production.sqlite"));
    try {
      expect(db.prepare("SELECT COUNT(*) AS count FROM studio_script_section_revisions WHERE section_id = ?")
        .get("chapter-ep01-01")).toMatchObject({ count: 2 });
      expect(db.prepare("SELECT revision, revision_id FROM studio_script_section_heads WHERE section_id = ?")
        .get("chapter-ep01-01")).toMatchObject({ revision: 2, revision_id: secondSection.id });
      expect(() => db.prepare("UPDATE studio_script_section_revisions SET title = title WHERE id = ?")
        .run(firstSection.id)).toThrow(/append-only/u);
    } finally {
      db.close();
    }
  });

  it("append 在业务提交后崩溃时只读 immutable section revision 对账，重启恢复不重复追加", async () => {
    const root = await managedRoot();
    const body = "第一章：阿航抵达石门。";
    await executeIdempotentCommand(root, envelope(20, {
      command: "create_studio_script_document",
      payload: { id: "script-section-recovery", title: "恢复剧本", expectedRevision: 0 },
    }));
    const appended = await executeIdempotentCommand(root, envelope(21, {
      command: "append_studio_script_revision",
      payload: {
        documentId: "script-section-recovery",
        expectedRevision: 0,
        body,
        source: "command-recovery-test",
        sourceVersion: "v1",
      },
    }));
    const scriptRevision = (appended.result as { revision: { id: string; bodySha256: string } }).revision;
    const request = envelope(22, {
      command: "append_studio_script_section_revision",
      payload: {
        sectionId: "chapter-recovery-01",
        expectedRevision: 0,
        kind: "chapter",
        title: "第一章",
        scriptRevisionId: scriptRevision.id,
        scriptSha256: scriptRevision.bodySha256,
        startOffsetUtf16: 0,
        endOffsetUtf16: body.length,
      },
    });

    process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE = request.request.command;
    try {
      await expect(executeIdempotentCommand(root, request)).rejects.toThrow("执行结果未确认");
    } finally {
      delete process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE;
    }
    expect((await listCommandLedger(root)).find((entry) => entry.idempotencyKey === request.idempotencyKey))
      .toMatchObject({
        status: "unknown",
        durableReconciliation: { schemaVersion: 1, request: request.request },
      });

    const recovered = await reconcileCommand(root, { idempotencyKey: request.idempotencyKey });
    expect(recovered).toMatchObject({
      status: "succeeded",
      replayed: true,
      result: {
        sectionId: "chapter-recovery-01",
        revision: 1,
        kind: "chapter",
        reconciled: true,
      },
    });
    const recoveredSection = recovered.result as { id: string };
    const replay = await executeIdempotentCommand(root, {
      ...request,
      requestId: "studio-section-request-recovery-replay",
    });
    expect(replay).toMatchObject({
      status: "succeeded",
      replayed: true,
      result: { id: recoveredSection.id, reconciled: true },
    });

    const db = new DatabaseSync(path.join(root, ".aicanvas", "studio-production.sqlite"));
    try {
      expect(db.prepare("SELECT COUNT(*) AS count FROM studio_script_section_revisions WHERE section_id = ?")
        .get("chapter-recovery-01")).toMatchObject({ count: 1 });
      expect(db.prepare("SELECT revision, revision_id FROM studio_script_section_heads WHERE section_id = ?")
        .get("chapter-recovery-01")).toMatchObject({ revision: 1, revision_id: recoveredSection.id });
    } finally {
      db.close();
    }
  });
});
