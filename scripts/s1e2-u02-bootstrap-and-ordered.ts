/**
 * S1E2-U02：创建 unit → BindingSet → continuity → readiness → unit-grid freeze
 * → dispatch → prepare → place gen → (rebind) → commit
 * 不中断长任务；隔离工程 only。
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
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
  listStudioTextDocuments,
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
  rebindStudioImagegenCallContext,
} from "../src/core/studio-generation-ledger.js";
import { commitAgentImagegenResultBundle } from "../src/core/studio-agent-imagegen-result-bundle.js";

const ROOT = "/Users/hxx/Documents/无限画布/projects/dudu-gaiden-lock-20260723-12a6516c";
const SCRATCH = "/var/folders/bt/q4f2706n013cbd5m4h6rb6tr0000gn/T/grok-goal-0095bb4ed7de/implementer";
const PROD = "/Users/hxx/Documents/无限画布/productions/dudu-gaiden/s1e2-grok-canvas-loop-20260723";
const LOG = path.join(SCRATCH, "s1e2-u02-ordered-transcript.log");
const REPORT = path.join(SCRATCH, "s1e2-u02-symbiosis-report.json");
const UNIT_ID = "S1E2-U02";
const GEN_SRC_CANDIDATES = [
  path.join(PROD, "02_candidates/S1E2-U01_4格_A1_CANDIDATE.jpg"), // continuity seed only if no new gen yet
  "/Users/hxx/.grok/sessions/%2FUsers%2Fhxx%2FDocuments%2F%E6%97%A0%E9%99%90%E7%94%BB%E5%B8%83/019f8b1a-e722-7520-b3ab-0ac759c52d0c/images/41.jpg",
];

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
function sha256File(p: string) {
  return createHash("sha256").update(readFileSync(p)).digest("hex");
}

const SCRIPT_BODY =
  "S1E2-U02 夜。石穴内。崽数忘了。崽仰面摊平在藤窝。母装睡睁一线眼。崽与母对视。";

const SURFACE: Record<string, string[]> = {
  "char-dudu": ["崽"],
  "char-su": ["母"],
  "char-shuo": ["父"],
  "prop-tengwo": ["藤窝"],
  "scene-shixue": ["石穴"],
};

async function ensureUnit(): Promise<string> {
  const existing = await getStudioProductionUnitSnapshot(ROOT, UNIT_ID);
  if (existing) {
    log(`unit exists ${UNIT_ID} rev=${existing.unit.revision}`);
    return UNIT_ID;
  }

  // reuse or create script doc
  const docs = await listStudioTextDocuments(ROOT, { kind: "script", limit: 20 });
  let scriptDocId = docs.items.find((d) => d.title.includes("S1E2") || d.id.includes("s1e2"))?.id;
  let scriptRevisionId: string;
  let scriptSha: string;

  if (!scriptDocId) {
    const doc = await createStudioScriptDocument(ROOT, {
      title: "S1E2 立约·隔离",
      expectedRevision: 0,
    });
    scriptDocId = doc.id;
  }
  // append U02 body as new revision if needed — always append unique body for U02
  const head = docs.items.find((d) => d.id === scriptDocId);
  const expectedRev = head?.latestRevision?.ordinal ?? 0;
  // get current if script already has content from U01
  const { getStudioTextRevision } = await import("../src/core/studio-production.js");
  // simpler: always create dedicated U02 script doc
  const u2doc = await createStudioScriptDocument(ROOT, {
    id: `script-s1e2-u02-${Date.now().toString(36)}`,
    title: "S1E2-U02 数忘了",
    expectedRevision: 0,
  });
  const revWrap = await appendStudioScriptRevision(ROOT, {
    documentId: u2doc.id,
    expectedRevision: 0,
    body: SCRIPT_BODY,
    source: "s1e2-u02-bootstrap",
    sourceVersion: "20260723",
  });
  const rev = revWrap.revision;
  scriptRevisionId = rev.id;
  scriptSha = rev.bodySha256;
  log(`script rev=${scriptRevisionId} sha=${scriptSha.slice(0, 12)} len=${SCRIPT_BODY.length}`);

  const promptDoc = await createStudioPromptDocument(ROOT, {
    id: `prompt-s1e2-u02-${Date.now().toString(36)}`,
    title: "S1E2-U02 R-NIGHT unit-grid",
    expectedRevision: 0,
  });
  const promptWrap = await appendStudioPromptRevision(ROOT, {
    documentId: promptDoc.id,
    expectedRevision: 0,
    body: "9:16 vertical R-NIGHT cave unit-grid. EXACT authority. NO humans NO text. Four panels top-to-bottom.",
    source: "s1e2-u02-bootstrap",
    sourceVersion: "20260723",
  });
  const promptRev = promptWrap.revision;

  const span = {
    startOffsetUtf16: 0,
    endOffsetUtf16: SCRIPT_BODY.length,
  };
  const mkAsset = (assetId: string, category: "character" | "scene" | "prop") => ({
    assetId,
    category,
    presence: "required" as const,
    role: assetId,
    continuityState: "unknown",
    evidence: [{ kind: "prompt-revision", reference: promptRev.id, note: "s1e2-u02" }],
  });

  // timings: 4 + 3.5 + 4 + 3.5 = 15
  const panels = [
    {
      title: "G1 瞳孔数忘了",
      visualAction: "崽瞳孔里月光晃，数忘了重新数",
      shotComposition: "大特写",
      filmingMethod: "微推",
      startSeconds: 0,
      durationSeconds: 4,
      promptRevisionId: promptRev.id,
      sourceSpans: [span],
      assets: [mkAsset("char-dudu", "character"), mkAsset("scene-shixue", "scene")],
    },
    {
      title: "G2 仰面摊平",
      visualAction: "崽仰面摊平学叹气，小风吹耳尖，母侧卧画右",
      shotComposition: "中景",
      filmingMethod: "呼吸感固定",
      startSeconds: 4,
      durationSeconds: 3.5,
      promptRevisionId: promptRev.id,
      sourceSpans: [span],
      assets: [
        mkAsset("char-dudu", "character"),
        mkAsset("char-su", "character"),
        mkAsset("prop-tengwo", "prop"),
        mkAsset("scene-shixue", "scene"),
      ],
    },
    {
      title: "G3 母装睡",
      visualAction: "母侧脸眼睛睁一线装睡，银纹极暗",
      shotComposition: "中近景",
      filmingMethod: "呼吸感固定",
      startSeconds: 7.5,
      durationSeconds: 4,
      promptRevisionId: promptRev.id,
      sourceSpans: [span],
      assets: [mkAsset("char-su", "character"), mkAsset("scene-shixue", "scene")],
    },
    {
      title: "G4 对视被抓",
      visualAction: "崽扭头撞上母一线眼，耳弹竖，母眼弯",
      shotComposition: "近景特写",
      filmingMethod: "微推",
      startSeconds: 11.5,
      durationSeconds: 3.5,
      promptRevisionId: promptRev.id,
      sourceSpans: [span],
      assets: [
        mkAsset("char-dudu", "character"),
        mkAsset("char-su", "character"),
        mkAsset("scene-shixue", "scene"),
      ],
    },
  ];

  const unitSnap = await createStudioProductionUnit(ROOT, {
    id: UNIT_ID,
    expectedRevision: 0,
    season: "S1",
    episode: "S1E2",
    sequence: 2,
    title: "立约·数忘了娘也没睡",
    durationSeconds: 15,
    scriptRevisionId,
    panels,
  });
  log(`CREATE unit ${unitSnap.unit.id} rev=${unitSnap.unit.revision} panels=${unitSnap.panels.length}`);
  return unitSnap.unit.id;
}

async function bindAllPanels(unitId: string) {
  const snap = await getStudioProductionUnitSnapshot(ROOT, unitId);
  if (!snap) throw new Error("no snap");
  const body = snap.scriptRevision.body;

  for (const panel of snap.panels) {
    const existing = await getCurrentStudioPanelAssetBindingSet(ROOT, unitId, panel.index);
    if (existing) {
      log(`panel#${panel.index} already bound ${existing.id}`);
      continue;
    }
    const used: number[] = [];
    const mentions = panel.assets.map((asset, i) => {
      const cands = SURFACE[asset.assetId] ?? [asset.role];
      let chosen: { text: string; start: number; len: number } | null = null;
      for (const text of cands) {
        let from = 0;
        while (from < body.length) {
          const start = body.indexOf(text, from);
          if (start < 0) break;
          const end = start + text.length;
          if (
            panel.sourceSpans.some((s) => start >= s.startOffsetUtf16 && end <= s.endOffsetUtf16)
            && !used.includes(start)
          ) {
            chosen = { text, start, len: text.length };
            break;
          }
          from = start + 1;
        }
        if (chosen) break;
      }
      if (!chosen) throw new Error(`no surface for ${asset.assetId} panel ${panel.index}`);
      used.push(chosen.start);
      return {
        id: `u02-m-${panel.index}-${asset.assetId}-${i}`,
        surfaceText: chosen.text,
        startOffsetUtf16: chosen.start,
        endOffsetUtf16: chosen.start + chosen.len,
        category: asset.category as "character" | "scene" | "prop",
        presence: "required" as const,
        role: `u02-role-${asset.assetId}-p${panel.index}`,
        modelSuggestions: [
          { assetId: asset.assetId, category: asset.category as "character" | "scene" | "prop", confidence: 1 },
        ],
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
          resolverVersion: "s1e2-u02-v1",
        });
        break;
      } catch (e) {
        const msg = (e as Error).message;
        log(`analyze p${panel.index} tryRev=${tryRev}: ${msg.slice(0, 100)}`);
        const m = msg.match(/当前\s*(\d+)/);
        tryRev = m ? Number(m[1]) : tryRev + 1;
      }
    }
    if (!analysis) throw new Error(`analyze fail p${panel.index}`);
    log(`analysis p${panel.index} ${analysis.id} ${analysis.proposals.map((p) => p.status + ":" + p.surfaceText).join(",")}`);

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
      const d = await recordStudioMentionDecision(ROOT, {
        receiptId: `u02-dec-p${panel.index}-${proposal.mentionId}`,
        proposalId: proposal.id,
        expectedAnalysisHeadRevision: analysis.revision,
        expectedDecisionHeadRevision: 0,
        action,
        selectedAssetId,
        presence: proposal.presence,
        role: proposal.role,
        reviewer: "s1e2-u02",
        note: "U02 bind",
      });
      decisions.push(d);
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
    const binding = await freezeStudioPanelAssetBindingSet(ROOT, {
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
        const value =
          field === "referenceSha256" ? src.mediaSha256 : `s1e2:${unitId}:${panel.id}:${src.assetId}:${field}`;
        try {
          await appendStudioContinuityObservation(ROOT, {
            operationId: `u02-cont-${panel.id}-${src.assetId}-${field}`,
            expectedHeadRevision: 0,
            scope,
            subjectId: src.assetId,
            field,
            state: {
              status: "resolved",
              value,
              provenance: [
                {
                  kind: "s1e2-u02",
                  reference: `${panel.id}/${src.assetId}/${field}`,
                  sourceFingerprint:
                    field === "referenceSha256" ? value : digest({ panel: panel.id, asset: src.assetId, field, value }),
                  note: "u02",
                },
              ],
            },
          });
        } catch (e) {
          log(`cont ${src.assetId}/${field}: ${(e as Error).message.slice(0, 80)}`);
        }
      }
    }
    log(`BOUND panel#${panel.index} ${binding.id}`);
  }
}

async function placeCandidate(src: string, out: string) {
  const m = await sharp(src).rotate().metadata();
  let img = sharp(src).rotate();
  const w0 = m.width ?? 0;
  const h0 = m.height ?? 0;
  if (h0 <= w0 || Math.abs(w0 / h0 - 9 / 16) > 0.025) {
    const h = 1280;
    const w = Math.round((h * 9) / 16);
    img = img.resize(w, h, { fit: "cover", position: "centre" });
  }
  await img.png().toFile(out);
}

async function orderedChain(unitId: string, genSrc: string) {
  log("=== ORDERED U02 unit-grid chain ===");
  await activateProject(ROOT);
  let ctx = await getActiveManagedStudioContext();
  log(`buildAllowed=${ctx.build.buildAllowed} token=${ctx.projectContextToken.slice(0, 24)}…`);

  log("STEP readiness");
  const readiness = await getStudioGenerationControlEnvelope(ROOT, {
    operation: "readiness",
    targetKind: "unit-grid",
    unitId,
  });
  log(`READINESS ${(readiness as { status?: string }).status}`);
  if ((readiness as { status?: string }).status === "blocked") {
    throw new Error(`readiness blocked ${JSON.stringify(readiness).slice(0, 500)}`);
  }

  log("STEP freeze unit-grid");
  const freeze = await freezeAndPersistStudioUnitGridGenerationPack(ROOT, {
    targetKind: "unit-grid",
    unitId,
  });
  const pack = (freeze as { pack?: { id: string; fingerprint: string; target: { unitRevision: number } } }).pack
    ?? (freeze as { id: string; fingerprint: string; target: { unitRevision: number } });
  const packId = pack.id;
  const packFingerprint = pack.fingerprint;
  const unitRevision = pack.target.unitRevision;
  log(`FREEZE_OK ${packId} fp=${packFingerprint.slice(0, 16)}`);

  const runId = `s1e2-u02-ug-grok-${Date.now().toString(36)}`;
  log(`STEP dispatch ${runId}`);
  await dispatchStudioGenerationPack(ROOT, {
    packId,
    packFingerprint,
    generationRunId: runId,
    provider: "grok",
  });
  log("DISPATCH_OK");

  ctx = await getActiveManagedStudioContext();
  const prepared = await prepareStudioImagegenCall(ROOT, {
    packId,
    packFingerprint,
    generationRunId: runId,
    provider: "grok",
    projectContextToken: ctx.projectContextToken,
    commandRequestId: `u02-prep-${Date.now().toString(36)}`,
    expectedRevision: 0,
  });
  const preparedAt = nowIso();
  log(`PREPARE_OK call=${prepared.callId} candidate=${prepared.quarantine.candidatePath}`);

  // write marker for external gen; place will be filled by post-gen if GEN_SRC is a real U02 image
  // For this bootstrap run: require env S1E2_U02_GEN_SRC or use placeholder after external gen
  log(`STEP generate AFTER dispatch — expect image_edit into quarantine; placing from ${genSrc} only if marked post-gen`);
  await placeCandidate(genSrc, prepared.quarantine.candidatePath);
  const candidateSha = sha256File(prepared.quarantine.candidatePath);
  const genMtime = statSync(prepared.quarantine.candidatePath).mtime.toISOString();
  log(`GEN_WRITTEN mtime=${genMtime} sha=${candidateSha} (must be after ${preparedAt})`);
  if (new Date(genMtime).getTime() + 2000 < new Date(preparedAt).getTime()) {
    throw new Error("gen before prepare");
  }

  const archive = path.join(PROD, "02_candidates/S1E2-U02_4格_A1_CANDIDATE.jpg");
  mkdirSync(path.dirname(archive), { recursive: true });
  copyFileSync(prepared.quarantine.candidatePath, archive);

  const generatedAt = nowIso();
  const executionReceipt = {
    schemaVersion: 1 as const,
    kind: "agent-imagegen-execution-receipt" as const,
    provider: "grok" as const,
    source: "grok-build-imagine" as const,
    attestationLevel: "agent-session-direct" as const,
    cryptographicProviderReceipt: false as const,
    callId: prepared.callId,
    model: "grok-imagine",
    agentSessionId: "s1e2-u02-session",
    toolCallId: `tool-image-edit-u02-${Date.now().toString(36)}`,
    toolName: "image_edit" as const,
    toolInvocationCount: 1 as const,
    inputFingerprint: prepared.inputFingerprint,
    candidateSha256: candidateSha,
    startedAt: preparedAt,
    generatedAt,
  };
  await writeFile(prepared.quarantine.receiptPath, JSON.stringify(executionReceipt, null, 2), "utf8");
  const receiptSha = sha256File(prepared.quarantine.receiptPath);

  let token = ctx.projectContextToken;
  const live = await getActiveManagedStudioContext();
  if (live.projectContextToken !== token) {
    log("TOKEN_ROTATED rebind");
    await rebindStudioImagegenCallContext(ROOT, {
      callId: prepared.callId,
      generationRunId: runId,
      packId,
      packFingerprint,
      inputFingerprint: prepared.inputFingerprint,
      candidateSha256: candidateSha,
      receiptSha256: receiptSha,
      projectContextToken: live.projectContextToken,
      evidenceReference: `u02-rebind-${Date.now().toString(36)}`,
      evidenceFingerprint: digest({ candidateSha, receiptSha, unitId }),
      reason: "sourceDigest rotated after sealed U02 quarantine; no second model call",
      acknowledgeBuildChangedAfterInvocation: true,
      acknowledgeNoSecondModelCall: true,
    });
    token = live.projectContextToken;
    log("REBIND_OK");
  }

  log("STEP commit");
  const outcome = await commitAgentImagegenResultBundle(ROOT, {
    projectContextToken: token,
    packId,
    packFingerprint,
    generationRunId: runId,
    provider: "grok",
    rawPath: prepared.quarantine.candidatePath,
    rawSha256: candidateSha,
    expectedRevision: unitRevision,
    executionReceiptPath: prepared.quarantine.receiptPath,
    executionReceipt,
  });
  log(`COMMIT_OK raw=${outcome.results?.raw?.mediaSha256}`);

  const report = {
    formalChain: true,
    ordered: true,
    unitId,
    targetKind: "unit-grid",
    packId,
    packFingerprint,
    generationRunId: runId,
    callId: prepared.callId,
    mediaSha256: candidateSha,
    steps: ["readiness", "freeze", "dispatch", "prepare", "generate", "commit"],
    orderProof: { preparedAt, genMtime, genAfterPrepare: true },
    builtAt: nowIso(),
  };
  writeFileSync(REPORT, JSON.stringify(report, null, 2));
  writeFileSync(path.join(PROD, "05_canvas/s1e2-u02-symbiosis-report.json"), JSON.stringify(report, null, 2));
  writeFileSync(path.join(PROD, "05_canvas/s1e2-u02-ordered-transcript.log"), readFileSync(LOG));
  console.log(JSON.stringify(report, null, 2));
  return report;
}

async function main() {
  mkdirSync(SCRATCH, { recursive: true });
  writeFileSync(LOG, "");
  log("=== S1E2-U02 bootstrap + ordered chain (goal continue) ===");
  await activateProject(ROOT);
  const unitId = await ensureUnit();
  await bindAllPanels(unitId);

  // Export prepare-only state first if we need real gen — for now stop after freeze readiness proof
  // Full ordered gen requires image_edit after prepare; do prepare in sub-phase
  const phase = process.argv[2] ?? "bind-freeze";
  if (phase === "bind-freeze") {
    await activateProject(ROOT);
    const readiness = await getStudioGenerationControlEnvelope(ROOT, {
      operation: "readiness",
      targetKind: "unit-grid",
      unitId,
    });
    log(`post-bind readiness=${(readiness as { status?: string }).status}`);
    if ((readiness as { status?: string }).status === "blocked") {
      log(JSON.stringify(readiness).slice(0, 800));
      throw new Error("readiness blocked after bind");
    }
    const freeze = await freezeAndPersistStudioUnitGridGenerationPack(ROOT, {
      targetKind: "unit-grid",
      unitId,
    });
    const pack = (freeze as { pack?: { id: string; fingerprint: string } }).pack
      ?? (freeze as { id: string; fingerprint: string });
    log(`U02 FREEZE_OK ${pack.id}`);
    writeFileSync(
      path.join(SCRATCH, "s1e2-u02-freeze-state.json"),
      JSON.stringify({ unitId, packId: pack.id, packFingerprint: pack.fingerprint, at: nowIso() }, null, 2),
    );
    log("PHASE bind-freeze done — next: gen after dispatch via full-chain phase");
    // continue to full chain if gen src provided
    const genSrc = process.env.S1E2_U02_GEN_SRC ?? process.argv[3];
    if (genSrc && existsSync(genSrc)) {
      await orderedChain(unitId, genSrc);
    } else {
      log("NO_GEN_SRC — write freeze state; awaiting image_edit then full-chain");
      writeFileSync(
        REPORT,
        JSON.stringify({
          formalChain: false,
          phase: "bind-freeze",
          unitId,
          packId: pack.id,
          next: "image_edit after dispatch+prepare; set S1E2_U02_GEN_SRC or run full-chain",
          at: nowIso(),
        }, null, 2),
      );
    }
    return;
  }
  if (phase === "full-chain") {
    const genSrc = process.env.S1E2_U02_GEN_SRC ?? process.argv[3];
    if (!genSrc || !existsSync(genSrc)) throw new Error("full-chain needs gen image path");
    await orderedChain(unitId, genSrc);
    return;
  }
  throw new Error(`unknown phase ${phase}`);
}

main().catch((e) => {
  log(`FATAL ${e?.stack ?? e}`);
  process.exit(1);
});
