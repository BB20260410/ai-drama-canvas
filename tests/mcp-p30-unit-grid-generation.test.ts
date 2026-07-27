import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";
import { registerProject, setActiveProjectRegistration } from "../src/core/sidecar.js";
import {
  createStudioP7Fixture,
  seedStudioP7ResolvedPanelContinuity,
  studioP7UserContinuationWaiver,
  type StudioP7Fixture,
} from "./helpers/studio-p7-fixture.js";

const originalRegistry = process.env.AI_CANVAS_REGISTRY_PATH;
let fixture: StudioP7Fixture | undefined;
let client: Client | undefined;

afterEach(async () => {
  await client?.close();
  await fixture?.cleanup();
  client = undefined;
  fixture = undefined;
  if (originalRegistry === undefined) delete process.env.AI_CANVAS_REGISTRY_PATH;
  else process.env.AI_CANVAS_REGISTRY_PATH = originalRegistry;
});

function parsed(result: unknown): Record<string, any> {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return JSON.parse(content.find((entry) => entry.type === "text")?.text ?? "{}") as Record<string, any>;
}

function commandArguments(projectRoot: string, suffix: string, request: Record<string, unknown>) {
  return {
    projectRoot,
    requestId: `p30-mcp-request-${suffix}`,
    idempotencyKey: `p30-mcp-key-${suffix}`,
    request,
  };
}

async function execute(
  activeClient: Client,
  projectRoot: string,
  suffix: string,
  request: Record<string, unknown>,
) {
  return parsed(await activeClient.callTool({
    name: "execute_command",
    arguments: commandArguments(projectRoot, suffix, request),
  }));
}

function collectLocalPathLocations(value: unknown, location = "root", output: string[] = []): string[] {
  if (!value || typeof value !== "object") return output;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectLocalPathLocations(entry, `${location}[${index}]`, output));
    return output;
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const child = `${location}.${key}`;
    if (key === "localPath") output.push(child);
    collectLocalPathLocations(entry, child, output);
  }
  return output;
}

describe.sequential("P30 MCP unit-grid generation 纵向链", () => {
  it("保留 panel 兼容、严格拒绝混合目标，并把一次性 pre-call 授权闭合在既有 execute_command", async () => {
    fixture = await createStudioP7Fixture();
    process.env.AI_CANVAS_REGISTRY_PATH = path.join(fixture.parentRoot, "p30-mcp-projects.json");
    await registerProject(fixture.shell.project);
    await setActiveProjectRegistration(fixture.root);
    for (const panel of fixture.units.twoPanel.panels) {
      await seedStudioP7ResolvedPanelContinuity(fixture.root, {
        unitId: fixture.units.twoPanel.unit.id,
        panelId: panel.id,
        assetIds: panel.assets.filter((asset) => asset.presence !== "forbidden").map((asset) => asset.assetId),
      });
    }

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", "src/mcp/server.ts"],
      cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
      env: {
        ...process.env,
        AI_CANVAS_REGISTRY_PATH: process.env.AI_CANVAS_REGISTRY_PATH,
        AI_CANVAS_RECORDED_SOURCE_DIGEST: "",
      },
      stderr: "pipe",
    });
    client = new Client({ name: "p30-unit-grid-mcp-test", version: "0.1.0" });
    await client.connect(transport);

    const tools = await client.listTools();
    const executeSchema = tools.tools.find((tool) => tool.name === "execute_command")?.inputSchema as {
      properties?: { request?: { oneOf?: any[]; anyOf?: any[] } };
    };
    const commandVariants = executeSchema.properties?.request?.oneOf ?? executeSchema.properties?.request?.anyOf ?? [];
    expect(commandVariants.map((variant) => variant.properties?.command?.const)).toEqual(expect.arrayContaining([
      "prepare_studio_imagegen_call",
      "reconcile_studio_imagegen_call",
    ]));

    const mixedReadiness = await client.callTool({
      name: "get_studio_generation_control",
      arguments: {
        projectRoot: fixture.root,
        query: {
          operation: "readiness",
          targetKind: "unit-grid",
          unitId: fixture.units.twoPanel.unit.id,
          panelId: fixture.units.twoPanel.panels[0]!.id,
        },
      },
    });
    expect(mixedReadiness.isError).toBe(true);

    const continuationWaiver = await studioP7UserContinuationWaiver(
      fixture.root,
      fixture.units.twoPanel,
      "fixture:mcp-p30-unit-grid",
    );
    const readiness = parsed(await client.callTool({
      name: "get_studio_generation_control",
      arguments: {
        projectRoot: fixture.root,
        query: {
          operation: "readiness",
          targetKind: "unit-grid",
          unitId: fixture.units.twoPanel.unit.id,
          continuationWaiver,
        },
      },
    }));
    expect(readiness).toMatchObject({
      operation: "readiness",
      status: "ready",
      targetKind: "unit-grid",
      candidate: {
        target: { targetKind: "unit-grid", unitId: fixture.units.twoPanel.unit.id, panelCount: 2 },
        panelCount: 2,
      },
      writeCommand: {
        command: "freeze_studio_generation_pack",
        payload: {
          targetKind: "unit-grid",
          unitId: fixture.units.twoPanel.unit.id,
          continuationWaiver,
        },
      },
      controlReferencesExposed: false,
    });
    expect(JSON.stringify(readiness)).not.toContain("localPath");

    const frozen = await execute(client, fixture.root, "freeze", {
      command: "freeze_studio_generation_pack",
      payload: readiness.writeCommand.payload,
    });
    expect(frozen).toMatchObject({
      status: "succeeded",
      result: { targetKind: "unit-grid", pack: { target: { targetKind: "unit-grid" } } },
    });
    const freezeResult = frozen.result as Record<string, any>;

    const packControl = parsed(await client.callTool({
      name: "get_studio_generation_control",
      arguments: { projectRoot: fixture.root, query: { operation: "pack", packId: freezeResult.packId } },
    }));
    expect(packControl).toMatchObject({
      operation: "pack",
      status: "ready",
      targetKind: "unit-grid",
      request: { target: { targetKind: "unit-grid" } },
      agentExecution: {
        preCallPayloadTemplate: {
          command: "prepare_studio_imagegen_call",
          expectedRevision: 0,
        },
      },
      controlReferencesExposed: true,
    });
    const localPathLocations = collectLocalPathLocations(packControl);
    expect(localPathLocations.length).toBeGreaterThan(0);
    expect(localPathLocations.every((location) => /^(?:root\.request|root\.pack\.request)\.controlReferences\[\d+\]\.localPath$/u.test(location))).toBe(true);
    expect(JSON.stringify(packControl)).not.toContain("objectPath");

    const planned = await execute(client, fixture.root, "plan", {
      command: "create_studio_generation_plan",
      payload: { nodes: [{ targetKind: "unit-grid", unitId: fixture.units.twoPanel.unit.id }] },
    });
    expect(planned).toMatchObject({ status: "succeeded", result: { nodeCount: 1 } });
    const planId = planned.result.planId as string;
    const planControl = parsed(await client.callTool({
      name: "get_studio_generation_control",
      arguments: { projectRoot: fixture.root, query: { operation: "plan", planId } },
    }));
    expect(planControl).toMatchObject({
      status: "ready",
      plan: { nodes: [{ targetKind: "unit-grid", targetKey: `unit-grid:${fixture.units.twoPanel.unit.id}` }] },
    });
    const generationRunId = planControl.plan.nodes[0].generationRunId as string;

    const dispatched = await execute(client, fixture.root, "dispatch", {
      command: "dispatch_studio_generation_pack",
      payload: {
        packId: freezeResult.packId,
        packFingerprint: freezeResult.fingerprint,
        generationRunId,
        provider: "codex",
        expectedRevision: freezeResult.pack.target.unitRevision,
      },
    });
    expect(dispatched).toMatchObject({ status: "succeeded", result: { provider: "codex", generationRunId } });

    const active = parsed(await client.callTool({ name: "get_active_managed_studio_context", arguments: {} }));
    const preparePayload = {
      projectContextToken: active.projectContextToken,
      packId: freezeResult.packId,
      packFingerprint: freezeResult.fingerprint,
      generationRunId,
      provider: "codex",
      expectedRevision: 0,
    } as const;
    const wrongContext = await execute(client, fixture.root, "prepare-wrong-context", {
      command: "prepare_studio_imagegen_call",
      payload: { ...preparePayload, projectContextToken: `studioctx-v1-${"0".repeat(64)}` },
    });
    expect(wrongContext).toMatchObject({ error: { code: expect.any(String) } });
    const wrongProvider = await execute(client, fixture.root, "prepare-wrong-provider", {
      command: "prepare_studio_imagegen_call",
      payload: { ...preparePayload, provider: "grok" },
    });
    expect(wrongProvider).toMatchObject({ error: { code: expect.any(String) } });
    const wrongPack = await execute(client, fixture.root, "prepare-wrong-pack", {
      command: "prepare_studio_imagegen_call",
      payload: { ...preparePayload, packFingerprint: "0".repeat(64) },
    });
    expect(wrongPack).toMatchObject({ error: { code: expect.any(String) } });

    const firstPrepare = await execute(client, fixture.root, "prepare-first", {
      command: "prepare_studio_imagegen_call",
      payload: preparePayload,
    });
    expect(firstPrepare).toMatchObject({
      status: "succeeded",
      replayed: false,
      result: { generationRunId, callAllowed: true, idempotentReplay: false, status: "generation_unknown" },
    });
    const callId = firstPrepare.result.callId as string;
    const replayPrepare = await execute(client, fixture.root, "prepare-new-operation", {
      command: "prepare_studio_imagegen_call",
      payload: preparePayload,
    });
    expect(replayPrepare).toMatchObject({
      status: "succeeded",
      result: { callId, callAllowed: false, idempotentReplay: true },
    });

    const reconciled = await execute(client, fixture.root, "reconcile-not-invoked", {
      command: "reconcile_studio_imagegen_call",
      payload: {
        callId,
        projectContextToken: active.projectContextToken,
        result: "not-invoked",
        evidenceReference: "p30-mcp-fixture-no-model-call",
        evidenceFingerprint: "a".repeat(64),
        note: "定向 MCP 测试未调用任何图像模型。",
        expectedRevision: 0,
      },
    });
    expect(reconciled).toMatchObject({ status: "succeeded", result: { callId, kind: "not-invoked" } });
    const cancelled = await execute(client, fixture.root, "cancel-after-reconcile", {
      command: "cancel_studio_generation_run",
      payload: { generationRunId, reason: "fixture pre-call reconciled as not invoked" },
    });
    expect(cancelled).toMatchObject({ status: "succeeded", result: { kind: "cancelled", generationRunId } });

    const history = parsed(await client.callTool({
      name: "get_studio_generation_control",
      arguments: {
        projectRoot: fixture.root,
        query: {
          operation: "history",
          targetKind: "unit-grid",
          unitId: fixture.units.twoPanel.unit.id,
          limit: 10,
          order: "newest-first",
        },
      },
    }));
    expect(history).toMatchObject({
      operation: "history",
      status: "ready",
      targetKind: "unit-grid",
      targetKey: `unit-grid:${fixture.units.twoPanel.unit.id}`,
      order: "newest-first",
      items: [],
      controlReferencesExposed: false,
    });
  }, 120_000);
});
