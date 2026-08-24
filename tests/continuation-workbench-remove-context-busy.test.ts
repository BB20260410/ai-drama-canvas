import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "@vue/compiler-sfc";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function source(): string {
  return readFileSync(path.join(root, "src/renderer/src/components/ContinuationWorkbenchView.vue"), "utf8");
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

describe("接续工作台删除项目记忆源码合同", () => {
  it("SFC 可解析并暴露删除项目记忆", () => {
    const vue = source();
    expect(parse(vue, { filename: "ContinuationWorkbenchView.vue" }).errors).toEqual([]);
    expect(vue).toContain('data-testid="delete-context"');
  });

  it("删除项目记忆在进行中 fail-closed：busy 在首个 await 之前置位，按钮禁用并给出大白话原因，连点不会重复写入", () => {
    const vue = source();
    const removeButton = buttonAttrs(vue, "delete-context");
    expect(removeButton).toContain(':disabled="removingContext || savingContext"');
    expect(removeButton).toContain("正在处理，不能再删除项目记忆");
    expect(vue).toContain("{{ removingContext ? '删除中' : '删除' }}");

    const remove = handlerBody(vue, "async function removeContext()", "function emptySkill()");
    expect(remove).toContain("if(removingContext.value||savingContext.value)return");
    expect(remove).toContain("removingContext.value=true");
    expect(remove.indexOf("if(removingContext.value||savingContext.value)return")).toBeLessThan(
      remove.indexOf("removingContext.value=true"),
    );
    expect(remove.indexOf("removingContext.value=true")).toBeLessThan(
      remove.indexOf("await window.canvasApi.deleteContext"),
    );
    expect(remove).toContain("removingContext.value=false");
  });
});


describe("接续工作台保存项目记忆源码合同", () => {
  it("SFC 可解析并暴露保存项目记忆", () => {
    const vue = source();
    expect(parse(vue, { filename: "ContinuationWorkbenchView.vue" }).errors).toEqual([]);
    expect(vue).toContain('data-testid="save-context"');
  });

  it("保存项目记忆在进行中 fail-closed：busy 在首个 await 之前置位，按钮禁用并给出大白话原因，连点不会重复写入", () => {
    const vue = source();
    const saveButton = buttonAttrs(vue, "save-context");
    expect(saveButton).toContain(':disabled="savingContext || !contextDraft.title.trim()"');
    expect(saveButton).toContain("正在处理，不能再保存项目记忆");
    expect(vue).toContain("{{ savingContext ? '保存中' : '保存' }}");

    const save = handlerBody(vue, "async function saveContext()", "async function removeContext()");
    expect(save).toContain("if(savingContext.value)return");
    expect(save).toContain("savingContext.value=true");
    expect(save.indexOf("if(savingContext.value)return")).toBeLessThan(save.indexOf("savingContext.value=true"));
    expect(save.indexOf("savingContext.value=true")).toBeLessThan(save.indexOf("await window.canvasApi.upsertContext"));
    expect(save).toContain("savingContext.value=false");
    expect(save).toContain('emit("failed",message(error))');
  });
});

describe("接续工作台保存 Skill 源码合同", () => {
  it("SFC 可解析并暴露保存项目 Skill", () => {
    const vue = source();
    expect(parse(vue, { filename: "ContinuationWorkbenchView.vue" }).errors).toEqual([]);
    expect(vue).toContain('data-testid="save-skill"');
  });

  it("保存项目 Skill 在进行中 fail-closed：busy 在首个 await 之前置位，按钮禁用并给出大白话原因，连点不会重复写入", () => {
    const vue = source();
    const saveButton = buttonAttrs(vue, "save-skill");
    expect(saveButton).toContain(':disabled="savingSkill || !skillDraft.id || !skillDraft.name.trim()"');
    expect(saveButton).toContain("正在处理，不能再保存项目 Skill");
    expect(vue).toContain("{{ savingSkill ? '保存中' : '保存并备份旧版' }}");

    const save = handlerBody(vue, "async function saveSkill()", "function revealSkill()");
    expect(save).toContain("if(savingSkill.value)return");
    expect(save).toContain("savingSkill.value=true");
    expect(save.indexOf("if(savingSkill.value)return")).toBeLessThan(save.indexOf("savingSkill.value=true"));
    expect(save.indexOf("savingSkill.value=true")).toBeLessThan(save.indexOf("await window.canvasApi.saveSkill"));
    expect(save).toContain("savingSkill.value=false");
    expect(save).toContain('emit("failed",message(error))');
  });
});

describe("接续工作台生成接续文件源码合同", () => {
  it("SFC 可解析并暴露生成接续文件", () => {
    const vue = source();
    expect(parse(vue, { filename: "ContinuationWorkbenchView.vue" }).errors).toEqual([]);
    expect(vue).toContain('data-testid="create-handoff"');
  });

  it("生成接续文件在进行中 fail-closed：busy 在首个 await 之前置位，按钮禁用并给出大白话原因，连点不会重复写入", () => {
    const vue = source();
    const handoffButton = buttonAttrs(vue, "create-handoff");
    expect(handoffButton).toContain(':disabled="creatingHandoff"');
    expect(handoffButton).toContain("正在处理，不能再生成接续文件");
    expect(vue).toContain("{{ creatingHandoff ? '正在落盘' : '生成接续文件' }}");

    const create = handlerBody(vue, "async function createHandoff()", "async function search()");
    expect(create).toContain("if(creatingHandoff.value||!snapshot.value)return");
    expect(create).toContain("creatingHandoff.value=true");
    expect(create.indexOf("if(creatingHandoff.value||!snapshot.value)return")).toBeLessThan(
      create.indexOf("creatingHandoff.value=true"),
    );
    expect(create.indexOf("creatingHandoff.value=true")).toBeLessThan(create.indexOf("await window.canvasApi.createHandoff"));
    expect(create).toContain("creatingHandoff.value=false");
    expect(create).toContain('emit("failed",message(error))');
  });
});

describe("接续工作台列表视口剔除", () => {
  it("search-results article 使用 content-visibility，离屏关联命中跳过同步布局", () => {
    const vue = source();
    expect(vue).toContain('v-for="hit in searchHits"');
    expect(vue).toContain(".search-results,.skill-inspector{min-height:0;overflow:auto;border-left:1px solid #30322c;background:#171815}");
    expect(vue).toContain(".search-results article{display:grid;grid-template-columns:23px 1fr;gap:8px;padding:12px 14px;border-bottom:1px solid #292b25;content-visibility:auto;contain-intrinsic-size:auto 56px}");
    expect(vue).not.toMatch(/\.search-results article\{[^}]*content-visibility:hidden/);
  });

  it("queue/memory/skill 索引行共用 content-visibility，离屏条目跳过同步布局", () => {
    const vue = source();
    expect(vue).toContain('v-for="entry in filteredContext"');
    expect(vue).toContain('v-for="skill in skills"');
    expect(vue).toContain(".queue-rail,.memory-index,.skill-index{min-height:0;overflow:auto;border-right:1px solid #30322c;background:#151613}");
    expect(vue).toContain(".queue-rail>button,.memory-index>button,.skill-index>button{position:relative;width:100%;display:block;padding:13px;border:0;border-bottom:1px solid #292b25;border-left:2px solid transparent;background:transparent;color:#b7b9b0;text-align:left;cursor:pointer;content-visibility:auto;contain-intrinsic-size:auto 64px}");
    expect(vue).not.toMatch(/\.skill-index>button\{[^}]*content-visibility:hidden/);
  });

  it("recovery-banner article 使用 content-visibility，离屏中断恢复卡跳过同步布局", () => {
    const vue = source();
    expect(vue).toContain('v-for="job in snapshot.generationRecovery"');
    expect(vue).toContain('data-testid="create-handoff"');
    expect(vue).toContain(".brief-main{min-width:0;overflow:auto;padding:24px 27px 60px}");
    expect(vue).toContain(".recovery-banner article{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:11px 16px;border-bottom:1px solid #35281c;content-visibility:auto;contain-intrinsic-size:auto 48px}");
    expect(vue).not.toMatch(/\.recovery-banner article\{[^}]*content-visibility:hidden/);
    expect(vue).not.toMatch(/\.recovery-banner>header\{[^}]*content-visibility/);
  });
});
