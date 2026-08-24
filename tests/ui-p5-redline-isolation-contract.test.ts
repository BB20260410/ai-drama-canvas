import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("P5 正式工程隔离合同", () => {
  it("只快照正式工程，全部 Core、注册表与 Electron 根目录都指向隔离副本", async () => {
    const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const source = await readFile(path.join(workspace, "scripts/ui-p5-multimedia-formal-smoke.ts"), "utf8");

    expect(source).toContain("createIsolatedRedlineProjectCopy(sourceProjectRoot)");
    expect(source).toContain("inspectManagedProject(isolated.projectRoot)");
    expect(source).toContain("AI_CANVAS_PROJECT_ROOT: isolated.projectRoot");
    expect(source).not.toContain("inspectManagedProject(sourceProjectRoot)");
    expect(source).not.toContain("AI_CANVAS_PROJECT_ROOT: sourceProjectRoot");
    expect(source).toContain("sourceProjectRoot,");
    expect(source).toContain("isolatedProjectCopy: true");
    expect(source).toContain("await isolated.cleanup()");
    expect(source).toContain("assertRedlineProjectSentinelsUnchanged(");
    expect(source).toContain("sourceProjectSentinelsBefore = await snapshotRedlineProjectSentinels(sourceProjectRoot)");
  });

  it("关闭、清理和正式工程复核完成前不落盘任何最终证据", async () => {
    const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const source = await readFile(path.join(workspace, "scripts/ui-p5-multimedia-formal-smoke.ts"), "utf8");
    const closeIndex = source.indexOf("await closeElectronApplicationOrThrow(application");
    const cleanupIndex = source.indexOf("await isolated.cleanup()");
    const absentIndex = source.indexOf("assertPathAbsent(isolated.runtimeRoot)");
    const sentinelIndex = source.indexOf("await assertRedlineProjectSentinelsUnchanged(");
    const pngWriteIndex = source.indexOf("await writeOwnedEvidenceOutput(\"overview\"");
    const jsonWriteIndex = source.indexOf("await writeOwnedEvidenceOutput(\"evidence\"");

    expect(source).toContain("async function captureScreenshotEvidence");
    expect(source).toContain("closeElectronApplicationOrThrow");
    expect(source).toContain("forceCleanupElectronApplication");
    expect(source).toContain("electronClose: null");
    expect(source).toContain("removeOwnedEvidenceOutputs");
    expect(source).toContain("writeOwnedEvidenceOutput");
    expect(source).toContain("AI_CANVAS_MEDIA_RUNTIME_DIR = mediaRuntimeRoot");
    expect(source).toContain("AI_CANVAS_MANAGED_PROJECTS_ROOT = managedProjectsRoot");
    expect(source).toContain("if (!outputsWritten || cleanupErrors.length > 0)");
    expect(source).toContain("cleanupErrors.push(...await removeOwnedEvidenceOutputs())");
    expect(closeIndex).toBeGreaterThan(-1);
    expect(cleanupIndex).toBeGreaterThan(closeIndex);
    expect(absentIndex).toBeGreaterThan(cleanupIndex);
    expect(sentinelIndex).toBeGreaterThan(absentIndex);
    expect(pngWriteIndex).toBeGreaterThan(sentinelIndex);
    expect(jsonWriteIndex).toBeGreaterThan(pngWriteIndex);
  });

  it("预存三份证据会在启动前失败，失败路径只删除本轮 wx 确认拥有的文件", async () => {
    const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const source = await readFile(path.join(workspace, "scripts/ui-p5-multimedia-formal-smoke.ts"), "utf8");
    const preflightIndex = source.indexOf("await Promise.all([\n  assertPathAbsent(evidencePath)");
    const mkdirIndex = source.indexOf("await mkdir(evidenceRoot, { recursive: true });");
    const tryIndex = source.indexOf("try {\n  isolated = await createIsolatedRedlineProjectCopy");

    expect(preflightIndex).toBeGreaterThan(-1);
    expect(mkdirIndex).toBeGreaterThan(preflightIndex);
    expect(tryIndex).toBeGreaterThan(mkdirIndex);
    expect(source).toContain("if (!outputOwned[kind]) continue;");
    expect(source).toContain('handle = await open(outputPath, "wx", 0o600);');
    expect(source).toContain("outputOwned[kind] = true;");
    expect(source).toContain("outputEverOwned[kind] = true;");
    expect(source).toContain("await handle.writeFile(content);");
    expect(source).toContain("await handle.close();");
    expect(source.indexOf('handle = await open(outputPath, "wx", 0o600);'))
      .toBeLessThan(source.indexOf("outputOwned[kind] = true;"));
    expect(source.indexOf("outputOwned[kind] = true;"))
      .toBeLessThan(source.indexOf("await handle.writeFile(content);"));
    expect(source.indexOf("await handle.writeFile(content);"))
      .toBeLessThan(source.indexOf("await handle.close();"));
    expect(source).not.toContain("rm(evidencePath, { force: true })");
  });

  it("异常清理失败会聚合进最终错误，而不是吞掉或产出 PASS", async () => {
    const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const source = await readFile(path.join(workspace, "scripts/ui-p5-multimedia-formal-smoke.ts"), "utf8");

    expect(source).toContain("const cleanupErrors: Error[] = [];");
    expect(source).toContain("const forced = await forceCleanupElectronApplication(application);");
    expect(source).toContain("await assertPathAbsent(isolatedPath);");
    expect(source).toContain("assertEverOwnedEvidenceOutputsAbsent");
    expect(source).toContain("primaryFailure = combineFailure(primaryFailure, cleanupErrors);");
    expect(source).toContain("if (primaryFailure) throw primaryFailure;");
  });
});
