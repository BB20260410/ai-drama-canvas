import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createBuildIdentity,
  createVerifyRunnerRecord,
} from "../src/core/build-identity.js";
import { countDeclaredMcpTools } from "../src/core/release-manifest.js";

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("P10 构建身份", () => {
  it("生成稳定 sourceDigest/buildId 与能力清单", async () => {
    const expectedToolCount = await countDeclaredMcpTools(workspace);
    const first = await createBuildIdentity(workspace, "2026-07-18T00:00:00.000Z");
    const second = await createBuildIdentity(workspace, "2026-07-18T00:00:00.000Z");
    expect(first.sourceDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.buildId).toHaveLength(32);
    expect(first.buildId).toBe(second.buildId);
    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.artifactBuiltAt).toBe("2026-07-18T00:00:00.000Z");
    expect(first.builtAtSource).toBe("artifact");
    expect(first.capabilities).toMatchObject({
      mcpToolCount: expectedToolCount,
      formalImagegenProvider: "agent-imagegen",
      formalImagegenProviders: ["codex", "grok"],
      browserGeneration: false,
      artlist: false,
      studioDashboard: true,
    });
    expect(first.roots.sourceFiles).toBeGreaterThan(50);

    const record = createVerifyRunnerRecord({
      name: "unit-test",
      argv: ["vitest", "run"],
      cwd: workspace,
      startedAt: "2026-07-18T00:00:00.000Z",
      endedAt: "2026-07-18T00:00:01.000Z",
      exitCode: 0,
      sourceDigest: first.sourceDigest,
      buildId: first.buildId,
      testCounts: { files: 1, tests: 1 },
    });
    expect(record.kind).toBe("verify-runner-record");
    expect(record.exitCode).toBe(0);
  }, 120_000);

  it("查询时间变化不改变同一源码工件的 buildId/fingerprint", async () => {
    const first = await createBuildIdentity(workspace, {
      artifactBuiltAt: "2026-07-18T00:00:00.000Z",
      queriedAt: "2026-07-18T01:00:00.000Z",
    });
    const second = await createBuildIdentity(workspace, {
      artifactBuiltAt: "2026-07-18T00:00:00.000Z",
      queriedAt: "2026-07-18T02:00:00.000Z",
    });
    expect(first.buildId).toBe(second.buildId);
    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.builtAt).toBe("2026-07-18T00:00:00.000Z");
    expect(second.builtAt).toBe(first.builtAt);
    expect(first.queriedAt).not.toBe(second.queriedAt);
  }, 120_000);

  it("同一源码克隆到不同绝对目录仍保持相同 fingerprint", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-build-relocation-"));
    try {
      const roots = [path.join(parent, "workspace-a"), path.join(parent, "workspace-b")];
      for (const root of roots) {
        await mkdir(path.join(root, "src", "mcp"), { recursive: true });
        await Promise.all([
          writeFile(path.join(root, "package.json"), `${JSON.stringify({ name: "ai-drama-canvas", version: "0.2.0" })}\n`),
          writeFile(path.join(root, "src", "mcp", "server.ts"), "server.registerTool(\"fixture\", {}, () => ({}));\n"),
        ]);
      }
      const options = {
        artifactBuiltAt: "2026-07-18T00:00:00.000Z",
        queriedAt: "2026-07-18T01:00:00.000Z",
        mcpToolCount: 1,
      } as const;
      const [first, second] = await Promise.all([
        createBuildIdentity(roots[0]!, options),
        createBuildIdentity(roots[1]!, options),
      ]);
      expect(first.roots.workspace).not.toBe(second.roots.workspace);
      expect(first.sourceDigest).toBe(second.sourceDigest);
      expect(first.buildId).toBe(second.buildId);
      expect(first.fingerprint).toBe(second.fingerprint);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("缺少工件时间时明确标记查询回退，且查询时间不污染稳定身份", async () => {
    const previous = process.env.AI_CANVAS_BUILD_TIMESTAMP;
    delete process.env.AI_CANVAS_BUILD_TIMESTAMP;
    try {
      const first = await createBuildIdentity(workspace, { queriedAt: "2026-07-18T01:00:00.000Z" });
      const second = await createBuildIdentity(workspace, { queriedAt: "2026-07-18T02:00:00.000Z" });
      expect(first).toMatchObject({
        builtAt: "2026-07-18T01:00:00.000Z",
        queriedAt: "2026-07-18T01:00:00.000Z",
        builtAtSource: "query-fallback",
      });
      expect(first.artifactBuiltAt).toBeUndefined();
      expect(first.buildId).toBe(second.buildId);
      expect(first.fingerprint).toBe(second.fingerprint);
    } finally {
      if (previous === undefined) delete process.env.AI_CANVAS_BUILD_TIMESTAMP;
      else process.env.AI_CANVAS_BUILD_TIMESTAMP = previous;
    }
  }, 120_000);
});
