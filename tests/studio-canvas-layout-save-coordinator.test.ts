import { describe, expect, it, vi } from "vitest";
import type { StudioCanvasLayout } from "../src/core/studio-canvas-layout-types.js";
import type { StudioCanvasLayoutSemanticSnapshot } from "../src/renderer/src/studio-canvas-layout-cas-merge.js";
import {
  createStudioCanvasLayoutSaveCoordinator,
  type StudioCanvasLayoutSaveResult,
} from "../src/renderer/src/studio-canvas-layout-save-coordinator.js";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function layout(
  fingerprint: string,
  viewport: { x: number; y: number; zoom: number },
): StudioCanvasLayout {
  return {
    schemaVersion: 1,
    kind: "studio-canvas-layout",
    fingerprint,
    viewport,
    nodes: { "unit:a": { x: 10, y: 20 } },
    workspaceMode: "projection",
    pinnedNodeIds: [],
    draftCanvasEdges: [],
    workflowGroups: [],
    updatedAt: "2026-07-28T00:00:00.000Z",
  };
}

function local(viewportX: number): StudioCanvasLayoutSemanticSnapshot {
  return {
    viewport: { x: viewportX, y: 0, zoom: 1 },
    nodes: { "unit:a": { x: 10, y: 20 } },
    workspaceMode: "projection",
    pinnedNodeIds: [],
    draftCanvasEdges: [],
    workflowGroups: [],
  };
}

describe("Studio 画布布局保存协调器", () => {
  it("快速连续 viewport 只保留最新待写快照，真实 save 单写且沿用自己的新 fingerprint", async () => {
    const first = deferred<StudioCanvasLayoutSaveResult>();
    const second = deferred<StudioCanvasLayoutSaveResult>();
    const calls: Array<{
      projectRoot: string;
      base: StudioCanvasLayout | null;
      local: StudioCanvasLayoutSemanticSnapshot;
      expectedFingerprint?: string;
    }> = [];
    let active = 0;
    let maximumActive = 0;
    let currentGeneration = 1;
    const accepted: Array<{ fingerprint: string; current: boolean; superseded: boolean }> = [];
    const coordinator = createStudioCanvasLayoutSaveCoordinator({
      persist: (input) => {
        calls.push(structuredClone(input));
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        const gate = calls.length === 1 ? first : second;
        return gate.promise.finally(() => {
          active -= 1;
        });
      },
      isRequestCurrent: (request) => (
        request.projectRoot === "/project-a"
        && request.generation === currentGeneration
      ),
      isProjectCurrent: (projectRoot) => projectRoot === "/project-a",
      onAutomaticAccepted: (_request, result, context) => {
        accepted.push({
          fingerprint: result.layout.fingerprint,
          current: context.requestCurrent,
          superseded: context.superseded,
        });
      },
    });
    coordinator.setBaseline("/project-a", layout("1".repeat(64), { x: 0, y: 0, zoom: 1 }));

    coordinator.saveLatest({
      projectRoot: "/project-a",
      generation: 1,
      local: local(10),
    });
    currentGeneration = 2;
    coordinator.saveLatest({
      projectRoot: "/project-a",
      generation: 2,
      local: local(20),
    });
    currentGeneration = 3;
    coordinator.saveLatest({
      projectRoot: "/project-a",
      generation: 3,
      local: local(30),
    });

    expect(calls).toHaveLength(1);
    expect(maximumActive).toBe(1);
    first.resolve({
      layout: layout("2".repeat(64), { x: 10, y: 0, zoom: 1 }),
      created: false,
      merged: false,
    });
    await vi.waitFor(() => expect(calls).toHaveLength(2));

    // generation=2 没有产生第三次写；generation=3 以本窗口第一次成功为新 base。
    expect(calls[1]).toMatchObject({
      projectRoot: "/project-a",
      expectedFingerprint: "2".repeat(64),
      base: { fingerprint: "2".repeat(64), viewport: { x: 10, y: 0, zoom: 1 } },
      local: { viewport: { x: 30, y: 0, zoom: 1 } },
    });
    expect(maximumActive).toBe(1);

    second.resolve({
      layout: layout("3".repeat(64), { x: 30, y: 0, zoom: 1 }),
      created: false,
      merged: false,
    });
    await coordinator.flush();

    expect(calls).toHaveLength(2);
    expect(maximumActive).toBe(1);
    expect(accepted).toEqual([
      { fingerprint: "2".repeat(64), current: false, superseded: true },
      { fingerprint: "3".repeat(64), current: true, superseded: false },
    ]);
  });

  it("在飞自动保存失败时不丢最新 pending，并从已落盘 baseline 重试最新快照", async () => {
    const first = deferred<void>();
    const calls: Array<{
      base: StudioCanvasLayout | null;
      local: StudioCanvasLayoutSemanticSnapshot;
      expectedFingerprint?: string;
    }> = [];
    const errors: Array<{ generation: number; error: unknown }> = [];
    const coordinator = createStudioCanvasLayoutSaveCoordinator({
      persist: async (input) => {
        calls.push(structuredClone(input));
        if (calls.length === 1) {
          await first.promise;
          throw new Error("temporary layout write failure");
        }
        return {
          layout: layout("2".repeat(64), input.local.viewport),
          created: false,
          merged: false,
        };
      },
      isRequestCurrent: () => true,
      isProjectCurrent: () => true,
      onAutomaticError: (request, error) => {
        errors.push({ generation: request.generation, error });
      },
    });
    const baseline = layout("1".repeat(64), { x: 0, y: 0, zoom: 1 });
    coordinator.setBaseline("/project-a", baseline);

    coordinator.saveLatest({
      projectRoot: "/project-a",
      generation: 1,
      local: local(10),
    });
    coordinator.saveLatest({
      projectRoot: "/project-a",
      generation: 2,
      local: local(20),
    });
    first.resolve();
    await coordinator.flush();

    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({
      expectedFingerprint: baseline.fingerprint,
      base: { fingerprint: baseline.fingerprint },
      local: { viewport: { x: 20, y: 0, zoom: 1 } },
    });
    expect(errors).toEqual([]);
  });

  it("工程切换 flush 会把已排队的旧工程 pending 提升为 force 后落盘", async () => {
    const first = deferred<StudioCanvasLayoutSaveResult>();
    const calls: Array<{
      projectRoot: string;
      local: StudioCanvasLayoutSemanticSnapshot;
      expectedFingerprint?: string;
    }> = [];
    let currentProjectRoot = "/project-a";
    const coordinator = createStudioCanvasLayoutSaveCoordinator({
      persist: async (input) => {
        calls.push(structuredClone(input));
        if (calls.length === 1) return first.promise;
        return {
          layout: layout("3".repeat(64), input.local.viewport),
          created: false,
          merged: false,
        };
      },
      isRequestCurrent: (request) => request.projectRoot === currentProjectRoot,
      isProjectCurrent: (projectRoot) => projectRoot === currentProjectRoot,
    });
    coordinator.setBaseline(
      "/project-a",
      layout("1".repeat(64), { x: 0, y: 0, zoom: 1 }),
    );

    coordinator.saveLatest({
      projectRoot: "/project-a",
      generation: 1,
      local: local(10),
    });
    coordinator.saveLatest({
      projectRoot: "/project-a",
      generation: 2,
      local: local(20),
    });
    currentProjectRoot = "/project-b";
    const flushing = coordinator.flush({
      projectRoot: "/project-a",
      force: true,
    });
    first.resolve({
      layout: layout("2".repeat(64), { x: 10, y: 0, zoom: 1 }),
      created: false,
      merged: false,
    });
    await flushing;

    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({
      projectRoot: "/project-a",
      expectedFingerprint: "2".repeat(64),
      local: { viewport: { x: 20, y: 0, zoom: 1 } },
    });
  });

  it("exclusive 在飞时按工程隔离 pending，不让新工程自动保存覆盖旧工程", async () => {
    const exclusiveGate = deferred<StudioCanvasLayoutSaveResult>();
    const calls: Array<{
      projectRoot: string;
      local: StudioCanvasLayoutSemanticSnapshot;
    }> = [];
    const coordinator = createStudioCanvasLayoutSaveCoordinator({
      persist: async (input) => {
        calls.push(structuredClone(input));
        if (calls.length === 1) return exclusiveGate.promise;
        return {
          layout: {
            ...layout(
              input.projectRoot === "/project-a" ? "c".repeat(64) : "d".repeat(64),
              input.local.viewport,
            ),
            workflowGroups: structuredClone(input.local.workflowGroups),
          },
          created: false,
          merged: false,
        };
      },
      isRequestCurrent: () => true,
      isProjectCurrent: () => true,
    });
    coordinator.setBaseline(
      "/project-a",
      layout("a".repeat(64), { x: 0, y: 0, zoom: 1 }),
    );
    coordinator.setBaseline(
      "/project-b",
      layout("b".repeat(64), { x: 0, y: 0, zoom: 1 }),
    );
    const exclusiveLocal = local(0);
    exclusiveLocal.workflowGroups = [{
      id: "workflow-exclusive",
      title: "exclusive",
      panelIds: ["panel-a"],
      pipeline: ["image"],
      createdAt: "2026-07-28T00:00:00.000Z",
    }];

    const exclusive = coordinator.saveExclusive({
      projectRoot: "/project-a",
      generation: 1,
      local: exclusiveLocal,
      force: true,
    });
    coordinator.saveLatest({
      projectRoot: "/project-a",
      generation: 2,
      local: local(10),
      force: true,
    });
    coordinator.saveLatest({
      projectRoot: "/project-b",
      generation: 1,
      local: local(20),
      force: true,
    });
    exclusiveGate.resolve({
      layout: {
        ...layout("e".repeat(64), { x: 0, y: 0, zoom: 1 }),
        workflowGroups: structuredClone(exclusiveLocal.workflowGroups),
      },
      created: false,
      merged: false,
    });
    await exclusive;
    await coordinator.flush();

    expect(calls.map((call) => call.projectRoot)).toEqual([
      "/project-a",
      "/project-a",
      "/project-b",
    ]);
    expect(calls[1]).toMatchObject({
      local: {
        viewport: { x: 10, y: 0, zoom: 1 },
        workflowGroups: [{ id: "workflow-exclusive" }],
      },
    });
    expect(calls[2]).toMatchObject({
      local: { viewport: { x: 20, y: 0, zoom: 1 } },
    });
  });

  it("旧工程迟到成功只推进旧工程内部 base，不触发当前工程接受回调", async () => {
    const oldProject = deferred<StudioCanvasLayoutSaveResult>();
    const newProject = deferred<StudioCanvasLayoutSaveResult>();
    const calls: Array<{ projectRoot: string; expectedFingerprint?: string }> = [];
    const acceptedRoots: string[] = [];
    let currentProjectRoot = "/project-a";
    let active = 0;
    let maximumActive = 0;
    const coordinator = createStudioCanvasLayoutSaveCoordinator({
      persist: (input) => {
        calls.push({
          projectRoot: input.projectRoot,
          ...(input.expectedFingerprint
            ? { expectedFingerprint: input.expectedFingerprint }
            : {}),
        });
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        const gate = input.projectRoot === "/project-a" ? oldProject : newProject;
        return gate.promise.finally(() => {
          active -= 1;
        });
      },
      isRequestCurrent: (request) => request.projectRoot === currentProjectRoot,
      isProjectCurrent: (projectRoot) => projectRoot === currentProjectRoot,
      onAutomaticAccepted: (request) => {
        acceptedRoots.push(request.projectRoot);
      },
    });
    coordinator.setBaseline("/project-a", layout("a".repeat(64), { x: 0, y: 0, zoom: 1 }));
    coordinator.setBaseline("/project-b", layout("b".repeat(64), { x: 0, y: 0, zoom: 1 }));

    coordinator.saveLatest({
      projectRoot: "/project-a",
      generation: 1,
      local: local(10),
      force: true,
    });
    currentProjectRoot = "/project-b";
    coordinator.saveLatest({
      projectRoot: "/project-b",
      generation: 1,
      local: local(20),
      force: true,
    });

    expect(calls).toEqual([
      { projectRoot: "/project-a", expectedFingerprint: "a".repeat(64) },
    ]);
    oldProject.resolve({
      layout: layout("c".repeat(64), { x: 10, y: 0, zoom: 1 }),
      created: false,
      merged: false,
    });
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]).toEqual({
      projectRoot: "/project-b",
      expectedFingerprint: "b".repeat(64),
    });
    expect(acceptedRoots).toEqual([]);

    newProject.resolve({
      layout: layout("d".repeat(64), { x: 20, y: 0, zoom: 1 }),
      created: false,
      merged: false,
    });
    await coordinator.flush();

    expect(maximumActive).toBe(1);
    expect(acceptedRoots).toEqual(["/project-b"]);
  });
});
