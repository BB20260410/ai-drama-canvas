import { readFile } from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  STUDIO_INTERNAL_COMMAND_NAMES,
  STUDIO_PUBLIC_COMMAND_NAMES,
} from "../src/core/studio-command-runtime.js";

async function moduleImports(relativePath: string): Promise<Array<{ specifier: string; runtime: boolean }>> {
  const absolutePath = path.join(process.cwd(), relativePath);
  const source = ts.createSourceFile(
    absolutePath,
    await readFile(absolutePath, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const imports: Array<{ specifier: string; runtime: boolean }> = [];
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const clause = statement.importClause;
    const runtime = !clause || (!clause.isTypeOnly && (
      Boolean(clause.name)
      || !clause.namedBindings
      || ts.isNamespaceImport(clause.namedBindings)
      || clause.namedBindings.elements.some((element) => !element.isTypeOnly)
    ));
    imports.push({ specifier: statement.moduleSpecifier.text, runtime });
  }
  return imports;
}

async function studioExecutorCaseNames(): Promise<string[]> {
  const relativePath = "src/core/studio-command-executor.ts";
  const absolutePath = path.join(process.cwd(), relativePath);
  const source = ts.createSourceFile(
    absolutePath,
    await readFile(absolutePath, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const executor = source.statements.find((statement): statement is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === "executeStudioCommand");
  expect(executor, `${relativePath} 必须定义 executeStudioCommand`).toBeDefined();
  const switchStatement = executor?.body?.statements.find(ts.isSwitchStatement);
  expect(switchStatement, "Studio executor 必须用单一 switch 明示列出权威命令集").toBeDefined();
  return switchStatement?.caseBlock.clauses.flatMap((clause) =>
    ts.isCaseClause(clause) && ts.isStringLiteral(clause.expression)
      ? [clause.expression.text]
      : []) ?? [];
}

describe("source module boundaries", () => {
  it("Studio executor case 集合与运行时 56 public + 2 internal 权威集精确一致", async () => {
    const actual = await studioExecutorCaseNames();
    const expected = [...STUDIO_PUBLIC_COMMAND_NAMES, ...STUDIO_INTERNAL_COMMAND_NAMES];
    expect(new Set(actual).size).toBe(actual.length);
    expect([...actual].sort()).toEqual([...expected].sort());
  });

  it("Studio executor 不持有 command-bus 可靠性壳，且只由 bus 在生产源码引用", async () => {
    const imports = await moduleImports("src/core/studio-command-executor.ts");
    const runtimeSpecifiers = imports.filter((entry) => entry.runtime).map((entry) => entry.specifier);
    for (const forbidden of [
      "./command-bus.js",
      "./command-ledger-store.js",
      "./locks.js",
      "./studio-sqlite-busy.js",
      "./studio-project-write-lease.js",
      "./sidecar.js",
    ]) {
      expect(runtimeSpecifiers).not.toContain(forbidden);
    }
    const importers: string[] = [];
    for (const relativePath of await fg(["src/**/*.ts", "src/**/*.vue"], { cwd: process.cwd() })) {
      if (relativePath === "src/core/studio-command-executor.ts") continue;
      const source = await readFile(path.join(process.cwd(), relativePath), "utf8");
      if (source.includes("studio-command-executor")) importers.push(relativePath);
    }
    expect(importers).toEqual(["src/core/command-bus.ts"]);
  });

  it("command-bus 保留且仅保留三条 active-project fence 与一次性结果投影", async () => {
    const source = await readFile(path.join(process.cwd(), "src/core/command-bus.ts"), "utf8");
    expect(source.match(/withActiveProjectActivationFence\(/gu)).toHaveLength(3);
    for (const command of [
      "prepare_studio_imagegen_call",
      "authorize_studio_higgsfield_connector_request",
      "prepare_studio_higgsfield_video_generation",
    ]) {
      expect(source).toContain(`request.command === "${command}"`);
    }
    expect(source).toContain("projectHiggsfieldConnectorQueueResultForPersistence");
    expect(source).toContain("projectHiggsfieldPrepareResultForPersistence");
    expect(source).toContain("revokeImagegenCallCapabilityFromResult");
  });

  it("Material Studio UI 合同不带运行时 Vue、SFC 或 preload 依赖", async () => {
    const imports = await moduleImports("src/renderer/src/material-studio-ui-contract.ts");
    expect(imports.every((entry) => !entry.runtime)).toBe(true);
    expect(imports.map((entry) => entry.specifier)).not.toContain("vue");
    expect(imports.map((entry) => entry.specifier).some((specifier) => specifier.endsWith(".vue"))).toBe(false);
    expect(imports.map((entry) => entry.specifier).some((specifier) => specifier.includes("preload"))).toBe(false);
  });

  it("Material Studio read mapper 只依赖只读类型与 UI 合同", async () => {
    const imports = await moduleImports("src/renderer/src/material-studio-read-mapper.ts");
    expect(imports.every((entry) => !entry.runtime)).toBe(true);
    expect(imports.map((entry) => entry.specifier).some((specifier) => specifier.endsWith(".vue"))).toBe(false);
    expect(imports.map((entry) => entry.specifier)).not.toContain("vue");
  });

  it("旧画布投影不携带 Vue 状态、IPC 或项目 epoch", async () => {
    const projection = await readFile(path.join(process.cwd(), "src/renderer/src/legacy-canvas-flow-projection.ts"), "utf8");
    expect(projection).not.toContain("from \"vue\"");
    expect(projection).not.toContain("window.canvasApi");
    expect(projection).not.toContain("LegacyProjectEpochToken");
    expect(projection).not.toContain("nextTick");
    expect(projection).toContain("visibleItems");
    expect(projection).toContain("planned:");
  });

  it("Higgsfield queue 与视频 owner 只共享纯合同，不再形成运行时环", async () => {
    const queueImports = await moduleImports("src/core/studio-higgsfield-connector-queue.ts");
    const videoImports = await moduleImports("src/core/studio-higgsfield-video-generation.ts");
    const contractImports = await moduleImports("src/core/studio-higgsfield-connector-contract.ts");

    expect(queueImports).toContainEqual({
      specifier: "./studio-higgsfield-connector-contract.js",
      runtime: true,
    });
    expect(videoImports).toContainEqual({
      specifier: "./studio-higgsfield-connector-contract.js",
      runtime: true,
    });
    expect(queueImports).not.toContainEqual({
      specifier: "./studio-higgsfield-video-generation.js",
      runtime: true,
    });
    expect(contractImports.filter((entry) => entry.specifier.startsWith("./"))).toEqual([]);
  });

  it("小说共享快照属于纯类型合同，写作模块不反向依赖仓库实现", async () => {
    for (const relativePath of [
      "src/core/novel-writing-source-import.ts",
      "src/core/novel-writing-state.ts",
    ]) {
      const imports = await moduleImports(relativePath);
      expect(imports.map((entry) => entry.specifier)).not.toContain("./novel-manuscript.js");
      expect(imports).toContainEqual({ specifier: "./novel-types.js", runtime: false });
    }
  });

  it("Active Studio 八个身份 owner 统一依赖同一 canonical JSON 内核", async () => {
    const owners = [
      "src/core/studio-generation.ts",
      "src/core/studio-unit-grid-generation.ts",
      "src/core/studio-generation-ledger.ts",
      "src/core/studio-generation-review.ts",
      "src/core/studio-generation-checkpoint.ts",
      "src/core/studio-post-result-observation.ts",
      "src/core/studio-production-dashboard.ts",
      "src/core/studio-video-package.ts",
    ];
    for (const relativePath of owners) {
      const imports = await moduleImports(relativePath);
      expect(imports).toContainEqual({ specifier: "./studio-canonical-json.js", runtime: true });
      expect(await readFile(path.join(process.cwd(), relativePath), "utf8")).not.toMatch(
        /function\s+(?:stableValue|stableDigest|digest)\s*\(/u,
      );
    }
  });

  it("continuity 只依赖 generation storage，不运行时依赖完整 business ledger", async () => {
    const imports = await moduleImports("src/core/studio-continuity-ledger.ts");
    expect(imports).toContainEqual({
      specifier: "./studio-generation-ledger-storage.js",
      runtime: true,
    });
    expect(imports).not.toContainEqual({
      specifier: "./studio-generation-ledger.js",
      runtime: true,
    });
  });

  it("generation storage 不运行时依赖三个 Active Studio business owner", async () => {
    const imports = await moduleImports("src/core/studio-generation-ledger-storage.ts");
    for (const specifier of [
      "./studio-generation.js",
      "./studio-unit-grid-generation.js",
      "./studio-continuity-ledger.js",
    ]) {
      expect(imports).not.toContainEqual({ specifier, runtime: true });
    }
  });

  it("旧 ledger 与纯 contract 共享同一 error class 构造器", async () => {
    const legacy = await import("../src/core/studio-generation-ledger.js");
    const contract = await import("../src/core/studio-generation-ledger-contract.js");
    expect(legacy.StudioGenerationLedgerError).toBe(contract.StudioGenerationLedgerError);
    expect(legacy.StudioGenerationResultConflictError).toBe(contract.StudioGenerationResultConflictError);
    const error = new legacy.StudioGenerationLedgerError("storage-invalid", "fixture");
    expect(error).toBeInstanceOf(contract.StudioGenerationLedgerError);
    expect(error).toBeInstanceOf(legacy.StudioGenerationLedgerError);
  });

  it("旧 ledger 与 storage 共享同一个 writable-open hook setter", async () => {
    const legacy = await import("../src/core/studio-generation-ledger.js");
    const storage = await import("../src/core/studio-generation-ledger-storage.js");
    expect(legacy.__setBeforeGenerationWritableOpenHookForTests)
      .toBe(storage.__setBeforeGenerationWritableOpenHookForTests);
  });
});
