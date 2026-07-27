import { createHash } from "node:crypto";
import { access, mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";
import sharp from "sharp";
import {
  appendStudioAssetVersion,
  createStudioCanonicalAsset,
  importStudioMedia,
  reviewStudioAssetVersion,
  setStudioPrimaryAuthority,
  type StudioCanonicalAssetCategory,
} from "../src/core/material-studio.js";
import { createManagedStudioProject } from "../src/core/service.js";
import { getStudioBindingControl } from "../src/core/studio-binding-control.js";
import {
  appendStudioPromptRevision,
  appendStudioScriptRevision,
  appendStudioScriptSectionRevision,
  createStudioProductionUnit,
  createStudioPromptDocument,
  createStudioScriptDocument,
  getCurrentStudioPanelAssetBindingSet,
  type StudioProductionPanelInput,
} from "../src/core/studio-production.js";

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evidenceRoot = path.join(workspace, "docs", "evidence");
const evidencePath = path.resolve(process.argv[2] || path.join(evidenceRoot, "p6-binding-workbench-ui-smoke-latest.json"));
const screenshotPath = path.resolve(process.argv[3] || path.join(evidenceRoot, "p6-binding-workbench-ui-smoke-latest.png"));

for (const output of [evidencePath, screenshotPath]) {
  const relative = path.relative(evidenceRoot, output);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`P6 UI 证据必须写入 docs/evidence：${output}`);
  }
  await access(output).then(
    () => { throw new Error(`P6 UI 证据已存在，拒绝覆盖：${output}`); },
    () => undefined,
  );
  await mkdir(path.dirname(output), { recursive: true });
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function fileEvidence(filePath: string) {
  const bytes = await readFile(filePath);
  const metadata = await stat(filePath);
  return { path: filePath, sizeBytes: metadata.size, sha256: sha256(bytes) };
}

async function createAuthority(
  root: string,
  input: { id: string; category: StudioCanonicalAssetCategory; name: string; aliases: string[]; color: string },
): Promise<void> {
  const sourcePath = path.join(root, `${input.id}-fixture.png`);
  await sharp({ create: { width: 180, height: 320, channels: 3, background: input.color } }).png().toFile(sourcePath);
  const media = await importStudioMedia(root, { sourcePath });
  const asset = await createStudioCanonicalAsset(root, {
    id: input.id,
    category: input.category,
    name: input.name,
    aliases: input.aliases,
    identityFeatures: [`${input.name} 固定身份`],
    positiveLocks: ["只使用当前 approved 权威版本"],
    negativeLocks: ["禁止串换身份"],
    defaultPrompt: `${input.name}，电影写实。`,
    expectedRevision: 0,
  });
  const appended = await appendStudioAssetVersion(root, {
    assetId: asset.id,
    mediaSha256: media.sha256,
    reviewStatus: "pending",
    sourceNote: "确定性本地 P6 UI fixture；不是正式生图。",
    expectedRevision: asset.revision,
  });
  const reviewed = await reviewStudioAssetVersion(root, {
    assetId: asset.id,
    versionId: appended.version.id,
    decision: "approved",
    note: "P6 UI smoke 机械 fixture 审核。",
    expectedRevision: appended.assetRevision,
  });
  await setStudioPrimaryAuthority(root, {
    assetId: asset.id,
    versionId: appended.version.id,
    expectedRevision: reviewed.revision,
    note: "P6 UI smoke 当前权威。",
  });
}

const temporaryRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "ai-canvas-p6-ui-")));
const projectsParent = path.join(temporaryRoot, "projects");
const registryPath = path.join(temporaryRoot, "registry", "projects.json");
const previousRegistry = process.env.AI_CANVAS_REGISTRY_PATH;
await Promise.all([mkdir(projectsParent, { recursive: true }), mkdir(path.dirname(registryPath), { recursive: true })]);
process.env.AI_CANVAS_REGISTRY_PATH = registryPath;

let application: Awaited<ReturnType<typeof electron.launch>> | undefined;
try {
  const shell = await createManagedStudioProject({ parentRoot: projectsParent, name: "P6 剧本绑定 UI 验证", slug: "p6-binding-ui" });
  const root = shell.paths.root;
  await createAuthority(root, { id: "prop-mask", category: "prop", name: "完整黄金面具", aliases: ["金面"], color: "#9b7423" });
  await createAuthority(root, { id: "character-guard-a", category: "character", name: "甲卫", aliases: ["守卫"], color: "#4a4038" });
  await createAuthority(root, { id: "character-guard-b", category: "character", name: "乙卫", aliases: ["守卫"], color: "#38424a" });

  const entitySentence = "金面与守卫在门前。";
  const emptySentence = "门内只有风吹动空帘。";
  const scriptBody = `${entitySentence}${emptySentence}`;
  const scriptDocument = await createStudioScriptDocument(root, { id: "script-p6-ui", title: "P6 UI 剧本", expectedRevision: 0 });
  const script = await appendStudioScriptRevision(root, {
    documentId: scriptDocument.id,
    expectedRevision: 0,
    body: scriptBody,
    source: "fixture/P6-UI.md",
    sourceVersion: "v1",
  });
  await appendStudioScriptSectionRevision(root, {
    sectionId: "chapter-p6-ui-01",
    expectedRevision: 0,
    kind: "chapter",
    title: "第一章 门前异动",
    scriptRevisionId: script.revision.id,
    scriptSha256: script.revision.bodySha256,
    startOffsetUtf16: 0,
    endOffsetUtf16: script.revision.body.length,
  });
  await appendStudioScriptSectionRevision(root, {
    sectionId: "scene-p6-ui-door",
    expectedRevision: 0,
    kind: "scene",
    title: "门前守卫",
    scriptRevisionId: script.revision.id,
    scriptSha256: script.revision.bodySha256,
    startOffsetUtf16: 0,
    endOffsetUtf16: script.revision.body.length,
  });
  const promptDocument = await createStudioPromptDocument(root, { id: "prompt-p6-ui", title: "P6 UI 提示词", expectedRevision: 0 });
  const prompt = await appendStudioPromptRevision(root, {
    documentId: promptDocument.id,
    expectedRevision: 0,
    body: "电影写实；所有身份先人工消歧，再冻结引用。",
    source: "fixture/P6-UI.txt",
    sourceVersion: "v1",
  });
  const assets: StudioProductionPanelInput["assets"] = [{
    assetId: "prop-mask",
    category: "prop",
    presence: "forbidden",
    role: "隐藏身份，不得进入可见参考。",
    continuityState: "实体保持不可见。",
    evidence: [{ kind: "hard-lock", reference: "mask-hidden" }],
  }, {
    assetId: "character-guard-a",
    category: "character",
    presence: "required",
    role: "门前守卫。",
    continuityState: "站位待 P7 记录。",
    evidence: [{ kind: "script", reference: script.revision.id }],
  }, {
    assetId: "character-guard-b",
    category: "character",
    presence: "required",
    role: "门前守卫。",
    continuityState: "站位待 P7 记录。",
    evidence: [{ kind: "script", reference: script.revision.id }],
  }];
  await createStudioProductionUnit(root, {
    id: "unit-p6-ui",
    season: "S03",
    episode: "EP01",
    sequence: 1,
    title: "门前消歧",
    scriptRevisionId: script.revision.id,
    expectedRevision: 0,
    panels: [{
      id: "panel-p6-ui-1",
      title: "门前",
      visualAction: "守卫在门前；黄金面具身份不得出画。",
      shotComposition: "中景。",
      filmingMethod: "固定机位。",
      startSeconds: 0,
      endSeconds: 7,
      durationSeconds: 7,
      promptRevisionId: prompt.revision.id,
      sourceSpans: [{ startOffsetUtf16: 0, endOffsetUtf16: entitySentence.length }],
      assets,
    }, {
      id: "panel-p6-ui-2",
      title: "门内",
      visualAction: "镜头进入门内。",
      shotComposition: "近景。",
      filmingMethod: "缓慢推近。",
      startSeconds: 7,
      endSeconds: 15,
      durationSeconds: 8,
      promptRevisionId: prompt.revision.id,
      sourceSpans: [{ startOffsetUtf16: entitySentence.length, endOffsetUtf16: script.revision.body.length }],
      assets: [],
    }],
  });

  const pageErrors: string[] = [];
  const externalRequests: string[] = [];
  const launchedAt = performance.now();
  application = await electron.launch({
    args: ["."],
    cwd: workspace,
    env: {
      ...process.env,
      AI_CANVAS_PROJECT_ROOT: root,
      AI_CANVAS_REGISTRY_PATH: registryPath,
      AI_CANVAS_WINDOW_WIDTH: "1900",
      AI_CANVAS_WINDOW_HEIGHT: "1200",
    },
  });
  const page = await application.firstWindow();
  page.setDefaultTimeout(90_000);
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("request", (request) => {
    if (/^https?:/iu.test(request.url())) externalRequests.push(request.url());
  });
  await page.locator('[data-testid="material-studio-view"]').waitFor();
  if (await page.locator('[data-testid="studio-binding-workbench"]').count()) {
    throw new Error("启动时错误预加载了剧本绑定工作台。 ");
  }
  await page.locator('[data-testid="studio-step-binding"]').click();
  const workbench = page.locator('[data-testid="studio-binding-workbench"]');
  await workbench.waitFor();
  await page.locator('[data-testid="binding-unit-entry"]').filter({ hasText: "门前消歧" }).waitFor();
  const panelEntries = page.locator('[data-testid="binding-panel-entry"]');
  await panelEntries.first().waitFor();
  if (await panelEntries.count() !== 2) throw new Error("P6 UI 没有显示严格二宫格时间线。 ");
  await page.locator('[data-testid="binding-source-excerpt"]').filter({ hasText: "金面与守卫在门前" }).waitFor();
  await page.locator('[data-testid="binding-source-section-chapter"]').filter({ hasText: "第一章 门前异动" }).waitFor();
  await page.locator('[data-testid="binding-source-section-scene"]').filter({ hasText: "门前守卫" }).waitFor();
  const analyze = page.locator('[data-testid="binding-analyze"]');
  if (await analyze.isDisabled()) throw new Error("有 source span 的当前宫格不应禁用解析。 ");
  await analyze.click();
  const maskProposal = page.locator('[data-testid="binding-proposal"]').filter({ hasText: "金面" });
  const guardProposal = page.locator('[data-testid="binding-proposal"]').filter({ hasText: "守卫" });
  await Promise.all([maskProposal.waitFor(), guardProposal.waitFor()]);
  const guardOptions = await guardProposal.locator("select").first().locator("option").evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value));
  if (!(await guardProposal.innerText()).includes("歧义") || !guardOptions.includes("character-guard-a")
    || !guardOptions.includes("character-guard-b")) {
    throw new Error("守卫歧义没有以两个候选显式显示。 ");
  }
  const maskOptions = await maskProposal.locator("select").first().locator("option").evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value));
  if (!(await maskProposal.innerText()).includes("匹配") || !maskOptions.includes("prop-mask")) {
    throw new Error("金面精确 alias 没有形成待审 matched 提案。 ");
  }
  if (!(await page.locator('[data-testid="binding-freeze"]').isDisabled())) throw new Error("歧义未解决时错误允许冻结。 ");
  await maskProposal.getByRole("button", { name: "确认候选（明确匹配）" }).click();
  await page.locator('[data-testid="binding-proposal"]').filter({ hasText: "守卫" })
    .locator("select").first().selectOption("character-guard-a");
  await page.locator('[data-testid="binding-proposal"]').filter({ hasText: "守卫" })
    .getByRole("button", { name: "确认候选（人工选择）" }).click();
  const freeze = page.locator('[data-testid="binding-freeze"]');
  await freeze.waitFor({ state: "visible" });
  await page.waitForFunction(() => {
    const button = document.querySelector('[data-testid="binding-freeze"]') as HTMLButtonElement | null;
    return Boolean(button && !button.disabled);
  });
  await freeze.click();
  await page.locator('[data-testid="binding-set-status"]').filter({ hasText: "当前有效" }).waitFor();
  const resolvedGuardText = await page.locator('[data-testid="binding-proposal"]').filter({ hasText: "守卫" }).innerText();
  if (!resolvedGuardText.includes("已确认") || !resolvedGuardText.includes("当前人工绑定：甲卫")) {
    throw new Error(`人工消歧结果没有从 Core resolvedAssetId 清晰回显：${resolvedGuardText}`);
  }
  const nextActionAfterFirstFreeze = await page.locator('[data-testid="binding-next-action"]').innerText();
  if (!nextActionAfterFirstFreeze.includes("宫格 2") || !nextActionAfterFirstFreeze.includes("解析")) {
    throw new Error(`第一格冻结后唯一下一步没有推进到第二格解析：${nextActionAfterFirstFreeze}`);
  }
  const firstPanelReadyText = await workbench.innerText();
  if (!firstPanelReadyText.includes("可以生图") || !firstPanelReadyText.includes("当前有效")) {
    throw new Error("生成绑定冻结后 UI 没有显示面向用户的可生图/当前有效状态。 ");
  }

  await panelEntries.nth(1).click();
  await page.locator('[data-testid="binding-source-excerpt"]').filter({ hasText: emptySentence }).waitFor();
  const secondAnalyze = page.locator('[data-testid="binding-analyze"]');
  if (await secondAnalyze.isDisabled()) throw new Error("零资产宫格仍应允许基于 source span 做显式分析。 ");
  await secondAnalyze.click();
  await page.locator('[data-testid="binding-empty-review"]').waitFor();
  if (await page.locator('[data-testid="binding-proposal"]').count() !== 0) {
    throw new Error("零资产宫格分析后意外产生了实体提案。 ");
  }
  const emptyReviewNote = "已逐字核对第二格唯一 source span；只有风吹空帘的环境动作，没有角色、场景身份或道具需要绑定。";
  await page.locator('[data-testid="binding-empty-note"]').fill(emptyReviewNote);
  const confirmEmpty = page.locator('[data-testid="binding-confirm-empty"]');
  await page.waitForFunction(() => {
    const button = document.querySelector('[data-testid="binding-confirm-empty"]') as HTMLButtonElement | null;
    return Boolean(button && !button.disabled);
  });
  await confirmEmpty.click();
  const emptyConfirmation = page.locator('[data-testid="binding-empty-confirmation-status"]');
  await emptyConfirmation.waitFor();
  const emptyConfirmationText = await emptyConfirmation.innerText();
  if (!emptyConfirmationText.includes("人工") || !emptyConfirmationText.includes(emptyReviewNote)) {
    throw new Error("confirmed-empty 的 user 审阅者或真实说明没有回显。 ");
  }
  const secondFreeze = page.locator('[data-testid="binding-freeze"]');
  await page.waitForFunction(() => {
    const button = document.querySelector('[data-testid="binding-freeze"]') as HTMLButtonElement | null;
    return Boolean(button && !button.disabled);
  });
  await secondFreeze.click();
  await page.locator('[data-testid="binding-set-status"]').filter({ hasText: "当前有效" }).waitFor();
  const nextActionAfterConfirmedEmptyFreeze = await page.locator('[data-testid="binding-next-action"]').innerText();
  if (!nextActionAfterConfirmedEmptyFreeze.includes("全部宫格绑定已就绪")) {
    throw new Error(`confirmed-empty 宫格冻结后单元仍未全部就绪：${nextActionAfterConfirmedEmptyFreeze}`);
  }
  const readyText = await workbench.innerText();
  if (!readyText.includes("当前有效") || !readyText.includes("可以生图")) {
    throw new Error("空镜冻结后 UI 没有同时显示审阅收据与可生图状态。 ");
  }
  const readyMs = Math.round(performance.now() - launchedAt);
  await page.locator('[data-testid="binding-source-excerpt"]').first().scrollIntoViewIfNeeded();
  // 绑定工作台内部已有独立滚动容器；fullPage 会要求 Chromium 重新栅格化整棵
  // 超长页面，在并行 MCP / SQLite 回归后的本机压力下可能卡在截图阶段。证据只需
  // 固定窗口内的真实最终状态，因此使用有界视口并关闭动画，避免截图本身成为假阻断。
  await page.screenshot({ path: screenshotPath, fullPage: false, animations: "disabled", timeout: 30_000 });
  await application.close();
  application = undefined;

  const control = await getStudioBindingControl(root, { unitId: "unit-p6-ui" });
  const bindingSet = await getCurrentStudioPanelAssetBindingSet(root, "unit-p6-ui", "panel-p6-ui-1");
  const confirmedEmptyBindingSet = await getCurrentStudioPanelAssetBindingSet(root, "unit-p6-ui", "panel-p6-ui-2");
  if (control.panels.some((panel) => panel.status !== "generation-ready") || !bindingSet || !confirmedEmptyBindingSet) {
    throw new Error("UI 操作落盘后 Core 未保持两个 generation-ready BindingSet。 ");
  }
  if (!confirmedEmptyBindingSet.confirmedEmpty || confirmedEmptyBindingSet.bindings.length !== 0
    || control.panels[1]?.emptyConfirmation?.currentness !== "current") {
    throw new Error("零资产宫格没有落盘为当前 confirmed-empty 空闭包。 ");
  }
  if (pageErrors.length || externalRequests.length) {
    throw new Error(`P6 UI 出现 renderer 错误或外网请求：${JSON.stringify({ pageErrors, externalRequests })}`);
  }
  const screenshot = await fileEvidence(screenshotPath);
  const metadata = await sharp(screenshotPath).metadata();
  const stats = await sharp(screenshotPath).stats();
  const stdev = Math.max(...stats.channels.map((channel) => channel.stdev));
  if ((metadata.width ?? 0) < 1_500 || (metadata.height ?? 0) < 900 || screenshot.sizeBytes < 35_000 || stdev < 5) {
    throw new Error("P6 UI 截图疑似空白或占位图。 ");
  }
  const evidence = {
    schemaVersion: 2,
    kind: "p6-binding-workbench-ui-smoke",
    status: "pass",
    createdAt: new Date().toISOString(),
    fixture: { projectId: shell.project.id, sourceRoots: shell.project.sourceRoots, units: 1, panels: 2, canonicalAssets: 3 },
    ui: {
      startupDefaultCanvas: true,
      bindingChunkLazyLoaded: true,
      sourceExcerptVisible: true,
      chapterAndSceneSourcesVisible: true,
      exactAliasPendingHumanAccept: true,
      ambiguousCandidateCount: 2,
      silentAmbiguitySelection: 0,
      resolvedDecisionVisible: true,
      confirmedEmptyReviewedByUser: true,
      confirmedEmptyCurrent: true,
      confirmedEmptyFrozen: true,
      bindingSetCurrent: true,
      generationReady: true,
      nextActionAfterFirstFreeze,
      nextActionAfterConfirmedEmptyFreeze,
      readyMs,
      pageErrors: 0,
      externalRequests: 0,
    },
    bindingSet: { id: bindingSet.id, fingerprint: bindingSet.fingerprint, bindings: bindingSet.bindings.length },
    confirmedEmptyBindingSet: {
      id: confirmedEmptyBindingSet.id,
      fingerprint: confirmedEmptyBindingSet.fingerprint,
      bindings: confirmedEmptyBindingSet.bindings.length,
      confirmedEmpty: confirmedEmptyBindingSet.confirmedEmpty,
      confirmationId: confirmedEmptyBindingSet.emptyConfirmationId,
      reviewer: control.panels[1]?.emptyConfirmation?.reviewer,
    },
    screenshot: { ...screenshot, width: metadata.width, height: metadata.height, format: metadata.format, stdev },
    boundaries: { formalProjectWrites: 0, filesystemScans: 0, imageGenerationCalls: 0, browserSupplierCalls: 0, uploads: 0 },
  };
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  process.stdout.write(`${JSON.stringify({
    evidencePath,
    screenshotPath,
    readyMs,
    bindingSetId: bindingSet.id,
    confirmedEmptyBindingSetId: confirmedEmptyBindingSet.id,
  })}\n`);
} finally {
  await application?.close().catch(() => undefined);
  await rm(temporaryRoot, { recursive: true, force: true });
  if (previousRegistry === undefined) delete process.env.AI_CANVAS_REGISTRY_PATH;
  else process.env.AI_CANVAS_REGISTRY_PATH = previousRegistry;
}
