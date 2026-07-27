import type { Artifact, WorkItemStatus } from "@core/types";

export function assetUrl(filePath?: string, expectedSha256?: string): string {
  if (!filePath) return "";
  const sha = expectedSha256 ? `&sha256=${encodeURIComponent(expectedSha256)}` : "";
  return `aicanvas-asset://file/?path=${encodeURIComponent(filePath)}${sha}`;
}

/** 旧画布节点缩略图 URL：主进程懒生成 512px WebP 并缓存，失败时回退原图。 */
export function assetThumbnailUrl(filePath?: string): string {
  if (!filePath) return "";
  return `aicanvas-asset://file/?path=${encodeURIComponent(filePath)}&thumb=1`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`;
  if (bytes < 1_073_741_824) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
}

export function statusClass(status: WorkItemStatus): string {
  if (status === "已完成") return "status-complete";
  if (status === "弃用") return "status-muted";
  if (status === "阻塞" || status === "返工") return "status-danger";
  if (status.includes("验收")) return "status-review";
  if (status.includes("视频")) return "status-video";
  return "status-active";
}

export function authoritativeArtifacts(artifacts: Artifact[]): Artifact[] {
  return artifacts.filter((artifact) => artifact.authoritative && !artifact.deprecated);
}
