import { createHash } from "node:crypto";
import { access, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { getSidecarPaths } from "../src/core/sidecar.js";
import type { PanelVisualConstraintAudit } from "../src/core/fusion-visual-constraints.js";
import { expectedRuntimeMcpToolCount } from "../src/core/release-manifest.js";

interface CliOptions {
  workspace: string;
  projectRoot: string;
  evidencePath: string;
  writeEvidence: boolean;
}

interface ConstraintSummary {
  constraintId: string;
  fingerprint: string;
  modelFingerprint: string;
  reviewRulesFingerprint: string;
  unitItemId: string;
  episodeNumber: number;
  gridContractId: string;
  panelId: string;
  panelIndex: number;
  hiddenMaskPolicy: { status: "not-applicable" | "concealed" | "reveal-authorized" };
  warningCodes: string[];
  reviewRuleCount: number;
  humanVisualReviewRequired: boolean;
  generationGate: { status: "ready" | "blocked"; blockerCodes: string[] };
}

interface ConstraintDetail extends ConstraintSummary {
  inputSnapshot: { resolutionId: string; resolutionFingerprint: string };
  modelPrompt: string;
  modelNegativePrompt: string;
  mustAppear: Array<{ assetId: string; modelInstruction: string }>;
  mustNotAppear: Array<{ warningCode: string; modelInstruction: string }>;
  identityLocks: unknown[];
  spatialLocks: unknown[];
  continuityLocks: unknown[];
  reviewRules: unknown[];
  warnings: unknown[];
}

const EXPECTED = {
  tools: await expectedRuntimeMcpToolCount("/Users/hxx/Documents/无限画布"),
  contracts: 1_288,
  constraints: 4_330,
  onScreenAssets: 12_502,
  continuityOnlyAssets: 1_310,
  unresolvedIdentityLocks: 8_331,
  unresolvedSpatialLocks: 24_992,
  unresolvedContinuityLocks: 440,
  concealedMaskPanels: 304,
  generationReadyPanels: 610,
} as const;

function usage(): string {
  return `P3 编译 MCP 只读烟测

用法：
  npm run mcp:p3-visual-constraints-smoke -- [参数]

参数：
  --workspace <path>       工作区
  --project-root <path>    已完成 P3 物化的隔离工程
  --evidence <path>        证据 JSON；写入时必须位于 workspace/docs/evidence
  --write-evidence         通过后独占写入证据；默认只输出摘要
  --help                   显示帮助

前置：先运行 npm run build:mcp 和 P3 正式安全迁移。本脚本只读，不调用供应商或生图。
`;
}

function optionValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} 缺少路径参数。`);
  return value;
}

function parseOptions(argv: string[]): CliOptions {
  const workspace = path.resolve(optionValue(argv, "--workspace") ?? "/Users/hxx/Documents/无限画布");
  return {
    workspace,
    projectRoot: path.resolve(optionValue(argv, "--project-root") ?? path.join(workspace, "productions/gushujuan-s3-f1a688020bfb7af6")),
    evidencePath: path.resolve(optionValue(argv, "--evidence") ?? path.join(workspace, "docs/evidence/p3-visual-constraints-mcp-final-20260717.json")),
    writeEvidence: argv.includes("--write-evidence"),
  };
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

async function exists(filePath: string): Promise<boolean> {
  return access(filePath).then(() => true, () => false);
}

async function assertSafeEvidencePath(input: CliOptions): Promise<void> {
  if (!input.writeEvidence) return;
  const [workspace, projectRoot, evidenceRoot] = await Promise.all([
    realpath(input.workspace),
    realpath(input.projectRoot),
    realpath(path.join(input.workspace, "docs", "evidence")),
  ]);
  if (!isInside(workspace, evidenceRoot)
    || path.dirname(input.evidencePath) !== evidenceRoot
    || isInside(projectRoot, input.evidencePath)
    || await exists(input.evidencePath)) {
    throw new Error(`P3 MCP 证据路径越界或已存在：${input.evidencePath}`);
  }
}

async function fileIdentity(filePath: string): Promise<{ path: string; bytes: number; sha256: string }> {
  const before = await stat(filePath);
  const content = await readFile(filePath);
  const after = await stat(filePath);
  if (!before.isFile() || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
    throw new Error(`P3 MCP 计算摘要期间文件发生变化：${filePath}`);
  }
  return { path: filePath, bytes: content.length, sha256: sha256(content) };
}

async function guardedIdentities(files: Record<string, string>): Promise<Record<string, { path: string; bytes: number; sha256: string }>> {
  return Object.fromEntries(await Promise.all(Object.entries(files).map(async ([name, filePath]) => [name, await fileIdentity(filePath)])));
}

function parse<T>(value: unknown): T {
  const result = value as { isError?: boolean; content?: Array<{ type: string; text?: string }> };
  const text = result.content?.find((entry) => entry.type === "text" && typeof entry.text === "string")?.text;
  if (!text) throw new Error("P3 MCP 没有返回 JSON 文本。");
  if (result.isError) throw new Error(text);
  return JSON.parse(text) as T;
}

function assertAudit(audit: PanelVisualConstraintAudit): void {
  const zeroFields = [
    audit.missingConstraints,
    audit.extraConstraints,
    audit.invalidConstraints,
    audit.duplicateConstraintIds,
    audit.invalidModelFingerprints,
    audit.invalidReviewRulesFingerprints,
    audit.modelPromptLeakPanels,
    audit.modelPathLeakPanels,
    audit.revealAuthorizedPanels,
    audit.warningsWithoutReviewRules,
  ];
  if (audit.contracts !== EXPECTED.contracts
    || audit.expectedPanels !== EXPECTED.constraints
    || audit.constraints !== EXPECTED.constraints
    || audit.onScreenAssets !== EXPECTED.onScreenAssets
    || audit.continuityOnlyAssets !== EXPECTED.continuityOnlyAssets
    || audit.optionalOffscreenAssets !== 0
    || audit.unresolvedIdentityLocks !== EXPECTED.unresolvedIdentityLocks
    || audit.unresolvedSpatialLocks !== EXPECTED.unresolvedSpatialLocks
    || audit.unresolvedContinuityLocks !== EXPECTED.unresolvedContinuityLocks
    || audit.concealedMaskPanels !== EXPECTED.concealedMaskPanels
    || zeroFields.some((value) => value !== 0)
    || !audit.auditFingerprint
    || !audit.closurePassed) {
    throw new Error(`P3 MCP 审计未达到正式闭包：${JSON.stringify(audit)}`);
  }
}

function assertSafePreEp32Model(detail: ConstraintDetail): void {
  if (detail.episodeNumber >= 32) throw new Error("安全载荷样本必须来自 EP32 前。");
  const modelText = [
    detail.modelPrompt,
    detail.modelNegativePrompt,
    ...detail.mustAppear.map((entry) => entry.modelInstruction),
    ...detail.mustNotAppear.map((entry) => entry.modelInstruction),
  ].join("\n");
  if (/(?:黄金面具|完整面具|半面具|裂面具|面具口型|\/Users\/|file:\/\/)/iu.test(modelText)) {
    throw new Error(`EP32 前模型载荷泄漏隐藏身份或本地路径：${detail.constraintId}`);
  }
}

function progress(message: string): void {
  process.stderr.write(`[P3 MCP smoke] ${message}\n`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(usage());
    return;
  }
  const input = parseOptions(argv);
  await assertSafeEvidencePath(input);
  const serverPath = path.join(input.workspace, "dist-mcp", "mcp", "server.js");
  if (!await exists(serverPath)) throw new Error(`编译 MCP 不存在：${serverPath}`);
  const sidecar = getSidecarPaths(input.projectRoot);
  const guardedFiles = {
    visualConstraints: sidecar.panelVisualConstraints,
    panelReferences: sidecar.panelReferenceResolutions,
    generationSettings: sidecar.generationSettings,
    generationJobs: sidecar.generationJobs,
    publications: sidecar.publications,
    reviews: sidecar.reviews,
    gridSelections: sidecar.storyboardGridSelections,
    projectIndex: sidecar.index,
    events: sidecar.events,
    commandLedger: sidecar.commandLedger,
  };
  const before = await guardedIdentities(guardedFiles);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    cwd: input.workspace,
    env: { ...process.env, AI_CANVAS_PROJECT_ROOT: input.projectRoot },
    stderr: "pipe",
  });
  const serverStderr: string[] = [];
  transport.stderr?.on("data", (chunk) => serverStderr.push(String(chunk)));
  const client = new Client({ name: "ai-drama-canvas-p3-visual-constraints-smoke", version: "1.0.0" });
  let audit!: PanelVisualConstraintAudit;
  let currentness!: { current: boolean; storeRevision: number; storeFingerprint: string; driftedInputs: string[] };
  let sample!: ConstraintDetail;
  let storeRevision = 0;
  let storeFingerprint = "";
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    const toolNames = tools.tools.map((tool) => tool.name);
    const requiredTools = [
      "audit_fusion_visual_constraints",
      "list_fusion_visual_constraints",
      "get_fusion_visual_constraint",
      "materialize_fusion_visual_constraints",
      "upsert_fusion_visual_constraint_override",
    ];
    if (tools.tools.length !== EXPECTED.tools) throw new Error(`P3 编译 MCP 工具应为 ${EXPECTED.tools}，实际 ${tools.tools.length}。`);
    const missing = requiredTools.filter((name) => !toolNames.includes(name));
    if (missing.length) throw new Error(`P3 编译 MCP 缺少工具：${missing.join("、")}`);
    progress("工具发现通过");

    const capabilities = parse<{
      server?: { toolCount?: number };
      domains?: { fusionProduction?: string[] };
      commandTypes?: string[];
      fusionProduction?: { visualConstraints?: { humanVisualReviewRequired?: boolean; mcpReturnsBinary?: boolean } };
    }>(await client.callTool({ name: "get_capabilities", arguments: { projectRoot: input.projectRoot } }));
    if (capabilities.server?.toolCount !== EXPECTED.tools
      || capabilities.fusionProduction?.visualConstraints?.humanVisualReviewRequired !== true
      || capabilities.fusionProduction.visualConstraints.mcpReturnsBinary !== false
      || requiredTools.slice(0, 3).some((name) => !capabilities.domains?.fusionProduction?.includes(name))
      || requiredTools.slice(3).some((name) => !capabilities.commandTypes?.includes(name))) {
      throw new Error(`P3 capabilities 未完整公开视觉约束合同：${JSON.stringify(capabilities)}`);
    }
    progress("能力合同通过");

    const audited = parse<{
      audit: PanelVisualConstraintAudit;
      currentness: { current: boolean; storeRevision: number; storeFingerprint: string; driftedInputs: string[] };
    }>(await client.callTool({ name: "audit_fusion_visual_constraints", arguments: { projectRoot: input.projectRoot } }));
    audit = audited.audit;
    currentness = audited.currentness;
    assertAudit(audit);
    if (!currentness.current || currentness.driftedInputs.length || currentness.storeRevision < 1 || !currentness.storeFingerprint) {
      throw new Error(`P3 store 不是 current：${JSON.stringify(currentness)}`);
    }
    storeRevision = currentness.storeRevision;
    storeFingerprint = currentness.storeFingerprint;
    progress("全季闭包与 currentness 通过");

    const page = parse<{
      total: number;
      offset: number;
      limit: number;
      storeRevision: number;
      storeFingerprint: string;
      items: ConstraintSummary[];
    }>(await client.callTool({ name: "list_fusion_visual_constraints", arguments: { projectRoot: input.projectRoot, episode: 1, offset: 0, limit: 2 } }));
    if (page.items.length !== 2 || page.total <= 0 || page.storeRevision !== storeRevision || page.storeFingerprint !== storeFingerprint) {
      throw new Error(`P3 分页身份异常：${JSON.stringify(page)}`);
    }
    const serializedPage = JSON.stringify(page.items);
    const forbiddenDetailFields = ["modelPrompt", "modelNegativePrompt", "reviewRules", "warnings", "identityLocks", "spatialLocks", "continuityLocks"];
    if (page.items.some((item) => forbiddenDetailFields.some((key) => Object.prototype.hasOwnProperty.call(item, key)))
      || /(?:base64|data:image)/iu.test(serializedPage)) {
      throw new Error("P3 列表越界返回模型载荷、完整规则或媒体数据。");
    }
    const first = page.items[0]!;
    sample = parse<ConstraintDetail>(await client.callTool({
      name: "get_fusion_visual_constraint",
      arguments: { projectRoot: input.projectRoot, contractId: first.gridContractId, panelId: first.panelId },
    }));
    if (sample.constraintId !== first.constraintId
      || sample.fingerprint !== first.fingerprint
      || sample.modelFingerprint !== first.modelFingerprint
      || sample.reviewRulesFingerprint !== first.reviewRulesFingerprint
      || !sample.inputSnapshot.resolutionId
      || !sample.inputSnapshot.resolutionFingerprint
      || !sample.humanVisualReviewRequired
      || sample.reviewRules.length !== sample.warnings.length) {
      throw new Error(`P3 详情与分页身份或人工规则不一致：${sample.constraintId}`);
    }
    assertSafePreEp32Model(sample);
    progress("分页、详情与模型隔离通过");

    const [concealed, ready, unresolvedSpatial] = await Promise.all([
      client.callTool({ name: "list_fusion_visual_constraints", arguments: { projectRoot: input.projectRoot, hiddenMaskStatus: "concealed", offset: 0, limit: 1 } }).then((value) => parse<{ total: number; items: ConstraintSummary[] }>(value)),
      client.callTool({ name: "list_fusion_visual_constraints", arguments: { projectRoot: input.projectRoot, generationReady: true, offset: 0, limit: 1 } }).then((value) => parse<{ total: number; items: ConstraintSummary[] }>(value)),
      client.callTool({ name: "list_fusion_visual_constraints", arguments: { projectRoot: input.projectRoot, unresolvedSpatialOnly: true, offset: 0, limit: 1 } }).then((value) => parse<{ total: number; items: ConstraintSummary[] }>(value)),
    ]);
    if (concealed.total !== EXPECTED.concealedMaskPanels
      || concealed.items[0]?.hiddenMaskPolicy.status !== "concealed"
      || ready.total !== EXPECTED.generationReadyPanels
      || ready.items[0]?.generationGate.status !== "ready"
      || unresolvedSpatial.total <= 0) {
      throw new Error(`P3 过滤统计异常：${JSON.stringify({ concealed: concealed.total, ready: ready.total, unresolvedSpatial: unresolvedSpatial.total })}`);
    }
    const concealedDetail = parse<ConstraintDetail>(await client.callTool({
      name: "get_fusion_visual_constraint",
      arguments: { projectRoot: input.projectRoot, contractId: concealed.items[0]!.gridContractId, panelId: concealed.items[0]!.panelId },
    }));
    assertSafePreEp32Model(concealedDetail);
    progress("隐藏面具、生成就绪与 unresolved 过滤通过");
  } finally {
    await client.close().catch(() => undefined);
  }

  const after = await guardedIdentities(guardedFiles);
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error("P3 MCP 只读烟测改写了正式工程侧车。");
  const evidence = {
    schemaVersion: 1,
    kind: "p3-visual-constraints-mcp-smoke",
    createdAt: new Date().toISOString(),
    workspace: input.workspace,
    projectRoot: input.projectRoot,
    toolCount: EXPECTED.tools,
    store: { revision: storeRevision, fingerprint: storeFingerprint, current: currentness.current },
    audit,
    sample: {
      constraintId: sample.constraintId,
      gridContractId: sample.gridContractId,
      panelId: sample.panelId,
      episodeNumber: sample.episodeNumber,
      modelPromptSha256: sha256(sample.modelPrompt),
      modelNegativePromptSha256: sha256(sample.modelNegativePrompt),
      localPathOrHiddenIdentityLeak: false,
      reviewRules: sample.reviewRules.length,
      warnings: sample.warnings.length,
    },
    guardedFiles: { before, after, unchanged: true },
    serverStderrTail: serverStderr.join("").split(/\r?\n/u).filter(Boolean).slice(-20),
    vendorOrGenerationInvoked: false,
    passed: true,
  };
  if (input.writeEvidence) {
    await mkdir(path.dirname(input.evidencePath), { recursive: true });
    await writeFile(input.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  }
  process.stdout.write(`${JSON.stringify({
    passed: true,
    evidencePath: input.writeEvidence ? input.evidencePath : undefined,
    toolCount: EXPECTED.tools,
    storeRevision,
    storeFingerprint,
    auditFingerprint: audit.auditFingerprint,
    guardedFilesUnchanged: true,
  }, null, 2)}\n`);
}

await main();
