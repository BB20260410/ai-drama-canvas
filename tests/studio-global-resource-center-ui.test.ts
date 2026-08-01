import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "@vue/compiler-sfc";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = (relative: string): string => readFileSync(path.join(root, relative), "utf8");

describe("总资源中心 renderer 合同", () => {
  it("以独立模式接入 Material Studio，并从只读画布抽屉跳转", () => {
    const material = source("src/renderer/src/components/MaterialStudioView.vue");
    const canvas = source("src/renderer/src/components/ManagedStudioCanvasView.vue");
    const center = source("src/renderer/src/components/GlobalResourceCenterView.vue");

    expect(parse(material, { filename: "MaterialStudioView.vue" }).errors).toEqual([]);
    expect(parse(canvas, { filename: "ManagedStudioCanvasView.vue" }).errors).toEqual([]);
    expect(parse(center, { filename: "GlobalResourceCenterView.vue" }).errors).toEqual([]);

    expect(material).toContain('data-testid="studio-mode-global-resources"');
    expect(material).toContain('data-testid="studio-global-resources-pane"');
    expect(material).toContain('activeMode === \'global-resources\'');
    expect(material).toContain("<AsyncGlobalResourceCenterView");
    expect(material).toContain(':target-project-root="projectRoot"');
    expect(material).toContain(':target-project-name="overview?.projectName || projectName"');
    expect(material).toContain('@reused="onGlobalResourceReused"');
    expect(material).toContain("全部受管项目总资源 · 调用目标为当前工程");
    expect(material).toContain('@open-resource-center="selectStudioMode(\'global-resources\')"');

    expect(canvas).toContain('data-testid="managed-canvas-open-resource-center"');
    expect(canvas).toContain("emit('openResourceCenter')");
    expect(canvas).toContain("openResourceCenter: []");
    const drawer = canvas.slice(
      canvas.indexOf('id="managed-canvas-global-resource-library"'),
      canvas.indexOf('<aside v-else-if="libraryOpen"'),
    );
    expect(drawer).toContain("打开总资源中心");
    expect(drawer).not.toContain("reuseGlobalResource");
    expect(drawer).not.toContain("executeStudioCommand");
    expect(drawer).not.toContain("togglePinnedNode");
  });

  it("覆盖全部图片、语义分类、生产图片、音频和视频十类以及稳定测试入口", () => {
    const center = source("src/renderer/src/components/GlobalResourceCenterView.vue");
    for (const category of [
      "all",
      "character",
      "scene",
      "prop",
      "style",
      "storyboard",
      "reference",
      "other",
      "audio",
      "video",
    ]) {
      expect(center).toContain(`{ kind: "${category}"`);
    }
    for (const testId of [
      "global-resource-center-view",
      "global-resource-target-project",
      "global-resource-search",
      "global-resource-summary",
      "global-resource-viewport",
      "global-resource-item",
      "global-resource-source-project",
      "global-resource-classification",
      "global-resource-association",
      "global-resource-use-in-project",
      "global-resource-use-image-in-project",
      "global-resource-target-state",
      "global-resource-prev",
      "global-resource-page-indicator",
      "global-resource-next",
      "global-resource-operation-notice",
      "global-resource-error",
    ]) {
      expect(center).toContain(`data-testid="${testId}"`);
    }
    expect(center).toContain(':data-testid="`global-resource-tab-${entry.kind}`"');
    expect(center).toContain("调用到");
    expect(center).toContain("{{ targetProjectName || \"当前项目\" }}");
    expect(center).toContain("调用不会覆盖同名资源");
    expect(center).toContain("自动进入总资源并分类");
    expect(center).toContain("projectImageEntries");
    expect(center).toContain("uniqueContentSha256");
  });

  it("列表以 target root、分类、搜索、游标和 36 上限隔离异步结果", () => {
    const center = source("src/renderer/src/components/GlobalResourceCenterView.vue");
    expect(center).toContain("const RESOURCE_PAGE_LIMIT = 36");
    expect(center).toContain("const pageState = shallowRef<ResourcePageState | null>(null)");
    expect(center).toContain("items: page.items.slice(0, RESOURCE_PAGE_LIMIT)");
    expect(center.match(/items: page\.items\.slice\(0, RESOURCE_PAGE_LIMIT\)/gu)?.length).toBe(2);

    const fingerprint = center.slice(
      center.indexOf("function requestFingerprint"),
      center.indexOf("async function loadPage"),
    );
    for (const field of [
      "input.targetProjectRoot",
      "input.category",
      "input.search",
      'input.cursor ?? ""',
      "input.limit",
    ]) {
      expect(fingerprint).toContain(field);
    }
    expect(center).toContain("request === listRequestSequence");
    expect(center).toContain("pendingListFingerprint === fingerprint");
    expect(center).toContain("targetProjectRoot === props.targetProjectRoot");
    expect(center).toContain("category === activeCategory.value");
    expect(center).toContain("search === searchQuery.value");
    expect(center).toContain("cursorStack.value = [...cursorStack.value, previousCursor]");
    expect(center).toContain("cursorStack.value = cursorStack.value.slice(0, -1)");
  });

  it("资产逐关联展示，并且只有 approved Primary 可以调用为目标 pending", () => {
    const center = source("src/renderer/src/components/GlobalResourceCenterView.vue");
    expect(center).toContain('v-for="association in item.associations"');
    expect(center).toContain("association.reviewStatus === \"approved\" && association.isPrimary");
    expect(center).toContain('v-if="canReuseAssociation(association)"');
    expect(center).toContain("仅已通过的 Primary 可调用");
    expect(center).toContain('resourceKind: "asset"');
    expect(center).toContain("sourceProjectRoot: item.sourceProject.primaryRoot");
    expect(center).toContain("expectedSourceProjectId: item.sourceProject.id");
    expect(center).toContain("sourceAssetId: association.assetId");
    expect(center).toContain("sourceVersionId: association.versionId");
    expect(center).toContain("expectedSourceAssetRevision: association.assetRevision");
    expect(center).toContain("targetExpectedRevision: 0");
    expect(center).toContain("作为 pending 候选等待当前项目独立审核");
  });

  it("普通图片按 SHA 调入当前项目，不创建或冒充规范资产", () => {
    const center = source("src/renderer/src/components/GlobalResourceCenterView.vue");
    expect(center).toContain("item.classification.primaryCategory");
    expect(center).toContain("item.classification.resourceRole");
    expect(center).toContain("item.classification.classificationState");
    expect(center).toContain("item.sourceNames.slice(0, 2)");
    expect(center).toContain('resourceKind: "image"');
    expect(center).toContain("sourceMediaSha256: item.mediaSha256");
    expect(center).toContain("expectedSourceMediaSizeBytes: item.sizeBytes");
    expect(center).toContain("不会擅自创建权威资产");
  });

  it("音视频只消费已有派生预览，不自动播放或触发派生生成", () => {
    const center = source("src/renderer/src/components/GlobalResourceCenterView.vue");
    expect(center).toContain("item.preview?.recipeKey");
    expect(center).toContain("aicanvas-studio://derivative/${item.preview.recipeKey}");
    expect(center).toContain('resourceKind: item.kind');
    expect(center).toContain("sourceMediaSha256: item.mediaSha256");
    expect(center).toContain("expectedSourceMediaSizeBytes: item.sizeBytes");
    expect(center).not.toContain("<video");
    expect(center).not.toContain("<audio");
    expect(center).not.toContain("autoplay");
    expect(center).not.toContain("prepareStudioMediaDerivatives");
    expect(center).not.toContain("aicanvas-studio://media/");
    expect(center.match(/loading="lazy"/gu)?.length).toBeGreaterThanOrEqual(2);
    expect(center.match(/decoding="async"/gu)?.length).toBeGreaterThanOrEqual(2);
  });

  it("调用四态有明确反馈，重复项不会再次触发写入", () => {
    const center = source("src/renderer/src/components/GlobalResourceCenterView.vue");
    for (const disposition of [
      "imported-pending",
      "already-imported",
      "imported",
      "already-present",
    ]) {
      expect(center).toContain(`"${disposition}"`);
    }
    expect(center).toContain("reuseCompleted(key)");
    expect(center).toContain("当前项目已有");
    expect(center).toContain("未重复导入");
    expect(center).toContain("未重复复制");
    expect(center).toContain("未自动播放、挂接时间线或加入画布");
    expect(center).not.toContain("conflict-dialog");
    expect(center).not.toContain("覆盖同名资源吗");
  });

  it("同一来源工程资源不会下发复用命令，并明确显示已经在当前项目", () => {
    const center = source("src/renderer/src/components/GlobalResourceCenterView.vue");
    expect(center).toContain("function isCurrentProjectResource(sourceProjectRoot: string)");
    expect(center).toContain("return sourceProjectRoot === props.targetProjectRoot");
    expect(center).toContain("当前项目资源");
    expect(center).toContain("已在当前项目，无需调用");
    expect(center.match(/isCurrentProjectResource\(item\.sourceProject\.primaryRoot\)/gu)?.length).toBeGreaterThanOrEqual(6);

    const reuseAsset = center.slice(
      center.indexOf("async function reuseAsset"),
      center.indexOf("async function reuseImage"),
    );
    const reuseImage = center.slice(
      center.indexOf("async function reuseImage"),
      center.indexOf("async function reuseMedia"),
    );
    const reuseMedia = center.slice(
      center.indexOf("async function reuseMedia"),
      center.indexOf("async function runReuse"),
    );
    expect(reuseAsset).toContain("if (isCurrentProjectResource(item.sourceProject.primaryRoot)) return;");
    expect(reuseImage).toContain("if (isCurrentProjectResource(item.sourceProject.primaryRoot)) return;");
    expect(reuseMedia).toContain("if (isCurrentProjectResource(item.sourceProject.primaryRoot)) return;");
  });

  it("调用成功后刷新目标工程概览，并在回到素材库时保留旧页直至新页替换", () => {
    const material = source("src/renderer/src/components/MaterialStudioView.vue");
    const reusedHandler = material.slice(
      material.indexOf("async function onGlobalResourceReused"),
      material.indexOf("async function runAction"),
    );
    expect(reusedHandler).toContain("currentLibraryRefreshPending.value = true");
    expect(reusedHandler).toContain("await props.api.getOverview(root)");
    expect(reusedHandler).toContain("overview.value = next");

    const libraryRefresh = material.slice(
      material.indexOf("async function refreshCurrentLibraryIfNeeded"),
      material.indexOf("async function loadFirstPage"),
    );
    expect(libraryRefresh).toContain('activeMode.value !== "library"');
    expect(libraryRefresh).toContain("const loaded = await loadFirstPage()");
    expect(libraryRefresh).toContain("currentLibraryRefreshPending.value = false");

    const selectSection = material.slice(
      material.indexOf("function selectSection"),
      material.indexOf("function entrySelectionId"),
    );
    expect(selectSection).toContain("if (!currentLibraryRefreshPending.value) entries.value = []");
    expect(selectSection).toContain("void refreshCurrentLibraryIfNeeded()");
    expect(material).toContain('data-testid="material-library-refresh-status"');
    expect(material).toContain("现有列表会保留到新结果成功返回");
  });

  it("App 只经全局只读 IPC 与受管 reuse command 适配三方法", () => {
    const app = source("src/renderer/src/App.vue");
    const material = source("src/renderer/src/components/MaterialStudioView.vue");
    expect(app).toContain("listGlobalResourceImages(query)");
    expect(app).toContain("window.canvasApi.listGlobalStudioImageResources(query)");
    expect(app).toContain("listGlobalMediaResources(query)");
    expect(app).toContain("window.canvasApi.listGlobalStudioMediaResources(query)");
    expect(app).toContain("async reuseGlobalResource(targetRoot, input)");
    expect(app).toContain('command: "reuse_studio_global_resource"');
    expect(app).toContain("payload: input");
    expect(app).toContain("result.result as ReuseStudioGlobalResourceResult");

    expect(material).toContain("listGlobalResourceImages?");
    expect(material).toContain("listGlobalMediaResources?");
    expect(material).toContain("reuseGlobalResource?");
    expect(material).toContain("props.api.listGlobalResourceImages");
    expect(material).toContain("props.api.listGlobalMediaResources");
    expect(material).toContain("props.api.reuseGlobalResource");
  });

  it("独立总资源组件不会读写 VueFlow、固定节点或布局状态", () => {
    const center = source("src/renderer/src/components/GlobalResourceCenterView.vue");
    for (const forbidden of [
      "VueFlow",
      "rebuildGraph",
      "fitCanvas",
      "togglePinnedNode",
      "pinnedNodeIds",
      "saveLayout",
      "draftCanvasEdges",
      "executeStudioCommand",
    ]) {
      expect(center).not.toContain(forbidden);
    }
  });
});
