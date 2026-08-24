import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "@vue/compiler-sfc";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function source(): string {
  return readFileSync(path.join(root, "src/renderer/src/components/TaskCenterView.vue"), "utf8");
}

describe("任务中心源码合同", () => {
  it("SFC 可解析并暴露刷新/创建批次", () => {
    const vue = source();
    expect(parse(vue, { filename: "TaskCenterView.vue" }).errors).toEqual([]);
    expect(vue).toContain('data-testid="task-center-refresh"');
    expect(vue).toContain('data-testid="task-center-create-image"');
    expect(vue).toContain('data-testid="task-center-create-video"');
  });

  it("刷新/创建/领取在进行中 fail-closed：loading 或 busyId 在首个 await 之前置位，连点不会重复创建任务包", () => {
    const vue = source();
    expect(vue).toContain(':disabled="loading || Boolean(busyId)"');
    expect(vue).toContain("正在处理，不能再刷新");
    expect(vue).toContain("正在处理，不能再创建图片批次");
    expect(vue).toContain("正在处理，不能再创建视频批次");

    const loadStart = vue.indexOf("async function loadCenter()");
    const loadEnd = vue.indexOf("\nasync function refresh()", loadStart);
    expect(loadStart).toBeGreaterThan(-1);
    expect(vue.slice(loadStart, loadEnd)).toContain("await window.canvasApi.getTaskCenter");

    const refreshStart = vue.indexOf("async function refresh()");
    const refreshEnd = vue.indexOf("\nasync function create(", refreshStart);
    const refresh = vue.slice(refreshStart, refreshEnd);
    expect(refresh).toContain("if (loading.value || busyId.value) return;");
    expect(refresh.indexOf("if (loading.value || busyId.value) return;")).toBeLessThan(refresh.indexOf("loading.value = true"));
    expect(refresh.indexOf("loading.value = true")).toBeLessThan(refresh.indexOf("await loadCenter"));

    const createStart = vue.indexOf("async function create(");
    const createEnd = vue.indexOf("\nasync function claim(", createStart);
    const create = vue.slice(createStart, createEnd);
    expect(create).toContain("if (loading.value || busyId.value) return;");
    expect(create.indexOf("if (loading.value || busyId.value) return;")).toBeLessThan(create.indexOf("loading.value = true"));
    expect(create.indexOf("loading.value = true")).toBeLessThan(create.indexOf("await window.canvasApi.createTaskPack"));

    const claimStart = vue.indexOf("async function claim(");
    const claimEnd = vue.indexOf("\nasync function finish(", claimStart);
    const claim = vue.slice(claimStart, claimEnd);
    expect(claim).toContain("if (loading.value || busyId.value) return;");
    expect(claim.indexOf("if (loading.value || busyId.value) return;")).toBeLessThan(claim.indexOf("busyId.value = task.id"));
    expect(claim.indexOf("busyId.value = task.id")).toBeLessThan(claim.indexOf("await window.canvasApi.claimTask"));
  });
});

describe("任务中心事件列表视口剔除", () => {
  it("event-list 行使用 content-visibility，离屏事件跳过同步布局", () => {
    const vue = source();
    expect(vue).toContain('v-for="event in events"');
    expect(vue).toContain(".event-list li { display: flex; gap: 11px; min-height: 54px; content-visibility: auto; contain-intrinsic-size: auto 54px; }");
    expect(vue).not.toMatch(/\.event-list li \{[^}]*content-visibility:hidden/);
  });

  it("task-pack 条目行使用 content-visibility，嵌套滚动跳过离屏布局", () => {
    const vue = source();
    expect(vue).toContain('v-for="item in task.itemSnapshots"');
    expect(vue).toContain(".task-pack ul { max-height: 190px; overflow: auto;");
    expect(vue).toContain(".task-pack li { display: grid; grid-template-columns: minmax(130px,1fr) 1fr; gap: 10px; padding: 8px 0; border-bottom: 1px solid #292b25; content-visibility: auto; contain-intrinsic-size: auto 32px; }");
    expect(vue).not.toMatch(/\.task-pack li \{[^}]*content-visibility:hidden/);
    expect(vue).not.toMatch(/\.task-pack footer button \{[^}]*content-visibility/);
  });
});
