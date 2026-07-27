import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    testTimeout: 30_000,
    // 多个测试会启动真实 FFmpeg、Electron-as-Node 与 stdio MCP 子进程；限制文件并发，
    // 避免 18 核机器同时跑十余条编解码链导致单测从约 6 秒饥饿到 120 秒超时。
    maxWorkers: 2,
  },
});
