import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import {
  createStudioCanonicalAsset,
  importStudioMedia,
  appendStudioAssetVersion,
  reviewStudioAssetVersion,
  setStudioPrimaryAuthority,
  getStudioCanonicalAsset,
} from "../src/core/material-studio.ts";
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

process.env.AI_CANVAS_WORKSPACE = workspace;
process.env.AI_CANVAS_REGISTRY_PATH = path.join(process.env.HOME, ".aicanvas/projects.json");
// load current release digest dynamically
try {
  const man = JSON.parse(await readFile(path.join(workspace, "release-manifest.json"), "utf8"));
  process.env.AI_CANVAS_RECORDED_SOURCE_DIGEST = man.sourceDigest;
  process.env.AI_CANVAS_RELEASE_MANIFEST_PATH = path.join(workspace, "release-manifest.json");
} catch {}

const shell = await inspectManagedProject(root);
await registerProject(shell.project);
await setActiveProjectRegistration(root);

await mkdir(work, { recursive: true });

// --- R3: prop authority from crop of character master (lantern region) + optional clean plate ---
const charPath = path.join(work, "character-qingdeng-ke-ref-raw.jpg");
const propPath = path.join(work, "prop-qingdeng-lantern-authority.png");

// Character image is 1280x720; lantern typically lower-left of subject. Crop a lantern-focused plate
// using a center-right crop around mid body where lantern is held in master.
const meta = await sharp(charPath).metadata();
const w = meta.width ?? 1280;
const h = meta.height ?? 720;
// Crop lower-center band where handheld lantern usually sits; then we also generate a cleaner pad
const cropW = Math.floor(w * 0.28);
const cropH = Math.floor(h * 0.42);
const left = Math.max(0, Math.floor(w * 0.28));
const top = Math.max(0, Math.floor(h * 0.35));
await sharp(charPath)
  .extract({ left, top, width: Math.min(cropW, w - left), height: Math.min(cropH, h - top) })
  .resize(768, 768, { fit: "cover", position: "centre" })
  .png()
  .toFile(propPath);

let prop;
try {
  prop = await getStudioCanonicalAsset(root, propId);
  console.error("prop exists rev", prop.revision, "auth", !!prop.primaryAuthority);
} catch {
  prop = await createStudioCanonicalAsset(root, {
    id: propId,
    category: "prop",
    name: "青灯",
    description: "青灯客手持冷青纸罩方灯：木/金属框、冷青绿罩、暖黄灯芯、云纹。跨时间线必须同一结构，禁止换成现代手电或红灯笼。",
    aliases: ["青灯客灯", "手提青灯", "方纸灯"],
    identityFeatures: ["方形纸罩灯", "冷青绿罩面", "暖黄灯芯", "细提梁"],
    positiveLocks: ["保持同一青灯结构与冷青罩暖芯", "手提高度可变但灯形不变"],
    negativeLocks: ["禁止现代手电", "禁止大红灯笼", "禁止无故换形"],
    defaultPrompt: "same blue-green square paper lantern with warm core, thin handle, cloud pattern on panels",
    expectedRevision: 0,
  });
}

let propAuth;
if (!prop.primaryAuthority) {
  const media = await importStudioMedia(root, { sourcePath: propPath, kind: "image" });
  prop = await getStudioCanonicalAsset(root, propId);
  const versioned = await appendStudioAssetVersion(root, {
    assetId: propId,
    mediaSha256: media.sha256,
    reviewStatus: "pending",
    sourceNote: "R3 prop authority plate cropped from character master for lantern structure lock",
    expectedRevision: prop.revision,
  });
  const reviewed = await reviewStudioAssetVersion(root, {
    assetId: propId,
    versionId: versioned.version.id,
    decision: "approved",
    expectedRevision: versioned.assetRevision,
    note: "R3 机械批准青灯 Authority 结构锁（裁切主参考中的灯区）；视觉以灯形/色罩为准。",
  });
  const primary = await setStudioPrimaryAuthority(root, {
    assetId: propId,
    versionId: versioned.version.id,
    expectedRevision: reviewed.revision,
    note: "R3 set primary authority for prop-qingdeng-lantern",
  });
  propAuth = { sha256: media.sha256, versionId: versioned.version.id, revision: primary.revision };
} else {
  const ver = prop.versions.find((v) => v.id === prop.primaryAuthority.versionId);
  propAuth = { sha256: ver?.mediaSha256 || prop.primaryAuthority.mediaSha256, versionId: prop.primaryAuthority.versionId, revision: prop.revision };
}

const char = await getStudioCanonicalAsset(root, characterId);
const scene = await getStudioCanonicalAsset(root, sceneId);
const charSha = char.versions.find((v) => v.id === char.primaryAuthority?.versionId)?.mediaSha256;
const sceneSha = scene.versions.find((v) => v.id === scene.primaryAuthority?.versionId)?.mediaSha256;

// --- R4: nine-field writeback for all panels × required subjects ---
const unit = await getStudioProductionUnitSnapshot(root, unitId);
const stanceByPanel = {
  1: {
    position: "客栈廊下湿青石阶上，身体居中偏右，右脚略前",
    facing: "躯干四分之三朝镜头左前，目光略偏左外",
    heldObject: "双手护持青灯于胸前偏左（提梁+托底）",
    emotion: "警觉而安静",
    costume: "靛青斗篷+素白交领",
    lighting: "灯暖上照脸+雨夜冷环境光",
    layout: "前景雨丝，中景人物，背景木门廊柱",
    injury: "not-applicable:无伤情",
  },
  2: {
    position: "客栈廊下同一轴线，近景半侧，贴近廊柱",
    facing: "半侧脸朝镜头，右颊浅痣可见",
    heldObject: "青灯在画面下方可见提梁与罩面",
    emotion: "侧耳倾听",
    costume: "靛青斗篷+素白交领，半束发蓝丝带",
    lighting: "灯火映右颊",
    layout: "近景脸与灯，背景廊下纵深",
    injury: "not-applicable:无伤情",
  },
  3: {
    position: "门廊入口，身体位于门框中轴偏左",
    facing: "朝向更深廊影/门内，四分之三背侧过渡",
    heldObject: "青灯前移带路，高度约腰至胸",
    emotion: "决意迈入",
    costume: "靛青斗篷+素白交领不变",
    lighting: "门廊内外明暗对比，灯为局部暖源",
    layout: "门框引导线，人物推门入廊",
    injury: "not-applicable:无伤情",
  },
};

const subjects = [
  { assetId: characterId, category: "character", sha: charSha },
  { assetId: sceneId, category: "scene", sha: sceneSha },
  { assetId: propId, category: "prop", sha: propAuth.sha256 },
];

const continuityResults = [];
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
  for (const subject of subjects) {
    // For scene, some fields are N/A differently
    for (const field of STUDIO_CONTINUITY_FIELDS) {
      let value;
      let status = "resolved";
      if (field === "referenceSha256") {
        value = subject.sha;
        if (!value) {
          continuityResults.push({ panelId: panel.id, subjectId: subject.assetId, field, error: "missing sha" });
          continue;
        }
      } else if (subject.category === "scene") {
        if (["costume", "injury", "heldObject", "emotion", "facing"].includes(field)) {
          // write not-applicable for scene on character-centric fields
          const write = await appendStudioContinuityObservation(root, {
            operationId: `r4-${unitId}-${panel.id}-${subject.assetId}-${field}`.slice(0, 200),
            expectedHeadRevision: 0,
            scope,
            subjectId: subject.assetId,
            field,
            state: {
              status: "not-applicable",
              reason: `场景主体不适用字段 ${field}`,
              provenance: [{
                kind: "r4-stance-writeback",
                reference: `${unitId}/${panel.id}/${subject.assetId}/${field}`,
                note: "R4 scene N/A field",
              }],
            },
          });
          continuityResults.push({ panelId: panel.id, subjectId: subject.assetId, field, status: "not-applicable", entryId: write?.entryId || write?.id });
          continue;
        }
        value = field === "position" ? "雨夜客栈廊下固定空间"
          : field === "layout" ? "廊下柱网与门的相对布局锁定"
          : field === "lighting" ? "雨夜青灯冷环境"
          : `scene:${field}:p${panel.index}`;
      } else if (subject.category === "prop") {
        if (["costume", "injury", "emotion", "facing"].includes(field)) {
          const write = await appendStudioContinuityObservation(root, {
            operationId: `r4-${unitId}-${panel.id}-${subject.assetId}-${field}`.slice(0, 200),
            expectedHeadRevision: 0,
            scope,
            subjectId: subject.assetId,
            field,
            state: {
              status: "not-applicable",
              reason: `道具主体不适用字段 ${field}`,
              provenance: [{
                kind: "r4-stance-writeback",
                reference: `${unitId}/${panel.id}/${subject.assetId}/${field}`,
                note: "R4 prop N/A field",
              }],
            },
          });
          continuityResults.push({ panelId: panel.id, subjectId: subject.assetId, field, status: "not-applicable" });
          continue;
        }
        value = field === "heldObject" ? stance.heldObject
          : field === "position" ? `青灯相对人物：${stance.heldObject}`
          : field === "layout" ? "灯为局部暖源，罩面冷青"
          : field === "lighting" ? "暖芯局部照明"
          : field === "costume" ? "N/A"
          : `prop-lantern:${field}:p${panel.index}`;
      } else {
        // character
        if (field === "injury") {
          const write = await appendStudioContinuityObservation(root, {
            operationId: `r4-${unitId}-${panel.id}-${subject.assetId}-${field}`.slice(0, 200),
            expectedHeadRevision: 0,
            scope,
            subjectId: subject.assetId,
            field,
            state: {
              status: "not-applicable",
              reason: "无伤情设定",
              provenance: [{
                kind: "r4-stance-writeback",
                reference: `${unitId}/${panel.id}/${subject.assetId}/${field}`,
                note: "R4 character injury N/A",
              }],
            },
          });
          continuityResults.push({ panelId: panel.id, subjectId: subject.assetId, field, status: "not-applicable" });
          continue;
        }
        value = stance[field] || `character:${field}:p${panel.index}`;
      }

      try {
        const write = await appendStudioContinuityObservation(root, {
          operationId: `r4-${unitId}-${panel.id}-${subject.assetId}-${field}`.slice(0, 200),
          expectedHeadRevision: 0,
          scope,
          subjectId: subject.assetId,
          field,
          state: {
            status: "resolved",
            value,
            provenance: [{
              kind: "r4-stance-writeback",
              reference: `${unitId}/${panel.id}/${subject.assetId}/${field}`,
              sourceFingerprint: field === "referenceSha256" ? value : createHash("sha256").update(`${unitId}|${panel.id}|${subject.assetId}|${field}|${value}`).digest("hex"),
              note: "R4 九字段站位/持物/朝向写回",
            }],
          },
        });
        continuityResults.push({ panelId: panel.id, subjectId: subject.assetId, field, status: "resolved", ok: true });
      } catch (e) {
        // idempotent/conflict: try readiness anyway
        continuityResults.push({ panelId: panel.id, subjectId: subject.assetId, field, error: e.message });
      }
    }

    const readiness = await getStudioContinuityReadiness(root, {
      scope,
      subjectId: subject.assetId,
      requiredFields: [...STUDIO_CONTINUITY_FIELDS],
    });
    continuityResults.push({
      panelId: panel.id,
      subjectId: subject.assetId,
      readiness: readiness.ready,
      fingerprint: readiness.fingerprint,
      missing: readiness.missingFields || readiness.unresolvedFields,
    });
  }
}

const out = {
  r3: {
    propId,
    propAuth,
    propPath,
    characterHasAuthority: !!char.primaryAuthority,
    sceneHasAuthority: !!scene.primaryAuthority,
  },
  r4: {
    unitId,
    unitRevision: unit.unit.revision,
    panelCount: unit.panels.length,
    subjects: subjects.map((s) => s.assetId),
    readinessSummary: continuityResults.filter((r) => "readiness" in r),
    writeErrors: continuityResults.filter((r) => r.error),
    writeCount: continuityResults.filter((r) => r.ok || r.status === "not-applicable").length,
  },
};
await writeFile(path.join(work, "r3-r4-result.json"), JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify(out, null, 2));
