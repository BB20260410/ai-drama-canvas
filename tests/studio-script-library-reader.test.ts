import { describe, expect, it } from "vitest";
import { buildScriptOutlineFromMarkdown, SCRIPT_READER_SCHEMA_VERSION } from "../src/core/studio-script-library-reader.js";

describe("studio-script-library-reader", () => {
  it("builds outline with utf16 offsets", () => {
    const body = ["# 场一", "", "正文甲", "## 场二", "正文乙"].join("\n");
    const outline = buildScriptOutlineFromMarkdown(body);
    expect(outline).toHaveLength(2);
    expect(outline[0]).toMatchObject({ level: 1, title: "场一", lineIndex: 0, startOffsetUtf16: 0 });
    expect(outline[1]?.title).toBe("场二");
    expect(outline[1]!.startOffsetUtf16).toBeGreaterThan(outline[0]!.endOffsetUtf16);
    expect(body.slice(outline[1]!.startOffsetUtf16, outline[1]!.endOffsetUtf16)).toContain("场二");
  });

  it("ignores non-heading lines", () => {
    expect(buildScriptOutlineFromMarkdown("no headings\n###not\n")).toEqual([]);
  });

  it("schema frozen", () => {
    expect(SCRIPT_READER_SCHEMA_VERSION).toBe(1);
  });

  it("阅读器复用 earliestReason，schema 仍为 1", async () => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const reader = readFileSync(path.join(root, "src/core/studio-script-library-reader.ts"), "utf8");
    expect(reader).toContain("earliestReason: earliest.earliestReason");
    expect(reader).toContain("SCRIPT_READER_SCHEMA_VERSION = 1");
    expect(reader).not.toContain("evaluateStudioConsistency");
  });
});
