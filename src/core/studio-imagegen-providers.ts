/**
 * Studio 正式生图执行面：只允许 Agent 侧 Codex / Grok。
 * 冻结包描述“生成什么”；dispatch 记录“谁执行”；应用内不内嵌浏览器/Artlist。
 */

export const STUDIO_FORMAL_IMAGEGEN_PROVIDERS = ["codex", "grok"] as const;
export type StudioFormalImagegenProvider = (typeof STUDIO_FORMAL_IMAGEGEN_PROVIDERS)[number];

/** 冻结包统一执行面：任意 allowedProviders 内的 Agent 均可消费。 */
export const STUDIO_IMAGEGEN_EXECUTOR_KIND = "agent-imagegen" as const;
export type StudioImagegenExecutorKind = typeof STUDIO_IMAGEGEN_EXECUTOR_KIND;

/** 历史冻结包曾写死的 executorKind；只读兼容，禁止新写。 */
export const STUDIO_IMAGEGEN_LEGACY_EXECUTOR_KIND = "codex-imagegen" as const;
export type StudioImagegenLegacyExecutorKind = typeof STUDIO_IMAGEGEN_LEGACY_EXECUTOR_KIND;

export type StudioImagegenExecutorKindAny =
  | StudioImagegenExecutorKind
  | StudioImagegenLegacyExecutorKind;

export const STUDIO_FORMAL_IMAGEGEN_ALLOWED_PROVIDERS: readonly StudioFormalImagegenProvider[] = [
  ...STUDIO_FORMAL_IMAGEGEN_PROVIDERS,
];

export function isStudioFormalImagegenProvider(value: unknown): value is StudioFormalImagegenProvider {
  return value === "codex" || value === "grok";
}

export function normalizeStudioFormalImagegenProvider(
  value: unknown,
  field = "provider",
): StudioFormalImagegenProvider {
  if (!isStudioFormalImagegenProvider(value)) {
    throw new Error(`${field} 必须是 codex 或 grok（正式生图仅允许这两家 Agent）。`);
  }
  return value;
}

export function assertStudioImagegenExecutorAllowed(
  executorKind: string,
  provider?: StudioFormalImagegenProvider,
): void {
  if (executorKind !== STUDIO_IMAGEGEN_EXECUTOR_KIND && executorKind !== STUDIO_IMAGEGEN_LEGACY_EXECUTOR_KIND) {
    throw new Error(`不支持的 executorKind：${executorKind}；正式面仅 agent-imagegen（及历史 codex-imagegen）。`);
  }
  if (provider !== undefined && !isStudioFormalImagegenProvider(provider)) {
    throw new Error(`不支持的 imagegen provider：${String(provider)}`);
  }
  // 历史 codex-imagegen 包在未声明 provider 时默认按 codex 解释；显式 grok 仍允许登记到新账本。
  if (executorKind === STUDIO_IMAGEGEN_LEGACY_EXECUTOR_KIND && provider === undefined) {
    return;
  }
}

export function defaultProviderForExecutorKind(
  executorKind: StudioImagegenExecutorKindAny,
): StudioFormalImagegenProvider {
  return executorKind === STUDIO_IMAGEGEN_LEGACY_EXECUTOR_KIND ? "codex" : "codex";
}

export function providerDisplayName(provider: StudioFormalImagegenProvider): string {
  return provider === "codex" ? "Codex" : "Grok";
}

export function providerToolHints(provider: StudioFormalImagegenProvider): {
  primaryTool: string;
  referenceTool?: string;
  maxImages: 1;
  notes: string[];
} {
  if (provider === "codex") {
    return {
      primaryTool: "image_gen（Codex / OpenAI 图像能力）",
      maxImages: 1,
      notes: [
        "严格只调用一次生图工具，只产出一张图。",
        "人物/场景/道具只能来自冻结 pack 的 controlReferences 与 modelPayload。",
        "禁止浏览器、Artlist、ComfyUI、网页自动化旁路。",
      ],
    };
  }
  return {
    primaryTool: "image_gen",
    referenceTool: "image_edit（有参考图时优先图生图保持一致性）",
    maxImages: 1,
    notes: [
      "严格只生成一张 9:16 分镜；有权威参考时用 image_edit 绑定角色/场景/道具。",
      "不得替换冻结包外的身份；不得把字幕/分屏画进 raw。",
      "禁止浏览器、Artlist、网页自动化旁路。",
    ],
  };
}
