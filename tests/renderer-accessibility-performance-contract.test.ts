import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseSfc } from "@vue/compiler-sfc";
import {
  baseParse,
  NodeTypes,
  type ElementNode,
  type RootNode,
  type TemplateChildNode,
} from "@vue/compiler-dom";

const rendererRoot = path.resolve("src/renderer/src");

async function listVueFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return listVueFiles(target);
    return entry.isFile() && entry.name.endsWith(".vue") ? [target] : [];
  }));
  return nested.flat().sort();
}

function hasNamedProp(node: ElementNode, name: string): boolean {
  return node.props.some((prop) => (
    (prop.type === NodeTypes.ATTRIBUTE && prop.name === name)
    || (
      prop.type === NodeTypes.DIRECTIVE
      && prop.arg?.type === NodeTypes.SIMPLE_EXPRESSION
      && prop.arg.content === name
    )
  ));
}

function staticAttributeValue(node: ElementNode, name: string): string | undefined {
  const prop = node.props.find((candidate) => candidate.type === NodeTypes.ATTRIBUTE && candidate.name === name);
  return prop?.type === NodeTypes.ATTRIBUTE ? prop.value?.content : undefined;
}

function hasMeaningfulText(node: TemplateChildNode): boolean {
  if (node.type === NodeTypes.TEXT) return Boolean(node.content.trim());
  if (node.type === NodeTypes.INTERPOLATION) return true;
  if (node.type === NodeTypes.ELEMENT) return node.children.some(hasMeaningfulText);
  return false;
}

function walkTemplate(
  root: RootNode,
  visit: (node: ElementNode, insideForm: boolean) => void,
): void {
  const walk = (node: TemplateChildNode, insideForm: boolean): void => {
    if (node.type !== NodeTypes.ELEMENT) return;
    const nextInsideForm = insideForm || node.tag === "form";
    visit(node, insideForm);
    for (const child of node.children) walk(child, nextInsideForm);
  };
  for (const child of root.children) walk(child, false);
}

describe("renderer 全局可访问性与媒体解码合同", () => {
  it("所有 Vue 页面按钮和媒体元素都满足静态可操作合同", async () => {
    const files = await listVueFiles(rendererRoot);
    const unnamedButtons: string[] = [];
    const implicitFormButtons: string[] = [];
    const unwiredButtons: string[] = [];
    const incompleteImages: string[] = [];
    const incompleteMedia: string[] = [];
    let buttonCount = 0;

    for (const file of files) {
      const source = await readFile(file, "utf8");
      const { descriptor, errors } = parseSfc(source, { filename: file });
      expect(errors, file).toEqual([]);
      if (!descriptor.template) continue;
      const template = baseParse(descriptor.template.content);
      const templateLine = descriptor.template.loc.start.line - 1;

      walkTemplate(template, (node, insideForm) => {
        const location = `${path.relative(process.cwd(), file)}:${node.loc.start.line + templateLine}`;
        if (node.tag === "button") {
          buttonCount += 1;
          const hasName = node.children.some(hasMeaningfulText)
            || hasNamedProp(node, "aria-label")
            || hasNamedProp(node, "title");
          if (!hasName) unnamedButtons.push(location);
          if (insideForm && !hasNamedProp(node, "type")) implicitFormButtons.push(location);
          const type = staticAttributeValue(node, "type");
          const intentionalCurrentTab = staticAttributeValue(node, "aria-pressed") === "true"
            || staticAttributeValue(node, "aria-current") === "page";
          const wired = hasNamedProp(node, "onClick")
            || hasNamedProp(node, "click")
            || type === "submit"
            || hasNamedProp(node, "disabled")
            || intentionalCurrentTab;
          if (!wired) unwiredButtons.push(location);
        }
        if (node.tag === "img" && (!hasNamedProp(node, "alt") || !hasNamedProp(node, "decoding"))) {
          incompleteImages.push(location);
        }
        if ((node.tag === "video" || node.tag === "audio") && !hasNamedProp(node, "preload")) {
          incompleteMedia.push(location);
        }
      });
    }

    expect(buttonCount).toBeGreaterThan(500);
    expect(unnamedButtons, "图标按钮必须具有可访问名称").toEqual([]);
    expect(implicitFormButtons, "表单内按钮必须显式声明 type").toEqual([]);
    expect(unwiredButtons, "按钮必须有点击、提交、禁用或当前页语义").toEqual([]);
    expect(incompleteImages, "图片必须声明 alt 与异步 decoding").toEqual([]);
    expect(incompleteMedia, "音视频必须声明 preload 策略").toEqual([]);
  });
});
