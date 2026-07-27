/**
 * T18 源码基线清单：只读内容清单+哈希快照。
 * 分类正式源码/生成物/证据/项目数据/临时运行器。
 * 不 commit（待用户授权）。
 *
 * 用法：npx tsx scripts/source-baseline-inventory.ts
 */
import { createHash } from "node:crypto";
import { readFile, readdir, lstat } from "node:fs/promises";
import path from "node:path";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..");

interface InventoryEntry {
  relativePath: string;
  category: "source" | "generated" | "evidence" | "project-data" | "temporary" | "config" | "documentation";
  sha256: string;
  sizeBytes: number;
}

function categorize(relativePath: string): InventoryEntry["category"] {
  if (relativePath.startsWith("src/")) return "source";
  if (relativePath.startsWith("docs/evidence/")) return "evidence";
  if (relativePath.startsWith("docs/")) return "documentation";
  if (relativePath.startsWith("projects/")) return "project-data";
  if (relativePath.startsWith("dist/") || relativePath.startsWith("dist-mcp/") || relativePath.startsWith("out/")) return "generated";
  if (relativePath.startsWith("scripts/")) return "temporary";
  if (relativePath.startsWith("tests/")) return "source";
  if (relativePath.startsWith(".planning/")) return "documentation";
  if (relativePath.startsWith("node_modules/")) return "generated";
  if (/\.(json|ts|js|mjs)$/u.test(relativePath) && !relativePath.includes("/")) return "config";
  return "temporary";
}

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "dist-mcp", "out", "release"]);
const MAX_FILES = 5000;

async function walk(dir: string, base: string, entries: InventoryEntry[]): Promise<void> {
  if (entries.length >= MAX_FILES) return;
  const items = await readdir(dir, { withFileTypes: true });
  for (const item of items) {
    if (entries.length >= MAX_FILES) break;
    const fullPath = path.join(dir, item.name);
    const relativePath = path.relative(base, fullPath);
    if (item.isDirectory()) {
      if (SKIP_DIRS.has(item.name)) continue;
      await walk(fullPath, base, entries);
    } else if (item.isFile()) {
      try {
        const stat = await lstat(fullPath);
        if (stat.size > 10 * 1024 * 1024) continue; // 跳过 >10MB 文件
        const bytes = await readFile(fullPath);
        entries.push({
          relativePath,
          category: categorize(relativePath),
          sha256: createHash("sha256").update(bytes).digest("hex"),
          sizeBytes: stat.size,
        });
      } catch { /* 跳过不可读文件 */ }
    }
  }
}

async function main(): Promise<void> {
  console.log("T18 源码基线清单扫描...");
  const entries: InventoryEntry[] = [];
  await walk(PROJECT_ROOT, PROJECT_ROOT, entries);
  entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  const byCategory = new Map<string, number>();
  let totalSize = 0;
  for (const entry of entries) {
    byCategory.set(entry.category, (byCategory.get(entry.category) ?? 0) + 1);
    totalSize += entry.sizeBytes;
  }

  console.log(`\n扫描完成：${entries.length} 文件，${(totalSize / 1024 / 1024).toFixed(1)} MB`);
  console.log("\n分类统计：");
  for (const [category, count] of [...byCategory.entries()].sort()) {
    console.log(`  ${category}: ${count}`);
  }

  // 输出 JSON 清单
  const manifest = {
    schemaVersion: 1,
    kind: "source-baseline-inventory",
    projectRoot: PROJECT_ROOT,
    fileCount: entries.length,
    totalSizeBytes: totalSize,
    categories: Object.fromEntries(byCategory),
    entries: entries.slice(0, 500), // 只输出前 500 条摘要
    truncated: entries.length > 500,
    builtAt: new Date().toISOString(),
  };
  const outPath = path.join(PROJECT_ROOT, ".planning", "2026-07-24-infinite-canvas-unified-remediation", "source-baseline-inventory.json");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(outPath, JSON.stringify(manifest, null, 2));
  console.log(`\n清单已写入：${outPath}`);
}

main().catch((error) => {
  console.error("扫描失败：", error);
  process.exit(1);
});
