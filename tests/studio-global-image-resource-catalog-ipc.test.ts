import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = (relative: string): string => readFileSync(path.join(root, relative), "utf8");

describe("全项目图片总资源 IPC 合同", () => {
  it("main 与 preload 暴露同名只读列表和单项查询", () => {
    const main = source("src/main/index.ts");
    const preload = source("src/preload/index.ts");

    expect(main).toContain("listGlobalStudioImageResources,");
    expect(main).toContain("getGlobalStudioImageResource,");
    expect(main).toContain("type GlobalStudioImageResourceQuery,");
    expect(main).toContain('ipcMain.handle("canvas:list-global-studio-image-resources"');
    expect(main).toContain("listGlobalStudioImageResources(query)");
    expect(main).toContain('ipcMain.handle("canvas:get-global-studio-image-resource"');
    expect(main).toContain("getGlobalStudioImageResource(projectRoot, mediaSha256)");

    expect(preload).toContain("listGlobalStudioImageResources:");
    expect(preload).toContain(
      'ipcRenderer.invoke("canvas:list-global-studio-image-resources", query)',
    );
    expect(preload).toContain("getGlobalStudioImageResource:");
    expect(preload).toContain(
      'ipcRenderer.invoke("canvas:get-global-studio-image-resource", projectRoot, mediaSha256)',
    );
  });

  it("图片分类委托统一快照 owner；来源库只读、限制 36 张且不建立第二数据库", () => {
    const catalog = source("src/core/studio-global-image-resource-catalog.ts");
    const projection = source("src/core/studio-global-image-resource-projection.ts");
    const unified = source("src/core/studio-global-asset-catalog.ts");

    expect(catalog).toContain("export async function listGlobalStudioImageResources(");
    expect(catalog).toContain("export async function getGlobalStudioImageResource(");
    expect(catalog).toContain("listGlobalStudioImageResourcesFromUnifiedCatalog(query)");
    expect(catalog).toContain(
      "getGlobalStudioImageResourceFromUnifiedCatalog(projectRoot, mediaSha256)",
    );
    expect(catalog).not.toContain("new DatabaseSync(");
    expect(catalog).not.toContain("listRegisteredProjects");
    expect(projection).not.toContain("studio-global-asset-catalog");
    expect(projection).not.toContain("listRegisteredProjects");
    expect(projection).not.toContain("new DatabaseSync(");
    expect(unified).toContain("new DatabaseSync(databasePath, { readOnly: true })");
    expect(unified).toContain('db.exec("PRAGMA query_only = ON")');
    expect(unified).toContain("listRegisteredProjects");
    expect(unified).toContain(
      "export async function listGlobalStudioImageResourcesFromUnifiedCatalog(",
    );
    expect(unified).toContain(
      "export async function getGlobalStudioImageResourceFromUnifiedCatalog(",
    );
    expect(unified).toContain("const MAX_REGISTERED_PROJECTS = 200");
    expect(projection).toContain("const MAX_PAGE_LIMIT = 36");
    expect(projection).toContain("projectImageEntries");
    expect(projection).toContain("uniqueContentSha256");
    expect(projection).toContain("classificationStateCounts");
    expect(projection).toContain("studio_media_imports");
    expect(projection).not.toContain("readdir(");
    expect(projection).not.toContain("watch(");
    expect(projection).not.toContain("CREATE TABLE");

    const publicTypeStart = projection.indexOf("export interface GlobalStudioImageResourceItem");
    const queryTypeStart = projection.indexOf("export interface GlobalStudioImageResourceQuery");
    const publicItem = projection.slice(publicTypeStart, queryTypeStart);
    expect(publicItem).toContain("displayName: string");
    expect(publicItem).toContain("sourceNames: string[]");
    expect(publicItem).toContain("classification: StudioGlobalImageClassification");
    expect(publicItem).not.toContain("sourcePath:");
    expect(publicItem).not.toContain("object_relpath");
    expect(publicItem).not.toContain("objectPath");
  });
});
