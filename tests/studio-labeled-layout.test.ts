import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import {
  formatStudioPanelTitle,
  materializeStudioLabeledLayout,
  StudioLabeledLayoutError,
} from "../src/core/studio-labeled-layout.js";

const temps: string[] = [];

afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeRawPng(dir: string, name: string, color: { r: number; g: number; b: number }): Promise<string> {
  const file = path.join(dir, name);
  await sharp({
    create: { width: 360, height: 640, channels: 3, background: color },
  }).png().toFile(file);
  return file;
}

describe("studio-labeled-layout", () => {
  it("从 raw 本地派生 labeled：可解码、SHA 不同、拒绝覆盖", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "studio-labeled-"));
    temps.push(dir);
    const rawPath = await makeRawPng(dir, "raw.png", { r: 40, g: 50, b: 60 });
    const out = path.join(dir, "labeled.png");

    const result = await materializeStudioLabeledLayout({
      rawPath,
      outputPath: out,
      labels: {
        panelTitle: formatStudioPanelTitle("单元甲", 1),
        subtitle: "阿航：不要动。",
        badge: "grok",
      },
    });

    expect(result.kind).toBe("studio-local-labeled-layout");
    expect(result.recipe).toBe("chinese-panel-chrome-v1");
    expect(result.width).toBe(360);
    expect(result.height).toBe(640);
    expect(result.rawSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.labeledSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.labeledSha256).not.toBe(result.rawSha256);
    expect(result.labels.panelTitle).toContain("第 1 格");

    const labeledBytes = await readFile(out);
    expect(labeledBytes.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const meta = await sharp(out).metadata();
    expect(meta.width).toBe(360);
    expect(meta.height).toBe(640);
    expect(createHash("sha256").update(labeledBytes).digest("hex")).toBe(result.labeledSha256);

    await expect(materializeStudioLabeledLayout({
      rawPath,
      outputPath: out,
      labels: { panelTitle: "重复", subtitle: "x" },
    })).rejects.toMatchObject({ code: "output-failed" });
  });

  it("非法 panelIndex 与不可解码源失败关闭", async () => {
    expect(() => formatStudioPanelTitle("U", 0)).toThrow(StudioLabeledLayoutError);
    expect(() => formatStudioPanelTitle("U", 7)).toThrow(StudioLabeledLayoutError);

    const dir = await mkdtemp(path.join(tmpdir(), "studio-labeled-bad-"));
    temps.push(dir);
    const junk = path.join(dir, "junk.bin");
    await writeFile(junk, Buffer.from("not-an-image"));
    await expect(materializeStudioLabeledLayout({
      rawPath: junk,
      outputPath: path.join(dir, "out.png"),
      labels: { panelTitle: "x" },
    })).rejects.toMatchObject({ code: "decode-failed" });
  });
});
