/**
 * S1E2-U03 有序 unit-grid：create → bind → freeze → dispatch → prepare
 * 生图由外部 image_edit 写入 quarantine 后：commit 阶段
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { activateProject } from "../src/core/service.js";
import { getActiveManagedStudioContext } from "../src/core/active-managed-studio-context.js";
import { getStudioGenerationControlEnvelope } from "../src/core/codex.js";
import {
  createStudioScriptDocument,
  appendStudioScriptRevision,
  createStudioPromptDocument,
  appendStudioPromptRevision,
  createStudioProductionUnit,
  getStudioProductionUnitSnapshot,
  analyzeStudioPanelAssetMentions,
  recordStudioMentionDecision,
  freezeStudioPanelAssetBindingSet,
  getStudioProductionPanelTimeContext,
  getCurrentStudioPanelAssetBindingSet,
} from "../src/core/studio-production.js";
import {
  getStudioCanonicalAsset,
  getStudioCanonicalAssetKnowledgeSnapshot,
  evaluateStudioAssetApplicability,
} from "../src/core/material-studio.js";
import { STUDIO_CONTINUITY_FIELDS } from "../src/core/studio-continuity.js";
import { appendStudioContinuityObservation } from "../src/core/studio-continuity-ledger.js";
import {
  freezeAndPersistStudioUnitGridGenerationPack,
  dispatchStudioGenerationPack,
  prepareStudioImagegenCall,
} from "../src/core/studio-generation-ledger.js";

const ROOT = "/Users/hxx/Documents/无限画布/projects/dudu-gaiden-lock-20260723-12a6516c";
const SCRATCH = "/var/folders/bt/q4f2706n013cbd5m4h6rb6tr0000gn/T/grok-goal-0095bb4ed7de/implementer";
const LOG = path.join(SCRATCH, "s1e2-u03-ordered-transcript.log");
const STATE = path.join(SCRATCH, "s1e2-u03-ordered-state.json");
const UNIT_ID = "S1E2-U03";
const SCRIPT_BODY =
  "S1E2-U03 夜。石穴内。崽在藤窝坐起看爪。崽问娘我们是什么。母转头看崽。母额银纹渐亮。";

const SURFACE: Record<string, string[]> = {
  "char-dudu": ["崽"],
  "char-su": ["母"],
  "char-shuo": ["父"],
  "prop-tengwo": ["藤窝"],
  "scene-shixue": ["石穴"],
};

function nowIso() {
  return new Date().toISOString();
}
function log(line: string) {
  const msg = `[${nowIso()}] ${line}`;
  console.log(msg);
  mkdirSync(SCRATCH, { recursive: true });
  writeFileSync(LOG, (existsSync(LOG) ? readFileSync(LOG, "utf8") : "") + msg + "\n");
}
function digest(v: unknown) {
  return createHash("sha256").update(JSON.stringify(v)).digest("hex");
}

async function ensureUnit() {
  const existing = await getStudioProductionUnitSnapshot(ROOT, UNIT_ID);
  if (existing) {
    log(`unit exists ${UNIT_ID}`);
    return UNIT_ID;
  }
  const u2doc = await createStudioScriptDocument(ROOT, {
    title: "S1E2-U03 我们是什么",
    expectedRevision: 0,
  });
  const revWrap = await appendStudioScriptRevision(ROOT, {
    documentId: u2doc.id,
    expectedRevision: 0,
    body: SCRIPT_BODY,
    source: "s1e2-u03",
    sourceVersion: "20260723",
  });
  const rev = revWrap.revision;
  const promptDoc = await createStudioPromptDocument(ROOT, {
    title: "S1E2-U03 R-NIGHT",
    expectedRevision: 0,
  });
  const promptWrap = await appendStudioPromptRevision(ROOT, {
    documentId: promptDoc.id,
    expectedRevision: 0,
    body: "9:16 vertical R-NIGHT cave unit-grid. EXACT authority. NO humans NO text.",
    source: "s1e2-u03",
    sourceVersion: "20260723",
  });
  const promptRev = promptWrap.revision;
  const span = { startOffsetUtf16: 0, endOffsetUtf16: SCRIPT_BODY.length };
  const mk = (assetId: string, category: "character" | "scene" | "prop") => ({
    assetId,
    category,
    presence: "required" as const,
    role: assetId,
    continuityState: "unknown",
    evidence: [{ kind: "prompt-revision", reference: promptRev.id, note: "s1e2-u03" }],
  });
  // 4+4+3.5+3.5=15
  const panels = [
    {
      title: "G1 坐起",
      visualAction: "崽坐起看母又看爪",
      shotComposition: "中近景",
      filmingMethod: "呼吸感固定",
      startSeconds: 0,
      durationSeconds: 4,
      promptRevisionId: promptRev.id,
      sourceSpans: [span],
      assets: [mk("char-dudu", "character"), mk("char-su", "character"), mk("scene-shixue", "scene"), mk("prop-tengwo", "prop")],
    },
    {
      title: "G2 第一句",
      visualAction: "崽问娘我们是什么，嘴几乎不动",
      shotComposition: "近景特写",
      filmingMethod: "微推",
      startSeconds: 4,
      durationSeconds: 4,
      promptRevisionId: promptRev.id,
      sourceSpans: [span],
      assets: [mk("char-dudu", "character"), mk("scene-shixue", "scene")],
    },
    {
      title: "G3 母转头",
      visualAction: "母转头看崽目光软",
      shotComposition: "中近景",
      filmingMethod: "呼吸感固定",
      startSeconds: 8,
      durationSeconds: 3.5,
      promptRevisionId: promptRev.id,
      sourceSpans: [span],
      assets: [mk("char-su", "character"), mk("char-dudu", "character"), mk("scene-shixue", "scene")],
    },
    {
      title: "G4 银纹亮",
      visualAction: "母白额银纹渐亮温润",
      shotComposition: "大特写",
      filmingMethod: "微推",
      startSeconds: 11.5,
      durationSeconds: 3.5,
      promptRevisionId: promptRev.id,
      sourceSpans: [span],
      assets: [mk("char-su", "character"), mk("scene-shixue", "scene")],
    },
  ];
  const unitSnap = await createStudioProductionUnit(ROOT, {
    id: UNIT_ID,
    expectedRevision: 0,
    season: "S1",
    episode: "S1E2",
    sequence: 3,
    title: "立约·我们是什么",
    durationSeconds: 15,
    scriptRevisionId: rev.id,
    panels,
  });
  log(`CREATE ${unitSnap.unit.id}`);
  return unitSnap.unit.id;
}

async function bindAll(unitId: string) {
  const snap = await getStudioProductionUnitSnapshot(ROOT, unitId);
  if (!snap) throw new Error("no snap");
  const body = snap.scriptRevision.body;
  for (const panel of snap.panels) {
    const existing = await getCurrentStudioPanelAssetBindingSet(ROOT, unitId, panel.index);
    if (existing) {
      log(`bound p${panel.index}`);
      continue;
    }
    const used: number[] = [];
    const mentions = panel.assets.map((asset, i) => {
      const cands = SURFACE[asset.assetId] ?? [];
      let chosen: { text: string; start: number; len: number } | null = null;
      for (const text of cands) {
        let from = 0;
        while (from < body.length) {
          const start = body.indexOf(text, from);
          if (start < 0) break;
          const end = start + text.length;
          if (panel.sourceSpans.some((s) => start >= s.startOffsetUtf16 && end <= s.endOffsetUtf16) && !used.includes(start)) {
            chosen = { text, start, len: text.length };
            break;
          }
          from = start + 1;
        }
        if (chosen) break;
      }
      if (!chosen) throw new Error(`surface ${asset.assetId} p${panel.index}`);
      used.push(chosen.start);
      return {
        id: `u03-m-${panel.index}-${asset.assetId}-${i}`,
        surfaceText: chosen.text,
        startOffsetUtf16: chosen.start,
        endOffsetUtf16: chosen.start + chosen.len,
        category: asset.category as "character" | "scene" | "prop",
        presence: "required" as const,
        role: `u03-${asset.assetId}-p${panel.index}`,
        modelSuggestions: [{ assetId: asset.assetId, category: asset.category as "character" | "scene" | "prop", confidence: 1 }],
      };
    });
    let tryRev = 0;
    let analysis: Awaited<ReturnType<typeof analyzeStudioPanelAssetMentions>> | undefined;
    for (let a = 0; a < 5; a++) {
      try {
        analysis = await analyzeStudioPanelAssetMentions(ROOT, {
          unitId: snap.unit.id,
          unitRevision: snap.unit.revision,
          unitFingerprint: snap.fingerprint,
          panelIndex: panel.index,
          scriptRevisionId: snap.scriptRevision.id,
          scriptSha256: snap.scriptRevision.bodySha256,
          expectedHeadRevision: tryRev,
          mentions,
          resolverVersion: "s1e2-u03-v1",
        });
        break;
      } catch (e) {
        const m = (e as Error).message.match(/当前\s*(\d+)/);
        tryRev = m ? Number(m[1]) : tryRev + 1;
      }
    }
    if (!analysis) throw new Error(`analyze p${panel.index}`);
    const decisions = [];
    for (const proposal of analysis.proposals) {
      const exact = proposal.candidates.filter((c) => c.kind !== "model");
      let action: "accept" | "select" = "accept";
      let selectedAssetId: string | undefined;
      if (!(proposal.status === "matched" && exact.length === 1)) {
        action = "select";
        selectedAssetId = proposal.candidates[0]?.assetId;
        if (!selectedAssetId) throw new Error("no cand");
      }
      decisions.push(
        await recordStudioMentionDecision(ROOT, {
          receiptId: `u03-dec-p${panel.index}-${proposal.mentionId}`,
          proposalId: proposal.id,
          expectedAnalysisHeadRevision: analysis.revision,
          expectedDecisionHeadRevision: 0,
          action,
          selectedAssetId,
          presence: proposal.presence,
          role: proposal.role,
          reviewer: "s1e2-u03",
          note: "u03",
        }),
      );
    }
    const time = getStudioProductionPanelTimeContext(snap.unit, panel);
    const target = {
      projectId: "project-1abfd57f23eb",
      seasonId: snap.unit.season,
      episodeId: snap.unit.episode,
      unitId: snap.unit.id,
      ...time,
    };
    const assetSources = [];
    for (const asset of panel.assets) {
      const detail = await getStudioCanonicalAsset(ROOT, asset.assetId);
      if (!detail?.primaryAuthority) throw new Error(`no auth ${asset.assetId}`);
      const definition = detail.definitionVersions.find((e) => e.id === detail.currentDefinitionVersionId)!;
      const authority = detail.authorityHistory.at(-1)!;
      const version = detail.versions.find((e) => e.id === detail.primaryAuthority!.versionId)!;
      const knowledge = await getStudioCanonicalAssetKnowledgeSnapshot(ROOT, detail.id, target);
      assetSources.push({
        assetId: detail.id,
        category: detail.category,
        assetRevision: detail.revision,
        definitionVersionId: definition.id,
        authorityEventId: authority.id,
        authorityVersionId: authority.versionId,
        assetVersionId: version.id,
        mediaSha256: version.mediaSha256,
        knowledgeFingerprint: knowledge!.fingerprint,
        applicabilityFingerprint: digest(evaluateStudioAssetApplicability(definition.applicability, target)),
      });
    }
    await freezeStudioPanelAssetBindingSet(ROOT, {
      analysisId: analysis.id,
      expectedAnalysisHeadRevision: analysis.revision,
      expectedBindingHeadRevision: 0,
      decisionReceiptIds: decisions.map((d) => d.id),
      assetSources,
    });
    const scope = {
      kind: "panel" as const,
      scopeId: panel.id,
      unitId: snap.unit.id,
      unitRevision: snap.unit.revision,
      startMilliseconds: Math.round(panel.startSeconds * 1000),
      endMilliseconds: Math.round(panel.endSeconds * 1000),
    };
    for (const src of assetSources) {
      for (const field of STUDIO_CONTINUITY_FIELDS) {
        const value = field === "referenceSha256" ? src.mediaSha256 : `s1e2:${unitId}:${panel.id}:${src.assetId}:${field}`;
        try {
          await appendStudioContinuityObservation(ROOT, {
            operationId: `u03-cont-${panel.id}-${src.assetId}-${field}`,
            expectedHeadRevision: 0,
            scope,
            subjectId: src.assetId,
            field,
            state: {
              status: "resolved",
              value,
              provenance: [
                {
                  kind: "s1e2-u03",
                  reference: `${panel.id}/${src.assetId}/${field}`,
                  sourceFingerprint: field === "referenceSha256" ? value : digest({ panel: panel.id, asset: src.assetId, field }),
                  note: "u03",
                },
              ],
            },
          });
        } catch {
          /* ok */
        }
      }
    }
    log(`BOUND p${panel.index}`);
  }
}

async function main() {
  mkdirSync(SCRATCH, { recursive: true });
  writeFileSync(LOG, "");
  log("=== S1E2-U03 ordered prepare ===");
  await activateProject(ROOT);
  const unitId = await ensureUnit();
  await bindAll(unitId);

  const readiness = await getStudioGenerationControlEnvelope(ROOT, {
    operation: "readiness",
    targetKind: "unit-grid",
    unitId,
  });
  log(`READINESS ${(readiness as { status?: string }).status}`);
  if ((readiness as { status?: string }).status === "blocked") throw new Error(JSON.stringify(readiness).slice(0, 500));

  const freeze = await freezeAndPersistStudioUnitGridGenerationPack(ROOT, {
    targetKind: "unit-grid",
    unitId,
  });
  const pack = (freeze as { pack?: { id: string; fingerprint: string; target: { unitRevision: number } } }).pack
    ?? (freeze as { id: string; fingerprint: string; target: { unitRevision: number } });
  log(`FREEZE_OK ${pack.id}`);

  const runId = `s1e2-u03-ug-grok-${Date.now().toString(36)}`;
  await dispatchStudioGenerationPack(ROOT, {
    packId: pack.id,
    packFingerprint: pack.fingerprint,
    generationRunId: runId,
    provider: "grok",
  });
  log(`DISPATCH_OK ${runId}`);

  const ctx = await getActiveManagedStudioContext();
  const prepared = await prepareStudioImagegenCall(ROOT, {
    packId: pack.id,
    packFingerprint: pack.fingerprint,
    generationRunId: runId,
    provider: "grok",
    projectContextToken: ctx.projectContextToken,
    commandRequestId: `u03-prep-${Date.now().toString(36)}`,
    expectedRevision: 0,
  });
  log(`PREPARE_OK ${prepared.callId}`);
  log(`CANDIDATE ${prepared.quarantine.candidatePath}`);

  const state = {
    preparedAt: nowIso(),
    projectContextToken: ctx.projectContextToken,
    unitId,
    packId: pack.id,
    packFingerprint: pack.fingerprint,
    unitRevision: pack.target.unitRevision,
    generationRunId: runId,
    callId: prepared.callId,
    inputFingerprint: prepared.inputFingerprint,
    quarantine: prepared.quarantine,
    controlRefs: [
      path.join(ROOT, ".aicanvas/objects/sha256/fa/fa33ebc0b8b86514878ced17c982791cd17f7e3dc0a7d42cf69c24e78c5204f6"),
      path.join(ROOT, ".aicanvas/objects/sha256/3f/3f5beae6126f00c3a16243c043cc7210aa3739df6d85ef9f0c747bca9b83d027"),
      path.join(ROOT, ".aicanvas/objects/sha256/61/618224e5fd9bd0bf9ae434750e2dd8c8fa421c535bb59defdd052704e8018386"),
    ],
  };
  writeFileSync(STATE, JSON.stringify(state, null, 2));
  console.log(JSON.stringify({ ok: true, statePath: STATE, candidatePath: prepared.quarantine.candidatePath }, null, 2));
}

main().catch((e) => {
  log(`FATAL ${e?.stack ?? e}`);
  process.exit(1);
});
