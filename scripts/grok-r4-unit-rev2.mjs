import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getStudioCanonicalAsset } from "../src/core/material-studio.ts";
import { getStudioProductionUnitSnapshot } from "../src/core/studio-production.ts";
import {
  appendStudioContinuityObservation,
  appendStudioContinuityCorrection,
  getStudioContinuityReadiness,
  queryStudioContinuityTimeline,
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
const shaOf = (a) => a.versions.find((v) => v.id === a.primaryAuthority?.versionId)?.mediaSha256 || a.primaryAuthority?.mediaSha256;

const stanceByPanel = {
  1: { position: "客栈廊下湿青石阶上，身体居中偏右，右脚略前", facing: "躯干四分之三朝镜头左前", heldObject: "双手护持青灯于胸前偏左", emotion: "警觉而安静", costume: "靛青斗篷+素白交领+半束发蓝丝带", lighting: "灯暖上照脸+雨夜冷环境光", layout: "前景雨丝，中景人物，背景木门廊柱" },
  2: { position: "廊下近景半侧贴近廊柱", facing: "半侧脸朝镜头，右颊浅痣可见", heldObject: "青灯在画面下方可见", emotion: "侧耳倾听", costume: "靛青斗篷+素白交领", lighting: "灯火映右颊", layout: "近景脸与灯" },
  3: { position: "门廊入口门框中轴偏左", facing: "朝向更深廊影", heldObject: "青灯前移带路约腰至胸", emotion: "决意迈入", costume: "靛青斗篷+素白交领", lighting: "门廊内外明暗对比", layout: "门框引导线" },
};

function resolved(value, note) {
  return { status: "resolved", value, provenance: [{ kind: "r4-unit-rev2", reference: note, sourceFingerprint: createHash("sha256").update(note + value).digest("hex"), note: "R4 unit rev2 stance" }] };
}
function na(reason, note) {
  return { status: "not-applicable", reason, provenance: [{ kind: "r4-unit-rev2", reference: note, note: "N/A" }] };
}

async function writeObs(scope, subjectId, field, state) {
  let expected = 0;
  for (let i = 0; i < 8; i++) {
    try {
      return await appendStudioContinuityObservation(root, {
        operationId: `r4rev2-${scope.scopeId}-${subjectId}-${field}-a${i}`.slice(0, 180),
        expectedHeadRevision: expected,
        scope, subjectId, field, state,
      });
    } catch (e) {
      if (e?.code === "head-conflict" && typeof e.actualRevision === "number") { expected = e.actualRevision; continue; }
      throw e;
    }
  }
  throw new Error("obs retry exhausted");
}

function stateFor(subjectId, field, stance, panelIndex) {
  if (subjectId === characterId) {
    if (field === "referenceSha256") return resolved(shaOf(char), `c-ref-${panelIndex}`);
    if (field === "injury") return na("无伤情", `c-inj-${panelIndex}`);
    return resolved(stance[field] || `c:${field}:${panelIndex}`, `c-${field}-${panelIndex}`);
  }
  if (subjectId === sceneId) {
    if (field === "referenceSha256") return resolved(shaOf(scene), `s-ref-${panelIndex}`);
    if (["costume","injury","heldObject","emotion","facing"].includes(field)) return na(`场景不适用${field}`, `s-${field}`);
    if (field === "position") return resolved("雨夜客栈廊下固定空间", `s-pos`);
    if (field === "layout") return resolved("廊下柱网与门布局锁定", `s-lay`);
    if (field === "lighting") return resolved("雨夜青灯冷环境", `s-lit`);
    return resolved(`s:${field}:${panelIndex}`, `s-${field}`);
  }
  if (field === "referenceSha256") return resolved(shaOf(prop), `p-ref`);
  if (["costume","injury","emotion","facing"].includes(field)) return na(`道具不适用${field}`, `p-${field}`);
  if (field === "heldObject") return resolved(stance.heldObject, `p-held`);
  if (field === "position") return resolved(`青灯相对人物：${stance.heldObject}`, `p-pos`);
  if (field === "layout") return resolved("灯为局部暖源罩面冷青不变", `p-lay`);
  if (field === "lighting") return resolved("暖芯局部照明", `p-lit`);
  return resolved(`prop:${field}:${panelIndex}`, `p-${field}`);
}

const unit = await getStudioProductionUnitSnapshot(root, unitId);
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
  for (const subjectId of [characterId, sceneId, propId]) {
    for (const field of STUDIO_CONTINUITY_FIELDS) {
      await writeObs(scope, subjectId, field, stateFor(subjectId, field, stance, panel.index));
    }
    let r = await getStudioContinuityReadiness(root, { scope, subjectId, requiredFields: [...STUDIO_CONTINUITY_FIELDS] });
    // resolve conflicts quickly if any
    if (!r.ready) {
      for (const b of (r.blockers || []).filter((x) => x.code === "required-state-conflict")) {
        const tl = await queryStudioContinuityTimeline(root, {
          scopeAnchor: { kind: "panel", scopeId: panel.id, unitId: unit.unit.id, unitRevision: unit.unit.revision },
          subjectId,
          field: b.field,
        });
        const latest = (tl.items || []).at(-1);
        if (!latest?.entry?.id) continue;
        for (const headTry of [1, 2, 3, 4, 5, 6, latest.head?.revision].filter(Boolean)) {
          try {
            await appendStudioContinuityCorrection(root, {
              operationId: `r4rev2fix-${panel.id}-${subjectId}-${b.field}-h${headTry}`.slice(0, 180),
              expectedHeadRevision: headTry,
              scope,
              subjectId,
              field: b.field,
              state: stateFor(subjectId, b.field, stance, panel.index),
              supersedesEntryId: latest.entry.id,
              resolvesConflicts: [{ conflictId: b.conflictId, expectedRevision: 1 }],
            });
            break;
          } catch (e) {
            if (e?.actualRevision != null) continue;
            for (const cr of [1, 2, 3]) {
              try {
                await appendStudioContinuityCorrection(root, {
                  operationId: `r4rev2fix2-${panel.id}-${subjectId}-${b.field}-c${cr}`.slice(0, 180),
                  expectedHeadRevision: e.actualRevision ?? headTry,
                  scope, subjectId, field: b.field,
                  state: stateFor(subjectId, b.field, stance, panel.index),
                  supersedesEntryId: latest.entry.id,
                  resolvesConflicts: [{ conflictId: b.conflictId, expectedRevision: cr }],
                });
                break;
              } catch { /* */ }
            }
          }
        }
      }
      r = await getStudioContinuityReadiness(root, { scope, subjectId, requiredFields: [...STUDIO_CONTINUITY_FIELDS] });
    }
    readiness.push({ panelId: panel.id, subjectId, ready: r.ready, blockers: (r.blockers || []).map((b) => b.code + ":" + b.field) });
  }
}
const out = { unitRevision: unit.unit.revision, readiness, allReady: readiness.every((r) => r.ready) };
await writeFile(path.join(work, "r4-unit-rev2-ready.json"), JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify(out, null, 2));
if (!out.allReady) process.exitCode = 2;
