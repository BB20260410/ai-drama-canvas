import { describe, expect, it } from "vitest";
import { createProjectionLoadController } from "../src/renderer/src/use-projection-refresh.js";
import { createLayoutSession } from "../src/renderer/src/use-layout-session.js";
import { createDashboardLoadController } from "../src/renderer/src/studio-production-dashboard-store.js";

describe("use-projection-refresh (Qwen D2)", () => {
  it("isolates streams and invalidates generation", () => {
    const c = createProjectionLoadController<"a" | "b", { op: "a" | "b" }>(
      (q) => q.op,
      (root, q) => `${root}:${q.op}`,
    );
    const t1 = c.beginQuery("/p", { op: "a" });
    const t2 = c.beginQuery("/p", { op: "b" });
    expect(c.isCurrentQuery(t1, { op: "a" })).toBe(true);
    expect(c.isCurrentQuery(t2, { op: "b" })).toBe(true);
    const t1b = c.beginQuery("/p", { op: "a" });
    expect(c.isCurrentQuery(t1, { op: "a" })).toBe(false);
    expect(c.isCurrentQuery(t1b, { op: "a" })).toBe(true);
    c.invalidate();
    expect(c.isCurrentQuery(t1b, { op: "a" })).toBe(false);
    expect(c.isCurrentQuery(t2, { op: "b" })).toBe(false);
  });

  it("dashboard controller still works via D2 core", () => {
    const c = createDashboardLoadController();
    const t = c.begin("/proj", { operation: "overview" });
    expect(c.isCurrent(t, { operation: "overview" })).toBe(true);
    c.invalidate();
    expect(c.isCurrent(t, { operation: "overview" })).toBe(false);
  });
});

describe("use-layout-session (Qwen D2)", () => {
  it("tracks generation and status labels", async () => {
    const s = createLayoutSession();
    expect(s.statusLabel()).toBe("布局空闲");
    let ran = false;
    s.schedule(
      "/p",
      async (gen, root) => {
        expect(s.markSaving(gen, root, "/p")).toBe(true);
        ran = true;
        s.markSaved(gen, root, "/p");
      },
      5,
    );
    expect(s.state).toBe("pending");
    await new Promise((r) => setTimeout(r, 20));
    expect(ran).toBe(true);
    expect(s.state).toBe("saved");
    expect(s.statusLabel()).toBe("布局已落盘");
  });
});
