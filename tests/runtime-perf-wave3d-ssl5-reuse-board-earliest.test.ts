import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = (relative: string) => readFileSync(path.join(root, relative), "utf8");

describe("Wave 3-D ssl5 复用 align-board earliest", () => {
  it("不再二次调用 getStudioEpisodeEarliest", () => {
    const text = source("src/core/studio-ssl5-missing-to-gen.ts");
    expect(text).toContain("getStudioScriptMediaAlignBoard");
    expect(text).toContain("board.earliestUnitId");
    expect(text).toContain("board.earliestCode");
    expect(text).toContain("refineSsl5FocusIfEarliestBlocking");
    expect(text).not.toMatch(/getStudioEpisodeEarliest\s*\(/u);
    expect(text).not.toContain("studio-episode-earliest");
    expect(text).toContain('"binding-ready?"');
    expect(text).toContain('"dispatch"');
    expect(text).toContain('"review"');
  });
});
