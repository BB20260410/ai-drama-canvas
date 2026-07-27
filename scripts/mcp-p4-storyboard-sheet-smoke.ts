import { createHash } from "node:crypto";
import { access, lstat, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { IdempotentCommandResult } from "../src/core/command-bus.js";
import type { FusionStoryboardSheetState, FusionStoryboardSheetVersionSummary } from "../src/core/fusion-storyboard-sheet-evidence.js";
import type { FusionStoryboardSheetMigrationResult } from "../src/core/fusion-storyboard-sheet-migration.js";
import { getSidecarPaths } from "../src/core/sidecar.js";
import { expectedRuntimeMcpToolCount } from "../src/core/release-manifest.js";

const EXPECTED_TOOL_COUNT = await expectedRuntimeMcpToolCount("/Users/hxx/Documents/无限画布");
const EP01_001 = "season-三-ep01-unit001";
const EP01_008 = "season-三-ep01-unit008";
const RAW_LABELED_PATTERNS = ["**/*_raw.png", "**/*_labeled.png"];
const RAW_LABELED_IGNORES = [
  ".aicanvas/backups/**",
  ".aicanvas/generation-downloads/**",
  ".aicanvas/subagent-staging/**",
];

interface CliOptions {
  workspace: string;
  projectRoot: string;
  migrationEvidencePath: string;
  evidencePath: string;
  writeEvidence: boolean;
}

interface MigrationEvidence {
  kind: "p4-fusion-storyboard-sheet-migration";
  projectRoot: string;
  command: {
    requestId: string;
    idempotencyKey: string;
    request: {
      command: "migrate_fusion_storyboard_sheets";
      payload: { itemIds?: string[]; expectedStoreRevision: number; expectedCandidateFingerprint: string };
    };
  };
  passed: true;
}

interface ListResult {
  storeRevision: number;
  migrationPreview: { pendingCount: number; blockers: string[]; candidateFingerprint: string };
  total: number;
  offset: number;
  limit: number;
  items: FusionStoryboardSheetVersionSummary[];
}

function usage(): string {
  return `P4 编译 MCP 故事板状态/迁移重放烟测

用法：
  npm run mcp:p4-storyboard-sheet-smoke -- [参数]

参数：
  --workspace <path>          工作区
  --project-root <path>       已完成 P4 正式迁移的隔离工程
  --migration-evidence <path> 正式迁移证据；用于同幂等键零写入重放
  --evidence <path>           输出证据 JSON
  --write-evidence            通过后独占写入；默认只输出摘要
  --help                      显示帮助

本烟测只调用 get/list 与正式迁移命令的既有幂等重放；不调用 render、Generate 或供应商。
`;
}

function optionValue(argv: string[], name: string): string | undefined {
  const indexes = argv.flatMap((entry, index) => entry === name ? [index] : []);
  if (indexes.length > 1) throw new Error(`${name} 参数重复。`);
  if (!indexes.length) return undefined;
  const value = argv[indexes[0]! + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} 缺少值。`);
  return value;
}

function parseOptions(argv: string[]): CliOptions {
  const valueOptions = new Set(["--workspace", "--project-root", "--migration-evidence", "--evidence"]);
  for (let index = 0; index < argv.length; index += 1) {
    const entry = argv[index]!;
    if (entry === "--write-evidence" || entry === "--help" || entry === "-h") continue;
    if (!valueOptions.has(entry)) throw new Error(`未知参数：${entry}`);
    index += 1;
    if (index >= argv.length || argv[index]!.startsWith("--")) throw new Error(`${entry} 缺少值。`);
  }
  const workspace = path.resolve(optionValue(argv, "--workspace") ?? "/Users/hxx/Documents/无限画布");
  return {
    workspace,
    projectRoot: path.resolve(optionValue(argv, "--project-root") ?? path.join(workspace, "productions/gushujuan-s3-f1a688020bfb7af6")),
    migrationEvidencePath: path.resolve(optionValue(argv, "--migration-evidence") ?? path.join(workspace, "docs/evidence/p4-fusion-storyboard-sheet-migration-final-20260717.json")),
    evidencePath: path.resolve(optionValue(argv, "--evidence") ?? path.join(workspace, "docs/evidence/p4-storyboard-sheet-mcp-final-20260717.json")),
    writeEvidence: argv.includes("--write-evidence"),
  };
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

async function exists(filePath: string): Promise<boolean> {
  return access(filePath).then(() => true, () => false);
}

async function assertSafePaths(input: CliOptions): Promise<void> {
  const [workspace, projectRoot, evidenceRoot] = await Promise.all([
    realpath(input.workspace),
    realpath(input.projectRoot),
    realpath(path.join(input.workspace, "docs", "evidence")),
  ]);
  if (!isInside(workspace, projectRoot) || !isInside(workspace, evidenceRoot)) throw new Error("P4 MCP 工程或证据根越出工作区。 ");
  if (!isInside(evidenceRoot, input.migrationEvidencePath)) throw new Error("正式迁移证据不在 docs/evidence。 ");
  if (!await exists(input.migrationEvidencePath)) throw new Error(`缺少正式迁移证据：${input.migrationEvidencePath}`);
  if (input.writeEvidence && (path.dirname(input.evidencePath) !== evidenceRoot || await exists(input.evidencePath))) {
    throw new Error(`P4 MCP 证据路径越界或已存在：${input.evidencePath}`);
  }
  if (isInside(projectRoot, input.evidencePath)) throw new Error("P4 MCP 证据不得写入正式工程。 ");
}

async function fileIdentity(filePath: string): Promise<{ path: string; exists: boolean; bytes?: number; sha256?: string }> {
  if (!await exists(filePath)) return { path: filePath, exists: false };
  const link = await lstat(filePath);
  if (link.isSymbolicLink() || !link.isFile()) throw new Error(`受保护路径不是普通文件：${filePath}`);
  const before = await stat(filePath);
  const content = await readFile(filePath);
  const after = await stat(filePath);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
    throw new Error(`计算摘要期间文件发生变化：${filePath}`);
  }
  return { path: filePath, exists: true, bytes: content.length, sha256: sha256(content) };
}

async function inventory(root: string, patterns: string | string[] = "**/*", ignore: string[] = []): Promise<{ root: string; files: number; bytes: number; sha256: string }> {
  if (!await exists(root)) return { root, files: 0, bytes: 0, sha256: sha256("") };
  const entries = (await fg(patterns, { cwd: root, dot: true, onlyFiles: true, followSymbolicLinks: false, unique: true, ignore }))
    .sort((left, right) => left.localeCompare(right, "en"));
  const rows = [] as Array<{ path: string; bytes: number; sha256: string }>;
  for (const relativePath of entries) {
    const absolutePath = path.join(root, ...relativePath.split("/"));
    const entry = await fileIdentity(absolutePath);
    if (!entry.exists || entry.bytes === undefined || !entry.sha256) throw new Error(`清单文件消失：${absolutePath}`);
    rows.push({ path: relativePath, bytes: entry.bytes, sha256: entry.sha256 });
  }
  return { root, files: rows.length, bytes: rows.reduce((sum, row) => sum + row.bytes, 0), sha256: sha256(JSON.stringify(rows)) };
}

async function guardedSnapshot(projectRoot: string): Promise<Record<string, unknown>> {
  const sidecar = getSidecarPaths(projectRoot);
  return {
    jobs: await fileIdentity(sidecar.generationJobs),
    publications: await fileIdentity(sidecar.publications),
    reviews: await fileIdentity(sidecar.reviews),
    sheetIndex: await fileIdentity(sidecar.storyboardSheetIndex),
    commandLedger: await fileIdentity(sidecar.commandLedger),
    events: await fileIdentity(sidecar.events),
    requests: await inventory(sidecar.generationRequests),
    downloads: await inventory(sidecar.generationDownloads),
    rawLabeled: await inventory(projectRoot, RAW_LABELED_PATTERNS, RAW_LABELED_IGNORES),
  };
}

function parseToolResult<T>(value: unknown): T {
  const result = value as { isError?: boolean; content?: Array<{ type: string; text?: string }> };
  const text = result.content?.find((entry) => entry.type === "text" && typeof entry.text === "string")?.text;
  if (!text) throw new Error("P4 MCP 没有返回 JSON 文本。 ");
  if (result.isError) throw new Error(text);
  return JSON.parse(text) as T;
}

function assertToolSchema(tool: { name: string; inputSchema?: unknown; annotations?: Record<string, unknown> }, mode: "read" | "write"): void {
  const schema = tool.inputSchema as { properties?: Record<string, unknown>; required?: string[] } | undefined;
  if (!schema?.properties?.projectRoot) throw new Error(`${tool.name} 未公开 projectRoot schema。`);
  if (mode === "read") {
    if (tool.annotations?.readOnlyHint !== true) throw new Error(`${tool.name} 未标记只读。`);
    return;
  }
  for (const key of ["expectedStoreRevision", "expectedCandidateFingerprint", "requestId", "idempotencyKey"]) {
    if (!schema.properties[key] || !schema.required?.includes(key)) throw new Error(`${tool.name} schema 缺少必填 ${key}。`);
  }
  if (tool.annotations?.idempotentHint !== true || tool.annotations.readOnlyHint !== false) {
    throw new Error(`${tool.name} 未声明受保护幂等写语义。`);
  }
}

function assertState001(state: FusionStoryboardSheetState): void {
  const statuses = new Set(state.versions.map((entry) => entry.status));
  if (state.schemaVersion !== 2 || state.kind !== "fusion-storyboard-sheet-state" || state.itemId !== EP01_001
    || state.currentSheetId !== undefined || state.readiness.canRender || state.readiness.expectedInputFingerprint
    || !statuses.has("stale") || !statuses.has("legacy-invalid")
    || state.migrationPreview.pendingCount !== 0 || state.migrationPreview.blockers.length) {
    throw new Error(`EP01_001 P4 状态不符合历史非 current 门禁：${JSON.stringify(state)}`);
  }
}

function assertState008(state: FusionStoryboardSheetState): void {
  const panelCount = state.currentContract?.selection.panelCount;
  const blockers = state.readiness.blockers.join("；");
  if (state.schemaVersion !== 2 || state.itemId !== EP01_008 || state.currentSheetId !== undefined
    || state.readiness.canRender || state.readiness.expectedInputFingerprint || panelCount !== 6 || state.versions.length !== 0
    || !/宫格05.*generation_unknown/u.test(blockers) || !/宫格06.*(?:缺少|missing)/u.test(blockers)
    || !/(?:完整宫格证据不足|不完整|没有 succeeded GenerationJob)/u.test(blockers)
    || state.migrationPreview.pendingCount !== 0 || state.migrationPreview.blockers.length) {
    throw new Error(`EP01_008 P4 状态未失败关闭 6 格缺口：${JSON.stringify(state)}`);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(usage());
    return;
  }
  const input = parseOptions(argv);
  await assertSafePaths(input);
  const serverPath = path.join(input.workspace, "dist-mcp", "mcp", "server.js");
  if (!await exists(serverPath)) throw new Error(`编译 MCP 不存在：${serverPath}`);
  const migrationEvidence = JSON.parse(await readFile(input.migrationEvidencePath, "utf8")) as MigrationEvidence;
  if (migrationEvidence.kind !== "p4-fusion-storyboard-sheet-migration" || !migrationEvidence.passed
    || path.resolve(migrationEvidence.projectRoot) !== input.projectRoot
    || migrationEvidence.command.request.command !== "migrate_fusion_storyboard_sheets") {
    throw new Error("P4 正式迁移证据身份无效。 ");
  }

  const before = await guardedSnapshot(input.projectRoot);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    cwd: input.workspace,
    env: { ...process.env, AI_CANVAS_PROJECT_ROOT: input.projectRoot },
    stderr: "pipe",
  });
  const stderr: string[] = [];
  transport.stderr?.on("data", (chunk) => stderr.push(String(chunk)));
  const client = new Client({ name: "ai-drama-canvas-p4-storyboard-sheet-smoke", version: "1.0.0" });
  let state001!: FusionStoryboardSheetState;
  let state008!: FusionStoryboardSheetState;
  let list001!: ListResult;
  let list008!: ListResult;
  let migrationReplay!: IdempotentCommandResult;
  try {
    await client.connect(transport);
    const discovered = await client.listTools();
    if (discovered.tools.length !== EXPECTED_TOOL_COUNT) {
      throw new Error(`P4 编译 MCP 工具应为 ${EXPECTED_TOOL_COUNT}，实际 ${discovered.tools.length}。`);
    }
    const required = ["get_fusion_storyboard_sheet_state", "list_fusion_storyboard_sheets", "migrate_fusion_storyboard_sheets"];
    const byName = new Map(discovered.tools.map((tool) => [tool.name, tool]));
    for (const name of required) if (!byName.has(name)) throw new Error(`P4 MCP 缺少工具：${name}`);
    assertToolSchema(byName.get(required[0]!)!, "read");
    assertToolSchema(byName.get(required[1]!)!, "read");
    assertToolSchema(byName.get(required[2]!)!, "write");

    const capabilities = parseToolResult<{
      server?: { toolCount?: number };
      domains?: { fusionProduction?: string[] };
      commandTypes?: string[];
    }>(await client.callTool({ name: "get_capabilities", arguments: { projectRoot: input.projectRoot } }));
    if (capabilities.server?.toolCount !== EXPECTED_TOOL_COUNT
      || required.slice(0, 2).some((name) => !capabilities.domains?.fusionProduction?.includes(name))
      || !capabilities.commandTypes?.includes("migrate_fusion_storyboard_sheets")) {
      throw new Error(`P4 capabilities 未完整公开故事板合同：${JSON.stringify(capabilities)}`);
    }

    state001 = parseToolResult<FusionStoryboardSheetState>(await client.callTool({
      name: "get_fusion_storyboard_sheet_state",
      arguments: { projectRoot: input.projectRoot, itemId: EP01_001 },
    }));
    state008 = parseToolResult<FusionStoryboardSheetState>(await client.callTool({
      name: "get_fusion_storyboard_sheet_state",
      arguments: { projectRoot: input.projectRoot, itemId: EP01_008 },
    }));
    assertState001(state001);
    assertState008(state008);

    list001 = parseToolResult<ListResult>(await client.callTool({
      name: "list_fusion_storyboard_sheets",
      arguments: { projectRoot: input.projectRoot, itemId: EP01_001, offset: 0, limit: 50 },
    }));
    list008 = parseToolResult<ListResult>(await client.callTool({
      name: "list_fusion_storyboard_sheets",
      arguments: { projectRoot: input.projectRoot, itemId: EP01_008, offset: 0, limit: 50 },
    }));
    if (list001.total !== state001.versions.length
      || !list001.items.some((entry) => entry.status === "stale")
      || !list001.items.some((entry) => entry.status === "legacy-invalid")
      || list001.items.some((entry) => entry.status === "current")
      || list008.items.some((entry) => entry.status === "current")
      || list001.migrationPreview.pendingCount !== 0 || list008.migrationPreview.pendingCount !== 0) {
      throw new Error(`P4 list/state 身份不一致：${JSON.stringify({ list001, list008 })}`);
    }

    const replayRequestId = `mcp-p4-replay-${sha256(migrationEvidence.command.idempotencyKey).slice(0, 32)}`;
    migrationReplay = parseToolResult<IdempotentCommandResult>(await client.callTool({
      name: "migrate_fusion_storyboard_sheets",
      arguments: {
        projectRoot: input.projectRoot,
        requestId: replayRequestId,
        idempotencyKey: migrationEvidence.command.idempotencyKey,
        ...migrationEvidence.command.request.payload,
      },
    }));
    const replayResult = migrationReplay.result as FusionStoryboardSheetMigrationResult | undefined;
    if (migrationReplay.status !== "succeeded" || !migrationReplay.replayed
      || replayResult?.kind !== "fusion-storyboard-sheet-migration-result"
      || replayResult.candidateFingerprint !== migrationEvidence.command.request.payload.expectedCandidateFingerprint) {
      throw new Error(`P4 MCP migration 不是既有命令的零写入重放：${JSON.stringify(migrationReplay)}`);
    }
  } finally {
    await client.close().catch(() => undefined);
  }

  const after = await guardedSnapshot(input.projectRoot);
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error("P4 MCP 状态/迁移重放改写了正式工程。 ");
  const evidence = {
    schemaVersion: 1,
    kind: "p4-storyboard-sheet-mcp-smoke",
    createdAt: new Date().toISOString(),
    workspace: input.workspace,
    projectRoot: input.projectRoot,
    toolCount: EXPECTED_TOOL_COUNT,
    schemas: { state: true, list: true, migrateGuardedIdempotent: true },
    ep01_001: {
      current: 0,
      history: state001.versions.map((entry) => ({ sheetId: entry.sheetId, status: entry.status, artifacts: entry.artifacts.length })),
      readiness: state001.readiness,
    },
    ep01_008: {
      current: 0,
      panelCount: state008.currentContract?.selection.panelCount,
      readiness: state008.readiness,
    },
    migrationReplay: {
      requestId: migrationReplay.requestId,
      idempotencyKey: migrationReplay.idempotencyKey,
      status: migrationReplay.status,
      replayed: migrationReplay.replayed,
      result: migrationReplay.result,
    },
    guarded: { before, after, unchanged: true },
    serverStderrTail: stderr.join("").split(/\r?\n/u).filter(Boolean).slice(-20),
    renderOrGenerationInvoked: false,
    passed: true,
  };
  if (input.writeEvidence) {
    await mkdir(path.dirname(input.evidencePath), { recursive: true });
    await writeFile(input.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  }
  process.stdout.write(`${JSON.stringify({
    passed: true,
    evidencePath: input.writeEvidence ? input.evidencePath : undefined,
    toolCount: EXPECTED_TOOL_COUNT,
    ep01_001: { current: 0, history: state001.versions.map((entry) => entry.status) },
    ep01_008: { current: 0, panelCount: state008.currentContract?.selection.panelCount },
    migrationReplayed: migrationReplay.replayed,
    guardedUnchanged: true,
  }, null, 2)}\n`);
}

await main();
