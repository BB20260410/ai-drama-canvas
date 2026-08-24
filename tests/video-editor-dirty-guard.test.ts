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

  it("保存在进行中 fail-closed：saving 在首个 await 之前置位，连点不会发出两次 saveEditProject", async () => {
    const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const component = await readFile(path.join(workspace, "src/renderer/src/components/VideoEditorView.vue"), "utf8");
    expect(component).toContain(':disabled="!active || saving"');
    const saveStart = component.indexOf("async function save(");
    const saveEnd = component.indexOf("\nasync function undoEditor()", saveStart);
    expect(saveStart).toBeGreaterThan(-1);
    expect(saveEnd).toBeGreaterThan(saveStart);
    const saveSource = component.slice(saveStart, saveEnd);
    expect(saveSource).toMatch(/if \(!active\.value \|\| saving\.value\) return false;/);
    expect(saveSource.indexOf("saving.value = true")).toBeGreaterThan(-1);
    expect(saveSource.indexOf("saving.value = true")).toBeLessThan(saveSource.indexOf("await suspendPreviewWork()"));
  });

  it("OTIO 导出在进行中 fail-closed：exportingOtio 在首个 await 之前置位，连点不会发出两次 exportEditOtio", async () => {
    const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const component = await readFile(path.join(workspace, "src/renderer/src/components/VideoEditorView.vue"), "utf8");
    expect(component).toContain(':disabled="!active || exportingOtio || saving"');
    expect(component).toContain("{{ exportingOtio ? '导出中' : 'OTIO' }}");
    const start = component.indexOf("async function exportOtio()");
    const end = component.indexOf("\nasync function importOtio()", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const source = component.slice(start, end);
    expect(source).toMatch(/if \(!active\.value \|\| exportingOtio\.value \|\| saving\.value\) return;/);
    expect(source.indexOf("exportingOtio.value = true")).toBeGreaterThan(-1);
    expect(source.indexOf("exportingOtio.value = true")).toBeLessThan(source.indexOf("await save("));
    expect(source.indexOf("shouldResumePreview = true")).toBeGreaterThan(source.indexOf("await save("));
    expect(source).toContain("if (shouldResumePreview) resumePreviewWork()");
    expect(source).toContain("exportEditOtio");
  });

  it("OTIO 导入在进行中 fail-closed：importingOtio 在首个 await 之前置位，连点不会发出两次 importEditOtio", async () => {
    const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const component = await readFile(path.join(workspace, "src/renderer/src/components/VideoEditorView.vue"), "utf8");
    expect(component).toContain(':disabled="importingOtio || exportingOtio || saving"');
    expect(component).toContain("{{ importingOtio ? '导入中' : 'OTIO' }}");
    const start = component.indexOf("async function importOtio()");
    const end = component.indexOf("\nfunction onEditorShortcut(", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const source = component.slice(start, end);
    expect(source).toMatch(/if \(importingOtio\.value \|\| exportingOtio\.value \|\| saving\.value\) return;/);
    expect(source.indexOf("importingOtio.value = true")).toBeGreaterThan(-1);
    expect(source.indexOf("importingOtio.value = true")).toBeLessThan(source.indexOf("await requestLeave("));
    expect(source).toContain("importEditOtio");
    expect(source).toContain("importingOtio.value = false");
  });

  it("成片导出在进行中 fail-closed：rendering 在首个 await 之前置位，连点不会发出两次 startEditRender", async () => {
    const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const component = await readFile(path.join(workspace, "src/renderer/src/components/VideoEditorView.vue"), "utf8");
    expect(component).toContain(':disabled="!active || !visualClips.length || rendering || saving || exportingOtio || importingOtio || !engine?.available"');
    expect(component).toContain("{{ rendering ? '正在导出' : '导出 MP4' }}");
    const start = component.indexOf("async function render()");
    const end = component.indexOf("\nlet renderPollActive = false;", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const source = component.slice(start, end);
    expect(source).toMatch(/if \(!active\.value \|\| rendering\.value \|\| saving\.value \|\| exportingOtio\.value \|\| importingOtio\.value\) return;/);
    expect(source.indexOf("rendering.value = true")).toBeGreaterThan(-1);
    expect(source.indexOf("rendering.value = true")).toBeLessThan(source.indexOf("await save("));
    expect(source.indexOf("shouldResumePreview = true")).toBeGreaterThan(source.indexOf("await save("));
    expect(source).toContain("if (shouldResumePreview) resumePreviewWork()");
    expect(source).toContain("startEditRender");
    expect(source).toContain("rendering.value = false");
  });

  it("导出当前帧在进行中 fail-closed：extractingFrame 在首个 await 之前置位，连点不会发出两次 extractTimelineFrame", async () => {
    const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const component = await readFile(path.join(workspace, "src/renderer/src/components/VideoEditorView.vue"), "utf8");
    expect(component).toContain(':disabled="extractingFrame || saving || exportingOtio || importingOtio"');
    expect(component).toContain("{{ extractingFrame ? '合成中' : '导出当前帧' }}");
    const start = component.indexOf("async function extractCurrentFrame()");
    const end = component.indexOf("\nasync function prepareTimelineContinuation()", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const source = component.slice(start, end);
    expect(source).toMatch(/if \(!active\.value \|\| !totalDuration\.value \|\| extractingFrame\.value \|\| saving\.value \|\| exportingOtio\.value \|\| importingOtio\.value\) return;/);
    expect(source.indexOf("extractingFrame.value = true")).toBeGreaterThan(-1);
    expect(source.indexOf("extractingFrame.value = true")).toBeLessThan(source.indexOf("await save("));
    expect(source.indexOf("shouldResumePreview = true")).toBeGreaterThan(source.indexOf("await save("));
    expect(source).toContain("if (shouldResumePreview) resumePreviewWork()");
    expect(source).toContain("extractTimelineFrame");
    expect(source).toContain("extractingFrame.value = false");
  });

  it("末帧续视频在进行中 fail-closed：preparingContinuation 在首个 await 之前置位，连点不会发出两次 prepareTimelineContinuation", async () => {
    const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const component = await readFile(path.join(workspace, "src/renderer/src/components/VideoEditorView.vue"), "utf8");
    expect(component).toContain(':disabled="preparingContinuation || saving || exportingOtio || importingOtio || !continuationTargetId"');
    expect(component).toContain("{{preparingContinuation?'准备中':'末帧续视频'}}");
    const start = component.indexOf("async function prepareTimelineContinuation()");
    const end = component.indexOf("\nfunction beginTimelineGesture(", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const source = component.slice(start, end);
    expect(source).toMatch(/if \(!active\.value \|\| !continuationTargetId\.value \|\| preparingContinuation\.value \|\| saving\.value \|\| exportingOtio\.value \|\| importingOtio\.value\) return;/);
    expect(source.indexOf("preparingContinuation.value = true")).toBeGreaterThan(-1);
    expect(source.indexOf("preparingContinuation.value = true")).toBeLessThan(source.indexOf("await save("));
    expect(source.indexOf("shouldResumePreview = true")).toBeGreaterThan(source.indexOf("await save("));
    expect(source).toContain("if (shouldResumePreview) resumePreviewWork()");
    expect(source).toContain("window.canvasApi.prepareTimelineContinuation");
    expect(source).toContain("preparingContinuation.value = false");
  });

  it("撤销/重做/分割/Ripple/快捷键在写入进行中 fail-closed：editorWriteBusy 挡住按钮和 ⌘Z/⌘B/⇧⌫，不能边保存边改历史", async () => {
    const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const component = await readFile(path.join(workspace, "src/renderer/src/components/VideoEditorView.vue"), "utf8");
    expect(component).toContain("const editorWriteBusy = computed(() => saving.value || exportingOtio.value || importingOtio.value || rendering.value || extractingFrame.value || preparingContinuation.value);");
    expect(component).toContain(':disabled="!active || !historyInfo.canUndo || editorWriteBusy"');
    expect(component).toContain(':disabled="!active || !historyInfo.canRedo || editorWriteBusy"');
    expect(component).toContain(':disabled="!canSplitSelected || editorWriteBusy"');
    expect(component).toContain('title="删除当前片段并收拢后续未锁定轨道（⇧⌫）" :disabled="!selectedClip || editorWriteBusy"');
    expect(component).toContain("正在处理剪辑，不能撤销");
    expect(component).toContain("正在处理剪辑，不能重做");

    const undoStart = component.indexOf("async function undoEditor()");
    const undoEnd = component.indexOf("\nasync function redoEditor()", undoStart);
    const redoStart = component.indexOf("async function redoEditor()");
    const redoEnd = component.indexOf("\nasync function exportOtio()", redoStart);
    const shortcutStart = component.indexOf("function onEditorShortcut(");
    const shortcutEnd = component.indexOf("\nasync function render()", shortcutStart);
    expect(undoStart).toBeGreaterThan(-1);
    expect(undoEnd).toBeGreaterThan(undoStart);
    expect(redoStart).toBeGreaterThan(-1);
    expect(redoEnd).toBeGreaterThan(redoStart);
    expect(shortcutStart).toBeGreaterThan(-1);
    expect(shortcutEnd).toBeGreaterThan(shortcutStart);

    const undoSource = component.slice(undoStart, undoEnd);
    const redoSource = component.slice(redoStart, redoEnd);
    const shortcutSource = component.slice(shortcutStart, shortcutEnd);
    expect(undoSource).toMatch(/if \(!active\.value \|\| !historyInfo\.canUndo \|\| editorWriteBusy\.value\) return;/);
    expect(undoSource.indexOf("editorWriteBusy.value")).toBeLessThan(undoSource.indexOf("await requestLeave("));
    expect(redoSource).toMatch(/if \(!active\.value \|\| !historyInfo\.canRedo \|\| editorWriteBusy\.value\) return;/);
    expect(redoSource.indexOf("editorWriteBusy.value")).toBeLessThan(redoSource.indexOf("await requestLeave("));
    expect(shortcutSource).toContain("if (editorWriteBusy.value) return;");
    expect(shortcutSource.indexOf("if (editorWriteBusy.value) return;")).toBeLessThan(shortcutSource.indexOf("splitSelectedAtPlayhead"));
    expect(shortcutSource.indexOf("if (editorWriteBusy.value) return;")).toBeLessThan(shortcutSource.indexOf("rippleDeleteSelected"));
    expect(shortcutSource.indexOf("if (editorWriteBusy.value) return;")).toBeLessThan(shortcutSource.indexOf("undoEditor"));
  });

  it("创建剪辑工程在进行中 fail-closed：creating 挡住按钮与 handler，同 tick 连点不会重复创建", async () => {
    const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const component = await readFile(path.join(workspace, "src/renderer/src/components/VideoEditorView.vue"), "utf8");
    expect(component).toContain(':disabled="creating"');
    expect(component).toContain("正在处理，不能再创建剪辑工程");

    const start = component.indexOf("async function createProject()");
    const end = component.indexOf("\nfunction addMedia(", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const source = component.slice(start, end);
    expect(source).toContain("if (creating.value) return;");
    expect(source.indexOf("if (creating.value) return;")).toBeLessThan(source.indexOf("await requestLeave("));
    expect(source.indexOf("if (creating.value) return;")).toBeLessThan(source.indexOf("creating.value = true;"));
    expect(source.indexOf("creating.value = true;")).toBeLessThan(source.indexOf("await window.canvasApi.createEditProject"));
    expect(source).toContain("creating.value = false;");
  });

  it("切换剪辑工程在写入/创建进行中 fail-closed：select 禁用，handler 还原当前工程且不进入 requestLeave", async () => {
    const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const component = await readFile(path.join(workspace, "src/renderer/src/components/VideoEditorView.vue"), "utf8");
    expect(component).toContain(':disabled="creating || editorWriteBusy"');
    expect(component).toContain("正在处理，不能再切换剪辑工程");

    const start = component.indexOf("async function selectEditProject(");
    const end = component.indexOf("\nasync function resolveRecovery(", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const source = component.slice(start, end);
    expect(source).toContain("if (creating.value || editorWriteBusy.value) {");
    expect(source).toContain("activeProjectId.value = currentId;");
    expect(source.indexOf("if (creating.value || editorWriteBusy.value)")).toBeLessThan(source.indexOf("await requestLeave("));
    expect(source.indexOf("activeProjectId.value = currentId;")).toBeLessThan(source.indexOf("await requestLeave("));
  });

  it("追加素材/字幕/画中画轨在写入进行中 fail-closed：不能边保存边改时间线", async () => {
    const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const component = await readFile(path.join(workspace, "src/renderer/src/components/VideoEditorView.vue"), "utf8");
    expect(component).toContain("正在处理，不能再追加素材");
    expect(component).toContain("正在处理，不能再添加字幕");
    expect(component).toContain("正在处理，不能再添加画中画轨");

    const addMediaStart = component.indexOf("function addMedia(");
    const addMediaEnd = component.indexOf("\nfunction addSubtitle()", addMediaStart);
    const addSubtitleStart = component.indexOf("function addSubtitle()");
    const addSubtitleEnd = component.indexOf("\nfunction addOverlayTrack()", addSubtitleStart);
    const addOverlayStart = component.indexOf("function addOverlayTrack()");
    const addOverlayEnd = component.indexOf("\nfunction removeTrack(", addOverlayStart);
    expect(addMediaStart).toBeGreaterThan(-1);
    expect(addMediaEnd).toBeGreaterThan(addMediaStart);
    expect(addSubtitleStart).toBeGreaterThan(-1);
    expect(addSubtitleEnd).toBeGreaterThan(addSubtitleStart);
    expect(addOverlayStart).toBeGreaterThan(-1);
    expect(addOverlayEnd).toBeGreaterThan(addOverlayStart);

    for (const source of [
      component.slice(addMediaStart, addMediaEnd),
      component.slice(addSubtitleStart, addSubtitleEnd),
      component.slice(addOverlayStart, addOverlayEnd),
    ]) {
      expect(source).toContain("if (creating.value || editorWriteBusy.value) return;");
      expect(source.indexOf("if (creating.value || editorWriteBusy.value) return;")).toBeLessThan(
        source.indexOf("if (!active.value) return;"),
      );
    }
  });

  it("新建工程对话框与删除空轨在写入进行中 fail-closed：不能边保存边改工程结构", async () => {
    const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const component = await readFile(path.join(workspace, "src/renderer/src/components/VideoEditorView.vue"), "utf8");
    expect(component).toContain("正在处理，不能再新建剪辑工程");
    expect(component).toContain("正在处理，不能再删除空叠加轨");
    expect(component).toContain("@click=\"openCreate\"");
    expect(component).not.toContain('@click="showCreate = true"');

    const openStart = component.indexOf("function openCreate(");
    const openEnd = component.indexOf("\nfunction ", openStart + "function openCreate(".length);
    expect(openStart).toBeGreaterThan(-1);
    expect(openEnd).toBeGreaterThan(openStart);
    const openSource = component.slice(openStart, openEnd);
    expect(openSource).toContain("if (creating.value || editorWriteBusy.value) return;");
    expect(openSource.indexOf("if (creating.value || editorWriteBusy.value) return;")).toBeLessThan(
      openSource.indexOf("showCreate.value = true"),
    );

    const removeStart = component.indexOf("function removeTrack(");
    const removeEnd = component.indexOf("\nasync function save(", removeStart);
    expect(removeStart).toBeGreaterThan(-1);
    expect(removeEnd).toBeGreaterThan(removeStart);
    const removeSource = component.slice(removeStart, removeEnd);
    expect(removeSource).toContain("if (creating.value || editorWriteBusy.value) return;");
    expect(removeSource.indexOf("if (creating.value || editorWriteBusy.value) return;")).toBeLessThan(
      removeSource.indexOf("if (!active.value) return;"),
    );
  });

  it("插入/刷新嵌套时间线在写入进行中 fail-closed：不能边保存边冻结子工程", async () => {
    const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const component = await readFile(path.join(workspace, "src/renderer/src/components/VideoEditorView.vue"), "utf8");
    expect(component).toContain("正在处理，不能再插入子时间线");
    expect(component).toContain("正在处理，不能再刷新嵌套时间线");

    const addStart = component.indexOf("async function addNestedTimeline()");
    const addEnd = component.indexOf("\nasync function refreshNestedTimeline()", addStart);
    const refreshStart = component.indexOf("async function refreshNestedTimeline()");
    const refreshEnd = component.indexOf("\nfunction addOverlayTrack()", refreshStart);
    expect(addStart).toBeGreaterThan(-1);
    expect(addEnd).toBeGreaterThan(addStart);
    expect(refreshStart).toBeGreaterThan(-1);
    expect(refreshEnd).toBeGreaterThan(refreshStart);

    const addSource = component.slice(addStart, addEnd);
    expect(addSource).toContain("if (creating.value || editorWriteBusy.value) return;");
    expect(addSource.indexOf("if (creating.value || editorWriteBusy.value) return;")).toBeLessThan(
      addSource.indexOf("nestedAdding.value = true"),
    );

    const refreshSource = component.slice(refreshStart, refreshEnd);
    expect(refreshSource).toContain("if (creating.value || editorWriteBusy.value) return;");
    expect(refreshSource.indexOf("if (creating.value || editorWriteBusy.value) return;")).toBeLessThan(
      refreshSource.indexOf("nestedAdding.value = true"),
    );
  });

  it("异常退出恢复 fail-closed：resolvingRecovery 挡住连点，不能重复 resolveEditorSessionRecovery", async () => {
    const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const component = await readFile(path.join(workspace, "src/renderer/src/components/VideoEditorView.vue"), "utf8");
    expect(component).toContain("class=\"editor-modal recovery-modal\"");
    expect(component).toContain(':disabled="resolvingRecovery"');
    expect(component).toContain("正在处理，不能再选择恢复修订");
    const start = component.indexOf("async function resolveRecovery(");
    const end = component.indexOf("\nasync function createProject()", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const source = component.slice(start, end);
    expect(source).toContain("if (resolvingRecovery.value || !editorRecovery.value || !editorSessionId.value) return;");
    expect(source).toContain("resolvingRecovery.value = true");
    expect(source.indexOf("if (resolvingRecovery.value || !editorRecovery.value || !editorSessionId.value) return;")).toBeLessThan(
      source.indexOf("resolvingRecovery.value = true"),
    );
    expect(source.indexOf("resolvingRecovery.value = true")).toBeLessThan(
      source.indexOf("await window.canvasApi.resolveEditorSessionRecovery"),
    );
    expect(source).toContain("resolvingRecovery.value = false");
  });

  it("取消导出 fail-closed：cancellingRender 挡住连点，不能重复 cancelEditRender", async () => {
    const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const component = await readFile(path.join(workspace, "src/renderer/src/components/VideoEditorView.vue"), "utf8");
    expect(component).toContain('class="ghost-button render-cancel"');
    expect(component).toContain(':disabled="cancellingRender"');
    expect(component).toContain("正在处理，不能再取消导出");
    const start = component.indexOf("async function cancelRender()");
    const end = component.indexOf("\nasync function extractCurrentFrame()", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const source = component.slice(start, end);
    expect(source).toContain("if (!activeRenderId.value || cancellingRender.value) return;");
    expect(source).toContain("cancellingRender.value = true");
    expect(source.indexOf("if (!activeRenderId.value || cancellingRender.value) return;")).toBeLessThan(
      source.indexOf("cancellingRender.value = true"),
    );
    expect(source.indexOf("cancellingRender.value = true")).toBeLessThan(
      source.indexOf("await window.canvasApi.cancelEditRender"),
    );
    expect(source).toContain("cancellingRender.value = false");
  });

  it("插入子时间线的 list/lookup 异常必须 emit failed，不能只停 busy", async () => {
    const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const component = await readFile(path.join(workspace, "src/renderer/src/components/VideoEditorView.vue"), "utf8");
    const start = component.indexOf("async function addNestedTimeline()");
    const end = component.indexOf("\nasync function refreshNestedTimeline()", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const source = component.slice(start, end);
    expect(source).toContain('throw new Error("选择的子剪辑工程已缺失，请重新选择。")');
    expect(source).toMatch(/\} catch \(error\) \{ emit\("failed", message\(error\)\); \}/);
    expect(source.indexOf('} catch (error) { emit("failed", message(error)); }')).toBeGreaterThan(
      source.indexOf('if (!child) throw new Error'),
    );
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
