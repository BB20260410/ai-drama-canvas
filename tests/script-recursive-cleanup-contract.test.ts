import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const workspace = process.cwd();
const scriptsRoot = path.join(workspace, "scripts");
const recursiveRmPattern = /\brm\(\s*([^,\n]+?)\s*,\s*\{[^}]*\brecursive\s*:\s*true[^}]*\}\s*\)/gsu;

const auditedExceptions = new Map<string, string>([
  ["scripts/build-icon.mjs::iconset", "固定 build/icon.iconset 仅为仓库构建派生目录，由 build-icon 单一 owner 重建。"],
  ["scripts/lib/owned-fixture-root.ts::tombstone", "删除前已校验 marker/canonical/inode 并原子 rename 为本次 UUID tombstone。"],
  ["scripts/measure-p24-trace-scale.ts::fixture.root", "fixture 由 fresh mkdtemp parent 下的 createStudioP7Fixture 创建。"],
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
});
