import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

/** P24 追溯 UI 合同与 IPC 桌面接线锚点（规范 §4-7/§4-8）。 */

async function source(relativePath: string): Promise<string> {
  return readFile(path.join(process.cwd(), relativePath), "utf8");
}

describe("P24 追溯 UI 合同（U1–U4 诊断面）", () => {
  it("U1/U2：控制页冻结包身份与结果行生成时身份/变化分类；renderer 不 import classify/studio-trace", async () => {
    const view = await source("src/renderer/src/components/StudioGenerationControlView.vue");
    // U1：冻结包身份区（生成时版本）+单包 IPC 通道。
    expect(view).toContain('data-testid="studio-pack-identity"');
    expect(view).toContain("冻结包身份（生成时版本）");
    expect(view).toContain("getStudioFrozenPack");
    expect(view).toContain("scriptRevisionId");
    expect(view).toContain("unitSnapshotFingerprint");
    // U2：结果行生成时身份+变化分类（经 pack-currentness IPC 懒加载——首次展开才取，错误可重试；切工程清缓存）。
    expect(view).toContain("studio-result-identity-");
    expect(view).toContain("生成时身份");
    expect(view).toContain("getStudioPackCurrentness");
    expect(view).toContain("changeClassificationLabel");
    expect(view).toContain("预期变化");
    expect(view).toContain("非预期变化");
    expect(view).toContain("ensurePackCurrentness");
    expect(view).toContain('@toggle="onResultIdentityToggle(item.packId)"');
    expect(view).toContain("packCurrentness.value = {};");
    // renderer 不自行分类（单一映射在 core 纯模块）。
    expect(view).not.toContain("studio-stale-classification");
    expect(view).not.toContain("studio-trace");
  });

  it("U3：审片 Review 历史条目提交时身份（投影已带字段，纯渲染扩展）", async () => {
    const view = await source("src/renderer/src/components/StudioContinuityReviewView.vue");
    expect(view).toContain("studio-review-identity-");
    expect(view).toContain("提交时身份（生成时版本）");
    expect(view).toContain("review.packId");
    expect(view).toContain("review.packFingerprint.slice(0, 12)");
    expect(view).toContain("review.rawSha256.slice(0, 12)");
    expect(view).toContain("review.labeledSha256.slice(0, 12)");
  });

  it("U4：素材详情修订历史（≤20 条新→旧，标记当前；经 props.api.listTextRevisions）", async () => {
    const view = await source("src/renderer/src/components/MaterialStudioView.vue");
    expect(view).toContain('data-testid="studio-text-revision-history"');
    expect(view).toContain("修订历史（最新在前，仅前 20 条）");
    expect(view).toContain("listTextRevisions");
    expect(view).toContain("textRevisionsLoading");
    expect(view).toContain("revision.ordinal === detail.revision");
    const app = await source("src/renderer/src/App.vue");
    expect(app).toContain("listTextRevisions: (root, query) => window.canvasApi.listStudioTextRevisions(root, query)");
  });
});

describe("P24 追溯 IPC 桌面接线（§4-8）", () => {
  it("main 三条只读通道均经受管校验；preload 暴露同名", async () => {
    const [main, preload] = await Promise.all([
      source("src/main/index.ts"),
      source("src/preload/index.ts"),
    ]);
    for (const channel of ["canvas:get-studio-generation-control", "canvas:get-studio-frozen-pack", "canvas:get-studio-pack-currentness", "canvas:list-studio-text-revisions"]) {
      expect(main).toContain(`ipcMain.handle("${channel}"`);
      const handlerStart = main.indexOf(`ipcMain.handle("${channel}"`);
      const handler = main.slice(handlerStart, handlerStart + 600);
      expect(handler).toContain("requireManagedStudioProject(projectRoot)");
    }
    // 通道名与参数序列是合同；调用者对象放宽为 .invoke( 前缀，兼容 preload 把
    // 只读通道接入 t23IpcPerformanceProbe 计时包装（内部仍是 ipcRenderer.invoke）。
    expect(preload).toContain('invoke("canvas:get-studio-frozen-pack", projectRoot, packId)');
    expect(preload).toContain('invoke("canvas:get-studio-pack-currentness", projectRoot, packId)');
    expect(preload).toContain('invoke("canvas:list-studio-text-revisions", projectRoot, query)');
    expect(preload).toContain('invoke("canvas:get-studio-generation-control", projectRoot, query)');
    expect(main).toContain("getStudioGenerationControlEnvelope(projectRoot, query)");
    expect(main).toContain("readAnyStudioGenerationFrozenPack(projectRoot, packId)");
    // pack-currentness 在 main 侧走 target-aware 聚合（内部逐 BindingSet 仍经
    // buildStudioAssetBindingCurrentContext→currentness→classify 纯模块，与 trace 同一映射点；退化资产归 unexpected）。
    expect(main).toContain("evaluateStudioGenerationPackCurrentness(projectRoot, pack)");
    expect(main).toContain('from "../core/studio-trace.js"');
    const traceCore = await source("src/core/studio-trace.ts");
    expect(traceCore).toContain("unit-grid 不伪造某一格 BindingSet 为整板身份");
    expect(traceCore).toContain("evaluatePackBindingCurrentness(projectRoot, bindingSetId)");
    expect(traceCore).toContain("buildStudioAssetBindingCurrentContext(projectRoot, bindingSetId)");
    expect(traceCore).toContain("getStudioAssetBindingSetCurrentness(projectRoot, bindingSetId, context)");
    expect(traceCore).toContain("classifyStudioStaleReasons(bindingSetStaleReasons)");
  });
});
