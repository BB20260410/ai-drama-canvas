/**
 * Agent imagegen 真实 canary v2。
 *
 * 两阶段且失败关闭：
 * 1) prepare：冻结 pack → dispatch(provider) → 输出仅限 /tmp 的执行信封；
 * 2) Agent 严格调用一次 image_gen，并落盘绑定 pack/prompt/raw 的会话自证；
 * 3) 独立审片者落盘视觉 Review；
 * 4) finalize：校验全部绑定 → import/register raw+labeled → Review → dashboard 重读。
 *
 * 本脚本不把 Agent 自证冒充供应商密码学回执；证据会明确记录
 * cryptographicProviderReceipt=false。
 */
import { createHash } from "node:crypto";
import {
  access,
  copyFile,
  lstat,
  mkdir,
  readFile,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import sharp from "sharp";
import { createBuildIdentity } from "../src/core/build-identity.js";
import { importStudioMedia, verifyStudioMediaObject } from "../src/core/material-studio.js";
import { getStudioProductionDashboard } from "../src/core/studio-production-dashboard.js";
import {
  dispatchStudioGenerationPack,
  freezeAndPersistStudioGenerationPack,
  registerStudioGenerationResult,
} from "../src/core/studio-generation-ledger.js";
import { submitStudioGenerationReview, type StudioGenerationReviewDecision } from "../src/core/studio-generation-review.js";
import { buildStudioAgentImagegenBrief } from "../src/core/studio-generation.js";
import { createStudioP7Fixture, seedStudioP7ResolvedContinuity } from "../tests/helpers/studio-p7-fixture.js";
import {
  assertOwnedTemporaryFixtureRoot,
  mkdtempOwnedFixtureRoot,
  removeOwnedTemporaryFixtureRoot,
} from "./lib/owned-fixture-root.js";

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHA256 = /^[a-f0-9]{64}$/u;
const REQUIRED_CANARY_CRITERIA = ["forbidden-content", "image-quality", "prompt-contract", "prop-scene-consistency"];
const REQUIRED_PRODUCTION_CRITERIA = ["hard-lock", "identity-consistency", "prop-costume", "scene-continuity"];

type Provider = "codex" | "grok";

export interface RealImagegenCanaryEnvelope {
  schemaVersion: 2;
  kind: "real-imagegen-canary-envelope";
  createdAt: string;
  expiresAt: string;
  provider: Provider;
  executorKind: "agent-imagegen";
  generationRunId: string;
  runtime: {
    ownerRoot: string;
    ownerLeaseId: string;
    parentRoot: string;
    projectRoot: string;
  };
  pack: {
    packId: string;
    packFingerprint: string;
    unitId: string;
    panelId: string;
    continuityFingerprint: string;
    promptSha256: string;
    renderedPrompt: string;
    controlReferences: Array<{ assetId: string; mediaSha256: string; localPath: string }>;
  };
  fixtureMediaSha256: string[];
  buildIdentity: { sourceDigest: string; buildId: string };
  fingerprint: string;
}

export interface AgentImagegenSessionAttestation {
  schemaVersion: 1;
  kind: "agent-imagegen-session-attestation";
  attestationLevel: "agent-session-direct";
  provider: Provider;
  executorKind: "agent-imagegen";
  primaryTool: "image_gen";
  generationRunId: string;
  packFingerprint: string;
  promptSha256: string;
  rawSha256: string;
  directToolCall: true;
  formalImageGenerationCalls: 1;
  agentTaskName: string;
  createdAt: string;
  note: string;
}

export interface AgentImagegenVisualReview {
  schemaVersion: 1;
  kind: "agent-imagegen-visual-review";
  scope: "synthetic-canary-contract" | "production-continuity";
  rawSha256: string;
  packFingerprint: string;
  decision: StudioGenerationReviewDecision;
  reviewer: string;
  reviewedAt: string;
  note: string;
  criteria: Array<{ code: string; status: "pass" | "fail" | "not-applicable"; note: string }>;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([key, entry]) => [key, stable(entry)]));
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stable(value)), "utf8").digest("hex");
}

async function sha256File(filePath: string): Promise<string> {
  const { createReadStream } = await import("node:fs");
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

async function imageMetadata(filePath: string): Promise<{
  width: number;
  height: number;
  format: "png" | "jpeg" | "webp";
  sizeBytes: number;
  sha256: string;
}> {
  const info = await stat(filePath);
  if (!info.isFile() || info.size < 256) throw new Error(`图像过小或不是文件：${filePath}`);
  const metadata = await sharp(filePath).metadata();
  if (!metadata.width || !metadata.height || !metadata.format) throw new Error(`图像不可解码：${filePath}`);
  if (!(["png", "jpeg", "webp"] as const).includes(metadata.format as "png" | "jpeg" | "webp")) {
    throw new Error(`不支持的图片格式：${metadata.format}`);
  }
  if (metadata.width < 256 || metadata.height < 256) throw new Error(`拒绝疑似 fixture 小图：${metadata.width}x${metadata.height}`);
  return {
    width: metadata.width,
    height: metadata.height,
    format: metadata.format as "png" | "jpeg" | "webp",
    sizeBytes: info.size,
    sha256: await sha256File(filePath),
  };
}

function envelopeBody(envelope: RealImagegenCanaryEnvelope): Omit<RealImagegenCanaryEnvelope, "fingerprint"> {
  const { fingerprint: _fingerprint, ...body } = envelope;
  return body;
}

export async function assertEnvelope(envelope: RealImagegenCanaryEnvelope): Promise<void> {
  if (envelope.schemaVersion !== 2 || envelope.kind !== "real-imagegen-canary-envelope") throw new Error("canary envelope schema 无效");
  if (digest(envelopeBody(envelope)) !== envelope.fingerprint) throw new Error("canary envelope fingerprint 漂移");
  if (Date.parse(envelope.expiresAt) <= Date.now()) throw new Error("canary envelope 已过期，拒绝登记旧生成结果");
  if (!path.isAbsolute(envelope.runtime.ownerRoot)
    || !path.isAbsolute(envelope.runtime.parentRoot)
    || !path.isAbsolute(envelope.runtime.projectRoot)) throw new Error("canary runtime 路径必须为绝对路径。");
  // macOS 上 os.tmpdir()（/var/...）是 /private/var/... 的符号链接，而 fixture
  // helper 已 realpath；词法 path.relative 会把同一真实目录误判为逃逸。包含性
  // 检查必须双侧 realpath 后进行，与 assertEnvelopeRuntimeOwnership 一致。
  const [canonicalOwner, canonicalParent, canonicalProject] = await Promise.all([
    realpath(envelope.runtime.ownerRoot),
    realpath(envelope.runtime.parentRoot),
    realpath(envelope.runtime.projectRoot),
  ]).catch(() => {
    throw new Error("canary runtime 路径必须已存在且可解析。");
  });
  const parentRelative = path.relative(canonicalOwner, canonicalParent);
  const projectRelative = path.relative(canonicalParent, canonicalProject);
  if (!parentRelative || parentRelative === ".." || parentRelative.startsWith(`..${path.sep}`) || path.isAbsolute(parentRelative)) {
    throw new Error("canary parentRoot 必须严格位于 ownerRoot 内。");
  }
  if (!projectRelative || projectRelative === ".." || projectRelative.startsWith(`..${path.sep}`) || path.isAbsolute(projectRelative)) {
    throw new Error("canary projectRoot 必须严格位于 parentRoot 内。");
  }
  if (typeof envelope.runtime.ownerLeaseId !== "string" || !/^[a-f0-9-]{36}$/u.test(envelope.runtime.ownerLeaseId)) {
    throw new Error("canary runtime owner lease 无效。");
  }
}

async function assertEnvelopeRuntimeOwnership(envelope: RealImagegenCanaryEnvelope): Promise<void> {
  const owner = await assertOwnedTemporaryFixtureRoot(envelope.runtime.ownerRoot, "run-real-imagegen-canary-v2");
  if (owner.leaseId !== envelope.runtime.ownerLeaseId) throw new Error("canary runtime owner lease 已漂移。");
  const [canonicalOwner, canonicalParent, canonicalProject, parentMetadata, projectMetadata] = await Promise.all([
    realpath(envelope.runtime.ownerRoot),
    realpath(envelope.runtime.parentRoot),
    realpath(envelope.runtime.projectRoot),
    lstat(envelope.runtime.parentRoot),
    lstat(envelope.runtime.projectRoot),
  ]);
  const parentRelative = path.relative(canonicalOwner, canonicalParent);
  const projectRelative = path.relative(canonicalParent, canonicalProject);
  if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink()
    || !projectMetadata.isDirectory() || projectMetadata.isSymbolicLink()
    || !parentRelative || parentRelative === ".." || parentRelative.startsWith(`..${path.sep}`) || path.isAbsolute(parentRelative)
    || !projectRelative || projectRelative === ".." || projectRelative.startsWith(`..${path.sep}`) || path.isAbsolute(projectRelative)) {
    throw new Error("canary runtime 的真实 owner/parent/project 包含关系无效。");
  }
}

export function assertAttestation(
  attestation: AgentImagegenSessionAttestation,
  envelope: RealImagegenCanaryEnvelope,
  rawSha256: string,
): void {
  if (attestation.schemaVersion !== 1 || attestation.kind !== "agent-imagegen-session-attestation") throw new Error("agent attestation schema 无效");
  if (attestation.attestationLevel !== "agent-session-direct" || attestation.directToolCall !== true) throw new Error("缺少当前 Agent 会话直接工具调用自证");
  if (attestation.provider !== envelope.provider || attestation.executorKind !== "agent-imagegen" || attestation.primaryTool !== "image_gen") throw new Error("attestation provider/tool 与冻结合同不一致");
  if (attestation.generationRunId !== envelope.generationRunId) throw new Error("attestation generationRunId 漂移");
  if (attestation.packFingerprint !== envelope.pack.packFingerprint) throw new Error("attestation packFingerprint 漂移");
  if (attestation.promptSha256 !== envelope.pack.promptSha256) throw new Error("attestation promptSha256 漂移");
  if (attestation.rawSha256 !== rawSha256 || !SHA256.test(attestation.rawSha256)) throw new Error("attestation rawSha256 漂移");
  if (attestation.formalImageGenerationCalls !== 1) throw new Error("真实 canary 必须且只能调用一次生图工具");
  if (!attestation.agentTaskName.trim() || !attestation.note.trim() || !Number.isFinite(Date.parse(attestation.createdAt))) throw new Error("attestation 审计字段不完整");
}

export function assertVisualReview(
  review: AgentImagegenVisualReview,
  envelope: RealImagegenCanaryEnvelope,
  rawSha256: string,
): void {
  if (review.schemaVersion !== 1 || review.kind !== "agent-imagegen-visual-review") throw new Error("visual review schema 无效");
  if (review.rawSha256 !== rawSha256 || review.packFingerprint !== envelope.pack.packFingerprint) throw new Error("visual review 未绑定当前 raw/pack");
  if (!review.reviewer.trim() || !review.note.trim() || !Number.isFinite(Date.parse(review.reviewedAt))) throw new Error("visual review 审计字段不完整");
  if (!Array.isArray(review.criteria) || review.criteria.length < 1) throw new Error("visual review criteria 不能为空");
  const byCode = new Map(review.criteria.map((entry) => [entry.code, entry]));
  const required = review.scope === "production-continuity"
    ? [...REQUIRED_CANARY_CRITERIA, ...REQUIRED_PRODUCTION_CRITERIA]
    : REQUIRED_CANARY_CRITERIA;
  for (const code of required) {
    if (!byCode.has(code)) throw new Error(`visual review 缺少必需检查项：${code}`);
  }
  if (review.decision === "pass" && required.some((code) => byCode.get(code)?.status !== "pass")) {
    throw new Error("visual review=pass 时所有必需检查项必须 pass");
  }
  if (review.decision === "pass" && review.criteria.some((entry) => entry.status === "fail")) throw new Error("visual review=pass 不能包含 fail");
  if (review.decision !== "pass" && !review.criteria.some((entry) => entry.status === "fail")) throw new Error("rework/reject 必须至少包含一项 fail");
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

async function refuseOverwrite(filePath: string): Promise<void> {
  await access(filePath).then(
    () => { throw new Error(`拒绝覆盖已有证据：${filePath}`); },
    () => undefined,
  );
  await mkdir(path.dirname(filePath), { recursive: true });
}

export async function prepareRealImagegenCanary(input: {
  provider: Provider;
  envelopePath: string;
  ttlMinutes?: number;
}): Promise<RealImagegenCanaryEnvelope> {
  const envelopePath = path.resolve(input.envelopePath);
  const temporaryRoots = [...new Set(await Promise.all(["/tmp", os.tmpdir()].map((candidate) => realpath(candidate))))];
  const envelopeParent = await realpath(path.dirname(envelopePath));
  const inTemporaryRoot = temporaryRoots.some((temporaryRoot) => {
    const relative = path.relative(temporaryRoot, envelopeParent);
    return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  });
  if (!inTemporaryRoot) throw new Error("执行信封包含临时本地路径，只允许写入系统临时目录");
  await refuseOverwrite(envelopePath);
  const ownedRuntime = await mkdtempOwnedFixtureRoot("real-imagegen-canary-v2", "run-real-imagegen-canary-v2");
  let fixture: Awaited<ReturnType<typeof createStudioP7Fixture>> | undefined;
  try {
    fixture = await createStudioP7Fixture({ parentDirectory: ownedRuntime.root });
    await seedStudioP7ResolvedContinuity(fixture);
    const unit = fixture.units.twoPanel;
    const panel = unit.panels[0]!;
    const generationRunId = `real-${input.provider}-canary-v2-001`;
    const pack = await freezeAndPersistStudioGenerationPack(fixture.root, { unitId: unit.unit.id, panelId: panel.id });
    if (pack.pack.request.executorKind !== "agent-imagegen") throw new Error("冻结包 executorKind 非 agent-imagegen");
    const brief = buildStudioAgentImagegenBrief(pack.pack, input.provider);
    await dispatchStudioGenerationPack(fixture.root, {
      packId: pack.packId,
      packFingerprint: pack.fingerprint,
      generationRunId,
      provider: input.provider,
    });
    const identity = await createBuildIdentity(workspace);
    const createdAt = new Date();
    const body: Omit<RealImagegenCanaryEnvelope, "fingerprint"> = {
      schemaVersion: 2,
      kind: "real-imagegen-canary-envelope",
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + (input.ttlMinutes ?? 120) * 60_000).toISOString(),
      provider: input.provider,
      executorKind: "agent-imagegen",
      generationRunId,
      runtime: {
        ownerRoot: ownedRuntime.root,
        ownerLeaseId: ownedRuntime.leaseId,
        parentRoot: fixture.parentRoot,
        projectRoot: fixture.root,
      },
      pack: {
        packId: pack.packId,
        packFingerprint: pack.fingerprint,
        unitId: unit.unit.id,
        panelId: panel.id,
        continuityFingerprint: pack.pack.continuity.fingerprint,
        promptSha256: digest(brief.renderedPrompt),
        renderedPrompt: brief.renderedPrompt,
        controlReferences: pack.pack.request.controlReferences.map((reference) => ({
          assetId: reference.assetId,
          mediaSha256: reference.mediaSha256,
          localPath: reference.localPath,
        })),
      },
      fixtureMediaSha256: fixture.allMedia.map((entry) => entry.imported.sha256).sort(),
      buildIdentity: { sourceDigest: identity.sourceDigest, buildId: identity.buildId },
    };
    const envelope = { ...body, fingerprint: digest(body) };
    await writeFile(envelopePath, `${JSON.stringify(envelope, null, 2)}\n`, "utf8");
    return envelope;
  } catch (error) {
    await fixture?.cleanup().catch(() => undefined);
    await removeOwnedTemporaryFixtureRoot(ownedRuntime.root, "run-real-imagegen-canary-v2").catch(() => undefined);
    throw error;
  }
}

async function materializeLabeled(rawPath: string, labeledPath: string): Promise<void> {
  const image = sharp(rawPath).rotate();
  const metadata = await image.metadata();
  const width = metadata.width ?? 720;
  const height = metadata.height ?? 1280;
  const svg = Buffer.from(`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${width}" height="${Math.round(height * 0.075)}" fill="rgba(0,0,0,.62)"/>
    <text x="${Math.round(width * .04)}" y="${Math.round(height * .048)}" font-size="${Math.max(20, Math.round(width * .035))}" fill="#fff" font-family="PingFang SC,sans-serif">真实 Agent 生图 canary · 宫格 1</text>
    <rect y="${Math.round(height * .91)}" width="${width}" height="${Math.round(height * .09)}" fill="rgba(0,0,0,.62)"/>
    <text x="${Math.round(width * .04)}" y="${Math.round(height * .965)}" font-size="${Math.max(18, Math.round(width * .03))}" fill="#fff" font-family="PingFang SC,sans-serif">中文审片标注由本地排版生成</text>
  </svg>`);
  await sharp(rawPath).rotate().composite([{ input: svg, top: 0, left: 0 }]).png().toFile(labeledPath);
}

export async function finalizeRealImagegenCanary(input: {
  envelopePath: string;
  rawPath: string;
  attestationPath: string;
  visualReviewPath: string;
  evidencePath: string;
}): Promise<Record<string, unknown>> {
  const envelope = await readJson<RealImagegenCanaryEnvelope>(path.resolve(input.envelopePath));
  await assertEnvelope(envelope);
  await assertEnvelopeRuntimeOwnership(envelope);
  const identity = await createBuildIdentity(workspace);
  if (identity.sourceDigest !== envelope.buildIdentity.sourceDigest) throw new Error("prepare 后源码已漂移，必须重新冻结并 dispatch");
  const rawMeta = await imageMetadata(path.resolve(input.rawPath));
  if (envelope.fixtureMediaSha256.includes(rawMeta.sha256)) throw new Error("拒绝把 fixture 媒体登记为真实生图");
  const attestation = await readJson<AgentImagegenSessionAttestation>(path.resolve(input.attestationPath));
  const visualReview = await readJson<AgentImagegenVisualReview>(path.resolve(input.visualReviewPath));
  assertAttestation(attestation, envelope, rawMeta.sha256);
  assertVisualReview(visualReview, envelope, rawMeta.sha256);

  const evidencePath = path.resolve(input.evidencePath);
  const stem = path.basename(evidencePath, path.extname(evidencePath));
  const rawExtension = rawMeta.format === "jpeg" ? "jpg" : rawMeta.format;
  const retainedRaw = path.join(path.dirname(evidencePath), `${stem}-raw.${rawExtension}`);
  const retainedLabeled = path.join(path.dirname(evidencePath), `${stem}-labeled.png`);
  const retainedAttestation = path.join(path.dirname(evidencePath), `${stem}-attestation.json`);
  const retainedVisualReview = path.join(path.dirname(evidencePath), `${stem}-visual-review.json`);
  for (const output of [evidencePath, retainedRaw, retainedLabeled, retainedAttestation, retainedVisualReview]) await refuseOverwrite(output);

  const runtimeImages = path.join(envelope.runtime.parentRoot, "canary-v2-images");
  await mkdir(runtimeImages, { recursive: true });
  const runtimeRaw = path.join(runtimeImages, `raw.${rawExtension}`);
  const runtimeLabeled = path.join(runtimeImages, "labeled.png");
  await copyFile(input.rawPath, runtimeRaw);
  await materializeLabeled(runtimeRaw, runtimeLabeled);
  const labeledMeta = await imageMetadata(runtimeLabeled);
  if (labeledMeta.sha256 === rawMeta.sha256) throw new Error("labeled 未发生本地排版变化");

  let completed = false;
  try {
    const rawImported = await importStudioMedia(envelope.runtime.projectRoot, {
      sourcePath: runtimeRaw,
      kind: "image",
      expectedSha256: rawMeta.sha256,
    });
    const labeledImported = await importStudioMedia(envelope.runtime.projectRoot, {
      sourcePath: runtimeLabeled,
      kind: "image",
      expectedSha256: labeledMeta.sha256,
    });
    if (!await verifyStudioMediaObject(envelope.runtime.projectRoot, rawImported.sha256)
      || !await verifyStudioMediaObject(envelope.runtime.projectRoot, labeledImported.sha256)) {
      throw new Error("raw/labeled CAS 校验失败");
    }
    const raw = await registerStudioGenerationResult(envelope.runtime.projectRoot, {
      packId: envelope.pack.packId,
      packFingerprint: envelope.pack.packFingerprint,
      generationRunId: envelope.generationRunId,
      variant: "raw",
      mediaSha256: rawImported.sha256,
      provider: envelope.provider,
    });
    const labeled = await registerStudioGenerationResult(envelope.runtime.projectRoot, {
      packId: envelope.pack.packId,
      packFingerprint: envelope.pack.packFingerprint,
      generationRunId: envelope.generationRunId,
      variant: "labeled",
      mediaSha256: labeledImported.sha256,
      provider: envelope.provider,
    });
    const review = await submitStudioGenerationReview(envelope.runtime.projectRoot, {
      operationId: `real-canary-v2-review-${envelope.generationRunId}`,
      generationRunId: envelope.generationRunId,
      kind: "observation",
      expectedHeadRevision: 0,
      rawResultId: raw.resultId,
      rawSha256: raw.mediaSha256,
      labeledResultId: labeled.resultId,
      labeledSha256: labeled.mediaSha256,
      expectedPackFingerprint: envelope.pack.packFingerprint,
      continuityFingerprint: envelope.pack.continuityFingerprint,
      decision: visualReview.decision,
      criteria: [
        ...visualReview.criteria,
        { code: "raw-labeled-pair", status: "pass" as const, note: "raw 外部单图 + labeled 本地中文排版；SHA 不同且均可解码" },
      ],
      reviewer: visualReview.reviewer,
      note: visualReview.note,
    });
    const dashboard = await getStudioProductionDashboard(envelope.runtime.projectRoot, {
      operation: "unit",
      unitId: envelope.pack.unitId,
      panelId: envelope.pack.panelId,
    });
    if (dashboard.operation !== "unit" || !dashboard.selectedPanel) throw new Error("dashboard 未重读到 canary 宫格");

    await copyFile(runtimeRaw, retainedRaw);
    await copyFile(runtimeLabeled, retainedLabeled);
    await copyFile(input.attestationPath, retainedAttestation);
    await copyFile(input.visualReviewPath, retainedVisualReview);
    const body = {
      schemaVersion: 2,
      kind: "real-imagegen-canary",
      status: visualReview.decision === "pass" ? "pass" : visualReview.decision,
      createdAt: new Date().toISOString(),
      provider: envelope.provider,
      executorKind: "agent-imagegen",
      pack: {
        packId: envelope.pack.packId,
        packFingerprint: envelope.pack.packFingerprint,
        promptSha256: envelope.pack.promptSha256,
        unitId: envelope.pack.unitId,
        panelId: envelope.pack.panelId,
        generationRunId: envelope.generationRunId,
      },
      providerProvenance: {
        level: attestation.attestationLevel,
        directToolCall: true,
        primaryTool: attestation.primaryTool,
        formalImageGenerationCalls: 1,
        cryptographicProviderReceipt: false,
        note: "Agent 当前会话自证已绑定 pack/prompt/raw；工具未提供可落盘密码学供应商回执。",
      },
      visualReview: {
        scope: visualReview.scope,
        decision: visualReview.decision,
        reviewer: visualReview.reviewer,
        criteria: visualReview.criteria,
        productionContinuityPassed: visualReview.scope === "production-continuity" && visualReview.decision === "pass",
      },
      media: {
        raw: { sha256: raw.mediaSha256, width: rawMeta.width, height: rawMeta.height, format: rawMeta.format, sizeBytes: rawMeta.sizeBytes, retainedFile: path.basename(retainedRaw) },
        labeled: { sha256: labeled.mediaSha256, width: labeledMeta.width, height: labeledMeta.height, format: labeledMeta.format, sizeBytes: labeledMeta.sizeBytes, retainedFile: path.basename(retainedLabeled) },
      },
      review: { reviewId: review.reviewId, decision: review.decision, approvedRawEligible: review.approvedRawEligible },
      dashboard: {
        fingerprint: dashboard.fingerprint,
        selectedPanelGenerationStatus: dashboard.selectedPanel.generation.status,
        nextActionCode: dashboard.nextAction.code,
      },
      retainedEvidence: {
        attestation: path.basename(retainedAttestation),
        visualReview: path.basename(retainedVisualReview),
      },
      buildIdentity: { sourceDigest: identity.sourceDigest, buildId: identity.buildId },
      boundaries: {
        fixtureMediaUsedAsGenerated: false,
        formalProjectTouched: false,
        browserSupplierCalls: 0,
        gitStage: 0,
        rawSingleImage: true,
        labeledLocalLayout: true,
      },
    };
    await writeFile(evidencePath, `${JSON.stringify(body, null, 2)}\n`, "utf8");
    completed = true;
    return body;
  } finally {
    if (completed) {
      await removeOwnedTemporaryFixtureRoot(envelope.runtime.ownerRoot, "run-real-imagegen-canary-v2").catch(() => undefined);
    }
  }
}

function parseArgs(argv: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]!;
    if (!key.startsWith("--")) throw new Error(`未知位置参数：${key}`);
    if (key === "--help") return { help: "true" };
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${key} 需要值`);
    result[key.slice(2)] = value;
    index += 1;
  }
  return result;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || (!args.prepare && !args.finalize)) {
    console.log(`Prepare:\n  npx tsx scripts/run-real-imagegen-canary-v2.ts --prepare /tmp/canary-envelope.json --provider codex|grok\nFinalize:\n  npx tsx scripts/run-real-imagegen-canary-v2.ts --finalize /tmp/canary-envelope.json --raw /path/image.jpg --attestation /path/attestation.json --visual-review /path/review.json --evidence docs/evidence/real-imagegen-canary-...json`);
    return;
  }
  if (args.prepare) {
    const provider = args.provider;
    if (provider !== "codex" && provider !== "grok") throw new Error("--provider 必须是 codex|grok");
    const envelope = await prepareRealImagegenCanary({ provider, envelopePath: args.prepare });
    console.log(JSON.stringify({ ok: true, phase: "prepared", envelopePath: path.resolve(args.prepare), envelope }, null, 2));
    return;
  }
  for (const required of ["finalize", "raw", "attestation", "visual-review", "evidence"]) {
    if (!args[required]) throw new Error(`finalize 缺少 --${required}`);
  }
  const evidence = await finalizeRealImagegenCanary({
    envelopePath: args.finalize!,
    rawPath: args.raw!,
    attestationPath: args.attestation!,
    visualReviewPath: args["visual-review"]!,
    evidencePath: args.evidence!,
  });
  console.log(JSON.stringify({ ok: true, phase: "finalized", status: evidence.status, evidencePath: path.resolve(args.evidence!) }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
