/**
 * Wave 4-D：MCP 只读诊断面冷域。启动路径不得静态拉 earliest / dashboard /
 * projection-bundle / multimedia-timeline / post-result-observation / write-lease /
 * script-reader / script-media-align。
 * 写路径仍走 command-bus 原命令与 executor 调度；此处只延迟加载同一模块。
 */
export type StudioEpisodeEarliestModule = typeof import("./studio-episode-earliest.js");
export type StudioProductionProjectionBundleModule = typeof import("./studio-production-projection-bundle.js");
export type StudioProductionDashboardModule = typeof import("./studio-production-dashboard.js");
export type StudioMultimediaTimelineModule = typeof import("./studio-multimedia-timeline.js");
export type StudioPostResultObservationModule = typeof import("./studio-post-result-observation.js");
export type StudioProjectWriteLeaseModule = typeof import("./studio-project-write-lease.js");
export type StudioScriptLibraryReaderModule = typeof import("./studio-script-library-reader.js");
export type StudioScriptMediaAlignModule = typeof import("./studio-script-media-align.js");
export type StudioSsl5MissingToGenModule = typeof import("./studio-ssl5-missing-to-gen.js");

let episodeEarliestModule: Promise<StudioEpisodeEarliestModule> | undefined;
let projectionBundleModule: Promise<StudioProductionProjectionBundleModule> | undefined;
let productionDashboardModule: Promise<StudioProductionDashboardModule> | undefined;
let multimediaTimelineModule: Promise<StudioMultimediaTimelineModule> | undefined;
let postResultObservationModule: Promise<StudioPostResultObservationModule> | undefined;
let projectWriteLeaseModule: Promise<StudioProjectWriteLeaseModule> | undefined;
let scriptLibraryReaderModule: Promise<StudioScriptLibraryReaderModule> | undefined;
let scriptMediaAlignModule: Promise<StudioScriptMediaAlignModule> | undefined;
let ssl5MissingToGenModule: Promise<StudioSsl5MissingToGenModule> | undefined;

export function loadStudioEpisodeEarliest(): Promise<StudioEpisodeEarliestModule> {
  episodeEarliestModule ??= import("./studio-episode-earliest.js");
  return episodeEarliestModule;
}

export function loadStudioProductionProjectionBundle(): Promise<StudioProductionProjectionBundleModule> {
  projectionBundleModule ??= import("./studio-production-projection-bundle.js");
  return projectionBundleModule;
}

export function loadStudioProductionDashboard(): Promise<StudioProductionDashboardModule> {
  productionDashboardModule ??= import("./studio-production-dashboard.js");
  return productionDashboardModule;
}

export function loadStudioMultimediaTimeline(): Promise<StudioMultimediaTimelineModule> {
  multimediaTimelineModule ??= import("./studio-multimedia-timeline.js");
  return multimediaTimelineModule;
}

export function loadStudioPostResultObservation(): Promise<StudioPostResultObservationModule> {
  postResultObservationModule ??= import("./studio-post-result-observation.js");
  return postResultObservationModule;
}

export function loadStudioProjectWriteLease(): Promise<StudioProjectWriteLeaseModule> {
  projectWriteLeaseModule ??= import("./studio-project-write-lease.js");
  return projectWriteLeaseModule;
}

export function loadStudioScriptLibraryReader(): Promise<StudioScriptLibraryReaderModule> {
  scriptLibraryReaderModule ??= import("./studio-script-library-reader.js");
  return scriptLibraryReaderModule;
}

export function loadStudioScriptMediaAlign(): Promise<StudioScriptMediaAlignModule> {
  scriptMediaAlignModule ??= import("./studio-script-media-align.js");
  return scriptMediaAlignModule;
}

export function loadStudioSsl5MissingToGen(): Promise<StudioSsl5MissingToGenModule> {
  ssl5MissingToGenModule ??= import("./studio-ssl5-missing-to-gen.js");
  return ssl5MissingToGenModule;
}

export async function withStudioEpisodeEarliest<T>(
  read: (earliest: StudioEpisodeEarliestModule) => T | Promise<T>,
): Promise<T> {
  return read(await loadStudioEpisodeEarliest());
}

export async function withStudioProductionProjectionBundle<T>(
  read: (bundle: StudioProductionProjectionBundleModule) => T | Promise<T>,
): Promise<T> {
  return read(await loadStudioProductionProjectionBundle());
}

export async function withStudioProductionDashboard<T>(
  read: (dashboard: StudioProductionDashboardModule) => T | Promise<T>,
): Promise<T> {
  return read(await loadStudioProductionDashboard());
}

export async function withStudioMultimediaTimeline<T>(
  read: (timeline: StudioMultimediaTimelineModule) => T | Promise<T>,
): Promise<T> {
  return read(await loadStudioMultimediaTimeline());
}

export async function withStudioPostResultObservation<T>(
  read: (observation: StudioPostResultObservationModule) => T | Promise<T>,
): Promise<T> {
  return read(await loadStudioPostResultObservation());
}

export async function withStudioProjectWriteLease<T>(
  read: (writeLease: StudioProjectWriteLeaseModule) => T | Promise<T>,
): Promise<T> {
  return read(await loadStudioProjectWriteLease());
}

export async function withStudioScriptLibraryReader<T>(
  read: (reader: StudioScriptLibraryReaderModule) => T | Promise<T>,
): Promise<T> {
  return read(await loadStudioScriptLibraryReader());
}

export async function withStudioScriptMediaAlign<T>(
  read: (align: StudioScriptMediaAlignModule) => T | Promise<T>,
): Promise<T> {
  return read(await loadStudioScriptMediaAlign());
}

export async function withStudioSsl5MissingToGen<T>(
  read: (ssl5: StudioSsl5MissingToGenModule) => T | Promise<T>,
): Promise<T> {
  return read(await loadStudioSsl5MissingToGen());
}
