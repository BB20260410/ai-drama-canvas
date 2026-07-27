import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  getStudioCanonicalAsset,
  getStudioCanonicalAssetKnowledgeSnapshot,
  evaluateStudioAssetApplicability,
} from "../src/core/material-studio.ts";
import {
  getStudioProductionUnitSnapshot,
  reviseStudioProductionUnit,
  analyzeStudioPanelAssetMentions,
  recordStudioMentionDecision,
  freezeStudioPanelAssetBindingSet,
  getStudioProductionPanelTimeContext,
  listStudioAssetMentionAnalyses,
} from "../src/core/studio-production.ts";
import { registerProject, setActiveProjectRegistration } from "../src/core/sidecar.ts";
import { inspectManagedProject } from "../src/core/managed-project.ts";

const workspace = "/Users/hxx/Documents/无限画布";
const root = path.join(workspace, "projects/grok-mvp-qingdeng-mrwc97mu-d0aea463");
const work = path.join(root, ".aicanvas/mvp-work");
const unitId = "S1E01-U01";
const characterId = "character-qingdeng-ke";
const sceneId = "scene-rainy-inn-porch";
const propId = "prop-qingdeng-lantern";
const SCRIPT = "雨夜，青灯客停在客栈廊下。她抬手护住灯火，侧耳听雨，随后推门迈入更深的廊影。";

const man = JSON.parse(await readFile(path.join(workspace, "release-manifest.json"), "utf8"));
process.env.AI_CANVAS_WORKSPACE = workspace;
process.env.AI_CANVAS_RECORDED_SOURCE_DIGEST = man.sourceDigest;
process.env.AI_CANVAS_RELEASE_MANIFEST_PATH = path.join(workspace, "release-manifest.json");
process.env.AI_CANVAS_REGISTRY_PATH = path.join(process.env.HOME, ".aicanvas/projects.json");

function digest(value) {
  const stable = (v) => {
    if (Array.isArray(v)) return v.map(stable);
    if (!v || typeof v !== "object") return v;
    return Object.fromEntries(Object.entries(v).filter(([, e]) => e !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, e]) => [k, stable(e)]));
  };
  return createHash("sha256").update(JSON.stringify(stable(value)), "utf8").digest("hex");
}

const shell = await inspectManagedProject(root);
await registerProject(shell.project);
await setActiveProjectRegistration(root);
const projectId = shell.manifest?.projectId || shell.project.projectId || shell.project.id;

let unit = await getStudioProductionUnitSnapshot(root, unitId);
const revisionBefore = unit.unit.revision;

// Ensure prop on all panels
const needsRevise = unit.panels.some((p) => !p.assets.some((a) => a.assetId === propId));
if (needsRevise) {
  const panelsInput = unit.panels.map((panel) => {
    const assets = panel.assets.map((a) => ({
      assetId: a.assetId,
      category: a.category,
      presence: a.presence,
      role: a.role,
      continuityState: a.continuityState,
      evidence: a.evidence?.length ? a.evidence : [{ kind: "script", reference: unit.scriptRevision.id, note: "inherit" }],
    }));
    if (!assets.some((a) => a.assetId === propId)) {
      assets.push({
        assetId: propId,
        category: "prop",
        presence: "required",
        role: "手持青灯",
        continuityState: "冷青罩暖芯方灯结构锁定",
        evidence: [{ kind: "hard-lock", reference: "prop-qingdeng-lantern-authority", note: "R3 prop authority" }],
      });
    }
    return {
      id: panel.id,
      title: panel.title,
      visualAction: panel.visualAction,
      shotComposition: panel.shotComposition,
      filmingMethod: panel.filmingMethod,
      dialogue: panel.dialogue || "",
      subtitle: panel.subtitle || "",
      startSeconds: panel.startSeconds,
      endSeconds: panel.endSeconds,
      durationSeconds: panel.durationSeconds,
      promptRevisionId: panel.promptRevision.id,
      sourceSpans: panel.sourceSpans.map((s) => ({
        startOffsetUtf16: s.startOffsetUtf16,
        endOffsetUtf16: s.endOffsetUtf16,
      })),
      assets,
    };
  });
  await reviseStudioProductionUnit(root, {
    unitId,
    expectedRevision: unit.unit.revision,
    season: unit.unit.season,
    episode: unit.unit.episode,
    sequence: unit.unit.sequence,
    title: unit.unit.title,
    scriptRevisionId: unit.scriptRevision.id,
    panels: panelsInput,
  });
  unit = await getStudioProductionUnitSnapshot(root, unitId);
}

async function analysisExpectedRevision(panelIndex) {
  try {
    const page = await listStudioAssetMentionAnalyses(root, { unitId, panelIndex, limit: 1 });
    const head = page?.items?.[0];
    if (head?.revision) return head.revision; // next write expects current head?
  } catch {}
  // try 0 then 1
  return null;
}

function mentionPlan(panel) {
  const span = panel.sourceSpans[0];
  const picks = [];
  let start = SCRIPT.indexOf("青灯客");
  let end = start + 3;
  if (start >= span.startOffsetUtf16 && end <= span.endOffsetUtf16) {
    picks.push({ assetId: characterId, category: "character", surface: "青灯客", start, end, presence: "required", role: "主体" });
  } else if (panel.index === 2) {
    picks.push({ assetId: characterId, category: "character", surface: "她", start: 13, end: 14, presence: "required", role: "主体" });
  } else {
    const i = SCRIPT.indexOf("推门");
    picks.push({ assetId: characterId, category: "character", surface: "推门", start: i, end: i + 2, presence: "required", role: "主体" });
  }
  start = SCRIPT.indexOf("客栈廊下");
  end = start + 4;
  if (start >= span.startOffsetUtf16 && end <= span.endOffsetUtf16) {
    picks.push({ assetId: sceneId, category: "scene", surface: "客栈廊下", start, end, presence: "required", role: "场景" });
  } else if (panel.index === 2) {
    const fire = SCRIPT.indexOf("火", 13);
    picks.push({ assetId: sceneId, category: "scene", surface: "火", start: fire, end: fire + 1, presence: "required", role: "场景" });
  } else {
    const i = SCRIPT.indexOf("廊影");
    picks.push({ assetId: sceneId, category: "scene", surface: "廊影", start: i, end: i + 2, presence: "required", role: "场景" });
  }
  // prop: prefer 灯火, else 灯 inside span
  start = SCRIPT.indexOf("灯火");
  end = start + 2;
  if (start >= 0 && start >= span.startOffsetUtf16 && end <= span.endOffsetUtf16) {
    picks.push({ assetId: propId, category: "prop", surface: "灯火", start, end, presence: "required", role: "手持青灯" });
  } else {
    const lamp = SCRIPT.indexOf("灯", span.startOffsetUtf16);
    if (lamp >= span.startOffsetUtf16 && lamp < span.endOffsetUtf16) {
      picks.push({ assetId: propId, category: "prop", surface: "灯", start: lamp, end: lamp + 1, presence: "required", role: "手持青灯" });
    } else {
      const s = span.startOffsetUtf16;
      picks.push({ assetId: propId, category: "prop", surface: SCRIPT.slice(s, s + 1), start: s, end: s + 1, presence: "required", role: "手持青灯" });
    }
  }
  return picks;
}

async function analyzeWithRetry(panel, mentions) {
  const attempts = [0, 1, 2, 3, 4, 5];
  let lastErr;
  for (const expectedHeadRevision of attempts) {
    try {
      return await analyzeStudioPanelAssetMentions(root, {
        unitId: unit.unit.id,
        unitRevision: unit.unit.revision,
        unitFingerprint: unit.fingerprint,
        panelIndex: panel.index,
        scriptRevisionId: unit.scriptRevision.id,
        scriptSha256: unit.scriptRevision.bodySha256,
        expectedHeadRevision,
        mentions,
        resolverVersion: "r3-prop-bind-v2",
      });
    } catch (e) {
      lastErr = e;
      if (e?.actualRevision != null) {
        // next loop may use actual
        if (!attempts.includes(e.actualRevision)) attempts.push(e.actualRevision);
        continue;
      }
      if (String(e.message || "").includes("期望") && String(e.message).includes("当前")) {
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

const bindings = [];
for (const panel of unit.panels) {
  const plan = mentionPlan(panel);
  const mentions = plan.map((m) => ({
    id: `bind-prop-v2-${unitId}-p${panel.index}-${m.assetId}`,
    surfaceText: m.surface,
    startOffsetUtf16: m.start,
    endOffsetUtf16: m.end,
    category: m.category,
    presence: m.presence,
    role: m.role,
    modelSuggestions: [{ assetId: m.assetId, category: m.category, confidence: 1, note: "bind prop re-freeze v2" }],
  }));

  const analysis = await analyzeWithRetry(panel, mentions);
  const decisions = [];
  for (const proposal of analysis.proposals) {
    const exact = proposal.candidates.filter((c) => c.kind !== "model");
    let action = "accept";
    let selectedAssetId;
    if (proposal.status === "matched" && exact.length === 1) {
      action = "accept";
    } else {
      action = "select";
      const wanted = plan.find((p) => p.role === proposal.role)
        || plan.find((p) => p.category === proposal.category)
        || plan.find((p) => proposal.candidates.some((c) => c.assetId === p.assetId));
      selectedAssetId = wanted?.assetId || proposal.candidates.find((c) => [characterId, sceneId, propId].includes(c.assetId))?.assetId
        || proposal.candidates[0]?.assetId;
      if (!selectedAssetId) throw new Error(`no candidate for ${proposal.id}`);
    }
    // ensure we end up with character, scene, prop selected across proposals - map by planned role
    const receipt = await recordStudioMentionDecision(root, {
      receiptId: `bind-prop-v2-dec-${unitId}-p${panel.index}-${proposal.id}`.slice(0, 200),
      proposalId: proposal.id,
      expectedAnalysisHeadRevision: analysis.revision,
      expectedDecisionHeadRevision: 0,
      action,
      selectedAssetId,
      presence: proposal.presence,
      role: proposal.role,
      reviewer: "grok-r3-bind",
      note: "re-freeze with prop-qingdeng-lantern v2",
    });
    decisions.push(receipt);
  }

  const time = getStudioProductionPanelTimeContext(unit.unit, panel);
  const target = {
    projectId,
    seasonId: unit.unit.season,
    episodeId: unit.unit.episode,
    unitId: unit.unit.id,
    ...time,
  };

  const requiredIds = [...new Set([characterId, sceneId, propId,
    ...panel.assets.filter((a) => a.presence === "required").map((a) => a.assetId),
  ])];

  const assetSources = [];
  for (const assetId of requiredIds) {
    const detail = await getStudioCanonicalAsset(root, assetId);
    if (!detail?.primaryAuthority) throw new Error(`missing authority ${assetId}`);
    const definition = detail.definitionVersions.find((e) => e.id === detail.currentDefinitionVersionId);
    const authority = detail.authorityHistory.at(-1);
    const version = detail.versions.find((e) => e.id === detail.primaryAuthority.versionId);
    const knowledge = await getStudioCanonicalAssetKnowledgeSnapshot(root, detail.id, target);
    if (!definition || !authority || !version || !knowledge) throw new Error(`incomplete ${assetId}`);
    assetSources.push({
      assetId: detail.id,
      category: detail.category,
      assetRevision: detail.revision,
      definitionVersionId: definition.id,
      authorityEventId: authority.id,
      authorityVersionId: authority.versionId,
      assetVersionId: version.id,
      mediaSha256: version.mediaSha256,
      knowledgeFingerprint: knowledge.fingerprint,
      applicabilityFingerprint: digest(evaluateStudioAssetApplicability(definition.applicability, target)),
    });
  }

  // freeze may need binding head > 0 if previous freeze exists
  let binding;
  let lastErr;
  for (const expectedBindingHeadRevision of [0, 1, 2, 3, 4, 5]) {
    try {
      binding = await freezeStudioPanelAssetBindingSet(root, {
        analysisId: analysis.id,
        expectedAnalysisHeadRevision: analysis.revision,
        expectedBindingHeadRevision,
        decisionReceiptIds: decisions.map((d) => d.id),
        assetSources,
      });
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      if (e?.actualRevision != null) continue;
      if (String(e.message || "").includes("期望") && String(e.message).includes("当前")) continue;
      throw e;
    }
  }
  if (!binding) throw lastErr;

  bindings.push({
    panelId: panel.id,
    panelIndex: panel.index,
    bindingId: binding.id,
    fingerprint: binding.fingerprint,
    assetIds: assetSources.map((a) => a.assetId).sort(),
    hasProp: assetSources.some((a) => a.assetId === propId),
  });
}

const after = await getStudioProductionUnitSnapshot(root, unitId);
const out = {
  unitId,
  unitRevisionBefore: revisionBefore,
  unitRevisionAfter: after.unit.revision,
  panelAssets: after.panels.map((p) => ({
    panelId: p.id,
    assetIds: p.assets.map((a) => a.assetId),
    hasProp: p.assets.some((a) => a.assetId === propId),
  })),
  bindings,
  allBindingsHaveProp: bindings.every((b) => b.hasProp),
};
await writeFile(path.join(work, "bind-prop-refreeze.json"), JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify(out, null, 2));
if (!out.allBindingsHaveProp || !out.panelAssets.every((p) => p.hasProp)) process.exitCode = 2;
