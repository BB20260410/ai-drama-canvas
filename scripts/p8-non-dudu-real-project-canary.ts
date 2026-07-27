import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import sharp from "sharp";
import { executeIdempotentCommand } from "../src/core/command-bus.js";
import { importStudioMedia } from "../src/core/material-studio.js";
import { inspectManagedProject } from "../src/core/managed-project.js";
import { getStudioPostResultObservationControl } from "../src/core/studio-post-result-observation.js";
import { readAnyStudioGenerationFrozenPack } from "../src/core/studio-generation-ledger.js";
import { readStudioGenerationReview } from "../src/core/studio-generation-review.js";
import { materializeStudioMediaDerivatives } from "../src/core/studio-media-derivatives.js";
import {
  attachStudioMultimediaTimelineMedia,
  getStudioMultimediaTimelineProjection,
} from "../src/core/studio-multimedia-timeline.js";
import { getStudioProductionUnitSnapshot } from "../src/core/studio-production.js";
import {
  getStudioVideoPackageControl,
  prepareStudioVideoPackageSource,
} from "../src/core/studio-video-package.js";
import { registerProject, setActiveProjectRegistration } from "../src/core/sidecar.js";
import {
  assertRedlineProjectSentinelsUnchanged,
  createIsolatedRedlineProjectCopy,
  snapshotRedlineProjectSentinels,
} from "./lib/redline-project-sentinel-shared.js";
import {
  commitUnitGridBundle,
  freezeDispatchPrepareUnitGrid,
  passUnitGridReview,
} from "../tests/helpers/studio-unit-grid-fixture.js";

const execFileAsync = promisify(execFile);
const workspace = path.resolve(import.meta.dirname, "..");
const sourceProjectRoot = path.resolve(
  process.argv[2]
    ?? path.join(workspace, "projects", "grok-mvp-qingdeng-mrwc97mu-d0aea463"),
);
const executablePath = path.resolve(
  process.argv[3]
    ?? path.join(workspace, "node_modules", "electron", "dist", "Electron.app", "Contents", "MacOS", "Electron"),
);
const evidencePath = path.resolve(
  process.argv[4]
    ?? path.join(workspace, "output", "evidence", "p8-non-dudu-real-project-canary-20260727.json"),
);
const screenshotPath = path.resolve(
  process.argv[5]
    ?? path.join(workspace, "output", "playwright", "p8-non-dudu-real-project-canary-20260727.png"),
);

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function generationCounts(projectRoot: string): {
  dispatches: number;
  callIntents: number;
  callEvents: number;
  results: number;
  reviews: number;
} {
  const database = new DatabaseSync(
    path.join(projectRoot, ".aicanvas", "studio-generation-ledger.sqlite"),
    { readOnly: true },
  );
  try {
    const count = (table: string) => Number(
      (database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count,
    );
    return {
      dispatches: count("studio_generation_dispatches"),
      callIntents: count("studio_generation_call_intents"),
      callEvents: count("studio_generation_call_events"),
      results: count("studio_generation_results"),
      reviews: count("studio_generation_review_events"),
    };
  } finally {
    database.close();
  }
}

function selectCurrentCodexReviewId(projectRoot: string): string {
  const database = new DatabaseSync(
    path.join(projectRoot, ".aicanvas", "studio-generation-ledger.sqlite"),
    { readOnly: true },
  );
  try {
    const row = database.prepare(`
      SELECT e.review_id
      FROM studio_generation_review_heads h
      JOIN studio_generation_review_events e
        ON e.review_id = h.review_id
        AND e.generation_run_id = h.generation_run_id
      JOIN studio_generation_dispatches d
        ON d.generation_run_id = e.generation_run_id
      WHERE e.decision = 'pass'
        AND e.current_at_submission = 1
        AND d.executor_provider = 'codex'
      ORDER BY e.sequence DESC
      LIMIT 1
    `).get() as { review_id?: string } | undefined;
    if (!row?.review_id) {
      throw new Error("非嘟嘟真实工程没有当前 Codex Review PASS，拒绝用旧 Grok 结果补证。");
    }
    return row.review_id;
  } finally {
    database.close();
  }
}

function assetCounts(projectRoot: string): { canonicalAssets: number; primaryAuthorities: number } {
  const database = new DatabaseSync(
    path.join(projectRoot, ".aicanvas", "material-studio.sqlite"),
    { readOnly: true },
  );
  try {
    return {
      canonicalAssets: Number((
        database.prepare("SELECT COUNT(*) AS count FROM studio_canonical_assets").get() as { count: number }
      ).count),
      primaryAuthorities: Number((
        database.prepare(`
          SELECT COUNT(*) AS count
          FROM studio_canonical_assets
          WHERE primary_version_id IS NOT NULL
        `).get() as { count: number }
      ).count),
    };
  } finally {
    database.close();
  }
}

async function makeRealMedia(projectRoot: string): Promise<{ videoPath: string; audioPath: string }> {
  const videoPath = path.join(projectRoot, "p8-canary-video.mp4");
  const audioPath = path.join(projectRoot, "p8-canary-dialogue.wav");
  await execFileAsync("ffmpeg", [
    "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=24",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
    "-t", "3", "-shortest",
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart",
    "-y", videoPath,
  ], { maxBuffer: 4 * 1024 * 1024 });
  await execFileAsync("ffmpeg", [
    "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "sine=frequency=523.25:sample_rate=48000:duration=3",
    "-af", "volume=0.12",
    "-c:a", "pcm_s16le",
    "-y", audioPath,
  ], { maxBuffer: 4 * 1024 * 1024 });
  return { videoPath, audioPath };
}

async function playForProbe(
  page: Page,
  testId: "multimedia-video-player" | "multimedia-audio-player",
) {
  const player = page.locator(`[data-testid="${testId}"]`);
  await player.waitFor({ state: "visible", timeout: 60_000 });
  await page.waitForFunction((selector) => {
    const media = document.querySelector<HTMLMediaElement>(selector);
    return Boolean(media
      && media.readyState >= HTMLMediaElement.HAVE_METADATA
      && Number.isFinite(media.duration)
      && media.duration > 0);
  }, `[data-testid="${testId}"]`, { timeout: 60_000 });
  return player.evaluate(async (media: HTMLMediaElement) => {
    const startSeconds = media.currentTime;
    await media.play();
    await new Promise((resolve) => setTimeout(resolve, 900));
    media.pause();
    return {
      readyState: media.readyState,
      networkState: media.networkState,
      durationSeconds: media.duration,
      startSeconds,
      endSeconds: media.currentTime,
      advanced: media.currentTime > startSeconds + 0.2,
      paused: media.paused,
      errorCode: media.error?.code ?? null,
      sourceProtocol: new URL(media.currentSrc || media.src).protocol,
    };
  });
}

async function screenshotEvidence(page: Page) {
  const bytes = await page.screenshot({ type: "png", fullPage: false, animations: "disabled" });
  await writeFile(screenshotPath, bytes, { flag: "wx", mode: 0o600 });
  const [metadata, statistics, file] = await Promise.all([
    sharp(bytes).metadata(),
    sharp(bytes).stats(),
    stat(screenshotPath),
  ]);
  const maxChannelStandardDeviation = Math.max(...statistics.channels.map((channel) => channel.stdev));
  if ((metadata.width ?? 0) < 1_400
    || (metadata.height ?? 0) < 800
    || file.size < 30_000
    || maxChannelStandardDeviation < 5) {
    throw new Error("非嘟嘟桌面 canary 截图疑似空白或占位。");
  }
  return {
    path: path.relative(workspace, screenshotPath).split(path.sep).join("/"),
    sha256: sha256(bytes),
    sizeBytes: file.size,
    width: metadata.width,
    height: metadata.height,
    maxChannelStandardDeviation,
  };
}

await Promise.all([
  mkdir(path.dirname(evidencePath), { recursive: true }),
  mkdir(path.dirname(screenshotPath), { recursive: true }),
]);
const sourceSentinelsBefore = await snapshotRedlineProjectSentinels(sourceProjectRoot);
const isolated = await createIsolatedRedlineProjectCopy(sourceProjectRoot);
const registryPath = path.join(isolated.runtimeRoot, "registry", "projects.json");
const userDataPath = path.join(isolated.runtimeRoot, "user-data");
const previousRegistryPath = process.env.AI_CANVAS_REGISTRY_PATH;
const previousRuntimePath = process.env.AI_CANVAS_MEDIA_RUNTIME_DIR;
let application: ElectronApplication | undefined;
let sourceSentinelsAfter = sourceSentinelsBefore;

try {
  const shell = await inspectManagedProject(isolated.projectRoot);
  const sourceReviewId = selectCurrentCodexReviewId(shell.paths.root);
  const sourceReview = await readStudioGenerationReview(shell.paths.root, sourceReviewId);
  if (!sourceReview || sourceReview.decision !== "pass") {
    throw new Error("非嘟嘟真实工程没有可追溯的 Codex Review PASS。");
  }
  const sourcePack = await readAnyStudioGenerationFrozenPack(shell.paths.root, sourceReview.packId);
  if (!sourcePack
    || !("targetKind" in sourcePack.target)
    || sourcePack.target.targetKind !== "unit-grid") {
    throw new Error("选择到的 Codex Review 不属于当前 unit-grid 冻结包。");
  }
  const unitId = sourcePack.target.unitId;
  const snapshot = await getStudioProductionUnitSnapshot(shell.paths.root, unitId);
  if (!snapshot || snapshot.unit.revision !== sourcePack.target.unitRevision) {
    throw new Error("非嘟嘟真实工程当前单元与冻结包 revision 不一致。");
  }

  const countsBefore = generationCounts(shell.paths.root);
  const assets = assetCounts(shell.paths.root);
  if (assets.canonicalAssets < 1 || assets.primaryAuthorities < 1) {
    throw new Error("非嘟嘟真实工程缺少可追溯权威资产。");
  }
  let review = sourceReview;
  let pack = sourcePack;
  let reviewMode: "reused-current-codex-review" | "isolated-deterministic-core-canary";
  if (sourceReview.current && sourceReview.approvedRawEligible) {
    reviewMode = "reused-current-codex-review";
  } else {
    const run = await freezeDispatchPrepareUnitGrid(
      shell.paths.root,
      unitId,
      "p8-real-non-dudu-deterministic-run-v1",
    );
    const bundle = await commitUnitGridBundle(
      shell.paths.root,
      run,
      "p8-real-non-dudu-deterministic-result-v1",
      { rawColor: "#24384a", labeledColor: "#6d5339" },
    );
    review = await passUnitGridReview(
      shell.paths.root,
      run,
      bundle,
      "p8-real-non-dudu-deterministic-review-v1",
      {
        reviewer: "p8-real-non-dudu-core-canary",
        note: "隔离副本确定性机械 canary：只验证通用 owner 与视频包，不冒充模型生成或正式视觉验收。",
      },
    );
    pack = run.pack.pack;
    reviewMode = "isolated-deterministic-core-canary";
  }
  if (!review.current || review.decision !== "pass" || !review.approvedRawEligible) {
    throw new Error("隔离副本未形成 current PASS Review。");
  }

  process.env.AI_CANVAS_MEDIA_RUNTIME_DIR = path.join(isolated.runtimeRoot, "media-runtime");
  const mediaPaths = await makeRealMedia(shell.paths.root);
  const [video, audio] = await Promise.all([
    importStudioMedia(shell.paths.root, { sourcePath: mediaPaths.videoPath, kind: "video" }),
    importStudioMedia(shell.paths.root, { sourcePath: mediaPaths.audioPath, kind: "audio" }),
  ]);
  const [videoDerivatives, audioDerivatives] = await Promise.all([
    materializeStudioMediaDerivatives(shell.paths.root, { mediaSha256: video.sha256 }),
    materializeStudioMediaDerivatives(shell.paths.root, { mediaSha256: audio.sha256 }),
  ]);
  if (videoDerivatives.status !== "ready" || audioDerivatives.status !== "ready") {
    throw new Error("非嘟嘟真实视频或音频派生未 ready。");
  }

  const common = {
    unitId,
    unitRevision: snapshot.unit.revision,
    expectedUnitFingerprint: snapshot.fingerprint,
  };
  const videoBinding = await attachStudioMultimediaTimelineMedia(shell.paths.root, {
    ...common,
    operationId: "p8-real-non-dudu-video-attach-v1",
    slotId: "p8-video-main",
    expectedHeadRevision: 0,
    startSeconds: 0,
    endSeconds: 3,
    role: "video",
    mediaSha256: video.sha256,
    note: "P8 非嘟嘟真实项目隔离 canary：H.264/AAC。",
  });
  const audioBinding = await attachStudioMultimediaTimelineMedia(shell.paths.root, {
    ...common,
    operationId: "p8-real-non-dudu-audio-attach-v1",
    slotId: "p8-dialogue-main",
    expectedHeadRevision: 0,
    startSeconds: 0,
    endSeconds: 3,
    role: "dialogue",
    mediaSha256: audio.sha256,
    note: "P8 非嘟嘟真实项目隔离 canary：PCM 对白轨。",
  });
  const timeline = await getStudioMultimediaTimelineProjection(shell.paths.root, { unitId });
  if (!timeline
    || timeline.availability.script !== "available"
    || timeline.availability.storyboard !== "available"
    || timeline.availability.video !== "available"
    || timeline.availability.audio !== "available") {
    throw new Error(`非嘟嘟真实项目四轨未齐：${JSON.stringify(timeline?.availability)}`);
  }

  const observation = await getStudioPostResultObservationControl(
    shell.paths.root,
    review.generationRunId,
  );
  const managedSource = await prepareStudioVideoPackageSource(shell.paths.root, {
    adapterKind: "managed-evidence-v1",
    reviewId: review.reviewId,
    expectedReviewFingerprint: review.fingerprint,
    expectedPackFingerprint: pack.fingerprint,
    expectedUnitSnapshotFingerprint: snapshot.fingerprint,
    expectedObservationControlFingerprint: observation.fingerprint,
    expectedObservationHeadRevision: observation.headRevision,
    expectedObservationStatus: observation.status,
    expectedObservationHeadId: observation.head?.observationId ?? null,
    expectedObservationHeadFingerprint: observation.head?.fingerprint ?? null,
    expectedObservationEvidenceSha256: observation.head?.evidenceSha256 ?? null,
  });
  const authority = { kind: "studio-review" as const, reviewId: review.reviewId };
  const beforePrepare = await getStudioVideoPackageControl(shell.paths.root, {
    by: "authority-latest",
    authority,
  });
  const expectedManagedSource = {
    adapterKind: "managed-evidence-v1" as const,
    reviewId: review.reviewId,
    expectedSourceFingerprint: managedSource.fingerprint,
    expectedReviewFingerprint: review.fingerprint,
    expectedPackFingerprint: pack.fingerprint,
    expectedUnitSnapshotFingerprint: snapshot.fingerprint,
    expectedObservationControlFingerprint: observation.fingerprint,
    expectedObservationHeadRevision: observation.headRevision,
    expectedObservationStatus: observation.status,
    expectedObservationHeadId: observation.head?.observationId ?? null,
    expectedObservationHeadFingerprint: observation.head?.fingerprint ?? null,
    expectedObservationEvidenceSha256: observation.head?.evidenceSha256 ?? null,
  };
  const preparedRecord = await executeIdempotentCommand(shell.paths.root, {
    requestId: "p8-real-non-dudu-video-package-prepare-request-v1",
    idempotencyKey: "p8-real-non-dudu-video-package-prepare-key-v1",
    request: {
      command: "prepare_studio_video_package_export",
      payload: {
        authority,
        expectedRevision: snapshot.unit.revision,
        expectedControlFingerprint: beforePrepare.fingerprint,
        expectedManagedSource,
      },
    },
  });
  if (preparedRecord.status !== "succeeded") throw new Error("视频包 prepare 命令未成功。");
  const prepared = preparedRecord.result as {
    intent: { intentId: string; fingerprint: string; unitRevision: number };
  };
  const [intentControl, authorityControl] = await Promise.all([
    getStudioVideoPackageControl(shell.paths.root, {
      by: "intent",
      intentId: prepared.intent.intentId,
    }),
    getStudioVideoPackageControl(shell.paths.root, {
      by: "authority-latest",
      authority,
    }),
  ]);
  const builtRecord = await executeIdempotentCommand(shell.paths.root, {
    requestId: "p8-real-non-dudu-video-package-build-request-v1",
    idempotencyKey: "p8-real-non-dudu-video-package-build-key-v1",
    request: {
      command: "build_studio_video_package",
      payload: {
        intentId: prepared.intent.intentId,
        expectedRevision: snapshot.unit.revision,
        expectedIntentControlFingerprint: intentControl.fingerprint,
        expectedAuthorityControlFingerprint: authorityControl.fingerprint,
        destinationPolicy: "managed-evidence-only",
      },
    },
  });
  if (builtRecord.status !== "succeeded") throw new Error("视频包 build 命令未成功。");
  const built = builtRecord.result as {
    receipt: {
      receiptId: string;
      storageKind: string;
      mechanicalStatus: string;
      dynamicModelStatus: string;
      manifestSha256: string;
      files: Array<{ path: string; sha256: string }>;
      fingerprint: string;
    };
  };
  if (built.receipt.storageKind !== "managed-evidence"
    || built.receipt.mechanicalStatus !== "verified"
    || built.receipt.dynamicModelStatus !== "not-run"
    || built.receipt.files.length < 5) {
    throw new Error(`非嘟嘟真实项目视频包未机械闭合：${JSON.stringify(built.receipt)}`);
  }
  const countsAfterBuild = generationCounts(shell.paths.root);
  if (reviewMode === "reused-current-codex-review"
    && JSON.stringify(countsAfterBuild) !== JSON.stringify(countsBefore)) {
    throw new Error("复用 current Review 的 P8 非嘟嘟 canary 意外新增生图账本记录。");
  }
  if (reviewMode === "isolated-deterministic-core-canary"
    && (countsAfterBuild.dispatches !== countsBefore.dispatches + 1
      || countsAfterBuild.callIntents !== countsBefore.callIntents + 1
      || countsAfterBuild.results !== countsBefore.results + 2
      || countsAfterBuild.reviews !== countsBefore.reviews + 1)) {
    throw new Error("隔离确定性 canary 的 dispatch/call/result/review 账本计数不符合预期。");
  }

  process.env.AI_CANVAS_REGISTRY_PATH = registryPath;
  await mkdir(path.dirname(registryPath), { recursive: true });
  await registerProject(shell.project);
  await setActiveProjectRegistration(shell.paths.root);
  application = await electron.launch({
    executablePath,
    args: [`--user-data-dir=${userDataPath}`],
    cwd: workspace,
    env: {
      ...process.env,
      AI_CANVAS_PROJECT_ROOT: shell.paths.root,
      AI_CANVAS_REGISTRY_PATH: registryPath,
      AI_CANVAS_WINDOW_WIDTH: "1728",
      AI_CANVAS_WINDOW_HEIGHT: "1029",
      ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
    },
  });
  const page = await application.firstWindow();
  await page.setViewportSize({ width: 1728, height: 1029 });
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const externalRequests: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("request", (request) => {
    if (/^https?:/iu.test(request.url())) externalRequests.push(request.url());
  });
  await page.waitForSelector('[data-testid="material-studio-view"]', { timeout: 90_000 });
  await page.locator('[data-testid="studio-mode-multimedia-timeline"]').click();
  await page.waitForSelector('[data-testid="studio-multimedia-timeline-view"]', { timeout: 60_000 });
  const unitButton = page.locator(`[data-testid="multimedia-unit-list"] [data-unit-id="${unitId}"]`);
  await unitButton.waitFor({ state: "visible", timeout: 60_000 });
  await unitButton.click();
  await page.waitForFunction(() => {
    const view = document.querySelector('[data-testid="studio-multimedia-timeline-view"]');
    return view?.getAttribute("aria-busy") === "false";
  }, undefined, { timeout: 60_000 });
  const availabilityText = (await page.locator('[data-testid="multimedia-availability"]').innerText()).trim();
  for (const expected of ["剧本 可用", "图片 可用", "视频 可用", "音频 可用"]) {
    if (!availabilityText.includes(expected)) throw new Error(`桌面 UI 缺少四轨状态：${expected}`);
  }
  const videoPlayback = await playForProbe(page, "multimedia-video-player");
  const playbackSelect = page.locator('[data-testid="multimedia-playback-select"]');
  const audioOption = (await playbackSelect.locator("option").evaluateAll((options) =>
    options.map((option) => ({
      value: (option as HTMLOptionElement).value,
      label: option.textContent?.trim() ?? "",
    })))).find((option) => option.label.includes("对白"));
  if (!audioOption) throw new Error("桌面 UI 没有非嘟嘟对白轨播放选项。");
  await playbackSelect.selectOption(audioOption.value);
  const audioPlayback = await playForProbe(page, "multimedia-audio-player");
  if (!videoPlayback.advanced || videoPlayback.errorCode !== null
    || !audioPlayback.advanced || audioPlayback.errorCode !== null) {
    throw new Error("桌面 UI 的非嘟嘟视频/音频没有真实推进。");
  }
  const screenshot = await screenshotEvidence(page);
  if (pageErrors.length > 0 || consoleErrors.length > 0 || externalRequests.length > 0) {
    throw new Error(`桌面 UI 发现错误或外网请求：${JSON.stringify({
      pageErrors,
      consoleErrors,
      externalRequests,
    })}`);
  }
  await application.close();
  application = undefined;

  sourceSentinelsAfter = await assertRedlineProjectSentinelsUnchanged(
    sourceProjectRoot,
    sourceSentinelsBefore,
  );
  const evidence = {
    schemaVersion: 1,
    kind: "p8-non-dudu-real-project-canary",
    status: "PASS",
    createdAt: new Date().toISOString(),
    sourceProject: {
      projectId: shell.project.id,
      projectName: shell.project.name,
      sourceProjectRoot,
      isolatedCopy: true,
      sourceSentinelsBefore,
      sourceSentinelsAfter,
      sourceProjectMutated: false,
    },
    realOwners: {
      scriptRevisionId: snapshot.scriptRevision.id,
      scriptSha256: snapshot.scriptRevision.bodySha256,
      assets,
      unit: {
        id: snapshot.unit.id,
        revision: snapshot.unit.revision,
        title: snapshot.unit.title,
        panelCount: snapshot.panels.length,
        durationSeconds: snapshot.unit.durationSeconds,
        fingerprint: snapshot.fingerprint,
      },
      generation: {
        provider: "codex",
        reviewMode,
        sourceReview: {
          reviewId: sourceReview.reviewId,
          current: sourceReview.current,
          approvedRawEligible: sourceReview.approvedRawEligible,
          currentStaleReasons: sourceReview.currentStaleReasons,
        },
        reviewId: review.reviewId,
        reviewFingerprint: review.fingerprint,
        packId: review.packId,
        packFingerprint: pack.fingerprint,
        rawSha256: review.rawSha256,
        labeledSha256: review.labeledSha256,
        countsBefore,
        countsAfterBuild,
        providerInvocationCount: 0,
        deterministicLocalResultCount:
          reviewMode === "isolated-deterministic-core-canary" ? 1 : 0,
      },
    },
    fourTrack: {
      availability: timeline.availability,
      gaps: timeline.gaps,
      videoBinding: videoBinding.binding,
      audioBinding: audioBinding.binding,
      videoMedia: {
        sha256: video.sha256,
        mimeType: video.mimeType,
        sizeBytes: video.sizeBytes,
        derivatives: videoDerivatives.derivatives,
      },
      audioMedia: {
        sha256: audio.sha256,
        mimeType: audio.mimeType,
        sizeBytes: audio.sizeBytes,
        derivatives: audioDerivatives.derivatives,
      },
    },
    videoPackage: {
      adapterKind: "managed-evidence-v1",
      sourceFingerprint: managedSource.fingerprint,
      intentId: prepared.intent.intentId,
      receipt: built.receipt,
    },
    packagedDesktop: {
      executablePath,
      availabilityText,
      videoPlayback,
      audioPlayback,
      pageErrors,
      consoleErrors,
      externalRequests,
      screenshot,
    },
    externalUploadCount: 0,
    imageGenerationCount: 0,
    paidActionCount: 0,
    publishedCount: 0,
  };
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  const written = await readFile(evidencePath);
  console.log(JSON.stringify({
    status: "PASS",
    evidencePath,
    evidenceSha256: sha256(written),
    sourceProjectMutated: false,
    providerInvocationCount: 0,
    availability: timeline.availability,
    receiptId: built.receipt.receiptId,
    screenshot,
  }, null, 2));
} finally {
  if (application) await application.close().catch(() => undefined);
  if (previousRegistryPath === undefined) delete process.env.AI_CANVAS_REGISTRY_PATH;
  else process.env.AI_CANVAS_REGISTRY_PATH = previousRegistryPath;
  if (previousRuntimePath === undefined) delete process.env.AI_CANVAS_MEDIA_RUNTIME_DIR;
  else process.env.AI_CANVAS_MEDIA_RUNTIME_DIR = previousRuntimePath;
  await isolated.cleanup().catch(() => undefined);
  await assertRedlineProjectSentinelsUnchanged(sourceProjectRoot, sourceSentinelsBefore);
}
