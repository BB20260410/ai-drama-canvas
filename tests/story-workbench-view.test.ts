import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "@vue/compiler-sfc";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function source(): string {
  return readFileSync(path.join(root, "src/renderer/src/components/StoryWorkbenchView.vue"), "utf8");
}

function buttonAttrs(text: string, testId: string): string {
  const marker = `data-testid="${testId}"`;
  const idx = text.indexOf(marker);
  expect(idx).toBeGreaterThan(-1);
  const start = text.lastIndexOf("<button", idx);
  const end = text.indexOf(">", idx);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return text.slice(start, end + 1);
}

function handlerBody(text: string, signature: string, nextSignature: string): string {
  const start = text.indexOf(signature);
  const end = text.indexOf(nextSignature, start + signature.length);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return text.slice(start, end);
}

describe("故事工作台原文导入源码合同", () => {
  it("SFC 可解析并暴露导入并拆章", () => {
    const vue = source();
    expect(parse(vue, { filename: "StoryWorkbenchView.vue" }).errors).toEqual([]);
    expect(vue).toContain('data-testid="story-import-run"');
  });

  it("导入原文在进行中 fail-closed：busy 在首个 await 之前置位，按钮禁用并给出大白话原因，连点不会重复写入", () => {
    const vue = source();
    const importButton = buttonAttrs(vue, "story-import-run");
    expect(importButton).toContain(':disabled="importing || !importTitle.trim() || (importMode===\'file\' ? !importPath : !pasteContent.trim())"');
    expect(importButton).toContain("正在处理，不能再导入原文");
    expect(vue).toContain("{{ importing ? '正在拆章' : '导入并拆章' }}");

    const runImport = handlerBody(vue, "async function runImport()", "async function previewContext()");
    expect(runImport).toContain("if(importing.value)return");
    expect(runImport).toContain("importing.value=true");
    expect(runImport.indexOf("if(importing.value)return")).toBeLessThan(runImport.indexOf("importing.value=true"));
    expect(runImport.indexOf("importing.value=true")).toBeLessThan(runImport.indexOf("await window.canvasApi.importStoryFile"));
    expect(runImport).toContain("importing.value=false");
  });

  it("选择原文文件 fail-closed：pickingSource 挡住连点双开系统文件框", () => {
    const vue = source();
    expect(vue).toContain('class="file-picker"');
    expect(vue).toContain(':disabled="pickingSource || importing"');
    expect(vue).toContain("正在处理，不能再选择原文文件");
    expect(vue).toContain('@click="pickSource"');
    const pick = handlerBody(vue, "async function pickSource()", "async function runImport()");
    expect(pick).toContain("if(pickingSource.value||importing.value)return");
    expect(pick).toContain("pickingSource.value=true");
    expect(pick.indexOf("if(pickingSource.value||importing.value)return")).toBeLessThan(pick.indexOf("pickingSource.value=true"));
    expect(pick.indexOf("pickingSource.value=true")).toBeLessThan(pick.indexOf("await window.canvasApi.pickStorySource"));
    expect(pick).toContain("pickingSource.value=false");
  });
});

describe("故事工作台事件图连线源码合同", () => {
  it("SFC 可解析并暴露事件图连线", () => {
    const vue = source();
    expect(parse(vue, { filename: "StoryWorkbenchView.vue" }).errors).toEqual([]);
    expect(vue).toContain('data-testid="story-graph-connect"');
  });

  it("事件图连线在进行中 fail-closed：busy 在首个 await 之前置位，画布禁用连线并给出大白话原因，连点不会重复写入", () => {
    const vue = source();
    expect(vue).toContain(':nodes-connectable="!connecting"');
    expect(vue).toContain("正在处理，不能再连事件");
    expect(vue).toContain("{{ connecting ? '正在连线' : '连线方向：前置事件 → 后续事件' }}");

    const onGraphConnect = handlerBody(vue, "async function onGraphConnect(", "function onGraphNode(");
    expect(onGraphConnect).toContain("if(connecting.value)return");
    expect(onGraphConnect).toContain("connecting.value=true");
    expect(onGraphConnect.indexOf("if(connecting.value)return")).toBeLessThan(onGraphConnect.indexOf("connecting.value=true"));
    expect(onGraphConnect.indexOf("connecting.value=true")).toBeLessThan(onGraphConnect.indexOf("await window.canvasApi.connectStoryEvents"));
    expect(onGraphConnect).toContain("connecting.value=false");
  });

  it("事件图 Vue Flow Controls Arrow/Home/End 只移焦，不改连线写入", () => {
    const vue = source();
    expect(vue).toContain("[data-testid='story-graph-connect'] .vue-flow__controls-button");
    expect(vue).toContain("function onStoryGraphControlsKeydown");
    expect(vue).toContain("moveStoryGraphControlsFocus");
    expect(vue).toContain('event.key!=="ArrowUp"&&event.key!=="ArrowDown"&&event.key!=="Home"&&event.key!=="End"');
    const keydown = handlerBody(vue, "function onStoryGraphControlsKeydown", "function onStoryGraphControlsFocusIn");
    expect(keydown).toContain("event.preventDefault()");
    expect(keydown).toContain("moveStoryGraphControlsFocus");
    expect(keydown).not.toContain("onGraphConnect");
    expect(keydown).not.toContain("connectStoryEvents");
    const move = handlerBody(vue, "function moveStoryGraphControlsFocus", "function onStoryGraphControlsKeydown");
    expect(move).not.toContain("connectStoryEvents");
    expect(vue).not.toContain("#managed-studio-flow .vue-flow__controls-button");
    expect(vue).toContain(':nodes-connectable="!connecting"');
  });
});

describe("故事工作台保存事件源码合同", () => {
  it("SFC 可解析并暴露保存事件", () => {
    const vue = source();
    expect(parse(vue, { filename: "StoryWorkbenchView.vue" }).errors).toEqual([]);
    expect(vue).toContain('data-testid="story-save-event"');
  });

  it("保存事件在进行中 fail-closed：busy 在首个 await 之前置位，按钮禁用并给出大白话原因，连点不会重复写入", () => {
    const vue = source();
    const saveButton = buttonAttrs(vue, "story-save-event");
    expect(saveButton).toContain(':disabled="savingEvent || !activeChapter || !eventDraft.title.trim()"');
    expect(saveButton).toContain("正在处理，不能再保存事件");
    expect(vue).toContain("{{ savingEvent ? '保存中' : eventDraft.status === 'confirmed' ? '保存已确认事件' : '保存事件草稿' }}");

    const saveEvent = handlerBody(vue, "async function saveEvent()", "async function onGraphConnect(");
    expect(saveEvent).toContain("if(savingEvent.value||!activeChapter.value)return");
    expect(saveEvent).toContain("savingEvent.value=true");
    expect(saveEvent.indexOf("if(savingEvent.value||!activeChapter.value)return")).toBeLessThan(
      saveEvent.indexOf("savingEvent.value=true"),
    );
    expect(saveEvent.indexOf("savingEvent.value=true")).toBeLessThan(
      saveEvent.indexOf("await window.canvasApi.upsertStoryEvent"),
    );
    expect(saveEvent).toContain("savingEvent.value=false");
    expect(saveEvent).toContain('emit("failed",message(error))');
  });
});

describe("故事工作台章节列表视口剔除", () => {
  it("chapter-list 行使用 content-visibility，避免离屏数百章同步布局", () => {
    const vue = source();
    expect(vue).toContain('v-for="chapter in sourceChapters"');
    expect(vue).toContain(".chapter-rail{min-height:0;overflow:auto;border-right:1px solid #30322c;background:#151613}");
    expect(vue).toContain(".chapter-list>button{width:100%;display:grid;grid-template-columns:28px 1fr;gap:8px;padding:10px 12px;border:0;border-bottom:1px solid #292b25;border-left:2px solid transparent;background:transparent;color:#aaa;text-align:left;content-visibility:auto;contain-intrinsic-size:auto 52px}");
    expect(vue).not.toMatch(/\.chapter-list>button\{[^}]*content-visibility:hidden/);
  });

  it("event-strip 行使用 content-visibility，离屏事件跳过同步布局", () => {
    const vue = source();
    expect(vue).toContain('v-for="event in chapterEvents"');
    expect(vue).toContain(".event-strip{max-height:176px;overflow:auto;border-bottom:1px solid #30322c}");
    expect(vue).toContain(".event-strip>button{width:100%;display:grid;grid-template-columns:10px 1fr;gap:7px;padding:10px 13px;border:0;border-bottom:1px solid #292b25;background:transparent;color:#aaa;text-align:left;content-visibility:auto;contain-intrinsic-size:auto 52px}");
    expect(vue).not.toMatch(/\.event-strip>button\{[^}]*content-visibility:hidden/);
  });

  it("source-row 使用 content-visibility，离屏原文来源跳过同步布局", () => {
    const vue = source();
    expect(vue).toContain('v-for="source in sources"');
    expect(vue).toContain(".source-row{width:100%;display:grid;grid-template-columns:28px 1fr;gap:9px;padding:12px;border:0;border-bottom:1px solid #292b25;border-left:2px solid transparent;background:transparent;color:#bbb;text-align:left;content-visibility:auto;contain-intrinsic-size:auto 56px}");
    expect(vue).not.toMatch(/\.source-row\{[^}]*content-visibility:hidden/);
  });
});
