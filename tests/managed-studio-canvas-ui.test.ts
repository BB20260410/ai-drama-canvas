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
    const gateIndex = refreshAll.indexOf("await refreshRuntimeWriteGate()");
    const firstBusinessReadIndex = refreshAll.indexOf("await flushPendingLayout(projectRoot)");
    expect(gateIndex).toBeGreaterThanOrEqual(0);
    expect(firstBusinessReadIndex).toBeGreaterThan(gateIndex);
    expect(refreshAll).toContain('runtimeWriteGateState.value !== "allowed") return');
    expect(refreshAll.match(/refreshRuntimeWriteGate\(\)/gu)).toHaveLength(1);
    const unitsIndex = refreshAll.indexOf("loadUnitsPage({ deferTimelineProjections: true })");
    const firstCardIndex = refreshAll.indexOf("await waitForInitialUnitCardDom(");
    const overviewIndex = refreshAll.indexOf("loadOverview()");
    const rawIndex = refreshAll.indexOf("void activateUnitTimelineProjections(initialUnits)");
    const assetsIndex = refreshAll.indexOf("loadAssets()");
    const textIndex = refreshAll.indexOf("loadTextDocuments()");
    expect(unitsIndex).toBeGreaterThan(gateIndex);
    expect(firstCardIndex).toBeGreaterThan(unitsIndex);
    expect(overviewIndex).toBeGreaterThan(firstCardIndex);
    expect(rawIndex).toBeGreaterThan(overviewIndex);
    expect(refreshAll).not.toContain("Promise.all([unitsRead, overviewRead])");
    expect(assetsIndex).toBeGreaterThan(rawIndex);
    expect(textIndex).toBeGreaterThan(rawIndex);
    const identityIndex = refreshAll.indexOf("void refreshRuntimeBuildIdentityDisplay(projectRoot, requestSequence)");
    expect(identityIndex).toBeGreaterThan(textIndex);
    const gateFunction = canvas.slice(
      canvas.indexOf("async function refreshRuntimeWriteGate(): Promise<void>"),
      canvas.indexOf("async function refreshRuntimeBuildIdentityDisplay("),
    );
    expect(gateFunction).toContain("await api.getRuntimeWriteGate()");
    expect(gateFunction).not.toContain("await api.getRuntimeBuildIdentity()");

    const firstCardObserver = canvas.slice(
      canvas.indexOf("function recordInitialUnitCardIfReady("),
      canvas.indexOf("const layoutSaveCoordinator"),
    );
    expect(canvas).toContain('const INITIAL_UNIT_CARD_SELECTOR = \'[data-testid="managed-studio-canvas-node"]');
    expect(firstCardObserver).toContain("document.querySelectorAll<HTMLElement>(INITIAL_UNIT_CARD_SELECTOR)");
    expect(firstCardObserver).toContain("scope.expectedUnitIds.has(node.dataset.unitId");
    expect(firstCardObserver).toContain("canvas-first-card-dom-unit:${unitId}");
    expect(firstCardObserver).not.toContain("t23PerformanceProbeEnabled");
    expect(canvas).toContain("unitId: unit.id");
    expect(refreshAll).toContain('emit("initialUnitCardsCommitted"');
    // 首卡 mutation 基线必须在任何 overview IPC 前冻结并逐层携带；否则 overview
    // 自己的读取会污染“首卡前”的门禁计数。
    expect(refreshAll).toContain("await captureT23FirstCardMutationChecks()");
    expect(refreshAll.indexOf("await captureT23FirstCardMutationChecks()")).toBeLessThan(
      refreshAll.indexOf("const overviewRead = loadOverview()"),
    );
    expect(refreshAll.indexOf('emit("initialUnitCardsCommitted"')).toBeLessThan(
      refreshAll.indexOf("const overviewRead = loadOverview()"),
    );
    expect(refreshAll).toContain("if (canvasDisposed) return");
    expect(refreshAll).toContain("const isCurrent = () => !canvasDisposed");

    const projectRootWatch = canvas.slice(
      canvas.indexOf("watch(() => props.projectRoot"),
      canvas.indexOf("onMounted(async () =>"),
    );
    expect(projectRootWatch).toContain("await previousLayoutFlush");
    expect(projectRootWatch).toMatch(/await previousLayoutFlush;\s*if \(canvasDisposed\) return;\s*await refreshAll\(\)/u);
  });

  it("作为 Material Studio 独立入口并默认打开，不替换生产驾驶舱 owner", () => {
    const material = source("src/renderer/src/components/MaterialStudioView.vue");
    expect(parse(material, { filename: "MaterialStudioView.vue" }).errors).toEqual([]);
    expect(material).toContain('data-testid="studio-mode-canvas"');
    expect(material).toContain("AsyncManagedStudioCanvasView");
    expect(material).toContain('@initial-unit-cards-committed="onInitialUnitCardsCommitted"');
    expect(material).toContain('props.dashboardApi ? "canvas" : "library"');
    expect(material.match(/props\.dashboardApi \? "canvas" : "library"/gu)?.length).toBeGreaterThanOrEqual(2);
    expect(material).toContain("AsyncStudioProductionDashboardView");

    const workspaceWatch = material.slice(
      material.indexOf("watch([() => props.projectRoot, () => props.api]"),
      material.indexOf("watch(searchInput"),
    );
    expect(workspaceWatch).toContain("initialOverviewReleaseGate.reset(props.projectRoot)");
    expect(workspaceWatch).not.toContain("void refresh()");
    expect(material).toContain("function startInitialOverview(");
    expect(material).toContain("function onInitialUnitCardsCommitted(");
    expect(material).toMatch(/function onDashboardFailed[\s\S]{0,220}startInitialOverview/u);
  });

  it("缩略图点击仍交给 Vue Flow 选中节点，避免图片节点无法打开下一步操作", () => {
    const node = source("src/renderer/src/components/ManagedStudioCanvasNode.vue");
    expect(parse(node, { filename: "ManagedStudioCanvasNode.vue" }).errors).toEqual([]);
    const thumbnail = node.slice(
      node.indexOf('data-testid="managed-canvas-node-thumb-wrap"') - 120,
      node.indexOf('data-testid="managed-canvas-node-thumb"'),
    );
    expect(thumbnail).not.toContain("@click.stop");
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
    expect(canvas).toContain("createT23RawReferenceSpanTracker");
    expect(canvas).toContain("t23RawReferenceSpanTracker.invalidateCurrent");
    expect(canvas).toContain("t23RawReferenceSpan.markFirstRaw(unit.id)");
    expect(canvas).toContain("t23RawReferenceSpan.recordPassReference(unitId)");
    expect(canvas).toContain("t23RawReferenceSpan.complete()");
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
    expect(canvas).toContain("const UNIT_GRID_ENRICHMENT_CONCURRENCY = 4");
    expect(canvas).toContain("runBoundedAsyncTasks");
    expect(canvas).toContain("unitGridVideoPackagePipeline.value = nextVideoPackages");
    expect(canvas).toContain("unitGridPostResultObservationPipeline.value = nextPostResultObservations");
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
    expect(canvas).toContain(':pan-on-drag="panOnDragButtons"');
    expect(canvas).toContain("spacePanHeld.value ? [0, 1, 2] : [1, 2]");
    expect(canvas).toContain(':selection-key-code="true"');
    expect(canvas).toContain('data-testid="managed-canvas-layout-status"');
    expect(canvas).not.toMatch(/sqlite|localStorage|sessionStorage/);
    const node = source("src/renderer/src/components/ManagedStudioCanvasNode.vue");
    // 缩略图始终禁止浏览器拖出；独立 nodrag/nopan 手柄才触发 OS 原生复制。
    expect(node).toContain('draggable="false"');
    expect(node).toContain('class="media-export-handle nodrag nopan"');
    expect(node).toContain('data-testid="managed-canvas-media-export-handle"');
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

  it("检查器禁用动作必须展示 action.reason，避免可点无反馈", () => {
    const inspector = source("src/renderer/src/components/CanvasInspectorPanel.vue");
    expect(inspector).toContain("action.reason");
    expect(inspector).toContain("managed-canvas-action-reason-");
    expect(inspector).toContain(":title=\"action.reason || action.label\"");
    expect(inspector).toContain("reason?: string");
    expect(inspector).toContain(":disabled=\"!action.enabled\"");
    expect(inspector).toContain("button:disabled { opacity: .4; cursor: default; }");
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
    const togglePinned = canvas.slice(
      canvas.indexOf("async function togglePinnedNode"),
      canvas.indexOf("async function addUnitToWorkspace"),
    );
    const enteringWorkflow = togglePinned.indexOf('const enteringWorkflow = workspaceMode.value !== "workflow";');
    const pinnedAssets = togglePinned.indexOf("await loadPinnedAssets({ rebuild: !enteringWorkflow });");
    const enterBranch = togglePinned.indexOf("if (enteringWorkflow) {");
    const switchMode = togglePinned.indexOf('workspaceMode.value = "workflow";', enterBranch);
    const rebuild = togglePinned.indexOf("rebuildGraph();", switchMode);
    const nextTick = togglePinned.indexOf("await nextTick();", rebuild);
    const fit = togglePinned.indexOf("void fitCanvas().catch", nextTick);
    expect([enteringWorkflow, pinnedAssets, enterBranch, switchMode, rebuild, nextTick, fit].every((index) => index >= 0)).toBe(true);
    expect(enteringWorkflow).toBeLessThan(pinnedAssets);
    expect(pinnedAssets).toBeLessThan(enterBranch);
    expect(enterBranch).toBeLessThan(switchMode);
    expect(switchMode).toBeLessThan(rebuild);
    expect(rebuild).toBeLessThan(nextTick);
    expect(nextTick).toBeLessThan(fit);
    expect(togglePinned).toContain("它不得占住固定节点的唯一 busy owner");
    expect(canvas).toContain("loadPinnedUnit");
    expect(canvas).toContain("loadUnitDetailById");
    expect(canvas).toMatch(/await loadPinnedTextDocuments\(\);[\s\S]{0,220}await loadPinnedMedia\(\{ rebuild: false \}\);[\s\S]{0,160}await loadPinnedUnit\(\);/u);
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
    expect(canvasSwitchBlock.lastIndexOf("loading.value = true"))
      .toBeGreaterThan(canvasSwitchBlock.indexOf("loading.value = false"));
    expect(canvasSwitchBlock.lastIndexOf("loading.value = true"))
      .toBeLessThan(canvasSwitchBlock.indexOf("await previousLayoutFlush"));
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
    expect(canvas).toContain("createStudioCanvasLayoutSaveCoordinator");
    expect(canvas).toContain("layoutSaveCoordinator.saveLatest");
    expect(canvas).toContain("layoutSaveCoordinator.saveExclusive");
    expect(canvas).toContain("persistLayoutNow(layoutSaveGeneration, projectRoot, { force: true })");
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
    expect(canvas).toContain("latestUnitSelectionKey");
    expect(canvas).toContain("unitSelectionDrain && latestUnitSelectionKey === requestKey");
    expect(canvas).toContain("return unitSelectionDrain");
  });

  it("总投影 IPC 保留一个当前单元详情槽", () => {
    const canvas = source("src/renderer/src/components/ManagedStudioCanvasView.vue");
    expect(canvas).toContain("const TIMELINE_PROJECTION_WORKER_CONCURRENCY = 3");
    expect(canvas).toContain("Math.min(TIMELINE_PROJECTION_WORKER_CONCURRENCY, projectionUnits.length)");
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
    expect(node).toContain('kind: "asset" | "reference" | "unit" | "panel" | "script" | "prompt" | "image" | "raw" | "labeled" | "review" | "video" | "audio"');
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
    expect(view).toContain('@close="closeInspector"');
    expect(view).toContain("selection.value = null");
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

describe("受管画布角色库图+音频入库", () => {
  it("角色页提供上传图片/音频并入库放到画布的入口", () => {
    const view = source("src/renderer/src/components/ManagedStudioCanvasView.vue");
    expect(view).toContain('data-testid="managed-canvas-character-ingest"');
    expect(view).toContain('data-testid="managed-canvas-character-pick-image"');
    expect(view).toContain('data-testid="managed-canvas-character-pick-audio"');
    expect(view).toContain('data-testid="managed-canvas-character-save"');
    expect(view).toContain("ingestCharacterCanvasPack");
    expect(view).toContain('libraryTab === \'character\' || libraryTab === \'scene\' || libraryTab === \'prop\'');
    expect(view).toContain('category === "character" && characterAudioPath.value');
    expect(view).toContain("attachCharacterCompanionAudio");
    expect(view).toContain('data-testid="managed-canvas-character-pick-side"');
    expect(view).toContain('data-testid="managed-canvas-character-pick-back"');
    expect(view).toContain("sideImagePath");
    expect(view).toContain("backImagePath");
    expect(view).toContain("audioSha256sForCharacterAsset");
    expect(view).toContain(':character-audio-count="selectedCharacterAudioCount"');
    expect(view).toContain('data-testid="managed-canvas-character-aliases-input"');
    expect(view).toContain("splitCanvasAssetAliases(characterIngestAliases.value)");
    expect(view).toContain("...(aliases.length ? { aliases } : {})");
    expect(view).toContain('data-testid="managed-canvas-character-description-input"');
    expect(view).toContain("...(description ? { description } : {})");
  });

  it("音频节点用原生播放器走 aicanvas-studio 媒体协议，不引入第二套波形库", () => {
    const node = source("src/renderer/src/components/ManagedStudioCanvasNode.vue");
    expect(node).toContain('data-testid="managed-canvas-audio-player"');
    expect(node).toContain("canPlayAudio");
    expect(node).toContain("aicanvas-studio://media/${props.data.mediaSha256}?projectRoot=");
    expect(node).not.toContain("wavesurfer");
    expect(node).not.toContain("peaks.js");
  });

  it("侧栏库条目可拖到画布落点钉选，不另建坐标表", () => {
    const view = source("src/renderer/src/components/ManagedStudioCanvasView.vue");
    expect(view).toContain('const LIBRARY_NODE_MIME = "application/x-aicanvas-library-node"');
    expect(view).toContain("function onLibraryDragStart");
    expect(view).toContain("async function dropLibraryNodeAt");
    expect(view).toContain("studioFlow.screenToFlowCoordinate");
    expect(view).toContain('data-testid="managed-canvas-library-drag"');
    expect(view).toContain("event.dataTransfer?.getData(LIBRARY_NODE_MIME)");
  });

  it("⌘G 创建空间命名组并写入 spatialGroups，不改 BindingSet", () => {
    const view = source("src/renderer/src/components/ManagedStudioCanvasView.vue");
    expect(view).toContain("function groupSelectedCanvasNodes");
    expect(view).toContain("function ungroupSelectedCanvasNodes");
    expect(view).toContain("function applySpatialGrouping");
    expect(view).toContain('type: "studioSpatialGroup"');
    expect(view).toContain('event.key.toLowerCase() === "g"');
    expect(view).not.toContain("createWorkflowFromSelection();");
  });

  it("节点 busy 时暂停音频，避免处理中仍播放", () => {
    const node = source("src/renderer/src/components/ManagedStudioCanvasNode.vue");
    expect(node).toContain("audioEl.value?.pause()");
    expect(node).toContain("watch(\n  () => props.data.busy,\n  (busy) => {\n    if (busy) audioEl.value?.pause();\n  },\n);");
    expect(node).toContain("onBeforeUnmount(() => {\n  nodeDisposed = true;\n  audioEl.value?.pause();");
  });

  it("播放地址身份变化时暂停音频，避免切工程仍播旧声", () => {
    const node = source("src/renderer/src/components/ManagedStudioCanvasNode.vue");
    expect(node).toContain("const playbackUrl = computed(() => {");
    expect(node).toContain("watch(playbackUrl, () => {\n  audioEl.value?.pause();\n});");
    expect(node).not.toContain("wavesurfer");
  });

  it("角色参考图/音频选择 fail-closed：pickingCharacterMedia 挡住连点双开系统文件框", () => {
    const view = source("src/renderer/src/components/ManagedStudioCanvasView.vue");
    expect(view).toContain('data-testid="managed-canvas-character-pick-image"');
    expect(view).toContain('data-testid="managed-canvas-character-pick-audio"');
    expect(view).toContain(':disabled="characterIngestBusy || pickingCharacterMedia"');
    expect(view).toContain("正在处理，不能再选择角色参考图");
    expect(view).toContain("正在处理，不能再选择角色音频");
    const image = view.slice(
      view.indexOf("async function pickCharacterImage()"),
      view.indexOf("async function pickCharacterAudio()"),
    );
    const audio = view.slice(
      view.indexOf("async function pickCharacterAudio()"),
      view.indexOf("async function submitCharacterIngest()"),
    );
    for (const handler of [image, audio]) {
      expect(handler).toContain("if (characterIngestBusy.value || pickingCharacterMedia.value) return;");
      expect(handler).toContain("pickingCharacterMedia.value = true;");
      expect(handler.indexOf("if (characterIngestBusy.value || pickingCharacterMedia.value) return;")).toBeLessThan(
        handler.indexOf("pickingCharacterMedia.value = true;"),
      );
      expect(handler.indexOf("pickingCharacterMedia.value = true;")).toBeLessThan(
        handler.indexOf("await window.canvasApi.pickStudioMediaFiles()"),
      );
      expect(handler).toContain("pickingCharacterMedia.value = false;");
    }
  });
});

describe("受管画布侧栏列表视口剔除", () => {
  it("library-list 行使用 content-visibility，避免离屏 36 项同步布局", () => {
    const view = source("src/renderer/src/components/ManagedStudioCanvasView.vue");
    expect(view).toContain("class=\"library-list unit-list\"");
    expect(view).toContain(".library-list li { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 5px; content-visibility: auto; contain-intrinsic-size: auto 56px; }");
  });

  it("global-resource-card 使用 content-visibility，离屏 36 项跳过同步布局", () => {
    const view = source("src/renderer/src/components/ManagedStudioCanvasView.vue");
    expect(view).toContain('v-for="(entry, index) in globalResourcePage.items"');
    expect(view).toContain('class="global-resource-card"');
    expect(view).toContain("const GLOBAL_RESOURCE_PAGE_LIMIT = 36");
    expect(view).toMatch(/\.global-resource-list-viewport\s*\{[^}]*overflow:\s*auto/);
    expect(view).toMatch(/\.global-resource-card\s*\{[^}]*content-visibility:\s*auto/);
    expect(view).toMatch(/\.global-resource-card\s*\{[^}]*contain-intrinsic-size:\s*auto 128px/);
    expect(view).not.toMatch(/\.global-resource-card\s*\{[^}]*content-visibility:\s*hidden/);
    expect(view).not.toMatch(/\.global-resource-tabs button\s*\{[^}]*content-visibility/);
  });

  it("检查器 appearance-list 行使用 content-visibility，离屏出场条目跳过同步布局", () => {
    const inspector = source("src/renderer/src/components/CanvasInspectorPanel.vue");
    expect(inspector).toContain('data-testid="managed-canvas-appearances"');
    expect(inspector).toContain(".appearance-list button { width: 100%; border: 1px solid var(--msc-line); border-radius: 7px; background: var(--msc-bg); padding: 8px; color: var(--msc-text); text-align: left; cursor: pointer; content-visibility: auto; contain-intrinsic-size: auto 40px; }");
    expect(inspector).not.toMatch(/\.appearance-list button \{[^}]*content-visibility:\s*hidden/);
  });

  it("角色检查器展示已绑定音频，放到画布时会自动带出", () => {
    const inspector = source("src/renderer/src/components/CanvasInspectorPanel.vue");
    expect(inspector).toContain('data-testid="managed-canvas-character-audio"');
    expect(inspector).toContain("放到画布时会自动带出");
    expect(inspector).toContain('data-testid="managed-canvas-character-views"');
    expect(inspector).toContain('data-testid="managed-canvas-character-aliases"');
    expect(inspector).toContain("characterAliasLabel");
    expect(inspector).toContain('data-testid="managed-canvas-character-description"');
  });

  it("角色检查器对已绑 CAS 音频用原生控件试听，busy 时禁用", () => {
    const inspector = source("src/renderer/src/components/CanvasInspectorPanel.vue");
    const view = source("src/renderer/src/components/ManagedStudioCanvasView.vue");
    expect(inspector).toContain('data-testid="managed-canvas-character-audio-player"');
    expect(inspector).toContain("<audio");
    expect(inspector).toContain('preload="metadata"');
    expect(inspector).toContain('class="audio-player inspector-audio-player"');
    expect(inspector).toContain("claimCanvasAudioPlayback(characterAudioEl.value)");
    expect(inspector).toContain("releaseCanvasAudioPlayback(characterAudioEl.value)");
    expect(inspector).toContain(".inspector-audio-player.audio-blocked { pointer-events: none; }");
    expect(inspector).not.toContain("wavesurfer");
    expect(view).toContain(':character-audio-playback-url="selectedCharacterAudioPlaybackUrl"');
    expect(view).toContain(':character-audio-blocked="characterAudioBlocked"');
    expect(view).toContain("aicanvas-studio://media/${sha}?projectRoot=");
    expect(view).toContain("loading.value || pinActionBusy.value");
  });

  it("Shift+1/0/2 视口快捷键走 fitCanvas、zoomTo(1)、选区包围盒，Controls 不走默认 fitView", () => {
    const view = source("src/renderer/src/components/ManagedStudioCanvasView.vue");
    const keydown = view.slice(view.indexOf("function onCanvasKeydown"), view.indexOf("function onWindowBlur") > view.indexOf("function onCanvasKeydown") ? view.indexOf("if (event.key !== \"Escape\") return") : view.length);
    expect(view).toContain('event.key === digit || event.code === `Digit${digit}`');
    expect(keydown.indexOf('isShiftDigit(event, "1")')).toBeGreaterThanOrEqual(0);
    expect(keydown.indexOf('isShiftDigit(event, "1")')).toBeLessThan(keydown.indexOf("void fitCanvas()"));
    expect(keydown.indexOf('isShiftDigit(event, "0")')).toBeLessThan(keydown.indexOf("onZoomTo100()"));
    expect(view).toContain("studioFlow.zoomTo(1, { duration: 180 })");
    expect(keydown.indexOf('isShiftDigit(event, "2")')).toBeLessThan(keydown.indexOf("void fitSelectedCanvasNodes()"));
    expect(view).toContain("const selected = nodes.value.filter((node) => node.selected);");
    expect(view).toContain("if (!selected.length) return;");
    expect(view.indexOf("if (!selected.length) return;")).toBeLessThan(view.indexOf("await fitCanvasToNodes(selected);"));
    expect(view).toContain('#control-fit-view');
    expect(view).toContain("onFitViewControl");
    expect(view).not.toContain("@fit-view=");
    expect(view).not.toContain("wavesurfer");
  });

  it("网格吸附默认关，对象吸附之后 round 24，成组拖不 round，不开 Vue Flow snapToGrid", () => {
    const view = source("src/renderer/src/components/ManagedStudioCanvasView.vue");
    const snap = view.slice(view.indexOf("function applySnap"), view.indexOf("function snapGuideStyle"));
    expect(view).toContain("const gridSnapEnabled = ref(false);");
    expect(view).toContain('data-testid="managed-canvas-snap-to-grid"');
    expect(view).not.toContain("snap-to-grid=");
    expect(view).not.toContain(":snap-to-grid");
    expect(snap).toContain("computeCanvasSnap");
    expect(snap.indexOf("selectedIds.size > 1")).toBeLessThan(snap.indexOf("roundToCanvasGrid"));
    expect(snap.indexOf("computeCanvasSnap")).toBeLessThan(snap.indexOf("roundToCanvasGrid"));
    expect(snap).toContain("if (gridSnapEnabled.value)");
    expect(snap).toContain("CANVAS_GRID_SIZE");
  });

  it("Arrow 微移 1px、Shift+Arrow 24px，无选区不 mutate", () => {
    const view = source("src/renderer/src/components/ManagedStudioCanvasView.vue");
    const keydown = view.slice(view.indexOf("function onCanvasKeydown"));
    expect(keydown).toContain('event.key === "ArrowUp" || event.key === "ArrowDown" || event.key === "ArrowLeft" || event.key === "ArrowRight"');
    expect(keydown.indexOf("ArrowLeft")).toBeLessThan(keydown.indexOf("nudgeSelectedCanvasNodes"));
    expect(view).toContain("const step = event.shiftKey ? CANVAS_GRID_SIZE : 1;");
    expect(view).toContain("if (!selected.length) return;");
    expect(view).toContain("function nudgeSelectedCanvasNodes");
    expect(view).toContain("applyPositionMap(changed);");
  });

  it("Delete/Backspace 优先删所选连线，否则卸钉；不启用 Vue Flow 默认删除", () => {
    const view = source("src/renderer/src/components/ManagedStudioCanvasView.vue");
    const keydown = view.slice(view.indexOf("function onCanvasKeydown"));
    expect(view).toContain(':delete-key-code="() => false"');
    expect(keydown).toContain('event.key === "Delete" || event.key === "Backspace"');
    expect(keydown.indexOf('event.key === "Delete" || event.key === "Backspace"')).toBeLessThan(keydown.indexOf("deleteSelectedDraftEdge()"));
    expect(keydown.indexOf("deleteSelectedDraftEdge()")).toBeLessThan(keydown.indexOf("void togglePinnedNode(node.id)"));
    expect(keydown).toContain("if (pinActionBusy.value || loading.value) return");
    expect(keydown).toContain("isPinned(node.id)");
  });

  it("⌘A 全选当前 nodes，空图不 mutate，不抢 Shift+⌘A", () => {
    const view = source("src/renderer/src/components/ManagedStudioCanvasView.vue");
    const keydown = view.slice(view.indexOf("function onCanvasKeydown"));
    expect(keydown).toContain('!event.shiftKey && event.key.toLowerCase() === "a"');
    expect(keydown.indexOf('event.key.toLowerCase() === "a"')).toBeLessThan(keydown.indexOf("selectAllCanvasNodes()"));
    expect(view).toContain("function selectAllCanvasNodes");
    expect(view).toContain("if (!nodes.value.length) return;");
  });

  it("Space 按下 pan-on-drag 含 0，松开回到中键/右键；输入框不切换", () => {
    const view = source("src/renderer/src/components/ManagedStudioCanvasView.vue");
    expect(view).toContain(':pan-on-drag="panOnDragButtons"');
    expect(view).toContain("const panOnDragButtons = computed(() => (spacePanHeld.value ? [0, 1, 2] : [1, 2]));");
    expect(view).toContain("if (isSpaceKey(event))");
    expect(view).toContain("spacePanHeld.value = true");
    expect(view).toContain("function onCanvasKeyup");
    expect(view).toContain('window.addEventListener("keyup", onCanvasKeyup)');
    expect(view).not.toContain(':pan-on-drag="[1, 2]"');
    expect(view).toContain("if (!editable)");
  });

  it("Escape 关弹层后再清节点选区，拖拽中不清选", () => {
    const view = source("src/renderer/src/components/ManagedStudioCanvasView.vue");
    const keydown = view.slice(view.indexOf("if (event.key !== \"Escape\") return"));
    expect(keydown).toContain("if (!isDragging.value) clearCanvasSelection()");
    expect(view).toContain("function clearCanvasSelection");
    expect(view).toContain("selected: false");
    expect(view).toContain("if (!nodes.value.some((node) => node.selected)) return;");
  });

  it("Shift+⌘A 翻转 selected，空图不 mutate", () => {
    const view = source("src/renderer/src/components/ManagedStudioCanvasView.vue");
    const keydown = view.slice(view.indexOf("function onCanvasKeydown"));
    expect(keydown).toContain("event.shiftKey && event.key.toLowerCase() === \"a\"");
    expect(keydown.indexOf("event.shiftKey && event.key.toLowerCase() === \"a\"")).toBeLessThan(keydown.indexOf("invertCanvasSelection()"));
    expect(view).toContain("function invertCanvasSelection");
    expect(view).toContain("selected: !node.selected");
  });

  it("Alt+Arrow 走 applyAlign，无 altKey 仍走微移", () => {
    const view = source("src/renderer/src/components/ManagedStudioCanvasView.vue");
    const keydown = view.slice(view.indexOf("function onCanvasKeydown"));
    expect(keydown).toContain("event.altKey");
    expect(keydown.indexOf('applyAlign("left")')).toBeGreaterThan(keydown.indexOf("event.altKey"));
    expect(keydown.indexOf('applyAlign("left")')).toBeLessThan(keydown.indexOf("nudgeSelectedCanvasNodes(-step, 0)"));
    expect(keydown).toContain("&& !event.altKey");
    expect(view).toContain("if (selected.length < 2) return;");
  });

  it("Alt+H/V 居中，Alt+Shift+H/V 均分", () => {
    const view = source("src/renderer/src/components/ManagedStudioCanvasView.vue");
    const keydown = view.slice(view.indexOf("function onCanvasKeydown"));
    expect(keydown).toContain('event.key.toLowerCase() === "h" || event.key.toLowerCase() === "v"');
    expect(keydown.indexOf('event.key.toLowerCase() === "h" || event.key.toLowerCase() === "v"')).toBeLessThan(
      keydown.indexOf('applyAlign(event.key.toLowerCase() === "h" ? "centerX" : "centerY")'),
    );
    expect(keydown).toContain('applyDistribute(event.key.toLowerCase() === "h" ? "x" : "y")');
    expect(view).toContain("if (selected.length < 3) return;");
  });

  it("Shift+E/M/W 切连线/小地图/工作流，不抢 meta/ctrl 导演和弦", () => {
    const view = source("src/renderer/src/components/ManagedStudioCanvasView.vue");
    const keydown = view.slice(view.indexOf("function onCanvasKeydown"));
    expect(keydown).toContain('event.shiftKey');
    expect(keydown).toContain('event.key.toLowerCase() === "e"');
    expect(keydown.indexOf('event.key.toLowerCase() === "e"')).toBeLessThan(keydown.indexOf("toggleEdges()"));
    expect(keydown.indexOf('event.key.toLowerCase() === "m"')).toBeLessThan(keydown.indexOf("toggleMiniMap()"));
    expect(keydown.indexOf('event.key.toLowerCase() === "w"')).toBeLessThan(keydown.indexOf("toggleWorkspaceMode()"));
    expect(view).toContain("function toggleMiniMap");
    expect(view).toContain('data-testid="managed-canvas-toggle-minimap"');
    expect(view).toContain('data-testid="managed-canvas-toggle-workspace-mode"');
  });

  it("Shift+T 时间线重排、Shift+Alt+T 强制；F5 走 refreshAll 且 preventDefault", () => {
    const view = source("src/renderer/src/components/ManagedStudioCanvasView.vue");
    const keydown = view.slice(view.indexOf("function onCanvasKeydown"));
    expect(keydown).toContain('event.key.toLowerCase() === "t"');
    expect(keydown.indexOf("void applyTimelineLayout(false)")).toBeGreaterThan(keydown.indexOf('!event.altKey'));
    expect(keydown).toContain("void applyTimelineLayout(true)");
    expect(keydown).toContain('event.key === "F5"');
    expect(keydown.indexOf('event.key === "F5"')).toBeLessThan(keydown.indexOf("void refreshAll()"));
    expect(view).toContain('data-testid="managed-canvas-refresh"');
  });

  it("无修饰 C/A/L 开合连线、添加、素材库；F1 帮助；Shift+L 剧本资源", () => {
    const view = source("src/renderer/src/components/ManagedStudioCanvasView.vue");
    const keydown = view.slice(view.indexOf("function onCanvasKeydown"));
    expect(keydown).toContain('event.key.toLowerCase() === "c"');
    expect(keydown.indexOf('event.key.toLowerCase() === "c"')).toBeLessThan(keydown.indexOf("toggleConnectMode()"));
    expect(keydown).toContain('event.key === "F1"');
    expect(keydown.indexOf('event.key === "F1"')).toBeLessThan(keydown.indexOf("toggleHelp()"));
    expect(keydown).toContain('event.key.toLowerCase() === "a"');
    expect(keydown.indexOf("toggleAddMenu()")).toBeGreaterThan(keydown.indexOf('event.key.toLowerCase() === "a"'));
    expect(keydown.indexOf("void toggleGlobalResourceLibrary()")).toBeLessThan(keydown.lastIndexOf("void toggleLibrary()"));
    expect(view).toContain("function toggleHelp");
    expect(view).toContain("function toggleAddMenu");
    expect(view).toContain('data-testid="managed-canvas-help"');
  });

  it("F6 核对来源、Shift+D 循环主题、⌘F 聚焦进度搜索、Enter 定位唯一命中", () => {
    const view = source("src/renderer/src/components/ManagedStudioCanvasView.vue");
    const keydown = view.slice(view.indexOf("function onCanvasKeydown"));
    expect(keydown).toContain('event.key === "F6"');
    expect(keydown.indexOf('event.key === "F6"')).toBeLessThan(keydown.indexOf("void verifyLocalProductionSource()"));
    expect(keydown).toContain('event.key.toLowerCase() === "d"');
    expect(keydown.indexOf('event.key.toLowerCase() === "d"')).toBeLessThan(keydown.indexOf("cycleCanvasTheme()"));
    expect(view).toContain("function cycleCanvasTheme");
    expect(view).toContain("setCanvasTheme(nextId)");
    expect(keydown).toContain('event.key.toLowerCase() === "f"');
    expect(keydown.indexOf('event.key.toLowerCase() === "f"')).toBeLessThan(keydown.indexOf("focusTimelineProgressQuery()"));
    expect(view).toContain('ref="timelineProgressQueryEl"');
    expect(view).toContain('@keydown.enter.prevent="onTimelineSearchEnter"');
    expect(view).toContain("void focusTimelineSearchResult()");
    expect(view).toContain('event.key === "F5"');
  });

  it("F3/Shift+F3 循环命中，Enter 仍只定位唯一命中；查询框 Escape 先清查询再失焦", () => {
    const view = source("src/renderer/src/components/ManagedStudioCanvasView.vue");
    const keydown = view.slice(view.indexOf("function onCanvasKeydown"));
    expect(view).toContain("if (unitIds.length !== 1) return;");
    expect(view).toContain("function cycleTimelineSearchHit");
    expect(keydown).toContain('event.key === "F3"');
    expect(keydown.indexOf('event.key === "F3"')).toBeLessThan(keydown.indexOf("cycleTimelineSearchHit(event.shiftKey ? -1 : 1)"));
    expect(keydown).toContain("timelineProgressQuery.value = \"\"");
    expect(keydown.indexOf("timelineProgressQuery.value = \"\"")).toBeLessThan(keydown.indexOf("timelineProgressQueryEl.value?.blur()"));
    expect(keydown.indexOf("timelineProgressQueryEl.value?.blur()")).toBeLessThan(keydown.indexOf("closeViewMenu({ restore: false })"));
    expect(keydown).toContain("rebuildGraph()");
  });

  it("查询框 Alt+Arrow 循环审片筛选；筛选 Escape 回查询框；[/] 循环宫格芯片", () => {
    const view = source("src/renderer/src/components/ManagedStudioCanvasView.vue");
    const keydown = view.slice(view.indexOf("function onCanvasKeydown"));
    expect(keydown).toContain('event.key === "ArrowDown" || event.key === "ArrowUp"');
    expect(keydown.indexOf("inTimelineQuery")).toBeLessThan(keydown.indexOf("cycleTimelineProgressReview"));
    expect(keydown.indexOf("cycleTimelineProgressReview")).toBeLessThan(keydown.indexOf('applyAlign("left")'));
    expect(view).toContain("TIMELINE_PROGRESS_REVIEW_OPTIONS");
    expect(keydown).toContain("[data-testid='managed-canvas-timeline-progress-review']");
    expect(keydown.indexOf("timelineProgressQueryEl.value?.focus()")).toBeGreaterThan(keydown.indexOf("[data-testid='managed-canvas-timeline-progress-review']"));
    expect(keydown).toContain('event.key === "[" || event.key === "]"');
    expect(keydown.indexOf('event.key === "[" || event.key === "]"')).toBeLessThan(keydown.indexOf("cyclePanelTimelineChip"));
    expect(view).toContain("void focusPanelOnCanvas");
  });

  it("Home/End 定位宫格首末芯片；条内 Arrow/Home/End/Page 只移焦", () => {
    const view = source("src/renderer/src/components/ManagedStudioCanvasView.vue");
    const keydown = view.slice(view.indexOf("function onCanvasKeydown"));
    const chipNavStart = view.indexOf("function movePanelTimelineChipFocus");
    const chipNavEnd = view.indexOf("function focusPanelTimelineChipEnd");
    const chipNav = view.slice(chipNavStart, chipNavEnd);
    const n42Home = keydown.lastIndexOf('event.key === "Home" || event.key === "End"');
    expect(view).toContain('role="toolbar"');
    expect(view).toContain(':tabindex="panelTimelineActiveChipIndex === index ? 0 : -1"');
    expect(keydown).toContain("[data-testid='managed-canvas-panel-timeline'] button");
    expect(keydown.indexOf("movePanelTimelineChipFocus")).toBeLessThan(keydown.indexOf("nudgeSelectedCanvasNodes"));
    expect(keydown.indexOf("movePanelTimelineChipFocus")).toBeLessThan(keydown.indexOf("focusPanelTimelineChipEnd"));
    expect(chipNav).toContain('key === "ArrowRight"');
    expect(chipNav).toContain('key === "ArrowLeft"');
    expect(chipNav).toContain('key === "Home"');
    expect(chipNav).toContain('key === "End"');
    expect(chipNav).toContain("Math.max(0, current - 10)");
    expect(chipNav).toContain("Math.min(strip.length - 1, current + 10)");
    expect(chipNav).not.toContain("focusPanelOnCanvas");
    expect(keydown).toContain('event.key === "PageUp" || event.key === "PageDown"');
    expect(keydown.indexOf('event.key === "PageUp" || event.key === "PageDown"')).toBeLessThan(keydown.indexOf("focusPanelTimelineChipEnd"));
    expect(n42Home).toBeGreaterThan(keydown.indexOf("cyclePanelTimelineChip"));
    expect(n42Home).toBeLessThan(keydown.indexOf("focusPanelTimelineChipEnd"));
    expect(keydown.slice(n42Home - 280, n42Home)).toContain("!editable");
    expect(keydown.slice(n42Home - 280, n42Home)).toContain("!event.shiftKey");
    expect(view).toContain("void focusPanelOnCanvas(strip[index]!.panelId)");
    const n45Page = keydown.lastIndexOf('event.key === "PageUp" || event.key === "PageDown"');
    const jumper = view.slice(view.indexOf("function jumpPanelTimelineChipPage"), view.indexOf("function jumpUnitListPage"));
    const unitJump = view.slice(view.indexOf("function jumpUnitListPage"), view.indexOf("async function pageUnitsByKeyboard"));
    const pager = view.slice(view.indexOf("async function pageUnitsByKeyboard"), view.indexOf("const timelineProgressFilterResult"));
    expect(n45Page).toBeGreaterThan(keydown.indexOf("focusPanelTimelineChipEnd"));
    expect(keydown.slice(n45Page - 360, n45Page)).toContain("!editable");
    expect(keydown.slice(n45Page - 360, n45Page)).toContain("!panelTimelineChip");
    expect(keydown.slice(n45Page - 360, n45Page)).toContain("!unitListItem");
    expect(n45Page).toBeLessThan(keydown.indexOf("jumpPanelTimelineChipPage"));
    expect(jumper).toContain("Math.min(strip.length - 1, start + 10)");
    expect(jumper).toContain("Math.max(0, start - 10)");
    expect(jumper).toContain("void focusPanelOnCanvas(strip[next]!.panelId)");
    expect(keydown).toContain(".unit-list .library-item");
    expect(keydown.indexOf("pageUnitsByKeyboard")).toBeLessThan(keydown.indexOf("jumpUnitListPage"));
    expect(keydown.indexOf("jumpUnitListPage")).toBeLessThan(keydown.indexOf("jumpPanelTimelineChipPage"));
    expect(unitJump).toContain("void selectUnit(unit)");
    expect(unitJump).toContain("Math.min(items.length - 1, current + 10)");
    expect(unitJump).not.toContain("unitsNext");
    expect(pager).toContain("await unitsNext()");
    expect(pager).toContain("await unitsPrevious()");
    expect(pager).toContain("if (loading.value) return");
    const n47 = keydown.lastIndexOf("unitListOrPager");
    expect(keydown.slice(n47, n47 + 280)).toContain("event.altKey");
    expect(keydown.slice(n47, n47 + 420)).toContain("pageUnitsByKeyboard");
  });

  it("单元轨/素材窗/文稿列表 Arrow/Home/End 只移焦，不进 N15/N42", () => {
    const view = source("src/renderer/src/components/ManagedStudioCanvasView.vue");
    const keydown = view.slice(view.indexOf("function onCanvasKeydown"));
    const unitNav = view.slice(view.indexOf("function moveUnitListFocus"), view.indexOf("function moveAssetListFocus"));
    const assetNav = view.slice(view.indexOf("function moveAssetListFocus"), view.indexOf("function moveTextListFocus"));
    const textNav = view.slice(view.indexOf("function moveTextListFocus"), view.indexOf("function moveMediaListFocus"));
    expect(view).toContain(':tabindex="unitListActiveIndex === index ? 0 : -1"');
    expect(view).toContain(':tabindex="assetListActiveIndex === index ? 0 : -1"');
    expect(view).toContain(':tabindex="textListActiveIndex === index ? 0 : -1"');
    expect(keydown).toContain(".unit-list .library-item");
    expect(keydown).toContain("[data-testid='managed-canvas-assets-virtual-viewport'] .library-item");
    expect(keydown).toContain(".text-list .library-item");
    expect(keydown).toContain('event.key === "ArrowUp" || event.key === "ArrowDown" || event.key === "Home" || event.key === "End"');
    expect(keydown.indexOf("moveUnitListFocus")).toBeLessThan(keydown.indexOf("nudgeSelectedCanvasNodes"));
    expect(keydown.indexOf("moveAssetListFocus")).toBeLessThan(keydown.indexOf("nudgeSelectedCanvasNodes"));
    expect(keydown.indexOf("moveTextListFocus")).toBeLessThan(keydown.indexOf("nudgeSelectedCanvasNodes"));
    expect(keydown.indexOf("moveUnitListFocus")).toBeLessThan(keydown.indexOf("focusPanelTimelineChipEnd"));
    expect(keydown.indexOf("movePanelTimelineChipFocus")).toBeLessThan(keydown.indexOf("moveUnitListFocus"));
    expect(unitNav).not.toContain("selectUnit");
    expect(assetNav).not.toContain("selectAsset");
    expect(textNav).not.toContain("selection.value");
    expect(view).toContain('key === "ArrowDown"');
    expect(view).toContain('key === "ArrowUp"');
    expect(view).toContain("[data-testid='managed-canvas-assets-virtual-viewport'] .library-item");
  });

  it("媒体库行 Arrow/Home/End 只移焦；媒体/素材 Alt+Page 翻页", () => {
    const view = source("src/renderer/src/components/ManagedStudioCanvasView.vue");
    const keydown = view.slice(view.indexOf("function onCanvasKeydown"));
    const mediaNav = view.slice(view.indexOf("function moveMediaListFocus"), view.indexOf("function moveAppearanceListFocus"));
    const mediaPager = view.slice(view.indexOf("async function pageMediaByKeyboard"), view.indexOf("async function pageAssetsByKeyboard"));
    const assetPager = view.slice(view.indexOf("async function pageAssetsByKeyboard"), view.indexOf("async function pageGlobalResourcesByKeyboard"));
    expect(view).toContain(':tabindex="mediaListActiveIndex === index ? 0 : -1"');
    expect(view).toContain('class="library-item media-library-item"');
    expect(keydown).toContain(".media-library-item");
    expect(keydown.indexOf("moveMediaListFocus")).toBeLessThan(keydown.indexOf("nudgeSelectedCanvasNodes"));
    expect(keydown.indexOf("moveTextListFocus")).toBeLessThan(keydown.indexOf("moveMediaListFocus"));
    expect(mediaNav).not.toContain("togglePinnedNode");
    expect(mediaNav).not.toContain("onLibraryDragStart");
    expect(keydown).toContain("mediaListOrPager");
    expect(keydown).toContain("assetListOrPager");
    const n52 = keydown.lastIndexOf("mediaListOrPager");
    expect(keydown.slice(n52, n52 + 280)).toContain("event.altKey");
    expect(keydown.slice(n52, n52 + 420)).toContain("pageMediaByKeyboard");
    const n53 = keydown.lastIndexOf("assetListOrPager");
    expect(keydown.slice(n53, n53 + 280)).toContain("event.altKey");
    expect(keydown.slice(n53, n53 + 420)).toContain("pageAssetsByKeyboard");
    expect(keydown.indexOf("pageUnitsByKeyboard")).toBeLessThan(keydown.indexOf("pageMediaByKeyboard"));
    expect(keydown.indexOf("pageMediaByKeyboard")).toBeLessThan(keydown.indexOf("pageAssetsByKeyboard"));
    expect(mediaPager).toContain("await mediaNext()");
    expect(mediaPager).toContain("await mediaPrevious()");
    expect(mediaPager).toContain("if (loading.value) return");
    expect(assetPager).toContain("await assetsNext()");
    expect(assetPager).toContain("await assetsPrevious()");
    expect(assetPager).not.toContain("unitsNext");
  });

  it("全局资源 Alt+Page 翻页，不抢 N47/N52/N53", () => {
    const view = source("src/renderer/src/components/ManagedStudioCanvasView.vue");
    const keydown = view.slice(view.indexOf("function onCanvasKeydown"));
    const globalPager = view.slice(
      view.indexOf("async function pageGlobalResourcesByKeyboard"),
      view.indexOf("async function pageAppearancesByKeyboard"),
    );
    expect(keydown).toContain("globalResourceListOrPager");
    expect(keydown).toContain(".global-resource-card");
    expect(keydown).toContain("[data-testid='managed-canvas-global-resources-prev']");
    expect(keydown).toContain("[data-testid='managed-canvas-global-resources-next']");
    const n54 = keydown.lastIndexOf("globalResourceListOrPager");
    expect(keydown.slice(n54, n54 + 280)).toContain("event.altKey");
    expect(keydown.slice(n54, n54 + 280)).toContain('event.key === "PageUp" || event.key === "PageDown"');
    expect(keydown.slice(n54, n54 + 420)).toContain("pageGlobalResourcesByKeyboard");
    expect(keydown.slice(n54, n54 + 280)).not.toContain("event.shiftKey &&");
    expect(keydown.indexOf("pageAssetsByKeyboard")).toBeLessThan(keydown.indexOf("pageGlobalResourcesByKeyboard"));
    expect(keydown.indexOf("pageGlobalResourcesByKeyboard")).toBeLessThan(keydown.indexOf("jumpUnitListPage"));
    expect(globalPager).toContain("await globalResourcesNext()");
    expect(globalPager).toContain("await globalResourcesPrevious()");
    expect(globalPager).toContain("if (globalResourceLoading.value) return");
    expect(globalPager).toContain(".global-resource-card");
    expect(globalPager).not.toContain("unitsNext");
    expect(globalPager).not.toContain("mediaNext");
    expect(globalPager).not.toContain("assetsNext");
    expect(globalPager).not.toContain("toggleGlobalResourceLibrary");
    const n47 = keydown.lastIndexOf("unitListOrPager");
    expect(keydown.slice(n47, n47 + 420)).toContain("pageUnitsByKeyboard");
    expect(keydown.slice(n47, n47 + 420)).not.toContain("pageGlobalResourcesByKeyboard");
  });

  it("检查器出场 Alt+Page 翻页，不抢 N47/N52/N53/N54", () => {
    const view = source("src/renderer/src/components/ManagedStudioCanvasView.vue");
    const keydown = view.slice(view.indexOf("function onCanvasKeydown"));
    const appearancePager = view.slice(
      view.indexOf("async function pageAppearancesByKeyboard"),
      view.indexOf("const timelineProgressFilterResult"),
    );
    expect(keydown).toContain("appearanceListOrPager");
    expect(keydown).toContain(".appearance-list button");
    expect(keydown).toContain("[data-testid='managed-canvas-appearances-prev']");
    expect(keydown).toContain("[data-testid='managed-canvas-appearances-next']");
    const n55 = keydown.lastIndexOf("appearanceListOrPager");
    expect(keydown.slice(n55, n55 + 280)).toContain("event.altKey");
    expect(keydown.slice(n55, n55 + 280)).toContain('event.key === "PageUp" || event.key === "PageDown"');
    expect(keydown.slice(n55, n55 + 420)).toContain("pageAppearancesByKeyboard");
    expect(keydown.indexOf("pageGlobalResourcesByKeyboard")).toBeLessThan(keydown.indexOf("pageAppearancesByKeyboard"));
    expect(keydown.indexOf("pageAppearancesByKeyboard")).toBeLessThan(keydown.indexOf("jumpUnitListPage"));
    expect(appearancePager).toContain("await appearancesNext()");
    expect(appearancePager).toContain("await appearancesPrevious()");
    expect(appearancePager).toContain("if (loading.value) return");
    expect(appearancePager).toContain('selection.value?.kind !== "asset"');
    expect(appearancePager).not.toContain("focusAppearance");
    expect(appearancePager).not.toContain("globalResourcesNext");
    expect(appearancePager).not.toContain("unitsNext");
    expect(appearancePager).not.toContain("mediaNext");
    expect(appearancePager).not.toContain("assetsNext");
    const n54 = keydown.lastIndexOf("globalResourceListOrPager");
    expect(keydown.slice(n54, n54 + 420)).toContain("pageGlobalResourcesByKeyboard");
    expect(keydown.slice(n54, n54 + 420)).not.toContain("pageAppearancesByKeyboard");
  });

  it("检查器出场行 Arrow/Home/End 只移焦，不进 N15/N55", () => {
    const view = source("src/renderer/src/components/ManagedStudioCanvasView.vue");
    const inspector = source("src/renderer/src/components/CanvasInspectorPanel.vue");
    const keydown = view.slice(view.indexOf("function onCanvasKeydown"));
    const appearanceNav = view.slice(
      view.indexOf("function moveAppearanceListFocus"),
      view.indexOf("function moveGlobalResourceListFocus"),
    );
    expect(inspector).toContain(':tabindex="appearanceListActiveIndex === index ? 0 : -1"');
    expect(inspector).toContain(".appearance-list button");
    expect(keydown).toContain("appearanceListItem");
    expect(keydown).toContain(".appearance-list button");
    expect(keydown.indexOf("moveAppearanceListFocus")).toBeLessThan(keydown.indexOf("nudgeSelectedCanvasNodes"));
    expect(keydown.indexOf("moveMediaListFocus")).toBeLessThan(keydown.indexOf("moveAppearanceListFocus"));
    expect(keydown.indexOf("movePanelTimelineChipFocus")).toBeLessThan(keydown.indexOf("moveAppearanceListFocus"));
    const n56 = keydown.lastIndexOf("appearanceListItem");
    expect(keydown.slice(n56, n56 + 360)).toContain("!event.altKey");
    expect(keydown.slice(n56, n56 + 360)).toContain('event.key === "ArrowUp" || event.key === "ArrowDown" || event.key === "Home" || event.key === "End"');
    expect(keydown.slice(n56, n56 + 420)).toContain("moveAppearanceListFocus");
    expect(appearanceNav).not.toContain("focusAppearance");
    expect(appearanceNav).not.toContain("appearancesNext");
    expect(appearanceNav).not.toContain("appearancesPrevious");
    expect(appearanceNav).not.toContain("nudgeSelectedCanvasNodes");
    const n55 = keydown.lastIndexOf("appearanceListOrPager");
    expect(keydown.slice(n55, n55 + 420)).toContain("pageAppearancesByKeyboard");
    expect(keydown.slice(n55, n55 + 420)).not.toContain("moveAppearanceListFocus");
  });

  it("全局资源卡 Arrow/Home/End 只移焦，不进 N15/N54", () => {
    const view = source("src/renderer/src/components/ManagedStudioCanvasView.vue");
    const keydown = view.slice(view.indexOf("function onCanvasKeydown"));
    const globalNav = view.slice(
      view.indexOf("function moveGlobalResourceListFocus"),
      view.indexOf("function moveNodeActionFocus"),
    );
    expect(view).toContain(':tabindex="globalResourceListActiveIndex === index ? 0 : -1"');
    expect(view).toContain('class="global-resource-card"');
    expect(keydown).toContain("globalResourceListItem");
    expect(keydown.indexOf("moveGlobalResourceListFocus")).toBeLessThan(keydown.indexOf("nudgeSelectedCanvasNodes"));
    expect(keydown.indexOf("moveAppearanceListFocus")).toBeLessThan(keydown.indexOf("moveGlobalResourceListFocus"));
    const n57 = keydown.lastIndexOf("globalResourceListItem");
    expect(keydown.slice(n57, n57 + 360)).toContain("!event.altKey");
    expect(keydown.slice(n57, n57 + 360)).toContain('event.key === "ArrowUp" || event.key === "ArrowDown" || event.key === "Home" || event.key === "End"');
    expect(keydown.slice(n57, n57 + 420)).toContain("moveGlobalResourceListFocus");
    expect(globalNav).not.toContain("openResourceCenter");
    expect(globalNav).not.toContain("globalResourcesNext");
    expect(globalNav).not.toContain("globalResourcesPrevious");
    expect(globalNav).not.toContain("togglePinnedNode");
    const n54 = keydown.lastIndexOf("globalResourceListOrPager");
    expect(keydown.slice(n54, n54 + 420)).toContain("pageGlobalResourcesByKeyboard");
    expect(keydown.slice(n54, n54 + 420)).not.toContain("moveGlobalResourceListFocus");
  });

  it("节点操作钮 Arrow/Home/End 只移焦可用项，不进 N15/N56/N57", () => {
    const view = source("src/renderer/src/components/ManagedStudioCanvasView.vue");
    const inspector = source("src/renderer/src/components/CanvasInspectorPanel.vue");
    const keydown = view.slice(view.indexOf("function onCanvasKeydown"));
    const actionNav = view.slice(
      view.indexOf("function moveNodeActionFocus"),
      view.indexOf("async function pageMediaByKeyboard"),
    );
    expect(inspector).toContain(':tabindex="action.enabled && nodeActionActiveIndex === index ? 0 : -1"');
    expect(inspector).toContain(".node-action-buttons");
    expect(keydown).toContain("nodeActionItem");
    expect(keydown).toContain(".node-action-buttons button");
    expect(keydown.indexOf("moveNodeActionFocus")).toBeLessThan(keydown.indexOf("nudgeSelectedCanvasNodes"));
    expect(keydown.indexOf("moveGlobalResourceListFocus")).toBeLessThan(keydown.indexOf("moveNodeActionFocus"));
    const n58 = keydown.lastIndexOf("nodeActionItem");
    expect(keydown.slice(n58, n58 + 360)).toContain("!event.altKey");
    expect(keydown.slice(n58, n58 + 360)).toContain('event.key === "ArrowUp" || event.key === "ArrowDown" || event.key === "Home" || event.key === "End"');
    expect(keydown.slice(n58, n58 + 420)).toContain("moveNodeActionFocus");
    expect(actionNav).toContain("!el.disabled");
    expect(actionNav).not.toContain("runNodeAction");
    expect(actionNav).not.toContain("nudgeSelectedCanvasNodes");
    expect(actionNav).not.toContain("focusAppearance");
  });

  it("素材库 tabs Arrow/Home/End 只移焦，不进 N15/N58", () => {
    const view = source("src/renderer/src/components/ManagedStudioCanvasView.vue");
    const keydown = view.slice(view.indexOf("function onCanvasKeydown"));
    const tabNav = view.slice(
      view.indexOf("function moveLibraryTabFocus"),
      view.indexOf("function moveGlobalResourceTabFocus"),
    );
    expect(view).toContain(':tabindex="libraryTabActiveIndex === index ? 0 : -1"');
    expect(view).toContain("#managed-canvas-library .library-tabs button");
    expect(keydown).toContain("libraryTabItem");
    expect(keydown).toContain("#managed-canvas-library .library-tabs button");
    expect(keydown.indexOf("moveLibraryTabFocus")).toBeLessThan(keydown.indexOf("nudgeSelectedCanvasNodes"));
    expect(keydown.indexOf("moveNodeActionFocus")).toBeLessThan(keydown.indexOf("moveLibraryTabFocus"));
    const n59 = keydown.lastIndexOf("libraryTabItem");
    expect(keydown.slice(n59, n59 + 360)).toContain("!event.altKey");
    expect(keydown.slice(n59, n59 + 360)).toContain('event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "Home" || event.key === "End"');
    expect(keydown.slice(n59, n59 + 420)).toContain("moveLibraryTabFocus");
    expect(tabNav).not.toContain("openLibraryFor");
    expect(tabNav).not.toContain("openGlobalResourcesFor");
    expect(tabNav).not.toContain("nudgeSelectedCanvasNodes");
    const n58Block = keydown.slice(keydown.lastIndexOf("nodeActionItem"), keydown.lastIndexOf("libraryTabItem"));
    expect(n58Block).toContain("moveNodeActionFocus");
    expect(n58Block).not.toContain("moveLibraryTabFocus");
  });

  it("全局资源 tabs Arrow/Home/End 只移焦可用项，不进 N15/N59", () => {
    const view = source("src/renderer/src/components/ManagedStudioCanvasView.vue");
    const keydown = view.slice(view.indexOf("function onCanvasKeydown"));
    const tabNav = view.slice(
      view.indexOf("function moveGlobalResourceTabFocus"),
      view.indexOf("function moveAddMenuFocus"),
    );
    expect(view).toContain(':tabindex="!globalResourceLoading && globalResourceTabActiveIndex === index ? 0 : -1"');
    expect(view).toContain(".global-resource-tabs button");
    expect(keydown).toContain("globalResourceTabItem");
    expect(keydown.indexOf("moveGlobalResourceTabFocus")).toBeLessThan(keydown.indexOf("nudgeSelectedCanvasNodes"));
    expect(keydown.indexOf("moveLibraryTabFocus")).toBeLessThan(keydown.indexOf("moveGlobalResourceTabFocus"));
    const n60 = keydown.lastIndexOf("globalResourceTabItem");
    expect(keydown.slice(n60, n60 + 360)).toContain("!event.altKey");
    expect(keydown.slice(n60, n60 + 360)).toContain('event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "Home" || event.key === "End"');
    expect(keydown.slice(n60, n60 + 420)).toContain("moveGlobalResourceTabFocus");
    expect(tabNav).toContain("!el.disabled");
    expect(tabNav).not.toContain("openGlobalResourcesFor");
    expect(tabNav).not.toContain("openLibraryFor");
    expect(tabNav).not.toContain("nudgeSelectedCanvasNodes");
    const n59Block = keydown.slice(keydown.lastIndexOf("libraryTabItem"), keydown.lastIndexOf("globalResourceTabItem"));
    expect(n59Block).toContain("moveLibraryTabFocus");
    expect(n59Block).not.toContain("moveGlobalResourceTabFocus");
  });

  it("添加菜单 Arrow/Home/End 只移焦，不进 N15/N29", () => {
    const view = source("src/renderer/src/components/ManagedStudioCanvasView.vue");
    const keydown = view.slice(view.indexOf("function onCanvasKeydown"));
    const menuNav = view.slice(
      view.indexOf("function moveAddMenuFocus"),
      view.indexOf("function moveFloatingToolbarFocus"),
    );
    const toggleAdd = view.slice(
      view.indexOf("function toggleAddMenu"),
      view.indexOf("function toggleConnectMode"),
    );
    expect(view).toContain(':tabindex="addMenuActiveIndex === index ? 0 : -1"');
    expect(view).toContain("#managed-canvas-add-menu button");
    expect(keydown).toContain("addMenuItem");
    expect(keydown.indexOf("moveAddMenuFocus")).toBeLessThan(keydown.indexOf("nudgeSelectedCanvasNodes"));
    expect(keydown.indexOf("moveGlobalResourceTabFocus")).toBeLessThan(keydown.indexOf("moveAddMenuFocus"));
    const n61 = keydown.lastIndexOf("addMenuItem");
    expect(keydown.slice(n61, n61 + 420)).toContain("!event.altKey");
    expect(keydown.slice(n61, n61 + 420)).toContain('event.key === "ArrowUp" || event.key === "ArrowDown" || event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "Home" || event.key === "End"');
    expect(keydown.slice(n61, n61 + 480)).toContain("moveAddMenuFocus");
    expect(menuNav).not.toContain("chooseAddKind");
    expect(menuNav).not.toContain("nudgeSelectedCanvasNodes");
    expect(toggleAdd).toContain("nextTick");
    expect(toggleAdd).toContain("#managed-canvas-add-menu button");
    expect(keydown.indexOf("toggleAddMenu()")).toBeGreaterThan(keydown.indexOf('event.key.toLowerCase() === "a"'));
    const n60Block = keydown.slice(keydown.lastIndexOf("globalResourceTabItem"), keydown.lastIndexOf("addMenuItem"));
    expect(n60Block).toContain("moveGlobalResourceTabFocus");
    expect(n60Block).not.toContain("moveAddMenuFocus");
  });

  it("浮动工具栏 Arrow/Home/End 只移焦，不进 N15/N61", () => {
    const view = source("src/renderer/src/components/ManagedStudioCanvasView.vue");
    const keydown = view.slice(view.indexOf("function onCanvasKeydown"));
    const toolbarNav = view.slice(
      view.indexOf("function moveFloatingToolbarFocus"),
      view.indexOf("function moveBottomToolbarFocus"),
    );
    expect(view).toContain(':tabindex="floatingToolbarActiveIndex === 0 ? 0 : -1"');
    expect(view).toContain(':tabindex="floatingToolbarActiveIndex === 4 ? 0 : -1"');
    expect(keydown).toContain("floatingToolbarButton");
    expect(keydown).toContain(".floating-tools > .add-menu-wrap > button");
    expect(keydown).toContain(".floating-tools > button");
    expect(keydown.indexOf("moveFloatingToolbarFocus")).toBeLessThan(keydown.indexOf("nudgeSelectedCanvasNodes"));
    expect(keydown.indexOf("moveAddMenuFocus")).toBeLessThan(keydown.indexOf("moveFloatingToolbarFocus"));
    const n62 = keydown.lastIndexOf("floatingToolbarButton");
    expect(keydown.slice(n62, n62 + 360)).toContain("!event.altKey");
    expect(keydown.slice(n62, n62 + 360)).toContain('event.key === "ArrowUp" || event.key === "ArrowDown" || event.key === "Home" || event.key === "End"');
    expect(keydown.slice(n62, n62 + 420)).toContain("moveFloatingToolbarFocus");
    expect(toolbarNav).not.toContain("toggleAddMenu");
    expect(toolbarNav).not.toContain("toggleLibrary");
    expect(toolbarNav).not.toContain("toggleGlobalResourceLibrary");
    expect(toolbarNav).not.toContain("toggleConnectMode");
    expect(toolbarNav).not.toContain("toggleHelp");
    expect(toolbarNav).not.toContain("nudgeSelectedCanvasNodes");
    const n61Block = keydown.slice(keydown.lastIndexOf("addMenuItem"), keydown.lastIndexOf("floatingToolbarButton"));
    expect(n61Block).toContain("moveAddMenuFocus");
    expect(n61Block).not.toContain("moveFloatingToolbarFocus");
  });

  it("底部视图工具 Arrow/Home/End 只移焦可用项，不进 N15/N62", () => {
    const view = source("src/renderer/src/components/ManagedStudioCanvasView.vue");
    const keydown = view.slice(view.indexOf("function onCanvasKeydown"));
    const bottomNav = view.slice(
      view.indexOf("function moveBottomToolbarFocus"),
      view.indexOf("function viewMenuItemEnabledSlots"),
    );
    expect(view).toContain("bottomToolbarTabIndex(");
    expect(view).toContain('data-testid="managed-canvas-undo" :disabled="!canUndoLayout || isDragging"');
    expect(keydown).toContain("bottomToolbarButton");
    expect(keydown).toContain(".bottom-tools > button");
    expect(keydown).toContain(".bottom-tools .align-tools button");
    expect(keydown.indexOf("moveBottomToolbarFocus")).toBeLessThan(keydown.indexOf("nudgeSelectedCanvasNodes"));
    expect(keydown.indexOf("moveFloatingToolbarFocus")).toBeLessThan(keydown.indexOf("moveBottomToolbarFocus"));
    const n63 = keydown.lastIndexOf("bottomToolbarButton");
    expect(keydown.slice(n63, n63 + 360)).toContain("!event.altKey");
    expect(keydown.slice(n63, n63 + 360)).toContain('event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "Home" || event.key === "End"');
    expect(keydown.slice(n63, n63 + 420)).toContain("moveBottomToolbarFocus");
    expect(bottomNav).toContain("!el.disabled");
    expect(bottomNav).not.toContain("fitCanvas");
    expect(bottomNav).not.toContain("applyAlign");
    expect(bottomNav).not.toContain("applyDistribute");
    expect(bottomNav).not.toContain("undoLayout");
    expect(bottomNav).not.toContain("toggleEdges");
    expect(bottomNav).not.toContain("applyTimelineLayout");
    const n62Block = keydown.slice(keydown.lastIndexOf("floatingToolbarButton"), keydown.lastIndexOf("bottomToolbarButton"));
    expect(n62Block).toContain("moveFloatingToolbarFocus");
    expect(n62Block).not.toContain("moveBottomToolbarFocus");
  });

  it("视图菜单项 Arrow/Home/End 只移焦可用项，不进 N15/N63", () => {
    const view = source("src/renderer/src/components/ManagedStudioCanvasView.vue");
    const keydown = view.slice(view.indexOf("function onCanvasKeydown"));
    const menuNav = view.slice(
      view.indexOf("function moveViewMenuItemFocus"),
      view.indexOf("function moveViewMenuThemeFocus"),
    );
    const toggleNav = view.slice(
      view.indexOf("function onViewMenuToggle"),
      view.indexOf("async function pageMediaByKeyboard"),
    );
    expect(view).toContain("viewMenuItemTabIndex(");
    expect(view).toContain(".view-menu-pop > button");
    expect(keydown).toContain("viewMenuPopItem");
    expect(keydown.indexOf("moveViewMenuItemFocus")).toBeLessThan(keydown.indexOf("nudgeSelectedCanvasNodes"));
    expect(keydown.indexOf("moveBottomToolbarFocus")).toBeLessThan(keydown.indexOf("moveViewMenuItemFocus"));
    const n64 = keydown.lastIndexOf("viewMenuPopItem");
    expect(keydown.slice(n64, n64 + 360)).toContain("!event.altKey");
    expect(keydown.slice(n64, n64 + 360)).toContain('event.key === "ArrowUp" || event.key === "ArrowDown" || event.key === "Home" || event.key === "End"');
    expect(keydown.slice(n64, n64 + 420)).toContain("moveViewMenuItemFocus");
    expect(menuNav).toContain("!el.disabled");
    expect(menuNav).not.toContain("toggleMiniMap");
    expect(menuNav).not.toContain("toggleWorkspaceMode");
    expect(menuNav).not.toContain("refreshAll");
    expect(menuNav).not.toContain("verifyLocalProductionSource");
    expect(toggleNav).toContain("nextTick");
    expect(toggleNav).toContain(".view-menu-pop > button");
    const n63Block = keydown.slice(keydown.lastIndexOf("bottomToolbarButton"), keydown.lastIndexOf("viewMenuPopItem"));
    expect(n63Block).toContain("moveBottomToolbarFocus");
    expect(n63Block).not.toContain("moveViewMenuItemFocus");
  });

  it("视图主题 radio Arrow/Home/End 只移焦，不进 N15/N33/N64", () => {
    const view = source("src/renderer/src/components/ManagedStudioCanvasView.vue");
    const keydown = view.slice(view.indexOf("function onCanvasKeydown"));
    const themeNav = view.slice(
      view.indexOf("function moveViewMenuThemeFocus"),
      view.indexOf("function onViewMenuToggle"),
    );
    expect(view).toContain(':tabindex="viewMenuThemeActiveIndex === index ? 0 : -1"');
    expect(view).toContain("setCanvasTheme(theme.id)");
    expect(keydown).toContain("viewMenuThemeItem");
    expect(keydown).toContain(".view-menu-theme > button[role='radio']");
    expect(keydown.indexOf("moveViewMenuThemeFocus")).toBeLessThan(keydown.indexOf("nudgeSelectedCanvasNodes"));
    expect(keydown.indexOf("moveViewMenuItemFocus")).toBeLessThan(keydown.indexOf("moveViewMenuThemeFocus"));
    const n65 = keydown.lastIndexOf("viewMenuThemeItem");
    expect(keydown.slice(n65, n65 + 360)).toContain("!event.altKey");
    expect(keydown.slice(n65, n65 + 360)).toContain('event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "Home" || event.key === "End"');
    expect(keydown.slice(n65, n65 + 420)).toContain("moveViewMenuThemeFocus");
    expect(themeNav).not.toContain("setCanvasTheme");
    expect(themeNav).not.toContain("nudgeSelectedCanvasNodes");
    const n64Block = keydown.slice(keydown.lastIndexOf("viewMenuPopItem"), keydown.lastIndexOf("viewMenuThemeItem"));
    expect(n64Block).toContain("moveViewMenuItemFocus");
    expect(n64Block).not.toContain("moveViewMenuThemeFocus");
    expect(view).toContain("setCanvasTheme(nextId)");
  });

  it("受管画布 Vue Flow Controls Arrow/Home/End 只移焦，不进 N15/N9", () => {
    const view = source("src/renderer/src/components/ManagedStudioCanvasView.vue");
    const keydown = view.slice(view.indexOf("function onCanvasKeydown"));
    const controlsNav = view.slice(
      view.indexOf("function moveManagedFlowControlsFocus"),
      view.indexOf("function onManagedFlowControlsFocusIn"),
    );
    expect(view).toContain("#managed-studio-flow .vue-flow__controls-button");
    expect(view).toContain("#control-fit-view");
    expect(view).toContain("onFitViewControl");
    expect(view).not.toContain("@fit-view=");
    expect(keydown).toContain("managedFlowControlsButton");
    expect(keydown.indexOf("moveManagedFlowControlsFocus")).toBeLessThan(keydown.indexOf("nudgeSelectedCanvasNodes"));
    expect(keydown.indexOf("moveViewMenuThemeFocus")).toBeLessThan(keydown.indexOf("moveManagedFlowControlsFocus"));
    const n66 = keydown.lastIndexOf("managedFlowControlsButton");
    expect(keydown.slice(n66, n66 + 360)).toContain("!event.altKey");
    expect(keydown.slice(n66, n66 + 360)).toContain('event.key === "ArrowUp" || event.key === "ArrowDown" || event.key === "Home" || event.key === "End"');
    expect(keydown.slice(n66, n66 + 420)).toContain("moveManagedFlowControlsFocus");
    expect(controlsNav).not.toContain("fitCanvas");
    expect(controlsNav).not.toContain("onFitViewControl");
    expect(controlsNav).not.toContain("onControlViewportChanged");
    expect(controlsNav).not.toContain("nudgeSelectedCanvasNodes");
    const n15 = keydown.lastIndexOf("nudgeSelectedCanvasNodes");
    expect(keydown.slice(keydown.indexOf("managed-canvas-minimap"), n15)).toContain("#managed-studio-flow .vue-flow__controls-button");
    const n65Block = keydown.slice(keydown.lastIndexOf("viewMenuThemeItem"), keydown.lastIndexOf("managedFlowControlsButton"));
    expect(n65Block).toContain("moveViewMenuThemeFocus");
    expect(n65Block).not.toContain("moveManagedFlowControlsFocus");
  });

  it("受管 MiniMap Arrow 平移视口，不进 N15/N23", () => {
    const view = source("src/renderer/src/components/ManagedStudioCanvasView.vue");
    const keydown = view.slice(view.indexOf("function onCanvasKeydown"));
    const pan = view.slice(
      view.indexOf("function panCanvasFromMiniMap"),
      view.indexOf("function miniMapNodeRects"),
    );
    expect(view).toContain('data-testid="managed-canvas-minimap"');
    expect(view).toContain('tabindex="0"');
    expect(keydown).toContain("miniMapSurface");
    expect(keydown).toContain("[data-testid='managed-canvas-minimap']");
    expect(keydown.indexOf("panCanvasFromMiniMap")).toBeLessThan(keydown.indexOf("nudgeSelectedCanvasNodes"));
    expect(keydown.indexOf("moveManagedFlowControlsFocus")).toBeLessThan(keydown.indexOf("panCanvasFromMiniMap"));
    const n69 = keydown.lastIndexOf("miniMapSurface");
    expect(keydown.slice(n69, n69 + 360)).toContain("!event.altKey");
    expect(keydown.slice(n69, n69 + 360)).toContain('event.key === "ArrowUp" || event.key === "ArrowDown" || event.key === "ArrowLeft" || event.key === "ArrowRight"');
    expect(keydown.slice(n69, n69 + 420)).toContain("panCanvasFromMiniMap");
    expect(pan).toContain("studioFlow.getViewport()");
    expect(pan).toContain("studioFlow.setViewport");
    expect(pan).not.toContain("toggleMiniMap");
    expect(pan).not.toContain("zoomTo");
    expect(pan).not.toContain("showMiniMap");
    expect(pan).not.toContain("nudgeSelectedCanvasNodes");
    expect(keydown.indexOf('event.key.toLowerCase() === "m"')).toBeLessThan(keydown.indexOf("toggleMiniMap()"));
    const n66Block = keydown.slice(keydown.lastIndexOf("managedFlowControlsButton"), keydown.lastIndexOf("miniMapNode"));
    expect(n66Block).toContain("moveManagedFlowControlsFocus");
    expect(n66Block).not.toContain("panCanvasFromMiniMap");
  });

  it("帮助卡打开后焦关闭钮，Tab 不逃出，不抢 N28/N18", () => {
    const view = source("src/renderer/src/components/ManagedStudioCanvasView.vue");
    const keydown = view.slice(view.indexOf("function onCanvasKeydown"));
    const toggle = view.slice(
      view.indexOf("function toggleHelp"),
      view.indexOf("function toggleAddMenu"),
    );
    const close = view.slice(
      view.indexOf("function closeHelp"),
      view.indexOf("function toggleHelp"),
    );
    expect(view).toContain('#managed-canvas-help-card button[aria-label="关闭帮助"]');
    expect(view).toContain("@click=\"closeHelp\"");
    expect(toggle).toContain("nextTick");
    expect(toggle).toContain("helpCloseButton()?.focus()");
    expect(close).toContain("helpTriggerEl.value?.focus()");
    expect(keydown).toContain('event.key === "Tab"');
    expect(keydown).toContain("#managed-canvas-help-card");
    const helpTab = keydown.indexOf("#managed-canvas-help-card");
    expect(keydown.slice(helpTab - 160, helpTab + 220)).toContain("preventDefault");
    expect(keydown.slice(helpTab - 160, helpTab + 220)).toContain("helpCloseButton");
    expect(keydown.indexOf('event.key === "F1"')).toBeLessThan(keydown.indexOf("toggleHelp()"));
    expect(keydown).toContain("if (helpWasOpen) helpTriggerEl.value?.focus()");
  });

  it("MiniMap 节点 data-node-id roving + Enter 选中，不进 N69/N15/连线", () => {
    const view = source("src/renderer/src/components/ManagedStudioCanvasView.vue");
    const keydown = view.slice(view.indexOf("function onCanvasKeydown"));
    const slot = view.slice(view.indexOf("#node-managedStudio"), view.indexOf("</MiniMap>"));
    const move = view.slice(
      view.indexOf("function moveMiniMapNodeFocus"),
      view.indexOf("function selectCanvasNodeFromMiniMap"),
    );
    const select = view.slice(
      view.indexOf("function selectCanvasNodeFromMiniMap"),
      view.indexOf("function onControlViewportChanged"),
    );
    expect(slot).toContain(":data-node-id=");
    expect(slot).toContain("{ id, position, dimensions, color, selected, dragging }");
    expect(slot).not.toContain(' id="');
    expect(slot).not.toContain(":id=");
    expect(keydown).toContain("miniMapNode");
    expect(keydown).toContain(".vue-flow__minimap-node");
    expect(keydown.indexOf("moveMiniMapNodeFocus")).toBeLessThan(keydown.indexOf("panCanvasFromMiniMap"));
    expect(keydown.indexOf("selectCanvasNodeFromMiniMap")).toBeLessThan(keydown.indexOf("spacePanHeld"));
    const n71 = keydown.lastIndexOf("miniMapNode");
    expect(keydown.slice(n71, n71 + 420)).toContain("!event.altKey");
    expect(keydown.slice(n71, n71 + 420)).toContain("moveMiniMapNodeFocus");
    expect(move).not.toContain("panCanvasFromMiniMap");
    expect(move).not.toContain("nudgeSelectedCanvasNodes");
    expect(select).toContain("studioFlow.setCenter");
    expect(select).toContain("data-node-id");
    expect(select).not.toContain("onNodeClick");
    expect(select).not.toContain("onConnect");
    const n71Block = keydown.slice(keydown.lastIndexOf("miniMapNode"), keydown.lastIndexOf("miniMapSurface"));
    expect(n71Block).toContain("moveMiniMapNodeFocus");
    expect(n71Block).not.toContain("panCanvasFromMiniMap");
  });

  it("连线横幅退出钮可 Tab，关闭后焦回连线钮，不改 status", () => {
    const view = source("src/renderer/src/components/ManagedStudioCanvasView.vue");
    const toggleConnectMode = view.match(/function toggleConnectMode\(\): void \{([\s\S]*?)\n\}/u)?.[1] ?? "";
    expect(view).toContain('v-if="connectMode" class="connect-banner" role="status"');
    expect(view).toContain('data-testid="managed-canvas-connect-exit"');
    expect(view).toContain("function restoreConnectTriggerFocus");
    expect(view).toContain('[data-testid="managed-canvas-connect-mode"]');
    expect(toggleConnectMode).toContain("stripPendingOutline(previousPendingId)");
    expect(toggleConnectMode).toContain("restoreConnectTriggerFocus()");
    expect(toggleConnectMode).not.toContain("rebuildGraph()");
    expect(toggleConnectMode).not.toContain('workspaceMode.value = "workflow"');
    expect(view).toContain("else if (connectWasOpen) restoreConnectTriggerFocus()");
    const keydown = view.slice(view.indexOf("function onCanvasKeydown"));
    expect(keydown.indexOf('event.key.toLowerCase() === "c"')).toBeLessThan(keydown.indexOf("toggleConnectMode()"));
  });

  it("检查器关闭钮可 Tab，关闭后焦回画布，不改成 dialog", () => {
    const view = source("src/renderer/src/components/ManagedStudioCanvasView.vue");
    const inspector = source("src/renderer/src/components/CanvasInspectorPanel.vue");
    const close = view.slice(
      view.indexOf("function closeInspector"),
      view.indexOf("function restoreInspectorFlowFocus"),
    );
    const restore = view.slice(
      view.indexOf("function restoreInspectorFlowFocus"),
      view.indexOf("function toggleConnectMode"),
    );
    expect(inspector).toContain('class="inspector-close"');
    expect(inspector).toContain('data-testid="managed-canvas-inspector-close"');
    expect(inspector).toContain('<aside class="canvas-inspector" aria-label="画布节点详情">');
    expect(inspector).not.toContain('role="dialog"');
    expect(inspector).not.toContain("aria-modal");
    expect(view).toContain('@close="closeInspector"');
    expect(close).toContain("selection.value = null");
    expect(restore).toContain("#managed-studio-flow");
    expect(restore).toContain(".vue-flow__node[data-id=");
    expect(inspector).toContain(':tabindex="appearanceListActiveIndex === index ? 0 : -1"');
    expect(inspector).toContain(':tabindex="action.enabled && nodeActionActiveIndex === index ? 0 : -1"');
  });

  it("导演面板打开焦过滤框，Tab 不逃出，不覆盖 N18 帮助/添加归还", () => {
    const view = source("src/renderer/src/components/ManagedStudioCanvasView.vue");
    const panel = source("src/renderer/src/components/DirectorActionPanel.vue");
    const keydown = view.slice(view.indexOf("function onCanvasKeydown"));
    expect(panel).toContain('data-testid="director-action-panel"');
    expect(panel).toContain('role="dialog"');
    expect(panel).toContain('data-testid="director-panel-filter"');
    expect(panel).toContain('data-testid="director-panel-close"');
    expect(view).toContain("watch(directorPanelOpen");
    expect(view).toContain('[data-testid="director-panel-filter"]');
    expect(view).toContain("function toggleDirectorPanel");
    expect(view).toContain("function closeDirectorPanel");
    expect(view).toContain("restoreDirectorToggleFocus");
    expect(keydown).toContain("[data-testid='director-action-panel']");
    const directorTab = keydown.indexOf("[data-testid='director-action-panel']");
    expect(keydown.slice(directorTab - 160, directorTab + 280)).toContain('event.key === "Tab"');
    expect(keydown.slice(directorTab - 160, directorTab + 280)).toContain("moveDirectorPanelFocus");
    expect(view).toContain("if (helpWasOpen) helpTriggerEl.value?.focus()");
    expect(view).toContain("else if (addWasOpen) addTriggerEl.value?.focus()");
    expect(view).toContain("else if (directorWasOpen) restoreDirectorToggleFocus()");
  });

  it("素材库/剧本资源关闭钮可 Tab，关闭后焦回开库钮，不改成 dialog", () => {
    const view = source("src/renderer/src/components/ManagedStudioCanvasView.vue");
    const close = view.slice(
      view.indexOf("function closeLibrary"),
      view.indexOf("async function loadGlobalResources"),
    );
    expect(view).toContain('data-testid="managed-canvas-library-close"');
    expect(view).toContain('data-testid="managed-canvas-global-library-close"');
    expect(view).toContain('id="managed-canvas-library" class="canvas-library" aria-label="素材库"');
    expect(view).toContain('id="managed-canvas-global-resource-library"');
    expect(view).not.toContain('id="managed-canvas-library" class="canvas-library" aria-label="素材库" role="dialog"');
    expect(close).toContain("managed-canvas-open-library");
    expect(close).toContain("managed-canvas-open-global-resources");
    const keydown = view.slice(view.indexOf("function onCanvasKeydown"));
    expect(keydown.indexOf("void toggleLibrary()")).toBeGreaterThan(keydown.indexOf('event.key.toLowerCase() === "l"'));
    expect(keydown.indexOf("void toggleGlobalResourceLibrary()")).toBeLessThan(keydown.lastIndexOf("void toggleLibrary()"));
  });

  it("错误横幅关闭钮可 Tab，关闭后焦回画布，Escape 不清错误", () => {
    const view = source("src/renderer/src/components/ManagedStudioCanvasView.vue");
    const keydown = view.slice(view.indexOf("function onCanvasKeydown"));
    const close = view.slice(
      view.indexOf("function closeCanvasError"),
      view.indexOf("function restoreInspectorFlowFocus"),
    );
    expect(view).toContain('class="canvas-error" role="alert"');
    expect(view).toContain('data-testid="managed-canvas-error-close"');
    expect(view).toContain('@click="closeCanvasError"');
    expect(close).toContain('errorMessage.value = ""');
    expect(close).toContain("restoreInspectorFlowFocus()");
    expect(close).not.toContain("role=\"dialog\"");
    const n18 = keydown.slice(
      keydown.lastIndexOf('if (event.key !== "Escape") return'),
      keydown.indexOf("function invalidateCanvasRequests"),
    );
    expect(n18).toContain("resetClearConfirmation()");
    expect(n18).not.toContain("errorMessage");
    expect(n18).toContain("if (helpWasOpen) helpTriggerEl.value?.focus()");
  });

  it("清空二次确认后焦回画布，无 window.confirm，不抢 N18", () => {
    const view = source("src/renderer/src/components/ManagedStudioCanvasView.vue");
    const keydown = view.slice(view.indexOf("function onCanvasKeydown"));
    const clear = view.slice(
      view.indexOf("function clearWorkflowCanvas"),
      view.indexOf("async function loadPanelPipeline"),
    );
    expect(view).toContain('data-testid="managed-canvas-clear-view"');
    expect(view).toContain('aria-live="polite"');
    expect(clear).toContain("if (!clearConfirmationArmed.value)");
    expect(clear).toContain("workspaceMode.value = \"projection\"");
    expect(clear).toContain("restoreInspectorFlowFocus()");
    expect(clear).not.toContain("window.confirm");
    expect(clear.indexOf("if (!clearConfirmationArmed.value)")).toBeLessThan(clear.indexOf("workflowGroups.value = []"));
    expect(clear.indexOf("workflowGroups.value = []")).toBeLessThan(clear.indexOf("restoreInspectorFlowFocus()"));
    expect(keydown).toContain("resetClearConfirmation()");
    expect(keydown).not.toContain("clearWorkflowCanvas()");
  });

  it("帮助关闭钮含 testid，click 仍归还触发钮，不抢 N70/N18", () => {
    const view = source("src/renderer/src/components/ManagedStudioCanvasView.vue");
    const close = view.slice(
      view.indexOf("function closeHelp"),
      view.indexOf("function toggleHelp"),
    );
    expect(view).toContain('data-testid="managed-canvas-help-close"');
    expect(view).toContain('#managed-canvas-help-card button[aria-label="关闭帮助"]');
    expect(close).toContain("helpOpen.value = false");
    expect(close).toContain("helpTriggerEl.value?.focus()");
    const keydown = view.slice(view.indexOf("function onCanvasKeydown"));
    expect(keydown.indexOf('event.key === "F1"')).toBeLessThan(keydown.indexOf("toggleHelp()"));
    expect(keydown).toContain("if (helpWasOpen) helpTriggerEl.value?.focus()");
  });

  it("视图菜单关闭后焦回 summary，帮助/添加归还优先", () => {
    const view = source("src/renderer/src/components/ManagedStudioCanvasView.vue");
    const keydown = view.slice(view.indexOf("function onCanvasKeydown"));
    const close = view.slice(
      view.indexOf("function closeViewMenu"),
      view.indexOf("function onGlobalPointerDown"),
    );
    expect(view).toContain('data-testid="managed-canvas-view-menu"');
    expect(view).toContain('<summary data-testid="managed-canvas-view-menu" aria-label="视图选项">');
    expect(close).toContain('viewMenuEl.value?.removeAttribute("open")');
    expect(close).toContain("restoreViewMenuSummaryFocus()");
    expect(view).toContain("closeViewMenu()");
    expect(keydown).toContain("const viewMenuWasOpen");
    expect(keydown).toContain("closeViewMenu({ restore: false })");
    expect(keydown).toContain("else if (viewMenuWasOpen) restoreViewMenuSummaryFocus()");
    expect(keydown.indexOf("if (helpWasOpen) helpTriggerEl.value?.focus()")).toBeLessThan(keydown.indexOf("else if (addWasOpen) addTriggerEl.value?.focus()"));
    expect(keydown.indexOf("else if (addWasOpen) addTriggerEl.value?.focus()")).toBeLessThan(keydown.indexOf("else if (viewMenuWasOpen) restoreViewMenuSummaryFocus()"));
    expect(view).toContain("function onViewMenuToggle");
    expect(keydown).toContain(".view-menu-pop > button");
  });

  it("画布诊断 details 可键盘开合，不改成 dialog，不扩 N18", () => {
    const view = source("src/renderer/src/components/ManagedStudioCanvasView.vue");
    const keydown = view.slice(
      view.indexOf("function onCanvasKeydown"),
      view.indexOf("function invalidateCanvasRequests"),
    );
    expect(view).toContain('class="flow-caption technical-diagnostics"');
    expect(view).toContain('data-testid="managed-canvas-diagnostics"');
    expect(view).toContain('data-testid="managed-canvas-dom-counts"');
    expect(view).not.toContain('class="flow-caption technical-diagnostics" role="dialog"');
    expect(keydown).not.toContain("managed-canvas-diagnostics");
    expect(keydown).toContain("closeViewMenu({ restore: false })");
  });

  it("检查器诊断 details 可键盘开合，不关检查器，不改成 dialog", () => {
    const inspector = source("src/renderer/src/components/CanvasInspectorPanel.vue");
    const view = source("src/renderer/src/components/ManagedStudioCanvasView.vue");
    expect(inspector).toContain('class="technical-diagnostics inspector-diagnostics"');
    expect(inspector).toContain('data-testid="managed-canvas-inspector-diagnostics"');
    expect(inspector).not.toContain('role="dialog"');
    expect(inspector).toContain('<aside class="canvas-inspector" aria-label="画布节点详情">');
    expect(view).toContain('@close="closeInspector"');
    expect(view).toContain('data-testid="managed-canvas-diagnostics"');
    expect(inspector).not.toContain("managed-canvas-diagnostics");
  });

  it("画布详细诊断 summary 含 testid，不抢 N80，不改 metrics open", () => {
    const view = source("src/renderer/src/components/ManagedStudioCanvasView.vue");
    expect(view).toContain('data-testid="managed-canvas-diagnostics-detail"');
    expect(view).toContain('data-testid="managed-canvas-detailed-diagnostics"');
    expect(view).toContain('<summary data-testid="managed-canvas-detailed-diagnostics">详细诊断</summary>');
    expect(view).toContain('<summary data-testid="managed-canvas-diagnostics">诊断详情</summary>');
    expect(view).toContain('data-testid="managed-canvas-metrics" open');
    expect(view).not.toContain("managed-canvas-detailed-diagnostics-");
    expect(view).not.toContain('diagnostics-detail" role="dialog"');
  });

  it("画布项目概览 summary 含 testid，metrics 仍默认展开", () => {
    const view = source("src/renderer/src/components/ManagedStudioCanvasView.vue");
    expect(view).toContain('class="canvas-metrics technical-diagnostics"');
    expect(view).toContain('data-testid="managed-canvas-metrics"');
    expect(view).toContain('data-testid="managed-canvas-metrics-summary"');
    expect(view).toContain('<summary data-testid="managed-canvas-metrics-summary">项目概览</summary>');
    expect(view).toContain('data-testid="managed-canvas-metrics" open');
    expect(view).toContain('data-testid="managed-canvas-detailed-diagnostics"');
    expect(view).not.toContain("managed-canvas-metrics-summary-");
  });

  it("画布高级操作 summary 含 testid，不改工作流 toolbar", () => {
    const view = source("src/renderer/src/components/ManagedStudioCanvasView.vue");
    expect(view).toContain('class="advanced-workflow"');
    expect(view).toContain('data-testid="managed-canvas-advanced-workflow"');
    expect(view).toContain('<summary data-testid="managed-canvas-advanced-workflow">高级操作</summary>');
    expect(view).toContain('data-testid="managed-canvas-workflow-toolbar"');
    expect(view).toContain('data-testid="managed-canvas-create-workflow"');
    expect(view).toContain('data-testid="managed-canvas-run-workflow"');
    expect(view).not.toContain("managed-canvas-advanced-workflow-");
    expect(view).not.toContain('advanced-workflow" role="dialog"');
    expect(view).toContain('data-testid="managed-canvas-diagnostics"');
  });
});
