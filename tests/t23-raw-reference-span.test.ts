import { describe, expect, it } from "vitest";
import {
  createT23RawReferenceSpanTracker,
} from "../src/renderer/src/t23-raw-reference-span.js";

describe("T23 raw/reference renderer 精确 span", () => {
  it("只在当前 flight 内按顺序记录首 raw 与完整 PASS 参考闭包", () => {
    let now = 100;
    const markers: Array<{ milestone: string; atMs: number }> = [];
    const tracker = createT23RawReferenceSpanTracker({
      now: () => now++,
      mark: (milestone, atMs) => markers.push({ milestone, atMs }),
    });
    const span = tracker.begin({
      projectRoot: "/fixture",
      flightSequence: 7,
      isCurrent: () => true,
    });

    span.setExpectedPassUnitIds(["S1E01-U03", "S1E01-U01"]);
    expect(span.markFirstRaw("S1E01-U03")).toBe(true);
    expect(span.markFirstRaw("S1E01-U01")).toBe(false);
    span.recordPassReference("S1E01-U03");
    span.recordPassReference("S1E01-U01");
    expect(span.complete()).toBe(true);

    const id = span.spanId;
    expect(markers.map((entry) => entry.milestone)).toEqual([
      `canvas-raw-span-start:${id}`,
      `canvas-first-raw-unit:${id}:S1E01-U03`,
      `canvas-first-raw-ready:${id}`,
      `canvas-all-pass-reference-unit:${id}:S1E01-U01`,
      `canvas-all-pass-reference-unit:${id}:S1E01-U03`,
      `canvas-all-pass-references-ready:${id}`,
      `canvas-raw-span-complete:${id}`,
    ]);
    expect(markers.map((entry) => entry.atMs)).toEqual([100, 101, 102, 103, 104, 105, 106]);
  });

  it("新 span 开始后必须使旧 completed span 失效，禁止回退冒充当前证据", () => {
    const markers: string[] = [];
    const tracker = createT23RawReferenceSpanTracker({
      now: () => 1,
      mark: (milestone) => markers.push(milestone),
    });
    const completed = tracker.begin({
      projectRoot: "/fixture",
      flightSequence: 1,
      isCurrent: () => true,
    });
    completed.setExpectedPassUnitIds(["U01"]);
    completed.markFirstRaw("U01");
    completed.recordPassReference("U01");
    expect(completed.complete()).toBe(true);

    const current = tracker.begin({
      projectRoot: "/fixture",
      flightSequence: 2,
      isCurrent: () => true,
    });
    expect(markers).toContain(`canvas-raw-span-invalidated:${completed.spanId}`);
    expect(current.invalidate()).toBe(true);
    expect(markers).toContain(`canvas-raw-span-invalidated:${current.spanId}`);
    expect(markers.at(-1)).toBe(`canvas-raw-span-invalidated:${current.spanId}`);
  });

  it("refresh、invalidate 与迟到 worker 都必须使旧 scope 失效，且不允许 complete 冒充 ready", () => {
    const markers: string[] = [];
    let current = true;
    const tracker = createT23RawReferenceSpanTracker({
      now: () => 1,
      mark: (milestone) => markers.push(milestone),
    });
    const first = tracker.begin({
      projectRoot: "/fixture-a",
      flightSequence: 1,
      isCurrent: () => current,
    });
    first.setExpectedPassUnitIds(["U01"]);
    expect(first.markFirstRaw("U01")).toBe(true);
    tracker.invalidateCurrent();
    expect(first.recordPassReference("U01")).toBe(false);
    expect(first.complete()).toBe(false);

    current = false;
    const stale = tracker.begin({
      projectRoot: "/fixture-b",
      flightSequence: 2,
      isCurrent: () => current,
    });
    expect(stale.markFirstRaw("U02")).toBe(false);
    expect(markers).toContain(`canvas-raw-span-invalidated:${first.spanId}`);
    expect(markers).toContain(`canvas-raw-span-start:${stale.spanId}`);
    expect(markers).not.toContain(`canvas-raw-span-complete:${first.spanId}`);
    expect(markers).not.toContain(`canvas-raw-span-complete:${stale.spanId}`);
  });
});
