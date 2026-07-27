/**
 * S1E2-U13 场3 天缺/破格 — create→bind→freeze→dispatch→prepare
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
import { getStudioGenerationCheckpointControl } from "../src/core/studio-generation-checkpoint.js";

const ROOT = "/Users/hxx/Documents/无限画布/projects/dudu-gaiden-lock-20260723-12a6516c";
const PROD = "/Users/hxx/Documents/无限画布/productions/dudu-gaiden/s1e2-grok-canvas-loop-20260723";
const SCRATCH = path.join(PROD, "05_canvas/_scratch");
const LOG = path.join(SCRATCH, "s1e2-u13-ordered-transcript.log");
const STATE = path.join(SCRATCH, "s1e2-u13-ordered-state.json");
const UNIT_ID = "S1E2-U13";
const SCRIPT_BODY =
  "S1E2-U13 画卷天空右上缺一块纯黑齿痕。星辰滑灭。天狗纹光齐仰天缺。黑漫出画幅触石穴洞壁。母与崽剪影。";

const SURFACE: Record<string, string[]> = {
  "scene-shixue": ["石穴", "画卷", "天空", "天缺", "洞壁"],
  // 兼容首版文案「母子剪影」：母子/剪影分给崽/母，避免同 offset 占用
  "char-dudu": ["崽", "母子"],
  "char-su": ["母", "剪影"],
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
async function sleep(ms: number) { await new Promise((r) => setTimeout(r, ms)); }

async function withRaceRetry<T>(label: string, fn: () => Promise<T>, max = 12): Promise<T> {
  let last: any;
  for (let i = 0; i < max; i++) {
    try { return await fn(); } catch (e: any) {
      last = e;
      const msg = String(e?.message || e);
      const details = JSON.stringify(e?.details || e?.cause?.details || []);
      const race = /snapshot|WAL|冻结验证|隔离快照|source identity|changed while|safe regular file|database is locked/i.test(msg + details);
      log(`${label} fail ${i} race=${race}: ${msg.slice(0, 140)}`);
      if (!race && i >= 3) throw e;
      await sleep(700 * Math.pow(1.35, i) + Math.random() * 300);
    }
  }
  throw last;
}

async function resolveControlLocalPaths(packId: string) {
  const pack = await readAnyStudioGenerationFrozenPack(ROOT, packId);
  if (!pack) throw new Error("pack missing");
  const refs = (pack as any).request?.controlReferences ?? (pack as any).controlReferences ?? [];
  const out: Array<{ assetId?: string; mediaSha256: string; localPath: string }> = [];
  for (const ref of refs) {
    const media = await getStudioMedia(ROOT, ref.mediaSha256);
    if (!media) throw new Error(`media missing ${ref.mediaSha256}`);
    const alt = (media as any).objectPath;
    if (alt && existsSync(alt)) {
      out.push({ assetId: ref.assetId, mediaSha256: ref.mediaSha256, localPath: alt });
      continue;
    }
    const localPath = path.join(ROOT, ".aicanvas/objects/sha256", ref.mediaSha256.slice(0, 2), ref.mediaSha256);
    if (!existsSync(localPath)) throw new Error(`CAS missing ${ref.mediaSha256}`);
    out.push({ assetId: ref.assetId, mediaSha256: ref.mediaSha256, localPath });
  }
  return out;
}

async function ensureUnit() {
  const existing = await getStudioProductionUnitSnapshot(ROOT, UNIT_ID);
  if (existing) {
    const body = existing.scriptRevision.body;
    if (!body.includes("母") || !body.includes("崽") || body.indexOf("母") === body.indexOf("母子")) {
      // rebind needs distinct surfaces for 母 and 崽 — append fixed script revision
      const docId = existing.scriptRevision.documentId;
      const head = existing.scriptRevision.revision ?? 0;
      // document revision head: try append with expected from document
      try {
        const wrap = await appendStudioScriptRevision(ROOT, {
          documentId: docId,
          expectedRevision: Number((existing.scriptRevision as any).documentRevision ?? head),
          body: SCRIPT_BODY,
          source: "s1e2-u13-fix-surface",
          sourceVersion: "20260723",
        });
        log(`SCRIPT_REVISED ${wrap.revision.id}`);
      } catch (e: any) {
        const m = String(e.message || e).match(/当前\s*(\d+)/);
        if (m) {
          const wrap = await appendStudioScriptRevision(ROOT, {
            documentId: docId,
            expectedRevision: Number(m[1]),
            body: SCRIPT_BODY,
            source: "s1e2-u13-fix-surface",
            sourceVersion: "20260723",
          });
          log(`SCRIPT_REVISED_retry ${wrap.revision.id}`);
        } else {
          log(`SCRIPT_REVISE_SKIP ${e.message?.slice(0, 120)}`);
        }
      }
    }
    log(`unit exists ${UNIT_ID}`);
    return UNIT_ID;
  }
  const scriptDoc = await createStudioScriptDocument(ROOT, { title: "S1E2-U13 天缺破格", expectedRevision: 0 });
  const revWrap = await appendStudioScriptRevision(ROOT, {
    documentId: scriptDoc.id, expectedRevision: 0, body: SCRIPT_BODY, source: "s1e2-u13", sourceVersion: "20260723",
  });
  const rev = revWrap.revision;
  const promptDoc = await createStudioPromptDocument(ROOT, {
    title: "S1E2-U13 R-CINE sky-missing bite + frame break",
    expectedRevision: 0,
  });
  const promptWrap = await appendStudioPromptRevision(ROOT, {
    documentId: promptDoc.id, expectedRevision: 0,
    body: "9:16 vertical unit-grid FOUR panels. G1-G3 pure mineral mural: sky missing bite pure black tooth-edge void, stars die at edge, tiangou light points look up — NO taotie body, NO creature form, only sky-missing silhouette. G4 frame-break: black creeps out mural frame onto real cave stone; mother+cub dog-beast silhouettes at bottom. Photoreal forbidden. NO human faces NO text.",
    source: "s1e2-u13", sourceVersion: "20260723",
  });
  const promptRev = promptWrap.revision;
  const span = { startOffsetUtf16: 0, endOffsetUtf16: SCRIPT_BODY.length };
  const mk = (assetId: string, category: "character" | "scene" | "prop") => ({
    assetId, category, presence: "required" as const, role: assetId, continuityState: "unknown",
    evidence: [{ kind: "prompt-revision", reference: promptRev.id, note: "s1e2-u13" }],
  });
  // 3.5+3.5+3+5=15
  const panels = [
    {
      title: "G1 天缺", visualAction: "画卷右上天缺纯黑齿痕缺口无星",
      shotComposition: "大远景", filmingMethod: "呼吸感固定",
      startSeconds: 0, durationSeconds: 3.5, promptRevisionId: promptRev.id, sourceSpans: [span],
      assets: [mk("scene-shixue", "scene")],
    },
    {
      title: "G2 星灭", visualAction: "星辰滑向齿痕过线即灭",
      shotComposition: "远景", filmingMethod: "微推",
      startSeconds: 3.5, durationSeconds: 3.5, promptRevisionId: promptRev.id, sourceSpans: [span],
      assets: [mk("scene-shixue", "scene")],
    },
    {
      title: "G3 齐仰", visualAction: "天狗纹光齐仰头顶天缺不退",
      shotComposition: "中景", filmingMethod: "上摇",
      startSeconds: 7, durationSeconds: 3, promptRevisionId: promptRev.id, sourceSpans: [span],
      assets: [mk("scene-shixue", "scene")],
    },
    {
      title: "G4 破格", visualAction: "天缺黑漫出画幅触石穴洞壁母子剪影轮廓光缺一线",
      shotComposition: "大远景", filmingMethod: "呼吸感固定",
      startSeconds: 10, durationSeconds: 5, promptRevisionId: promptRev.id, sourceSpans: [span],
      assets: [mk("scene-shixue", "scene"), mk("char-dudu", "character"), mk("char-su", "character")],
    },
  ];
  const unitSnap = await createStudioProductionUnit(ROOT, {
    id: UNIT_ID, expectedRevision: 0, season: "S1", episode: "S1E2", sequence: 13,
    title: "封印·天缺破格", durationSeconds: 15, scriptRevisionId: rev.id, panels,
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
          id: `u13-m-${panel.index}-${asset.assetId}-${i}-${attempt}`,
          surfaceText: chosen.text,
          startOffsetUtf16: chosen.start,
          endOffsetUtf16: chosen.start + chosen.len,
          category: asset.category as "character" | "scene" | "prop",
          presence: "required" as const,
          role: `u13-${asset.assetId}-p${panel.index}-${attempt}`,
          modelSuggestions: [{ assetId: asset.assetId, category: asset.category as "character" | "scene" | "prop", confidence: 1 }],
        };
      });
      try {
        analysis = await analyzeStudioPanelAssetMentions(ROOT, {
          unitId: snap.unit.id, unitRevision: snap.unit.revision, unitFingerprint: snap.fingerprint,
          panelIndex: panel.index, scriptRevisionId: snap.scriptRevision.id, scriptSha256: snap.scriptRevision.bodySha256,
          expectedHeadRevision: tryRev, mentions, resolverVersion: `s1e2-u13-${attempt}`,
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
            receiptId: `u13-dec-p${panel.index}-${proposal.mentionId}-${attempt}`,
            proposalId: proposal.id, expectedAnalysisHeadRevision: analysis.revision, expectedDecisionHeadRevision: 0,
            action, selectedAssetId, presence: proposal.presence, role: proposal.role, reviewer: "s1e2-u13", note: "u13",
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
      startMilliseconds: Math.round(panel.startSeconds * 1000), endMilliseconds: Math.round(panel.endSeconds * 1000),
    };
    for (const src of assetSources as Array<{ assetId: string; mediaSha256: string }>) {
      for (const field of STUDIO_CONTINUITY_FIELDS) {
        const value = field === "referenceSha256" ? src.mediaSha256 : `s1e2:${unitId}:${panel.id}:${src.assetId}:${field}`;
        try {
          await appendStudioContinuityObservation(ROOT, {
            operationId: `u13-cont-${panel.id}-${src.assetId}-${field}`, expectedHeadRevision: 0, scope,
            subjectId: src.assetId, field,
            state: {
              status: "resolved", value,
              provenance: [{
                kind: "s1e2-u13", reference: `${panel.id}/${src.assetId}/${field}`,
                sourceFingerprint: field === "referenceSha256" ? value : digest({ panel: panel.id, asset: src.assetId, field }),
                note: "u13",
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
  log("=== S1E2-U13 ordered prepare ===");
  await activateProject(ROOT);
  const gate = await withRaceRetry("gate", () => getStudioGenerationCheckpointControl(ROOT));
  log(`GATE allowed=${(gate as any).newSlotDispatchAllowed} blocking=${(gate as any).blockingBatchNumber}`);
  if ((gate as any).newSlotDispatchAllowed === false) throw new Error("six-image gate blocked batch " + (gate as any).blockingBatchNumber);

  const unitId = await ensureUnit();
  await bindAll(unitId);

  await withRaceRetry("readiness", async () => {
    const readiness = await getStudioGenerationControlEnvelope(ROOT, { operation: "readiness", targetKind: "unit-grid", unitId });
    log(`READINESS ${(readiness as any).status}`);
    if ((readiness as any).status === "blocked") throw new Error(JSON.stringify(readiness).slice(0, 600));
    return readiness;
  });

  const freeze = await withRaceRetry("freeze", () => freezeAndPersistStudioUnitGridGenerationPack(ROOT, { targetKind: "unit-grid", unitId }));
  const packId = (freeze as any).pack?.id ?? (freeze as any).id;
  const packFingerprint = (freeze as any).pack?.fingerprint ?? (freeze as any).fingerprint;
  const unitRevision = (freeze as any).pack?.target?.unitRevision ?? 1;
  if (!packId || !packFingerprint) throw new Error("freeze missing");
  log(`FREEZE_OK ${packId}`);

  const controlRefs = await resolveControlLocalPaths(packId);
  log(`CONTROL_REFS ${controlRefs.length}`);

  const runId = `s1e2-u13-ug-grok-${Date.now().toString(36)}`;
  await withRaceRetry("dispatch", () => dispatchStudioGenerationPack(ROOT, {
    packId, packFingerprint, generationRunId: runId, provider: "grok",
  }));
  log(`DISPATCH_OK ${runId}`);

  await sleep(1200);
  let ctx = await withRaceRetry("context", () => getActiveManagedStudioContext());
  const prepared = await withRaceRetry("prepare", async () => {
    ctx = await getActiveManagedStudioContext();
    return prepareStudioImagegenCall(ROOT, {
      packId, packFingerprint, generationRunId: runId, provider: "grok",
      projectContextToken: ctx.projectContextToken,
      commandRequestId: `u13-prep-${Date.now().toString(36)}`,
      expectedRevision: 0,
    });
  }, 16);
  log(`PREPARE_OK ${prepared.callId}`);

  const state = {
    preparedAt: nowIso(), projectRoot: ROOT, projectContextToken: ctx.projectContextToken,
    unitId, packId, packFingerprint, unitRevision, generationRunId: runId,
    callId: prepared.callId, inputFingerprint: prepared.inputFingerprint, quarantine: prepared.quarantine,
    controlRefs,
    candidateOut: path.join(PROD, "02_candidates/S1E2-U13_4格_A1_CANDIDATE.jpg"),
    reportOut: path.join(PROD, "05_canvas/s1e2-u13-symbiosis-report.json"),
  };
  writeFileSync(STATE, JSON.stringify(state, null, 2));
  console.log(JSON.stringify({ ok: true, statePath: STATE, candidatePath: prepared.quarantine.candidatePath, controlRefs }, null, 2));
}

main().catch((e) => {
  log(`FATAL ${e?.stack ?? e}`);
  process.exit(1);
});
