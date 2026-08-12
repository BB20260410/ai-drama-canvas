import { describe, expect, it } from "vitest";
import {
  STORYBOARD_WIZARD_ASSET_READ_CONCURRENCY,
  resolveStoryboardWizardAssets,
} from "../src/renderer/src/storyboard-wizard-assets.js";

describe("resolveStoryboardWizardAssets", () => {
  it("去重、保序并将只读资产 IPC 并发限制为 4", async () => {
    const panels = [
      { suggestedAssetIds: ["asset-1", "asset-2", "asset-3", "asset-4", "asset-5"] },
      { suggestedAssetIds: ["asset-2", "asset-6", "asset-missing", "asset-7"] },
    ];
    let active = 0;
    let maximumActive = 0;
    const calls: string[] = [];
    const assets = await resolveStoryboardWizardAssets(panels, async (assetId) => {
      calls.push(assetId);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      return assetId === "asset-missing" ? null : { id: assetId };
    });

    expect(STORYBOARD_WIZARD_ASSET_READ_CONCURRENCY).toBe(4);
    expect(maximumActive).toBe(4);
    expect(calls).toEqual([
      "asset-1",
      "asset-2",
      "asset-3",
      "asset-4",
      "asset-5",
      "asset-6",
      "asset-missing",
      "asset-7",
    ]);
    expect([...assets.keys()]).toEqual([
      "asset-1",
      "asset-2",
      "asset-3",
      "asset-4",
      "asset-5",
      "asset-6",
      "asset-7",
    ]);
  });

  it("保持原有失败关闭语义，不吞掉资产读取异常", async () => {
    await expect(resolveStoryboardWizardAssets(
      [{ suggestedAssetIds: ["asset-ok", "asset-failed"] }],
      async (assetId) => {
        if (assetId === "asset-failed") throw new Error("asset read failed");
        return { id: assetId };
      },
    )).rejects.toThrow("asset read failed");
  });
});
