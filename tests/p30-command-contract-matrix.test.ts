import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";
import {
  executeIdempotentCommand,
  listCommandLedger,
  reconcileCommand,
} from "../src/core/command-bus.js";
import { upsertCommandLedgerEntry } from "../src/core/command-ledger-store.js";
import {
  discoverDuduReadonlyImportProjects,
  finalizeDuduReadonlyManagedProject,
  getActiveDuduReadonlyProjectIdentity,
  getDuduReadonlyImportControl,
  resolveDuduReadonlyImportCommandRoot,
  stageDuduReadonlyManagedProject,
} from "../src/core/dudu-readonly-import.js";
import { readStudioUnitGridGenerationFrozenPack } from "../src/core/studio-generation-ledger.js";
import { getStudioProductionUnitSnapshot } from "../src/core/studio-production.js";
import { getStudioVideoPackageControl } from "../src/core/studio-video-package.js";
import {
  builderInvocationCount,
  createDuduReadonlySourceFixture,
  type DuduReadonlySourceFixture,
} from "./helpers/dudu-readonly-source-fixture.js";

/**
 * P30 S3 合同矩阵：expectedRevision CAS、稳定幂等键、Rejected/Unknown 错误合同、
 * bootstrap scope 明确定位与 durable proof 失败保持 unknown。
 * 只使用临时夹具；不触碰正式工程，不生图，不调视频模型。
 */

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([key, entry]) => [key, stableValue(entry)]));
}

function stableDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stableValue(value)), "utf8").digest("hex");
}

function parseMcpText(result: unknown): any {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return JSON.parse(content.find((entry) => entry.type === "text")?.text ?? "null");
}

async function createMcpClient(registryPath: string): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/mcp/server.ts"],
    cwd: path.resolve(process.cwd()),
    env: { ...process.env, AI_CANVAS_REGISTRY_PATH: registryPath },
    stderr: "pipe",
  });
  const client = new Client({ name: "p30-command-contract-matrix-test", version: "0.1.0" });
  await client.connect(transport);
  return client;
}

async function withFixtureRegistry<T>(fixture: DuduReadonlySourceFixture, run: () => Promise<T>): Promise<T> {
  const prior = process.env.AI_CANVAS_REGISTRY_PATH;
  process.env.AI_CANVAS_REGISTRY_PATH = fixture.registryPath;
  try {
    return await run();
  } finally {
    if (prior === undefined) delete process.env.AI_CANVAS_REGISTRY_PATH;
    else process.env.AI_CANVAS_REGISTRY_PATH = prior;
  }
}

describe.sequential("P30 command 合同矩阵", () => {
  it("stage/finalize expectedRevision≠0 在账本注册前拒绝；MCP 前置 CAS 拒绝返回可重试 CONFLICT 且账本落 failed；scope=dudu-bootstrap 不猜测账本；pid 死亡的 running 记录只转 unknown 不重执行", async () => {
    const fixture = await createDuduReadonlySourceFixture();
    let mcpClient: Client | undefined;
    try {
      await withFixtureRegistry(fixture, async () => {
        const bootstrapRoot = await resolveDuduReadonlyImportCommandRoot(fixture.projectsRoot);

        // 1) expectedRevision≠0：公开入口在账本注册前直接拒绝，不留任何记录，修正后可重试。
        await expect(executeIdempotentCommand(bootstrapRoot, {
          requestId: "p30-matrix-stage-invalid-revision",
          idempotencyKey: "p30-matrix-stage-invalid-revision",
          request: {
            command: "stage_dudu_readonly_managed_project",
            payload: {
              projectsRoot: fixture.projectsRoot,
              source: fixture.source,
              expectedRevision: 1 as 0,
              expectedDiscoveryFingerprint: "0".repeat(64),
            },
          },
        })).rejects.toThrow(/expectedRevision 必须为 0/u);
        await expect(executeIdempotentCommand(path.join(fixture.root, "no-managed-project"), {
          requestId: "p30-matrix-finalize-invalid-revision",
          idempotencyKey: "p30-matrix-finalize-invalid-revision",
          request: {
            command: "finalize_dudu_readonly_managed_project",
            payload: {
              source: fixture.source,
              expectedRevision: 1 as 0,
              expectedDiscoveryFingerprint: "0".repeat(64),
              expectedImportFingerprint: "0".repeat(64),
              expectedControlFingerprint: "0".repeat(64),
            },
          },
        })).rejects.toThrow(/expectedRevision 必须为 0/u);
        expect(await listCommandLedger(bootstrapRoot)).toEqual([]);

        // 2) MCP 面：前置 CAS（stale discovery 指纹）拒绝必须分类为可重试 CONFLICT，
        //    账本只落 failed（applied:false），不得误锁成 unknown。
        mcpClient = await createMcpClient(fixture.registryPath);
        const staleStage = await mcpClient.callTool({
          name: "execute_command",
          arguments: {
            projectRoot: fixture.projectsRoot,
            requestId: "p30-matrix-mcp-stale-stage-request",
            idempotencyKey: "p30-matrix-mcp-stale-stage-key",
            request: {
              command: "stage_dudu_readonly_managed_project",
              payload: {
                projectsRoot: fixture.projectsRoot,
                source: fixture.source,
                expectedRevision: 0,
                expectedDiscoveryFingerprint: "0".repeat(64),
              },
            },
          },
        });
        expect(staleStage.isError).toBe(true);
        const staleStagePayload = parseMcpText(staleStage);
        expect(staleStagePayload, JSON.stringify(staleStagePayload)).toMatchObject({
          error: { code: "CONFLICT", retryable: true, applied: false, reason: "control_conflict" },
        });
        // 回包有界且不泄露内部账本拓扑。
        expect(JSON.stringify(staleStage).length).toBeLessThan(256 * 1024);
        const bootstrapLedger = parseMcpText(await mcpClient.callTool({
          name: "list_command_ledger",
          arguments: { projectRoot: fixture.projectsRoot, scope: "dudu-bootstrap", limit: 20 },
        })) as Array<Record<string, unknown>>;
        expect(bootstrapLedger).toEqual(expect.arrayContaining([
          expect.objectContaining({
            idempotencyKey: "p30-matrix-mcp-stale-stage-key",
            command: "stage_dudu_readonly_managed_project",
            status: "failed",
            replayed: false,
          }),
        ]));
        expect(JSON.stringify(bootstrapLedger)).not.toContain("durableReconciliation");
        expect(JSON.stringify(bootstrapLedger)).not.toContain("storageRoot");
        expect(JSON.stringify(bootstrapLedger)).not.toContain(".aicanvas-dudu-import-transactions");

        // 3) scope=dudu-bootstrap 只映射固定 transaction root：传工程根/错误根不得扫描猜测到其他账本。
        const wrongRoot = path.join(fixture.root, "some-project-root");
        await mkdir(wrongRoot, { recursive: true });
        const wrongScopeLedger = parseMcpText(await mcpClient.callTool({
          name: "list_command_ledger",
          arguments: { projectRoot: wrongRoot, scope: "dudu-bootstrap", limit: 20 },
        })) as Array<Record<string, unknown>>;
        expect(wrongScopeLedger).toEqual([]);
        const wrongScopeReconcile = await mcpClient.callTool({
          name: "reconcile_command",
          arguments: { projectRoot: wrongRoot, scope: "dudu-bootstrap", idempotencyKey: "p30-matrix-mcp-stale-stage-key" },
        });
        expect(wrongScopeReconcile.isError).toBe(true);
        expect(parseMcpText(wrongScopeReconcile).error?.message ?? "").toMatch(/找不到幂等键/u);

        // 4) 伪造 pid 已死亡的 running 记录：reconcile 只转 executor-lost unknown，绝不重新执行。
        const deadRequest = {
          command: "stage_dudu_readonly_managed_project" as const,
          payload: {
            projectsRoot: fixture.projectsRoot,
            source: fixture.source,
            expectedRevision: 0 as const,
            expectedDiscoveryFingerprint: "0".repeat(64),
          },
        };
        const deadStartedAt = new Date(Date.now() - 60_000).toISOString();
        await upsertCommandLedgerEntry(bootstrapRoot, {
          schemaVersion: 1,
          requestId: "p30-matrix-dead-executor-request",
          idempotencyKey: "p30-matrix-dead-executor-key",
          command: "stage_dudu_readonly_managed_project",
          status: "running",
          replayed: false,
          requestHash: stableDigest({ projectRoot: path.resolve(bootstrapRoot), request: deadRequest }),
          execution: { pid: 4_194_303, phase: "executing", heartbeatAt: deadStartedAt },
          durableReconciliation: { schemaVersion: 1, request: deadRequest },
          startedAt: deadStartedAt,
        }, deadStartedAt);
        const deadReconcile = parseMcpText(await mcpClient.callTool({
          name: "reconcile_command",
          arguments: { projectRoot: fixture.projectsRoot, scope: "dudu-bootstrap", idempotencyKey: "p30-matrix-dead-executor-key" },
        }));
        expect(deadReconcile).toMatchObject({ status: "unknown", replayed: true });
        expect(deadReconcile.error?.message ?? "").toMatch(/已退出/u);
        // 没有发生任何 staging 副作用：projectsRoot 仍然没有任何候选。
        const discovery = await discoverDuduReadonlyImportProjects(fixture.projectsRoot);
        expect(discovery).toMatchObject({ status: "none", candidateCount: 0 });
      });
    } finally {
      await mcpClient?.close().catch(() => undefined);
      await fixture.cleanup();
    }
  }, 120_000);

  it("prepare/build expectedRevision 漂移返回 revision_conflict Rejected：可修正重试、副作用零发生", async () => {
    const fixture = await createDuduReadonlySourceFixture();
    try {
      await withFixtureRegistry(fixture, async () => {
        const staged = await stageDuduReadonlyManagedProject({
          projectsRoot: fixture.projectsRoot,
          source: fixture.source,
        });
        const projectRoot = staged.shell.paths.root;
        // 视频包导出要求精确激活且完整闭包的 Dudu owner：先完成真实 finalize 流程。
        await finalizeDuduReadonlyManagedProject(projectRoot, fixture.source);
        const u13 = staged.receipt.units.find((unit) => unit.unitId === "S1E01-U13")!;
        const pack = await readStudioUnitGridGenerationFrozenPack(projectRoot, u13.packId!);
        expect(pack).not.toBeNull();
        const authority = { kind: "historical-import" as const, packId: u13.packId! };
        const counterPath = path.join(fixture.root, "builder-counter.txt");
        process.env.P30_TEST_BUILDER_COUNTER = counterPath;

        // prepare：控制面指纹正确但 expectedRevision 漂移 → revision_conflict（非 control_conflict）。
        const beforePrepare = await getStudioVideoPackageControl(projectRoot, { by: "authority-latest", authority });
        const stalePrepareRequest = {
          command: "prepare_studio_video_package_export" as const,
          payload: {
            authority,
            expectedRevision: pack!.target.unitRevision + 1,
            expectedControlFingerprint: beforePrepare.fingerprint,
          },
        };
        await expect(executeIdempotentCommand(projectRoot, {
          requestId: "p30-matrix-prepare-stale-request",
          idempotencyKey: "p30-matrix-prepare-stale-key",
          request: stalePrepareRequest,
        })).rejects.toMatchObject({
          name: "RejectedCommandFailure",
          result: { applied: false, reason: "revision_conflict" },
        });
        // 账本落 failed 而非 unknown；同键只报已明确失败，不重放。
        const [failedPrepare] = await listCommandLedger(projectRoot);
        expect(failedPrepare).toMatchObject({
          idempotencyKey: "p30-matrix-prepare-stale-key",
          status: "failed",
          result: { applied: false, reason: "revision_conflict" },
        });
        await expect(executeIdempotentCommand(projectRoot, {
          requestId: "p30-matrix-prepare-stale-replay-request",
          idempotencyKey: "p30-matrix-prepare-stale-key",
          request: stalePrepareRequest,
        })).rejects.toThrow(/已明确失败/u);
        // 修正 expectedRevision 后换新键成功（prepare 不启动 builder）。
        const prepared = await executeIdempotentCommand(projectRoot, {
          requestId: "p30-matrix-prepare-ok-request",
          idempotencyKey: "p30-matrix-prepare-ok-key",
          request: {
            command: "prepare_studio_video_package_export",
            payload: {
              authority,
              expectedRevision: pack!.target.unitRevision,
              expectedControlFingerprint: beforePrepare.fingerprint,
            },
          },
        });
        expect(prepared).toMatchObject({ status: "succeeded", replayed: false });
        const intentId = (prepared.result as { intent: { intentId: string } }).intent.intentId;

        // build：intent 指纹正确但 expectedRevision 漂移 → revision_conflict；builder 零调用。
        const intentControl = await getStudioVideoPackageControl(projectRoot, { by: "intent", intentId });
        const authorityControl = await getStudioVideoPackageControl(projectRoot, { by: "authority-latest", authority });
        await expect(executeIdempotentCommand(projectRoot, {
          requestId: "p30-matrix-build-stale-request",
          idempotencyKey: "p30-matrix-build-stale-key",
          request: {
            command: "build_studio_video_package",
            payload: {
              intentId,
              expectedRevision: pack!.target.unitRevision + 1,
              expectedIntentControlFingerprint: intentControl.fingerprint,
              expectedAuthorityControlFingerprint: authorityControl.fingerprint,
              destinationPolicy: "managed-evidence-only",
            },
          },
        })).rejects.toMatchObject({
          name: "RejectedCommandFailure",
          result: {
            applied: false,
            reason: "revision_conflict",
            expectedRevision: pack!.target.unitRevision + 1,
            currentRevision: pack!.target.unitRevision,
          },
        });
        expect(await builderInvocationCount(counterPath)).toBe(0);
        const buildLedger = await listCommandLedger(projectRoot);
        expect(buildLedger.find((record) => record.idempotencyKey === "p30-matrix-build-stale-key"))
          .toMatchObject({ status: "failed", result: { applied: false } });
      });
    } finally {
      delete process.env.P30_TEST_BUILDER_COUNTER;
      await fixture.cleanup();
    }
  }, 180_000);

  it("crash-after-stage 转 unknown；来源漂移时 durable proof 拒绝匹配并保持 unknown、禁止重放、不二次写入；恢复来源后可对账", async () => {
    const fixture = await createDuduReadonlySourceFixture();
    const priorCrash = process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE;
    try {
      await withFixtureRegistry(fixture, async () => {
        const bootstrapRoot = await resolveDuduReadonlyImportCommandRoot(fixture.projectsRoot);
        const discovery = await discoverDuduReadonlyImportProjects(fixture.projectsRoot);
        const stageRequest = {
          command: "stage_dudu_readonly_managed_project" as const,
          payload: {
            projectsRoot: fixture.projectsRoot,
            source: fixture.source,
            expectedRevision: 0 as const,
            expectedDiscoveryFingerprint: discovery.fingerprint,
          },
        };

        // 副作用提交后、终态落账前崩溃：记录锁为 unknown。
        process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE = "stage_dudu_readonly_managed_project";
        await expect(executeIdempotentCommand(bootstrapRoot, {
          requestId: "p30-matrix-stage-crash-request",
          idempotencyKey: "p30-matrix-stage-crash-key",
          request: stageRequest,
        })).rejects.toThrow(/执行结果未确认/u);
        if (priorCrash === undefined) delete process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE;
        else process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE = priorCrash;
        const [unknownRecord] = await listCommandLedger(bootstrapRoot);
        expect(unknownRecord).toMatchObject({ status: "unknown", replayed: false });

        // 不可变来源漂移：durable proof 必须拒绝匹配，同键重执行保持 unknown、禁止自动重放。
        const contractPath = path.join(fixture.productionRoot, "00_唯一长期执行合同_v2.md");
        const originalContract = await readFile(contractPath);
        await appendFile(contractPath, "\n# p30 matrix immutable drift\n");
        await expect(executeIdempotentCommand(bootstrapRoot, {
          requestId: "p30-matrix-stage-crash-retry-request",
          idempotencyKey: "p30-matrix-stage-crash-key",
          request: stageRequest,
        })).rejects.toThrow(/保持 unknown，禁止自动重放/u);
        const [stillUnknown] = await listCommandLedger(bootstrapRoot);
        expect(stillUnknown).toMatchObject({ status: "unknown" });
        // 不得二次写入：候选目录仍是崩溃时的唯一一个，discovery 不新增、不消失。
        const discoveryAfterDrift = await discoverDuduReadonlyImportProjects(fixture.projectsRoot);
        expect(discoveryAfterDrift.candidates.length).toBe(1);

        // 恢复来源后，proof 重新闭合：同一 unknown 记录可对账为 succeeded 且不重新执行 staging。
        await writeFile(contractPath, originalContract);
        const reconciled = await reconcileCommand(bootstrapRoot, { idempotencyKey: "p30-matrix-stage-crash-key" });
        expect(reconciled).toMatchObject({
          status: "succeeded",
          replayed: true,
          result: { kind: "dudu-readonly-stage-command-outcome", replayed: true, reconciled: true },
        });
        const discoveryAfterReconcile = await discoverDuduReadonlyImportProjects(fixture.projectsRoot);
        expect(discoveryAfterReconcile.candidates.length).toBe(1);
      });
    } finally {
      if (priorCrash === undefined) delete process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE;
      else process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE = priorCrash;
      await fixture.cleanup();
    }
  }, 180_000);

  it("crash-after-finalize 转 unknown；权威身份漂移时保持 unknown，闭合后恢复 succeeded", async () => {
    const fixture = await createDuduReadonlySourceFixture();
    const priorCrash = process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE;
    try {
      await withFixtureRegistry(fixture, async () => {
        const staged = await stageDuduReadonlyManagedProject({
          projectsRoot: fixture.projectsRoot,
          source: fixture.source,
        });
        const projectRoot = staged.shell.paths.root;
        const stagingControl = await getDuduReadonlyImportControl(projectRoot);
        const discovery = await discoverDuduReadonlyImportProjects(fixture.projectsRoot);
        const finalizeRequest = {
          command: "finalize_dudu_readonly_managed_project" as const,
          payload: {
            source: fixture.source,
            expectedRevision: 0 as const,
            expectedDiscoveryFingerprint: discovery.fingerprint,
            expectedImportFingerprint: staged.receipt.fingerprint,
            expectedControlFingerprint: stagingControl.fingerprint,
          },
        };

        process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE = "finalize_dudu_readonly_managed_project";
        await expect(executeIdempotentCommand(projectRoot, {
          requestId: "p30-matrix-finalize-crash-request",
          idempotencyKey: "p30-matrix-finalize-crash-key",
          request: finalizeRequest,
        })).rejects.toThrow(/执行结果未确认/u);
        if (priorCrash === undefined) delete process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE;
        else process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE = priorCrash;
        const [unknownFinalize] = await listCommandLedger(projectRoot);
        expect(unknownFinalize).toMatchObject({ status: "unknown" });

        // finalize 的 durable proof 依赖 registration/activation 闭包；篡改 import 指纹后证明必须失败。
        await expect(executeIdempotentCommand(projectRoot, {
          requestId: "p30-matrix-finalize-crash-retry-request",
          idempotencyKey: "p30-matrix-finalize-crash-key",
          request: {
            ...finalizeRequest,
            payload: { ...finalizeRequest.payload, expectedImportFingerprint: "f".repeat(64) },
          },
        })).rejects.toThrow(/幂等键已用于不同参数/u);

        // 正确请求重放：proof 闭合，恢复 succeeded，registration/activation 幂等不重复建立。
        const recovered = await executeIdempotentCommand(projectRoot, {
          requestId: "p30-matrix-finalize-recover-request",
          idempotencyKey: "p30-matrix-finalize-crash-key",
          request: finalizeRequest,
        });
        expect(recovered).toMatchObject({
          status: "succeeded",
          replayed: true,
          result: {
            kind: "dudu-readonly-managed-finalization",
            replayedRegistration: true,
            replayedActivation: true,
          },
        });
        const replayedAgain = await finalizeDuduReadonlyManagedProject(projectRoot, fixture.source);
        expect(replayedAgain).toMatchObject({ replayedRegistration: true, replayedActivation: true });

        // active Dudu 是生产 owner，不是永远冻结在导入时计数的 staging 快照。
        // 通过统一 command ledger 追加 prompt revision 并推进 unit head 后，身份门仍应接受
        // 稳定 head 数不变、revision/Binding/生成等 append-only 计数单调增长的合法生产演进。
        const before = await getStudioProductionUnitSnapshot(projectRoot, "S1E01-U29");
        expect(before).not.toBeNull();
        const firstPanel = before!.panels[0]!;
        const promptAppend = await executeIdempotentCommand(projectRoot, {
          requestId: "p30-matrix-dudu-evolving-prompt-request",
          idempotencyKey: "p30-matrix-dudu-evolving-prompt-key",
          request: {
            command: "append_studio_prompt_revision",
            payload: {
              documentId: firstPanel.promptRevision.documentId,
              expectedRevision: firstPanel.promptRevision.ordinal,
              body: `${firstPanel.promptRevision.body}\n\nP30 fixture：明确禁见画外角色。`,
              source: "p30-fixture",
              sourceVersion: "append-only-owner-v1",
            },
          },
        });
        const promptRevisionId = (promptAppend.result as { revision: { id: string } }).revision.id;
        const revise = await executeIdempotentCommand(projectRoot, {
          requestId: "p30-matrix-dudu-evolving-unit-request",
          idempotencyKey: "p30-matrix-dudu-evolving-unit-key",
          request: {
            command: "revise_studio_production_unit",
            payload: {
              unitId: before!.unit.id,
              expectedRevision: before!.unit.revision,
              season: before!.unit.season,
              episode: before!.unit.episode,
              sequence: before!.unit.sequence,
              title: before!.unit.title,
              durationSeconds: before!.unit.durationSeconds,
              scriptRevisionId: before!.unit.scriptRevisionId,
              panels: before!.panels.map((panel, index) => ({
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
                promptRevisionId: index === 0 ? promptRevisionId : panel.promptRevisionId,
                sourceSpans: panel.sourceSpans.map((span) => ({
                  startOffsetUtf16: span.startOffsetUtf16,
                  endOffsetUtf16: span.endOffsetUtf16,
                })),
                assets: panel.assets.map((mention) => ({
                  assetId: mention.assetId,
                  category: mention.category,
                  presence: mention.presence,
                  role: mention.role,
                  continuityState: mention.continuityState,
                  evidence: mention.evidence.map((entry) => ({
                    kind: entry.kind,
                    reference: entry.reference,
                    note: entry.note,
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
        });
        expect(revise.result).toMatchObject({ unit: { id: "S1E01-U29", revision: 2 } });
        await expect(getActiveDuduReadonlyProjectIdentity(projectRoot)).resolves.toMatchObject({
          projectId: staged.shell.project.id,
          projectRoot,
        });
      });
    } finally {
      if (priorCrash === undefined) delete process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE;
      else process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE = priorCrash;
      await fixture.cleanup();
    }
  }, 240_000);
});
