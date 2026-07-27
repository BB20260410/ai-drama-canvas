import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  executeIdempotentCommand,
  type StudioCommandRequest,
} from "../src/core/command-bus.js";
import { getStudioBindingControl } from "../src/core/studio-binding-control.js";
import { createManagedProject } from "../src/core/managed-project.js";
import {
  getStudioProductionUnitSnapshot,
  getStudioTextRevision,
  initializeStudioProduction,
} from "../src/core/studio-production.js";
import {
  applyWizardPanelEdits,
  openStudioStoryboardWizard,
  validateWizardForMaterialize,
} from "../src/core/studio-storyboard-wizard.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function envelope(index: number, request: StudioCommandRequest) {
  const suffix = String(index).padStart(4, "0");
  return {
    requestId: `p6-wizard-command-request-${suffix}`,
    idempotencyKey: `p6-wizard-command-key-${suffix}`,
    request,
  };
}

async function run(
  root: string,
  index: number,
  request: StudioCommandRequest,
): Promise<Record<string, any>> {
  const record = await executeIdempotentCommand(root, envelope(index, request));
  expect(record.status).toBe("succeeded");
  return record.result as Record<string, any>;
}

describe("P6 storyboard wizard public command flow", () => {
  it("anchors a selected span, materializes through the command bus, and stops at Binding", async () => {
    const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "p6-wizard-command-flow-")));
    roots.push(parent);
    const root = (await createManagedProject({ parentRoot: parent, name: "P6 分镜向导" })).paths.root;
    await initializeStudioProduction(root);

    const script = await run(root, 1, {
      command: "create_studio_script_document",
      payload: { id: "script-p6-wizard-flow", title: "P6 向导剧本", expectedRevision: 0 },
    });
    const prefix = "前文不选。";
    const selected = "阿航推门进入石室。守门人突然回头。两人在金光中对峙。";
    const scriptRevision = await run(root, 2, {
      command: "append_studio_script_revision",
      payload: {
        documentId: script.id,
        expectedRevision: 0,
        body: `${prefix}${selected}后文不选。`,
        source: "p6-command-flow",
        sourceVersion: "1",
      },
    });
    const sourceRange = {
      startOffsetUtf16: prefix.length,
      endOffsetUtf16: prefix.length + selected.length,
    };
    const wizard = await openStudioStoryboardWizard(root, {
      scriptRevisionId: scriptRevision.revision.id,
      panelCount: 3,
      sourceRange,
    });
    const panels = applyWizardPanelEdits(wizard.panels, wizard.panels.map((panel) => ({
      panelIndex: panel.panelIndex,
      visualAction: `画面动作 G${panel.panelIndex}`,
      shotComposition: panel.panelIndex === 3 ? "近景" : "中景",
      filmingMethod: panel.panelIndex === 2 ? "缓慢推近" : "呼吸感固定",
    })));
    expect(validateWizardForMaterialize(panels)).toEqual([]);

    const prompt = await run(root, 3, {
      command: "create_studio_prompt_document",
      payload: {
        id: "prompt-p6-wizard-flow",
        title: "P6 向导提示词",
        expectedRevision: 0,
      },
    });
    const promptBody = panels.map((panel) =>
      `G${panel.panelIndex} ${panel.startSeconds}-${panel.endSeconds}s ${panel.visualAction}`,
    ).join("\n");
    const promptRevision = await run(root, 4, {
      command: "append_studio_prompt_revision",
      payload: {
        documentId: prompt.id,
        expectedRevision: 0,
        body: promptBody,
        source: "studio-storyboard-wizard-ui",
        sourceVersion: wizard.suggestion.fingerprint,
      },
    });
    const unitRequest: StudioCommandRequest = {
      command: "create_studio_production_unit",
      payload: {
        id: "unit-p6-wizard-flow",
        expectedRevision: 0,
        season: "S1",
        episode: "EP01",
        sequence: 1,
        title: "选区 15 秒单元",
        durationSeconds: 15,
        scriptRevisionId: scriptRevision.revision.id,
        panels: panels.map((panel) => ({
          title: panel.title,
          visualAction: panel.visualAction,
          shotComposition: panel.shotComposition,
          filmingMethod: panel.filmingMethod,
          startSeconds: panel.startSeconds,
          endSeconds: panel.endSeconds,
          durationSeconds: panel.durationSeconds,
          promptRevisionId: promptRevision.revision.id,
          sourceSpans: panel.sourceSpans,
          assets: [],
          shotType: panel.shotType,
        })),
      },
    };
    const unit = await run(root, 5, unitRequest);
    const replay = await executeIdempotentCommand(root, envelope(5, unitRequest));
    expect(replay.status).toBe("succeeded");
    expect((replay.result as Record<string, any>).unit.id).toBe(unit.unit.id);

    const snapshot = await getStudioProductionUnitSnapshot(root, unit.unit.id);
    expect(snapshot?.panels).toHaveLength(3);
    expect(snapshot?.panels.flatMap((panel) => panel.sourceSpans).every((span) =>
      span.startOffsetUtf16 >= sourceRange.startOffsetUtf16
      && span.endOffsetUtf16 <= sourceRange.endOffsetUtf16
    )).toBe(true);
    expect(snapshot?.panels.every((panel) => panel.promptRevisionId === promptRevision.revision.id)).toBe(true);
    expect((await getStudioTextRevision(root, promptRevision.revision.id))?.body).toBe(promptBody);

    const binding = await getStudioBindingControl(root, { unitId: unit.unit.id });
    expect(binding.panels).toHaveLength(3);
    expect(binding.panels.every((panel) => panel.status !== "generation-ready")).toBe(true);
    expect(binding.nextAction).toMatch(/分析|绑定|检查|实体/u);
  });
});
