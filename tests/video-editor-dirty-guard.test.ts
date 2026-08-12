import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  captureVideoEditorDraftBaseline,
  createVideoEditorLoadGate,
  createLatestVideoEditorMediaLoader,
  hasUnsavedVideoEditorDraft,
} from "../src/renderer/src/video-editor-dirty-state.js";
import type { EditProject } from "../src/core/types.js";

function projectFixture(): EditProject {
  return {
    schemaVersion: 1,
    id: "edit-1",
    projectId: "project-1",
    name: "测试剪辑",
    revision: 1,
    width: 1080,
    height: 1920,
    fps: 24,
    backgroundColor: "#000000",
    tracks: [{
      id: "track-1",
      kind: "visual",
      name: "主画面",
      order: 0,
      locked: false,
      muted: false,
      hidden: false,
      clips: [],
    }],
    createdAt: "2026-08-09T00:00:00.000Z",
    updatedAt: "2026-08-09T00:00:00.000Z",
  };
}

describe("导演剪辑台未保存草稿门禁", () => {
  it("以已落盘快照为 baseline，能识别并恢复嵌套剪辑改动", () => {
    const project = projectFixture();
    const baseline = captureVideoEditorDraftBaseline(project);
    expect(hasUnsavedVideoEditorDraft(project, baseline)).toBe(false);

    project.tracks[0]!.name = "改名但未保存";
    expect(hasUnsavedVideoEditorDraft(project, baseline)).toBe(true);
    project.tracks[0]!.name = "主画面";
    expect(hasUnsavedVideoEditorDraft(project, baseline)).toBe(false);

    const firstTrack = project.tracks[0]!;
    const reordered = {
      tracks: [{
        clips: firstTrack.clips,
        hidden: firstTrack.hidden,
        muted: firstTrack.muted,
        locked: firstTrack.locked,
        order: firstTrack.order,
        name: firstTrack.name,
        kind: firstTrack.kind,
        id: firstTrack.id,
      }],
      updatedAt: project.updatedAt,
      createdAt: project.createdAt,
      revision: project.revision,
      backgroundColor: project.backgroundColor,
      fps: project.fps,
      height: project.height,
      width: project.width,
      name: project.name,
      projectId: project.projectId,
      id: project.id,
      schemaVersion: project.schemaVersion,
    } satisfies EditProject;
    expect(captureVideoEditorDraftBaseline(reordered)).toBe(baseline);
    project.tracks.push({ ...project.tracks[0]!, id: "track-2", order: 1 });
    expect(hasUnsavedVideoEditorDraft(project, baseline)).toBe(true);
  });

  it("组件暴露 requestLeave，App 的关窗、切工程和模块切换都经过同一 owner", async () => {
    const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const [component, app] = await Promise.all([
      readFile(path.join(workspace, "src/renderer/src/components/VideoEditorView.vue"), "utf8"),
      readFile(path.join(workspace, "src/renderer/src/App.vue"), "utf8"),
    ]);

    expect(component).toContain("defineExpose<VideoEditorExpose>({ requestLeave })");
    expect(component).toContain("hasUnsavedVideoEditorDraft");
    expect(component).toContain("selectEditProject");
    expect(app).toContain('ref="videoEditorRef"');
    expect(app).toContain('requestActiveWorkspaceLeave("window_close")');
    expect(app).toContain('requestActiveWorkspaceLeave("project_switch")');
    expect(app).toContain('requestActiveWorkspaceLeave("workspace_switch")');
    expect(app).toContain("switchModuleView(entry.id)");
    expect(app).toContain(':key="projectRoot"');
    expect(component).toContain("createVideoEditorLoadGate");
    expect(component).toContain("closeEditorSession(token.projectRoot, session.state.sessionId)");
    expect(component).toContain('import { MAX_EDIT_TIMELINE_SECONDS } from "@core/editor-limits"');
    expect(component).not.toMatch(/import\s*\{[^}]*MAX_EDIT_TIMELINE_SECONDS[^}]*\}\s*from\s*"@core\/editor"/u);
  });

  it("初始化 token 在卸载或换根后立即失效，旧 session 必须进入回收分支", () => {
    const gate = createVideoEditorLoadGate();
    const first = gate.begin("/project/a");
    expect(gate.isCurrent(first)).toBe(true);
    gate.invalidate();
    expect(gate.isCurrent(first)).toBe(false);
    const second = gate.begin("/project/b");
    expect(gate.isCurrent(second)).toBe(true);
    expect(gate.isCurrent(first)).toBe(false);
    expect(second.projectRoot).toBe("/project/b");
  });

  it("同工程连续扫描只接纳最后一次媒体请求，旧响应后到不能覆盖新列表", async () => {
    let resolveFirst!: (value: string[]) => void;
    let resolveSecond!: (value: string[]) => void;
    const requests = [
      new Promise<string[]>((resolve) => { resolveFirst = resolve; }),
      new Promise<string[]>((resolve) => { resolveSecond = resolve; }),
    ];
    const accepted: string[][] = [];
    const loader = createLatestVideoEditorMediaLoader(
      async () => requests.shift()!,
      (value) => accepted.push(value),
    );

    const first = loader.load("/project/a");
    const second = loader.load("/project/a");
    resolveSecond(["new-media"]);
    await expect(second).resolves.toBe(true);
    resolveFirst(["stale-media"]);
    await expect(first).resolves.toBe(false);
    expect(accepted).toEqual([["new-media"]]);
  });
});
