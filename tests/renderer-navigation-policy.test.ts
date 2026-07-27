import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { isRendererNavigationAllowed } from "../src/main/renderer-navigation-policy.js";

describe("renderer navigation policy", () => {
  it("开发态只允许实际 renderer origin，不接受任意 localhost 或端口", () => {
    const rendererUrl = "http://127.0.0.1:5173/studio";
    const policy = { devRendererUrl: rendererUrl, packagedEntryPath: "/unused/index.html" };
    expect(isRendererNavigationAllowed("http://127.0.0.1:5173/other?x=1", policy)).toBe(true);
    expect(isRendererNavigationAllowed("http://localhost:5173/studio", policy)).toBe(false);
    expect(isRendererNavigationAllowed("http://127.0.0.1:9999/studio", policy)).toBe(false);
    expect(isRendererNavigationAllowed("https://127.0.0.1:5173/studio", policy)).toBe(false);
  });

  it("安装态只允许打包 index.html 本身，拒绝同目录其他文件与外部 URL", () => {
    const entry = path.resolve("/Applications/AI 漫剧画布.app/Contents/Resources/app.asar/out/renderer/index.html");
    const policy = { packagedEntryPath: entry };
    expect(isRendererNavigationAllowed(`${pathToFileURL(entry).href}?mode=canvas#panel`, policy)).toBe(true);
    expect(isRendererNavigationAllowed(pathToFileURL(path.join(path.dirname(entry), "other.html")).href, policy)).toBe(false);
    expect(isRendererNavigationAllowed("http://localhost:5173/", policy)).toBe(false);
  });
});
