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

  it("Context Pack 回执 summary 含 testid，details 仍 open，不铺逐项轨迹", () => {
    const source = novelStudioSource();
    expect(source).toContain('class="context-pack-receipt"');
    expect(source).toContain('data-testid="novel-context-pack-receipt"');
    expect(source).toContain('data-testid="novel-context-pack-receipt-summary"');
    expect(source).toContain('<summary data-testid="novel-context-pack-receipt-summary">Context Pack 选择回执</summary>');
    expect(source).toContain("data-testid=\"novel-context-pack-receipt\"\n                open>");
    expect(source).not.toContain("novel-context-pack-receipt-summary-");
    expect(source).not.toContain('context-pack-receipt" role="dialog"');
  });

  it("Context Pack 逐项轨迹 summary 含 testid，不抢回执", () => {
    const source = novelStudioSource();
    expect(source).toContain('class="receipt-trace"');
    expect(source).toContain('data-testid="novel-context-pack-receipt-trace"');
    expect(source).toContain('<summary data-testid="novel-context-pack-receipt-trace">逐项轨迹（{{ writingDashboard.writeReadiness.lease.contextPackReceipt.selectionTrace.entries.length }}）</summary>');
    expect(source).not.toContain("novel-context-pack-receipt-trace-");
    expect(source).not.toContain('receipt-trace" role="dialog"');
    expect(source).toContain('data-testid="novel-context-pack-receipt-summary"');
    expect(source).toContain("data-testid=\"novel-context-pack-receipt\"\n                open>");
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

  it("项目中心在 busy/loading 时 fail-closed：按钮禁用并给出原因，连点不会边导入边切工程", () => {
    const source = novelStudioSource();
    expect(source).toContain('data-testid="novel-open-project-center"');
    expect(source).toContain(':disabled="Boolean(busy || loading)"');
    expect(source).toContain("正在处理，不能打开项目中心");
    expect(source).toContain("正在切换工作区");
    expect(source).toContain("function requestOpenProjectCenter(): void {");
    const start = source.indexOf("function requestOpenProjectCenter()");
    const end = source.indexOf("\nfunction chapterTitle", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const handler = source.slice(start, end);
    expect(handler).toContain("if (busy.value || props.loading) return;");
    expect(handler).toContain('emit("open-project-center")');
    expect(handler.indexOf("if (busy.value || props.loading) return;")).toBeLessThan(
      handler.indexOf('emit("open-project-center")'),
    );
    expect(source).not.toContain('@click="emit(\'open-project-center\')"');
  });

  it("导入/备份/恢复/保存在 busy 时 fail-closed：按钮禁用并给出大白话原因，连点不会重复触发", () => {
    const source = novelStudioSource();
    const buttonAttrs = (testId: string): string => {
      const marker = `data-testid="${testId}"`;
      const idx = source.indexOf(marker);
      expect(idx).toBeGreaterThan(-1);
      const start = source.lastIndexOf("<button", idx);
      const end = source.indexOf(">", idx);
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      return source.slice(start, end + 1);
    };
    const handlerBody = (signature: string, nextSignature: string): string => {
      const start = source.indexOf(signature);
      const end = source.indexOf(nextSignature, start + signature.length);
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      return source.slice(start, end);
    };

    const importFile = buttonAttrs("novel-import-file");
    expect(importFile).toContain(':disabled="busy"');
    expect(importFile).toContain("正在处理，不能再导入文件");

    const importDirectory = buttonAttrs("novel-import-directory");
    expect(importDirectory).toContain(':disabled="busy"');
    expect(importDirectory).toContain("正在处理，不能再导入目录");

    const backup = buttonAttrs("novel-backup");
    expect(backup).toContain(':disabled="busy"');
    expect(backup).toContain("正在处理，不能再备份");

    const restore = buttonAttrs("novel-restore");
    expect(restore).toContain(':disabled="busy"');
    expect(restore).toContain("正在处理，不能再恢复");

    const save = buttonAttrs("novel-save-chapter");
    expect(save).toContain(':disabled="busy || !dirty"');
    expect(save).toContain("正在处理，不能再保存");

    const importHandler = handlerBody("async function importNovel(", "watch(() => props.project.projectRoot");
    expect(importHandler).toContain("if (busy.value) return;");
    expect(importHandler.indexOf("if (busy.value) return;")).toBeLessThan(importHandler.indexOf("busy.value = true;"));

    const backupHandler = handlerBody("async function backupProject(", "async function restoreProject(");
    expect(backupHandler).toContain("if (busy.value) return;");
    expect(backupHandler.indexOf("if (busy.value) return;")).toBeLessThan(backupHandler.indexOf("busy.value = true;"));

    const restoreHandler = handlerBody("async function restoreProject(", "async function importNovel(");
    expect(restoreHandler).toContain("if (busy.value) return;");
    expect(restoreHandler.indexOf("if (busy.value) return;")).toBeLessThan(restoreHandler.indexOf("busy.value = true;"));

    const saveHandler = handlerBody("async function saveActiveChapter(", "async function activateChapterPage(");
    expect(saveHandler).toContain("if (busy.value) return;");
    expect(saveHandler.indexOf("if (busy.value) return;")).toBeLessThan(saveHandler.indexOf("busy.value = true;"));
  });

  it("初始化正文库在 busy 时 fail-closed：按钮禁用并给出大白话原因，连点不会重复初始化", () => {
    const source = novelStudioSource();
    const marker = 'data-testid="novel-initialize"';
    const idx = source.indexOf(marker);
    expect(idx).toBeGreaterThan(-1);
    const start = source.lastIndexOf("<button", idx);
    const end = source.indexOf(">", idx);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const button = source.slice(start, end + 1);
    expect(button).toContain(':disabled="busy"');
    expect(button).toContain("正在处理，不能再初始化正文库");

    const handlerStart = source.indexOf("async function initializeManuscript(");
    const handlerEnd = source.indexOf("async function openChapter(", handlerStart + 1);
    expect(handlerStart).toBeGreaterThan(-1);
    expect(handlerEnd).toBeGreaterThan(handlerStart);
    const handler = source.slice(handlerStart, handlerEnd);
    expect(handler).toContain("if (busy.value) return;");
    expect(handler.indexOf("if (busy.value) return;")).toBeLessThan(handler.indexOf("busy.value = true;"));
    expect(handler.indexOf("busy.value = true;")).toBeLessThan(handler.indexOf("await runCommand"));
    expect(handler).toContain("error.value = messageOf(reason);");
  });

  it("新建卷/章/改名在 busy 时 fail-closed：handler 在置 busy 前拦截，同 tick 连点不会重复写入", () => {
    const source = novelStudioSource();
    const handlerBody = (signature: string, nextSignature: string): string => {
      const start = source.indexOf(signature);
      const end = source.indexOf(nextSignature, start + signature.length);
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      return source.slice(start, end);
    };

    expect(source).toContain(':disabled="busy || !newVolumeTitle.trim()"');
    expect(source).toContain("正在处理，不能再新建卷");
    expect(source).toContain(':disabled="busy || !newChapterTitles[volume.volumeId]?.trim()"');
    expect(source).toContain("正在处理，不能再新建章节");
    expect(source).toContain("正在处理，不能再改名");

    const createVolume = handlerBody("async function createVolume()", "async function createChapter(");
    expect(createVolume).toContain("if (busy.value) return;");
    expect(createVolume.indexOf("if (busy.value) return;")).toBeLessThan(createVolume.indexOf("busy.value = true;"));
    expect(createVolume.indexOf("busy.value = true;")).toBeLessThan(createVolume.indexOf("await runCommand"));

    const createChapter = handlerBody("async function createChapter(", "async function renameActiveChapter(");
    expect(createChapter).toContain("if (busy.value) return;");
    expect(createChapter.indexOf("if (busy.value) return;")).toBeLessThan(createChapter.indexOf("busy.value = true;"));
    expect(createChapter.indexOf("busy.value = true;")).toBeLessThan(createChapter.indexOf("await runCommand"));

    const rename = handlerBody("async function renameActiveChapter()", "async function searchAllChapters(");
    expect(rename).toContain("if (busy.value) return;");
    expect(rename.indexOf("if (busy.value) return;")).toBeLessThan(rename.indexOf("window.prompt"));
    expect(rename.indexOf("if (busy.value) return;")).toBeLessThan(rename.indexOf("busy.value = true;"));
    expect(rename.indexOf("busy.value = true;")).toBeLessThan(rename.indexOf("await runCommand"));
  });

  it("选卷/翻页在 busy 时 fail-closed：不能把进行中的写入 busy 清掉", () => {
    const source = novelStudioSource();
    const handlerBody = (signature: string, nextSignature: string): string => {
      const start = source.indexOf(signature);
      const end = source.indexOf(nextSignature, start + signature.length);
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      return source.slice(start, end);
    };

    const selectVolume = handlerBody("async function selectVolume(", "async function changeChapterPage(");
    expect(selectVolume).toContain("if (busy.value) return;");
    expect(selectVolume.indexOf("if (busy.value) return;")).toBeLessThan(selectVolume.indexOf("await requestLeave("));
    expect(selectVolume.indexOf("if (busy.value) return;")).toBeLessThan(selectVolume.indexOf("busy.value = true;"));

    const changeChapter = handlerBody("async function changeChapterPage(", "async function changeVolumePage(");
    expect(changeChapter).toContain("if (busy.value) return;");
    expect(changeChapter.indexOf("if (busy.value) return;")).toBeLessThan(changeChapter.indexOf("await requestLeave("));
    expect(changeChapter.indexOf("if (busy.value) return;")).toBeLessThan(changeChapter.indexOf("busy.value = true;"));

    const changeVolume = handlerBody("async function changeVolumePage(", "async function reviewCandidate(");
    expect(changeVolume).toContain("if (busy.value) return;");
    expect(changeVolume.indexOf("if (busy.value) return;")).toBeLessThan(changeVolume.indexOf("await requestLeave("));
    expect(changeVolume.indexOf("if (busy.value) return;")).toBeLessThan(changeVolume.indexOf("busy.value = true;"));
  });
});

describe("小说工作区章节行视口剔除", () => {
  it("volume-section 章行使用 content-visibility，离屏最多 100 章跳过同步布局", () => {
    const source = novelStudioSource();
    expect(source).toContain('v-for="chapter in chapters"');
    expect(source).toContain("CHAPTER_PAGE_LIMIT = 100");
    expect(source).toContain(".chapter-rail, .memory-rail { min-height: 0; overflow: auto; background: #f6f7f4; }");
    expect(source).toContain(".volume-section > button { width: 100%; display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; padding: 8px; border: 0; border-radius: 6px; text-align: left; background: transparent; cursor: pointer; content-visibility: auto; contain-intrinsic-size: auto 40px; }");
    expect(source).not.toMatch(/\.volume-section > button \{[^}]*content-visibility:\s*hidden/);
  });

  it("search-results 行使用 content-visibility，离屏命中跳过同步布局", () => {
    const source = novelStudioSource();
    expect(source).toContain('v-for="result in searchResults"');
    expect(source).toContain('data-testid="novel-search-results"');
    expect(source).toContain(".search-results > button { width: 100%; display: grid; gap: 3px; padding: 8px 10px; border: 0; border-top: 1px solid #edf0ed; text-align: left; background: white; cursor: pointer; content-visibility: auto; contain-intrinsic-size: auto 48px; }");
    expect(source).not.toMatch(/\.search-results > button \{[^}]*content-visibility:\s*hidden/);
    expect(source).not.toMatch(/\.search-results header button \{[^}]*content-visibility/);
  });

  it("memory-list 行使用 content-visibility，离屏正典条目跳过同步布局", () => {
    const source = novelStudioSource();
    expect(source).toContain('v-for="fact in visibleFacts"');
    expect(source).toContain('data-testid="novel-memory-list"');
    expect(source).toContain(".memory-list > button { width: 100%; display: grid; gap: 4px; padding: 10px 7px; border: 0; border-bottom: 1px solid #e5e9e5; text-align: left; background: transparent; cursor: pointer; content-visibility: auto; contain-intrinsic-size: auto 48px; }");
    expect(source).not.toMatch(/\.memory-list > button \{[^}]*content-visibility:\s*hidden/);
  });

  it("candidate-list 状态候选卡使用 content-visibility，横向离屏卡跳过同步布局", () => {
    const source = novelStudioSource();
    expect(source).toContain('v-for="candidate in pendingCandidates"');
    expect(source).toContain('data-testid="novel-state-candidate-board"');
    expect(source).toContain(".candidate-list { display: flex; gap: 5px; overflow-x: auto; padding-bottom: 2px; }");
    expect(source).toContain(".candidate-list button { min-width: 120px; display: grid; gap: 3px; padding: 8px; border: 1px solid var(--line); border-radius: 7px; text-align: left; background: white; cursor: pointer; content-visibility: auto; contain-intrinsic-size: auto 48px; }");
    expect(source).not.toMatch(/\.candidate-list button \{[^}]*content-visibility:\s*hidden/);
    expect(source).not.toMatch(/\.candidate-detail \{[^}]*content-visibility/);
    expect(source).not.toMatch(/\.candidate-board > header \{[^}]*content-visibility/);
  });

  it("volume-toggle 卷头使用 content-visibility，离屏最多 50 卷跳过同步布局", () => {
    const source = novelStudioSource();
    expect(source).toContain('v-for="volume in sortedVolumes"');
    expect(source).toContain("VOLUME_PAGE_LIMIT = 50");
    expect(source).toContain("class=\"volume-toggle\"");
    expect(source).toContain(".volume-toggle { width: 100%; display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; padding: 7px 5px; border: 0; border-radius: 6px; color: inherit; text-align: left; background: transparent; cursor: pointer; content-visibility: auto; contain-intrinsic-size: auto 40px; }");
    expect(source).not.toMatch(/\.volume-toggle \{[^}]*content-visibility:\s*hidden/);
    expect(source).not.toMatch(/\.rail-pagination button \{[^}]*content-visibility/);
    expect(source).not.toMatch(/\.inline-create button \{[^}]*content-visibility/);
  });
});
