import { access, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { appendEvent, ensureSidecar, getSidecarPaths, writeTextAtomic } from "./sidecar.js";
import type { AgentSkill, AgentSkillCategory } from "./types.js";
import { withProjectLock } from "./locks.js";

const DEFAULT_SKILLS: Array<Omit<AgentSkill, "path" | "revision" | "createdAt" | "updatedAt">> = [
  {
    id: "task-orchestration",
    name: "任务编排与批次边界",
    description: "决定下一任务、批次上限、暂停点和状态回写方式。",
    category: "orchestration",
    enabled: true,
    content: `# 任务编排与批次边界

1. 开始前先扫描真实文件并读取当前节点，不根据聊天记录猜测状态。
2. 图片批次最多 6 个生产单元，视频批次最多 3 个；不得跨集。
3. 每个结果必须使用新版本路径，不覆盖权威素材，不删除旧文件。
4. 机械验收结束后停在视觉验收点；没有视觉结论不得虚报完成。
5. 一批结束时回写画布并汇报完成项、失败项、路径和下一批候选。`,
  },
  {
    id: "production-continuity",
    name: "角色与场景连续性",
    description: "约束角色身份、黄金面具、道具、服装和相邻镜头连续性。",
    category: "continuity",
    enabled: true,
    content: `# 角色与场景连续性

- 优先读取节点关联硬锁和相邻镜头权威版本。
- 阿航、嘟嘟、豆姐及完整黄金面具不得换脸、换设定或改成半面具。
- 保持年龄、体态、服装层级、道具佩戴关系、空间方向、天气与光线连续。
- 参考存在冲突时停止生成，记录冲突并等待选择权威版本。`,
  },
  {
    id: "asset-production",
    name: "图片与视频生产规则",
    description: "规范提示词读取、单图生成、落盘命名和视频桥接。",
    category: "production",
    enabled: true,
    content: `# 图片与视频生产规则

- 每张图单独生成，默认电影写实，读取完整提示词而非只用摘要。
- 图片结果必须检查存在、大小、尺寸、可解码和 raw/labeled 配对。
- 视频只能从已完成图片视觉验收的 15 秒单元创建；结果必须通过 ffprobe。
- 网页或外部供应商结果只有真实落盘并登记后才算生成成功。`,
  },
  {
    id: "director-review",
    name: "导演视觉验收",
    description: "规定图片、视频逐项验收和返工记录要求。",
    category: "review",
    enabled: true,
    content: `# 导演视觉验收

- 图片验收必须看完首帧和尾帧，并对照 raw/labeled 当前权威版本。
- 逐项检查角色身份、硬锁、道具服装、场景连续性、构图和画面质量。
- 视频另查动作连续性、时长、声音与可解码性。
- 不确定时标记待定；返工必须写明失败项和保留项；通过结论写入追加式历史。`,
  },
];

function safeId(value: string): string {
  const id = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,79}$/.test(id)) throw new Error("Skill ID 只允许小写字母、数字、连字符和下划线。");
  return id;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) return trimmed.slice(1, -1);
  return trimmed;
}

function parseSkill(filePath: string, source: string, fileStat: Awaited<ReturnType<typeof stat>>): AgentSkill {
  const lines = source.replace(/\r/g, "").split("\n");
  const metadata: Record<string, string> = {};
  let bodyStart = 0;
  if (lines[0]?.trim() === "---") {
    const end = lines.slice(1).findIndex((line) => line.trim() === "---");
    if (end >= 0) {
      for (const line of lines.slice(1, end + 1)) {
        const match = line.match(/^([a-zA-Z][\w-]*)\s*:\s*(.*)$/);
        if (match) metadata[match[1]!] = unquote(match[2] ?? "");
      }
      bodyStart = end + 2;
    }
  }
  const id = safeId(metadata.id || path.basename(filePath, ".md"));
  const category = (["orchestration", "production", "continuity", "review", "custom"].includes(metadata.category ?? "") ? metadata.category : "custom") as AgentSkillCategory;
  return {
    id,
    name: metadata.name || id,
    description: metadata.description || "项目本地 Codex Skill",
    category,
    enabled: metadata.enabled !== "false",
    content: lines.slice(bodyStart).join("\n").trim(),
    path: filePath,
    revision: Math.max(1, Number(metadata.revision) || 1),
    createdAt: metadata.createdAt || fileStat.birthtime.toISOString(),
    updatedAt: metadata.updatedAt || fileStat.mtime.toISOString(),
  };
}

function serializeSkill(skill: AgentSkill): string {
  return `---\nid: ${skill.id}\nname: ${JSON.stringify(skill.name)}\ndescription: ${JSON.stringify(skill.description)}\ncategory: ${skill.category}\nenabled: ${skill.enabled}\nrevision: ${skill.revision}\ncreatedAt: ${skill.createdAt}\nupdatedAt: ${skill.updatedAt}\n---\n\n${skill.content.trim()}\n`;
}

export async function ensureDefaultSkills(projectRoot: string): Promise<void> {
  const paths = getSidecarPaths(projectRoot);
  const initialized = await access(paths.config).then(() => true).catch(() => false);
  if (!initialized) await ensureSidecar(projectRoot);
  else await Promise.all([mkdir(paths.skills, { recursive: true }), mkdir(paths.skillHistory, { recursive: true })]);
  for (const draft of DEFAULT_SKILLS) {
    const filePath = path.join(paths.skills, `${draft.id}.md`);
    const exists = await access(filePath).then(() => true).catch(() => false);
    if (exists) continue;
    const now = new Date().toISOString();
    await writeTextAtomic(filePath, serializeSkill({ ...draft, path: filePath, revision: 1, createdAt: now, updatedAt: now }));
  }
}

export async function listAgentSkills(projectRoot: string, options: { enabledOnly?: boolean } = {}): Promise<AgentSkill[]> {
  await ensureDefaultSkills(projectRoot);
  return readAgentSkills(projectRoot, options);
}

/** 只读取已经落盘的 Skill；不会初始化默认 Skill、创建目录或改写侧车。 */
export async function readAgentSkills(projectRoot: string, options: { enabledOnly?: boolean } = {}): Promise<AgentSkill[]> {
  const directory = getSidecarPaths(projectRoot).skills;
  const names = (await readdir(directory).catch(() => [] as string[])).filter((name) => name.endsWith(".md") && !name.startsWith("."));
  const skills = await Promise.all(names.map(async (name) => {
    const filePath = path.join(directory, name);
    const fileStat = await stat(filePath);
    if (fileStat.size > 2_000_000) throw new Error(`Skill 文件超过 2MB：${filePath}`);
    return parseSkill(filePath, await readFile(filePath, "utf8"), fileStat);
  }));
  return skills.filter((skill) => !options.enabledOnly || skill.enabled).sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.category.localeCompare(b.category) || a.name.localeCompare(b.name, "zh-CN"));
}

export async function readAgentSkill(projectRoot: string, skillId: string): Promise<AgentSkill> {
  const id = safeId(skillId);
  const skill = (await listAgentSkills(projectRoot)).find((candidate) => candidate.id === id);
  if (!skill) throw new Error(`找不到 Skill：${id}`);
  return skill;
}

export async function saveAgentSkill(
  projectRoot: string,
  input: { id: string; name: string; description: string; category: AgentSkillCategory; enabled: boolean; content: string; expectedUpdatedAt?: string },
): Promise<AgentSkill> {
  return withProjectLock(projectRoot, "skills", async () => {
  await ensureDefaultSkills(projectRoot);
  const id = safeId(input.id);
  const paths = getSidecarPaths(projectRoot);
  const filePath = path.join(paths.skills, `${id}.md`);
  const exists = await access(filePath).then(() => true).catch(() => false);
  let previous: AgentSkill | undefined;
  if (exists) {
    previous = await readAgentSkill(projectRoot, id);
    if (input.expectedUpdatedAt && previous.updatedAt !== input.expectedUpdatedAt) throw new Error("Skill 已被其他窗口更新，请刷新后重试。");
    const backup = path.join(paths.skillHistory, id, `${new Date().toISOString().replace(/[:.]/g, "-")}-r${previous.revision}.md`);
    await mkdir(path.dirname(backup), { recursive: true });
    await writeTextAtomic(backup, await readFile(filePath, "utf8"));
  }
  const now = new Date().toISOString();
  const skill: AgentSkill = {
    id,
    name: input.name.trim().slice(0, 120) || id,
    description: input.description.trim().slice(0, 500) || "项目本地 Codex Skill",
    category: input.category,
    enabled: input.enabled,
    content: input.content.trim().slice(0, 200_000),
    path: filePath,
    revision: (previous?.revision ?? 0) + 1,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
  };
  await writeTextAtomic(filePath, serializeSkill(skill));
  await appendEvent(projectRoot, { actor: "user", type: "skill.saved", data: { skillId: id, revision: skill.revision, enabled: skill.enabled } });
  return skill;
  });
}

export async function deleteAgentSkill(projectRoot: string, skillId: string): Promise<void> {
  await withProjectLock(projectRoot, "skills", async () => {
  const skill = await readAgentSkill(projectRoot, skillId);
  if (DEFAULT_SKILLS.some((candidate) => candidate.id === skill.id)) throw new Error("内置项目 Skill 不能删除，可以停用或编辑。");
  const paths = getSidecarPaths(projectRoot);
  const backup = path.join(paths.skillHistory, skill.id, `${new Date().toISOString().replace(/[:.]/g, "-")}-deleted-r${skill.revision}.md`);
  await mkdir(path.dirname(backup), { recursive: true });
  await writeTextAtomic(backup, await readFile(skill.path, "utf8"));
  await rm(skill.path);
  await appendEvent(projectRoot, { actor: "user", type: "skill.deleted", data: { skillId: skill.id, revision: skill.revision } });
  });
}
