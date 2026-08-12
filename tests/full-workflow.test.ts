import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const registries: string[] = [];

afterEach(async () => {
  await Promise.all([
    ...roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    ...registries.splice(0).map((filePath) => rm(filePath, { force: true })),
  ]);
});

describe("小说到视频续接的隔离全链路", () => {
  it("真实文件经过分镜、生成、验收、剪辑、续接、导出后可跨进程恢复", async () => {
    const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-full-workflow-test-"));
    const root = path.join(runtimeRoot, "project");
    const registry = path.join(runtimeRoot, "registry.json");
    roots.push(runtimeRoot);
    registries.push(registry);
    const executable = path.join(process.cwd(), "node_modules", ".bin", "tsx");
    const { stdout } = await execFileAsync(executable, ["scripts/full-workflow-smoke.ts", root, registry], {
      cwd: process.cwd(),
      env: { ...process.env, AI_CANVAS_REGISTRY_PATH: registry },
      maxBuffer: 4_000_000,
    });
    const result = JSON.parse(stdout) as {
      chapters: number;
      facts: number;
      beats: number;
      conciseUnits: number;
      splitUnits: number;
      editRevision: number;
      renderPath: string;
      continuationOutputPath: string;
      jsonPath: string;
      markdownPath: string;
      restartVerified: boolean;
      restart: { planRestored: boolean; completedUnits: number; storyboardValid: boolean; editClipCount: number; continuationStatus: string; timebase: { rateNumerator: number; rateDenominator: number } };
    };
    expect(result).toEqual(expect.objectContaining({ chapters: 2, conciseUnits: 1, restartVerified: true }));
    expect(result.facts).toBeGreaterThan(0);
    expect(result.beats).toBeGreaterThan(0);
    expect(result.splitUnits).toBeGreaterThanOrEqual(2);
    expect(result.editRevision).toBeGreaterThan(1);
    expect(result.restart).toEqual(expect.objectContaining({ planRestored: true, completedUnits: 1, storyboardValid: true, editClipCount: 2, continuationStatus: "completed", timebase: { rateNumerator: 24_000, rateDenominator: 1_001 } }));
    expect([result.renderPath, result.continuationOutputPath, result.jsonPath, result.markdownPath].every((value) => value.startsWith(root))).toBe(true);
    // 2026-08-12（wq-0007 收口）：空载全链约 69s，恢复 120s 严格门。
    // 该测试必须单 worker 串行；资源争抢造成的外部抖动不得用永久放宽掩盖。
  }, 120_000);
});
