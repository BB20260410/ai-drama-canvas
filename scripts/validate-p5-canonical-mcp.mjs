#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  opendir,
  readFile,
  readlink,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const EXPECTED_ASSET_COUNT = 77;
const EXPECTED_CATEGORY_COUNTS = Object.freeze({ character: 24, scene: 20, prop: 33 });
const REQUIRED_CANONICAL_TOOLS = Object.freeze([
  "get_canonical_asset_catalog_state",
  "list_canonical_assets",
  "get_canonical_asset",
]);
const LEGACY_TOOL = "list_fusion_production_assets";
const PANEL_REFERENCE_LIST_TOOL = "list_fusion_panel_reference_resolutions";
const MAX_RESPONSE_BYTES = 1_500_000;
const MAX_STRING_BYTES = 262_144;
const MAX_TOOL_CATALOG_BYTES = 2_500_000;
const GOLDEN_MASK_PATH_PATTERN = /(?:黄金面具|gold(?:en)?[-_ ]?mask)/iu;
const DEFAULT_WORKSPACE = "/Users/hxx/Documents/无限画布";
const releaseManifest = JSON.parse(await readFile(path.join(DEFAULT_WORKSPACE, "release-manifest.json"), "utf8"));
const EXPECTED_TOOL_COUNT = releaseManifest.mcpToolCount;
if (!Number.isInteger(EXPECTED_TOOL_COUNT) || EXPECTED_TOOL_COUNT <= 0) throw new Error("release manifest 缺少有效 mcpToolCount。");
const DEFAULT_PROJECT_RELATIVE = "productions/gushujuan-s3-f1a688020bfb7af6";
const DEFAULT_EVIDENCE_RELATIVE = "docs/evidence/p5-canonical-mcp-smoke-20260718-r3.json";

function usage() {
  return `P5 规范资产 source/compiled MCP 只读烟测

用法：
  node scripts/validate-p5-canonical-mcp.mjs [参数]

参数：
  --workspace <path>     工作区（默认 ${DEFAULT_WORKSPACE}）
  --project-root <path>  已迁移 P5 的正式隔离工程
  --evidence <path>      证据 JSON（必须直接位于 docs/evidence）
  --write-evidence       通过后以 wx 模式写入证据；默认只输出摘要
  --help                 显示帮助

本脚本只调用只读 MCP 工具，不调用迁移、生图、供应商或网页。
`;
}

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([key, entry]) => [key, stableValue(entry)]));
}

function semanticDigest(value) {
  return sha256(JSON.stringify(stableValue(value)));
}

function optionValue(argv, name) {
  const indexes = argv.flatMap((entry, index) => entry === name ? [index] : []);
  if (indexes.length > 1) fail(`${name} 参数重复。`);
  if (!indexes.length) return undefined;
  const value = argv[indexes[0] + 1];
  if (!value || value.startsWith("--")) fail(`${name} 缺少值。`);
  return value;
}

function parseOptions(argv) {
  const valued = new Set(["--workspace", "--project-root", "--evidence"]);
  for (let index = 0; index < argv.length; index += 1) {
    const entry = argv[index];
    if (["--write-evidence", "--help", "-h"].includes(entry)) continue;
    if (!valued.has(entry)) fail(`未知参数：${entry}`);
    index += 1;
    if (index >= argv.length || argv[index].startsWith("--")) fail(`${entry} 缺少值。`);
  }
  const workspace = path.resolve(optionValue(argv, "--workspace") ?? DEFAULT_WORKSPACE);
  return {
    workspace,
    projectRoot: path.resolve(optionValue(argv, "--project-root") ?? path.join(workspace, DEFAULT_PROJECT_RELATIVE)),
    evidencePath: path.resolve(optionValue(argv, "--evidence") ?? path.join(workspace, DEFAULT_EVIDENCE_RELATIVE)),
    writeEvidence: argv.includes("--write-evidence"),
  };
}

function isStrictlyInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return Boolean(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function exists(filePath) {
  return access(filePath).then(() => true, () => false);
}

async function assertSafeInputs(input) {
  const [workspace, projectRoot, evidenceRoot] = await Promise.all([
    realpath(input.workspace),
    realpath(input.projectRoot),
    realpath(path.join(input.workspace, "docs", "evidence")),
  ]);
  assert(isStrictlyInside(workspace, projectRoot), "P5 MCP 正式工程必须位于工作区内。");
  assert(isStrictlyInside(workspace, evidenceRoot), "P5 MCP 证据根越出工作区。");
  assert(path.dirname(input.evidencePath) === evidenceRoot, "P5 MCP 证据必须直接位于 docs/evidence。");
  assert(!isStrictlyInside(projectRoot, input.evidencePath), "P5 MCP 证据不得写入正式工程。");
  if (input.writeEvidence) assert(!await exists(input.evidencePath), `P5 MCP 证据已存在：${input.evidencePath}`);
  const requiredFiles = [
    path.join(workspace, "src", "mcp", "server.ts"),
    path.join(workspace, "dist-mcp", "mcp", "server.js"),
    path.join(projectRoot, ".aicanvas", "canonical-assets.json"),
  ];
  for (const filePath of requiredFiles) {
    const metadata = await lstat(filePath).catch(() => undefined);
    assert(metadata?.isFile() && !metadata.isSymbolicLink(), `P5 MCP 缺少普通文件：${filePath}`);
  }
  return { workspace, projectRoot, evidenceRoot };
}

function progress(message) {
  process.stderr.write(`[P5 canonical MCP] ${message}\n`);
}

async function hashFileStable(filePath) {
  const before = await stat(filePath, { bigint: true });
  assert(before.isFile(), `受保护路径不是普通文件：${filePath}`);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  const after = await stat(filePath, { bigint: true });
  for (const key of ["dev", "ino", "mode", "size", "mtimeNs", "ctimeNs"]) {
    assert(before[key] === after[key], `计算哈希期间文件发生变化：${filePath}`);
  }
  return {
    bytes: Number(after.size),
    sha256: hash.digest("hex"),
    identity: {
      dev: String(after.dev),
      ino: String(after.ino),
      mode: String(after.mode),
      mtimeNs: String(after.mtimeNs),
      ctimeNs: String(after.ctimeNs),
    },
  };
}

async function walkProject(root) {
  const entries = [];
  async function visit(relativeDirectory) {
    const absoluteDirectory = relativeDirectory ? path.join(root, relativeDirectory) : root;
    const directory = await opendir(absoluteDirectory);
    for await (const entry of directory) {
      const relativePath = relativeDirectory ? path.join(relativeDirectory, entry.name) : entry.name;
      const portablePath = relativePath.split(path.sep).join("/");
      const absolutePath = path.join(root, relativePath);
      if (entry.isDirectory()) {
        entries.push({ path: portablePath, kind: "directory", absolutePath });
        await visit(relativePath);
      } else if (entry.isFile()) {
        entries.push({ path: portablePath, kind: "file", absolutePath });
      } else if (entry.isSymbolicLink()) {
        entries.push({ path: portablePath, kind: "symlink", absolutePath });
      } else {
        fail(`正式工程包含不支持的文件类型：${absolutePath}`);
      }
    }
  }
  await visit("");
  return entries.sort((left, right) => left.path.localeCompare(right.path, "en"));
}

async function projectGuardSnapshot(projectRoot) {
  const rootMetadata = await lstat(projectRoot, { bigint: true });
  const entries = await walkProject(projectRoot);
  const rows = [];
  const fileEntries = entries.filter((entry) => entry.kind === "file");
  const fileResults = new Map();
  const concurrency = 6;
  for (let index = 0; index < fileEntries.length; index += concurrency) {
    const batch = fileEntries.slice(index, index + concurrency);
    const values = await Promise.all(batch.map(async (entry) => [entry.path, await hashFileStable(entry.absolutePath)]));
    for (const [relativePath, value] of values) fileResults.set(relativePath, value);
  }
  let totalBytes = 0;
  let files = 0;
  let directories = 1;
  let symlinks = 0;
  for (const entry of entries) {
    if (entry.kind === "file") {
      const value = fileResults.get(entry.path);
      assert(value, `项目哈希结果缺失：${entry.path}`);
      files += 1;
      totalBytes += value.bytes;
      rows.push({ path: entry.path, kind: "file", bytes: value.bytes, sha256: value.sha256, ...value.identity });
    } else if (entry.kind === "symlink") {
      symlinks += 1;
      const [target, metadata] = await Promise.all([readlink(entry.absolutePath), lstat(entry.absolutePath, { bigint: true })]);
      rows.push({
        path: entry.path,
        kind: "symlink",
        target,
        mode: String(metadata.mode),
        mtimeNs: String(metadata.mtimeNs),
        ctimeNs: String(metadata.ctimeNs),
      });
    } else {
      directories += 1;
      const metadata = await lstat(entry.absolutePath, { bigint: true });
      rows.push({
        path: entry.path,
        kind: "directory",
        mode: String(metadata.mode),
        mtimeNs: String(metadata.mtimeNs),
        ctimeNs: String(metadata.ctimeNs),
      });
    }
  }
  const semanticRows = rows.map((row) => row.kind === "file"
    ? { path: row.path, kind: row.kind, bytes: row.bytes, sha256: row.sha256 }
    : row.kind === "symlink"
      ? { path: row.path, kind: row.kind, target: row.target }
      : { path: row.path, kind: row.kind });
  const rootIdentity = {
    mode: String(rootMetadata.mode),
    mtimeNs: String(rootMetadata.mtimeNs),
    ctimeNs: String(rootMetadata.ctimeNs),
  };
  return {
    files,
    directories,
    symlinks,
    bytes: totalBytes,
    semanticSha256: semanticDigest(semanticRows),
    identitySha256: semanticDigest({ rootIdentity, rows }),
  };
}

async function canonicalStoreGuard(projectRoot) {
  const filePath = path.join(projectRoot, ".aicanvas", "canonical-assets.json");
  const identity = await hashFileStable(filePath);
  const store = JSON.parse(await readFile(filePath, "utf8"));
  assert(store?.kind === "canonical-asset-store" && store?.schemaVersion === 1, "正式 canonical-assets store 合同无效。");
  return {
    bytes: identity.bytes,
    rawSha256: identity.sha256,
    semanticSha256: semanticDigest(store),
    revision: store.revision,
    storeFingerprint: store.storeFingerprint,
    counts: {
      assets: store.assets?.length,
      aliases: store.aliases?.length,
      versions: store.versions?.length,
      authorities: store.authorities?.length,
      relations: store.relations?.length,
    },
  };
}

async function guardedProjectState(projectRoot) {
  const [tree, canonicalStore] = await Promise.all([
    projectGuardSnapshot(projectRoot),
    canonicalStoreGuard(projectRoot),
  ]);
  return { tree, canonicalStore };
}

function assertGuardUnchanged(before, after, label) {
  assert(semanticDigest(before) === semanticDigest(after), `${label} 改写了正式工程文件、语义或文件身份。`);
}

function safetyStatsFor(value) {
  const stats = { strings: 0, maxStringBytes: 0, binaryValues: 0, embeddedMediaFields: 0 };
  function visit(candidate, key = "root") {
    if (candidate === null || candidate === undefined) return;
    if (Buffer.isBuffer(candidate) || ArrayBuffer.isView(candidate) || candidate instanceof ArrayBuffer) {
      stats.binaryValues += 1;
      fail(`MCP 只读输出包含二进制值：${key}`);
    }
    if (typeof candidate === "string") {
      stats.strings += 1;
      const bytes = Buffer.byteLength(candidate);
      stats.maxStringBytes = Math.max(stats.maxStringBytes, bytes);
      assert(bytes <= MAX_STRING_BYTES, `MCP 只读输出包含巨型字符串：${key} (${bytes} bytes)`);
      assert(!/^data:[^;,]+;base64,/iu.test(candidate), `MCP 只读输出包含 base64 data URI：${key}`);
      assert(!/[A-Za-z0-9+/]{4096,}={0,2}/u.test(candidate), `MCP 只读输出包含疑似巨型 base64：${key}`);
      return;
    }
    if (Array.isArray(candidate)) {
      candidate.forEach((entry, index) => visit(entry, `${key}[${index}]`));
      return;
    }
    if (typeof candidate !== "object") return;
    for (const [childKey, childValue] of Object.entries(candidate)) {
      if (/^(?:base64|binary|dataUrl|imageData|mediaData|blob)$/iu.test(childKey)
        && childValue !== null && childValue !== undefined && childValue !== "") {
        stats.embeddedMediaFields += 1;
        fail(`MCP 只读输出包含内嵌媒体字段：${key}.${childKey}`);
      }
      visit(childValue, `${key}.${childKey}`);
    }
  }
  visit(value);
  return stats;
}

function createCallMetrics() {
  return {
    calls: [],
    totalBytes: 0,
    largestResponseBytes: 0,
    largestResponseCall: undefined,
    maxStringBytes: 0,
  };
}

async function callReadTool(client, metrics, callKey, name, args) {
  const result = await client.callTool({ name, arguments: args });
  const content = result?.content ?? [];
  const nonText = content.filter((entry) => entry.type !== "text");
  assert(nonText.length === 0, `${callKey} 返回了非文本 MCP content block。`);
  const textBlocks = content.filter((entry) => entry.type === "text" && typeof entry.text === "string");
  assert(textBlocks.length === 1, `${callKey} 必须精确返回一个 JSON 文本块。`);
  const text = textBlocks[0].text;
  const bytes = Buffer.byteLength(text);
  assert(bytes <= MAX_RESPONSE_BYTES, `${callKey} 响应过大：${bytes} bytes。`);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    fail(`${callKey} 返回非 JSON 文本：${error instanceof Error ? error.message : String(error)}`);
  }
  if (result.isError) fail(`${callKey} MCP 调用失败：${text.slice(0, 2_000)}`);
  const textSafety = safetyStatsFor(parsed);
  assert(result.structuredContent && typeof result.structuredContent === "object", `${callKey} 缺少 structuredContent。`);
  const structuredSafety = safetyStatsFor(result.structuredContent);
  assert(semanticDigest(parsed) === semanticDigest(result.structuredContent), `${callKey} 的文本 JSON 与 structuredContent 不一致。`);
  const parsedSha256 = semanticDigest(parsed);
  metrics.calls.push({ callKey, tool: name, bytes, parsedSha256 });
  metrics.totalBytes += bytes;
  if (bytes > metrics.largestResponseBytes) {
    metrics.largestResponseBytes = bytes;
    metrics.largestResponseCall = callKey;
  }
  metrics.maxStringBytes = Math.max(metrics.maxStringBytes, textSafety.maxStringBytes, structuredSafety.maxStringBytes);
  return parsed;
}

function requireReadToolSchema(tool, requiredFields) {
  assert(tool, `MCP 缺少工具：${requiredFields.join("/")}`);
  assert(tool.annotations?.readOnlyHint === true && tool.annotations?.openWorldHint === false, `${tool.name} 未声明封闭只读语义。`);
  const schema = tool.inputSchema ?? {};
  const required = new Set(schema.required ?? []);
  for (const field of requiredFields) assert(required.has(field), `${tool.name} schema 缺少必填 ${field}。`);
  return schema;
}

function collectPathFields(value) {
  const paths = [];
  function visit(candidate, key = "") {
    if (!candidate || typeof candidate !== "object") return;
    if (Array.isArray(candidate)) {
      candidate.forEach((entry) => visit(entry, key));
      return;
    }
    for (const [childKey, childValue] of Object.entries(candidate)) {
      if (typeof childValue === "string" && /path$/iu.test(childKey) && path.isAbsolute(childValue)) paths.push(childValue);
      else visit(childValue, childKey);
    }
  }
  visit(value);
  return [...new Set(paths.map((entry) => path.resolve(entry)))].sort((left, right) => left.localeCompare(right, "en"));
}

function pathDigests(paths) {
  return paths.map((entry) => sha256(path.resolve(entry))).sort();
}

function collectKeyedStrings(value, keyPattern) {
  const values = [];
  function visit(candidate) {
    if (!candidate || typeof candidate !== "object") return;
    if (Array.isArray(candidate)) {
      candidate.forEach(visit);
      return;
    }
    for (const [key, childValue] of Object.entries(candidate)) {
      if (typeof childValue === "string" && keyPattern.test(key)) values.push(childValue);
      else visit(childValue);
    }
  }
  visit(value);
  return [...new Set(values)].sort((left, right) => left.localeCompare(right, "en"));
}

function authorityLockRows(authorities) {
  return authorities.flatMap((authority) => [
    ...(authority.positiveLocks ?? []),
    ...(authority.negativeLocks ?? []),
  ]);
}

async function buildP01ProjectionAudit(projectRoot) {
  const storePath = path.join(projectRoot, ".aicanvas", "canonical-assets.json");
  const store = JSON.parse(await readFile(storePath, "utf8"));
  const asset = store.assets?.find((entry) => entry.id === "P01");
  assert(asset, "规范资产库缺少 P01。 ");
  assert(Array.isArray(asset.currentSupportingAuthorityIds), "P01 尚未物化显式 currentSupportingAuthorityIds；请先完成新版规范资产迁移。 ");

  const authorities = (store.authorities ?? []).filter((authority) => authority.assetId === "P01");
  const versions = (store.versions ?? []).filter((version) => version.assetId === "P01");
  const definitionVersions = (store.definitionVersions ?? []).filter((version) => version.assetId === "P01");
  const contractVersions = (store.contractVersions ?? []).filter((version) => version.assetId === "P01");
  const currentAuthorityIds = new Set([
    asset.primaryAuthorityId,
    ...asset.currentSupportingAuthorityIds,
  ].filter(Boolean));
  const allowedAuthorities = authorities.filter((authority) => currentAuthorityIds.has(authority.id)
    && authority.exposure === "allowed"
    && authority.scope?.usage === "generation-reference");
  const currentForbiddenAuthorities = authorities.filter((authority) => currentAuthorityIds.has(authority.id)
    && !allowedAuthorities.includes(authority));
  const historicalAuthorities = authorities.filter((authority) => !currentAuthorityIds.has(authority.id));
  const allowedVersionIds = new Set(allowedAuthorities.map((authority) => authority.assetVersionId));
  const currentVersionIds = new Set(authorities.filter((authority) => currentAuthorityIds.has(authority.id))
    .map((authority) => authority.assetVersionId));
  const currentForbiddenVersionIds = new Set(currentForbiddenAuthorities.map((authority) => authority.assetVersionId));
  const allowedVersions = versions.filter((version) => allowedVersionIds.has(version.id));
  const redactedVersions = versions.filter((version) => !allowedVersionIds.has(version.id));
  const allowedLockRows = authorityLockRows(allowedAuthorities);
  const allowedLockIds = new Set(allowedLockRows.map((rule) => rule.id));
  const redactedLockRows = [
    ...authorityLockRows([...currentForbiddenAuthorities, ...historicalAuthorities]),
    ...(asset.positiveLocks ?? []).filter((rule) => !allowedLockIds.has(rule.id)),
    ...(asset.negativeLocks ?? []).filter((rule) => !allowedLockIds.has(rule.id)),
  ];

  assert(allowedAuthorities.length === 1, `P01 当前允许生成权威应精确为 1，实际 ${allowedAuthorities.length}。`);
  assert(allowedAuthorities[0].id === asset.primaryAuthorityId, "P01 唯一允许生成权威不是 primaryAuthorityId。 ");
  assert(allowedVersions.length === 1, `P01 当前允许生成版本应精确为 1，实际 ${allowedVersions.length}。`);
  assert(currentForbiddenAuthorities.length === 1, `P01 当前禁止生成权威应精确为 1，实际 ${currentForbiddenAuthorities.length}。`);

  const redactedAuthorities = [...currentForbiddenAuthorities, ...historicalAuthorities];
  const redactedSourceSensitiveValues = collectKeyedStrings(
    redactedAuthorities.map((authority) => authority.source),
    /^(?:sourcePath|snapshotPath|sourceSha256|snapshotSha256|sha256)$/u,
  );
  const redactedMediaSensitiveValues = collectKeyedStrings(
    redactedVersions.map((version) => version.media),
    /^(?:path|relativePath|sha256)$/u,
  );
  const allowedSensitiveValues = new Set([
    ...collectKeyedStrings(allowedAuthorities.map((authority) => authority.source), /^(?:sourcePath|snapshotPath|sourceSha256|snapshotSha256|sha256)$/u),
    ...collectKeyedStrings(allowedVersions.map((version) => version.media), /^(?:path|relativePath|sha256)$/u),
  ]);
  const exclusiveRedactedSensitiveValues = [...new Set([
    ...redactedSourceSensitiveValues,
    ...redactedMediaSensitiveValues,
  ])].filter((value) => !allowedSensitiveValues.has(value));
  const redactedPaths = [...new Set([
    ...redactedAuthorities.flatMap((authority) => collectPathFields(authority.source)),
    ...redactedVersions.flatMap((version) => collectPathFields(version.media)),
  ])].sort((left, right) => left.localeCompare(right, "en"));
  const allowedProjectionPaths = [...new Set([
    ...allowedAuthorities.flatMap((authority) => collectPathFields(authority.source)),
    ...allowedVersions.flatMap((version) => collectPathFields(version.media)),
  ])].sort((left, right) => left.localeCompare(right, "en"));

  assert(exclusiveRedactedSensitiveValues.length > 0, "P01 缺少可用于证明脱敏的禁止/历史敏感值。 ");
  assert(redactedPaths.length > 0, "P01 缺少可用于证明脱敏的禁止/历史路径。 ");
  assert(redactedPaths.some((entry) => GOLDEN_MASK_PATH_PATTERN.test(entry)), "P01 禁止/历史路径未包含黄金面具人工复核参考。 ");

  return {
    primaryAuthorityId: asset.primaryAuthorityId,
    primaryVersionId: allowedVersions[0].id,
    currentSupportingAuthorityIds: [...asset.currentSupportingAuthorityIds].sort(),
    allowedAuthorityIds: allowedAuthorities.map((authority) => authority.id).sort(),
    allowedVersionIds: allowedVersions.map((version) => version.id).sort(),
    allowedLockIds: [...allowedLockIds].sort(),
    allowedLockInstructions: [...new Set(allowedLockRows.map((rule) => rule.instruction))].sort(),
    allowedProjectionPaths,
    redactedAuthorityIds: redactedAuthorities.map((authority) => authority.id).sort(),
    redactedVersionIds: redactedVersions.map((version) => version.id).sort(),
    redactedLockIds: [...new Set(redactedLockRows.map((rule) => rule.id))].sort(),
    redactedLockInstructions: [...new Set(redactedLockRows.map((rule) => rule.instruction))].sort(),
    exclusiveRedactedSensitiveValues,
    redactedPaths,
    expectedRedactions: {
      currentForbiddenAuthorityCount: currentForbiddenAuthorities.length,
      historicalAuthorityCount: historicalAuthorities.length,
      currentForbiddenVersionCount: versions.filter((version) => currentForbiddenVersionIds.has(version.id)).length,
      historicalVersionCount: versions.filter((version) => !currentVersionIds.has(version.id)).length,
      omittedVersionCount: redactedVersions.length,
      historicalDefinitionVersionCount: definitionVersions.filter((version) => version.id !== asset.currentDefinitionVersionId).length,
      historicalContractVersionCount: contractVersions.filter((version) => version.id !== asset.currentContractVersionId).length,
      omittedAssetLockCount: (asset.positiveLocks?.length ?? 0) + (asset.negativeLocks?.length ?? 0) - allowedLockIds.size,
    },
  };
}

function assertProjectionExcludesRedacted(projectionPaths, redactedPaths, label) {
  const redacted = new Set(redactedPaths.map((entry) => path.resolve(entry)));
  const normalized = [...new Set(projectionPaths.filter(Boolean).map((entry) => path.resolve(entry)))];
  assert(normalized.length > 0, `${label} 没有可核验的生成投影路径。`);
  const overlap = normalized.filter((entry) => redacted.has(entry));
  assert(overlap.length === 0, `${label} 泄漏 forbidden/historical 路径。`);
  const golden = normalized.filter((entry) => GOLDEN_MASK_PATH_PATTERN.test(entry));
  assert(golden.length === 0, `${label} 泄漏黄金面具路径。`);
  return normalized;
}

function assertPageIdentity(page, state, { total, offset, limit, category } = {}) {
  assert(page?.available === true, "list_canonical_assets 未返回 available=true。");
  assert(page.storeRevision === state.storeRevision && page.storeFingerprint === state.storeFingerprint, "list_canonical_assets 与 catalog state 身份不一致。");
  assert(/^[a-f0-9]{64}$/u.test(page.queryFingerprint), "list_canonical_assets 缺少有效 queryFingerprint。");
  if (total !== undefined) assert(page.total === total, `list_canonical_assets total 应为 ${total}，实际 ${page.total}。`);
  if (offset !== undefined) assert(page.offset === offset, `list_canonical_assets offset 应为 ${offset}。`);
  if (limit !== undefined) assert(page.limit === limit, `list_canonical_assets limit 应为 ${limit}。`);
  if (category !== undefined) assert(page.items.every((item) => item.category === category), `${category} 分类页混入其他显式类别。`);
  const ids = page.items.map((item) => item.id);
  assert(new Set(ids).size === ids.length, "list_canonical_assets 分页内出现重复 ID。");
  assert(ids.join("\n") === [...ids].sort((left, right) => left.localeCompare(right, "en")).join("\n"), "list_canonical_assets 未按稳定 ID 排序。");
}

async function runMode(mode, input) {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), `ai-canvas-p5-canonical-mcp-${mode}-`));
  const serverArgs = mode === "source"
    ? ["--import", "tsx", "src/mcp/server.ts"]
    : [path.join(input.workspace, "dist-mcp", "mcp", "server.js")];
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: serverArgs,
    cwd: input.workspace,
    env: {
      ...process.env,
      HOME: runtimeRoot,
      TMPDIR: runtimeRoot,
      AI_CANVAS_PROJECT_ROOT: input.projectRoot,
      AI_CANVAS_REGISTRY_PATH: path.join(runtimeRoot, "projects.json"),
      AI_CANVAS_MEDIA_RUNTIME_DIR: path.join(runtimeRoot, "media-runtime"),
    },
    stderr: "pipe",
  });
  let stderrBytes = 0;
  let stderrTailBuffer = "";
  transport.stderr?.on("data", (chunk) => {
    const text = String(chunk);
    stderrBytes += Buffer.byteLength(text);
    stderrTailBuffer = `${stderrTailBuffer}${text}`.slice(-65_536);
  });
  const client = new Client({ name: `ai-drama-canvas-p5-canonical-${mode}-smoke`, version: "1.0.0" });
  const metrics = createCallMetrics();
  try {
    await client.connect(transport);
    const discovered = await client.listTools();
    const toolCatalogBytes = Buffer.byteLength(JSON.stringify(discovered.tools));
    assert(toolCatalogBytes <= MAX_TOOL_CATALOG_BYTES, `${mode} MCP 工具目录过大：${toolCatalogBytes} bytes。`);
    assert(discovered.tools.length === EXPECTED_TOOL_COUNT, `${mode} MCP 工具数应为 ${EXPECTED_TOOL_COUNT}，实际 ${discovered.tools.length}。`);
    const names = discovered.tools.map((tool) => tool.name);
    assert(new Set(names).size === names.length, `${mode} MCP 存在重名工具。`);
    const byName = new Map(discovered.tools.map((tool) => [tool.name, tool]));
    for (const name of [...REQUIRED_CANONICAL_TOOLS, LEGACY_TOOL, PANEL_REFERENCE_LIST_TOOL]) {
      assert(byName.has(name), `${mode} MCP 缺少工具：${name}`);
    }
    const stateSchema = requireReadToolSchema(byName.get("get_canonical_asset_catalog_state"), ["projectRoot"]);
    const listSchema = requireReadToolSchema(byName.get("list_canonical_assets"), ["projectRoot"]);
    requireReadToolSchema(byName.get("get_canonical_asset"), ["projectRoot", "assetId"]);
    // 旧工具保留了历史默认根 schema；本烟测仍每次显式传入正式 projectRoot。
    requireReadToolSchema(byName.get(LEGACY_TOOL), []);
    requireReadToolSchema(byName.get(PANEL_REFERENCE_LIST_TOOL), []);
    assert(stateSchema.properties?.projectRoot, "catalog state schema 缺少 projectRoot 定义。");
    assert(JSON.stringify(listSchema.properties?.category?.enum) === JSON.stringify(["character", "scene", "prop"]), "canonical list category enum 不精确。");
    assert(JSON.stringify(listSchema.properties?.authority?.enum) === JSON.stringify(["any", "with-authority", "without-authority"]), "canonical list authority enum 不精确。");
    assert(listSchema.properties?.offset?.default === 0, "canonical list offset 默认值应为 0。");
    assert(listSchema.properties?.limit?.default === 30 && listSchema.properties?.limit?.maximum === 100, "canonical list limit schema 应为 default=30/max=100。");

    const state = await callReadTool(client, metrics, "catalog-state", "get_canonical_asset_catalog_state", { projectRoot: input.projectRoot });
    assert(state.available === true && state.current === true, `${mode} 规范资产库不是 available/current。`);
    assert(Array.isArray(state.driftedInputs) && state.driftedInputs.length === 0, `${mode} 规范资产库存在漂移输入。`);
    assert(Number.isInteger(state.storeRevision) && state.storeRevision >= 1, `${mode} 规范资产 store revision 无效。`);
    assert(/^[a-f0-9]{64}$/u.test(state.storeFingerprint), `${mode} 规范资产 store fingerprint 无效。`);
    assert(state.counts?.assets === EXPECTED_ASSET_COUNT, `${mode} 规范资产数应为 ${EXPECTED_ASSET_COUNT}。`);
    assert(semanticDigest(state.counts.byCategory) === semanticDigest(EXPECTED_CATEGORY_COUNTS), `${mode} 显式分类计数不是 24/20/33。`);

    const firstPage = await callReadTool(client, metrics, "canonical-page-0", "list_canonical_assets", {
      projectRoot: input.projectRoot, offset: 0, limit: 13,
    });
    const secondPage = await callReadTool(client, metrics, "canonical-page-13", "list_canonical_assets", {
      projectRoot: input.projectRoot, offset: 13, limit: 13,
    });
    const tailPage = await callReadTool(client, metrics, "canonical-page-70", "list_canonical_assets", {
      projectRoot: input.projectRoot, offset: 70, limit: 13,
    });
    assertPageIdentity(firstPage, state, { total: EXPECTED_ASSET_COUNT, offset: 0, limit: 13 });
    assertPageIdentity(secondPage, state, { total: EXPECTED_ASSET_COUNT, offset: 13, limit: 13 });
    assertPageIdentity(tailPage, state, { total: EXPECTED_ASSET_COUNT, offset: 70, limit: 13 });
    assert(firstPage.items.length === 13 && secondPage.items.length === 13 && tailPage.items.length === 7, `${mode} canonical list 分页长度不符合 13/13/7。`);
    const firstIds = new Set(firstPage.items.map((item) => item.id));
    assert(secondPage.items.every((item) => !firstIds.has(item.id)), `${mode} canonical list 相邻分页重叠。`);
    const firstTwoIds = [...firstPage.items, ...secondPage.items].map((item) => item.id);
    assert(firstTwoIds.join("\n") === [...firstTwoIds].sort((left, right) => left.localeCompare(right, "en")).join("\n"), `${mode} canonical list 跨页顺序不稳定。`);

    const categoryPages = {};
    for (const [category, expected] of Object.entries(EXPECTED_CATEGORY_COUNTS)) {
      const page = await callReadTool(client, metrics, `category-${category}`, "list_canonical_assets", {
        projectRoot: input.projectRoot, category, offset: 0, limit: 100,
      });
      assertPageIdentity(page, state, { total: expected, offset: 0, limit: 100, category });
      assert(page.items.length === expected, `${mode} ${category} 分类页未一页返回全部 ${expected} 项。`);
      categoryPages[category] = page;
    }
    const categorizedIds = Object.values(categoryPages).flatMap((page) => page.items.map((item) => item.id));
    assert(categorizedIds.length === EXPECTED_ASSET_COUNT && new Set(categorizedIds).size === EXPECTED_ASSET_COUNT, `${mode} 24/20/33 显式分类未无损覆盖 77 资产。`);

    const idSearch = await callReadTool(client, metrics, "search-P01", "list_canonical_assets", {
      projectRoot: input.projectRoot, search: "P01", offset: 0, limit: 30,
    });
    const nameSearch = await callReadTool(client, metrics, "search-布囊", "list_canonical_assets", {
      projectRoot: input.projectRoot, search: "布囊", offset: 0, limit: 30,
    });
    for (const page of [idSearch, nameSearch]) {
      assertPageIdentity(page, state, { total: 1, offset: 0, limit: 30 });
      assert(page.items.length === 1 && page.items[0].id === "P01", `${mode} P01 ID/名称搜索未精确返回 P01。`);
    }
    const aliasSearchCases = [
      { query: "半璧", expectedId: "P03" },
      { query: "旧铜鱼挂坠", expectedId: "P04" },
    ];
    const aliasSearches = {};
    for (const { query, expectedId } of aliasSearchCases) {
      const page = await callReadTool(client, metrics, `search-alias-${expectedId}`, "list_canonical_assets", {
        projectRoot: input.projectRoot, search: query, offset: 0, limit: 30,
      });
      assertPageIdentity(page, state, { total: 1, offset: 0, limit: 30 });
      assert(page.items.length === 1 && page.items[0].id === expectedId, `${mode} 显式别名 ${query} 未精确解析为 ${expectedId}。`);
      aliasSearches[query] = page.items.map((item) => item.id);
    }
    const p01Summary = idSearch.items[0];
    assert(p01Summary.hasAuthority === true && p01Summary.hasPrimaryAuthority === true && p01Summary.hasSupportingAuthority === true, `${mode} P01 列表摘要未显示 primary + supporting 权威。`);

    const detail = await callReadTool(client, metrics, "detail-P01", "get_canonical_asset", {
      projectRoot: input.projectRoot, assetId: "P01",
    });
    const projectionAudit = input.p01ProjectionAudit;
    assert(detail.asset?.id === "P01" && detail.asset.category === "prop", `${mode} P01 详情身份或显式类别错误。`);
    assert(detail.storeRevision === state.storeRevision && detail.storeFingerprint === state.storeFingerprint, `${mode} P01 详情与 catalog state 身份不一致。`);
    assert(detail.asset.primaryAuthorityId === projectionAudit.primaryAuthorityId, `${mode} P01 模型安全投影的 primaryAuthorityId 错误。`);
    assert(Array.isArray(detail.asset.currentSupportingAuthorityIds) && detail.asset.currentSupportingAuthorityIds.length === 0, `${mode} P01 模型安全投影不得暴露 forbidden supporting authority。`);
    assert(detail.authorities.length === 1, `${mode} P01 模型安全投影应精确返回一个当前 allowed 权威。`);
    assert(detail.versions.length === 1, `${mode} P01 模型安全投影应精确返回一个当前 allowed 版本。`);
    const primary = detail.authorities[0];
    assert(primary, `${mode} P01 缺少 asset.primaryAuthorityId 指向的权威。`);
    assert(primary.id === projectionAudit.primaryAuthorityId, `${mode} P01 返回了非当前 primary 权威。`);
    assert(["primary-identity", "production-hard-lock"].includes(primary.role), `${mode} P01 主权威 role 不允许用于生成。`);
    assert(primary.exposure === "allowed" && primary.scope?.usage === "generation-reference", `${mode} P01 主权威未显式允许 generation-reference。`);
    const primaryVersion = detail.versions.find((version) => version.id === primary.assetVersionId);
    assert(primaryVersion?.id === projectionAudit.primaryVersionId && primaryVersion.representation !== "supporting-reference", `${mode} P01 主权威未唯一绑定当前生产版本。`);
    assert(detail.definitionVersions.length === 1 && detail.definitionVersions[0].id === detail.asset.currentDefinitionVersionId, `${mode} P01 仅可返回当前 definition version。`);
    assert(detail.contractVersions.length === 1 && detail.contractVersions[0].id === detail.asset.currentContractVersionId, `${mode} P01 仅可返回当前 contract version。`);

    const expectedPolicy = {
      authorityOverridesDefinition: true,
      currentAuthorityOnly: true,
      forbiddenAndHistoricalOmitted: true,
      mediaMayBeUsedOnlyWhenReturnedByThisProjection: true,
    };
    assert(semanticDigest(detail.generationPolicy) === semanticDigest(expectedPolicy), `${mode} P01 generationPolicy 安全字段不完整或不精确。`);
    for (const [key, expected] of Object.entries(projectionAudit.expectedRedactions)) {
      assert(detail.redactions?.[key] === expected, `${mode} P01 redactions.${key} 应为 ${expected}，实际 ${detail.redactions?.[key]}。`);
    }
    assert(detail.redactions.currentForbiddenAuthorityCount === 1, `${mode} P01 必须报告一个当前 forbidden supporting 权威。`);
    assert(typeof detail.redactions.policy === "string" && detail.redactions.policy.includes("均不返回"), `${mode} P01 redactions 缺少明确模型安全策略。`);

    const returnedAuthorityLocks = authorityLockRows(detail.authorities);
    const returnedAssetLocks = [...(detail.asset.positiveLocks ?? []), ...(detail.asset.negativeLocks ?? [])];
    const expectedAllowedLockIds = projectionAudit.allowedLockIds;
    for (const [label, rows] of [["权威", returnedAuthorityLocks], ["资产", returnedAssetLocks]]) {
      const ids = rows.map((rule) => rule.id).sort();
      assert(semanticDigest(ids) === semanticDigest(expectedAllowedLockIds), `${mode} P01 ${label}锁未精确限制为当前 allowed 权威锁。`);
      assert(rows.every((rule) => projectionAudit.allowedLockInstructions.includes(rule.instruction)), `${mode} P01 ${label}锁混入 forbidden/historical instruction。`);
      assert(rows.every((rule) => !projectionAudit.redactedLockIds.includes(rule.id)), `${mode} P01 ${label}锁泄漏 forbidden/historical lock ID。`);
      assert(rows.every((rule) => !projectionAudit.redactedLockInstructions.includes(rule.instruction)), `${mode} P01 ${label}锁泄漏 forbidden/historical lock instruction。`);
    }

    const detailSerialized = JSON.stringify(detail);
    for (const authorityId of projectionAudit.redactedAuthorityIds) {
      assert(!detailSerialized.includes(authorityId), `${mode} P01 响应泄漏 forbidden/historical authority ID。`);
    }
    for (const versionId of projectionAudit.redactedVersionIds) {
      assert(!detailSerialized.includes(versionId), `${mode} P01 响应泄漏 forbidden/historical version ID。`);
    }
    for (const sensitiveValue of projectionAudit.exclusiveRedactedSensitiveValues) {
      assert(!detailSerialized.includes(sensitiveValue), `${mode} P01 响应泄漏 forbidden/historical sourcePath、snapshotPath、SHA 或媒体路径。`);
    }
    const redactedPaths = projectionAudit.redactedPaths;
    const primaryProjectionPaths = assertProjectionExcludesRedacted([
      ...collectPathFields(primary.source),
      ...collectPathFields(primaryVersion.media),
    ], redactedPaths, `${mode} P01 规范主权威投影`);
    assert(semanticDigest(pathDigests(primaryProjectionPaths)) === semanticDigest(pathDigests(projectionAudit.allowedProjectionPaths)), `${mode} P01 当前主权威路径与 store 允许投影不一致。`);
    assert(p01Summary.primaryAuthorityId === primary.id && p01Summary.primaryVersionId === primaryVersion.id, `${mode} P01 列表的主权威/版本与详情不一致。`);
    assert(primaryProjectionPaths.includes(path.resolve(p01Summary.thumbnail.path)), `${mode} P01 列表缩略图未使用主权威版本。`);

    const legacy = await callReadTool(client, metrics, "legacy-P01", LEGACY_TOOL, {
      projectRoot: input.projectRoot, assetId: "P01", offset: 0, limit: 30,
    });
    assert(legacy.available === true && legacy.deprecated === true && legacy.compatibilitySource === "canonical-assets", `${mode} legacy asset list 未标记 deprecated=true/compatibilitySource=canonical-assets。`);
    assert(legacy.total === 1 && legacy.items?.length === 1 && legacy.items[0].assetId === "P01", `${mode} legacy P01 兼容投影身份错误。`);
    assert(legacy.items[0].primaryAuthorityId === primary.id && legacy.items[0].primaryVersionId === primaryVersion.id, `${mode} legacy P01 兼容投影未指向规范主权威。`);
    for (const forbiddenField of ["authority", "definition", "contract", "paths"]) {
      assert(!Object.prototype.hasOwnProperty.call(legacy.items[0], forbiddenField), `${mode} legacy 兼容投影泄漏旧详情字段 ${forbiddenField}。`);
    }
    const legacySerialized = JSON.stringify(legacy);
    assert(!GOLDEN_MASK_PATH_PATTERN.test(legacySerialized), `${mode} legacy 生成兼容投影泄漏黄金面具路径。`);
    for (const redactedPath of redactedPaths) assert(!legacySerialized.includes(redactedPath), `${mode} legacy 投影泄漏 forbidden/historical 路径。`);

    let panelOffset = 0;
    let panelTotal;
    let panelPages = 0;
    let p01PanelOccurrences = 0;
    const downstreamProjectionPaths = [];
    const downstreamReferenceVersions = new Set();
    while (panelTotal === undefined || panelOffset < panelTotal) {
      assert(panelPages < 10, `${mode} EP01 逐格引用分页超过安全上限。`);
      const page = await callReadTool(client, metrics, `panel-reference-ep01-${panelOffset}`, PANEL_REFERENCE_LIST_TOOL, {
        projectRoot: input.projectRoot,
        episode: 1,
        offset: panelOffset,
        limit: 50,
      });
      if (panelTotal === undefined) panelTotal = page.total;
      assert(page.total === panelTotal && page.offset === panelOffset && page.limit === 50, `${mode} EP01 逐格引用分页身份漂移。`);
      assert(Array.isArray(page.items) && page.items.length > 0, `${mode} EP01 逐格引用分页提前为空。`);
      for (const resolution of page.items) {
        const p01Assets = resolution.semanticAssets?.filter((asset) => asset.assetId === "P01") ?? [];
        for (const asset of p01Assets) {
          p01PanelOccurrences += 1;
          assert(asset.hardLock?.path && asset.hardLock?.referenceVersion, `${mode} P01 逐格生成投影缺少 hardLock 路径/版本。`);
          downstreamProjectionPaths.push(asset.hardLock.path);
          downstreamReferenceVersions.add(asset.hardLock.referenceVersion);
        }
        for (const slot of resolution.referenceSlots ?? []) {
          if (slot.coveredAssetIds?.includes("P01") && slot.path) downstreamProjectionPaths.push(slot.path);
        }
      }
      panelOffset += page.items.length;
      panelPages += 1;
    }
    assert(Number.isInteger(panelTotal) && panelTotal > 0 && panelOffset === panelTotal, `${mode} EP01 逐格引用未完整分页。`);
    assert(p01PanelOccurrences > 0, `${mode} EP01 逐格引用未找到 P01 生成投影。`);
    assert(downstreamReferenceVersions.size === 1 && downstreamReferenceVersions.has(primaryVersion.id), `${mode} P01 逐格引用未唯一指向规范主版本。`);
    const downstreamPaths = assertProjectionExcludesRedacted(downstreamProjectionPaths, redactedPaths, `${mode} P01 EP01 全分页下游生成投影`);

    const responseFingerprints = Object.fromEntries(metrics.calls.map((entry) => [entry.callKey, entry.parsedSha256]));
    const parityPayload = {
      toolCount: discovered.tools.length,
      state,
      pagination: {
        firstIds: firstPage.items.map((item) => item.id),
        secondIds: secondPage.items.map((item) => item.id),
        tailIds: tailPage.items.map((item) => item.id),
        categoryIds: Object.fromEntries(Object.entries(categoryPages).map(([category, page]) => [category, page.items.map((item) => item.id)])),
        idSearchIds: idSearch.items.map((item) => item.id),
        nameSearchIds: nameSearch.items.map((item) => item.id),
        aliasSearches,
      },
      p01: {
        assetFingerprint: detail.asset.fingerprint,
        primaryAuthorityId: primary.id,
        primaryVersionId: primaryVersion.id,
        returnedAuthorityIds: detail.authorities.map((authority) => authority.id).sort(),
        returnedVersionIds: detail.versions.map((version) => version.id).sort(),
        generationPolicy: detail.generationPolicy,
        redactions: detail.redactions,
        primaryProjectionPathDigests: pathDigests(primaryProjectionPaths),
        redactedPathDigests: pathDigests(redactedPaths),
        downstreamPathDigests: pathDigests(downstreamPaths),
        downstreamReferenceVersions: [...downstreamReferenceVersions].sort(),
        p01PanelOccurrences,
      },
      legacy: {
        deprecated: legacy.deprecated,
        compatibilitySource: legacy.compatibilitySource,
        item: legacy.items[0],
      },
      responseFingerprints,
    };
    return {
      mode,
      process: {
        executable: process.execPath,
        server: mode === "source" ? "src/mcp/server.ts via tsx" : "dist-mcp/mcp/server.js",
        runtimeIsolation: "temporary HOME/TMPDIR/registry/media-runtime removed after close",
      },
      toolCount: discovered.tools.length,
      toolCatalogBytes,
      schemas: {
        canonicalReadTools: true,
        legacyReadTool: true,
        projectRootRequired: true,
        listDefaults: { offset: 0, limit: 30, maximumLimit: 100 },
      },
      catalog: {
        available: state.available,
        current: state.current,
        storeRevision: state.storeRevision,
        storeFingerprint: state.storeFingerprint,
        counts: state.counts,
        driftedInputs: state.driftedInputs,
      },
      paginationAndSearch: {
        pageSizes: [firstPage.items.length, secondPage.items.length, tailPage.items.length],
        pageOffsets: [firstPage.offset, secondPage.offset, tailPage.offset],
        adjacentPagesDisjoint: true,
        crossPageOrderStable: true,
        categoryCounts: Object.fromEntries(Object.entries(categoryPages).map(([category, page]) => [category, page.total])),
        categoryCoverage: categorizedIds.length,
        categoryIdsUnique: new Set(categorizedIds).size,
        searches: {
          P01: idSearch.items.map((item) => item.id),
          "布囊": nameSearch.items.map((item) => item.id),
          ...aliasSearches,
        },
      },
      p01: {
        assetId: detail.asset.id,
        category: detail.asset.category,
        primary: {
          authorityId: primary.id,
          role: primary.role,
          exposure: primary.exposure,
          usage: primary.scope.usage,
          versionId: primaryVersion.id,
          representation: primaryVersion.representation,
        },
        modelSafeProjection: {
          returnedAuthorityCount: detail.authorities.length,
          returnedVersionCount: detail.versions.length,
          returnedSupportingAuthorityCount: detail.asset.currentSupportingAuthorityIds.length,
          generationPolicy: detail.generationPolicy,
          redactions: detail.redactions,
          forbiddenAndHistoricalAuthorityIdsAbsent: true,
          forbiddenAndHistoricalVersionIdsAbsent: true,
          forbiddenAndHistoricalSourceSnapshotShaMediaValuesAbsent: true,
          forbiddenAndHistoricalLockRowsAbsent: true,
        },
        pathAudit: {
          redactedPathCount: redactedPaths.length,
          redactedPathDigests: pathDigests(redactedPaths),
          redactedPathHasGoldenMaskMarker: true,
          canonicalPrimaryProjectionPathCount: primaryProjectionPaths.length,
          canonicalPrimaryProjectionPathDigests: pathDigests(primaryProjectionPaths),
          ep01PanelResolutionTotal: panelTotal,
          ep01PanelPages: panelPages,
          p01PanelOccurrences,
          downstreamProjectionPathCount: downstreamPaths.length,
          downstreamProjectionPathDigests: pathDigests(downstreamPaths),
          downstreamReferenceVersions: [...downstreamReferenceVersions],
          forbiddenAndHistoricalPathsExcludedFromModelAndGenerationProjection: true,
          goldenMaskPathsExcludedFromGenerationProjection: true,
        },
      },
      legacyCompatibility: {
        deprecated: legacy.deprecated,
        compatibilitySource: legacy.compatibilitySource,
        total: legacy.total,
        assetId: legacy.items[0].assetId,
        fullLegacyDetailFieldsAbsent: true,
        forbiddenAndHistoricalPathsAbsent: true,
      },
      payloadSafety: {
        calls: metrics.calls,
        callCount: metrics.calls.length,
        totalBytes: metrics.totalBytes,
        largestResponseBytes: metrics.largestResponseBytes,
        largestResponseCall: metrics.largestResponseCall,
        maxStringBytes: metrics.maxStringBytes,
        responseLimitBytes: MAX_RESPONSE_BYTES,
        stringLimitBytes: MAX_STRING_BYTES,
        nonTextContentBlocks: 0,
        binaryValues: 0,
        embeddedMediaFields: 0,
        base64Payloads: 0,
      },
      responseFingerprints,
      parityFingerprint: semanticDigest(parityPayload),
      serverStderr: {
        bytes: stderrBytes,
        retainedTailOnly: true,
        tail: stderrTailBuffer.split(/\r?\n/u).filter(Boolean).slice(-20).map((line) => line.slice(0, 1_000)),
      },
      readOnlyToolsInvoked: [
        ...REQUIRED_CANONICAL_TOOLS,
        LEGACY_TOOL,
        PANEL_REFERENCE_LIST_TOOL,
      ],
      writeToolsInvoked: [],
      vendorBrowserOrGenerationInvoked: false,
      passed: true,
    };
  } finally {
    await client.close().catch(() => undefined);
    await rm(runtimeRoot, { recursive: true, force: true });
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(usage());
    return;
  }
  const requested = parseOptions(argv);
  const safe = await assertSafeInputs(requested);
  const p01ProjectionAudit = await buildP01ProjectionAudit(safe.projectRoot);
  const input = {
    ...requested,
    workspace: safe.workspace,
    projectRoot: safe.projectRoot,
    p01ProjectionAudit,
  };
  const startedAt = new Date().toISOString();

  progress("计算正式工程全树内容/身份守卫快照");
  const before = await guardedProjectState(input.projectRoot);
  progress("运行 source MCP 只读烟测");
  const source = await runMode("source", input);
  const afterSource = await guardedProjectState(input.projectRoot);
  assertGuardUnchanged(before, afterSource, "source MCP 只读烟测");

  progress("运行 compiled MCP 只读烟测");
  const compiled = await runMode("compiled", input);
  const afterCompiled = await guardedProjectState(input.projectRoot);
  assertGuardUnchanged(afterSource, afterCompiled, "compiled MCP 只读烟测");
  assert(source.parityFingerprint === compiled.parityFingerprint, "source/compiled MCP P5 观测语义不一致。");
  assert(semanticDigest(source.responseFingerprints) === semanticDigest(compiled.responseFingerprints), "source/compiled MCP 只读响应指纹不一致。");

  const evidence = {
    schemaVersion: 1,
    kind: "p5-canonical-mcp-smoke",
    startedAt,
    completedAt: new Date().toISOString(),
    workspace: input.workspace,
    projectRoot: input.projectRoot,
    assertions: {
      sourceAndCompiledToolCount178: true,
      canonicalCatalogCurrent: true,
      canonicalAssets77: true,
      explicitCategoryCounts: EXPECTED_CATEGORY_COUNTS,
      paginationAndSearchPassed: true,
      explicitAliasSearchPassed: true,
      p01ModelProjectionContainsOnlyCurrentPrimary: true,
      p01CurrentForbiddenAuthorityRedactedCount1: true,
      p01GenerationPolicyAllSafetyFieldsTrue: true,
      p01ForbiddenHistoricalSourceSnapshotShaMediaAndLocksAbsent: true,
      p01GoldenMaskPathExcludedFromGenerationProjection: true,
      downstreamReferencesOnlyCurrentPrimaryVersion: true,
      legacyDeprecatedCanonicalCompatibility: true,
      noBase64OrLargeMediaPayload: true,
      formalProjectUnchanged: true,
    },
    formalProjectGuard: {
      policy: "全树文件内容 SHA + 路径语义 + dev/ino/mode/mtime/ctime 身份守卫；无正式工程日志例外",
      allowedProjectMutations: [],
      before,
      afterSource,
      afterCompiled,
      sourceUnchanged: true,
      compiledUnchanged: true,
    },
    runs: [source, compiled],
    parity: {
      sourceFingerprint: source.parityFingerprint,
      compiledFingerprint: compiled.parityFingerprint,
      responseFingerprintsEqual: true,
      passed: true,
    },
    writeToolsInvoked: [],
    vendorBrowserOrGenerationInvoked: false,
    p5CompletionClaimed: false,
    passed: true,
  };
  if (input.writeEvidence) {
    await mkdir(path.dirname(input.evidencePath), { recursive: true });
    await writeFile(input.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  }
  process.stdout.write(`${JSON.stringify({
    passed: true,
    evidencePath: input.writeEvidence ? input.evidencePath : undefined,
    modes: evidence.runs.map((run) => run.mode),
    toolCounts: evidence.runs.map((run) => run.toolCount),
    catalog: { current: true, assets: EXPECTED_ASSET_COUNT, byCategory: EXPECTED_CATEGORY_COUNTS },
    p01: {
      returnedAuthorityCount: 1,
      returnedVersionCount: 1,
      currentForbiddenAuthorityRedactedCount: 1,
      generationPolicyAllSafetyFieldsTrue: true,
      forbiddenHistoricalSensitiveValuesAbsent: true,
      goldenMaskPathExcludedFromGenerationProjection: true,
      downstreamOnlyCurrentPrimaryVersion: true,
    },
    legacy: { deprecated: true, compatibilitySource: "canonical-assets" },
    payloadSafety: { base64Payloads: 0, nonTextContentBlocks: 0 },
    formalProjectUnchanged: true,
    p5CompletionClaimed: false,
  }, null, 2)}\n`);
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
  process.stderr.write(`[P5 canonical MCP] FAILED\n${message.slice(0, 12_000)}\n`);
  process.exitCode = 1;
}
