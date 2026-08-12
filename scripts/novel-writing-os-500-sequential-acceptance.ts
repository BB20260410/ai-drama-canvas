import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  executeIdempotentCommand,
  getNovelImportCommandOwnerRoot,
} from "../src/core/command-bus.js";
import { createAuthorizedNovelImportPreflight } from "../src/core/novel-import.js";
import {
  NovelRepository,
  orderedNovelChapters,
} from "../src/core/novel-manuscript.js";
import { runWithOperationContext } from "../src/core/operation-context.js";
import {
  getNovelStateRebuildStatus,
  prepareNovelChapterWrite,
} from "../src/core/novel-agent-service.js";
import {
  loadNovelWritingState,
  planNovelWritingStateRebuild,
  projectNovelWritingState,
} from "../src/core/novel-writing-state.js";
import { listRegisteredProjects } from "../src/core/sidecar.js";
import type {
  NovelChapterRecord,
  NovelChapterStateCandidate,
  NovelStageChapterStateCandidateInput,
  NovelStateChangeKind,
  NovelWritingStateDocument,
} from "../src/core/novel-types.js";
import type { NovelCommandRequest } from "../src/core/novel-command-runtime.js";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function parsePositiveInteger(name: string, fallback: number): number {
  const marker = `--${name}=`;
  const raw = process.argv.find((entry) => entry.startsWith(marker))?.slice(marker.length);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} 必须为正整数。`);
  return value;
}

function parseOutputPath(): string {
  const marker = "--output=";
  const value = process.argv.find((entry) => entry.startsWith(marker))?.slice(marker.length);
  if (!value) throw new Error("必须提供 --output=<evidence.json>。");
  return path.resolve(value);
}

function commandEnvelope(command: string, payload: Record<string, unknown>, label: string) {
  const identity = sha256(`${command}\0${label}`).slice(0, 32);
  return {
    requestId: `scale-request-${identity}`,
    idempotencyKey: `scale-key-${identity}`,
    request: { command, payload },
  } as Parameters<typeof executeIdempotentCommand>[1];
}

async function mutate<T>(label: string, command: string, work: () => Promise<T>): Promise<T> {
  const identity = sha256(`${label}\0${command}`);
  return runWithOperationContext({
    requestId: `scale-core-request-${identity.slice(0, 32)}`,
    idempotencyKey: `scale-core-key-${identity.slice(0, 32)}`,
    requestHash: identity,
    command,
  }, work);
}

function percentile(values: number[], ratio: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)]! * 100) / 100;
}

function quantiles(values: number[]) {
  return {
    minimumMs: Math.round(Math.min(...values) * 100) / 100,
    p50Ms: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    maximumMs: Math.round(Math.max(...values) * 100) / 100,
    meanMs: Math.round((values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length)) * 100) / 100,
  };
}

function summarizePhaseDurations(durations: Record<string, number[]>) {
  return Object.fromEntries(Object.entries(durations).map(([phase, values]) => [phase, {
    durationMs: Math.round(values.reduce((sum, value) => sum + value, 0)),
    latency: quantiles(values),
  }]));
}

function windowedLatency(values: number[], windowCount = 10) {
  const windowSize = Math.max(1, Math.ceil(values.length / windowCount));
  const windows: Array<{ startCycle: number; endCycle: number; latency: ReturnType<typeof quantiles> }> = [];
  for (let offset = 0; offset < values.length; offset += windowSize) {
    const slice = values.slice(offset, Math.min(values.length, offset + windowSize));
    windows.push({
      startCycle: offset + 1,
      endCycle: offset + slice.length,
      latency: quantiles(slice),
    });
  }
  return windows;
}

function sourceCorpus(chapterCount: number, targetCharacters: number): string {
  const targetPerChapter = Math.max(400, Math.ceil(targetCharacters / chapterCount));
  const paragraphs: string[] = [
    "# 第000章 启动检查点\n\n启动章只用于建立可信历史基线。主人公守住证据边界，等待正式顺序任务。",
  ];
  const seed = "他先核对证据，再把责任节点写进纸本；没有证据的判断一律留空，人物状态只随已发生事件推进。";
  for (let index = 1; index <= chapterCount; index += 1) {
    const prefix = `# 第${String(index).padStart(3, "0")}章 顺序闭环${index}\n\n第${index}章受管正文。`;
    const body = seed.repeat(Math.ceil(targetPerChapter / seed.length)).slice(0, targetPerChapter);
    paragraphs.push(`${prefix}${body}`);
  }
  return `${paragraphs.join("\n\n")}\n`;
}

function dynamicFields(label: string) {
  return {
    body: `稳定-${label}`,
    emotion: `专注-${label}`,
    known: [`已完成-${label}`],
    unknown: ["未来密钥"],
    relationships: ["证据链：持续核对"],
    goals: [`推进-${label}`],
    psychology: `只承认截止章证据-${label}`,
    unresolved: [`未决-${label}`],
  };
}

function candidatePayload(
  chapter: NovelChapterRecord,
  state: NovelWritingStateDocument,
  content: string,
  label: string,
): NovelStageChapterStateCandidateInput {
  const endOffset = Math.min(content.length, Math.max(1, content.indexOf("。") + 1 || 12));
  const evidenceExcerpt = content.slice(0, endOffset);
  return {
    chapterId: chapter.chapterId,
    expectedChapterRevision: chapter.revision,
    expectedChapterSha256: chapter.sha256,
    expectedWritingStateRevision: state.revision,
    expectedWritingStateFingerprint: state.fingerprint,
    summary: `顺序状态提交-${label}`,
    delta: {
      characterStates: [{
        stateId: "scale-character-state",
        entityId: "scale-character",
        fields: dynamicFields(label),
      }],
      knowledge: [],
      relationships: [],
      timeline: [],
      foreshadowing: [],
    },
    evidenceSpans: [{
      evidenceId: `evidence-${label}`,
      startOffset: 0,
      endOffset,
      evidenceExcerpt,
    }],
    changeEvidence: [{
      kind: "character_state" as const,
      recordId: "scale-character-state",
      reason: `正文形成章末状态-${label}`,
      evidenceSpanIds: [`evidence-${label}`],
    }],
    auditScope: {
      checkedCharacterIds: ["scale-character"],
      checkedStateKinds: ["character_state", "knowledge", "relationship", "timeline", "foreshadowing"] as NovelStateChangeKind[],
    },
  };
}

async function runCli(request: unknown, registryPath: string): Promise<{ code: number; response: Record<string, any> }> {
  const child = spawn(process.execPath, ["--import", "tsx", "scripts/novel-agent-cli.ts"], {
    cwd: workspaceRoot,
    env: { ...process.env, AI_CANVAS_REGISTRY_PATH: registryPath },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdin.end(JSON.stringify(request));
  const code = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (exitCode, signal) => signal ? reject(new Error(`CLI signal=${signal}`)) : resolve(exitCode ?? 1));
  });
  let response: Record<string, any>;
  try { response = JSON.parse(stdout.trim()) as Record<string, any>; }
  catch { throw new Error(`CLI 非 JSON：${stdout.slice(0, 300)}；stderr=${stderr.slice(0, 300)}`); }
  return { code, response };
}

async function captureReason(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
    return "UNEXPECTED_SUCCESS";
  } catch (error) {
    if (error && typeof error === "object" && "result" in error) {
      const result = (error as { result?: { reason?: string } }).result;
      return result?.reason ?? (error instanceof Error ? error.name : "unknown");
    }
    return error instanceof Error ? error.name : "unknown";
  }
}

const outputPath = parseOutputPath();
const chapterCount = parsePositiveInteger("chapters", 500);
const targetCharacters = parsePositiveInteger("target-characters", 1_000_000);
const retconFrom = parsePositiveInteger("retcon-from", Math.min(200, Math.max(2, Math.floor(chapterCount * 0.4))));
requireCondition(retconFrom > 1 && retconFrom <= chapterCount, "retcon-from 必须位于 2..chapters。");

const temporaryRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "novel-500-sequential-")));
const registryPath = path.join(temporaryRoot, "registry", "projects.json");
const projectsRoot = path.join(temporaryRoot, "projects");
const sourceRoot = path.join(temporaryRoot, "source");
await Promise.all([
  mkdir(path.dirname(registryPath), { recursive: true }),
  mkdir(projectsRoot, { recursive: true }),
  mkdir(sourceRoot, { recursive: true }),
  mkdir(path.dirname(outputPath), { recursive: true }),
]);
const previousRegistry = process.env.AI_CANVAS_REGISTRY_PATH;
process.env.AI_CANVAS_REGISTRY_PATH = registryPath;
let success = false;

try {
  const corpus = sourceCorpus(chapterCount, targetCharacters);
  const sourcePath = path.join(sourceRoot, "sequential-million.md");
  await writeFile(sourcePath, corpus, { encoding: "utf8", flag: "wx", mode: 0o600 });
  const sourceBefore = { sha256: sha256(corpus), byteLength: Buffer.byteLength(corpus), charCount: corpus.length };
  const authorized = await createAuthorizedNovelImportPreflight(sourcePath);
  requireCondition(authorized.authorization && authorized.preflight.eligible, "500章来源预检未通过。");
  requireCondition(authorized.preflight.summary.chapterCount === chapterCount + 1,
    `预检章节数应为 ${chapterCount + 1}，实际 ${authorized.preflight.summary.chapterCount}。`);
  const importRequest: Extract<NovelCommandRequest, { command: "novel_import_external_snapshot" }> = {
    command: "novel_import_external_snapshot",
    payload: {
      projectsRoot,
      projectName: `Writing OS ${chapterCount}章顺序闭环`,
      preflightId: authorized.preflight.preflightId,
      preflightFingerprint: authorized.preflight.fingerprint,
      sourceTreeAggregateSha256: authorized.preflight.sourceTreeAggregateSha256,
      duplicateResolution: "include_all",
      convertToManagedMarkdown: true,
      preflightAuthorization: authorized.authorization.authorizationId,
    },
  };
  const importStarted = performance.now();
  const imported = await executeIdempotentCommand(getNovelImportCommandOwnerRoot(), {
    requestId: `scale-import-request-${randomUUID()}`,
    idempotencyKey: `scale-import-key-${sha256(corpus).slice(0, 40)}`,
    request: importRequest,
  });
  const importDurationMs = Math.round(performance.now() - importStarted);
  const projectId = (imported.result as { receipt?: { projectId?: string } }).receipt?.projectId;
  requireCondition(projectId, "导入结果缺少 projectId。");
  const registration = (await listRegisteredProjects()).find((entry) => entry.id === projectId);
  requireCondition(registration, "导入工程未注册。");
  const projectRoot = await realpath(registration.primaryRoot);
  let repository = new NovelRepository(projectRoot);
  let snapshot = await repository.snapshot();
  const chapters = orderedNovelChapters(snapshot.chapters);
  requireCondition(chapters.length === chapterCount + 1, "受管工程章节数不符。");
  const bootstrap = chapters[0]!;
  const targets = chapters.slice(1);
  const sourceId = "scale-p0";
  const futureSecret = "超级未来密钥-只允许未来 owner 知道";
  const seedPayload = {
    baselineStatus: "locked" as const,
    sourceTreeAggregateSha256: authorized.preflight.sourceTreeAggregateSha256,
    currentThroughChapterId: bootstrap.chapterId,
    sourceDocuments: [{ sourceId, displayPath: "fixture/P0.md", content: "禁用词：万能解决。人物必须只使用截止章证据。" }],
    entities: [{ entityId: "scale-character", name: "序衡", aliases: ["主角"], level: "L1" as const, baseSummary: "证据优先，短句，不猜未来。", sourceIds: [sourceId] }],
    hardCanon: [{ ruleId: "scale-canon", text: "禁用词：万能解决", priority: 100, canonStatus: "canon" as const, visibility: "writer" as const, sourceIds: [sourceId] }],
    characterStates: [{
      stateId: "scale-character-state",
      entityId: "scale-character",
      throughChapterId: bootstrap.chapterId,
      fields: dynamicFields("bootstrap"),
      sourceIds: [sourceId],
    }],
    knowledge: [{
      knowledgeId: "scale-future-secret",
      entityId: "scale-character",
      fact: futureSecret,
      status: "planned_later" as const,
      rawValue: "未来卷",
      sourceIds: [sourceId],
    }],
    relationships: [],
    timeline: [{ timelineId: "scale-clock", storyTime: "D0", summary: "启动检查点", endChapterId: bootstrap.chapterId, sourceIds: [sourceId] }],
    foreshadowing: [{ foreshadowingId: "scale-thread", summary: "长期责任链", status: "progression" as const, maintenanceChapterIds: [bootstrap.chapterId], sourceIds: [sourceId] }],
    chapterBriefs: targets.map((chapter, index) => ({
      chapterId: chapter.chapterId,
      summary: `按顺序完成第${index + 1}章并更新章末人物状态`,
      mustDo: ["只使用 cutoff 内正典", "提交完整五类审计范围"],
      mustNotDo: ["泄露未来密钥", "跳过状态提交"],
      requiredCharacterIds: ["scale-character"],
      sourceIds: [sourceId],
    })),
    characterProfiles: [{
      entityId: "scale-character",
      valuePriorities: ["证据优先", "不伤无辜", "时态一致"],
      coreDesire: "把责任链钉回真实节点",
      coreFear: "错误信息污染后续数百章",
      secret: "由 owner 保管，不进入公开写章包",
      boundaries: ["不猜未来", "不自批正典"],
      forbiddenPhrases: ["一切尽在掌握"],
      vocabulary: ["证据", "节点", "先对账"],
      sentencePatterns: ["短句；先结论后证据"],
      relationshipVoices: [],
      sampleLines: ["先对账。账不平，谁都别走。"],
      sourceIds: [sourceId],
    }],
    characterAppearances: [{
      entityId: "scale-character",
      summary: "三十岁上下的清瘦青年，左眉尾有一道浅疤，常穿深灰旧夹克。",
      locks: [{
        lockId: "scale-left-brow-scar",
        category: "distinctive_mark" as const,
        canonicalDescription: "左眉尾有一道浅疤",
        allowedVariants: ["左眉尾淡疤"],
        contradictionPhrases: ["眉尾光洁无疤"],
        mutability: "immutable" as const,
        enforcement: "block" as const,
      }],
      sourceIds: [sourceId],
    }],
    completedChapterIds: [bootstrap.chapterId],
  };
  const seeded = await executeIdempotentCommand(projectRoot, commandEnvelope(
    "novel_seed_writing_state",
    seedPayload,
    "seed",
  ), { novelWriteActor: "human_owner" });
  let state = (seeded.result as { state: NovelWritingStateDocument }).state;
  const attribution = {
    actorId: "scale-primary-writer",
    provider: "local-deterministic",
    model: "sequential-fixture",
    sessionId: "scale-session-a",
    transport: "internal" as const,
  };
  const competingAttribution = { ...attribution, actorId: "scale-competing-writer", sessionId: "scale-session-b" };
  const originalDurations: number[] = [];
  const originalPhaseDurations = {
    readChapter: [] as number[],
    prepare: [] as number[],
    saveChapter: [] as number[],
    loadWritingState: [] as number[],
    stageCandidate: [] as number[],
    acceptCandidate: [] as number[],
  };
  let peakRssBytes = process.memoryUsage().rss;
  const faults: Record<string, string> = {};
  const externalPathCheckpoints: number[] = [];
  let restartProof: Record<string, unknown> | null = null;

  for (let index = 1; index <= chapterCount; index += 1) {
    const started = performance.now();
    const target = targets[index - 1]!;
    let phaseStarted = performance.now();
    const read = await repository.readChapter(target.chapterId);
    requireCondition(read.status === "healthy", `第${index}章正文身份异常。`);
    originalPhaseDurations.readChapter.push(performance.now() - phaseStarted);
    phaseStarted = performance.now();
    const prepared = await prepareNovelChapterWrite(projectRoot, {
      taskType: "revise_chapter",
      targetChapterId: target.chapterId,
      workflowMode: "formal",
      maxCharacters: 8_192,
      attribution,
      ttlSeconds: 1_800,
    });
    requireCondition(prepared.ready, `第${index}章 prepare 未 ready。`);
    originalPhaseDurations.prepare.push(performance.now() - phaseStarted);
    if (index === 1) {
      requireCondition(!JSON.stringify(prepared.pack).includes(futureSecret), "Context Pack 泄露 planned_later 未来秘密。");
      faults.doubleWriter = await captureReason(() => prepareNovelChapterWrite(projectRoot, {
        taskType: "revise_chapter",
        targetChapterId: target.chapterId,
        workflowMode: "formal",
        maxCharacters: 8_192,
        attribution: competingAttribution,
        ttlSeconds: 1_800,
      }));
    }
    const nextContent = `${read.content.trimEnd()}\n\n顺序受管写入-${String(index).padStart(3, "0")}。\n`;
    const useExternalPath = index === 1 || index === Math.ceil(chapterCount / 2) || index === chapterCount;
    let savedChapter: NovelChapterRecord;
    phaseStarted = performance.now();
    if (useExternalPath) {
      externalPathCheckpoints.push(index);
      const saved = await executeIdempotentCommand(projectRoot, commandEnvelope("novel_save_chapter", {
        chapterId: target.chapterId,
        content: nextContent,
        expectedRevision: target.revision,
        expectedSha256: target.sha256,
        aiWriteContext: prepared.aiWriteContext,
      }, `save-${index}`), {
        novelWriteActor: "agent",
        novelWriteLeaseToken: prepared.leaseToken,
        novelActorAttribution: attribution,
      });
      savedChapter = (saved.result as { chapter: NovelChapterRecord }).chapter;
    } else {
      const saved = await mutate(`save-${index}`, "novel_save_chapter", () => repository.saveChapter({
        chapterId: target.chapterId,
        content: nextContent,
        expectedRevision: target.revision,
        expectedSha256: target.sha256,
        aiWriteContext: prepared.aiWriteContext,
      }, {
        requireWriteLease: true,
        writeLease: { leaseToken: prepared.leaseToken, attribution },
      }));
      requireCondition(saved.chapter, `第${index}章 direct save 缺少 chapter。`);
      savedChapter = saved.chapter;
    }
    originalPhaseDurations.saveChapter.push(performance.now() - phaseStarted);
    phaseStarted = performance.now();
    state = (await loadNovelWritingState(projectRoot, projectId))!;
    originalPhaseDurations.loadWritingState.push(performance.now() - phaseStarted);
    if (index === 1) {
      const evidence = nextContent.slice(0, 8);
      faults.emptyDelta = await captureReason(() => mutate("fault-empty", "novel_stage_chapter_state_candidate", () => repository.stageChapterStateCandidate({
        chapterId: savedChapter.chapterId,
        expectedChapterRevision: savedChapter.revision,
        expectedChapterSha256: savedChapter.sha256,
        expectedWritingStateRevision: state.revision,
        expectedWritingStateFingerprint: state.fingerprint,
        summary: "空变更故障注入",
        delta: { characterStates: [], knowledge: [], relationships: [], timeline: [], foreshadowing: [] },
        evidenceSpans: [{ evidenceId: "fault-empty-evidence", startOffset: 0, endOffset: 8, evidenceExcerpt: evidence }],
        changeEvidence: [],
        auditScope: { checkedCharacterIds: ["scale-character"], checkedStateKinds: ["character_state", "knowledge", "relationship", "timeline", "foreshadowing"] },
      })));
      faults.unknownEntity = await captureReason(() => mutate("fault-unknown", "novel_stage_chapter_state_candidate", () => repository.stageChapterStateCandidate({
        ...candidatePayload(savedChapter, state, nextContent, "fault-unknown"),
        delta: {
          characterStates: [{ stateId: "unknown-state", entityId: "unknown-character", fields: dynamicFields("unknown") }],
          knowledge: [], relationships: [], timeline: [], foreshadowing: [],
        },
        changeEvidence: [{ kind: "character_state", recordId: "unknown-state", reason: "故障注入", evidenceSpanIds: ["evidence-fault-unknown"] }],
      })));
      faults.wrongCast = await captureReason(() => mutate("fault-cast", "novel_stage_chapter_state_candidate", () => repository.stageChapterStateCandidate({
        ...candidatePayload(savedChapter, state, nextContent, "fault-cast"),
        auditScope: { checkedCharacterIds: [], checkedStateKinds: ["character_state", "knowledge", "relationship", "timeline", "foreshadowing"] },
      })));
    }
    const payload = candidatePayload(savedChapter, state, nextContent, `original-${index}`);
    let candidate: NovelChapterStateCandidate;
    phaseStarted = performance.now();
    if (useExternalPath) {
      const staged = await executeIdempotentCommand(projectRoot, commandEnvelope(
        "novel_stage_chapter_state_candidate",
        payload as unknown as Record<string, unknown>,
        `stage-${index}`,
      ), { novelWriteActor: "agent" });
      candidate = (staged.result as { candidate: NovelChapterStateCandidate }).candidate;
    } else {
      candidate = (await mutate(`stage-${index}`, "novel_stage_chapter_state_candidate", () => repository.stageChapterStateCandidate(payload))).candidate as NovelChapterStateCandidate;
    }
    originalPhaseDurations.stageCandidate.push(performance.now() - phaseStarted);
    if (index === 1) {
      faults.agentSelfAccept = await captureReason(() => executeIdempotentCommand(projectRoot, commandEnvelope("novel_review_chapter_state_candidate", {
        candidateId: candidate.candidateId,
        expectedCandidateFingerprint: candidate.fingerprint,
        expectedWritingStateRevision: state.revision,
        expectedWritingStateFingerprint: state.fingerprint,
        decision: "accepted",
        reviewer: "scale-writer",
      }, "fault-agent-self-accept"), { novelWriteActor: "agent" }));
    }
    phaseStarted = performance.now();
    if (useExternalPath) {
      const accepted = await executeIdempotentCommand(projectRoot, commandEnvelope("novel_review_chapter_state_candidate", {
        candidateId: candidate.candidateId,
        expectedCandidateFingerprint: candidate.fingerprint,
        expectedWritingStateRevision: state.revision,
        expectedWritingStateFingerprint: state.fingerprint,
        decision: "accepted",
        reviewer: "scale-human-owner",
      }, `accept-${index}`), { novelWriteActor: "human_owner" });
      state = (accepted.result as { state: NovelWritingStateDocument }).state;
    } else {
      state = (await mutate(`accept-${index}`, "novel_review_chapter_state_candidate", () => repository.reviewChapterStateCandidate({
        candidateId: candidate.candidateId,
        expectedCandidateFingerprint: candidate.fingerprint,
        expectedWritingStateRevision: state.revision,
        expectedWritingStateFingerprint: state.fingerprint,
        decision: "accepted",
        reviewer: "scale-human-owner",
      }))).state;
    }
    originalPhaseDurations.acceptCandidate.push(performance.now() - phaseStarted);
    requireCondition(state.currentThroughChapterId === target.chapterId, `第${index}章 accept 未推进 head。`);
    originalDurations.push(performance.now() - started);
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
    if (index === Math.ceil(chapterCount / 2)) {
      const next = targets[index];
      requireCondition(next, "重启检查缺少下一章。");
      const cli = await runCli({
        schemaVersion: 1,
        operation: "get_writing_state",
        projectRoot,
        input: { targetChapterId: next.chapterId, cutoff: "before", characterIds: ["scale-character"] },
      }, registryPath);
      requireCondition(cli.code === 0 && cli.response.data?.stateIdentity?.currentThroughChapterId === target.chapterId,
        "新进程 CLI 未恢复当前 writing-state head。");
      restartProof = { atChapter: index, newProcessCliExitCode: cli.code, recoveredHead: target.chapterId };
      repository = new NovelRepository(projectRoot);
    }
    if (index % Math.max(1, Math.floor(chapterCount / 20)) === 0 || index === chapterCount) {
      process.stderr.write(`[sequential] ${index}/${chapterCount} head=${target.chapterId} rssMiB=${Math.round(peakRssBytes / 1024 / 1024)}\n`);
    }
  }

  snapshot = await repository.snapshot();
  state = (await loadNovelWritingState(projectRoot, projectId))!;
  const retconTarget = targets[retconFrom - 1]!;
  const retconRead = await repository.readChapter(retconTarget.chapterId);
  requireCondition(retconRead.status === "healthy", "retcon 目标正文异常。");
  const retconSaved = await mutate("retcon-save", "novel_save_chapter", () => repository.saveChapter({
    chapterId: retconTarget.chapterId,
    content: `${retconRead.content.trimEnd()}\n\nRETCON-${retconFrom}：补入早期因果证据。\n`,
    expectedRevision: retconRead.chapter.revision,
    expectedSha256: retconRead.chapter.sha256,
  }));
  requireCondition(retconSaved.chapter?.revision === retconRead.chapter.revision + 1, "retcon 正文未形成新 revision。");
  snapshot = await repository.snapshot();
  const plan = await planNovelWritingStateRebuild(projectRoot, snapshot, retconTarget.chapterId);
  requireCondition(plan.allowed && plan.affectedChapters.length === chapterCount - retconFrom + 1,
    `retcon rebuild plan 异常：allowed=${plan.allowed} affected=${plan.affectedChapters.length}`);
  const invalidated = await mutate("retcon-invalidate", "novel_invalidate_writing_state_from", () => repository.invalidateWritingStateFrom({
    targetChapterId: retconTarget.chapterId,
    expectedWritingStateRevision: state.revision,
    expectedWritingStateFingerprint: state.fingerprint,
    expectedPlanFingerprint: plan.fingerprint,
  }));
  state = invalidated.state;
  requireCondition(state.rebuild?.nextChapterId === retconTarget.chapterId, "invalidate 未建立精确 rebuild queue。");
  const outOfOrderTarget = targets[retconFrom]!;
  const outOfOrderRead = await repository.readChapter(outOfOrderTarget.chapterId);
  requireCondition(outOfOrderRead.status === "healthy", "越序故障注入章节异常。");
  faults.rebuildOutOfOrder = await captureReason(() => mutate("fault-rebuild-order", "novel_stage_chapter_state_candidate", () => repository.stageChapterStateCandidate(
    candidatePayload(outOfOrderRead.chapter, state, outOfOrderRead.content, `fault-rebuild-${retconFrom + 1}`),
  )));

  const rebuildDurations: number[] = [];
  const rebuildPhaseDurations = {
    readChapter: [] as number[],
    stageCandidate: [] as number[],
    acceptCandidate: [] as number[],
  };
  let rebuildRestartProof: Record<string, unknown> | null = null;
  const rebuildTotal = chapterCount - retconFrom + 1;
  for (let index = retconFrom; index <= chapterCount; index += 1) {
    const started = performance.now();
    const target = targets[index - 1]!;
    let phaseStarted = performance.now();
    const read = await repository.readChapter(target.chapterId);
    requireCondition(read.status === "healthy", `rebuild 第${index}章正文身份异常。`);
    rebuildPhaseDurations.readChapter.push(performance.now() - phaseStarted);
    phaseStarted = performance.now();
    const staged = await mutate(`rebuild-stage-${index}`, "novel_stage_chapter_state_candidate", () => repository.stageChapterStateCandidate(
      candidatePayload(read.chapter, state, read.content, `rebuild-${index}`),
    ));
    const candidate = staged.candidate as NovelChapterStateCandidate;
    rebuildPhaseDurations.stageCandidate.push(performance.now() - phaseStarted);
    phaseStarted = performance.now();
    state = (await mutate(`rebuild-accept-${index}`, "novel_review_chapter_state_candidate", () => repository.reviewChapterStateCandidate({
      candidateId: candidate.candidateId,
      expectedCandidateFingerprint: candidate.fingerprint,
      expectedWritingStateRevision: state.revision,
      expectedWritingStateFingerprint: state.fingerprint,
      decision: "accepted",
      reviewer: "scale-human-owner-rebuild",
    }))).state;
    rebuildPhaseDurations.acceptCandidate.push(performance.now() - phaseStarted);
    requireCondition(state.currentThroughChapterId === target.chapterId, `rebuild 第${index}章未推进 head。`);
    rebuildDurations.push(performance.now() - started);
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
    if (index === retconFrom + Math.floor(rebuildTotal / 2) && index < chapterCount) {
      const next = targets[index]!;
      const cli = await runCli({
        schemaVersion: 1,
        operation: "get_writing_state",
        projectRoot,
        input: { targetChapterId: next.chapterId, cutoff: "before", characterIds: ["scale-character"] },
      }, registryPath);
      requireCondition(cli.code === 0 && cli.response.data?.stateIdentity?.currentThroughChapterId === target.chapterId,
        "rebuild 中途新进程未恢复 cursor。");
      rebuildRestartProof = { atChapter: index, newProcessCliExitCode: cli.code, recoveredHead: target.chapterId };
      repository = new NovelRepository(projectRoot);
    }
    const rebuilt = index - retconFrom + 1;
    if (rebuilt % Math.max(1, Math.floor(rebuildTotal / 10)) === 0 || index === chapterCount) {
      process.stderr.write(`[rebuild] ${rebuilt}/${rebuildTotal} chapter=${index} rssMiB=${Math.round(peakRssBytes / 1024 / 1024)}\n`);
    }
  }

  snapshot = await repository.snapshot();
  state = (await loadNovelWritingState(projectRoot, projectId))!;
  requireCondition(!state.rebuild && state.currentThroughChapterId === targets.at(-1)!.chapterId,
    "重建完成后未恢复最终 head 或 rebuild 未清除。");
  requireCondition(state.chapterCompletions.length === chapterCount + 1,
    `最终 completion 数量应为 ${chapterCount + 1}，实际 ${state.chapterCompletions.length}。`);
  const historyStatus = await getNovelStateRebuildStatus(projectRoot);
  const expectedHistoryEvents = chapterCount + 1 + rebuildTotal;
  requireCondition(historyStatus.healthy && !historyStatus.recoveryRequired
    && historyStatus.verificationMode === "full"
    && historyStatus.verifiedEventCount === expectedHistoryEvents
    && historyStatus.activeRebuild === null,
  `状态谱系全链复验失败：${JSON.stringify({
    healthy: historyStatus.healthy,
    recoveryRequired: historyStatus.recoveryRequired,
    verificationMode: historyStatus.verificationMode,
    verifiedEventCount: historyStatus.verifiedEventCount,
    expectedHistoryEvents,
    activeRebuild: historyStatus.activeRebuild,
    issue: historyStatus.issue,
  })}`);

  const oracleChecks: Array<{ label: string; actual: string; expected: string; pass: boolean }> = [];
  const checkOracle = (label: string, targetIndexOneBased: number, cutoff: "before" | "through", expected: string): void => {
    const chapter = targets[targetIndexOneBased - 1]!;
    const projection = projectNovelWritingState(snapshot, state, {
      targetChapterId: chapter.chapterId,
      cutoff,
      characterIds: ["scale-character"],
    });
    const actual = projection.temporal.characterStates[0]?.fields.body ?? "MISSING";
    oracleChecks.push({ label, actual, expected, pass: actual === expected });
  };
  const beforeRetconSample = Math.max(2, retconFrom - 1);
  checkOracle("before-retcon-history", beforeRetconSample, "through", `稳定-original-${beforeRetconSample}`);
  checkOracle("retcon-boundary-before", retconFrom, "before", `稳定-original-${retconFrom - 1}`);
  if (retconFrom < chapterCount) checkOracle("retcon-boundary-through", retconFrom + 1, "before", `稳定-rebuild-${retconFrom}`);
  checkOracle("final-through", chapterCount, "through", `稳定-rebuild-${chapterCount}`);
  requireCondition(oracleChecks.every((entry) => entry.pass), `cutoff oracle 不一致：${JSON.stringify(oracleChecks)}`);

  const statePath = path.join(projectRoot, "story-bible", "writing-state.json");
  const candidateRoot = path.join(projectRoot, ".aicanvas", "novel", "change-sets");
  const decisionRoot = path.join(projectRoot, ".aicanvas", "novel", "change-set-decisions");
  const rebuildRoot = path.join(projectRoot, ".aicanvas", "novel", "state-rebuilds");
  const historyEventRoot = path.join(projectRoot, ".aicanvas", "novel", "state-history", "events", "sha256");
  const historyCheckpointRoot = path.join(projectRoot, ".aicanvas", "novel", "state-history", "checkpoints", "sha256");
  const leasePath = path.join(projectRoot, ".aicanvas", "novel", "chapter-write-leases.json");
  const [stateStat, candidateFiles, decisionFiles, rebuildDirectories, historyEventFiles, historyCheckpointFiles, leaseStat] = await Promise.all([
    stat(statePath),
    readdir(candidateRoot),
    readdir(decisionRoot),
    readdir(rebuildRoot),
    readdir(historyEventRoot),
    readdir(historyCheckpointRoot),
    stat(leasePath),
  ]);
  const leaseDocument = JSON.parse(await readFile(leasePath, "utf8")) as { leases?: unknown[] };
  const sourceAfterBytes = await readFile(sourcePath);
  const sourceAfter = {
    sha256: sha256(sourceAfterBytes),
    byteLength: sourceAfterBytes.byteLength,
    charCount: sourceAfterBytes.toString("utf8").length,
  };
  const expectedFaults = {
    doubleWriter: "chapter_write_lease_conflict",
    emptyDelta: "state_delta_required",
    unknownEntity: "invalid_reference",
    wrongCast: "invalid_reference",
    agentSelfAccept: "actor_forbidden",
    rebuildOutOfOrder: "state_rebuild_out_of_order",
  };
  requireCondition(Object.entries(expectedFaults).every(([key, value]) => faults[key] === value),
    `故障注入结果不符：${JSON.stringify(faults)}`);
  requireCondition(sourceAfter.sha256 === sourceBefore.sha256
    && sourceAfter.byteLength === sourceBefore.byteLength
    && sourceAfter.charCount === sourceBefore.charCount,
  "隔离导入来源在验收期间被修改。");
  requireCondition(candidateFiles.length === chapterCount + rebuildTotal,
    `候选文件数应为 ${chapterCount + rebuildTotal}，实际 ${candidateFiles.length}。`);
  requireCondition(decisionFiles.length === candidateFiles.length, "候选与裁决文件数量不一致。");
  requireCondition(rebuildDirectories.length === 1, "应只有一条受管 rebuild lineage。");
  requireCondition(historyEventFiles.length === expectedHistoryEvents,
    `状态 event 数量应为 ${expectedHistoryEvents}，实际 ${historyEventFiles.length}。`);
  requireCondition(historyCheckpointFiles.length === expectedHistoryEvents + 1,
    `状态 checkpoint 数量应为 ${expectedHistoryEvents + 1}，实际 ${historyCheckpointFiles.length}。`);
  requireCondition((leaseDocument.leases?.length ?? 0) <= 2, "租约账本未清理 stale lease，规模随章节线性增长。");

  const evidence = {
    schemaVersion: 1,
    kind: "novel-writing-os-sequential-scale-acceptance",
    verdict: "PASS",
    createdAt: new Date().toISOString(),
    environment: { node: process.version, platform: process.platform, arch: process.arch },
    scale: {
      targetChapters: chapterCount,
      managedChaptersIncludingBootstrap: chapterCount + 1,
      requestedSourceCharacters: targetCharacters,
      actualSourceCharacters: sourceBefore.charCount,
      retconFromChapter: retconFrom,
    },
    sourceReadOnly: { before: sourceBefore, after: sourceAfter, unchanged: true },
    import: { durationMs: importDurationMs, chapterCount: chapters.length },
    originalSequentialLoop: {
      cycles: chapterCount,
      operation: "prepare(formal+lease) -> CAS save -> evidence candidate -> owner accept",
      durationMs: Math.round(originalDurations.reduce((sum, value) => sum + value, 0)),
      latency: quantiles(originalDurations),
      latencyByWindow: windowedLatency(originalDurations),
      phases: summarizePhaseDurations(originalPhaseDurations),
      externalMcpEquivalentCommandBusCheckpoints: externalPathCheckpoints,
      restartProof,
    },
    retconRebuild: {
      targetChapter: retconFrom,
      affectedChapters: rebuildTotal,
      beforeSnapshotLocator: invalidated.snapshotLocator,
      cycles: rebuildDurations.length,
      durationMs: Math.round(rebuildDurations.reduce((sum, value) => sum + value, 0)),
      latency: quantiles(rebuildDurations),
      latencyByWindow: windowedLatency(rebuildDurations),
      phases: summarizePhaseDurations(rebuildPhaseDurations),
      restartProof: rebuildRestartProof,
      finalHeadChapter: chapterCount,
      rebuildCleared: state.rebuild === undefined,
    },
    faultInjection: { expected: expectedFaults, actual: faults, allFailedClosed: true, futureSecretAbsentFromPack: true },
    cutoffOracle: oracleChecks,
    storage: {
      writingStateBytes: stateStat.size,
      writingStateRevision: state.revision,
      characterStateHistoryRecords: state.characterStates.length,
      chapterCompletions: state.chapterCompletions.length,
      immutableCandidates: candidateFiles.length,
      immutableDecisions: decisionFiles.length,
      rebuildLineages: rebuildDirectories.length,
      historyEvents: historyEventFiles.length,
      historyCheckpoints: historyCheckpointFiles.length,
      fullLineageVerifiedEvents: historyStatus.verifiedEventCount,
      leaseFileBytes: leaseStat.size,
      liveOrStaleLeaseRecordsAfterPruning: leaseDocument.leases?.length ?? 0,
      peakRssBytes,
    },
    programGuarantees: [
      "cutoff projection and future-secret filtering",
      "required cast plus structured character profile formal gate",
      "chapter lease plus revision/SHA CAS",
      "evidence-bound state candidate plus human owner decision",
      "append-only dynamic history and ordered retcon rebuild",
      "append-only state events/checkpoints plus shadow rebuild and full-lineage verification",
      "new-process durable state recovery",
    ],
    limitations: [
      "规模循环使用确定性夹具，不代表真实文学质量或真实外部模型表现。",
      "中间章节使用同一 Repository/Core 写锁路径以控制验收时长；第1、中点、末章额外穿过 command bus actor/lease 外层。",
      "机械 PASS 不证明人物魅力、心理真实、节奏或文风，仍需独立模型与人工审稿。",
    ],
  };
  await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  success = true;
  process.stdout.write(`${JSON.stringify({
    verdict: evidence.verdict,
    evidencePath: outputPath,
    chapters: chapterCount,
    sourceCharacters: sourceBefore.charCount,
    originalLatency: evidence.originalSequentialLoop.latency,
    rebuildLatency: evidence.retconRebuild.latency,
    peakRssMiB: Math.round(peakRssBytes / 1024 / 1024),
  }, null, 2)}\n`);
} finally {
  if (previousRegistry === undefined) delete process.env.AI_CANVAS_REGISTRY_PATH;
  else process.env.AI_CANVAS_REGISTRY_PATH = previousRegistry;
  if (success) await rm(temporaryRoot, { recursive: true, force: true });
  else process.stderr.write(`[sequential] failed workspace preserved: ${temporaryRoot}\n`);
}
