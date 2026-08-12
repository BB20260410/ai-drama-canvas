import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = (relative: string): string => readFileSync(path.join(root, relative), "utf8");

describe("全局音视频资源 IPC 合同", () => {
  it("main 与 preload 暴露同名只读列表和单项查询", () => {
    const main = source("src/main/index.ts");
    const registrar = source("src/main/studio-global-resource-read-ipc.ts");
    const preload = source("src/preload/index.ts");

    expect(main).toContain("registerStudioGlobalResourceReadIpc(ipcMain.handle.bind(ipcMain));");
    expect(registrar).toContain("listGlobalStudioMediaResources,");
    expect(registrar).toContain("getGlobalStudioMediaResource,");
    expect(registrar).toContain("type GlobalStudioMediaResourceQuery,");
    expect(registrar).toContain('handle("canvas:list-global-studio-media-resources"');
    expect(registrar).toContain("services.listGlobalStudioMediaResources(query)");
    expect(registrar).toContain('handle("canvas:get-global-studio-media-resource"');
    expect(registrar).toContain("services.getGlobalStudioMediaResource(projectRoot, mediaSha256)");

    expect(preload).toContain("listGlobalStudioMediaResources:");
    expect(preload).toContain(
      'ipcRenderer.invoke("canvas:list-global-studio-media-resources", query)',
    );
    expect(preload).toContain("getGlobalStudioMediaResource:");
    expect(preload).toContain(
      'ipcRenderer.invoke("canvas:get-global-studio-media-resource", projectRoot, mediaSha256)',
    );
  });

  it("Core 只读打开来源库，限制 36 项且不调用派生生成 owner", () => {
    const catalog = source("src/core/studio-global-asset-catalog.ts");

    expect(catalog).toContain('export type GlobalStudioMediaResourceKind = "audio" | "video"');
    expect(catalog).toContain("export async function listGlobalStudioMediaResources(");
    expect(catalog).toContain("export async function getGlobalStudioMediaResource(");
    expect(catalog).toContain("new DatabaseSync(databasePath, { readOnly: true })");
    expect(catalog).toContain('db.exec("PRAGMA query_only = ON")');
    expect(catalog).toContain("const MAX_PAGE_LIMIT = 36");
    expect(catalog).toContain("const MAX_REGISTERED_PROJECTS = 200");
    expect(catalog).toContain("previewCoverage");
    expect(catalog).toContain("videoPosterReady");
    expect(catalog).toContain("videoProxyReady");
    expect(catalog).toContain("audioWaveformReady");
    expect(catalog).not.toContain("materializeStudioMediaDerivatives");
    expect(catalog).not.toContain("prepareStudioMediaDerivatives");

    const publicTypeStart = catalog.indexOf("export interface GlobalStudioMediaResourceItem");
    const queryTypeStart = catalog.indexOf("export interface GlobalStudioMediaResourceQuery");
    expect(publicTypeStart).toBeGreaterThanOrEqual(0);
    expect(queryTypeStart).toBeGreaterThan(publicTypeStart);
    const publicItem = catalog.slice(publicTypeStart, queryTypeStart);
    expect(publicItem).toContain("mediaSha256: string");
    expect(publicItem).toContain("sourceBasename: string");
    expect(publicItem).toContain('kind: "video_poster" | "audio_waveform"');
    expect(publicItem).toContain('kind: "video_proxy"');
    expect(publicItem).not.toContain("object_relpath");
    expect(publicItem).not.toContain("relative_path");
    expect(publicItem).not.toContain("objectPath");
  });
});
