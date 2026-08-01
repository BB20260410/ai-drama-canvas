import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "@vue/compiler-sfc";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = (relative: string): string => readFileSync(path.join(root, relative), "utf8");

describe("画布媒体原生拖出 IPC 合同", () => {
  it("renderer 只持有一次性 token，主进程绑定 webContents 并同步 startDrag", () => {
    const preload = source("src/preload/index.ts");
    const main = source("src/main/index.ts");
    const preloadSlice = preload.slice(
      preload.indexOf("prepareStudioMediaExport:"),
      preload.indexOf("backupManagedProject:"),
    );

    expect(preloadSlice).toContain("token: string");
    expect(preloadSlice).toContain('ipcRenderer.send("canvas:start-native-file-drag", token)');
    expect(preloadSlice).not.toContain("exportPath:");
    expect(main).toContain("prepareStudioNativeMediaDragCopy");
    expect(main).toContain("StudioNativeMediaDragResourceManager");
    expect(main).toContain("cleanupStaleStudioNativeMediaDragDirectories");
    expect(main).toContain("await initializeStudioNativeMediaDragResources()");
    expect(main).toContain("nativeMediaDragResources.prepare(async () =>");
    expect(main).toContain("webContentsId: event.sender.id");
    expect(main).toContain("prepared.webContentsId !== event.sender.id");
    expect(main).toContain("samePreparedDragIdentity");
    expect(main).toContain("nativeMediaDragResources.takePrepared(token)");
    expect(main).toContain("nativeMediaDragResources.beginOsHandoff(prepared)");
    expect(main).toContain("event.sender.startDrag({ file: prepared.exportPath, icon: prepared.icon })");
    expect(main).toContain("nativeMediaDragResources.finishOsHandoff(prepared)");
    expect(main).toContain("studioNativeMediaDragResources?.cleanupForExit()");
    expect(main).not.toContain("event.sender.startDrag({ file: resolved");
  });

  it("缩略图不参与浏览器默认拖拽，独立手柄覆盖图片、视频、音频复制体", () => {
    const node = source("src/renderer/src/components/ManagedStudioCanvasNode.vue");
    const canvas = source("src/renderer/src/components/ManagedStudioCanvasView.vue");
    expect(parse(node, { filename: "ManagedStudioCanvasNode.vue" }).errors).toEqual([]);
    expect(parse(canvas, { filename: "ManagedStudioCanvasView.vue" }).errors).toEqual([]);

    expect(node).toContain('draggable="false"');
    expect(node).toContain("-webkit-user-drag: none");
    expect(node).toContain('class="media-export-handle nodrag nopan"');
    expect(node).toContain("preparedExportToken");
    expect(node).toContain("prepareStudioMediaExport");
    expect(node).toContain("startNativeFileDrag(preparedExportToken.value)");
    expect(node).toContain('case "audio": return "音"');
    expect(node).toContain("画布原件会保留");

    expect(canvas).toContain('{ kind: "media", label: "媒体", mark: "媒" }');
    expect(canvas).toContain('data-testid="managed-canvas-media-library"');
    expect(canvas).toContain("STUDIO_CANVAS_MEDIA_PAGE_LIMIT = 36");
    expect(canvas).toContain("STUDIO_CANVAS_PINNED_MEDIA_LIMIT = 12");
    expect(canvas).toContain("listStudioMedia(projectRoot");
    expect(canvas).toContain("library-media:");
    expect(canvas).toContain("exportMediaSha256: media.sha256");
    expect(canvas).toContain('kind: mediaKind');
    expect(canvas).toContain("图片、视频或音频文件");
  });
});
