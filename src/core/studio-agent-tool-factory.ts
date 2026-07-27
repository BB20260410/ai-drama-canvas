/**
 * P1.5 Agent 工具工厂：按 unit/episode 注入上下文，禁止跨集乱绑。
 * clean-room（对照火宝 createStoryboardTools 工厂模式）。
 */

export type StudioAgentToolContext = {
  unitId: string;
  episodeId: string;
  projectId?: string;
  allowedCharacterIds: string[];
  allowedSceneIds: string[];
};

export type StudioAgentToolSpec = {
  id: string;
  description: string;
  /** 工具执行时闭包上下文（只读） */
  bound: StudioAgentToolContext;
};

export function createStudioAgentToolFactory(ctx: StudioAgentToolContext): {
  context: StudioAgentToolContext;
  tools: StudioAgentToolSpec[];
  assertInScope: (kind: "character" | "scene", id: string) => void;
} {
  const unitId = ctx.unitId?.trim() ?? "";
  const episodeId = ctx.episodeId?.trim() ?? "";
  if (!unitId || !episodeId) throw new Error("tool-factory: unitId/episodeId 不能为空。");

  const chars = new Set(ctx.allowedCharacterIds.map((x) => x.trim()).filter(Boolean));
  const scenes = new Set(ctx.allowedSceneIds.map((x) => x.trim()).filter(Boolean));

  const bound: StudioAgentToolContext = {
    unitId,
    episodeId,
    projectId: ctx.projectId?.trim() || undefined,
    allowedCharacterIds: [...chars],
    allowedSceneIds: [...scenes],
  };

  function assertInScope(kind: "character" | "scene", id: string): void {
    const t = id?.trim() ?? "";
    if (!t) throw new Error("tool-factory: id 不能为空。");
    if (kind === "character" && !chars.has(t)) {
      throw new Error(`tool-factory: character ${t} 不属于单元 ${unitId}。`);
    }
    if (kind === "scene" && !scenes.has(t)) {
      throw new Error(`tool-factory: scene ${t} 不属于单元 ${unitId}。`);
    }
  }

  const tools: StudioAgentToolSpec[] = [
    {
      id: "read_unit_context",
      description: `读取单元 ${unitId} / 集 ${episodeId} 的剧本与资产上下文`,
      bound,
    },
    {
      id: "bind_character",
      description: `在单元 ${unitId} 内绑定角色（必须属集内）`,
      bound,
    },
    {
      id: "bind_scene",
      description: `在单元 ${unitId} 内绑定场景（必须属集内）`,
      bound,
    },
    {
      id: "save_panel_draft",
      description: `保存宫格草稿到单元 ${unitId}`,
      bound,
    },
  ];

  return { context: bound, tools, assertInScope };
}
