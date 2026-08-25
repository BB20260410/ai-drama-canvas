import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = (relative: string) => readFileSync(path.join(root, relative), "utf8");

/**
 * Wave 3-A 源码合同：只读投影入口不得 inspectManagedProject（会 ensure ledger）。
 * 不建受管工程，Linux/macOS 均可跑。
 */
describe("Wave 3-A 只读 inspect 合同", () => {
  it("正式时间线投影只走 inspectManagedProjectReadOnly", () => {
    const text = source("src/core/studio-approved-timeline-projection.ts");
    expect(text).toContain('import { inspectManagedProjectReadOnly } from "./managed-project.js"');
    expect(text).toContain("await inspectManagedProjectReadOnly(projectRoot)");
    expect(text).not.toMatch(/inspectManagedProject\(/u);
    expect(text).not.toContain("activateProject");
  });

  it("earliest 只走 ReadOnly inspect 与只读租约", () => {
    const text = source("src/core/studio-episode-earliest.ts");
    expect(text).toContain('import { inspectManagedProjectReadOnly } from "./managed-project.js"');
    expect(text).toContain("await inspectManagedProjectReadOnly(root)");
    expect(text).toContain("getStudioProjectWriteLeaseReadOnly");
    expect(text).not.toMatch(/inspectManagedProject\(/u);
    expect(text).not.toMatch(/getStudioProjectWriteLease\(/u);
    expect(text).not.toContain("activateProject");
  });

  it("align-board 不直接写 inspect，身份校验继承 earliest", () => {
    const text = source("src/core/studio-script-media-align.ts");
    expect(text).toContain("getStudioEpisodeEarliest");
    expect(text).not.toContain("inspectManagedProject");
    expect(text).not.toContain("activateProject");
    expect(text).not.toContain("ensureManagedGenerationLedger");
  });
});
