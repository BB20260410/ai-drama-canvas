import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyWizardPanelEdits,
  openStudioStoryboardWizard,
  toWizardEditablePanels,
  validateWizardForMaterialize,
  STORYBOARD_WIZARD_SCHEMA_VERSION,
  type WizardEditablePanel,
} from "../src/core/studio-storyboard-wizard.js";
import type { StudioStoryboardDraftPanelSuggestion } from "../src/core/studio-storyboard-draft.js";
import {
  appendStudioScriptRevision,
  createStudioScriptDocument,
  initializeStudioProduction,
} from "../src/core/studio-production.js";
import { createManagedProject } from "../src/core/managed-project.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function basePanel(index: number, overrides: Partial<StudioStoryboardDraftPanelSuggestion> = {}): StudioStoryboardDraftPanelSuggestion {
  return {
    panelIndex: index,
    shotType: "original",
    startSeconds: (index - 1) * 5,
    endSeconds: index * 5,
    durationSeconds: 5,
    sourceSpans: [{ startOffsetUtf16: 0, endOffsetUtf16: 4 }],
    suggestedAssetIds: [],
    unresolvedProposals: [],
    ...overrides,
  };
}

describe("studio-storyboard-wizard", () => {
  it("toWizardEditablePanels seeds editable fields", () => {
    const panels = toWizardEditablePanels([basePanel(1), basePanel(2), basePanel(3)]);
    expect(panels).toHaveLength(3);
    expect(panels[0]?.title).toBe("G1");
    expect(panels[0]?.visualAction).toBe("");
  });

  it("applyWizardPanelEdits merges by panelIndex", () => {
    const panels = toWizardEditablePanels([basePanel(1), basePanel(2)]);
    const next = applyWizardPanelEdits(panels, [{ panelIndex: 2, visualAction: "推近", title: "近景格" }]);
    expect(next[0]?.visualAction).toBe("");
    expect(next[1]?.visualAction).toBe("推近");
    expect(next[1]?.title).toBe("近景格");
  });

  it("validateWizardForMaterialize enforces 15s and visualAction", () => {
    const panels = toWizardEditablePanels([basePanel(1), basePanel(2), basePanel(3)]) as WizardEditablePanel[];
    expect(validateWizardForMaterialize(panels).some((e) => e.includes("visualAction"))).toBe(true);
    const filled = applyWizardPanelEdits(panels, [
      { panelIndex: 1, visualAction: "a" },
      { panelIndex: 2, visualAction: "b" },
      { panelIndex: 3, visualAction: "c" },
    ]);
    expect(validateWizardForMaterialize(filled)).toEqual([]);
  });

  it("schema frozen", () => {
    expect(STORYBOARD_WIZARD_SCHEMA_VERSION).toBe(1);
  });

  it("keeps a selected span anchored to the original revision offsets", async () => {
    const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "storyboard-wizard-source-range-")));
    roots.push(parent);
    const projectRoot = (await createManagedProject({ parentRoot: parent, name: "选区向导" })).paths.root;
    await initializeStudioProduction(projectRoot);
    const doc = await createStudioScriptDocument(projectRoot, {
      id: "script-wizard-range",
      title: "选区剧本",
      expectedRevision: 0,
    });
    const prefix = "不在选区。";
    const selected = "第一句动作。第二句反应。第三句收束。";
    const revision = await appendStudioScriptRevision(projectRoot, {
      documentId: doc.id,
      expectedRevision: 0,
      body: `${prefix}${selected}选区之外。`,
      source: "test",
      sourceVersion: "1",
    });
    const startOffsetUtf16 = prefix.length;
    const endOffsetUtf16 = prefix.length + selected.length;
    const session = await openStudioStoryboardWizard(projectRoot, {
      scriptRevisionId: revision.revision.id,
      panelCount: 3,
      sourceRange: { startOffsetUtf16, endOffsetUtf16 },
    });
    expect(session.sourceRange).toEqual({ startOffsetUtf16, endOffsetUtf16 });
    expect(session.panels).toHaveLength(3);
    expect(session.panels.flatMap((panel) => panel.sourceSpans).every((span) =>
      span.startOffsetUtf16 >= startOffsetUtf16 && span.endOffsetUtf16 <= endOffsetUtf16
    )).toBe(true);
    expect(session.panels[0]?.sourceSpans[0]?.startOffsetUtf16).toBe(startOffsetUtf16);
  });
});
