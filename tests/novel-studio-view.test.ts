import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "@vue/compiler-sfc";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function novelStudioSource(): string {
  return readFileSync(path.join(root, "src/renderer/src/components/NovelStudioView.vue"), "utf8");
}

describe("轻量小说工作区", () => {
  it("SFC 可解析并暴露最小可用写作面", () => {
    const source = novelStudioSource();
    expect(parse(source, { filename: "NovelStudioView.vue" }).errors).toEqual([]);
    for (const testId of [
      "novel-studio-view",
      "novel-chapter-rail",
      "novel-editor-workspace",
      "novel-chapter-editor",
      "novel-save-chapter",
      "novel-search-input",
      "novel-search-results",
      "novel-memory-rail",
      "novel-memory-authority",
      "novel-writing-dashboard",
      "novel-writing-readiness",
      "novel-state-debt",
      "novel-consistency-probe",
      "novel-state-candidate-board",
      "novel-state-candidate-diff",
      "novel-accept-state-candidate",
      "novel-reject-state-candidate",
      "novel-backup",
      "novel-restore",
      "novel-import-file",
      "novel-import-directory",
    ]) expect(source).toContain(`data-testid="${testId}"`);
  });

  it("全文搜索输入有明确可访问名称", () => {
    const source = novelStudioSource();
    expect(source).toContain(
      '<input v-model="searchQuery" data-testid="novel-search-input" aria-label="搜索小说全部正文" placeholder="搜索全部正文" @keyup.enter="searchAllChapters" />',
    );
  });

  it("正式写入复用 novel command bus，不让 renderer 直接接触文件系统", () => {
    const source = novelStudioSource();
    expect(source).toContain("window.canvasApi.novel.executeNovelCommand");
    expect(source).toContain('command: "novel_save_chapter"');
    expect(source).toContain("expectedRevision: chapter.revision");
    expect(source).toContain("expectedSha256: chapter.sha256");
    expect(source).not.toMatch(/node:fs|writeFile|rename\(/u);
  });

  it("全文搜索走单次 Core IPC，记忆面只读消费 Writing OS 正典投影", () => {
    const source = novelStudioSource();
    for (const marker of [
      "listChapters",
      "readChapter",
      "window.canvasApi.novel.searchChapters",
      "window.canvasApi.novel.listFacts",
      "Writing OS 记忆",
      "novel_stage_story_bible_candidate",
      "legacy adaptation 事实；它们只读保留",
    ]) expect(source).toContain(marker);
    expect(source).not.toContain("window.canvasApi.novel.upsertFact");
    expect(source).not.toContain("offset += 8");
    expect(source).not.toContain("Promise.all(batch.map");
  });

  it("卷章导航使用 50/100 有界分页，不再累计 100000 章或全量挂载 DOM", () => {
    const source = novelStudioSource();
    for (const marker of [
      "VOLUME_PAGE_LIMIT = 50",
      "CHAPTER_PAGE_LIMIT = 100",
      "window.canvasApi.novel.getNavigation",
      "anchorVolumeId",
      "anchorChapterId",
      'data-testid="novel-volume-pagination"',
      'data-testid="novel-chapter-pagination"',
    ]) expect(source).toContain(marker);
    expect(source).not.toContain("window.canvasApi.novel.getWorkspace");
    expect(source).not.toContain("100_000");
    expect(source).not.toContain("limit: 500");
    expect(source).not.toContain("chaptersForVolume");
  });

  it("跨根异步结果按 root + generation 失效，离开编辑器必须经过三选一脏稿门禁", () => {
    const source = novelStudioSource();
    for (const marker of [
      "type NovelLoadScope",
      "function beginLoadScope",
      "function isCurrentLoadScope",
      "novelLoadGate.isCurrent(scope, props.project.projectRoot)",
      "defineExpose<NovelStudioExpose>({ requestLeave })",
      'data-testid="novel-unsaved-dialog"',
      'data-testid="novel-leave-save"',
      'data-testid="novel-leave-discard"',
      'data-testid="novel-leave-cancel"',
      'requestLeave("chapter_switch")',
      "if (isCurrentLoadScope(scope) && activeChapter.value?.chapterId === chapter.chapterId)",
    ]) expect(source).toContain(marker);
    expect(source).not.toContain("当前章节有未保存修改，确定放弃并切换吗？");
  });

  it("桌面显示写前 readiness、当前章状态债与写后探针，并把候选裁决交给 typed human_ui IPC", () => {
    const source = novelStudioSource();
    for (const marker of [
      "window.canvasApi.novel.getWritingDashboard",
      "window.canvasApi.novel.reviewStateCandidate",
      "写前门禁阻断",
      "欠状态提交",
      "写后一致性探针",
      "Context Pack 选择回执",
      "novel-context-pack-receipt",
      "writingDashboard.writeReadiness.lease.contextPackReceipt",
      "逐项轨迹",
      "状态候选已由人类界面接受",
      "expectedCandidateFingerprint: candidate.fingerprint",
      "expectedWritingStateFingerprint: state.fingerprint",
    ]) expect(source).toContain(marker);
    expect(source).toContain("Writing OS 已标记状态债");
    expect(source).not.toContain('reviewer: "desktop-human-owner"');
  });

  it("导入明确创建受管副本，并由顶层打开新工程", () => {
    const source = novelStudioSource();
    for (const copy of [
      "pickSource",
      "pickDestination",
      "preflightSource",
      'command: "novel_import_external_snapshot"',
      "原始来源不会被修改",
      'emit("imported", projectId)',
    ]) expect(source).toContain(copy);
  });
});
