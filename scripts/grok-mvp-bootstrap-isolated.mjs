import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { createManagedProject } from "../src/core/managed-project.ts";
import { registerProject, setActiveProjectRegistration } from "../src/core/sidecar.ts";
import {
  createStudioCanonicalAsset,
  importStudioMedia,
  appendStudioAssetVersion,
  reviewStudioAssetVersion,
  setStudioPrimaryAuthority,
  getStudioCanonicalAsset,
} from "../src/core/material-studio.ts";
import {
  createStudioScriptDocument,
  appendStudioScriptRevision,
  createStudioPromptDocument,
  appendStudioPromptRevision,
  createStudioProductionUnit,
} from "../src/core/studio-production.ts";

const workspace = "/Users/hxx/Documents/无限画布";
const parentRoot = path.join(workspace, "projects");
const existing = process.argv[2]; // optional existing project root to resume
const slug = "grok-mvp-qingdeng-" + Date.now().toString(36);
const name = "Grok最小受管生图闭环-青灯客";
const evidenceDir = path.join(workspace, "docs/evidence");
await mkdir(evidenceDir, { recursive: true });

process.env.AI_CANVAS_WORKSPACE = workspace;
process.env.AI_CANVAS_RECORDED_SOURCE_DIGEST = "9d650d4df5fde6fdd13ba2e8460ce9ffb66350a63e1c2f3511090df5676a0798";
process.env.AI_CANVAS_RELEASE_MANIFEST_PATH = path.join(workspace, "release-manifest.json");
process.env.AI_CANVAS_REGISTRY_PATH = process.env.AI_CANVAS_REGISTRY_PATH || path.join(process.env.HOME, ".aicanvas/projects.json");

let root;
let shell;
if (existing) {
  root = path.resolve(existing);
  const { inspectManagedProject } = await import("../src/core/managed-project.ts");
  shell = await inspectManagedProject(root);
  await registerProject(shell.project);
  await setActiveProjectRegistration(root);
} else {
  shell = await createManagedProject({ parentRoot, name, slug });
  root = shell.paths.root;
  await registerProject(shell.project);
  await setActiveProjectRegistration(root);
}

const work = path.join(root, ".aicanvas/mvp-work");
await mkdir(work, { recursive: true });

const scenePng = path.join(work, "scene-rainy-inn-provisional.png");
await sharp({
  create: { width: 1280, height: 720, channels: 3, background: { r: 28, g: 34, b: 48 } },
}).png().toFile(scenePng);

async function promoteAuthority(assetId, sourcePath, note) {
  const media = await importStudioMedia(root, { sourcePath, kind: "image" });
  const asset = await getStudioCanonicalAsset(root, assetId);
  const versioned = await appendStudioAssetVersion(root, {
    assetId,
    mediaSha256: media.sha256,
    reviewStatus: "pending",
    sourceNote: note,
    expectedRevision: asset.revision,
  });
  const reviewed = await reviewStudioAssetVersion(root, {
    assetId,
    versionId: versioned.version.id,
    decision: "approved",
    expectedRevision: versioned.assetRevision,
    note: `${note} | mechanical approve for MVP authority`,
  });
  const primary = await setStudioPrimaryAuthority(root, {
    assetId,
    versionId: versioned.version.id,
    expectedRevision: reviewed.revision,
    note: "set primary authority for isolated grok mvp",
  });
  return { media, versionId: versioned.version.id, revision: primary.revision, sha256: media.sha256 };
}

async function ensureAsset(input) {
  try {
    return await getStudioCanonicalAsset(root, input.id);
  } catch {
    return createStudioCanonicalAsset(root, { ...input, expectedRevision: 0 });
  }
}

const character = await ensureAsset({
  id: "character-qingdeng-ke",
  category: "character",
  name: "青灯客",
  description: "原创隔离 canary 角色：二十多岁东亚女性旅人，靛青色斗篷、内衬素白交领、黑发半束、右颊浅痣。禁止嘟嘟/素任何身份串用。",
  aliases: ["青灯客旅人"],
  identityFeatures: ["东亚女性青年面孔", "右颊浅痣", "半束黑发", "靛青色旅行斗篷"],
  positiveLocks: ["同一张脸", "靛青斗篷", "素白交领内衫", "右颊浅痣"],
  negativeLocks: ["禁止换脸", "禁止现代服装", "禁止嘟嘟形象", "禁止儿童化"],
  defaultPrompt: "cinematic photoreal character reference of a young East Asian woman traveler, indigo travel cloak, white cross-collar underlayer, half-tied black hair, faint mole on right cheek, neutral three-quarter portrait, soft lantern light, 16:9",
});

const scene = await ensureAsset({
  id: "scene-rainy-inn-porch",
  category: "scene",
  name: "雨夜客栈廊",
  description: "原创隔离场景：青石客栈廊下、雨夜、一盏青灯。",
  aliases: ["雨夜廊下"],
  identityFeatures: ["青石廊柱", "雨夜湿地面", "一盏青灯"],
  positiveLocks: ["保持同一客栈廊下布局", "雨夜青灯光"],
  negativeLocks: ["禁止白天", "禁止现代都市", "禁止室内封闭全黑"],
  defaultPrompt: "rainy night wooden inn porch, blue-green lantern, wet stone floor, cinematic",
});

let sceneAuth;
const sceneDetail = await getStudioCanonicalAsset(root, scene.id);
if (!sceneDetail.primaryAuthority) {
  sceneAuth = await promoteAuthority(
    scene.id,
    scenePng,
    "provisional scene authority fixture for isolated grok mvp (not live canary image)",
  );
} else {
  sceneAuth = { sha256: sceneDetail.primaryAuthority.mediaSha256, versionId: sceneDetail.primaryAuthority.versionId, revision: sceneDetail.revision };
}

// script/unit may already exist if resume - try create fresh ids with suffix
const stamp = Date.now().toString(36);
let unitId = "S1E01-U01";
let unitRevision = 0;
let panelIds = [];
let scriptRevisionId = "";

try {
  const { getStudioProductionUnitSnapshot } = await import("../src/core/studio-production.ts");
  const snap = await getStudioProductionUnitSnapshot(root, unitId);
  unitRevision = snap.unit.revision;
  panelIds = snap.panels.map((p) => p.id);
  scriptRevisionId = snap.unit.scriptRevisionId;
  console.error("unit exists, reusing", unitId, unitRevision);
} catch {
  const scriptDoc = await createStudioScriptDocument(root, {
    id: `script-qingdeng-mvp-${stamp}`,
    title: "青灯客·最小15秒",
    expectedRevision: 0,
  });
  const scriptBody = "雨夜，青灯客停在客栈廊下。她抬手护住灯火，侧耳听雨，随后推门迈入更深的廊影。";
  const scriptRev = await appendStudioScriptRevision(root, {
    documentId: scriptDoc.id,
    expectedRevision: 0,
    body: scriptBody,
    source: "grok-mvp-isolated",
    sourceVersion: "2026-07-23",
  });
  scriptRevisionId = scriptRev.revision.id;

  async function makePrompt(id, title, body) {
    const doc = await createStudioPromptDocument(root, { id, title, expectedRevision: 0 });
    const rev = await appendStudioPromptRevision(root, {
      documentId: doc.id,
      expectedRevision: 0,
      body,
      source: "grok-mvp-isolated",
      sourceVersion: "2026-07-23",
    });
    return rev.revision.id;
  }

  const p1Prompt = await makePrompt(
    `prompt-u01-p1-${stamp}`,
    "P1 停步护灯",
    "电影写实 16:9 三格故事板左格：青灯客侧身停在雨夜客栈廊下，双手护住青灯，雨丝斜落，湿青石反光。只出青灯客与廊下，禁止字幕、分镜框、其他角色。",
  );
  const p2Prompt = await makePrompt(
    `prompt-u01-p2-${stamp}`,
    "P2 侧耳听雨",
    "电影写实 16:9 三格故事板中格：青灯客半侧脸贴近廊柱，侧耳听雨，灯火映右颊浅痣，斗篷微湿。同一人物同一廊下，禁止换脸换景。",
  );
  const p3Prompt = await makePrompt(
    `prompt-u01-p3-${stamp}`,
    "P3 推门入廊",
    "电影写实 16:9 三格故事板右格：青灯客推开客栈木门迈入更深廊影，青灯前移带出一缕暖光。同一人物同一客栈，禁止字幕与其他角色。",
  );

  const evidence = [{ kind: "script", reference: scriptRevisionId, note: "最小原创剧本" }];
  const unit = await createStudioProductionUnit(root, {
    id: unitId,
    expectedRevision: 0,
    season: "S1",
    episode: "S1E1",
    sequence: 1,
    title: "青灯客·雨夜廊下",
    scriptRevisionId,
    panels: [
      {
        id: "S1E01-U01-P1",
        title: "停步护灯",
        visualAction: "青灯客停步，双手护住青灯",
        shotComposition: "中景，左侧廊柱，人物居中偏右",
        filmingMethod: "缓慢推近",
        startSeconds: 0,
        durationSeconds: 5,
        endSeconds: 5,
        promptRevisionId: p1Prompt,
        sourceSpans: [{ startOffsetUtf16: 0, endOffsetUtf16: 13 }],
        assets: [
          { assetId: character.id, category: "character", presence: "required", role: "主体", continuityState: "靛青斗篷半束发，右颊浅痣", evidence },
          { assetId: scene.id, category: "scene", presence: "required", role: "场景", continuityState: "雨夜客栈廊下青灯", evidence },
        ],
      },
      {
        id: "S1E01-U01-P2",
        title: "侧耳听雨",
        visualAction: "青灯客侧耳听雨，灯映右颊",
        shotComposition: "近景，半侧脸",
        filmingMethod: "固定机位微侧",
        startSeconds: 5,
        durationSeconds: 5,
        endSeconds: 10,
        promptRevisionId: p2Prompt,
        sourceSpans: [{ startOffsetUtf16: 13, endOffsetUtf16: 26 }],
        assets: [
          { assetId: character.id, category: "character", presence: "required", role: "主体", continuityState: "同一张脸与斗篷，右颊浅痣可见", evidence },
          { assetId: scene.id, category: "scene", presence: "required", role: "场景", continuityState: "同一廊下", evidence },
        ],
      },
      {
        id: "S1E01-U01-P3",
        title: "推门入廊",
        visualAction: "青灯客推门迈入廊影",
        shotComposition: "中全景，门框引导线",
        filmingMethod: "跟移半步",
        startSeconds: 10,
        durationSeconds: 5,
        endSeconds: 15,
        promptRevisionId: p3Prompt,
        sourceSpans: [{ startOffsetUtf16: 26, endOffsetUtf16: 38 }],
        assets: [
          { assetId: character.id, category: "character", presence: "required", role: "主体", continuityState: "斗篷与灯位连续", evidence },
          { assetId: scene.id, category: "scene", presence: "required", role: "场景", continuityState: "客栈门廊", evidence },
        ],
      },
    ],
  });
  unitRevision = unit.unit.revision;
  panelIds = unit.panels.map((p) => p.id);
}

const out = {
  projectRoot: root,
  projectId: shell.project?.id || shell.manifest?.projectId || shell.project?.projectId,
  slug: path.basename(root),
  name: shell.project?.name || name,
  characterId: character.id,
  sceneId: scene.id,
  sceneAuthoritySha256: sceneAuth.sha256,
  characterHasAuthority: Boolean((await getStudioCanonicalAsset(root, character.id)).primaryAuthority),
  unitId,
  unitRevision,
  panelIds,
  scriptRevisionId,
  next: "generate_character_reference_then_authority_then_bind_freeze",
  duduProtected: true,
  active: true,
};
const outPath = path.join(work, "bootstrap.json");
await writeFile(outPath, JSON.stringify(out, null, 2) + "\n");
const evidencePath = path.join(evidenceDir, `grok-mvp-bootstrap-${path.basename(root)}.json`);
await writeFile(evidencePath, JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify({ ok: true, outPath, evidencePath, ...out }, null, 2));
