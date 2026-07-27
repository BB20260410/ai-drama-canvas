export const MANAGED_STUDIO_CREATE_MODE = "story_first" as const;

export interface ManagedStudioCreateDraft {
  parentRoot: string;
  name: string;
  slug?: string;
}

export interface ManagedStudioCreateValidation {
  valid: boolean;
  message: string;
  input?: { parentRoot: string; name: string; slug?: string };
}

export function validateManagedStudioCreateDraft(draft: ManagedStudioCreateDraft): ManagedStudioCreateValidation {
  const parentRoot = draft.parentRoot.normalize("NFKC").trim();
  const name = draft.name.normalize("NFKC").trim();
  const slug = draft.slug?.normalize("NFKC").trim() || undefined;
  if (!parentRoot) return { valid: false, message: "请明确填写新工程的父目录绝对路径。" };
  if (!parentRoot.startsWith("/")) return { valid: false, message: "工程父目录必须是绝对路径。" };
  if (!name) return { valid: false, message: "请填写新工程名称。" };
  if (name.length > 120) return { valid: false, message: "工程名称不得超过 120 个字符。" };
  if (/\p{Cc}/u.test(name) || (slug && /\p{Cc}/u.test(slug))) {
    return { valid: false, message: "工程名称和目录短名不得包含控制字符。" };
  }
  if (slug && slug.length > 120) return { valid: false, message: "目录短名不得超过 120 个字符。" };
  return {
    valid: true,
    message: "将建立 story_first 受管工程；不会扫描、导入或改写父目录中的既有项目。",
    input: { parentRoot, name, ...(slug ? { slug } : {}) },
  };
}

