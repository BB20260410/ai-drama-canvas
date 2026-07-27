import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import {
  executeIdempotentCommand,
  listCommandLedger,
  reconcileCommand,
  type StudioCommandRequest,
} from "../src/core/command-bus.js";
import { getStudioBindingControl } from "../src/core/studio-binding-control.js";
import { createManagedProject } from "../src/core/managed-project.js";

const roots: string[] = [];

afterEach(async () => {
  delete process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function envelope(index: number, request: StudioCommandRequest) {
  const suffix = String(index).padStart(4, "0");
  return {
    requestId: `studio-binding-request-${suffix}`,
    idempotencyKey: `studio-binding-key-${suffix}`,
    request,
  };
}

async function executeSetup(root: string, index: number, request: StudioCommandRequest) {
  const record = await executeIdempotentCommand(root, envelope(index, request));
  expect(record.status).toBe("succeeded");
  return record.result as Record<string, any>;
}

async function fixture(): Promise<{ root: string; scriptBody: string }> {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "studio-binding-command-bus-")));
  roots.push(parent);
  const root = (await createManagedProject({ parentRoot: parent, name: "P6 绑定命令总线" })).paths.root;
  await executeSetup(root, 1, {
    command: "create_studio_asset",
    payload: {
      id: "character-ahang",
      category: "character",
      name: "阿航",
      aliases: ["青年阿航"],
      identityFeatures: ["固定脸"],
      positiveLocks: ["黑衣"],
      negativeLocks: ["禁止换脸"],
      expectedRevision: 0,
    },
  });
  const script = await executeSetup(root, 2, {
    command: "create_studio_script_document",
    payload: { id: "script-p6-binding", title: "P6 绑定剧本", expectedRevision: 0 },
  });
  const scriptBody = "阿航进入石室，神秘人守门。";
  const scriptRevision = await executeSetup(root, 3, {
    command: "append_studio_script_revision",
    payload: {
      documentId: script.id,
      expectedRevision: 0,
      body: scriptBody,
      source: "fixture",
      sourceVersion: "p6-binding-v1",
    },
  });
  const prompt = await executeSetup(root, 4, {
    command: "create_studio_prompt_document",
    payload: { id: "prompt-p6-binding", title: "P6 绑定提示词", expectedRevision: 0 },
  });
  const promptRevision = await executeSetup(root, 5, {
    command: "append_studio_prompt_revision",
    payload: {
      documentId: prompt.id,
      expectedRevision: 0,
      body: "电影写实，阿航身份与石室连续。",
      source: "fixture",
      sourceVersion: "p6-binding-v1",
    },
  });
  await executeSetup(root, 6, {
    command: "create_studio_production_unit",
    payload: {
      id: "unit-p6-binding-001",
      expectedRevision: 0,
      season: "S03",
      episode: "EP01",
      sequence: 1,
      title: "进入石室",
      scriptRevisionId: scriptRevision.revision.id,
      panels: [
        {
          id: "panel-01",
          title: "进场",
          visualAction: "阿航进入石室。",
          shotComposition: "中景。",
          filmingMethod: "稳定器跟拍。",
          startSeconds: 0,
          endSeconds: 7,
          durationSeconds: 7,
          promptRevisionId: promptRevision.revision.id,
          sourceSpans: [{ startOffsetUtf16: 0, endOffsetUtf16: scriptBody.length }],
          assets: [{
            assetId: "character-ahang",
            category: "character",
            presence: "required",
            role: "主角",
            continuityState: "固定脸与黑衣。",
            evidence: [{ kind: "fixture", reference: "script-p6-binding" }],
          }],
        },
        {
          id: "panel-02",
          title: "停步",
          visualAction: "阿航在石门前停步。",
          shotComposition: "近景。",
          filmingMethod: "50mm 缓推。",
          startSeconds: 7,
          endSeconds: 15,
          durationSeconds: 8,
          promptRevisionId: promptRevision.revision.id,
          sourceSpans: [{ startOffsetUtf16: 0, endOffsetUtf16: scriptBody.length }],
          assets: [{
            assetId: "character-ahang",
            category: "character",
            presence: "required",
            role: "主角",
            continuityState: "承接上一格。",
            evidence: [{ kind: "fixture", reference: "panel-01" }],
          }],
        },
      ],
    },
  });

  const sourcePath = path.join(parent, "ahang-p6-binding.png");
  await sharp({ create: { width: 32, height: 48, channels: 3, background: "#584636" } }).png().toFile(sourcePath);
  const media = await executeSetup(root, 7, {
    command: "import_studio_media",
    payload: { sourcePath, kind: "image" },
  });
  const version = await executeSetup(root, 8, {
    command: "append_studio_asset_version",
    payload: {
      assetId: "character-ahang",
      mediaSha256: media.sha256,
      reviewStatus: "pending",
      sourceNote: "P6 绑定命令测试。",
      expectedRevision: 1,
    },
  });
  const review = await executeSetup(root, 9, {
    command: "review_studio_asset_version",
    payload: {
      assetId: "character-ahang",
      versionId: version.version.id,
      decision: "approved",
      expectedRevision: version.assetRevision,
      note: "P6 绑定测试权威图审核通过。",
    },
  });
  await executeSetup(root, 10, {
    command: "set_studio_primary_authority",
    payload: {
      assetId: "character-ahang",
      versionId: version.version.id,
      expectedRevision: review.revision,
      note: "P6 绑定测试主权威。",
    },
  });
  return { root, scriptBody };
}

async function crashThenRecover(root: string, index: number, request: StudioCommandRequest, viaReconcileCommand = false) {
  const first = envelope(index, request);
  process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE = request.command;
  try {
    await expect(executeIdempotentCommand(root, first)).rejects.toThrow("执行结果未确认");
  } finally {
    delete process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE;
  }
  expect((await listCommandLedger(root)).find((entry) => entry.idempotencyKey === first.idempotencyKey))
    .toMatchObject({
      status: "unknown",
      durableReconciliation: { schemaVersion: 1, request },
    });
  const recovered = viaReconcileCommand
    ? await reconcileCommand(root, { idempotencyKey: first.idempotencyKey })
    : await executeIdempotentCommand(root, {
      ...first,
      requestId: `${first.requestId}-recovery`,
    });
  expect(recovered).toMatchObject({
    status: "succeeded",
    replayed: true,
    result: { reconciled: true },
  });
  return recovered;
}

describe("P6 Studio binding 命令总线", () => {
  it("三个高层命令只收 UI 安全 payload，崩溃后只凭追加收据对账而不重放写操作", async () => {
    const { root, scriptBody } = await fixture();
    const initial = await getStudioBindingControl(root, { unitId: "unit-p6-binding-001" });
    const mysteryStart = scriptBody.indexOf("神秘人");
    const analyzeRequest = {
      command: "analyze_studio_script_entities" as const,
      payload: {
        unitId: "unit-p6-binding-001",
        panelId: "panel-01",
        expectedRevisionToken: initial.revisionToken,
        extractedMentions: [{
          startOffsetUtf16: mysteryStart,
          endOffsetUtf16: mysteryStart + "神秘人".length,
          category: "character" as const,
          presence: "optional" as const,
          role: "Codex 待审角色提议",
          candidateAssetIds: ["character-ahang"],
        }],
      },
    };

    await expect(executeIdempotentCommand(root, envelope(100, {
      ...analyzeRequest,
      payload: {
        ...analyzeRequest.payload,
        assetSources: [{ assetId: "malicious" }],
      },
    } as unknown as StudioCommandRequest))).rejects.toThrow(/载荷不符合合同.*assetSources/u);
    await expect(executeIdempotentCommand(root, envelope(101, {
      ...analyzeRequest,
      payload: {
        ...analyzeRequest.payload,
        extractedMentions: [{
          ...analyzeRequest.payload.extractedMentions[0],
          expectedAnalysisHeadRevision: 99,
        }],
      },
    } as unknown as StudioCommandRequest))).rejects.toThrow(/载荷不符合合同.*expectedAnalysisHeadRevision/u);
    expect((await listCommandLedger(root)).some((entry) => entry.idempotencyKey === "studio-binding-key-0100" || entry.idempotencyKey === "studio-binding-key-0101")).toBe(false);

    await crashThenRecover(root, 110, analyzeRequest);
    const analyzed = await getStudioBindingControl(root, { unitId: "unit-p6-binding-001" });
    const panel = analyzed.panels.find((entry) => entry.id === "panel-01")!;
    const ahang = panel.proposals.find((proposal) => proposal.entityText === "阿航")!;
    const suggested = panel.proposals.find((proposal) => proposal.entityText === "神秘人")!;
    expect(ahang).toMatchObject({ status: "matched", matchedAssetId: "character-ahang" });
    expect(ahang).not.toHaveProperty("resolvedAssetId");
    expect(suggested).toMatchObject({
      status: "unmatched",
      candidates: [{ assetId: "character-ahang", matchKind: "model" }],
    });
    expect(suggested).not.toHaveProperty("resolvedAssetId");

    const resolveRequest = {
      command: "resolve_studio_entity_proposal" as const,
      payload: {
        unitId: "unit-p6-binding-001",
        panelId: "panel-01",
        proposalId: ahang.id,
        decision: "accept" as const,
        selectedAssetId: "character-ahang",
        presence: "required" as const,
        role: "主角",
        expectedRevisionToken: analyzed.revisionToken,
        reviewer: "codex" as const,
      },
    };
    await crashThenRecover(root, 120, resolveRequest, true);

    const resolved = await getStudioBindingControl(root, { unitId: "unit-p6-binding-001" });
    expect(resolved.panels.find((entry) => entry.id === "panel-01")?.freezeAllowed).toBe(true);
    const freezeRequest = {
      command: "freeze_studio_asset_binding_set" as const,
      payload: {
        unitId: "unit-p6-binding-001",
        panelId: "panel-01",
        expectedRevisionToken: resolved.revisionToken,
      },
    };
    await crashThenRecover(root, 130, freezeRequest);
    const ready = await getStudioBindingControl(root, { unitId: "unit-p6-binding-001" });
    expect(ready.panels.find((entry) => entry.id === "panel-01")).toMatchObject({
      status: "generation-ready",
      freezeAllowed: false,
      bindingSet: { currentness: "current" },
    });

    const db = new DatabaseSync(path.join(root, ".aicanvas", "studio-production.sqlite"), { readOnly: true });
    const receipts = db.prepare(`SELECT command, request_hash, outcome_fingerprint
      FROM studio_binding_operation_receipts ORDER BY created_at`).all() as Array<Record<string, unknown>>;
    db.close();
    expect(receipts.map((receipt) => receipt.command)).toEqual([
      "analyze_studio_script_entities",
      "resolve_studio_entity_proposal",
      "freeze_studio_asset_binding_set",
    ]);
    expect(receipts.every((receipt) => String(receipt.request_hash).length === 64 && String(receipt.outcome_fingerprint).length === 64)).toBe(true);
    const recoveredEvents = (await listCommandLedger(root)).filter((entry) => [110, 120, 130]
      .map((index) => `studio-binding-key-${String(index).padStart(4, "0")}`).includes(entry.idempotencyKey));
    expect(recoveredEvents.every((entry) => entry.status === "succeeded" && entry.result && (entry.result as { reconciled?: boolean }).reconciled)).toBe(true);
  }, 30_000);
});
