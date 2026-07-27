/**
 * S1E2-U22 崽问题出口·洞无声 — create→bind only
 * 后续：npx tsx scripts/s1e2-mcp-only-runner.ts prepare --unit S1E2-U22
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { activateProject } from "../src/core/service.js";
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
} from "../src/core/studio-production.js";
import {
  getStudioCanonicalAsset,
  getStudioCanonicalAssetKnowledgeSnapshot,
  evaluateStudioAssetApplicability,
} from "../src/core/material-studio.js";
import { STUDIO_CONTINUITY_FIELDS } from "../src/core/studio-continuity.js";
import { appendStudioContinuityObservation } from "../src/core/studio-continuity-ledger.js";
import { getStudioGenerationCheckpointControl } from "../src/core/studio-generation-checkpoint.js";

const ROOT = "/Users/hxx/Documents/无限画布/projects/dudu-gaiden-lock-20260723-12a6516c";
const PROD = "/Users/hxx/Documents/无限画布/productions/dudu-gaiden/s1e2-grok-canvas-loop-20260723";
const SCRATCH = path.join(PROD, "05_canvas/_scratch");
const LOG = path.join(SCRATCH, "s1e2-u22-ordered-transcript.log");
const UNIT_ID = "S1E2-U22";
const SCRIPT_BODY =
  "S1E2-U22 洞内崽抬头问出口。石穴岩壁无回声。母不答静。洞里没有声音。";

const SURFACE: Record<string, string[]> = {
  "scene-shixue": ["洞内", "石穴", "岩壁", "洞里"],
  "char-dudu": ["崽"],
  "char-su": ["母"],
};

function nowIso() { return new Date().toISOString(); }
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
  if (existing) { log(`unit exists ${UNIT_ID} rev=${existing.unit.revision}`); return UNIT_ID; }
  const scriptDoc = await createStudioScriptDocument(ROOT, { title: "S1E2-U22 问题出口·无声", expectedRevision: 0 });
  const revWrap = await appendStudioScriptRevision(ROOT, {
    documentId: scriptDoc.id, expectedRevision: 0, body: SCRIPT_BODY, source: "s1e2-u22", sourceVersion: "20260723",
  });
  const rev = revWrap.revision;
  const promptDoc = await createStudioPromptDocument(ROOT, {
    title: "S1E2-U22 R-CINE cub question silence cave",
    expectedRevision: 0,
  });
  const promptWrap = await appendStudioPromptRevision(ROOT, {
    documentId: promptDoc.id, expectedRevision: 0,
    body: "9:16 vertical FOUR panels pure mineral mural fresco lapis gold. Silent unit zero dialogue text. G1 medium REAL cave: white-headed black cub pup looks up mouth open as if asking, eyes bright, stone cave background. G2 close-up: cub face and ear tips waiting for answer, cave wall behind. G3 medium: mother wolf still silent, no mouth move, cub small against her. G4 wide: empty cave air, only rock and faint residual gold dust, absolute silence, no echo lines. NO humans faces NO text. Photoreal forbidden. Lock identities from control refs when present.",
    source: "s1e2-u22", sourceVersion: "20260724",
  });
  const promptRev = promptWrap.revision;
  const span = { startOffsetUtf16: 0, endOffsetUtf16: SCRIPT_BODY.length };
  const mk = (assetId: string, category: "character" | "scene" | "prop") => ({
    assetId, category, presence: "required" as const, role: assetId, continuityState: "unknown",
    evidence: [{ kind: "prompt-revision", reference: promptRev.id, note: "s1e2-u22" }],
  });
  // 4+4+2.5+4.5=15
  // 4+3.5+3.5+4=15
  const panels = [
    {
      title: "G1 问出口", visualAction: "洞内崽抬头问出口",
      shotComposition: "中景", filmingMethod: "微推",
      startSeconds: 0, durationSeconds: 4, promptRevisionId: promptRev.id, sourceSpans: [span],
      assets: [mk("scene-shixue", "scene"), mk("char-dudu", "character")],
    },
    {
      title: "G2 等回声", visualAction: "石穴岩壁无回声",
      shotComposition: "近景", filmingMethod: "呼吸感固定",
      startSeconds: 4, durationSeconds: 3.5, promptRevisionId: promptRev.id, sourceSpans: [span],
      assets: [mk("scene-shixue", "scene"), mk("char-dudu", "character")],
    },
    {
      title: "G3 母不答", visualAction: "母不答静崽贴侧",
      shotComposition: "中近景", filmingMethod: "呼吸感固定",
      startSeconds: 7.5, durationSeconds: 3.5, promptRevisionId: promptRev.id, sourceSpans: [span],
      assets: [mk("scene-shixue", "scene"), mk("char-dudu", "character"), mk("char-su", "character")],
    },
    {
      title: "G4 洞无声", visualAction: "洞里没有声音空",
      shotComposition: "远景", filmingMethod: "缓拉",
      startSeconds: 11, durationSeconds: 4, promptRevisionId: promptRev.id, sourceSpans: [span],
      assets: [mk("scene-shixue", "scene")],
    },
  ];
  const unitSnap = await createStudioProductionUnit(ROOT, {
    id: UNIT_ID, expectedRevision: 0, season: "S1", episode: "S1E2", sequence: 22,
    title: "场5·问题出口·无声", durationSeconds: 15, scriptRevisionId: rev.id, panels,
  });
  log(`CREATE ${unitSnap.unit.id}`);
  return unitSnap.unit.id;
}

async function bindAll(unitId: string) {
  const snap = await getStudioProductionUnitSnapshot(ROOT, unitId);
  if (!snap) throw new Error("no snap");
  const body = snap.scriptRevision.body;
  for (const panel of snap.panels) {
    let analysis: Awaited<ReturnType<typeof analyzeStudioPanelAssetMentions>> | undefined;
    let lastErr = "";
    let tryRev = 0;
    let decisions: Awaited<ReturnType<typeof recordStudioMentionDecision>>[] = [];
    let assetSources: unknown[] = [];
    for (let attempt = 0; attempt < 8; attempt++) {
      const used: number[] = [];
      const mentions = panel.assets.map((asset, i) => {
        const surfaces = SURFACE[asset.assetId] ?? [asset.assetId];
        let chosen: { text: string; start: number; len: number } | undefined;
        for (const text of surfaces) {
          let from = 0;
          while (from <= body.length) {
            const start = body.indexOf(text, from);
            if (start < 0) break;
            if (!used.includes(start)) { chosen = { text, start, len: text.length }; break; }
            from = start + 1;
          }
          if (chosen) break;
        }
        if (!chosen) throw new Error(`surface ${asset.assetId} p${panel.index}`);
        used.push(chosen.start);
        return {
          id: `u22-m-${panel.index}-${asset.assetId}-${i}-${attempt}`,
          surfaceText: chosen.text,
          startOffsetUtf16: chosen.start,
          endOffsetUtf16: chosen.start + chosen.len,
          category: asset.category as "character" | "scene" | "prop",
          presence: "required" as const,
          role: `u22-${asset.assetId}-p${panel.index}-${attempt}`,
          modelSuggestions: [{ assetId: asset.assetId, category: asset.category as "character" | "scene" | "prop", confidence: 1 }],
        };
      });
      try {
        analysis = await analyzeStudioPanelAssetMentions(ROOT, {
          unitId: snap.unit.id, unitRevision: snap.unit.revision, unitFingerprint: snap.fingerprint,
          panelIndex: panel.index, scriptRevisionId: snap.scriptRevision.id, scriptSha256: snap.scriptRevision.bodySha256,
          expectedHeadRevision: tryRev, mentions, resolverVersion: `s1e2-u22-${attempt}`,
        });
        decisions = [];
        for (const proposal of analysis.proposals) {
          const exact = proposal.candidates.filter((c) => c.kind !== "model");
          let action: "accept" | "select" = "accept";
          let selectedAssetId: string | undefined;
          if (!(proposal.status === "matched" && exact.length === 1)) {
            action = "select";
            selectedAssetId = proposal.candidates[0]?.assetId;
            if (!selectedAssetId) throw new Error("no cand");
          }
          decisions.push(await recordStudioMentionDecision(ROOT, {
            receiptId: `u22-dec-p${panel.index}-${proposal.mentionId}-${attempt}`,
            proposalId: proposal.id, expectedAnalysisHeadRevision: analysis.revision, expectedDecisionHeadRevision: 0,
            action, selectedAssetId, presence: proposal.presence, role: proposal.role, reviewer: "s1e2-u22", note: "u22",
          }));
        }
        const time = getStudioProductionPanelTimeContext(snap.unit, panel);
        const target = { projectId: "project-1abfd57f23eb", seasonId: snap.unit.season, episodeId: snap.unit.episode, unitId: snap.unit.id, ...time };
        assetSources = [];
        for (const asset of panel.assets) {
          const detail = await getStudioCanonicalAsset(ROOT, asset.assetId);
          if (!detail?.primaryAuthority) throw new Error(`no auth ${asset.assetId}`);
          const definition = detail.definitionVersions.find((e) => e.id === detail.currentDefinitionVersionId)!;
          const authority = detail.authorityHistory.at(-1)!;
          const version = detail.versions.find((e) => e.id === detail.primaryAuthority!.versionId)!;
          const knowledge = await getStudioCanonicalAssetKnowledgeSnapshot(ROOT, detail.id, target);
          assetSources.push({
            assetId: detail.id, category: detail.category, assetRevision: detail.revision,
            definitionVersionId: definition.id, authorityEventId: authority.id, authorityVersionId: authority.versionId,
            assetVersionId: version.id, mediaSha256: version.mediaSha256,
            knowledgeFingerprint: knowledge!.fingerprint,
            applicabilityFingerprint: digest(evaluateStudioAssetApplicability(definition.applicability, target)),
          });
        }
        break;
      } catch (e) {
        lastErr = (e as Error).message;
        analysis = undefined;
        const m = lastErr.match(/当前\s*(\d+)/);
        if (m) tryRev = Number(m[1]); else tryRev += 1;
      }
    }
    if (!analysis) throw new Error(`analyze p${panel.index}: ${lastErr.slice(0, 200)}`);
    let bindHead = 0;
    for (let b = 0; b < 4; b++) {
      try {
        await freezeStudioPanelAssetBindingSet(ROOT, {
          analysisId: analysis.id, expectedAnalysisHeadRevision: analysis.revision, expectedBindingHeadRevision: bindHead,
          decisionReceiptIds: decisions.map((d) => d.id), assetSources: assetSources as any,
        });
        break;
      } catch (e) {
        const msg = (e as Error).message;
        const m = msg.match(/当前\s*(\d+)/);
        if (m) bindHead = Number(m[1]); else throw e;
        if (b === 3) throw e;
      }
    }
    const scope = {
      kind: "panel" as const, scopeId: panel.id, unitId: snap.unit.id, unitRevision: snap.unit.revision,
      startMilliseconds: Math.round(panel.startSeconds * 1000),
      endMilliseconds: Math.round((panel as any).endMilliseconds ?? panel.endSeconds * 1000),
    };
    for (const src of assetSources as Array<{ assetId: string; mediaSha256: string }>) {
      for (const field of STUDIO_CONTINUITY_FIELDS) {
        const value = field === "referenceSha256" ? src.mediaSha256 : `s1e2:${unitId}:${panel.id}:${src.assetId}:${field}`;
        try {
          await appendStudioContinuityObservation(ROOT, {
            operationId: `u22-cont-${panel.id}-${src.assetId}-${field}`, expectedHeadRevision: 0, scope,
            subjectId: src.assetId, field,
            state: {
              status: "resolved", value,
              provenance: [{
                kind: "s1e2-u22", reference: `${panel.id}/${src.assetId}/${field}`,
                sourceFingerprint: field === "referenceSha256" ? value : digest({ panel: panel.id, asset: src.assetId, field }),
                note: "u22",
              }],
            },
          });
        } catch { /* ok */ }
      }
    }
    log(`BOUND p${panel.index}`);
  }
}

async function main() {
  mkdirSync(SCRATCH, { recursive: true });
  writeFileSync(LOG, "");
  log("=== S1E2-U22 create+bind ===");
  await activateProject(ROOT);
  const gate = await getStudioGenerationCheckpointControl(ROOT);
  log(`GATE allowed=${(gate as any).newSlotDispatchAllowed}`);
  if ((gate as any).newSlotDispatchAllowed === false) throw new Error("six-image gate blocked");
  const unitId = await ensureUnit();
  await bindAll(unitId);
  log(`BIND_OK ${unitId}`);
  console.log(JSON.stringify({ ok: true, unitId }, null, 2));
}

main().catch((e) => {
  log(`FATAL ${e?.stack ?? e}`);
  process.exit(1);
});
