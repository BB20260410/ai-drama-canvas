import { createHash } from "node:crypto";
import type {
  LocalCreativeIngestFile,
  LocalCreativeProjectIngestPreview,
} from "./local-creative-project-ingest.js";

export type LocalCreativeDocumentClass =
  | "script"
  | "prompt"
  | "storyboard"
  | "bible"
  | "index"
  | "qc"
  | "manifest"
  | "log"
  | "other";

export interface LocalCreativeSourceDocumentRecord {
  fileId: string;
  relativePath: string;
  extension: string;
  sourceLayerRole: string;
  sourceStatus: string;
  classification: LocalCreativeDocumentClass;
  confidence: "high" | "medium" | "low";
  evidenceRule: string;
  importTarget: "script" | "prompt" | "inventory-only" | "unsupported" | "rejected";
  sizeBytes: number;
  mtimeMs: number;
  sourceSha256?: string;
}

export interface LocalCreativeSourceDocumentInventory {
  schemaVersion: 1;
  kind: "local-creative-source-document-inventory";
  sourceFingerprint: string;
  total: number;
  byClass: Record<LocalCreativeDocumentClass, number>;
  byImportTarget: Record<LocalCreativeSourceDocumentRecord["importTarget"], number>;
  items: LocalCreativeSourceDocumentRecord[];
  fingerprint: string;
  builtAt: string;
}

const CLASS_RULES: Array<{
  classification: Exclude<LocalCreativeDocumentClass, "other">;
  pattern: RegExp;
  evidenceRule: string;
}> = [
  { classification: "prompt", pattern: /提示词|prompt|negative.?prompt|binding.?set|camera.?score/iu, evidenceRule: "name:prompt" },
  { classification: "storyboard", pattern: /分镜|故事板|宫格|storyboard|shot.?card|镜头表|逐镜/iu, evidenceRule: "name:storyboard" },
  { classification: "bible", pattern: /设定|圣经|角色卡|人物卡|场景卡|道具卡|资产卡|story.?bible|character.?bible|世界观/iu, evidenceRule: "name:bible" },
  { classification: "qc", pattern: /验收|审片|质检|审核|裁决|合同|review|acceptance|\bqc\b|audit/iu, evidenceRule: "name:qc" },
  { classification: "index", pattern: /索引|总表|交接|任务|状态|台账|目录|index|status|tasks|ledger|handoff/iu, evidenceRule: "name:index" },
  { classification: "manifest", pattern: /manifest|schema|receipt|fingerprint|清单|声明/iu, evidenceRule: "name:manifest" },
  { classification: "log", pattern: /日志|记录|进度|运行报告|变更记录|\blog\b|progress|changelog/iu, evidenceRule: "name:log" },
  { classification: "script", pattern: /剧本|脚本|文案|旁白|screenplay|script|episode|(?:^|[/_.-])ep\d+|S\d+E\d+|第.{0,8}集/iu, evidenceRule: "name:script" },
];

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function emptyClassCounts(): Record<LocalCreativeDocumentClass, number> {
  return {
    script: 0,
    prompt: 0,
    storyboard: 0,
    bible: 0,
    index: 0,
    qc: 0,
    manifest: 0,
    log: 0,
    other: 0,
  };
}

function emptyImportTargetCounts(): Record<LocalCreativeSourceDocumentRecord["importTarget"], number> {
  return { script: 0, prompt: 0, "inventory-only": 0, unsupported: 0, rejected: 0 };
}

export function classifyLocalCreativeSourceDocument(
  file: LocalCreativeIngestFile,
): LocalCreativeSourceDocumentRecord {
  const normalized = `${file.relativePath}\n${file.basename}`.normalize("NFKC");
  const matched = CLASS_RULES.find((rule) => rule.pattern.test(normalized));
  const classification = matched?.classification ?? "other";
  const supportedText = file.extension === ".md" || file.extension === ".txt";
  const rejected = file.status === "REJECTED_OR_FORBIDDEN";
  const importTarget: LocalCreativeSourceDocumentRecord["importTarget"] = rejected
    ? "rejected"
    : !supportedText
      ? "unsupported"
      : classification === "script" || classification === "prompt"
        ? classification
        : "inventory-only";
  return {
    fileId: file.fileId,
    relativePath: file.relativePath,
    extension: file.extension,
    sourceLayerRole: file.sourceLayer.role,
    sourceStatus: file.status,
    classification,
    confidence: matched ? "high" : "low",
    evidenceRule: matched?.evidenceRule ?? "name:no-semantic-match",
    importTarget,
    sizeBytes: file.sizeBytes,
    mtimeMs: file.mtimeMs,
    ...(file.sha256 ? { sourceSha256: file.sha256 } : {}),
  };
}

export function buildLocalCreativeSourceDocumentInventory(
  preview: LocalCreativeProjectIngestPreview,
): LocalCreativeSourceDocumentInventory {
  const items = preview.files
    .filter((file) => file.mediaKind === "document")
    .map(classifyLocalCreativeSourceDocument)
    .sort((left, right) => (
      left.relativePath.localeCompare(right.relativePath, "zh-CN")
      || left.fileId.localeCompare(right.fileId, "en")
    ));
  const byClass = emptyClassCounts();
  const byImportTarget = emptyImportTargetCounts();
  for (const item of items) {
    byClass[item.classification] += 1;
    byImportTarget[item.importTarget] += 1;
  }
  const sourceFingerprint = digest(items.map((item) => ({
    fileId: item.fileId,
    relativePath: item.relativePath,
    sizeBytes: item.sizeBytes,
    mtimeMs: item.mtimeMs,
    sourceSha256: item.sourceSha256 ?? null,
  })));
  const body = {
    schemaVersion: 1 as const,
    kind: "local-creative-source-document-inventory" as const,
    sourceFingerprint,
    total: items.length,
    byClass,
    byImportTarget,
    items,
  };
  return {
    ...body,
    fingerprint: digest(body),
    builtAt: new Date().toISOString(),
  };
}
