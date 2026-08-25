/**
 * Wave 4-C：local-creative 冷域。启动路径不得静态拉 ingest-status / preview / materializer / inventory / content-import。
 * 写路径仍走 command-bus 原命令与 executor 调度；此处只延迟加载同一模块。
 */
export type LocalCreativeIngestStatusModule = typeof import("./local-creative-project-ingest-status.js");
export type LocalCreativePreviewModule = typeof import("./local-creative-production-unit-preview.js");
export type LocalCreativeMaterializerModule = typeof import("./local-creative-production-unit-materializer.js");
export type LocalCreativeInventoryModule = typeof import("./local-creative-source-inventory.js");
export type LocalCreativeContentImportModule = typeof import("./local-creative-project-content-import.js");

let ingestStatusModule: Promise<LocalCreativeIngestStatusModule> | undefined;
let previewModule: Promise<LocalCreativePreviewModule> | undefined;
let materializerModule: Promise<LocalCreativeMaterializerModule> | undefined;
let inventoryModule: Promise<LocalCreativeInventoryModule> | undefined;
let contentImportModule: Promise<LocalCreativeContentImportModule> | undefined;

export function loadLocalCreativeIngestStatus(): Promise<LocalCreativeIngestStatusModule> {
  ingestStatusModule ??= import("./local-creative-project-ingest-status.js");
  return ingestStatusModule;
}

export function loadLocalCreativePreview(): Promise<LocalCreativePreviewModule> {
  previewModule ??= import("./local-creative-production-unit-preview.js");
  return previewModule;
}

export function loadLocalCreativeMaterializer(): Promise<LocalCreativeMaterializerModule> {
  materializerModule ??= import("./local-creative-production-unit-materializer.js");
  return materializerModule;
}

export function loadLocalCreativeInventory(): Promise<LocalCreativeInventoryModule> {
  inventoryModule ??= import("./local-creative-source-inventory.js");
  return inventoryModule;
}

export function loadLocalCreativeContentImport(): Promise<LocalCreativeContentImportModule> {
  contentImportModule ??= import("./local-creative-project-content-import.js");
  return contentImportModule;
}

export async function withLocalCreativeIngestStatus<T>(
  read: (ingest: LocalCreativeIngestStatusModule) => T | Promise<T>,
): Promise<T> {
  return read(await loadLocalCreativeIngestStatus());
}

export async function withLocalCreativePreview<T>(
  read: (preview: LocalCreativePreviewModule) => T | Promise<T>,
): Promise<T> {
  return read(await loadLocalCreativePreview());
}

export async function withLocalCreativeMaterializer<T>(
  read: (materializer: LocalCreativeMaterializerModule) => T | Promise<T>,
): Promise<T> {
  return read(await loadLocalCreativeMaterializer());
}

export async function withLocalCreativeInventory<T>(
  read: (inventory: LocalCreativeInventoryModule) => T | Promise<T>,
): Promise<T> {
  return read(await loadLocalCreativeInventory());
}

export async function withLocalCreativeContentImport<T>(
  read: (contentImport: LocalCreativeContentImportModule) => T | Promise<T>,
): Promise<T> {
  return read(await loadLocalCreativeContentImport());
}
