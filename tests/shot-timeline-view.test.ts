import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "@vue/compiler-sfc";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function source(): string {
  return readFileSync(path.join(root, "src/renderer/src/components/ShotTimelineView.vue"), "utf8");
}

function handlerBody(text: string, signature: string, nextSignature: string): string {
  const start = text.indexOf(signature);
  const end = text.indexOf(nextSignature, start + signature.length);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return text.slice(start, end);
}

describe("镜头时间线源码合同", () => {
  it("SFC 可解析并暴露保存/入队/创建任务包", () => {
    const vue = source();
    expect(parse(vue, { filename: "ShotTimelineView.vue" }).errors).toEqual([]);
    expect(vue).toContain('data-testid="shot-timeline-save"');
    expect(vue).toContain('data-testid="shot-timeline-enqueue"');
    expect(vue).toContain('data-testid="shot-timeline-create-pack"');
  });

  it("保存/入队/创建在进行中 fail-closed：writeBusy 挡住按钮与切单元，连点不会重复写入", () => {
    const vue = source();
    expect(vue).toContain("const writeBusy = computed(() => saving.value || creating.value || queuing.value);");
    expect(vue).toContain(':disabled="!active || writeBusy"');
    expect(vue).toContain(':disabled="!active?.shots.length || !localValid || writeBusy"');
    expect(vue).toContain("正在处理，不能再保存编排");
    expect(vue).toContain("正在处理，不能再加入图片队列");
    expect(vue).toContain("正在处理，不能再创建任务包");

    const save = handlerBody(vue, "async function saveTimeline()", "async function createPack()");
    expect(save).toContain("if (!active.value || !localValid.value || writeBusy.value) return false;");
    expect(save.indexOf("if (!active.value || !localValid.value || writeBusy.value) return false;")).toBeLessThan(
      save.indexOf("saving.value = true"),
    );
    expect(save.indexOf("saving.value = true")).toBeLessThan(save.indexOf("await persistTimeline"));

    const create = handlerBody(vue, "async function createPack()", "async function enqueueShots()");
    expect(create).toContain("if (!active.value || !localValid.value || writeBusy.value) return;");
    expect(create.indexOf("if (!active.value || !localValid.value || writeBusy.value) return;")).toBeLessThan(
      create.indexOf("creating.value = true"),
    );

    const enqueue = handlerBody(vue, "async function enqueueShots()", "function pad(");
    expect(enqueue).toContain("if (!active.value || !localValid.value || writeBusy.value) return;");
    expect(enqueue.indexOf("if (!active.value || !localValid.value || writeBusy.value) return;")).toBeLessThan(
      enqueue.indexOf("queuing.value = true"),
    );

    const load = handlerBody(vue, "async function load()", "function selectUnit(");
    expect(load).toContain("if (writeBusy.value) return;");
    expect(load.indexOf("if (writeBusy.value) return;")).toBeLessThan(load.indexOf("loading.value = true"));

    const select = handlerBody(vue, "function selectUnit(unitId: string)", "function move(");
    expect(select).toContain("if (writeBusy.value) return;");
    expect(select.indexOf("if (writeBusy.value) return;")).toBeLessThan(select.indexOf("activeUnitId.value = unitId"));

    const move = handlerBody(vue, "function move(index: number, offset: number)", "async function persistTimeline(");
    expect(move).toContain("if (!active.value || writeBusy.value) return;");
  });
});
