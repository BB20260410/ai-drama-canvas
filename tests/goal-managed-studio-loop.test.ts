/**
 * Goal 验收：桌面/MCP 同项目 · 锁输入 → 写回可见 · 漂移不可提升 · 短 Prompt 可 list
 * 驱动 shipped core + MCP stdio，禁止 mock 被测单元。
 */
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import {
  executeIdempotentCommand,
  type CommandRequest,
  type IdempotentCommandInput,
} from "../src/core/command-bus.js";
import { getStudioGenerationControlEnvelope } from "../src/core/codex.js";
import { importStudioMedia, getStudioCanonicalAsset } from "../src/core/material-studio.js";
import { getStudioProductionUnitSnapshot } from "../src/core/studio-production.js";
import { getStudioProductionDashboard } from "../src/core/studio-production-dashboard.js";
import {
  createStudioP7Fixture,
  seedStudioP7ResolvedContinuity,
  type StudioP7Fixture,
} from "./helpers/studio-p7-fixture.js";

const roots: string[] = [];
let fixture: StudioP7Fixture | undefined;

afterEach(async () => {
  await fixture?.cleanup();
  fixture = undefined;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function envelope(seq: number, request: CommandRequest): IdempotentCommandInput {
  return {
    requestId: `goal-loop-req-${String(seq).padStart(4, "0")}`,
    idempotencyKey: `goal-loop-idem-${String(seq).padStart(4, "0")}`,
    request,
  };
}

/** Dashboard / MCP 投影：不得泄漏库与 body 路径 */
function noDashboardPaths(value: unknown): void {
  const text = JSON.stringify(value);
  expect(text).not.toMatch(/\.sqlite|bodyPath|databasePath/u);
}

/** 命令结果：不得泄漏账本/CAS 根路径键（与 studio-command-bus 合同对齐） */
function noLedgerCasRoots(value: unknown): void {
  expect(value).not.toHaveProperty("databasePath");
  expect(value).not.toHaveProperty("packCasRoot");
  const text = JSON.stringify(value);
  expect(text).not.toContain("studio-generation-ledger.sqlite");
  expect(text).not.toContain("studio-generation/objects/sha256");
}

describe("Goal · 受管 Studio 终态环", () => {
  it("桌面驾驶舱有界投影含权威锁字段且无库路径", async () => {
    fixture = await createStudioP7Fixture();
    await seedStudioP7ResolvedContinuity(fixture);
    const root = fixture.root;
    const projectId = fixture.shell.project.id;

    const overview = await getStudioProductionDashboard(root, { operation: "overview" });
    expect(overview.projectId).toBe(projectId);
    noDashboardPaths(overview);

    const assets = await getStudioProductionDashboard(root, { operation: "assets", limit: 36 });
    if (assets.operation !== "assets") throw new Error("expected assets");
    const locked = assets.page.items.filter((item) => item.hasPrimaryAuthority);
    expect(locked.length).toBeGreaterThan(0);
    expect(locked.some((item) => Boolean(item.authorityThumbnailRecipeKey || item.authorityMediaSha256))).toBe(true);
    noDashboardPaths(assets);

    const units = await getStudioProductionDashboard(root, { operation: "units", limit: 36 });
    if (units.operation !== "units") throw new Error("expected units");
    expect(units.page.items.length).toBeGreaterThan(0);
    expect(units.page.limit).toBeLessThanOrEqual(36);
    noDashboardPaths(units);
  }, 120_000);

  it("shipped 写回：freeze→漂移→register 后可见且 promotionEligible=false", async () => {
    fixture = await createStudioP7Fixture();
    await seedStudioP7ResolvedContinuity(fixture);
    const root = fixture.root;
    const unitId = fixture.units.sixPanel.unit.id;
    const panelId = fixture.units.sixPanel.panels[0]!.id;

    const unitLive = await getStudioProductionUnitSnapshot(root, unitId);
    if (!unitLive) throw new Error("unit missing");

    const freeze = await executeIdempotentCommand(root, envelope(10, {
      command: "freeze_studio_generation_pack",
      payload: { unitId, panelId, expectedRevision: unitLive.unit.revision },
    }));
    const frozen = freeze.result as {
      packId: string;
      fingerprint: string;
      pack: { target: { unitRevision: number } };
    };
    expect(frozen.packId).toBeTruthy();
    noLedgerCasRoots(freeze.result);

    const resultPath = path.join(root, "goal-loop-result.png");
    await sharp({ create: { width: 96, height: 128, channels: 3, background: "#224466" } }).png().toFile(resultPath);
    const imported = await importStudioMedia(root, { sourcePath: resultPath, kind: "image" });

    // 先派发（仍 ready），再漂移资产知识，最后登记晚到结果
    await executeIdempotentCommand(root, envelope(11, {
      command: "dispatch_studio_generation_pack",
      payload: {
        packId: frozen.packId,
        packFingerprint: frozen.fingerprint,
        generationRunId: "goal-loop-run-1",
        provider: "codex",
        expectedRevision: frozen.pack.target.unitRevision,
      },
    }));

    const ahangId = fixture.assets.ahang.id;
    const detail = await getStudioCanonicalAsset(root, ahangId);
    if (!detail) throw new Error("asset missing");
    await executeIdempotentCommand(root, envelope(12, {
      command: "update_studio_asset",
      payload: {
        assetId: ahangId,
        expectedRevision: detail.revision,
        aliases: [...detail.aliases, "goal-loop-drift-alias"],
      },
    }));

    const registered = await executeIdempotentCommand(root, envelope(13, {
      command: "register_studio_generation_result",
      payload: {
        packId: frozen.packId,
        packFingerprint: frozen.fingerprint,
        generationRunId: "goal-loop-run-1",
        variant: "raw",
        mediaSha256: imported.sha256,
        expectedRevision: unitLive.unit.revision,
      },
    }));
    expect(registered).toMatchObject({
      status: "succeeded",
      result: {
        generationRunId: "goal-loop-run-1",
        packId: frozen.packId,
        inputCurrent: false,
        promotionEligible: false,
      },
    });
    noLedgerCasRoots(registered.result);

    const history = await getStudioGenerationControlEnvelope(root, {
      operation: "history",
      unitId,
      panelId,
      limit: 12,
    });
    const blob = JSON.stringify(history);
    expect(blob.includes("goal-loop-run-1") || blob.includes(frozen.packId)).toBe(true);
    noDashboardPaths(history);
    expect(blob).not.toContain("studio-generation-ledger.sqlite");

    // 桌面同一读面：dashboard unit 仍可达且无路径泄漏
    const unitDash = await getStudioProductionDashboard(root, { operation: "unit", unitId, panelId });
    expect(unitDash.projectId).toBe(fixture.shell.project.id);
    noDashboardPaths(unitDash);
  }, 180_000);

  it("MCP listPrompts 含短环 managed_studio_lock_generate_writeback 且 listTools 含同项目读面", async () => {
    const cwd = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const runtimeRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "goal-mcp-prompts-")));
    roots.push(runtimeRoot);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", "src/mcp/server.ts"],
      cwd,
      env: { ...process.env, AI_CANVAS_REGISTRY_PATH: path.join(runtimeRoot, "projects.json") },
      stderr: "pipe",
    });
    const client = new Client({ name: "goal-loop-test", version: "0.1.0" });
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      const names = tools.tools.map((t) => t.name);
      for (const required of [
        "get_managed_studio_overview",
        "get_studio_production_dashboard",
        "get_studio_binding_control",
        "get_studio_generation_control",
        "list_studio_assets",
        "list_studio_text_documents",
        "execute_command",
      ]) {
        expect(names).toContain(required);
      }
      const prompts = await client.listPrompts();
      const promptNames = prompts.prompts.map((p) => p.name);
      expect(promptNames).toContain("managed_studio_lock_generate_writeback");
      const short = prompts.prompts.find((p) => p.name === "managed_studio_lock_generate_writeback");
      expect(short?.description).toMatch(/读锁|写回|Review|提示词/i);

      const got = await client.getPrompt({
        name: "managed_studio_lock_generate_writeback",
        arguments: { projectRoot: runtimeRoot, provider: "codex" },
      });
      const text = (got.messages[0]?.content as { text?: string })?.text ?? "";
      expect(text).toContain("freeze_studio_generation_pack");
      expect(text).toContain("commit_agent_imagegen_result_bundle");
      expect(text).toContain("get_studio_production_dashboard");
    } finally {
      await client.close().catch(() => undefined);
    }
  }, 60_000);
});
