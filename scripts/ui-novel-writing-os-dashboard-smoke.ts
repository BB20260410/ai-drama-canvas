import { createHash, randomUUID } from "node:crypto";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import sharp from "sharp";
import { executeIdempotentCommand, type IdempotentCommandInput } from "../src/core/command-bus.js";
import { createManagedProject } from "../src/core/managed-project.js";
import { registerProject, setActiveProjectRegistration } from "../src/core/sidecar.js";
import type { CanvasApi } from "../src/preload/index.js";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runId = process.env.NOVEL_WRITING_OS_UI_RUN_ID ?? "desktop-writing-os-p0-20260802";
if (!/^[a-z0-9][a-z0-9._-]{0,79}$/u.test(runId)) throw new Error(`非法证据 run id：${runId}`);
const evidenceDirectory = path.join(workspaceRoot, "docs", "evidence", "novel-mode-v1", "writing-os-desktop-p0", runId);
const outputPaths = {
  report: path.join(evidenceDirectory, "electron-smoke.json"),
  dashboard: path.join(evidenceDirectory, "01-dashboard-state-debt.png"),
  diff: path.join(evidenceDirectory, "02-candidate-diff.png"),
  accepted: path.join(evidenceDirectory, "03-state-accepted.png"),
};
for (const output of Object.values(outputPaths)) {
  await access(output).then(
    () => { throw new Error(`证据已存在，拒绝覆盖：${output}`); },
    () => undefined,
  );
}
await mkdir(evidenceDirectory, { recursive: true });

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

let sequence = 0;
function envelope(command: string, payload: Record<string, unknown>): IdempotentCommandInput {
  sequence += 1;
  return {
    requestId: `writing-os-ui-${sequence}-${randomUUID()}`,
    idempotencyKey: `writing-os-ui-key-${sequence}-${randomUUID()}`,
    request: { command, payload },
  } as IdempotentCommandInput;
}

interface Diagnostics {
  pageErrors: string[];
  consoleErrors: string[];
  externalRequests: string[];
}

function observe(page: Page, diagnostics: Diagnostics): void {
  page.on("pageerror", (entry) => diagnostics.pageErrors.push(entry.message));
  page.on("console", (entry) => {
    if (entry.type() === "error") diagnostics.consoleErrors.push(entry.text());
  });
  page.on("request", (request) => {
    if (/^https?:/iu.test(request.url())) diagnostics.externalRequests.push(request.url());
  });
}

async function closeApplication(application: ElectronApplication | undefined): Promise<void> {
  if (!application) return;
  await application.close().catch(() => {
    const child = application.process();
    if (child.exitCode === null) child.kill("SIGTERM");
  });
}

async function screenshotIdentity(filePath: string): Promise<{
  relativePath: string;
  bytes: number;
  sha256: string;
  width: number;
  height: number;
  entropy: number;
}> {
  const bytes = await readFile(filePath);
  const image = sharp(bytes);
  const [metadata, statistics] = await Promise.all([image.metadata(), image.stats()]);
  if (!metadata.width || !metadata.height || bytes.byteLength < 40_000 || metadata.width < 1400
    || metadata.height < 850 || statistics.entropy < 1.1) {
    throw new Error(`Electron 截图机械质量不足：${path.basename(filePath)}`);
  }
  return {
    relativePath: path.relative(workspaceRoot, filePath).split(path.sep).join("/"),
    bytes: bytes.byteLength,
    sha256: sha256(bytes),
    width: metadata.width,
    height: metadata.height,
    entropy: statistics.entropy,
  };
}

const temporaryRoot = await realpath(await mkdtemp(path.join(await realpath(os.tmpdir()), "ai-canvas-writing-os-ui-")));
const projectsParent = path.join(temporaryRoot, "projects");
const registryPath = path.join(temporaryRoot, "registry", "projects.json");
const userDataPath = path.join(temporaryRoot, "user-data");
await Promise.all([
  mkdir(projectsParent, { recursive: true }),
  mkdir(path.dirname(registryPath), { recursive: true }),
  mkdir(userDataPath, { recursive: true }),
]);
const previousRegistryPath = process.env.AI_CANVAS_REGISTRY_PATH;
process.env.AI_CANVAS_REGISTRY_PATH = registryPath;
let application: ElectronApplication | undefined;
let completed = false;

try {
  const shell = await createManagedProject({
    parentRoot: projectsParent,
    name: "Writing OS 桌面闭环验收",
    slug: "writing-os-desktop-p0",
    workspaceMode: "novel",
  });
  await registerProject(shell.project);
  const initialized = await executeIdempotentCommand(shell.paths.root, envelope("novel_initialize_manuscript", {
    sourceMode: "managed_markdown",
  }));
  let manifest = (initialized.result as {
    chapters: { revision: number; volumes: Array<{ volumeId: string }> };
  }).chapters;
  const volumeId = manifest.volumes[0]!.volumeId;
  const chapters: Array<{ chapterId: string; revision: number; sha256: string }> = [];
  for (const [title, content] of [["第010章 基线", "易航确认担保短信存在。"], ["第011章 对账", ""]] as const) {
    const created = await executeIdempotentCommand(shell.paths.root, envelope("novel_create_chapter", {
      volumeId,
      title,
      content,
      expectedManifestRevision: manifest.revision,
    }), { novelWriteActor: "human_ui" });
    const result = created.result as {
      chapter: { chapterId: string; revision: number; sha256: string };
      manifest: { revision: number; volumes: Array<{ volumeId: string }> };
    };
    chapters.push(result.chapter);
    manifest = result.manifest;
  }
  const chapter10 = chapters[0]!;
  const chapter11 = chapters[1]!;
  const seeded = await executeIdempotentCommand(shell.paths.root, envelope("novel_seed_writing_state", {
    baselineStatus: "locked",
    sourceTreeAggregateSha256: sha256("desktop-ui-fixture-source"),
    currentThroughChapterId: chapter10.chapterId,
    sourceDocuments: [{ sourceId: "canon", displayPath: "夹具/正典.md", content: "易航证据优先。" }],
    entities: [{
      entityId: "character-yihang",
      name: "易航",
      aliases: [],
      level: "L1",
      baseSummary: "冷静，证据优先。",
      sourceIds: ["canon"],
    }],
    hardCanon: [{
      ruleId: "canon-evidence-first",
      text: "易航证据优先。",
      priority: 100,
      canonStatus: "canon",
      visibility: "writer",
      sourceIds: ["canon"],
    }],
    characterStates: [{
      stateId: "state-yihang",
      entityId: "character-yihang",
      throughChapterId: chapter10.chapterId,
      fields: {
        body: "疲惫",
        emotion: "克制",
        known: ["担保短信存在"],
        unknown: ["后台身份"],
        relationships: [],
        goals: ["完成对账"],
        psychology: "先固定证据",
        unresolved: ["担保链去向"],
      },
      sourceIds: ["canon"],
    }],
    knowledge: [],
    relationships: [],
    timeline: [],
    foreshadowing: [],
    chapterBriefs: [{
      chapterId: chapter11.chapterId,
      summary: "易航固定账本证据。",
      mustDo: ["完成对账"],
      mustNotDo: ["越界知晓后台身份"],
      requiredCharacterIds: ["character-yihang"],
      sourceIds: ["canon"],
    }],
    characterProfiles: [{
      entityId: "character-yihang",
      valuePriorities: ["证据优先"],
      coreDesire: "固定责任链",
      coreFear: "证据被抹去",
      secret: "旧案创伤",
      boundaries: ["不伤无辜"],
      forbiddenPhrases: ["一切尽在掌握"],
      vocabulary: ["对账", "证据"],
      sentencePatterns: ["短句"],
      relationshipVoices: [],
      sampleLines: ["先对账。"],
      sourceIds: ["canon"],
    }],
    characterAppearances: [{
      entityId: "character-yihang",
      summary: "三十岁上下的清瘦青年，左眉尾有一道浅疤，常穿深灰旧夹克。",
      locks: [{
        lockId: "yihang-left-brow-scar",
        category: "distinctive_mark" as const,
        canonicalDescription: "左眉尾有一道浅疤",
        allowedVariants: ["左眉尾淡疤"],
        contradictionPhrases: ["眉尾光洁无疤"],
        mutability: "immutable" as const,
        enforcement: "block" as const,
      }],
      sourceIds: ["canon"],
    }],
    completedChapterIds: [chapter10.chapterId],
  }), { novelWriteActor: "human_ui" });
  const initialState = (seeded.result as { state: { revision: number; fingerprint: string } }).state;
  const chapterContent = "易航按住账本，先对账。";
  const saved = await executeIdempotentCommand(shell.paths.root, envelope("novel_save_chapter", {
    chapterId: chapter11.chapterId,
    content: chapterContent,
    expectedRevision: chapter11.revision,
    expectedSha256: chapter11.sha256,
  }), { novelWriteActor: "human_ui" });
  const savedChapter = (saved.result as { chapter: { chapterId: string; revision: number; sha256: string } }).chapter;
  const staged = await executeIdempotentCommand(shell.paths.root, envelope("novel_stage_chapter_state_candidate", {
    chapterId: savedChapter.chapterId,
    expectedChapterRevision: savedChapter.revision,
    expectedChapterSha256: savedChapter.sha256,
    expectedWritingStateRevision: initialState.revision,
    expectedWritingStateFingerprint: initialState.fingerprint,
    summary: "易航完成账本证据固定，身体疲惫加重。",
    delta: {
      characterStates: [{
        stateId: "state-yihang",
        entityId: "character-yihang",
        fields: {
          body: "通宵后明显疲惫",
          emotion: "克制但警觉",
          known: ["担保短信存在", "账本可作证"],
          unknown: ["后台身份"],
          relationships: [],
          goals: ["追查责任链"],
          psychology: "证据已固定，开始追人",
          unresolved: ["担保链去向"],
        },
      }],
      knowledge: [], relationships: [], timeline: [], foreshadowing: [],
    },
    evidenceSpans: [{ evidenceId: "evidence-body", startOffset: 0, endOffset: chapterContent.length, evidenceExcerpt: chapterContent }],
    changeEvidence: [{
      kind: "character_state",
      recordId: "state-yihang",
      reason: "动作与对白证明证据固定。",
      evidenceSpanIds: ["evidence-body"],
    }],
    auditScope: {
      checkedCharacterIds: ["character-yihang"],
      checkedStateKinds: ["character_state", "knowledge", "relationship", "timeline", "foreshadowing"],
    },
  }));
  const candidate = (staged.result as { candidate: { candidateId: string; fingerprint: string } }).candidate;
  await setActiveProjectRegistration(shell.paths.root);

  const diagnostics: Diagnostics = { pageErrors: [], consoleErrors: [], externalRequests: [] };
  application = await electron.launch({
    args: [".", `--user-data-dir=${userDataPath}`],
    cwd: workspaceRoot,
    env: {
      ...process.env,
      AI_CANVAS_MCP_ALLOW_MULTI: "1",
      AI_CANVAS_REGISTRY_PATH: registryPath,
      AI_CANVAS_PROJECT_ROOT: shell.paths.root,
      AI_CANVAS_MANAGED_PROJECTS_ROOT: projectsParent,
      AI_CANVAS_WORKSPACE: workspaceRoot,
      AI_CANVAS_WINDOW_WIDTH: "1728",
      AI_CANVAS_WINDOW_HEIGHT: "1029",
      ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
    },
  });
  const page = await application.firstWindow();
  observe(page, diagnostics);
  page.setDefaultTimeout(90_000);
  await page.setViewportSize({ width: 1728, height: 1029 });
  await page.locator('[data-testid="root-runtime-write-gate"]').waitFor({ state: "detached" });
  await page.locator('[data-testid="novel-studio-view"]').waitFor();
  await page.locator('[data-testid="novel-chapter-editor"]').waitFor();
  await page.locator('[data-testid="novel-writing-dashboard"]').waitFor();
  await page.locator('[data-testid="novel-writing-dashboard-refresh"]:not([disabled])').waitFor();
  await page.locator(`[data-chapter-id="${savedChapter.chapterId}"]:not([disabled])`).click();
  await page.locator(`[data-chapter-id="${savedChapter.chapterId}"].active`).waitFor();
  await page.locator('[data-testid="novel-writing-dashboard-refresh"]:not([disabled])').waitFor();
  await page.locator('[data-testid="novel-state-debt"]').filter({ hasText: "欠状态提交" }).waitFor();
  await page.locator('[data-testid="novel-consistency-probe"]').filter({ hasText: "机械冲突" }).waitFor();
  await page.screenshot({ path: outputPaths.dashboard, animations: "disabled" });

  await page.locator('[data-testid="novel-writing-tab-memory"]').click();
  await page.locator('[data-testid="novel-memory-list"]').getByText("人物外形", { exact: false }).first().waitFor();
  await page.locator('[data-testid="novel-memory-list"]').getByText("左眉尾有一道浅疤", { exact: false }).first().waitFor();

  await page.locator('[data-testid="novel-writing-tab-candidates"]').click();
  const diff = page.locator('[data-testid="novel-state-candidate-diff"]');
  await diff.waitFor();
  await diff.getByText("人物动态八项", { exact: false }).first().waitFor();
  await diff.getByText("通宵后明显疲惫", { exact: true }).waitFor();
  await page.screenshot({ path: outputPaths.diff, animations: "disabled" });

  page.once("dialog", async (dialog) => dialog.accept());
  await page.locator('[data-testid="novel-accept-state-candidate"]').click();
  await page.locator('[data-testid="novel-state-debt"]').filter({ hasText: "状态已提交" }).waitFor();
  await page.locator('[data-testid="novel-consistency-probe"]').filter({ hasText: "机械通过" }).waitFor();
  await page.locator('[data-testid="novel-writing-readiness"]').filter({ hasText: "当前无待写章" }).waitFor();
  if (await page.locator('[data-testid="novel-writing-dashboard"] .blockers').count()) {
    throw new Error("最后一章完成后 target_chapter_missing 不应继续显示为阻断项。");
  }
  await page.locator('[data-testid="novel-notice"]').filter({ hasText: "状态候选已由人类界面接受" }).waitFor();
  await page.screenshot({ path: outputPaths.accepted, animations: "disabled" });

  const runtimeState = await page.evaluate(async (chapterId) => {
    const api = (window as typeof window & { canvasApi: CanvasApi }).canvasApi;
    const active = await api.getActiveProject();
    if (!active?.available) throw new Error("Electron 没有活动小说工程。");
    const dashboard = await api.novel.getWritingDashboard(active.primaryRoot, {
      selectedChapterId: String(chapterId),
      workflowMode: "formal",
    });
    return {
      projectId: dashboard.projectId,
      readyForPrepare: dashboard.writeReadiness.readyForPrepare,
      currentThroughChapterId: dashboard.writingState?.currentThroughChapterId,
      selectedCompletion: dashboard.selectedChapter?.completion.status,
      probeStatus: dashboard.selectedChapter?.probe?.status,
      pendingCandidateCount: dashboard.pendingCandidateCount,
    };
  }, savedChapter.chapterId);
  if (runtimeState.currentThroughChapterId !== savedChapter.chapterId
    || runtimeState.selectedCompletion !== "committed"
    || runtimeState.probeStatus !== "pass"
    || runtimeState.pendingCandidateCount !== 0) {
    throw new Error(`Electron Writing OS 状态不符合预期：${JSON.stringify(runtimeState)}`);
  }
  const decisionPath = path.join(shell.paths.root, ".aicanvas", "novel", "change-set-decisions", `${candidate.candidateId}.json`);
  const decision = JSON.parse(await readFile(decisionPath, "utf8")) as {
    candidateId: string;
    decision: string;
    reviewer: string;
    fingerprint: string;
  };
  if (decision.candidateId !== candidate.candidateId || decision.decision !== "accepted"
    || decision.reviewer !== "desktop-human-owner" || !/^[a-f0-9]{64}$/u.test(decision.fingerprint)) {
    throw new Error(`Electron 人类裁决回执无效：${JSON.stringify(decision)}`);
  }
  if (diagnostics.pageErrors.length || diagnostics.consoleErrors.length || diagnostics.externalRequests.length) {
    throw new Error(`Electron 诊断不干净：${JSON.stringify(diagnostics)}`);
  }

  const screenshots = await Promise.all([
    screenshotIdentity(outputPaths.dashboard),
    screenshotIdentity(outputPaths.diff),
    screenshotIdentity(outputPaths.accepted),
  ]);
  const releaseManifest = JSON.parse(await readFile(path.join(workspaceRoot, "release-manifest.json"), "utf8")) as {
    sourceDigest?: string;
    buildId?: string;
  };
  const report = {
    schemaVersion: 1,
    kind: "novel-writing-os-desktop-p0-electron-smoke",
    verdict: "PASS",
    capturedAt: new Date().toISOString(),
    scope: {
      isolatedManagedFixture: true,
      formalNovelSourcesTouched: false,
      remoteServicesUsed: false,
      gitMutationPerformed: false,
    },
    build: {
      sourceDigest: releaseManifest.sourceDigest,
      buildId: releaseManifest.buildId,
    },
    checks: {
      stateDebtVisibleBeforeReview: true,
      machineConflictVisibleBeforeReview: true,
      appearanceAuthorityVisible: true,
      eightFieldDiffVisible: true,
      humanUiAcceptedCandidate: true,
      completionCommittedAfterReview: true,
      probePassedAfterReview: true,
      pendingCandidateRemovedAfterReview: true,
      fixedReviewerInjectedByMain: decision.reviewer === "desktop-human-owner",
    },
    runtimeState,
    decision: {
      candidateId: decision.candidateId,
      decision: decision.decision,
      reviewer: decision.reviewer,
      fingerprint: decision.fingerprint,
    },
    diagnostics,
    screenshots,
  };
  await writeFile(outputPaths.report, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  await chmod(outputPaths.report, 0o600);
  completed = true;
  process.stdout.write(`${JSON.stringify({
    verdict: "PASS",
    report: path.relative(workspaceRoot, outputPaths.report).split(path.sep).join("/"),
    screenshots: screenshots.map((entry) => entry.relativePath),
    runtimeState,
  }, null, 2)}\n`);
} finally {
  await closeApplication(application);
  if (!completed) {
    await Promise.all(Object.values(outputPaths).map((output) => rm(output, { force: true })));
  }
  if (previousRegistryPath === undefined) delete process.env.AI_CANVAS_REGISTRY_PATH;
  else process.env.AI_CANVAS_REGISTRY_PATH = previousRegistryPath;
  await rm(temporaryRoot, { recursive: true, force: true });
}
