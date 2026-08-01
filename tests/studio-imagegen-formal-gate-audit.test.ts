/**
 * 生图入口正式 Freeze Pack 门禁 · 负数审计测试（只读审计产出，不修改 src）。
 *
 * 目标：证明所有"可能触达生图"的入口都无法绕过正式门禁链：
 *   freeze_studio_generation_pack → create_studio_generation_plan → dispatch_studio_generation_pack
 *   → prepare_studio_imagegen_call（一次性 callAllowed）→ 外部 Agent 写 quarantine
 *   → commit_agent_imagegen_result_bundle → submit_studio_generation_review。
 *
 * 负数矩阵（对应审计任务逐项）：
 *   1. 未冻结参考：continuity 未就绪时 freeze 直接拒绝；伪造 packId/指纹不得 dispatch。
 *   2. 无 projectContextToken：prepare / commit 均以 project-context-token-mismatch 拒绝。
 *   3. 无 call intent：unit-grid 未 prepare 即 commit 以 call-intent-required 拒绝；
 *      panel v4 旧目标既拿不到 call intent（prepare 仅服务 protocol v2），
 *      其非 fixture 回执也被 call-intent-required 拒绝（旧登记路径的隔离边界）。
 *   4. generation_unknown 未对账：reconcile not-invoked 后 commit 拒绝；已提交结果
 *      不得二次新增（result-conflict）；重放 prepare 永不二次授权（callAllowed=false）。
 *   5. 来源不明本地路径：rawPath 不在 pre-call 授予的 quarantine candidatePath 即
 *      storage-unsafe；raw SHA 不符即 raw-sha-mismatch。
 *   6. 未批准候选：commit 成功也只落 pending Review，机器绝不 autoApprove。
 *   7. 旧队列线（legacy generation queue / codex-subagent 适配器）：受管工程上
 *      enqueue/process/update-subagent 全部拒绝或空转；命令总线对旧命令 fail-close。
 *
 * 结构上无法在 fixture 中实例化的入口（MCP 工具面、renderer、codex.ts 执行面）
 * 用源码级断言代替，并在各断言处注释说明依据。
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import {
  executeIdempotentCommand,
  type IdempotentCommandInput,
} from "../src/core/command-bus.js";
import { getActiveManagedStudioContext } from "../src/core/active-managed-studio-context.js";
import {
  enqueueGeneration,
  processGenerationQueue,
  updateSubagentImageGenerationJob,
} from "../src/core/generation.js";
import {
  dispatchStudioGenerationPack,
  freezeAndPersistStudioGenerationPack,
  freezeAndPersistStudioUnitGridGenerationPack,
  readStudioGenerationResultBundle,
} from "../src/core/studio-generation-ledger.js";
import { submitStudioGenerationReview } from "../src/core/studio-generation-review.js";
import {
  acceptStudioImagegenCandidateBytes,
  assertStudioImagegenCandidatePathAllowed,
} from "../src/core/studio-imagegen-candidate-gate.js";
import { registerProject, setActiveProjectRegistration } from "../src/core/sidecar.js";
import {
  createStudioP7Fixture,
  seedStudioP7ResolvedPanelContinuity,
  studioP7ContinuationWaiver,
  type StudioP7Fixture,
} from "./helpers/studio-p7-fixture.js";

const originalRegistry = process.env.AI_CANVAS_REGISTRY_PATH;
const originalWorkspace = process.env.AI_CANVAS_WORKSPACE;
const originalRecordedDigest = process.env.AI_CANVAS_RECORDED_SOURCE_DIGEST;
let fixture: StudioP7Fixture | undefined;
let registryParent: string | undefined;

afterEach(async () => {
  if (originalRegistry === undefined) delete process.env.AI_CANVAS_REGISTRY_PATH;
  else process.env.AI_CANVAS_REGISTRY_PATH = originalRegistry;
  if (originalWorkspace === undefined) delete process.env.AI_CANVAS_WORKSPACE;
  else process.env.AI_CANVAS_WORKSPACE = originalWorkspace;
  if (originalRecordedDigest === undefined) delete process.env.AI_CANVAS_RECORDED_SOURCE_DIGEST;
  else process.env.AI_CANVAS_RECORDED_SOURCE_DIGEST = originalRecordedDigest;
  if (fixture) await fixture.cleanup();
  fixture = undefined;
  if (registryParent) await rm(registryParent, { recursive: true, force: true });
  registryParent = undefined;
});

function envelope(index: string, request: IdempotentCommandInput["request"]): IdempotentCommandInput {
  return {
    requestId: `gate-audit-request-${index}`,
    idempotencyKey: `gate-audit-idempotency-${index}`,
    request,
  };
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function isolateRegistryAndIdentity(tag: string): Promise<void> {
  delete process.env.AI_CANVAS_RECORDED_SOURCE_DIGEST;
  registryParent = path.join("/tmp", `ai-canvas-gate-audit-${tag}-${process.pid}-${Date.now()}`);
  process.env.AI_CANVAS_REGISTRY_PATH = path.join(registryParent, "projects.json");
}

/** 与既有 call-command-bus 测试一致：固定构建身份，避免 token 因源码摘要漂移而旋转。 */
async function pinStableBuildIdentity(): Promise<void> {
  const identityWorkspace = path.join(fixture!.parentRoot, "stable-build-identity");
  await mkdir(path.join(identityWorkspace, "src", "mcp"), { recursive: true });
  await Promise.all([
    writeFile(path.join(identityWorkspace, "package.json"), `${JSON.stringify({ name: "ai-drama-canvas", version: "0.2.0" })}\n`),
    writeFile(path.join(identityWorkspace, "src", "mcp", "server.ts"), "server.registerTool(\"fixture\", {}, () => ({}));\n"),
  ]);
  process.env.AI_CANVAS_WORKSPACE = identityWorkspace;
}

async function seedUnitContinuity(unit: StudioP7Fixture["units"]["twoPanel"]): Promise<void> {
  for (const panel of unit.panels) {
    await seedStudioP7ResolvedPanelContinuity(fixture!.root, {
      unitId: unit.unit.id,
      panelId: panel.id,
      assetIds: panel.assets.filter((asset) => asset.presence !== "forbidden").map((asset) => asset.assetId),
    });
  }
}

describe.sequential("生图入口正式门禁 · 负数审计", () => {
  it("未冻结/未就绪参考拒绝冻结；旧队列线在受管工程全被拒", async () => {
    await isolateRegistryAndIdentity("legacy");
    fixture = await createStudioP7Fixture();

    // ── 负数 1a：continuity 九字段未就绪（未冻结参考）时，unit-grid freeze 必须失败。
    // buildStudioGenerationFreezePack 的 continuity readiness 闸（src/core/studio-generation.ts:1237）
    // 或统一引用闭包 generation-ready 闸（:2122）必须先于任何 pack 落盘拦截。
    const freezeAttempt = await freezeAndPersistStudioUnitGridGenerationPack(fixture.root, {
      targetKind: "unit-grid",
      unitId: fixture.units.twoPanel.unit.id,
      verifiedHistoricalImportContinuationWaiver: await studioP7ContinuationWaiver(
        fixture.root,
        fixture.units.twoPanel,
        "fixture:formal-gate-audit:not-ready",
      ),
    }).then(
      () => null,
      (error: unknown) => error as { code?: string; message?: string },
    );
    expect(freezeAttempt, "continuity 未就绪的 unit-grid 冻结必须被拒绝").not.toBeNull();
    expect(freezeAttempt).toMatchObject({
      code: expect.stringMatching(/^(continuity-not-ready|asset-binding-unconfirmed|asset-binding-missing|too-few-references)$/) as unknown as string,
    });

    // ── 负数 7a：旧队列线 enqueue_generation 在受管工程上被隐式门禁拒绝。
    // generation.ts:1045-1046 先查融合工程（受管工程无 fusion manifest → false），
    // 再落 assertProductionWorkflowGate（production.ts:415）：受管工程没有 legacy
    // completed 证据，门禁 fail。UI 层另有 GenerationQueueView.vue:247-251 的受管壳拦截。
    const enqueueAttempt = await enqueueGeneration(fixture.root, {
      itemIds: [fixture.units.twoPanel.unit.id],
      kind: "image",
    }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(enqueueAttempt, "受管工程上的旧队列入队必须被拒绝").not.toBeNull();
    expect(String((enqueueAttempt as Error).message)).toMatch(/门禁|工作流|融合|节点|供应商|completed/);

    // ── 负数 7b：命令总线对受管工程上的旧命令 fail-close。
    // command-bus.ts:3260-3262：managed && !studioCommand → 拒绝（MCP execute_command 必经此闸）。
    for (const [index, request] of ([
      ["enqueue_generation", { command: "enqueue_generation", payload: { itemIds: [fixture.units.twoPanel.unit.id], kind: "image" } }],
      ["process_generation_queue", { command: "process_generation_queue", payload: {} }],
      ["update_subagent_image_generation", { command: "update_subagent_image_generation", payload: { jobId: "ghost-job", expectedRevision: 0, status: "claim" } }],
    ] as const).entries()) {
      await expect(executeIdempotentCommand(fixture.root, envelope(`legacy-bus-${index}`, request as unknown as IdempotentCommandInput["request"])))
        .rejects.toThrow(/受管素材工程拒绝旧命令/);
    }

    // ── 负数 7c：旧队列为空时 processGenerationQueue 无任何可执行对象（无 POST 旁路）。
    // 真正的生图 POST（submitComfyUiJob:4317 / submitHttpJob:4406）只处理既有 queued job；
    // 入队已被 7a/7b 阻断，这里证明队列恒空、无任何任务可被定向处理。
    await expect(processGenerationQueue(fixture.root)).resolves.toEqual([]);
    await expect(processGenerationQueue(fixture.root, { jobId: "ghost-job-audit" }))
      .rejects.toThrow(/找不到要处理的生成任务/);

    // ── 负数 7d：旧 codex-subagent 适配器的检查点写入在无真实任务时立即拒绝。
    // generation.ts:2253：任务查找先于一切 action 校验，幽灵 jobId 直接失败。
    await expect(updateSubagentImageGenerationJob(fixture.root, "ghost-job-audit", {
      expectedRevision: 0,
      status: "claim",
      agentTaskName: "gate-audit",
      owner: "gate-audit",
    })).rejects.toThrow(/找不到生成任务/);
  }, 120_000);

  it("正式链负数门禁矩阵：token/一次性 call/quarantine/对账/未批准候选", async () => {
    await isolateRegistryAndIdentity("formal");
    fixture = await createStudioP7Fixture();
    await pinStableBuildIdentity();
    await registerProject(fixture.shell.project);
    await setActiveProjectRegistration(fixture.root);

    const unit = fixture.units.twoPanel;
    await seedUnitContinuity(unit);
    const frozen = await freezeAndPersistStudioUnitGridGenerationPack(fixture.root, {
      targetKind: "unit-grid",
      unitId: unit.unit.id,
      verifiedHistoricalImportContinuationWaiver: await studioP7ContinuationWaiver(
        fixture.root,
        unit,
        "fixture:formal-gate-audit:formal",
      ),
    });
    const context = await getActiveManagedStudioContext();
    const fakeToken = `studioctx-v1-${"0".repeat(64)}`;

    // ── 负数 1b：伪造 packId 不得 dispatch（studio-generation-ledger.ts:4684）。
    await expect(dispatchStudioGenerationPack(fixture.root, {
      packId: "studio-generation-freeze-nonexistent",
      packFingerprint: "0".repeat(64),
      generationRunId: "gate-audit-ghost-pack",
      provider: "codex",
    })).rejects.toMatchObject({ code: "pack-not-found" });

    // ── 负数 1c：真实 packId + 错误指纹不得 dispatch（:4685 指纹失配）。
    await expect(dispatchStudioGenerationPack(fixture.root, {
      packId: frozen.packId,
      packFingerprint: "0".repeat(64),
      generationRunId: "gate-audit-bad-fingerprint",
      provider: "codex",
    })).rejects.toMatchObject({ code: "pack-index-conflict" });

    // ── 负数 3a：未 dispatch 的 run 不得 commit（bundle verifyPackAndDispatch:454）。
    await expect(executeIdempotentCommand(fixture.root, envelope("commit-no-dispatch", {
      command: "commit_agent_imagegen_result_bundle",
      payload: {
        projectContextToken: context.projectContextToken,
        packId: frozen.packId,
        packFingerprint: frozen.fingerprint,
        generationRunId: "gate-audit-no-dispatch",
        provider: "codex",
        rawPath: path.join(fixture.root, "fixture-inputs", "ghost.png"),
        rawSha256: "0".repeat(64),
        expectedRevision: frozen.pack.target.unitRevision,
        executionReceipt: {
          schemaVersion: 1, kind: "agent-imagegen-execution-receipt", provider: "codex",
          source: "fixture-canary", attestationLevel: "unverified-external-agent",
          cryptographicProviderReceipt: false, callId: "gate-audit-ghost-call",
          model: "fixture-imagegen", generatedAt: "2026-07-25T00:00:00.000Z",
        },
      },
    }))).rejects.toMatchObject({
      name: "RejectedCommandFailure",
      result: { entityType: "studio_generation_result_bundle", code: "dispatch-not-found" },
    });

    // ── 负数 2a：伪造 projectContextToken 不得 prepare（command-bus.ts:2481 先验 token）。
    await expect(executeIdempotentCommand(fixture.root, envelope("prepare-fake-token", {
      command: "prepare_studio_imagegen_call",
      payload: {
        packId: frozen.packId,
        packFingerprint: frozen.fingerprint,
        generationRunId: "gate-audit-fake-token-run",
        provider: "codex",
        projectContextToken: fakeToken,
        expectedRevision: 0,
      },
    }))).rejects.toMatchObject({
      name: "RejectedCommandFailure",
      result: { code: "project-context-token-mismatch" },
    });

    // ── 负数 2b：伪造 projectContextToken 不得 commit（bundle:833 assertActiveManagedStudioContextToken）。
    await expect(executeIdempotentCommand(fixture.root, envelope("commit-fake-token", {
      command: "commit_agent_imagegen_result_bundle",
      payload: {
        projectContextToken: fakeToken,
        packId: frozen.packId,
        packFingerprint: frozen.fingerprint,
        generationRunId: "gate-audit-fake-token-commit",
        provider: "codex",
        rawPath: path.join(fixture.root, "fixture-inputs", "ghost.png"),
        rawSha256: "0".repeat(64),
        expectedRevision: frozen.pack.target.unitRevision,
        executionReceipt: {
          schemaVersion: 1, kind: "agent-imagegen-execution-receipt", provider: "codex",
          source: "fixture-canary", attestationLevel: "unverified-external-agent",
          cryptographicProviderReceipt: false, callId: "gate-audit-fake-token-call",
          model: "fixture-imagegen", generatedAt: "2026-07-25T00:00:00.000Z",
        },
      },
    }))).rejects.toMatchObject({
      name: "RejectedCommandFailure",
      result: { entityType: "studio_generation_result_bundle", code: "project-context-token-mismatch" },
    });

    // 正式 dispatch run-0001（后续用例的合法载体）。
    const run1 = "gate-audit-run-0001";
    await dispatchStudioGenerationPack(fixture.root, {
      packId: frozen.packId,
      packFingerprint: frozen.fingerprint,
      generationRunId: run1,
      provider: "codex",
    });

    // ── 负数 3b：unit-grid 未经 prepare（无 call intent）即 commit，连最宽松的
    // fixture-canary 回执也被 call-intent-required 拒绝（bundle:465-467）。
    await expect(executeIdempotentCommand(fixture.root, envelope("commit-no-precall", {
      command: "commit_agent_imagegen_result_bundle",
      payload: {
        projectContextToken: context.projectContextToken,
        packId: frozen.packId,
        packFingerprint: frozen.fingerprint,
        generationRunId: run1,
        provider: "codex",
        rawPath: path.join(fixture.root, "fixture-inputs", "ghost.png"),
        rawSha256: "0".repeat(64),
        expectedRevision: frozen.pack.target.unitRevision,
        executionReceipt: {
          schemaVersion: 1, kind: "agent-imagegen-execution-receipt", provider: "codex",
          source: "fixture-canary", attestationLevel: "unverified-external-agent",
          cryptographicProviderReceipt: false, callId: "gate-audit-no-precall-call",
          model: "fixture-imagegen", generatedAt: "2026-07-25T00:00:00.000Z",
        },
      },
    }))).rejects.toMatchObject({
      name: "RejectedCommandFailure",
      result: { entityType: "studio_generation_result_bundle", code: "call-intent-required" },
    });
    expect(await readStudioGenerationResultBundle(fixture.root, run1)).toBeNull();

    // ── 正数 3c：panel v4 dispatch 可在 prepare 时追加 protocol v2 扩展，
    // 获得与 unit-grid 相同的一次性 call intent，并只从 quarantine 原子写回。
    const panelUnit = fixture.units.sixPanel;
    const panel = panelUnit.panels[0]!;
    await seedStudioP7ResolvedPanelContinuity(fixture.root, {
      unitId: panelUnit.unit.id,
      panelId: panel.id,
      assetIds: panel.assets.filter((asset) => asset.presence !== "forbidden").map((asset) => asset.assetId),
    });
    const panelFrozen = await freezeAndPersistStudioGenerationPack(fixture.root, {
      unitId: panelUnit.unit.id,
      panelId: panel.id,
    });
    const panelRun = "gate-audit-panel-run-0001";
    await dispatchStudioGenerationPack(fixture.root, {
      packId: panelFrozen.packId,
      packFingerprint: panelFrozen.fingerprint,
      generationRunId: panelRun,
      provider: "codex",
    });
    const panelPreparedCommand = await executeIdempotentCommand(fixture.root, envelope("prepare-panel-v4", {
      command: "prepare_studio_imagegen_call",
      payload: {
        packId: panelFrozen.packId,
        packFingerprint: panelFrozen.fingerprint,
        generationRunId: panelRun,
        provider: "codex",
        projectContextToken: context.projectContextToken,
        expectedRevision: 0,
      },
    }));
    expect(panelPreparedCommand).toMatchObject({
      status: "succeeded",
      result: { callAllowed: true, idempotentReplay: false, targetKind: "panel" },
    });
    const panelPrepared = panelPreparedCommand.result as {
      callId: string;
      quarantine: { candidatePath: string };
    };
    const panelWide = panelFrozen.pack.request.modelPayload.layout === "cinematic-wide";
    await sharp({
      create: {
        width: panelWide ? 1919 : 900,
        height: panelWide ? 820 : 1600,
        channels: 3,
        background: "#243a4b",
      },
    }).png({ compressionLevel: 0 }).toFile(panelPrepared.quarantine.candidatePath);
    const panelCandidateSha = sha256(await readFile(panelPrepared.quarantine.candidatePath));
    const panelCommitted = await executeIdempotentCommand(fixture.root, envelope("commit-panel-live-receipt", {
      command: "commit_agent_imagegen_result_bundle",
      payload: {
        projectContextToken: context.projectContextToken,
        packId: panelFrozen.packId,
        packFingerprint: panelFrozen.fingerprint,
        generationRunId: panelRun,
        provider: "codex",
        rawPath: panelPrepared.quarantine.candidatePath,
        rawSha256: panelCandidateSha,
        expectedRevision: panelFrozen.pack.target.unitRevision,
        executionReceipt: {
          schemaVersion: 1, kind: "agent-imagegen-execution-receipt", provider: "codex",
          source: "codex-imagegen", attestationLevel: "agent-session-direct",
          cryptographicProviderReceipt: false, callId: panelPrepared.callId,
          model: "built-in image_gen", generatedAt: "2026-07-25T00:00:00.000Z",
        },
      },
    }));
    expect(panelCommitted).toMatchObject({
      status: "succeeded",
      result: {
        generationRunId: panelRun,
        results: {
          status: "pending-review",
          pairComplete: true,
          raw: { targetKind: "panel" },
        },
        review: { status: "pending", autoApproved: false },
      },
    });

    // 正式 prepare run-0001：唯一一次 callAllowed=true。
    const preparedCommand = await executeIdempotentCommand(fixture.root, envelope("prepare-run-0001", {
      command: "prepare_studio_imagegen_call",
      payload: {
        packId: frozen.packId,
        packFingerprint: frozen.fingerprint,
        generationRunId: run1,
        provider: "codex",
        projectContextToken: context.projectContextToken,
        expectedRevision: 0,
      },
    }));
    expect(preparedCommand).toMatchObject({ status: "succeeded", result: { callAllowed: true, idempotentReplay: false } });
    const prepared = preparedCommand.result as {
      callId: string;
      inputFingerprint: string;
      quarantine: { candidatePath: string; receiptPath: string };
    };
    const candidatePath = prepared.quarantine.candidatePath;
    await sharp({ create: { width: 90, height: 160, channels: 3, background: "#2c4257" } })
      .png({ compressionLevel: 0 })
      .toFile(candidatePath);
    const candidateSha256 = sha256(await readFile(candidatePath));

    // ── 负数 3d：伪造 callId（非 prepare 派生）不得 commit（bundle:468-483 call-intent-conflict）。
    await expect(executeIdempotentCommand(fixture.root, envelope("commit-forged-call-id", {
      command: "commit_agent_imagegen_result_bundle",
      payload: {
        projectContextToken: context.projectContextToken,
        packId: frozen.packId,
        packFingerprint: frozen.fingerprint,
        generationRunId: run1,
        provider: "codex",
        rawPath: candidatePath,
        rawSha256: candidateSha256,
        expectedRevision: frozen.pack.target.unitRevision,
        executionReceipt: {
          schemaVersion: 1, kind: "agent-imagegen-execution-receipt", provider: "codex",
          source: "codex-imagegen", attestationLevel: "agent-session-direct",
          cryptographicProviderReceipt: false, callId: "studio-imagegen-call-forged",
          model: "built-in image_gen", generatedAt: "2026-07-25T00:00:01.000Z",
        },
      },
    }))).rejects.toMatchObject({
      name: "RejectedCommandFailure",
      result: { entityType: "studio_generation_result_bundle", code: "call-intent-conflict" },
    });

    // ── 负数 5a：来源不明本地路径（不在 quarantine candidatePath）不得 commit
    //（bundle:322-335 → storage-unsafe；底层 gate 见源码级断言用例）。
    const outsideRawPath = path.join(fixture.root, "fixture-inputs", "gate-audit-outside.png");
    await sharp({ create: { width: 90, height: 160, channels: 3, background: "#5c2c2c" } })
      .png({ compressionLevel: 0 })
      .toFile(outsideRawPath);
    await expect(executeIdempotentCommand(fixture.root, envelope("commit-outside-quarantine", {
      command: "commit_agent_imagegen_result_bundle",
      payload: {
        projectContextToken: context.projectContextToken,
        packId: frozen.packId,
        packFingerprint: frozen.fingerprint,
        generationRunId: run1,
        provider: "codex",
        rawPath: outsideRawPath,
        rawSha256: sha256(await readFile(outsideRawPath)),
        expectedRevision: frozen.pack.target.unitRevision,
        executionReceipt: {
          schemaVersion: 1, kind: "agent-imagegen-execution-receipt", provider: "codex",
          source: "codex-imagegen", attestationLevel: "agent-session-direct",
          cryptographicProviderReceipt: false, callId: prepared.callId,
          model: "built-in image_gen", generatedAt: "2026-07-25T00:00:02.000Z",
        },
      },
    }))).rejects.toMatchObject({
      name: "RejectedCommandFailure",
      result: { entityType: "studio_generation_result_bundle", code: "storage-unsafe" },
    });

    // ── 负数 5b：raw SHA 与候选实际字节不符（未批准候选/机械验收）不得 commit。
    await expect(executeIdempotentCommand(fixture.root, envelope("commit-raw-sha-mismatch", {
      command: "commit_agent_imagegen_result_bundle",
      payload: {
        projectContextToken: context.projectContextToken,
        packId: frozen.packId,
        packFingerprint: frozen.fingerprint,
        generationRunId: run1,
        provider: "codex",
        rawPath: candidatePath,
        rawSha256: "8".repeat(64),
        expectedRevision: frozen.pack.target.unitRevision,
        executionReceipt: {
          schemaVersion: 1, kind: "agent-imagegen-execution-receipt", provider: "codex",
          source: "codex-imagegen", attestationLevel: "agent-session-direct",
          cryptographicProviderReceipt: false, callId: prepared.callId,
          model: "built-in image_gen", generatedAt: "2026-07-25T00:00:03.000Z",
        },
      },
    }))).rejects.toMatchObject({
      name: "RejectedCommandFailure",
      result: { entityType: "studio_generation_result_bundle", code: "raw-sha-mismatch" },
    });
    expect(await readStudioGenerationResultBundle(fixture.root, run1)).toBeNull();

    // 正面对照：合法 commit 成功（证明上述拒绝是门禁而非环境故障）。
    const committed = await executeIdempotentCommand(fixture.root, envelope("commit-run-0001", {
      command: "commit_agent_imagegen_result_bundle",
      payload: {
        projectContextToken: context.projectContextToken,
        packId: frozen.packId,
        packFingerprint: frozen.fingerprint,
        generationRunId: run1,
        provider: "codex",
        rawPath: candidatePath,
        rawSha256: candidateSha256,
        expectedRevision: frozen.pack.target.unitRevision,
        executionReceipt: {
          schemaVersion: 1, kind: "agent-imagegen-execution-receipt", provider: "codex",
          source: "codex-imagegen", attestationLevel: "agent-session-direct",
          cryptographicProviderReceipt: false, callId: prepared.callId,
          model: "built-in image_gen", generatedAt: "2026-07-25T00:00:04.000Z",
        },
      },
    }));
    // ── 负数 6a（的正面锚点）：commit 只落 pending Review，机器绝不 autoApprove。
    expect(committed).toMatchObject({
      status: "succeeded",
      result: {
        generationRunId: run1,
        results: { pairComplete: true },
        review: { status: "pending", autoApproved: false },
      },
    });
    const committedResults = committed.result as {
      results: { raw: { resultId: string }; labeled: { resultId: string } };
      media: { labeled: { sha256: string } };
    };

    // ── 负数 4a：重放 prepare 永不二次授权（一次性 callAllowed 闸）。
    const replayPrepare = await executeIdempotentCommand(fixture.root, envelope("prepare-run-0001-replay", {
      command: "prepare_studio_imagegen_call",
      payload: {
        packId: frozen.packId,
        packFingerprint: frozen.fingerprint,
        generationRunId: run1,
        provider: "codex",
        projectContextToken: context.projectContextToken,
        expectedRevision: 0,
      },
    }));
    expect(replayPrepare).toMatchObject({
      status: "succeeded",
      result: { callId: prepared.callId, callAllowed: false, idempotentReplay: true },
    });

    // ── 负数 4b：已提交结果的 run 不得二次新增（替换候选 → result-conflict）。
    await sharp({ create: { width: 90, height: 160, channels: 3, background: "#6d3f31" } })
      .png({ compressionLevel: 0 })
      .toFile(candidatePath);
    const replacedSha256 = sha256(await readFile(candidatePath));
    await expect(executeIdempotentCommand(fixture.root, envelope("commit-run-0001-second", {
      command: "commit_agent_imagegen_result_bundle",
      payload: {
        projectContextToken: context.projectContextToken,
        packId: frozen.packId,
        packFingerprint: frozen.fingerprint,
        generationRunId: run1,
        provider: "codex",
        rawPath: candidatePath,
        rawSha256: replacedSha256,
        expectedRevision: frozen.pack.target.unitRevision,
        executionReceipt: {
          schemaVersion: 1, kind: "agent-imagegen-execution-receipt", provider: "codex",
          source: "codex-imagegen", attestationLevel: "agent-session-direct",
          cryptographicProviderReceipt: false, callId: prepared.callId,
          model: "built-in image_gen", generatedAt: "2026-07-25T00:00:05.000Z",
        },
      },
    }))).rejects.toMatchObject({
      name: "RejectedCommandFailure",
      result: { entityType: "studio_generation_result_bundle", code: "result-conflict" },
    });

    // ── 负数 4c：已 result-committed 的 call 不得翻供为 not-invoked。
    await expect(executeIdempotentCommand(fixture.root, envelope("reconcile-after-commit", {
      command: "reconcile_studio_imagegen_call",
      payload: {
        callId: prepared.callId,
        projectContextToken: context.projectContextToken,
        result: "not-invoked",
        evidenceReference: "gate-audit-must-not-land",
        evidenceFingerprint: "2".repeat(64),
        expectedRevision: 0,
      },
    }))).rejects.toMatchObject({
      name: "RejectedCommandFailure",
      result: { entityType: "studio_generation_call", code: "call-intent-conflict" },
    });

    // ── 负数 4d：generation_unknown 对账为 not-invoked 后，结果登记被拒（一次性闸闭合）。
    // 先为 run-0001 结果对提交人工 Review 放槽（既有测试同款门禁适配），再派生 run-0002。
    await submitStudioGenerationReview(fixture.root, {
      operationId: "gate-audit-review-run-0001",
      generationRunId: run1,
      kind: "observation",
      expectedHeadRevision: 0,
      rawResultId: committedResults.results.raw.resultId,
      rawSha256: candidateSha256,
      labeledResultId: committedResults.results.labeled.resultId,
      labeledSha256: committedResults.media.labeled.sha256,
      expectedPackFingerprint: frozen.fingerprint,
      continuityFingerprint: frozen.pack.continuityFingerprint,
      decision: "pass",
      criteria: [{ code: "identity-consistency", status: "pass", note: "run-0001 结果对机械验收通过。" }],
      reviewer: "user",
      note: "为 run-0002 not-invoked 对账用例放槽。",
    });
    const run2 = "gate-audit-run-0002";
    await dispatchStudioGenerationPack(fixture.root, {
      packId: frozen.packId,
      packFingerprint: frozen.fingerprint,
      generationRunId: run2,
      provider: "codex",
    });
    const prepared2Command = await executeIdempotentCommand(fixture.root, envelope("prepare-run-0002", {
      command: "prepare_studio_imagegen_call",
      payload: {
        packId: frozen.packId,
        packFingerprint: frozen.fingerprint,
        generationRunId: run2,
        provider: "codex",
        projectContextToken: context.projectContextToken,
        expectedRevision: 0,
      },
    }));
    const prepared2 = prepared2Command.result as { callId: string };
    await executeIdempotentCommand(fixture.root, envelope("reconcile-run-0002-not-invoked", {
      command: "reconcile_studio_imagegen_call",
      payload: {
        callId: prepared2.callId,
        projectContextToken: context.projectContextToken,
        result: "not-invoked",
        evidenceReference: "gate-audit-agent-attests-no-invocation",
        evidenceFingerprint: "3".repeat(64),
        expectedRevision: 0,
      },
    }));
    await expect(executeIdempotentCommand(fixture.root, envelope("commit-run-0002-after-not-invoked", {
      command: "commit_agent_imagegen_result_bundle",
      payload: {
        projectContextToken: context.projectContextToken,
        packId: frozen.packId,
        packFingerprint: frozen.fingerprint,
        generationRunId: run2,
        provider: "codex",
        rawPath: candidatePath,
        rawSha256: replacedSha256,
        expectedRevision: frozen.pack.target.unitRevision,
        executionReceipt: {
          schemaVersion: 1, kind: "agent-imagegen-execution-receipt", provider: "codex",
          source: "codex-imagegen", attestationLevel: "agent-session-direct",
          cryptographicProviderReceipt: false, callId: prepared2.callId,
          model: "built-in image_gen", generatedAt: "2026-07-25T00:00:06.000Z",
        },
      },
    }))).rejects.toMatchObject({
      name: "RejectedCommandFailure",
      result: { entityType: "studio_generation_result_bundle", code: "call-intent-conflict" },
    });
    expect(await readStudioGenerationResultBundle(fixture.root, run2)).toBeNull();
  }, 240_000);

  it("源码级结构断言：无直接生图工具、双系统隔离、受管壳拦截（结构性证据）", () => {
    const root = path.resolve(__dirname, "..");
    const source = (relative: string) => readFileSync(path.join(root, relative), "utf8");

    // ── 结构断言 1：MCP 面不存在任何"直接执行生图"的工具。
    // 正式链中 prepare_studio_imagegen_call 只经 execute_command 暴露为 command，
    // MCP 工具本身从不调模型；生图只可能由外部 Agent 在拿到 callAllowed 后完成。
    // 该断言 pinning：任何未来新增的 generate_image/txt2img 类工具都会立刻破测试。
    const serverSource = source("src/mcp/server.ts");
    const toolNames = [...serverSource.matchAll(/registerTool\(\s*"([^"]+)"/g)].map((match) => match[1]!);
    expect(toolNames.length).toBeGreaterThan(0);
    const directImagegenTools = toolNames.filter((name) => /^(generate_image|generate-image|txt2img|text2image|imagegen|call_imagegen|invoke_imagegen|run_imagegen|submit_imagegen)$/i.test(name));
    expect(directImagegenTools, `MCP 不得注册直接生图工具：${directImagegenTools.join(",")}`).toEqual([]);

    // ── 结构断言 2：旧队列线（generation.ts）与正式账本（studio ledger / 冻结包 /
    // projectContextToken）源码级零互引 —— 两套系统隔离，旧线无法伪造正式身份。
    //（逐行人工核实：generation.ts 全文无 managed/freeze_pack/projectContextToken 引用。）
    const legacyGeneration = source("src/core/generation.ts");
    expect(legacyGeneration).not.toContain("studio-generation-ledger");
    expect(legacyGeneration).not.toContain("projectContextToken");
    expect(legacyGeneration).not.toContain("freeze_studio_generation_pack");

    // ── 结构断言 3：codex.ts 是只读投影 + brief 构造器，源码级无进程/网络执行点，
    // 不可能自行调 Codex CLI 或任何生图 API（人工核实：spawn/exec/fetch 零命中）。
    const codexCore = source("src/core/codex.ts");
    expect(codexCore).not.toContain("child_process");
    expect(codexCore).not.toContain("spawn(");
    expect(codexCore).not.toContain("fetch(");
    expect(codexCore).not.toContain("https.request");

    // ── 结构断言 4：旧队列 UI 对受管壳显式隐藏入队并提示走正式链；
    // canProcess 对 subagentCheckpoint 任务返回 false（UI 层不定向处理子代理任务）。
    const queueView = source("src/renderer/src/components/GenerationQueueView.vue");
    expect(queueView).toContain("受管工程请从画布工作流 / MCP freeze-dispatch 派发");
    expect(queueView).toContain("!job.subagentCheckpoint");

    // ── 结构断言 5：命令总线对受管工程上的旧命令 fail-close 的闸口存在。
    const commandBus = source("src/core/command-bus.ts");
    expect(commandBus).toContain("受管素材工程拒绝旧命令");

    // ── 结构断言 6：quarantine 候选门禁纯函数行为（单元级，无需 fixture）：
    // 候选必须精确等于 pre-call 授予的 candidatePath 且位于 quarantine root 内；
    //  sibling authority 图、根外路径、过小文件一律拒绝。
    const grant = {
      rootPath: path.resolve("/quarantine/call-001"),
      candidatePath: path.resolve("/quarantine/call-001/candidate.png"),
    };
    expect(assertStudioImagegenCandidatePathAllowed(grant, path.resolve("/quarantine/call-001/candidate.png")))
      .toBe(grant.candidatePath);
    expect(() => assertStudioImagegenCandidatePathAllowed(grant, path.resolve("/quarantine/call-001/sibling-authority.png")))
      .toThrowError(expect.objectContaining({ code: "candidate-path-mismatch" }) as unknown as Error);
    expect(() => assertStudioImagegenCandidatePathAllowed(grant, path.resolve("/elsewhere/candidate.png")))
      .toThrowError(expect.objectContaining({ code: "candidate-path-mismatch" }) as unknown as Error);
    expect(() => acceptStudioImagegenCandidateBytes(grant, grant.candidatePath, 0))
      .toThrowError(expect.objectContaining({ code: "candidate-missing" }) as unknown as Error);
    expect(() => acceptStudioImagegenCandidateBytes(grant, grant.candidatePath, 1_999))
      .toThrowError(expect.objectContaining({ code: "candidate-too-small" }) as unknown as Error);
    expect(acceptStudioImagegenCandidateBytes(grant, grant.candidatePath, 20_000)).toMatchObject({ accepted: true });
  });
});
