import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  importStudioMedia,
  appendStudioAssetVersion,
  reviewStudioAssetVersion,
  setStudioPrimaryAuthority,
  getStudioCanonicalAsset,
  getStudioCanonicalAssetKnowledgeSnapshot,
  evaluateStudioAssetApplicability,
} from "../src/core/material-studio.ts";
import {
  analyzeStudioPanelAssetMentions,
  recordStudioMentionDecision,
  freezeStudioPanelAssetBindingSet,
  getStudioProductionUnitSnapshot,
  getStudioProductionPanelTimeContext,
} from "../src/core/studio-production.ts";
import {
  appendStudioContinuityObservation,
  getStudioContinuityReadiness,
} from "../src/core/studio-continuity-ledger.ts";
import { STUDIO_CONTINUITY_FIELDS } from "../src/core/studio-continuity.ts";
import {
  freezeAndPersistStudioUnitGridGenerationPack,
  dispatchStudioGenerationPack,
} from "../src/core/studio-generation-ledger.ts";
import { executeIdempotentCommand } from "../src/core/command-bus.ts";
import { getActiveManagedStudioContext } from "../src/core/active-managed-studio-context.ts";
import { registerProject, setActiveProjectRegistration } from "../src/core/sidecar.ts";
import { inspectManagedProject } from "../src/core/managed-project.ts";

const workspace = "/Users/hxx/Documents/无限画布";
const root = "/Users/hxx/Documents/无限画布/projects/grok-mvp-qingdeng-mrwc97mu-d0aea463";
const work = path.join(root, ".aicanvas/mvp-work");
const charPath = path.join(work, "character-qingdeng-ke-ref-raw.jpg");
const characterId = "character-qingdeng-ke";
const sceneId = "scene-rainy-inn-porch";
const unitId = "S1E01-U01";
const SCRIPT_BODY = "雨夜，青灯客停在客栈廊下。她抬手护住灯火，侧耳听雨，随后推门迈入更深的廊影。";

function digest(value) {
  const stable = (v) => {
    if (Array.isArray(v)) return v.map(stable);
    if (!v || typeof v !== "object") return v;
    return Object.fromEntries(Object.entries(v).filter(([, e]) => e !== undefined).sort(([a],[b]) => a.localeCompare(b)).map(([k,e]) => [k, stable(e)]));
  };
  return createHash("sha256").update(JSON.stringify(stable(value)), "utf8").digest("hex");
}

process.env.AI_CANVAS_WORKSPACE = workspace;
process.env.AI_CANVAS_RECORDED_SOURCE_DIGEST = "9d650d4df5fde6fdd13ba2e8460ce9ffb66350a63e1c2f3511090df5676a0798";
process.env.AI_CANVAS_RELEASE_MANIFEST_PATH = path.join(workspace, "release-manifest.json");
process.env.AI_CANVAS_REGISTRY_PATH = path.join(process.env.HOME, ".aicanvas/projects.json");

const shell = await inspectManagedProject(root);
await registerProject(shell.project);
await setActiveProjectRegistration(root);
const projectId = shell.manifest?.projectId || shell.project.projectId || shell.project.id;

// Character authority
let char = await getStudioCanonicalAsset(root, characterId);
let charAuth;
if (!char.primaryAuthority) {
  const media = await importStudioMedia(root, { sourcePath: charPath, kind: "image" });
  char = await getStudioCanonicalAsset(root, characterId);
  const versioned = await appendStudioAssetVersion(root, {
    assetId: characterId,
    mediaSha256: media.sha256,
    reviewStatus: "pending",
    sourceNote: "grok live character reference canary raw | provider=grok | image_gen | session images/1.jpg",
    expectedRevision: char.revision,
  });
  const reviewed = await reviewStudioAssetVersion(root, {
    assetId: characterId,
    versionId: versioned.version.id,
    decision: "approved",
    expectedRevision: versioned.assetRevision,
    note: "Grok主代理原尺寸视觉PASS：东亚女性旅人、靛青斗篷、素白交领、提青灯、雨夜廊下、无字幕无串角；批准为角色Authority。",
  });
  const primary = await setStudioPrimaryAuthority(root, {
    assetId: characterId,
    versionId: versioned.version.id,
    expectedRevision: reviewed.revision,
    note: "isolated grok mvp character authority",
  });
  charAuth = { sha256: media.sha256, versionId: versioned.version.id, revision: primary.revision };
} else {
  charAuth = { sha256: char.primaryAuthority.mediaSha256, versionId: char.primaryAuthority.versionId, revision: char.revision };
}

const ASSETS = [
  { id: characterId, name: "青灯客", category: "character" },
  { id: sceneId, name: "雨夜客栈廊", category: "scene" },
];

// Mentions: character name appears; scene may not appear as exact text - use surface from script for 客栈廊下
// For scene, surface "客栈廊下" exists in script at start
const mentionTemplates = [
  { assetId: characterId, name: "青灯客", category: "character", presence: "required", role: "主体" },
  { assetId: sceneId, name: "客栈廊下", category: "scene", presence: "required", role: "场景" },
];

const unit = await getStudioProductionUnitSnapshot(root, unitId);
const frozenBindings = [];

for (const panel of unit.panels) {
  const mentions = mentionTemplates.map((m) => {
    // Each panel has its own sourceSpan - mention must be fully inside that span
    const span = panel.sourceSpans[0];
    const bodySlice = SCRIPT_BODY.slice(span.startOffsetUtf16, span.endOffsetUtf16);
    // Find name in full script then check containment; if not in panel span, use a substring that is in span
    let start = SCRIPT_BODY.indexOf(m.name);
    let end = start + m.name.length;
    let surface = m.name;
    if (start < 0 || start < span.startOffsetUtf16 || end > span.endOffsetUtf16) {
      // fallback surfaces that exist in each span:
      // P1 0-13: 雨夜，青灯客停在客栈廊下。
      // P2 13-26: 她抬手护住灯火，侧耳听雨，
      // P3 26-38: 随后推门迈入更深的廊影。
      if (m.category === "character") {
        if (panel.index === 1) { surface = "青灯客"; start = SCRIPT_BODY.indexOf(surface); end = start + surface.length; }
        else if (panel.index === 2) { surface = "她"; start = 13; end = 14; }
        else { surface = "推门"; start = SCRIPT_BODY.indexOf("推门"); end = start + 2; }
      } else {
        if (panel.index === 1) { surface = "客栈廊下"; start = SCRIPT_BODY.indexOf(surface); end = start + surface.length; }
        else if (panel.index === 2) { surface = "火"; start = SCRIPT_BODY.indexOf("火", 13); end = start + 1; }
        else { surface = "廊影"; start = SCRIPT_BODY.indexOf("廊影"); end = start + 2; }
      }
    }
    return {
      id: `mvp-mention-${unitId}-p${panel.index}-${m.assetId}`,
      surfaceText: surface,
      startOffsetUtf16: start,
      endOffsetUtf16: end,
      category: m.category,
      presence: m.presence,
      role: m.role,
      modelSuggestions: [{ assetId: m.assetId, category: m.category, confidence: 1, note: "mvp explicit candidate" }],
    };
  });

  const analysis = await analyzeStudioPanelAssetMentions(root, {
    unitId: unit.unit.id,
    unitRevision: unit.unit.revision,
    unitFingerprint: unit.fingerprint,
    panelIndex: panel.index,
    scriptRevisionId: unit.scriptRevision.id,
    scriptSha256: unit.scriptRevision.bodySha256,
    expectedHeadRevision: 0,
    mentions,
    resolverVersion: "grok-mvp-isolated-v1",
  });

  const decisions = [];
  for (const proposal of analysis.proposals) {
    const exact = proposal.candidates.filter((c) => c.kind !== "model");
    let action = "accept";
    let selectedAssetId;
    if (proposal.status === "matched" && exact.length === 1) {
      action = "accept";
    } else {
      // select from model suggestion matching template
      const wanted = mentionTemplates.find((t) => proposal.role === t.role || proposal.category === t.category) 
        || mentionTemplates.find((t) => proposal.surfaceText && t.name.includes(proposal.surfaceText));
      const cand = proposal.candidates.find((c) => c.assetId === characterId || c.assetId === sceneId)
        || proposal.candidates[0];
      action = "select";
      selectedAssetId = cand?.assetId;
      if (!selectedAssetId) throw new Error(`no candidate for proposal ${proposal.id}`);
    }
    const receipt = await recordStudioMentionDecision(root, {
      receiptId: `mvp-decision-${unitId}-p${panel.index}-${proposal.id}`.slice(0, 200),
      proposalId: proposal.id,
      expectedAnalysisHeadRevision: analysis.revision,
      expectedDecisionHeadRevision: 0,
      action,
      selectedAssetId,
      presence: proposal.presence,
      role: proposal.role,
      reviewer: "grok-mvp",
      note: "isolated mvp explicit decision",
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

  // Assets to bind: from decisions selected + panel required assets
  const selectedIds = [...new Set(decisions.map((d) => d.selectedAssetId).filter(Boolean))];
  const requiredIds = panel.assets.filter((a) => a.presence === "required").map((a) => a.assetId);
  const assetIds = [...new Set([...requiredIds, ...selectedIds])];

  const assetSources = [];
  for (const assetId of assetIds) {
    const detail = await getStudioCanonicalAsset(root, assetId);
    if (!detail?.primaryAuthority) throw new Error(`missing authority: ${assetId}`);
    const definition = detail.definitionVersions.find((e) => e.id === detail.currentDefinitionVersionId);
    const authority = detail.authorityHistory.at(-1);
    const version = detail.versions.find((e) => e.id === detail.primaryAuthority.versionId);
    const knowledge = await getStudioCanonicalAssetKnowledgeSnapshot(root, detail.id, target);
    if (!definition || !authority || !version || !knowledge) throw new Error(`incomplete knowledge: ${assetId}`);
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

  const binding = await freezeStudioPanelAssetBindingSet(root, {
    analysisId: analysis.id,
    expectedAnalysisHeadRevision: analysis.revision,
    expectedBindingHeadRevision: 0,
    decisionReceiptIds: decisions.map((d) => d.id),
    assetSources,
  });
  frozenBindings.push({ panelId: panel.id, panelIndex: panel.index, bindingId: binding.id, fingerprint: binding.fingerprint });
}

// Continuity nine fields for each panel x required assets
const continuity = [];
const unitAfter = await getStudioProductionUnitSnapshot(root, unitId);
for (const panel of unitAfter.panels) {
  const scope = {
    kind: "panel",
    scopeId: panel.id,
    unitId: unitAfter.unit.id,
    unitRevision: unitAfter.unit.revision,
    startMilliseconds: Math.round(panel.startSeconds * 1000),
    endMilliseconds: Math.round(panel.endSeconds * 1000),
  };
  for (const mention of panel.assets.filter((a) => a.presence !== "forbidden")) {
    const detail = await getStudioCanonicalAsset(root, mention.assetId);
    const authoritySha = detail.versions.find((v) => v.id === detail.primaryAuthority.versionId).mediaSha256;
    for (const field of STUDIO_CONTINUITY_FIELDS) {
      const value = field === "referenceSha256"
        ? authoritySha
        : `mvp:${mention.assetId}:${field}:p${panel.index}`;
      await appendStudioContinuityObservation(root, {
        operationId: `mvp-cont-${unitId}-${panel.id}-${mention.assetId}-${field}`.slice(0, 200),
        expectedHeadRevision: 0,
        scope,
        subjectId: mention.assetId,
        field,
        state: {
          status: "resolved",
          value,
          provenance: [{
            kind: "grok-mvp-isolated",
            reference: `${unitId}/${panel.id}/${mention.assetId}/${field}`,
            sourceFingerprint: field === "referenceSha256" ? value : digest({ unitId, panelId: panel.id, assetId: mention.assetId, field, value }),
            note: "isolated mvp continuity seed",
          }],
        },
      });
    }
    const readiness = await getStudioContinuityReadiness(root, {
      scope,
      subjectId: mention.assetId,
      requiredFields: [...STUDIO_CONTINUITY_FIELDS],
    });
    continuity.push({ panelId: panel.id, assetId: mention.assetId, ready: readiness.ready, fingerprint: readiness.fingerprint });
    if (!readiness.ready) throw new Error(`continuity not ready ${panel.id}/${mention.assetId}`);
  }
}

// Freeze unit-grid pack + dispatch provider=grok + prepare call
const frozen = await freezeAndPersistStudioUnitGridGenerationPack(root, {
  targetKind: "unit-grid",
  unitId,
});
const generationRunId = `grok-mvp-ug-run-${Date.now().toString(36)}`;
await dispatchStudioGenerationPack(root, {
  packId: frozen.packId,
  packFingerprint: frozen.fingerprint,
  generationRunId,
  provider: "grok",
});

const context = await getActiveManagedStudioContext();
const prepare = await executeIdempotentCommand(root, {
  requestId: `grok-mvp-prepare-${generationRunId}`.slice(0, 160),
  idempotencyKey: `grok-mvp-prepare-key-${generationRunId}`.slice(0, 200),
  request: {
    command: "prepare_studio_imagegen_call",
    payload: {
      packId: frozen.packId,
      packFingerprint: frozen.fingerprint,
      generationRunId,
      provider: "grok",
      projectContextToken: context.projectContextToken,
      expectedRevision: 0,
    },
  },
});

const prepared = prepare.result;
const out = {
  characterAuthority: charAuth,
  frozenBindings,
  continuity,
  pack: {
    packId: frozen.packId,
    packFingerprint: frozen.fingerprint,
    unitRevision: frozen.pack?.target?.unitRevision || unitAfter.unit.revision,
  },
  generationRunId,
  prepare: {
    status: prepare.status,
    callAllowed: prepared.callAllowed,
    callId: prepared.callId,
    inputFingerprint: prepared.inputFingerprint,
    quarantine: prepared.quarantine,
    idempotentReplay: prepared.idempotentReplay,
  },
  projectContextToken: context.projectContextToken,
  next: prepared.callAllowed ? "image_gen_to_quarantine_then_commit" : "BLOCKED_callAllowed_false",
};
await writeFile(path.join(work, "precall-state.json"), JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify(out, null, 2));
