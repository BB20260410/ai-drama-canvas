import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = (relative: string) => readFileSync(path.join(root, relative), "utf8");

/**
 * Wave 3-A 源码合同：入口不得调用写版 inspectManagedProject(（会 ensure ledger）。
 * 不断言「整条只读路径零 ensure」——checkpoint / 账本开库留给 W3-B。
 * 不建受管工程，Linux/macOS 均可跑。
 */
describe("Wave 3-A 只读 inspect 合同", () => {
  it("正式时间线投影入口只走 inspectManagedProjectReadOnly", () => {
    const text = source("src/core/studio-approved-timeline-projection.ts");
    expect(text).toContain('import { inspectManagedProjectReadOnly } from "./managed-project.js"');
    expect(text).toContain("await inspectManagedProjectReadOnly(projectRoot)");
    expect(text).not.toMatch(/inspectManagedProject\(/u);
    expect(text).not.toMatch(/activateProject\s*\(/u);
  });

  it("earliest 入口只走 ReadOnly inspect 与只读租约", () => {
    const text = source("src/core/studio-episode-earliest.ts");
    expect(text).toContain('import { inspectManagedProjectReadOnly } from "./managed-project.js"');
    expect(text).toContain("await inspectManagedProjectReadOnly(root)");
    expect(text).toContain("getStudioProjectWriteLeaseReadOnly");
    expect(text).not.toMatch(/inspectManagedProject\(/u);
    expect(text).not.toMatch(/getStudioProjectWriteLease\(/u);
    expect(text).not.toMatch(/activateProject\s*\(/u);
  });

  it("align-board 不直接调用写版 inspect", () => {
    const text = source("src/core/studio-script-media-align.ts");
    expect(text).toContain("getStudioEpisodeEarliest");
    expect(text).not.toMatch(/inspectManagedProject\(/u);
    expect(text).not.toMatch(/activateProject\s*\(/u);
    expect(text).not.toMatch(/ensureManagedGenerationLedger\s*\(/u);
  });
});
