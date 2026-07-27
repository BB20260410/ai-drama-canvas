import { access, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { executeIdempotentCommand, listCommandLedger, type CommandRequest, type StudioCommandRequest } from "../src/core/command-bus.js";
import { createManagedProject } from "../src/core/managed-project.js";
import { getStudioBindingControl } from "../src/core/studio-binding-control.js";
import type { StudioProductionPanelInput } from "../src/core/studio-production.js";
import { seedStudioP7ResolvedPanelContinuity } from "./helpers/studio-p7-fixture.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function managedRoot(): Promise<string> {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "ai-canvas-studio-command-")));
  roots.push(parent);
  return (await createManagedProject({ parentRoot: parent, name: "命令总线素材工程" })).paths.root;
}

function envelope(index: number, request: StudioCommandRequest) {
  return {
    requestId: `studio-command-request-${String(index).padStart(4, "0")}`,
    idempotencyKey: `studio-command-key-${String(index).padStart(4, "0")}`,
    request,
  };
}

describe("受管素材中心命令总线", () => {
  it("坏 Studio payload 在工程锁和 command ledger 之前失败，零 DB/sidecar/记录", async () => {
    const root = await managedRoot();
    const invalidRequests = [
      { command: "create_studio_asset", payload: { category: "character", expectedRevision: 0 } },
      {
        command: "dispatch_studio_generation_pack",
        payload: {
          packId: "pack-invalid",
          packFingerprint: "a".repeat(64),
          generationRunId: "run-invalid",
          provider: "browser",
          expectedRevision: 1,
        },
      },
      {
        command: "create_studio_asset",
        payload: { category: "character", name: "非法额外字段", expectedRevision: 0, operationId: "forbidden" },
      },
      {
        command: "freeze_studio_generation_pack",
        payload: { unitId: "unit-invalid", panelId: "panel-invalid", expectedRevision: 0 },
      },
      { command: "initialize_material_studio", payload: { unexpected: true } },
    ] as const;
    for (const [index, request] of invalidRequests.entries()) {
      await expect(executeIdempotentCommand(
        root,
        envelope(900 + index, request as unknown as StudioCommandRequest),
      )).rejects.toThrow(/不符合合同/u);
    }
    expect(await listCommandLedger(root)).toEqual([]);
    const databasePath = path.join(root, ".aicanvas", "command-ledger.sqlite");
    for (const candidate of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
      await expect(access(candidate)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("素材、剧本、提示词与 15 秒宫格都经幂等账本写入并可重放", async () => {
    const root = await managedRoot();
    const assetCommand = envelope(1, {
      command: "create_studio_asset",
      payload: {
        id: "character-ahang",
        category: "character",
        name: "阿航",
        aliases: ["青年阿航"],
        identityFeatures: ["固定脸", "左侧银白挑染"],
        positiveLocks: ["黑衣", "古蜀写实"],
        negativeLocks: ["禁止换脸", "禁止现代服饰"],
        defaultPrompt: "电影写实，保持阿航固定脸与黑衣。",
        expectedRevision: 0,
      },
    });
    const created = await executeIdempotentCommand(root, assetCommand);
    const replay = await executeIdempotentCommand(root, { ...assetCommand, requestId: "studio-command-request-replay-0001" });
    expect(created).toMatchObject({ status: "succeeded", replayed: false, result: { id: "character-ahang", revision: 1 } });
    expect(replay).toMatchObject({ status: "succeeded", replayed: true, result: { id: "character-ahang" } });

    const script = await executeIdempotentCommand(root, envelope(2, {
      command: "create_studio_script_document",
      payload: { id: "script-ep01", title: "EP01", expectedRevision: 0 },
    }));
    expect(script.result).toMatchObject({ id: "script-ep01", revision: 0 });
    const scriptRevision = await executeIdempotentCommand(root, envelope(3, {
      command: "append_studio_script_revision",
      payload: {
        documentId: "script-ep01",
        expectedRevision: 0,
        body: "阿航进入石室。",
        source: "local-import",
        sourceVersion: "v1",
      },
    }));
    const scriptRevisionId = (scriptRevision.result as { revision: { id: string } }).revision.id;

    await executeIdempotentCommand(root, envelope(4, {
      command: "create_studio_prompt_document",
      payload: { id: "prompt-ep01", title: "EP01 宫格提示词", expectedRevision: 0 },
    }));
    const promptRevision = await executeIdempotentCommand(root, envelope(5, {
      command: "append_studio_prompt_revision",
      payload: {
        documentId: "prompt-ep01",
        expectedRevision: 0,
        body: "电影写实，固定阿航身份与石室布局。",
        source: "codex",
        sourceVersion: "v1",
      },
    }));
    const promptRevisionId = (promptRevision.result as { revision: { id: string } }).revision.id;

    const unitPanels: StudioProductionPanelInput[] = [
      {
        id: "panel-01",
        title: "入场",
        visualAction: "阿航进入石室。",
        shotComposition: "中景，纵深构图。",
        filmingMethod: "稳定器缓慢跟拍。",
        startSeconds: 0,
        endSeconds: 7,
        durationSeconds: 7,
        promptRevisionId,
        sourceSpans: [{ startOffsetUtf16: 0, endOffsetUtf16: "阿航进入石室。".length }],
        assets: [{
          assetId: "character-ahang",
          category: "character",
          presence: "required",
          role: "主角",
          continuityState: "固定脸、黑衣、左侧银白挑染。",
          evidence: [{ kind: "asset-definition", reference: "character-ahang", note: "规范资产" }],
        }],
      },
      {
        id: "panel-02",
        title: "停步",
        visualAction: "阿航在石门前停步。",
        shotComposition: "近景，人物居中。",
        filmingMethod: "50mm 缓推。",
        startSeconds: 7,
        endSeconds: 15,
        durationSeconds: 8,
        promptRevisionId,
        sourceSpans: [{ startOffsetUtf16: 0, endOffsetUtf16: "阿航进入石室。".length }],
        assets: [{
          assetId: "character-ahang",
          category: "character",
          presence: "required",
          role: "主角",
          continuityState: "承接上一格站位与服装。",
          evidence: [{ kind: "timeline", reference: "panel-01", note: "连续站位" }],
        }],
      },
    ];
    const unit = await executeIdempotentCommand(root, envelope(6, {
      command: "create_studio_production_unit",
      payload: {
        id: "unit-ep01-001",
        expectedRevision: 0,
        season: "S03",
        episode: "EP01",
        sequence: 1,
        title: "进入石室",
        scriptRevisionId,
        panels: unitPanels,
      },
    }));
    expect(unit).toMatchObject({
      status: "succeeded",
      result: {
        unit: { id: "unit-ep01-001", durationSeconds: 15, panelCount: 2 },
      },
    });

    const referencePath = path.join(root, "ahang-command-reference.png");
    await sharp({ create: { width: 80, height: 120, channels: 3, background: "#66503f" } }).png().toFile(referencePath);
    const importReferenceCommand = envelope(7, {
      command: "import_studio_media",
      payload: { sourcePath: referencePath },
    });
    const importedReference = await executeIdempotentCommand(root, importReferenceCommand);
    const importedReferenceReplay = await executeIdempotentCommand(root, {
      ...importReferenceCommand,
      requestId: "studio-command-request-import-replay-0007",
    });
    expect(importedReferenceReplay).toMatchObject({ replayed: true, result: importedReference.result });
    const referenceSha256 = (importedReference.result as { sha256: string }).sha256;
    const importAudit = new DatabaseSync(path.join(root, ".aicanvas", "material-studio.sqlite"), { readOnly: true });
    const importOriginCount = importAudit.prepare("SELECT COUNT(*) AS count FROM studio_media_imports WHERE media_sha256 = ?")
      .get(referenceSha256) as { count: number };
    importAudit.close();
    expect(importOriginCount.count).toBe(1);
    const version = await executeIdempotentCommand(root, envelope(8, {
      command: "append_studio_asset_version",
      payload: {
        assetId: "character-ahang",
        mediaSha256: referenceSha256,
        reviewStatus: "pending",
        sourceNote: "命令总线角色参考候选。",
        expectedRevision: 1,
      },
    }));
    const versionResult = version.result as { version: { id: string }; assetRevision: number };
    const review = await executeIdempotentCommand(root, envelope(80, {
      command: "review_studio_asset_version",
      payload: {
        assetId: "character-ahang",
        versionId: versionResult.version.id,
        decision: "approved",
        expectedRevision: versionResult.assetRevision,
        note: "命令总线 fixture 审核通过。",
      },
    }));
    const reviewResult = review.result as { revision: number };
    const authority = await executeIdempotentCommand(root, envelope(9, {
      command: "set_studio_primary_authority",
      payload: {
        assetId: "character-ahang",
        versionId: versionResult.version.id,
        expectedRevision: reviewResult.revision,
        note: "命令总线冻结测试主权威。",
      },
    }));

    const bindingBefore = await getStudioBindingControl(root, { unitId: "unit-ep01-001" });
    await executeIdempotentCommand(root, envelope(91, {
      command: "analyze_studio_script_entities",
      payload: {
        unitId: "unit-ep01-001",
        panelId: "panel-01",
        expectedRevisionToken: bindingBefore.revisionToken,
      },
    }));
    const bindingAnalyzed = await getStudioBindingControl(root, { unitId: "unit-ep01-001" });
    const ahangProposal = bindingAnalyzed.panels[0]!.proposals.find((proposal) => proposal.entityText === "阿航");
    expect(ahangProposal).toMatchObject({ status: "matched", matchedAssetId: "character-ahang" });
    await executeIdempotentCommand(root, envelope(92, {
      command: "resolve_studio_entity_proposal",
      payload: {
        unitId: "unit-ep01-001",
        panelId: "panel-01",
        proposalId: ahangProposal!.id,
        decision: "accept",
        selectedAssetId: "character-ahang",
        presence: "required",
        role: "主角",
        expectedRevisionToken: bindingAnalyzed.revisionToken,
        reviewer: "codex",
      },
    }));
    const bindingResolved = await getStudioBindingControl(root, { unitId: "unit-ep01-001" });
    await executeIdempotentCommand(root, envelope(93, {
      command: "freeze_studio_asset_binding_set",
      payload: {
        unitId: "unit-ep01-001",
        panelId: "panel-01",
        expectedRevisionToken: bindingResolved.revisionToken,
      },
    }));
    expect((await getStudioBindingControl(root, { unitId: "unit-ep01-001" })).panels[0]?.status).toBe("generation-ready");

    await seedStudioP7ResolvedPanelContinuity(root, {
      unitId: "unit-ep01-001",
      panelId: "panel-01",
      assetIds: ["character-ahang"],
    });

    const bindingUnitRevision = (unit.result as { unit: { revision: number } }).unit.revision;
    const unrelatedRevision = await executeIdempotentCommand(root, envelope(94, {
      command: "revise_studio_production_unit",
      payload: {
        unitId: "unit-ep01-001",
        expectedRevision: bindingUnitRevision,
        season: "S03",
        episode: "EP01",
        sequence: 1,
        title: "进入石室",
        scriptRevisionId,
        panels: unitPanels.map((panel) => panel.id === "panel-02"
          ? { ...panel, visualAction: "阿航在石门前停步，听见远处水声。" }
          : panel),
      },
    }));
    const currentUnitRevision = (unrelatedRevision.result as { unit: { revision: number } }).unit.revision;
    const freezeCommand = envelope(10, {
      command: "freeze_studio_generation_pack",
      payload: { unitId: "unit-ep01-001", panelId: "panel-01", expectedRevision: currentUnitRevision },
    });
    const frozen = await executeIdempotentCommand(root, freezeCommand);
    const freezeReplay = await executeIdempotentCommand(root, {
      ...freezeCommand,
      requestId: "studio-command-request-freeze-replay-0010",
    });
    const frozenResult = frozen.result as {
      sequence: number;
      packId: string;
      fingerprint: string;
      pack: { target: { unitRevision: number }; request: { modelPayload: { exactlyOneImage: boolean } } };
    };
    expect(frozen).toMatchObject({ status: "succeeded", replayed: false });
    expect(freezeReplay).toMatchObject({ status: "succeeded", replayed: true, result: { packId: frozenResult.packId } });
    expect(currentUnitRevision).toBe(bindingUnitRevision + 1);
    expect(frozenResult.pack.target.unitRevision).toBe(bindingUnitRevision);
    expect(frozenResult.pack.request.modelPayload.exactlyOneImage).toBe(true);
    expect(frozen.result).not.toHaveProperty("databasePath");
    expect(frozen.result).not.toHaveProperty("packCasRoot");
    expect(JSON.stringify(frozen.result)).not.toContain("studio-generation-ledger.sqlite");
    expect(JSON.stringify(frozen.result)).not.toContain("studio-generation/objects/sha256");

    const dispatchRequest = {
      command: "dispatch_studio_generation_pack" as const,
      payload: {
        packId: frozenResult.packId,
        packFingerprint: frozenResult.fingerprint,
        generationRunId: "codex-local-run-0001",
        provider: "codex" as const,
        expectedRevision: frozenResult.pack.target.unitRevision,
      },
    };
    const dispatched = await executeIdempotentCommand(root, envelope(100, dispatchRequest));
    expect(dispatched).toMatchObject({
      status: "succeeded",
      replayed: false,
      result: {
        generationRunId: "codex-local-run-0001",
        packId: frozenResult.packId,
        dispatchProvenance: "local-dispatch-intent",
      },
    });

    // dispatch 后资产知识发生漂移；晚返回结果仍必须挂回原 pack，但绝不具备提升资格。
    const authorityRevision = (authority.result as { revision: number }).revision;
    await executeIdempotentCommand(root, envelope(101, {
      command: "update_studio_asset",
      payload: {
        assetId: "character-ahang",
        expectedRevision: authorityRevision,
        aliases: ["阿航（更新后别名）"],
      },
    }));

    const resultPath = path.join(root, "ahang-command-result.png");
    await sharp({ create: { width: 80, height: 120, channels: 3, background: "#304c68" } }).png().toFile(resultPath);
    const importedResult = await executeIdempotentCommand(root, envelope(11, {
      command: "import_studio_media",
      payload: { sourcePath: resultPath },
    }));
    const resultSha256 = (importedResult.result as { sha256: string }).sha256;
    const registerRequest = {
      command: "register_studio_generation_result" as const,
      payload: {
        packId: frozenResult.packId,
        packFingerprint: frozenResult.fingerprint,
        generationRunId: "codex-local-run-0001",
        variant: "raw" as const,
        mediaSha256: resultSha256,
        expectedRevision: bindingUnitRevision,
      },
    };
    const registerCommand = envelope(12, registerRequest);
    const registered = await executeIdempotentCommand(root, registerCommand);
    const registerReplay = await executeIdempotentCommand(root, {
      ...registerCommand,
      requestId: "studio-command-request-register-replay-0012",
    });
    const registerDomainReplay = await executeIdempotentCommand(root, envelope(13, registerRequest));
    expect(registered).toMatchObject({
      status: "succeeded",
      replayed: false,
      result: {
        generationRunId: "codex-local-run-0001",
        variant: "raw",
        status: "pending",
        packId: frozenResult.packId,
        unitRevision: bindingUnitRevision,
        inputCurrent: false,
        promotionEligible: false,
      },
    });
    expect((registered.result as { staleReasons: string[] }).staleReasons.length).toBeGreaterThan(0);
    expect(registerReplay).toMatchObject({ status: "succeeded", replayed: true, result: registered.result });
    expect(registerDomainReplay).toMatchObject({ status: "succeeded", replayed: false, result: registered.result });
    expect(JSON.stringify(registered.result)).not.toContain("objectPath");
    expect(JSON.stringify(registered.result)).not.toContain("studio-generation/objects");

    await expect(executeIdempotentCommand(root, envelope(14, {
      command: "freeze_studio_generation_pack",
      payload: { unitId: "unit-ep01-001", panelId: "panel-01", expectedRevision: currentUnitRevision + 1 },
    }))).rejects.toMatchObject({
      name: "RejectedCommandFailure",
      result: {
        applied: false,
        entityType: "studio_generation_pack",
        reason: "revision_conflict",
        expectedRevision: currentUnitRevision + 1,
        currentRevision: currentUnitRevision,
      },
    });

    const conflictingPath = path.join(root, "ahang-command-result-conflict.png");
    await sharp({ create: { width: 80, height: 120, channels: 3, background: "#684430" } }).png().toFile(conflictingPath);
    const conflictingImport = await executeIdempotentCommand(root, envelope(15, {
      command: "import_studio_media",
      payload: { sourcePath: conflictingPath },
    }));
    await expect(executeIdempotentCommand(root, envelope(16, {
      command: "register_studio_generation_result",
      payload: { ...registerRequest.payload, mediaSha256: (conflictingImport.result as { sha256: string }).sha256 },
    }))).rejects.toMatchObject({
      name: "RejectedCommandFailure",
      result: {
        applied: false,
        entityType: "studio_generation_result",
        reason: "result_conflict",
        code: "result-conflict",
      },
    });
    const generationEntries = (await listCommandLedger(root)).filter((entry) => entry.command.includes("studio_generation"));
    expect(generationEntries.filter((entry) => entry.status === "succeeded")).toHaveLength(4);
    expect(generationEntries.filter((entry) => entry.status === "failed")).toHaveLength(2);
  });

  it("命令总线拒绝直接 approved/rejected，历史版本 UPDATE 也被数据库拒绝", async () => {
    const root = await managedRoot();
    await executeIdempotentCommand(root, envelope(101, {
      command: "create_studio_asset",
      payload: {
        id: "character-review-gate",
        category: "character",
        name: "审核门禁角色",
        expectedRevision: 0,
      },
    }));
    const sourcePath = path.join(root, "review-gate.png");
    await sharp({ create: { width: 32, height: 48, channels: 3, background: "#4f3f31" } }).png().toFile(sourcePath);
    const imported = await executeIdempotentCommand(root, envelope(102, {
      command: "import_studio_media",
      payload: { sourcePath },
    }));
    const mediaSha256 = (imported.result as { sha256: string }).sha256;

    for (const [index, forbiddenStatus] of ["approved", "rejected"].entries()) {
      const maliciousRequest = {
        command: "append_studio_asset_version",
        payload: {
          assetId: "character-review-gate",
          mediaSha256,
          reviewStatus: forbiddenStatus,
          sourceNote: "恶意跳过审核的候选。",
          expectedRevision: 1,
        },
      } as unknown as StudioCommandRequest;
      await expect(executeIdempotentCommand(root, envelope(103 + index, maliciousRequest)))
        .rejects.toThrow(/pending|reviewStatus/u);
    }

    const pending = await executeIdempotentCommand(root, envelope(105, {
      command: "append_studio_asset_version",
      payload: {
        assetId: "character-review-gate",
        mediaSha256,
        reviewStatus: "pending",
        sourceNote: "合法 pending 候选。",
        expectedRevision: 1,
      },
    }));
    const pendingResult = pending.result as { version: { id: string }; assetRevision: number };
    const db = new DatabaseSync(path.join(root, ".aicanvas", "material-studio.sqlite"));
    expect(() => db.prepare("UPDATE studio_asset_versions SET review_status = 'approved' WHERE id = ?").run(pendingResult.version.id))
      .toThrow("studio_asset_versions is append-only");
    db.close();

    await expect(executeIdempotentCommand(root, envelope(106, {
      command: "set_studio_primary_authority",
      payload: {
        assetId: "character-review-gate",
        versionId: pendingResult.version.id,
        expectedRevision: pendingResult.assetRevision,
      },
    }))).rejects.toThrow("只有 approved 版本");

    const audit = new DatabaseSync(path.join(root, ".aicanvas", "material-studio.sqlite"), { readOnly: true });
    const asset = audit.prepare("SELECT revision, primary_version_id FROM studio_canonical_assets WHERE id = ?")
      .get("character-review-gate") as { revision: number; primary_version_id: string | null };
    const reviewCount = audit.prepare("SELECT COUNT(*) AS count FROM studio_version_reviews WHERE version_id = ?")
      .get(pendingResult.version.id) as { count: number };
    audit.close();
    expect(asset).toEqual({ revision: pendingResult.assetRevision, primary_version_id: null });
    expect(reviewCount.count).toBe(0);
  });

  it("非受管目录失败关闭，不会被素材命令静默接管", async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "ai-canvas-not-managed-")));
    roots.push(root);
    await expect(executeIdempotentCommand(root, envelope(9, {
      command: "initialize_material_studio",
      payload: {},
    }))).rejects.toThrow("受管项目");
    await expect(executeIdempotentCommand(root, envelope(10, {
      command: "freeze_studio_generation_pack",
      payload: { unitId: "unit-001", panelId: "panel-01", expectedRevision: 1 },
    }))).rejects.toThrow("受管项目");
    await expect(executeIdempotentCommand(root, envelope(11, {
      command: "register_studio_generation_result",
      payload: {
        packId: "studio-generation-freeze-unmanaged",
        packFingerprint: "a".repeat(64),
        generationRunId: "unmanaged-generation-run-001",
        variant: "raw",
        mediaSha256: "b".repeat(64),
        expectedRevision: 1,
      },
    }))).rejects.toThrow("受管项目");
    await expect(access(path.join(root, ".aicanvas"))).rejects.toThrow();
  });

  it("受管目录只接受素材中心命令，旧扫描命令在写账本前即失败关闭", async () => {
    const root = await managedRoot();
    const request = { command: "scan_project", payload: {} } satisfies CommandRequest;
    await expect(executeIdempotentCommand(root, {
      requestId: "studio-command-request-legacy-0010",
      idempotencyKey: "studio-command-key-legacy-0010",
      request,
    })).rejects.toThrow("拒绝旧命令 scan_project");
  });
});
