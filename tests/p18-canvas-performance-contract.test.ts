import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * P18 旧画布性能合同（审核补漏）：锁住两项修复的关键语义，防止回退。
 * - 缩放不再触发 rebuildFlow（watch 源无 zoom、无 deep 遍历、仅 compactZoom 阈值跨越）；
 * - rebuildFlow 不直接发 loadLayout IPC（必须经 ensureLayoutPositions 缓存）；
 * - persistLayoutPositions 先并缓存后落盘；ensureLayoutPositions 失败不记键可重试。
 */
describe("P18 旧画布性能合同", () => {
  const app = readFileSync(path.join(process.cwd(), "src/renderer/src/App.vue"), "utf8");

  it("画布 watch 不再包含 zoom 源，也不做 deep 遍历", () => {
    expect(app).toContain("const compactZoom = computed(() => zoom.value < 0.35)");
    expect(app).toContain("watch([visibleItems, viewKey, compactZoom], () => void rebuildFlow())");
    expect(app).not.toContain("watch([visibleItems, viewKey, zoom");
    expect(app).not.toContain("watch([visibleItems, viewKey, compactZoom], () => void rebuildFlow(), { deep: true })");
  });

  it("nodes/edges 使用 shallowRef（整页替换语义，避免深层响应式）", () => {
    expect(app).toContain("const nodes = shallowRef<Node[]>([])");
    expect(app).toContain("const edges = shallowRef<Edge[]>([])");
    expect(app).not.toContain("const nodes = ref<Node[]>([])");
    expect(app).not.toContain("const edges = ref<Edge[]>([])");
  });

  it("rebuildFlow 不直接调用 loadLayout，只能经 ensureLayoutPositions 缓存", () => {
    const start = app.indexOf("async function rebuildFlow(");
    const end = app.indexOf("function onNodeClick", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = app.slice(start, end);
    expect(body).toContain("await ensureLayoutPositions(token, frozenViewKey)");
    expect(body).not.toContain("loadLayout(");
  });

  it("persistLayoutPositions 先并入缓存再落盘；ensureLayoutPositions 失败不记键", () => {
    const persistStart = app.indexOf("async function persistLayoutPositions");
    const persistEnd = app.indexOf("async function rebuildFlow", persistStart);
    const persist = app.slice(persistStart, persistEnd);
    const mergeAt = persist.indexOf("layoutPositions.value = { ...layoutPositions.value, ...positions }");
    const saveAt = persist.indexOf("window.canvasApi.saveLayout(");
    expect(mergeAt).toBeGreaterThan(-1);
    expect(saveAt).toBeGreaterThan(-1);
    expect(mergeAt).toBeLessThan(saveAt);
    expect(app).toContain("if (loaded === null) return false;");
  });
});
