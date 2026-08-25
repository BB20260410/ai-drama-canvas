/**
 * Wave 4 补刀：get_capabilities(projectRoot) 读分析配置不得加载小说分析整图。
 */
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getCapabilities } from "../src/core/codex.js";
import {
  emptyNovelAnalysisProviderSettings,
  getNovelAnalysisProviderSettings,
  validateNovelAnalysisProviderSettings,
} from "../src/core/novel-analysis-provider-settings.js";
import * as novelAnalysisProviderLazy from "../src/core/novel-analysis-provider-lazy.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = (relative: string) => readFileSync(path.join(root, relative), "utf8");

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Wave 4 get_capabilities 读分析配置走薄模块", () => {
  it("薄模块：缺文件为空配置；坏结构失败关闭", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "w4-analysis-settings-"));
    await expect(getNovelAnalysisProviderSettings(tmp)).resolves.toEqual(emptyNovelAnalysisProviderSettings());
    expect(() => validateNovelAnalysisProviderSettings({})).toThrow(/结构损坏/);
    expect(() => validateNovelAnalysisProviderSettings({
      schemaVersion: 1,
      revision: 1,
      providers: [],
      updatedAt: "2026-08-25T00:00:00.000Z",
      defaultProviderId: "missing",
    })).toThrow(/默认 Provider 不存在/);
  });

  it("getCapabilities 源码不再 withNovelAnalysisProvider", () => {
    const codex = source("src/core/codex.ts");
    const start = codex.indexOf("export async function getCapabilities");
    const end = codex.indexOf("export async function getProjectChanges");
    const body = codex.slice(start, end);
    expect(body).toContain("getNovelAnalysisProviderSettings");
    expect(body).not.toContain("withNovelAnalysisProvider");
    expect(source("src/core/codex.ts")).toContain('from "./novel-analysis-provider-settings.js"');
    expect(source("src/core/novel-analysis-provider.ts")).toContain('from "./novel-analysis-provider-settings.js"');
  });

  it("运行时：带 projectRoot 握手不调用 withNovelAnalysisProvider", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "w4-cap-settings-"));
    await mkdir(path.join(tmp, "story"), { recursive: true });
    await writeFile(path.join(tmp, "story", "analysis-providers.json"), JSON.stringify({
      schemaVersion: 1,
      revision: 1,
      providers: [],
      updatedAt: "2026-08-25T00:00:00.000Z",
    }), "utf8");
    const spy = vi.spyOn(novelAnalysisProviderLazy, "withNovelAnalysisProvider").mockImplementation(async () => {
      throw new Error("get_capabilities 不得加载小说分析整图");
    });
    const capabilities = await getCapabilities(tmp);
    expect(spy).not.toHaveBeenCalled();
    expect(capabilities.project).toEqual(expect.objectContaining({
      root: expect.any(String),
      novelAnalysisProviders: [],
    }));
  });
});
