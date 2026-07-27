import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildLocalCreativeSourceDocumentInventory } from "../src/core/local-creative-document-inventory.js";
import { inspectLocalCreativeProject } from "../src/core/local-creative-project-ingest.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("本机创作文档语义盘点", () => {
  it("把剧本、提示词、分镜、设定、索引和验收分开，只有剧本/提示词进入对应 CAS", async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "ai-canvas-document-inventory-")));
    roots.push(root);
    await mkdir(path.join(root, "docs"));
    await Promise.all([
      writeFile(path.join(root, "S1E1_剧本.md"), "剧本\n"),
      writeFile(path.join(root, "U01_视频提示词.txt"), "提示词\n"),
      writeFile(path.join(root, "01_分镜故事板.md"), "分镜\n"),
      writeFile(path.join(root, "docs", "设定圣经.md"), "设定\n"),
      writeFile(path.join(root, "00_索引.md"), "索引\n"),
      writeFile(path.join(root, "03_最终验收报告.md"), "验收\n"),
      writeFile(path.join(root, "manifest.json"), "{}\n"),
      writeFile(path.join(root, "附件.pdf"), Buffer.from("%PDF-1.4\n")),
    ]);
    const preview = await inspectLocalCreativeProject({
      projectKey: "classification-test",
      projectName: "分类测试",
      projectType: "story-production",
      sourceLayers: [{ role: "PRIMARY_AUTHORITY", rootPath: root }],
    });
    const inventory = buildLocalCreativeSourceDocumentInventory(preview);
    expect(inventory.total).toBe(8);
    expect(inventory.byClass).toMatchObject({
      script: 1,
      prompt: 1,
      storyboard: 1,
      bible: 1,
      index: 1,
      qc: 1,
      manifest: 1,
    });
    expect(inventory.byImportTarget).toEqual({
      script: 1,
      prompt: 1,
      "inventory-only": 4,
      unsupported: 2,
      rejected: 0,
    });
    expect(inventory.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
  });
});
