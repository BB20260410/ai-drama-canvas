import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

function parsed(result: unknown): Record<string, any> {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return JSON.parse(content.find((entry) => entry.type === "text")?.text ?? "{}") as Record<string, any>;
}

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "ai-canvas-mcp-fusion-")));
  roots.push(root);
  const sourceRoot = path.join(root, "source");
  const targetParent = path.join(root, "targets");
  const packageRoot = path.join(sourceRoot, "07_9x16_15秒融合制作包");
  const unitRelative = "蜀道山古蜀卷第三季_EP01_测试_9x16_漫剧/04_15秒融合分镜/EP01_15s_001_测试.md";
  await Promise.all([
    mkdir(path.join(packageRoot, path.dirname(unitRelative)), { recursive: true }),
    mkdir(path.join(sourceRoot, "05_提示词"), { recursive: true }),
    mkdir(path.join(sourceRoot, "01_剧本"), { recursive: true }),
    mkdir(targetParent, { recursive: true }),
  ]);
  const assets = `# 全季资产库

### C01 阿航

- **出场集数**：EP01
- **AI 出图提示词**：
  电影级写实青年。

### S01 山路

- **出场集数**：EP01
- **AI 出图提示词**：
  商周山路。

### P01 布囊

- **出场集数**：EP01
- **AI 出图提示词**：
  不透明素麻布囊。
`;
  const sourcePrompt = `# EP01 提示词

#### 镜01 [13s] 【中景】（24帧）
**参考素材**：@C01 阿航、@S01 山路、@P01 布囊
【参考】@图片1=C01，@图片2=S01，@图片3=P01。
`;
  const unitMarkdown = `# EP01 15s-001｜测试

## 3. 机位 / 焦段 / 运镜

| 原镜 | 景别 | 焦段 | 机位 | 运镜 | 帧率 | 备注 |
|---|---|---|---|---|---|---|
| 镜01 | 中景 | 50mm | 平视 | 侧移 | 24 | 起幅 |

## 4. 人物 / 道具站位

参考 C01、S01、P01。

## 7. 首帧生图提示词

电影级写实，9:16，阿航在山路按住不透明布囊。

## 8. 图生视频中文提示词

按时间段执行。

### 原镜01 视频提示词

参考素材：@C01、@S01、@P01。
电影级写实，阿航在山路按住不透明布囊。
尾帧：布囊保持不透明，阿航停步。

## 9. 生成注意事项

禁止露出布囊内部物品。
`;
  const units = [{
    id: "EP01_15s_001",
    episode: "EP01",
    episode_title: "测试",
    unit_title: "测试",
    md_path: unitRelative,
    source_script: "01_剧本/第三季_EP01_测试.md",
    source_prompt_table: "05_提示词/第三季_EP01_提示词表.md",
    source_shots: [1],
    source_duration_seconds: 13,
    standard_duration_seconds: 15,
    aspect_ratio: "9:16",
    story_goal: "测试连续性",
    schedule: [
      { start: 0, end: 13, shot: "镜01", seconds: 13, content: "阿航在山路按住布囊" },
      { start: 13, end: 15, shot: "扩写补足", seconds: 2, content: "动作收束，不新增剧情" },
    ],
    asset_ids: ["C01", "S01", "P01"],
    reference_image_paths: [],
    validation: { source_order_preserved: true, source_duration_lte_15: true, no_compression: true },
  }];
  await Promise.all([
    writeFile(path.join(packageRoot, "15s_fused_units.json"), `${JSON.stringify(units, null, 2)}\n`, "utf8"),
    writeFile(path.join(packageRoot, unitRelative), unitMarkdown, "utf8"),
    writeFile(path.join(sourceRoot, "05_提示词", "00_全季资产库.md"), assets, "utf8"),
    writeFile(path.join(sourceRoot, "05_提示词", "第三季_EP01_提示词表.md"), sourcePrompt, "utf8"),
    writeFile(path.join(sourceRoot, "01_剧本", "第三季_EP01_测试.md"), "# EP01 测试剧本\n", "utf8"),
  ]);
  const authorityPath = path.join(root, "authority.jpg");
  const pixels = Buffer.alloc(900 * 1600 * 3);
  for (let index = 0; index < pixels.length; index += 3) {
    const pixel = index / 3;
    const x = pixel % 900;
    const y = Math.floor(pixel / 900);
    pixels[index] = (x * 17 + y * 7) % 256;
    pixels[index + 1] = (x * 5 + y * 19) % 256;
    pixels[index + 2] = (x * 11 + y * 3) % 256;
  }
  const authorityBytes = await sharp(pixels, { raw: { width: 900, height: 1600, channels: 3 } }).jpeg({ quality: 90 }).toBuffer();
  await writeFile(authorityPath, authorityBytes);
  const authoritySha256 = createHash("sha256").update(authorityBytes).digest("hex");
  const expectedCounts = { episodes: 1, units: 1, sourceShots: 1, scheduleRows: 2, assets: 3, characters: 1, scenes: 1, props: 1, standardDurationSeconds: 15 };
  return { root, sourceRoot, packageRoot, targetParent, authorityPath, authoritySha256, expectedCounts };
}

describe("第三季融合生产 MCP 入口", () => {
  it("只读预检、幂等物化、当前索引参考板与连续性查询贯通且不返回图片内容", async () => {
    const data = await fixture();
    const cwd = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", "src/mcp/server.ts"],
      cwd,
      env: { ...process.env, AI_CANVAS_REGISTRY_PATH: path.join(data.root, "projects.json") },
      stderr: "pipe",
    });
    const client = new Client({ name: "ai-canvas-fusion-test", version: "0.1.0" });
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
        "inspect_fusion_package",
        "materialize_fusion_project",
        "list_fusion_production_assets",
        "list_continuity_tracks",
        "get_continuity_spans",
        "build_fusion_reference_board",
        "build_fusion_storyboard_grid",
        "materialize_fusion_panel_references",
        "audit_fusion_panel_references",
        "list_fusion_panel_reference_resolutions",
        "get_fusion_panel_reference_resolution",
        "list_derived_panel_reference_assets",
        "upsert_panel_reference_override",
        "register_derived_panel_reference_artifact",
        "materialize_fusion_visual_constraints",
        "audit_fusion_visual_constraints",
        "list_fusion_visual_constraints",
        "get_fusion_visual_constraint",
        "upsert_fusion_visual_constraint_override",
        "get_fusion_storyboard_sheet_state",
        "list_fusion_storyboard_sheets",
        "migrate_fusion_storyboard_sheets",
        "render_fusion_storyboard_sheet",
      ]));
      const materializeSchema = tools.tools.find((tool) => tool.name === "materialize_fusion_project")?.inputSchema as {
        properties?: Record<string, any>;
        required?: string[];
      };
      expect(materializeSchema.required).toEqual(expect.arrayContaining(["requestId", "idempotencyKey", "packageRoot", "targetParent"]));
      expect(materializeSchema.properties?.authorities?.items?.properties).toEqual(expect.objectContaining({ expectedSha256: expect.anything(), exposeToGeneration: expect.anything() }));
      expect(materializeSchema.properties?.authorities?.items?.required).toEqual(expect.arrayContaining(["expectedSha256", "exposeToGeneration"]));
      const executeSchema = tools.tools.find((tool) => tool.name === "execute_command")?.inputSchema as {
        properties?: { request?: { anyOf?: Array<{ properties?: { command?: { const?: string } } }>; oneOf?: Array<{ properties?: { command?: { const?: string } } }> } };
      };
      const variants = executeSchema.properties?.request?.oneOf ?? executeSchema.properties?.request?.anyOf ?? [];
      expect(variants.map((variant) => variant.properties?.command?.const)).toEqual(expect.arrayContaining(["materialize_fusion_project", "build_fusion_reference_board", "build_fusion_storyboard_grid", "materialize_fusion_panel_references", "materialize_fusion_visual_constraints", "upsert_fusion_visual_constraint_override", "upsert_panel_reference_override", "register_derived_panel_reference_artifact", "migrate_fusion_storyboard_evidence", "migrate_fusion_storyboard_sheets", "render_fusion_storyboard_sheet"]));
      const directGridSchema = tools.tools.find((tool) => tool.name === "build_fusion_storyboard_grid")?.inputSchema as { properties?: Record<string, unknown> };
      expect(directGridSchema.properties).toEqual(expect.objectContaining({ referenceOverride: expect.anything() }));

      const inspectionResult = await client.callTool({ name: "inspect_fusion_package", arguments: {
        packageRoot: data.packageRoot,
        sourceRoot: data.sourceRoot,
        expectedCounts: data.expectedCounts,
      } });
      const inspection = parsed(inspectionResult);
      expect(inspection).toMatchObject({ readOnly: true, counts: { units: 1, sourceShots: 1, scheduleRows: 2, assets: 3 }, inventory: { fileCount: 5 } });
      expect(Array.isArray(inspection.units)).toBe(false);

      const authorities = (["C01", "S01", "P01"] as const).map((assetId) => ({
        id: `authority-${assetId.toLowerCase()}`,
        assetId,
        name: `${assetId} 权威参考`,
        sourcePath: data.authorityPath,
        expectedSha256: data.authoritySha256,
        rules: ["测试锁定"],
        exposeToGeneration: true,
      }));
      const materializeArguments = {
        projectRoot: data.root,
        requestId: "fusion-materialize-request-001",
        idempotencyKey: "fusion-materialize-key-001",
        packageRoot: data.packageRoot,
        sourceRoot: data.sourceRoot,
        expectedCounts: data.expectedCounts,
        targetParent: data.targetParent,
        authorities,
      };
      const firstRecord = parsed(await client.callTool({ name: "materialize_fusion_project", arguments: materializeArguments }));
      expect(firstRecord).toMatchObject({ status: "succeeded", replayed: false, command: "materialize_fusion_project", result: { created: true, productionAssets: { total: 3 }, continuityTracks: 3 } });
      const targetRoot = firstRecord.result.targetRoot as string;
      await expect(stat(targetRoot)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
      const replayRecord = parsed(await client.callTool({ name: "materialize_fusion_project", arguments: { ...materializeArguments, requestId: "fusion-materialize-request-002" } }));
      expect(replayRecord).toMatchObject({ status: "succeeded", replayed: true, result: { targetRoot } });

      const boardRecord = parsed(await client.callTool({ name: "build_fusion_reference_board", arguments: {
        projectRoot: targetRoot,
        requestId: "fusion-board-request-001",
        idempotencyKey: "fusion-board-key-001",
        itemId: "season-三-ep01-unit001",
        variant: "start",
      } }));
      expect(boardRecord).toMatchObject({ status: "succeeded", command: "build_fusion_reference_board", result: { board: { variant: "start", assetIds: ["C01", "S01", "P01"] } } });
      expect(boardRecord.result.board.sources).toHaveLength(3);
      await expect(stat(boardRecord.result.board.board.path)).resolves.toMatchObject({ size: expect.any(Number) });

      const gridRecord = parsed(await client.callTool({ name: "build_fusion_storyboard_grid", arguments: {
        projectRoot: targetRoot,
        requestId: "fusion-grid-request-001",
        idempotencyKey: "fusion-grid-key-001",
        itemId: "season-三-ep01-unit001",
      } }));
      expect(gridRecord).toMatchObject({ status: "succeeded", command: "build_fusion_storyboard_grid", result: { kind: "fusion-storyboard-grid-contract", selection: { panelCount: 2 }, localRendering: { textRendering: "local-only", aiImageContainsText: false } } });

      const doctorBeforePanelReferences = parsed(await client.callTool({ name: "doctor_project", arguments: { projectRoot: targetRoot } }));
      expect(doctorBeforePanelReferences).toMatchObject({
        checks: expect.arrayContaining([expect.objectContaining({ id: "fusion-panel-reference-closure", level: "warning" })]),
        suggestedNextCalls: expect.arrayContaining(["materialize_fusion_panel_references", "audit_fusion_panel_references"]),
      });
      const snapshotBeforePanelReferences = parsed(await client.callTool({ name: "get_project_snapshot", arguments: { projectRoot: targetRoot } }));
      expect(snapshotBeforePanelReferences).toMatchObject({
        productionDesign: { panelReferences: null },
        suggestedNextCalls: expect.arrayContaining(["materialize_fusion_panel_references", "audit_fusion_panel_references"]),
      });

      const panelReferenceRecord = parsed(await client.callTool({ name: "materialize_fusion_panel_references", arguments: {
        projectRoot: targetRoot,
        requestId: "fusion-panel-references-request-001",
        idempotencyKey: "fusion-panel-references-key-001",
      } }));
      expect(panelReferenceRecord).toMatchObject({
        status: "succeeded",
        command: "materialize_fusion_panel_references",
        result: {
          revision: 1,
          audit: { currentContracts: 1, panels: 2, unresolvedPanels: 0, knownAssetMissingBindings: 0, unhandledOverflowPanels: 0, timeSpanContinuityMismatches: 0 },
          derivedDefinitions: 0,
          overrides: 0,
        },
      });
      expect(panelReferenceRecord.result).not.toHaveProperty("resolutions");

      const panelAudit = parsed(await client.callTool({ name: "audit_fusion_panel_references", arguments: { projectRoot: targetRoot } }));
      expect(panelAudit).toMatchObject({ currentContracts: 1, panels: 2, maximumReferenceSlotsPerPanel: 3, currentness: { current: true, driftedInputs: [], storeRevision: 1 } });
      const panelPage = parsed(await client.callTool({ name: "list_fusion_panel_reference_resolutions", arguments: { projectRoot: targetRoot, episode: 1, limit: 1 } }));
      expect(panelPage).toMatchObject({ total: 2, offset: 0, limit: 1, storeRevision: 1, items: [expect.objectContaining({ unitItemId: "season-三-ep01-unit001", closureStatus: "resolved", generationReady: true })] });
      expect(panelPage.items).toHaveLength(1);
      const firstPanel = panelPage.items[0] as { gridContractId: string; panelId: string; resolutionId: string };
      const panelDetail = parsed(await client.callTool({ name: "get_fusion_panel_reference_resolution", arguments: { projectRoot: targetRoot, contractId: firstPanel.gridContractId, panelId: firstPanel.panelId } }));
      expect(panelDetail).toMatchObject({ resolutionId: firstPanel.resolutionId, referenceSlots: expect.any(Array), semanticAssets: expect.any(Array) });
      const derivedPage = parsed(await client.callTool({ name: "list_derived_panel_reference_assets", arguments: { projectRoot: targetRoot } }));
      expect(derivedPage).toMatchObject({ total: 0, items: [] });
      const visualConstraintRecord = parsed(await client.callTool({ name: "materialize_fusion_visual_constraints", arguments: {
        projectRoot: targetRoot,
        expectedStoreRevision: 0,
        requestId: "fusion-visual-constraints-request-001",
        idempotencyKey: "fusion-visual-constraints-key-001",
      } }));
      expect(visualConstraintRecord).toMatchObject({
        status: "succeeded",
        command: "materialize_fusion_visual_constraints",
        result: {
          revision: 1,
          audit: { contracts: 1, expectedPanels: 2, constraints: 2, missingConstraints: 0, invalidConstraints: 0, modelPromptLeakPanels: 0, modelPathLeakPanels: 0, closurePassed: true },
          presenceOverrideCount: 0,
          revealAuthorizationCount: 0,
        },
      });
      expect(visualConstraintRecord.result).not.toHaveProperty("constraints");
      const visualAudit = parsed(await client.callTool({ name: "audit_fusion_visual_constraints", arguments: { projectRoot: targetRoot } }));
      expect(visualAudit).toMatchObject({ audit: { constraints: 2, closurePassed: true, modelPromptLeakPanels: 0, modelPathLeakPanels: 0 }, currentness: { current: true, storeRevision: 1, driftedInputs: [] } });
      const visualPage = parsed(await client.callTool({ name: "list_fusion_visual_constraints", arguments: { projectRoot: targetRoot, episode: 1, limit: 1 } }));
      expect(visualPage).toMatchObject({ total: 2, offset: 0, limit: 1, storeRevision: 1, items: [expect.objectContaining({ gridContractId: firstPanel.gridContractId, generationGate: expect.any(Object), warningCodes: expect.any(Array) })] });
      expect(visualPage.items).toHaveLength(1);
      expect(visualPage.items[0]).not.toHaveProperty("modelPrompt");
      const visualPanel = visualPage.items[0] as { gridContractId: string; panelId: string };
      const visualDetail = parsed(await client.callTool({ name: "get_fusion_visual_constraint", arguments: { projectRoot: targetRoot, contractId: visualPanel.gridContractId, panelId: visualPanel.panelId } }));
      expect(visualDetail).toMatchObject({ constraintId: expect.stringMatching(/^panel-visual-/u), modelPrompt: expect.any(String), modelNegativePrompt: expect.any(String), reviewRules: expect.any(Array), warnings: expect.any(Array), humanVisualReviewRequired: true });
      expect(visualDetail.modelPrompt).not.toMatch(/\/Users\/|黄金面具|面具三视图/iu);
      const sheetState = parsed(await client.callTool({ name: "get_fusion_storyboard_sheet_state", arguments: {
        projectRoot: targetRoot,
        itemId: "season-三-ep01-unit001",
        contractId: gridRecord.result.contractId,
      } }));
      expect(sheetState).toMatchObject({
        schemaVersion: 2,
        itemId: "season-三-ep01-unit001",
        storeRevision: 0,
        readiness: { canRender: false, blockers: expect.any(Array) },
        versions: [],
        migrationPreview: { storeRevision: 0, candidateCount: 0, pendingCount: 0, canMigrate: false },
      });
      const sheetPage = parsed(await client.callTool({ name: "list_fusion_storyboard_sheets", arguments: { projectRoot: targetRoot, itemId: "season-三-ep01-unit001", limit: 10 } }));
      expect(sheetPage).toMatchObject({ total: 0, offset: 0, limit: 10, storeRevision: 0, items: [], migrationPreview: { candidateCount: 0, pendingCount: 0 } });
      const presence = visualDetail.assetPresence[0] as { assetId: string; bindingId: string; presence: string };
      const override = {
        overrideType: "presence",
        contractId: visualDetail.gridContractId,
        panelId: visualDetail.panelId,
        assetId: presence.assetId,
        expectedStoreRevision: 1,
        expectedConstraintId: visualDetail.constraintId,
        expectedResolutionId: visualDetail.inputSnapshot.resolutionId,
        expectedBindingId: presence.bindingId,
        presence: presence.presence === "on-screen" ? "continuity-only" : "on-screen",
        reason: "MCP P3 CAS 覆盖回归测试",
      };
      const visualOverrideRecord = parsed(await client.callTool({ name: "upsert_fusion_visual_constraint_override", arguments: {
        projectRoot: targetRoot,
        requestId: "fusion-visual-override-request-001",
        idempotencyKey: "fusion-visual-override-key-001",
        override,
      } }));
      expect(visualOverrideRecord).toMatchObject({ status: "succeeded", command: "upsert_fusion_visual_constraint_override", result: { revision: 2, appliedOverrideType: "presence", presenceOverrideCount: 1, constraint: { contractId: visualDetail.gridContractId, panelId: visualDetail.panelId } } });
      const visualOverrideReplay = parsed(await client.callTool({ name: "upsert_fusion_visual_constraint_override", arguments: {
        projectRoot: targetRoot,
        requestId: "fusion-visual-override-request-002",
        idempotencyKey: "fusion-visual-override-key-001",
        override,
      } }));
      expect(visualOverrideReplay).toMatchObject({ status: "succeeded", replayed: true, result: { revision: 2, presenceOverrideCount: 1 } });
      const staleVisualOverride = await client.callTool({ name: "upsert_fusion_visual_constraint_override", arguments: {
        projectRoot: targetRoot,
        requestId: "fusion-visual-override-request-003",
        idempotencyKey: "fusion-visual-override-key-stale-001",
        override,
      } });
      expect(staleVisualOverride).toMatchObject({ isError: true });
      expect(parsed(staleVisualOverride)).toMatchObject({ error: { code: "CONFLICT", retryable: true } });
      const visualLedger = parsed(await client.callTool({ name: "list_command_ledger", arguments: { projectRoot: targetRoot, limit: 20 } })) as unknown as Array<{ idempotencyKey: string; status: string }>;
      expect(visualLedger.find((entry) => entry.idempotencyKey === "fusion-visual-override-key-stale-001")).toMatchObject({ status: "failed" });
      const snapshotAfterPanelReferences = parsed(await client.callTool({ name: "get_project_snapshot", arguments: { projectRoot: targetRoot } }));
      expect(snapshotAfterPanelReferences).toMatchObject({
        productionDesign: { panelReferences: { revision: 1, currentness: { current: true, driftedInputs: [] }, audit: { currentContracts: 1, panels: 2 }, derivedDefinitions: 0, overrides: 0 } },
        suggestedNextCalls: expect.arrayContaining(["audit_fusion_panel_references", "list_fusion_panel_reference_resolutions"]),
      });

      const storyboardStorePath = path.join(targetRoot, ".aicanvas", "storyboards.json");
      await writeFile(storyboardStorePath, `${await readFile(storyboardStorePath, "utf8")}\n`, "utf8");
      const staleDoctor = parsed(await client.callTool({ name: "doctor_project", arguments: { projectRoot: targetRoot } }));
      expect(staleDoctor).toMatchObject({
        checks: expect.arrayContaining([expect.objectContaining({ id: "fusion-panel-reference-closure", level: "error", detail: expect.stringContaining("storyboards") })]),
        suggestedNextCalls: expect.arrayContaining(["materialize_fusion_panel_references", "audit_fusion_panel_references"]),
      });
      const staleAudit = parsed(await client.callTool({ name: "audit_fusion_panel_references", arguments: { projectRoot: targetRoot } }));
      expect(staleAudit).toMatchObject({ currentness: { current: false, driftedInputs: expect.arrayContaining(["storyboards"]) } });

      const assetsPage = parsed(await client.callTool({ name: "list_fusion_production_assets", arguments: { projectRoot: targetRoot } }));
      expect(assetsPage).toMatchObject({ available: true, currentIndexAvailable: true, total: 3 });
      expect(assetsPage.items.every((entry: Record<string, unknown>) => entry.hardLockStatus === "hard-locked")).toBe(true);
      const tracksPage = parsed(await client.callTool({ name: "list_continuity_tracks", arguments: { projectRoot: targetRoot } }));
      expect(tracksPage).toMatchObject({ available: true, total: 3 });
      const spansPage = parsed(await client.callTool({ name: "get_continuity_spans", arguments: { projectRoot: targetRoot, assetId: "C01" } }));
      expect(spansPage).toMatchObject({ available: true, track: { assetId: "C01" }, total: 1 });

      const combinedText = [inspectionResult, firstRecord, boardRecord, gridRecord, panelReferenceRecord, panelAudit, panelPage, panelDetail, derivedPage, visualConstraintRecord, visualAudit, visualPage, visualDetail, sheetState, sheetPage, visualOverrideRecord, assetsPage, tracksPage, spansPage].map((value) => JSON.stringify(value)).join("\n");
      expect(combinedText).not.toMatch(/data:image|base64,/iu);
    } finally {
      await client.close();
    }
  }, 60_000);
});
