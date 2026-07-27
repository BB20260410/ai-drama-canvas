/**
 * 本库 OTIO 子集能力矩阵 + 文档形状轻量校验（OpenTimelineIO 边界加固）。
 * - 不嵌入官方 C++/Python 运行时
 * - 与 editor.ts 导出 schema 对齐：Timeline.1 / Track.1 / Clip.2 / Gap.1 / Transition.1 / Stack.1
 */
export type StudioOtioSupportLevel = "supported" | "partial" | "rejected";

export interface StudioOtioCapabilityRow {
  schema: string;
  level: StudioOtioSupportLevel;
  note: string;
}

export interface StudioOtioCapabilityMatrix {
  schemaVersion: 1;
  kind: "studio-otio-capability-matrix";
  contractFamily: "aicanvas.otio";
  rows: StudioOtioCapabilityRow[];
}

export interface StudioOtioDocumentProbeResult {
  schemaVersion: 1;
  kind: "studio-otio-document-probe";
  ok: boolean;
  rootSchema?: string;
  supportedSchemaHits: string[];
  rejectedSchemaHits: string[];
  unknownSchemaHits: string[];
  issues: string[];
}

/** 与 editor 导出一致的能力表（权威文档化，供回归）。 */
export function getStudioOtioCapabilityMatrix(): StudioOtioCapabilityMatrix {
  return {
    schemaVersion: 1,
    kind: "studio-otio-capability-matrix",
    contractFamily: "aicanvas.otio",
    rows: [
      { schema: "Timeline.1", level: "supported", note: "export/import 根文档" },
      { schema: "Stack.1", level: "supported", note: "tracks 栈 / 嵌套时间线" },
      { schema: "Track.1", level: "supported", note: "Video/Audio 轨" },
      { schema: "Clip.2", level: "supported", note: "媒体片段 + aicanvas metadata" },
      { schema: "Gap.1", level: "supported", note: "空隙" },
      { schema: "Transition.1", level: "partial", note: "仅 SMPTE_Dissolve + 本库合同" },
      { schema: "LinearTimeWarp.1", level: "supported", note: "playbackRate ≠ 1" },
      { schema: "ExternalReference.1", level: "supported", note: "file URL 媒体引用" },
      { schema: "MissingReference.1", level: "supported", note: "缺媒体占位" },
      { schema: "RationalTime.1", level: "supported", note: "时间基数" },
      { schema: "TimeRange.1", level: "supported", note: "区间" },
      { schema: "SerializableCollection.1", level: "rejected", note: "集合容器不导入为剪辑工程" },
      { schema: "Marker.1", level: "rejected", note: "标记未映射" },
      { schema: "Effect.1", level: "rejected", note: "通用 Effect 不导入；仅已知 warp/transition" },
      { schema: "Clip.1", level: "rejected", note: "旧 Clip.1 不接受（导出用 Clip.2）" },
    ],
  };
}

function collectSchemas(node: unknown, out: Set<string>, depth = 0): void {
  if (depth > 40 || node == null) return;
  if (Array.isArray(node)) {
    for (const item of node) collectSchemas(item, out, depth + 1);
    return;
  }
  if (typeof node !== "object") return;
  const record = node as Record<string, unknown>;
  if (typeof record.OTIO_SCHEMA === "string") out.add(record.OTIO_SCHEMA);
  for (const value of Object.values(record)) collectSchemas(value, out, depth + 1);
}

/**
 * 对 OTIO 类 JSON 文档做轻量 probe：是否根为 Timeline、有无拒绝 schema。
 * 不替代 importEditProjectOtio 的完整语义校验。
 */
export function probeStudioOtioDocument(document: unknown): StudioOtioDocumentProbeResult {
  const issues: string[] = [];
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    return {
      schemaVersion: 1,
      kind: "studio-otio-document-probe",
      ok: false,
      supportedSchemaHits: [],
      rejectedSchemaHits: [],
      unknownSchemaHits: [],
      issues: ["文档必须是对象。"],
    };
  }

  const root = document as Record<string, unknown>;
  const rootSchema = typeof root.OTIO_SCHEMA === "string" ? root.OTIO_SCHEMA : undefined;
  if (rootSchema !== "Timeline.1") {
    issues.push(`根 OTIO_SCHEMA 须为 Timeline.1，实际：${rootSchema ?? "missing"}`);
  }

  const matrix = getStudioOtioCapabilityMatrix();
  const levelBySchema = new Map(matrix.rows.map((row) => [row.schema, row.level]));
  const found = new Set<string>();
  collectSchemas(document, found);

  const supportedSchemaHits: string[] = [];
  const rejectedSchemaHits: string[] = [];
  const unknownSchemaHits: string[] = [];

  for (const schema of [...found].sort()) {
    const level = levelBySchema.get(schema);
    if (level === "supported" || level === "partial") supportedSchemaHits.push(schema);
    else if (level === "rejected") {
      rejectedSchemaHits.push(schema);
      issues.push(`含拒绝 schema：${schema}`);
    } else {
      unknownSchemaHits.push(schema);
      issues.push(`含未知 schema：${schema}`);
    }
  }

  return {
    schemaVersion: 1,
    kind: "studio-otio-document-probe",
    ok: issues.length === 0,
    rootSchema,
    supportedSchemaHits,
    rejectedSchemaHits,
    unknownSchemaHits,
    issues,
  };
}
