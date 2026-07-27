/**
 * SSL-4 分镜向导：短剧本 suggest → 填动作 → 物化 demo unit
 * npx tsx scripts/s1e2-ssl4-storyboard-wizard.ts
 */
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { activateProject } from "../src/core/service.js";
import {
  appendStudioScriptRevision,
  createStudioScriptDocument,
  getStudioProductionUnitSnapshot,
} from "../src/core/studio-production.js";
import {
  applyWizardPanelEdits,
  materializeStudioStoryboardWizardUnit,
  openStudioStoryboardWizard,
  validateWizardForMaterialize,
} from "../src/core/studio-storyboard-wizard.js";

const ROOT = "/Users/hxx/Documents/无限画布/projects/dudu-gaiden-lock-20260723-12a6516c";
const OUT =
  "/Users/hxx/Documents/无限画布/productions/dudu-gaiden/s1e2-grok-canvas-loop-20260723/05_canvas";

async function main() {
  await activateProject(ROOT);

  // 短剧本（≤50k）供 P20 拆格；不手写 uNN-run 全链
  const body = [
    "洞口晨光落在石壁上。崽从窝里抬起头，耳朵轻轻一颤。",
    "母在一旁舔了舔他的额顶，没有说话。",
    "远处山风穿过绝谷，金纹像余烬一样暗了一下。",
    "父站在洞口外侧，背影沉稳，没有回头。",
  ].join("");

  const doc = await createStudioScriptDocument(ROOT, {
    title: "SSL4-Wizard-Demo-S1E2-snippet",
    expectedRevision: 0,
  });
  const rev = await appendStudioScriptRevision(ROOT, {
    documentId: doc.id,
    expectedRevision: 0,
    body,
    source: "ssl4-wizard-demo",
    sourceVersion: "20260724",
  });

  const session = await openStudioStoryboardWizard(ROOT, {
    scriptRevisionId: rev.revision.id,
    panelCount: 4,
  });

  const edited = applyWizardPanelEdits(session.panels, [
    { panelIndex: 1, title: "G1 晨光", visualAction: "洞口晨光落石壁", shotComposition: "远景", filmingMethod: "缓推" },
    { panelIndex: 2, title: "G2 抬头", visualAction: "崽抬头耳颤", shotComposition: "近景", filmingMethod: "呼吸感固定" },
    { panelIndex: 3, title: "G3 舔额", visualAction: "母舔崽额无言", shotComposition: "中景", filmingMethod: "微推" },
    { panelIndex: 4, title: "G4 父影", visualAction: "父洞口背影", shotComposition: "中远景", filmingMethod: "缓拉" },
  ]);
  // 对齐时长若建议格不足 4
  while (edited.length < 4 && session.panels.length > edited.length) {
    /* keep as suggested count */
  }
  const panels = edited.slice(0, session.panels.length);
  // 若建议只有 2–3 格，补齐时长到 15
  const sum = panels.reduce((s, p) => s + p.durationSeconds, 0);
  if (Math.abs(sum - 15) > 0.05 && panels.length > 0) {
    const each = 15 / panels.length;
    for (let i = 0; i < panels.length; i++) {
      panels[i] = {
        ...panels[i]!,
        startSeconds: Number((each * i).toFixed(1)),
        durationSeconds: Number(each.toFixed(1)),
        endSeconds: Number((each * (i + 1)).toFixed(1)),
      };
    }
    // fix float drift on last
    const last = panels[panels.length - 1]!;
    const used = panels.slice(0, -1).reduce((s, p) => s + p.durationSeconds, 0);
    panels[panels.length - 1] = {
      ...last,
      durationSeconds: Number((15 - used).toFixed(1)),
      endSeconds: 15,
      startSeconds: Number(used.toFixed(1)),
    };
  }

  const valErrs = validateWizardForMaterialize(panels);
  if (valErrs.length) throw new Error(valErrs.join("; "));

  const unitId = `S1E2-WIZARD-DEMO-${Date.now().toString(36)}`;
  const materialized = await materializeStudioStoryboardWizardUnit(ROOT, {
    season: "S1",
    episode: "S1E2",
    sequence: 9001,
    unitId,
    unitTitle: "SSL4 向导演示单元",
    scriptRevisionId: rev.revision.id,
    panels,
  });

  const snap = await getStudioProductionUnitSnapshot(ROOT, materialized.unitId);
  mkdirSync(OUT, { recursive: true });
  const sessionPath = path.join(OUT, "ssl4-wizard-session-20260724.json");
  writeFileSync(
    sessionPath,
    JSON.stringify({ ...session, panels: panels.map((p) => ({ ...p, sourceSpans: p.sourceSpans })) }, null, 2),
  );
  const report = {
    ok: true,
    claim: "从短剧本文档到可冻结 15s 单元，不靠手写 uNN-run 脚本",
    sessionPath,
    scriptRevisionId: rev.revision.id,
    suggestionPanelCount: session.suggestion.panelCount,
    suggestionFingerprint: session.suggestion.fingerprint,
    materialize: materialized,
    unitSnapshot: snap
      ? {
          unitId: snap.unit.id,
          panelCount: snap.panels.length,
          durationSeconds: snap.unit.durationSeconds,
          sequence: snap.unit.sequence,
          scriptRevisionId: snap.scriptRevision?.id,
        }
      : null,
    nextAfterMaterialize: ["binding", "readiness", "freeze", "dispatch", "gen", "commit"],
    builtAt: new Date().toISOString(),
  };
  writeFileSync(path.join(OUT, "ssl4-wizard-report-20260724.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
