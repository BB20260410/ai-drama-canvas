import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { ProjectConfig, WorkItemStatus } from "./types.js";

// P2-3（main 审查 F-09）：默认工程根不再硬编码开发者机器路径，改为用户文档目录（仍支持环境变量覆盖）。
export const DEFAULT_PROJECT_ROOT = process.env.AI_CANVAS_PROJECT_ROOT || path.join(os.homedir(), "Documents", "Ai漫剧");
export const SIDECAR_DIR = ".aicanvas";

export const DEFAULT_IGNORE_SEGMENTS = [
  "旧版",
  "弃用",
  "废弃",
  "备份",
  "archive",
  "deprecated",
  "__pycache__",
  ".git",
  ".aicanvas",
];

export const STATUS_PRIORITY: Record<WorkItemStatus, number> = {
  返工: 0,
  阻塞: 99,
  待机械验收: 1,
  待视觉验收: 2,
  待尾帧: 3,
  待首帧: 4,
  待提示词: 5,
  待规划: 6,
  待视频验收: 7,
  待视频: 8,
  视频生成中: 9,
  已完成: 100,
  弃用: 101,
};

export function createDefaultProjectConfig(root = DEFAULT_PROJECT_ROOT): ProjectConfig {
  const now = new Date().toISOString();
  const fallbackName = root.split(/[\\/]/).filter(Boolean).at(-1) || "AI 漫剧项目";
  const absoluteRoot = path.resolve(root);
  return {
    schemaVersion: 1,
    id: `project-${createHash("sha1").update(absoluteRoot).digest("hex").slice(0, 12)}`,
    name: fallbackName,
    primaryRoot: absoluteRoot,
    sourceRoots: [],
    outputRoots: [absoluteRoot],
    ignoreSegments: [...DEFAULT_IGNORE_SEGMENTS],
    namingRules: { patterns: [], manualMappings: [] },
    hardLocks: [],
    automation: {
      imageBatchSize: 6,
      videoBatchSize: 3,
      pauseAfterVisualBatch: true,
      allowOverwriteAuthoritative: false,
    },
    createdAt: now,
    updatedAt: now,
  };
}
