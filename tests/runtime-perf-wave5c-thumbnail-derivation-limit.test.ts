import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  STUDIO_THUMBNAIL_DERIVATION_CONCURRENCY,
  createBoundedConcurrency,
} from "../src/core/studio-thumbnail-derivation-limit.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = (relative: string) => readFileSync(path.join(root, relative), "utf8");

describe("Wave 5-C 缩略派生并发上限", () => {
  it("闸与 15 秒向导同级为 4，超额任务排队且峰值不超过上限", async () => {
    expect(STUDIO_THUMBNAIL_DERIVATION_CONCURRENCY).toBe(4);
    const gate = createBoundedConcurrency(STUDIO_THUMBNAIL_DERIVATION_CONCURRENCY);
    let peak = 0;
    const tasks = Array.from({ length: 8 }, (_, index) =>
      gate.run(async () => {
        peak = Math.max(peak, gate.active);
        await new Promise((resolve) => setTimeout(resolve, 15));
        return index;
      }),
    );
    await expect(Promise.all(tasks)).resolves.toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(peak).toBe(STUDIO_THUMBNAIL_DERIVATION_CONCURRENCY);
    expect(gate.active).toBe(0);
  });

  it("失败任务释放名额，后续任务仍能进入", async () => {
    const gate = createBoundedConcurrency(2);
    await expect(gate.run(async () => {
      throw new Error("派生失败");
    })).rejects.toThrow(/派生失败/u);
    await expect(gate.run(async () => "ok")).resolves.toBe("ok");
    expect(gate.active).toBe(0);
  });

  it("materializeThumbnail 源图 sharp 走闸；recipe / recipeKey 未改", () => {
    const owner = source("src/core/material-studio.ts");
    expect(owner).toContain("studioThumbnailDerivationGate.run");
    expect(owner).toContain("material-studio-thumb:v1:autorotate:inside-512:no-enlarge:webp-q82");
    expect(owner).toContain("createHash(\"sha256\").update(`${THUMBNAIL_RECIPE}\\0${mediaSha256}`");
    expect(owner).toContain(".resize({ width: 512, height: 512, fit: \"inside\", withoutEnlargement: true })");
    expect(owner).toContain(".webp({ quality: 82 })");
    const deriveAt = owner.indexOf("studioThumbnailDerivationGate.run");
    const objectSharpAt = owner.indexOf("loadSharpDefault())(objectPath");
    expect(deriveAt).toBeGreaterThan(-1);
    expect(objectSharpAt).toBeGreaterThan(deriveAt);
    expect(objectSharpAt - deriveAt).toBeLessThan(120);
  });
});
