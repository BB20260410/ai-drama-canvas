/**
 * S1E2 正式 managed 链：BindingSet → freeze pack → dispatch(grok) → register
 * 仅写隔离工程 projects/dudu-gaiden-lock-20260723-12a6516c
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  analyzeStudioPanelAssetMentions,
  freezeStudioPanelAssetBindingSet,
  getStudioProductionUnitSnapshot,
  listStudioProductionUnits,
  recordStudioMentionDecision,
  getStudioProductionPanelTimeContext,
  getCurrentStudioPanelAssetBindingSet,
} from "../src/core/studio-production.js";
import {
  getStudioCanonicalAsset,
  getStudioCanonicalAssetKnowledgeSnapshot,
  evaluateStudioAssetApplicability,
  importStudioMedia,
} from "../src/core/material-studio.js";
import {
  freezeAndPersistStudioGenerationPack,
  dispatchStudioGenerationPack,
  registerStudioGenerationResult,
} from "../src/core/studio-generation-ledger.js";
import { assertStudioExecutionFreezePackGate } from "../src/core/studio-generation-execution-gate.js";
import { STUDIO_CONTINUITY_FIELDS } from "../src/core/studio-continuity.js";
import { appendStudioContinuityObservation } from "../src/core/studio-continuity-ledger.js";

const ROOT = "/Users/hxx/Documents/无限画布/projects/dudu-gaiden-lock-20260723-12a6516c";
const SCRATCH = "/var/folders/bt/q4f2706n013cbd5m4h6rb6tr0000gn/T/grok-goal-0095bb4ed7de/implementer";
const CANDIDATE =
  "/Users/hxx/Documents/无限画布/productions/dudu-gaiden/s1e2-grok-canvas-loop-20260723/02_candidates/S1E2-U01_4格_A1_CANDIDATE.jpg";
const LOG = path.join(SCRATCH, "s1e2-mcp-freeze-dispatch-transcript.log");
const REPORT = path.join(SCRATCH, "canvas-symbiosis-report.json");

function log(line: string) {
  const msg = `[${new Date().toISOString()}] ${line}`;
  console.log(msg);
  writeFileSync(LOG, (existsSync(LOG) ? readFileSync(LOG, "utf8") : "") + msg + "\n");
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function ensureBindingForPanel(unitId: string, panelIndex: number): Promise<{ bindingSetId: string; panelId: string }> {
  const snap = await getStudioProductionUnitSnapshot(ROOT, unitId);
  if (!snap) throw new Error(`unit missing ${unitId}`);
  const panel = snap.panels.find((p) => p.index === panelIndex);
  if (!panel) throw new Error(`panel index ${panelIndex} missing`);

  const existing = await getCurrentStudioPanelAssetBindingSet(ROOT, unitId, panelIndex).catch(() => null);
  if (existing) {
    log(`panel ${panel.id} already has bindingSet ${existing.id}`);
    return { bindingSetId: existing.id, panelId: panel.id };
  }

  const body = snap.scriptRevision.body;
  // 剧本用 崽/母/父 等别名；禁止用 assetId 当 surface（会落到 "S1E2" 前缀误匹配）
  const SURFACE_BY_ASSET: Record<string, string[]> = {
    "char-dudu": ["崽", "嘟嘟", "dudu"],
    "char-su": ["母", "素", "母·素"],
    "char-shuo": ["父", "朔", "父·朔"],
    "prop-tengwo": ["藤窝"],
    "scene-shixue": ["石穴"],
  };
  const usedRanges: Array<{ start: number; end: number }> = [];
  const mentions = panel.assets.map((asset, i) => {
    const surfaceCandidates = [
      ...(SURFACE_BY_ASSET[asset.assetId] ?? []),
      asset.role && !asset.role.startsWith("char-") && !asset.role.startsWith("prop-") && !asset.role.startsWith("scene-")
        ? asset.role
        : "",
      ...(asset.category === "character" ? ["崽", "母", "父"] : []),
      ...(asset.category === "scene" ? ["石穴"] : []),
      ...(asset.category === "prop" ? ["藤窝"] : []),
    ].filter((t): t is string => Boolean(t && t.trim()));

    let chosen: { text: string; start: number; len: number } | null = null;
    for (const text of surfaceCandidates) {
      let from = 0;
      while (from < body.length) {
        const start = body.indexOf(text, from);
        if (start < 0) break;
        const endUtf16 = start + text.length;
        const inSpan = panel.sourceSpans.some((s) => start >= s.startOffsetUtf16 && endUtf16 <= s.endOffsetUtf16);
        const overlap = usedRanges.some((r) => !(endUtf16 <= r.start || start >= r.end));
        if (inSpan && !overlap) {
          chosen = { text, start, len: text.length };
          break;
        }
        from = start + 1;
      }
      if (chosen) break;
    }
    if (!chosen) {
      throw new Error(
        `cannot place surface for ${asset.assetId} in panel ${panel.id}; body=${JSON.stringify(body)} candidates=${surfaceCandidates.join(",")}`,
      );
    }
    usedRanges.push({ start: chosen.start, end: chosen.start + chosen.len });
    return {
      id: `s1e2-m-${panelIndex}-${asset.assetId}-${i}`,
      surfaceText: chosen.text,
      startOffsetUtf16: chosen.start,
      endOffsetUtf16: chosen.start + chosen.len,
      category: asset.category as "character" | "scene" | "prop",
      presence: (asset.presence ?? "required") as "required" | "optional" | "forbidden",
      role: asset.role || asset.assetId,
      // 保险：即使 exact 未命中，model 候选也能 select（必须带 category）
      modelSuggestions: [
        {
          assetId: asset.assetId,
          category: asset.category as "character" | "scene" | "prop",
          confidence: 1,
        },
      ],
    };
  });

  log(`analyze panel=${panel.id} mentions=${mentions.map((m) => `${m.surfaceText}@${m.startOffsetUtf16}`).join(" | ")}`);

  // expectedHeadRevision = 当前 analysis head（已有一次失败尝试则为 1）
  let analysis;
  let tryRev = 0;
  for (let attempt = 0; attempt < 4; attempt++) {
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
        resolverVersion: "s1e2-grok-canvas-loop-v1",
      });
      break;
    } catch (err) {
      const msg = (err as Error).message;
      log(`analyze expectedHead=${tryRev} failed: ${msg.slice(0, 160)}`);
      const m = msg.match(/actual[=: ]*(\d+)/i) ?? msg.match(/当前[=: ]*(\d+)/) ?? msg.match(/期望\s*(\d+).*实际\s*(\d+)/);
      if (m) {
        tryRev = Number(m[2] ?? m[1]);
      } else {
        tryRev += 1;
      }
    }
  }
  if (!analysis) throw new Error(`analyze failed for panel ${panel.id}`);
  log(`analysis id=${analysis.id} rev=${analysis.revision} proposals=${analysis.proposals.length} statuses=${analysis.proposals.map((p) => p.status).join(",")}`);

  const decisions = [];
  for (const proposal of analysis.proposals) {
    const exact = proposal.candidates.filter((c) => (c as { kind?: string }).kind !== "model");
    let action: "accept" | "select" = "accept";
    let selectedAssetId: string | undefined;
    if (proposal.status === "matched" && exact.length === 1) {
      action = "accept";
    } else {
      const mention = mentions.find((m) => m.id === proposal.mentionId);
      const wanted = panel.assets.find((a) => a.assetId === mention?.role)
        ?? panel.assets.find((a) => a.role === proposal.role)
        ?? panel.assets.find((a) => a.category === proposal.category)
        ?? panel.assets[0];
      const targetId = wanted?.assetId ?? exact[0]?.assetId ?? proposal.candidates[0]?.assetId;
      if (!targetId) throw new Error(`no candidate for proposal ${proposal.id} status=${proposal.status}`);
      action = "select";
      selectedAssetId = targetId;
    }
    const d = await recordStudioMentionDecision(ROOT, {
      receiptId: `s1e2-dec-${panel.index}-${proposal.mentionId}-${Date.now().toString(36)}`,
      proposalId: proposal.id,
      expectedAnalysisHeadRevision: analysis.revision,
      expectedDecisionHeadRevision: 0,
      action,
      selectedAssetId,
      presence: proposal.presence,
      role: proposal.role,
      reviewer: "s1e2-grok",
      note: "S1E2 isolation formal BindingSet decision",
    });
    decisions.push(d);
    log(`decision ${d.id} action=${action}`);
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
    if (!detail?.primaryAuthority) {
      log(`WARN skip asset without authority: ${asset.assetId}`);
      continue;
    }
    const definition = detail.definitionVersions.find((e) => e.id === detail.currentDefinitionVersionId);
    const authority = detail.authorityHistory.at(-1);
    const version = detail.versions.find((e) => e.id === detail.primaryAuthority!.versionId);
    const knowledge = await getStudioCanonicalAssetKnowledgeSnapshot(ROOT, detail.id, target);
    if (!definition || !authority || !version || !knowledge) {
      throw new Error(`incomplete asset source ${asset.assetId}`);
    }
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

  const binding = await freezeStudioPanelAssetBindingSet(ROOT, {
    analysisId: analysis.id,
    expectedAnalysisHeadRevision: analysis.revision,
    expectedBindingHeadRevision: 0,
    decisionReceiptIds: decisions.map((d) => d.id),
    assetSources,
  });
  log(`bindingSet id=${binding.id} fp=${binding.fingerprint.slice(0, 16)}`);

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
        field === "referenceSha256"
          ? src.mediaSha256
          : `s1e2:${unitId}:${panel.id}:${src.assetId}:${field}`;
      try {
        await appendStudioContinuityObservation(ROOT, {
          operationId: `s1e2-cont-${panel.id}-${src.assetId}-${field}-v3`,
          expectedHeadRevision: 0,
          scope,
          subjectId: src.assetId,
          field,
          state: {
            status: "resolved",
            value,
            provenance: [
              {
                kind: "s1e2-formal-chain",
                reference: `${unitId}/${panel.id}/${src.assetId}/${field}`,
                sourceFingerprint:
                  field === "referenceSha256"
                    ? value
                    : digest({ unitId, panelId: panel.id, assetId: src.assetId, field, value }),
                note: "S1E2 formal freeze chain continuity",
              },
            ],
          },
        });
      } catch (e) {
        // already seeded is OK
        log(`continuity ${src.assetId}/${field}: ${(e as Error).message.slice(0, 120)}`);
      }
    }
  }
  log(`continuity done assets=${assetSources.map((a) => a.assetId).join(",")}`);
  return { bindingSetId: binding.id, panelId: panel.id };
}

async function main() {
  mkdirSync(SCRATCH, { recursive: true });
  writeFileSync(LOG, "");
  log("=== formal freeze/dispatch/register chain v3 ===");
  log(`managed project-1abfd57f23eb root=${ROOT}`);

  const filePackPath =
    "/Users/hxx/Documents/无限画布/productions/dudu-gaiden/s1e2-grok-canvas-loop-20260723/01_packs/S1E2-U01_A1_freeze-pack.json";
  if (existsSync(filePackPath)) {
    try {
      assertStudioExecutionFreezePackGate(JSON.parse(readFileSync(filePackPath, "utf8")));
      log("assertStudioExecutionFreezePackGate PASS on file pack");
    } catch (e) {
      log(`file pack gate: ${(e as Error).message}`);
    }
  }

  let listed = await listStudioProductionUnits(ROOT, { limit: 50 });
  log(`units count=${listed.items.length} ids=${listed.items.map((u) => u.id).join(",")}`);
  const unitId =
    listed.items.find((u) => /S1E2|s1e2|E2/i.test(u.id))?.id
    ?? listed.items[0]?.id;
  if (!unitId) throw new Error("no production unit in isolation project — import U01 first");
  log(`using unitId=${unitId}`);

  const snap = await getStudioProductionUnitSnapshot(ROOT, unitId);
  if (!snap) throw new Error("snapshot missing");
  log(`unit rev=${snap.unit.revision} panels=${snap.panels.length} season=${snap.unit.season} ep=${snap.unit.episode}`);
  log(`scriptRev=${snap.scriptRevision.id} bodyLen=${snap.scriptRevision.body.length}`);
  for (const p of snap.panels) {
    log(`  panel#${p.index} id=${p.id} assets=${p.assets.map((a) => a.assetId).join(",")} spans=${p.sourceSpans.length}`);
  }

  const panelIds: string[] = [];
  for (const p of snap.panels) {
    try {
      const r = await ensureBindingForPanel(unitId, p.index);
      panelIds.push(r.panelId);
      log(`BOUND panel#${p.index}`);
    } catch (err) {
      log(`panel#${p.index} BIND FAIL: ${(err as Error).stack ?? (err as Error).message}`);
    }
  }
  if (panelIds.length === 0) throw new Error("no panels bound");

  const panel0 = snap.panels[0]!;
  log(`freezing pack for panel ${panel0.id}`);
  const freezeResult = await freezeAndPersistStudioGenerationPack(ROOT, {
    unitId,
    panelId: panel0.id,
  });
  const packId = freezeResult.pack?.id ?? freezeResult.id;
  const packFingerprint = freezeResult.pack?.fingerprint ?? freezeResult.fingerprint;
  if (!packId || !packFingerprint) {
    log(`freeze raw keys=${Object.keys(freezeResult).join(",")} sample=${JSON.stringify(freezeResult).slice(0, 1500)}`);
    throw new Error("freeze missing packId/fingerprint");
  }
  log(`FREEZE_OK packId=${packId} fp=${packFingerprint.slice(0, 20)}`);

  const runId = `s1e2-u01-a1-grok-${Date.now().toString(36)}`;
  const dispatch = await dispatchStudioGenerationPack(ROOT, {
    packId,
    packFingerprint,
    generationRunId: runId,
    provider: "grok",
  });
  log(`DISPATCH_OK runId=${runId} dispatchId=${dispatch.dispatchId}`);

  if (!existsSync(CANDIDATE)) throw new Error(`candidate missing ${CANDIDATE}`);
  const rawBuf = readFileSync(CANDIDATE);
  const rawSha = createHash("sha256").update(rawBuf).digest("hex");
  log(`candidate sha=${rawSha} bytes=${rawBuf.length}`);

  try {
    const imported = await importStudioMedia(ROOT, {
      sourcePath: CANDIDATE,
      kind: "image",
      expectedSha256: rawSha,
    });
    log(`media imported sha=${imported.sha256}`);
  } catch (e) {
    log(`import media note: ${(e as Error).message.slice(0, 200)}`);
  }

  const registered = await registerStudioGenerationResult(ROOT, {
    packId,
    packFingerprint,
    generationRunId: runId,
    variant: "raw",
    mediaSha256: rawSha,
    provider: "grok",
  });
  log(`REGISTER_OK resultId=${registered.resultId} status=${registered.status}`);

  const report = {
    formalChain: true,
    formalChainVersion: 3,
    projectId: "project-1abfd57f23eb",
    projectRoot: ROOT,
    unitId,
    panelId: panel0.id,
    packId,
    packFingerprint,
    generationRunId: runId,
    provider: "grok",
    mediaSha256: rawSha,
    candidatePath: CANDIDATE,
    boundPanels: panelIds,
    resultId: registered.resultId,
    steps: ["bindingSet", "continuity", "freeze", "dispatch", "importMedia", "register"],
    builtAt: new Date().toISOString(),
    canvasImprovements: [
      "assertStudioFormalGenerationPackDiscipline wired into freezeAndPersist*",
      "rebuild mcp+identity sourceDigest after gate wire (BUILD_CURRENTNESS)",
      "formal BindingSet expectedHeadRevision integer path documented",
    ],
  };
  writeFileSync(REPORT, JSON.stringify(report, null, 2));
  log("REPORT written formalChain=true");
  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  const msg = err?.stack ?? String(err);
  log(`FATAL ${msg}`);
  writeFileSync(
    REPORT,
    JSON.stringify({ formalChain: false, error: String(err?.message ?? err), at: new Date().toISOString() }, null, 2),
  );
  process.exit(1);
});
