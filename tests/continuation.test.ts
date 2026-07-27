import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { seedProductionReady } from "./workflow-helpers.js";
import { createContinuationHandoff, deleteProjectContext, getContinuationSnapshot, listProjectContext, searchProjectContext, upsertProjectContext } from "../src/core/memory.js";
import { deleteAgentSkill, listAgentSkills, readAgentSkill, saveAgentSkill } from "../src/core/skills.js";
import { createTaskPack, scanAndPersist } from "../src/core/service.js";
import { getSidecarPaths } from "../src/core/sidecar.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function project(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-continuation-"));
  roots.push(root);
  const directory = path.join(root, "EP01_15s_001_金面初醒");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "00_信息.md"), "首帧提示词：阿航戴完整黄金面具从祭坛醒来。\n尾帧提示词：保持面具完整与角色一致。\n", "utf8");
  await scanAndPersist(root);
  await seedProductionReady(root, "frames");
  return root;
}

describe("Codex 项目记忆与 Skill 接续", () => {
  it("生成回执不明时暂停下一批并把 clientJobId 写入接续提示", async () => {
    const root = await project();
    const now = new Date().toISOString();
    await writeFile(getSidecarPaths(root).generationJobs, `${JSON.stringify([{
      schemaVersion: 1,
      id: "gen-continuation-reconcile-test",
      projectId: "project-continuation-test",
      itemId: "main-ep01-unit001",
      providerId: "browser-continuation-test",
      kind: "image",
      status: "submission_unknown",
      prompt: "接续待对账测试",
      referencePaths: [],
      storyboardRevision: 0,
      storyboardRows: [],
      expectedOutputPath: path.join(root, "待对账结果_raw.png"),
      requestPath: path.join(root, ".aicanvas", "generation-requests", "gen-continuation-reconcile-test.browser.json"),
      browserState: "submission_unknown",
      browserCheckpoint: { revision: 4, stage: "submission_unknown", updatedAt: now, submissionIntent: { clientJobId: "gen-continuation-reconcile-test", attempt: 1, createdAt: now } },
      attempts: 1,
      createdAt: now,
      updatedAt: now,
    }], null, 2)}\n`, "utf8");

    const snapshot = await getContinuationSnapshot(root);
    expect(snapshot.generationRecovery).toEqual([expect.objectContaining({ jobId: "gen-continuation-reconcile-test", status: "submission_unknown", browserCheckpoint: expect.objectContaining({ revision: 4, submissionIntent: expect.objectContaining({ clientJobId: "gen-continuation-reconcile-test" }) }) })]);
    expect(snapshot.nextItems).toHaveLength(0);
    expect(snapshot.focusItem).toBeUndefined();
    expect(snapshot.prompt).toContain("完成提交结果对账前禁止领取新任务");
    expect(snapshot.prompt).toContain("get_browser_generation_plan");
    expect(snapshot.prompt).toContain("clientJobId=gen-continuation-reconcile-test");
    const handoff = await createContinuationHandoff(root);
    expect(await readFile(handoff.path, "utf8")).toContain("## 待对账生成任务");
  });

  it("建立默认 Skill、保存版本备份并注入任务包", async () => {
    const root = await project();
    const [skills, concurrentSkills] = await Promise.all([listAgentSkills(root), listAgentSkills(root)]);
    expect(skills).toHaveLength(4);
    expect(concurrentSkills).toHaveLength(4);
    expect(skills.every((skill) => skill.enabled && skill.revision === 1)).toBe(true);
    const continuity = await readAgentSkill(root, "production-continuity");
    const updated = await saveAgentSkill(root, { id: continuity.id, name: continuity.name, description: continuity.description, category: continuity.category, enabled: true, content: `${continuity.content}\n\n- 新增：祭坛段保持面具无裂纹。`, expectedUpdatedAt: continuity.updatedAt });
    expect(updated.revision).toBe(2);
    await expect(saveAgentSkill(root, { id: continuity.id, name: continuity.name, description: continuity.description, category: continuity.category, enabled: true, content: continuity.content, expectedUpdatedAt: continuity.updatedAt })).rejects.toThrow("其他窗口");
    const backups = await readdir(path.join(getSidecarPaths(root).skillHistory, continuity.id));
    expect(backups.some((name) => name.includes("r1"))).toBe(true);
    await expect(deleteAgentSkill(root, continuity.id)).rejects.toThrow("不能删除");

    const { task } = await createTaskPack(root, { kind: "image" });
    expect(task.skillRefs).toHaveLength(4);
    expect(task.skillRefs.find((skill) => skill.id === continuity.id)?.revision).toBe(2);
  });

  it("记忆关联真实节点、支持检索、并生成可恢复接续文件", async () => {
    const root = await project();
    const entry = await upsertProjectContext(root, {
      kind: "continuity",
      title: "完整黄金面具硬锁",
      content: "阿航在祭坛段始终佩戴完整黄金面具，不允许半面具、裂纹或换脸。",
      tags: ["阿航", "黄金面具", "祭坛"],
      itemIds: ["main-ep01-unit001"],
    });
    expect(entry.revision).toBe(1);
    await expect(upsertProjectContext(root, { kind: entry.kind, title: "非法创建", content: "create 不得带 revision", expectedRevision: 1 } as any)).rejects.toMatchObject({ name: "RejectedCommandFailure", result: { reason: "invalid_create_revision", entityType: "project_context" } });
    await expect(upsertProjectContext(root, { id: "", kind: entry.kind, title: entry.title, content: "空 ID" } as any)).rejects.toMatchObject({ name: "RejectedCommandFailure", result: { reason: "invalid_id" } });
    await expect(upsertProjectContext(root, { id: "context-missing", kind: entry.kind, title: entry.title, content: "不得静默新建", expectedRevision: 1 })).rejects.toMatchObject({ name: "RejectedCommandFailure", result: { reason: "not_found", entityId: "context-missing" } });
    await expect(upsertProjectContext(root, { id: entry.id, kind: entry.kind, title: entry.title, content: "缺少修订" } as any)).rejects.toMatchObject({ name: "RejectedCommandFailure", result: { reason: "revision_required", currentRevision: entry.revision } });
    await expect(upsertProjectContext(root, { id: entry.id, kind: entry.kind, title: entry.title, content: "非法修订", expectedRevision: 0 })).rejects.toMatchObject({ name: "RejectedCommandFailure", result: { reason: "invalid_revision", currentRevision: entry.revision } });
    const results = await searchProjectContext(root, "阿航 完整黄金面具", 10);
    expect(results[0]?.source).toBe("memory");
    expect(results.some((hit) => hit.itemId === "main-ep01-unit001")).toBe(true);

    const snapshot = await getContinuationSnapshot(root, { itemId: "main-ep01-unit001" });
    expect(snapshot.focusItem?.id).toBe("main-ep01-unit001");
    expect(snapshot.activeSkills).toHaveLength(4);
    expect(snapshot.prompt).toContain(root);
    expect(snapshot.prompt).toContain("完整黄金面具硬锁");
    expect(snapshot.relatedContext[0]?.id).toBe(entry.id);
    expect(snapshot.prompt).toContain("task-orchestration.md");
    const handoff = await createContinuationHandoff(root, { itemId: "main-ep01-unit001" });
    await expect(access(handoff.path)).resolves.toBeUndefined();
    expect(await readFile(handoff.path, "utf8")).toContain("复制到新 Codex 任务");

    const updated = await upsertProjectContext(root, { id: entry.id, kind: entry.kind, title: entry.title, content: entry.content, expectedRevision: entry.revision });
    expect(updated.revision).toBe(entry.revision + 1);
    await expect(deleteProjectContext(root, { contextId: entry.id } as any)).rejects.toMatchObject({ name: "RejectedCommandFailure", result: { reason: "revision_required" } });
    await expect(deleteProjectContext(root, { contextId: entry.id, expectedRevision: entry.revision } as any)).rejects.toMatchObject({ name: "RejectedCommandFailure", result: { reason: "revision_conflict", currentRevision: updated.revision } });
    await deleteProjectContext(root, { contextId: entry.id, expectedRevision: updated.revision } as any);
    expect(await listProjectContext(root)).toHaveLength(0);
  });

  it("项目记忆 update/delete 使用同一 revision 竞争时只提交一次", async () => {
    const root = await project();
    const entry = await upsertProjectContext(root, { kind: "decision", title: "并发决策", content: "初始内容" });
    const results = await Promise.allSettled([
      upsertProjectContext(root, { id: entry.id, kind: entry.kind, title: entry.title, content: "窗口更新", expectedRevision: entry.revision }),
      deleteProjectContext(root, { contextId: entry.id, expectedRevision: entry.revision } as any),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect((results.find((result) => result.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({ name: "RejectedCommandFailure", result: { reason: expect.stringMatching(/revision_conflict|not_found/) } });
    const entries = await listProjectContext(root);
    if (entries.length) expect(entries[0]?.revision).toBe(entry.revision + 1);
  });
});
