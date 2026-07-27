import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "@vue/compiler-sfc";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = (relative: string) => readFileSync(path.join(root, relative), "utf8");

describe("受管 Studio 无限画布 UI 合同", () => {
  it("运行时门禁检查期保持只读但不误报必须重启，并暴露可验收状态", () => {
    const canvas = source("src/renderer/src/components/ManagedStudioCanvasView.vue");
    expect(parse(canvas, { filename: "ManagedStudioCanvasView.vue" }).errors).toEqual([]);
    expect(canvas).toContain(':data-runtime-write-gate-state="runtimeWriteGateState"');
    expect(canvas).toContain('type RuntimeWriteGateUiState = "checking" | "allowed" | "blocked" | "unavailable"');
    expect(canvas).toContain('runtimeWriteGateState.value !== "allowed"');
    expect(canvas).toContain("checking 不能在视觉上误报为“必须重启”");
    expect(canvas).toContain("runtimeWriteGateState === 'blocked' || runtimeWriteGateState === 'unavailable'");
    const refreshAll = canvas.slice(
      canvas.indexOf("async function refreshAll(): Promise<void>"),
      canvas.indexOf("async function resetUnits(): Promise<void>"),
    );
    const gateIndex = refreshAll.indexOf("await refreshRuntimeBuildIdentity()");
    const firstBusinessReadIndex = refreshAll.indexOf("await flushPendingLayout(projectRoot)");
    expect(gateIndex).toBeGreaterThanOrEqual(0);
    expect(firstBusinessReadIndex).toBeGreaterThan(gateIndex);
    expect(refreshAll).toContain('runtimeWriteGateState.value !== "allowed") return');
    expect(refreshAll.match(/refreshRuntimeBuildIdentity\(\)/gu)).toHaveLength(1);
  });

  it("作为 Material Studio 独立入口并默认打开，不替换生产驾驶舱 owner", () => {
    const material = source("src/renderer/src/components/MaterialStudioView.vue");
    expect(parse(material, { filename: "MaterialStudioView.vue" }).errors).toEqual([]);
    expect(material).toContain('data-testid="studio-mode-canvas"');
    expect(material).toContain("AsyncManagedStudioCanvasView");
    expect(material).toContain('props.dashboardApi ? "canvas" : "library"');
    expect(material.match(/props\.dashboardApi \? "canvas" : "library"/gu)?.length).toBeGreaterThanOrEqual(2);
    expect(material).toContain("AsyncStudioProductionDashboardView");
  });

  it("按 6 资产/36 单元/6 宫格及最多 18 结果节点有界投影，且启用视口剔除", () => {
    const canvas = source("src/renderer/src/components/ManagedStudioCanvasView.vue");
    expect(parse(canvas, { filename: "ManagedStudioCanvasView.vue" }).errors).toEqual([]);
    expect(canvas).toContain('data-testid="managed-studio-canvas-view"');
    expect(canvas).toContain(':only-render-visible-elements="true"');
    expect(canvas.match(/limit: 36/g)?.length).toBeGreaterThanOrEqual(2);
    expect(canvas).toMatch(/operation:\s*"assets" as const,[\s\S]{0,360}limit:\s*36,/u);
    expect(canvas).toContain("unitDetail.value?.panels");
    // 结果/审片计数必须来自真实 DOM 渲染，禁止“宫格数×3”推算。
    expect(canvas).toContain("const pipelineNodeCount = computed(() => nodes.value.filter(");
    expect(canvas).toContain('kind === "raw" || kind === "labeled" || kind === "review"');
    expect(canvas).not.toContain("panels.length ?? 0) * 3");
    for (const resultKind of ['kind: "raw"', 'kind: "labeled"', 'kind: "review"']) {
      expect(canvas).toContain(resultKind);
    }
    expect(canvas).toContain("createDashboardLoadController");
    for (const lane of ["pinActionGate", "addUnitActionGate", "externalImportActionGate"]) {
      expect(canvas).toContain(lane);
    }
    expect(canvas).toContain("canvasUiActionIsCurrent");
    expect(canvas).toContain('actionId: "external-media-import"');
    expect(canvas).toContain("executeStudioCommand(");
    expect(canvas).not.toMatch(/sqlite|localStorage|sessionStorage|bodyPath|objectRoot|base64/);
  });

  it("Qwen D3–D5：导演面板 + 受闸快捷键 + 侧栏虚拟列表已挂载", () => {
    const canvas = source("src/renderer/src/components/ManagedStudioCanvasView.vue");
    expect(canvas).toContain("DirectorActionPanel");
    expect(canvas).toContain('data-testid="managed-canvas-director-toggle"');
    expect(canvas).toContain('data-testid="managed-canvas-assets-virtual-viewport"');
    expect(canvas).toContain("搜索名称、别名或权威 SHA");
    expect(canvas).toContain("createGatedHotkeyRegistry");
    expect(canvas).toContain("DEFAULT_DIRECTOR_HOTKEYS");
    expect(canvas).toContain("createThumbnailLru");
    expect(canvas).toContain("computeVirtualListWindow");
    expect(canvas).toContain("onDirectorAction");
    // 导演动作分发本身不得出现 execute_command 字面量
    const directorFn = canvas.slice(canvas.indexOf("function onDirectorAction"), canvas.indexOf("function onDirectorAction") + 900);
    expect(directorFn).not.toContain("execute_command");
  });

  it("同时投影规范资产、15 秒单元、宫格与资产出场连线", () => {
    const canvas = source("src/renderer/src/components/ManagedStudioCanvasView.vue");
    for (const marker of ["asset-node", "unit-node", "panel-node", "appearance-edge"]) {
      expect(canvas).toContain(marker);
    }
    expect(canvas).toContain('operation: "appearances"');
    expect(canvas).toContain('operation: "unit"');
    expect(canvas).toContain('operation: "assets"');
    expect(canvas).toContain('operation: "units"');
  });

  it("本机来源单元预览经只读 IPC 后台接入，明确资产未裁决时禁止生图", () => {
    const canvas = source("src/renderer/src/components/ManagedStudioCanvasView.vue");
    const preload = source("src/preload/index.ts");
    const main = source("src/main/index.ts");
    expect(canvas).toContain('data-testid="managed-canvas-source-unit-preview"');
    expect(canvas).toContain("previewLocalCreativeProductionUnits");
    expect(canvas).toContain("getLocalCreativeProjectIngestStatus");
    expect(canvas).toContain("显式选择最多 3 个单元");
    expect(canvas).toContain("来源未同步");
    expect(canvas).toContain("来源扫描期间仍在变化");
    expect(canvas).toContain("当前只允许查看预览");
    expect(canvas).toContain("资产权威未解析前禁止正式生图");
    expect(canvas).toContain("首屏完成后后台核对");
    expect(preload).toContain("canvas:preview-local-creative-production-units");
    expect(preload).toContain("canvas:get-local-creative-project-ingest-status");
    expect(main).toContain("canvas:preview-local-creative-production-units");
    expect(main).toContain("canvas:get-local-creative-project-ingest-status");
  });

  it("主时间线只投影已成对且人工 PASS 的最新 unit-grid raw", () => {
    const canvas = source("src/renderer/src/components/ManagedStudioCanvasView.vue");
    expect(canvas).toContain("loadApprovedUnitGridRawProjection");
    expect(canvas).toContain("scheduleGenerationProjectionRefresh");
    expect(canvas).toContain("refreshGenerationProjectionFromLedger");
    expect(canvas).toContain("generationProjectionRefreshInFlight");
    expect(canvas).toContain("listStudioGenerationUnitGridHistory");
    expect(canvas).toContain("getStudioHistoricalGenerationEvidenceByUnit");
    expect(canvas).toContain("getStudioGenerationCheckpointCanvasProjection");
    expect(canvas).toContain('provenance: "historical-import"');
    expect(canvas).toContain('provenance: "checkpoint-attested"');
    expect(canvas).toContain('verification: "ledger-attested"');
    expect(canvas).toContain('"reference-verified"');
    expect(canvas).toContain("provider: item.provider");
    expect(canvas).toContain('approvedRaw.provider === "grok" ? "Grok" : "Codex"');
    // 正式 raw 的唯一裁决来源是核心投影：批量投影已附带同一 SQLite
    // snapshot 内闭合的 PASS execution identity；renderer 只做精确 SHA/pack
    // 匹配、读媒体和闭包核验，不再逐单元重读 Review。
    expect(canvas).toContain("getApprovedTimelineProjection");
    expect(canvas).toContain("resolveUnitGridSelectedResultIdentity");
    expect(canvas).toContain("rawMediaSha256: selectedRawSha256");
    expect(canvas).toContain("停检账本只可作为首屏 placeholder");
    expect(canvas).toContain("attested.rawMediaSha256 === selectedRawSha256");
    expect(canvas).toContain("verification: closureVerified ? \"deep-verified\" : \"ledger-attested\"");
    expect(canvas).toContain("projectCoreNonPassProjection");
    expect(canvas).toContain("clearUnitGridFormalProjectionState");
    expect(canvas).toContain("一旦开始新一轮核心核对");
    expect(canvas).toMatch(/const begun = unitGridRawProjectionFlight\.begin[\s\S]{0,700}clearUnitGridFormalProjectionState\(\)[\s\S]{0,300}rebuildGraph\(\)/u);
    expect(canvas).toContain("核心裁决不可读时旧 PASS raw/参考/连续性不能继续冒充 current");
    expect(canvas).toContain("core.selectedRawSha256 === projection.rawMediaSha256");
    expect(canvas).toContain("深核验随后增量补回");
    expect(canvas).toContain("scheduleUnitGridGraphRebuild");
    expect(canvas).toContain("flushUnitGridGraphRebuild");
    expect(canvas).toContain("window.requestAnimationFrame");
    expect(canvas).not.toContain('review.status !== "pass"');
    expect(canvas).not.toContain('review.decision === "pass"');
    expect(canvas).toContain("media:unit-grid-raw:");
    expect(canvas).toContain("unit-grid-raw-node");
    expect(canvas).toContain("const canvasStatus = approvedRaw");
    expect(canvas).toContain('"正式整板已通过"');
    expect(canvas).toContain('"正式整板待恢复参考链"');
    expect(canvas).toContain("const ledgerPending = rawProjection?.verification === \"ledger-attested\"");
    expect(canvas).toContain("正式整板待恢复冻结参考");
    expect(canvas).toContain("待恢复参考链");
    expect(canvas).toContain('"正式整板待人工验收"');
    expect(canvas).toContain("const directlyMatchedUnitIds = units");
    expect(canvas).toContain("reference.mediaSha256.toLowerCase().includes(query)");
    expect(canvas).toContain("raw+labeled 成对 · 人工审片通过");
    expect(canvas).toContain("图生视频提交包待建立");
    expect(canvas).toContain("历史导入正式 raw 未建立图生视频提交包");
    expect(canvas).toContain("unitGridVideoPackagePipeline.value = new Map(unitGridVideoPackagePipeline.value)");
    expect(canvas).toContain("const continuityReadable = continuity.opaqueFieldCount === 0");
    expect(canvas).toContain("末格计划状态 · ${observationStatus}");
    expect(canvas).toContain("末格计划状态待人工补全 · ${observationStatus}");
    expect(canvas).toContain("缺少实际末态观察");
    expect(canvas).toContain("实际末态观察已过期");
    expect(canvas).toContain("禁止作为下一镜站位/朝向输入");
    expect(canvas).toContain("双击打开连续性复核");
    expect(canvas).toContain("async function openUnitGridContinuityReview");
    expect(canvas).toContain('generationTarget: { targetKind: "unit-grid", targetKey: `unit-grid:${unitId}` }');
    expect(canvas).toMatch(/kind === "continuity"[\s\S]{0,480}openUnitGridContinuityReview/u);
    expect(canvas).toContain("isOpaqueContinuityLocator");
    expect(canvas).toContain("个字段已锁，");
    expect(canvas).toContain("个仅内部定位");
    expect(canvas).toContain("assetSummary");
    expect(canvas).toContain("system:raw-video-package:");
    expect(canvas).toContain("system:raw-continuity:");
    expect(canvas).not.toContain("system:continuity-next-unit:");
    expect(canvas).toContain("getStudioPostResultObservationControl");
    expect(canvas).toContain('kindLabel: "实际末态"');
    expect(canvas).toContain("currentObservedEndState");
    expect(canvas).toContain('observationControl?.status === "current"');
    expect(canvas).toContain("observationControl.head?.current === true");
    expect(canvas).toContain("observationControl.head.continuationEligible === true");
    expect(canvas).toContain("system:raw-observed-continuity:");
    expect(canvas).toContain("system:observed-continuity-next-unit:");
    expect(canvas).toContain("planned 不能作为 actual");
    expect(canvas).toContain("冻结计划终态");
    expect(canvas).toContain("禁止直接作为下一镜实际起态");
    expect(canvas).toContain("unitGridNonPassPipeline");
    expect(canvas).toContain("正式整板待人工验收");
    expect(canvas).toContain("raw 不展示、不导出、不作为后续参考");
    expect(canvas).toContain("system:unit-generation-state:");
    expect(canvas).not.toMatch(/unitGridRawPipeline[\s\S]{0,1200}review\.status\s*!==\s*"pass"[\s\S]{0,1200}rework.*thumbnailUrl/u);
    const preload = source("src/preload/index.ts");
    const main = source("src/main/index.ts");
    expect(preload).toContain("listStudioGenerationUnitGridHistory");
    expect(preload).toContain("getStudioHistoricalGenerationEvidenceByUnit");
    expect(preload).toContain("getStudioGenerationCheckpointCanvasProjection");
    expect(main).toContain("canvas:list-studio-generation-unit-grid-history");
    expect(main).toContain("canvas:get-studio-historical-generation-evidence-by-unit");
    expect(main).toContain("canvas:get-studio-generation-checkpoint-canvas-projection");
    expect(preload).toContain("canvas:get-studio-post-result-observation-control");
    expect(main).toContain("canvas:get-studio-post-result-observation-control");
  });

  it("A3：素材中心 dual-entry 接线与 canvas open-dashboard", () => {
    const material = source("src/renderer/src/components/MaterialStudioView.vue");
    expect(material).toContain("onDashboardOpenCanvas");
    expect(material).toContain("onCanvasOpenDashboard");
    expect(material).toContain("intentOpenCanvasFromDashboard");
    expect(material).toContain("intentOpenDashboardFromCanvas");
    expect(material).toContain(':focus="canvasFocus"');
    expect(material).toContain('@open-canvas="onDashboardOpenCanvas"');
    const dashboard = source("src/renderer/src/components/StudioProductionDashboardView.vue");
    expect(dashboard).toContain("openCanvasForPanel");
    expect(dashboard).toContain('data-testid="dashboard-open-canvas"');
    const canvas = source("src/renderer/src/components/ManagedStudioCanvasView.vue");
    expect(canvas).toContain("onNodeDoubleClick");
    expect(canvas).toContain("openDashboard");
    expect(canvas).toContain("applyExternalFocus");
  });

  it("A2：加载/拖拽 debounce 持久化 studio-canvas-layout，不写业务真源", () => {
    const canvas = source("src/renderer/src/components/ManagedStudioCanvasView.vue");
    expect(canvas).toContain("hydrateLayoutFromDisk");
    expect(canvas).toContain("scheduleLayoutPersist");
    expect(canvas).toContain("onNodeDragStop");
    expect(canvas).toContain("saveLayout");
    expect(canvas).toContain("loadLayout");
    expect(canvas).toContain("applyInitialTimelineLayoutIfNeeded");
    expect(canvas).toContain("initialTimelineLayoutAppliedRoot");
    expect(canvas).toContain("已有布局永不自动改写");
    expect(canvas).toContain("resolveStudioCanvasNodePosition");
    expect(canvas).toContain("collectStudioCanvasNodePositions");
    expect(canvas).toContain("@core/studio-canvas-layout-geometry");
    expect(canvas).toMatch(/import type \{[\s\S]*StudioCanvasLayout[\s\S]*\} from "@core\/studio-canvas-layout-types"/u);
    expect(canvas).toContain(':pan-on-drag="[1, 2]"');
    expect(canvas).toContain(':selection-key-code="true"');
    expect(canvas).toContain('data-testid="managed-canvas-layout-status"');
    expect(canvas).not.toMatch(/sqlite|localStorage|sessionStorage/);
    const node = source("src/renderer/src/components/ManagedStudioCanvasNode.vue");
    // 缩略图默认禁止浏览器拖出；export 武装时才允许 :draggable
    expect(node).toMatch(/:draggable="exportArmed"|draggable="false"/);
    expect(node).toContain("-webkit-user-drag: none");
    const preload = source("src/preload/index.ts");
    expect(preload).toContain("loadStudioCanvasLayout");
    expect(preload).toContain("saveStudioCanvasLayout");
    const main = source("src/main/index.ts");
    expect(main).toContain("canvas:load-studio-canvas-layout");
    expect(main).toContain("canvas:save-studio-canvas-layout");
  });

  it("VF-1/VF-2：MiniMap + 框选创建工作流组（Vue Flow + LMD-1）", () => {
    const canvas = source("src/renderer/src/components/ManagedStudioCanvasView.vue");
    expect(parse(canvas, { filename: "ManagedStudioCanvasView.vue" }).errors).toEqual([]);
    expect(canvas).toContain('from "@vue-flow/minimap"');
    expect(canvas).toContain("<MiniMap");
    expect(canvas).toContain('data-testid="managed-canvas-minimap"');
    expect(canvas).toContain("@nodes-change=\"onNodesChange\"");
    expect(canvas).toContain("extractStudioCanvasPanelIdsFromSelection");
    expect(canvas).toContain("createStudioCanvasWorkflowGroup");
    expect(canvas).toContain("createWorkflowFromSelection");
    expect(canvas).toContain('data-testid="managed-canvas-create-workflow"');
    expect(canvas).toContain("workflowGroups");
    expect(canvas).toContain("workflowGroups:");
    const main = source("src/renderer/src/main.ts");
    expect(main).toContain("@vue-flow/minimap/dist/style.css");
    const pkg = JSON.parse(source("package.json")) as { dependencies: Record<string, string> };
    expect(pkg.dependencies["@vue-flow/minimap"]).toMatch(/1\.5\./);
  });

  it("Local #1 backlog：节点内操作面板 + 状态 overlay 合同", () => {
    const canvas = source("src/renderer/src/components/ManagedStudioCanvasView.vue");
    expect(canvas).toContain("buildStudioCanvasNodeActionPanel");
    expect(canvas).toContain("createStudioCanvasNodeStatusStore");
    expect(source("src/renderer/src/components/CanvasInspectorPanel.vue")).toContain('data-testid="managed-canvas-node-action-panel"');
    expect(source("src/renderer/src/components/CanvasInspectorPanel.vue")).toContain("managed-canvas-action-");
    const node = source("src/renderer/src/components/ManagedStudioCanvasNode.vue");
    expect(node).toContain("managed-node-status-overlay");
    expect(canvas).toContain("nodeStatusStore");
    expect(canvas).toContain("runNodeAction");
    expect(canvas).toContain("openBinding");
    expect(canvas).toContain('code === "open-binding"');
    expect(canvas).toContain('code === "open-dashboard"');
    expect(canvas).toContain('code === "focus-unit"');
    expect(canvas).toContain('code === "freeze-dispatch"');
    expect(canvas).toContain('code === "close-panel"');
    expect(canvas).toContain("appearanceListElement.value?.scrollIntoView");
    expect(canvas).toContain('if (kind === "asset" || kind === "unit" || kind === "panel") actionPanelOpen.value = true');
  });

  it("LMD residual：执行最近工作流组按钮接线", () => {
    const canvas = source("src/renderer/src/components/ManagedStudioCanvasView.vue");
    expect(canvas).toContain('data-testid="managed-canvas-run-workflow"');
    expect(canvas).toContain("runLastWorkflowGroup");
  });

  it("P15/MVP：主前台显式选择 Codex/Grok，复杂门禁仍走受管 Studio owner", () => {
    const material = source("src/renderer/src/components/MaterialStudioView.vue");
    const canvas = source("src/renderer/src/components/ManagedStudioCanvasView.vue");
    expect(material).toContain('data-testid="studio-generation-provider-selector"');
    expect(material).toContain('<option value="codex">Codex</option>');
    expect(material).toContain('<option value="grok">Grok</option>');
    expect(material).toContain(':generation-provider="generationProvider"');
    expect(material).toContain('const generationProvider = ref<"codex" | "grok">("codex")');
    expect(material).toMatch(/watch\(\(\) => props\.projectRoot,[\s\S]{0,120}generationProvider\.value = "codex"/u);
    for (const testId of [
      "managed-canvas-add-node",
      "managed-canvas-open-library",
      "managed-canvas-connect-mode",
      "managed-canvas-primary-start",
      "managed-canvas-result-status",
    ]) {
      expect(canvas).toContain(`data-testid="${testId}"`);
    }
    expect(canvas).toContain(':nodes-connectable="true"');
    expect(canvas).toContain(':connection-mode="ConnectionMode.Loose"');
    expect(canvas).toContain(':connect-on-click="false"');
    expect(canvas).toContain('@connect="onConnect"');
    expect(canvas).toContain("function onConnectPoint(nodeId: string)");
    expect(canvas).toContain('generationProvider: "codex" | "grok"');
    expect(canvas).toContain("const provider = props.generationProvider");
    expect(canvas).toContain("provider,");
    expect(canvas).toContain('imageMode: "freeze-dispatch-only"');
    expect(canvas).toContain("draftForPanels");
    expect(canvas).toContain("validateStudioCanvasWorkflowDraft");
    expect(canvas).toContain("plainNodePositions");
    expect(canvas).toContain("plainDraftEdges");
    expect(canvas).toContain("plainWorkflowGroups");
    expect(canvas).toMatch(/function toggleConnectMode\(\): void \{[\s\S]{0,260}connectMode\.value = !connectMode\.value;[\s\S]{0,260}\}/u);
    const toggleConnectMode = canvas.match(/function toggleConnectMode\(\): void \{([\s\S]*?)\n\}/u)?.[1] ?? "";
    expect(toggleConnectMode).not.toContain('workspaceMode.value = "workflow"');
    expect(toggleConnectMode).not.toContain("rebuildGraph()");
    expect(canvas).toContain('restoredPinnedNodeIds.length === 0');
    const node = source("src/renderer/src/components/ManagedStudioCanvasNode.vue");
    expect(node).toContain('data-testid="managed-canvas-node-left-plus"');
    expect(node).toContain('data-testid="managed-canvas-node-right-plus"');
    expect(node).toContain("data.onConnectPoint?.('left')");
    expect(node).toContain("data.onConnectPoint?.('right')");
    expect(node).toContain(">＋</span>");
    expect(node).toContain("width: 26px");
  });

  it("P0 入口真实性：开始只记录冻结/计划/派发，等待 Agent 领取且不冒充已生成", () => {
    const canvas = source("src/renderer/src/components/ManagedStudioCanvasView.vue");
    expect(canvas).toContain("准备并记录 ${unitDetail.panels.length} 格派发");
    expect(canvas).toContain("派发已记录，等待 Agent 领取");
    expect(canvas).toContain("冻结/计划/派发记录 ${ok}");
    expect(canvas).toContain("等待 ${providerLabel} Agent 领取");
    expect(canvas).toContain("此步骤不会直接生成图片");
    expect(canvas).toContain("Review、音频和视频未接入本按钮工作流");
    expect(canvas).not.toContain("后台自动开始生成");
    expect(canvas).not.toContain("已交给后台生成，完成后自动出现");
    expect(canvas).not.toContain("开始全部");
    expect(canvas).not.toContain("开始失败：");
    expect(canvas).toContain("派发准备失败：");
  });

  it("P15：桌面端优先使用受管 Studio layout owner，添加单元后自动收起抽屉并适配画布", () => {
    const canvas = source("src/renderer/src/components/ManagedStudioCanvasView.vue");
    expect(canvas).toContain("window.canvasApi");
    expect(canvas).toMatch(/if \(typeof bridge\.loadStudioCanvasLayout[\s\S]{0,650}if \(typeof bridge\.loadLayout/u);
    expect(canvas).toMatch(/async function addUnitToWorkspace[\s\S]{0,1500}libraryOpen\.value = false;[\s\S]{0,480}await fitCanvas\(\);/u);
    const addUnit = canvas.slice(
      canvas.indexOf("async function addUnitToWorkspace"),
      canvas.indexOf("async function openLibraryFor"),
    );
    expect(addUnit).toContain("addUnitActionGate.begin");
    expect(addUnit).toContain("await loadUnitDetailById(unit.id)");
    expect(addUnit).not.toContain("await selectUnit(unit)");
    expect(addUnit).toContain("if (!canvasUiActionIsCurrent(addUnitActionGate, scope)) return;");
    expect(addUnit).toContain("if (canvasUiActionIsCurrent(addUnitActionGate, scope)) addUnitActionBusy.value = false;");
    expect(canvas).toContain("originX: 680");
    expect(canvas).toContain("layoutPatch[node.id]");
    expect(canvas).toContain("studioFlow.fitBounds");
    expect(canvas).not.toContain("studioFlow.fitView");
    expect(canvas).toContain('@zoom-in="onControlViewportChanged"');
    expect(canvas).toContain("studioFlow.getViewport()");
    expect(canvas).toContain("pinnedAssetsPage");
    expect(canvas).toMatch(/operation:\s*"assets" as const,[\s\S]{0,120}assetIds,[\s\S]{0,120}limit:\s*6/u);
    expect(canvas).toMatch(/async function loadAssets\(\): Promise<void> \{[\s\S]{0,1200}if \(workspaceMode\.value !== "workflow"\) rebuildGraph\(\);/u);
    expect(canvas).toMatch(/const enteringWorkflow = workspaceMode\.value !== "workflow";[\s\S]{0,1500}await loadPinnedAssets\(\{ rebuild: !enteringWorkflow \}\);[\s\S]{0,1200}if \(enteringWorkflow\) \{[\s\S]{0,160}workspaceMode\.value = "workflow";[\s\S]{0,240}rebuildGraph\(\);[\s\S]{0,160}await nextTick\(\);[\s\S]{0,120}await fitCanvas\(\);/u);
    expect(canvas).toContain("loadPinnedUnit");
    expect(canvas).toContain("loadUnitDetailById");
    expect(canvas).toMatch(/await loadPinnedTextDocuments\(\);[\s\S]{0,160}await loadPinnedUnit\(\);/u);
    const node = source("src/renderer/src/components/ManagedStudioCanvasNode.vue");
    expect(node).toContain("overflow: visible");
  });

  it("大型时间线重排后聚焦正式单元，不把参考链压成不可读缩略图", () => {
    const canvas = source("src/renderer/src/components/ManagedStudioCanvasView.vue");
    expect(canvas).toContain("async function focusTimelineAnchor");
    expect(canvas).toMatch(/async function applyTimelineLayout[\s\S]{0,1800}await focusTimelineAnchor\(timeline\);/u);
    expect(canvas).toMatch(/focusTimelineAnchor[\s\S]{0,1100}media:unit-grid-raw:/u);
    expect(canvas).toMatch(/focusTimelineAnchor[\s\S]{0,1500}studioFlow\.setCenter/u);
  });

  it("进度搜索精确命中单元后直接定位正式 raw，避免命中后仍需人工找图", () => {
    const canvas = source("src/renderer/src/components/ManagedStudioCanvasView.vue");
    expect(canvas).toContain('@input="scheduleFocusTimelineSearchResult"');
    expect(canvas).toContain('@change="focusTimelineSearchResult"');
    expect(canvas).toContain("async function focusTimelineSearchResult");
    expect(canvas).toContain("function scheduleFocusTimelineSearchResult");
    expect(canvas).toContain('placeholder="搜集数/单元/角色/场景/SHA/审片状态"');
    expect(canvas).toContain("unitQuery: q");
    expect(canvas).toContain("timelineProgressFilterResult.value?.matchedUnitIds");
    expect(canvas).toContain("media:unit-grid-raw:${unitId}");
    expect(canvas).toContain("generation-state:${unitId}");
  });

  it("P16：跨页固定节点、完整出场分页、布局 flush 与安全清空", () => {
    const canvas = source("src/renderer/src/components/ManagedStudioCanvasView.vue");
    expect(canvas).toContain("selectAssetById");
    expect(canvas).toContain("selectUnitById");
    expect(canvas).toContain("loadPinnedTextDocuments");
    expect(source("src/renderer/src/components/CanvasInspectorPanel.vue")).toContain('data-testid="managed-canvas-appearances-prev"');
    expect(source("src/renderer/src/components/CanvasInspectorPanel.vue")).toContain('data-testid="managed-canvas-appearances-next"');
    expect(canvas).toContain("appearanceCursorStack");
    expect(canvas).toMatch(/async function focusAppearance[\s\S]{0,900}loadUnitDetailById\(unitId, panelId\)/u);
    expect(canvas).toContain("flushPendingLayout");
    expect(canvas).toMatch(/watch\(\(\) => props\.projectRoot,[\s\S]{0,300}const previousLayoutFlush = flushPendingLayout\(previousProjectRoot\)/u);
    const switchBlock = canvas.match(/watch\(\(\) => props\.projectRoot,[\s\S]*?await refreshAll\(\);\n\}\);/u)?.[0] ?? "";
    expect(switchBlock.indexOf("nodes.value = []")).toBeGreaterThan(-1);
    expect(switchBlock.indexOf("nodes.value = []")).toBeLessThan(switchBlock.indexOf("await previousLayoutFlush"));
    const unmountFlush = canvas.match(/onBeforeUnmount\(\(\) => \{([\s\S]*?)\n\}\);/u)?.[1] ?? "";
    expect(unmountFlush).toContain("const finalLayoutFlush = flushPendingLayout(props.projectRoot)");
    expect(unmountFlush).toContain("void finalLayoutFlush.finally");
    expect(canvas).toContain("清空画布视图");
    expect(canvas).toContain("clearConfirmationArmed");
    expect(canvas).toContain("再点一次确认清空");
    expect(canvas).toMatch(/function clearWorkflowCanvas[\s\S]{0,900}workflowGroups\.value = \[\]/u);
    expect(canvas).toContain("describeStudioCanvasWorkflowMismatch");
    expect(canvas).toContain("连线预检未通过");
    expect(canvas).toContain("剧本缺少当前冻结修订");
    expect(canvas).toContain("提示词缺少当前冻结修订");
  });

  it("跨工程异步边界冻结 root+lane，旧详情/反馈/busy 与创建草稿不能写入新工程", () => {
    const canvas = source("src/renderer/src/components/ManagedStudioCanvasView.vue");
    const material = source("src/renderer/src/components/MaterialStudioView.vue");
    expect(parse(canvas, { filename: "ManagedStudioCanvasView.vue" }).errors).toEqual([]);
    expect(parse(material, { filename: "MaterialStudioView.vue" }).errors).toEqual([]);

    const guardedBlock = canvas.match(/async function guarded\([\s\S]*?\n\}/u)?.[0] ?? "";
    expect(guardedBlock).toContain("guardedActionGate.begin(projectRoot, lane)");
    expect(guardedBlock).toContain("operation(scope)");
    expect(guardedBlock.match(/canvasUiActionIsCurrent\(guardedActionGate, scope\)/gu)?.length).toBeGreaterThanOrEqual(2);
    const selectAssetByIdBlock = canvas.match(/async function selectAssetById[\s\S]*?\n\}/u)?.[0] ?? "";
    expect(selectAssetByIdBlock).toContain("scope.projectRoot");
    expect(selectAssetByIdBlock).toContain("canvasUiActionIsCurrent(guardedActionGate, scope)");
    expect(selectAssetByIdBlock).not.toContain("getDashboard(props.projectRoot");
    const canvasSwitchBlock = canvas.match(/watch\(\(\) => props\.projectRoot,[\s\S]*?await refreshAll\(\);\n\}\);/u)?.[0] ?? "";
    expect(canvasSwitchBlock).toContain("loading.value = false");
    expect(canvas).toContain("guardedActionGate.invalidate()");
    expect(canvas).toContain("guardedActionGate.dispose()");
    const leaseBlock = canvas.match(/async function refreshUnitLeaseDisplay[\s\S]*?\n\}/u)?.[0] ?? "";
    expect(leaseBlock).toContain("const projectRoot = props.projectRoot");
    expect(leaseBlock).toContain("const requestSequence = refreshSequence");
    expect(leaseBlock).toContain("projectRoot !== props.projectRoot || requestSequence !== refreshSequence");
    expect(leaseBlock).not.toContain("getStudioUnitWriteLeases(props.projectRoot)");
    const diagnosticsBlock = canvas.match(/async function refreshProductionDiagnostics[\s\S]*?\n\}/u)?.[0] ?? "";
    expect(diagnosticsBlock).toContain("const projectRoot = props.projectRoot");
    expect(diagnosticsBlock).toContain("const requestSequence = refreshSequence");
    expect(diagnosticsBlock).toContain("projectRoot !== props.projectRoot || requestSequence !== refreshSequence");
    expect(diagnosticsBlock).not.toContain("getStudioProductionDiagnostics(props.projectRoot)");
    expect(canvasSwitchBlock).toContain("unitLeaseDisplayHint.value = null");
    expect(canvasSwitchBlock).toContain("productionDiagnostics.value = null");

    const materialResetBlock = material.match(/function resetWorkspace\(\): void \{[\s\S]*?\n    \}/u)?.[0] ?? "";
    expect(materialResetBlock).toContain("actionGate.invalidate()");
    expect(materialResetBlock).toContain("textRevisionsToken += 1");
    expect(materialResetBlock).toContain("detailRequest += 1");
    expect(materialResetBlock).toContain("searchTimer = undefined");
    expect(materialResetBlock).toContain("relationSearchTimer = undefined");
    expect(materialResetBlock).toContain("resetCreateDraft()");
    expect(materialResetBlock).toContain("createDialogOpen.value = false");
    for (const busy of [
      "loading.value = false",
      "loadingMore.value = false",
      "detailLoading.value = false",
      "textRevisionsLoading.value = false",
      "relationCandidatesLoading.value = false",
      'pendingAction.value = ""',
    ]) {
      expect(materialResetBlock).toContain(busy);
    }
    const createBlock = material.match(/async function createAsset\(\): Promise<void> \{[\s\S]*?\n    \}/u)?.[0] ?? "";
    expect(createBlock).toContain("const frozenDraft =");
    expect(createBlock).toContain("props.api.createAsset(scope.projectRoot");
    expect(createBlock).toContain("materialActionIsCurrent(scope)");
    expect(createBlock).not.toContain("props.api.createAsset(props.projectRoot");
    const refreshAfterMutationBlock = material.match(/async function refreshAfterMutation[\s\S]*?\n    \}/u)?.[0] ?? "";
    expect(refreshAfterMutationBlock).toContain("const firstPageLoaded = await loadFirstPage()");
    expect(refreshAfterMutationBlock).toMatch(/if \(!firstPageLoaded \|\| root !== props\.projectRoot\) return;/u);
    expect(refreshAfterMutationBlock.indexOf("if (!firstPageLoaded || root !== props.projectRoot) return;"))
      .toBeLessThan(refreshAfterMutationBlock.indexOf("await selectEntry(entry, true)"));
  });

  it("普通画布刷新不触发来源全量 SHA，只有显式核对才读取完整来源", () => {
    const canvas = source("src/renderer/src/components/ManagedStudioCanvasView.vue");
    const routineBlock = canvas.match(/async function refreshLocalProductionPreview[\s\S]*?\n\}/u)?.[0] ?? "";
    expect(routineBlock).toContain("refreshSource: false");
    expect(routineBlock).not.toContain("refreshSource: true");
    expect(routineBlock).not.toContain("previewLocalCreativeProductionUnits(projectRoot)");
    const verifyBlock = canvas.match(/async function verifyLocalProductionSource[\s\S]*?\n\}/u)?.[0] ?? "";
    expect(verifyBlock).toContain("refreshSource: true");
    expect(verifyBlock).toContain("previewLocalCreativeProductionUnits(projectRoot)");
    expect(verifyBlock).toContain("projectRoot !== props.projectRoot || requestSequence !== refreshSequence");
    expect(canvas).toContain('data-testid="managed-canvas-verify-source"');
    expect(canvas).toContain('@click="verifyLocalProductionSource"');
  });

  it("P16：素材库 36 项分页与画布 6 项投影分离，CAS 冲突保留本地语义", () => {
    const canvas = source("src/renderer/src/components/ManagedStudioCanvasView.vue");
    const casMerge = source("src/renderer/src/studio-canvas-layout-cas-merge.ts");
    expect(canvas).toContain("toggleLibrary");
    expect(canvas).toContain("(assetsPage.value?.page.items ?? []).slice(0, 6)");
    expect(canvas).toMatch(/async function loadAssets[\s\S]{0,500}limit:\s*36/u);
    expect(canvas).toContain("const local: StudioCanvasLayoutSemanticSnapshot = {");
    expect(canvas).toContain("workflowGroups: plainWorkflowGroups(workflowGroups.value)");
    expect(canvas).toContain("saveStudioCanvasLayoutWithCasMerge");
    expect(canvas).toContain("persistedLayoutBase");
    expect(canvas).toContain("const persistedLayoutBase = shallowRef<StudioCanvasLayout | null>(null)");
    expect(casMerge).toContain("mergeStudioCanvasLayoutThreeWay");
    expect(casMerge).toContain("const remote = await input.api.loadLayout(input.projectRoot)");
    expect(casMerge).toContain("StudioCanvasLayoutMergeConflictError");
  });

  it("P7：快速切单元只保留当前在途和最新待处理读取", () => {
    const canvas = source("src/renderer/src/components/ManagedStudioCanvasView.vue");
    expect(canvas).toContain("async function drainLatestUnitSelection");
    expect(canvas).toContain("queuedUnitSelection = null");
    expect(canvas).toContain("queuedUnitSelection?.resolve()");
    expect(canvas).toContain('guarded("unit-detail"');
    expect(canvas).not.toContain("guarded(`unit-detail:${unit.id}`");
    expect(canvas).toContain("unitContextText");
    expect(canvas).toContain("· 正在载入");
    expect(canvas).toContain("invalidateQueuedUnitSelection()");
  });

  it("画布图片化：自定义节点 + 权威缩略图 + 剧本/提示词节点", () => {
    const canvas = source("src/renderer/src/components/ManagedStudioCanvasView.vue");
    expect(canvas).toContain("ManagedStudioCanvasNode");
    expect(canvas).toContain("authorityThumbUrl");
    expect(canvas).toContain("authorityThumbnailRecipeKey");
    expect(canvas).toContain("aicanvas-studio://thumbnail/");
    expect(canvas).toContain("loadTextDocuments");
    expect(canvas).toContain('kind: "script" | "prompt"');
    expect(canvas).toContain("提示词");
    expect(canvas).toContain("assetThumbById");
    expect(canvas).toContain("thumbnailNodeCount");
    expect(canvas).toContain('data-testid="managed-canvas-thumb-count"');
    expect(source("src/renderer/src/components/CanvasInspectorPanel.vue")).toContain('data-testid="managed-canvas-inspector-thumb"');
    expect(source("src/renderer/src/components/CanvasInspectorPanel.vue")).toContain('data-testid="managed-canvas-text-body"');
    expect(canvas).toContain("selection.value = { kind, doc }");
    const node = source("src/renderer/src/components/ManagedStudioCanvasNode.vue");
    expect(node).toContain('data-testid="managed-canvas-node-thumb"');
    expect(node).toContain("thumbnailUrl");
    expect(node).toContain('@error="recoverThumbnail"');
    expect(node).toContain("ensureStudioImageThumbnail");
    expect(node).toContain("thumbnailRetryNonce");
    const thumbnailScheduler = canvas.match(/function scheduleStudioThumbnailDerivation[\s\S]*?\n\}/u)?.[0] ?? "";
    expect(thumbnailScheduler).toContain("mediaKind === \"image\"");
    expect(thumbnailScheduler).toContain("ensureStudioImageThumbnail");
    expect(thumbnailScheduler).not.toContain(".finally");
    expect(node).toContain('kind: "asset" | "reference" | "unit" | "panel" | "script" | "prompt" | "raw" | "labeled" | "review"');
    const dash = source("src/core/studio-production-dashboard.ts");
    expect(dash).toContain("authorityThumbnailRecipeKey");
  });

  it("正式整板旁显示 pack 实际冻结参考，并以类型化系统边直连 raw", () => {
    const canvas = source("src/renderer/src/components/ManagedStudioCanvasView.vue");
    expect(canvas).toContain("projectStudioCanvasFrozenReferences");
    expect(canvas).toContain("loadFrozenReferencesForApprovedRaw");
    expect(canvas).toContain("getStudioFrozenPack");
    expect(canvas).toContain("unitGridReferencePipeline");
    expect(canvas).toContain("unit-grid-reference-node");
    expect(canvas).toContain("system:reference-raw:");
    expect(canvas).toContain("system-reference-edge");
    expect(canvas).toContain("本整板实际冻结输入 · approved 权威图");
    expect(canvas).toContain("mediaSha256: approvedRaw.rawMediaSha256");
    expect(canvas).toContain("mediaSha256: reference.mediaSha256");
    expect(canvas).toContain('kind: "reference"');
    // 不从资产搜索结果猜引用，也不把无法还原闭包的 raw 留在主时间线。
    expect(canvas).toContain("无法完整还原时该单元失败关闭");
    const helper = source("src/core/studio-canvas-frozen-references.ts");
    expect(helper).toContain("pack.controlReferences");
    expect(helper).toContain("pack.request.controlReferences");
    expect(helper).not.toMatch(/forbiddenAssets\.map/u);
  });

  it("正式 raw 与冻结参考节点显示可核对的 SHA 指纹，并保留完整 SHA 辅助读取", () => {
    const node = source("src/renderer/src/components/ManagedStudioCanvasNode.vue");
    expect(node).toContain("data.mediaSha256");
    expect(node).toContain("完整 SHA-256");
    expect(node).toContain("shortMediaSha256");
    expect(node).toContain("class=\"media-sha\"");
  });

  it("不透明连续性字段必须投影为 UNKNOWN，不能伪装成可直接进入下一镜的起态", () => {
    const canvas = source("src/renderer/src/components/ManagedStudioCanvasView.vue");
    expect(canvas).toContain("const continuityReadable = continuity.opaqueFieldCount === 0");
    expect(canvas).toContain("冻结计划终态 · UNKNOWN");
    expect(canvas).toContain("禁止作为下一镜站位/朝向输入");
    expect(canvas).not.toContain("system:continuity-next-unit:");
    expect(canvas).toContain("system:observed-continuity-next-unit:");
    const node = source("src/renderer/src/components/ManagedStudioCanvasNode.vue");
    expect(node).toContain('case "continuity": return "续"');
  });

  it("可读末格状态必须把真实站位等交接字段写到画布，不可读时保留末格动作与镜头信息", () => {
    const canvas = source("src/renderer/src/components/ManagedStudioCanvasView.vue");
    expect(canvas).toContain("const handoffSummary");
    expect(canvas).toContain('new Set(["position", "facing", "heldObject", "layout", "lighting"])');
    expect(canvas).toContain("lastPanelTitle: lastPanel.instruction.title");
    expect(canvas).toContain("filmingMethod: lastPanel.instruction.filmingMethod");
    expect(canvas).toContain("sceneLighting: lastPanel.instruction.sceneLighting");
    expect(canvas).toContain("计划值：${continuity.handoffSummary}");
    expect(canvas).toContain("须由 PASS 结果观察回执确认");
    expect(canvas).toContain("末格：${continuity.lastPanelTitle");
  });
});

describe("P23 画布编辑增量 UI 合同", () => {
  it("对齐/分布/吸附/undo 接入齐备且写回为数组整体替换，App.vue 门控防跨域双撤销", async () => {
    const { readFile } = await import("node:fs/promises");
    const path = await import("node:path");
    const view = await readFile(path.join(process.cwd(), "src/renderer/src/components/ManagedStudioCanvasView.vue"), "utf8");
    // 写回机制钉死（R-pre-1 P1）：数组整体替换，禁 in-place。
    expect(view).toContain("nodes.value = nodes.value.map(");
    // 事件接入：@node-drag-start/@node-drag/@node-drag-stop + delete-key-code 禁用。
    expect(view).toContain('@node-drag-start="onNodeDragStart"');
    expect(view).toContain('@node-drag="onNodeDrag"');
    expect(view).toContain("delete-key-code");
    // 对齐/分布入口与 gating（≥2/≥3）。
    expect(view).toContain("managed-canvas-align-tools");
    expect(view).toContain("applyAlign('left')");
    expect(view).toContain("applyDistribute('x')");
    expect(view).toContain("selectionCount >= 2");
    expect(view).toContain("selectionCount >= 3");
    // undo/redo 入口与快捷键门控（非输入框+isDragging）。
    expect(view).toContain("managed-canvas-undo");
    expect(view).toContain("managed-canvas-redo");
    expect(view).toContain("isDragging.value");
    expect(view).toContain("undoLayout");
    expect(view).toContain("redoLayout");
    // 吸附参考线层与候选（会话内已渲染 dimensions 口径，规范 v2.2 附录）。
    expect(view).toContain("snap-guides");
    expect(view).toContain("computeCanvasSnap");
    expect(view).toContain("8 / zoom");
    // R2-F3：候选过滤与 delete-key-code 值锚点。
    expect(view).toContain("!selectedIds.has(node.id)");
    expect(view).toContain("dimensions?.height");
    expect(view).toContain(':delete-key-code="() => false"');
    // R3-F1：成组拖动禁吸附门控（库逐帧重算组员，吸附会破坏队形并被落盘）。
    expect(view).toContain("selectedIds.size > 1");
    // R5-F1：组拖判据以载荷 dragItems 计数为准（Cmd/Ctrl toggle 手势下实时选区会少算被拖节点）+显式剔除自候选。
    expect(view).toContain("(event.nodes?.length ?? 0) > 1");
    expect(view).toContain("node.id !== draggedNode.id");
    // R3 N1：drag-start 快照以载荷 dragItems 精确集为准（toggle 手势下 undo 能回退被拖节点）。
    expect(view).toContain("event?.nodes?.length");
    // R3-F2/R2-F1：挂起 rAF 取消（stop/切工程/卸载三路径）+ 迟到回调 isDragging 防线 + 最新事件合并。
    expect(view).toContain("cancelPendingSnap");
    expect((view.match(/cancelPendingSnap\(\);/gu) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(view).toContain("pendingSnapEvent");
    expect(view).toContain("if (!isDragging.value) {\n    snapLines.value = [];");
    // R2-F5：undo/redo 按钮与快捷键同享 isDragging 门控。
    expect(view).toContain('data-testid="managed-canvas-undo" :disabled="!canUndoLayout || isDragging"');
    expect(view).toContain('data-testid="managed-canvas-redo" :disabled="!canRedoLayout || isDragging"');
    // 帮助文案与多选计数。
    expect(view).toContain("左键拖框选、Cmd/Ctrl+点击多选、选中后整组拖动");
    expect(view).toContain("已选 {{ selectionCount }} 节点");
    // 持久化路径复用（§4-6）：applyPositionMap 合并 persistedLayoutNodes + scheduleLayoutPersist。
    expect(view).toContain("persistedLayoutNodes.value = { ...persistedLayoutNodes.value, ...changed };");
    expect(view).toContain("scheduleLayoutPersist();");
    // 纯函数模块无 node 依赖。
    const align = await readFile(path.join(process.cwd(), "src/renderer/src/studio-canvas-align.ts"), "utf8");
    expect(align).not.toMatch(/from "node:/u);
    expect(align).toContain("alignCanvasNodes");
    expect(align).toContain("distributeCanvasNodes");
    expect(align).toContain("computeCanvasSnap");
    const undo = await readFile(path.join(process.cwd(), "src/renderer/src/studio-canvas-undo.ts"), "utf8");
    expect(undo).not.toMatch(/from "node:/u);
    expect(undo).toContain("createCanvasUndoStack");
    // App.vue 门控（R-pre-2 F2）。
    const app = await readFile(path.join(process.cwd(), "src/renderer/src/App.vue"), "utf8");
    expect(app).toContain("managedShell.value || activeView.value !== \"canvas\"");
  });
});

describe("P25 主题与事件接线 UI 合同", () => {
  it("主题系统接线：根 data-theme、主题模块消费、视图菜单三选一、组件无存储字面量", () => {
    const view = source("src/renderer/src/components/ManagedStudioCanvasView.vue");
    expect(view).toContain(':data-theme="canvasTheme"');
    expect(view).toContain('role="radiogroup"');
    expect(view).toContain("setCanvasTheme(theme.id)");
    expect(view).toContain("readManagedCanvasTheme()");
    expect(view).toContain("writeManagedCanvasTheme(themeId)");
    expect(view).toContain("getManagedCanvasThemeAssets(canvasTheme.value)");
    expect(view).toContain(':pattern-color="canvasThemeAssets.patternColor"');
    expect(view).toContain(':mask-color="canvasThemeAssets.minimapMaskColor"');
    expect(view).toContain(':node-color="canvasThemeAssets.minimapNodeColor"');
    // 合同红线：组件源码不得出现存储/SQLite 字面量（含注释），主题持久化只能经主题模块。
    expect(view).not.toMatch(/sqlite|localStorage|sessionStorage/);
    // 主题 token 三皮肤：light 默认挂裸类，dark/paper 属性选择器覆盖。
    expect(view).toMatch(/\.managed-studio-canvas\s*\{\s*--msc-bg:/u);
    expect(view).toContain('.managed-studio-canvas[data-theme="dark"]');
    expect(view).toContain('.managed-studio-canvas[data-theme="paper"]');
    // Vue Flow 深色全局样式经 scoped :deep 覆写（不动 styles.css）。
    expect(view).toContain(":deep(.vue-flow__controls-button)");
    expect(view).toContain(":deep(.vue-flow__minimap)");
    expect(source("src/renderer/src/styles.css")).not.toMatch(/--msc-|data-theme/u);
    const node = source("src/renderer/src/components/ManagedStudioCanvasNode.vue");
    expect(node).toContain("var(--msc-surface)");
    expect(node).toContain("color-mix(in srgb, var(--msc-kind-unit)");
  });

  it("选区回读走 nodesChange（库无 selection-change 事件），对齐/分布/保存所选可达", () => {
    const view = source("src/renderer/src/components/ManagedStudioCanvasView.vue");
    // F-01 回归：模板必须监听 nodes-change，禁止再绑定不存在的 selection-change。
    expect(view).toContain('@nodes-change="onNodesChange"');
    expect(view).not.toContain("@selection-change");
    expect(view).toContain('change.type === "select"');
    expect(view).toContain("syncSelectionSnapshot(nodes.value)");
    expect(view).toContain("syncSelectionSnapshot(nextNodes)");
    expect(view).toContain("MAX_CANVAS_TEXT_DOCUMENTS = 12");
    expect(view).toContain("planStatusLoadSequence");
    expect(view).toContain("payload.projectId !== overview.value?.projectId");
    expect(view).toContain("controlViewportSequence");
    // 拖拽会话收尾：blur 与 dragStop 共用 finalizeDragSession。
    expect(view).toContain("finalizeDragSession");
    expect(view).toContain('window.addEventListener("blur", onWindowBlur)');
    expect(view).toContain('window.removeEventListener("blur", onWindowBlur)');
    // 账本投影驱动节点徽标（syncPlanNodeStatuses 经 200ms 去抖重建；拖拽中置脏收尾补齐）。
    expect(view).toContain("schedulePlanStatusRebuild()");
    expect(view).toContain("planStatusRebuildDirty");
    // 取消连线外科式清除描边（不触发全量重建，P15 合同）。
    expect(view).toContain("stripPendingOutline");
    expect(view).toMatch(/function toggleConnectMode[\s\S]{0,400}stripPendingOutline\(previousPendingId\);/u);
  });
});

describe("P26 弹层交互基建合同", () => {
  it("点击外部关闭 + Escape 统一（含视图菜单）+ 焦点归还 + 连线横幅", () => {
    const view = source("src/renderer/src/components/ManagedStudioCanvasView.vue");
    // 外部点击关闭三处弹层（钉取反运算符与各分支守卫，防行为反转）。
    expect(view).toContain("onGlobalPointerDown");
    expect(view).toContain('document.addEventListener("pointerdown", onGlobalPointerDown, true)');
    expect(view).toContain('document.removeEventListener("pointerdown", onGlobalPointerDown, true)');
    expect(view).toMatch(/addMenuOpen\.value && !target\.closest\("\.add-menu-wrap"\)/u);
    expect(view).toMatch(/helpOpen\.value && !target\.closest\("\.help-card"\) && !helpTriggerEl\.value\?\.contains\(target\)/u);
    expect(view).toMatch(/hasAttribute\("open"\) && !target\.closest\("\.view-menu"\)/u);
    // view-menu 关闭函数体必须真实移除 open 属性。
    expect(view).toContain('viewMenuEl.value?.removeAttribute("open")');
    // Escape 关闭 details 形态视图菜单；焦点归还带守卫（仅在弹层曾打开时归还对应触发器）。
    expect(view).toContain("closeViewMenu()");
    expect(view).toMatch(/if \(helpWasOpen\) helpTriggerEl\.value\?\.focus\(\);/u);
    expect(view).toMatch(/else if \(addWasOpen\) addTriggerEl\.value\?\.focus\(\);/u);
    // 连线模式横幅（role=status，v-if 绑定 connectMode，文案说人话，Esc 退出）。
    expect(view).toContain('v-if="connectMode" class="connect-banner" role="status"');
    expect(view).toContain("连线模式：点击一个节点的＋");
    // 动效遵守 prefers-reduced-motion。
    expect(view).toContain("prefers-reduced-motion");
  });
});

describe("P26 素材库与可发现性合同", () => {
  it("素材库空态/加载态/搜索提示/分页位置感/已添加禁重复", () => {
    const view = source("src/renderer/src/components/ManagedStudioCanvasView.vue");
    expect(view).toContain("library-empty");
    expect(view).toContain("正在加载…");
    expect(view).toContain("输入名称、别名或 SHA，按回车搜索");
    expect(view).toContain("pager-position");
    expect(view).toContain('role="status"');
    expect(view).toMatch(/addUnitToWorkspace\(unit\)">|已添加/u);
    expect(view).toContain(':disabled="isPinned(`unit:${unit.id}`) || loading || addUnitActionBusy"');
    // 帮助卡补充行为可发现性（双击详情/单击直达审片）。
    expect(view).toContain("双击单元或资产节点可打开驾驶舱详情");
    expect(view).toContain("原始图/标注图/审片");
  });
});

describe("P26 接线与文案合同（审查升级补强）", () => {
  it("检查器父子接线、错误翻译接线、P2-1 计划组文案、壳主题事件联动", () => {
    const view = source("src/renderer/src/components/ManagedStudioCanvasView.vue");
    // 父组件必须真实渲染并绑定子组件（防整体删除检查器仍绿）。
    expect(view).toContain("<CanvasInspectorPanel");
    expect(view).toContain('@close="selection = null"');
    expect(view).toContain('@focus-appearance="focusAppearance"');
    expect(view).toContain('@run-node-action="runNodeAction"');
    // 错误翻译在画布 message() 实际接线。
    expect(view).toContain('from "../user-facing-error"');
    expect(view).toMatch(/function message\(error: unknown\): string \{\s*return toUserFacingErrorText\(error\);\s*\}/u);
    // 壳 fail() 接线 + 主题事件监听与注销。
    const material = source("src/renderer/src/components/MaterialStudioView.vue");
    expect(material).toContain("toUserFacingErrorText(reason)");
    expect(material).toContain("MANAGED_CANVAS_THEME_CHANGED_EVENT");
    expect(material).toContain('window.removeEventListener(MANAGED_CANVAS_THEME_CHANGED_EVENT, onCanvasThemeChanged)');
    expect(material).toContain(':data-theme="shellTheme"');
    // 主题模块事件派发。
    const theme = source("src/renderer/src/managed-canvas-theme.ts");
    expect(theme).toContain('new CustomEvent(MANAGED_CANVAS_THEME_CHANGED_EVENT');
    expect(view).toContain("notifyManagedCanvasThemeChanged(themeId)");
    // P2-1 计划组用户文案与分组字段。
    const generation = source("src/renderer/src/components/StudioGenerationControlView.vue");
    expect(generation).toContain("第 {{ groupIndex + 1 }} 批 · {{ group.nodes.length }} 个任务");
    expect(generation).toContain("最近活动 {{ group.lastActivityAt }}");
    expect(generation).toContain("lastActivityAt");
    expect(generation).toContain("第 {{ node.attempt }} 次尝试");
    expect(generation).toContain("接管上一次任务");
    expect(generation).toContain("生成包已变化");
    expect(generation).toContain("plan-id-diagnostics");
  });
});

describe("T23 规模验收只读 hook", () => {
  it("从 VueFlow nodes store 暴露实际单元节点 ID，不以 overview 计数代替", () => {
    const view = source("src/renderer/src/components/ManagedStudioCanvasView.vue");
    expect(view).toContain("unitNodeIds: nodes.value");
    expect(view).toMatch(
      /unitNodeIds:\s*nodes\.value\s*\.filter\(\(node\) => node\.id\.startsWith\("unit:"\)\)\s*\.map/u,
    );
  });
});

describe("P2c 当前单元聚合投影", () => {
  it("桌面端用一次聚合 IPC 读取当前 2–6 格，旧逐格历史查询仅作兼容回退", () => {
    const view = source("src/renderer/src/components/ManagedStudioCanvasView.vue");
    const preload = source("src/preload/index.ts");
    const main = source("src/main/index.ts");
    const app = source("src/renderer/src/App.vue");

    expect(view).toContain("props.api.getProductionProjectionBundle");
    expect(view).toContain("bundle.currentUnit.panels.length > 6");
    expect(view).toContain("currentProductionBundle = shallowRef");
    expect(view.indexOf("props.api.getProductionProjectionBundle")).toBeLessThan(
      view.indexOf("window.canvasApi.listStudioGenerationPanelHistory"),
    );
    expect(preload).toContain('t23IpcPerformanceProbe.invoke("canvas:get-studio-production-projection-bundle"');
    expect(main).toContain('ipcMain.handle("canvas:get-studio-production-projection-bundle"');
    expect(main).toContain("buildStudioProductionProjectionBundle(projectRoot, query)");
    expect(app).toContain("window.canvasApi.getStudioProductionProjectionBundle(root, query)");
  });
});
