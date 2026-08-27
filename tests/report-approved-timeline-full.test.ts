import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  assertApprovedTimelineFullProjectAllowed,
  parseApprovedTimelineFullArgs,
} from "../scripts/report-approved-timeline-full.js";

describe("report-approved-timeline-full（Wave 1-B）", () => {
  it("缺少 --project 失败关闭", () => {
    expect(() => parseApprovedTimelineFullArgs([])).toThrow(/必须提供 --project/);
  });

  it("解析 season/episode，默认 S1/S1E1", () => {
    expect(parseApprovedTimelineFullArgs(["--project", "/tmp/iso"])).toEqual({
      projectRoot: "/tmp/iso",
      season: "S1",
      episode: "S1E1",
    });
    expect(parseApprovedTimelineFullArgs([
      "--project", "/tmp/iso",
      "--season", "S03",
      "--episode", "EP01",
    ]).episode).toBe("EP01");
  });

  it("拒绝正式工程路径", () => {
    expect(() => assertApprovedTimelineFullProjectAllowed("/workspace/projects/codex-ai-drama-studio")).toThrow(
      /拒绝探测正式工程/,
    );
  });

  it("脚本显式 fastMode:false 并输出耗时", () => {
    const source = readFileSync(new URL("../scripts/report-approved-timeline-full.ts", import.meta.url), "utf8");
    expect(source).toContain("fastMode: false");
    expect(source).toContain("durationMs");
    expect(source).not.toContain("codex-ai-drama-studio\" as 默认");
  });
});
