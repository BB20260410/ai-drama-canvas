import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  matchesT23DualUnitLabel,
  parseT23VerifyCli,
  prepareIsolatedRuntime,
  snapshotT23ReadonlyProjectTree,
  snapshotT23ReadonlySentinels,
  verifyT23ReadonlyProjectTree,
  verifyT23ReadonlySentinels,
} from "../scripts/lib/t23-project-ui-verify-shared.js";
import { REDLINE_SENTINEL_RELATIVE_PATHS } from "../scripts/lib/redline-project-sentinel-shared.js";

describe("T23 通用季集双编号识别", () => {
  it.each([
    "029｜S1E01-U28",
    "001｜S1E02-U00",
    "107｜S2E16-U06",
  ])("接受任意合法季集标签：%s", (label) => {
    expect(matchesT23DualUnitLabel(label)).toBe(true);
  });

  it.each([
    "029｜S1E01",
    "S1E02-U00",
    "029｜S1E-U28",
  ])("拒绝不完整标签：%s", (label) => {
    expect(matchesT23DualUnitLabel(label)).toBe(false);
  });

  it("验收入口只接受源码 dev/build，明确拒绝 installed", () => {
    const generic = parseT23VerifyCli([
      "--projectRoot=/tmp/project",
      "--mode=dev",
    ], "/tmp/evidence");
    expect(generic.mode).toBe("dev");
    expect(generic.requireDualUnitLabel).toBe(false);
    expect(parseT23VerifyCli([
      "--projectRoot=/tmp/project",
      "--mode=build",
      "--require-dual-label",
    ], "/tmp/evidence").requireDualUnitLabel).toBe(true);
    expect(() => parseT23VerifyCli([
      "--projectRoot=/tmp/project",
      "--mode=installed",
    ], "/tmp/evidence")).toThrow(/禁止安装版/u);
  });

  it("真实 UI 运行时让 registry 只指向完整工程副本，并解引用符号链接", async () => {
    const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "t23-copy-fixture-"));
    let isolated: Awaited<ReturnType<typeof prepareIsolatedRuntime>> | undefined;
    try {
      const projectRoot = path.join(fixtureRoot, "project");
      const externalFile = path.join(fixtureRoot, "outside.txt");
      const registryPath = path.join(fixtureRoot, "projects.json");
      await mkdir(path.join(projectRoot, ".aicanvas"), { recursive: true });
      await writeFile(path.join(projectRoot, ".aicanvas", "project.json"), `${JSON.stringify({
        primaryRoot: projectRoot,
        outputRoots: [projectRoot],
      })}\n`);
      await writeFile(path.join(projectRoot, ".aicanvas", "index.json"), `${JSON.stringify({
        project: { primaryRoot: projectRoot, outputRoots: [projectRoot] },
      })}\n`);
      await writeFile(path.join(projectRoot, ".aicanvas", "managed-project.json"), `${JSON.stringify({
        rootRealpath: projectRoot,
        projectConfigSha256: "fixture",
        bootstrapIndexSha256: "fixture",
        fingerprint: "fixture",
      })}\n`);
      await writeFile(externalFile, "formal-source\n");
      await symlink(externalFile, path.join(projectRoot, "linked.txt"));
      await writeFile(registryPath, `${JSON.stringify([{
        id: "project-test",
        name: "隔离副本测试",
        primaryRoot: projectRoot,
      }])}\n`);

      isolated = await prepareIsolatedRuntime({
        projectRoot,
        sourceRegistryPath: registryPath,
        copyProject: true,
      });
      expect(isolated.isolatedProjectCopy).toBe(true);
      expect(isolated.project.primaryRoot).not.toBe(projectRoot);
      expect(isolated.project.primaryRoot).toBe(await realpath(isolated.project.primaryRoot));
      const copiedConfig = JSON.parse(await readFile(path.join(
        isolated.project.primaryRoot,
        ".aicanvas",
        "project.json",
      ), "utf8"));
      expect(copiedConfig.primaryRoot).toBe(isolated.project.primaryRoot);
      expect(await readFile(path.join(isolated.project.primaryRoot, "linked.txt"), "utf8"))
        .toBe("formal-source\n");
      const copiedRegistry = JSON.parse(await readFile(isolated.registryPath, "utf8"));
      expect(copiedRegistry[0].primaryRoot).toBe(isolated.project.primaryRoot);
      await writeFile(path.join(isolated.project.primaryRoot, "linked.txt"), "isolated-write\n");
      expect(await readFile(externalFile, "utf8")).toBe("formal-source\n");
    } finally {
      await isolated?.cleanup().catch(() => undefined);
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });
});

describe("T23 正式工程六项候选哨兵", () => {
  it("全树元数据捕获任意路径漂移，关键 SQLite 即使同字节数并恢复 mtime 仍由 SHA 检出", async () => {
    const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "t23-full-tree-"));
    try {
      const sidecar = path.join(fixtureRoot, ".aicanvas");
      await mkdir(path.join(fixtureRoot, "nested"), { recursive: true });
      await mkdir(sidecar, { recursive: true });
      const databasePath = path.join(sidecar, "material-studio.sqlite");
      await writeFile(databasePath, "database-A\n", "utf8");
      await writeFile(path.join(fixtureRoot, "nested", "asset.txt"), "asset-A\n", "utf8");
      const before = await snapshotT23ReadonlyProjectTree(fixtureRoot);
      const databaseBefore = before.entries.find((entry) => entry.relativePath === ".aicanvas/material-studio.sqlite")!;

      await writeFile(path.join(fixtureRoot, "nested", "asset.txt"), "asset-B-expanded\n", "utf8");
      await writeFile(databasePath, "database-B\n", "utf8");
      await utimes(databasePath, new Date(databaseBefore.mtimeMs), new Date(databaseBefore.mtimeMs));

      const verification = await verifyT23ReadonlyProjectTree(fixtureRoot, before);
      expect(verification.ok).toBe(false);
      expect(verification.changedPaths).toEqual(expect.arrayContaining([
        ".aicanvas/material-studio.sqlite",
        "nested/asset.txt",
      ]));
      expect(verification.criticalContentChangedPaths).toContain(".aicanvas/material-studio.sqlite");
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("只纳入启动前存在项，并逐项记录 SHA、bytes 与整数毫秒 mtime", async () => {
    const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "t23-sentinel-evidence-"));
    try {
      const sidecar = path.join(fixtureRoot, ".aicanvas");
      await mkdir(sidecar, { recursive: true });
      await writeFile(path.join(sidecar, "managed-project.json"), "{}\n", "utf8");
      await writeFile(path.join(sidecar, "studio-production.sqlite"), "sqlite-fixture\n", "utf8");

      const before = await snapshotT23ReadonlySentinels(fixtureRoot);
      expect(before.map((item) => item.relativePath)).toEqual([
        ".aicanvas/managed-project.json",
        ".aicanvas/studio-production.sqlite",
      ]);
      expect(before.every((item) => (
        item.sha256.length === 64
        && Number.isInteger(item.bytes)
        && Number.isInteger(item.mtimeMs)
      ))).toBe(true);

      const verification = await verifyT23ReadonlySentinels(fixtureRoot, before);
      expect(verification).toMatchObject({
        ok: true,
        candidateRelativePaths: [...REDLINE_SENTINEL_RELATIVE_PATHS],
        includedExistingCount: 2,
        mtimePrecision: "integer-millisecond",
      });
      expect(verification.items).toHaveLength(2);
      expect(verification.items.every((item) => (
        item.status === "PASS"
        && item.changedFields.length === 0
        && item.after.exists
      ))).toBe(true);
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("分别识别缺失、SHA、bytes 与 mtime 漂移", async () => {
    const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "t23-sentinel-drift-"));
    try {
      const sidecar = path.join(fixtureRoot, ".aicanvas");
      await mkdir(sidecar, { recursive: true });
      const relativePaths = REDLINE_SENTINEL_RELATIVE_PATHS.slice(0, 4);
      for (const [index, relativePath] of relativePaths.entries()) {
        await writeFile(path.join(fixtureRoot, relativePath), `sentinel-${index}\n`, "utf8");
      }
      const before = await snapshotT23ReadonlySentinels(fixtureRoot);
      await rm(path.join(fixtureRoot, relativePaths[0]!));
      await writeFile(path.join(fixtureRoot, relativePaths[1]!), "changed--1\n", "utf8");
      await writeFile(path.join(fixtureRoot, relativePaths[2]!), "sentinel-2-expanded\n", "utf8");
      const mtimeOnly = before.find((item) => item.relativePath === relativePaths[3])!;
      await utimes(
        path.join(fixtureRoot, relativePaths[3]!),
        new Date(mtimeOnly.mtimeMs),
        new Date(mtimeOnly.mtimeMs + 5_000),
      );

      const verification = await verifyT23ReadonlySentinels(fixtureRoot, before);
      const byPath = new Map(verification.items.map((item) => [item.relativePath, item]));
      expect(verification.ok).toBe(false);
      expect(byPath.get(relativePaths[0]!)?.changedFields).toContain("exists");
      expect(byPath.get(relativePaths[1]!)?.changedFields).toContain("sha256");
      expect(byPath.get(relativePaths[2]!)?.changedFields).toContain("bytes");
      expect(byPath.get(relativePaths[3]!)?.changedFields).toContain("mtimeMs");
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("T23 主脚本复用共享哨兵，并保持截图与报告 wx 拒绝覆盖", async () => {
    const [script, helper] = await Promise.all([
      readFile(path.resolve("scripts/t23-layer4-project-ui-verify.ts"), "utf8"),
      readFile(path.resolve("scripts/lib/t23-project-ui-verify-shared.ts"), "utf8"),
    ]);
    expect(script).toContain("snapshotT23ReadonlySentinels");
    expect(script).toContain("verifyT23ReadonlySentinels");
    expect(script).toContain("snapshotT23ReadonlyProjectTree");
    expect(script).toContain("verifyT23ReadonlyProjectTree");
    expect(script).toContain("criticalContentChangedPaths");
    expect(script).not.toContain("formalProjectWrites: 0");
    expect(script).toContain("readonlySentinels:");
    expect(script).not.toContain("const READONLY_SENTINELS");
    expect(script).toMatch(/writeFile\(reportPath,[\s\S]*?flag:\s*"wx"/u);
    expect(helper).toMatch(/writeFile\(outputPath,\s*bytes,\s*\{\s*flag:\s*"wx"\s*\}\)/u);
    const rawShaScript = await readFile(path.resolve("scripts/t23-project-raw-sha-ui-verify.ts"), "utf8");
    expect(rawShaScript).toContain("new Image()");
    expect(rawShaScript).toContain("naturalWidth");
    expect(rawShaScript).toContain("status: \"SKIP\"");
    expect(rawShaScript).not.toContain("formalProjectWrites: 0");
  });
});
