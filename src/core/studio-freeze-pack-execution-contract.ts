/**
 * 冻结执行包最小合同校验（S1E2+canvas 共生环）。
 * 主线程编译 pack 后、派生子代理前必须通过；不读画布全书。
 */

export type FreezePackStyleCode = "R-CINE" | "R-EPIC" | "R-NIGHT";
export type FreezePackTargetKind = "unit-grid" | "panel";
export type FreezePackAuthorityLineage = "codex-user-locked-v1" | "grok-original-20260723";

export interface FreezePackControlReference {
  role: "CHARACTER_IDENTITY" | "SCENE_TOPOLOGY" | "SCENE_MASTER_EMPTY" | "PROP_IDENTITY" | "STYLE_ONLY";
  assetId: string;
  sha256: string;
  path: string;
  order?: number;
}

export interface StudioFreezePackExecutionContract {
  schemaVersion: 1;
  kind: "execution-freeze-pack";
  packId: string;
  fingerprint?: string;
  dispatch_allowed: boolean;
  target: {
    targetKind: FreezePackTargetKind;
    unitId: string;
    panelCount: number;
    durationSeconds: number;
    exactlyOneImage: true;
    maxCalls: 1;
    layout?: string;
  };
  frameLock: { aspect_ratio: "9:16"; orientation?: "vertical" };
  styleLock: { code: FreezePackStyleCode; path: string; sha256: string };
  authority_lineage: FreezePackAuthorityLineage;
  controlReferences: FreezePackControlReference[];
  governance: {
    concurrency: 1;
    agentMayChooseRefs: false;
    agentMayRereadProject: false;
  };
  modelPayload?: {
    aspect_ratio: "9:16";
    renderedPrompt: string;
    negative?: string[];
  };
  outputs?: {
    candidate_raw: string;
  };
}

export type FreezePackValidationIssue = { code: string; message: string };

const SHA256_RE = /^[a-f0-9]{64}$/i;

export function validateStudioFreezePackExecutionContract(
  pack: unknown,
): { ok: true; pack: StudioFreezePackExecutionContract } | { ok: false; issues: FreezePackValidationIssue[] } {
  const issues: FreezePackValidationIssue[] = [];
  if (!pack || typeof pack !== "object") {
    return { ok: false, issues: [{ code: "not-object", message: "pack 必须是对象" }] };
  }
  const p = pack as Record<string, unknown>;

  if (p.schemaVersion !== 1) issues.push({ code: "schemaVersion", message: "schemaVersion 必须为 1" });
  if (p.kind !== "execution-freeze-pack") issues.push({ code: "kind", message: "kind 必须为 execution-freeze-pack" });
  if (typeof p.packId !== "string" || !p.packId.trim()) issues.push({ code: "packId", message: "packId 必填" });
  if (p.dispatch_allowed !== true && p.dispatch_allowed !== false) {
    issues.push({ code: "dispatch_allowed", message: "dispatch_allowed 必填 boolean" });
  }

  const target = p.target as Record<string, unknown> | undefined;
  if (!target) {
    issues.push({ code: "target", message: "target 必填" });
  } else {
    if (target.targetKind !== "unit-grid" && target.targetKind !== "panel") {
      issues.push({ code: "targetKind", message: "targetKind 必须 unit-grid|panel" });
    }
    if (typeof target.unitId !== "string" || !/^S\d+E\d+-U\d+$/i.test(target.unitId) && !/^S1E2-U\d+$/i.test(target.unitId)) {
      // allow S1E2-U01 style
      if (typeof target.unitId !== "string" || !target.unitId.includes("-U")) {
        issues.push({ code: "unitId", message: "unitId 格式无效" });
      }
    }
    if (target.exactlyOneImage !== true) issues.push({ code: "exactlyOneImage", message: "exactlyOneImage 必须 true" });
    if (target.maxCalls !== 1) issues.push({ code: "maxCalls", message: "maxCalls 必须 1" });
    if (typeof target.panelCount !== "number" || target.panelCount < 1 || target.panelCount > 6) {
      issues.push({ code: "panelCount", message: "panelCount 必须 1–6" });
    }
    if (typeof target.durationSeconds !== "number" || target.durationSeconds <= 0) {
      issues.push({ code: "durationSeconds", message: "durationSeconds 必须 > 0" });
    }
    if (target.targetKind === "unit-grid" && target.layout !== "9:16-vertical-ordered-grid") {
      issues.push({ code: "layout", message: "unit-grid layout 必须 9:16-vertical-ordered-grid" });
    }
  }

  const frame = p.frameLock as Record<string, unknown> | undefined;
  if (!frame || frame.aspect_ratio !== "9:16") {
    issues.push({ code: "frameLock", message: "frameLock.aspect_ratio 必须 9:16" });
  }

  const style = p.styleLock as Record<string, unknown> | undefined;
  if (!style || !["R-CINE", "R-EPIC", "R-NIGHT"].includes(String(style.code))) {
    issues.push({ code: "styleLock.code", message: "styleLock.code 必须 R-CINE|R-EPIC|R-NIGHT" });
  } else {
    if (typeof style.path !== "string" || !style.path) issues.push({ code: "styleLock.path", message: "styleLock.path 必填" });
    if (typeof style.sha256 !== "string" || !SHA256_RE.test(style.sha256)) {
      issues.push({ code: "styleLock.sha256", message: "styleLock.sha256 必须 64 hex" });
    }
  }

  if (p.authority_lineage !== "codex-user-locked-v1" && p.authority_lineage !== "grok-original-20260723") {
    issues.push({ code: "authority_lineage", message: "authority_lineage 必须二选一且不得混用" });
  }

  const refs = p.controlReferences;
  if (!Array.isArray(refs) || refs.length < 1 || refs.length > 6) {
    issues.push({ code: "controlReferences", message: "controlReferences 长度 1–6" });
  } else {
    const hasChar = refs.some((r) => (r as FreezePackControlReference).role === "CHARACTER_IDENTITY");
    if (!hasChar) issues.push({ code: "controlReferences.char", message: "至少一条 CHARACTER_IDENTITY" });
    for (let i = 0; i < refs.length; i++) {
      const r = refs[i] as FreezePackControlReference;
      if (!r?.assetId || !r.path) issues.push({ code: `ref[${i}]`, message: "assetId/path 必填" });
      if (!r?.sha256 || !SHA256_RE.test(r.sha256)) issues.push({ code: `ref[${i}].sha`, message: "sha256 必须 64 hex" });
    }
  }

  const gov = p.governance as Record<string, unknown> | undefined;
  if (!gov || gov.concurrency !== 1) issues.push({ code: "concurrency", message: "governance.concurrency 必须 1" });
  if (!gov || gov.agentMayChooseRefs !== false) {
    issues.push({ code: "agentMayChooseRefs", message: "agentMayChooseRefs 必须 false" });
  }
  if (!gov || gov.agentMayRereadProject !== false) {
    issues.push({ code: "agentMayRereadProject", message: "agentMayRereadProject 必须 false" });
  }

  if (issues.length) return { ok: false, issues };
  return { ok: true, pack: pack as StudioFreezePackExecutionContract };
}

/** 生成内容指纹（稳定 JSON 字符串 sha 前由调用方算；此处提供 canonical 串） */
export function canonicalFreezePackForFingerprint(pack: StudioFreezePackExecutionContract): string {
  return JSON.stringify(pack, Object.keys(pack).sort());
}
