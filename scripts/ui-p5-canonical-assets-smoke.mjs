import { createHash } from "node:crypto";
import { access, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fg from "fast-glob";
import { _electron as electron } from "playwright";
import sharp from "sharp";

const EXPECTED_PROJECT_ROOT = "/Users/hxx/Documents/无限画布/productions/gushujuan-s3-f1a688020bfb7af6";
const EXPECTED_SOURCE_ROOT = "/Users/hxx/Documents/古蜀卷第三季";
const UI_PAGE_SIZE = 24;
const IPC_PAGE_LIMIT = 100;

function parseCli(argv) {
  const values = new Map();
  const valueOptions = new Set(["--workspace", "--project-root", "--evidence", "--screenshot"]);
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--help" || key === "-h") continue;
    if (!valueOptions.has(key)) throw new Error(`P5 UI 烟测未知参数：${key}`);
    if (values.has(key)) throw new Error(`P5 UI 烟测参数重复：${key}`);
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`P5 UI 烟测参数缺少值：${key}`);
    values.set(key, value);
  }
  return values;
}

function usage() {
  return `P5 fresh-profile Electron 规范资产库烟测

用法：
  node scripts/ui-p5-canonical-assets-smoke.mjs [参数]

参数：
  --workspace <path>      工作区
  --project-root <path>   已完成 P5 迁移的正式工程
  --evidence <path>       紧凑机器证据 JSON
  --screenshot <path>     规范资产库 P01 详情截图
  --help                  显示帮助

脚本只读取正式工程；临时 registry 与全新 Electron profile 运行后删除。
`;
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  process.stdout.write(usage());
  process.exit(0);
}

const cli = parseCli(process.argv.slice(2));
const workspace = path.resolve(cli.get("--workspace") || path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
const projectRoot = path.resolve(cli.get("--project-root") || EXPECTED_PROJECT_ROOT);
const evidencePath = path.resolve(cli.get("--evidence") || path.join(workspace, "docs/evidence/p5-canonical-assets-ui-smoke-20260718-r2.json"));
const screenshotPath = path.resolve(cli.get("--screenshot") || path.join(workspace, "docs/evidence/p5-canonical-assets-ui-smoke-20260718-r2.png"));
const sidecarRoot = path.join(projectRoot, ".aicanvas");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function exists(filePath) {
  return access(filePath).then(() => true, () => false);
}

async function canonicalTarget(target) {
  const suffix = [];
  let cursor = path.resolve(target);
  while (!await exists(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) throw new Error(`无法解析路径：${target}`);
    suffix.unshift(path.basename(cursor));
    cursor = parent;
  }
  return path.join(await realpath(cursor), ...suffix);
}

function isWithin(target, root) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function normalizedText(value) {
  return String(value ?? "").replace(/\s+/gu, " ").trim();
}

const projectConfigPath = path.join(sidecarRoot, "project.json");
if (!await exists(projectConfigPath)) throw new Error(`正式工程缺少 project.json：${projectConfigPath}`);
const projectConfig = JSON.parse(await readFile(projectConfigPath, "utf8"));
assert(projectRoot === EXPECTED_PROJECT_ROOT || cli.has("--project-root"), `默认烟测必须打开正式工程：${EXPECTED_PROJECT_ROOT}`);

const outputs = [evidencePath, screenshotPath];
assert(new Set(outputs).size === outputs.length, "P5 UI evidence 与 screenshot 必须使用不同路径。 ");
const [canonicalOutputs, evidenceRoot, forbiddenRoots] = await Promise.all([
  Promise.all(outputs.map(canonicalTarget)),
  canonicalTarget(path.join(workspace, "docs/evidence")),
  Promise.all([
    canonicalTarget(projectRoot),
    canonicalTarget(path.join(workspace, "productions")),
    canonicalTarget(EXPECTED_SOURCE_ROOT),
    ...(projectConfig.sourceRoots ?? []).map((root) => canonicalTarget(root)),
  ]),
]);
for (let index = 0; index < outputs.length; index += 1) {
  assert(isWithin(canonicalOutputs[index], evidenceRoot), `P5 UI 永久输出只允许写入 workspace/docs/evidence：${outputs[index]}`);
  assert(!forbiddenRoots.some((root) => isWithin(canonicalOutputs[index], root)), `P5 UI 输出禁止落入正式工程或只读源：${outputs[index]}`);
  if (await exists(outputs[index])) throw new Error(`P5 UI 证据已存在，拒绝覆盖：${outputs[index]}`);
  await mkdir(path.dirname(outputs[index]), { recursive: true });
}

async function fileIdentity(filePath) {
  if (!await exists(filePath)) return { exists: false };
  const link = await lstat(filePath);
  if (link.isSymbolicLink() || !link.isFile()) throw new Error(`P5 UI 受保护路径不是普通文件：${filePath}`);
  const before = await stat(filePath);
  const content = await readFile(filePath);
  const after = await stat(filePath);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
    throw new Error(`P5 UI 计算 SHA 期间文件发生变化：${filePath}`);
  }
  return {
    exists: true,
    bytes: content.length,
    sha256: createHash("sha256").update(content).digest("hex"),
    mtimeMs: after.mtimeMs,
    ctimeMs: after.ctimeMs,
  };
}

const guardedFiles = {
  canonicalAssets: path.join(sidecarRoot, "canonical-assets.json"),
  project: projectConfigPath,
  index: path.join(sidecarRoot, "index.json"),
  productionAssets: path.join(sidecarRoot, "production-assets.json"),
  overrides: path.join(sidecarRoot, "overrides.json"),
  jobs: path.join(sidecarRoot, "generation-jobs.json"),
  publications: path.join(sidecarRoot, "publications.json"),
  reviews: path.join(sidecarRoot, "reviews.json"),
  panelReferences: path.join(sidecarRoot, "panel-reference-resolutions.json"),
  panelConstraints: path.join(sidecarRoot, "panel-visual-constraints.json"),
  sheetIndex: path.join(sidecarRoot, "storyboard-sheet-index.json"),
  commandLedger: path.join(sidecarRoot, "command-ledger.json"),
  events: path.join(sidecarRoot, "events.jsonl"),
};

async function guardedSnapshot() {
  return Object.fromEntries(await Promise.all(Object.entries(guardedFiles).map(async ([key, filePath]) => [key, await fileIdentity(filePath)])));
}

async function treeIdentity(root) {
  const canonicalRoot = await realpath(root);
  const relativeFiles = (await fg("**/*", {
    cwd: canonicalRoot,
    onlyFiles: true,
    dot: true,
    followSymbolicLinks: false,
    unique: true,
  })).map((entry) => entry.split(path.sep).join("/")).sort((left, right) => left.localeCompare(right, "en"));
  const rows = [];
  let totalBytes = 0;
  for (const relativePath of relativeFiles) {
    const identity = await fileIdentity(path.join(canonicalRoot, relativePath));
    assert(identity.exists, `P5 UI 树快照期间文件消失：${path.join(canonicalRoot, relativePath)}`);
    totalBytes += identity.bytes;
    rows.push({
      path: relativePath,
      bytes: identity.bytes,
      sha256: identity.sha256,
      mtimeMs: identity.mtimeMs,
      ctimeMs: identity.ctimeMs,
    });
  }
  return {
    root: canonicalRoot,
    fileCount: rows.length,
    totalBytes,
    digest: createHash("sha256").update(JSON.stringify(rows)).digest("hex"),
  };
}

async function profileFileCount(profileRoot) {
  if (!await exists(profileRoot)) return 0;
  return (await readdir(profileRoot, { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile()).length;
}

async function inspectScreenshotBuffer(buffer) {
  const [metadata, statistics] = await Promise.all([sharp(buffer).metadata(), sharp(buffer).stats()]);
  const standardDeviation = Math.max(...statistics.channels.map((channel) => channel.stdev));
  assert(buffer.length >= 50_000, `P5 UI 截图体积不足：${buffer.length}`);
  assert(metadata.format === "png" && (metadata.width ?? 0) >= 1_400 && (metadata.height ?? 0) >= 800, `P5 UI 截图尺寸或格式异常：${JSON.stringify(metadata)}`);
  assert(standardDeviation >= 5, `P5 UI 截图疑似空白或占位：stdev=${standardDeviation}`);
  return {
    bytes: buffer.length,
    sha256: createHash("sha256").update(buffer).digest("hex"),
    width: metadata.width,
    height: metadata.height,
    standardDeviation,
  };
}

async function installReadProbe(electronApplication) {
  const result = await electronApplication.evaluate(({ ipcMain }) => {
    const catalogChannel = "canvas:get-canonical-asset-catalog-state";
    const listChannel = "canvas:list-canonical-assets";
    const detailChannel = "canvas:get-canonical-asset";
    const handlers = ipcMain._invokeHandlers;
    const originalCatalog = handlers?.get(catalogChannel);
    const originalList = handlers?.get(listChannel);
    const originalDetail = handlers?.get(detailChannel);
    if (!(handlers instanceof Map)
      || typeof originalCatalog !== "function"
      || typeof originalList !== "function"
      || typeof originalDetail !== "function") {
      return { installed: false, installedBy: "", handlerCount: handlers?.size ?? -1 };
    }
    const probe = {
      installed: true,
      installedBy: "ipcMain-handler",
      catalogCalls: [],
      listCalls: [],
      detailCalls: [],
      startOrder: 0,
      finishOrder: 0,
      raceEnabled: false,
      raceRejectCharacter: false,
      forceStale: false,
    };
    const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
    const wrappedCatalog = async (event, root) => {
      const call = {
        id: probe.catalogCalls.length + 1,
        startOrder: ++probe.startOrder,
        finishOrder: 0,
        forceStale: probe.forceStale,
        ok: false,
      };
      probe.catalogCalls.push(call);
      try {
        const value = await originalCatalog(event, root);
        const result = probe.forceStale && value?.available
          ? { ...value, current: false, driftedInputs: ["p5-ui-smoke-injected-stale"] }
          : value;
        call.finishOrder = ++probe.finishOrder;
        call.ok = true;
        call.result = {
          available: result?.available,
          current: result?.current,
          driftedInputs: result?.driftedInputs,
        };
        return result;
      } catch (error) {
        call.finishOrder = ++probe.finishOrder;
        call.error = error instanceof Error ? error.message : String(error);
        throw error;
      }
    };
    const wrappedList = async (event, root, input) => {
      const call = {
        id: probe.listCalls.length + 1,
        category: input?.category ?? "any",
        authority: input?.authority ?? "any",
        search: input?.search ?? "",
        offset: input?.offset,
        limit: input?.limit,
        startOrder: ++probe.startOrder,
        finishOrder: 0,
        delayedMs: 0,
        rejectAfterDelay: false,
        ok: false,
      };
      probe.listCalls.push(call);
      try {
        const value = await originalList(event, root, input);
        if (probe.raceEnabled && !call.search && call.offset === 0 && call.category === "character") call.delayedMs = 900;
        if (probe.raceEnabled && !call.search && call.offset === 0 && call.category === "scene") call.delayedMs = 20;
        call.rejectAfterDelay = Boolean(probe.raceRejectCharacter && call.category === "character" && call.delayedMs);
        if (call.delayedMs) await delay(call.delayedMs);
        if (call.rejectAfterDelay) throw new Error("P5 injected stale list error");
        call.finishOrder = ++probe.finishOrder;
        call.ok = true;
        call.result = { total: value.total, offset: value.offset, limit: value.limit, count: value.items.length };
        return value;
      } catch (error) {
        call.finishOrder = ++probe.finishOrder;
        call.error = error instanceof Error ? error.message : String(error);
        throw error;
      }
    };
    const wrappedDetail = async (event, root, assetId) => {
      const call = { assetId, startOrder: ++probe.startOrder, finishOrder: 0, ok: false };
      probe.detailCalls.push(call);
      try {
        const value = await originalDetail(event, root, assetId);
        call.finishOrder = ++probe.finishOrder;
        call.ok = true;
        call.result = {
          assetId: value.asset.id,
          primaryAuthorityId: value.asset.primaryAuthorityId,
          currentSupportingAuthorityIds: [...(value.asset.currentSupportingAuthorityIds ?? [])],
          authorities: value.authorities.map((entry) => ({
            id: entry.id,
            role: entry.role,
            exposure: entry.exposure,
            usage: entry.scope?.usage,
            crossProject: entry.scope?.crossProject,
            assetVersionId: entry.assetVersionId,
            exposeToGeneration: entry.source?.exposeToGeneration,
          })),
          versions: value.versions.map((entry) => ({ id: entry.id, representation: entry.representation, mediaCount: entry.media.length })),
        };
        return value;
      } catch (error) {
        call.finishOrder = ++probe.finishOrder;
        call.error = error instanceof Error ? error.message : String(error);
        throw error;
      }
    };

    ipcMain.removeHandler(catalogChannel);
    ipcMain.removeHandler(listChannel);
    ipcMain.removeHandler(detailChannel);
    ipcMain.handle(catalogChannel, wrappedCatalog);
    ipcMain.handle(listChannel, wrappedList);
    ipcMain.handle(detailChannel, wrappedDetail);
    globalThis.__p5CanonicalAssetProbe = probe;
    return { installed: true, installedBy: probe.installedBy, handlerCount: handlers.size };
  });
  assert(result.installed, `无法安装 P5 只读 IPC 延迟探针：${JSON.stringify(result)}`);
  return result;
}

async function readMainProbe(electronApplication) {
  return electronApplication.evaluate(() => JSON.parse(JSON.stringify(globalThis.__p5CanonicalAssetProbe ?? null)));
}

async function waitForMainProbe(electronApplication, predicate, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let snapshot;
  while (Date.now() < deadline) {
    snapshot = await readMainProbe(electronApplication);
    if (snapshot && predicate(snapshot)) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`等待 P5 IPC 探针超时：${label}；${JSON.stringify(snapshot)}`);
}

async function setForcedCatalogStale(electronApplication, forceStale) {
  await electronApplication.evaluate((_, value) => {
    if (!globalThis.__p5CanonicalAssetProbe?.installed) throw new Error("P5 规范资产 IPC 探针未安装。");
    globalThis.__p5CanonicalAssetProbe.forceStale = value;
  }, forceStale);
}

async function probeContentAddressedAsset(electronApplication, imageLocator) {
  await imageLocator.waitFor();
  const correctUrl = await imageLocator.getAttribute("src");
  assert(correctUrl, "P5 缩略图缺少 aicanvas-asset URL。");
  const parsed = new URL(correctUrl);
  const mediaPath = parsed.searchParams.get("path");
  const expectedSha256 = parsed.searchParams.get("sha256");
  assert(parsed.protocol === "aicanvas-asset:" && mediaPath && expectedSha256 && /^[a-f0-9]{64}$/u.test(expectedSha256),
    `P5 缩略图没有使用内容寻址 URL：${correctUrl}`);
  const diskIdentity = await fileIdentity(mediaPath);
  assert(diskIdentity.exists && diskIdentity.sha256 === expectedSha256,
    `P5 缩略图 URL 的 SHA 与实际媒体不一致：${JSON.stringify({ mediaPath, expectedSha256, diskIdentity })}`);
  const wrongSha256 = `${expectedSha256[0] === "0" ? "1" : "0"}${expectedSha256.slice(1)}`;
  const wrongUrl = new URL(correctUrl);
  wrongUrl.searchParams.set("sha256", wrongSha256);
  const responses = await electronApplication.evaluate(async ({ net }, { correct, wrong }) => {
    const inspect = async (url) => {
      const response = await net.fetch(url, { cache: "no-store" });
      const bytes = new Uint8Array(await response.arrayBuffer());
      return {
        ok: response.ok,
        status: response.status,
        bytes: bytes.length,
        contentType: response.headers.get("content-type"),
        cacheControl: response.headers.get("cache-control"),
        bodyPreview: response.ok ? "" : new TextDecoder().decode(bytes.slice(0, 160)),
      };
    };
    return { correct: await inspect(correct), wrong: await inspect(wrong) };
  }, { correct: correctUrl, wrong: wrongUrl.toString() });
  assert(responses.correct.ok
    && responses.correct.status === 200
    && responses.correct.bytes === diskIdentity.bytes
    && /^image\//iu.test(responses.correct.contentType ?? "")
    && responses.correct.cacheControl === "no-store",
  `P5 内容寻址媒体正确 SHA 未返回 HTTP 200：${JSON.stringify(responses.correct)}`);
  assert(!responses.wrong.ok
    && responses.wrong.status === 409
    && /SHA-256 mismatch/iu.test(responses.wrong.bodyPreview),
  `P5 内容寻址媒体错误 SHA 未返回 HTTP 409：${JSON.stringify(responses.wrong)}`);
  return {
    mediaPath,
    expectedSha256,
    bytes: diskIdentity.bytes,
    correct: responses.correct,
    wrong: responses.wrong,
  };
}

async function runStaleCatalogGate(electronApplication, page) {
  const before = await readMainProbe(electronApplication);
  await setForcedCatalogStale(electronApplication, true);
  await page.locator(".library-header > button").click();
  await page.locator(".migration-empty h3", { hasText: "规范资产库输入已漂移" }).waitFor();
  await waitForMainProbe(electronApplication, (probe) => {
    const latest = probe.catalogCalls.at(-1);
    return probe.catalogCalls.length === before.catalogCalls.length + 1
      && latest?.finishOrder > 0
      && latest?.result?.available === true
      && latest?.result?.current === false;
  }, "注入 stale 目录状态已生效");
  await page.waitForTimeout(100);
  const during = await readMainProbe(electronApplication);
  const staleUi = await page.evaluate(() => ({
    cards: document.querySelectorAll(".canonical-card").length,
    images: document.querySelectorAll('[data-testid="canonical-asset-library"] img').length,
    details: document.querySelectorAll(".asset-detail").length,
    toolbar: document.querySelectorAll(".library-toolbar").length,
    heading: document.querySelector(".migration-empty h3")?.textContent?.trim(),
    blocker: document.querySelector(".migration-empty p")?.textContent?.replace(/\s+/gu, " ").trim(),
    drift: document.querySelector(".catalog-strip > p")?.textContent?.replace(/\s+/gu, " ").trim(),
    refreshDisabled: Boolean(document.querySelector(".library-header > button")?.disabled),
  }));
  assert(during.catalogCalls.length === before.catalogCalls.length + 1
    && during.catalogCalls.at(-1)?.result?.current === false
    && during.listCalls.length === before.listCalls.length
    && during.detailCalls.length === before.detailCalls.length,
  `P5 stale 目录仍触发了列表或详情读取：${JSON.stringify({
    before: { list: before.listCalls.length, detail: before.detailCalls.length },
    during: { list: during.listCalls.length, detail: during.detailCalls.length },
  })}`);
  assert(staleUi.cards === 0
    && staleUi.images === 0
    && staleUi.details === 0
    && staleUi.toolbar === 0
    && staleUi.heading === "规范资产库输入已漂移"
    && staleUi.blocker?.includes("旧列表、详情和缩略图已清空")
    && staleUi.drift?.includes("p5-ui-smoke-injected-stale")
    && !staleUi.refreshDisabled,
  `P5 stale 目录未失败关闭并清空资产 UI：${JSON.stringify(staleUi)}`);

  await setForcedCatalogStale(electronApplication, false);
  await page.locator(".library-header > button").click();
  await waitForUiResult(page, { total: 1, count: 1, activeCategory: "全部", firstId: "P01" });
  const restored = await waitForMainProbe(electronApplication, (probe) => {
    const latest = probe.catalogCalls.at(-1);
    return probe.catalogCalls.length === before.catalogCalls.length + 2
      && latest?.finishOrder > 0
      && latest?.result?.current === true
      && probe.listCalls.length === before.listCalls.length + 1;
  }, "stale 注入已撤销且当前列表已恢复");
  assert(restored.detailCalls.length === before.detailCalls.length,
    `P5 stale 恢复时不应隐式重读详情：${JSON.stringify({ before: before.detailCalls.length, restored: restored.detailCalls.length })}`);
  return {
    injectedDriftInput: "p5-ui-smoke-injected-stale",
    callsBefore: { catalog: before.catalogCalls.length, list: before.listCalls.length, detail: before.detailCalls.length },
    callsDuring: { catalog: during.catalogCalls.length, list: during.listCalls.length, detail: during.detailCalls.length },
    callsRestored: { catalog: restored.catalogCalls.length, list: restored.listCalls.length, detail: restored.detailCalls.length },
    staleUi,
    currentRestored: true,
  };
}

async function readUiPage(page) {
  return page.evaluate(() => ({
    ids: [...document.querySelectorAll(".canonical-card")].map((element) => element.getAttribute("data-asset-id")).filter(Boolean),
    categoryLabels: [...document.querySelectorAll(".canonical-card .card-copy > span")].map((element) => element.textContent?.trim()),
    range: document.querySelector(".pager > span")?.textContent?.trim(),
    totalLabel: document.querySelector(".library-toolbar > span")?.textContent?.trim(),
    activeCategory: document.querySelector(".category-tabs button.active")?.textContent?.trim(),
    loading: Boolean(document.querySelector(".library-header > button")?.disabled),
  }));
}

async function waitForUiResult(page, { total, count, activeCategory, firstId }) {
  await page.waitForFunction(({ total: expectedTotal, count: expectedCount, activeCategory: expectedCategory, firstId: expectedFirstId }) => {
    const ids = [...document.querySelectorAll(".canonical-card")].map((element) => element.getAttribute("data-asset-id")).filter(Boolean);
    const totalLabel = document.querySelector(".library-toolbar > span")?.textContent?.trim();
    const active = document.querySelector(".category-tabs button.active")?.textContent?.trim();
    const loading = Boolean(document.querySelector(".library-header > button")?.disabled);
    return totalLabel === `${expectedTotal} 项`
      && ids.length === expectedCount
      && (!expectedCategory || active === expectedCategory)
      && (!expectedFirstId || ids[0] === expectedFirstId)
      && !loading;
  }, { total, count, activeCategory, firstId });
}

async function runFilterRace(electronApplication, page, rejectCharacter) {
  await electronApplication.evaluate((_, reject) => {
    globalThis.__p5CanonicalAssetProbe.raceEnabled = true;
    globalThis.__p5CanonicalAssetProbe.raceRejectCharacter = reject;
  }, rejectCharacter);
  const startIndex = (await readMainProbe(electronApplication)).listCalls.length;
  await page.locator(".category-tabs").getByRole("button", { name: "角色", exact: true }).click();
  await waitForMainProbe(electronApplication, (probe) => probe.listCalls.slice(startIndex).some((call) => call.category === "character"), "角色筛选请求已开始");
  await page.locator(".category-tabs").getByRole("button", { name: "场景", exact: true }).click();
  await waitForUiResult(page, { total: 20, count: 20, activeCategory: "场景" });
  const probe = await waitForMainProbe(electronApplication, (snapshot) => {
    const calls = snapshot.listCalls.slice(startIndex).filter((call) => ["character", "scene"].includes(call.category));
    return calls.length >= 2 && calls.every((call) => call.finishOrder > 0);
  }, "角色旧请求与场景新请求均已完成");
  await page.waitForTimeout(80);
  const calls = probe.listCalls.slice(startIndex)
      .filter((call) => ["character", "scene"].includes(call.category))
      .map((call) => ({
        category: call.category,
        startOrder: call.startOrder,
        finishOrder: call.finishOrder,
        delayedMs: call.delayedMs,
        total: call.result?.total,
        error: call.error,
      }));
  const final = await page.evaluate(() => {
    const ids = [...document.querySelectorAll(".canonical-card")].map((element) => element.getAttribute("data-asset-id")).filter(Boolean);
    const labels = [...document.querySelectorAll(".canonical-card .card-copy > span")].map((element) => element.textContent?.trim());
    return {
      activeCategory: document.querySelector(".category-tabs button.active")?.textContent?.trim(),
      totalLabel: document.querySelector(".library-toolbar > span")?.textContent?.trim(),
      count: ids.length,
      allExplicitScene: labels.every((label) => label?.startsWith("场景 ·")),
      staleErrorVisible: Boolean(document.querySelector(".library-error")),
    };
  });
  const result = { calls, final };
  const characterCall = result.calls.find((entry) => entry.category === "character");
  const sceneCall = result.calls.find((entry) => entry.category === "scene");
  assert(characterCall && sceneCall
    && characterCall.startOrder < sceneCall.startOrder
    && sceneCall.finishOrder < characterCall.finishOrder
    && (rejectCharacter ? /injected stale list error/u.test(characterCall.error ?? "") : characterCall.total === 24)
    && sceneCall.total === 20
    && result.final.activeCategory === "场景"
    && result.final.totalLabel === "20 项"
    && result.final.count === 20
    && result.final.allExplicitScene
    && !result.final.staleErrorVisible,
  `P5 快速筛选被异步旧${rejectCharacter ? "异常" : "响应"}覆盖：${JSON.stringify(result)}`);
  await electronApplication.evaluate(() => {
    globalThis.__p5CanonicalAssetProbe.raceEnabled = false;
    globalThis.__p5CanonicalAssetProbe.raceRejectCharacter = false;
  });
  return result;
}

const protectedTreeRoots = [...new Set([
  projectRoot,
  EXPECTED_SOURCE_ROOT,
  ...(projectConfig.sourceRoots ?? []).map((root) => path.resolve(root)),
])];
const [before, protectedTreesBefore] = await Promise.all([
  guardedSnapshot(),
  Promise.all(protectedTreeRoots.map(treeIdentity)),
]);
assert(before.canonicalAssets.exists, `正式工程缺少规范资产 store：${guardedFiles.canonicalAssets}`);

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-p5-ui-"));
const registryPath = path.join(temporaryRoot, "registry.json");
const userDataPath = path.join(temporaryRoot, "fresh-profile");
const stagedScreenshotPath = path.join(temporaryRoot, "p5-canonical-assets.png");
await mkdir(userDataPath, { recursive: false });
const profileBeforeFiles = await profileFileCount(userDataPath);
assert(profileBeforeFiles === 0, "P5 UI fresh profile 启动前不是空目录。 ");
await writeFile(registryPath, `${JSON.stringify([{
  id: projectConfig.id,
  name: projectConfig.name,
  primaryRoot: projectRoot,
  updatedAt: projectConfig.updatedAt,
}], null, 2)}\n`, { encoding: "utf8", flag: "wx" });

const pageErrors = [];
const externalRequests = [];
const externalPages = [];
let electronApp;
let profileDuringFiles = 0;
let profileResolvedPath = "";
let profileCleaned = false;
let uiEvidence;
let screenshotBuffer;

try {
  electronApp = await electron.launch({
    args: [".", `--user-data-dir=${userDataPath}`],
    cwd: workspace,
    env: {
      ...process.env,
      AI_CANVAS_PROJECT_ROOT: projectRoot,
      AI_CANVAS_REGISTRY_PATH: registryPath,
      AI_CANVAS_WINDOW_WIDTH: "1820",
      AI_CANVAS_WINDOW_HEIGHT: "1160",
    },
  });
  profileResolvedPath = await electronApp.evaluate(({ app }) => app.getPath("userData"));
  assert(await canonicalTarget(profileResolvedPath) === await canonicalTarget(userDataPath), `Electron 未使用声明的 fresh profile：${profileResolvedPath}`);

  const observedPages = new WeakSet();
  const observePage = (candidate) => {
    if (observedPages.has(candidate)) return;
    observedPages.add(candidate);
    candidate.on("pageerror", (error) => pageErrors.push(error.message));
    candidate.on("request", (request) => {
      if (/^https?:/iu.test(request.url())) externalRequests.push(request.url());
    });
    candidate.on("framenavigated", (frame) => {
      if (frame === candidate.mainFrame() && /^https?:/iu.test(frame.url())) externalPages.push(frame.url());
    });
  };
  electronApp.on("window", observePage);
  const page = await electronApp.firstWindow();
  observePage(page);
  page.setDefaultTimeout(180_000);
  await page.waitForLoadState("domcontentloaded");
  assert(/^file:/u.test(page.url()), `P5 UI 没有打开本地 Electron 页面：${page.url()}`);

  const probeInstallation = await installReadProbe(electronApp);
  await page.getByRole("button", { name: "资产库", exact: true }).click();
  await page.locator('[data-testid="canonical-asset-library"]').waitFor();
  await waitForUiResult(page, { total: 77, count: UI_PAGE_SIZE, activeCategory: "全部", firstId: "C01" });

  const state = await page.evaluate((root) => window.canvasApi.getCanonicalAssetCatalogState(root), projectRoot);
  const openedProjectName = normalizedText(await page.locator(".brand-block p").textContent());
  assert(openedProjectName === projectConfig.name && state.projectId === projectConfig.id,
    `P5 Electron 未打开声明的正式工程：${JSON.stringify({ openedProjectName, expectedName: projectConfig.name, stateProjectId: state.projectId, expectedId: projectConfig.id })}`);
  assert(state.available && state.current && state.counts, `P5 正式规范资产库不可用或不 current：${JSON.stringify(state)}`);
  assert(state.counts.assets === 77
    && state.counts.byCategory.character === 24
    && state.counts.byCategory.scene === 20
    && state.counts.byCategory.prop === 33,
  `P5 正式规范资产计数异常：${JSON.stringify(state.counts)}`);

  const catalogMetrics = await page.locator(".catalog-strip > div").evaluateAll((elements) => Object.fromEntries(elements.map((element) => [
    element.querySelector("span")?.textContent?.trim(),
    element.querySelector("b")?.textContent?.trim(),
  ])));
  assert(catalogMetrics["全部资产"] === "77"
    && catalogMetrics["角色"] === "24"
    && catalogMetrics["场景"] === "20"
    && catalogMetrics["道具"] === "33"
    && catalogMetrics["已有版本"] === "20"
    && catalogMetrics["待生成"] === "57"
    && catalogMetrics["Store Revision"] === `r${state.storeRevision}`,
  `P5 UI 目录统计未与 Core 对齐：${JSON.stringify(catalogMetrics)}`);

  const paginationPages = [];
  const allIds = new Set();
  const nextButton = page.locator(".pager").getByRole("button", { name: "下一页", exact: false });
  for (;;) {
    const current = await readUiPage(page);
    current.ids.forEach((id) => allIds.add(id));
    paginationPages.push({ count: current.ids.length, range: current.range, first: current.ids[0], last: current.ids.at(-1) });
    if (await nextButton.isDisabled()) break;
    const previousFirst = current.ids[0];
    await nextButton.click();
    await page.waitForFunction((oldFirst) => {
      const first = document.querySelector(".canonical-card")?.getAttribute("data-asset-id");
      return first && first !== oldFirst && !document.querySelector(".library-header > button")?.disabled;
    }, previousFirst);
  }
  assert(JSON.stringify(paginationPages.map((entry) => entry.count)) === JSON.stringify([24, 24, 24, 5])
    && allIds.size === 77
    && paginationPages.every((entry) => entry.count <= UI_PAGE_SIZE),
  `P5 UI 分页没有无损覆盖 77 项：${JSON.stringify(paginationPages)}`);

  const ipcLimit = await page.evaluate(async ({ root, limit }) => {
    const accepted = await window.canvasApi.listCanonicalAssets(root, { offset: 0, limit, authority: "any", search: "" });
    let overLimitError = "";
    try {
      await window.canvasApi.listCanonicalAssets(root, { offset: 0, limit: limit + 1, authority: "any", search: "" });
    } catch (error) {
      overLimitError = error instanceof Error ? error.message : String(error);
    }
    return { accepted: { total: accepted.total, count: accepted.items.length, limit: accepted.limit }, overLimitError };
  }, { root: projectRoot, limit: IPC_PAGE_LIMIT });
  assert(ipcLimit.accepted.total === 77 && ipcLimit.accepted.count === 77 && ipcLimit.accepted.limit === IPC_PAGE_LIMIT
    && /limit.*1[–-]100|limit.*100/iu.test(ipcLimit.overLimitError),
  `P5 IPC 分页上限没有失败关闭：${JSON.stringify(ipcLimit)}`);

  const staleSuccessRace = await runFilterRace(electronApp, page, false);
  await page.locator(".category-tabs").getByRole("button", { name: "全部", exact: true }).click();
  await waitForUiResult(page, { total: 77, count: UI_PAGE_SIZE, activeCategory: "全部", firstId: "C01" });
  const staleErrorRace = await runFilterRace(electronApp, page, true);
  await page.locator(".category-tabs").getByRole("button", { name: "全部", exact: true }).click();
  await waitForUiResult(page, { total: 77, count: UI_PAGE_SIZE, activeCategory: "全部", firstId: "C01" });
  const searchInput = page.getByPlaceholder("按正式 ID、名称或确认别名搜索", { exact: true });
  await searchInput.fill("P01");
  await waitForUiResult(page, { total: 1, count: 1, activeCategory: "全部", firstId: "P01" });
  const detailProbeBefore = await readMainProbe(electronApp);
  const detailBefore = {
    calls: detailProbeBefore.detailCalls.length,
    placeholder: await page.locator(".asset-detail .detail-empty").textContent(),
  };
  assert(detailBefore.calls === 0 && detailBefore.placeholder?.includes("选择资产后才按需读取"), `P5 详情不是点击后懒加载：${JSON.stringify(detailBefore)}`);

  const p01Card = page.locator('.canonical-card[data-asset-id="P01"]');
  const p01CardText = normalizedText(await p01Card.textContent());
  assert(p01CardText.includes("主权威已冻结") && p01CardText.includes("含不可直接生成的辅助身份参考"), `P01 列表摘要没有区分主权威与隐藏辅助权威：${p01CardText}`);
  const assetProtocol = await probeContentAddressedAsset(electronApp, p01Card.locator("img"));
  await p01Card.click();
  await page.locator(".asset-detail > header").waitFor();
  const detailProbeAfter = await waitForMainProbe(electronApp,
    (probe) => probe.detailCalls.length === 1 && probe.detailCalls[0]?.finishOrder > 0,
    "P01 懒加载详情完成");
  const detailCall = detailProbeAfter.detailCalls[0];

  const p01Ui = await page.evaluate(() => {
    const detail = document.querySelector(".asset-detail");
    return {
      heading: detail?.querySelector("h3")?.textContent?.trim(),
      authorities: [...(detail?.querySelectorAll(".authority-entry") ?? [])].map((entry) => ({
        forbidden: entry.classList.contains("forbidden"),
        historical: entry.classList.contains("historical"),
        text: entry.textContent?.replace(/\s+/gu, " ").trim(),
      })),
      versions: [...(detail?.querySelectorAll(".version-entry") ?? [])].map((entry) => ({
        historical: entry.classList.contains("historical"),
        text: entry.textContent?.replace(/\s+/gu, " ").trim(),
      })),
      actionButtons: [...(detail?.querySelectorAll("button") ?? [])].map((entry) => entry.textContent?.replace(/\s+/gu, " ").trim()),
    };
  });
  const primaryAuthority = detailCall.result.authorities.find((entry) => entry.id === detailCall.result.primaryAuthorityId);
  const supportingAuthority = detailCall.result.authorities.find((entry) => entry.role === "supporting-identity");
  const currentAuthorityIds = new Set([
    detailCall.result.primaryAuthorityId,
    ...detailCall.result.currentSupportingAuthorityIds,
  ]);
  assert(primaryAuthority?.role === "production-hard-lock"
    && primaryAuthority.exposure === "allowed"
    && primaryAuthority.usage === "generation-reference"
    && primaryAuthority.crossProject === false,
  `P01 主权威没有冻结为项目内生产硬锁：${JSON.stringify(primaryAuthority)}`);
  assert(supportingAuthority
    && supportingAuthority.id !== primaryAuthority.id
    && supportingAuthority.exposure === "forbidden"
    && supportingAuthority.usage === "human-review-only"
    && supportingAuthority.crossProject === false
    && supportingAuthority.exposeToGeneration === false,
  `P01 隐藏 supporting authority 可能暴露给生成：${JSON.stringify(supportingAuthority)}`);
  assert(detailCall.result.currentSupportingAuthorityIds.length === 1
    && currentAuthorityIds.has(primaryAuthority.id)
    && currentAuthorityIds.has(supportingAuthority.id)
    && !detailCall.result.currentSupportingAuthorityIds.includes(primaryAuthority.id),
  `P01 当前主权威与 supporting head 没有显式分离：${JSON.stringify({
    primaryAuthorityId: detailCall.result.primaryAuthorityId,
    currentSupportingAuthorityIds: detailCall.result.currentSupportingAuthorityIds,
  })}`);
  assert(p01Ui.authorities.some((entry) => !entry.forbidden && !entry.historical && entry.text.includes("生产硬锁") && entry.text.includes("当前可用于生成"))
    && p01Ui.authorities.some((entry) => entry.forbidden && !entry.historical && entry.text.includes("辅助身份权威") && entry.text.includes("当前仅人工复核/禁止上传生成"))
    && p01Ui.authorities.filter((entry) => entry.historical).every((entry) => entry.text.includes("历史，不可用于生成"))
    && p01Ui.versions.some((entry) => !entry.historical && entry.text.includes("生产输出") && entry.text.includes("当前"))
    && p01Ui.versions.some((entry) => !entry.historical && entry.text.includes("辅助参考版本") && entry.text.includes("当前"))
    && p01Ui.versions.filter((entry) => entry.historical).every((entry) => entry.text.includes("历史，不可用于生成"))
    && p01Ui.actionButtons.every((entry) => !/(?:生成|上传)/u.test(entry)),
  `P01 权威审计 UI 未正确区分可生成主权威与禁用辅助权威：${JSON.stringify(p01Ui)}`);

  const staleGate = await runStaleCatalogGate(electronApp, page);
  const restoredP01Card = page.locator('.canonical-card[data-asset-id="P01"]');
  await restoredP01Card.click();
  await page.locator(".asset-detail > header").waitFor();
  const restoredProbe = await waitForMainProbe(electronApp,
    (probe) => probe.detailCalls.length === 2 && probe.detailCalls[1]?.finishOrder > 0,
    "stale 恢复后 P01 详情重新显式读取");
  assert(restoredProbe.detailCalls[1].result.assetId === "P01"
    && restoredProbe.detailCalls[1].result.primaryAuthorityId === detailCall.result.primaryAuthorityId
    && JSON.stringify(restoredProbe.detailCalls[1].result.currentSupportingAuthorityIds) === JSON.stringify(detailCall.result.currentSupportingAuthorityIds),
  `P5 stale 恢复后 P01 当前权威 head 发生变化：${JSON.stringify(restoredProbe.detailCalls[1].result)}`);

  const libraryError = page.locator(".library-error");
  const libraryErrorCount = await libraryError.count();
  if (libraryErrorCount) throw new Error(`P5 UI 出现错误提示：${normalizedText(await libraryError.first().textContent())}`);
  await page.screenshot({ path: stagedScreenshotPath, type: "png", animations: "disabled", fullPage: true });

  uiEvidence = {
    localPageUrl: page.url(),
    openedProject: { id: state.projectId, name: openedProjectName },
    probeInstallation,
    catalog: {
      storeRevision: state.storeRevision,
      storeFingerprint: state.storeFingerprint,
      counts: state.counts,
      uiMetrics: catalogMetrics,
    },
    pagination: {
      uiPageSize: UI_PAGE_SIZE,
      pages: paginationPages,
      uniqueAssetsVisited: allIds.size,
      ipcMaximum: IPC_PAGE_LIMIT,
      overLimitRejected: Boolean(ipcLimit.overLimitError),
    },
    race: { staleSuccess: staleSuccessRace, staleError: staleErrorRace },
    assetProtocol,
    staleCatalogGate: staleGate,
    search: { query: "P01", total: 1, resultId: "P01" },
    lazyDetail: { callsBeforeSelection: detailBefore.calls, callsAfterSelection: 1, callsAfterStaleRestoreSelection: 2 },
    p01: {
      heading: p01Ui.heading,
      currentSupportingAuthorityIds: detailCall.result.currentSupportingAuthorityIds,
      primary: primaryAuthority,
      hiddenSupporting: supportingAuthority,
      uiAuthorities: p01Ui.authorities,
      uiVersions: p01Ui.versions,
      versionRepresentations: detailCall.result.versions.map((entry) => entry.representation),
      generationOrUploadActions: p01Ui.actionButtons.filter((entry) => /(?:生成|上传)/u.test(entry)).length,
    },
  };
} finally {
  if (electronApp) {
    await electronApp.close().catch(() => undefined);
  }
  profileDuringFiles = await profileFileCount(userDataPath).catch(() => 0);
  if (await exists(stagedScreenshotPath)) screenshotBuffer = await readFile(stagedScreenshotPath);
  await rm(temporaryRoot, { recursive: true, force: true });
  profileCleaned = !await exists(temporaryRoot);
}

assert(profileDuringFiles > 0 && profileCleaned, `P5 fresh profile 未实际使用或未清理：${JSON.stringify({ profileDuringFiles, profileCleaned })}`);
const [after, protectedTreesAfter] = await Promise.all([
  guardedSnapshot(),
  Promise.all(protectedTreeRoots.map(treeIdentity)),
]);
assert(JSON.stringify(before) === JSON.stringify(after), "P5 UI 只读烟测改写了正式工程。 ");
assert(JSON.stringify(protectedTreesBefore) === JSON.stringify(protectedTreesAfter),
  `P5 UI 只读烟测改写了正式工程树或只读源树：${JSON.stringify({ protectedTreesBefore, protectedTreesAfter })}`);
assert(pageErrors.length === 0, `P5 UI 页面异常：${pageErrors.join("；")}`);
assert(externalRequests.length === 0 && externalPages.length === 0, `P5 UI 烟测访问了外部网页：${JSON.stringify({ externalRequests, externalPages })}`);
assert(screenshotBuffer, "P5 UI 没有生成可验收截图。 ");
const screenshotInspection = await inspectScreenshotBuffer(screenshotBuffer);
await writeFile(screenshotPath, screenshotBuffer, { flag: "wx" });
const screenshot = { path: screenshotPath, ...screenshotInspection };
const guardedHashes = Object.fromEntries(Object.entries(before).map(([key, value]) => [key, value.exists ? value.sha256 : null]));
const evidence = {
  schemaVersion: 2,
  kind: "p5-canonical-assets-fresh-profile-ui-smoke",
  createdAt: new Date().toISOString(),
  passed: true,
  transport: "electron-current-production-build-fresh-profile",
  workspace,
  projectRoot,
  freshProfile: {
    path: profileResolvedPath,
    filesBeforeLaunch: profileBeforeFiles,
    filesAfterClose: profileDuringFiles,
    cleaned: profileCleaned,
  },
  ...uiEvidence,
  screenshot,
  guarded: {
    unchanged: true,
    files: guardedHashes,
    protectedTreesUnchanged: true,
    protectedTrees: protectedTreesBefore,
  },
  externalWebpages: 0,
  pageErrors: 0,
  writes: { formalProject: false, migration: false, generation: false, upload: false, review: false },
  assertions: {
    formalProjectOpened: true,
    exactCounts77And24_20_33: true,
    uiPagination24AndAll77Visited: true,
    ipcPaginationMaximum100Enforced: true,
    searchP01Exact: true,
    detailLazyLoadedAfterSelection: true,
    primaryAuthorityAuditable: true,
    hiddenSupportingAuthorityAuditableButGenerationForbidden: true,
    currentPrimaryAndSupportingAuthorityHeadsExplicit: true,
    currentAndHistoricalAuthorityLabelsSeparated: true,
    contentAddressedThumbnailCorrectSha200AndMismatch409: true,
    staleCatalogClearsCardsImagesAndDetail: true,
    staleCatalogSkipsListAndDetailReads: true,
    currentCatalogRestoredAfterStaleInjection: true,
    staleAsyncFilterResponseDiscarded: true,
    freshProfileUsedAndRemoved: true,
    formalProjectUnchanged: true,
    formalProjectAndSourceTreesUnchanged: true,
  },
};
await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
process.stdout.write(`${JSON.stringify({
  passed: true,
  evidencePath,
  screenshotPath,
  catalog: { assets: 77, categories: [24, 20, 33] },
  pagination: { uiPageSize: UI_PAGE_SIZE, pages: uiEvidence.pagination.pages.map((entry) => entry.count), ipcMaximum: IPC_PAGE_LIMIT },
  search: uiEvidence.search,
  lazyDetail: uiEvidence.lazyDetail,
  authority: {
    primary: uiEvidence.p01.primary.role,
    supportingExposure: uiEvidence.p01.hiddenSupporting.exposure,
    currentSupportingAuthorityIds: uiEvidence.p01.currentSupportingAuthorityIds,
  },
  assetProtocol: { correctStatus: uiEvidence.assetProtocol.correct.status, wrongShaStatus: uiEvidence.assetProtocol.wrong.status },
  staleCatalogGate: {
    cards: uiEvidence.staleCatalogGate.staleUi.cards,
    images: uiEvidence.staleCatalogGate.staleUi.images,
    details: uiEvidence.staleCatalogGate.staleUi.details,
    currentRestored: uiEvidence.staleCatalogGate.currentRestored,
  },
  race: uiEvidence.race,
  freshProfile: true,
  guardedUnchanged: true,
  protectedTrees: protectedTreesBefore.map(({ root, fileCount, totalBytes, digest }) => ({ root, fileCount, totalBytes, digest })),
  pageErrors: 0,
  externalWebpages: 0,
}, null, 2)}\n`);
