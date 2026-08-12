import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { createManagedProject } from "../src/core/managed-project.js";
import { recordStudioDetachedGenerationUnknownObservation } from "../src/core/studio-generation-ledger.js";
import { registerProject, setActiveProjectRegistration } from "../src/core/sidecar.js";
import {
  createStudioP7Fixture,
  seedStudioP7ResolvedContinuity,
  seedStudioP7ResolvedPanelContinuity,
  studioP7UserContinuationWaiver,
} from "./helpers/studio-p7-fixture.js";
import { EXPECTED_MCP_TOOL_COUNT } from "./helpers/mcp-tool-count.js";

const roots: string[] = [];
const originalRegistryPath = process.env.AI_CANVAS_REGISTRY_PATH;

afterEach(async () => {
  if (originalRegistryPath === undefined) delete process.env.AI_CANVAS_REGISTRY_PATH;
  else process.env.AI_CANVAS_REGISTRY_PATH = originalRegistryPath;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function parsed(result: unknown): Record<string, any> {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return JSON.parse(content.find((entry) => entry.type === "text")?.text ?? "{}") as Record<string, any>;
}

async function createClient(runtimeRoot: string, compiledServerPath?: string): Promise<Client> {
  const cwd = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: compiledServerPath ? [compiledServerPath] : ["--import", "tsx", "src/mcp/server.ts"],
    cwd,
    env: { ...process.env, AI_CANVAS_REGISTRY_PATH: path.join(runtimeRoot, "projects.json") },
    stderr: "pipe",
  });
  const client = new Client({ name: "managed-studio-mcp-test", version: "0.1.0" });
  await client.connect(transport);
  return client;
}

function commandArguments(projectRoot: string, index: number, request: Record<string, unknown>) {
  const suffix = String(index).padStart(3, "0");
  return {
    projectRoot,
    requestId: `managed-studio-request-${suffix}`,
    idempotencyKey: `managed-studio-key-${suffix}`,
    request,
  };
}

async function execute(client: Client, projectRoot: string, index: number, request: Record<string, unknown>) {
  const record = parsed(await client.callTool({
    name: "execute_command",
    arguments: commandArguments(projectRoot, index, request),
  }));
  expect(record).toMatchObject({ status: "succeeded", replayed: false });
  expect(record).not.toHaveProperty("durableReconciliation");
  expect(record).not.toHaveProperty("storageRoot");
  return record.result as Record<string, any>;
}

async function captureMcpFailure(call: Promise<unknown>): Promise<string> {
  try {
    const result = await call as { isError?: boolean; content?: unknown };
    expect(result.isError).toBe(true);
    return JSON.stringify(result);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function expectNoPrivateStoragePaths(value: unknown): void {
  const serialized = JSON.stringify(value);
  expect(serialized).not.toMatch(/"(?:objectPath|bodyPath|databasePath|objectRoot|textCasRoot|thumbnailRoot|packCasRoot|packCasPath|contentRelpath|localPath)"\s*:/u);
  expect(serialized).not.toMatch(/[\\/]\.aicanvas[\\/](?:objects[\\/]sha256|studio-production[\\/]objects[\\/]sha256|studio-generation[\\/]objects[\\/]sha256)[\\/]/u);
  expect(serialized).not.toMatch(/data:[^;,]+;base64,/iu);
}

function expectOnlyVerifiedControlLocalPaths(value: Record<string, any>, expectedPath: string): void {
  expect(value).toMatchObject({
    operation: "pack",
    status: "ready",
    controlReferencesExposed: true,
    request: { controlReferences: [{ localPath: expectedPath }] },
    pack: { request: { controlReferences: [{ localPath: expectedPath }] } },
  });
  const withoutAllowedPaths = JSON.parse(JSON.stringify(value, (key, entry) => key === "localPath" ? undefined : entry));
  expectNoPrivateStoragePaths(withoutAllowedPaths);
}

describe("受管素材中心 MCP", () => {
  it("通过显式受管根读取分页投影，并仅通过命令总线写入", async () => {
    const runtimeRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "ai-canvas-mcp-managed-studio-")));
    roots.push(runtimeRoot);
    const projectRoot = (await createManagedProject({ parentRoot: runtimeRoot, name: "MCP 受管素材工程" })).paths.root;
    const sourcePath = path.join(runtimeRoot, "ahang-reference.png");
    await sharp({ create: { width: 16, height: 16, channels: 3, background: "#71614f" } }).png().toFile(sourcePath);
    const secondSourcePath = path.join(runtimeRoot, "ahang-reference-authority-copy.png");
    await writeFile(secondSourcePath, await readFile(sourcePath));
    const client = await createClient(runtimeRoot);
    try {
      const tools = await client.listTools();
      expect(tools.tools.length).toBe(EXPECTED_MCP_TOOL_COUNT);
      const readNames = [
        "get_managed_studio_overview",
        "list_studio_assets",
        "list_studio_media",
        "list_studio_media_import_origins",
        "list_studio_text_documents",
        "list_studio_production_units",
        "query_studio_asset_timeline",
        "get_studio_asset",
        "get_studio_text_revision",
        "get_studio_production_unit_snapshot",
        "get_studio_generation_control",
        "get_dudu_readonly_import_control",
        "get_studio_video_package_control",
        "get_studio_binding_control",
      ];
      for (const name of readNames) {
        const tool = tools.tools.find((entry) => entry.name === name);
        expect(tool?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
        expect((tool?.inputSchema as { required?: string[] }).required).toContain("projectRoot");
        expect((tool?.inputSchema as { properties?: { projectRoot?: { default?: string } } }).properties?.projectRoot?.default).toBeUndefined();
      }
      const duduDiscovery = tools.tools.find((entry) => entry.name === "discover_dudu_readonly_import_projects");
      expect(duduDiscovery?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
      expect((duduDiscovery?.inputSchema as { required?: string[] }).required).toContain("projectsRoot");
      const mediaOriginsSchema = tools.tools.find((entry) => entry.name === "list_studio_media_import_origins")?.inputSchema as {
        properties?: Record<string, unknown>;
        required?: string[];
      };
      expect(mediaOriginsSchema.required).toEqual(expect.arrayContaining(["projectRoot", "mediaSha256"]));
      expect(mediaOriginsSchema.required).not.toEqual(expect.arrayContaining(["cursor", "limit"]));
      expect(mediaOriginsSchema.properties).toEqual(expect.objectContaining({ projectRoot: expect.anything(), mediaSha256: expect.anything(), cursor: expect.anything(), limit: expect.anything() }));
      const generationControlSchema = tools.tools.find((entry) => entry.name === "get_studio_generation_control")?.inputSchema as {
        properties?: { query?: { oneOf?: Array<{ properties?: { operation?: { const?: string } } }>; anyOf?: Array<{ properties?: { operation?: { const?: string } } }> } };
      };
      const generationControlVariants = generationControlSchema.properties?.query?.oneOf ?? generationControlSchema.properties?.query?.anyOf ?? [];
      expect([...new Set(generationControlVariants.map((variant) => variant.properties?.operation?.const))])
        .toEqual(["session-snapshot", "readiness", "pack", "history", "plan", "call", "active-runs", "detached-unknown"]);
      expect(generationControlVariants).toEqual(expect.arrayContaining([
        expect.objectContaining({
          properties: expect.objectContaining({
            operation: { type: "string", const: "session-snapshot" },
            unitId: expect.any(Object),
            panelId: expect.any(Object),
          }),
          required: ["operation", "unitId"],
        }),
        expect.objectContaining({
          properties: expect.objectContaining({
            operation: { type: "string", const: "readiness" },
            targetKind: { type: "string", const: "unit-grid" },
            unitId: expect.any(Object),
          }),
          required: ["operation", "targetKind", "unitId"],
        }),
        expect.objectContaining({
          properties: expect.objectContaining({
            operation: { type: "string", const: "history" },
            targetKind: { type: "string", const: "unit-grid" },
            unitId: expect.any(Object),
          }),
          required: ["operation", "targetKind", "unitId"],
        }),
      ]));

      const executeSchema = tools.tools.find((tool) => tool.name === "execute_command")?.inputSchema as {
        properties?: { request?: { oneOf?: Array<{ properties?: { command?: { const?: string }; payload?: { properties?: Record<string, unknown>; required?: string[] } } }>; anyOf?: Array<{ properties?: { command?: { const?: string }; payload?: { properties?: Record<string, unknown>; required?: string[] } } }> } };
      };
      const variants = executeSchema.properties?.request?.oneOf ?? executeSchema.properties?.request?.anyOf ?? [];
      const studioCommands = [
        "import_studio_media",
        "create_studio_asset",
        "update_studio_asset",
        "append_studio_asset_relation",
        "append_studio_asset_version",
        "review_studio_asset_version",
        "set_studio_primary_authority",
        "create_studio_script_document",
        "create_studio_prompt_document",
        "append_studio_script_revision",
        "append_studio_prompt_revision",
        "create_studio_production_unit",
        "revise_studio_production_unit",
        "freeze_studio_generation_pack",
        "dispatch_studio_generation_pack",
        "prepare_studio_imagegen_call",
        "reconcile_studio_imagegen_call",
        "abandon_studio_generation_unknown",
        "abandon_studio_detached_generation_unknown",
        "rebind_studio_imagegen_call_context",
        "register_studio_generation_result",
        "commit_agent_imagegen_result_bundle",
      ];
      const p30OrchestrationCommands = [
        "stage_dudu_readonly_managed_project",
        "finalize_dudu_readonly_managed_project",
        "prepare_studio_video_package_export",
        "build_studio_video_package",
      ];
      expect(variants.map((variant) => variant.properties?.command?.const))
        .toEqual(expect.arrayContaining([...studioCommands, ...p30OrchestrationCommands]));
      const createAssetVariant = variants.find((variant) => variant.properties?.command?.const === "create_studio_asset");
      const updateAssetVariant = variants.find((variant) => variant.properties?.command?.const === "update_studio_asset");
      expect(createAssetVariant?.properties?.payload?.properties).toHaveProperty("applicability");
      expect(updateAssetVariant?.properties?.payload?.properties).toHaveProperty("applicability");
      const relationVariant = variants.find((variant) => variant.properties?.command?.const === "append_studio_asset_relation");
      expect(relationVariant?.properties?.payload?.required).toEqual([
        "kind",
        "subjectAssetId",
        "objectAssetId",
        "expectedSubjectRevision",
        "expectedObjectRevision",
      ]);
      expect(relationVariant?.properties?.payload?.properties).toEqual(expect.objectContaining({
        supersedesRelationId: expect.any(Object),
        ordinal: expect.any(Object),
        role: expect.any(Object),
        note: expect.any(Object),
      }));
      const appendVersionVariant = variants.find((variant) => variant.properties?.command?.const === "append_studio_asset_version");
      expect(appendVersionVariant?.properties?.payload?.properties?.reviewStatus).toMatchObject({ const: "pending" });
      const unitVariant = variants.find((variant) => variant.properties?.command?.const === "create_studio_production_unit");
      expect(unitVariant?.properties?.payload?.required).toEqual(expect.arrayContaining(["expectedRevision", "season", "episode", "sequence", "title", "scriptRevisionId", "panels"]));
      const freezeVariant = variants.find((variant) => variant.properties?.command?.const === "freeze_studio_generation_pack");
      const freezePayloadSchema = freezeVariant?.properties?.payload as {
        oneOf?: Array<{ required?: string[] }>;
        anyOf?: Array<{ required?: string[] }>;
      } | undefined;
      const freezeTargets = freezePayloadSchema?.oneOf ?? freezePayloadSchema?.anyOf ?? [];
      expect(freezeTargets.map((target) => target.required)).toEqual(expect.arrayContaining([
        ["unitId", "panelId", "expectedRevision"],
        ["targetKind", "unitId", "expectedRevision"],
      ]));
      const dispatchVariant = variants.find((variant) => variant.properties?.command?.const === "dispatch_studio_generation_pack");
      expect(dispatchVariant?.properties?.payload?.required).toEqual([
        "packId",
        "packFingerprint",
        "generationRunId",
        "provider",
        "expectedRevision",
      ]);
      const registerVariant = variants.find((variant) => variant.properties?.command?.const === "register_studio_generation_result");
      expect(registerVariant?.properties?.payload?.required).toEqual(["packId", "packFingerprint", "generationRunId", "variant", "mediaSha256", "expectedRevision"]);
      expect(registerVariant?.properties?.payload?.properties).toHaveProperty("provider");
      const prepareCallVariant = variants.find((variant) => variant.properties?.command?.const === "prepare_studio_imagegen_call");
      expect(prepareCallVariant?.properties?.payload?.required).toEqual([
        "projectContextToken",
        "packId",
        "packFingerprint",
        "generationRunId",
        "provider",
        "expectedRevision",
      ]);
      expect(prepareCallVariant?.properties?.payload?.properties).toHaveProperty("callerAgentId");
      expect(prepareCallVariant?.properties?.payload?.properties?.expectedRevision).toMatchObject({ const: 0 });
      const reconcileCallVariant = variants.find((variant) => variant.properties?.command?.const === "reconcile_studio_imagegen_call");
      expect(reconcileCallVariant?.properties?.payload?.required).toEqual([
        "callId",
        "projectContextToken",
        "result",
        "evidenceReference",
        "evidenceFingerprint",
        "expectedRevision",
      ]);
      const abandonCallVariant = variants.find((variant) => variant.properties?.command?.const === "abandon_studio_generation_unknown");
      expect(abandonCallVariant?.properties?.payload?.required).toEqual([
        "callId",
        "generationRunId",
        "projectContextToken",
        "evidenceReference",
        "evidenceFingerprint",
        "reason",
        "acknowledgeRemoteMayExist",
        "acknowledgeLateResultWillBeRejected",
        "expectedRevision",
      ]);
      expect(abandonCallVariant?.properties?.payload?.properties?.acknowledgeRemoteMayExist).toMatchObject({ const: true });
      expect(abandonCallVariant?.properties?.payload?.properties?.acknowledgeLateResultWillBeRejected).toMatchObject({ const: true });
      expect(abandonCallVariant?.properties?.payload?.properties?.expectedRevision).toMatchObject({ const: 0 });
      const abandonDetachedVariant = variants.find(
        (variant) => variant.properties?.command?.const === "abandon_studio_detached_generation_unknown",
      );
      expect(abandonDetachedVariant?.properties?.payload?.required).toEqual([
        "observationId",
        "expectedObservationFingerprint",
        "projectContextToken",
        "authorizationEvidenceReference",
        "authorizationText",
        "authorizationTextSha256",
        "reason",
        "acknowledgeRemoteGenerationMayExist",
        "acknowledgeDetachedCandidateWillNeverBeImportedOrReused",
        "acknowledgeFreshFormalRunMayDuplicateRemoteGeneration",
        "expectedRevision",
      ]);
      const rebindCallVariant = variants.find((variant) => variant.properties?.command?.const === "rebind_studio_imagegen_call_context");
      expect(rebindCallVariant?.properties?.payload?.required).toEqual([
        "callId",
        "generationRunId",
        "packId",
        "packFingerprint",
        "inputFingerprint",
        "candidateSha256",
        "receiptSha256",
        "projectContextToken",
        "evidenceReference",
        "evidenceFingerprint",
        "reason",
        "acknowledgeBuildChangedAfterInvocation",
        "acknowledgeNoSecondModelCall",
        "expectedRevision",
      ]);
      expect(rebindCallVariant?.properties?.payload?.properties?.acknowledgeBuildChangedAfterInvocation)
        .toMatchObject({ const: true });
      expect(rebindCallVariant?.properties?.payload?.properties?.acknowledgeNoSecondModelCall)
        .toMatchObject({ const: true });
      expect(rebindCallVariant?.properties?.payload?.properties?.expectedRevision).toMatchObject({ const: 0 });
      const bundleVariant = variants.find((variant) => variant.properties?.command?.const === "commit_agent_imagegen_result_bundle");
      expect(bundleVariant?.properties?.payload?.required).toEqual([
        "projectContextToken",
        "packId",
        "packFingerprint",
        "generationRunId",
        "provider",
        "rawPath",
        "rawSha256",
        "expectedRevision",
        "executionReceipt",
      ]);
      const executionReceiptSchema = bundleVariant?.properties?.payload?.properties?.executionReceipt as {
        required?: string[];
        properties?: Record<string, unknown>;
      } | undefined;
      expect(executionReceiptSchema?.required).toEqual([
        "schemaVersion",
        "kind",
        "provider",
        "source",
        "attestationLevel",
        "cryptographicProviderReceipt",
        "callId",
        "model",
        "generatedAt",
      ]);
      const stageDuduVariant = variants.find((variant) => variant.properties?.command?.const === "stage_dudu_readonly_managed_project");
      expect(stageDuduVariant?.properties?.payload?.required).toEqual([
        "projectsRoot",
        "source",
        "expectedRevision",
        "expectedDiscoveryFingerprint",
      ]);
      expect(stageDuduVariant?.properties?.payload?.properties?.expectedRevision).toMatchObject({ const: 0 });
      expect(stageDuduVariant?.properties?.payload?.properties).toEqual(expect.objectContaining({
        detachedUnknownObservations: expect.any(Object),
      }));
      const finalizeDuduVariant = variants.find((variant) => variant.properties?.command?.const === "finalize_dudu_readonly_managed_project");
      expect(finalizeDuduVariant?.properties?.payload?.required).toEqual([
        "source",
        "expectedRevision",
        "expectedDiscoveryFingerprint",
        "expectedImportFingerprint",
        "expectedControlFingerprint",
      ]);
      expect(finalizeDuduVariant?.properties?.payload?.properties?.expectedRevision).toMatchObject({ const: 0 });
      const prepareVideoVariant = variants.find((variant) => variant.properties?.command?.const === "prepare_studio_video_package_export");
      expect(prepareVideoVariant?.properties?.payload?.required).toEqual([
        "authority",
        "expectedRevision",
        "expectedControlFingerprint",
      ]);
      const buildVideoVariant = variants.find((variant) => variant.properties?.command?.const === "build_studio_video_package");
      expect(buildVideoVariant?.properties?.payload?.required).toEqual([
        "intentId",
        "expectedRevision",
        "expectedIntentControlFingerprint",
        "expectedAuthorityControlFingerprint",
        "destinationPolicy",
      ]);
      expect(buildVideoVariant?.properties?.payload?.properties?.destinationPolicy)
        .toMatchObject({ const: "managed-evidence-only" });

      const capabilities = parsed(await client.callTool({ name: "get_capabilities", arguments: {} }));
      expect(capabilities).toMatchObject({
        server: { toolCount: EXPECTED_MCP_TOOL_COUNT },
        domains: { managedStudio: expect.arrayContaining(readNames) },
        commandTypes: expect.arrayContaining([...studioCommands, ...p30OrchestrationCommands]),
        managedStudio: {
          managedManifestFailClosed: true,
          writes: "execute_command-only",
          projectRoot: "explicit-or-zero-param-active-managed-context",
          activeContext: {
            tool: "get_active_managed_studio_context",
            parameters: "none",
            selection: "explicit-active-registration-only-never-first-project",
          },
          unitContract: {
            season: "required-explicit-nonempty",
            sequenceScope: "unique-within-season-and-episode",
            episodeAbsoluteSeconds: "sum(preceding real unit durations)+missing legacy slots*15+unitLocalSeconds",
          },
          mediaReadProjection: "metadata-only-no-objectPath-or-thumbnail-path",
          mediaOriginReadProjection: "explicit-sha-query-project-relative-or-external-absolute-no-cas-path-no-scan",
          textReadProjection: "body-without-bodyPath",
          assetKnowledge: {
            structuredApplicability: ["projects", "seasons", "episodes", "units", "timeRanges", "tags"],
            relationKinds: ["derived_from", "variant_of", "reference_of", "composite_member"],
            relationReadProjection: "get_studio_asset.relations",
            relationWriteCommand: "append_studio_asset_relation",
            relationConcurrency: "subject-and-object-revision-cas",
            relationSchema: "append-only-v2-superseding-heads",
            relationRecovery: "explicit-same-semantic-rebase",
            relationStatuses: ["current", "stale", "superseded"],
          },
          genericMediaIsNotGenerationControlPackage: true,
          generationControl: {
            tool: "get_studio_generation_control",
            operations: ["session-snapshot", "readiness", "pack", "history", "plan", "call", "active-runs", "detached-unknown"],
            readinessAndHistoryPaths: "none",
            frozenPackCasPathExposure: "none",
            directWriteTools: false,
            writes: "execute_command-only",
            targetKinds: ["panel", "unit-grid"],
            writeCommands: ["freeze_studio_generation_pack", "dispatch_studio_generation_pack", "prepare_studio_imagegen_call", "reconcile_studio_imagegen_call", "abandon_studio_generation_unknown", "abandon_studio_detached_generation_unknown", "rebind_studio_imagegen_call_context", "commit_agent_imagegen_result_bundle", "register_studio_generation_result", "create_studio_generation_plan", "fail_studio_generation_run", "cancel_studio_generation_run", "retry_studio_generation_plan_nodes"],
            unitGridPreCall: "prepare_studio_imagegen_call-first-success-only-callAllowed-true-replay-false",
            preferredWriteback: "commit_agent_imagegen_result_bundle-v4-v5-provider-required-atomic-pair",
          },
          duduImportControl: {
            tools: ["discover_dudu_readonly_import_projects", "get_dudu_readonly_import_control"],
            discovery: "bounded-direct-children-zero-one-conflict-never-select-first",
            directWriteTools: false,
            writes: "execute_command-only",
            writeCommands: ["stage_dudu_readonly_managed_project", "finalize_dudu_readonly_managed_project"],
            stageCommandRoot: "<projectsRoot>/.aicanvas-dudu-import-transactions",
            stageFinalizeExposure: "execute-command-only-no-named-tools",
          },
          videoPackageControl: {
            tool: "get_studio_video_package_control",
            selectors: ["intent", "authority-latest"],
            directWriteTools: false,
            writes: "execute_command-only",
            writeCommands: ["prepare_studio_video_package_export", "build_studio_video_package"],
            builderExecution: "managed-evidence-only-via-execute-command",
            dynamicVideoModel: "never",
          },
        },
      });

      const initialOverview = parsed(await client.callTool({ name: "get_managed_studio_overview", arguments: { projectRoot } }));
      expect(initialOverview).toMatchObject({
        kind: "managed-studio-overview",
        material: { counts: { canonicalAssets: 0, media: 0 } },
        production: { counts: { textDocuments: 0, units: 0 } },
      });
      expect(JSON.stringify(initialOverview)).not.toContain(projectRoot);

      const asset = await execute(client, projectRoot, 1, {
        command: "create_studio_asset",
        payload: {
          id: "character-ahang",
          category: "character",
          name: "阿航",
          aliases: ["青年阿航"],
          identityFeatures: ["固定脸", "左侧银白挑染"],
          positiveLocks: ["黑衣", "古蜀电影写实"],
          negativeLocks: ["禁止换脸", "禁止现代服饰"],
          defaultPrompt: "电影写实，保持阿航固定脸与黑衣。",
          expectedRevision: 0,
        },
      });
      expect(asset).toMatchObject({ id: "character-ahang", revision: 1 });

      const media = await execute(client, projectRoot, 2, {
        command: "import_studio_media",
        payload: { sourcePath, kind: "image" },
      });
      expect(media).toMatchObject({ kind: "image", sourceBasename: "ahang-reference.png", derivativeStatus: "ready" });
      expect(media.sha256).toMatch(/^[a-f0-9]{64}$/u);
      const duplicateMedia = await execute(client, projectRoot, 200, {
        command: "import_studio_media",
        payload: { sourcePath: secondSourcePath, kind: "image", expectedSha256: media.sha256 },
      });
      expect(duplicateMedia).toMatchObject({ sha256: media.sha256, sourceBasename: "ahang-reference.png" });

      const appended = await execute(client, projectRoot, 3, {
        command: "append_studio_asset_version",
        payload: {
          assetId: "character-ahang",
          mediaSha256: media.sha256,
          reviewStatus: "pending",
          sourceNote: "阿航青年三视图权威来源",
          expectedRevision: 1,
        },
      });
      const versionId = appended.version.id as string;
      expect(appended).toMatchObject({
        assetRevision: 2,
        version: { assetId: "character-ahang", reviewStatus: "pending", sourceNote: "阿航青年三视图权威来源" },
      });

      const reviewed = await execute(client, projectRoot, 4, {
        command: "review_studio_asset_version",
        payload: { assetId: "character-ahang", versionId, decision: "approved", expectedRevision: 2, note: "人物固定脸与服饰验收通过。" },
      });
      expect(reviewed).toMatchObject({ id: "character-ahang", revision: 3 });

      const authoritative = await execute(client, projectRoot, 5, {
        command: "set_studio_primary_authority",
        payload: { assetId: "character-ahang", versionId, expectedRevision: 3, note: "提升为当前生成权威。" },
      });
      expect(authoritative).toMatchObject({ id: "character-ahang", revision: 4, primaryAuthority: { versionId } });

      await execute(client, projectRoot, 6, {
        command: "create_studio_script_document",
        payload: { id: "script-ep01", title: "EP01 剧本", expectedRevision: 0 },
      });
      const scriptRevision = await execute(client, projectRoot, 7, {
        command: "append_studio_script_revision",
        payload: { documentId: "script-ep01", expectedRevision: 0, body: "阿航进入石室，在石门前停步。", source: "codex", sourceVersion: "v1" },
      });
      const scriptRevisionId = scriptRevision.revision.id as string;

      await execute(client, projectRoot, 8, {
        command: "create_studio_prompt_document",
        payload: { id: "prompt-ep01", title: "EP01 宫格提示词", expectedRevision: 0 },
      });
      const promptRevision = await execute(client, projectRoot, 9, {
        command: "append_studio_prompt_revision",
        payload: { documentId: "prompt-ep01", expectedRevision: 0, body: "电影写实，固定阿航身份与石室布局。", source: "codex", sourceVersion: "v1" },
      });
      const promptRevisionId = promptRevision.revision.id as string;

      const unit = await execute(client, projectRoot, 10, {
        command: "create_studio_production_unit",
        payload: {
          id: "unit-ep01-001",
          expectedRevision: 0,
          season: "S03",
          episode: "EP01",
          sequence: 1,
          title: "进入石室",
          scriptRevisionId,
          panels: [
            {
              id: "panel-01",
              title: "入场",
              visualAction: "阿航进入石室。",
              shotComposition: "中景，纵深构图。",
              filmingMethod: "稳定器缓慢跟拍。",
              startSeconds: 0,
              endSeconds: 7,
              durationSeconds: 7,
              promptRevisionId,
              sourceSpans: [{ startOffsetUtf16: 0, endOffsetUtf16: "阿航进入石室，在石门前停步。".length }],
              assets: [{ assetId: "character-ahang", category: "character", presence: "required", role: "主角", continuityState: "固定脸、黑衣、左侧银白挑染。", evidence: [{ kind: "asset-definition", reference: "character-ahang", note: "规范资产" }] }],
            },
            {
              id: "panel-02",
              title: "停步",
              visualAction: "阿航在石门前停步。",
              shotComposition: "近景，人物居中。",
              filmingMethod: "50mm 缓推。",
              startSeconds: 7,
              endSeconds: 15,
              durationSeconds: 8,
              promptRevisionId,
              sourceSpans: [{ startOffsetUtf16: 0, endOffsetUtf16: "阿航进入石室，在石门前停步。".length }],
              assets: [{ assetId: "character-ahang", category: "character", presence: "required", role: "主角", continuityState: "承接上一格站位与服装。", evidence: [{ kind: "timeline", reference: "panel-01", note: "连续站位" }] }],
            },
          ],
        },
      });
      expect(unit).toMatchObject({ unit: { id: "unit-ep01-001", durationSeconds: 15, panelCount: 2 } });

      const bindingBefore = parsed(await client.callTool({
        name: "get_studio_binding_control",
        arguments: { projectRoot, query: { operation: "get_control", unitId: "unit-ep01-001" } },
      }));
      await execute(client, projectRoot, 101, {
        command: "analyze_studio_script_entities",
        payload: {
          unitId: "unit-ep01-001",
          panelId: "panel-01",
          expectedRevisionToken: bindingBefore.revisionToken,
        },
      });
      const bindingAnalyzed = parsed(await client.callTool({
        name: "get_studio_binding_control",
        arguments: { projectRoot, query: { operation: "get_control", unitId: "unit-ep01-001" } },
      }));
      const ahangProposal = bindingAnalyzed.panels[0].proposals.find((proposal: Record<string, any>) => proposal.entityText === "阿航");
      expect(ahangProposal).toMatchObject({ status: "matched", matchedAssetId: "character-ahang" });
      await execute(client, projectRoot, 102, {
        command: "resolve_studio_entity_proposal",
        payload: {
          unitId: "unit-ep01-001",
          panelId: "panel-01",
          proposalId: ahangProposal.id,
          decision: "accept",
          selectedAssetId: "character-ahang",
          presence: "required",
          role: "主角",
          expectedRevisionToken: bindingAnalyzed.revisionToken,
          reviewer: "codex",
        },
      });
      const bindingResolved = parsed(await client.callTool({
        name: "get_studio_binding_control",
        arguments: { projectRoot, query: { operation: "get_control", unitId: "unit-ep01-001" } },
      }));
      await execute(client, projectRoot, 103, {
        command: "freeze_studio_asset_binding_set",
        payload: {
          unitId: "unit-ep01-001",
          panelId: "panel-01",
          expectedRevisionToken: bindingResolved.revisionToken,
        },
      });
      const bindingReady = parsed(await client.callTool({
        name: "get_studio_binding_control",
        arguments: { projectRoot, query: { operation: "get_control", unitId: "unit-ep01-001" } },
      }));
      expect(bindingReady.panels[0]).toMatchObject({ status: "generation-ready", bindingSet: { currentness: "current" } });

      await seedStudioP7ResolvedPanelContinuity(projectRoot, {
        unitId: "unit-ep01-001",
        panelId: "panel-01",
        assetIds: ["character-ahang"],
      });

      const unitRevision = unit.unit.revision as number;
      const frozen = await execute(client, projectRoot, 11, {
        command: "freeze_studio_generation_pack",
        payload: { unitId: "unit-ep01-001", panelId: "panel-01", expectedRevision: unitRevision },
      });
      expectNoPrivateStoragePaths(frozen);
      const dispatched = await execute(client, projectRoot, 110, {
        command: "dispatch_studio_generation_pack",
        payload: {
          packId: frozen.packId,
          packFingerprint: frozen.fingerprint,
          generationRunId: "codex-generation-run-001",
          provider: "codex",
          expectedRevision: frozen.pack.target.unitRevision,
        },
      });
      expect(dispatched).toMatchObject({
        generationRunId: "codex-generation-run-001",
        packId: frozen.packId,
        provider: "codex",
        dispatchProvenance: "local-dispatch-intent",
      });
      expectNoPrivateStoragePaths(dispatched);
      const registered = await execute(client, projectRoot, 12, {
        command: "register_studio_generation_result",
        payload: {
          packId: frozen.packId,
          packFingerprint: frozen.fingerprint,
          generationRunId: "codex-generation-run-001",
          variant: "raw",
          mediaSha256: media.sha256,
          expectedRevision: unitRevision,
        },
      });
      expectNoPrivateStoragePaths(registered);

      const overview = parsed(await client.callTool({ name: "get_managed_studio_overview", arguments: { projectRoot } }));
      const assets = parsed(await client.callTool({ name: "list_studio_assets", arguments: { projectRoot, category: "character", search: "阿航", limit: 1 } }));
      const mediaPage = parsed(await client.callTool({ name: "list_studio_media", arguments: { projectRoot, kind: "image", search: "ahang", limit: 1 } }));
      const originFirst = parsed(await client.callTool({
        name: "list_studio_media_import_origins",
        arguments: { projectRoot, mediaSha256: media.sha256, limit: 1 },
      }));
      const originSecond = parsed(await client.callTool({
        name: "list_studio_media_import_origins",
        arguments: { projectRoot, mediaSha256: media.sha256, cursor: originFirst.nextCursor, limit: 1 },
      }));
      const scripts = parsed(await client.callTool({ name: "list_studio_text_documents", arguments: { projectRoot, kind: "script", search: "EP01", limit: 1 } }));
      const units = parsed(await client.callTool({ name: "list_studio_production_units", arguments: { projectRoot, season: "S03", episode: "EP01", limit: 1 } }));
      const detail = parsed(await client.callTool({ name: "get_studio_asset", arguments: { projectRoot, assetId: "character-ahang" } }));
      const textRevision = parsed(await client.callTool({ name: "get_studio_text_revision", arguments: { projectRoot, revisionId: scriptRevisionId } }));
      const snapshot = parsed(await client.callTool({ name: "get_studio_production_unit_snapshot", arguments: { projectRoot, unitId: "unit-ep01-001" } }));
      const timelineFirst = parsed(await client.callTool({ name: "query_studio_asset_timeline", arguments: { projectRoot, assetId: "character-ahang", limit: 1 } }));
      const timelineSecond = parsed(await client.callTool({ name: "query_studio_asset_timeline", arguments: { projectRoot, assetId: "character-ahang", cursor: timelineFirst.nextCursor, limit: 1 } }));
      const ledger = parsed(await client.callTool({ name: "list_command_ledger", arguments: { projectRoot, limit: 20 } }));
      const readiness = parsed(await client.callTool({
        name: "get_studio_generation_control",
        arguments: { projectRoot, query: { operation: "readiness", unitId: "unit-ep01-001", panelId: "panel-01" } },
      }));
      const generationPack = parsed(await client.callTool({
        name: "get_studio_generation_control",
        arguments: { projectRoot, query: { operation: "pack", packId: frozen.packId } },
      }));
      const generationHistory = parsed(await client.callTool({
        name: "get_studio_generation_control",
        arguments: { projectRoot, query: { operation: "history", unitId: "unit-ep01-001", panelId: "panel-01", limit: 1 } },
      }));

      expect(overview).toMatchObject({ material: { counts: { media: 1, mediaImports: 2, canonicalAssets: 1, primaryAuthorities: 1 } }, production: { counts: { textDocuments: 2, textRevisions: 2, units: 1 } } });
      expect(assets).toMatchObject({ items: [{ id: "character-ahang", primaryAuthority: { versionId } }] });
      expect(mediaPage).toMatchObject({ items: [{ sha256: media.sha256, kind: "image" }] });
      const originItems = [...originFirst.items, ...originSecond.items];
      expect(originFirst.items).toHaveLength(1);
      expect(originFirst.nextCursor).toEqual(expect.any(String));
      expect(originSecond.items).toHaveLength(1);
      expect(originSecond.nextCursor).toBeUndefined();
      expect(originItems.map((origin: any) => origin.sourceBasename).sort()).toEqual(["ahang-reference-authority-copy.png", "ahang-reference.png"]);
      expect(originItems.map((origin: any) => origin.source)).toEqual([
        { scope: "external" },
        { scope: "external" },
      ]);
      expect(JSON.stringify(originItems)).not.toContain(sourcePath);
      expect(JSON.stringify(originItems)).not.toContain(secondSourcePath);
      expect(originItems.find((origin: any) => origin.sourceBasename === "ahang-reference-authority-copy.png")).toMatchObject({
        sourceSizeBytes: expect.any(Number),
        expectedSha256: media.sha256,
        importedAt: expect.any(String),
      });
      expect(JSON.stringify(mediaPage)).not.toContain(sourcePath);
      expect(JSON.stringify(mediaPage)).not.toContain(secondSourcePath);
      expect(mediaPage).not.toHaveProperty("items.0.source");
      expectNoPrivateStoragePaths(originFirst);
      expectNoPrivateStoragePaths(originSecond);
      expect(scripts).toMatchObject({ items: [{ id: "script-ep01", latestRevision: { id: scriptRevisionId } }] });
      expect(units).toMatchObject({ items: [{ id: "unit-ep01-001", durationSeconds: 15, panelCount: 2 }] });
      expect(detail).toMatchObject({ id: "character-ahang", revision: 4, primaryAuthority: { versionId } });
      expect(textRevision).toMatchObject({ id: scriptRevisionId, body: "阿航进入石室，在石门前停步。" });
      expect(snapshot).toMatchObject({ kind: "studio-production-unit-snapshot", unit: { id: "unit-ep01-001" }, panels: [{ id: "panel-01" }, { id: "panel-02" }] });
      expect(timelineFirst.items).toHaveLength(1);
      expect(timelineFirst.nextCursor).toEqual(expect.any(String));
      expect(timelineSecond.items).toHaveLength(1);
      expect(timelineSecond.nextCursor).toBeUndefined();
      expect(readiness).toMatchObject({
        kind: "studio-codex-generation-control-envelope",
        operation: "readiness",
        status: "ready",
        candidate: { packId: frozen.packId, fingerprint: frozen.fingerprint, controlReferenceCount: 1 },
        persistence: "execute-command-required",
        controlReferencesExposed: false,
      });
      expect(generationHistory).toMatchObject({
        kind: "studio-codex-generation-control-envelope",
        operation: "history",
        status: "ready",
        items: [{ generationRunId: "codex-generation-run-001", variant: "raw", mediaSha256: media.sha256, packId: frozen.packId }],
        controlReferencesExposed: false,
      });
      const expectedControlPath = path.join(projectRoot, ".aicanvas", "objects", "sha256", media.sha256.slice(0, 2), media.sha256);
      expectOnlyVerifiedControlLocalPaths(generationPack, expectedControlPath);
      expect(createHash("sha256").update(await readFile(expectedControlPath)).digest("hex")).toBe(media.sha256);
      expectNoPrivateStoragePaths({ overview, assets, mediaPage, scripts, units, detail, textRevision, snapshot, timelineFirst, timelineSecond, ledger, scriptRevision, promptRevision, unit, frozen, registered, readiness, generationHistory });

      const originalBytes = await readFile(expectedControlPath);
      await writeFile(expectedControlPath, Buffer.from("tampered-control-reference", "utf8"));
      const shaDriftFailure = parsed(await client.callTool({
        name: "get_studio_generation_control",
        arguments: { projectRoot, query: { operation: "pack", packId: frozen.packId } },
      }));
      expect(shaDriftFailure).toMatchObject({ error: { code: expect.any(String) } });
      expectNoPrivateStoragePaths(shaDriftFailure);

      await writeFile(expectedControlPath, originalBytes);
      const escapedPath = path.join(projectRoot, "escaped-reference.png");
      await writeFile(escapedPath, originalBytes);
      const database = new DatabaseSync(path.join(projectRoot, ".aicanvas", "material-studio.sqlite"));
      try {
        database.exec("DROP TRIGGER studio_media_identity_no_update");
        database.prepare("UPDATE studio_media SET object_relpath = ? WHERE sha256 = ?").run("escaped-reference.png", media.sha256);
      } finally {
        database.close();
      }
      const pathDriftFailure = parsed(await client.callTool({
        name: "get_studio_generation_control",
        arguments: { projectRoot, query: { operation: "pack", packId: frozen.packId } },
      }));
      expect(pathDriftFailure).toMatchObject({ error: { code: expect.any(String) } });
      expectNoPrivateStoragePaths(pathDriftFailure);
    } finally {
      await client.close();
    }
    // 空载实测约 24.5s，贴近 30s 旧帽；integration 分区并发负载下必撞顶（wq-0006 verify 实测）。
    // 断言合同不变，仅显式放宽本用例时限。
  }, 120_000);

  it("P30 unit-grid 通过同一 generation control/MCP 命令总线冻结、读取安全参考和计划投影", async () => {
    const runtimeRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "ai-canvas-mcp-unit-grid-")));
    roots.push(runtimeRoot);
    const fixture = await createStudioP7Fixture({ parentDirectory: runtimeRoot });
    await seedStudioP7ResolvedContinuity(fixture);
    process.env.AI_CANVAS_REGISTRY_PATH = path.join(runtimeRoot, "projects.json");
    await registerProject(fixture.shell.project);
    await setActiveProjectRegistration(fixture.root);
    const client = await createClient(runtimeRoot);
    try {
      const unit = fixture.units.twoPanel;
      const continuationWaiver = await studioP7UserContinuationWaiver(
        fixture.root,
        unit,
        "fixture:mcp-managed-studio:unit-grid",
      );
      const readiness = parsed(await client.callTool({
        name: "get_studio_generation_control",
        arguments: {
          projectRoot: fixture.root,
          query: {
            operation: "readiness",
            targetKind: "unit-grid",
            unitId: unit.unit.id,
            continuationWaiver,
          },
        },
      }));
      expect(readiness).toMatchObject({
        operation: "readiness",
        targetKind: "unit-grid",
        status: "ready",
        candidate: {
          target: { targetKind: "unit-grid", unitId: unit.unit.id, panelCount: 2 },
          controlReferenceCount: expect.any(Number),
        },
        writeCommand: {
          command: "freeze_studio_generation_pack",
          payload: {
            targetKind: "unit-grid",
            unitId: unit.unit.id,
            continuationWaiver,
            expectedRevision: unit.unit.revision,
          },
        },
        controlReferencesExposed: false,
      });
      expectNoPrivateStoragePaths(readiness);

      const frozen = await execute(client, fixture.root, 701, {
        command: "freeze_studio_generation_pack",
        payload: {
          targetKind: "unit-grid",
          unitId: unit.unit.id,
          continuationWaiver,
          expectedRevision: unit.unit.revision,
        },
      });
      expect(frozen).toMatchObject({ targetKind: "unit-grid", unitId: unit.unit.id, panelCount: 2 });
      expectNoPrivateStoragePaths(frozen);

      const pack = parsed(await client.callTool({
        name: "get_studio_generation_control",
        arguments: { projectRoot: fixture.root, query: { operation: "pack", packId: frozen.packId } },
      }));
      expect(pack).toMatchObject({
        operation: "pack",
        targetKind: "unit-grid",
        status: "ready",
        request: { exactlyOneImage: true, maxCalls: 1, controlReferences: expect.any(Array) },
        verification: { panelBindingContinuityClosure: true, mediaCasContainment: true, mediaSha256: true },
      });
      expect(pack.request.controlReferences.length).toBeGreaterThan(0);
      for (const reference of pack.request.controlReferences as Array<{ mediaSha256: string; localPath: string }>) {
        const expectedPath = path.join(fixture.root, ".aicanvas", "objects", "sha256", reference.mediaSha256.slice(0, 2), reference.mediaSha256);
        expect(reference.localPath).toBe(expectedPath);
        expect(createHash("sha256").update(await readFile(reference.localPath)).digest("hex")).toBe(reference.mediaSha256);
      }
      expect(pack.pack.request.controlReferences).toEqual(pack.request.controlReferences);
      const withoutVerifiedPaths = JSON.parse(JSON.stringify(pack, (key, value) => key === "localPath" ? undefined : value));
      expectNoPrivateStoragePaths(withoutVerifiedPaths);

      const plan = await execute(client, fixture.root, 702, {
        command: "create_studio_generation_plan",
        payload: { nodes: [{ targetKind: "unit-grid", unitId: unit.unit.id }] },
      });
      const projectedPlan = parsed(await client.callTool({
        name: "get_studio_generation_control",
        arguments: {
          projectRoot: fixture.root,
          query: { operation: "plan", targetKind: "unit-grid", unitId: unit.unit.id },
        },
      }));
      expect(projectedPlan).toMatchObject({
        operation: "plan",
        status: "ready",
        plans: [{ planId: plan.planId, nodes: [{ targetKind: "unit-grid", unitId: unit.unit.id }] }],
        controlReferencesExposed: false,
      });
      expectNoPrivateStoragePaths(projectedPlan);

      const generationRunId = `${plan.planId}:node:1:attempt:1`;
      const dispatched = await execute(client, fixture.root, 703, {
        command: "dispatch_studio_generation_pack",
        payload: {
          packId: frozen.packId,
          packFingerprint: frozen.fingerprint,
          generationRunId,
          provider: "codex",
          expectedRevision: unit.unit.revision,
        },
      });
      expect(dispatched).toMatchObject({ generationRunId, provider: "codex" });
      const active = parsed(await client.callTool({ name: "get_active_managed_studio_context", arguments: {} }));
      expect(active).toMatchObject({
        kind: "active-managed-studio-context",
        projectId: fixture.shell.project.id,
        projectRoot: fixture.root,
        projectContextToken: expect.stringMatching(/^studioctx-v1-[a-f0-9]{64}$/u),
      });
      expectNoPrivateStoragePaths(active);
      const bootstrappedOverview = parsed(await client.callTool({
        name: "get_studio_production_dashboard",
        arguments: { projectRoot: active.projectRoot, query: { operation: "overview" } },
      }));
      expect(bootstrappedOverview).toMatchObject({ operation: "overview", projectId: fixture.shell.project.id });
      const preparePayload = {
        projectContextToken: active.projectContextToken,
        packId: frozen.packId,
        packFingerprint: frozen.fingerprint,
        generationRunId,
        provider: "codex",
        expectedRevision: 0,
      };
      const prepared = await execute(client, fixture.root, 704, {
        command: "prepare_studio_imagegen_call",
        payload: preparePayload,
      });
      expect(prepared).toMatchObject({
        generationRunId,
        status: "generation_unknown",
        callAllowed: true,
        idempotentReplay: false,
      });
      const replayedPrepare = await execute(client, fixture.root, 705, {
        command: "prepare_studio_imagegen_call",
        payload: preparePayload,
      });
      expect(replayedPrepare).toMatchObject({
        callId: prepared.callId,
        generationRunId,
        status: "generation_unknown",
        callAllowed: false,
        idempotentReplay: true,
      });
      const unknownCall = parsed(await client.callTool({
        name: "get_studio_generation_control",
        arguments: { projectRoot: fixture.root, query: { operation: "call", generationRunId } },
      }));
      expect(unknownCall).toMatchObject({
        operation: "call",
        status: "ready",
        generationRunId,
        intent: { callId: prepared.callId, status: "generation_unknown", callAllowed: false },
        generationBlocked: true,
        modelCallAuthorized: false,
        nextAction: "reconcile-or-commit-existing-call-only",
      });
      expectNoPrivateStoragePaths(unknownCall);
      const reconciled = await execute(client, fixture.root, 706, {
        command: "reconcile_studio_imagegen_call",
        payload: {
          callId: prepared.callId,
          projectContextToken: active.projectContextToken,
          result: "not-invoked",
          evidenceReference: path.join(runtimeRoot, "evidence", "not-invoked.json"),
          evidenceFingerprint: "a".repeat(64),
          note: "MCP fixture 明确未调用模型。",
          expectedRevision: 0,
        },
      });
      expect(reconciled).toMatchObject({ callId: prepared.callId, kind: "not-invoked" });
      const reconciledCall = parsed(await client.callTool({
        name: "get_studio_generation_control",
        arguments: { projectRoot: fixture.root, query: { operation: "call", generationRunId } },
      }));
      expect(reconciledCall).toMatchObject({
        intent: { status: "not-invoked", callAllowed: false },
        events: [{ kind: "not-invoked", evidence: { scope: "external", basename: "not-invoked.json" } }],
        generationBlocked: false,
        modelCallAuthorized: false,
        nextAction: "new-run-required",
      });
      expect(JSON.stringify(reconciledCall)).not.toContain(runtimeRoot);
      expectNoPrivateStoragePaths(reconciledCall);

      const emptyHistory = parsed(await client.callTool({
        name: "get_studio_generation_control",
        arguments: {
          projectRoot: fixture.root,
          query: { operation: "history", targetKind: "unit-grid", unitId: unit.unit.id, limit: 10 },
        },
      }));
      expect(emptyHistory).toMatchObject({
        operation: "history",
        targetKind: "unit-grid",
        unitId: unit.unit.id,
        items: [],
        controlReferencesExposed: false,
      });
      expectNoPrivateStoragePaths(emptyHistory);

      await recordStudioDetachedGenerationUnknownObservation(fixture.root, {
        unitId: unit.unit.id,
        unitRevision: unit.unit.revision,
        unitFingerprint: unit.fingerprint,
        sourceTaskId: "stopped-task-fixture-0001",
        evidenceReference: path.join(runtimeRoot, "quarantine", "late-candidate.png"),
        evidenceFingerprint: "b".repeat(64),
        candidateSha256: "c".repeat(64),
        candidateSizeBytes: 1234,
        candidateWidth: 720,
        candidateHeight: 1280,
        note: "只登记 unknown 元数据，不导入结果。",
      });
      const detached = parsed(await client.callTool({
        name: "get_studio_generation_control",
        arguments: {
          projectRoot: fixture.root,
          query: { operation: "detached-unknown", unitId: unit.unit.id },
        },
      }));
      expect(detached).toMatchObject({
        operation: "detached-unknown",
        targetKind: "unit-grid",
        unitId: unit.unit.id,
        generationBlocked: true,
        nextAction: "reconcile-external-unknown-only",
        observations: [{
          status: "generation_unknown",
          candidateSha256: "c".repeat(64),
          evidence: { scope: "external", basename: "late-candidate.png" },
        }],
      });
      expect(JSON.stringify(detached)).not.toContain(runtimeRoot);
      expectNoPrivateStoragePaths(detached);
    } finally {
      await client.close();
    }
  }, 60_000);

  it("通过结构化适用范围和双 revision 关系命令维护资产知识图谱", async () => {
    const runtimeRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "ai-canvas-mcp-asset-relations-")));
    roots.push(runtimeRoot);
    const projectRoot = (await createManagedProject({ parentRoot: runtimeRoot, name: "MCP 资产关系工程" })).paths.root;
    const client = await createClient(runtimeRoot);
    try {
      const member = await execute(client, projectRoot, 201, {
        command: "create_studio_asset",
        payload: {
          id: "prop-mask-source",
          category: "prop",
          name: "完整黄金面具身份来源",
          applicability: {
            projects: ["古蜀卷"],
            seasons: ["S03"],
            episodes: ["EP01", "EP32"],
            units: ["EP01_15s_008"],
            timeRanges: [{ scope: "unit", scopeId: "EP01_15s_008", startSeconds: 7, endSeconds: 15, label: "布囊内部隐藏身份" }],
            tags: ["隐藏实体", "连续性硬锁"],
          },
          expectedRevision: 0,
        },
      });
      const composite = await execute(client, projectRoot, 202, {
        command: "create_studio_asset",
        payload: {
          id: "prop-cloth-pouch",
          category: "prop",
          name: "P01 布囊",
          applicability: { projects: ["古蜀卷"], seasons: ["S03"], episodes: ["EP01"] },
          expectedRevision: 0,
        },
      });
      const updatedMember = await execute(client, projectRoot, 203, {
        command: "update_studio_asset",
        payload: {
          assetId: "prop-mask-source",
          expectedRevision: member.revision,
          applicability: {
            projects: ["古蜀卷"],
            seasons: ["S03"],
            episodes: ["EP01", "EP32"],
            units: ["EP01_15s_008"],
            timeRanges: [{ scope: "unit", scopeId: "EP01_15s_008", startSeconds: 7, endSeconds: 15, label: "布囊内部隐藏身份" }],
            tags: ["隐藏实体", "连续性硬锁", "EP32前不得露出"],
          },
        },
      });
      const relation = await execute(client, projectRoot, 204, {
        command: "append_studio_asset_relation",
        payload: {
          id: "relation-mask-inside-pouch",
          kind: "composite_member",
          subjectAssetId: "prop-mask-source",
          objectAssetId: "prop-cloth-pouch",
          expectedSubjectRevision: updatedMember.revision,
          expectedObjectRevision: composite.revision,
          ordinal: 1,
          role: "布囊内部身份来源",
          note: "只锁定语义关系，不允许 EP32 前显露完整面具实体。",
        },
      });
      expect(relation).toMatchObject({
        id: "relation-mask-inside-pouch",
        kind: "composite_member",
        ordinal: 1,
        subject: { assetId: "prop-mask-source", assetRevision: 3 },
        object: { assetId: "prop-cloth-pouch", assetRevision: 2 },
      });

      const memberDetail = parsed(await client.callTool({
        name: "get_studio_asset",
        arguments: { projectRoot, assetId: "prop-mask-source" },
      }));
      const compositeDetail = parsed(await client.callTool({
        name: "get_studio_asset",
        arguments: { projectRoot, assetId: "prop-cloth-pouch" },
      }));
      const assetList = parsed(await client.callTool({
        name: "list_studio_assets",
        arguments: { projectRoot, category: "prop", limit: 10 },
      }));
      expect(memberDetail).toMatchObject({
        id: "prop-mask-source",
        revision: 3,
        applicability: {
          projects: ["古蜀卷"],
          seasons: ["S03"],
          episodes: ["EP01", "EP32"],
          units: ["EP01_15s_008"],
          timeRanges: [{ scope: "unit", scopeId: "EP01_15s_008", startSeconds: 7, endSeconds: 15 }],
          tags: ["EP32前不得露出", "连续性硬锁", "隐藏实体"],
        },
        relations: [{ id: "relation-mask-inside-pouch", object: { assetId: "prop-cloth-pouch" } }],
      });
      expect(compositeDetail).toMatchObject({
        id: "prop-cloth-pouch",
        revision: 2,
        relations: [{ id: "relation-mask-inside-pouch", subject: { assetId: "prop-mask-source" } }],
      });
      expect(assetList.items).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "prop-mask-source", applicability: expect.objectContaining({ seasons: ["S03"] }) }),
        expect.objectContaining({ id: "prop-cloth-pouch", applicability: expect.objectContaining({ episodes: ["EP01"] }) }),
      ]));
      const driftedMember = await execute(client, projectRoot, 205, {
        command: "update_studio_asset",
        payload: {
          assetId: "prop-mask-source",
          expectedRevision: 3,
          description: "显式触发关系快照过期。",
        },
      });
      const staleDetail = parsed(await client.callTool({
        name: "get_studio_asset",
        arguments: { projectRoot, assetId: "prop-mask-source" },
      }));
      expect(staleDetail.relations).toMatchObject([{ id: relation.id, head: true, status: "stale" }]);
      const rebased = await execute(client, projectRoot, 206, {
        command: "append_studio_asset_relation",
        payload: {
          id: "relation-mask-inside-pouch-v2",
          supersedesRelationId: relation.id,
          kind: relation.kind,
          subjectAssetId: relation.subject.assetId,
          objectAssetId: relation.object.assetId,
          expectedSubjectRevision: driftedMember.revision,
          expectedObjectRevision: 2,
          ordinal: relation.ordinal,
          role: relation.role,
          note: relation.note,
        },
      });
      expect(rebased).toMatchObject({
        seriesId: relation.id,
        revision: 2,
        supersedesRelationId: relation.id,
        head: true,
        status: "current",
      });
      const recoveredDetail = parsed(await client.callTool({
        name: "get_studio_asset",
        arguments: { projectRoot, assetId: "prop-mask-source" },
      }));
      expect(recoveredDetail.relations).toMatchObject([
        { id: relation.id, head: false, status: "superseded", supersededByRelationId: rebased.id },
        { id: rebased.id, head: true, status: "current", supersedesRelationId: relation.id },
      ]);
      expectNoPrivateStoragePaths({ member, composite, updatedMember, relation, memberDetail, compositeDetail, assetList });
    } finally {
      await client.close();
    }
  }, 30_000);

  it("compiled MCP 可分页追溯同 SHA 的两个来源，通用媒体列表仍不泄露原路径", async () => {
    const runtimeRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "ai-canvas-mcp-compiled-media-origins-")));
    roots.push(runtimeRoot);
    const projectRoot = (await createManagedProject({ parentRoot: runtimeRoot, name: "compiled MCP 媒体来源追溯" })).paths.root;
    const firstPath = path.join(runtimeRoot, "same-content-first.png");
    const secondPath = path.join(runtimeRoot, "same-content-second.png");
    await sharp({ create: { width: 18, height: 30, channels: 3, background: "#49382d" } }).png().toFile(firstPath);
    await writeFile(secondPath, await readFile(firstPath));
    const compiledServerPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist-mcp", "mcp", "server.js");
    await access(compiledServerPath);
    const client = await createClient(runtimeRoot, compiledServerPath);
    try {
      const tools = await client.listTools();
      expect(tools.tools.length).toBe(EXPECTED_MCP_TOOL_COUNT);
      expect(tools.tools.find((tool) => tool.name === "list_studio_media_import_origins")?.annotations)
        .toMatchObject({ readOnlyHint: true, openWorldHint: false });
      const first = await execute(client, projectRoot, 281, {
        command: "import_studio_media",
        payload: { sourcePath: firstPath, kind: "image" },
      });
      const second = await execute(client, projectRoot, 282, {
        command: "import_studio_media",
        payload: { sourcePath: secondPath, kind: "image", expectedSha256: first.sha256 },
      });
      expect(second.sha256).toBe(first.sha256);

      const pageOne = parsed(await client.callTool({
        name: "list_studio_media_import_origins",
        arguments: { projectRoot, mediaSha256: first.sha256, limit: 1 },
      }));
      const pageTwo = parsed(await client.callTool({
        name: "list_studio_media_import_origins",
        arguments: { projectRoot, mediaSha256: first.sha256, cursor: pageOne.nextCursor, limit: 1 },
      }));
      expect(pageOne.items).toHaveLength(1);
      expect(pageOne.nextCursor).toEqual(expect.any(String));
      expect(pageTwo.items).toHaveLength(1);
      expect(pageTwo.nextCursor).toBeUndefined();
      const origins = [...pageOne.items, ...pageTwo.items];
      expect(origins.map((origin: any) => origin.sourceBasename).sort()).toEqual(["same-content-first.png", "same-content-second.png"]);
      expect(origins.map((origin: any) => origin.source)).toEqual([
        { scope: "external" },
        { scope: "external" },
      ]);
      expect(JSON.stringify(origins)).not.toContain(firstPath);
      expect(JSON.stringify(origins)).not.toContain(secondPath);
      expect(origins.find((origin: any) => origin.sourceBasename === "same-content-second.png")?.expectedSha256).toBe(first.sha256);
      expectNoPrivateStoragePaths(pageOne);
      expectNoPrivateStoragePaths(pageTwo);

      const generic = parsed(await client.callTool({ name: "list_studio_media", arguments: { projectRoot, limit: 10 } }));
      expect(generic.items).toHaveLength(1);
      expect(JSON.stringify(generic)).not.toContain(firstPath);
      expect(JSON.stringify(generic)).not.toContain(secondPath);
      expect(JSON.stringify(generic)).not.toContain("absolutePath");
      expect(JSON.stringify(generic)).not.toContain("projectRelativePath");
      expectNoPrivateStoragePaths(generic);
      const capabilities = parsed(await client.callTool({ name: "get_capabilities", arguments: { projectRoot } }));
      expect(capabilities).toMatchObject({
        server: { toolCount: EXPECTED_MCP_TOOL_COUNT },
        domains: { managedStudio: expect.arrayContaining(["list_studio_media_import_origins"]) },
      });
    } finally {
      await client.close();
    }
  }, 30_000);

  it("compiled MCP 只接受 pending 新版本，伪造 approved 状态也无法绕过审核收据", async () => {
    const runtimeRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "ai-canvas-mcp-compiled-review-gate-")));
    roots.push(runtimeRoot);
    const projectRoot = (await createManagedProject({ parentRoot: runtimeRoot, name: "compiled MCP 审核门禁" })).paths.root;
    const compiledServerPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist-mcp", "mcp", "server.js");
    await access(compiledServerPath);
    const sourcePath = path.join(runtimeRoot, "review-gate.png");
    await sharp({ create: { width: 16, height: 24, channels: 3, background: "#53412f" } }).png().toFile(sourcePath);
    const client = await createClient(runtimeRoot, compiledServerPath);
    try {
      const tools = await client.listTools();
      const executeSchema = tools.tools.find((tool) => tool.name === "execute_command")?.inputSchema as {
        properties?: { request?: { oneOf?: Array<{ properties?: { command?: { const?: string }; payload?: { properties?: Record<string, any> } } }>; anyOf?: Array<{ properties?: { command?: { const?: string }; payload?: { properties?: Record<string, any> } } }> } };
      };
      const variants = executeSchema.properties?.request?.oneOf ?? executeSchema.properties?.request?.anyOf ?? [];
      const appendVariant = variants.find((variant) => variant.properties?.command?.const === "append_studio_asset_version");
      expect(appendVariant?.properties?.payload?.properties?.reviewStatus).toMatchObject({ const: "pending" });

      await execute(client, projectRoot, 301, {
        command: "create_studio_asset",
        payload: { id: "character-compiled-gate", category: "character", name: "compiled 审核门禁角色", expectedRevision: 0 },
      });
      const media = await execute(client, projectRoot, 302, {
        command: "import_studio_media",
        payload: { sourcePath, kind: "image" },
      });

      for (const [offset, forbiddenStatus] of ["approved", "rejected"].entries()) {
        const failure = await captureMcpFailure(client.callTool({
          name: "execute_command",
          arguments: commandArguments(projectRoot, 303 + offset, {
            command: "append_studio_asset_version",
            payload: {
              assetId: "character-compiled-gate",
              mediaSha256: media.sha256,
              reviewStatus: forbiddenStatus,
              sourceNote: "恶意跳过审核",
              expectedRevision: 1,
            },
          }),
        }));
        expect(failure).toMatch(/pending|reviewStatus/iu);
      }

      const pending = await execute(client, projectRoot, 305, {
        command: "append_studio_asset_version",
        payload: {
          assetId: "character-compiled-gate",
          mediaSha256: media.sha256,
          reviewStatus: "pending",
          sourceNote: "合法 pending 候选版本",
          expectedRevision: 1,
        },
      });
      const versionId = pending.version.id as string;
      const databasePath = path.join(projectRoot, ".aicanvas", "material-studio.sqlite");
      const db = new DatabaseSync(databasePath);
      expect(() => db.prepare("UPDATE studio_asset_versions SET review_status = 'approved' WHERE id = ?").run(versionId))
        .toThrow("studio_asset_versions is append-only");
      db.close();

      const authorityFailure = parsed(await client.callTool({
        name: "execute_command",
        arguments: commandArguments(projectRoot, 306, {
          command: "set_studio_primary_authority",
          payload: { assetId: "character-compiled-gate", versionId, expectedRevision: pending.assetRevision },
        }),
      }));
      expect(authorityFailure).toMatchObject({
        error: { code: "CONFLICT", message: expect.stringContaining("只有 approved 版本") },
      });

      const audit = new DatabaseSync(databasePath, { readOnly: true });
      const stored = audit.prepare("SELECT revision, primary_version_id FROM studio_canonical_assets WHERE id = ?")
        .get("character-compiled-gate") as { revision: number; primary_version_id: string | null };
      const reviewCount = audit.prepare("SELECT COUNT(*) AS count FROM studio_version_reviews WHERE version_id = ?")
        .get(versionId) as { count: number };
      audit.close();
      expect(stored).toEqual({ revision: pending.assetRevision, primary_version_id: null });
      expect(reviewCount.count).toBe(0);
    } finally {
      await client.close();
    }
  }, 30_000);

  it("非受管目录在读取和命令账本写入前失败关闭", async () => {
    const runtimeRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "ai-canvas-mcp-unmanaged-studio-")));
    roots.push(runtimeRoot);
    const projectRoot = path.join(runtimeRoot, "plain-directory");
    await mkdir(projectRoot);
    const client = await createClient(runtimeRoot);
    try {
      const readFailure = parsed(await client.callTool({ name: "get_managed_studio_overview", arguments: { projectRoot } }));
      expect(readFailure).toMatchObject({ error: { code: expect.any(String) } });
      const generationControlFailure = parsed(await client.callTool({
        name: "get_studio_generation_control",
        arguments: { projectRoot, query: { operation: "readiness", unitId: "unit-ep01-001", panelId: "panel-01" } },
      }));
      expect(generationControlFailure).toMatchObject({ error: { code: expect.any(String) } });
      expectNoPrivateStoragePaths(generationControlFailure);
      const generationFreezeFailure = parsed(await client.callTool({
        name: "execute_command",
        arguments: commandArguments(projectRoot, 100, {
          command: "freeze_studio_generation_pack",
          payload: { unitId: "unit-ep01-001", panelId: "panel-01", expectedRevision: 1 },
        }),
      }));
      expect(generationFreezeFailure).toMatchObject({ error: { code: expect.any(String) } });
      const generationDispatchFailure = parsed(await client.callTool({
        name: "execute_command",
        arguments: commandArguments(projectRoot, 102, {
          command: "dispatch_studio_generation_pack",
          payload: {
            packId: "studio-generation-freeze-unmanaged",
            packFingerprint: "a".repeat(64),
            generationRunId: "unmanaged-generation-run-001",
            provider: "codex",
            expectedRevision: 1,
          },
        }),
      }));
      expect(generationDispatchFailure).toMatchObject({ error: { code: expect.any(String) } });
      const generationRegisterFailure = parsed(await client.callTool({
        name: "execute_command",
        arguments: commandArguments(projectRoot, 101, {
          command: "register_studio_generation_result",
          payload: {
            packId: "studio-generation-freeze-unmanaged",
            packFingerprint: "a".repeat(64),
            generationRunId: "unmanaged-generation-run-001",
            variant: "raw",
            mediaSha256: "b".repeat(64),
            expectedRevision: 1,
          },
        }),
      }));
      expect(generationRegisterFailure).toMatchObject({ error: { code: expect.any(String) } });
      expectNoPrivateStoragePaths({ generationFreezeFailure, generationDispatchFailure, generationRegisterFailure });
      const writeFailure = parsed(await client.callTool({
        name: "execute_command",
        arguments: commandArguments(projectRoot, 99, {
          command: "create_studio_asset",
          payload: { id: "character-ahang", category: "character", name: "阿航", expectedRevision: 0 },
        }),
      }));
      expect(writeFailure).toMatchObject({ error: { code: expect.any(String) } });
      await expect(access(path.join(projectRoot, ".aicanvas"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await client.close();
    }
  }, 30_000);

  it("P20 §4-14 suggest_studio_storyboard_draft 边界：strict/fail-closed/形状/create 5 字段 strict 校验", async () => {
    const runtimeRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "ai-canvas-mcp-p20-storyboard-")));
    roots.push(runtimeRoot);
    const projectRoot = (await createManagedProject({ parentRoot: runtimeRoot, name: "MCP P20 拆格建议" })).paths.root;
    const client = await createClient(runtimeRoot);
    try {
      const tools = await client.listTools();
      expect(tools.tools.find((tool) => tool.name === "suggest_studio_storyboard_draft")?.annotations)
        .toMatchObject({ readOnlyHint: true, openWorldHint: false });

      // superRefine：scriptRevisionId 与 unitId 皆缺 → 拒绝。
      expect(await captureMcpFailure(client.callTool({
        name: "suggest_studio_storyboard_draft",
        arguments: { projectRoot, query: {} },
      }))).toMatch(/scriptRevisionId|至少其一必填/u);
      // zod 边界：panelCount 7 → 拒绝。
      expect(await captureMcpFailure(client.callTool({
        name: "suggest_studio_storyboard_draft",
        arguments: { projectRoot, query: { scriptRevisionId: "script-revision-x", panelCount: 7 } },
      }))).toMatch(/panelCount/u);
      // strict：未知字段 → 拒绝。
      expect(await captureMcpFailure(client.callTool({
        name: "suggest_studio_storyboard_draft",
        arguments: { projectRoot, query: { scriptRevisionId: "script-revision-x", bogus: 1 } },
      }))).toMatch(/bogus|unrecognized/iu);
      // Core fail-closed：revision 不存在。
      expect(await captureMcpFailure(client.callTool({
        name: "suggest_studio_storyboard_draft",
        arguments: { projectRoot, query: { scriptRevisionId: "script-revision-missing" } },
      }))).toMatch(/不存在/u);

      // 合法路径：形状 + fingerprint + 无私有路径泄露。
      await execute(client, projectRoot, 1, {
        command: "create_studio_script_document",
        payload: { id: "script-p20", title: "EP01", expectedRevision: 0 },
      });
      const body = "阿航走入石室。火把滑落照亮墙壁。他屏住呼吸。";
      const scriptRevision = await execute(client, projectRoot, 2, {
        command: "append_studio_script_revision",
        payload: { documentId: "script-p20", expectedRevision: 0, body, source: "codex", sourceVersion: "v1" },
      });
      const suggestion = parsed(await client.callTool({
        name: "suggest_studio_storyboard_draft",
        arguments: { projectRoot, query: { scriptRevisionId: scriptRevision.revision.id, panelCount: 2 } },
      }));
      expect(suggestion).toMatchObject({
        schemaVersion: 1,
        kind: "studio-storyboard-draft-suggestion",
        scriptRevisionId: scriptRevision.revision.id,
        panelCount: 2,
      });
      expect(suggestion.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
      expect(suggestion.panels).toHaveLength(2);
      for (const panel of suggestion.panels as Array<Record<string, any>>) {
        expect(panel.shotType).toBe("original");
        expect((panel.sourceSpans as unknown[]).length).toBeGreaterThan(0);
        for (const proposal of panel.unresolvedProposals as Array<Record<string, any>>) {
          expect(proposal).toMatchObject({
            surfaceText: expect.any(String),
            startOffsetUtf16: expect.any(Number),
            endOffsetUtf16: expect.any(Number),
          });
          expect(Array.isArray(proposal.candidateAssetIds)).toBe(true);
        }
      }
      expectNoPrivateStoragePaths(suggestion);

      // create payload 5 字段 strict：negativePrompt 超 2000 字符拒绝（对照：合法值接受）。
      await execute(client, projectRoot, 3, {
        command: "create_studio_prompt_document",
        payload: { id: "prompt-p20", title: "提示词", expectedRevision: 0 },
      });
      const promptRevision = await execute(client, projectRoot, 4, {
        command: "append_studio_prompt_revision",
        payload: { documentId: "prompt-p20", expectedRevision: 0, body: "电影写实。", source: "codex", sourceVersion: "v1" },
      });
      const panelsPayload = (negativePrompt: string) => [0, 7.5].map((start, offset) => ({
        id: `panel-0${offset + 1}`,
        title: `镜头 ${offset + 1}`,
        visualAction: "阿航走入石室。",
        shotComposition: "中景。",
        filmingMethod: "固定机位。",
        startSeconds: start,
        endSeconds: start + 7.5,
        durationSeconds: 7.5,
        promptRevisionId: promptRevision.revision.id,
        sourceSpans: [{ startOffsetUtf16: 0, endOffsetUtf16: body.length }],
        assets: [],
        transition: offset === 0 ? "叠化" : "",
        costumeState: "深灰祭服",
        sceneLighting: "左侧火光",
        shotType: "original",
        negativePrompt,
      }));
      await captureMcpFailure(client.callTool({
        name: "execute_command",
        arguments: commandArguments(projectRoot, 5, {
          command: "create_studio_production_unit",
          payload: {
            expectedRevision: 0,
            season: "S03",
            episode: "EP01",
            sequence: 1,
            title: "P20 单元",
            scriptRevisionId: scriptRevision.revision.id,
            panels: panelsPayload("长".repeat(2001)),
          },
        }),
      }));
      const unit = await execute(client, projectRoot, 6, {
        command: "create_studio_production_unit",
        payload: {
          expectedRevision: 0,
          season: "S03",
          episode: "EP01",
          sequence: 1,
          title: "P20 单元",
          scriptRevisionId: scriptRevision.revision.id,
          panels: panelsPayload("不要文字"),
        },
      });
      expect(unit).toMatchObject({ unit: { panelCount: 2 } });
      expect(JSON.stringify(unit)).toContain("深灰祭服");
      expect(JSON.stringify(unit)).toContain("不要文字");
    } finally {
      await client.close();
    }
  }, 30_000);

  it("P24 get_studio_trace 四 operation+zod 边界+unitSnapshot 可选 unitRevision（功能）", async () => {
    const { createStudioP24TraceFixture, freezeP24Pack, dispatchAndRegisterP24Pair } = await import("./helpers/studio-p24-trace-fixture.js");
    const fixture = await createStudioP24TraceFixture();
    const projectRoot = fixture.root;
    const client = await createClient(fixture.p7.parentRoot);
    try {
      const tools = await client.listTools();
      expect(tools.tools.find((tool) => tool.name === "get_studio_trace")?.annotations)
        .toMatchObject({ readOnlyHint: true, openWorldHint: false });
      // zod：operation 非法值拒绝；by-pack 缺 packId 拒绝。
      expect(await captureMcpFailure(client.callTool({
        name: "get_studio_trace",
        arguments: { projectRoot, operation: "bogus-operation" },
      }))).toMatch(/operation|invalid/iu);
      expect(await captureMcpFailure(client.callTool({
        name: "get_studio_trace",
        arguments: { projectRoot, operation: "by-pack" },
      }))).toMatch(/packId/u);
      expect(await captureMcpFailure(client.callTool({
        name: "get_studio_trace",
        arguments: { projectRoot, operation: "by-pack", packId: "pack-x", runId: "run-x" },
      }))).toMatch(/只允许且必须提供 packId|选择器/u);
      expect(await captureMcpFailure(client.callTool({
        name: "get_studio_trace",
        arguments: { projectRoot, operation: "by-pack", packId: "pack-x", limit: 10 },
      }))).toMatch(/不接受 limit\/cursor/u);
      // 非受管根 fail-closed。
      expect(await captureMcpFailure(client.callTool({
        name: "get_studio_trace",
        arguments: { projectRoot: path.join(fixture.p7.parentRoot, "not-managed"), operation: "by-pack", packId: "pack-x" },
      }))).toMatch(/受管|managed/iu);

      const pack = await freezeP24Pack(fixture, fixture.units.two, 1);
      const { rawResultId } = await dispatchAndRegisterP24Pair(fixture, pack, "p24-mcp-trace-run-0001");
      const byPack = parsed(await client.callTool({
        name: "get_studio_trace",
        arguments: { projectRoot, operation: "by-pack", packId: pack.packId },
      }));
      expect(byPack).toMatchObject({
        pack: { packId: pack.packId, fingerprint: pack.fingerprint },
        unit: { unitId: fixture.units.two.unit.id, unitRevision: fixture.units.two.unit.revision },
      });
      expect(byPack.results).toHaveLength(2);
      expect(byPack.changeClassification.classification).toBe("current");
      expect(JSON.stringify(byPack)).not.toContain(projectRoot);
      expect(JSON.stringify(byPack)).not.toContain("/.aicanvas/");
      const byRun = parsed(await client.callTool({
        name: "get_studio_trace",
        arguments: { projectRoot, operation: "by-run", runId: "p24-mcp-trace-run-0001" },
      }));
      expect(byRun.pack.packId).toBe(pack.packId);
      const byResult = parsed(await client.callTool({
        name: "get_studio_trace",
        arguments: { projectRoot, operation: "by-result", resultId: rawResultId },
      }));
      expect(byResult.pack.packId).toBe(pack.packId);
      const impact = parsed(await client.callTool({
        name: "get_studio_trace",
        arguments: { projectRoot, operation: "script-revision-impact", scriptRevisionId: fixture.units.two.scriptRevision.id },
      }));
      expect(impact.empty).toBe(false);
      expect(JSON.stringify(impact)).toContain(pack.packId);

      // unitSnapshot：缺省=head 与显式 unitRevision=1 均返回 r1（该单元无更高修订）。
      const head = parsed(await client.callTool({
        name: "get_studio_production_unit_snapshot",
        arguments: { projectRoot, unitId: fixture.units.two.unit.id },
      }));
      const historical = parsed(await client.callTool({
        name: "get_studio_production_unit_snapshot",
        arguments: { projectRoot, unitId: fixture.units.two.unit.id, unitRevision: 1 },
      }));
      expect(head.unit.revision).toBe(1);
      expect(historical.unit.revision).toBe(1);
    } finally {
      await client.close();
      await fixture.p7.cleanup();
    }
  }, 120_000);
});
