import type { IpcMain } from "electron";
import {
  getGlobalStudioAssetResourceImage,
  getGlobalStudioMediaResource,
  listGlobalStudioAssetCatalog,
  listGlobalStudioAssetResourceImages,
  listGlobalStudioMediaResources,
  type GlobalStudioAssetCatalogQuery,
  type GlobalStudioAssetResourceImageQuery,
  type GlobalStudioMediaResourceQuery,
} from "../core/studio-global-asset-catalog.js";
import {
  getGlobalStudioImageResource,
  listGlobalStudioImageResources,
  type GlobalStudioImageResourceQuery,
} from "../core/studio-global-image-resource-catalog.js";

/**
 * 全局 Material Studio 资源的只读 IPC 适配器。
 *
 * 调用方必须传入已经安装 runtime write gate 的 handle；本模块不持有 Electron
 * 单例，也不建立缓存、数据库或任何业务状态。
 */
export interface StudioGlobalResourceReadIpcServices {
  listGlobalStudioAssetCatalog: typeof listGlobalStudioAssetCatalog;
  listGlobalStudioAssetResourceImages: typeof listGlobalStudioAssetResourceImages;
  getGlobalStudioAssetResourceImage: typeof getGlobalStudioAssetResourceImage;
  listGlobalStudioImageResources: typeof listGlobalStudioImageResources;
  getGlobalStudioImageResource: typeof getGlobalStudioImageResource;
  listGlobalStudioMediaResources: typeof listGlobalStudioMediaResources;
  getGlobalStudioMediaResource: typeof getGlobalStudioMediaResource;
}

const defaultServices: StudioGlobalResourceReadIpcServices = {
  listGlobalStudioAssetCatalog,
  listGlobalStudioAssetResourceImages,
  getGlobalStudioAssetResourceImage,
  listGlobalStudioImageResources,
  getGlobalStudioImageResource,
  listGlobalStudioMediaResources,
  getGlobalStudioMediaResource,
};

export function registerStudioGlobalResourceReadIpc(
  handle: IpcMain["handle"],
  services: StudioGlobalResourceReadIpcServices = defaultServices,
): void {
  handle("canvas:list-global-studio-assets", (_event, query: GlobalStudioAssetCatalogQuery) => (
    services.listGlobalStudioAssetCatalog(query)
  ));
  handle("canvas:list-global-studio-asset-images", (_event, query: GlobalStudioAssetResourceImageQuery) => (
    services.listGlobalStudioAssetResourceImages(query)
  ));
  handle("canvas:get-global-studio-asset-image", (_event, projectRoot: string, mediaSha256: string) => (
    services.getGlobalStudioAssetResourceImage(projectRoot, mediaSha256)
  ));
  handle("canvas:list-global-studio-image-resources", (_event, query: GlobalStudioImageResourceQuery) => (
    services.listGlobalStudioImageResources(query)
  ));
  handle("canvas:get-global-studio-image-resource", (_event, projectRoot: string, mediaSha256: string) => (
    services.getGlobalStudioImageResource(projectRoot, mediaSha256)
  ));
  handle("canvas:list-global-studio-media-resources", (_event, query: GlobalStudioMediaResourceQuery) => (
    services.listGlobalStudioMediaResources(query)
  ));
  handle("canvas:get-global-studio-media-resource", (_event, projectRoot: string, mediaSha256: string) => (
    services.getGlobalStudioMediaResource(projectRoot, mediaSha256)
  ));
}
