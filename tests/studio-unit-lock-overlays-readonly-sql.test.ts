/**
 * 当前单元锁版光线/服化：Linux 手工 sqlite 只读旁路。
 * 不调用 createManagedProject / P7 fixture（需 Darwin dirfd）。
 * 不改 dashboard 投影。不是 BindingSet，不是安装版 T23，不是 GUI 探针。
 */
import { existsSync, readFileSync, symlinkSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  readStudioUnitLockOverlays,
  UNIT_LOCK_OVERLAY_PANEL_LIMIT,
} from "../src/core/studio-unit-lock-overlays-read.js";
import {
  formatUnitLockPanelCostumeLine,
  formatUnitLockPanelLightingLine,
  formatUnitLockPanelShotTypeLine,
} from "../src/core/studio-panel-standing.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = (relative: string) => readFileSync(path.join(repoRoot, relative), "utf8");

const tempRoots: string[] = [];

afterEach(async () => {
  const roots = tempRoots.splice(0);
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function seedLockOverlayDatabase(options?: {
  omitLightingColumns?: boolean;
  extraPanels?: number;
  withShotTypeColumn?: boolean;
}): Promise<string> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "unit-lock-overlays-"));
  tempRoots.push(tempRoot);
  const sidecar = path.join(tempRoot, ".aicanvas");
  await mkdir(sidecar, { recursive: true });
  const databasePath = path.join(sidecar, "studio-production.sqlite");
  const db = new DatabaseSync(databasePath);
  try {
    const lightingColumns = options?.omitLightingColumns
      ? ""
      : `, scene_lighting TEXT NOT NULL DEFAULT '', costume_state TEXT NOT NULL DEFAULT ''${
        options?.withShotTypeColumn ? ", shot_type TEXT NOT NULL DEFAULT ''" : ""
      }`;
    db.exec(`
      CREATE TABLE studio_production_units (
        id TEXT PRIMARY KEY,
        season TEXT NOT NULL,
        episode TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        title TEXT NOT NULL,
        revision INTEGER NOT NULL,
        panel_count INTEGER NOT NULL
      );
      CREATE TABLE studio_production_panels (
        unit_id TEXT NOT NULL,
        unit_revision INTEGER NOT NULL,
        panel_index INTEGER NOT NULL,
        panel_id TEXT NOT NULL
        ${lightingColumns}
      );
    `);
    db.prepare(`
      INSERT INTO studio_production_units(id, season, episode, sequence, title, revision, panel_count)
      VALUES('u1', 'S1', 'S1E1', 1, '单元一', 2, 2)
    `).run();
    if (options?.omitLightingColumns) {
      db.prepare(`
        INSERT INTO studio_production_panels(unit_id, unit_revision, panel_index, panel_id)
        VALUES('u1', 2, 1, 'p1')
      `).run();
    } else {
      const insertPanel = db.prepare(`
        INSERT INTO studio_production_panels(
          unit_id, unit_revision, panel_index, panel_id, scene_lighting, costume_state${
            options?.withShotTypeColumn ? ", shot_type" : ""
          }
        ) VALUES(?, ?, ?, ?, ?, ?${options?.withShotTypeColumn ? ", ?" : ""})
      `);
      if (options?.withShotTypeColumn) {
        insertPanel.run("u1", 1, 1, "p-stale", "旧修订火光", "旧修订祭服", "original");
        insertPanel.run("u1", 2, 1, "p1", "室内火光", "深灰祭服", "original");
        insertPanel.run("u1", 2, 2, "p2", "", "青布短打", "extension");
      } else {
        insertPanel.run("u1", 1, 1, "p-stale", "旧修订火光", "旧修订祭服");
        insertPanel.run("u1", 2, 1, "p1", "室内火光", "深灰祭服");
        insertPanel.run("u1", 2, 2, "p2", "", "青布短打");
      }
      const extra = options?.extraPanels ?? 0;
      for (let index = 3; index < 3 + extra; index += 1) {
        if (options?.withShotTypeColumn) {
          insertPanel.run("u1", 2, index, `p${index}`, `光${index}`, `服${index}`, "original");
        } else {
          insertPanel.run("u1", 2, index, `p${index}`, `光${index}`, `服${index}`);
        }
      }
    }
  } finally {
    db.close();
  }
  return tempRoot;
}

describe("当前单元锁版光线/服化只读 SQL", () => {
  it("只认当前 revision 的本格覆盖，空字段仍占位但不格式化", async () => {
    const root = await seedLockOverlayDatabase();
    const result = readStudioUnitLockOverlays(root, { unitId: "u1", unitRevision: 2 });
    expect(result.overlays).toEqual([
      { panelId: "p1", panelIndex: 1, sceneLighting: "室内火光", costumeState: "深灰祭服", shotType: "" },
      { panelId: "p2", panelIndex: 2, sceneLighting: "", costumeState: "青布短打", shotType: "" },
    ]);
    expect(formatUnitLockPanelShotTypeLine(result.overlays[0])).toBeNull();
    expect(result.overlays.some((row) => row.panelId === "p-stale")).toBe(false);
    expect(formatUnitLockPanelLightingLine(result.overlays[0])).toContain("锁版光线：G1 室内火光");
    expect(formatUnitLockPanelCostumeLine(result.overlays[0])).toContain("锁版服装：G1 深灰祭服");
    expect(formatUnitLockPanelLightingLine(result.overlays[1])).toBeNull();
    expect(formatUnitLockPanelCostumeLine(result.overlays[1])).toContain("G2 青布短打");
    expect(formatUnitLockPanelLightingLine(null)).toBeNull();
    expect(formatUnitLockPanelLightingLine({ panelIndex: 2, sceneLighting: "  " })).toBeNull();
  });

  it("修订对不上 / 缺库 / 缺列 / 非法查询失败关闭为空，符号链接拒绝", async () => {
    const root = await seedLockOverlayDatabase();
    expect(readStudioUnitLockOverlays(root, { unitId: "u1", unitRevision: 1 }).overlays).toEqual([]);
    expect(readStudioUnitLockOverlays(root, { unitId: "missing", unitRevision: 2 }).overlays).toEqual([]);
    expect(readStudioUnitLockOverlays(root, { unitId: "", unitRevision: 2 }).overlays).toEqual([]);
    expect(readStudioUnitLockOverlays(root, { unitId: "u1", unitRevision: 0 }).overlays).toEqual([]);
    const missingRoot = await mkdtemp(path.join(os.tmpdir(), "unit-lock-overlays-missing-"));
    try {
      expect(readStudioUnitLockOverlays(missingRoot, { unitId: "u1", unitRevision: 2 }).overlays).toEqual([]);
    } finally {
      await rm(missingRoot, { recursive: true, force: true });
    }
    const noColumnRoot = await seedLockOverlayDatabase({ omitLightingColumns: true });
    expect(readStudioUnitLockOverlays(noColumnRoot, { unitId: "u1", unitRevision: 2 }).overlays).toEqual([]);
    const missingShotType = await seedLockOverlayDatabase();
    expect(readStudioUnitLockOverlays(missingShotType, { unitId: "u1", unitRevision: 2 }).overlays).toEqual([
      { panelId: "p1", panelIndex: 1, sceneLighting: "室内火光", costumeState: "深灰祭服", shotType: "" },
      { panelId: "p2", panelIndex: 2, sceneLighting: "", costumeState: "青布短打", shotType: "" },
    ]);
    const linkRoot = await mkdtemp(path.join(os.tmpdir(), "unit-lock-overlays-link-"));
    try {
      const sidecar = path.join(linkRoot, ".aicanvas");
      await mkdir(sidecar, { recursive: true });
      const target = path.join(sidecar, "target.sqlite");
      await writeFile(target, "not-a-db");
      symlinkSync(target, path.join(sidecar, "studio-production.sqlite"));
      expect(() => readStudioUnitLockOverlays(linkRoot, { unitId: "u1", unitRevision: 2 })).toThrow(/普通文件/);
    } finally {
      await rm(linkRoot, { recursive: true, force: true });
    }
  });

  it("最多 6 格，不扫 snapshot / 不改 dashboard / renderer 不拉 sqlite", () => {
    expect(UNIT_LOCK_OVERLAY_PANEL_LIMIT).toBe(6);
    const reader = source("src/core/studio-unit-lock-overlays-read.ts");
    expect(reader).toContain("readOnly: true");
    expect(reader).toContain("PRAGMA query_only = ON");
    expect(reader).not.toContain("ensureProductionDirectories");
    expect(reader).not.toContain("getStudioProductionUnitSnapshot");
    expect(reader).not.toContain("getStudioBindingControl");
    expect(reader).not.toContain("evaluateStudioConsistency");
    expect(reader).not.toContain("studio-production-dashboard");
    const dash = source("src/core/studio-production-dashboard.ts");
    const panelSummary = dash.slice(
      dash.indexOf("export interface StudioDashboardPanelSummary"),
      dash.indexOf("export interface StudioDashboardUnitDetail"),
    );
    expect(panelSummary).not.toContain("sceneLighting");
    expect(panelSummary).not.toContain("costumeState");
    const canvas = source("src/renderer/src/components/ManagedStudioCanvasView.vue");
    expect(canvas).not.toContain("studio-unit-lock-overlays-read");
    expect(canvas).not.toContain("studio-scene-backrefs-read");
    expect(canvas).toContain("getStudioUnitLockOverlays");
    expect(canvas).toContain("formatUnitLockPanelLightingLine");
    expect(canvas).toContain("formatUnitLockPanelCostumeLine");
    expect(canvas).toContain("formatUnitLockPanelShotTypeLine");
    expect(reader).toContain('REQUIRED_PANEL_COLUMNS = ["panel_id", "panel_index", "scene_lighting", "costume_state"]');
    expect(reader).not.toContain('REQUIRED_PANEL_COLUMNS = ["panel_id", "panel_index", "scene_lighting", "costume_state", "shot_type"]');
    expect(canvas).toContain('inspectorLightingCostumeSource.value = "unit-lock"');
    expect(canvas).toContain('inspectorLightingCostumeSource.value = "frozen-rendered-prompt"');
    expect(canvas).not.toContain("evaluateStudioConsistency(");
    expect(canvas).not.toContain("getStudioBindingControl");
    const inspectorWatch = canvas.slice(
      canvas.indexOf("watch([selection, unitDetail, () => props.projectRoot]"),
      canvas.indexOf("const appearanceListElement"),
    );
    expect(inspectorWatch).toContain("readInspectorLockOverlays");
    expect(inspectorWatch).not.toContain("getStudioProductionUnit(");
    expect(inspectorWatch).not.toContain("getStudioProductionUnitSnapshot");
    expect(canvas).toContain("window.canvasApi.getStudioUnitLockOverlays");
    const inspector = source("src/renderer/src/components/CanvasInspectorPanel.vue");
    expect(inspector).toContain("panelLightingCostumeSource");
    expect(inspector).toContain("managed-canvas-inspector-shot-type");
    expect(inspector).toContain("锁版未记光线");
    expect(inspector).toContain("当前单元锁版。不是 BindingSet，不能当 generation-ready。");
    expect(existsSync(path.join(repoRoot, "src/core/studio-unit-lock-overlays-read.ts"))).toBe(true);
    const main = source("src/main/index.ts");
    const handlerStart = main.indexOf("canvas:get-studio-unit-lock-overlays");
    expect(handlerStart).toBeGreaterThan(-1);
    const handler = main.slice(handlerStart, handlerStart + 700);
    expect(handler).toContain("requireManagedStudioProjectReadOnly(projectRoot)");
    expect(handler).toContain("readStudioUnitLockOverlays");
    expect(handler).not.toContain("getStudioProductionUnitSnapshot");
    const preload = source("src/preload/index.ts");
    expect(preload).toContain('invoke("canvas:get-studio-unit-lock-overlays", projectRoot, query)');
  });

  it("有可选 shot_type 列时可读扩写格，缺列不让光线/服化失败关闭", async () => {
    const withColumn = await seedLockOverlayDatabase({ withShotTypeColumn: true });
    const result = readStudioUnitLockOverlays(withColumn, { unitId: "u1", unitRevision: 2 });
    expect(result.overlays).toEqual([
      { panelId: "p1", panelIndex: 1, sceneLighting: "室内火光", costumeState: "深灰祭服", shotType: "original" },
      { panelId: "p2", panelIndex: 2, sceneLighting: "", costumeState: "青布短打", shotType: "extension" },
    ]);
    expect(formatUnitLockPanelShotTypeLine(result.overlays[0])).toContain("锁版原镜：G1");
    expect(formatUnitLockPanelShotTypeLine(result.overlays[1])).toContain("锁版扩写格：G2");
    expect(formatUnitLockPanelShotTypeLine(result.overlays[1])).toContain("禁止锚定原文");
    expect(formatUnitLockPanelLightingLine(result.overlays[0])).toContain("锁版光线：G1 室内火光");
  });

  it("上限截断到 6 格，不读更后宫格", async () => {
    const root = await seedLockOverlayDatabase({ extraPanels: 6 });
    const result = readStudioUnitLockOverlays(root, { unitId: "u1", unitRevision: 2 });
    expect(result.overlays).toHaveLength(6);
    expect(result.overlays.at(-1)?.panelId).toBe("p6");
    expect(result.overlays.some((row) => row.panelId === "p7")).toBe(false);
  });
});
