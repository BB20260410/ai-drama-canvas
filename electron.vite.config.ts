import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import vue from "@vitejs/plugin-vue";
import { computeSourceDigest } from "./src/core/build-identity.js";

function recordedSourceDigest(): string {
  const manifest = JSON.parse(readFileSync(resolve("release-manifest.json"), "utf8")) as {
    sourceDigest?: unknown;
  };
  if (typeof manifest.sourceDigest !== "string" || !/^[a-f0-9]{64}$/u.test(manifest.sourceDigest)) {
    throw new Error("release-manifest.json 缺少有效 sourceDigest，拒绝构建无来源证明的源码运行时。");
  }
  return manifest.sourceDigest;
}

export default defineConfig(async ({ command }) => {
  // 开发态由 electron-vite 现场编译当前源码，必须绑定现场摘要；继续读取旧发布
  // 清单会让新源码一启动就被运行时写闸门判为 stale。正式 build 仍只信发布清单，
  // 不允许用开发态动态摘要绕过发布身份合同。
  const buildSourceDigest = command === "serve"
    ? (await computeSourceDigest(resolve("."))).sourceDigest
    : recordedSourceDigest();
  return {
    main: {
      plugins: [externalizeDepsPlugin()],
      define: {
        "globalThis.__AI_CANVAS_BUILD_SOURCE_DIGEST__": JSON.stringify(buildSourceDigest),
      },
      resolve: {
        alias: {
          "@core": resolve("src/core"),
        },
      },
    },
    preload: {
      plugins: [externalizeDepsPlugin()],
    },
    renderer: {
      resolve: {
        alias: {
          "@": resolve("src/renderer/src"),
          "@core": resolve("src/core"),
        },
      },
      plugins: [vue()],
    },
  };
});
