import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { computeSourceDigest } from "../src/core/build-identity.js";
import { resolveCurrentMcpRuntime } from "../src/core/current-mcp-runtime.js";
import {
  buildNovelContextPack,
  getNovelWritingState,
  preflightNovelChapterWrite,
} from "../src/core/novel-agent-service.js";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evidenceRoot = path.join(workspaceRoot, "docs/evidence/novel-agent-contract-v1");
const beforeManifestPath = path.join(
  workspaceRoot,
  "docs/evidence/novel-mode-v1/real-project/black-page-ch011-pilot-before.json",
);
const afterManifestPath = path.join(
  workspaceRoot,
  "docs/evidence/novel-mode-v1/real-project/black-page-ch011-pilot-after.json",
);
const pilotReceiptPath = path.join(
  workspaceRoot,
  "docs/evidence/novel-mode-v1/real-project/black-page-ch011-managed-pilot.json",
);
const scaleEvidencePath = path.join(evidenceRoot, "writing-os-v1-1m-500-acceptance.json");
const uiEvidencePath = path.join(
  workspaceRoot,
  "docs/evidence/novel-mode-lite-v1/writing-os-v1-ui-smoke.json",
);
const outputPath = path.join(evidenceRoot, "writing-os-v1-final-validation-r2.json");

interface TreeManifest {
  kind: "novel-readonly-tree-manifest";
  rootPersisted: false;
  aggregateSha256: string;
  summary: {
    entries: number;
    directories: number;
    files: number;
    symlinks: number;
    fileBytes: number;
  };
  entries: Array<{
    path: string;
    type: string;
    size: number;
    mtimeNs: string;
    sha256: string | null;
  }>;
}

interface PilotChapterReceipt {
  number: number;
  chapterId: string;
  title: string;
  revision: number;
  sha256: string;
  sourceSha256: string | null;
  rehearsal: boolean;
}

interface PilotReceipt {
  kind: "black-page-ch011-managed-writing-pilot";
  baselineStatus: "provisional";
  formalSourceRootPersisted: false;
  formalSourceTreeAggregateSha256: string;
  managedProjectRelativePath: string;
  managedProjectId: string;
  sourceChecks: {
    selectedFiles: number;
    files: Array<{ relativePath: string; sha256: string; byteLength: number }>;
  };
  manuscript: { chapters: PilotChapterReceipt[] };
  mapping: {
    sources: number;
    entities: number;
    dynamicStates: number;
    knowledge: number;
    relationships: number;
    timeline: number;
    foreshadowing: number;
    hardCanon: number;
  };
  chapter11: {
    contextPackFingerprint: string;
    cutoffChapterId: string;
    budget: { maximumCharacters: number; usedCharacters: number; truncated: boolean; omitted: unknown[] };
    excerptChapterIds: string[];
    preflightId: string;
    saveRevision: number;
    staleReplayReason: string;
    reviewTicketId: string;
    candidateId: string;
    decisionId: string;
    committedStateRevision: number;
    committedThroughChapterId: string;
  };
  chapter12: { contextPackFingerprint: string; preflightId: string; ready: boolean };
  boundaries: {
    formalSourceWritten: false;
    remoteModelsCalled: false;
    feesIncurred: false;
    rehearsalBodySyncedToFormalSource: false;
  };
}

interface ManuscriptChapter {
  chapterId: string;
  title: string;
  order: number;
  relativePath: string;
  sha256: string;
  byteLength: number;
  charCount: number;
  revision: number;
}

interface ManuscriptManifest {
  kind: "novel-chapter-manifest";
  projectId: string;
  revision: number;
  chapters: ManuscriptChapter[];
}

interface WritingSource {
  sourceId: string;
  displayPath: string;
  objectRelativePath: string;
  sha256: string;
  byteLength: number;
}

interface ChapterCompletion {
  chapterId: string;
  chapterRevision: number;
  chapterSha256: string;
  stateCommitId: string;
  candidateId?: string;
}

interface WritingState {
  kind: "novel-writing-state";
  projectId: string;
  revision: number;
  fingerprint: string;
  baselineStatus: "provisional" | "locked";
  currentThroughChapterId: string;
  sources: WritingSource[];
  entities: Array<{ entityId: string; name: string }>;
  hardCanon: unknown[];
  characterStates: unknown[];
  knowledge: unknown[];
  relationships: unknown[];
  timeline: unknown[];
  foreshadowing: unknown[];
  chapterCompletions: ChapterCompletion[];
  appliedCandidateIds: string[];
}

interface ScaleEvidence {
  kind: "novel-writing-os-v1-1m-500-acceptance";
  status: "PASS";
  scope: {
    remoteModelsCalled: false;
    feesIncurred: false;
    formalNovelSourcesTouched: false;
    temporaryProjectsCleanedAfterReport: true;
  };
  runtime: { toolCount: number; requiredTools: string[] };
  smallVerticalSlice: {
    mcpCliEquivalent: { state: boolean; contextPack2: boolean; preflight: boolean };
    crossInterfaceReplay: boolean;
    staleReason: string;
    reviewTicketAttached: boolean;
    stateCommittedThroughChapter2: boolean;
    chapter3PreflightReady: boolean;
  };
  million: {
    targetCharacters: number;
    utf16Characters: number;
    chapterCount: number;
    importDurationMs: number;
    seedDurationMs: number;
    completionCount: number;
    contextPack: {
      version: number;
      deterministicRepeat: boolean;
      targetChapterExcluded: boolean;
      locatorRoundTrip: boolean;
      durationMs: number;
    };
    preflight: { ready: boolean };
    search: { scannedChapters: number; skippedExternalChanges: number; hitCount: number; hotDurationMs: number };
    sourceUnchanged: boolean;
  };
}

interface UiEvidence {
  kind: "novel-lite-short100-electron-smoke";
  verdict: "PASS";
  scope: {
    profile: "short100";
    targetCharacters: number;
    chapterCount: number;
    originalSourceReadOnly: boolean;
    remoteServicesUsed: boolean;
    installedApplicationReplaced: boolean;
  };
  runtimeState: {
    chapterCount: number;
    totalCharacters: number;
    manifestRevision: number;
    memoryCount: number;
    tracedMemory: boolean;
    searchConsistency: {
      scannedChapters: number;
      skippedExternalChanges: number;
      hitCount: number;
    };
  };
  sourceStableAfterImportAndUi: boolean;
  diagnostics: { pageErrors: string[]; consoleErrors: string[]; externalRequests: string[] };
  screenshot: { relativePath: string; bytes: number; width: number; height: number; entropy: number };
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function portable(relativePath: string): string {
  return relativePath.split(path.sep).join("/");
}

function workspaceRelative(absolutePath: string): string {
  const relative = path.relative(workspaceRoot, absolutePath);
  assert(relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
    `路径不在工作区内：${absolutePath}`);
  return portable(relative);
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

async function verifyChapterFile(projectRoot: string, chapter: ManuscriptChapter): Promise<{
  chapterId: string;
  order: number;
  revision: number;
  byteLength: number;
  charCount: number;
  sha256: string;
}> {
  const absolute = path.resolve(projectRoot, chapter.relativePath);
  assert(workspaceRelative(absolute).startsWith(`${workspaceRelative(projectRoot)}/`),
    `章节路径逃逸pilot工程：${chapter.relativePath}`);
  const bytes = await readFile(absolute);
  const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  assert(bytes.byteLength === chapter.byteLength, `章节byteLength不一致：${chapter.chapterId}`);
  assert(content.length === chapter.charCount, `章节charCount不一致：${chapter.chapterId}`);
  assert(sha256(bytes) === chapter.sha256, `章节SHA不一致：${chapter.chapterId}`);
  return {
    chapterId: chapter.chapterId,
    order: chapter.order,
    revision: chapter.revision,
    byteLength: bytes.byteLength,
    charCount: content.length,
    sha256: chapter.sha256,
  };
}

async function main(): Promise<void> {
  const [before, after, pilot, scale, ui] = await Promise.all([
    readJson<TreeManifest>(beforeManifestPath),
    readJson<TreeManifest>(afterManifestPath),
    readJson<PilotReceipt>(pilotReceiptPath),
    readJson<ScaleEvidence>(scaleEvidencePath),
    readJson<UiEvidence>(uiEvidencePath),
  ]);
  assert(before.kind === "novel-readonly-tree-manifest" && after.kind === before.kind, "正式源manifest类型错误。");
  assert(before.rootPersisted === false && after.rootPersisted === false, "正式源绝对路径被持久化。");
  assert(before.aggregateSha256 === after.aggregateSha256, "正式源前后聚合SHA不一致。");
  assert(JSON.stringify(before.summary) === JSON.stringify(after.summary), "正式源前后summary不一致。");
  assert(JSON.stringify(before.entries) === JSON.stringify(after.entries), "正式源前后entry清单不一致。");
  assert(pilot.formalSourceTreeAggregateSha256 === before.aggregateSha256, "pilot未绑定正式源before manifest。");
  assert(pilot.baselineStatus === "provisional", "《黑页》当前不得冒充locked基线。");
  assert(pilot.formalSourceRootPersisted === false, "pilot不应持久化正式源绝对路径。");
  assert(Object.values(pilot.boundaries).every((value) => value === false), "pilot越过了只读/离线边界。");

  const projectRoot = await realpath(path.join(workspaceRoot, pilot.managedProjectRelativePath));
  assert(workspaceRelative(projectRoot) === pilot.managedProjectRelativePath, "pilot相对路径与真实路径不一致。");
  const manuscriptPath = path.join(projectRoot, "manuscript/chapters.json");
  const statePath = path.join(projectRoot, "story-bible/writing-state.json");
  const [manuscript, state] = await Promise.all([
    readJson<ManuscriptManifest>(manuscriptPath),
    readJson<WritingState>(statePath),
  ]);
  assert(manuscript.projectId === pilot.managedProjectId && state.projectId === pilot.managedProjectId,
    "pilot工程ID不一致。");
  assert(manuscript.chapters.length === 12 && pilot.manuscript.chapters.length === 12, "pilot必须恰有12章。");
  assert(manuscript.chapters.every((chapter, index) => chapter.order === index), "pilot章节顺序不连续。");
  const chapterFiles = await Promise.all(manuscript.chapters.map((chapter) => verifyChapterFile(projectRoot, chapter)));
  for (const receiptChapter of pilot.manuscript.chapters) {
    const chapter = manuscript.chapters.find((entry) => entry.chapterId === receiptChapter.chapterId);
    assert(chapter, `pilot receipt章节不存在：${receiptChapter.number}`);
    assert(chapter.order === receiptChapter.number - 1
      && chapter.title === receiptChapter.title
      && chapter.revision === receiptChapter.revision
      && chapter.sha256 === receiptChapter.sha256,
    `pilot receipt章节身份不一致：${receiptChapter.number}`);
    if (receiptChapter.number <= 10) {
      assert(receiptChapter.rehearsal === false && receiptChapter.sourceSha256 === chapter.sha256,
        `来源章SHA未与受管正文锁定：${receiptChapter.number}`);
      const sourceCheck = pilot.sourceChecks.files.find((entry) => entry.sha256 === receiptChapter.sourceSha256
        && entry.relativePath.startsWith("正文/"));
      assert(sourceCheck?.byteLength === chapter.byteLength, `来源章字节数未与受管正文锁定：${receiptChapter.number}`);
    }
  }
  const chapter11 = manuscript.chapters[10]!;
  const chapter12 = manuscript.chapters[11]!;
  assert(chapter11.revision === 2 && chapter11.charCount > 0 && pilot.manuscript.chapters[10]!.rehearsal,
    "011隔离演练正文身份错误。");
  assert(chapter12.revision === 1 && chapter12.charCount === 0 && pilot.manuscript.chapters[11]!.rehearsal,
    "012应保持空白隔离演练章。");

  assert(state.kind === "novel-writing-state" && state.revision === 2, "writing-state未推进到revision 2。");
  assert(state.baselineStatus === "provisional" && state.currentThroughChapterId === chapter11.chapterId,
    "writing-state截止章错误。");
  assert(state.sources.length === pilot.mapping.sources
    && state.entities.length === pilot.mapping.entities
    && state.characterStates.length === pilot.mapping.dynamicStates
    && state.knowledge.length === pilot.mapping.knowledge
    && state.relationships.length === pilot.mapping.relationships
    && state.timeline.length === pilot.mapping.timeline
    && state.foreshadowing.length === pilot.mapping.foreshadowing
    && state.hardCanon.length === pilot.mapping.hardCanon,
  "writing-state映射计数与pilot receipt不一致。");
  const sourceObjects = await Promise.all(state.sources.map(async (source) => {
    const sourcePath = path.resolve(projectRoot, source.objectRelativePath);
    assert(workspaceRelative(sourcePath).startsWith(`${workspaceRelative(projectRoot)}/`),
      `writing source object逃逸pilot：${source.sourceId}`);
    const bytes = await readFile(sourcePath);
    assert(bytes.byteLength === source.byteLength && sha256(bytes) === source.sha256,
      `writing source object身份错误：${source.sourceId}`);
    const selected = pilot.sourceChecks.files.find((entry) => entry.relativePath === source.displayPath);
    assert(selected?.sha256 === source.sha256 && selected.byteLength === source.byteLength,
      `writing source object未绑定只读来源：${source.displayPath}`);
    return { sourceId: source.sourceId, sha256: source.sha256, byteLength: source.byteLength };
  }));
  assert(state.chapterCompletions.length === 11, "writing-state应有001-011共11个completion。");
  for (const completion of state.chapterCompletions) {
    const chapter = manuscript.chapters.find((entry) => entry.chapterId === completion.chapterId);
    assert(chapter?.revision === completion.chapterRevision && chapter.sha256 === completion.chapterSha256,
      `completion与正文身份不一致：${completion.chapterId}`);
  }
  assert(state.appliedCandidateIds.includes(pilot.chapter11.candidateId), "011状态候选未进入已批准列表。");

  const candidatePath = path.join(projectRoot, `.aicanvas/novel/change-sets/${pilot.chapter11.candidateId}.json`);
  const decisionPath = path.join(projectRoot, `.aicanvas/novel/change-set-decisions/${pilot.chapter11.candidateId}.json`);
  const reviewPath = path.join(projectRoot, `.aicanvas/novel/reviews/${pilot.chapter11.reviewTicketId}.json`);
  const [candidate, decision, review, chapter11Body] = await Promise.all([
    readJson<{ candidateId: string; chapter: { chapterId: string; chapterRevision: number; chapterSha256: string } }>(candidatePath),
    readJson<{ decisionId: string; candidateId: string; decision: string; writingStateRevision: number }>(decisionPath),
    readJson<{
      ticketId: string;
      chapter: { chapterId: string; chapterRevision: number; chapterSha256: string };
      startOffset: number;
      endOffset: number;
      evidenceExcerpt: string;
    }>(reviewPath),
    readFile(path.join(projectRoot, chapter11.relativePath), "utf8"),
  ]);
  assert(candidate.candidateId === pilot.chapter11.candidateId
    && candidate.chapter.chapterId === chapter11.chapterId
    && candidate.chapter.chapterRevision === chapter11.revision
    && candidate.chapter.chapterSha256 === chapter11.sha256,
  "011状态候选未绑定正文CAS身份。");
  assert(decision.decisionId === pilot.chapter11.decisionId
    && decision.candidateId === candidate.candidateId
    && decision.decision === "accepted"
    && decision.writingStateRevision === state.revision,
  "011状态裁决未绑定已提交state。");
  assert(review.ticketId === pilot.chapter11.reviewTicketId
    && review.chapter.chapterId === chapter11.chapterId
    && review.chapter.chapterRevision === chapter11.revision
    && review.chapter.chapterSha256 === chapter11.sha256
    && chapter11Body.slice(review.startOffset, review.endOffset) === review.evidenceExcerpt,
  "review ticket未绑定正文证据区间。");
  const pastChapterIds = new Set(manuscript.chapters.slice(0, 10).map((chapter) => chapter.chapterId));
  assert(pilot.chapter11.excerptChapterIds.every((chapterId) => pastChapterIds.has(chapterId)),
    "011 context pack包含目标章或未来章正文。");
  assert(pilot.chapter11.cutoffChapterId === manuscript.chapters[9]!.chapterId
    && pilot.chapter11.budget.truncated === false
    && pilot.chapter11.budget.omitted.length === 0
    && pilot.chapter11.staleReplayReason === "context_preflight_stale",
  "011 pack/cutoff/stale门证据不完整。");

  const yihang = state.entities.find((entity) => entity.name === "易航");
  assert(yihang, "writing-state缺少易航实体。");
  const liveState = await getNovelWritingState(projectRoot, { targetChapterId: chapter12.chapterId, cutoff: "before" });
  assert(liveState.stateIdentity.revision === state.revision && liveState.stateIdentity.fingerprint === state.fingerprint,
    "共享Agent service读取的state与权威文件不一致。");
  const pack12 = await buildNovelContextPack(projectRoot, {
    taskType: "continue_chapter",
    targetChapterId: chapter12.chapterId,
    characterIds: [yihang.entityId],
    maxCharacters: 60_000,
  });
  assert("contextPackVersion" in pack12
    && pack12.contextPackVersion === 2
    && pack12.fingerprint === pilot.chapter12.contextPackFingerprint,
    "012 Context Pack 2.0不再确定性复现。");
  const preflight12 = await preflightNovelChapterWrite(projectRoot, {
    targetChapterId: chapter12.chapterId,
    contextPackFingerprint: pack12.fingerprint,
    characterIds: [yihang.entityId],
    maxCharacters: 60_000,
  });
  assert(preflight12.ready
    && preflight12.preflightId === pilot.chapter12.preflightId
    && pilot.chapter12.ready,
  "012 preflight不再ready或身份不稳定。");

  assert(scale.kind === "novel-writing-os-v1-1m-500-acceptance" && scale.status === "PASS", "1M证据未通过。");
  assert(Object.values(scale.scope).every((value) => value === false || value === true)
    && scale.scope.remoteModelsCalled === false
    && scale.scope.feesIncurred === false
    && scale.scope.formalNovelSourcesTouched === false
    && scale.scope.temporaryProjectsCleanedAfterReport,
  "1M smoke越过边界或未清理临时工程。");
  assert(scale.runtime.toolCount === 209
    && Object.values(scale.smallVerticalSlice.mcpCliEquivalent).every(Boolean)
    && scale.smallVerticalSlice.crossInterfaceReplay
    && scale.smallVerticalSlice.staleReason === "context_preflight_stale"
    && scale.smallVerticalSlice.reviewTicketAttached
    && scale.smallVerticalSlice.stateCommittedThroughChapter2
    && scale.smallVerticalSlice.chapter3PreflightReady,
  "MCP/CLI小型闭环证据不完整。");
  assert(scale.million.targetCharacters === 1_000_000
    && scale.million.utf16Characters === 1_000_000
    && scale.million.chapterCount === 500
    && scale.million.completionCount === 499
    && scale.million.contextPack.version === 2
    && scale.million.contextPack.deterministicRepeat
    && scale.million.contextPack.targetChapterExcluded
    && scale.million.contextPack.locatorRoundTrip
    && scale.million.preflight.ready
    && scale.million.search.scannedChapters === 500
    && scale.million.search.skippedExternalChanges === 0
    && scale.million.search.hitCount === 1
    && scale.million.sourceUnchanged,
  "1M/500章性能或一致性门未满足。");

  assert(ui.kind === "novel-lite-short100-electron-smoke" && ui.verdict === "PASS", "最小Electron smoke未通过。");
  assert(ui.scope.profile === "short100"
    && ui.scope.targetCharacters === 100
    && ui.scope.chapterCount === 1
    && ui.scope.originalSourceReadOnly
    && !ui.scope.remoteServicesUsed
    && !ui.scope.installedApplicationReplaced,
  "Electron smoke越过只读来源、远程服务或安装版边界。");
  assert(ui.runtimeState.chapterCount === 1
    && ui.runtimeState.totalCharacters >= 100
    && ui.runtimeState.manifestRevision === 2
    && ui.runtimeState.memoryCount === 1
    && ui.runtimeState.tracedMemory
    && ui.runtimeState.searchConsistency.scannedChapters === 1
    && ui.runtimeState.searchConsistency.skippedExternalChanges === 0
    && ui.runtimeState.searchConsistency.hitCount === 1
    && ui.sourceStableAfterImportAndUi,
  "Electron导入、搜索、记忆或正文保存闭环不完整。");
  assert(ui.diagnostics.pageErrors.length === 0
    && ui.diagnostics.consoleErrors.length === 0
    && ui.diagnostics.externalRequests.length === 0,
  "Electron smoke存在页面、控制台或外部请求错误。");
  assert(ui.screenshot.bytes >= 40_000
    && ui.screenshot.width >= 1_400
    && ui.screenshot.height >= 850
    && ui.screenshot.entropy >= 1.1,
  "Electron截图机械质量不足。");

  const [liveSource, runtime] = await Promise.all([
    computeSourceDigest(workspaceRoot),
    resolveCurrentMcpRuntime({ workspace: workspaceRoot }),
  ]);
  assert(runtime.receipt.sourceDigest === liveSource.sourceDigest
    && runtime.receipt.sourceFiles === liveSource.sourceFiles
    && runtime.receipt.sourceBytes === liveSource.sourceBytes
    && runtime.receipt.mcpToolCount === 209
    && runtime.expected.mcpToolCount === 209
    && runtime.invalidCandidates === 0,
  "current immutable MCP candidate与live source不一致。");

  const report = {
    schemaVersion: 1,
    kind: "novel-writing-os-v1-final-validation",
    status: "PASS",
    generatedAt: new Date().toISOString(),
    conclusion: {
      softwareWritingLoop: "complete",
      blackPageFormalBaseline: "provisional",
      blackPageChapter11ProductionWritten: false,
      literaryQualityReviewed: false,
      humanVisualUiReviewed: false,
    },
    formalSource: {
      beforeManifest: workspaceRelative(beforeManifestPath),
      afterManifest: workspaceRelative(afterManifestPath),
      entries: before.summary.entries,
      files: before.summary.files,
      bytes: before.summary.fileBytes,
      aggregateSha256: before.aggregateSha256,
      completeEntryEquality: true,
      rootPersisted: false,
    },
    blackPagePilot: {
      receipt: workspaceRelative(pilotReceiptPath),
      project: workspaceRelative(projectRoot),
      baselineStatus: pilot.baselineStatus,
      chapters: chapterFiles,
      sourceChaptersByteIdentical: 10,
      writingState: {
        revision: state.revision,
        fingerprint: state.fingerprint,
        currentThroughChapterId: state.currentThroughChapterId,
        completionCount: state.chapterCompletions.length,
        sourceObjects: sourceObjects.length,
        entities: state.entities.length,
        dynamicStates: state.characterStates.length,
        knowledge: state.knowledge.length,
        relationships: state.relationships.length,
        timeline: state.timeline.length,
        foreshadowing: state.foreshadowing.length,
        hardCanon: state.hardCanon.length,
      },
      chapter11: {
        preflightId: pilot.chapter11.preflightId,
        contextPackFingerprint: pilot.chapter11.contextPackFingerprint,
        pastOnlyExcerpts: true,
        staleReplayReason: pilot.chapter11.staleReplayReason,
        reviewTicketId: review.ticketId,
        candidateId: candidate.candidateId,
        decisionId: decision.decisionId,
        bodyUnchangedByReviewAndCommit: true,
      },
      chapter12: {
        contextPackDeterministic: true,
        preflightId: preflight12.preflightId,
        ready: preflight12.ready,
      },
    },
    millionCharacterAcceptance: {
      evidence: workspaceRelative(scaleEvidencePath),
      characters: scale.million.utf16Characters,
      chapters: scale.million.chapterCount,
      importDurationMs: scale.million.importDurationMs,
      stateSeedDurationMs: scale.million.seedDurationMs,
      contextPackDurationMs: scale.million.contextPack.durationMs,
      searchDurationMs: scale.million.search.hotDurationMs,
      scannedChapters: scale.million.search.scannedChapters,
      externalChanges: scale.million.search.skippedExternalChanges,
      locatorRoundTrip: scale.million.contextPack.locatorRoundTrip,
    },
    runtime: {
      sourceDigest: liveSource.sourceDigest,
      sourceFiles: liveSource.sourceFiles,
      sourceBytes: liveSource.sourceBytes,
      candidateId: runtime.receipt.candidateId,
      buildId: runtime.receipt.buildId,
      mcpToolCount: runtime.receipt.mcpToolCount,
      invalidCandidates: runtime.invalidCandidates,
      liveDistMcpUnchangedByCandidateBuild: true,
      installedApplicationReplaced: false,
    },
    electron: {
      evidence: workspaceRelative(uiEvidencePath),
      verdict: ui.verdict,
      isolated: true,
      importedSearchedEditedAndSaved: true,
      screenshots: [ui.screenshot.relativePath],
      mechanicalOnly: true,
    },
    boundaries: {
      formalSourceWritten: false,
      remoteModelsCalled: false,
      feesIncurred: false,
      gitStagedOrCommitted: false,
      deployedOrPublished: false,
    },
  };
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  assert(!serialized.includes("/Users/") && !serialized.includes("file://"), "最终证据泄漏本机绝对路径。");
  await mkdir(evidenceRoot, { recursive: true });
  const existing = await readFile(outputPath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  let replayed = false;
  if (existing !== null) {
    const prior = JSON.parse(existing) as typeof report;
    const replayProjection = { ...report, generatedAt: prior.generatedAt };
    assert(JSON.stringify(prior) === JSON.stringify(replayProjection),
      `最终证据已存在但与当前验证结果不同，拒绝覆盖：${workspaceRelative(outputPath)}`);
    replayed = true;
  } else {
    await writeFile(outputPath, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    replayed,
    evidence: workspaceRelative(outputPath),
    sourceDigest: liveSource.sourceDigest,
    candidateId: runtime.receipt.candidateId,
    mcpToolCount: runtime.receipt.mcpToolCount,
    formalSourceAggregateSha256: before.aggregateSha256,
  })}\n`);
}

await main();
