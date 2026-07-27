import { randomUUID } from "node:crypto";
import path from "node:path";
import { getHttpGenerationSubmissionCheckpoint, listGenerationJobs } from "./generation.js";
import { listReviewRecords } from "./reviews.js";
import { getProjectIndex } from "./service.js";
import { listAgentSkills, readAgentSkills } from "./skills.js";
import { appendEvent, getSidecarPaths, listEvents, readJson, writeJsonAtomic, writeTextAtomic } from "./sidecar.js";
import type {
  ContextSearchHit,
  ContinuationSnapshot,
  ProjectContextEntry,
  ProjectContextDeleteInput,
  ProjectContextKind,
  ProjectContextStore,
  ProjectContextUpsertInput,
  ProjectEvent,
  ReviewRecord,
  WorkItem,
} from "./types.js";
import { withProjectLock } from "./locks.js";
import { assertExistingRevision, assertRevisionedUpsert } from "./command-outcome.js";

async function withLock<T>(projectRoot: string, operation: () => Promise<T>): Promise<T> {
  return withProjectLock(projectRoot, "context", operation);
}

async function loadStore(projectRoot: string): Promise<ProjectContextStore> {
  return readJson(getSidecarPaths(projectRoot).context, { schemaVersion: 1, revision: 0, entries: [], updatedAt: new Date(0).toISOString() });
}

export async function listProjectContext(
  projectRoot: string,
  options: { kind?: ProjectContextKind; tag?: string; itemId?: string; limit?: number } = {},
): Promise<ProjectContextEntry[]> {
  const store = await loadStore(projectRoot);
  return store.entries
    .filter((entry) => !options.kind || entry.kind === options.kind)
    .filter((entry) => !options.tag || entry.tags.includes(options.tag))
    .filter((entry) => !options.itemId || entry.itemIds.includes(options.itemId))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, Math.max(1, Math.min(options.limit ?? 500, 2_000)));
}

export async function upsertProjectContext(
  projectRoot: string,
  input: ProjectContextUpsertInput,
  actor: Extract<ProjectEvent["actor"], "user" | "codex"> = "user",
): Promise<ProjectContextEntry> {
  return withLock(projectRoot, async () => {
    const store = await loadStore(projectRoot);
    const existing = typeof input.id === "string" && input.id.trim() ? store.entries.find((entry) => entry.id === input.id) : undefined;
    assertRevisionedUpsert({ id: input.id, expectedRevision: input.expectedRevision, currentRevision: existing?.revision, entityType: "project_context", entityLabel: "项目记忆" });
    const now = new Date().toISOString();
    const entry: ProjectContextEntry = {
      id: existing?.id ?? `context-${randomUUID()}`,
      kind: input.kind,
      title: input.title.trim().slice(0, 160) || "未命名项目记忆",
      content: input.content.trim().slice(0, 100_000),
      tags: [...new Set((input.tags ?? existing?.tags ?? []).map((tag) => tag.trim()).filter(Boolean))].slice(0, 40),
      itemIds: [...new Set((input.itemIds ?? existing?.itemIds ?? []).map((id) => id.trim()).filter(Boolean))].slice(0, 100),
      sourcePaths: [...new Set((input.sourcePaths ?? existing?.sourcePaths ?? []).map((value) => path.resolve(value)))].slice(0, 100),
      revision: (existing?.revision ?? 0) + 1,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    const index = existing ? store.entries.findIndex((candidate) => candidate.id === existing.id) : -1;
    if (index >= 0) store.entries[index] = entry;
    else store.entries.push(entry);
    store.revision += 1;
    store.updatedAt = now;
    await writeJsonAtomic(getSidecarPaths(projectRoot).context, store);
    await appendEvent(projectRoot, { actor, type: "context.upserted", itemId: entry.itemIds[0], data: { contextId: entry.id, kind: entry.kind, revision: entry.revision } });
    return entry;
  });
}

export async function deleteProjectContext(
  projectRoot: string,
  input: ProjectContextDeleteInput,
  actor: Extract<ProjectEvent["actor"], "user" | "codex"> = "user",
): Promise<void> {
  await withLock(projectRoot, async () => {
    const store = await loadStore(projectRoot);
    const contextId = typeof input.contextId === "string" ? input.contextId.trim() : "";
    if (!contextId) assertRevisionedUpsert({ id: input.contextId, expectedRevision: input.expectedRevision, entityType: "project_context", entityLabel: "项目记忆" });
    const existing = store.entries.find((entry) => entry.id === contextId);
    assertExistingRevision({ entityType: "project_context", entityLabel: "项目记忆", entityId: contextId, expectedRevision: input.expectedRevision, currentRevision: existing?.revision });
    store.entries = store.entries.filter((entry) => entry.id !== contextId);
    store.revision += 1;
    store.updatedAt = new Date().toISOString();
    await writeJsonAtomic(getSidecarPaths(projectRoot).context, store);
    await appendEvent(projectRoot, { actor, type: "context.deleted", itemId: existing!.itemIds[0], data: { contextId, kind: existing!.kind, revision: existing!.revision, storeRevision: store.revision } });
  });
}

function normalized(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

function queryTerms(query: string): string[] {
  const compact = normalized(query).slice(0, 120);
  const characters = [...compact];
  const pairs = characters.slice(0, -1).map((character, index) => `${character}${characters[index + 1]}`);
  return [...new Set([compact, ...query.toLowerCase().split(/\s+/).filter((term) => term.length > 1), ...pairs])].filter(Boolean);
}

function relevance(query: string, title: string, content: string, tags: string[] = []): number {
  const compact = normalized(query);
  const normalizedTitle = normalized(title);
  const normalizedContent = normalized(content);
  const normalizedTags = normalized(tags.join(" "));
  let score = normalizedTitle.includes(compact) ? 24 : normalizedContent.includes(compact) ? 12 : normalizedTags.includes(compact) ? 16 : 0;
  for (const term of queryTerms(query)) {
    const normalizedTerm = normalized(term);
    if (!normalizedTerm) continue;
    if (normalizedTitle.includes(normalizedTerm)) score += 4;
    if (normalizedTags.includes(normalizedTerm)) score += 3;
    if (normalizedContent.includes(normalizedTerm)) score += 1;
  }
  return score;
}

function excerpt(value: string, max = 420): string {
  return value.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim().slice(0, max);
}

export async function searchProjectContext(projectRoot: string, query: string, limit = 20): Promise<ContextSearchHit[]> {
  const needle = query.trim();
  if (!needle) {
    return (await listProjectContext(projectRoot, { limit })).map((entry) => ({ id: entry.id, source: "memory", score: 1, title: entry.title, excerpt: excerpt(entry.content), kind: entry.kind, itemId: entry.itemIds[0], path: entry.sourcePaths[0], updatedAt: entry.updatedAt }));
  }
  const [entries, index, reviews, events] = await Promise.all([
    listProjectContext(projectRoot),
    getProjectIndex(projectRoot),
    listReviewRecords(projectRoot, { limit: 300 }),
    listEvents(projectRoot, 300),
  ]);
  const hits: ContextSearchHit[] = [];
  for (const entry of entries) {
    const score = relevance(needle, entry.title, entry.content, entry.tags);
    if (score) hits.push({ id: entry.id, source: "memory", score: score + 8, title: entry.title, excerpt: excerpt(entry.content), kind: entry.kind, itemId: entry.itemIds[0], path: entry.sourcePaths[0], updatedAt: entry.updatedAt });
  }
  for (const item of index.items) {
    const score = relevance(needle, item.title, `${item.infoExcerpt ?? ""}\n${item.sourcePaths.join("\n")}\n${item.failureReason ?? ""}`);
    if (score) hits.push({ id: item.id, source: "item", score: score + 5, title: item.title, excerpt: excerpt(`${item.status} · ${item.nextAction}\n${item.infoExcerpt ?? item.failureReason ?? ""}`), itemId: item.id, path: item.infoPath ?? item.sourcePaths[0], updatedAt: item.updatedAt });
  }
  for (const lock of index.project.hardLocks) {
    const score = relevance(needle, lock.name, `${lock.note}\n${lock.path}`);
    if (score) hits.push({ id: lock.id, source: "hard-lock", score: score + 12, title: lock.name, excerpt: excerpt(lock.note), path: lock.path });
  }
  for (const review of reviews) {
    const score = relevance(needle, `验收 ${review.itemId}`, `${review.note ?? ""}\n${review.criteria.map((criterion) => `${criterion.key}:${criterion.result}:${criterion.note ?? ""}`).join("\n")}`);
    if (score) hits.push({ id: review.id, source: "review", score, title: `${review.decision} · ${review.itemId}`, excerpt: excerpt(review.note ?? review.criteria.map((criterion) => `${criterion.key}: ${criterion.result}`).join("；")), itemId: review.itemId, updatedAt: review.createdAt });
  }
  for (const event of events) {
    const content = JSON.stringify(event.data ?? {});
    const score = relevance(needle, event.type, content);
    if (score) hits.push({ id: event.id, source: "event", score, title: event.type, excerpt: excerpt(content), itemId: event.itemId, updatedAt: event.at });
  }
  return hits.sort((a, b) => b.score - a.score || (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "")).slice(0, Math.max(1, Math.min(limit, 50)));
}

function nextItems(items: WorkItem[], limit = 6): WorkItem[] {
  return items
    .filter((item) => item.type === "unit" && !["已完成", "弃用", "阻塞", "视频生成中"].includes(item.status))
    .sort((a, b) => a.priority - b.priority || (a.episode ?? 0) - (b.episode ?? 0) || (a.unit ?? 0) - (b.unit ?? 0))
    .slice(0, limit);
}

function buildPrompt(snapshot: Omit<ContinuationSnapshot, "prompt">): string {
  const focus = snapshot.focusItem;
  const skills = snapshot.activeSkills.map((skill) => `- ${skill.name}：${skill.path}`).join("\n") || "- 无已启用 Skill";
  const next = snapshot.nextItems.map((item) => `- ${item.id}｜${item.status}｜${item.nextAction}`).join("\n") || "- 当前没有可领取的生产单元";
  const context = snapshot.relatedContext.slice(0, 6).map((hit) => `- [${hit.source}] ${hit.title}：${excerpt(hit.excerpt, 180)}`).join("\n") || "- 无关联项目记忆";
  const recovery = snapshot.generationRecovery.map((job) => `- ${job.jobId}｜${job.kind}｜${job.providerId}｜${job.subagentCheckpoint ? `subagent ${job.subagentCheckpoint.stage} R${job.subagentCheckpoint.revision}｜lease=${job.subagentCheckpoint.lease?.leaseId ?? "none"}｜call=${job.subagentCheckpoint.callIntent?.callId ?? "none"}` : job.browserCheckpoint ? `browser ${job.browserCheckpoint.stage} R${job.browserCheckpoint.revision}｜clientJobId=${job.browserCheckpoint.submissionIntent?.clientJobId ?? job.jobId}` : job.comfyUiCheckpoint ? `comfyui ${job.comfyUiCheckpoint.stage} R${job.comfyUiCheckpoint.revision}｜promptId=${job.comfyUiCheckpoint.promptId}` : job.httpSubmissionCheckpoint ? `http ${job.httpSubmissionCheckpoint.stage} R${job.httpSubmissionCheckpoint.revision}｜clientJobId=${job.httpSubmissionCheckpoint.submissionIntent.clientJobId}` : job.status}`).join("\n") || "- 无待对账生成任务";
  const mode = snapshot.generationRecovery.length ? "中断恢复；完成提交结果对账前禁止领取新任务或再次提交。" : "自动驾驶；每批视觉验收后暂停。";
  const firstAction = snapshot.generationRecovery.length
    ? "先调用 doctor_project、get_project_snapshot 和 list_command_ledger。网页任务逐项读取 get_browser_generation_plan；HTTP 任务读取 httpSubmissionCheckpoint.revision 后调用 reconcile_http_generation_submission；ComfyUI 任务调用 process_generation_queue，只按已保存 promptId 查询 history/queue，绝不重新 POST。子代理任务先读取 get_subagent_image_generation_plan：generation_unknown 只能对账，candidate_generated 只能视觉验收，leased/generating 必须核对 owner/心跳/callId，绝不重复调用。"
    : "先调用 get_progress 获取真实扫描快照，再读取当前节点、项目记忆和已启用 Skill。不要根据聊天记录猜测完成状态。";
  return `连接本机“AI 漫剧画布”，项目主根是：\n${snapshot.projectRoot}\n项目：${snapshot.projectName}\n\n模式：${mode}\n\n${firstAction}\n\n待对账生成任务：\n${recovery}\n\n当前焦点：\n${focus ? `${focus.id}｜${focus.title}｜${focus.status}\n下一动作：${focus.nextAction}\n信息文件：${focus.infoPath ?? "未识别"}` : snapshot.generationRecovery.length ? "暂停生产节点推进，先恢复上述生成任务。" : "未指定；调用 get_next_task 领取最高优先级节点。"}\n\n下一批候选：\n${next}\n\n必须读取的项目 Skill：\n${skills}\n\n关联上下文：\n${context}\n\n执行要求：\n1. 文件系统、机械验收和追加式视觉验收共同决定完成状态。\n2. 旧版、弃用、备份不计入完成度；不得删除或覆盖权威素材。\n3. 每张图单独生成；严格保持角色、完整黄金面具、道具、服装和场景连续性。\n4. 新结果独立落盘并登记，完成后检查存在、大小、尺寸、解码、raw/labeled 配对和占位图。\n5. 判断不确定时停在待视觉验收或返工，不虚报完成。\n6. submission_unknown 只能对账：找到远端任务则登记 externalTaskId；确认未找到则提交结构化 reconciliation 并关闭旧任务，新尝试必须创建新版本。\n7. 一批结束后回写画布，汇报完成项、失败项、路径和下一批候选，然后暂停。`;
}

export async function getContinuationSnapshot(projectRoot: string, options: { itemId?: string; initializeDefaultSkills?: boolean } = {}): Promise<ContinuationSnapshot> {
  const [index, events, reviews, skills, generationJobs] = await Promise.all([
    getProjectIndex(projectRoot),
    listEvents(projectRoot, 20),
    listReviewRecords(projectRoot, { limit: 20 }),
    options.initializeDefaultSkills === false ? readAgentSkills(projectRoot, { enabledOnly: true }) : listAgentSkills(projectRoot, { enabledOnly: true }),
    listGenerationJobs(projectRoot),
  ]);
  const generationRecovery: ContinuationSnapshot["generationRecovery"] = generationJobs.filter((job) => {
    if (job.status === "submission_unknown" || job.status === "generation_unknown" || job.status === "candidate_generated") return true;
    return ["leased", "generating", "generation_unknown", "candidate_generated", "generated"].includes(job.subagentCheckpoint?.stage ?? "");
  }).map((job) => ({
    jobId: job.id,
    itemId: job.itemId,
    kind: job.kind,
    providerId: job.providerId,
    status: job.status,
    expectedOutputPath: job.expectedOutputPath,
    requestPath: job.requestPath,
    error: job.error,
    browserCheckpoint: job.browserCheckpoint ? {
      revision: job.browserCheckpoint.revision,
      stage: job.browserCheckpoint.stage,
      updatedAt: job.browserCheckpoint.updatedAt,
      submissionIntent: job.browserCheckpoint.submissionIntent,
      submissionReconciliation: job.browserCheckpoint.submissionReconciliation,
    } : undefined,
    httpSubmissionCheckpoint: getHttpGenerationSubmissionCheckpoint(job),
    comfyUiCheckpoint: job.comfyUiCheckpoint ? structuredClone(job.comfyUiCheckpoint) : undefined,
    subagentCheckpoint: job.subagentCheckpoint ? structuredClone(job.subagentCheckpoint) : undefined,
  }));
  const candidates = generationRecovery.length ? [] : nextItems(index.items);
  const focusItem = options.itemId ? index.items.find((item) => item.id === options.itemId) : generationRecovery.length ? undefined : candidates[0];
  if (options.itemId && !focusItem) throw new Error(`找不到接续焦点节点：${options.itemId}`);
  let relatedContext: ContextSearchHit[];
  if (focusItem) {
    const [linked, searched] = await Promise.all([
      listProjectContext(projectRoot, { itemId: focusItem.id, limit: 30 }),
      searchProjectContext(projectRoot, `${focusItem.title} ${focusItem.infoExcerpt?.slice(0, 120) ?? ""}`, 20),
    ]);
    const linkedHits: ContextSearchHit[] = linked.map((entry) => ({ id: entry.id, source: "memory", score: 1_000, title: entry.title, excerpt: excerpt(entry.content), kind: entry.kind, itemId: focusItem.id, path: entry.sourcePaths[0], updatedAt: entry.updatedAt }));
    const seen = new Set(linkedHits.map((hit) => `${hit.source}:${hit.id}`));
    relatedContext = [...linkedHits, ...searched.filter((hit) => !seen.has(`${hit.source}:${hit.id}`))].slice(0, 12);
  } else {
    relatedContext = await searchProjectContext(projectRoot, "", 12);
  }
  const base: Omit<ContinuationSnapshot, "prompt"> = {
    generatedAt: new Date().toISOString(),
    projectRoot: index.project.primaryRoot,
    projectName: index.project.name,
    scannedAt: index.scannedAt,
    summary: index.summary,
    focusItem,
    nextItems: candidates,
    blockers: index.items.filter((item) => item.status === "阻塞").slice(0, 20),
    generationRecovery,
    relatedContext,
    recentEvents: events,
    recentReviews: reviews,
    activeSkills: skills.map(({ id, name, description, category, path, revision }) => ({ id, name, description, category, path, revision })),
  };
  return { ...base, prompt: buildPrompt(base) };
}

function renderHandoff(snapshot: ContinuationSnapshot): string {
  const nextRows = snapshot.nextItems.map((item) => `| ${item.id} | ${item.title} | ${item.status} | ${item.nextAction} |`).join("\n") || "| — | 无 | — | — |";
  const contextRows = snapshot.relatedContext.map((hit) => `- **${hit.title}**（${hit.source}）：${hit.excerpt}`).join("\n") || "- 无";
  const recoveryRows = snapshot.generationRecovery.map((job) => `| ${job.jobId} | ${job.providerId} | ${job.subagentCheckpoint?.stage ?? job.browserCheckpoint?.stage ?? job.httpSubmissionCheckpoint?.stage ?? job.status} | R${job.subagentCheckpoint?.revision ?? job.browserCheckpoint?.revision ?? job.httpSubmissionCheckpoint?.revision ?? "—"} | ${job.subagentCheckpoint?.callIntent?.callId ?? job.browserCheckpoint?.submissionIntent?.clientJobId ?? job.httpSubmissionCheckpoint?.submissionIntent.clientJobId ?? job.jobId} |`).join("\n") || "| — | 无 | — | — | — |";
  return `# ${snapshot.projectName} · Codex 接续\n\n- 生成时间：${snapshot.generatedAt}\n- 项目主根：${snapshot.projectRoot}\n- 文件快照：${snapshot.scannedAt}\n- 当前焦点：${snapshot.focusItem?.id ?? "未指定"}\n\n## 待对账生成任务\n\n| 任务 | 供应商 | 状态 | 修订 | clientJobId |\n|---|---|---|---|---|\n${recoveryRows}\n\n## 下一批候选\n\n| 节点 | 标题 | 状态 | 下一动作 |\n|---|---|---|---|\n${nextRows}\n\n## 关联上下文\n\n${contextRows}\n\n## 已启用 Skill\n\n${snapshot.activeSkills.map((skill) => `- [${skill.name}](${skill.path}) · r${skill.revision}`).join("\n")}\n\n## 复制到新 Codex 任务\n\n\`\`\`text\n${snapshot.prompt}\n\`\`\`\n`;
}

export async function createContinuationHandoff(projectRoot: string, options: { itemId?: string } = {}): Promise<{ path: string; snapshot: ContinuationSnapshot }> {
  const snapshot = await getContinuationSnapshot(projectRoot, options);
  const filePath = path.join(getSidecarPaths(projectRoot).handoffs, `Codex接续_${snapshot.generatedAt.replace(/[:.]/g, "-")}.md`);
  await writeTextAtomic(filePath, renderHandoff(snapshot));
  await appendEvent(projectRoot, { actor: "user", type: "handoff.created", itemId: snapshot.focusItem?.id, data: { path: filePath } });
  return { path: filePath, snapshot };
}
