import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "@vue/compiler-sfc";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = (relative: string): string => readFileSync(path.join(root, relative), "utf8");

describe("全剧本素材目录 UI / IPC 合同", () => {
  it("main 与 preload 同时暴露资产实体和逐张版本图片的只读 IPC/API", () => {
    const main = source("src/main/index.ts");
    const registrar = source("src/main/studio-global-resource-read-ipc.ts");
    const preload = source("src/preload/index.ts");

    expect(main).toContain("registerStudioGlobalResourceReadIpc(ipcMain.handle.bind(ipcMain));");
    expect(registrar).toContain('handle("canvas:list-global-studio-assets"');
    expect(registrar).toContain("services.listGlobalStudioAssetCatalog(query)");
    expect(registrar).toContain('handle("canvas:list-global-studio-asset-images"');
    expect(registrar).toContain("services.listGlobalStudioAssetResourceImages(query)");
    expect(registrar).toContain('handle("canvas:get-global-studio-asset-image"');
    expect(registrar).toContain("services.getGlobalStudioAssetResourceImage(projectRoot, mediaSha256)");

    expect(preload).toContain("listGlobalStudioAssets:");
    expect(preload).toContain('ipcRenderer.invoke("canvas:list-global-studio-assets", query)');
    expect(preload).toContain("listGlobalStudioAssetImages:");
    expect(preload).toContain('ipcRenderer.invoke("canvas:list-global-studio-asset-images", query)');
    expect(preload).toContain("getGlobalStudioAssetImage:");
    expect(preload).toContain('ipcRenderer.invoke("canvas:get-global-studio-asset-image", projectRoot, mediaSha256)');
  });

  it("App 在 scope=all 下按 representation 路由逐图或资产目录，并保留当前剧本 owner", () => {
    const app = source("src/renderer/src/App.vue");
    expect(parse(app, { filename: "App.vue" }).errors).toEqual([]);

    const listStart = app.indexOf("async listEntries(root, query)");
    const detailStart = app.indexOf("async getEntryDetail(root, entryId)", listStart);
    expect(listStart).toBeGreaterThanOrEqual(0);
    expect(detailStart).toBeGreaterThan(listStart);
    const listAdapter = app.slice(listStart, detailStart);

    expect(listAdapter).toContain('if (query.scope === "all")');
    expect(listAdapter).toContain('if (query.representation === "images")');
    expect(listAdapter).toContain("window.canvasApi.listGlobalStudioAssetImages({");
    expect(listAdapter).toContain("window.canvasApi.listGlobalStudioAssets({");
    expect(listAdapter).toContain("window.canvasApi.listStudioAssets(root, {");
    expect(listAdapter.indexOf("window.canvasApi.listGlobalStudioAssetImages({"))
      .toBeLessThan(listAdapter.indexOf("window.canvasApi.listGlobalStudioAssets({"));
    expect(listAdapter.indexOf("window.canvasApi.listGlobalStudioAssets({"))
      .toBeLessThan(listAdapter.indexOf("window.canvasApi.listStudioAssets(root, {"));

    expect(listAdapter).toContain("const names = [...new Set(image.associations.map((association) => association.name))]");
    expect(listAdapter).toContain('title: names.join(" / ")');
    expect(listAdapter).toContain("sourceProjectId: image.sourceProject.id");
    expect(listAdapter).toContain("sourceProjectName: image.sourceProject.name");
    expect(listAdapter).toContain("sourceProjectRoot: image.sourceProject.primaryRoot");
    expect(listAdapter).toContain("sourceEntryId: `resource-image:${image.mediaSha256}`");
    expect(listAdapter).toMatch(/resourceImage:\s*\{[\s\S]{0,900}versionOrdinal: association\.versionOrdinal,[\s\S]{0,300}reviewStatus: association\.reviewStatus,[\s\S]{0,300}isPrimary: association\.isPrimary,/u);
    expect(listAdapter).toContain("resourceCounts: page.resourceCounts");

    expect(listAdapter).toContain("sourceProjectId: asset.sourceProject.id");
    expect(listAdapter).toContain("sourceProjectName: asset.sourceProject.name");
    expect(listAdapter).toContain("sourceProjectRoot: asset.sourceProject.primaryRoot");
    expect(listAdapter).toContain("sourceEntryId: `asset:${asset.assetId}`");
    expect(listAdapter).toContain("imageCoverage: page.imageCoverage");
    expect(listAdapter).toContain("unavailableProjects: page.unavailableProjects");
  });

  it("resource-image 详情由来源工程逐图 API 映射，并保留全部名称、版本、Review 与 Primary", () => {
    const app = source("src/renderer/src/App.vue");
    const detailStart = app.indexOf("async getEntryDetail(root, entryId)");
    expect(detailStart).toBeGreaterThanOrEqual(0);
    const detailAdapter = app.slice(detailStart);

    expect(detailAdapter).toContain('if (scope === "resource-image")');
    expect(detailAdapter).toContain("window.canvasApi.getGlobalStudioAssetImage(root, id)");
    expect(detailAdapter).toContain("const names = [...new Set(image.associations.map((association) => association.name))]");
    expect(detailAdapter).toContain('title: names.join(" / ")');
    expect(detailAdapter).toContain("同一来源工程内按图片 SHA 去重，全部名称、版本、Review 与 Primary 状态均保留");
    expect(detailAdapter).toMatch(/resourceImage:\s*\{[\s\S]{0,1200}name: association\.name,[\s\S]{0,300}versionOrdinal: association\.versionOrdinal,[\s\S]{0,300}reviewStatus: association\.reviewStatus,[\s\S]{0,300}isPrimary: association\.isPrimary,[\s\S]{0,300}sourceNote: association\.sourceNote \|\| undefined,/u);
    expect(detailAdapter).toMatch(/versions: image\.associations\.map\(\(association\) => \(\{[\s\S]{0,900}reviewStatus: association\.reviewStatus,[\s\S]{0,300}isPrimary: association\.isPrimary,/u);
    expect(detailAdapter).toContain("ownerAssetId: association.assetId");
    expect(detailAdapter).toContain("ownerName: association.name");
    expect(detailAdapter).toContain("ownerCategory: association.category");
    expect(detailAdapter).toContain("列表和详情默认只读取冻结缩略图；受管 CAS 原图仅在明确打开单图检查时读取。");
  });

  it("全部剧本素材默认展示版本图片，并可显式切换到资产实体", () => {
    const view = source("src/renderer/src/components/MaterialStudioView.vue");
    expect(parse(view, { filename: "MaterialStudioView.vue" }).errors).toEqual([]);

    for (const testId of [
      "material-asset-scope-switch",
      "material-asset-scope-current",
      "material-asset-scope-all",
      "material-asset-representation-switch",
      "material-asset-representation-images",
      "material-asset-representation-assets",
      "material-global-asset-summary",
      "material-entry-source-project",
      "material-global-readonly-detail",
    ]) {
      expect(view).toContain(`data-testid="${testId}"`);
    }
    expect(view).toContain(">当前剧本</button>");
    expect(view).toContain(">全部剧本</button>");
    expect(view).toContain(">版本图片</button>");
    expect(view).toContain(">资产实体</button>");
    expect(view).toContain('const assetRepresentation = ref<MaterialStudioAssetRepresentation>("images")');
    expect(view).toContain('if (scope === "all") assetRepresentation.value = "images"');
    expect(view).toContain('effectiveListScope.value === "all" ? assetRepresentation.value : "assets"');
    expect(view).toContain('assetRepresentation === "images" ? "全部版本图片" : "全部规范资产"');
    expect(view).toContain("来源剧本：{{ entrySourceProjectLabel(entry) }}");
    expect(view).toContain("已进入剧本资源 {{ globalCatalogSummary.imageCoverage.assetVersionImages }} 张 / 全部图片 {{ globalCatalogSummary.imageCoverage.totalImages }}");
    expect(view).toContain("个资产实体对应 {{ globalCatalogSummary.resourceCounts.total }} 张版本图片；共享图片保留全部名称与版本关系");
    expect(view).toContain("张普通图片未归入人物、场景、道具或风格资产");
    expect(view).toContain("个剧本暂不可读取，未冒充完整覆盖");
  });

  it("逐图资源卡与详情展示图片对应的全部名称、版本、Review 和 Primary 关系", () => {
    const view = source("src/renderer/src/components/MaterialStudioView.vue");

    for (const testId of [
      "material-resource-image-associations",
      "material-resource-image-detail",
    ]) {
      expect(view).toContain(`data-testid="${testId}"`);
    }
    expect(view).toContain('v-if="entry.resourceImage"');
    expect(view).toContain('v-for="association in entry.resourceImage.associations"');
    expect(view).toContain("<b>{{ association.name }}</b>");
    expect(view).toContain("{{ kindLabel(association.category) }} · v{{ association.versionOrdinal }} · {{ reviewLabel(association.reviewStatus) }}");
    expect(view).toContain('<em v-if="association.isPrimary">Primary</em>');
    expect(view).toContain('<em v-else>非 Primary</em>');
    expect(view).toContain('v-for="association in detail.resourceImage.associations"');
    expect(view).toContain(':class="`review-${association.reviewStatus}`"');
    expect(view).toContain('{{ association.isPrimary ? "Primary" : "非 Primary" }}');
    expect(view).toContain("<p v-if=\"association.sourceNote\">{{ association.sourceNote }}</p>");
    expect(view).toContain("version.ownerName ? `${version.ownerName} · v${version.ordinal}` : `v${version.ordinal}`");
    expect(view).toContain("versionPreview.ownerName || detail?.title");
    expect(view.match(/loading="lazy"/gu)?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(view.match(/decoding="async"/gu)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });

  it("representation 进入异步指纹，切换表示层会失效旧列表和详情请求", () => {
    const view = source("src/renderer/src/components/MaterialStudioView.vue");

    expect(view).toMatch(/function listQueryFingerprint[\s\S]{0,360}JSON\.stringify\(\[\s*projectRoot,\s*query\.scope,\s*query\.representation,/u);
    expect(view.match(/representation: effectiveAssetRepresentation\.value/gu)?.length ?? 0).toBeGreaterThanOrEqual(4);
    expect(view).toContain("scope.queryFingerprint === listQueryFingerprint(props.projectRoot, currentQuery)");
    expect(view).toMatch(/function setAssetRepresentation[\s\S]{0,1800}listRequest \+= 1;[\s\S]{0,400}detailRequest \+= 1;[\s\S]{0,800}assetRepresentation\.value = representation;[\s\S]{0,800}resetMaterialStudioCursorState\(pageCursors\);[\s\S]{0,900}void loadFirstPage\(\);/u);
    expect(view).toContain("已显示全部剧本中逐张登记的版本图片；同工程重复 SHA 合并为一张并保留全部名称与版本关系。");
  });

  it("resource-image 使用来源工程详情映射，全部剧本模式隐藏或拒绝所有写入口", () => {
    const view = source("src/renderer/src/components/MaterialStudioView.vue");

    expect(view).toContain('const detailProjectRoot = scope === "all" ? entry.sourceProjectRoot?.trim() : projectRoot');
    expect(view).toContain('const detailEntryId = scope === "all" ? entry.sourceEntryId?.trim() : entry.id');
    expect(view).toContain("已拒绝使用当前工程代读详情");
    expect(view).toContain("const next = await props.api.getEntryDetail(detailProjectRoot, detailEntryId)");
    expect(view).toContain("if (!detailRequestIsCurrent(request) || selectedId.value !== selectionId) return");
    expect(view).toContain('return JSON.stringify([sourceProjectId, sourceProjectRoot, sourceEntry])');
    expect(view).toMatch(/function clearHiddenSelection[\s\S]{0,500}detailRequest \+= 1;[\s\S]{0,180}detailLoading\.value = false;[\s\S]{0,180}versionPreview\.value = null;/u);
    expect(view).toMatch(/function selectSection[\s\S]{0,240}detailRequest \+= 1;[\s\S]{0,450}detailLoading\.value = false;[\s\S]{0,180}versionPreview\.value = null;/u);

    expect(view).toContain('const globalWriteBlockedText = "如需创建、附加版本、Review、关系写入或跨项目复用，请切回当前剧本后操作。"');
    expect(view).toContain('data-testid="material-global-readonly-detail"');
    expect(view).toContain("全部剧本详情为只读；{{ globalWriteBlockedText }}");
    expect(view).toContain('v-if="isAssetKind(detail.kind) && !isGlobalAssetScope" class="detail-section cross-project-reuse"');
    expect(view).toContain('v-if="isAssetKind(detail.kind) && !isGlobalAssetScope" class="detail-section version-intake"');
    expect(view).toContain("version.reviewStatus === 'pending' && !isGlobalAssetScope");
    expect(view).toContain("version.reviewStatus === 'approved' && !version.isPrimary && isAssetKind(detail.kind) && !isGlobalAssetScope");
    expect(view).toContain("if (isGlobalAssetScope.value && action.requiresWrite)");
    expect(view).toContain("全部剧本素材只提供只读查看");
    expect(view.match(/if \(blockGlobalAssetWrite\(\)\) return;/gu)?.length ?? 0).toBeGreaterThanOrEqual(10);
    expect(view.match(/:disabled="Boolean\(pendingAction\) \|\| isGlobalAssetScope"/gu)?.length ?? 0).toBeGreaterThanOrEqual(5);
  });

  it("全局与当前列表都受 36 项上限约束，并以 projectRoot+scope+representation 隔离异步结果", () => {
    const view = source("src/renderer/src/components/MaterialStudioView.vue");
    const pagination = source("src/renderer/src/material-studio-pagination.ts");
    const cursorPagination = source("src/renderer/src/use-cursor-pagination.ts");
    const globalCatalog = source("src/core/studio-global-asset-catalog.ts");

    expect(cursorPagination).toContain("export const DEFAULT_CURSOR_PAGE_LIMIT = 36 as const");
    expect(pagination).toContain("export const MATERIAL_STUDIO_PAGE_LIMIT = DEFAULT_CURSOR_PAGE_LIMIT");
    expect(globalCatalog).toContain("const MAX_PAGE_LIMIT = 36");
    expect(view.match(/limit: MATERIAL_STUDIO_PAGE_LIMIT/gu)?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(view.match(/entries\.value = boundedMaterialStudioEntries\(page\.items\)/gu)?.length ?? 0).toBeGreaterThanOrEqual(3);

    expect(view).toMatch(/function listQueryFingerprint[\s\S]{0,360}JSON\.stringify\(\[\s*projectRoot,\s*query\.scope,\s*query\.representation,/u);
    expect(view).toContain("scope.projectRoot === props.projectRoot");
    expect(view).toContain("scope.scope === effectiveListScope.value");
    expect(view).toContain("scope.queryFingerprint === listQueryFingerprint(props.projectRoot, currentQuery)");
    expect(view).toMatch(/function detailQueryFingerprint[\s\S]{0,360}JSON\.stringify\(\[\s*projectRoot,\s*scope,/u);
  });

  it("无限画布以内置只读剧本资源抽屉展示全部版本图片，不污染当前工程节点", () => {
    const material = source("src/renderer/src/components/MaterialStudioView.vue");
    const canvas = source("src/renderer/src/components/ManagedStudioCanvasView.vue");
    expect(parse(canvas, { filename: "ManagedStudioCanvasView.vue" }).errors).toEqual([]);

    expect(material).toContain(':global-resource-api="api"');
    expect(canvas).toContain("export interface ManagedStudioCanvasGlobalResourceApi");
    expect(canvas).toContain("globalResourceApi?: ManagedStudioCanvasGlobalResourceApi");
    for (const testId of [
      "managed-canvas-open-global-resources",
      "managed-canvas-global-resource-library",
      "managed-canvas-global-resource-summary",
      "managed-canvas-global-resource-viewport",
      "managed-canvas-global-resource-item",
      "managed-canvas-global-resource-associations",
      "managed-canvas-global-resources-prev",
      "managed-canvas-global-resources-next",
    ]) {
      expect(canvas).toContain(`data-testid="${testId}"`);
    }
    expect(canvas).toContain("<span>剧本资源</span>");
    expect(canvas).toContain("<h3>全部剧本版本图片</h3>");
    expect(canvas).toContain("只读 · 不写入当前工程");
    expect(canvas).toContain('const GLOBAL_RESOURCE_PAGE_LIMIT = 36');
    expect(canvas).toMatch(/resourceApi\.listEntries\(projectRoot,\s*\{[\s\S]{0,500}scope:\s*"all",[\s\S]{0,200}representation:\s*"images",[\s\S]{0,300}limit:\s*GLOBAL_RESOURCE_PAGE_LIMIT,/u);
    expect(canvas).toContain("items: page.items.slice(0, GLOBAL_RESOURCE_PAGE_LIMIT)");

    const fingerprint = canvas.slice(
      canvas.indexOf("function globalResourceQueryFingerprint"),
      canvas.indexOf("let globalResourcePendingFingerprint"),
    );
    for (const identityField of [
      "input.projectRoot",
      '"global"',
      "input.category",
      "input.search",
      'input.cursor ?? ""',
      "GLOBAL_RESOURCE_PAGE_LIMIT",
    ]) {
      expect(fingerprint).toContain(identityField);
    }
    expect(canvas).toContain('libraryMode.value === "global"');
    expect(canvas).toContain("requestSequence === globalResourceLoadSequence");
    expect(canvas).toContain("globalResourcePendingFingerprint === fingerprint");
    expect(canvas).toContain("invalidateGlobalResourceRequest();");
    expect(canvas).toContain('globalResourceCategory.value = "character"');
    expect(canvas).toContain('libraryMode.value = "current"');

    expect(canvas).toContain("来源剧本：{{ globalResourceSourceLabel(entry) }}");
    expect(canvas).toContain('v-for="association in entry.resourceImage.associations"');
    expect(canvas).toContain("<b>{{ association.name }}</b>");
    expect(canvas).toContain("v{{ association.versionOrdinal }}");
    expect(canvas).toContain('{{ association.isPrimary ? "Primary" : "非 Primary" }}');
    expect(canvas).toContain('loading="lazy"');
    expect(canvas).toContain('decoding="async"');
    expect(canvas).toContain(':data-resource-key="entry.id"');

    const globalTemplate = canvas.slice(
      canvas.indexOf('id="managed-canvas-global-resource-library"'),
      canvas.indexOf('<aside v-else-if="libraryOpen"'),
    );
    expect(globalTemplate).not.toContain("togglePinnedNode");
    expect(globalTemplate).not.toContain("selectAsset");
    expect(globalTemplate).not.toContain("executeStudioCommand");
    expect(globalTemplate).not.toContain(">添加</button>");
    const globalFunctions = canvas.slice(
      canvas.indexOf("function globalResourceQueryFingerprint"),
      canvas.indexOf("async function openLibraryFor"),
    );
    expect(globalFunctions).not.toContain("rebuildGraph");
    expect(globalFunctions).not.toContain("fitCanvas");
    expect(globalFunctions).not.toContain("togglePinnedNode");
  });
});
