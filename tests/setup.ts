import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll } from "vitest";

const registryPath = path.join(os.tmpdir(), `ai-canvas-test-registry-${process.pid}.json`);
const mediaRuntimePath = path.join(os.tmpdir(), `ai-canvas-test-media-runtime-${process.pid}`);
process.env.AI_CANVAS_REGISTRY_PATH = registryPath;
process.env.AI_CANVAS_MEDIA_RUNTIME_DIR = mediaRuntimePath;
process.env.AI_CANVAS_MEDIA_CAPACITY = "4";
// 单测默认 compat：不强制每条 gen 写先 acquire；require 行为见 studio-project-write-lease.test.ts
if (!process.env.AI_CANVAS_WRITE_LEASE_MODE) {
  process.env.AI_CANVAS_WRITE_LEASE_MODE = "compat";
}
// 允许并行 MCP 子进程测例
if (!process.env.AI_CANVAS_MCP_ALLOW_MULTI) {
  process.env.AI_CANVAS_MCP_ALLOW_MULTI = "1";
}

afterAll(async () => {
  await rm(registryPath, { force: true });
  await rm(mediaRuntimePath, { recursive: true, force: true });
});
