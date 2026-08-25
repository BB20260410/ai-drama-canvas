/**
 * Wave 2 补刀：驾驶舱当前单元路径不得省略 unitIds 物化整集。
 * 不建受管工程、不扫正式工程、不走 Darwin dirfd / P7 fixture。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  APPROVED_TIMELINE_BOUNDED_UNIT_LIMIT,
  resolveApprovedTimelineBound,
  resolveProjectionBundleApprovedTimelineUnitIds,
} from "../src/core/studio-approved-timeline-projection.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = (relative: string) => readFileSync(path.join(root, relative), "utf8");

describe("Wave 2 bundle approved timeline 有界", () => {
  it("helper：当前+前后邻去重，最多 3，空标识失败关闭", () => {
    expect(resolveProjectionBundleApprovedTimelineUnitIds({
      unitId: "S1E1-U02",
      previousUnitId: "S1E1-U01",
      nextUnitId: "S1E1-U03",
    })).toEqual(["S1E1-U02", "S1E1-U01", "S1E1-U03"]);

    expect(resolveProjectionBundleApprovedTimelineUnitIds({
      unitId: "S1E1-U01",
      previousUnitId: null,
      nextUnitId: "S1E1-U02",
    })).toEqual(["S1E1-U01", "S1E1-U02"]);

    expect(resolveProjectionBundleApprovedTimelineUnitIds({
      unitId: "S1E1-U09",
      previousUnitId: "S1E1-U08",
      nextUnitId: undefined,
    })).toEqual(["S1E1-U09", "S1E1-U08"]);

    expect(resolveProjectionBundleApprovedTimelineUnitIds({
      unitId: "S1E1-U02",
      previousUnitId: "S1E1-U02",
      nextUnitId: "S1E1-U03",
    })).toEqual(["S1E1-U02", "S1E1-U03"]);

    expect(resolveProjectionBundleApprovedTimelineUnitIds({
      unitId: "S1E1-U01",
      previousUnitId: "  ",
      nextUnitId: null,
    })).toEqual(["S1E1-U01"]);

    expect(() => resolveProjectionBundleApprovedTimelineUnitIds({
      unitId: "   ",
      previousUnitId: null,
      nextUnitId: "",
    })).toThrow(/非空数组/);

    const bound = resolveApprovedTimelineBound({
      unitIds: resolveProjectionBundleApprovedTimelineUnitIds({
        unitId: "S1E1-U02",
        previousUnitId: "S1E1-U01",
        nextUnitId: "S1E1-U03",
      }),
    });
    expect(bound.unitIds).toHaveLength(3);
    expect(bound.unitIds!.length).toBeLessThanOrEqual(APPROVED_TIMELINE_BOUNDED_UNIT_LIMIT);
  });

  it("bundle：阶段名不变，approved 在邻接之后且必须带 unitIds", () => {
    const bundle = source("src/core/studio-production-projection-bundle.ts");
    expect(bundle).toContain('"timeline-approved-neighbors"');
    expect(bundle).toContain("resolveProjectionBundleApprovedTimelineUnitIds");
    expect(bundle).not.toContain("const approvedTimelinePromise = getApprovedTimelineProjection");

    const successorAt = bundle.indexOf("getStudioCanonicalSuccessorUnitIds");
    const predecessorAt = bundle.indexOf("getStudioCanonicalPredecessorUnitIds");
    const approvedAt = bundle.indexOf("await getApprovedTimelineProjection(");
    expect(successorAt).toBeGreaterThan(-1);
    expect(predecessorAt).toBeGreaterThan(-1);
    expect(approvedAt).toBeGreaterThan(successorAt);
    expect(approvedAt).toBeGreaterThan(predecessorAt);

    const invoke = bundle.slice(approvedAt, approvedAt + 700);
    expect(invoke).toContain("fastMode: true");
    expect(invoke).toContain("unitIds: resolveProjectionBundleApprovedTimelineUnitIds");
    expect(invoke).toContain("previousUnitId");
    expect(invoke).toContain("nextUnitId");

    const phaseBlock = bundle.slice(
      bundle.indexOf('"timeline-approved-neighbors"'),
      bundle.indexOf("if (!timelineProjection)"),
    );
    expect(phaseBlock).toContain("unitIds:");
    expect(phaseBlock.match(/getApprovedTimelineProjection\(/g)).toHaveLength(1);
  });

  it("多媒体 storyboard：只请求当前 unitId，不省略成整集", () => {
    const multimedia = source("src/core/studio-multimedia-timeline.ts");
    const fnAt = multimedia.indexOf("async function approvedStoryboardProjection");
    expect(fnAt).toBeGreaterThan(-1);
    const fn = multimedia.slice(fnAt, multimedia.indexOf("export async function getStudioMultimediaTimelineProjection"));
    const approvedAt = fn.indexOf("getApprovedTimelineProjection(");
    expect(approvedAt).toBeGreaterThan(-1);
    expect(fn.slice(approvedAt).match(/getApprovedTimelineProjection\(/g)).toHaveLength(1);
    const invoke = fn.slice(approvedAt, approvedAt + 280);
    expect(invoke).toContain("fastMode: true");
    expect(invoke).toContain("unitIds: [snapshot.unit.id]");
  });
});
