import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getStudioCanonicalAsset } from "../src/core/material-studio.ts";
import { getStudioProductionUnitSnapshot } from "../src/core/studio-production.ts";
import {
  appendStudioContinuityObservation,
  getStudioContinuityReadiness,
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

async function writeField({ scope, subjectId, field, state, tag }) {
  const opBase = `r4v2-${scope.scopeId}-${subjectId}-${field}-${tag}`.slice(0, 180);
  let expected = 0;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      const result = await appendStudioContinuityObservation(root, {
        operationId: `${opBase}-a${attempt}`,
        expectedHeadRevision: expected,
        scope,
        subjectId,
        field,
        state,
      });
      return { ok: true, expected, headRevision: result.head?.revision, replayed: result.replayed };
    } catch (e) {
      if (e?.code === "head-conflict" && typeof e.actualRevision === "number") {
        expected = e.actualRevision;
        continue;
      }
      if (e?.code === "operation-conflict") {
        // try next attempt id with same expected
        continue;
      }
      return { ok: false, error: e.message, code: e.code, expected };
    }
  }
  return { ok: false, error: "retry-exhausted", expected };
}

function resolved(value, note) {
  return {
    status: "resolved",
    value,
    provenance: [{
      kind: "r4-stance-writeback",
      reference: note,
      sourceFingerprint: createHash("sha256").update(note + "|" + value).digest("hex"),
      note: "R4 九字段站位/持物/朝向写回",
    }],
  };
}

function na(reason, note) {
  return {
    status: "not-applicable",
    reason,
    provenance: [{
      kind: "r4-stance-writeback",
      reference: note,
      note: "R4 N/A",
    }],
  };
}

const unit = await getStudioProductionUnitSnapshot(root, unitId);
const writes = [];
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

  // Character — emphasize stance fields; other fields also kept coherent
  for (const field of STUDIO_CONTINUITY_FIELDS) {
    let state;
    if (field === "referenceSha256") state = resolved(shaOf(char), `${panel.id}/character/ref`);
    else if (field === "injury") state = na("无伤情设定", `${panel.id}/character/injury`);
    else state = resolved(stance[field] || `character:${field}:p${panel.index}`, `${panel.id}/character/${field}`);
    writes.push({ panelId: panel.id, subjectId: characterId, field, ...(await writeField({ scope, subjectId: characterId, field, state, tag: "char" })) });
  }

  // Scene
  for (const field of STUDIO_CONTINUITY_FIELDS) {
    let state;
    if (field === "referenceSha256") state = resolved(shaOf(scene), `${panel.id}/scene/ref`);
    else if (["costume", "injury", "heldObject", "emotion", "facing"].includes(field)) {
      state = na(`场景不适用 ${field}`, `${panel.id}/scene/${field}`);
    } else if (field === "position") state = resolved("雨夜客栈廊下固定空间", `${panel.id}/scene/position`);
    else if (field === "layout") state = resolved("廊下柱网与门的相对布局锁定", `${panel.id}/scene/layout`);
    else if (field === "lighting") state = resolved("雨夜青灯冷环境", `${panel.id}/scene/lighting`);
    else state = resolved(`scene:${field}:p${panel.index}`, `${panel.id}/scene/${field}`);
    writes.push({ panelId: panel.id, subjectId: sceneId, field, ...(await writeField({ scope, subjectId: sceneId, field, state, tag: "scene" })) });
  }

  // Prop (R3 subject) — full nine fields
  for (const field of STUDIO_CONTINUITY_FIELDS) {
    let state;
    if (field === "referenceSha256") state = resolved(shaOf(prop), `${panel.id}/prop/ref`);
    else if (["costume", "injury", "emotion", "facing"].includes(field)) {
      state = na(`道具不适用 ${field}`, `${panel.id}/prop/${field}`);
    } else if (field === "heldObject") state = resolved(stance.heldObject, `${panel.id}/prop/held`);
    else if (field === "position") state = resolved(`青灯相对人物：${stance.heldObject}`, `${panel.id}/prop/pos`);
    else if (field === "layout") state = resolved("灯为局部暖源，罩面冷青结构不变", `${panel.id}/prop/layout`);
    else if (field === "lighting") state = resolved("暖芯局部照明", `${panel.id}/prop/light`);
    else state = resolved(`prop-lantern:${field}:p${panel.index}`, `${panel.id}/prop/${field}`);
    writes.push({ panelId: panel.id, subjectId: propId, field, ...(await writeField({ scope, subjectId: propId, field, state, tag: "prop" })) });
  }

  for (const subjectId of [characterId, sceneId, propId]) {
    const r = await getStudioContinuityReadiness(root, {
      scope,
      subjectId,
      requiredFields: [...STUDIO_CONTINUITY_FIELDS],
    });
    readiness.push({
      panelId: panel.id,
      subjectId,
      ready: r.ready,
      fingerprint: r.fingerprint,
      missing: r.missingFields ?? r.unresolved ?? null,
    });
  }
}

const failedWrites = writes.filter((w) => !w.ok);
const notReady = readiness.filter((r) => !r.ready);
const out = {
  r3: {
    propId,
    propAuthoritySha256: shaOf(prop),
    propRevision: prop.revision,
    alreadyExisted: true,
  },
  r4: {
    unitId,
    unitRevision: unit.unit.revision,
    writeOk: writes.filter((w) => w.ok).length,
    writeFail: failedWrites.length,
    failedWrites: failedWrites.slice(0, 20),
    readiness,
    allReady: notReady.length === 0,
  },
};
await writeFile(path.join(work, "r3-r4-result.json"), JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify(out, null, 2));
if (failedWrites.length || notReady.length) process.exitCode = 2;
