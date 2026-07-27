/**
 * P1.8 提示词模板外置：从 markdown 文本加载 name/description/body。
 * clean-room（对照 skills/SKILL.md 形态，不依赖 MCP 大改）。
 */

export type StudioPromptTemplate = {
  name: string;
  description: string;
  body: string;
};

const FRONTMATTER = /^---\s*\n([\s\S]*?)\n---\s*\n?/;

export function loadStudioPromptTemplateFromMarkdown(markdown: string): StudioPromptTemplate {
  const text = markdown?.trim() ?? "";
  if (!text) throw new Error("prompt-template: 内容为空。");
  let name = "";
  let description = "";
  let body = text;
  const m = text.match(FRONTMATTER);
  if (m) {
    const fm = m[1]!;
    for (const line of fm.split("\n")) {
      const nm = line.match(/^name:\s*(.+)$/i);
      const dm = line.match(/^description:\s*(.+)$/i);
      if (nm) name = nm[1]!.trim().replace(/^["']|["']$/g, "");
      if (dm) description = dm[1]!.trim().replace(/^["']|["']$/g, "");
    }
    body = text.slice(m[0].length).trim();
  }
  if (!name) {
    const h = body.match(/^#\s+(.+)$/m);
    name = h?.[1]?.trim() || "unnamed-template";
  }
  if (!body) throw new Error("prompt-template: body 为空。");
  return { name, description: description || name, body };
}

export function renderStudioPromptTemplate(
  template: StudioPromptTemplate,
  vars: Record<string, string>,
): string {
  let out = template.body;
  for (const [k, v] of Object.entries(vars)) {
    out = out.split(`{{${k}}}`).join(v);
  }
  if (/\{\{[a-zA-Z0-9_]+\}\}/.test(out)) {
    throw new Error("prompt-template: 仍有未替换占位符。");
  }
  return out;
}
