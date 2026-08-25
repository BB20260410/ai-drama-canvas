import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = (relative: string) => readFileSync(path.join(root, relative), "utf8");

describe("Wave 3-C earliest 用 list 行 revision", () => {
  it("不再逐单元拉 production snapshot", () => {
    const text = source("src/core/studio-episode-earliest.ts");
    expect(text).toContain("listStudioProductionUnitIdentities");
    expect(text).not.toContain("listStudioProductionUnits");
    expect(text).toContain("revision: unit.revision");
    expect(text).not.toMatch(/getStudioProductionUnitSnapshot\s*\(/u);
    expect(text).not.toMatch(/snap\?\.unit\.revision/u);
  });
});
