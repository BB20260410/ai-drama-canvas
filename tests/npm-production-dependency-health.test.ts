import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  assertNpmProductionDependencyHealth,
  type NpmLsJson,
  type PackageLockJson,
} from "../scripts/lib/npm-production-dependency-health.js";

describe("npm production dependency health", () => {
  it("接受 lockfile 可证明的 sharp optional wasm 链，并拒绝其他 extraneous", async () => {
    const lockfile = await readFile("package-lock.json", "utf8")
      .then((value) => JSON.parse(value) as PackageLockJson);
    const npmLs: NpmLsJson = {
      problems: [
        "extraneous: @emnapi/runtime@1.11.3 /workspace/node_modules/@emnapi/runtime",
        "extraneous: @img/sharp-wasm32@0.35.3 /workspace/node_modules/@img/sharp-wasm32",
        "extraneous: tslib@2.8.1 /workspace/node_modules/tslib",
      ],
      dependencies: {
        "@emnapi/runtime": { version: "1.11.3", extraneous: true },
        "@img/sharp-wasm32": { version: "0.35.3", extraneous: true },
        tslib: { version: "2.8.1", extraneous: true },
      },
    };
    const summary = assertNpmProductionDependencyHealth(npmLs, lockfile);
    expect(summary.status).toBe("passed");
    expect(summary.problemCount).toBe(3);
    expect(summary.acceptedOptionalProblems.map((entry) => entry.name).sort()).toEqual([
      "@emnapi/runtime",
      "@img/sharp-wasm32",
      "tslib",
    ]);
    expect(summary.rejectedProblems).toEqual([]);

    const invalid = structuredClone(npmLs);
    invalid.problems = [...(invalid.problems ?? []), "extraneous: surprise@1.0.0 /tmp/node_modules/surprise"];
    invalid.dependencies = {
      ...(invalid.dependencies ?? {}),
      surprise: { version: "1.0.0", extraneous: true },
    };
    expect(() => assertNpmProductionDependencyHealth(invalid, lockfile)).toThrow(/surprise|生产依赖/u);
  });

  it("missing、invalid、版本漂移和非 optional extraneous 一律失败关闭", () => {
    const lockfile: PackageLockJson = {
      packages: {
        "": { dependencies: { direct: "1.0.0" } },
        "node_modules/direct": { version: "1.0.0" },
        "node_modules/nonoptional": { version: "1.0.0" },
      },
    };
    for (const problem of [
      "missing: direct@1.0.0, required by app@1.0.0",
      "invalid: direct@2.0.0 /tmp/node_modules/direct",
      "extraneous: nonoptional@1.0.0 /tmp/node_modules/nonoptional",
    ]) {
      const npmLs: NpmLsJson = {
        problems: [problem],
        dependencies: {
          direct: { version: problem.startsWith("invalid") ? "2.0.0" : "1.0.0" },
          nonoptional: { version: "1.0.0", extraneous: problem.startsWith("extraneous") },
        },
      };
      expect(() => assertNpmProductionDependencyHealth(npmLs, lockfile)).toThrow(/生产依赖/u);
    }
  });

  it("节点 extraneous flag 即使缺少 problems 字符串也必须失败关闭", () => {
    const npmLs: NpmLsJson = {
      dependencies: {
        surprise: { version: "1.0.0", extraneous: true },
      },
    };
    expect(() => assertNpmProductionDependencyHealth(npmLs, { packages: {} }))
      .toThrow(/surprise|生产依赖/u);
  });

  it("按真实 lockfile 节点路径解析 optional 链，拒绝同名 nested 版本错配", () => {
    const lockfile: PackageLockJson = {
      packages: {
        "": { dependencies: { direct: "1.0.0", optionalRoot: "1.0.0" } },
        "node_modules/direct": { version: "1.0.0", dependencies: { leaf: "^1.0.0" } },
        "node_modules/direct/node_modules/leaf": { version: "1.5.0" },
        "node_modules/optionalRoot": { version: "1.0.0", optionalDependencies: { leaf: "^2.0.0" } },
        "node_modules/leaf": { version: "2.1.0", optional: true },
      },
    };
    const npmLs: NpmLsJson = {
      problems: ["extraneous: leaf@2.1.0 /workspace/node_modules/direct/node_modules/leaf"],
      dependencies: {
        direct: {
          version: "1.0.0",
          dependencies: { leaf: { version: "2.1.0", extraneous: true } },
        },
      },
    };
    expect(() => assertNpmProductionDependencyHealth(npmLs, lockfile)).toThrow(/leaf|生产依赖/u);
  });

  it("caret/tilde 稳定版范围不得静默接受 prerelease", () => {
    const lockfile: PackageLockJson = {
      packages: {
        "": { optionalDependencies: { leaf: "^1.0.0" } },
        "node_modules/leaf": { version: "1.1.0-beta.1", optional: true },
      },
    };
    const npmLs: NpmLsJson = {
      problems: ["extraneous: leaf@1.1.0-beta.1 /workspace/node_modules/leaf"],
      dependencies: {
        leaf: { version: "1.1.0-beta.1", extraneous: true },
      },
    };
    expect(() => assertNpmProductionDependencyHealth(npmLs, lockfile)).toThrow(/leaf|生产依赖/u);
  });

  it("candidate 与 isolated package 两条交付链都执行同一语义门禁并留结构化证据", async () => {
    const [candidateStage, isolatedPackage] = await Promise.all([
      readFile("scripts/lib/immutable-mcp-candidate-stage.ts", "utf8"),
      readFile("scripts/isolated-package-smoke.ts", "utf8"),
    ]);
    for (const source of [candidateStage, isolatedPackage]) {
      expect(source).toContain("assertNpmProductionDependencyHealth");
      expect(source).toContain("productionDependencyHealth");
      expect(source).toContain('"--omit=dev", "--all", "--json"');
    }
  });
});
