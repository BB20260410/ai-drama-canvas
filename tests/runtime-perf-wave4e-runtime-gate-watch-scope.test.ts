import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  SOURCE_DIGEST_GLOBS,
  resolveSourceDigestWatchScope,
  sourceDigestPathIsRelevant,
  sourceDigestWatchPaths,
} from "../src/core/build-identity.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = (relative: string) => readFileSync(path.join(root, relative), "utf8");

describe("Wave 4-E runtime gate watcher 收窄", () => {
  it("默认常驻只递归订 src，tests/scripts 走开关", () => {
    expect(resolveSourceDigestWatchScope({})).toBe("resident");
    expect(sourceDigestWatchPaths(root, { env: {} })).toEqual([
      root,
      path.join(root, "src"),
    ]);
    expect(sourceDigestWatchPaths(root, { env: { AI_CANVAS_RUNTIME_GATE_WATCH_TESTS_SCRIPTS: "1" } })).toEqual([
      root,
      path.join(root, "src"),
      path.join(root, "tests"),
      path.join(root, "scripts"),
    ]);
  });

  it("身份枚举与事件过滤器仍含 tests/scripts，未关 packaged / ledger watcher", () => {
    expect(SOURCE_DIGEST_GLOBS).toEqual(expect.arrayContaining([
      "tests/**/*.{ts,json}",
      "scripts/**/*.{ts,mjs,js}",
    ]));
    expect(sourceDigestPathIsRelevant(root, path.join(root, "tests/example.test.ts"))).toBe(true);
    expect(sourceDigestPathIsRelevant(root, path.join(root, "scripts/example.ts"))).toBe(true);
    expect(source("src/mcp/server.ts")).toContain("sourceDigestWatchPaths(boot.workspace)");
    expect(source("src/main/index.ts")).toContain("sourceDigestWatchPaths(sourceRuntimeWorkspace)");
    expect(source("src/main/index.ts")).toContain("app.isPackaged");
    expect(source("src/main/index.ts")).toContain("createStudioGenerationLedgerWatcher");
    expect(source("src/main/studio-generation-ledger-watcher.ts")).toContain("chokidar.watch(aicanvasDir");
    expect(source("src/main/index.ts")).toMatch(/const sourceRuntimeBootIdentity = app\.isPackaged\s*\n\s*\? undefined/u);
  });
});
