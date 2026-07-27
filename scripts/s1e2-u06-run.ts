/**
 * S1E2-U06 画卷段有序 unit-grid：create → bind → freeze → dispatch → prepare
 * 生图后：npx tsx scripts/s1e2-commit-prepared-state.ts <state.json>
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
  getStudioMedia,
} from "../src/core/material-studio.js";
import { STUDIO_CONTINUITY_FIELDS } from "../src/core/studio-continuity.js";
import { appendStudioContinuityObservation } from "../src/core/studio-continuity-ledger.js";
import {
  freezeAndPersistStudioUnitGridGenerationPack,
  dispatchStudioGenerationPack,
  prepareStudioImagegenCall,
  readAnyStudioGenerationFrozenPack,
} from "../src/core/studio-generation-ledger.js";

const ROOT = "/Users/hxx/Documents/无限画布/projects/dudu-gaiden-lock-20260723-12a6516c";
const SCRATCH = "/var/folders/bt/q4f2706n013cbd5m4h6rb6tr0000gn/T/grok-goal-0095bb4ed7de/implementer";
const PROD = "/Users/hxx/Documents/无限画布/productions/dudu-gaiden/s1e2-grok-canvas-loop-20260723";
const LOG = path.join(SCRATCH, "s1e2-u06-ordered-transcript.log");
const STATE = path.join(SCRATCH, "s1e2-u06-ordered-state.json");
const UNIT_ID = "S1E2-U06";
const SCRIPT_BODY =
  "S1E2-U06 画卷太古。星河横展。先祖玉狼自星河画成。父踏星河。白额无纹。";

const SURFACE: Record<string, string[]> = {
  "char-shuo": ["父", "先祖"],
  "scene-shixue": ["石穴", "画卷", "太古", "星河"],
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

async function resolveControlLocalPaths(packId: string) {
  const pack = await readAnyStudioGenerationFrozenPack(ROOT, packId);
  if (!pack) throw new Error("pack missing after freeze");
  const refs =
    (pack as { request?: { controlReferences?: Array<{ assetId?: string; mediaSha256: string }> } }).request
      ?.controlReferences
    ?? (pack as { controlReferences?: Array<{ assetId?: string; mediaSha256: string }> }).controlReferences
    ?? [];
  const out: Array<{ assetId?: string; mediaSha256: string; localPath: string }> = [];
  for (const ref of refs) {
    const media = await getStudioMedia(ROOT, ref.mediaSha256);
    if (!media) throw new Error(`media missing ${ref.mediaSha256}`);
    const alt = (media as { objectPath?: string }).objectPath;
    if (alt && existsSync(alt)) {
      out.push({ assetId: ref.assetId, mediaSha256: ref.mediaSha256, localPath: alt });
      continue;
    }
    const localPath = path.join(ROOT, ".aicanvas/objects/sha256", ref.mediaSha256.slice(0, 2), ref.mediaSha256);
    if (!existsSync(localPath)) throw new Error(`CAS path missing for ${ref.mediaSha256}`);
    out.push({ assetId: ref.assetId, mediaSha256: ref.mediaSha256, localPath });
  }
  return out;
}

async function ensureUnit() {
  const existing = await getStudioProductionUnitSnapshot(ROOT, UNIT_ID);
  if (existing) {
    log(`unit exists ${UNIT_ID}`);
    return UNIT_ID;
  }
  const scriptDoc = await createStudioScriptDocument(ROOT, {
    title: "S1E2-U06 太古星河先祖",
    expectedRevision: 0,
  });
  const revWrap = await appendStudioScriptRevision(ROOT, {
    documentId: scriptDoc.id,
    expectedRevision: 0,
    body: SCRIPT_BODY,
    source: "s1e2-u06",
    sourceVersion: "20260723",
  });
  const rev = revWrap.revision;
  const promptDoc = await createStudioPromptDocument(ROOT, {
    title: "S1E2-U06 R-CINE mural",
    expectedRevision: 0,
  });
  const promptWrap = await appendStudioPromptRevision(ROOT, {
    documentId: promptDoc.id,
    expectedRevision: 0,
    body: "9:16 vertical unit-grid FOUR panels top-to-bottom. Ancient Chinese mineral mural style: ochre ground, gold-leaf star river, lapis blue, engraved lines, crackled paint. G1 extreme wide star river scroll empty sky. G2 jade-wolf ancestor drawn from stars white head black body. G3 ancestor walks on star river side silhouette. G4 close white forehead NO marks yet. NO photoreal cave NO humans NO text. EXACT authority for wolf form from char-shuo ref.",
    source: "s1e2-u06",
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
    evidence: [{ kind: "prompt-revision", reference: promptRev.id, note: "s1e2-u06" }],
  });
  // 5+4+3.5+2.5=15
  const panels = [
    {
      title: "G1 星河横展",
      visualAction: "画卷太古整幅壁画横展赭石底金箔星河上缘天外留白",
      shotComposition: "大远景",
      filmingMethod: "水平摇",
      startSeconds: 0,
      durationSeconds: 5,
      promptRevisionId: promptRev.id,
      sourceSpans: [span],
      // 画卷空角色格仍绑定场景资产，避免 empty 控制面分叉
      assets: [mk("scene-shixue", "scene")],
    },
    {
      title: "G2 先祖成形",
      visualAction: "星河间金光聚拢刻线画出白首黑身玉狼先祖轮廓",
      shotComposition: "远景全景",
      filmingMethod: "呼吸感固定",
      startSeconds: 5,
      durationSeconds: 4,
      promptRevisionId: promptRev.id,
      sourceSpans: [span],
      assets: [mk("char-shuo", "character")],
    },
    {
      title: "G3 踏星河",
      visualAction: "先祖踏星河侧影爪落星涟平面波纹",
      shotComposition: "中远景",
      filmingMethod: "横移跟拍",
      startSeconds: 9,
      durationSeconds: 3.5,
      promptRevisionId: promptRev.id,
      sourceSpans: [span],
      assets: [mk("char-shuo", "character")],
    },
    {
      title: "G4 白额无纹",
      visualAction: "先祖白额特写空无一纹星河光淌过",
      shotComposition: "近景特写",
      filmingMethod: "微推",
      startSeconds: 12.5,
      durationSeconds: 2.5,
      promptRevisionId: promptRev.id,
      sourceSpans: [span],
      assets: [mk("char-shuo", "character")],
    },
  ];
  const unitSnap = await createStudioProductionUnit(ROOT, {
    id: UNIT_ID,
    expectedRevision: 0,
    season: "S1",
    episode: "S1E2",
    sequence: 6,
    title: "立约·太古星河先祖",
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
    if (existing) log(`rebind p${panel.index}`);

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
            if (!used.includes(start)) {
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
          id: `u06-m-${panel.index}-${asset.assetId}-${i}-${attempt}`,
          surfaceText: chosen.text,
          startOffsetUtf16: chosen.start,
          endOffsetUtf16: chosen.start + chosen.len,
          category: asset.category as "character" | "scene" | "prop",
          presence: "required" as const,
          role: `u06-${asset.assetId}-p${panel.index}-${attempt}`,
          modelSuggestions: [{ assetId: asset.assetId, category: asset.category as "character" | "scene" | "prop", confidence: 1 }],
        };
      });
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
          resolverVersion: `s1e2-u06-${attempt}`,
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
          decisions.push(
            await recordStudioMentionDecision(ROOT, {
              receiptId: `u06-dec-p${panel.index}-${proposal.mentionId}-${attempt}`,
              proposalId: proposal.id,
              expectedAnalysisHeadRevision: analysis.revision,
              expectedDecisionHeadRevision: 0,
              action,
              selectedAssetId,
              presence: proposal.presence,
              role: proposal.role,
              reviewer: "s1e2-u06",
              note: "u06",
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
        assetSources = [];
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
        break;
      } catch (e) {
        lastErr = (e as Error).message;
        analysis = undefined;
        const m = lastErr.match(/当前\s*(\d+)/);
        if (m) tryRev = Number(m[1]);
        else tryRev += 1;
      }
    }
    if (!analysis) throw new Error(`analyze p${panel.index}: ${lastErr.slice(0, 200)}`);
    let bindHead = 0;
    for (let b = 0; b < 4; b++) {
      try {
        await freezeStudioPanelAssetBindingSet(ROOT, {
          analysisId: analysis.id,
          expectedAnalysisHeadRevision: analysis.revision,
          expectedBindingHeadRevision: bindHead,
          decisionReceiptIds: decisions.map((d) => d.id),
          assetSources: assetSources as any,
        });
        break;
      } catch (e) {
        const msg = (e as Error).message;
        const m = msg.match(/当前\s*(\d+)/);
        if (m) bindHead = Number(m[1]);
        else throw e;
        if (b === 3) throw e;
      }
    }
    const scope = {
      kind: "panel" as const,
      scopeId: panel.id,
      unitId: snap.unit.id,
      unitRevision: snap.unit.revision,
      startMilliseconds: Math.round(panel.startSeconds * 1000),
      endMilliseconds: Math.round(panel.endSeconds * 1000),
    };
    for (const src of assetSources as Array<{ assetId: string; mediaSha256: string }>) {
      for (const field of STUDIO_CONTINUITY_FIELDS) {
        const value = field === "referenceSha256" ? src.mediaSha256 : `s1e2:${unitId}:${panel.id}:${src.assetId}:${field}`;
        try {
          await appendStudioContinuityObservation(ROOT, {
            operationId: `u06-cont-${panel.id}-${src.assetId}-${field}`,
            expectedHeadRevision: 0,
            scope,
            subjectId: src.assetId,
            field,
            state: {
              status: "resolved",
              value,
              provenance: [
                {
                  kind: "s1e2-u06",
                  reference: `${panel.id}/${src.assetId}/${field}`,
                  sourceFingerprint: field === "referenceSha256" ? value : digest({ panel: panel.id, asset: src.assetId, field }),
                  note: "u06-mural",
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
  log("=== S1E2-U06 ordered prepare (mural) ===");
  await activateProject(ROOT);
  const unitId = await ensureUnit();
  await bindAll(unitId);

  const readiness = await getStudioGenerationControlEnvelope(ROOT, {
    operation: "readiness",
    targetKind: "unit-grid",
    unitId,
  });
  log(`READINESS ${(readiness as { status?: string }).status}`);
  if ((readiness as { status?: string }).status === "blocked") {
    throw new Error(JSON.stringify(readiness).slice(0, 800));
  }

  const freeze = await freezeAndPersistStudioUnitGridGenerationPack(ROOT, {
    targetKind: "unit-grid",
    unitId,
  });
  const pack = (freeze as { pack?: { id: string; fingerprint: string; target: { unitRevision: number } } }).pack
    ?? (freeze as unknown as { id: string; fingerprint: string; target: { unitRevision: number } });
  // normalize pack id from freeze result shapes
  const packId = (freeze as any).pack?.id ?? (freeze as any).id ?? pack.id;
  const packFingerprint = (freeze as any).pack?.fingerprint ?? (freeze as any).fingerprint ?? pack.fingerprint;
  const unitRevision = (freeze as any).pack?.target?.unitRevision ?? (freeze as any).target?.unitRevision ?? 1;
  if (!packId || !packFingerprint) throw new Error(`freeze missing ids ${JSON.stringify(freeze).slice(0, 400)}`);
  log(`FREEZE_OK ${packId}`);

  const controlRefs = await resolveControlLocalPaths(packId);
  log(`CONTROL_REFS count=${controlRefs.length}`);

  const runId = `s1e2-u06-ug-grok-${Date.now().toString(36)}`;
  await dispatchStudioGenerationPack(ROOT, {
    packId,
    packFingerprint,
    generationRunId: runId,
    provider: "grok",
  });
  log(`DISPATCH_OK ${runId}`);

  const ctx = await getActiveManagedStudioContext();
  const prepared = await prepareStudioImagegenCall(ROOT, {
    packId,
    packFingerprint,
    generationRunId: runId,
    provider: "grok",
    projectContextToken: ctx.projectContextToken,
    commandRequestId: `u06-prep-${Date.now().toString(36)}`,
    expectedRevision: 0,
  });
  log(`PREPARE_OK ${prepared.callId}`);
  log(`CANDIDATE ${prepared.quarantine.candidatePath}`);

  const state = {
    preparedAt: nowIso(),
    projectRoot: ROOT,
    projectContextToken: ctx.projectContextToken,
    unitId,
    packId,
    packFingerprint,
    unitRevision,
    generationRunId: runId,
    callId: prepared.callId,
    inputFingerprint: prepared.inputFingerprint,
    quarantine: prepared.quarantine,
    controlRefs,
    candidateOut: path.join(PROD, "02_candidates/S1E2-U06_4格_A1_CANDIDATE.jpg"),
    reportOut: path.join(PROD, "05_canvas/s1e2-u06-symbiosis-report.json"),
    order: ["readiness", "freeze", "dispatch", "prepare", "generate", "commit"],
  };
  writeFileSync(STATE, JSON.stringify(state, null, 2));
  console.log(JSON.stringify({
    ok: true,
    statePath: STATE,
    candidatePath: prepared.quarantine.candidatePath,
    controlRefs: controlRefs.map((r) => ({ assetId: r.assetId, mediaSha256: r.mediaSha256, localPath: r.localPath })),
  }, null, 2));
}

main().catch((e) => {
  log(`FATAL ${e?.stack ?? e}`);
  process.exit(1);
});
