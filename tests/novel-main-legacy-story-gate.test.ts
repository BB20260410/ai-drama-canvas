import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import { createManagedProject, inspectManagedProjectReadOnly } from "../src/core/managed-project.js";

const workspace = process.cwd();
const roots: string[] = [];

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

interface GateIdentity {
  managed: boolean;
  schemaVersion?: number;
  workspaceMode?: string;
}

type Gate = (projectRoot: string, identity: GateIdentity) => string;
type ReadGate = (projectRoot: string, registeredRoots: readonly string[]) => string;

async function mainSource(): Promise<string> {
  return readFile(path.join(workspace, "src/main/index.ts"), "utf8");
}

function executableWorkspaceGate(source: string): Gate {
  const startMarker = "// LEGACY_STORY_MUTATION_WORKSPACE_GATE_START";
  const endMarker = "// LEGACY_STORY_MUTATION_WORKSPACE_GATE_END";
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const snippet = source.slice(start + startMarker.length, end);
  const compiled = ts.transpileModule(snippet, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports: Record<string, unknown> = {};
  const evaluate = new Function("exports", "path", compiled) as (exportsValue: Record<string, unknown>, pathValue: typeof path) => void;
  evaluate(exports, path);
  const gate = exports.assertLegacyStoryMutationWorkspaceAllowed;
  expect(gate).toBeTypeOf("function");
  return gate as Gate;
}

function executableReadRootGate(source: string): ReadGate {
  const startMarker = "// LEGACY_STORY_READ_ROOT_GATE_START";
  const endMarker = "// LEGACY_STORY_READ_ROOT_GATE_END";
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const snippet = source.slice(start + startMarker.length, end);
  const compiled = ts.transpileModule(snippet, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports: Record<string, unknown> = {};
  const evaluate = new Function("exports", "path", compiled) as (exportsValue: Record<string, unknown>, pathValue: typeof path) => void;
  evaluate(exports, path);
  const gate = exports.assertLegacyStoryRootRegistered;
  expect(gate).toBeTypeOf("function");
  return gate as ReadGate;
}

function handlerSlice(source: string, channel: string): string {
  const start = source.indexOf(`ipcMain.handle("${channel}"`);
  expect(start, `缺少 IPC handler：${channel}`).toBeGreaterThanOrEqual(0);
  const next = source.indexOf("ipcMain.handle(\"canvas:", start + 20);
  return source.slice(start, next < 0 ? source.length : next);
}

async function treeSnapshot(root: string): Promise<Array<{ path: string; type: string; size?: number; sha256?: string }>> {
  const output: Array<{ path: string; type: string; size?: number; sha256?: string }> = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, "en"))) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      const metadata = await lstat(absolute);
      if (metadata.isDirectory()) {
        output.push({ path: relative, type: "directory" });
        await visit(absolute);
      } else if (metadata.isFile()) {
        const bytes = await readFile(absolute);
        output.push({
          path: relative,
          type: "file",
          size: bytes.byteLength,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        });
      } else {
        output.push({ path: relative, type: metadata.isSymbolicLink() ? "symlink" : "special" });
      }
    }
  };
  await visit(root);
  return output;
}

describe("Main legacy Story/Adaptation 写入口门禁", () => {
  it("只读根门必须精确匹配登记工程，不接受未登记根、父根或子目录", async () => {
    const gate = executableReadRootGate(await mainSource());
    const registered = path.resolve(os.tmpdir(), "registered-story-project");
    expect(gate(registered, [registered])).toBe(registered);
    expect(() => gate(path.join(registered, "child"), [registered])).toThrow("精确匹配");
    expect(() => gate(path.dirname(registered), [registered])).toThrow("精确匹配");
    expect(() => gate(path.resolve(os.tmpdir(), "unregistered-story-project"), [registered])).toThrow("精确匹配");
    expect(() => gate("relative/story-project", [registered])).toThrow("绝对工程根");
  });

  it("真实 v2 novel/hybrid 身份在只读检查后拒绝且全树零写，schema v1 drama/legacy 保持允许", async () => {
    const source = await mainSource();
    const gate = executableWorkspaceGate(source);
    const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "novel-main-story-gate-")));
    roots.push(parent);
    const novel = await createManagedProject({ parentRoot: parent, name: "Main Novel Gate", workspaceMode: "novel" });
    const hybrid = await createManagedProject({ parentRoot: parent, name: "Main Hybrid Gate", workspaceMode: "hybrid" });
    const drama = await createManagedProject({ parentRoot: parent, name: "Main Drama Gate", workspaceMode: "drama" });

    for (const shell of [novel, hybrid]) {
      const before = await treeSnapshot(shell.paths.root);
      const inspected = await inspectManagedProjectReadOnly(shell.paths.root);
      expect(() => gate(shell.paths.root, {
        managed: true,
        schemaVersion: inspected.manifest.schemaVersion,
        workspaceMode: inspected.workspaceMode,
      })).toThrow("schema v2 novel/hybrid");
      expect(await treeSnapshot(shell.paths.root)).toEqual(before);
    }

    const dramaBefore = await treeSnapshot(drama.paths.root);
    const inspectedDrama = await inspectManagedProjectReadOnly(drama.paths.root);
    expect(gate(drama.paths.root, {
      managed: true,
      schemaVersion: inspectedDrama.manifest.schemaVersion,
      workspaceMode: inspectedDrama.workspaceMode,
    })).toBe(drama.paths.root);
    expect(gate(drama.paths.root, { managed: false })).toBe(drama.paths.root);
    expect(await treeSnapshot(drama.paths.root)).toEqual(dramaBefore);
    expect(() => gate("relative/project", { managed: false })).toThrow("绝对工程根");
  });

  it("统一 allowlist 中每个直连写 handler 都先经过同一门，已知只读 handler 不被误列", async () => {
    const source = await mainSource();
    const mutations = [
      ["canvas:import-story-file", "importStoryFile"],
      ["canvas:import-story-text", "importStoryText"],
      ["canvas:upsert-story-event", "upsertStoryEvent"],
      ["canvas:connect-story-events", "connectStoryEvents"],
      ["canvas:analyze-novel-chapters", "analyzeNovelChapters"],
      ["canvas:generate-adaptation-plans", "generateAdaptationPlans"],
      ["canvas:select-adaptation-plan", "selectAdaptationPlan"],
      ["canvas:materialize-adaptation-plan", "materializeSelectedAdaptationPlan"],
      ["canvas:regenerate-adaptation-scope", "regenerateAdaptationScope"],
      ["canvas:upsert-novel-fact", "upsertNovelFact"],
      ["canvas:upsert-narrative-beat", "upsertNarrativeBeat"],
      ["canvas:export-adaptation", "exportAdaptation"],
    ] as const;
    const allowlistStart = source.indexOf("export const LEGACY_STORY_MUTATION_IPC_CHANNELS");
    const allowlistEnd = source.indexOf("] as const;", allowlistStart);
    expect(allowlistStart).toBeGreaterThanOrEqual(0);
    const allowlist = source.slice(allowlistStart, allowlistEnd);
    for (const [channel, callee] of mutations) {
      expect(allowlist).toContain(`"${channel}"`);
      const handler = handlerSlice(source, channel);
      const gateAt = handler.indexOf("await requireLegacyStoryMutationProjectRoot(projectRoot)");
      const callAt = handler.indexOf(`${callee}(`);
      expect(gateAt, `${channel} 未调用统一门`).toBeGreaterThanOrEqual(0);
      expect(callAt, `${channel} 未调用 ${callee}`).toBeGreaterThanOrEqual(0);
      expect(gateAt, `${channel} 必须先门禁再进入 Core`).toBeGreaterThan(callAt);
    }
    expect((allowlist.match(/"canvas:/gu) ?? [])).toHaveLength(mutations.length);

    for (const channel of [
      "canvas:list-story-sources",
      "canvas:list-story-chapters",
      "canvas:read-story-chapter",
      "canvas:list-story-events",
      "canvas:build-story-context",
      "canvas:get-adaptation-workspace",
      "canvas:analyze-adaptation-impact",
      "canvas:validate-adaptation-plan",
    ]) {
      expect(allowlist).not.toContain(`"${channel}"`);
      expect(handlerSlice(source, channel)).not.toContain("requireLegacyStoryMutationProjectRoot");
    }
  });

  it("统一项目根 helper 先做绝对根/realpath 基础门，再只读识别受管 schema", async () => {
    const source = await mainSource();
    const start = source.indexOf("async function requireLegacyStoryMutationProjectRoot");
    const end = source.indexOf('ipcMain.handle("canvas:get-index"', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const helper = source.slice(start, end);
    const baseAt = helper.indexOf("await requireLegacyProjectRoot(candidate)");
    const managedAt = helper.indexOf("await isManagedProject(root)");
    const inspectAt = helper.indexOf("await inspectManagedProjectReadOnly(root)");
    const decisionAt = helper.lastIndexOf("assertLegacyStoryMutationWorkspaceAllowed");
    expect(baseAt).toBeGreaterThanOrEqual(0);
    expect(managedAt).toBeGreaterThan(baseAt);
    expect(inspectAt).toBeGreaterThan(managedAt);
    expect(decisionAt).toBeGreaterThan(inspectAt);
    expect(helper).not.toMatch(/\b(?:mkdir|writeFile|writeJsonAtomic|registerProject|getManagedProjectShell)\s*\(/u);
  });

  it("五个 legacy Story 只读 handler 都在 Core 前经过登记根与受管 manifest 检查", async () => {
    const source = await mainSource();
    const reads = [
      ["canvas:list-story-sources", "listStorySources"],
      ["canvas:list-story-chapters", "listStoryChapters"],
      ["canvas:read-story-chapter", "readStoryChapter"],
      ["canvas:list-story-events", "listStoryEvents"],
      ["canvas:build-story-context", "buildStoryContext"],
    ] as const;
    for (const [channel, callee] of reads) {
      const handler = handlerSlice(source, channel);
      const callAt = handler.indexOf(`${callee}(`);
      const gateAt = handler.indexOf("await requireLegacyStoryReadProjectRoot(projectRoot)");
      expect(callAt, `${channel} 未调用 ${callee}`).toBeGreaterThanOrEqual(0);
      expect(gateAt, `${channel} 未调用只读登记根门`).toBeGreaterThan(callAt);
      expect(handler).not.toContain(`${callee}(projectRoot`);
    }

    const helperStart = source.indexOf("async function requireLegacyStoryReadProjectRoot");
    const helperEnd = source.indexOf('ipcMain.handle("canvas:get-index"', helperStart);
    const helper = source.slice(helperStart, helperEnd);
    expect(helper.indexOf("await requireLegacyProjectRoot(candidate)")).toBeGreaterThanOrEqual(0);
    expect(helper.indexOf("registeredLegacyStoryRoots()")).toBeGreaterThanOrEqual(0);
    expect(helper.indexOf("assertLegacyStoryRootRegistered(root, registeredRoots)")).toBeGreaterThanOrEqual(0);
    expect(helper.indexOf("await inspectManagedProjectReadOnly(root)")).toBeGreaterThanOrEqual(0);
    expect(helper).not.toMatch(/\b(?:mkdir|writeFile|writeJsonAtomic|registerProject|getManagedProjectShell)\s*\(/u);
  });
});
