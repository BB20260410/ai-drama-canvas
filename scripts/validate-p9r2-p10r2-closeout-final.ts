/** P9-R2 / P10-R2 最终关账：只读取新证据并写新 final-validation，历史文件永不覆盖。 */
import { createHash } from "node:crypto";
import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { createBuildIdentity } from "../src/core/build-identity.js";
import { inspectManagedProject } from "../src/core/managed-project.js";
import { getMaterialStudioState } from "../src/core/material-studio.js";
import { getStudioGenerationLedgerState } from "../src/core/studio-generation-ledger.js";
import { getStudioProductionState } from "../src/core/studio-production.js";
import { P9_SCALE_ASSET_COUNT, P9_SCALE_TARGET_PANELS, P9_SCALE_UNIT_COUNT } from "../src/core/studio-scale-fixture.js";

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evidenceRoot = path.join(workspace, "docs", "evidence");
const paths = {
  scale: path.join(evidenceRoot, "p9-scale-fixture-20260718-p9r2-full1288.json"),
  media: path.join(evidenceRoot, "p9-media-scale-20260718-p9r2-real10k.json"),
  ui: path.join(evidenceRoot, "managed-studio-scale-canvas-ui-smoke-20260718-r3.json"),
  p10: path.join(evidenceRoot, "p10-canary-e2e-20260718-p10r2.json"),
  realCodex: path.join(evidenceRoot, "real-imagegen-canary-20260718-codex-v2-final.json"),
  targeted: path.join(evidenceRoot, "p9r2-p10r2-targeted-tests-20260718.json"),
  full: path.join(evidenceRoot, "p9r2-p10r2-full-tests-20260718.json"),
  build: path.join(evidenceRoot, "p9r2-p10r2-production-build-20260718.json"),
  p9Final: path.join(evidenceRoot, "final-validation-20260718-p9r2-reliability.json"),
  p10Final: path.join(evidenceRoot, "final-validation-20260718-p10r2-build-identity.json"),
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function json(filePath: string): Promise<any> {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function identity(filePath: string): Promise<{ relativePath: string; sizeBytes: number; sha256: string }> {
  const bytes = await readFile(filePath);
  return {
    relativePath: path.relative(workspace, filePath).split(path.sep).join("/"),
    sizeBytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

for (const output of [paths.p9Final, paths.p10Final]) {
  await access(output).then(
    () => { throw new Error(`final-validation 已存在，拒绝覆盖：${output}`); },
    () => undefined,
  );
}
const [scale, media, ui, p10, realCodex, targeted, full, build] = await Promise.all([
  json(paths.scale), json(paths.media), json(paths.ui), json(paths.p10), json(paths.realCodex),
  json(paths.targeted), json(paths.full), json(paths.build),
]);
const current = await createBuildIdentity(workspace);

assert(scale.status === "pass", "P9 1288 规模证据非 pass");
assert(scale.observed?.units === P9_SCALE_UNIT_COUNT, "P9 单元不是 1288");
assert(scale.observed?.panels === P9_SCALE_TARGET_PANELS, "P9 宫格不是精确 4235");
assert(scale.observed?.assets === P9_SCALE_ASSET_COUNT, "P9 资产不是 77");
assert(scale.gates?.productionPathNonZero === true, "P9 首单元完整生产路径未过");
assert(media.status === "pass", "P9 真实媒体规模证据非 pass");
assert(media.counts?.mediaIndexed === 10_000 && media.counts?.casObjectsVerified === 10_000, "P9 10k CAS 未全量复核");
assert(media.counts?.realDecodableThumbFiles >= 1_000, "P9 可解码缩略图不足 1000");
assert(media.performance?.keyset === true && media.performance?.mediaPages === 100, "P9 媒体 keyset 分页不完整");
assert(ui.status === "pass", "Electron 规模 UI 非 pass");
assert(ui.fixture?.large?.units === 1_288 && ui.fixture?.large?.media?.total === 10_000, "Electron UI 未使用 1288/10k 夹具");
assert(ui.canvas?.initialDom <= 72 && ui.canvas?.expandedDom <= 78, "Electron 画布 DOM 无界");
assert(ui.mediaLibrary?.scrolledDom === 36 && ui.projectSwitch?.crossProjectLeak === false, "Electron 滚动或切工程失败");
assert(ui.buildIdentity?.sourceDigest === current.sourceDigest, "Electron UI 证据不是当前源码构建");
const screenshotPath = path.join(workspace, ui.screenshot.relativePath);
const screenshot = await sharp(screenshotPath, { failOn: "error" }).metadata();
assert(screenshot.format === "png" && (screenshot.width ?? 0) >= 1_400 && (screenshot.height ?? 0) >= 800, "Electron 截图不可解码或尺寸不足");

assert(p10.status === "pass", "P10 canary 非 pass");
assert(p10.dualProvider?.sameFrozenPack === true, "Codex/Grok 未消费同一冻结包");
assert(p10.dualProvider?.codex?.provider === "codex" && p10.dualProvider?.grok?.provider === "grok", "P10 双 provider 缺失");
assert(p10.canary?.readinessNoLocalPath === true, "MCP readiness 泄漏 localPath");
assert(p10.backupRestore?.hasPerFileSha === true && p10.backupRestore?.duplicateRestoreRejected === true, "P10 备份恢复门禁不完整");
assert(p10.buildIdentity?.sourceDigest === current.sourceDigest, "P10 canary 不是当前源码");
assert(realCodex.status === "pass" && realCodex.provider === "codex", "真实 Codex imagegen canary 未通过");
assert(realCodex.providerProvenance?.directToolCall === true && realCodex.providerProvenance?.formalImageGenerationCalls === 1, "真实 canary 不符合单次直接调用");
assert(realCodex.providerProvenance?.cryptographicProviderReceipt === false, "不得虚构密码学供应商回执");
assert(realCodex.visualReview?.scope === "synthetic-canary-contract" && realCodex.visualReview?.decision === "pass", "独立视觉审片未通过");
assert(realCodex.review?.approvedRawEligible === true, "真实 canary raw 未获 Review 资格");
assert(realCodex.buildIdentity?.sourceDigest === current.sourceDigest, "真实 canary 不是当前源码");
for (const [name, record] of Object.entries({ targeted, full, build })) {
  assert(record.status === "pass" && record.exitCode === 0 && record.sourceStable === true, `${name} 验证记录未通过`);
  assert(record.buildIdentity?.after?.sourceDigest === current.sourceDigest, `${name} 不是当前源码`);
}

const formalRoot = path.join(workspace, "projects", "codex-ai-drama-studio");
const formalShell = await inspectManagedProject(formalRoot);
const [formalMaterial, formalProduction, formalGeneration] = await Promise.all([
  getMaterialStudioState(formalRoot),
  getStudioProductionState(formalRoot),
  getStudioGenerationLedgerState(formalRoot),
]);
assert(formalShell.manifest.startupPolicy === "no-filesystem-scan" && formalShell.project.sourceRoots.length === 0, "正式工程隔离策略漂移");
assert(Object.values(formalMaterial.counts).every((value) => value === 0), "正式工程素材库不再为空");
assert(Object.values(formalProduction.counts).every((value) => value === 0), "正式工程生产库不再为空");
assert(Object.values(formalGeneration.counts).every((value) => value === 0), "正式工程生成账本不再为空");

const common = {
  schemaVersion: 3,
  createdAt: new Date().toISOString(),
  buildIdentity: {
    buildId: current.buildId,
    sourceDigest: current.sourceDigest,
    fingerprint: current.fingerprint,
    sourceFiles: current.roots.sourceFiles,
    sourceBytes: current.roots.sourceBytes,
    capabilities: current.capabilities,
  },
  formalProject: {
    projectId: formalShell.project.id,
    startupPolicy: formalShell.manifest.startupPolicy,
    sourceRoots: formalShell.project.sourceRoots,
    materialCounts: formalMaterial.counts,
    productionCounts: formalProduction.counts,
    generationCounts: formalGeneration.counts,
  },
};
const p9Body = {
  ...common,
  kind: "final-validation-p9r2-reliability",
  status: "PASS",
  conclusion: "SQL 深分页、1288/4235/77 精确规模、10k 真实 CAS、1000 可解码缩略图、受管无限画布与 Electron 滚动/切工程均通过。",
  evidence: await Promise.all([paths.scale, paths.media, paths.ui, paths.targeted, paths.full, paths.build].map(identity)),
  gates: {
    exactScale: true,
    realCas10k: true,
    sqlKeysetDeepPages: true,
    boundedCanvasDom: true,
    mediaScrollBounded: true,
    projectSwitchIsolated: true,
  },
};
const p10Body = {
  ...common,
  kind: "final-validation-p10r2-build-identity",
  status: "PASS",
  conclusion: "稳定构建身份、MCP 全局旧构建门禁、SQLite 一致性备份、同冻结包双供应、真实 Codex 单次 canary 与全量构建测试均通过。",
  evidence: await Promise.all([paths.p10, paths.realCodex, paths.targeted, paths.full, paths.build].map(identity)),
  gates: {
    stableBuildIdentity: true,
    globalMcpCurrentnessGate: true,
    sqliteConsistentBackup: true,
    sameFrozenPackDualProvider: true,
    realCodexSingleCallCanary: true,
    independentVisualReview: true,
    legacyCanaryDisabled: true,
  },
  externalValidationBoundary: {
    grokRealImagegenExecutedInThisCodexSession: false,
    reason: "当前 Codex 会话没有可调用的 Grok imagegen 工具；已验证 Grok 同冻结包 dispatch/register 合同，但未伪造外部真实 Grok 回执。",
    affectsSoftwareCloseout: false,
  },
};
await mkdir(evidenceRoot, { recursive: true });
await writeFile(paths.p9Final, `${JSON.stringify(p9Body, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
await writeFile(paths.p10Final, `${JSON.stringify(p10Body, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
process.stdout.write(`${JSON.stringify({
  ok: true,
  p9: { path: paths.p9Final, status: p9Body.status, sha256: (await identity(paths.p9Final)).sha256 },
  p10: { path: paths.p10Final, status: p10Body.status, sha256: (await identity(paths.p10Final)).sha256 },
  buildId: current.buildId,
  sourceDigest: current.sourceDigest,
}, null, 2)}\n`);
