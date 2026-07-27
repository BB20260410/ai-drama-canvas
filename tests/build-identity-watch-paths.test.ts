import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  listSourceDigestFiles,
  sourceDigestPathIsRelevant,
  sourceDigestWatchPaths,
} from "../src/core/build-identity.js";

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("sourceDigest watcher 合同", () => {
  it("只暴露 workspace 浅层与三个递归源码根", () => {
    expect(sourceDigestWatchPaths(workspace)).toEqual([
      workspace,
      path.join(workspace, "src"),
      path.join(workspace, "tests"),
      path.join(workspace, "scripts"),
    ]);
  });

  it.each([
    "package.json",
    "package-lock.json",
    "vitest.config.ts",
    "electron.vite.config.ts",
    "tsconfig.json",
    "tsconfig.mcp.json",
    "src/main/index.ts",
    "src/renderer/src/App.vue",
    "src/renderer/src/style.css",
    "src/renderer/index.html",
    "tests/example.test.ts",
    "tests/fixtures/example.json",
    "scripts/example.ts",
    "scripts/example.mjs",
    "scripts/example.js",
  ])("接受会进入 sourceDigest 的文件：%s", (relativePath) => {
    expect(sourceDigestPathIsRelevant(workspace, path.join(workspace, relativePath))).toBe(true);
  });

  it.each([
    ".",
    "../outside.ts",
    "node_modules/dependency/index.ts",
    "src/example/node_modules/dependency.ts",
    "src/example/dist/generated.ts",
    "tests/example/dist-mcp/generated.ts",
    "scripts/example/out/generated.ts",
    "dist-mcp/mcp/server.js",
    "out/main/index.js",
    "projects/project.json",
    "src/README.md",
    "tests/README.md",
    "scripts/example.json",
    "scripts/qa-dudu-storyboard.ts",
  ])("拒绝不会进入 sourceDigest 的文件：%s", (relativePath) => {
    expect(sourceDigestPathIsRelevant(workspace, path.resolve(workspace, relativePath))).toBe(false);
  });

  it("当前真实枚举文件全部能通过同源事件过滤器", async () => {
    const files = await listSourceDigestFiles(workspace);
    expect(files.length).toBeGreaterThan(0);
    expect(files.filter((filePath) => !sourceDigestPathIsRelevant(workspace, filePath))).toEqual([]);
    expect(files.some((filePath) => filePath.endsWith("scripts/qa-dudu-storyboard.ts"))).toBe(false);
  });
});
