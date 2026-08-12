import { describe, expect, it } from "vitest";
import {
  IMMUTABLE_MCP_CANDIDATE_STAGE_STEP_ORDER,
  runImmutableMcpCandidateStageSteps,
} from "../scripts/lib/immutable-mcp-candidate-stage.js";
import {
  ImmutableMcpCandidateCutoverCommittedError,
  runImmutableMcpCandidateCutoverTransaction,
  verifyCommittedImmutableMcpCandidateDelivery,
} from "../scripts/lib/immutable-mcp-candidate-cutover.js";
import { readFile } from "node:fs/promises";
import path from "node:path";

describe("immutable MCP 交付编排边界", () => {
  it("隔离 stage 保持已运行的调用顺序", async () => {
    const observed: string[] = [];
    const operations = Object.fromEntries(IMMUTABLE_MCP_CANDIDATE_STAGE_STEP_ORDER.map((step) => [
      step,
      async () => { observed.push(step); },
    ])) as Record<(typeof IMMUTABLE_MCP_CANDIDATE_STAGE_STEP_ORDER)[number], () => Promise<void>>;

    await runImmutableMcpCandidateStageSteps(operations);

    expect(observed).toEqual([
      "copy-source-inputs",
      "verify-stage-source-before",
      "npm-ci",
      "build-launcher",
      "build-mcp",
      "build-identity",
      "verify-stage-source-after",
      "verify-live-source-before-payload",
      "npm-prune-production",
      "npm-ls-production",
      "remove-node-modules-bin",
      "copy-candidate-payload",
      "create-candidate-receipt",
      "verify-candidate-payload",
      "runtime-smoke",
      "create-publication-record",
    ]);
  });

  it("stage 中途失败时不继续 payload/receipt/publication", async () => {
    const observed: string[] = [];
    const operations = Object.fromEntries(IMMUTABLE_MCP_CANDIDATE_STAGE_STEP_ORDER.map((step) => [
      step,
      async () => {
        observed.push(step);
        if (step === "build-identity") throw new Error("injected-build-identity-failure");
      },
    ])) as Record<(typeof IMMUTABLE_MCP_CANDIDATE_STAGE_STEP_ORDER)[number], () => Promise<void>>;

    await expect(runImmutableMcpCandidateStageSteps(operations))
      .rejects.toThrow(/injected-build-identity-failure/u);
    expect(observed).toEqual([
      "copy-source-inputs",
      "verify-stage-source-before",
      "npm-ci",
      "build-launcher",
      "build-mcp",
      "build-identity",
    ]);
  });

  it("cutover 只有一个 launcher rename，且发布后才切换", async () => {
    const observed: string[] = [];
    const result = await runImmutableMcpCandidateCutoverTransaction({
      async stageLauncher() {
        observed.push("stage-launcher");
        return { token: "staged" };
      },
      async withPublicationLock(callback) {
        observed.push("lock-enter");
        const value = await callback();
        observed.push("lock-exit");
        return value;
      },
      async validateCurrentLauncher() { observed.push("validate-old-launcher"); },
      async publishCandidateAndPublication() {
        observed.push("publish-candidate-and-publication");
        return { candidateRoot: "/candidate" };
      },
      async verifyStagedLauncher() { observed.push("verify-staged-launcher"); },
      async beforeLauncherCutover() { observed.push("before-launcher-cutover"); },
      async renameLauncher() { observed.push("rename-launcher"); },
      async cleanupStagedLauncher() { observed.push("cleanup-staged-launcher"); },
    });

    expect(result).toEqual({ candidateRoot: "/candidate" });
    expect(observed).toEqual([
      "stage-launcher",
      "lock-enter",
      "validate-old-launcher",
      "publish-candidate-and-publication",
      "verify-staged-launcher",
      "before-launcher-cutover",
      "rename-launcher",
      "lock-exit",
      "cleanup-staged-launcher",
    ]);
    expect(observed.filter((step) => step === "rename-launcher")).toHaveLength(1);
  });

  it("cutover 前验证失败时保留旧 launcher，不执行可见发布 rename", async () => {
    const observed: string[] = [];
    await expect(runImmutableMcpCandidateCutoverTransaction({
      async stageLauncher() {
        observed.push("stage-launcher");
        return { token: "staged" };
      },
      async withPublicationLock(callback) { return callback(); },
      async validateCurrentLauncher() { observed.push("validate-old-launcher"); },
      async publishCandidateAndPublication() {
        observed.push("publish-candidate-and-publication");
        return { candidateRoot: "/candidate" };
      },
      async verifyStagedLauncher() { observed.push("verify-staged-launcher"); },
      async beforeLauncherCutover() { throw new Error("injected-source-drift"); },
      async renameLauncher() { observed.push("rename-launcher"); },
      async cleanupStagedLauncher() { observed.push("cleanup-staged-launcher"); },
    })).rejects.toThrow(/injected-source-drift/u);

    expect(observed).toContain("publish-candidate-and-publication");
    expect(observed).not.toContain("rename-launcher");
    expect(observed.at(-1)).toBe("cleanup-staged-launcher");
  });

  it("launcher 已提交但 lock release 失败时返回 typed committed error，禁止按未发布重试", async () => {
    const observed: string[] = [];
    let caught: unknown;
    try {
      await runImmutableMcpCandidateCutoverTransaction({
        async stageLauncher() { return { token: "staged" }; },
        async withPublicationLock(callback) {
          const result = await callback();
          observed.push("release-lock");
          expect(result).toEqual({ candidateRoot: "/candidate" });
          throw new Error("injected-lock-release-failure");
        },
        async validateCurrentLauncher() {},
        async publishCandidateAndPublication() { return { candidateRoot: "/candidate" }; },
        async verifyStagedLauncher() {},
        async beforeLauncherCutover() {},
        async renameLauncher() { observed.push("rename-launcher"); },
        async cleanupStagedLauncher() { observed.push("cleanup-staged-launcher"); },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ImmutableMcpCandidateCutoverCommittedError);
    expect(caught).toMatchObject({
      code: "IMMUTABLE_MCP_CUTOVER_COMMITTED_LOCK_RELEASE_FAILED",
      committed: true,
      result: { candidateRoot: "/candidate" },
      cause: expect.objectContaining({ message: "injected-lock-release-failure" }),
    });
    expect(observed).toEqual(["rename-launcher", "release-lock", "cleanup-staged-launcher"]);
    expect(observed.filter((step) => step === "rename-launcher")).toHaveLength(1);
  });

  it("publish 返回后的 landed 联合回读失败保持 committed=true，cleanup 失败不能掩盖", async () => {
    const committed = { candidateRoot: "/candidate", launcherPath: "/launcher" };
    let cleanupCalls = 0;
    let caught: unknown;
    try {
      await verifyCommittedImmutableMcpCandidateDelivery({
        committedResult: committed,
        async verifyLanded() { throw new Error("injected-landed-reread-failure"); },
        async cleanupStage() {
          cleanupCalls += 1;
          throw new Error("injected-stage-cleanup-failure");
        },
      });
    } catch (error) {
      caught = error;
    }

    expect(cleanupCalls).toBe(1);
    expect(caught).toBeInstanceOf(ImmutableMcpCandidateCutoverCommittedError);
    expect(caught).toMatchObject({ committed: true, result: committed });
    const cause = (caught as Error & { cause?: unknown }).cause;
    expect(cause).toBeInstanceOf(AggregateError);
    expect((cause as AggregateError).errors.map((error) => (error as Error).message)).toEqual([
      "injected-landed-reread-failure",
      "injected-stage-cleanup-failure",
    ]);
  });

  it("candidate stage 显式隔离 HOME 与空 npm userconfig，并固定官方 registry", async () => {
    const source = await readFile(path.join(process.cwd(), "scripts/build-immutable-mcp-candidate.ts"), "utf8");
    expect(source).toContain('const stageHome = path.join(tempRoot, "home")');
    expect(source).toContain('const stageNpmUserConfig = path.join(tempRoot, "npmrc")');
    expect(source).toContain("mkdir(stageHome");
    expect(source).toContain("await writeFile(stageNpmUserConfig, \"\"");
    expect(source).toContain("HOME: stageHome");
    expect(source).toContain("npm_config_userconfig: stageNpmUserConfig");
    expect(source).toContain('npm_config_registry: "https://registry.npmjs.org"');
  });
});
