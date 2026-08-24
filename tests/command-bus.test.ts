import { createHash } from "node:crypto";
import { access, chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { seedProductionReady } from "./workflow-helpers.js";
import { executeIdempotentCommand, listCommandLedger, reconcileCommand } from "../src/core/command-bus.js";
import { getCanvasSemanticState } from "../src/core/canvas-state.js";
import { listProjectContext, upsertProjectContext } from "../src/core/memory.js";
import { listAssetRelations, listVoiceIdentities, upsertAssetRelation, upsertVoiceIdentity } from "../src/core/asset-registry.js";
import { getProductionWorkflow, listCreativeBibles, upsertCreativeBible } from "../src/core/production.js";
import { createTaskPack, scanAndPersist } from "../src/core/service.js";
import { appendEvent, ensureSidecar, getSidecarPaths, listEvents, listTaskPacks, loadIndex, writeJsonAtomic } from "../src/core/sidecar.js";
import { listProjectLocks } from "../src/core/locks.js";
import { upsertCommandLedgerEntry } from "../src/core/command-ledger-store.js";
import { previewFusionStoryboardSheetMigration } from "../src/core/fusion-storyboard-sheet-migration.js";
import {
  FUSION_STORYBOARD_SHEET_RENDER_POLICY_VERSION,
  buildFusionStoryboardSheetId,
  fusionStoryboardSheetInputFingerprint,
  loadFusionStoryboardSheetStore,
  registerFusionStoryboardSheetRecord,
  registerLegacyFusionStoryboardSheetRecord,
  type FusionStoryboardSheetCurrentEvidence,
  type FusionStoryboardSheetRegistrationInput,
} from "../src/core/fusion-storyboard-sheet-store.js";

const roots: string[] = [];
const execFileAsync = promisify(execFile);
afterEach(async () => { delete process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE; delete process.env.AI_CANVAS_TEST_COMMAND_CRASH_BEFORE_COMMIT_EVENT; delete process.env.AI_CANVAS_TEST_COMMAND_DELAY_COMMAND; delete process.env.AI_CANVAS_TEST_COMMAND_DELAY_MS; await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-command-"));
  roots.push(root);
  const config = await ensureSidecar(root);
  config.sourceRoots = [];
  config.outputRoots = [root];
  await writeJsonAtomic(getSidecarPaths(root).config, config);
  const directory = path.join(root, "EP01_15s_001_幂等测试");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "00_信息.md"), "首帧提示词：幂等测试。\n尾帧提示词：保持连续。\n", "utf8");
  await scanAndPersist(root);
  await seedProductionReady(root, "frames");
  return root;
}

function sha(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function p4MigrationFixture() {
  const root = await fixture();
  const index = await loadIndex(root);
  if (!index) throw new Error("测试夹具缺少扫描索引。 ");
  const directory = path.join(root, "production", "EP01", "AI画布生成");
  await mkdir(directory, { recursive: true });
  const pngPath = path.join(directory, "EP01_15s_001_中文分镜板_legacy.png");
  const svgPath = path.join(directory, "EP01_15s_001_中文分镜板_legacy.svg");
  const receiptPath = path.join(directory, "EP01_15s_001_中文分镜板_legacy.json");
  const png = Buffer.from("p4-command-migration-png");
  const svg = Buffer.from("<svg>p4-command-migration</svg>");
  await Promise.all([writeFile(pngPath, png), writeFile(svgPath, svg)]);
  await writeFile(receiptPath, `${JSON.stringify({
    schemaVersion: 1,
    kind: "fusion-storyboard-sheet-production-receipt",
    projectId: index.project.id,
    itemId: "main-ep01-unit001",
    contractId: "grid-command-p4",
    sourceFingerprint: sha("p4-command-source"),
    productionFingerprint: sha("p4-command-production"),
    reviewId: "review-command-p4",
    requirementId: `fusion-review-${sha("p4-command-requirement")}`,
    png: { path: pngPath, sha256: sha(png), bytes: png.length },
    svg: { path: svgPath, sha256: sha(svg), bytes: svg.length },
    width: 2_160,
    height: 3_840,
    panelCount: 2,
    durationSeconds: 15,
    renderPurpose: "formal",
    formalProductionEligible: true,
  }, null, 2)}\n`, "utf8");
  const preview = await previewFusionStoryboardSheetMigration(root, { itemIds: ["main-ep01-unit001"] });
  return { root, pngPath, preview };
}

async function removeTerminalReceipts(projectRoot: string, idempotencyKey: string): Promise<void> {
  const eventsPath = getSidecarPaths(projectRoot).events;
  const raw = await readFile(eventsPath, "utf8");
  const kept = raw.split("\n").filter((line) => {
    if (!line.trim()) return false;
    const event = JSON.parse(line) as { type?: string; idempotencyKey?: string };
    return event.type !== "command.side-effect-committed" || event.idempotencyKey !== idempotencyKey;
  });
  await writeFile(eventsPath, kept.length ? `${kept.join("\n")}\n` : "", "utf8");
}

async function p4RenderRegistrationFixture(root: string): Promise<{
  evidence: FusionStoryboardSheetCurrentEvidence;
  registration: FusionStoryboardSheetRegistrationInput;
  inputFingerprint: string;
  sheetId: string;
}> {
  const panels = [1, 2].map((panelIndex) => ({
    panelId: `panel-${panelIndex}`,
    panelIndex,
    panelCount: 2,
    generationJobId: `job-render-${panelIndex}`,
    generationJobFingerprint: sha(`job-render-${panelIndex}`),
    publicationReceiptId: `publication-render-${panelIndex}`,
    publicationReceiptFingerprint: sha(`publication-render-${panelIndex}`),
    raw: { artifactId: `raw-render-${panelIndex}`, path: path.join(root, `raw-${panelIndex}.png`), sha256: sha(`raw-${panelIndex}`), bytes: 101 + panelIndex },
    labeled: { artifactId: `labeled-render-${panelIndex}`, path: path.join(root, `labeled-${panelIndex}.png`), sha256: sha(`labeled-${panelIndex}`), bytes: 201 + panelIndex },
  }));
  const evidence: FusionStoryboardSheetCurrentEvidence = {
    projectId: "project-command-p4-render",
    sourceContentAddress: `sha256:${sha("command-p4-render-source")}`,
    itemId: "main-ep01-unit001",
    contract: {
      contractId: "grid-command-p4-render",
      sourceFingerprint: sha("command-p4-render-contract-source"),
      productionFingerprint: sha("command-p4-render-contract-production"),
      contractFingerprint: sha("command-p4-render-contract"),
    },
    requirement: { requirementId: `fusion-review-${sha("command-p4-render-requirement-id")}`, requirementFingerprint: sha("command-p4-render-requirement"), complete: true },
    review: { reviewId: "review-command-p4-render", reviewFingerprint: sha("command-p4-render-review"), decision: "pass" },
    panels,
    renderPolicy: {
      policyVersion: FUSION_STORYBOARD_SHEET_RENDER_POLICY_VERSION,
      renderer: "svg-sharp-v2",
      locale: "zh-CN",
      defaultImageFit: "contain",
      textMeasurement: "deterministic-character-units-v2",
      overflowPolicy: "long-sheet",
      rowHeightPolicy: "dynamic-content-measured",
      silentTruncation: false,
      pageWidth: 2_160,
      basePageHeight: 3_840,
      maximumPageHeight: 12_000,
      panelImagePolicies: Object.fromEntries(panels.map((panel) => [panel.panelId, { fit: "contain" as const }])),
    },
  };
  const png = Buffer.from("command-p4-render-output-png");
  const svg = Buffer.from("<svg>command-p4-render-output</svg>");
  const inputFingerprint = fusionStoryboardSheetInputFingerprint(evidence);
  const sheetId = buildFusionStoryboardSheetId(evidence);
  const outputDirectory = path.join(root, "outputs", sheetId);
  await mkdir(outputDirectory, { recursive: true });
  const pngPath = path.join(outputDirectory, `${sheetId}-p01.png`);
  const svgPath = path.join(outputDirectory, `${sheetId}-p01.svg`);
  await Promise.all([writeFile(pngPath, png), writeFile(svgPath, svg)]);
  const fields = ["imageContentAction", "shotComposition", "shootingMethod", "continuitySound", "dialogueSubtitle"] as const;
  const registration: FusionStoryboardSheetRegistrationInput = {
    ...evidence,
    renderEvidence: {
      renderFingerprint: sha("command-p4-render-result"),
      cropAudit: panels.map((panel) => ({ panelId: panel.panelId, fit: "contain", geometry: "none", sourceWidth: 720, sourceHeight: 1280, orientedWidth: 720, orientedHeight: 1280, targetWidth: 570, targetHeight: 720, cropApplied: false })),
      overflowReport: {
        policy: "long-sheet",
        basePageHeight: 3_840,
        actualPageHeight: 3_840,
        expanded: false,
        overflowPixels: 0,
        allRequiredTextVisible: true,
        silentTruncation: false,
        truncatedFields: [],
        rows: panels.map((panel, index) => ({
          panelId: panel.panelId,
          top: 320 + index * 1_500,
          height: 1_450,
          textFields: fields.map((field) => ({ panelId: panel.panelId, field, contentSha256: sha(`${panel.panelId}-${field}`), lineCount: 1, requiredHeight: 48, allocatedHeight: 64, complete: true })),
        })),
      },
    },
    outputs: [
      { role: "png", path: pngPath, sha256: sha(png), bytes: png.length, width: 2_160, height: 3_840, pageIndex: 1, pageCount: 1 },
      { role: "svg", path: svgPath, sha256: sha(svg), bytes: svg.length, width: 2_160, height: 3_840, pageIndex: 1, pageCount: 1 },
    ],
  };
  return { evidence, registration, inputFingerprint, sheetId };
}

describe("Codex 幂等命令总线", () => {
  it("相同幂等键只执行一次，不同参数复用时拒绝", async () => {
    const root = await fixture();
    const input = {
      requestId: "request-command-0001",
      idempotencyKey: "status-main-ep01-unit001-blocked-v1",
      request: { command: "update_status" as const, payload: { itemId: "main-ep01-unit001", status: "阻塞" as const, note: "等待导演确认" } },
    };
    const first = await executeIdempotentCommand(root, input);
    expect(first.replayed).toBe(false);
    const replay = await executeIdempotentCommand(root, { ...input, requestId: "request-command-0002" });
    expect(replay.replayed).toBe(true);
    expect(replay.requestHash).toBe(first.requestHash);
    await expect(executeIdempotentCommand(root, { ...input, requestId: "request-command-0003", request: { ...input.request, payload: { ...input.request.payload, note: "不同参数" } } })).rejects.toThrow("幂等键已用于不同参数");
    expect(await listCommandLedger(root)).toHaveLength(1);
    const events = await listEvents(root, 100);
    expect(events.filter((event) => event.type === "command.executed")).toHaveLength(1);
    expect(events.filter((event) => event.type === "item.status_updated")).toHaveLength(1);
  });

  it("任务租约命令强制修订号且同幂等键仍直接重放原结果", async () => {
    const root = await fixture();
    const { task } = await createTaskPack(root, { kind: "image" });
    const input = {
      requestId: "request-claim-revision-001",
      idempotencyKey: "claim-task-revision-unit001-v1",
      request: { command: "claim_task" as const, payload: { taskId: task.id, agentId: "codex-command", expectedRevision: task.revision } },
    };
    const first = await executeIdempotentCommand(root, input);
    expect(first.replayed).toBe(false);
    expect(first.result).toEqual(expect.objectContaining({ status: "claimed", revision: task.revision + 1 }));
    const replay = await executeIdempotentCommand(root, { ...input, requestId: "request-claim-revision-002" });
    expect(replay.replayed).toBe(true);
    expect(replay.result).toEqual(first.result);
    const tasks = await listTaskPacks(root);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toEqual(expect.objectContaining({ status: "claimed", revision: task.revision + 1 }));
    expect((await listEvents(root, 100)).filter((event) => event.type === "task.claimed")).toHaveLength(1);
  });

  it("统一入口覆盖项目记忆、画布语义和任务包等主要写操作", async () => {
    const root = await fixture();
    const contextCommand = { requestId: "request-context-command-001", idempotencyKey: "context-main-continuity-001", request: { command: "upsert_context" as const, payload: { kind: "continuity" as const, title: "角色连续性", content: "阿航不得换脸。", itemIds: ["main-ep01-unit001"] } } };
    const savedContext = await executeIdempotentCommand(root, contextCommand);
    expect(savedContext.replayed).toBe(false);
    expect((await executeIdempotentCommand(root, { ...contextCommand, requestId: "request-context-command-002" })).replayed).toBe(true);
    await executeIdempotentCommand(root, { requestId: "request-canvas-command-001", idempotencyKey: "canvas-note-main-unit001-001", request: { command: "upsert_canvas_entity", payload: { kind: "note", title: "导演批注", body: "保持运动方向。", position: { x: 120, y: 80 } } } });
    await executeIdempotentCommand(root, { requestId: "request-taskpack-command-001", idempotencyKey: "taskpack-image-main-unit001-001", request: { command: "create_task_pack", payload: { itemIds: ["main-ep01-unit001"], mode: "autopilot", kind: "image" } } });
    expect((await listProjectContext(root))[0]?.title).toBe("角色连续性");
    expect((await getCanvasSemanticState(root)).entities[0]?.title).toBe("导演批注");
    expect(await listTaskPacks(root)).toHaveLength(1);
    expect(await listCommandLedger(root)).toHaveLength(3);
  });

  it("长期事实 CAS 写前拒绝形成 failed/committed:false 而不是 unknown", async () => {
    const root = await fixture();
    const secondDirectory = path.join(root, "EP01_15s_002_幂等测试二号");
    await mkdir(secondDirectory, { recursive: true });
    await writeFile(path.join(secondDirectory, "00_信息.md"), "首帧提示词：第二单元。\n尾帧提示词：保持连续。\n", "utf8");
    await scanAndPersist(root);
    const workflow = await getProductionWorkflow(root);
    const bible = await upsertCreativeBible(root, { kind: "director", name: "账本 Bible", summary: "测试 CAS" });
    const relation = await upsertAssetRelation(root, { kind: "reference_of", parentItemId: "main-ep01-unit001", childItemId: "main-ep01-unit002" });
    const voice = await upsertVoiceIdentity(root, { name: "账本音色", tags: ["保留"] });
    const context = await upsertProjectContext(root, { kind: "decision", title: "账本记忆", content: "测试 CAS" });

    const rejectedRequests = [
      { command: "update_workflow_stage", payload: { stageId: "source", status: "in_progress" } },
      { command: "upsert_creative_bible", payload: { id: bible.id, kind: bible.kind, name: bible.name, summary: bible.summary } },
      { command: "upsert_asset_relation", payload: { id: relation.id, kind: relation.kind, parentItemId: relation.parentItemId, childItemId: relation.childItemId } },
      { command: "upsert_voice_identity", payload: { id: voice.id, name: voice.name } },
      { command: "upsert_context", payload: { id: context.id, kind: context.kind, title: context.title, content: context.content } },
      { command: "delete_context", payload: { contextId: context.id } },
    ] as const;

    for (const [index, request] of rejectedRequests.entries()) {
      await expect(executeIdempotentCommand(root, {
        requestId: `request-long-lived-rejected-${String(index).padStart(2, "0")}`,
        idempotencyKey: `long-lived-rejected-${String(index).padStart(2, "0")}-v1`,
        request: request as any,
      })).rejects.toMatchObject({ name: "RejectedCommandFailure", result: { applied: false, reason: "revision_required" } });
    }

    const ledger = await listCommandLedger(root);
    expect(ledger.filter((entry) => entry.idempotencyKey.startsWith("long-lived-rejected-"))).toHaveLength(6);
    expect(ledger.filter((entry) => entry.idempotencyKey.startsWith("long-lived-rejected-")).every((entry) => entry.status === "failed" && (entry.result as any)?.reason === "revision_required")).toBe(true);
    const events = await listEvents(root, 300);
    const failed = events.filter((event) => event.type === "command.failed" && event.idempotencyKey?.startsWith("long-lived-rejected-"));
    expect(failed).toHaveLength(6);
    expect(failed.every((event) => event.data?.committed === false)).toBe(true);
    expect(events.some((event) => event.type === "command.outcome-unknown" && event.idempotencyKey?.startsWith("long-lived-rejected-"))).toBe(false);
    expect((await getProductionWorkflow(root)).revision).toBe(workflow.revision);
    expect((await listCreativeBibles(root)).find((entry) => entry.id === bible.id)?.revision).toBe(bible.revision);
    expect((await listAssetRelations(root)).find((entry) => entry.id === relation.id)?.revision).toBe(relation.revision);
    expect((await listVoiceIdentities(root)).find((entry) => entry.id === voice.id)?.revision).toBe(voice.revision);
    expect((await listProjectContext(root)).find((entry) => entry.id === context.id)?.revision).toBe(context.revision);
  });

  it("副作用后回执中断会锁定为 unknown，重试不会重复执行", async () => {
    const root = await fixture();
    process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE = "create_task_pack";
    const input = { requestId: "request-crash-window-001", idempotencyKey: "taskpack-crash-window-unit001-v1", request: { command: "create_task_pack" as const, payload: { itemIds: ["main-ep01-unit001"], mode: "autopilot" as const, kind: "image" as const } } };
    await expect(executeIdempotentCommand(root, input)).rejects.toThrow("结果未确认");
    expect(await listTaskPacks(root)).toHaveLength(1);
    expect((await listCommandLedger(root))[0]?.status).toBe("unknown");
    delete process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE;
    await expect(executeIdempotentCommand(root, { ...input, requestId: "request-crash-window-002" })).rejects.toThrow("禁止自动重放");
    expect(await listTaskPacks(root)).toHaveLength(1);
    expect((await listEvents(root, 100)).filter((event) => event.type === "command.outcome-unknown")).toHaveLength(1);
    const reconciled = await reconcileCommand(root, { idempotencyKey: input.idempotencyKey });
    expect(reconciled.status).toBe("succeeded");
    expect(reconciled.result).toEqual(expect.objectContaining({
      reconciled: true,
      evidenceEvents: expect.arrayContaining([
        expect.objectContaining({ type: "command.side-effect-committed" }),
      ]),
    }));
    const replayed = await executeIdempotentCommand(root, { ...input, requestId: "request-crash-window-003" });
    expect(replayed.replayed).toBe(true);
    expect(await listTaskPacks(root)).toHaveLength(1);
  });

  it("成功终态收据只保存摘要，不复制命令返回中的正文或绝对路径", async () => {
    const root = await fixture();
    const contentSentinel = "RECEIPT_CONTENT_MUST_NOT_LEAK_20260813";
    const pathSentinel = "/ABSOLUTE_RECEIPT_LEAK_SENTINEL/private.md";
    const input = {
      requestId: "request-terminal-receipt-redaction-001",
      idempotencyKey: "terminal-receipt-redaction-context-v1",
      request: {
        command: "upsert_context" as const,
        payload: {
          kind: "continuity" as const,
          title: "回执脱敏",
          content: `${contentSentinel}\n${pathSentinel}`,
          itemIds: ["main-ep01-unit001"],
        },
      },
    };
    const result = await executeIdempotentCommand(root, input);
    expect(JSON.stringify(result.result)).toContain(contentSentinel);
    const terminal = (await listEvents(root, 200)).find((event) =>
      event.type === "command.side-effect-committed"
      && event.idempotencyKey === input.idempotencyKey);
    expect(terminal?.data?.resultDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(terminal?.data).not.toHaveProperty("result");
    expect(JSON.stringify(terminal?.data)).not.toContain(contentSentinel);
    expect(JSON.stringify(terminal?.data)).not.toContain(pathSentinel);
  });

  it("摘要型成功收据必须拒绝终态账本结果漂移，reconcile 与同键重放均不重进 domain", async () => {
    const root = await fixture();
    const input = {
      requestId: "request-terminal-ledger-digest-drift-001",
      idempotencyKey: "terminal-ledger-digest-drift-taskpack-v1",
      request: {
        command: "create_task_pack" as const,
        payload: {
          itemIds: ["main-ep01-unit001"],
          mode: "autopilot" as const,
          kind: "image" as const,
        },
      },
    };
    await expect(executeIdempotentCommand(root, input)).resolves.toMatchObject({ status: "succeeded" });
    const terminal = (await listEvents(root, 200)).find((event) =>
      event.type === "command.side-effect-committed" && event.idempotencyKey === input.idempotencyKey);
    expect(terminal?.data).not.toHaveProperty("result");
    const original = (await listCommandLedger(root)).find((entry) => entry.idempotencyKey === input.idempotencyKey)!;
    await upsertCommandLedgerEntry(root, {
      ...original,
      result: { schemaVersion: 1, tampered: true },
    }, original.executedAt);

    await expect(reconcileCommand(root, { idempotencyKey: input.idempotencyKey }))
      .rejects.toThrow("账本结果摘要与终态收据冲突");
    await expect(executeIdempotentCommand(root, { ...input, requestId: "request-terminal-ledger-digest-drift-002" }))
      .rejects.toThrow("账本结果摘要与终态收据冲突");
    await upsertCommandLedgerEntry(root, {
      ...original,
      result: undefined,
    }, original.executedAt);
    await expect(reconcileCommand(root, { idempotencyKey: input.idempotencyKey }))
      .rejects.toThrow("终态账本缺少结果且终态收据仅含摘要");
    expect(await listTaskPacks(root)).toHaveLength(1);
    expect((await listEvents(root, 200)).filter((event) =>
      event.type === "task.created" && event.idempotencyKey === input.idempotencyKey)).toHaveLength(1);
  });

  it("同一命令出现不同摘要的终态收据时失败关闭且不改写账本", async () => {
    const root = await fixture();
    const input = {
      requestId: "request-terminal-receipt-conflict-001",
      idempotencyKey: "terminal-receipt-conflict-taskpack-v1",
      request: {
        command: "create_task_pack" as const,
        payload: {
          itemIds: ["main-ep01-unit001"],
          mode: "autopilot" as const,
          kind: "image" as const,
        },
      },
    };
    process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE = input.request.command;
    try {
      await expect(executeIdempotentCommand(root, input)).rejects.toThrow("结果未确认");
    } finally {
      delete process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE;
    }
    const original = (await listEvents(root, 200)).find((event) =>
      event.type === "command.side-effect-committed"
      && event.idempotencyKey === input.idempotencyKey);
    expect(original?.data?.resultDigest).toMatch(/^[a-f0-9]{64}$/u);
    await appendEvent(root, {
      actor: "codex",
      type: "command.side-effect-committed",
      requestId: input.requestId,
      idempotencyKey: input.idempotencyKey,
      command: input.request.command,
      data: {
        ...(original?.data ?? {}),
        resultDigest: "f".repeat(64),
      },
    });
    await expect(reconcileCommand(root, {
      idempotencyKey: input.idempotencyKey,
    })).rejects.toThrow("互相冲突的终态收据");
    expect((await listCommandLedger(root))[0]?.status).toBe("unknown");
    expect(await listTaskPacks(root)).toHaveLength(1);
  });

  it("同摘要的成功与失败终态收据冲突时失败关闭", async () => {
    const root = await fixture();
    const input = {
      requestId: "request-terminal-receipt-status-conflict-001",
      idempotencyKey: "terminal-receipt-status-conflict-taskpack-v1",
      request: {
        command: "create_task_pack" as const,
        payload: {
          itemIds: ["main-ep01-unit001"],
          mode: "autopilot" as const,
          kind: "image" as const,
        },
      },
    };
    process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE = input.request.command;
    try {
      await expect(executeIdempotentCommand(root, input)).rejects.toThrow("结果未确认");
    } finally {
      delete process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE;
    }
    const original = (await listEvents(root, 200)).find((event) =>
      event.type === "command.side-effect-committed"
      && event.idempotencyKey === input.idempotencyKey);
    await appendEvent(root, {
      actor: "codex",
      type: "command.side-effect-committed",
      requestId: input.requestId,
      idempotencyKey: input.idempotencyKey,
      command: input.request.command,
      data: {
        ...(original?.data ?? {}),
        outcomeStatus: "failed",
        error: "测试终态失败",
      },
    });

    await expect(reconcileCommand(root, {
      idempotencyKey: input.idempotencyKey,
    })).rejects.toThrow("互相冲突的终态收据");
    expect((await listCommandLedger(root))[0]?.status).toBe("unknown");
    expect(await listTaskPacks(root)).toHaveLength(1);
  });

  it("只有中间业务事件时不能把 unknown 错判为成功", async () => {
    const root = await fixture();
    process.env.AI_CANVAS_TEST_COMMAND_CRASH_BEFORE_COMMIT_EVENT = "create_task_pack";
    const input = { requestId: "request-partial-event-001", idempotencyKey: "taskpack-partial-event-unit001-v1", request: { command: "create_task_pack" as const, payload: { itemIds: ["main-ep01-unit001"], mode: "autopilot" as const, kind: "image" as const } } };
    try { await expect(executeIdempotentCommand(root, input)).rejects.toThrow("结果未确认"); }
    finally { delete process.env.AI_CANVAS_TEST_COMMAND_CRASH_BEFORE_COMMIT_EVENT; }
    expect((await listEvents(root, 100)).some((event) => event.type === "task.created")).toBe(true);
    await expect(reconcileCommand(root, { idempotencyKey: input.idempotencyKey })).rejects.toThrow("终态提交证据");
  });

  it("P4 migration 业务 store 落盘后、终态事件前崩溃时由候选指纹确定恢复且不重复登记", async () => {
    const sample = await p4MigrationFixture();
    expect(sample.preview).toMatchObject({ storeRevision: 0, candidateCount: 1, pendingCount: 1, blockers: [] });
    const input = {
      requestId: "request-p4-migration-crash-001",
      idempotencyKey: "p4-migration-crash-after-store-v1",
      request: {
        command: "migrate_fusion_storyboard_sheets" as const,
        payload: {
          itemIds: ["main-ep01-unit001"],
          expectedStoreRevision: sample.preview.storeRevision,
          expectedCandidateFingerprint: sample.preview.candidateFingerprint,
        },
      },
    };
    process.env.AI_CANVAS_TEST_COMMAND_CRASH_BEFORE_COMMIT_EVENT = input.request.command;
    try { await expect(executeIdempotentCommand(sample.root, input)).rejects.toThrow("结果未确认"); }
    finally { delete process.env.AI_CANVAS_TEST_COMMAND_CRASH_BEFORE_COMMIT_EVENT; }

    const afterCrash = await loadFusionStoryboardSheetStore(sample.root);
    expect(afterCrash.revision).toBe(1);
    expect(Object.values(afterCrash.legacyRecords)).toHaveLength(1);
    expect((await listCommandLedger(sample.root))[0]).toMatchObject({ status: "unknown", durableReconciliation: { schemaVersion: 1, request: input.request } });
    const indexBeforeReplay = await readFile(getSidecarPaths(sample.root).storyboardSheetIndex);
    const eventsBeforeReplay = await listEvents(sample.root, 200);
    expect(eventsBeforeReplay.some((event) => event.type === "command.side-effect-committed" && event.idempotencyKey === input.idempotencyKey)).toBe(false);

    const replayed = await executeIdempotentCommand(sample.root, { ...input, requestId: "request-p4-migration-crash-002" });
    expect(replayed).toMatchObject({ status: "succeeded", replayed: true, result: { kind: "fusion-storyboard-sheet-migration-result", applied: false, replayed: true, reconciled: true, storeRevision: 1, pendingCount: 0, created: 0, unchanged: 1 } });
    expect(await readFile(getSidecarPaths(sample.root).storyboardSheetIndex)).toEqual(indexBeforeReplay);
    expect((await loadFusionStoryboardSheetStore(sample.root)).revision).toBe(1);
    expect(Object.values((await loadFusionStoryboardSheetStore(sample.root)).legacyRecords)).toHaveLength(1);
    const events = await listEvents(sample.root, 300);
    expect(events.filter((event) => event.type === "command.reconciled" && event.idempotencyKey === input.idempotencyKey)).toHaveLength(1);
    expect(events.find((event) => event.type === "command.reconciled" && event.idempotencyKey === input.idempotencyKey)?.data?.evidenceSource).toBe("fusion-storyboard-sheet-migration-candidate-fingerprint");
    expect(events.some((event) => event.type === "command.side-effect-committed" && event.idempotencyKey === input.idempotencyKey)).toBe(false);
  });

  it("reconcile_command 可使用账本内 P4 请求快照从业务 store 对账，并回写独立事务根", async () => {
    const sample = await p4MigrationFixture();
    const storageRoot = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-p4-command-storage-"));
    roots.push(storageRoot);
    const input = {
      requestId: "request-p4-reconcile-snapshot-001",
      idempotencyKey: "p4-reconcile-snapshot-after-store-v1",
      request: {
        command: "migrate_fusion_storyboard_sheets" as const,
        payload: {
          itemIds: ["main-ep01-unit001"],
          expectedStoreRevision: sample.preview.storeRevision,
          expectedCandidateFingerprint: sample.preview.candidateFingerprint,
        },
      },
    };
    process.env.AI_CANVAS_TEST_COMMAND_CRASH_BEFORE_COMMIT_EVENT = input.request.command;
    try { await expect(executeIdempotentCommand(sample.root, input, { storageRoot })).rejects.toThrow("结果未确认"); }
    finally { delete process.env.AI_CANVAS_TEST_COMMAND_CRASH_BEFORE_COMMIT_EVENT; }
    expect((await listEvents(sample.root, 200)).some((event) => event.type === "command.side-effect-committed" && event.idempotencyKey === input.idempotencyKey)).toBe(false);

    const reconciled = await reconcileCommand(sample.root, { idempotencyKey: input.idempotencyKey });
    expect(reconciled).toMatchObject({ status: "succeeded", replayed: true, result: { reconciled: true, candidateFingerprint: sample.preview.candidateFingerprint } });
    expect((await listCommandLedger(storageRoot))[0]).toMatchObject({ status: "succeeded", result: { reconciled: true } });
    expect((await loadFusionStoryboardSheetStore(sample.root)).revision).toBe(1);
    expect((await executeIdempotentCommand(sample.root, { ...input, requestId: "request-p4-reconcile-snapshot-002" }, { storageRoot })).replayed).toBe(true);
  });

  it("durable proof 不得越过损坏的终态收据把 unknown 提升为 succeeded", async () => {
    const sample = await p4MigrationFixture();
    const input = {
      requestId: "request-p4-malformed-receipt-001",
      idempotencyKey: "p4-malformed-receipt-after-store-v1",
      request: {
        command: "migrate_fusion_storyboard_sheets" as const,
        payload: {
          itemIds: ["main-ep01-unit001"],
          expectedStoreRevision: sample.preview.storeRevision,
          expectedCandidateFingerprint: sample.preview.candidateFingerprint,
        },
      },
    };
    process.env.AI_CANVAS_TEST_COMMAND_CRASH_BEFORE_COMMIT_EVENT = input.request.command;
    try {
      await expect(executeIdempotentCommand(sample.root, input)).rejects.toThrow("结果未确认");
    } finally {
      delete process.env.AI_CANVAS_TEST_COMMAND_CRASH_BEFORE_COMMIT_EVENT;
    }
    const ledgerBefore = (await listCommandLedger(sample.root))[0];
    expect(ledgerBefore).toMatchObject({ status: "unknown", durableReconciliation: { request: input.request } });
    await appendEvent(sample.root, {
      actor: "codex",
      type: "command.side-effect-committed",
      requestId: input.requestId,
      idempotencyKey: input.idempotencyKey,
      command: input.request.command,
      data: {
        requestHash: ledgerBefore?.requestHash,
        command: input.request.command,
        resultDigest: "not-a-sha256",
        outcomeStatus: "succeeded",
      },
    });

    await expect(reconcileCommand(sample.root, {
      idempotencyKey: input.idempotencyKey,
    })).rejects.toThrow("resultDigest");
    expect((await listCommandLedger(sample.root))[0]?.status).toBe("unknown");
    expect((await loadFusionStoryboardSheetStore(sample.root)).revision).toBe(1);
  });

  it("durable proof 必须服从合法失败收据且不得改判 succeeded", async () => {
    const sample = await p4MigrationFixture();
    const input = {
      requestId: "request-p4-failed-receipt-001",
      idempotencyKey: "p4-failed-receipt-after-store-v1",
      request: {
        command: "migrate_fusion_storyboard_sheets" as const,
        payload: {
          itemIds: ["main-ep01-unit001"],
          expectedStoreRevision: sample.preview.storeRevision,
          expectedCandidateFingerprint: sample.preview.candidateFingerprint,
        },
      },
    };
    process.env.AI_CANVAS_TEST_COMMAND_CRASH_BEFORE_COMMIT_EVENT = input.request.command;
    try {
      await expect(executeIdempotentCommand(sample.root, input)).rejects.toThrow("结果未确认");
    } finally {
      delete process.env.AI_CANVAS_TEST_COMMAND_CRASH_BEFORE_COMMIT_EVENT;
    }
    const ledgerBefore = (await listCommandLedger(sample.root))[0];
    const failedResult = { schemaVersion: 1, applied: false, reason: "confirmed_failure" };
    await appendEvent(sample.root, {
      actor: "codex",
      type: "command.side-effect-committed",
      requestId: input.requestId,
      idempotencyKey: input.idempotencyKey,
      command: input.request.command,
      data: {
        requestHash: ledgerBefore?.requestHash,
        command: input.request.command,
        result: failedResult,
        resultDigest: sha('{"applied":false,"reason":"confirmed_failure","schemaVersion":1}'),
        outcomeStatus: "failed",
        error: "测试确认失败",
      },
    });

    await expect(reconcileCommand(sample.root, {
      idempotencyKey: input.idempotencyKey,
    })).resolves.toMatchObject({
      status: "failed",
      result: { schemaVersion: 1, applied: false },
    });
    expect((await listCommandLedger(sample.root))[0]).toMatchObject({
      status: "failed",
      result: { schemaVersion: 1, applied: false },
    });
    expect((await loadFusionStoryboardSheetStore(sample.root)).revision).toBe(1);
  });

  it("durable proof 读取完成后若终态收据抢先落盘，锁内二次校验必须让失败收据胜出", async () => {
    const sample = await p4MigrationFixture();
    const input = {
      requestId: "request-p4-receipt-race-001",
      idempotencyKey: "p4-receipt-race-after-proof-v1",
      request: {
        command: "migrate_fusion_storyboard_sheets" as const,
        payload: {
          itemIds: ["main-ep01-unit001"],
          expectedStoreRevision: sample.preview.storeRevision,
          expectedCandidateFingerprint: sample.preview.candidateFingerprint,
        },
      },
    };
    process.env.AI_CANVAS_TEST_COMMAND_CRASH_BEFORE_COMMIT_EVENT = input.request.command;
    try {
      await expect(executeIdempotentCommand(sample.root, input)).rejects.toThrow("结果未确认");
    } finally {
      delete process.env.AI_CANVAS_TEST_COMMAND_CRASH_BEFORE_COMMIT_EVENT;
    }
    const ledgerBefore = (await listCommandLedger(sample.root))[0]!;
    let releaseProof!: () => void;
    let proofEntered!: () => void;
    const proofEnteredPromise = new Promise<void>((resolve) => { proofEntered = resolve; });
    const releaseProofPromise = new Promise<void>((resolve) => { releaseProof = resolve; });
    const actualMigration = await vi.importActual<typeof import("../src/core/fusion-storyboard-sheet-migration.js")>("../src/core/fusion-storyboard-sheet-migration.js");
    vi.doMock("../src/core/fusion-storyboard-sheet-migration.js", () => ({
      ...actualMigration,
      previewFusionStoryboardSheetMigration: async (...args: Parameters<typeof actualMigration.previewFusionStoryboardSheetMigration>) => {
        proofEntered();
        await releaseProofPromise;
        return actualMigration.previewFusionStoryboardSheetMigration(...args);
      },
    }));
    vi.resetModules();
    try {
      const isolatedBus = await import("../src/core/command-bus.js");
      const reconciling = isolatedBus.reconcileCommand(sample.root, { idempotencyKey: input.idempotencyKey });
      await proofEnteredPromise;
      const failedResult = { schemaVersion: 1, applied: false, reason: "confirmed_failure" };
      await appendEvent(sample.root, {
        actor: "codex",
        type: "command.side-effect-committed",
        requestId: input.requestId,
        idempotencyKey: input.idempotencyKey,
        command: input.request.command,
        data: {
          requestHash: ledgerBefore.requestHash,
          command: input.request.command,
          result: failedResult,
          resultDigest: sha('{"applied":false,"reason":"confirmed_failure","schemaVersion":1}'),
          outcomeStatus: "failed",
          error: "safe confirmed failure",
        },
      });
      releaseProof();
      await expect(reconciling).resolves.toMatchObject({
        status: "failed",
        result: failedResult,
      });
      expect((await listCommandLedger(sample.root))[0]).toMatchObject({ status: "failed", result: failedResult });
    } finally {
      releaseProof();
      vi.doUnmock("../src/core/fusion-storyboard-sheet-migration.js");
      vi.resetModules();
    }
  });

  it("P4 render 已登记 current receipt/store 后崩溃只做确定性对账与补扫，不再次渲染或登记", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-command-p4-render-"));
    roots.push(root);
    await ensureSidecar(root);
    const materialized = await p4RenderRegistrationFixture(root);
    let renderCalls = 0;
    vi.resetModules();
    vi.doMock("../src/core/fusion-storyboard-production.js", async () => {
      const actual = await vi.importActual<typeof import("../src/core/fusion-storyboard-production.js")>("../src/core/fusion-storyboard-production.js");
      return {
        ...actual,
        renderCompletedFusionStoryboardSheetForProject: async (projectRoot: string) => {
          renderCalls += 1;
          const registered = await registerFusionStoryboardSheetRecord(projectRoot, materialized.registration, { expectedRevision: 0, selectCurrent: true });
          return { itemId: materialized.evidence.itemId, sheetId: registered.record.sheetId, inputFingerprint: registered.record.inputFingerprint, storeRevision: registered.store.revision };
        },
      };
    });
    vi.doMock("../src/core/fusion-storyboard-sheet-evidence.js", async () => {
      const actual = await vi.importActual<typeof import("../src/core/fusion-storyboard-sheet-evidence.js")>("../src/core/fusion-storyboard-sheet-evidence.js");
      return {
        ...actual,
        inspectFusionStoryboardSheetEvidence: async () => ({
          itemId: materialized.evidence.itemId,
          jobs: [],
          artifacts: [],
          currentEvidence: structuredClone(materialized.evidence),
          readiness: {
            canRender: true,
            blockers: [],
            expectedInputFingerprint: materialized.inputFingerprint,
            expectedSheetId: materialized.sheetId,
            requirementId: materialized.evidence.requirement.requirementId,
            reviewId: materialized.evidence.review.reviewId,
          },
        }),
      };
    });
    try {
      const isolatedBus = await import("../src/core/command-bus.js");
      const input = {
        requestId: "request-p4-render-crash-001",
        idempotencyKey: "p4-render-crash-after-store-v1",
        request: {
          command: "render_fusion_storyboard_sheet" as const,
          payload: {
            itemId: materialized.evidence.itemId,
            contractId: materialized.evidence.contract.contractId,
            expectedInputFingerprint: materialized.inputFingerprint,
          },
        },
      };
      process.env.AI_CANVAS_TEST_COMMAND_CRASH_BEFORE_COMMIT_EVENT = input.request.command;
      try { await expect(isolatedBus.executeIdempotentCommand(root, input)).rejects.toThrow("结果未确认"); }
      finally { delete process.env.AI_CANVAS_TEST_COMMAND_CRASH_BEFORE_COMMIT_EVENT; }
      expect(renderCalls).toBe(1);
      expect((await isolatedBus.listCommandLedger(root))[0]?.status).toBe("unknown");
      const storeAfterCrash = await loadFusionStoryboardSheetStore(root);
      expect(storeAfterCrash).toMatchObject({ revision: 1, currentByItemId: { [materialized.evidence.itemId]: { sheetId: materialized.sheetId, inputFingerprint: materialized.inputFingerprint } } });

      const pngPath = materialized.registration.outputs.find((output) => output.role === "png")!.path;
      const originalPng = await readFile(pngPath);
      await writeFile(pngPath, "corrupted-after-render-crash");
      await expect(isolatedBus.executeIdempotentCommand(root, { ...input, requestId: "request-p4-render-crash-002" })).rejects.toThrow(/保持 unknown|禁止自动重放/u);
      expect(renderCalls).toBe(1);
      expect((await isolatedBus.listCommandLedger(root))[0]?.status).toBe("unknown");

      await writeFile(pngPath, originalPng);
      const replayed = await isolatedBus.executeIdempotentCommand(root, { ...input, requestId: "request-p4-render-crash-003" });
      expect(replayed).toMatchObject({
        status: "succeeded",
        replayed: true,
        result: {
          schemaVersion: 2,
          kind: "fusion-storyboard-sheet-render",
          reconciled: true,
          reused: true,
          itemId: materialized.evidence.itemId,
          sheetId: materialized.sheetId,
          inputFingerprint: materialized.inputFingerprint,
          png: { path: pngPath, status: "existing" },
          svg: { status: "existing" },
        },
      });
      expect(renderCalls).toBe(1);
      expect((await loadFusionStoryboardSheetStore(root)).revision).toBe(1);
      expect(Object.keys((await loadFusionStoryboardSheetStore(root)).records)).toEqual([materialized.sheetId]);
      expect((await listEvents(root, 300)).find((event) => event.type === "command.reconciled" && event.idempotencyKey === input.idempotencyKey)?.data?.evidenceSource).toBe("fusion-storyboard-sheet-store");
    } finally {
      delete process.env.AI_CANVAS_TEST_COMMAND_CRASH_BEFORE_COMMIT_EVENT;
      vi.doUnmock("../src/core/fusion-storyboard-production.js");
      vi.doUnmock("../src/core/fusion-storyboard-sheet-evidence.js");
      vi.resetModules();
    }
  });

  it("P4 migration 的 stale candidate fingerprint 与 CAS 冲突保持确定 failed，原键绝不被业务对账改判", async () => {
    const drift = await p4MigrationFixture();
    const originalPng = await readFile(drift.pngPath);
    await writeFile(drift.pngPath, "candidate-drift-after-preview");
    const driftInput = {
      requestId: "request-p4-migration-drift-001",
      idempotencyKey: "p4-migration-candidate-drift-v1",
      request: {
        command: "migrate_fusion_storyboard_sheets" as const,
        payload: {
          itemIds: ["main-ep01-unit001"],
          expectedStoreRevision: drift.preview.storeRevision,
          expectedCandidateFingerprint: drift.preview.candidateFingerprint,
        },
      },
    };
    await expect(executeIdempotentCommand(drift.root, driftInput)).rejects.toMatchObject({ name: "RejectedCommandFailure", result: { applied: false } });
    expect((await listCommandLedger(drift.root))[0]).toMatchObject({ status: "failed", execution: { phase: "executing" } });
    expect((await loadFusionStoryboardSheetStore(drift.root)).revision).toBe(0);
    await writeFile(drift.pngPath, originalPng);
    await expect(executeIdempotentCommand(drift.root, { ...driftInput, requestId: "request-p4-migration-drift-002" })).rejects.toThrow("已明确失败");
    expect((await listCommandLedger(drift.root))[0]?.status).toBe("failed");

    const conflict = await p4MigrationFixture();
    const unrelatedPath = path.join(conflict.root, "unrelated-p4-history.png");
    await writeFile(unrelatedPath, "unrelated");
    await registerLegacyFusionStoryboardSheetRecord(conflict.root, {
      itemId: "main-ep01-unit999",
      artifacts: [{ role: "png", path: unrelatedPath, pageIndex: 1, pageCount: 1, sha256: sha("unrelated"), bytes: 9 }],
      reason: "command bus CAS conflict fixture",
    }, { expectedRevision: 0 });
    const conflictInput = {
      requestId: "request-p4-migration-cas-001",
      idempotencyKey: "p4-migration-revision-conflict-v1",
      request: {
        command: "migrate_fusion_storyboard_sheets" as const,
        payload: {
          itemIds: ["main-ep01-unit001"],
          expectedStoreRevision: conflict.preview.storeRevision,
          expectedCandidateFingerprint: conflict.preview.candidateFingerprint,
        },
      },
    };
    await expect(executeIdempotentCommand(conflict.root, conflictInput)).rejects.toMatchObject({ name: "RejectedCommandFailure", result: { applied: false, reason: "revision_conflict", currentRevision: 1 } });
    expect((await listCommandLedger(conflict.root))[0]).toMatchObject({ status: "failed", result: { reason: "revision_conflict" }, execution: { phase: "executing" } });
    await expect(executeIdempotentCommand(conflict.root, { ...conflictInput, requestId: "request-p4-migration-cas-002" })).rejects.toThrow("已明确失败");
    const conflictStore = await loadFusionStoryboardSheetStore(conflict.root);
    expect(conflictStore.revision).toBe(1);
    expect(Object.values(conflictStore.legacyRecords)).toHaveLength(1);
  });

  it("独立事务根的 unknown 可从项目根对账并同步回原账本", async () => {
    const root = await fixture();
    const storageRoot = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-command-storage-"));
    roots.push(storageRoot);
    const input = { requestId: "request-external-ledger-001", idempotencyKey: "external-ledger-taskpack-unit001-v1", request: { command: "create_task_pack" as const, payload: { itemIds: ["main-ep01-unit001"], mode: "autopilot" as const, kind: "image" as const } } };
    process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE = "create_task_pack";
    await expect(executeIdempotentCommand(root, input, { storageRoot })).rejects.toThrow("结果未确认");
    delete process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE;
    expect((await listCommandLedger(root))[0]?.status).toBe("unknown");
    expect((await reconcileCommand(root, { idempotencyKey: input.idempotencyKey })).status).toBe("succeeded");
    expect((await listCommandLedger(root))[0]).toMatchObject({ status: "succeeded", requestId: input.requestId });
    expect((await listCommandLedger(storageRoot))[0]).toMatchObject({ status: "succeeded", requestId: input.requestId });
    const replayed = await executeIdempotentCommand(root, { ...input, requestId: "request-external-ledger-002" }, { storageRoot });
    expect(replayed.replayed).toBe(true);
  });

  it("独立事务根只存在 owner 收据时可对账并补齐镜像根收据", async () => {
    const root = await fixture();
    const storageRoot = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-command-owner-receipt-"));
    roots.push(storageRoot);
    const input = { requestId: "request-owner-receipt-001", idempotencyKey: "owner-only-receipt-taskpack-v1", request: { command: "create_task_pack" as const, payload: { itemIds: ["main-ep01-unit001"], mode: "autopilot" as const, kind: "image" as const } } };
    process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE = input.request.command;
    try { await expect(executeIdempotentCommand(root, input, { storageRoot })).rejects.toThrow("结果未确认"); }
    finally { delete process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE; }
    await removeTerminalReceipts(root, input.idempotencyKey);

    await expect(reconcileCommand(root, { idempotencyKey: input.idempotencyKey }))
      .resolves.toMatchObject({ status: "succeeded", replayed: true });
    expect((await listEvents(root, 200)).filter((event) => event.type === "command.side-effect-committed" && event.idempotencyKey === input.idempotencyKey)).toHaveLength(1);
  });

  it("独立事务根只有镜像收据时失败关闭，不能把镜像当 owner", async () => {
    const root = await fixture();
    const storageRoot = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-command-mirror-receipt-"));
    roots.push(storageRoot);
    const input = { requestId: "request-mirror-receipt-001", idempotencyKey: "mirror-only-receipt-taskpack-v1", request: { command: "create_task_pack" as const, payload: { itemIds: ["main-ep01-unit001"], mode: "autopilot" as const, kind: "image" as const } } };
    process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE = input.request.command;
    try { await expect(executeIdempotentCommand(root, input, { storageRoot })).rejects.toThrow("结果未确认"); }
    finally { delete process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE; }
    await removeTerminalReceipts(storageRoot, input.idempotencyKey);

    await expect(reconcileCommand(root, { idempotencyKey: input.idempotencyKey }))
      .rejects.toThrow(/owner|事务根/u);
    expect((await listCommandLedger(storageRoot))[0]?.status).toBe("unknown");
  });

  it("独立事务根 succeeded 账本同键重放遇到 mirror-only 收据也失败关闭", async () => {
    const root = await fixture();
    const storageRoot = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-command-terminal-mirror-only-"));
    roots.push(storageRoot);
    const input = { requestId: "request-terminal-mirror-only-001", idempotencyKey: "terminal-mirror-only-taskpack-v1", request: { command: "create_task_pack" as const, payload: { itemIds: ["main-ep01-unit001"], mode: "autopilot" as const, kind: "image" as const } } };
    await expect(executeIdempotentCommand(root, input, { storageRoot }))
      .resolves.toMatchObject({ status: "succeeded" });
    await removeTerminalReceipts(storageRoot, input.idempotencyKey);

    await expect(executeIdempotentCommand(root, { ...input, requestId: "request-terminal-mirror-only-002" }, { storageRoot }))
      .rejects.toThrow(/owner|事务根/u);
    expect(await listTaskPacks(root)).toHaveLength(1);
  });

  it("独立事务根与镜像根各自合法但终态不同仍失败关闭", async () => {
    const root = await fixture();
    const storageRoot = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-command-cross-root-conflict-"));
    roots.push(storageRoot);
    const input = { requestId: "request-cross-root-conflict-001", idempotencyKey: "cross-root-conflict-taskpack-v1", request: { command: "create_task_pack" as const, payload: { itemIds: ["main-ep01-unit001"], mode: "autopilot" as const, kind: "image" as const } } };
    process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE = input.request.command;
    try { await expect(executeIdempotentCommand(root, input, { storageRoot })).rejects.toThrow("结果未确认"); }
    finally { delete process.env.AI_CANVAS_TEST_COMMAND_CRASH_AFTER_EXECUTE; }
    const ownerReceipt = (await listEvents(storageRoot, 200)).find((event) => event.type === "command.side-effect-committed" && event.idempotencyKey === input.idempotencyKey)!;
    await removeTerminalReceipts(root, input.idempotencyKey);
    await appendEvent(root, {
      actor: "codex",
      type: "command.side-effect-committed",
      requestId: input.requestId,
      idempotencyKey: input.idempotencyKey,
      command: input.request.command,
      data: { ...ownerReceipt.data, outcomeStatus: "failed", error: "safe mirror conflict" },
    });

    await expect(reconcileCommand(root, { idempotencyKey: input.idempotencyKey }))
      .rejects.toThrow(/互相冲突|跨根/u);
    expect((await listCommandLedger(storageRoot))[0]?.status).toBe("unknown");
  });

  it("两个独立进程使用同一幂等键只执行一次", async () => {
    const root = await fixture();
    const executable = path.join(process.cwd(), "node_modules", ".bin", "tsx");
    const idempotencyKey = "cross-process-taskpack-unit001-v1";
    const [first, second] = await Promise.all([
      execFileAsync(executable, ["scripts/command-worker.ts", root, "main-ep01-unit001", "request-cross-process-a", idempotencyKey], { cwd: process.cwd() }),
      execFileAsync(executable, ["scripts/command-worker.ts", root, "main-ep01-unit001", "request-cross-process-b", idempotencyKey], { cwd: process.cwd() }),
    ]);
    const results = [first.stdout, second.stdout].map((value) => JSON.parse(value.trim()) as { ok: boolean; replayed: boolean });
    expect(results.every((entry) => entry.ok)).toBe(true);
    expect(results.filter((entry) => entry.replayed)).toHaveLength(1);
    expect(await listTaskPacks(root)).toHaveLength(1);
    expect(await listCommandLedger(root)).toHaveLength(1);
  });

  it("两个独立进程用不同幂等键和同一 revision 更新长期事实时恰好一成一败", async () => {
    const root = await fixture();
    const context = await upsertProjectContext(root, { kind: "decision", title: "跨进程 CAS", content: "初始内容" });
    const worker = path.join(process.cwd(), "scripts", "revision-cas-worker.ts");
    const common = ["--import", "tsx", worker, root, context.id, String(context.revision)];
    const [first, second] = await Promise.all([
      execFileAsync(process.execPath, [...common, "窗口 A", "request-cas-process-a", "context-cas-process-a-v1"], { cwd: process.cwd() }),
      execFileAsync(process.execPath, [...common, "窗口 B", "request-cas-process-b", "context-cas-process-b-v1"], { cwd: process.cwd() }),
    ]);
    const outcomes = [first.stdout, second.stdout].map((value) => JSON.parse(value.trim()) as { ok: boolean; status?: string; reason?: string; revision?: number });
    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
    expect(outcomes.filter((outcome) => !outcome.ok)).toEqual([expect.objectContaining({ name: "RejectedCommandFailure", reason: "revision_conflict" })]);
    const persisted = (await listProjectContext(root)).find((entry) => entry.id === context.id)!;
    expect(persisted.revision).toBe(context.revision + 1);
    expect(["窗口 A", "窗口 B"]).toContain(persisted.content);
    const ledger = (await listCommandLedger(root)).filter((entry) => entry.idempotencyKey.startsWith("context-cas-process-"));
    expect(ledger.map((entry) => entry.status).sort()).toEqual(["failed", "succeeded"]);
  });

  it("长业务操作不会占住全局命令账本锁阻塞其他业务域", async () => {
    const root = await fixture();
    process.env.AI_CANVAS_TEST_COMMAND_DELAY_COMMAND = "upsert_context";
    process.env.AI_CANVAS_TEST_COMMAND_DELAY_MS = "1200";
    let firstFinished = false;
    const first = executeIdempotentCommand(root, { requestId: "request-long-domain-001", idempotencyKey: "long-context-domain-unit001-v1", request: { command: "upsert_context", payload: { kind: "continuity", title: "延迟写入", content: "测试命令总线短锁。" } } }).then((result) => { firstFinished = true; return result; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = await executeIdempotentCommand(root, { requestId: "request-fast-domain-001", idempotencyKey: "fast-canvas-domain-unit001-v1", request: { command: "upsert_canvas_entity", payload: { kind: "note", title: "并行批注", position: { x: 10, y: 10 } } } });
    const firstWasFinishedWhenSecondEnded = firstFinished;
    const firstResult = await first;

    expect(second.status).toBe("succeeded");
    // 决定性条件是不同业务域的第二条命令在被显式延迟的第一条命令之前完成。
    // 墙钟毫秒会随整仓并发负载抖动，不能拿固定 1s 当作锁隔离的正确性证据。
    expect(firstWasFinishedWhenSecondEnded).toBe(false);
    expect(firstResult).toEqual(expect.objectContaining({ status: "succeeded" }));
  });

  it("scan_project 取消会形成 cancelled 终态，不提交索引且不能复用原幂等键", async () => {
    const root = await fixture();
    const baseline = await loadIndex(root);
    const directory = path.join(root, "EP01_15s_001_幂等测试");
    const videoPath = path.join(directory, "EP01_15s_001_取消扫描.mp4");
    await writeFile(videoPath, Buffer.alloc(60_000, 7));
    const pidPath = path.join(root, "command-fake-ffprobe.pid");
    const markerPath = path.join(root, "command-fake-ffprobe.terminated");
    const fakeProbe = path.join(root, "command-fake-ffprobe.mjs");
    await writeFile(fakeProbe, `#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(pidPath)}, String(process.pid));\nprocess.on("SIGTERM", () => { writeFileSync(${JSON.stringify(markerPath)}, "terminated"); process.exit(143); });\nsetInterval(() => {}, 1000);\n`, "utf8");
    await chmod(fakeProbe, 0o755);
    const previousProbe = process.env.FFPROBE_PATH;
    const previousMediaRuntime = process.env.AI_CANVAS_MEDIA_RUNTIME_DIR;
    process.env.FFPROBE_PATH = fakeProbe;
    process.env.AI_CANVAS_MEDIA_RUNTIME_DIR = path.join(root, ".aicanvas", "test-media-runtime");
    const controller = new AbortController();
    const input = { requestId: "request-scan-cancel-001", idempotencyKey: "scan-project-cancel-unit001-v1", request: { command: "scan_project" as const, payload: {} } };
    const progress: string[] = [];
    let running: ReturnType<typeof executeIdempotentCommand> | undefined;
    try {
      running = executeIdempotentCommand(root, input, { signal: controller.signal, onProgress: (value) => progress.push(value.phase) });
      let runningSettled = false;
      void running.then(
        () => { runningSettled = true; },
        () => { runningSettled = true; },
      );
      const startDeadline = Date.now() + 10_000;
      while (Date.now() < startDeadline && !runningSettled) {
        if (await access(pidPath).then(() => true).catch(() => false)) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      if (runningSettled && !await access(pidPath).then(() => true).catch(() => false)) await running;
      expect(await access(pidPath).then(() => true).catch(() => false)).toBe(true);
      const pid = Number(await readFile(pidPath, "utf8"));
      controller.abort("命令总线扫描取消测试");
      await expect(running).rejects.toMatchObject({ name: "AbortError", message: "命令总线扫描取消测试" });
      await expect(access(markerPath)).resolves.toBeUndefined();
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try { process.kill(pid, 0); }
        catch { break; }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      const ledger = await listCommandLedger(root);
      expect(ledger[0]).toEqual(expect.objectContaining({ idempotencyKey: input.idempotencyKey, status: "cancelled" }));
      expect(ledger[0]?.error?.message).toBe("命令总线扫描取消测试");
      expect((await loadIndex(root))?.scanId).toBe(baseline?.scanId);
      expect(await listProjectLocks(root)).toEqual([]);
      expect(progress.length).toBeGreaterThan(0);
      const events = await listEvents(root, 200);
      expect(events.some((event) => event.type === "command.cancelled" && event.idempotencyKey === input.idempotencyKey)).toBe(true);
      expect(events.some((event) => event.type === "command.side-effect-committed" && event.idempotencyKey === input.idempotencyKey)).toBe(false);
      expect((await reconcileCommand(root, { idempotencyKey: input.idempotencyKey })).status).toBe("cancelled");
      await expect(executeIdempotentCommand(root, { ...input, requestId: "request-scan-cancel-002" })).rejects.toThrow("已明确取消");

      await rm(videoPath, { force: true });
      const retried = await executeIdempotentCommand(root, { requestId: "request-scan-cancel-003", idempotencyKey: "scan-project-cancel-unit001-v2", request: input.request });
      expect(retried.status).toBe("succeeded");
    } finally {
      controller.abort("取消测试清理未完成扫描");
      await running?.catch(() => undefined);
      if (previousProbe === undefined) delete process.env.FFPROBE_PATH;
      else process.env.FFPROBE_PATH = previousProbe;
      if (previousMediaRuntime === undefined) delete process.env.AI_CANVAS_MEDIA_RUNTIME_DIR;
      else process.env.AI_CANVAS_MEDIA_RUNTIME_DIR = previousMediaRuntime;
    }
  }, 60_000);

  it("预取消不写命令账本，等待者取消也不会终止同键原执行者", async () => {
    const root = await fixture();
    const preCancelled = new AbortController();
    preCancelled.abort("尚未登记即取消");
    await expect(executeIdempotentCommand(root, {
      requestId: "request-scan-pre-cancel-001",
      idempotencyKey: "scan-project-pre-cancel-v1",
      request: { command: "scan_project", payload: {} },
    }, { signal: preCancelled.signal })).rejects.toMatchObject({ name: "AbortError", message: "尚未登记即取消" });
    expect(await listCommandLedger(root)).toHaveLength(0);

    process.env.AI_CANVAS_TEST_COMMAND_DELAY_COMMAND = "scan_project";
    process.env.AI_CANVAS_TEST_COMMAND_DELAY_MS = "800";
    const input = {
      requestId: "request-scan-owner-001",
      idempotencyKey: "scan-project-owner-wait-v1",
      request: { command: "scan_project" as const, payload: {} },
    };
    const owner = executeIdempotentCommand(root, input);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await listCommandLedger(root))[0]?.status === "running") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const waiterController = new AbortController();
    const waiter = executeIdempotentCommand(root, { ...input, requestId: "request-scan-waiter-001" }, { signal: waiterController.signal });
    await new Promise((resolve) => setTimeout(resolve, 30));
    waiterController.abort("只取消等待者");
    await expect(waiter).rejects.toMatchObject({ name: "AbortError", message: "只取消等待者" });
    expect((await listCommandLedger(root))[0]?.status).toBe("running");
    const ownerResult = await owner;
    expect(ownerResult.status).toBe("succeeded");
    expect((await listCommandLedger(root))[0]?.status).toBe("succeeded");
    const events = await listEvents(root, 200);
    expect(events.filter((event) => event.type === "command.cancelled" && event.idempotencyKey === input.idempotencyKey)).toHaveLength(0);
    expect(events.filter((event) => event.type === "command.side-effect-committed" && event.idempotencyKey === input.idempotencyKey)).toHaveLength(1);
  });

  it("执行进程在业务前消失时将 running 转为 unknown 且不自动重放", async () => {
    const root = await fixture();
    const startedAt = new Date(Date.now() - 60_000).toISOString();
    const idempotencyKey = "dead-executor-before-business-v1";
    await writeJsonAtomic(getSidecarPaths(root).commandLedger, {
      schemaVersion: 1,
      entries: [{ schemaVersion: 1, requestId: "request-dead-executor-001", idempotencyKey, command: "create_task_pack", status: "running", replayed: false, requestHash: "dead-request-hash", execution: { pid: 999_999_999, phase: "registered", heartbeatAt: startedAt }, startedAt }],
      updatedAt: startedAt,
    });

    const reconciled = await reconcileCommand(root, { idempotencyKey });
    expect(reconciled.status).toBe("unknown");
    expect(reconciled.error?.message).toContain("禁止自动重放");
    expect((await listEvents(root, 50)).some((event) => event.type === "command.executor-lost")).toBe(true);
  });
});
