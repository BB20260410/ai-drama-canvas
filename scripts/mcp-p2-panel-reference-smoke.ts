import { createHash } from "node:crypto";
import { access, mkdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { getSidecarPaths, readJson, writeJsonAtomicExclusive } from "../src/core/sidecar.js";
import type { FusionPanelReferenceAudit } from "../src/core/fusion-panel-references.js";
import { FUSION_PANEL_REFERENCE_CONTRACT_COVERAGE_VERSION } from "../src/core/fusion-panel-references.js";

const EXPECTED_DISTRIBUTION = { "2": 151, "3": 667, "4": 349, "5": 95, "6": 26 } as const;

interface CliOptions {
  workspace: string;
  projectRoot: string;
  evidencePath: string;
  writeEvidence: boolean;
  skipProjectSnapshot: boolean;
}

interface ResolutionSummary {
  resolutionId: string;
  resolutionFingerprint: string;
  gridContractId: string;
  panelId: string;
  unitItemId: string;
  closureStatus: string;
  generationReady: boolean;
  detectedOverflow: boolean;
  blockerCodes: string[];
  semanticAssetIds?: string[];
  semanticAssets?: Array<{ assetId: string }>;
  referenceSlotCount?: number;
  referenceSlots?: unknown[];
}

function usage(): string {
  return `P2 编译 MCP 只读烟测

用法：
  npm run mcp:p2-panel-reference-smoke -- [参数]

参数：
  --workspace <path>       工作区
  --project-root <path>    已完成 P2 物化的隔离工程
  --evidence <path>        证据 JSON 路径（写入时仅 workspace/docs/evidence）
  --write-evidence        验证通过后独占写入证据；默认只输出摘要
  --skip-project-snapshot 仅供 primaryRoot 不匹配的 /tmp 演练副本；正式关账禁止使用
  --help                  显示帮助

前置：先运行 npm run build:mcp，且正式 P2 迁移已通过。
`;
}

function optionValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} 缺少路径参数。`);
  return value;
}

function options(argv: string[]): CliOptions {
  const workspace = path.resolve(optionValue(argv, "--workspace") ?? "/Users/hxx/Documents/无限画布");
  return {
    workspace,
    projectRoot: path.resolve(optionValue(argv, "--project-root") ?? path.join(workspace, "productions/gushujuan-s3-f1a688020bfb7af6")),
    evidencePath: path.resolve(optionValue(argv, "--evidence") ?? path.join(workspace, "docs/evidence/p2-panel-reference-mcp-final-20260717.json")),
    writeEvidence: argv.includes("--write-evidence"),
    skipProjectSnapshot: argv.includes("--skip-project-snapshot"),
  };
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function nearestExistingRealPath(candidate: string): Promise<{ real: string; suffix: string[] }> {
  const suffix: string[] = [];
  let cursor = path.resolve(candidate);
  while (!await exists(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) throw new Error(`无法找到证据路径的现存父目录：${candidate}`);
    suffix.unshift(path.basename(cursor));
    cursor = parent;
  }
  return { real: await realpath(cursor), suffix };
}

async function assertSafeEvidencePath(input: CliOptions): Promise<void> {
  if (!input.writeEvidence) return;
  const evidenceRoot = path.resolve(input.workspace, "docs/evidence");
  const target = path.resolve(input.evidencePath);
  if (target === evidenceRoot || !isInside(evidenceRoot, target) || isInside(input.projectRoot, target)) {
    throw new Error(`MCP 烟测证据必须位于 workspace/docs/evidence，且不得位于正式 production：${target}`);
  }
  const [canonicalWorkspace, canonicalRoot, canonicalProject] = await Promise.all([
    realpath(input.workspace),
    realpath(evidenceRoot),
    realpath(input.projectRoot),
  ]);
  if (!isInside(canonicalWorkspace, canonicalRoot) || isInside(canonicalProject, canonicalRoot)) {
    throw new Error("workspace/docs/evidence 经符号链接解析后不在工作区安全证据树内。");
  }
  const parent = await nearestExistingRealPath(path.dirname(target));
  const canonicalTarget = await exists(target)
    ? await realpath(target)
    : path.join(parent.real, ...parent.suffix, path.basename(target));
  if (!isInside(canonicalRoot, canonicalTarget) || isInside(canonicalProject, canonicalTarget)) {
    throw new Error(`MCP 烟测证据经符号链接解析后越出 docs/evidence：${target}`);
  }
}

async function exists(filePath: string): Promise<boolean> {
  return access(filePath).then(() => true, () => false);
}

async function hashExistingFiles(files: Record<string, string>): Promise<Record<string, { path: string; bytes: number; sha256: string }>> {
  const result: Record<string, { path: string; bytes: number; sha256: string }> = {};
  for (const [name, filePath] of Object.entries(files)) {
    if (!await exists(filePath)) continue;
    const before = await stat(filePath);
    const content = await readFile(filePath);
    const after = await stat(filePath);
    if (!before.isFile()
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs
      || content.length !== before.size) {
      throw new Error(`MCP 烟测计算受保护文件摘要期间内容发生变化：${filePath}`);
    }
    result[name] = { path: filePath, bytes: content.length, sha256: sha256(content) };
  }
  return result;
}

function parse<T>(value: unknown): T {
  const result = value as { isError?: boolean; content?: Array<{ type: string; text?: string }> };
  const text = result.content?.find((entry) => entry.type === "text" && typeof entry.text === "string")?.text;
  if (!text) throw new Error("MCP 未返回 JSON 文本。");
  if (result.isError) throw new Error(text);
  return JSON.parse(text) as T;
}

function assertAudit(audit: FusionPanelReferenceAudit): void {
  if (audit.currentContracts !== 1_288
    || audit.panels !== 4_330
    || audit.contractCoverageVersion !== FUSION_PANEL_REFERENCE_CONTRACT_COVERAGE_VERSION
    || audit.semanticAssetBindings !== 13_812
    || audit.referenceSlots !== 12_720
    || audit.detectedRowContinuityDifferencePanels !== 913
    || audit.detectedRowContinuityDifferences !== 1_994
    || JSON.stringify(audit.panelDistribution) !== JSON.stringify(EXPECTED_DISTRIBUTION)
    || audit.unresolvedPanels !== 0
    || audit.unresolvedReferences !== 0
    || audit.knownAssetMissingBindingPanels !== 0
    || audit.knownAssetMissingBindings !== 0
    || audit.semanticAssetMissingSlotPanels !== 0
    || audit.semanticAssetMissingSlots !== 0
    || audit.contractAssetMissingBindingPanels !== 0
    || audit.contractAssetMissingBindings !== 0
    || audit.explicitContinuityMissingBindingPanels !== 0
    || audit.explicitContinuityMissingBindings !== 0
    || audit.unhandledOverflowPanels !== 0
    || audit.timeSpanContinuityMismatchPanels !== 0
    || audit.timeSpanContinuityMismatches !== 0
    || audit.maximumReferenceSlotsPerPanel > 6
    || audit.detectedOverflowPanels !== 166
    || audit.pendingDerivedArtifactPanels !== 166
    || audit.derivedDefinitions !== 52
    || !audit.closurePassed) {
    throw new Error(`MCP P2 审计摘要不满足正式闭包：${JSON.stringify(audit)}`);
  }
}

function allAssertionsTrue(assertions: Record<string, boolean>): boolean {
  return Object.values(assertions).every(Boolean);
}

function progress(stage: string): void {
  process.stderr.write(`[P2 MCP smoke] ${stage}\n`);
}

async function withTimeout<T>(label: string, promise: Promise<T>, timeoutMs = 30_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} 在 ${timeoutMs}ms 内未返回；编译 MCP 可能已退出或卡死。`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(usage());
    return;
  }
  const input = options(argv);
  await assertSafeEvidencePath(input);
  const serverPath = path.join(input.workspace, "dist-mcp/mcp/server.js");
  if (!await exists(serverPath)) throw new Error(`编译 MCP 不存在：${serverPath}；请先运行 npm run build:mcp。`);
  if (input.writeEvidence && await exists(input.evidencePath)) throw new Error(`证据已存在，拒绝覆盖：${input.evidencePath}`);

  const sidecar = getSidecarPaths(input.projectRoot);
  const projectConfig = await readJson<{ primaryRoot?: string }>(sidecar.config, {});
  const configuredPrimaryRootMismatch = Boolean(projectConfig.primaryRoot
    && path.resolve(projectConfig.primaryRoot) !== path.resolve(input.projectRoot));
  if (input.skipProjectSnapshot && !configuredPrimaryRootMismatch) {
    throw new Error("--skip-project-snapshot 只允许用于 project.json.primaryRoot 与演练根不同的副本；正式工程禁止跳过。");
  }
  const guardedFiles = {
    projectConfig: sidecar.config,
    projectIndex: sidecar.index,
    projectOverrides: sidecar.overrides,
    scanCache: sidecar.cache,
    storyboards: sidecar.storyboards,
    productionWorkflow: sidecar.productionWorkflow,
    fusionProjectManifest: sidecar.fusionProjectManifest,
    productionAssets: sidecar.productionAssets,
    continuityTracks: sidecar.continuityTracks,
    assetConsistencyBatches: sidecar.assetConsistencyBatches,
    panelReferenceResolutions: sidecar.panelReferenceResolutions,
    storyboardGridSelections: sidecar.storyboardGridSelections,
    generationJobs: sidecar.generationJobs,
    publications: sidecar.publications,
    reviews: sidecar.reviews,
    events: sidecar.events,
    commandLedger: sidecar.commandLedger,
  };
  const before = await hashExistingFiles(guardedFiles);
  if (!before.panelReferenceResolutions) throw new Error("正式工程尚无 P2 逐格引用仓；先完成显式 --apply 迁移。");

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    cwd: input.workspace,
    env: { ...process.env, AI_CANVAS_PROJECT_ROOT: input.projectRoot },
    stderr: "pipe",
  });
  const stderr: string[] = [];
  transport.stderr?.on("data", (chunk) => stderr.push(String(chunk)));
  const client = new Client({ name: "ai-drama-canvas-p2-panel-reference-smoke", version: "1.0.0" });

  try {
    await client.connect(transport);
    progress("已连接编译 MCP");
    const listed = await client.listTools();
    const toolNames = listed.tools.map((tool) => tool.name);
    const requiredTools = [
      "audit_fusion_panel_references",
      "list_fusion_panel_reference_resolutions",
      "get_fusion_panel_reference_resolution",
      "list_derived_panel_reference_assets",
      "materialize_fusion_panel_references",
      "upsert_panel_reference_override",
      "register_derived_panel_reference_artifact",
    ];
    const missingTools = requiredTools.filter((name) => !toolNames.includes(name));
    if (missingTools.length) throw new Error(`编译 MCP 缺少 P2 工具：${missingTools.join("、")}`);

    const capabilities = parse<{
      domains?: { fusionProduction?: string[] };
      commandTypes?: string[];
      fusionProduction?: Record<string, unknown>;
    }>(await client.callTool({ name: "get_capabilities", arguments: { projectRoot: input.projectRoot } }));
    progress("工具发现与能力清单通过");
    const fusionTools = capabilities.domains?.fusionProduction ?? [];
    for (const name of requiredTools.slice(0, 4)) {
      if (!fusionTools.includes(name)) throw new Error(`capabilities.tools.fusionProduction 缺少 ${name}`);
    }
    for (const command of ["materialize_fusion_panel_references", "upsert_panel_reference_override", "register_derived_panel_reference_artifact"]) {
      if (!capabilities.commandTypes?.includes(command)) throw new Error(`capabilities.commandTypes 缺少 ${command}`);
    }

    const audit = parse<FusionPanelReferenceAudit & { currentness?: { current?: boolean; driftedInputs?: string[] } }>(await client.callTool({
      name: "audit_fusion_panel_references",
      arguments: { projectRoot: input.projectRoot },
    }));
    assertAudit(audit);
    if (audit.currentness?.current !== true || audit.currentness.driftedInputs?.length) {
      throw new Error(`MCP P2 引用仓当前性失效：${JSON.stringify(audit.currentness)}`);
    }
    progress("闭包审计与当前性通过");

    const page = parse<{
      total: number;
      offset: number;
      limit: number;
      items: ResolutionSummary[];
      audit: FusionPanelReferenceAudit;
      storeRevision: number;
      storeFingerprint: string;
    }>(await client.callTool({
      name: "list_fusion_panel_reference_resolutions",
      arguments: { projectRoot: input.projectRoot, episode: 1, offset: 0, limit: 2 },
    }));
    if (page.total <= 0 || page.items.length !== 2 || !page.storeFingerprint || page.storeRevision < 1) {
      throw new Error(`P2 分页返回无效：${JSON.stringify(page)}`);
    }
    const first = page.items[0]!;
    if (!first.gridContractId || !first.panelId || !first.resolutionId) throw new Error(`P2 分页摘要缺少内容身份：${JSON.stringify(first)}`);

    const detail = parse<ResolutionSummary>(await client.callTool({
      name: "get_fusion_panel_reference_resolution",
      arguments: { projectRoot: input.projectRoot, contractId: first.gridContractId, panelId: first.panelId },
    }));
    if (detail.resolutionId !== first.resolutionId
      || detail.resolutionFingerprint !== first.resolutionFingerprint
      || detail.gridContractId !== first.gridContractId
      || detail.panelId !== first.panelId) {
      throw new Error(`P2 详情与分页身份不一致：${JSON.stringify({ first, detail })}`);
    }
    const semanticCount = detail.semanticAssetIds?.length ?? detail.semanticAssets?.length ?? 0;
    const slotCount = detail.referenceSlotCount ?? detail.referenceSlots?.length ?? 0;
    if (slotCount > 6 || (detail.closureStatus !== "resolved" && detail.closureStatus !== "confirmed-empty")) {
      throw new Error(`P2 详情未形成闭包或超过六槽：${JSON.stringify(detail)}`);
    }
    progress("分页与单格身份通过");

    const overflowPage = parse<{ total: number; items: ResolutionSummary[] }>(await client.callTool({
      name: "list_fusion_panel_reference_resolutions",
      arguments: { projectRoot: input.projectRoot, overflowOnly: true, offset: 0, limit: 1 },
    }));
    if (overflowPage.total !== 166 || overflowPage.items.length !== 1 || !overflowPage.items[0]?.detectedOverflow) {
      throw new Error(`MCP 溢出格分页应为 166：${JSON.stringify(overflowPage)}`);
    }

    const derived = parse<{
      total: number;
      offset: number;
      limit: number;
      items: Array<{ id: string; status: string; visualArtifact?: unknown; memberAssetIds: string[] }>;
      storeRevision: number;
    }>(await client.callTool({
      name: "list_derived_panel_reference_assets",
      arguments: { projectRoot: input.projectRoot, offset: 0, limit: 100 },
    }));
    if (derived.total !== 52
      || derived.items.length !== 52
      || derived.items.some((asset) => asset.status !== "definition-approved" || asset.visualArtifact || asset.memberAssetIds.length <= 6)) {
      throw new Error(`52 个派生引用应只完成结构定义，不得伪造视觉就绪：${JSON.stringify({ total: derived.total, statuses: derived.items.map((asset) => asset.status) })}`);
    }
    progress("溢出分页与 52 个派生定义通过");

    const doctor = parse<Record<string, unknown>>(await withTimeout("doctor_project", client.callTool({
      name: "doctor_project",
      arguments: { projectRoot: input.projectRoot },
    })));
    progress("Doctor 调用返回");
    const snapshot = input.skipProjectSnapshot
      ? undefined
      : parse<Record<string, unknown>>(await withTimeout("get_project_snapshot", client.callTool({
        name: "get_project_snapshot",
        arguments: { projectRoot: input.projectRoot },
      })));
    if (input.skipProjectSnapshot) progress("仅演练：已跳过 primaryRoot 不匹配副本的统一快照");
    const diagnosticText = JSON.stringify({ doctor, snapshot, audit });
    if (!diagnosticText.includes(audit.auditFingerprint)
      || !diagnosticText.includes("待硬锁")
      || !diagnosticText.includes("待派生视觉产物")) {
      throw new Error("Doctor/统一快照没有暴露 P2 审计身份与生产就绪阻塞。");
    }
    progress("Doctor 与统一快照通过");

    // capabilities 会以约束字段名描述 reservationToken，那不是密钥值；
    // 密钥泄露检查只针对真实项目查询结果。
    const serialized = JSON.stringify({ audit, page, detail, overflowPage, derived, doctor, snapshot });
    if (/data:image|;base64,|reservationToken|publicationReservationToken|companionPublicationReservationToken/u.test(serialized)) {
      throw new Error("P2 MCP 只读响应泄露了媒体二进制或 Publication 令牌。");
    }

    const after = await hashExistingFiles(guardedFiles);
    if (JSON.stringify(after) !== JSON.stringify(before)) {
      throw new Error(`P2 MCP 只读烟测改写了正式状态：${JSON.stringify({ before, after })}`);
    }
    progress("受保护项目文件前后一致");
    const assertions = {
      sevenP2ToolsDiscoverable: true,
      capabilitiesExposeReadToolsAndCommands: true,
      exactAuditCountsAndFourClosureErrorsZero: true,
      listAndDetailShareFrozenResolutionIdentity: true,
      paginationAndFiltersWork: true,
      overflowPanelsAreNotSilentlyTruncated: true,
      derivedDefinitionsAreStructuralOnlyAndGenerationBlocked: true,
      doctorExposesClosureAndReadiness: true,
      projectSnapshotPolicyHonored: input.skipProjectSnapshot ? configuredPrimaryRootMismatch : Boolean(snapshot),
      noBinaryOrSecretExposure: true,
      readOnlyCallsDidNotWriteFormalState: true,
    };
    if (!allAssertionsTrue(assertions)) throw new Error("P2 MCP 烟测存在未通过断言。");
    const evidence = {
      schemaVersion: 1,
      kind: "p2-panel-reference-mcp-smoke",
      createdAt: new Date().toISOString(),
      workspace: input.workspace,
      projectRoot: input.projectRoot,
      serverPath,
      serverSha256: sha256(await readFile(serverPath)),
      tools: { count: listed.tools.length, required: requiredTools },
      guardedFiles: { before, after, unchanged: true },
      audit,
      page: {
        total: page.total,
        storeRevision: page.storeRevision,
        storeFingerprint: page.storeFingerprint,
        firstTwo: page.items,
      },
      detail: { ...detail, semanticAssetCount: semanticCount, referenceSlotCount: slotCount },
      overflow: { total: overflowPage.total, first: overflowPage.items[0] },
      derived: {
        total: derived.total,
        structuralDefinitions: derived.items.filter((asset) => asset.status === "definition-approved").length,
        visualReady: derived.items.filter((asset) => asset.status === "visual-ready").length,
      },
      diagnosticsSha256: sha256(diagnosticText),
      projectSnapshot: { skipped: input.skipProjectSnapshot, configuredPrimaryRootMismatch },
      stderrSha256: sha256(stderr.join("")),
      assertions,
    };
    if (input.writeEvidence) {
      await mkdir(path.dirname(input.evidencePath), { recursive: true });
      await writeJsonAtomicExclusive(input.evidencePath, evidence);
    }
    progress(input.writeEvidence ? `证据已写入 ${input.evidencePath}` : "无写证据模式验证通过");
    process.stdout.write(`${JSON.stringify({
      evidencePath: input.writeEvidence ? input.evidencePath : undefined,
      audit,
      tools: evidence.tools,
      derived: evidence.derived,
      guardedFilesUnchanged: true,
      assertions,
    }, null, 2)}\n`);
  } catch (error) {
    const serverTail = stderr.join("").split(/\r?\n/u).filter(Boolean).slice(-40);
    if (serverTail.length) process.stderr.write(`[P2 MCP smoke] 编译服务器 stderr 尾部：\n${serverTail.join("\n")}\n`);
    throw error;
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
