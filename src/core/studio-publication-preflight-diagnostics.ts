/**
 * Publication 预检诊断用语（clean-room 对齐 OpenAssetIO preflight/register 语义）。
 * - 不引入 Python Manager
 * - 将本库 Publication 状态映射为可观测诊断码
 * - 可挂到 preflight 回包（额外字段，不破坏既有 intent 字段）
 */

import type { PublicationIntent } from "./publication.js";
export type StudioPublicationLifecyclePhase =
  | "resolve"
  | "preflight"
  | "reserve"
  | "register"
  | "cancel"
  | "fail";

export type StudioPublicationDiagnosticSeverity = "info" | "warning" | "error";

export interface StudioPublicationDiagnostic {
  code: string;
  phase: StudioPublicationLifecyclePhase;
  severity: StudioPublicationDiagnosticSeverity;
  /** OpenAssetIO 风格术语（说明性，非 API 绑定） */
  openAssetIoTerm: string;
  message: string;
  hint?: string;
}

export interface StudioPublicationPreflightReport {
  schemaVersion: 1;
  kind: "studio-publication-preflight-report";
  ok: boolean;
  phase: StudioPublicationLifecyclePhase;
  diagnostics: StudioPublicationDiagnostic[];
}

export class StudioPublicationPreflightError extends Error {
  readonly code = "invalid-input" as const;
  constructor(message: string) {
    super(message);
    this.name = "StudioPublicationPreflightError";
  }
}

/**
 * 根据意图状态构建诊断（视图层；不读盘）。
 */
export function buildStudioPublicationPreflightReport(input: {
  status: "reserved" | "registered" | "cancelled" | "failed" | string;
  hasTargetPath?: boolean;
  hasReservationToken?: boolean;
  purpose?: string;
  reason?: string;
}): StudioPublicationPreflightReport {
  const status = String(input.status ?? "").trim();
  if (!status) throw new StudioPublicationPreflightError("status 不能为空。");

  const diagnostics: StudioPublicationDiagnostic[] = [];

  // resolve：实体是否可定位
  if (input.hasTargetPath === false) {
    diagnostics.push({
      code: "entity-unresolved",
      phase: "resolve",
      severity: "error",
      openAssetIoTerm: "EntityResolutionError",
      message: "目标路径未解析，无法注册实体。",
      hint: "先 reserve 并完成媒体落盘。",
    });
  } else {
    diagnostics.push({
      code: "entity-resolved",
      phase: "resolve",
      severity: "info",
      openAssetIoTerm: "EntityReference",
      message: "实体引用可解析（或尚不需要路径）。",
    });
  }

  // preflight
  if (input.hasReservationToken === false && status === "reserved") {
    diagnostics.push({
      code: "preflight-missing-token",
      phase: "preflight",
      severity: "error",
      openAssetIoTerm: "PreflightFailed",
      message: "reserved 状态缺少 reservationToken。",
    });
  } else {
    diagnostics.push({
      code: "preflight-ok",
      phase: "preflight",
      severity: "info",
      openAssetIoTerm: "managementPolicy / preflight",
      message: "预检字段齐备（本库 sidecar 合同）。",
    });
  }

  // lifecycle phase mapping
  let phase: StudioPublicationLifecyclePhase = "preflight";
  if (status === "reserved") {
    phase = "reserve";
    diagnostics.push({
      code: "lifecycle-reserved",
      phase: "reserve",
      severity: "info",
      openAssetIoTerm: "register (pending)",
      message: "已预留 intent，等待 register。",
    });
  } else if (status === "registered") {
    phase = "register";
    diagnostics.push({
      code: "lifecycle-registered",
      phase: "register",
      severity: "info",
      openAssetIoTerm: "register (success)",
      message: "实体已注册。",
    });
  } else if (status === "cancelled") {
    phase = "cancel";
    diagnostics.push({
      code: "lifecycle-cancelled",
      phase: "cancel",
      severity: "warning",
      openAssetIoTerm: "manager retracted / cancel",
      message: input.reason?.trim() || "发布意图已取消。",
    });
  } else if (status === "failed") {
    phase = "fail";
    diagnostics.push({
      code: "lifecycle-failed",
      phase: "fail",
      severity: "error",
      openAssetIoTerm: "BatchElementError",
      message: input.reason?.trim() || "发布失败。",
    });
  } else {
    diagnostics.push({
      code: "lifecycle-unknown",
      phase: "preflight",
      severity: "error",
      openAssetIoTerm: "UnknownState",
      message: `未知 status：${status}`,
    });
  }

  if (input.purpose) {
    diagnostics.push({
      code: "purpose-tag",
      phase: "preflight",
      severity: "info",
      openAssetIoTerm: "traits / context",
      message: `purpose=${input.purpose}`,
    });
  }

  const ok = !diagnostics.some((d) => d.severity === "error");
  return {
    schemaVersion: 1,
    kind: "studio-publication-preflight-report",
    ok,
    phase,
    diagnostics,
  };
}

/**
 * 从已有 PublicationIntent 生成 OA 风格诊断，并挂到回包（intent 字段原样保留）。
 */
export function enrichPublicationIntentWithDiagnostics<T extends Pick<PublicationIntent, "status" | "targetPath" | "reservationToken" | "context" | "note">>(
  intent: T,
): T & { openAssetIoDiagnostics: StudioPublicationPreflightReport } {
  const report = buildStudioPublicationPreflightReport({
    status: intent.status,
    hasTargetPath: Boolean(intent.targetPath?.trim()),
    hasReservationToken: Boolean(intent.reservationToken?.trim()),
    purpose: intent.context?.purpose,
    reason: intent.note,
  });
  return {
    ...intent,
    openAssetIoDiagnostics: report,
  };
}
