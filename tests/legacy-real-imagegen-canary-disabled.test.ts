import { spawn } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

function runLegacy(rawPath: string, outputPath: string): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      "--import", "tsx", "scripts/run-real-imagegen-canary.ts",
      "--provider", "codex", "--raw", rawPath, outputPath,
    ], { cwd: path.resolve("."), stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stderr }));
  });
}

describe("旧版真实 imagegen canary", () => {
  it("无论输入何种 raw 都失败关闭，且不落假证据", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "legacy-imagegen-canary-disabled-"));
    const evidence = path.join(root, "legacy-evidence.json");
    try {
      const result = await runLegacy(path.join(root, "does-not-matter.png"), evidence);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("旧版真实 imagegen canary 已永久停用");
      await expect(access(evidence)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
