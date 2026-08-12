import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const workspace = process.cwd();
const scriptsRoot = path.join(workspace, "scripts");
const recursiveRmPattern = /\brm\(\s*([^,\n]+?)\s*,\s*\{[^}]*\brecursive\s*:\s*true[^}]*\}\s*\)/gsu;

const auditedExceptions = new Map<string, string>([
  ["scripts/build-icon.mjs::iconset", "固定 build/icon.iconset 仅为仓库构建派生目录，由 build-icon 单一 owner 重建。"],
  ["scripts/lib/immutable-mcp-candidate-stage.ts::absolutePath", "仅命中隔离 stage 中已规范遍历确认的 node_modules/.bin 目录；stage 来自本次 fresh mkdtemp，不触及 live node_modules。"],
  ["scripts/lib/immutable-mcp-candidate-cutover.ts::temporaryCandidateRoot", "只接受主入口在规范 candidate 输出根下 fresh mkdtemp 创建的候选目录；复用已有候选时由同一 cutover owner 回收这份临时副本。"],
  ["scripts/lib/immutable-mcp-candidate-cutover.ts::stagedLauncher.temporaryDirectory", "目录由 stageStableLauncher 内 fresh mkdtemp 创建并随同返回；只持有本次 launcher 临时副本，最终 rename 或失败后均由同一 cutover owner 回收。"],
  ["scripts/lib/owned-fixture-root.ts::tombstone", "删除前已校验 marker/canonical/inode 并原子 rename 为本次 UUID tombstone。"],
  ["scripts/measure-p24-trace-scale.ts::fixture.root", "fixture 由 fresh mkdtemp parent 下的 createStudioP7Fixture 创建。"],
  ["scripts/ui-native-media-drag-smoke.ts::directory", "目录来自隔离 App 私有 exportRoot 的前后差集，已严格复验 drag 目录与唯一普通文件；应用退出清理后仅作兜底回收。"],
]);

function targetHasFreshMkdtempBinding(source: string, target: string): boolean {
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(target)) return false;
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(?:const|let)\\s+${escaped}\\b[\\s\\S]{0,220}?\\bmkdtemp\\s*\\(`, "u").test(source)
    || new RegExp(`\\b${escaped}\\s*=[\\s\\S]{0,220}?\\bmkdtemp\\s*\\(`, "u").test(source);
}

describe("脚本递归清理 owner 合同", () => {
  it("每个 scripts/** recursive rm 仅删除 fresh mkdtemp 根或显式审计的 owner 目标", async () => {
    const entries = await readdir(scriptsRoot, { recursive: true });
    const files = entries
      .filter((entry) => /\.(?:ts|mjs|js)$/u.test(entry))
      .sort((left, right) => left.localeCompare(right, "en"));
    const violations: string[] = [];
    const observedExceptions = new Set<string>();

    for (const relativeEntry of files) {
      const relativePath = path.posix.join("scripts", relativeEntry.split(path.sep).join("/"));
      const source = await readFile(path.join(scriptsRoot, relativeEntry), "utf8");
      for (const match of source.matchAll(recursiveRmPattern)) {
        const target = match[1]!.trim();
        const key = `${relativePath}::${target}`;
        if (auditedExceptions.has(key)) {
          observedExceptions.add(key);
          continue;
        }
        if (!targetHasFreshMkdtempBinding(source, target)) violations.push(key);
      }
    }

    expect(violations, "recursive rm 必须绑定 fresh mkdtemp 或显式审计 owner").toEqual([]);
    expect([...observedExceptions].sort()).toEqual([...auditedExceptions.keys()].sort());
    for (const reason of auditedExceptions.values()) expect(reason.length).toBeGreaterThan(20);
  });

  it("真实拖拽子进程与父验收器共享 owner，并在删除前复核 marker/inode", async () => {
    const [harness, runner] = await Promise.all([
      readFile(path.join(scriptsRoot, "ui-native-media-drag-physical-harness.ts"), "utf8"),
      readFile(path.join(scriptsRoot, "run-native-media-drag-physical-acceptance.ts"), "utf8"),
    ]);
    const owner = 'const NATIVE_DRAG_RUNTIME_OWNER = "native-media-drag-physical-harness"';
    expect(harness).toContain(owner);
    expect(runner).toContain(owner);
    expect(harness).toContain("mkdtempOwnedFixtureRoot(");
    expect(harness).toContain("removeOwnedTemporaryFixtureRoot(runtimeRoot, NATIVE_DRAG_RUNTIME_OWNER)");
    expect(harness).toContain("runtimeOwnerId: NATIVE_DRAG_RUNTIME_OWNER");
    expect(runner).toContain("candidate.runtimeOwnerId === NATIVE_DRAG_RUNTIME_OWNER");
    expect(runner).toContain("removeOwnedTemporaryFixtureRoot(runtimeRoot, NATIVE_DRAG_RUNTIME_OWNER)");
    expect(harness).not.toContain("rm(runtimeRoot, { recursive: true");
    expect(runner).not.toContain("rm(runtimeRoot, { recursive: true");
  });
});
