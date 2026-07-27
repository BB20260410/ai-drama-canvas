import type { Artifact, WorkItem } from "./types.js";

export function completionIssues(item: Pick<WorkItem, "type" | "fusionStoryboard">, artifacts: Artifact[]): string[] {
  const active = artifacts.filter((artifact) => artifact.authoritative && !artifact.deprecated);
  const issues: string[] = [];
  const requireArtifact = (label: string, kind: Artifact["kind"], variants?: Artifact["variant"][]) => {
    const match = active.find((artifact) => artifact.kind === kind && (!variants || variants.includes(artifact.variant)));
    if (!match) issues.push(`缺少${label}`);
    else if (!match.check.ok) issues.push(`${label}机械验收失败：${match.check.issues.join("；") || "未知原因"}`);
  };

  if (item.type === "asset") {
    const raw = active.find((artifact) => artifact.kind === "raw-image" && artifact.variant === "generic");
    const labeled = active.find((artifact) => artifact.kind === "labeled-image" && artifact.variant === "generic");
    if (!raw) issues.push("缺少权威资产 raw");
    else if (!raw.check.ok || raw.check.decodable === false) issues.push(`权威资产 raw 机械验收失败：${raw.check.issues.join("；") || "无法解码"}`);
    if (labeled && (!labeled.check.ok || labeled.check.decodable === false)) {
      issues.push(`权威资产 labeled 机械验收失败：${labeled.check.issues.join("；") || "无法解码"}`);
    }
    return issues;
  }
  if (item.type === "shot") {
    requireArtifact("原镜头 raw", "raw-image", ["generic", "start"]);
    requireArtifact("原镜头 labeled", "labeled-image", ["generic", "start"]);
    return issues;
  }
  if (item.type === "unit") {
    if (item.fusionStoryboard) {
      for (const panel of item.fusionStoryboard.panels) {
        const label = `宫格${String(panel.panelIndex).padStart(2, "0")}`;
        const raw = artifacts.find((artifact) => artifact.id === panel.rawArtifactId && artifact.authoritative && !artifact.deprecated);
        const labeled = artifacts.find((artifact) => artifact.id === panel.labeledArtifactId && artifact.authoritative && !artifact.deprecated);
        if (!raw) issues.push(`缺少${label} raw`);
        else if (!raw.check.ok) issues.push(`${label} raw 机械验收失败：${raw.check.issues.join("；") || "未知原因"}`);
        if (!labeled) issues.push(`缺少${label} labeled`);
        else if (!labeled.check.ok) issues.push(`${label} labeled 机械验收失败：${labeled.check.issues.join("；") || "未知原因"}`);
        if (panel.issues.length) issues.push(...panel.issues.map((issue) => `${label} ${issue}`));
      }
      requireArtifact("可解码视频", "video");
      return [...new Set(issues)];
    }
    requireArtifact("首帧 raw", "raw-image", ["start"]);
    requireArtifact("首帧 labeled", "labeled-image", ["start"]);
    requireArtifact("尾帧 raw", "raw-image", ["end"]);
    requireArtifact("尾帧 labeled", "labeled-image", ["end"]);
    requireArtifact("可解码视频", "video");
    return issues;
  }
  issues.push("当前节点类型不支持标记已完成");
  return issues;
}
