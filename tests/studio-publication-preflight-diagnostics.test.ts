import { describe, expect, it } from "vitest";
import {
  buildStudioPublicationPreflightReport,
  enrichPublicationIntentWithDiagnostics,
  StudioPublicationPreflightError,
} from "../src/core/studio-publication-preflight-diagnostics.js";

describe("studio-publication-preflight-diagnostics（OpenAssetIO OA-1）", () => {
  it("registered 全绿诊断", () => {
    const report = buildStudioPublicationPreflightReport({
      status: "registered",
      hasTargetPath: true,
      hasReservationToken: true,
      purpose: "generation-output",
    });
    expect(report.kind).toBe("studio-publication-preflight-report");
    expect(report.ok).toBe(true);
    expect(report.phase).toBe("register");
    expect(report.diagnostics.some((d) => d.openAssetIoTerm.includes("register"))).toBe(true);
  });

  it("缺路径 + failed 报 error", () => {
    const report = buildStudioPublicationPreflightReport({
      status: "failed",
      hasTargetPath: false,
      reason: "本地执行失败",
    });
    expect(report.ok).toBe(false);
    expect(report.phase).toBe("fail");
    expect(report.diagnostics.some((d) => d.code === "entity-unresolved")).toBe(true);
    expect(report.diagnostics.some((d) => d.message.includes("本地执行失败"))).toBe(true);
  });

  it("空 status 失败关闭", () => {
    expect(() => buildStudioPublicationPreflightReport({ status: "" })).toThrow(
      StudioPublicationPreflightError,
    );
  });

  it("enrichPublicationIntentWithDiagnostics 保留 intent 字段并挂报告", () => {
    const enriched = enrichPublicationIntentWithDiagnostics({
      status: "reserved" as const,
      targetPath: "/tmp/out.png",
      reservationToken: "tok-1",
      context: { purpose: "generation-output" as const },
      note: undefined,
      id: "publication-x",
    });
    expect(enriched.id).toBe("publication-x");
    expect(enriched.status).toBe("reserved");
    expect(enriched.openAssetIoDiagnostics.kind).toBe("studio-publication-preflight-report");
    expect(enriched.openAssetIoDiagnostics.phase).toBe("reserve");
    expect(enriched.openAssetIoDiagnostics.ok).toBe(true);
  });
});
