import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  diffStudioP24GoldenCase,
  executeStudioP24GoldenCase,
  STUDIO_P24_GOLDEN_CASES,
  type StudioP24GoldenFile,
} from "./helpers/studio-p24-golden-cases.js";

/**
 * P24 golden runner（规范 §2.7/§4-6）：逐 case 建夹具→施加变更→跑 trace/impact→比对 golden。
 * mismatch 失败并打印 diff；本文件绝不写 golden（显式审核更新走 scripts/update-p24-golden.ts）。
 */

const GOLDEN_PATH = path.join(process.cwd(), "tests/fixtures/p24-trace-golden.json");

async function loadGolden(): Promise<StudioP24GoldenFile> {
  const raw = await readFile(GOLDEN_PATH, "utf8");
  const parsed = JSON.parse(raw) as StudioP24GoldenFile;
  if (parsed.schemaVersion !== 1) throw new Error(`p24 golden schemaVersion 不支持：${String(parsed.schemaVersion)}`);
  return parsed;
}

describe.concurrent("P24 golden 固定样本回归（3 格型×5 差异×2 分类）", () => {
  it("golden 文件完整覆盖 30 case 矩阵", async () => {
    const golden = await loadGolden();
    expect(Object.keys(golden.cases).sort()).toEqual(STUDIO_P24_GOLDEN_CASES.map((entry) => entry.id).sort());
  });

  // per-case it + describe.concurrent：case 间完全隔离（私有 bootstrap 注册表+mkdtemp），
  // 由 vitest maxConcurrency(5) 限流，3 串行大 it（75s）→ 并行小 it。
  for (const goldenCase of STUDIO_P24_GOLDEN_CASES) {
    it(`case ${goldenCase.id}`, { timeout: 600_000 }, async () => {
      const golden = await loadGolden();
      const expectation = golden.cases[goldenCase.id];
      expect(expectation, `golden 缺少 case ${goldenCase.id}`).toBeDefined();
      const actual = await executeStudioP24GoldenCase(goldenCase);
      const diffs = diffStudioP24GoldenCase(expectation!, actual);
      expect(diffs, `case ${goldenCase.id}：\n  - ${diffs.join("\n  - ")}`).toEqual([]);
    });
  }
});
