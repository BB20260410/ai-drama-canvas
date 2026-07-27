import { createHash } from "node:crypto";
import { appendFile, lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import sharp from "sharp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";
import { getActiveManagedStudioContext } from "../src/core/active-managed-studio-context.js";
import { executeIdempotentCommand } from "../src/core/command-bus.js";
import { listRegisteredProjects, registerProject } from "../src/core/sidecar.js";
import {
  duduReadonlySourceRequestMatchesReceipt,
  discoverDuduReadonlyImportProjects,
  finalizeDuduReadonlyManagedProject,
  getActiveDuduReadonlyProjectIdentity,
  getDuduReadonlyImportControl,
  proveDuduReadonlyFinalizationOutcome,
  proveDuduReadonlyStageCommandOutcome,
  resolveDuduReadonlyImportCommandRoot,
  stageDuduReadonlyManagedProject,
} from "../src/core/dudu-readonly-import.js";
import { inspectDuduReadonlySources, type DuduReadonlySourceInput } from "../src/core/dudu-readonly-source.js";
import { commitAgentImagegenResultBundle } from "../src/core/studio-agent-imagegen-result-bundle.js";
import { runStudioCanvasWorkflowGroup } from "../src/core/studio-canvas-workflow-runner.js";
import {
  dispatchStudioGenerationPack,
  prepareStudioImagegenCall,
  readStudioUnitGridGenerationFrozenPack,
} from "../src/core/studio-generation-ledger.js";
import { submitStudioGenerationReview } from "../src/core/studio-generation-review.js";
import { importStudioMedia } from "../src/core/material-studio.js";
import {
  getStudioPostResultObservationControl,
  submitStudioPostResultObservation,
} from "../src/core/studio-post-result-observation.js";
import { getStudioProductionUnitSnapshot } from "../src/core/studio-production.js";
import {
  buildAndVerifyStudioVideoPackage,
  getStudioVideoPackageControl,
  getStudioVideoPackageExportControl,
  prepareStudioVideoPackageExport,
  prepareStudioVideoPackagePublication,
  prepareStudioVideoPackageSource,
  publishStudioVideoPackageReplacement,
  readStudioVideoPackageExportIntentByOperationId,
  StudioVideoPackageError,
} from "../src/core/studio-video-package.js";
import {
  builderInvocationCount,
  createDuduReadonlySourceFixture,
} from "./helpers/dudu-readonly-source-fixture.js";

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

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

async function waitForPath(filePath: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await lstat(filePath).catch(() => null))) {
    if (Date.now() >= deadline) throw new Error(`等待测试路径超时：${filePath}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function parseMcpText(result: unknown): any {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return JSON.parse(content.find((entry) => entry.type === "text")?.text ?? "null");
}

async function createP30McpClient(registryPath: string): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/mcp/server.ts"],
    cwd: path.resolve(process.cwd()),
    env: { ...process.env, AI_CANVAS_REGISTRY_PATH: registryPath },
    stderr: "pipe",
  });
  const client = new Client({ name: "p30-dudu-bootstrap-ledger-test", version: "0.1.0" });
  await client.connect(transport);
  return client;
}

async function readOnlySurfaceSnapshot(input: {
  sidecar: string;
  databases: string[];
  registryPath: string;
}): Promise<unknown> {
  const paths = [
    ...input.databases.flatMap((database) => [database, `${database}-wal`, `${database}-shm`]),
    input.registryPath,
    path.join(path.dirname(input.registryPath), "active-project.json"),
  ];
  const files: Record<string, unknown> = {};
  for (const filePath of paths) {
    const metadata = await lstat(filePath, { bigint: true }).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    files[filePath] = metadata ? {
      size: metadata.size.toString(),
      mtimeNs: metadata.mtimeNs.toString(),
      ctimeNs: metadata.ctimeNs.toString(),
      sha256: metadata.isFile() ? sha256(await readFile(filePath)) : null,
    } : null;
  }
  const locksPath = path.join(input.sidecar, "locks");
  const lockNames = await readdir(locksPath).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return [] as string[];
    throw error;
  });
  return { files, lockNames: [...lockNames].sort() };
}

describe.sequential("P30 Studio 视频包 owner", () => {
  it("以活动 Dudu 身份完成历史采用、只读门、receipt 重放和 Review 派生包", async () => {
    const fixture = await createDuduReadonlySourceFixture();
    const priorRegistry = process.env.AI_CANVAS_REGISTRY_PATH;
    const priorCounter = process.env.P30_TEST_BUILDER_COUNTER;
    const priorBuilderFault = process.env.P30_TEST_BUILDER_FAULT;
    const priorInstallFault = process.env.P30_TEST_INSTALL_FAULT;
    const priorPythonPath = process.env.PYTHONPATH;
    const priorCommandCrash = process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE;
    const priorFinalCasBarrier = process.env.P30_TEST_VIDEO_PACKAGE_FINAL_CAS_BARRIER;
    const priorReceiptCasBarrier = process.env.P30_TEST_VIDEO_PACKAGE_RECEIPT_CAS_BARRIER;
    const priorReceiptPostCasBarrier = process.env.P30_TEST_VIDEO_PACKAGE_RECEIPT_POST_CAS_BARRIER;
    let mcpClient: Client | undefined;
    process.env.AI_CANVAS_REGISTRY_PATH = fixture.registryPath;
    const counterPath = path.join(fixture.root, "builder-counter.txt");
    process.env.P30_TEST_BUILDER_COUNTER = counterPath;
    try {
      const initialDiscovery = await discoverDuduReadonlyImportProjects(fixture.projectsRoot);
      const bootstrapCommandRoot = await resolveDuduReadonlyImportCommandRoot(fixture.projectsRoot);
      const bootstrapRequest = {
        command: "stage_dudu_readonly_managed_project" as const,
        payload: {
          projectsRoot: fixture.projectsRoot,
          source: fixture.source,
          expectedRevision: 0 as const,
          expectedDiscoveryFingerprint: initialDiscovery.fingerprint,
        },
      };
      const bootstrapCommandHash = stableDigest({
        projectRoot: path.resolve(bootstrapCommandRoot),
        request: bootstrapRequest,
      });
      process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE = "stage_dudu_readonly_managed_project";
      await expect(executeIdempotentCommand(bootstrapCommandRoot, {
        requestId: "p30-dudu-bootstrap-request-0001",
        idempotencyKey: "p30-dudu-bootstrap-key-0001",
        request: bootstrapRequest,
      })).rejects.toThrow(/执行结果未确认/u);
      if (priorCommandCrash === undefined) delete process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE;
      else process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE = priorCommandCrash;
      mcpClient = await createP30McpClient(fixture.registryPath);
      const bootstrap = parseMcpText(await mcpClient.callTool({
        name: "reconcile_command",
        arguments: {
          projectRoot: fixture.projectsRoot,
          scope: "dudu-bootstrap",
          idempotencyKey: "p30-dudu-bootstrap-key-0001",
        },
      }));
      expect(bootstrap).toMatchObject({
        status: "succeeded",
        replayed: true,
        result: {
          kind: "dudu-readonly-stage-command-outcome",
          counts: { units: 33, panels: 112 },
          replayed: true,
          reconciled: true,
        },
      });
      const bootstrapLedger = parseMcpText(await mcpClient.callTool({
        name: "list_command_ledger",
        arguments: { projectRoot: fixture.projectsRoot, scope: "dudu-bootstrap", limit: 20 },
      })) as Array<Record<string, unknown>>;
      expect(bootstrapLedger).toEqual(expect.arrayContaining([
        expect.objectContaining({
          idempotencyKey: "p30-dudu-bootstrap-key-0001",
          command: "stage_dudu_readonly_managed_project",
          status: "succeeded",
        }),
      ]));
      const bootstrapLedgerJson = JSON.stringify(bootstrapLedger);
      expect(bootstrapLedgerJson).not.toContain(".aicanvas-dudu-import-transactions");
      expect(bootstrapLedgerJson).not.toContain("durableReconciliation");
      expect(bootstrapLedgerJson).not.toContain("storageRoot");
      const wrongScopeLedger = parseMcpText(await mcpClient.callTool({
        name: "list_command_ledger",
        arguments: { projectRoot: fixture.projectsRoot, scope: "project", limit: 20 },
      })) as Array<Record<string, unknown>>;
      expect(wrongScopeLedger.some((record) => record.idempotencyKey === "p30-dudu-bootstrap-key-0001")).toBe(false);
      await expect(proveDuduReadonlyStageCommandOutcome({
        projectsRoot: fixture.projectsRoot,
        source: fixture.source,
      }, bootstrapCommandHash)).resolves.toMatchObject({
        kind: "dudu-readonly-stage-command-outcome",
        importFingerprint: expect.any(String),
      });
      await expect(proveDuduReadonlyStageCommandOutcome({
        projectsRoot: fixture.projectsRoot,
        source: fixture.source,
      }, "0".repeat(64))).resolves.toBeNull();
      await expect(proveDuduReadonlyStageCommandOutcome({
        projectsRoot: fixture.projectsRoot,
        source: { ...fixture.source, contractRelativePath: "wrong-contract-override.md" },
      }, bootstrapCommandHash)).resolves.toBeNull();
      await expect(executeIdempotentCommand(bootstrapCommandRoot, {
        requestId: "p30-dudu-bootstrap-request-stale-0002",
        idempotencyKey: "p30-dudu-bootstrap-key-stale-0002",
        request: bootstrapRequest,
      })).rejects.toMatchObject({
        name: "RejectedCommandFailure",
        result: { applied: false, reason: "control_conflict" },
      });
      const staged = await stageDuduReadonlyManagedProject({
        projectsRoot: fixture.projectsRoot,
        source: fixture.source,
      });
      const stagedReplay = await stageDuduReadonlyManagedProject({
        projectsRoot: fixture.projectsRoot,
        source: fixture.source,
      });
      expect(stagedReplay).toMatchObject({
        replayed: true,
        shell: { project: { id: staged.shell.project.id } },
        receipt: { fingerprint: staged.receipt.fingerprint },
      });
      await expect(runStudioCanvasWorkflowGroup(staged.shell.paths.root, {
        id: "p30-dudu-panel-fallback-guard",
        title: "Dudu panel fallback 安全门",
        panelIds: ["must-not-dispatch-panel"],
        pipeline: ["image"],
        createdAt: "2026-07-22T00:00:00.000Z",
      }, {
        provider: "codex",
        targets: [{ targetKind: "panel", panelId: "must-not-dispatch-panel", unitId: "S1E01-U28" }],
      })).rejects.toMatchObject({ code: "unit-grid-target-required" });
      const selectorMatrix = [
        ["contractRelativePath", "00_唯一长期执行合同_v2.md"],
        ["machineStateRelativePath", "02_出图总表/00_S1E1_生产状态.json"],
        ["referenceRegistryRelativePath", "01_视觉资产锁/00_允许参考资产.json"],
        ["visualCanonRevisionRelativePath", "00_视觉正典_v2/00_视觉正典修订说明.md"],
        ["visualExecutionRelativePath", "00_视觉正典_v2/episodes/S1E1_树下的家_视觉执行v2.md"],
        ["visualConflictDecisionRelativePath", "01_视觉资产锁/00_正典冲突与执行裁决.md"],
        ["meteorVfxRuleRelativePath", "01_视觉资产锁/04_特殊规则/rule-liuxingdeng-v2_故事卡.md"],
      ] as const satisfies ReadonlyArray<readonly [keyof DuduReadonlySourceInput, string]>;
      expect(duduReadonlySourceRequestMatchesReceipt(staged.inspection, staged.receipt)).toBe(true);
      for (const [selector, defaultRelativePath] of selectorMatrix) {
        const explicitSource = { ...fixture.source, [selector]: defaultRelativePath };
        const explicitInspection = await inspectDuduReadonlySources(explicitSource);
        expect(duduReadonlySourceRequestMatchesReceipt(explicitInspection, staged.receipt), selector).toBe(true);

        const alternateRelativePath = `p30-selector-matrix/${selector}-${path.basename(defaultRelativePath)}`;
        const alternateAbsolutePath = path.join(fixture.productionRoot, alternateRelativePath);
        await mkdir(path.dirname(alternateAbsolutePath), { recursive: true });
        await writeFile(alternateAbsolutePath, await readFile(path.join(fixture.productionRoot, defaultRelativePath)));
        const alternateInspection = await inspectDuduReadonlySources({
          ...fixture.source,
          [selector]: alternateRelativePath,
        });
        expect(duduReadonlySourceRequestMatchesReceipt(alternateInspection, staged.receipt), selector).toBe(false);
        await expect(inspectDuduReadonlySources({
          ...fixture.source,
          [selector]: `p30-selector-matrix/missing-${selector}`,
        }), selector).rejects.toThrow();
      }
      await expect(proveDuduReadonlyStageCommandOutcome({
        projectsRoot: fixture.projectsRoot,
        source: Object.fromEntries([
          ...Object.entries(fixture.source),
          ...selectorMatrix,
        ]) as unknown as DuduReadonlySourceInput,
      }, bootstrapCommandHash)).resolves.toMatchObject({ importFingerprint: staged.receipt.fingerprint });
      const stagingReadOnlyBefore = await readOnlySurfaceSnapshot({
        sidecar: staged.shell.paths.sidecar,
        databases: [
          staged.shell.paths.materialDatabase,
          staged.shell.paths.productionDatabase,
          staged.shell.paths.generationDatabase,
        ],
        registryPath: fixture.registryPath,
      });
      const stagingControl = await getDuduReadonlyImportControl(staged.shell.paths.root);
      const stagingReadOnlyAfter = await readOnlySurfaceSnapshot({
        sidecar: staged.shell.paths.sidecar,
        databases: [
          staged.shell.paths.materialDatabase,
          staged.shell.paths.productionDatabase,
          staged.shell.paths.generationDatabase,
        ],
        registryPath: fixture.registryPath,
      });
      expect(stagingReadOnlyAfter).toEqual(stagingReadOnlyBefore);
      expect(stagingControl).toMatchObject({
        status: "staging-verified",
        counts: { units: 33, panels: 112, durationSeconds: 492, generationDispatches: 0, generationCallIntents: 0 },
        registration: { registered: false },
        activation: { active: false },
        nextAction: "finalize-registration-and-activation-via-authorized-core-orchestration",
        readOnly: true,
      });
      const finalizeDiscovery = await discoverDuduReadonlyImportProjects(fixture.projectsRoot);
      const finalizeRequest = {
        command: "finalize_dudu_readonly_managed_project" as const,
        payload: {
          source: fixture.source,
          expectedRevision: 0 as const,
          expectedDiscoveryFingerprint: finalizeDiscovery.fingerprint,
          expectedImportFingerprint: stagingControl.identity.importReceiptFingerprint!,
          expectedControlFingerprint: stagingControl.fingerprint,
        },
      };
      const finalizeCommandHash = stableDigest({
        projectRoot: path.resolve(staged.shell.paths.root),
        request: finalizeRequest,
      });
      process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE = "finalize_dudu_readonly_managed_project";
      await expect(executeIdempotentCommand(staged.shell.paths.root, {
        requestId: "p30-dudu-finalize-request-0001",
        idempotencyKey: "p30-dudu-finalize-key-0001",
        request: finalizeRequest,
      })).rejects.toThrow(/执行结果未确认/u);
      if (priorCommandCrash === undefined) delete process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE;
      else process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE = priorCommandCrash;
      const finalizeRecovered = await executeIdempotentCommand(staged.shell.paths.root, {
        requestId: "p30-dudu-finalize-recover-request-0002",
        idempotencyKey: "p30-dudu-finalize-key-0001",
        request: finalizeRequest,
      });
      expect(finalizeRecovered).toMatchObject({
        status: "succeeded",
        replayed: true,
        result: {
          kind: "dudu-readonly-managed-finalization",
          projectRoot: staged.shell.paths.root,
          importFingerprint: staged.receipt.fingerprint,
          replayedRegistration: true,
          replayedActivation: true,
        },
      });
      await expect(proveDuduReadonlyFinalizationOutcome(
        staged.shell.paths.root,
        fixture.source,
        staged.receipt.fingerprint,
        finalizeCommandHash,
      )).resolves.toMatchObject({ projectRoot: staged.shell.paths.root });
      await expect(proveDuduReadonlyFinalizationOutcome(
        staged.shell.paths.root,
        fixture.source,
        staged.receipt.fingerprint,
        "0".repeat(64),
      )).resolves.toBeNull();
      const finalized = finalizeRecovered.result as Awaited<ReturnType<typeof finalizeDuduReadonlyManagedProject>>;
      const concurrentFinalizations = await Promise.all([
        finalizeDuduReadonlyManagedProject(staged.shell.paths.root, fixture.source),
        finalizeDuduReadonlyManagedProject(staged.shell.paths.root, fixture.source),
      ]);
      expect(new Set(concurrentFinalizations.map((item) => item.activationId)).size).toBe(1);
      expect(concurrentFinalizations.every((item) => item.replayedRegistration)).toBe(true);
      expect(concurrentFinalizations.every((item) => item.replayedActivation)).toBe(true);
      const finalizedReplay = await finalizeDuduReadonlyManagedProject(staged.shell.paths.root, fixture.source);
      expect(finalizedReplay).toMatchObject({
        projectId: finalized.projectId,
        activationId: finalized.activationId,
        replayedRegistration: true,
        replayedActivation: true,
      });
      const active = await getActiveDuduReadonlyProjectIdentity(staged.shell.paths.root);
      expect(active).toMatchObject({
        projectId: staged.shell.project.id,
        sourceProductionRoot: fixture.productionRoot,
        sourceManifestFingerprint: staged.receipt.sourceManifestFingerprint,
      });
      await expect(getDuduReadonlyImportControl(staged.shell.paths.root)).resolves.toMatchObject({
        status: "active",
        registration: { registered: true },
        activation: { active: true, activationId: finalized.activationId },
        nextAction: "ready",
        blockers: [],
      });
      await expect(proveDuduReadonlyFinalizationOutcome(staged.shell.paths.root, {
        ...fixture.source,
        lockedScriptPath: path.join(fixture.root, "wrong-source", "locked-script.md"),
      }, staged.receipt.fingerprint, finalizeCommandHash)).resolves.toBeNull();

      // CAS 前置门：owner 已 active 后的新 stage 必须在进入 Core 副作用前明确拒绝，
      // 不能落成 unknown，更不能借旧 stage receipt 把这个新请求改判成功。
      const activeDiscovery = await discoverDuduReadonlyImportProjects(fixture.projectsRoot);
      const activeOwnerStageRequest = {
        command: "stage_dudu_readonly_managed_project" as const,
        payload: {
          projectsRoot: fixture.projectsRoot,
          source: fixture.source,
          expectedRevision: 0 as const,
          expectedDiscoveryFingerprint: activeDiscovery.fingerprint,
        },
      };
      await expect(executeIdempotentCommand(bootstrapCommandRoot, {
        requestId: "p30-dudu-active-owner-stage-request-0001",
        idempotencyKey: "p30-dudu-active-owner-stage-key-0001",
        request: activeOwnerStageRequest,
      })).rejects.toMatchObject({
        name: "RejectedCommandFailure",
        result: { applied: false, reason: "control_conflict" },
      });
      await expect(executeIdempotentCommand(bootstrapCommandRoot, {
        requestId: "p30-dudu-active-owner-stage-retry-0002",
        idempotencyKey: "p30-dudu-active-owner-stage-key-0001",
        request: activeOwnerStageRequest,
      })).rejects.toThrow(/已明确失败/u);
      const u13 = staged.receipt.units.find((unit) => unit.unitId === "S1E01-U13")!;
      await expect(getStudioVideoPackageControl(staged.shell.paths.root, {
        by: "authority-latest",
        authority: { kind: "historical-import", packId: u13.packId! },
      })).resolves.toMatchObject({
        status: "not-prepared",
        selectedIntentId: null,
        control: null,
        nextAction: "prepare-via-authorized-core-orchestration",
        readOnly: true,
      });
      await expect(getStudioVideoPackageExportControl(
        staged.shell.paths.root,
        "studio-video-package-intent-not-created",
      )).rejects.toMatchObject({ code: "storage-invalid" } satisfies Partial<StudioVideoPackageError>);
      const before = new DatabaseSync(staged.shell.paths.generationDatabase, { readOnly: true });
      try {
        const tables = before.prepare(`SELECT name FROM sqlite_master
          WHERE type='table' AND name LIKE 'studio_video_package_%' ORDER BY name`).all() as Array<{ name: string }>;
        const marker = before.prepare(`SELECT value FROM studio_generation_ledger_meta
          WHERE key='studio_video_package_schema_version'`).get();
        expect(tables).toEqual([]);
        expect(marker).toBeUndefined();
      } finally {
        before.close();
      }

      const hostilePythonPath = path.join(fixture.root, "ambient-pythonpath");
      const ambientPythonMarker = path.join(fixture.root, "ambient-sitecustomize-executed.txt");
      await mkdir(hostilePythonPath, { recursive: true });
      await writeFile(
        path.join(hostilePythonPath, "sitecustomize.py"),
        `from pathlib import Path\nPath(${JSON.stringify(ambientPythonMarker)}).write_text("executed", encoding="utf-8")\n`,
      );
      process.env.PYTHONPATH = hostilePythonPath;
      const u13Prepared = await prepareStudioVideoPackageExport(staged.shell.paths.root, {
        operationId: "p30-video-u13-historical",
        authority: { kind: "historical-import", packId: u13.packId! },
      });
      expect(u13Prepared.replayed).toBe(false);
      const u13Alias = await prepareStudioVideoPackageExport(staged.shell.paths.root, {
        operationId: "p30-video-shared-alias",
        authority: { kind: "historical-import", packId: u13.packId! },
      });
      expect(u13Alias).toMatchObject({ replayed: true, intent: { intentId: u13Prepared.intent.intentId } });
      await writeFile(counterPath, "");
      const u13Built = await buildAndVerifyStudioVideoPackage(staged.shell.paths.root, u13Prepared.intent.intentId);
      expect(u13Built).toMatchObject({
        adoptedExisting: true,
        replayed: false,
        receipt: {
          storageKind: "external-production",
          storageRelativePath: u13Prepared.intent.packageRelativePath,
          specSchemaVersion: "2.0",
          i2vReadiness: "NOT_TESTED",
          i2vStaticStatus: "ready",
          dynamicModelStatus: "not-run",
        },
      });
      expect(await builderInvocationCount(counterPath)).toBe(3);
      await expect(lstat(ambientPythonMarker)).rejects.toMatchObject({ code: "ENOENT" });
      const u13Replay = await buildAndVerifyStudioVideoPackage(staged.shell.paths.root, u13Prepared.intent.intentId);
      expect(u13Replay).toMatchObject({ replayed: true, adoptedExisting: false, receipt: { receiptId: u13Built.receipt.receiptId } });
      expect(await builderInvocationCount(counterPath)).toBe(3);
      const readOnlyBefore = await readOnlySurfaceSnapshot({
        sidecar: staged.shell.paths.sidecar,
        databases: [
          staged.shell.paths.materialDatabase,
          staged.shell.paths.productionDatabase,
          staged.shell.paths.generationDatabase,
        ],
        registryPath: fixture.registryPath,
      });
      const u13Control = await getStudioVideoPackageExportControl(staged.shell.paths.root, u13Prepared.intent.intentId);
      const readOnlyAfter = await readOnlySurfaceSnapshot({
        sidecar: staged.shell.paths.sidecar,
        databases: [
          staged.shell.paths.materialDatabase,
          staged.shell.paths.productionDatabase,
          staged.shell.paths.generationDatabase,
        ],
        registryPath: fixture.registryPath,
      });
      expect(readOnlyAfter).toEqual(readOnlyBefore);
      expect(u13Control).toMatchObject({
        status: "mechanically-verified",
        mechanicalStatus: "verified",
        i2vStaticStatus: "ready",
        dynamicModelStatus: "not-run",
        blockers: [],
        nextAction: "package-ready-dynamic-model-not-tested",
      });
      await expect(getStudioVideoPackageControl(staged.shell.paths.root, {
        by: "authority-latest",
        authority: { kind: "historical-import", packId: u13.packId! },
      })).resolves.toMatchObject({
        status: "resolved",
        selectedIntentId: u13Prepared.intent.intentId,
        selectedIsDestinationHead: true,
        control: { fingerprint: u13Control.fingerprint },
        nextAction: "use-resolved-control",
      });
      await expect(getStudioVideoPackageControl(staged.shell.paths.root, {
        by: "intent",
        intentId: u13Prepared.intent.intentId,
      })).resolves.toMatchObject({
        status: "resolved",
        selectedIntentId: u13Prepared.intent.intentId,
        control: { fingerprint: u13Control.fingerprint },
      });

      // P30 公开命令纵切：prepare 读取 authority CAS；build 同时冻结 intent 与
      // authority-latest/destination-head，并强制只写 managed evidence。崩溃窗口
      // 只能从 immutable receipt 证明完成，不能伪造 adoptedExisting。
      const u12 = staged.receipt.units.find((unit) => unit.unitId === "S1E01-U12")!;
      const u12Pack = await readStudioUnitGridGenerationFrozenPack(staged.shell.paths.root, u12.packId!);
      const u12Authority = { kind: "historical-import" as const, packId: u12.packId! };
      const u12BeforePrepare = await getStudioVideoPackageControl(staged.shell.paths.root, {
        by: "authority-latest",
        authority: u12Authority,
      });
      const u12PrepareRequest = {
        command: "prepare_studio_video_package_export" as const,
        payload: {
          authority: u12Authority,
          expectedRevision: u12Pack!.target.unitRevision,
          expectedControlFingerprint: u12BeforePrepare.fingerprint,
        },
      };
      const u12PrepareRecord = await executeIdempotentCommand(staged.shell.paths.root, {
        requestId: "p30-video-u12-prepare-request-0001",
        idempotencyKey: "p30-video-u12-prepare-key-0001",
        request: u12PrepareRequest,
      });
      const u12PreparedByCommand = u12PrepareRecord.result as Awaited<ReturnType<typeof prepareStudioVideoPackageExport>>;
      expect(u12PreparedByCommand).toMatchObject({ replayed: false, intent: { unitId: "S1E01-U12" } });
      await expect(executeIdempotentCommand(staged.shell.paths.root, {
        requestId: "p30-video-u12-prepare-stale-request-0002",
        idempotencyKey: "p30-video-u12-prepare-stale-key-0002",
        request: u12PrepareRequest,
      })).rejects.toMatchObject({
        name: "RejectedCommandFailure",
        result: { applied: false, reason: "control_conflict" },
      });
      const u12IntentBeforeBuild = await getStudioVideoPackageControl(staged.shell.paths.root, {
        by: "intent",
        intentId: u12PreparedByCommand.intent.intentId,
      });
      const u12AuthorityBeforeBuild = await getStudioVideoPackageControl(staged.shell.paths.root, {
        by: "authority-latest",
        authority: u12Authority,
      });
      expect(u12AuthorityBeforeBuild).toMatchObject({
        status: "resolved",
        selectedIntentId: u12PreparedByCommand.intent.intentId,
        selectedIsDestinationHead: true,
      });
      const u12BuildRequest = {
        command: "build_studio_video_package" as const,
        payload: {
          intentId: u12PreparedByCommand.intent.intentId,
          expectedRevision: u12Pack!.target.unitRevision,
          expectedIntentControlFingerprint: u12IntentBeforeBuild.fingerprint,
          expectedAuthorityControlFingerprint: u12AuthorityBeforeBuild.fingerprint,
          destinationPolicy: "managed-evidence-only" as const,
        },
      };
      const builderCountBeforeU12Build = await builderInvocationCount(counterPath);
      const wrongIntentControlBuildRequest = {
        ...u12BuildRequest,
        payload: { ...u12BuildRequest.payload, expectedIntentControlFingerprint: "0".repeat(64) },
      };
      await expect(executeIdempotentCommand(staged.shell.paths.root, {
        requestId: "p30-video-u12-build-wrong-intent-control-request-0001",
        idempotencyKey: "p30-video-u12-build-wrong-intent-control-key-0001",
        request: wrongIntentControlBuildRequest,
      })).rejects.toMatchObject({
        name: "RejectedCommandFailure",
        result: { applied: false, reason: "control_conflict" },
      });
      const wrongAuthorityControlBuildRequest = {
        ...u12BuildRequest,
        payload: { ...u12BuildRequest.payload, expectedAuthorityControlFingerprint: "0".repeat(64) },
      };
      await expect(executeIdempotentCommand(staged.shell.paths.root, {
        requestId: "p30-video-u12-build-wrong-authority-control-request-0001",
        idempotencyKey: "p30-video-u12-build-wrong-authority-control-key-0001",
        request: wrongAuthorityControlBuildRequest,
      })).rejects.toMatchObject({
        name: "RejectedCommandFailure",
        result: { applied: false, reason: "control_conflict" },
      });
      expect(await builderInvocationCount(counterPath)).toBe(builderCountBeforeU12Build);
      await expect(readStudioVideoPackageExportIntentByOperationId(
        staged.shell.paths.root,
        stableDigest({ projectRoot: path.resolve(staged.shell.paths.root), request: wrongIntentControlBuildRequest }),
      )).resolves.toBeNull();
      await expect(readStudioVideoPackageExportIntentByOperationId(
        staged.shell.paths.root,
        stableDigest({ projectRoot: path.resolve(staged.shell.paths.root), request: wrongAuthorityControlBuildRequest }),
      )).resolves.toBeNull();
      const previousCommandCrash = process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE;
      process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE = "build_studio_video_package";
      try {
        await expect(executeIdempotentCommand(staged.shell.paths.root, {
          requestId: "p30-video-u12-build-request-0001",
          idempotencyKey: "p30-video-u12-build-key-0001",
          request: u12BuildRequest,
        })).rejects.toThrow(/执行结果未确认/u);
      } finally {
        if (previousCommandCrash === undefined) delete process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE;
        else process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE = previousCommandCrash;
      }
      const u12Recovered = await executeIdempotentCommand(staged.shell.paths.root, {
        requestId: "p30-video-u12-build-recover-request-0002",
        idempotencyKey: "p30-video-u12-build-key-0001",
        request: u12BuildRequest,
      });
      expect(u12Recovered).toMatchObject({
        status: "succeeded",
        replayed: true,
        result: { replayed: true, reconciled: true, receipt: { storageKind: "managed-evidence" } },
      });
      expect(u12Recovered.result).not.toHaveProperty("adoptedExisting");
      await expect(readStudioVideoPackageExportIntentByOperationId(
        staged.shell.paths.root,
        stableDigest({ projectRoot: path.resolve(staged.shell.paths.root), request: u12BuildRequest }),
      )).resolves.toMatchObject({ intentId: u12PreparedByCommand.intent.intentId });

      // authority-latest 明确 conflict 时，即使调用方提交了匹配的 control fingerprint，
      // command-bus 也必须在追加 alias/intent 前失败关闭，不能猜一个候选继续。
      const u11 = staged.receipt.units.find((unit) => unit.unitId === "S1E01-U11")!;
      const u11Pack = await readStudioUnitGridGenerationFrozenPack(staged.shell.paths.root, u11.packId!);
      const u11Authority = { kind: "historical-import" as const, packId: u11.packId! };
      const u11Prepared = await prepareStudioVideoPackageExport(staged.shell.paths.root, {
        operationId: "p30-video-u11-conflict-base",
        authority: u11Authority,
      });
      const {
        schemaVersion: _conflictBaseSchemaVersion,
        // 下面手工注入的是旧 v3 冲突行；v5 的 immutable source closure
        // 没有写入旧列集合，也不能混入旧内容地址语义。
        sourceClosureFingerprint: _conflictBaseSourceClosureFingerprint,
        sequence: _conflictBaseSequence,
        fingerprint: _conflictBaseFingerprint,
        intentId: _conflictBaseIntentId,
        ...conflictBase
      } = u11Prepared.intent;
      const conflictIdentityInput = {
        ...conflictBase,
        operationId: "p30-video-u11-conflict-injected",
        inputFingerprint: stableDigest({ fixture: "p30-video-u11-authority-conflict" }),
        packageRelativePath: `${u11Prepared.intent.packageRelativePath}-conflict`,
        supersedesIntentId: null,
        createdAt: "2026-07-22T00:00:01.000Z",
      };
      const conflictIntentId = `studio-video-package-intent-${stableDigest(conflictIdentityInput).slice(0, 40)}`;
      const conflictSemantic = { ...conflictIdentityInput, intentId: conflictIntentId };
      const conflictDb = new DatabaseSync(staged.shell.paths.generationDatabase);
      let aliasCountBeforeConflictAttempt = 0;
      try {
        conflictDb.prepare(`INSERT INTO studio_video_package_export_intents(
          intent_id, operation_id, input_fingerprint, project_id,
          authority_kind, authority_id, authority_fingerprint,
          pack_id, pack_fingerprint, target_kind, target_key, unit_id, unit_revision, generation_run_id,
          raw_result_id, raw_sha256, labeled_result_id, labeled_sha256,
          dudu_import_receipt_fingerprint, dudu_registration_fingerprint, source_manifest_fingerprint,
          production_scope_fingerprint, contract_sha256,
          production_root, builder_relative_path, builder_sha256,
          source_spec_relative_path, source_spec_sha256, output_root_relative_path, package_relative_path,
          supersedes_intent_id, created_at, fingerprint
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          conflictIntentId,
          conflictIdentityInput.operationId,
          conflictIdentityInput.inputFingerprint,
          conflictIdentityInput.projectId,
          conflictIdentityInput.authorityKind,
          conflictIdentityInput.authorityId,
          conflictIdentityInput.authorityFingerprint,
          conflictIdentityInput.packId,
          conflictIdentityInput.packFingerprint,
          conflictIdentityInput.targetKind,
          conflictIdentityInput.targetKey,
          conflictIdentityInput.unitId,
          conflictIdentityInput.unitRevision,
          conflictIdentityInput.generationRunId,
          conflictIdentityInput.rawResultId,
          conflictIdentityInput.rawSha256,
          conflictIdentityInput.labeledResultId,
          conflictIdentityInput.labeledSha256,
          conflictIdentityInput.duduImportReceiptFingerprint,
          conflictIdentityInput.duduRegistrationFingerprint,
          conflictIdentityInput.sourceManifestFingerprint,
          conflictIdentityInput.productionScopeFingerprint,
          conflictIdentityInput.contractSha256,
          conflictIdentityInput.productionRoot,
          conflictIdentityInput.builderRelativePath,
          conflictIdentityInput.builderSha256,
          conflictIdentityInput.sourceSpecRelativePath,
          conflictIdentityInput.sourceSpecSha256,
          conflictIdentityInput.outputRootRelativePath,
          conflictIdentityInput.packageRelativePath,
          conflictIdentityInput.supersedesIntentId,
          conflictIdentityInput.createdAt,
          stableDigest(conflictSemantic),
        );
        aliasCountBeforeConflictAttempt = Number((conflictDb.prepare(
          "SELECT COUNT(*) AS count FROM studio_video_package_operation_aliases",
        ).get() as { count: number }).count);
      } finally {
        conflictDb.close();
      }
      await expect(readStudioVideoPackageExportIntentByOperationId(
        staged.shell.paths.root,
        conflictIdentityInput.operationId,
      )).resolves.toMatchObject({
        schemaVersion: 3,
        intentId: conflictIntentId,
        fingerprint: stableDigest(conflictSemantic),
      });
      await expect(getStudioVideoPackageControl(staged.shell.paths.root, {
        by: "intent",
        intentId: conflictIntentId,
      })).resolves.toMatchObject({
        status: "resolved",
        selectedIntentId: conflictIntentId,
        control: {
          status: "stale",
          mechanicalStatus: "stale",
          blockers: ["input-drift"],
          nextAction: "repair-input",
        },
      });
      await expect(buildAndVerifyStudioVideoPackage(
        staged.shell.paths.root,
        conflictIntentId,
      )).rejects.toMatchObject({
        code: "input-drift",
      } satisfies Partial<StudioVideoPackageError>);
      const u11ConflictControl = await getStudioVideoPackageControl(staged.shell.paths.root, {
        by: "authority-latest",
        authority: u11Authority,
      });
      expect(u11ConflictControl).toMatchObject({
        status: "conflict",
        selectedIntentId: null,
        nextAction: "resolve-video-package-ledger-conflict",
        blockers: ["authority-destination-conflict"],
      });
      await expect(executeIdempotentCommand(staged.shell.paths.root, {
        requestId: "p30-video-u11-conflict-prepare-request-0001",
        idempotencyKey: "p30-video-u11-conflict-prepare-key-0001",
        request: {
          command: "prepare_studio_video_package_export",
          payload: {
            authority: u11Authority,
            expectedRevision: u11Pack!.target.unitRevision,
            expectedControlFingerprint: u11ConflictControl.fingerprint,
          },
        },
      })).rejects.toMatchObject({
        name: "RejectedCommandFailure",
        result: { applied: false, reason: "control_conflict" },
      });
      const conflictDbAfter = new DatabaseSync(staged.shell.paths.generationDatabase, { readOnly: true });
      try {
        expect(Number((conflictDbAfter.prepare(
          "SELECT COUNT(*) AS count FROM studio_video_package_operation_aliases",
        ).get() as { count: number }).count)).toBe(aliasCountBeforeConflictAttempt);
      } finally {
        conflictDbAfter.close();
      }

      const u27 = staged.receipt.units.find((unit) => unit.unitId === "S1E01-U27")!;
      await expect(prepareStudioVideoPackageExport(staged.shell.paths.root, {
        operationId: "p30-video-shared-alias",
        authority: { kind: "historical-import", packId: u27.packId! },
      })).rejects.toMatchObject({ code: "operation-conflict" } satisfies Partial<StudioVideoPackageError>);
      const u27Prepared = await prepareStudioVideoPackageExport(staged.shell.paths.root, {
        operationId: "p30-video-u27-historical",
        authority: { kind: "historical-import", packId: u27.packId! },
      });
      await writeFile(counterPath, "");
      const u27Built = await buildAndVerifyStudioVideoPackage(staged.shell.paths.root, u27Prepared.intent.intentId);
      expect(u27Built.receipt).toMatchObject({
        storageKind: "external-production",
        storageRelativePath: u27Prepared.intent.packageRelativePath,
        i2vReadiness: "STORYBOARD_CROP_ANCHOR_FOLLOWUP_ONLY",
        i2vStaticStatus: "needs-independent-frame-or-review",
        dynamicModelStatus: "not-run",
      });
      expect((await getStudioVideoPackageExportControl(staged.shell.paths.root, u27Prepared.intent.intentId))).toMatchObject({
        blockers: ["i2v-static-input-incomplete"],
        nextAction: "complete-i2v-static-input",
      });

      const u28 = staged.receipt.units.find((unit) => unit.unitId === "S1E01-U28")!;
      const pack = await readStudioUnitGridGenerationFrozenPack(staged.shell.paths.root, u28.packId!);
      expect(pack).not.toBeNull();
      const generationRunId = "p30-video-u28-fixture-run-1";
      await dispatchStudioGenerationPack(staged.shell.paths.root, {
        packId: pack!.id,
        packFingerprint: pack!.fingerprint,
        generationRunId,
        provider: "codex",
      });
      const context = await getActiveManagedStudioContext();
      const call = await prepareStudioImagegenCall(staged.shell.paths.root, {
        packId: pack!.id,
        packFingerprint: pack!.fingerprint,
        generationRunId,
        provider: "codex",
        projectContextToken: context.projectContextToken,
        commandRequestId: "p30-video-u28-prepare-call",
        expectedRevision: 0,
      });
      expect(call).toMatchObject({ callAllowed: true, status: "generation_unknown" });
      const rawPath = path.join(fixture.root, "u28-fixture-unit-grid-raw.png");
      await sharp({
        create: { width: 900, height: 1600, channels: 3, background: { r: 45, g: 70, b: 95 } },
      }).png({ compressionLevel: 9 }).toFile(rawPath);
      const rawBytes = await readFile(rawPath);
      const committed = await commitAgentImagegenResultBundle(staged.shell.paths.root, {
        projectContextToken: context.projectContextToken,
        packId: pack!.id,
        packFingerprint: pack!.fingerprint,
        generationRunId,
        provider: "codex",
        rawPath,
        rawSha256: sha256(rawBytes),
        expectedRevision: pack!.target.unitRevision,
        executionReceipt: {
          schemaVersion: 1,
          kind: "agent-imagegen-execution-receipt",
          provider: "codex",
          source: "fixture-canary",
          attestationLevel: "unverified-external-agent",
          cryptographicProviderReceipt: false,
          callId: call.callId,
          model: "fixture-no-model",
          generatedAt: "2026-07-22T00:00:00.000Z",
        },
      });
      const review = await submitStudioGenerationReview(staged.shell.paths.root, {
        operationId: "p30-video-u28-review-pass",
        generationRunId,
        kind: "observation",
        expectedHeadRevision: 0,
        rawResultId: committed.results.raw.resultId,
        rawSha256: committed.results.raw.mediaSha256,
        labeledResultId: committed.results.labeled.resultId,
        labeledSha256: committed.results.labeled.mediaSha256,
        expectedPackFingerprint: pack!.fingerprint,
        continuityFingerprint: pack!.continuityFingerprint,
        decision: "pass",
        criteria: [
          { code: "fixture-mechanical", status: "pass", note: "仅验证软件写回合同。" },
          { code: "fixture-identity", status: "pass", note: "确定性像素，不代表正式视觉验收。" },
        ],
        reviewer: "p30-video-package-test",
        note: "隔离 fixture Review；不得解释为真实 canary。",
      });
      expect(review).toMatchObject({ current: true, head: true, approvedRawEligible: true });
      const u28Snapshot = await getStudioProductionUnitSnapshot(staged.shell.paths.root, pack!.target.unitId);
      const u28ObservationControl = await getStudioPostResultObservationControl(
        staged.shell.paths.root,
        review.generationRunId,
      );
      const u28ManagedSource = await prepareStudioVideoPackageSource(staged.shell.paths.root, {
        adapterKind: "managed-evidence-v1",
        reviewId: review.reviewId,
        expectedReviewFingerprint: review.fingerprint,
        expectedPackFingerprint: pack!.fingerprint,
        expectedUnitSnapshotFingerprint: u28Snapshot!.fingerprint,
        expectedObservationControlFingerprint: u28ObservationControl.fingerprint,
        expectedObservationHeadRevision: u28ObservationControl.headRevision,
        expectedObservationStatus: u28ObservationControl.status,
        expectedObservationHeadId: u28ObservationControl.head?.observationId ?? null,
        expectedObservationHeadFingerprint: u28ObservationControl.head?.fingerprint ?? null,
        expectedObservationEvidenceSha256: u28ObservationControl.head?.evidenceSha256 ?? null,
      });

      const u28InitialPrepared = await prepareStudioVideoPackageExport(staged.shell.paths.root, {
        operationId: "p30-video-u28-review-derived",
        authority: { kind: "studio-review", reviewId: review.reviewId },
        expectedManagedSource: {
          adapterKind: "managed-evidence-v1",
          reviewId: review.reviewId,
          expectedSourceFingerprint: u28ManagedSource.fingerprint,
          expectedReviewFingerprint: review.fingerprint,
          expectedPackFingerprint: pack!.fingerprint,
          expectedUnitSnapshotFingerprint: u28Snapshot!.fingerprint,
          expectedObservationControlFingerprint: u28ObservationControl.fingerprint,
          expectedObservationHeadRevision: u28ObservationControl.headRevision,
          expectedObservationStatus: u28ObservationControl.status,
          expectedObservationHeadId: u28ObservationControl.head?.observationId ?? null,
          expectedObservationHeadFingerprint: u28ObservationControl.head?.fingerprint ?? null,
          expectedObservationEvidenceSha256: u28ObservationControl.head?.evidenceSha256 ?? null,
        },
      });
      await expect(getStudioVideoPackageControl(staged.shell.paths.root, {
        by: "authority-latest",
        authority: { kind: "studio-review", reviewId: review.reviewId },
      })).resolves.toMatchObject({
        status: "resolved",
        selectedIntentId: u28InitialPrepared.intent.intentId,
        selectedIsDestinationHead: true,
        control: { status: "prepared" },
      });
      const interimEvidencePath = path.join(fixture.root, "u28-fixture-accepted-last-frame.png");
      await sharp({
        create: { width: 450, height: 800, channels: 3, background: { r: 41, g: 67, b: 93 } },
      }).png({ compressionLevel: 9 }).toFile(interimEvidencePath);
      const interimEvidence = await importStudioMedia(staged.shell.paths.root, {
        sourcePath: interimEvidencePath,
        kind: "image",
      });
      const finalCasBarrier = path.join(staged.shell.paths.root, "p30-video-u28-final-cas");
      const productionSpecPath = path.join(
        u28InitialPrepared.intent.productionRoot,
        ...u28InitialPrepared.intent.sourceSpecRelativePath.split("/"),
      );
      const productionPackagePath = path.join(
        u28InitialPrepared.intent.productionRoot,
        ...u28InitialPrepared.intent.packageRelativePath.split("/"),
      );
      const managedEvidencePath = path.join(
        staged.shell.paths.root,
        ".aicanvas",
        "studio-video-package-evidence",
        u28InitialPrepared.intent.intentId,
        u28InitialPrepared.intent.unitId,
      );
      await expect(lstat(productionSpecPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(lstat(productionPackagePath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(lstat(managedEvidencePath)).rejects.toMatchObject({ code: "ENOENT" });
      process.env.P30_TEST_VIDEO_PACKAGE_FINAL_CAS_BARRIER = finalCasBarrier;
      const initialBuildOutcome = buildAndVerifyStudioVideoPackage(
        staged.shell.paths.root,
        u28InitialPrepared.intent.intentId,
      ).then(
        (value) => ({ status: "fulfilled" as const, value }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      );
      await waitForPath(`${finalCasBarrier}.reached`);
      const interimObservation = await submitStudioPostResultObservation(staged.shell.paths.root, {
        operationId: "p30-video-u28-interim-observation",
        generationRunId: review.generationRunId,
        expectedHeadRevision: 0,
        expectedReviewId: review.reviewId,
        expectedReviewFingerprint: review.fingerprint,
        rawResultId: review.rawResultId,
        rawSha256: review.rawSha256,
        labeledResultId: review.labeledResultId,
        labeledSha256: review.labeledSha256,
        packId: review.packId,
        packFingerprint: review.packFingerprint,
        plannedContinuityFingerprint: review.continuityFingerprint,
        evidenceKind: "accepted-last-frame",
        evidenceSha256: interimEvidence.sha256,
        observedState: {
          costume: "fixture 服装状态。",
          injury: "fixture 无可确认伤势。",
          heldObject: "fixture 无可确认持物。",
          position: "fixture 主体位于画面中央。",
          facing: "fixture 主体朝向画面左侧。",
          emotion: "fixture 表情平静。",
          layout: "fixture 布局保持冻结。",
          lighting: "fixture 光线保持冻结。",
          referenceSha256: interimEvidence.sha256,
          motionVector: "静态图不可确认。",
          cameraPhase: "静态图不可确认。",
          focusState: "fixture 焦点在主体。",
          audioPhase: "静态图不可确认。",
        },
        observedAvailability: {
          costume: "observed",
          injury: "unknown",
          heldObject: "unknown",
          position: "observed",
          facing: "observed",
          emotion: "observed",
          layout: "observed",
          lighting: "observed",
          motionVector: "unknown",
          cameraPhase: "unknown",
          focusState: "observed",
          audioPhase: "not-applicable",
        },
        observer: "p30-video-package-test",
        note: "只用于验证 prepare 后 Observation 漂移会生成 v4 successor。",
      });
      expect(interimObservation).toMatchObject({
        current: true,
        continuationEligible: false,
      });
      await writeFile(`${finalCasBarrier}.release`, "release\n", { flag: "wx" });
      delete process.env.P30_TEST_VIDEO_PACKAGE_FINAL_CAS_BARRIER;
      const initialBuildResult = await initialBuildOutcome;
      expect(initialBuildResult.status).toBe("rejected");
      expect(initialBuildResult.status === "rejected" ? initialBuildResult.error : null).toMatchObject({
        // final CAS 后直接在 generation ledger 的同一只读快照复核
        // Review/result/Observation Head；因此漂移会在任何目标目录写入前
        // 精确归类为 input-drift，而不是等后续证据安装阶段再报错。
        code: "input-drift",
      });
      await expect(lstat(productionSpecPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(lstat(productionPackagePath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(lstat(managedEvidencePath)).rejects.toMatchObject({ code: "ENOENT" });
      const u28SuccessorControl = await getStudioPostResultObservationControl(
        staged.shell.paths.root,
        review.generationRunId,
      );
      const u28SuccessorSource = await prepareStudioVideoPackageSource(staged.shell.paths.root, {
        adapterKind: "managed-evidence-v1",
        reviewId: review.reviewId,
        expectedReviewFingerprint: review.fingerprint,
        expectedPackFingerprint: pack!.fingerprint,
        expectedUnitSnapshotFingerprint: u28Snapshot!.fingerprint,
        expectedObservationControlFingerprint: u28SuccessorControl.fingerprint,
        expectedObservationHeadRevision: u28SuccessorControl.headRevision,
        expectedObservationStatus: u28SuccessorControl.status,
        expectedObservationHeadId: u28SuccessorControl.head?.observationId ?? null,
        expectedObservationHeadFingerprint: u28SuccessorControl.head?.fingerprint ?? null,
        expectedObservationEvidenceSha256: u28SuccessorControl.head?.evidenceSha256 ?? null,
      });
      const u28Prepared = await prepareStudioVideoPackageExport(staged.shell.paths.root, {
        operationId: "p30-video-u28-review-derived-successor",
        authority: { kind: "studio-review", reviewId: review.reviewId },
        expectedManagedSource: {
          adapterKind: "managed-evidence-v1",
          reviewId: review.reviewId,
          expectedSourceFingerprint: u28SuccessorSource.fingerprint,
          expectedReviewFingerprint: review.fingerprint,
          expectedPackFingerprint: pack!.fingerprint,
          expectedUnitSnapshotFingerprint: u28Snapshot!.fingerprint,
          expectedObservationControlFingerprint: u28SuccessorControl.fingerprint,
          expectedObservationHeadRevision: u28SuccessorControl.headRevision,
          expectedObservationStatus: u28SuccessorControl.status,
          expectedObservationHeadId: u28SuccessorControl.head?.observationId ?? null,
          expectedObservationHeadFingerprint: u28SuccessorControl.head?.fingerprint ?? null,
          expectedObservationEvidenceSha256: u28SuccessorControl.head?.evidenceSha256 ?? null,
        },
      });
      expect(u28Prepared.intent).toMatchObject({
        schemaVersion: 5,
        supersedesIntentId: u28InitialPrepared.intent.intentId,
      });
      await expect(getStudioVideoPackageControl(staged.shell.paths.root, {
        by: "authority-latest",
        authority: { kind: "studio-review", reviewId: review.reviewId },
      })).resolves.toMatchObject({
        status: "resolved",
        selectedIntentId: u28Prepared.intent.intentId,
        selectedIsDestinationHead: true,
        control: { status: "prepared" },
      });
      await writeFile(counterPath, "");
      process.env.P30_TEST_BUILDER_FAULT = "invalid-png";
      await expect(buildAndVerifyStudioVideoPackage(staged.shell.paths.root, u28Prepared.intent.intentId))
        .rejects.toMatchObject({ code: "verify-failed" } satisfies Partial<StudioVideoPackageError>);
      process.env.P30_TEST_BUILDER_FAULT = "invalid-markdown";
      await expect(buildAndVerifyStudioVideoPackage(staged.shell.paths.root, u28Prepared.intent.intentId))
        .rejects.toMatchObject({ code: "verify-failed" } satisfies Partial<StudioVideoPackageError>);
      process.env.P30_TEST_BUILDER_FAULT = "wrong-pixels";
      await expect(buildAndVerifyStudioVideoPackage(staged.shell.paths.root, u28Prepared.intent.intentId))
        .rejects.toMatchObject({ code: "verify-failed" } satisfies Partial<StudioVideoPackageError>);
      process.env.P30_TEST_BUILDER_FAULT = "wrong-prompt";
      await expect(buildAndVerifyStudioVideoPackage(staged.shell.paths.root, u28Prepared.intent.intentId))
        .rejects.toMatchObject({ code: "verify-failed" } satisfies Partial<StudioVideoPackageError>);
      delete process.env.P30_TEST_BUILDER_FAULT;
      process.env.P30_TEST_INSTALL_FAULT = "partial-file";
      await expect(buildAndVerifyStudioVideoPackage(staged.shell.paths.root, u28Prepared.intent.intentId))
        .rejects.toMatchObject({ code: "destination-conflict" } satisfies Partial<StudioVideoPackageError>);
      delete process.env.P30_TEST_INSTALL_FAULT;
      process.env.P30_TEST_INSTALL_FAULT = "after-rename-before-receipt";
      await expect(buildAndVerifyStudioVideoPackage(staged.shell.paths.root, u28Prepared.intent.intentId))
        .rejects.toMatchObject({ code: "builder-failed" } satisfies Partial<StudioVideoPackageError>);
      delete process.env.P30_TEST_INSTALL_FAULT;
      await expect(getStudioVideoPackageControl(staged.shell.paths.root, {
        by: "intent",
        intentId: u28Prepared.intent.intentId,
      })).resolves.toMatchObject({
        control: {
          status: "prepared",
          receipt: null,
        },
      });
      const u28Built = await buildAndVerifyStudioVideoPackage(staged.shell.paths.root, u28Prepared.intent.intentId);
      expect(u28Built).toMatchObject({
        replayed: false,
        adoptedExisting: true,
        receipt: {
          storageKind: "managed-evidence",
          i2vReadiness: "STORYBOARD_CROP_ANCHOR_FOLLOWUP_ONLY",
          i2vStaticStatus: "needs-independent-frame-or-review",
          dynamicModelStatus: "not-run",
        },
      });
      expect(await builderInvocationCount(counterPath)).toBe(14);
      const evidencePackagePath = path.join(staged.shell.paths.root, u28Built.receipt.storageRelativePath);
      const manifest = JSON.parse(await readFile(path.join(evidencePackagePath, "manifest.json"), "utf8")) as {
        files: Array<{ path: string; sha256: string }>;
      };
      expect(manifest.files.find((file) => file.path === "S1E01-U28_labeled.png")?.sha256)
        .toBe(committed.results.labeled.mediaSha256);
      expect(u28Built.receipt.manifestRelativePath).toBe(`${u28Built.receipt.storageRelativePath}/manifest.json`);
      await expect(lstat(path.join(
        fixture.productionRoot,
        u28Prepared.intent.sourceSpecRelativePath,
      ))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(lstat(path.join(
        fixture.productionRoot,
        fixture.rawRelativePathByUnit["S1E01-U28"]!,
      ))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(lstat(path.join(
        fixture.productionRoot,
        u28Prepared.intent.packageRelativePath,
      ))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(lstat(path.join(evidencePackagePath, ".studio-video-package-install-claim.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
      await buildAndVerifyStudioVideoPackage(staged.shell.paths.root, u28Prepared.intent.intentId);
      expect(await builderInvocationCount(counterPath)).toBe(14);
      expect(await getStudioVideoPackageExportControl(staged.shell.paths.root, u28Prepared.intent.intentId)).toMatchObject({
        status: "mechanically-verified",
        mechanicalStatus: "verified",
        blockers: ["i2v-static-input-incomplete"],
        nextAction: "complete-i2v-static-input",
      });

      // U29 覆盖异步 receipt CAS 已返回、SQLite receipt 事务尚未 BEGIN 的竞态窗。
      // 当前 PENDING 单元没有进入
      // 只读 sourceFiles 的冻结视频规格，按真实合同只能写 managed evidence；
      // 测试不得把它伪装成 external production。
      const u29 = staged.receipt.units.find((unit) => unit.unitId === "S1E01-U29")!;
      const u29Pack = await readStudioUnitGridGenerationFrozenPack(staged.shell.paths.root, u29.packId!);
      expect(u29Pack).not.toBeNull();
      const u29GenerationRunId = "p30-video-u29-fixture-run-1";
      await dispatchStudioGenerationPack(staged.shell.paths.root, {
        packId: u29Pack!.id,
        packFingerprint: u29Pack!.fingerprint,
        generationRunId: u29GenerationRunId,
        provider: "codex",
      });
      const u29Context = await getActiveManagedStudioContext();
      const u29Call = await prepareStudioImagegenCall(staged.shell.paths.root, {
        packId: u29Pack!.id,
        packFingerprint: u29Pack!.fingerprint,
        generationRunId: u29GenerationRunId,
        provider: "codex",
        projectContextToken: u29Context.projectContextToken,
        commandRequestId: "p30-video-u29-prepare-call",
        expectedRevision: 0,
      });
      const u29RawPath = path.join(fixture.root, "u29-fixture-unit-grid-raw.png");
      await sharp({
        create: { width: 900, height: 1600, channels: 3, background: { r: 61, g: 83, b: 109 } },
      }).png({ compressionLevel: 9 }).toFile(u29RawPath);
      const u29RawBytes = await readFile(u29RawPath);
      const u29Committed = await commitAgentImagegenResultBundle(staged.shell.paths.root, {
        projectContextToken: u29Context.projectContextToken,
        packId: u29Pack!.id,
        packFingerprint: u29Pack!.fingerprint,
        generationRunId: u29GenerationRunId,
        provider: "codex",
        rawPath: u29RawPath,
        rawSha256: sha256(u29RawBytes),
        expectedRevision: u29Pack!.target.unitRevision,
        executionReceipt: {
          schemaVersion: 1,
          kind: "agent-imagegen-execution-receipt",
          provider: "codex",
          source: "fixture-canary",
          attestationLevel: "unverified-external-agent",
          cryptographicProviderReceipt: false,
          callId: u29Call.callId,
          model: "fixture-no-model",
          generatedAt: "2026-07-22T00:00:00.000Z",
        },
      });
      const u29Review = await submitStudioGenerationReview(staged.shell.paths.root, {
        operationId: "p30-video-u29-review-pass",
        generationRunId: u29GenerationRunId,
        kind: "observation",
        expectedHeadRevision: 0,
        rawResultId: u29Committed.results.raw.resultId,
        rawSha256: u29Committed.results.raw.mediaSha256,
        labeledResultId: u29Committed.results.labeled.resultId,
        labeledSha256: u29Committed.results.labeled.mediaSha256,
        expectedPackFingerprint: u29Pack!.fingerprint,
        continuityFingerprint: u29Pack!.continuityFingerprint,
        decision: "pass",
        criteria: [
          { code: "fixture-mechanical", status: "pass", note: "仅验证软件写回合同。" },
          { code: "fixture-identity", status: "pass", note: "确定性像素，不代表正式视觉验收。" },
        ],
        reviewer: "p30-video-package-test",
        note: "隔离 fixture Review；不得解释为真实 canary。",
      });
      const u29Snapshot = await getStudioProductionUnitSnapshot(
        staged.shell.paths.root,
        u29Pack!.target.unitId,
      );
      const u29InitialControl = await getStudioPostResultObservationControl(
        staged.shell.paths.root,
        u29Review.generationRunId,
      );
      const u29InitialSource = await prepareStudioVideoPackageSource(staged.shell.paths.root, {
        adapterKind: "managed-evidence-v1",
        reviewId: u29Review.reviewId,
        expectedReviewFingerprint: u29Review.fingerprint,
        expectedPackFingerprint: u29Pack!.fingerprint,
        expectedUnitSnapshotFingerprint: u29Snapshot!.fingerprint,
        expectedObservationControlFingerprint: u29InitialControl.fingerprint,
        expectedObservationHeadRevision: u29InitialControl.headRevision,
        expectedObservationStatus: u29InitialControl.status,
        expectedObservationHeadId: u29InitialControl.head?.observationId ?? null,
        expectedObservationHeadFingerprint: u29InitialControl.head?.fingerprint ?? null,
        expectedObservationEvidenceSha256: u29InitialControl.head?.evidenceSha256 ?? null,
      });
      const u29InitialPrepared = await prepareStudioVideoPackageExport(staged.shell.paths.root, {
        operationId: "p30-video-u29-review-derived-initial",
        authority: { kind: "studio-review", reviewId: u29Review.reviewId },
        expectedManagedSource: {
          adapterKind: "managed-evidence-v1",
          reviewId: u29Review.reviewId,
          expectedSourceFingerprint: u29InitialSource.fingerprint,
          expectedReviewFingerprint: u29Review.fingerprint,
          expectedPackFingerprint: u29Pack!.fingerprint,
          expectedUnitSnapshotFingerprint: u29Snapshot!.fingerprint,
          expectedObservationControlFingerprint: u29InitialControl.fingerprint,
          expectedObservationHeadRevision: u29InitialControl.headRevision,
          expectedObservationStatus: u29InitialControl.status,
          expectedObservationHeadId: u29InitialControl.head?.observationId ?? null,
          expectedObservationHeadFingerprint: u29InitialControl.head?.fingerprint ?? null,
          expectedObservationEvidenceSha256: u29InitialControl.head?.evidenceSha256 ?? null,
        },
      });
      const u29ReceiptBarrier = path.join(staged.shell.paths.root, "p30-video-u29-receipt-post-cas");
      process.env.P30_TEST_VIDEO_PACKAGE_RECEIPT_POST_CAS_BARRIER = u29ReceiptBarrier;
      const u29InitialBuildOutcome = buildAndVerifyStudioVideoPackage(
        staged.shell.paths.root,
        u29InitialPrepared.intent.intentId,
      ).then(
        (value) => ({ status: "fulfilled" as const, value }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      );
      const u29BarrierRace = await Promise.race([
        waitForPath(`${u29ReceiptBarrier}.reached`, 180_000).then(
          () => ({ kind: "barrier" as const }),
          (error: unknown) => ({ kind: "timeout" as const, error }),
        ),
        u29InitialBuildOutcome.then((outcome) => ({
          kind: "settled" as const,
          outcome,
        })),
      ]);
      if (u29BarrierRace.kind === "settled") {
        if (u29BarrierRace.outcome.status === "rejected") throw u29BarrierRace.outcome.error;
        throw new Error("U29 build 在 receipt post-CAS/pre-transaction barrier 前意外成功。");
      }
      if (u29BarrierRace.kind === "timeout") {
        // 不让测试失败遗留仍在运行的 build Promise：预先写 release，使它
        // 即使稍后才到 barrier 也能退出，再等待真实终态后报告基础设施超时。
        await writeFile(`${u29ReceiptBarrier}.release`, "timeout-release\n", { flag: "wx" })
          .catch(() => undefined);
        const lateOutcome = await u29InitialBuildOutcome;
        throw new Error(
          `${u29BarrierRace.error instanceof Error ? u29BarrierRace.error.message : String(u29BarrierRace.error)}；`
          + `build=${lateOutcome.status}`,
        );
      }
      const u29Observation = await submitStudioPostResultObservation(staged.shell.paths.root, {
        operationId: "p30-video-u29-observation-after-install",
        generationRunId: u29Review.generationRunId,
        expectedHeadRevision: 0,
        expectedReviewId: u29Review.reviewId,
        expectedReviewFingerprint: u29Review.fingerprint,
        rawResultId: u29Review.rawResultId,
        rawSha256: u29Review.rawSha256,
        labeledResultId: u29Review.labeledResultId,
        labeledSha256: u29Review.labeledSha256,
        packId: u29Review.packId,
        packFingerprint: u29Review.packFingerprint,
        plannedContinuityFingerprint: u29Review.continuityFingerprint,
        evidenceKind: "accepted-last-frame",
        evidenceSha256: interimEvidence.sha256,
        observedState: {
          costume: "fixture 服装状态。",
          injury: "fixture 无可确认伤势。",
          heldObject: "fixture 无可确认持物。",
          position: "fixture 主体位于画面中央。",
          facing: "fixture 主体朝向画面左侧。",
          emotion: "fixture 表情平静。",
          layout: "fixture 布局保持冻结。",
          lighting: "fixture 光线保持冻结。",
          referenceSha256: interimEvidence.sha256,
          motionVector: "静态图不可确认。",
          cameraPhase: "静态图不可确认。",
          focusState: "fixture 焦点在主体。",
          audioPhase: "静态图不可确认。",
        },
        observedAvailability: {
          costume: "observed",
          injury: "unknown",
          heldObject: "unknown",
          position: "observed",
          facing: "observed",
          emotion: "observed",
          layout: "observed",
          lighting: "observed",
          motionVector: "unknown",
          cameraPhase: "unknown",
          focusState: "observed",
          audioPhase: "not-applicable",
        },
        observer: "p30-video-package-test",
        note: "在异步 receipt CAS 返回后、SQLite receipt 事务 BEGIN 前制造 managed-source 漂移。",
      });
      await writeFile(`${u29ReceiptBarrier}.release`, "release\n", { flag: "wx" });
      delete process.env.P30_TEST_VIDEO_PACKAGE_RECEIPT_POST_CAS_BARRIER;
      const u29InitialBuildResult = await u29InitialBuildOutcome;
      expect(u29InitialBuildResult.status).toBe("rejected");
      expect(u29InitialBuildResult.status === "rejected" ? u29InitialBuildResult.error : null)
        .toMatchObject({ code: "input-drift" });
      const u29ReceiptDb = new DatabaseSync(staged.shell.paths.generationDatabase, { readOnly: true });
      try {
        const receiptCount = Number((u29ReceiptDb.prepare(`
          SELECT COUNT(*) AS count FROM studio_video_package_verify_receipts WHERE intent_id=?
        `).get(u29InitialPrepared.intent.intentId) as { count: number }).count);
        expect(receiptCount).toBe(0);
      } finally {
        u29ReceiptDb.close();
      }
      await expect(getStudioVideoPackageControl(staged.shell.paths.root, {
        by: "intent",
        intentId: u29InitialPrepared.intent.intentId,
      })).resolves.toMatchObject({
        control: { status: "stale", receipt: null },
      });
      const u29InitialEvidencePackagePath = path.join(
        staged.shell.paths.root,
        ".aicanvas",
        "studio-video-package-evidence",
        u29InitialPrepared.intent.intentId,
        u29InitialPrepared.intent.unitId,
      );
      expect((await lstat(path.join(u29InitialEvidencePackagePath, "manifest.json"))).isFile()).toBe(true);
      const u29CurrentControl = await getStudioPostResultObservationControl(
        staged.shell.paths.root,
        u29Review.generationRunId,
      );
      const u29CurrentSource = await prepareStudioVideoPackageSource(staged.shell.paths.root, {
        adapterKind: "managed-evidence-v1",
        reviewId: u29Review.reviewId,
        expectedReviewFingerprint: u29Review.fingerprint,
        expectedPackFingerprint: u29Pack!.fingerprint,
        expectedUnitSnapshotFingerprint: u29Snapshot!.fingerprint,
        expectedObservationControlFingerprint: u29CurrentControl.fingerprint,
        expectedObservationHeadRevision: u29CurrentControl.headRevision,
        expectedObservationStatus: u29CurrentControl.status,
        expectedObservationHeadId: u29CurrentControl.head?.observationId ?? null,
        expectedObservationHeadFingerprint: u29CurrentControl.head?.fingerprint ?? null,
        expectedObservationEvidenceSha256: u29CurrentControl.head?.evidenceSha256 ?? null,
      });
      const u29SuccessorPrepared = await prepareStudioVideoPackageExport(staged.shell.paths.root, {
        operationId: "p30-video-u29-review-derived-successor",
        authority: { kind: "studio-review", reviewId: u29Review.reviewId },
        expectedManagedSource: {
          adapterKind: "managed-evidence-v1",
          reviewId: u29Review.reviewId,
          expectedSourceFingerprint: u29CurrentSource.fingerprint,
          expectedReviewFingerprint: u29Review.fingerprint,
          expectedPackFingerprint: u29Pack!.fingerprint,
          expectedUnitSnapshotFingerprint: u29Snapshot!.fingerprint,
          expectedObservationControlFingerprint: u29CurrentControl.fingerprint,
          expectedObservationHeadRevision: u29CurrentControl.headRevision,
          expectedObservationStatus: u29CurrentControl.status,
          expectedObservationHeadId: u29CurrentControl.head?.observationId ?? null,
          expectedObservationHeadFingerprint: u29CurrentControl.head?.fingerprint ?? null,
          expectedObservationEvidenceSha256: u29CurrentControl.head?.evidenceSha256 ?? null,
        },
      });
      expect(u29SuccessorPrepared.intent.supersedesIntentId)
        .toBe(u29InitialPrepared.intent.intentId);
      const u29SuccessorBuilt = await buildAndVerifyStudioVideoPackage(
        staged.shell.paths.root,
        u29SuccessorPrepared.intent.intentId,
      );
      expect(u29SuccessorBuilt).toMatchObject({
        adoptedExisting: false,
        receipt: {
          storageKind: "managed-evidence",
          i2vStaticStatus: "needs-independent-frame-or-review",
        },
      });
      const u29SuccessorEvidencePackagePath = path.join(
        staged.shell.paths.root,
        u29SuccessorBuilt.receipt.storageRelativePath,
      );
      expect((await lstat(path.join(u29InitialEvidencePackagePath, "manifest.json"))).isFile()).toBe(true);
      expect((await lstat(path.join(u29SuccessorEvidencePackagePath, "manifest.json"))).isFile()).toBe(true);

      // 只有 fixture 将该单元真实冻结为 ready external 时，才运行下方
      // publication 文件链。当前 managed-evidence 路径不冒充 external；
      // v3 地址与同目标 pending 约束另由轻量账本测试覆盖。
      if (u29SuccessorBuilt.receipt.storageKind === "external-production") {
      // 把已真实 verify 的 U29 external v5 head 在隔离 fixture 中还原成
      // 迁移前 v3 行与原内容地址 receipt，随后证明：v3 仍禁止 build，但
      // v5 successor 可在 managed evidence verify 后只读验真、归档并发布。
      const {
        schemaVersion: _u29V4SchemaVersion,
        sequence: _u29V4Sequence,
        fingerprint: _u29V4Fingerprint,
        intentId: _u29V4IntentId,
        managedSourceFingerprint: _u29ManagedSourceFingerprint,
        managedSourceUnitSnapshotFingerprint: _u29ManagedUnitFingerprint,
        observationControlFingerprint: _u29ObservationControlFingerprint,
        observationControlStatus: _u29ObservationControlStatus,
        observationHeadRevision: _u29ObservationHeadRevision,
        observationId: _u29ObservationId,
        observationHeadFingerprint: _u29ObservationHeadFingerprint,
        observationEvidenceContractVersion: _u29EvidenceContractVersion,
        observationEvidenceKind: _u29EvidenceKind,
        observationEvidenceSha256: _u29EvidenceSha256,
        observationEvidenceLineageFingerprint: _u29EvidenceLineageFingerprint,
        sourceClosureFingerprint: _u29SourceClosureFingerprint,
        ...u29LegacyIntentIdentityInput
      } = u29SuccessorPrepared.intent;
      const u29LegacyIntentId =
        `studio-video-package-intent-${stableDigest(u29LegacyIntentIdentityInput).slice(0, 40)}`;
      const u29LegacyIntentSemantic = {
        ...u29LegacyIntentIdentityInput,
        intentId: u29LegacyIntentId,
      };
      const {
        sequence: _u29V4ReceiptSequence,
        fingerprint: _u29V4ReceiptFingerprint,
        receiptId: _u29V4ReceiptId,
        intentId: _u29V4ReceiptIntentId,
        ...u29LegacyReceiptRest
      } = u29SuccessorBuilt.receipt;
      const u29LegacyReceiptIdentityInput = {
        ...u29LegacyReceiptRest,
        intentId: u29LegacyIntentId,
      };
      const u29LegacyReceiptId =
        `studio-video-package-receipt-${stableDigest(u29LegacyReceiptIdentityInput).slice(0, 40)}`;
      const u29LegacyReceiptSemantic = {
        ...u29LegacyReceiptIdentityInput,
        receiptId: u29LegacyReceiptId,
      };
      const u29LegacyDb = new DatabaseSync(staged.shell.paths.generationDatabase);
      try {
        u29LegacyDb.exec(`
          PRAGMA foreign_keys=ON;
          BEGIN IMMEDIATE;
          DROP TRIGGER studio_video_package_receipts_no_delete;
          DROP TRIGGER studio_video_package_intents_no_delete;
          DELETE FROM studio_video_package_verify_receipts
            WHERE intent_id='${u29SuccessorPrepared.intent.intentId}';
          DELETE FROM studio_video_package_export_intents
            WHERE intent_id='${u29SuccessorPrepared.intent.intentId}';
        `);
        u29LegacyDb.prepare(`INSERT INTO studio_video_package_export_intents(
          intent_id, operation_id, input_fingerprint, project_id,
          authority_kind, authority_id, authority_fingerprint,
          pack_id, pack_fingerprint, target_kind, target_key, unit_id, unit_revision, generation_run_id,
          raw_result_id, raw_sha256, labeled_result_id, labeled_sha256,
          dudu_import_receipt_fingerprint, dudu_registration_fingerprint, source_manifest_fingerprint,
          production_scope_fingerprint, contract_sha256,
          production_root, builder_relative_path, builder_sha256,
          source_spec_relative_path, source_spec_sha256, output_root_relative_path, package_relative_path,
          supersedes_intent_id, created_at, fingerprint
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          u29LegacyIntentId,
          u29LegacyIntentIdentityInput.operationId,
          u29LegacyIntentIdentityInput.inputFingerprint,
          u29LegacyIntentIdentityInput.projectId,
          u29LegacyIntentIdentityInput.authorityKind,
          u29LegacyIntentIdentityInput.authorityId,
          u29LegacyIntentIdentityInput.authorityFingerprint,
          u29LegacyIntentIdentityInput.packId,
          u29LegacyIntentIdentityInput.packFingerprint,
          u29LegacyIntentIdentityInput.targetKind,
          u29LegacyIntentIdentityInput.targetKey,
          u29LegacyIntentIdentityInput.unitId,
          u29LegacyIntentIdentityInput.unitRevision,
          u29LegacyIntentIdentityInput.generationRunId,
          u29LegacyIntentIdentityInput.rawResultId,
          u29LegacyIntentIdentityInput.rawSha256,
          u29LegacyIntentIdentityInput.labeledResultId,
          u29LegacyIntentIdentityInput.labeledSha256,
          u29LegacyIntentIdentityInput.duduImportReceiptFingerprint,
          u29LegacyIntentIdentityInput.duduRegistrationFingerprint,
          u29LegacyIntentIdentityInput.sourceManifestFingerprint,
          u29LegacyIntentIdentityInput.productionScopeFingerprint,
          u29LegacyIntentIdentityInput.contractSha256,
          u29LegacyIntentIdentityInput.productionRoot,
          u29LegacyIntentIdentityInput.builderRelativePath,
          u29LegacyIntentIdentityInput.builderSha256,
          u29LegacyIntentIdentityInput.sourceSpecRelativePath,
          u29LegacyIntentIdentityInput.sourceSpecSha256,
          u29LegacyIntentIdentityInput.outputRootRelativePath,
          u29LegacyIntentIdentityInput.packageRelativePath,
          u29LegacyIntentIdentityInput.supersedesIntentId,
          u29LegacyIntentIdentityInput.createdAt,
          stableDigest(u29LegacyIntentSemantic),
        );
        u29LegacyDb.prepare(`INSERT INTO studio_video_package_verify_receipts(
          receipt_id, intent_id, storage_kind, storage_relative_path, manifest_relative_path,
          manifest_sha256, manifest_fingerprint, files_json, spec_schema_version,
          package_status, i2v_readiness, mechanical_status, i2v_static_status,
          dynamic_model_status, verified_at, fingerprint
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          u29LegacyReceiptId,
          u29LegacyIntentId,
          u29LegacyReceiptIdentityInput.storageKind,
          u29LegacyReceiptIdentityInput.storageRelativePath,
          u29LegacyReceiptIdentityInput.manifestRelativePath,
          u29LegacyReceiptIdentityInput.manifestSha256,
          u29LegacyReceiptIdentityInput.manifestFingerprint,
          JSON.stringify(u29LegacyReceiptIdentityInput.files),
          u29LegacyReceiptIdentityInput.specSchemaVersion,
          u29LegacyReceiptIdentityInput.packageStatus,
          u29LegacyReceiptIdentityInput.i2vReadiness,
          u29LegacyReceiptIdentityInput.mechanicalStatus,
          u29LegacyReceiptIdentityInput.i2vStaticStatus,
          u29LegacyReceiptIdentityInput.dynamicModelStatus,
          u29LegacyReceiptIdentityInput.verifiedAt,
          stableDigest(u29LegacyReceiptSemantic),
        );
        u29LegacyDb.exec(`
          CREATE TRIGGER studio_video_package_intents_no_delete
            BEFORE DELETE ON studio_video_package_export_intents
            BEGIN SELECT RAISE(ABORT, 'video package intents are append-only'); END;
          CREATE TRIGGER studio_video_package_receipts_no_delete
            BEFORE DELETE ON studio_video_package_verify_receipts
            BEGIN SELECT RAISE(ABORT, 'video package receipts are append-only'); END;
          COMMIT;
        `);
      } catch (error) {
        try { u29LegacyDb.exec("ROLLBACK"); } catch {}
        throw error;
      } finally {
        u29LegacyDb.close();
      }
      await expect(readStudioVideoPackageExportIntentByOperationId(
        staged.shell.paths.root,
        u29LegacyIntentIdentityInput.operationId,
      )).resolves.toMatchObject({
        schemaVersion: 3,
        intentId: u29LegacyIntentId,
        fingerprint: stableDigest(u29LegacyIntentSemantic),
      });
      await expect(buildAndVerifyStudioVideoPackage(
        staged.shell.paths.root,
        u29LegacyIntentId,
      )).rejects.toMatchObject({ code: "input-drift" });

      const u29SecondObservation = await submitStudioPostResultObservation(staged.shell.paths.root, {
        operationId: "p30-video-u29-observation-v3-successor",
        generationRunId: u29Review.generationRunId,
        expectedHeadRevision: u29Observation.headRevision,
        expectedReviewId: u29Review.reviewId,
        expectedReviewFingerprint: u29Review.fingerprint,
        rawResultId: u29Review.rawResultId,
        rawSha256: u29Review.rawSha256,
        labeledResultId: u29Review.labeledResultId,
        labeledSha256: u29Review.labeledSha256,
        packId: u29Review.packId,
        packFingerprint: u29Review.packFingerprint,
        plannedContinuityFingerprint: u29Review.continuityFingerprint,
        evidenceKind: "accepted-last-frame",
        evidenceSha256: interimEvidence.sha256,
        observedState: {
          costume: "fixture 服装状态。",
          injury: "fixture 无可确认伤势。",
          heldObject: "fixture 无可确认持物。",
          position: "fixture 主体位于画面右侧。",
          facing: "fixture 主体朝向画面右侧。",
          emotion: "fixture 表情平静。",
          layout: "fixture 布局保持冻结。",
          lighting: "fixture 光线保持冻结。",
          referenceSha256: interimEvidence.sha256,
          motionVector: "静态图不可确认。",
          cameraPhase: "静态图不可确认。",
          focusState: "fixture 焦点在主体。",
          audioPhase: "静态图不可确认。",
        },
        observedAvailability: {
          costume: "observed",
          injury: "unknown",
          heldObject: "unknown",
          position: "observed",
          facing: "observed",
          emotion: "observed",
          layout: "observed",
          lighting: "observed",
          motionVector: "unknown",
          cameraPhase: "unknown",
          focusState: "observed",
          audioPhase: "not-applicable",
        },
        observer: "p30-video-package-test",
        note: "为 v3 external prior 创建可发布的 v4 successor。",
      });
      const u29V4Control = await getStudioPostResultObservationControl(
        staged.shell.paths.root,
        u29Review.generationRunId,
      );
      const u29V4Source = await prepareStudioVideoPackageSource(staged.shell.paths.root, {
        adapterKind: "managed-evidence-v1",
        reviewId: u29Review.reviewId,
        expectedReviewFingerprint: u29Review.fingerprint,
        expectedPackFingerprint: u29Pack!.fingerprint,
        expectedUnitSnapshotFingerprint: u29Snapshot!.fingerprint,
        expectedObservationControlFingerprint: u29V4Control.fingerprint,
        expectedObservationHeadRevision: u29V4Control.headRevision,
        expectedObservationStatus: u29V4Control.status,
        expectedObservationHeadId: u29V4Control.head?.observationId ?? null,
        expectedObservationHeadFingerprint: u29V4Control.head?.fingerprint ?? null,
        expectedObservationEvidenceSha256: u29V4Control.head?.evidenceSha256 ?? null,
      });
      const u29V4Prepared = await prepareStudioVideoPackageExport(staged.shell.paths.root, {
        operationId: "p30-video-u29-v3-prior-v4-successor",
        authority: { kind: "studio-review", reviewId: u29Review.reviewId },
        expectedManagedSource: {
          adapterKind: "managed-evidence-v1",
          reviewId: u29Review.reviewId,
          expectedSourceFingerprint: u29V4Source.fingerprint,
          expectedReviewFingerprint: u29Review.fingerprint,
          expectedPackFingerprint: u29Pack!.fingerprint,
          expectedUnitSnapshotFingerprint: u29Snapshot!.fingerprint,
          expectedObservationControlFingerprint: u29V4Control.fingerprint,
          expectedObservationHeadRevision: u29V4Control.headRevision,
          expectedObservationStatus: u29V4Control.status,
          expectedObservationHeadId: u29V4Control.head?.observationId ?? null,
          expectedObservationHeadFingerprint: u29V4Control.head?.fingerprint ?? null,
          expectedObservationEvidenceSha256: u29V4Control.head?.evidenceSha256 ?? null,
        },
      });
      expect(u29V4Prepared.intent).toMatchObject({
        schemaVersion: 5,
        supersedesIntentId: u29LegacyIntentId,
      });
      const u29V4Built = await buildAndVerifyStudioVideoPackage(
        staged.shell.paths.root,
        u29V4Prepared.intent.intentId,
      );
      expect(u29V4Built.receipt).toMatchObject({
        storageKind: "managed-evidence",
        i2vStaticStatus: "ready",
      });
      const u29Publication = await prepareStudioVideoPackagePublication(staged.shell.paths.root, {
        operationId: "p30-video-u29-v3-prior-publication",
        successorIntentId: u29V4Prepared.intent.intentId,
      });
      const u29Published = await publishStudioVideoPackageReplacement(
        staged.shell.paths.root,
        u29Publication.publication.publicationId,
      );
      expect(u29Published).toMatchObject({
        replayed: false,
        publication: {
          successorIntentId: u29V4Prepared.intent.intentId,
          priorExternalIntentId: u29LegacyIntentId,
        },
      });
      await expect(publishStudioVideoPackageReplacement(
        staged.shell.paths.root,
        u29Publication.publication.publicationId,
      )).resolves.toMatchObject({
        replayed: true,
        receipt: { publicationId: u29Publication.publication.publicationId },
      });
      const u29LegacyArchivePath = path.join(
        fixture.productionRoot,
        ...u29Publication.publication.archiveRelativePath.split("/"),
      );
      expect((await lstat(path.join(u29LegacyArchivePath, "manifest.json"))).isFile()).toBe(true);
      expect(u29SecondObservation.headRevision).toBe(u29V4Control.headRevision);

      const u29ThirdObservation = await submitStudioPostResultObservation(staged.shell.paths.root, {
        operationId: "p30-video-u29-observation-next-publication",
        generationRunId: u29Review.generationRunId,
        expectedHeadRevision: u29V4Control.headRevision,
        expectedReviewId: u29Review.reviewId,
        expectedReviewFingerprint: u29Review.fingerprint,
        rawResultId: u29Review.rawResultId,
        rawSha256: u29Review.rawSha256,
        labeledResultId: u29Review.labeledResultId,
        labeledSha256: u29Review.labeledSha256,
        packId: u29Review.packId,
        packFingerprint: u29Review.packFingerprint,
        plannedContinuityFingerprint: u29Review.continuityFingerprint,
        evidenceKind: "accepted-last-frame",
        evidenceSha256: interimEvidence.sha256,
        observedState: {
          costume: "fixture 服装状态。",
          injury: "fixture 无可确认伤势。",
          heldObject: "fixture 无可确认持物。",
          position: "fixture 主体回到画面中央。",
          facing: "fixture 主体朝向镜头。",
          emotion: "fixture 表情平静。",
          layout: "fixture 布局保持冻结。",
          lighting: "fixture 光线保持冻结。",
          referenceSha256: interimEvidence.sha256,
          motionVector: "静态图不可确认。",
          cameraPhase: "静态图不可确认。",
          focusState: "fixture 焦点在主体。",
          audioPhase: "静态图不可确认。",
        },
        observedAvailability: {
          costume: "observed",
          injury: "unknown",
          heldObject: "unknown",
          position: "observed",
          facing: "observed",
          emotion: "observed",
          layout: "observed",
          lighting: "observed",
          motionVector: "unknown",
          cameraPhase: "unknown",
          focusState: "observed",
          audioPhase: "not-applicable",
        },
        observer: "p30-video-package-test",
        note: "准备第二个 publication，用于验证同 destination pending 门。",
      });
      const u29NextControl = await getStudioPostResultObservationControl(
        staged.shell.paths.root,
        u29Review.generationRunId,
      );
      const u29NextSource = await prepareStudioVideoPackageSource(staged.shell.paths.root, {
        adapterKind: "managed-evidence-v1",
        reviewId: u29Review.reviewId,
        expectedReviewFingerprint: u29Review.fingerprint,
        expectedPackFingerprint: u29Pack!.fingerprint,
        expectedUnitSnapshotFingerprint: u29Snapshot!.fingerprint,
        expectedObservationControlFingerprint: u29NextControl.fingerprint,
        expectedObservationHeadRevision: u29NextControl.headRevision,
        expectedObservationStatus: u29NextControl.status,
        expectedObservationHeadId: u29NextControl.head?.observationId ?? null,
        expectedObservationHeadFingerprint: u29NextControl.head?.fingerprint ?? null,
        expectedObservationEvidenceSha256: u29NextControl.head?.evidenceSha256 ?? null,
      });
      const u29NextPrepared = await prepareStudioVideoPackageExport(staged.shell.paths.root, {
        operationId: "p30-video-u29-next-publication-successor",
        authority: { kind: "studio-review", reviewId: u29Review.reviewId },
        expectedManagedSource: {
          adapterKind: "managed-evidence-v1",
          reviewId: u29Review.reviewId,
          expectedSourceFingerprint: u29NextSource.fingerprint,
          expectedReviewFingerprint: u29Review.fingerprint,
          expectedPackFingerprint: u29Pack!.fingerprint,
          expectedUnitSnapshotFingerprint: u29Snapshot!.fingerprint,
          expectedObservationControlFingerprint: u29NextControl.fingerprint,
          expectedObservationHeadRevision: u29NextControl.headRevision,
          expectedObservationStatus: u29NextControl.status,
          expectedObservationHeadId: u29NextControl.head?.observationId ?? null,
          expectedObservationHeadFingerprint: u29NextControl.head?.fingerprint ?? null,
          expectedObservationEvidenceSha256: u29NextControl.head?.evidenceSha256 ?? null,
        },
      });
      const u29NextBuilt = await buildAndVerifyStudioVideoPackage(
        staged.shell.paths.root,
        u29NextPrepared.intent.intentId,
      );
      expect(u29NextBuilt.receipt).toMatchObject({
        storageKind: "managed-evidence",
        i2vStaticStatus: "ready",
      });
      const u29PendingPublication = await prepareStudioVideoPackagePublication(
        staged.shell.paths.root,
        {
          operationId: "p30-video-u29-pending-publication",
          successorIntentId: u29NextPrepared.intent.intentId,
        },
      );
      expect(u29PendingPublication.publication.successorIntentId)
        .toBe(u29NextPrepared.intent.intentId);
      const u29FourthObservation = await submitStudioPostResultObservation(staged.shell.paths.root, {
        operationId: "p30-video-u29-observation-pending-publication",
        generationRunId: u29Review.generationRunId,
        expectedHeadRevision: u29ThirdObservation.headRevision,
        expectedReviewId: u29Review.reviewId,
        expectedReviewFingerprint: u29Review.fingerprint,
        rawResultId: u29Review.rawResultId,
        rawSha256: u29Review.rawSha256,
        labeledResultId: u29Review.labeledResultId,
        labeledSha256: u29Review.labeledSha256,
        packId: u29Review.packId,
        packFingerprint: u29Review.packFingerprint,
        plannedContinuityFingerprint: u29Review.continuityFingerprint,
        evidenceKind: "accepted-last-frame",
        evidenceSha256: interimEvidence.sha256,
        observedState: {
          costume: "fixture 服装状态。",
          injury: "fixture 无可确认伤势。",
          heldObject: "fixture 无可确认持物。",
          position: "fixture 主体位于画面左侧。",
          facing: "fixture 主体朝向画面左侧。",
          emotion: "fixture 表情平静。",
          layout: "fixture 布局保持冻结。",
          lighting: "fixture 光线保持冻结。",
          referenceSha256: interimEvidence.sha256,
          motionVector: "静态图不可确认。",
          cameraPhase: "静态图不可确认。",
          focusState: "fixture 焦点在主体。",
          audioPhase: "静态图不可确认。",
        },
        observedAvailability: {
          costume: "observed",
          injury: "unknown",
          heldObject: "unknown",
          position: "observed",
          facing: "observed",
          emotion: "observed",
          layout: "observed",
          lighting: "observed",
          motionVector: "unknown",
          cameraPhase: "unknown",
          focusState: "observed",
          audioPhase: "not-applicable",
        },
        observer: "p30-video-package-test",
        note: "pending publication 后制造新 source，export 必须失败关闭。",
      });
      const u29BlockedControl = await getStudioPostResultObservationControl(
        staged.shell.paths.root,
        u29Review.generationRunId,
      );
      expect(u29FourthObservation.headRevision).toBe(u29BlockedControl.headRevision);
      const u29BlockedSource = await prepareStudioVideoPackageSource(staged.shell.paths.root, {
        adapterKind: "managed-evidence-v1",
        reviewId: u29Review.reviewId,
        expectedReviewFingerprint: u29Review.fingerprint,
        expectedPackFingerprint: u29Pack!.fingerprint,
        expectedUnitSnapshotFingerprint: u29Snapshot!.fingerprint,
        expectedObservationControlFingerprint: u29BlockedControl.fingerprint,
        expectedObservationHeadRevision: u29BlockedControl.headRevision,
        expectedObservationStatus: u29BlockedControl.status,
        expectedObservationHeadId: u29BlockedControl.head?.observationId ?? null,
        expectedObservationHeadFingerprint: u29BlockedControl.head?.fingerprint ?? null,
        expectedObservationEvidenceSha256: u29BlockedControl.head?.evidenceSha256 ?? null,
      });
      await expect(prepareStudioVideoPackageExport(staged.shell.paths.root, {
        operationId: "p30-video-u29-blocked-by-pending-publication",
        authority: { kind: "studio-review", reviewId: u29Review.reviewId },
        expectedManagedSource: {
          adapterKind: "managed-evidence-v1",
          reviewId: u29Review.reviewId,
          expectedSourceFingerprint: u29BlockedSource.fingerprint,
          expectedReviewFingerprint: u29Review.fingerprint,
          expectedPackFingerprint: u29Pack!.fingerprint,
          expectedUnitSnapshotFingerprint: u29Snapshot!.fingerprint,
          expectedObservationControlFingerprint: u29BlockedControl.fingerprint,
          expectedObservationHeadRevision: u29BlockedControl.headRevision,
          expectedObservationStatus: u29BlockedControl.status,
          expectedObservationHeadId: u29BlockedControl.head?.observationId ?? null,
          expectedObservationHeadFingerprint: u29BlockedControl.head?.fingerprint ?? null,
          expectedObservationEvidenceSha256: u29BlockedControl.head?.evidenceSha256 ?? null,
        },
      })).rejects.toMatchObject({ code: "destination-conflict" });
      }

      // 视频账本、dispatch/result/Review 和新增 CAS 都是受控增长；不可变导入身份仍应有效。
      await expect(getActiveDuduReadonlyProjectIdentity(staged.shell.paths.root)).resolves.toMatchObject({
        projectId: staged.shell.project.id,
        importReceiptFingerprint: staged.receipt.fingerprint,
      });
      for (let index = 0; index < 31; index += 1) {
        await registerProject({
          ...staged.shell.project,
          id: `p30-registry-retention-${String(index).padStart(2, "0")}`,
          name: `P30 registry retention ${index}`,
          primaryRoot: path.join(fixture.root, "registry-retention", String(index)),
        });
      }
      expect((await listRegisteredProjects()).some((project) => project.id === staged.shell.project.id)).toBe(true);
      const duplicateProjectsRoot = path.join(fixture.root, "duplicate-projects");
      await mkdir(duplicateProjectsRoot, { recursive: true });
      const duplicateStage = await stageDuduReadonlyManagedProject({
        projectsRoot: duplicateProjectsRoot,
        source: fixture.source,
      });
      await expect(finalizeDuduReadonlyManagedProject(duplicateStage.shell.paths.root, fixture.source))
        .rejects.toThrow(/禁止建立平行真相源/u);
      await expect(getActiveDuduReadonlyProjectIdentity(staged.shell.paths.root)).resolves.toMatchObject({
        projectId: staged.shell.project.id,
        activationId: finalized.activationId,
      });
      const machineStatePath = path.join(fixture.productionRoot, "02_出图总表/00_S1E1_生产状态.json");
      const machineState = JSON.parse(await readFile(machineStatePath, "utf8")) as Record<string, unknown>;
      machineState.projection_test_note = "mutable projection may grow without changing immutable source identity";
      const validMutableMachineState = `${JSON.stringify(machineState, null, 2)}\n`;
      await writeFile(machineStatePath, validMutableMachineState);
      await expect(getActiveDuduReadonlyProjectIdentity(staged.shell.paths.root)).resolves.toMatchObject({
        projectId: staged.shell.project.id,
        importReceiptFingerprint: staged.receipt.fingerprint,
      });
      await writeFile(machineStatePath, "{}\n");
      await expect(getActiveDuduReadonlyProjectIdentity(staged.shell.paths.root)).rejects.toThrow(/当前机器状态单元数应为 33/u);
      await writeFile(machineStatePath, validMutableMachineState);
      const regressedMachineState = JSON.parse(validMutableMachineState) as {
        units: Array<Record<string, unknown>>;
        summary: Record<string, unknown>;
      };
      regressedMachineState.units[0]!.storyboard_status = "PENDING";
      regressedMachineState.summary.storyboard_pass_count = 27;
      regressedMachineState.summary.earliest_storyboard_pending = "S1E01-U00";
      await writeFile(machineStatePath, `${JSON.stringify(regressedMachineState, null, 2)}\n`);
      await expect(getActiveDuduReadonlyProjectIdentity(staged.shell.paths.root)).rejects.toThrow(/历史 PASS\/approved raw 身份发生倒退/u);
      await writeFile(machineStatePath, validMutableMachineState);
      await appendFile(fixture.builderPath, "\n# immutable drift\n");
      await expect(getActiveDuduReadonlyProjectIdentity(staged.shell.paths.root)).rejects.toThrow(/冻结来源文件(?:大小|内容)漂移/u);
    } finally {
      await mcpClient?.close().catch(() => undefined);
      if (priorRegistry === undefined) delete process.env.AI_CANVAS_REGISTRY_PATH;
      else process.env.AI_CANVAS_REGISTRY_PATH = priorRegistry;
      if (priorCounter === undefined) delete process.env.P30_TEST_BUILDER_COUNTER;
      else process.env.P30_TEST_BUILDER_COUNTER = priorCounter;
      if (priorBuilderFault === undefined) delete process.env.P30_TEST_BUILDER_FAULT;
      else process.env.P30_TEST_BUILDER_FAULT = priorBuilderFault;
      if (priorInstallFault === undefined) delete process.env.P30_TEST_INSTALL_FAULT;
      else process.env.P30_TEST_INSTALL_FAULT = priorInstallFault;
      if (priorPythonPath === undefined) delete process.env.PYTHONPATH;
      else process.env.PYTHONPATH = priorPythonPath;
      if (priorCommandCrash === undefined) delete process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE;
      else process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE = priorCommandCrash;
      if (priorFinalCasBarrier === undefined) delete process.env.P30_TEST_VIDEO_PACKAGE_FINAL_CAS_BARRIER;
      else process.env.P30_TEST_VIDEO_PACKAGE_FINAL_CAS_BARRIER = priorFinalCasBarrier;
      if (priorReceiptCasBarrier === undefined) delete process.env.P30_TEST_VIDEO_PACKAGE_RECEIPT_CAS_BARRIER;
      else process.env.P30_TEST_VIDEO_PACKAGE_RECEIPT_CAS_BARRIER = priorReceiptCasBarrier;
      if (priorReceiptPostCasBarrier === undefined) {
        delete process.env.P30_TEST_VIDEO_PACKAGE_RECEIPT_POST_CAS_BARRIER;
      } else {
        process.env.P30_TEST_VIDEO_PACKAGE_RECEIPT_POST_CAS_BARRIER = priorReceiptPostCasBarrier;
      }
      await fixture.cleanup();
      await rm(counterPath, { force: true });
    }
    // v4 successor 回归会额外执行一次真实 managed-source 漂移与确定性重建；
    // 空闲单跑已超过旧 600s 门，且本用例合并最终/receipt CAS、rename
    // 崩溃恢复、v3→v4 publication 与 pending 门；留出 1200s，避免把
    // 完整真实链路的耗时误判为功能失败。
  }, 1_200_000);
});
