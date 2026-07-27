import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { runStudioFusionHelper } from "../src/core/studio-fusion-product-helpers.js";
import { executeStudioShotCompose, planStudioShotCompose } from "../src/core/studio-shot-compose.js";

describe("runStudioFusionHelper product entry", () => {
  it("shot-compose-plan + element-bind + video-prompt + staging-demo", () => {
    const plan = runStudioFusionHelper({
      operation: "shot-compose-plan",
      payload: {
        visualPath: "/tmp/a.png",
        visualKind: "still",
        outputFileName: "out.mp4",
        durationSeconds: 2,
      },
    });
    expect(plan.ok).toBe(true);

    const bind = runStudioFusionHelper({
      operation: "element-bind",
      payload: {
        panelId: "p1",
        assetId: "character-r07-dudu",
        allowedAssetIds: ["character-r07-dudu"],
      },
    });
    expect(bind.ok).toBe(true);

    const badBind = runStudioFusionHelper({
      operation: "element-bind",
      payload: { panelId: "p1", assetId: "character-x", allowedAssetIds: ["character-r07-dudu"] },
    });
    expect(badBind.ok).toBe(false);

    const vp = runStudioFusionHelper({
      operation: "video-prompt",
      payload: { videoPrompt: "0-3秒：开场。\n3-6秒：推进。" },
    });
    expect(vp.ok).toBe(true);

    const st = runStudioFusionHelper({
      operation: "staging-demo",
      payload: { id: "s1", decision: "accept" },
    });
    expect(st.ok).toBe(true);
  });

  it("shot-number intercalate 10/20 → 15", () => {
    const r = runStudioFusionHelper({
      operation: "shot-number-intercalate",
      payload: { before: 10, after: 20 },
    });
    expect(r.ok).toBe(true);
    expect((r.result as { number: number }).number).toBe(15);
  });
});

describe("executeStudioShotCompose real ffmpeg", () => {
  it("still → mp4 产出非空文件与稳定 sha 长度", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "shot-compose-"));
    const still = path.join(dir, "still.png");
    await sharp({
      create: { width: 64, height: 36, channels: 3, background: { r: 20, g: 40, b: 80 } },
    })
      .png()
      .toFile(still);

    const plan = planStudioShotCompose({
      visualPath: still,
      visualKind: "still",
      outputFileName: "unit.mp4",
      durationSeconds: 1,
    });
    expect(plan.readyForFfmpeg).toBe(true);

    const result = await executeStudioShotCompose({
      visualPath: still,
      visualKind: "still",
      outputFileName: "unit.mp4",
      durationSeconds: 1,
      outputDir: dir,
    });
    expect(result.bytes).toBeGreaterThan(500);
    expect(result.outputSha256).toMatch(/^[a-f0-9]{64}$/);
    const buf = await readFile(result.outputPath);
    expect(createHash("sha256").update(buf).digest("hex")).toBe(result.outputSha256);
  }, 60_000);
});
