import { describe, expect, it } from "vitest";
import {
  matchOutlineAnchorsForUnit,
  SCRIPT_MEDIA_ALIGN_SCHEMA_VERSION,
} from "../src/core/studio-script-media-align.js";

describe("studio-script-media-align", () => {
  it("matches outline headings containing unit id", () => {
    const outline = [
      { level: 2, title: "场1", lineIndex: 0, startOffsetUtf16: 0, endOffsetUtf16: 2 },
      {
        level: 2,
        title: "S1E2-U01 · 15s · 4宫格",
        lineIndex: 1,
        startOffsetUtf16: 10,
        endOffsetUtf16: 30,
      },
      {
        level: 3,
        title: "S1E2-U01-G1 · 5s",
        lineIndex: 2,
        startOffsetUtf16: 40,
        endOffsetUtf16: 55,
      },
      {
        level: 2,
        title: "S1E2-U02 下一单元",
        lineIndex: 3,
        startOffsetUtf16: 60,
        endOffsetUtf16: 80,
      },
    ];
    const anchors = matchOutlineAnchorsForUnit("S1E2-U01", outline);
    expect(anchors).toHaveLength(2);
    expect(anchors[0]?.title).toContain("U01");
    expect(matchOutlineAnchorsForUnit("S1E2-U99", outline)).toEqual([]);
  });

  it("schema frozen", () => {
    expect(SCRIPT_MEDIA_ALIGN_SCHEMA_VERSION).toBe(1);
  });
});
