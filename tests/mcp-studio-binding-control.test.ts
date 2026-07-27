import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";
import { listCommandLedger } from "../src/core/command-bus.js";
import { createManagedProject } from "../src/core/managed-project.js";
import { EXPECTED_MCP_TOOL_COUNT } from "./helpers/mcp-tool-count.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function parsed(result: unknown): Record<string, any> {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return JSON.parse(content.find((entry) => entry.type === "text")?.text ?? "{}") as Record<string, any>;
}

async function clientFor(runtimeRoot: string): Promise<Client> {
  const cwd = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/mcp/server.ts"],
    cwd,
    env: { ...process.env, AI_CANVAS_REGISTRY_PATH: path.join(runtimeRoot, "projects.json") },
    stderr: "pipe",
  });
  const client = new Client({ name: "studio-binding-control-test", version: "0.1.0" });
  await client.connect(transport);
  return client;
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

describe("P6 Studio binding MCP", () => {
  it("暴露有界只读工具与四个严格 UI 安全命令 schema", async () => {
    const runtimeRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "mcp-studio-binding-control-")));
    roots.push(runtimeRoot);
    const projectRoot = (await createManagedProject({ parentRoot: runtimeRoot, name: "P6 MCP 绑定控制" })).paths.root;
    const client = await clientFor(runtimeRoot);
    try {
      const tools = await client.listTools();
      expect(tools.tools).toHaveLength(EXPECTED_MCP_TOOL_COUNT);
      const readTool = tools.tools.find((tool) => tool.name === "get_studio_binding_control");
      expect(readTool?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
      const readSchema = readTool?.inputSchema as {
        required?: string[];
        properties?: { query?: { oneOf?: any[]; anyOf?: any[] } };
      };
      expect(readSchema.required).toEqual(expect.arrayContaining(["projectRoot", "query"]));
      const readVariants = readSchema.properties?.query?.oneOf ?? readSchema.properties?.query?.anyOf ?? [];
      expect(readVariants.map((variant) => variant.properties?.operation?.const)).toEqual([
        "list_units",
        "get_control",
        "list_sections",
        "get_section",
      ]);
      const listVariant = readVariants.find((variant) => variant.properties?.operation?.const === "list_units");
      expect(listVariant.properties.limit).toMatchObject({ minimum: 1, maximum: 36, default: 36 });
      const sectionListVariant = readVariants.find((variant) => variant.properties?.operation?.const === "list_sections");
      expect(sectionListVariant.properties.limit).toMatchObject({ minimum: 1, maximum: 100, default: 50 });
      expect(sectionListVariant.required).toEqual(["operation", "scriptRevisionId"]);
      const sectionGetVariant = readVariants.find((variant) => variant.properties?.operation?.const === "get_section");
      expect(sectionGetVariant.required).toEqual(["operation", "revisionId"]);

      const executeTool = tools.tools.find((tool) => tool.name === "execute_command");
      const executeSchema = executeTool?.inputSchema as {
        properties?: { request?: { oneOf?: any[]; anyOf?: any[] } };
      };
      const commandVariants = executeSchema.properties?.request?.oneOf ?? executeSchema.properties?.request?.anyOf ?? [];
      const command = (name: string) => commandVariants.find((variant) => variant.properties?.command?.const === name);
      const analyze = command("analyze_studio_script_entities");
      const resolve = command("resolve_studio_entity_proposal");
      const confirmEmpty = command("confirm_studio_panel_empty");
      const freeze = command("freeze_studio_asset_binding_set");
      const appendSection = command("append_studio_script_section_revision");
      expect([analyze, resolve, confirmEmpty, freeze, appendSection].every(Boolean)).toBe(true);
      expect(analyze.properties.payload.required).toEqual(["unitId", "panelId", "expectedRevisionToken"]);
      expect(Object.keys(analyze.properties.payload.properties).sort()).toEqual([
        "expectedRevisionToken", "extractedMentions", "panelId", "unitId",
      ]);
      expect(analyze.properties.payload.properties.extractedMentions).toMatchObject({ maxItems: 256 });
      const extractedItem = analyze.properties.payload.properties.extractedMentions.items;
      expect(Object.keys(extractedItem.properties).sort()).toEqual([
        "candidateAssetIds", "category", "endOffsetUtf16", "presence", "role", "startOffsetUtf16",
      ]);
      expect(extractedItem.properties.candidateAssetIds).toMatchObject({ maxItems: 5 });
      expect(Object.keys(resolve.properties.payload.properties).sort()).toEqual([
        "decision", "expectedRevisionToken", "note", "panelId", "presence", "proposalId", "reviewer", "role", "selectedAssetId", "unitId",
      ]);
      expect(resolve.properties.payload.required).toEqual(expect.arrayContaining(["reviewer"]));
      expect(Object.keys(confirmEmpty.properties.payload.properties).sort()).toEqual([
        "expectedRevisionToken", "note", "panelId", "reviewer", "unitId",
      ]);
      expect(confirmEmpty.properties.payload.required).toEqual([
        "unitId", "panelId", "expectedRevisionToken", "reviewer", "note",
      ]);
      expect(confirmEmpty.properties.payload).toMatchObject({ additionalProperties: false });
      expect(Object.keys(freeze.properties.payload.properties).sort()).toEqual([
        "expectedRevisionToken", "panelId", "unitId",
      ]);
      expect(appendSection.properties.payload.required).toEqual([
        "sectionId", "expectedRevision", "kind", "title", "scriptRevisionId", "scriptSha256", "startOffsetUtf16", "endOffsetUtf16",
      ]);
      expect(Object.keys(appendSection.properties.payload.properties)).toEqual([
        "sectionId", "expectedRevision", "kind", "title", "scriptRevisionId", "scriptSha256", "startOffsetUtf16", "endOffsetUtf16",
      ]);
      expect(appendSection.properties.payload).toMatchObject({ additionalProperties: false });
      expect(appendSection.properties.payload.properties.expectedRevision).toMatchObject({ minimum: 0 });
      expect(appendSection.properties.payload.properties.kind).toMatchObject({ enum: ["chapter", "scene"] });
      expect(appendSection.properties.payload.properties.title).toMatchObject({ maxLength: 500 });
      expect(appendSection.properties.payload.properties.scriptSha256).toMatchObject({ pattern: "^[a-f0-9]{64}$" });
      const publicSchemas = JSON.stringify({ analyze, resolve, confirmEmpty, freeze, appendSection });
      expect(publicSchemas).not.toMatch(/assetSources|expectedAnalysisHeadRevision|expectedDecisionHeadRevision|expectedBindingHeadRevision|decisionReceiptIds/u);

      const empty = parsed(await client.callTool({
        name: "get_studio_binding_control",
        arguments: { projectRoot, query: { operation: "list_units", limit: 36 } },
      }));
      expect(empty).toMatchObject({ items: [], total: 0 });

      const capabilities = parsed(await client.callTool({ name: "get_capabilities", arguments: {} }));
      expect(capabilities).toMatchObject({
        server: { toolCount: EXPECTED_MCP_TOOL_COUNT },
        domains: { managedStudio: expect.arrayContaining(["get_studio_binding_control"]) },
        commandTypes: expect.arrayContaining([
          "analyze_studio_script_entities",
          "resolve_studio_entity_proposal",
          "confirm_studio_panel_empty",
          "freeze_studio_asset_binding_set",
          "append_studio_script_section_revision",
        ]),
        managedStudio: {
          scriptSections: {
            writeCommand: "append_studio_script_section_revision",
            publicPayload: ["sectionId", "expectedRevision", "kind", "title", "scriptRevisionId", "scriptSha256", "startOffsetUtf16", "endOffsetUtf16"],
            kinds: ["chapter", "scene"],
            offsetSemantics: "utf16-half-open",
            concurrency: "append-only-head-revision-cas",
            readProjection: "get_studio_binding_control",
            readOperations: ["list_sections", "get_section"],
            listScope: "scriptRevisionId-resolves-script-document-current-heads",
            pageLimit: 100,
            readPayload: "metadata-only-no-body-or-path",
            lineage: "stable-sectionId-fixed-kind-and-script-document",
            durableReconciliation: "immutable-revision-row-proof-no-append-replay",
          },
          bindingControl: {
            operations: ["list_units", "get_control", "list_sections", "get_section"],
            unitPageLimit: 36,
            sectionPageLimit: 100,
            proposalsPerPanelMax: 256,
            candidatesPerProposalMax: 5,
            codexCandidateSemantics: "model-suggestion-only-never-auto-decision-or-binding",
            writeCommands: expect.arrayContaining(["confirm_studio_panel_empty"]),
            durableReconciliation: "read-immutable-section-revisions-or-studio_binding_operation_receipts-only-no-write-replay",
          },
        },
      });

      const base = {
        projectRoot,
        requestId: "mcp-binding-malicious-request-001",
        idempotencyKey: "mcp-binding-malicious-key-001",
        request: {
          command: "analyze_studio_script_entities",
          payload: {
            unitId: "unit-missing",
            panelId: "panel-01",
            expectedRevisionToken: "a".repeat(64),
          },
        },
      };
      expect(await rejected(client.callTool({
        name: "execute_command",
        arguments: {
          ...base,
          request: { ...base.request, payload: { ...base.request.payload, assetSources: [] } },
        },
      }))).toMatch(/assetSources|unrecognized|invalid/i);
      expect(await rejected(client.callTool({
        name: "execute_command",
        arguments: {
          ...base,
          requestId: "mcp-binding-too-many-request-001",
          idempotencyKey: "mcp-binding-too-many-key-001",
          request: {
            ...base.request,
            payload: {
              ...base.request.payload,
              extractedMentions: Array.from({ length: 257 }, () => ({
                startOffsetUtf16: 0,
                endOffsetUtf16: 1,
                category: "character",
                presence: "optional",
                role: "待审",
              })),
            },
          },
        },
      }))).toMatch(/256|too_big|invalid/i);
      expect(await rejected(client.callTool({
        name: "execute_command",
        arguments: {
          ...base,
          requestId: "mcp-binding-too-many-candidates-request",
          idempotencyKey: "mcp-binding-too-many-candidates-key",
          request: {
            ...base.request,
            payload: {
              ...base.request.payload,
              extractedMentions: [{
                startOffsetUtf16: 0,
                endOffsetUtf16: 1,
                category: "character",
                presence: "optional",
                role: "待审",
                candidateAssetIds: Array.from({ length: 6 }, (_, index) => `character-${index}`),
              }],
            },
          },
        },
      }))).toMatch(/5|too_big|invalid/i);

      const confirmBase = {
        projectRoot,
        requestId: "mcp-confirm-empty-invalid-request",
        idempotencyKey: "mcp-confirm-empty-invalid-key",
        request: {
          command: "confirm_studio_panel_empty",
          payload: {
            unitId: "unit-missing",
            panelId: "panel-01",
            expectedRevisionToken: "a".repeat(64),
            reviewer: "user",
            note: "已逐段审阅。",
          },
        },
      };
      expect(await rejected(client.callTool({
        name: "execute_command",
        arguments: confirmBase,
      }))).toMatch(/reviewer.*codex|MCP\/Codex/i);
      expect(await rejected(client.callTool({
        name: "execute_command",
        arguments: {
          ...confirmBase,
          request: { ...confirmBase.request, payload: { ...confirmBase.request.payload, emptyConfirmationId: "forged" } },
        },
      }))).toMatch(/emptyConfirmationId|unrecognized|invalid/i);
      expect(await rejected(client.callTool({
        name: "execute_command",
        arguments: {
          ...confirmBase,
          requestId: "mcp-confirm-empty-blank-note-request",
          idempotencyKey: "mcp-confirm-empty-blank-note-key",
          request: { ...confirmBase.request, payload: { ...confirmBase.request.payload, note: "   " } },
        },
      }))).toMatch(/note|too_small|invalid/i);

      const sectionBase = {
        projectRoot,
        requestId: "mcp-section-malicious-request-001",
        idempotencyKey: "mcp-section-malicious-key-001",
        request: {
          command: "append_studio_script_section_revision",
          payload: {
            sectionId: "chapter-ep01-01",
            expectedRevision: 0,
            kind: "chapter",
            title: "第一章",
            scriptRevisionId: "script-revision-missing",
            scriptSha256: "a".repeat(64),
            startOffsetUtf16: 0,
            endOffsetUtf16: 8,
          },
        },
      };
      expect(await rejected(client.callTool({
        name: "execute_command",
        arguments: {
          ...sectionBase,
          request: { ...sectionBase.request, payload: { ...sectionBase.request.payload, body: "禁止注入原文" } },
        },
      }))).toMatch(/body|unrecognized|invalid/i);
      expect(await rejected(client.callTool({
        name: "execute_command",
        arguments: {
          ...sectionBase,
          requestId: "mcp-section-invalid-range-request",
          idempotencyKey: "mcp-section-invalid-range-key",
          request: { ...sectionBase.request, payload: { ...sectionBase.request.payload, endOffsetUtf16: 0 } },
        },
      }))).toMatch(/endOffsetUtf16|greater|positive|invalid/i);
      expect(await listCommandLedger(projectRoot)).toEqual([]);
    } finally {
      await client.close();
    }
  }, 30_000);

  it("MCP 进程重启后可按旧 script revision 分页恢复同文档 current heads，并按 revisionId 读取历史元数据", async () => {
    const runtimeRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "mcp-studio-section-restart-")));
    roots.push(runtimeRoot);
    const projectRoot = (await createManagedProject({ parentRoot: runtimeRoot, name: "P6 MCP section 重启恢复" })).paths.root;
    let client: Client | undefined = await clientFor(runtimeRoot);
    const bodyV1 = "第一章：阿航抵达。\n场景一：阿航走进石室。";
    const bodyV2 = "第一章：阿航抵达。\n场景一：阿航走进石室，守卫回头。";
    const command = async (index: number, request: Record<string, unknown>) => parsed(await client!.callTool({
      name: "execute_command",
      arguments: {
        projectRoot,
        requestId: `mcp-section-restart-request-${String(index).padStart(3, "0")}`,
        idempotencyKey: `mcp-section-restart-key-${String(index).padStart(3, "0")}`,
        request,
      },
    }));
    try {
      await command(1, {
        command: "create_studio_script_document",
        payload: { id: "script-mcp-sections", title: "MCP sections", expectedRevision: 0 },
      });
      const scriptV1 = (await command(2, {
        command: "append_studio_script_revision",
        payload: {
          documentId: "script-mcp-sections",
          expectedRevision: 0,
          body: bodyV1,
          source: "mcp-restart-fixture",
          sourceVersion: "v1",
        },
      })).result.revision;
      const chapterV1 = (await command(3, {
        command: "append_studio_script_section_revision",
        payload: {
          sectionId: "chapter-mcp-01",
          expectedRevision: 0,
          kind: "chapter",
          title: "第一章",
          scriptRevisionId: scriptV1.id,
          scriptSha256: scriptV1.bodySha256,
          startOffsetUtf16: 0,
          endOffsetUtf16: bodyV1.indexOf("\n"),
        },
      })).result;
      const scene = (await command(4, {
        command: "append_studio_script_section_revision",
        payload: {
          sectionId: "scene-mcp-01",
          expectedRevision: 0,
          kind: "scene",
          title: "石室",
          scriptRevisionId: scriptV1.id,
          scriptSha256: scriptV1.bodySha256,
          startOffsetUtf16: bodyV1.indexOf("场景一"),
          endOffsetUtf16: bodyV1.length,
        },
      })).result;
      const scriptV2 = (await command(5, {
        command: "append_studio_script_revision",
        payload: {
          documentId: "script-mcp-sections",
          expectedRevision: 1,
          body: bodyV2,
          source: "mcp-restart-fixture",
          sourceVersion: "v2",
        },
      })).result.revision;
      const chapterV2 = (await command(6, {
        command: "append_studio_script_section_revision",
        payload: {
          sectionId: "chapter-mcp-01",
          expectedRevision: 1,
          kind: "chapter",
          title: "第一章（修订）",
          scriptRevisionId: scriptV2.id,
          scriptSha256: scriptV2.bodySha256,
          startOffsetUtf16: 0,
          endOffsetUtf16: bodyV2.indexOf("\n"),
        },
      })).result;

      await client.close();
      client = undefined;
      client = await clientFor(runtimeRoot);

      const firstPage = parsed(await client.callTool({
        name: "get_studio_binding_control",
        arguments: {
          projectRoot,
          query: { operation: "list_sections", scriptRevisionId: scriptV1.id, limit: 1 },
        },
      }));
      expect(firstPage.items).toHaveLength(1);
      expect(firstPage.nextCursor).toEqual(expect.any(String));
      const secondPage = parsed(await client.callTool({
        name: "get_studio_binding_control",
        arguments: {
          projectRoot,
          query: { operation: "list_sections", scriptRevisionId: scriptV1.id, cursor: firstPage.nextCursor, limit: 1 },
        },
      }));
      expect(secondPage.items).toHaveLength(1);
      expect(secondPage.nextCursor).toBeUndefined();
      const heads = [...firstPage.items, ...secondPage.items].sort((left, right) => left.sectionId.localeCompare(right.sectionId));
      expect(heads).toEqual([
        expect.objectContaining({ id: chapterV2.id, sectionId: "chapter-mcp-01", revision: 2, scriptRevisionId: scriptV2.id }),
        expect.objectContaining({ id: scene.id, sectionId: "scene-mcp-01", revision: 1, scriptRevisionId: scriptV1.id }),
      ]);

      const historical = parsed(await client.callTool({
        name: "get_studio_binding_control",
        arguments: { projectRoot, query: { operation: "get_section", revisionId: chapterV1.id } },
      }));
      expect(historical).toMatchObject({
        id: chapterV1.id,
        sectionId: "chapter-mcp-01",
        revision: 1,
        kind: "chapter",
        scriptRevisionId: scriptV1.id,
      });
      const publicResponse = JSON.stringify({ heads, historical });
      expect(publicResponse).not.toContain(projectRoot);
      expect(publicResponse).not.toContain(bodyV1);
      expect(publicResponse).not.toMatch(/"(?:body|bodyPath|path)"\s*:/u);

      expect(await rejected(client.callTool({
        name: "get_studio_binding_control",
        arguments: {
          projectRoot,
          query: { operation: "list_sections", scriptRevisionId: scriptV1.id, limit: 101 },
        },
      }))).toMatch(/100|too_big|invalid/i);
      expect(await rejected(client.callTool({
        name: "get_studio_binding_control",
        arguments: {
          projectRoot,
          query: { operation: "get_section", revisionId: chapterV1.id, body: true },
        },
      }))).toMatch(/body|unrecognized|invalid/i);
      expect(await rejected(client.callTool({
        name: "get_studio_binding_control",
        arguments: {
          projectRoot,
          query: { operation: "get_section", revisionId: "script-section-missing" },
        },
      }))).toMatch(/不存在|section-not-found|missing/i);
    } finally {
      await client?.close();
    }
  }, 30_000);
});
