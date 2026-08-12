import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const scriptPath = path.join(process.cwd(), "scripts/ui-global-resource-center-live-smoke.ts");

describe("总资源中心隐藏验收证据发布", () => {
  it("默认输出每轮唯一，显式同路径由 run lock 和原子独占发布保护", async () => {
    const source = await readFile(scriptPath, "utf8");

    expect(source).toContain("createUniqueEvidenceStem(\"global-resource-center-live-ui\")");
    expect(source).toContain("assertFreshOutputSet([");
    expect(source).toContain("await acquireEvidenceRunLock(evidencePath, evidenceRunId)");
    expect(source).toContain("await writeBytesAtomicExclusive(screenshotPath");
    expect(source).toContain("await writeJsonAtomicExclusive(evidencePath, evidence)");
    expect(source).toContain("await evidenceRunLock?.release()");

    expect(source).not.toMatch(/`\$\{screenshotPath\}\.tmp`/u);
    expect(source).not.toMatch(/`\$\{evidencePath\}\.tmp`/u);
    expect(source).not.toMatch(/rename\(`\$\{(?:screenshotPath|evidencePath)\}\.tmp`/u);
  });
});
