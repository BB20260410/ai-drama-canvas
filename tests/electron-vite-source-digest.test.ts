import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import electronViteConfig from "../electron.vite.config.js";
import { computeSourceDigest } from "../src/core/build-identity.js";

async function resolvedConfig(command: "serve" | "build") {
  if (typeof electronViteConfig !== "function") {
    throw new Error("electron.vite.config 必须按 serve/build 解析运行时来源身份。");
  }
  return electronViteConfig({
    command,
    mode: command === "serve" ? "development" : "production",
  });
}

describe("Electron Vite 运行时来源摘要", () => {
  it("dev 绑定当前源码摘要，build 继续绑定发布清单摘要", async () => {
    const workspace = path.resolve(process.cwd());
    const current = await computeSourceDigest(workspace);
    const dev = await resolvedConfig("serve");
    expect(dev.main?.define?.["globalThis.__AI_CANVAS_BUILD_SOURCE_DIGEST__"])
      .toBe(JSON.stringify(current.sourceDigest));

    const release = JSON.parse(await readFile(
      path.join(workspace, "release-manifest.json"),
      "utf8",
    )) as { sourceDigest?: unknown };
    expect(release.sourceDigest).toMatch(/^[a-f0-9]{64}$/u);
    const build = await resolvedConfig("build");
    expect(build.main?.define?.["globalThis.__AI_CANVAS_BUILD_SOURCE_DIGEST__"])
      .toBe(JSON.stringify(release.sourceDigest));
  }, 120_000);
});
