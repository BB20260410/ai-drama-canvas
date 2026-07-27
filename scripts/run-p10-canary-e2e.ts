/**
 * P10-R 金丝雀：隔离工程 + 双供应方 dispatch/register + 驾驶舱 + 备份恢复 + MCP 只读。
 * 使用夹具媒体登记，不冒充真实 imagegen 批量生产。
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  createStudioP7Fixture,
  seedStudioP7ResolvedContinuity,
} from "../tests/helpers/studio-p7-fixture.js";
import { createBuildIdentity } from "../src/core/build-identity.js";
import {
  createManagedProjectBackup,
  restoreManagedProjectBackup,
  assertRuntimeBuildCurrentness,
} from "../src/core/project-backup.js";
import { getStudioProductionDashboard } from "../src/core/studio-production-dashboard.js";
import { inspectManagedProject } from "../src/core/managed-project.js";
import {
  dispatchStudioGenerationPack,
  freezeAndPersistStudioGenerationPack,
  registerStudioGenerationResult,
} from "../src/core/studio-generation-ledger.js";
import { submitStudioGenerationReview } from "../src/core/studio-generation-review.js";
import { buildStudioAgentImagegenBrief } from "../src/core/studio-generation.js";

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evidenceRoot = path.join(workspace, "docs", "evidence");
const stamp = new Date().toISOString().replace(/[:.]/gu, "-").slice(0, 19);
const outputPath = path.resolve(
  process.argv[2] || path.join(evidenceRoot, `p10-canary-e2e-${stamp}.json`),
);

function parse(result: unknown): Record<string, any> {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return JSON.parse(content.find((entry) => entry.type === "text")?.text ?? "{}") as Record<string, any>;
}

async function withMcp<T>(registryPath: string, run: (client: Client) => Promise<T>): Promise<T> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/mcp/server.ts"],
    cwd: workspace,
    env: { ...process.env, AI_CANVAS_REGISTRY_PATH: registryPath },
    stderr: "pipe",
  });
  const client = new Client({ name: "p10r-canary", version: "0.1.0" });
  await client.connect(transport);
  try {
    return await run(client);
  } finally {
    await client.close();
  }
}

const runtime = await realpath(await mkdtemp(path.join("/tmp", "p10r-canary-")));
const registryPath = path.join(runtime, "projects.json");
const fixture = await createStudioP7Fixture();
await seedStudioP7ResolvedContinuity(fixture);
const identity = await createBuildIdentity(workspace);

// 双供应方：同一冻结包，codex + grok 各登记一格
const sharedPanel = fixture.units.sixPanel.panels[0]!;
const sharedMedia = fixture.panelMediaPairs.find((entry) => entry.panelId === sharedPanel.id)!;
const sharedPack = await freezeAndPersistStudioGenerationPack(fixture.root, {
  unitId: fixture.units.sixPanel.unit.id,
  panelId: sharedPanel.id,
});

async function runProvider(
  media: typeof sharedMedia,
  provider: "codex" | "grok",
  runId: string,
) {
  const brief = buildStudioAgentImagegenBrief(sharedPack.pack, provider);
  if ((brief as { controlReferences?: Array<{ localPath?: string }> }).controlReferences?.some((r) => "localPath" in r && r.localPath)) {
    throw new Error("brief 不得含 localPath");
  }
  await dispatchStudioGenerationPack(fixture.root, {
    packId: sharedPack.packId,
    packFingerprint: sharedPack.fingerprint,
    generationRunId: runId,
    provider,
  });
  const raw = await registerStudioGenerationResult(fixture.root, {
    packId: sharedPack.packId,
    packFingerprint: sharedPack.fingerprint,
    generationRunId: runId,
    variant: "raw",
    mediaSha256: media.raw.imported.sha256,
    provider,
  });
  const labeled = await registerStudioGenerationResult(fixture.root, {
    packId: sharedPack.packId,
    packFingerprint: sharedPack.fingerprint,
    generationRunId: runId,
    variant: "labeled",
    mediaSha256: media.labeled.imported.sha256,
    provider,
  });
  await submitStudioGenerationReview(fixture.root, {
    operationId: `p10r-review-${runId}`,
    generationRunId: runId,
    kind: "observation",
    expectedHeadRevision: 0,
    rawResultId: raw.resultId,
    rawSha256: raw.mediaSha256,
    labeledResultId: labeled.resultId,
    labeledSha256: labeled.mediaSha256,
    expectedPackFingerprint: sharedPack.fingerprint,
    continuityFingerprint: sharedPack.pack.continuity.fingerprint,
    decision: "pass",
    criteria: [
      { code: "identity-consistency", status: "pass", note: "canary" },
      { code: "raw-labeled-pair", status: "pass", note: "canary" },
    ],
    reviewer: "p10r-canary",
    note: `P10-R ${provider} 夹具 Review`,
  });
  return {
    provider,
    packId: sharedPack.packId,
    packFingerprint: sharedPack.fingerprint,
    executorKind: sharedPack.pack.request.executorKind,
    allowedProviders: sharedPack.pack.request.allowedProviders,
    rawSha: raw.mediaSha256,
    labeledSha: labeled.mediaSha256,
    briefHasLocalPath: false,
  };
}

const codexRun = await runProvider(sharedMedia, "codex", "p10r-codex-run");
const grokRun = await runProvider(sharedMedia, "grok", "p10r-grok-run");
if (codexRun.packId !== grokRun.packId || codexRun.packFingerprint !== grokRun.packFingerprint) {
  throw new Error("双供应方没有消费同一个冻结包，P10 canary 失败关闭。");
}

const first = await withMcp(registryPath, async (client) => {
  const tools = await client.listTools();
  const capabilities = parse(await client.callTool({ name: "get_capabilities", arguments: {} }));
  const overview = parse(await client.callTool({
    name: "get_studio_production_dashboard",
    arguments: { projectRoot: fixture.root, query: { operation: "overview" } },
  }));
  const readiness = parse(await client.callTool({
    name: "get_studio_generation_control",
    arguments: {
      projectRoot: fixture.root,
      query: {
        operation: "readiness",
        unitId: fixture.units.twoPanel.unit.id,
        panelId: fixture.units.twoPanel.panels[0]!.id,
      },
    },
  }));
  const readinessJson = JSON.stringify(readiness);
  if (readinessJson.includes('"localPath"')) {
    throw new Error("readiness 响应泄漏 localPath");
  }
  return {
    toolCount: tools.tools.length,
    capabilitiesToolCount: capabilities.server?.toolCount,
    formalProviders: capabilities.reliability?.formalImagegenProviders
      ?? capabilities.buildIdentity?.capabilities?.formalImagegenProviders,
    overviewFingerprint: overview.fingerprint,
    readinessStatus: readiness.status,
  };
});

const second = await withMcp(registryPath, async (client) => {
  const overview = parse(await client.callTool({
    name: "get_studio_production_dashboard",
    arguments: { projectRoot: fixture.root, query: { operation: "overview" } },
  }));
  const six = parse(await client.callTool({
    name: "get_studio_production_dashboard",
    arguments: {
      projectRoot: fixture.root,
      query: {
        operation: "unit",
        unitId: fixture.units.sixPanel.unit.id,
        panelId: fixture.units.sixPanel.panels[0]!.id,
      },
    },
  }));
  return {
    overviewFingerprint: overview.fingerprint,
    sixPanelCount: six.panels?.length,
    sixNextAction: six.nextAction?.code,
  };
});

const coreOverview = await getStudioProductionDashboard(fixture.root, { operation: "overview" });
if (coreOverview.operation !== "overview") throw new Error("core overview 失败");
if (coreOverview.fingerprint !== first.overviewFingerprint || first.overviewFingerprint !== second.overviewFingerprint) {
  throw new Error("重启前后 overview fingerprint 不一致");
}

const backup = await createManagedProjectBackup(fixture.root, path.join(runtime, "backups"));
const restored = await restoreManagedProjectBackup(backup.backupRoot, path.join(runtime, "restores"));
await inspectManagedProject(restored.projectRoot);
await expectRejectDuplicateRestore(backup.backupRoot, path.join(runtime, "restores"));

const buildGate = await assertRuntimeBuildCurrentness({
  workspace,
  recordedSourceDigest: identity.sourceDigest,
});
if (!buildGate.allowed) throw new Error(buildGate.reason ?? "build gate denied");

const evidence = {
  schemaVersion: 2,
  kind: "p10-canary-e2e",
  status: "pass",
  createdAt: new Date().toISOString(),
  buildIdentity: {
    buildId: identity.buildId,
    sourceDigest: identity.sourceDigest,
    fingerprint: identity.fingerprint,
    capabilities: identity.capabilities,
  },
  mcp: {
    toolCount: first.toolCount,
    capabilitiesToolCount: first.capabilitiesToolCount,
    formalImagegenProviders: first.formalProviders,
  },
  dualProvider: {
    sameAllowedProviders: JSON.stringify(codexRun.allowedProviders) === JSON.stringify(grokRun.allowedProviders),
    sameFrozenPack: codexRun.packId === grokRun.packId
      && codexRun.packFingerprint === grokRun.packFingerprint,
    sharedPanelId: sharedPanel.id,
    codex: codexRun,
    grok: grokRun,
  },
  canary: {
    twoPanelUnitId: fixture.units.twoPanel.unit.id,
    sixPanelUnitId: fixture.units.sixPanel.unit.id,
    longChinesePresent: Boolean(fixture.units.twoPanel.panels[0]?.dialogue && fixture.units.twoPanel.panels[0]!.dialogue.length > 4),
    sixPanelCount: second.sixPanelCount,
    sixNextAction: second.sixNextAction,
    restartFingerprintMatch: true,
    readinessNoLocalPath: true,
  },
  backupRestore: {
    schemaVersion: backup.manifest.schemaVersion,
    fileCount: backup.manifest.fileCount,
    hasPerFileSha: Array.isArray(backup.manifest.files) && backup.manifest.files.length === backup.manifest.fileCount,
    restoredProjectId: restored.manifest.projectId,
    duplicateRestoreRejected: true,
  },
  boundaries: {
    formalImageGenerationCalls: 0,
    realImagegenCanary: false,
    browserSupplierCalls: 0,
    gitStage: 0,
    fixtureMediaUsed: true,
  },
};

async function expectRejectDuplicateRestore(backupRoot: string, restoreParent: string) {
  try {
    await restoreManagedProjectBackup(backupRoot, restoreParent);
    throw new Error("重复恢复应失败");
  } catch (error) {
    if (!(error instanceof Error) || !/已存在/.test(error.message)) throw error;
  }
}

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
await fixture.cleanup();
await rm(runtime, { recursive: true, force: true });
console.log(JSON.stringify({
  ok: true,
  outputPath,
  sha256: createHash("sha256").update(JSON.stringify(evidence)).digest("hex"),
  toolCount: first.toolCount,
  expectedToolCount: identity.capabilities.mcpToolCount,
  dualProviders: ["codex", "grok"],
}, null, 2));
