import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";
import { listCommandLedger } from "../src/core/command-bus.js";
import {
  dispatchStudioGenerationPack,
  freezeAndPersistStudioGenerationPack,
  registerStudioGenerationResult,
} from "../src/core/studio-generation-ledger.js";
import {
  createStudioP7Fixture,
  seedStudioP7ResolvedContinuity,
  type StudioP7Fixture,
} from "./helpers/studio-p7-fixture.js";
import { EXPECTED_MCP_TOOL_COUNT } from "./helpers/mcp-tool-count.js";

let fixture: StudioP7Fixture | undefined;

afterEach(async () => {
  await fixture?.cleanup();
  fixture = undefined;
});

function parsed(result: unknown): Record<string, any> {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return JSON.parse(content.find((entry) => entry.type === "text")?.text ?? "{}") as Record<string, any>;
}

async function rejected(call: Promise<unknown>): Promise<string> {
  try {
    const value = await call as { isError?: boolean };
    expect(value.isError).toBe(true);
    return JSON.stringify(value);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function clientFor(runtimeRoot: string): Promise<Client> {
  const cwd = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const compiled = process.env.AI_CANVAS_TEST_COMPILED_MCP === "1";
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: compiled ? ["dist-mcp/mcp/server.js"] : ["--import", "tsx", "src/mcp/server.ts"],
    cwd,
    env: { ...process.env, AI_CANVAS_REGISTRY_PATH: path.join(runtimeRoot, "projects.json") },
    stderr: "pipe",
  });
  const client = new Client({ name: "studio-continuity-review-test", version: "0.1.0" });
  await client.connect(transport);
  return client;
}

describe("P7 Studio continuity / Review MCP execute_command", () => {
  it("只扩展统一 execute_command schema，Codex Review reviewer 固定且真实写入走中心分类器", async () => {
    fixture = await createStudioP7Fixture();
    await seedStudioP7ResolvedContinuity(fixture);
    const client = await clientFor(fixture.parentRoot);
    try {
      const tools = await client.listTools();
      expect(tools.tools).toHaveLength(EXPECTED_MCP_TOOL_COUNT);
      expect(tools.tools.some((tool) => [
        "append_studio_continuity_observation",
        "append_studio_continuity_correction",
        "submit_studio_generation_review",
        "refresh_studio_generation_checkpoint",
        "attest_studio_generation_checkpoint",
      ].includes(tool.name))).toBe(false);

      const executeTool = tools.tools.find((tool) => tool.name === "execute_command");
      const executeSchema = executeTool?.inputSchema as {
        properties?: { request?: { oneOf?: any[]; anyOf?: any[] } };
      };
      const commandVariants = executeSchema.properties?.request?.oneOf
        ?? executeSchema.properties?.request?.anyOf
        ?? [];
      const command = (name: string) => commandVariants
        .find((variant) => variant.properties?.command?.const === name);
      const observationSchema = command("append_studio_continuity_observation");
      const correctionSchema = command("append_studio_continuity_correction");
      const reviewSchema = command("submit_studio_generation_review");
      const checkpointRefreshSchema = command("refresh_studio_generation_checkpoint");
      const checkpointAttestSchema = command("attest_studio_generation_checkpoint");
      expect([
        observationSchema,
        correctionSchema,
        reviewSchema,
        checkpointRefreshSchema,
        checkpointAttestSchema,
      ].every(Boolean)).toBe(true);
      expect(Object.keys(observationSchema.properties.payload.properties).sort()).toEqual([
        "expectedHeadRevision", "field", "scope", "state", "subjectId",
      ]);
      expect(observationSchema.properties.payload.required).toEqual([
        "expectedHeadRevision", "scope", "subjectId", "field", "state",
      ]);
      expect(observationSchema.properties.payload).toMatchObject({ additionalProperties: false });
      expect(Object.keys(correctionSchema.properties.payload.properties).sort()).toEqual([
        "expectedHeadRevision", "field", "resolvesConflicts", "scope", "state", "subjectId", "supersedesEntryId",
      ]);
      expect(correctionSchema.properties.payload.required).toEqual(expect.arrayContaining(["supersedesEntryId"]));
      expect(correctionSchema.properties.payload).toMatchObject({ additionalProperties: false });
      expect(Object.keys(reviewSchema.properties.payload.properties).sort()).toEqual([
        "annotations", "continuityFingerprint", "criteria", "decision", "expectedHeadRevision",
        "expectedPackFingerprint", "generationRunId", "kind", "labeledResultId", "labeledSha256",
        "note", "rawResultId", "rawSha256", "reviewer", "supersedesReviewId",
      ]);
      expect(reviewSchema.properties.payload.required).toEqual(expect.arrayContaining([
        "generationRunId", "kind", "expectedHeadRevision", "rawResultId", "rawSha256",
        "labeledResultId", "labeledSha256", "expectedPackFingerprint", "continuityFingerprint",
        "decision", "criteria", "reviewer", "note",
      ]));
      expect(reviewSchema.properties.payload.properties.reviewer).toMatchObject({ const: "codex" });
      expect(reviewSchema.properties.payload).toMatchObject({ additionalProperties: false });
      expect(Object.keys(checkpointRefreshSchema.properties.payload.properties).sort()).toEqual([
        "batchNumber", "expectedHeadRevision",
      ]);
      expect(checkpointRefreshSchema.properties.payload).toMatchObject({
        additionalProperties: false,
        required: ["batchNumber", "expectedHeadRevision"],
      });
      expect(Object.keys(checkpointAttestSchema.properties.payload.properties).sort()).toEqual([
        "batchNumber", "checkpointFingerprint", "checkpointId", "decision",
        "expectedHeadRevision", "note", "reviewer",
      ]);
      expect(checkpointAttestSchema.properties.payload.properties.reviewer).toMatchObject({ const: "codex" });
      expect(checkpointAttestSchema.properties.payload).toMatchObject({ additionalProperties: false });
      const publicSchemas = JSON.stringify({
        observationSchema,
        correctionSchema,
        reviewSchema,
        checkpointRefreshSchema,
        checkpointAttestSchema,
      });
      expect(publicSchemas).not.toMatch(/operationId|headKey|receiptId|requestFingerprint/u);

      const capabilities = parsed(await client.callTool({ name: "get_capabilities", arguments: {} }));
      expect(capabilities).toMatchObject({
        server: { toolCount: EXPECTED_MCP_TOOL_COUNT },
        commandTypes: expect.arrayContaining([
          "append_studio_continuity_observation",
          "append_studio_continuity_correction",
          "submit_studio_generation_review",
          "refresh_studio_generation_checkpoint",
          "attest_studio_generation_checkpoint",
        ]),
      });

      const panel = fixture.units.sixPanel.panels[0]!;
      const observationRequest = {
        command: "append_studio_continuity_observation",
        payload: {
          expectedHeadRevision: 0,
          scope: {
            kind: "source-shot",
            scopeId: "p7-mcp-source-shot-001",
            unitId: fixture.units.sixPanel.unit.id,
            unitRevision: fixture.units.sixPanel.unit.revision,
            startMilliseconds: 0,
            endMilliseconds: 2_500,
          },
          subjectId: fixture.assets.ahang.id,
          field: "position",
          state: {
            status: "resolved",
            value: "石室中央",
            provenance: [{ kind: "codex-review", reference: panel.id }],
          },
        },
      };
      const observation = parsed(await client.callTool({
        name: "execute_command",
        arguments: {
          projectRoot: fixture.root,
          requestId: "p7-mcp-continuity-request-001",
          idempotencyKey: "p7-mcp-continuity-key-001",
          request: observationRequest,
        },
      }));
      expect(observation).toMatchObject({
        command: "append_studio_continuity_observation",
        status: "succeeded",
        replayed: false,
        result: {
          command: "append-observation",
          operationId: observation.requestHash,
          entry: { field: "position", subjectId: fixture.assets.ahang.id },
        },
      });

      const operationInjectionKey = "p7-mcp-continuity-private-key";
      expect(await rejected(client.callTool({
        name: "execute_command",
        arguments: {
          projectRoot: fixture.root,
          requestId: "p7-mcp-continuity-private-request",
          idempotencyKey: operationInjectionKey,
          request: {
            ...observationRequest,
            payload: { ...observationRequest.payload, operationId: "forged-operation" },
          },
        },
      }))).toMatch(/operationId|unrecognized|invalid/i);

      const media = fixture.panelMediaPairs.find((entry) => entry.panelId === panel.id)!;
      const pack = await freezeAndPersistStudioGenerationPack(fixture.root, {
        unitId: fixture.units.sixPanel.unit.id,
        panelId: panel.id,
      });
      const generationRunId = "p7-mcp-review-run-001";
      await dispatchStudioGenerationPack(fixture.root, {
        packId: pack.packId,
        packFingerprint: pack.fingerprint,
        generationRunId,
    provider: "codex",
  });
      const raw = await registerStudioGenerationResult(fixture.root, {
        packId: pack.packId,
        packFingerprint: pack.fingerprint,
        generationRunId,
        variant: "raw",
        mediaSha256: media.raw.imported.sha256,
      });
      const labeled = await registerStudioGenerationResult(fixture.root, {
        packId: pack.packId,
        packFingerprint: pack.fingerprint,
        generationRunId,
        variant: "labeled",
        mediaSha256: media.labeled.imported.sha256,
      });
      const reviewPayload = {
        generationRunId,
        kind: "observation",
        expectedHeadRevision: 0,
        rawResultId: raw.resultId,
        rawSha256: raw.mediaSha256,
        labeledResultId: labeled.resultId,
        labeledSha256: labeled.mediaSha256,
        expectedPackFingerprint: pack.fingerprint,
        continuityFingerprint: pack.pack.continuity.fingerprint,
        decision: "pass",
        criteria: [{ code: "identity-consistency", status: "pass", note: "Codex 逐帧验收。" }],
        reviewer: "codex",
        note: "MCP Codex 提交首次生成结果验收。",
      };
      const review = parsed(await client.callTool({
        name: "execute_command",
        arguments: {
          projectRoot: fixture.root,
          requestId: "p7-mcp-review-request-001",
          idempotencyKey: "p7-mcp-review-key-001",
          request: { command: "submit_studio_generation_review", payload: reviewPayload },
        },
      }));
      expect(review).toMatchObject({
        command: "submit_studio_generation_review",
        status: "succeeded",
        result: {
          generationRunId,
          kind: "observation",
          reviewer: "codex",
          headRevision: 1,
          head: true,
        },
      });

      const userReviewerKey = "p7-mcp-review-user-key-001";
      expect(await rejected(client.callTool({
        name: "execute_command",
        arguments: {
          projectRoot: fixture.root,
          requestId: "p7-mcp-review-user-request-001",
          idempotencyKey: userReviewerKey,
          request: {
            command: "submit_studio_generation_review",
            payload: { ...reviewPayload, reviewer: "user" },
          },
        },
      }))).toMatch(/reviewer|codex|invalid/i);

      const legacyKey = "p7-mcp-legacy-review-key-001";
      expect(await rejected(client.callTool({
        name: "execute_command",
        arguments: {
          projectRoot: fixture.root,
          requestId: "p7-mcp-legacy-review-request-001",
          idempotencyKey: legacyKey,
          request: {
            command: "submit_review",
            payload: {
              itemId: "legacy-item",
              reviewType: "image",
              artifactIds: ["legacy-artifact"],
              expectedScanId: "legacy-scan",
              expectedArtifactHashes: { "legacy-artifact": "a".repeat(64) },
              decision: "pending",
              criteria: [],
            },
          },
        },
      }))).toMatch(/受管素材工程拒绝旧命令 submit_review/u);
      const rejectedKeys = new Set([operationInjectionKey, userReviewerKey, legacyKey]);
      expect((await listCommandLedger(fixture.root)).some((entry) => rejectedKeys.has(entry.idempotencyKey))).toBe(false);
    } finally {
      await client.close();
    }
  }, 60_000);
});
