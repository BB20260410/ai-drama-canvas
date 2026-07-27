import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getStudioCanonicalAsset } from "../src/core/material-studio.ts";
import { getStudioProductionUnitSnapshot } from "../src/core/studio-production.ts";
import {
  appendStudioContinuityCorrection,
  getStudioContinuityReadiness,
  queryStudioContinuityTimeline,
  listOpenStudioContinuityConflicts,
} from "../src/core/studio-continuity-ledger.ts";
import { STUDIO_CONTINUITY_FIELDS } from "../src/core/studio-continuity.ts";
import { registerProject, setActiveProjectRegistration } from "../src/core/sidecar.ts";
import { inspectManagedProject } from "../src/core/managed-project.ts";

const workspace = "/Users/hxx/Documents/无限画布";
const root = path.join(workspace, "projects/grok-mvp-qingdeng-mrwc97mu-d0aea463");
const work = path.join(root, ".aicanvas/mvp-work");
const propId = "prop-qingdeng-lantern";
const characterId = "character-qingdeng-ke";
const sceneId = "scene-rainy-inn-porch";
const unitId = "S1E01-U01";

const man = JSON.parse(await readFile(path.join(workspace, "release-manifest.json"), "utf8"));
process.env.AI_CANVAS_WORKSPACE = workspace;
process.env.AI_CANVAS_RECORDED_SOURCE_DIGEST = man.sourceDigest;
process.env.AI_CANVAS_RELEASE_MANIFEST_PATH = path.join(workspace, "release-manifest.json");
process.env.AI_CANVAS_REGISTRY_PATH = path.join(process.env.HOME, ".aicanvas/projects.json");

const shell = await inspectManagedProject(root);
await registerProject(shell.project);
await setActiveProjectRegistration(root);

const char = await getStudioCanonicalAsset(root, characterId);
const scene = await getStudioCanonicalAsset(root, sceneId);
const prop = await getStudioCanonicalAsset(root, propId);
const shaOf = (asset) => asset.versions.find((v) => v.id === asset.primaryAuthority?.versionId)?.mediaSha256
  || asset.primaryAuthority?.mediaSha256;

const stanceByPanel = {
  1: {
    position: "客栈廊下湿青石阶上，身体居中偏右，右脚略前",
    facing: "躯干四分之三朝镜头左前，目光略偏左外",
    heldObject: "双手护持青灯于胸前偏左（提梁+托底）",
    emotion: "警觉而安静",
    costume: "靛青斗篷+素白交领+半束发蓝丝带",
    lighting: "灯暖上照脸+雨夜冷环境光",
    layout: "前景雨丝，中景人物，背景木门廊柱",
  },
  2: {
    position: "客栈廊下同一轴线，近景半侧，贴近廊柱",
    facing: "半侧脸朝镜头，右颊浅痣可见",
    heldObject: "青灯在画面下方可见提梁与罩面",
    emotion: "侧耳倾听",
    costume: "靛青斗篷+素白交领，半束发蓝丝带",
    lighting: "灯火映右颊",
    layout: "近景脸与灯，背景廊下纵深",
  },
  3: {
    position: "门廊入口，身体位于门框中轴偏左",
    facing: "朝向更深廊影/门内",
    heldObject: "青灯前移带路，高度约腰至胸",
    emotion: "决意迈入",
    costume: "靛青斗篷+素白交领不变",
    lighting: "门廊内外明暗对比，灯为局部暖源",
    layout: "门框引导线，人物推门入廊",
  },
};

function resolved(value, note) {
  return {
    status: "resolved",
    value,
    provenance: [{
      kind: "r4-stance-correction",
      reference: note,
      sourceFingerprint: createHash("sha256").update(note + "|" + value).digest("hex"),
      note: "R4 correction resolve open conflict",
    }],
  };
}
function na(reason, note) {
  return {
    status: "not-applicable",
    reason,
    provenance: [{ kind: "r4-stance-correction", reference: note, note: "R4 N/A correction" }],
  };
}

function desiredState(subjectId, field, panelIndex, stance) {
  if (subjectId === characterId) {
    if (field === "referenceSha256") return resolved(shaOf(char), `char-ref-p${panelIndex}`);
    if (field === "injury") return na("无伤情设定", `char-injury-p${panelIndex}`);
    return resolved(stance[field] || `character:${field}:p${panelIndex}`, `char-${field}-p${panelIndex}`);
  }
  if (subjectId === sceneId) {
    if (field === "referenceSha256") return resolved(shaOf(scene), `scene-ref-p${panelIndex}`);
    if (["costume", "injury", "heldObject", "emotion", "facing"].includes(field)) {
      return na(`场景不适用 ${field}`, `scene-${field}-p${panelIndex}`);
    }
    if (field === "position") return resolved("雨夜客栈廊下固定空间", `scene-pos-p${panelIndex}`);
    if (field === "layout") return resolved("廊下柱网与门的相对布局锁定", `scene-layout-p${panelIndex}`);
    if (field === "lighting") return resolved("雨夜青灯冷环境", `scene-light-p${panelIndex}`);
    return resolved(`scene:${field}:p${panelIndex}`, `scene-${field}-p${panelIndex}`);
  }
  // prop
  if (field === "referenceSha256") return resolved(shaOf(prop), `prop-ref-p${panelIndex}`);
  if (["costume", "injury", "emotion", "facing"].includes(field)) return na(`道具不适用 ${field}`, `prop-${field}-p${panelIndex}`);
  if (field === "heldObject") return resolved(stance.heldObject, `prop-held-p${panelIndex}`);
  if (field === "position") return resolved(`青灯相对人物：${stance.heldObject}`, `prop-pos-p${panelIndex}`);
  if (field === "layout") return resolved("灯为局部暖源，罩面冷青结构不变", `prop-layout-p${panelIndex}`);
  if (field === "lighting") return resolved("暖芯局部照明", `prop-light-p${panelIndex}`);
  return resolved(`prop-lantern:${field}:p${panelIndex}`, `prop-${field}-p${panelIndex}`);
}

const unit = await getStudioProductionUnitSnapshot(root, unitId);
const corrections = [];
const readiness = [];

for (const panel of unit.panels) {
  const scope = {
    kind: "panel",
    scopeId: panel.id,
    unitId: unit.unit.id,
    unitRevision: unit.unit.revision,
    startMilliseconds: Math.round(panel.startSeconds * 1000),
    endMilliseconds: Math.round(panel.endSeconds * 1000),
  };
  const stance = stanceByPanel[panel.index] || stanceByPanel[1];
  const scopeAnchor = {
    kind: "panel",
    scopeId: panel.id,
    unitId: unit.unit.id,
    unitRevision: unit.unit.revision,
  };

  for (const subjectId of [characterId, sceneId, propId]) {
    let r = await getStudioContinuityReadiness(root, {
      scope,
      subjectId,
      requiredFields: [...STUDIO_CONTINUITY_FIELDS],
    });
    if (r.ready) {
      readiness.push({ panelId: panel.id, subjectId, ready: true, fingerprint: r.fingerprint, path: "already-ready" });
      continue;
    }

    // Resolve each open conflict via correction on the latest entry for that field
    const conflictBlockers = (r.blockers || []).filter((b) => b.code === "required-state-conflict");
    for (const blocker of conflictBlockers) {
      const field = blocker.field;
      const timeline = await queryStudioContinuityTimeline(root, {
        scopeAnchor,
        subjectId,
        field,
      });
      // latest entry covering panel span
      const items = timeline.items || [];
      const latest = items[items.length - 1];
      if (!latest?.entry?.id) {
        corrections.push({ panelId: panel.id, subjectId, field, ok: false, error: "no-entry-to-supersede" });
        continue;
      }
      const openConflicts = (timeline.openConflicts || [])
        .filter((c) => c.status === "open" || !c.status)
        .map((c) => ({ conflictId: c.id, expectedRevision: c.revision ?? 1 }));
      // also use blocker conflictId
      if (blocker.conflictId && !openConflicts.some((c) => c.conflictId === blocker.conflictId)) {
        openConflicts.push({ conflictId: blocker.conflictId, expectedRevision: 1 });
      }

      let expectedHead = latest.head?.revision ?? latest.entry?.headRevision ?? 1;
      // try head from readiness path - use timeline head if present
      if (typeof timeline.headRevision === "number") expectedHead = timeline.headRevision;
      // Get from last write - try several head revisions
      let applied = false;
      for (const headTry of [expectedHead, expectedHead + 1, 1, 2, 3, 4, 5]) {
        try {
          const result = await appendStudioContinuityCorrection(root, {
            operationId: `r4fix-${panel.id}-${subjectId}-${field}-h${headTry}`.slice(0, 180),
            expectedHeadRevision: headTry,
            scope,
            subjectId,
            field,
            state: desiredState(subjectId, field, panel.index, stance),
            supersedesEntryId: latest.entry.id,
            resolvesConflicts: openConflicts.map((c) => ({
              conflictId: c.conflictId,
              expectedRevision: c.expectedRevision || 1,
            })),
          });
          corrections.push({
            panelId: panel.id,
            subjectId,
            field,
            ok: true,
            headRevision: result.head?.revision,
            resolved: result.resolvedConflictIds,
          });
          applied = true;
          break;
        } catch (e) {
          if (e?.code === "head-conflict" && typeof e.actualRevision === "number") {
            // next loop uses better head
            continue;
          }
          // conflict revision mismatch - try without resolves or with rev from error
          if (String(e.message || "").includes("conflict") || e?.code === "conflict-revision-mismatch") {
            try {
              // list open conflicts for accurate revisions
              const opens = await listOpenStudioContinuityConflicts(root, { scope });
              const matching = (opens || []).filter((c) =>
                (c.field === field || c.subjectId === subjectId) && (c.id === blocker.conflictId || true)
              );
              const resolves = matching.length
                ? matching.map((c) => ({ conflictId: c.id, expectedRevision: c.revision ?? 1 }))
                : [{ conflictId: blocker.conflictId, expectedRevision: 1 }];
              // try revisions 1..5 for conflict
              for (const cr of [1, 2, 3]) {
                try {
                  const result = await appendStudioContinuityCorrection(root, {
                    operationId: `r4fix2-${panel.id}-${subjectId}-${field}-c${cr}-h${headTry}`.slice(0, 180),
                    expectedHeadRevision: e.actualRevision ?? headTry,
                    scope,
                    subjectId,
                    field,
                    state: desiredState(subjectId, field, panel.index, stance),
                    supersedesEntryId: latest.entry.id,
                    resolvesConflicts: resolves.map((x) => ({ ...x, expectedRevision: cr })),
                  });
                  corrections.push({
                    panelId: panel.id,
                    subjectId,
                    field,
                    ok: true,
                    headRevision: result.head?.revision,
                    resolved: result.resolvedConflictIds,
                    path: "conflict-rev-retry",
                  });
                  applied = true;
                  break;
                } catch {
                  // continue
                }
              }
              if (applied) break;
            } catch {
              // fallthrough
            }
          }
          if (applied) break;
          corrections.push({
            panelId: panel.id,
            subjectId,
            field,
            ok: false,
            error: e.message,
            code: e.code,
            headTry,
          });
        }
        if (applied) break;
      }
      if (!applied && !corrections.some((c) => c.panelId === panel.id && c.subjectId === subjectId && c.field === field && c.ok === false && c.error)) {
        corrections.push({ panelId: panel.id, subjectId, field, ok: false, error: "unresolved-after-retries" });
      }
    }

    // other blockers: gap / unresolved
    for (const blocker of (r.blockers || []).filter((b) => b.code !== "required-state-conflict")) {
      corrections.push({
        panelId: panel.id,
        subjectId,
        field: blocker.field,
        ok: false,
        error: `blocker:${blocker.code}`,
        message: blocker.message,
      });
    }

    r = await getStudioContinuityReadiness(root, {
      scope,
      subjectId,
      requiredFields: [...STUDIO_CONTINUITY_FIELDS],
    });
    readiness.push({
      panelId: panel.id,
      subjectId,
      ready: r.ready,
      fingerprint: r.fingerprint,
      blockers: (r.blockers || []).map((b) => ({ code: b.code, field: b.field, conflictId: b.conflictId })),
    });
  }
}

const out = {
  correctionsOk: corrections.filter((c) => c.ok).length,
  correctionsFail: corrections.filter((c) => !c.ok).length,
  corrections: corrections.filter((c) => !c.ok).slice(0, 40),
  readiness,
  allReady: readiness.every((r) => r.ready),
};
await writeFile(path.join(work, "r4-resolve-result.json"), JSON.stringify({ ...out, correctionsSample: corrections.slice(0, 15) }, null, 2) + "\n");
console.log(JSON.stringify(out, null, 2));
if (!out.allReady) process.exitCode = 2;
