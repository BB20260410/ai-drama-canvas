import { readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

async function source(relativePath: string): Promise<string> {
  return readFile(path.join(process.cwd(), relativePath), "utf8");
}

describe("Material Studio UI contract", () => {
  it("把跨视图公共类型放在无运行时 UI 依赖的合同中", async () => {
    const contractPath = "src/renderer/src/material-studio-ui-contract.ts";
    const contract = await source(contractPath);
    const parsed = ts.createSourceFile(contractPath, contract, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const imports = parsed.statements.filter(ts.isImportDeclaration).map((statement) => ({
      specifier: ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : "",
      typeOnly: statement.importClause?.isTypeOnly ?? false,
    }));

    expect(contract).toContain("export interface MaterialStudioUiApi");
    expect(contract).toContain("export interface MaterialStudioProjectOverview");
    expect(contract).toContain("export interface StudioScriptProductUiApi");
    expect(imports.every((entry) => entry.typeOnly)).toBe(true);
    expect(imports.map((entry) => entry.specifier)).not.toContain("vue");
    expect(imports.map((entry) => entry.specifier).some((specifier) => specifier.endsWith(".vue"))).toBe(false);
    expect(contract).not.toContain("preload");
  });

  it("SFC 兼容再导出，消费者不再把 SFC 当类型合同", async () => {
    const material = await source("src/renderer/src/components/MaterialStudioView.vue");
    expect(material).toContain('} from "../material-studio-ui-contract";');
    expect(material).toContain("export type {");
    expect(material).not.toContain("export interface MaterialStudioUiApi");
    expect(material).not.toContain("export interface StudioScriptProductUiApi");

    for (const relativePath of [
      "src/renderer/src/App.vue",
      "src/renderer/src/components/ManagedStudioCanvasView.vue",
      "src/renderer/src/components/ScriptMediaAlignView.vue",
    ]) {
      const content = await source(relativePath);
      expect(content).toContain("material-studio-ui-contract");
      expect(content).not.toContain("MaterialStudioView.vue\";");
    }
  });
});
