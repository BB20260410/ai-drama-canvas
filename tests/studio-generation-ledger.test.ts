import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, realpath, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendStudioAssetVersion,
  createStudioCanonicalAsset,
  evaluateStudioAssetApplicability,
  getStudioCanonicalAsset,
  getStudioCanonicalAssetKnowledgeSnapshot,
  importStudioMedia,
  reviewStudioAssetVersion,
  setStudioPrimaryAuthority,
  updateStudioCanonicalAsset,
} from "../src/core/material-studio.js";
import { createManagedProject, inspectManagedProject } from "../src/core/managed-project.js";
import { STUDIO_CONTINUITY_FIELDS } from "../src/core/studio-continuity.js";
import { appendStudioContinuityObservation } from "../src/core/studio-continuity-ledger.js";
import { getStudioGenerationCheckpointControl } from "../src/core/studio-generation-checkpoint.js";
import {
  evaluateStudioGenerationPackCurrentness,
  getStudioGenerationTrace,
} from "../src/core/studio-trace.js";
import {
  getStudioGenerationReviewControl,
  submitStudioGenerationReview,
} from "../src/core/studio-generation-review.js";
import { buildStudioGenerationPlanProgress } from "../src/core/studio-generation-plan-progress.js";
import {
  appendStudioPromptRevision,
  appendStudioScriptRevision,
  analyzeStudioPanelAssetMentions,
  createStudioProductionUnit,
  createStudioPromptDocument,
  createStudioScriptDocument,
  freezeStudioPanelAssetBindingSet,
  getStudioProductionUnitSnapshot,
  recordStudioMentionDecision,
  reviseStudioProductionUnit,
  type StudioProductionPanelInput,
} from "../src/core/studio-production.js";
import {
  __setBeforeGenerationWritableOpenHookForTests,
  abandonStudioDetachedGenerationUnknown,
  abandonStudioGenerationUnknown,
  assertStudioGenerationRawNotDetachedCandidate,
  assertStudioGenerationResultPromotionEligible,
  cancelStudioGenerationRun,
  createStudioGenerationPlan,
  dispatchStudioGenerationPack,
  failStudioGenerationRun,
  StudioGenerationResultConflictError,
  freezeAndPersistStudioGenerationPack,
  freezeAndPersistStudioUnitGridGenerationPack,
  getStudioGenerationLedgerState,
  getStudioDetachedGenerationUnknownUnitStates,
  getStudioGenerationLatestPlanForUnitGrid,
  getStudioGenerationPlanProjection,
  initializeStudioGenerationLedger,
  importStudioHistoricalGenerationEvidence,
  listStudioDetachedGenerationUnknownObservations,
  listStudioDetachedGenerationUnknownDispositions,
  listStudioActiveDetachedGenerationUnknownObservations,
  listStudioGenerationPanelHistory,
  listStudioGenerationPacksByUnit,
  listStudioGenerationUnitGridHistory,
  readPersistedStudioGenerationPack,
  readStudioImagegenCallEventHistory,
  readStudioImagegenCallContextRebindByRun,
  readStudioImagegenCallIntentByRun,
  readStudioGenerationDispatch,
  readStudioGenerationFrozenPack,
  readStudioGenerationResult,
  readStudioHistoricalGenerationEvidenceByPack,
  readStudioHistoricalGenerationEvidenceByUnit,
  readStudioGenerationRunEventHistory,
  readStudioUnitGridGenerationFrozenPack,
  recordStudioDetachedGenerationUnknownObservation,
  prepareStudioImagegenCall,
  reconcileStudioImagegenCall,
  rebindStudioImagegenCallContext,
  registerStudioGenerationResult,
  registerStudioGenerationResultBundle,
  retryStudioGenerationPlanNodes,
  isStudioImagegenCallContextAuthorized,
  studioImagegenContextTokenHash,
} from "../src/core/studio-generation-ledger.js";

const roots: string[] = [];

afterEach(async () => {
  __setBeforeGenerationWritableOpenHookForTests(null);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function managedProject(): Promise<string> {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "ai-canvas-ledger-parent-")));
  roots.push(parent);
  return (await createManagedProject({ parentRoot: parent, name: "P5 生成账本测试" })).paths.root;
}

async function createImage(root: string, name: string, color: string) {
  const sourcePath = path.join(root, `${name}.png`);
  await sharp({ create: { width: 80, height: 120, channels: 3, background: color } }).png().toFile(sourcePath);
  return importStudioMedia(root, { sourcePath });
}

function panels(promptRevisionId: string): StudioProductionPanelInput[] {
  return [
    { startSeconds: 0, endSeconds: 7, durationSeconds: 7 },
    { startSeconds: 7, endSeconds: 15, durationSeconds: 8 },
  ].map((timing, offset) => ({
    id: `panel-${String(offset + 1).padStart(2, "0")}`,
    title: `镜头 ${offset + 1}`,
    visualAction: offset === 0 ? "阿航走入石室。" : "阿航停步回头。",
    shotComposition: offset === 0 ? "中景居中。" : "近景侧逆光。",
    filmingMethod: offset === 0 ? "稳定器跟拍。" : "50mm 缓慢推近。",
    dialogue: offset === 0 ? "阿航：别出声。" : "",
    subtitle: offset === 0 ? "别出声" : "",
    ...timing,
    promptRevisionId,
    sourceSpans: [{ startOffsetUtf16: 0, endOffsetUtf16: 2 }],
    assets: [{
      assetId: "character-ahang",
      category: "character",
      presence: "required",
      role: "画面主体，保持固定脸。",
      continuityState: `第 ${offset + 1} 格站位连续。`,
      evidence: [{ kind: "prompt-revision", reference: promptRevisionId, note: "显式宫格绑定。" }],
    }, {
      assetId: "prop-complete-mask",
      category: "prop",
      presence: "forbidden",
      role: "藏在布囊内，当前不得露出。",
      continuityState: "始终为完整黄金面具。",
      evidence: [{ kind: "hard-lock", reference: "P04-complete-mask", note: "禁止半面具。" }],
    }],
  } satisfies StudioProductionPanelInput));
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([key, entry]) => [key, stableValue(entry)]));
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stableValue(value)), "utf8").digest("hex");
}

async function bindReadyPanel(root: string, unitId: string, panelId: string) {
  const snapshot = await getStudioProductionUnitSnapshot(root, unitId);
  if (!snapshot) throw new Error("missing ledger unit");
  const panel = snapshot.panels.find((item) => item.id === panelId)!;
  const details = await Promise.all(panel.assets.map((mention) => getStudioCanonicalAsset(root, mention.assetId)));
  if (details.some((detail) => !detail)) throw new Error("missing ledger canonical asset");
  const analysis = await analyzeStudioPanelAssetMentions(root, {
    unitId,
    unitRevision: snapshot.unit.revision,
    unitFingerprint: snapshot.fingerprint,
    panelIndex: panel.index,
    scriptRevisionId: snapshot.scriptRevision.id,
    scriptSha256: snapshot.scriptRevision.bodySha256,
    expectedHeadRevision: 0,
    mentions: panel.assets.map((mention, index) => ({
      id: `ledger-mention-${unitId}-${panelId}-${index + 1}`,
      surfaceText: snapshot.scriptRevision.body.slice(index, index + 1),
      startOffsetUtf16: index,
      endOffsetUtf16: index + 1,
      category: mention.category,
      presence: mention.presence,
      role: mention.role,
      modelSuggestions: [{ assetId: mention.assetId, category: mention.category, confidence: 1 }],
    })),
    assets: details.map((detail) => ({
      assetId: detail!.id,
      category: detail!.category,
      formalName: detail!.name,
      aliases: detail!.aliases,
    })),
    resolverVersion: "ledger-test-v1",
  });
  const decisions = await Promise.all(analysis.proposals.map((proposal) => recordStudioMentionDecision(root, {
    receiptId: `ledger-decision-${proposal.mentionId}`,
    proposalId: proposal.id,
    expectedAnalysisHeadRevision: analysis.revision,
    expectedDecisionHeadRevision: 0,
    action: "select",
    selectedAssetId: proposal.candidates.find((candidate) => candidate.kind === "model")!.assetId,
    presence: proposal.presence,
    role: proposal.role,
    reviewer: "ledger-test",
    note: "显式绑定确认。",
  })));
  const projectId = (await inspectManagedProject(root)).project.id;
  const target = {
    projectId,
    seasonId: snapshot.unit.season,
    episodeId: snapshot.unit.episode,
    unitId,
    unitLocalStartSeconds: panel.startSeconds,
    unitLocalEndSeconds: panel.endSeconds,
    episodeAbsoluteStartSeconds: (snapshot.unit.sequence - 1) * 15 + panel.startSeconds,
    episodeAbsoluteEndSeconds: (snapshot.unit.sequence - 1) * 15 + panel.endSeconds,
  };
  const assetSources = await Promise.all(details.map(async (detail) => {
    const definition = detail!.definitionVersions.find((entry) => entry.id === detail!.currentDefinitionVersionId)!;
    const authority = detail!.authorityHistory.at(-1)!;
    const version = detail!.versions.find((entry) => entry.id === detail!.primaryAuthority!.versionId)!;
    const knowledge = await getStudioCanonicalAssetKnowledgeSnapshot(root, detail!.id, target);
    const applicability = evaluateStudioAssetApplicability(definition.applicability, target);
    return {
      assetId: detail!.id,
      category: detail!.category,
      assetRevision: detail!.revision,
      definitionVersionId: definition.id,
      authorityEventId: authority.id,
      authorityVersionId: authority.versionId,
      assetVersionId: version.id,
      mediaSha256: version.mediaSha256,
      knowledgeFingerprint: knowledge!.fingerprint,
      applicabilityFingerprint: digest(applicability),
    };
  }));
  const bindingSet = await freezeStudioPanelAssetBindingSet(root, {
    analysisId: analysis.id,
    expectedAnalysisHeadRevision: analysis.revision,
    expectedBindingHeadRevision: 0,
    decisionReceiptIds: decisions.map((decision) => decision.id),
    assetSources,
  });
  const scope = {
    kind: "panel" as const,
    scopeId: panel.id,
    unitId,
    unitRevision: bindingSet.unitRevision,
    startMilliseconds: Math.round(panel.startSeconds * 1_000),
    endMilliseconds: Math.round(panel.endSeconds * 1_000),
  };
  for (const binding of bindingSet.bindings.filter((entry) => entry.presence !== "forbidden")) {
    for (const field of STUDIO_CONTINUITY_FIELDS) {
      const value = field === "referenceSha256"
        ? binding.mediaSha256
        : `ledger-fixture:${unitId}:${panelId}:${binding.assetId}:${field}`;
      await appendStudioContinuityObservation(root, {
        operationId: `p6-ledger-continuity-${unitId}-${bindingSet.unitRevision}-${panelId}-${binding.assetId}-${field}`,
        expectedHeadRevision: 0,
        scope,
        subjectId: binding.assetId,
        field,
        state: {
          status: "resolved",
          value,
          provenance: [{
            kind: "deterministic-fixture",
            reference: `${unitId}/${panelId}/${binding.assetId}/${field}`,
            sourceFingerprint: field === "referenceSha256" ? value : digest({ unitId, panelId, assetId: binding.assetId, field, value }),
            note: "P6 ledger regression fixture explicit continuity seed.",
          }],
        },
      });
    }
  }
  return bindingSet;
}

async function readyProject() {
  const root = await managedProject();
  const scriptDocument = await createStudioScriptDocument(root, {
    id: "script-main",
    title: "主剧本",
    expectedRevision: 0,
  });
  const script = await appendStudioScriptRevision(root, {
    documentId: scriptDocument.id,
    expectedRevision: 0,
    body: "阿航走入古蜀石室。",
    source: "scripts/EP01.md",
    sourceVersion: "script-v1",
  });
  const promptDocument = await createStudioPromptDocument(root, {
    id: "prompt-main",
    title: "主提示词",
    expectedRevision: 0,
  });
  const prompt = await appendStudioPromptRevision(root, {
    documentId: promptDocument.id,
    expectedRevision: 0,
    body: "只生成一张电影写实分镜，保持阿航一致。",
    source: "prompts/EP01.txt",
    sourceVersion: "prompt-v1",
  });
  const unit = await createStudioProductionUnit(root, {
    id: "unit-001",
    expectedRevision: 0,
    season: "S03",
    episode: "EP01",
    sequence: 1,
    title: "石室入口",
    scriptRevisionId: script.revision.id,
    panels: panels(prompt.revision.id),
  });
  const referenceMedia = await createImage(root, "ahang-authority", "#654b37");
  const asset = await createStudioCanonicalAsset(root, {
    id: "character-ahang",
    expectedRevision: 0,
    category: "character",
    name: "阿航",
    identityFeatures: ["东方青年面孔", "黑色束发"],
    positiveLocks: ["固定脸", "素麻古蜀服"],
    negativeLocks: ["禁止换脸", "禁止现代服饰"],
    defaultPrompt: "阿航，电影写实，固定角色。",
  });
  const version = await appendStudioAssetVersion(root, {
    assetId: asset.id,
    mediaSha256: referenceMedia.sha256,
    reviewStatus: "pending",
    expectedRevision: asset.revision,
  });
  const reviewed = await reviewStudioAssetVersion(root, {
    assetId: asset.id,
    versionId: version.version.id,
    decision: "approved",
    expectedRevision: version.assetRevision,
    note: "P5 主权威 fixture 审核通过。",
  });
  const authoritative = await setStudioPrimaryAuthority(root, {
    assetId: asset.id,
    versionId: version.version.id,
    expectedRevision: reviewed.revision,
    note: "P5 主权威。",
  });
  const forbiddenAsset = await createStudioCanonicalAsset(root, {
    id: "prop-complete-mask",
    expectedRevision: 0,
    category: "prop",
    name: "完整黄金面具",
    identityFeatures: ["完整对称金面结构"],
    positiveLocks: ["始终保持完整面具"],
    negativeLocks: ["禁止半面具", "禁止当前格露出"],
    defaultPrompt: "完整黄金面具藏在布囊内，不入画。",
  });
  const forbiddenMedia = await createImage(root, "mask-authority", "#9a7020");
  const forbiddenVersion = await appendStudioAssetVersion(root, {
    assetId: forbiddenAsset.id,
    mediaSha256: forbiddenMedia.sha256,
    reviewStatus: "pending",
    expectedRevision: forbiddenAsset.revision,
  });
  const forbiddenReviewed = await reviewStudioAssetVersion(root, {
    assetId: forbiddenAsset.id,
    versionId: forbiddenVersion.version.id,
    decision: "approved",
    expectedRevision: forbiddenVersion.assetRevision,
    note: "禁止资产权威审核通过。",
  });
  const forbiddenAuthoritative = await setStudioPrimaryAuthority(root, {
    assetId: forbiddenAsset.id,
    versionId: forbiddenVersion.version.id,
    expectedRevision: forbiddenReviewed.revision,
    note: "禁止资产仅锁身份，不进入控制图上传。",
  });
  await bindReadyPanel(root, unit.unit.id, "panel-01");
  return { root, unit, script, prompt, referenceMedia, authoritative, forbiddenAsset: forbiddenAuthoritative };
}

async function registerInput(
  root: string,
  pack: Awaited<ReturnType<typeof freezeAndPersistStudioGenerationPack>>,
  generationRunId: string,
  color: string,
  variant: "raw" | "labeled" = "raw",
) {
  const dispatch = await dispatchStudioGenerationPack(root, {
    packId: pack.packId,
    packFingerprint: pack.fingerprint,
    generationRunId,
    provider: "codex",
  });
  const media = await createImage(root, `${generationRunId}-${variant}-${color.replace("#", "")}`, color);
  const input = {
    packId: pack.packId,
    packFingerprint: pack.fingerprint,
    generationRunId,
    variant,
    mediaSha256: media.sha256,
  } as const;
  return { dispatch, media, input };
}

function downgradeGenerationLedgerToV1(databasePath: string): void {
  const db = new DatabaseSync(databasePath);
  try {
    db.exec(`
      PRAGMA foreign_keys=OFF;
      DROP TRIGGER IF EXISTS studio_generation_results_no_update;
      DROP TRIGGER IF EXISTS studio_generation_results_no_delete;
      DROP INDEX IF EXISTS studio_generation_result_panel_sequence_idx;
      DROP INDEX IF EXISTS studio_generation_result_pack_idx;
      ALTER TABLE studio_generation_results RENAME TO studio_generation_results_v2_source;
      CREATE TABLE studio_generation_results (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        result_id TEXT NOT NULL UNIQUE,
        generation_run_id TEXT NOT NULL,
        variant TEXT NOT NULL CHECK(variant IN ('raw', 'labeled')),
        status TEXT NOT NULL CHECK(status IN ('pending', 'approved', 'rejected')),
        media_sha256 TEXT NOT NULL CHECK(length(media_sha256) = 64),
        pack_id TEXT NOT NULL,
        pack_fingerprint TEXT NOT NULL CHECK(length(pack_fingerprint) = 64),
        unit_id TEXT NOT NULL,
        unit_revision INTEGER NOT NULL CHECK(unit_revision >= 1),
        panel_id TEXT NOT NULL,
        panel_index INTEGER NOT NULL CHECK(panel_index BETWEEN 1 AND 6),
        created_at TEXT NOT NULL,
        UNIQUE(generation_run_id, variant),
        FOREIGN KEY(pack_id, pack_fingerprint)
          REFERENCES studio_generation_packs(pack_id, fingerprint) ON DELETE RESTRICT
      ) STRICT;
      INSERT INTO studio_generation_results(
        sequence, result_id, generation_run_id, variant, status, media_sha256,
        pack_id, pack_fingerprint, unit_id, unit_revision, panel_id, panel_index, created_at
      ) SELECT
        sequence, result_id, generation_run_id, variant, status, media_sha256,
        pack_id, pack_fingerprint, unit_id, unit_revision, panel_id, panel_index, created_at
      FROM studio_generation_results_v2_source ORDER BY sequence;
      DROP TABLE studio_generation_results_v2_source;
      DROP TRIGGER IF EXISTS studio_generation_dispatches_no_update;
      DROP TRIGGER IF EXISTS studio_generation_dispatches_no_delete;
      DROP INDEX IF EXISTS studio_generation_dispatch_pack_idx;
      DROP TABLE studio_generation_dispatches;
      CREATE INDEX studio_generation_result_panel_sequence_idx
        ON studio_generation_results(unit_id, panel_id, sequence);
      CREATE INDEX studio_generation_result_pack_idx
        ON studio_generation_results(pack_id, sequence);
      CREATE TRIGGER studio_generation_results_no_update
        BEFORE UPDATE ON studio_generation_results BEGIN SELECT RAISE(ABORT, 'generation results are append-only'); END;
      CREATE TRIGGER studio_generation_results_no_delete
        BEFORE DELETE ON studio_generation_results BEGIN SELECT RAISE(ABORT, 'generation results are append-only'); END;
      UPDATE studio_generation_ledger_meta SET value = '1' WHERE key = 'schema_version';
      PRAGMA foreign_keys=ON;
    `);
  } finally {
    db.close();
  }
}

function downgradeGenerationLedgerToV4(databasePath: string, corruptCallEvents = false): void {
  const db = new DatabaseSync(databasePath);
  try {
    db.exec(`
      PRAGMA foreign_keys=OFF;
      DROP TABLE IF EXISTS studio_generation_detached_unknown_dispositions;
      DROP INDEX IF EXISTS studio_generation_dispatch_call_identity_idx;
      DROP TABLE IF EXISTS studio_generation_call_events;
      DROP TABLE IF EXISTS studio_generation_call_intents;
      DROP TABLE IF EXISTS studio_generation_dispatch_protocols;
      DROP TABLE IF EXISTS studio_generation_historical_imports;
      DROP TABLE IF EXISTS studio_generation_detached_unknown_observations;
      DROP TABLE IF EXISTS studio_generation_plan_node_targets;
      DROP TABLE IF EXISTS studio_generation_pack_targets;
      UPDATE studio_generation_ledger_meta SET value = '4' WHERE key = 'schema_version';
      PRAGMA foreign_keys=ON;
    `);
    if (corruptCallEvents) db.exec("CREATE TABLE studio_generation_call_events(wrong_column TEXT) STRICT;");
  } finally {
    db.close();
  }
}

function downgradeGenerationLedgerToV5(databasePath: string): void {
  const db = new DatabaseSync(databasePath);
  try {
    db.exec(`
      PRAGMA foreign_keys=OFF;
      DROP TRIGGER IF EXISTS studio_generation_detached_disposition_no_update;
      DROP TRIGGER IF EXISTS studio_generation_detached_disposition_no_delete;
      DROP INDEX IF EXISTS studio_generation_detached_disposition_target_idx;
      DROP TABLE IF EXISTS studio_generation_detached_unknown_dispositions;
      ALTER TABLE studio_generation_call_intents DROP COLUMN caller_agent_id;
      UPDATE studio_generation_ledger_meta SET value = '5' WHERE key = 'schema_version';
      PRAGMA foreign_keys=ON;
    `);
  } finally {
    db.close();
  }
}

function downgradeGenerationLedgerToV3(databasePath: string): void {
  downgradeGenerationLedgerToV4(databasePath);
  const db = new DatabaseSync(databasePath);
  try {
    db.exec(`
      PRAGMA foreign_keys=OFF;
      DROP TABLE studio_generation_run_events;
      DROP TABLE studio_generation_plan_nodes;
      DROP TABLE studio_generation_plans;
      UPDATE studio_generation_ledger_meta SET value = '3' WHERE key = 'schema_version';
      PRAGMA foreign_keys=ON;
    `);
  } finally {
    db.close();
  }
}

function downgradeGenerationLedgerToV2(databasePath: string): void {
  downgradeGenerationLedgerToV3(databasePath);
  const db = new DatabaseSync(databasePath);
  try {
    db.exec(`
      PRAGMA foreign_keys=OFF;
      DROP TRIGGER studio_generation_dispatches_no_update;
      DROP TRIGGER studio_generation_dispatches_no_delete;
      DROP TRIGGER studio_generation_results_no_update;
      DROP TRIGGER studio_generation_results_no_delete;
      DROP INDEX studio_generation_dispatch_pack_idx;
      DROP INDEX studio_generation_result_panel_sequence_idx;
      DROP INDEX studio_generation_result_pack_idx;
      ALTER TABLE studio_generation_results RENAME TO studio_generation_results_v3_source;
      ALTER TABLE studio_generation_dispatches RENAME TO studio_generation_dispatches_v3_source;

      CREATE TABLE studio_generation_dispatches (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        dispatch_id TEXT NOT NULL UNIQUE,
        generation_run_id TEXT NOT NULL UNIQUE,
        pack_id TEXT NOT NULL,
        pack_fingerprint TEXT NOT NULL CHECK(length(pack_fingerprint) = 64),
        provenance TEXT NOT NULL CHECK(provenance IN ('local-dispatch-intent', 'legacy-registration')),
        dispatched_at TEXT NOT NULL,
        UNIQUE(dispatch_id, generation_run_id, pack_id, pack_fingerprint),
        FOREIGN KEY(pack_id, pack_fingerprint)
          REFERENCES studio_generation_packs(pack_id, fingerprint) ON DELETE RESTRICT
      ) STRICT;
      CREATE TABLE studio_generation_results (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        result_id TEXT NOT NULL UNIQUE,
        dispatch_id TEXT NOT NULL,
        generation_run_id TEXT NOT NULL,
        variant TEXT NOT NULL CHECK(variant IN ('raw', 'labeled')),
        status TEXT NOT NULL CHECK(status IN ('pending', 'approved', 'rejected')),
        media_sha256 TEXT NOT NULL CHECK(length(media_sha256) = 64),
        input_current INTEGER NOT NULL CHECK(input_current IN (0, 1)),
        promotion_eligible INTEGER NOT NULL CHECK(promotion_eligible IN (0, 1)),
        stale_reasons_json TEXT NOT NULL,
        pack_id TEXT NOT NULL,
        pack_fingerprint TEXT NOT NULL CHECK(length(pack_fingerprint) = 64),
        unit_id TEXT NOT NULL,
        unit_revision INTEGER NOT NULL CHECK(unit_revision >= 1),
        panel_id TEXT NOT NULL,
        panel_index INTEGER NOT NULL CHECK(panel_index BETWEEN 1 AND 6),
        created_at TEXT NOT NULL,
        UNIQUE(generation_run_id, variant),
        FOREIGN KEY(pack_id, pack_fingerprint)
          REFERENCES studio_generation_packs(pack_id, fingerprint) ON DELETE RESTRICT,
        FOREIGN KEY(dispatch_id, generation_run_id, pack_id, pack_fingerprint)
          REFERENCES studio_generation_dispatches(dispatch_id, generation_run_id, pack_id, pack_fingerprint)
          ON DELETE RESTRICT
      ) STRICT;
      INSERT INTO studio_generation_dispatches(
        sequence, dispatch_id, generation_run_id, pack_id, pack_fingerprint, provenance, dispatched_at
      ) SELECT sequence, dispatch_id, generation_run_id, pack_id, pack_fingerprint, provenance, dispatched_at
        FROM studio_generation_dispatches_v3_source ORDER BY sequence;
      INSERT INTO studio_generation_results(
        sequence, result_id, dispatch_id, generation_run_id, variant, status, media_sha256,
        input_current, promotion_eligible, stale_reasons_json, pack_id, pack_fingerprint,
        unit_id, unit_revision, panel_id, panel_index, created_at
      ) SELECT sequence, result_id, dispatch_id, generation_run_id, variant, status, media_sha256,
        input_current, promotion_eligible, stale_reasons_json, pack_id, pack_fingerprint,
        unit_id, unit_revision, panel_id, panel_index, created_at
        FROM studio_generation_results_v3_source ORDER BY sequence;
      DROP TABLE studio_generation_results_v3_source;
      DROP TABLE studio_generation_dispatches_v3_source;
      CREATE INDEX studio_generation_dispatch_pack_idx
        ON studio_generation_dispatches(pack_id, sequence);
      CREATE INDEX studio_generation_result_panel_sequence_idx
        ON studio_generation_results(unit_id, panel_id, sequence);
      CREATE INDEX studio_generation_result_pack_idx
        ON studio_generation_results(pack_id, sequence);
      CREATE TRIGGER studio_generation_dispatches_no_update
        BEFORE UPDATE ON studio_generation_dispatches BEGIN SELECT RAISE(ABORT, 'generation dispatches are append-only'); END;
      CREATE TRIGGER studio_generation_dispatches_no_delete
        BEFORE DELETE ON studio_generation_dispatches BEGIN SELECT RAISE(ABORT, 'generation dispatches are append-only'); END;
      CREATE TRIGGER studio_generation_results_no_update
        BEFORE UPDATE ON studio_generation_results BEGIN SELECT RAISE(ABORT, 'generation results are append-only'); END;
      CREATE TRIGGER studio_generation_results_no_delete
        BEFORE DELETE ON studio_generation_results BEGIN SELECT RAISE(ABORT, 'generation results are append-only'); END;
      UPDATE studio_generation_ledger_meta SET value = '2' WHERE key = 'schema_version';
      PRAGMA foreign_keys=ON;
    `);
  } finally {
    db.close();
  }
}

describe("Studio generation 本地持久账本", () => {
  it("future schema 在 writable open 前拒绝且不创建 SQLite sidecar", async () => {
    const fixture = await readyProject();
    const databasePath = path.join(fixture.root, ".aicanvas", "studio-generation-ledger.sqlite");
    const db = new DatabaseSync(databasePath);
    db.prepare("UPDATE studio_generation_ledger_meta SET value='999' WHERE key='schema_version'").run();
    db.close();
    const beforeBytes = await readFile(databasePath);
    const beforeEntries = (await readdir(path.dirname(databasePath))).sort();

    await expect(initializeStudioGenerationLedger(fixture.root))
      .rejects.toMatchObject({ code: "storage-invalid" });
    expect(await readFile(databasePath)).toEqual(beforeBytes);
    expect((await readdir(path.dirname(databasePath))).sort()).toEqual(beforeEntries);
  });

  it("只读预检后数据库被 future inode 替换时在 SQLite 写打开前失败关闭", async () => {
    const fixture = await readyProject();
    const databasePath = path.join(fixture.root, ".aicanvas", "studio-generation-ledger.sqlite");
    const displacedPath = `${databasePath}.preflight-original`;
    const replacementPath = `${databasePath}.future-replacement`;
    const future = new DatabaseSync(replacementPath);
    future.exec(`
      CREATE TABLE studio_generation_ledger_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      INSERT INTO studio_generation_ledger_meta(key, value) VALUES('schema_version', '999');
    `);
    future.close();
    const originalBytes = await readFile(databasePath);
    const replacementBytes = await readFile(replacementPath);

    __setBeforeGenerationWritableOpenHookForTests(async ({ databasePath: openedPath }) => {
      expect(openedPath).toBe(databasePath);
      await rename(databasePath, displacedPath);
      await rename(replacementPath, databasePath);
    });

    await expect(initializeStudioGenerationLedger(fixture.root))
      .rejects.toMatchObject({ code: "storage-invalid" });
    expect(await readFile(displacedPath)).toEqual(originalBytes);
    expect(await readFile(databasePath)).toEqual(replacementBytes);
    expect((await readdir(path.dirname(databasePath))).filter((name) => name.endsWith("-journal"))).toEqual([]);
  });

  it("generation 主库及现存 sidecar 只允许单链接文件", async () => {
    const fixture = await readyProject();
    const databasePath = path.join(fixture.root, ".aicanvas", "studio-generation-ledger.sqlite");
    const aliasPath = `${databasePath}.hardlink-alias`;
    const before = await readFile(databasePath);
    await link(databasePath, aliasPath);
    await expect(initializeStudioGenerationLedger(fixture.root))
      .rejects.toMatchObject({ code: "storage-invalid" });
    expect(await readFile(databasePath)).toEqual(before);
    await rm(aliasPath);

    await initializeStudioGenerationLedger(fixture.root);
    for (const suffix of ["-wal", "-shm", "-journal"] as const) {
      const sidecarPath = `${databasePath}${suffix}`;
      const sidecarAlias = `${sidecarPath}.hardlink-alias`;
      await rm(sidecarPath, { force: true });
      await writeFile(sidecarPath, `unsafe${suffix}`);
      await link(sidecarPath, sidecarAlias);
      await expect(initializeStudioGenerationLedger(fixture.root))
        .rejects.toMatchObject({ code: "storage-invalid" });
      await rm(sidecarAlias);
      await rm(sidecarPath);
    }
  });

  it("v5 generation 任意附加 trigger/view 在只读预检阶段失败关闭", async () => {
    const fixture = await readyProject();
    const databasePath = path.join(fixture.root, ".aicanvas", "studio-generation-ledger.sqlite");
    const db = new DatabaseSync(databasePath);
    db.exec(`
      CREATE TRIGGER arbitrary_generation_side_effect
        AFTER INSERT ON studio_generation_packs BEGIN DELETE FROM studio_generation_packs; END;
      CREATE VIEW arbitrary_generation_view AS SELECT pack_id FROM studio_generation_packs;
    `);
    db.close();
    const beforeBytes = await readFile(databasePath);
    const beforeEntries = (await readdir(path.dirname(databasePath))).sort();
    await expect(initializeStudioGenerationLedger(fixture.root))
      .rejects.toMatchObject({ code: "storage-invalid" });
    expect(await readFile(databasePath)).toEqual(beforeBytes);
    expect((await readdir(path.dirname(databasePath))).sort()).toEqual(beforeEntries);
  });

  it("generation pack CAS 根或临时目录为 symlink 时冻结失败且账本零新增", async () => {
    for (const target of ["root", "temporary"] as const) {
      const fixture = await readyProject();
      const outside = path.join(fixture.root, `outside-generation-${target}`);
      await mkdir(outside);
      const objects = path.join(fixture.root, ".aicanvas", "studio-generation", "objects");
      const replaced = target === "root" ? path.join(objects, "sha256") : path.join(objects, ".tmp");
      await rm(replaced, { recursive: true, force: true });
      await symlink(outside, replaced, "dir");

      await expect(freezeAndPersistStudioGenerationPack(fixture.root, {
        unitId: "unit-001",
        panelId: "panel-01",
      })).rejects.toThrow(/符号链接|真实路径|受管项目/u);
      expect(await readdir(outside)).toEqual([]);
      const db = new DatabaseSync(path.join(fixture.root, ".aicanvas", "studio-generation-ledger.sqlite"), { readOnly: true });
      try {
        expect(db.prepare("SELECT COUNT(*) AS count FROM studio_generation_packs").get()).toEqual({ count: 0 });
      } finally {
        db.close();
      }
    }
  });

  it("冻结包以小 JSON 写入内容寻址 CAS，SQLite 只存轻量索引，重复冻结幂等", async () => {
    const fixture = await readyProject();
    const empty = await initializeStudioGenerationLedger(fixture.root);
    expect(empty.counts).toEqual({
      packs: 0,
      dispatches: 0,
      results: 0,
      pendingResults: 0,
      staleAtRegistrationResults: 0,
      plans: 0,
      runEvents: 0,
      targetExtensions: 0,
      callIntents: 0,
      callEvents: 0,
      historicalImports: 0,
      detachedUnknownObservations: 0,
      detachedUnknownDispositions: 0,
    });

    const first = await freezeAndPersistStudioGenerationPack(fixture.root, { unitId: "unit-001", panelId: "panel-01" });
    const second = await freezeAndPersistStudioGenerationPack(fixture.root, { unitId: "unit-001", panelId: "panel-01" });
    expect(second).toEqual(first);
    expect(first).toMatchObject({
      persisted: true,
      packId: first.pack.id,
      fingerprint: first.pack.fingerprint,
      unitId: "unit-001",
      panelId: "panel-01",
      panelIndex: 1,
    });
    expect((await getStudioGenerationLedgerState(fixture.root)).counts).toEqual({
      packs: 1,
      dispatches: 0,
      results: 0,
      pendingResults: 0,
      staleAtRegistrationResults: 0,
      plans: 0,
      runEvents: 0,
      targetExtensions: 0,
      callIntents: 0,
      callEvents: 0,
      historicalImports: 0,
      detachedUnknownObservations: 0,
      detachedUnknownDispositions: 0,
    });

    const databasePath = path.join(fixture.root, ".aicanvas", "studio-generation-ledger.sqlite");
    const db = new DatabaseSync(databasePath);
    const row = db.prepare("SELECT content_sha256, content_relpath, content_size_bytes FROM studio_generation_packs").get() as {
      content_sha256: string;
      content_relpath: string;
      content_size_bytes: number;
    };
    const columns = db.prepare("PRAGMA table_info(studio_generation_packs)").all() as Array<{ name: string; type: string }>;
    db.close();
    expect(columns.map((column) => column.name)).not.toContain("pack_json");
    expect(columns.some((column) => column.type.toUpperCase() === "BLOB")).toBe(false);
    const casPath = path.join(fixture.root, ...row.content_relpath.split("/"));
    const bytes = await readFile(casPath);
    expect(bytes.byteLength).toBe(row.content_size_bytes);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(row.content_sha256);
    expect(path.basename(casPath)).toBe(`${row.content_sha256}.json`);
    expect(JSON.parse(bytes.toString("utf8"))).toEqual(first.pack);

    // 每次读取都重开 SQLite/CAS，验证进程重启后的持久恢复路径。
    await expect(readStudioGenerationFrozenPack(fixture.root, first.packId)).resolves.toEqual(first.pack);
    await expect(readPersistedStudioGenerationPack(fixture.root, first.packId)).resolves.toEqual(first.pack);
  });

  it("unit-grid 使用同账本目标扩展与稳定 pre-call intent，unknown 时禁止重复执行并与 bundle 原子收口", async () => {
    const fixture = await readyProject();
    await bindReadyPanel(fixture.root, "unit-001", "panel-02");
    const first = await freezeAndPersistStudioUnitGridGenerationPack(fixture.root, {
      targetKind: "unit-grid",
      unitId: "unit-001",
    });
    const replay = await freezeAndPersistStudioUnitGridGenerationPack(fixture.root, {
      targetKind: "unit-grid",
      unitId: "unit-001",
    });
    expect(replay).toEqual(first);
    await expect(readStudioUnitGridGenerationFrozenPack(fixture.root, first.packId)).resolves.toEqual(first.pack);
    await expect(readStudioGenerationFrozenPack(fixture.root, first.packId))
      .rejects.toMatchObject({ code: "pack-schema-unsupported" });

    const dispatch = await dispatchStudioGenerationPack(fixture.root, {
      packId: first.packId,
      packFingerprint: first.fingerprint,
      generationRunId: "grid-run-001",
      provider: "codex",
    });
    const intent = await prepareStudioImagegenCall(fixture.root, {
      packId: first.packId,
      packFingerprint: first.fingerprint,
      generationRunId: "grid-run-001",
      provider: "codex",
      projectContextToken: "isolated-worker-token-001",
      commandRequestId: "grid-call-command-001",
      expectedRevision: 0,
    });
    expect(intent).toMatchObject({
      generationRunId: "grid-run-001",
      dispatchId: dispatch.dispatchId,
      targetKind: "unit-grid",
      targetKey: "unit-grid:unit-001",
      status: "generation_unknown",
      callAllowed: true,
      idempotentReplay: false,
    });
    const intentReplay = await prepareStudioImagegenCall(fixture.root, {
      packId: first.packId,
      packFingerprint: first.fingerprint,
      generationRunId: "grid-run-001",
      provider: "codex",
      projectContextToken: "another-window-token-must-not-recall",
      commandRequestId: "grid-call-command-replay",
      expectedRevision: 0,
    });
    expect(intentReplay).toMatchObject({
      callId: intent.callId,
      status: "generation_unknown",
      callAllowed: false,
      idempotentReplay: true,
    });
    await expect(cancelStudioGenerationRun(fixture.root, { generationRunId: "grid-run-001" }))
      .rejects.toMatchObject({ code: "generation-unknown" });
    await expect(failStudioGenerationRun(fixture.root, {
      generationRunId: "grid-run-001",
      errorClass: "worker-disconnected",
    })).rejects.toMatchObject({ code: "generation-unknown" });

    const single = await createImage(fixture.root, "grid-single-result", "#41576a");
    await expect(registerStudioGenerationResult(fixture.root, {
      packId: first.packId,
      packFingerprint: first.fingerprint,
      generationRunId: "grid-run-001",
      variant: "raw",
      mediaSha256: single.sha256,
      provider: "codex",
    })).rejects.toMatchObject({ code: "call-intent-requires-bundle" });

    const raw = await createImage(fixture.root, "grid-raw-result", "#30495d");
    const labeled = await createImage(fixture.root, "grid-labeled-result", "#715b43");
    await expect(registerStudioGenerationResultBundle(fixture.root, {
      packId: first.packId,
      packFingerprint: first.fingerprint,
      generationRunId: "grid-run-001",
      provider: "codex",
      rawMediaSha256: raw.sha256,
      labeledMediaSha256: labeled.sha256,
    })).rejects.toMatchObject({ code: "call-intent-required" });
    const bundle = await registerStudioGenerationResultBundle(fixture.root, {
      packId: first.packId,
      packFingerprint: first.fingerprint,
      generationRunId: "grid-run-001",
      provider: "codex",
      rawMediaSha256: raw.sha256,
      labeledMediaSha256: labeled.sha256,
      callId: intent.callId,
    });
    expect(bundle).toMatchObject({
      schemaVersion: 5,
      pairComplete: true,
      raw: {
        targetKind: "unit-grid",
        targetKey: "unit-grid:unit-001",
      },
      labeled: {
        targetKind: "unit-grid",
        targetKey: "unit-grid:unit-001",
      },
    });
    expect(bundle.raw).not.toHaveProperty("panelId");
    expect(bundle.raw).not.toHaveProperty("panelIndex");
    expect(bundle.labeled).not.toHaveProperty("panelId");
    expect(bundle.labeled).not.toHaveProperty("panelIndex");
    const trace = await getStudioGenerationTrace(fixture.root, { packId: first.packId });
    expect(trace).toMatchObject({
      target: { targetKind: "unit-grid", targetKey: "unit-grid:unit-001" },
      unit: { unitId: "unit-001", unitRevision: 1 },
      prompt: null,
      panel: null,
      bindingSet: null,
    });
    expect(trace.panels.map((panel) => panel.panelId)).toEqual(["panel-01", "panel-02"]);
    expect(trace.prompts.map((prompt) => prompt.panelId)).toEqual(["panel-01", "panel-02"]);
    expect(trace.bindingSets.length).toBeGreaterThan(0);
    await expect(evaluateStudioGenerationPackCurrentness(fixture.root, first.pack)).resolves.toEqual({
      targetKind: "unit-grid",
      bindingSetId: null,
      bindingSetIds: trace.bindingSets.map((bindingSet) => bindingSet.id).sort((left, right) => left.localeCompare(right, "en")),
      bindingSetStaleReasons: [],
      changeClassification: "current",
      expectedReasons: [],
      unexpectedReasons: [],
    });
    const packIndexes = await listStudioGenerationPacksByUnit(fixture.root, { unitId: "unit-001" });
    expect(packIndexes.items).toEqual([expect.objectContaining({
      packId: first.packId,
      targetKind: "unit-grid",
      targetKey: "unit-grid:unit-001",
      panelId: "unit-grid:unit-001",
      panelIndex: 0,
    })]);
    await expect(listStudioGenerationPacksByUnit(fixture.root, {
      unitId: "unit-001",
      panelId: "panel-01",
    })).resolves.toEqual({ items: [] });
    const review = await submitStudioGenerationReview(fixture.root, {
      operationId: "grid-review-operation-001",
      generationRunId: "grid-run-001",
      kind: "observation",
      expectedHeadRevision: 0,
      rawResultId: bundle.raw.resultId,
      rawSha256: bundle.raw.mediaSha256,
      labeledResultId: bundle.labeled.resultId,
      labeledSha256: bundle.labeled.mediaSha256,
      expectedPackFingerprint: first.fingerprint,
      continuityFingerprint: first.pack.continuityFingerprint,
      decision: "pass",
      criteria: [
        { code: "identity", status: "pass" },
        { code: "grid-order", status: "pass" },
        { code: "no-text", status: "pass" },
      ],
      reviewer: "ledger-unit-grid-test",
      note: "原尺寸人工复核 fixture：身份、宫格顺序与禁字均通过。",
    });
    expect(review).toMatchObject({ current: true, decision: "pass", approvedRawEligible: true });
    await expect(getStudioGenerationReviewControl(fixture.root, "grid-run-001"))
      .resolves.toMatchObject({ status: "pass", nextAction: "approved-raw-ready" });
    const checkpointControl = await getStudioGenerationCheckpointControl(fixture.root);
    expect(checkpointControl).toMatchObject({ completedSlotCount: 1, collectingSlotCount: 1 });
    expect(JSON.stringify(checkpointControl)).not.toContain('"panelId":"panel-01"');
    await expect(listStudioGenerationPanelHistory(fixture.root, {
      unitId: "unit-001",
      panelId: "panel-01",
    })).resolves.toEqual({ items: [] });
    const gridHistoryFirst = await listStudioGenerationUnitGridHistory(fixture.root, {
      unitId: "unit-001",
      limit: 1,
    });
    expect(gridHistoryFirst).toMatchObject({
      items: [{ targetKind: "unit-grid", targetKey: "unit-grid:unit-001", variant: "raw" }],
      nextCursor: expect.any(String),
    });
    expect(gridHistoryFirst.items[0]).not.toHaveProperty("panelId");
    expect(gridHistoryFirst.items[0]).not.toHaveProperty("panelIndex");
    const gridHistorySecond = await listStudioGenerationUnitGridHistory(fixture.root, {
      unitId: "unit-001",
      cursor: gridHistoryFirst.nextCursor,
      limit: 1,
    });
    expect(gridHistorySecond).toMatchObject({
      items: [{ targetKind: "unit-grid", targetKey: "unit-grid:unit-001", variant: "labeled" }],
    });
    expect(gridHistorySecond.items[0]).not.toHaveProperty("panelId");
    expect(gridHistorySecond.items[0]).not.toHaveProperty("panelIndex");
    expect(JSON.stringify([gridHistoryFirst, gridHistorySecond])).not.toContain('"panelId"');
    await expect(listStudioGenerationPanelHistory(fixture.root, {
      unitId: "unit-001",
      panelId: "panel-01",
      cursor: gridHistoryFirst.nextCursor!,
    })).rejects.toMatchObject({ code: "invalid-cursor" });
    const terminalReplay = await prepareStudioImagegenCall(fixture.root, {
      packId: first.packId,
      packFingerprint: first.fingerprint,
      generationRunId: "grid-run-001",
      provider: "codex",
      projectContextToken: "terminal-replay",
      commandRequestId: "grid-call-command-terminal-replay",
      expectedRevision: 0,
    });
    expect(terminalReplay).toMatchObject({
      callId: intent.callId,
      status: "result-committed",
      callAllowed: false,
      idempotentReplay: true,
    });

    await dispatchStudioGenerationPack(fixture.root, {
      packId: first.packId,
      packFingerprint: first.fingerprint,
      generationRunId: "grid-run-002",
      provider: "codex",
    });
    const unknownIntent = await prepareStudioImagegenCall(fixture.root, {
      packId: first.packId,
      packFingerprint: first.fingerprint,
      generationRunId: "grid-run-002",
      provider: "codex",
      projectContextToken: "isolated-worker-token-002",
      commandRequestId: "grid-call-command-002",
      expectedRevision: 0,
    });
    await expect(reconcileStudioImagegenCall(fixture.root, {
      callId: unknownIntent.callId,
      projectContextToken: "different-active-context-token",
      result: "unknown-observation",
      evidenceReference: "must-not-land",
      evidenceFingerprint: digest({ observation: "wrong-context", run: "grid-run-002" }),
    })).rejects.toMatchObject({ code: "call-intent-conflict" });
    await reconcileStudioImagegenCall(fixture.root, {
      callId: unknownIntent.callId,
      projectContextToken: "isolated-worker-token-002",
      result: "unknown-observation",
      evidenceReference: "worker-disconnected-before-receipt",
      evidenceFingerprint: digest({ observation: "no-receipt", run: "grid-run-002" }),
    });
    await expect(cancelStudioGenerationRun(fixture.root, { generationRunId: "grid-run-002" }))
      .rejects.toMatchObject({ code: "generation-unknown" });
    await reconcileStudioImagegenCall(fixture.root, {
      callId: unknownIntent.callId,
      projectContextToken: "isolated-worker-token-002",
      result: "not-invoked",
      evidenceReference: "isolated-worker-structured-receipt",
      evidenceFingerprint: digest({ invoked: false, run: "grid-run-002" }),
    });
    await expect(cancelStudioGenerationRun(fixture.root, {
      generationRunId: "grid-run-002",
      reason: "structured receipt confirms no model call",
    })).resolves.toMatchObject({ kind: "cancelled" });
    expect((await getStudioGenerationLedgerState(fixture.root)).counts).toMatchObject({
      packs: 1,
      dispatches: 2,
      results: 2,
      targetExtensions: 1,
      callIntents: 2,
      callEvents: 3,
    });
  }, 120_000);

  it("owner 可封存 generation_unknown 而不伪造 not-invoked，并永久拒收旧 run 后由 retry 创建 attempt+1", async () => {
    const fixture = await readyProject();
    await bindReadyPanel(fixture.root, "unit-001", "panel-02");
    const frozen = await freezeAndPersistStudioUnitGridGenerationPack(fixture.root, {
      targetKind: "unit-grid",
      unitId: "unit-001",
    });
    const plan = await createStudioGenerationPlan(fixture.root, {
      nodes: [{ targetKind: "unit-grid", unitId: "unit-001" }],
      sourceCommandRequestId: "owner-abandon-plan-command-001",
    });
    const initialProjection = await getStudioGenerationPlanProjection(fixture.root, plan.planId);
    const generationRunId = initialProjection!.nodes[0]!.generationRunId;
    await dispatchStudioGenerationPack(fixture.root, {
      packId: frozen.packId,
      packFingerprint: frozen.fingerprint,
      generationRunId,
      provider: "codex",
    });
    const projectContextToken = `studioctx-v1-${"a".repeat(64)}`;
    const intent = await prepareStudioImagegenCall(fixture.root, {
      packId: frozen.packId,
      packFingerprint: frozen.fingerprint,
      generationRunId,
      provider: "codex",
      projectContextToken,
      commandRequestId: "owner-abandon-call-command-001",
      expectedRevision: 0,
    });
    await expect(retryStudioGenerationPlanNodes(fixture.root, { planId: plan.planId }))
      .rejects.toMatchObject({ code: "generation-unknown" });

    const quarantinedCandidate = Buffer.from("late candidate remains quarantined", "utf8");
    await writeFile(intent.quarantine.candidatePath, quarantinedCandidate);
    const abandonInput = {
      callId: intent.callId,
      generationRunId,
      projectContextToken,
      evidenceReference: "user-owner-abandon-confirmation-20260723",
      evidenceFingerprint: digest({ callId: intent.callId, decision: "owner-abandon" }),
      reason: "用户接受远端调用仍可能存在，并要求永久拒收旧 run 的迟到结果。",
      acknowledgeRemoteMayExist: true as const,
      acknowledgeLateResultWillBeRejected: true as const,
    };
    const abandoned = await abandonStudioGenerationUnknown(fixture.root, abandonInput);
    expect(abandoned).toMatchObject({
      generationRunId,
      kind: "cancelled",
      attempt: 1,
      detail: {
        disposition: "owner-abandoned-generation-unknown",
        remoteInvocation: "unknown-may-exist",
        lateResultPolicy: "quarantine-and-reject",
        publicationPolicy: "forbidden",
        acknowledgeRemoteMayExist: true,
        acknowledgeLateResultWillBeRejected: true,
        evidenceReference: abandonInput.evidenceReference,
        evidenceFingerprint: abandonInput.evidenceFingerprint,
        reason: abandonInput.reason,
      },
    });
    await expect(readFile(intent.quarantine.candidatePath)).resolves.toEqual(quarantinedCandidate);
    await expect(readStudioImagegenCallIntentByRun(fixture.root, generationRunId)).resolves.toMatchObject({
      callId: intent.callId,
      status: "owner-abandoned",
      callAllowed: false,
    });
    expect(await readStudioImagegenCallEventHistory(fixture.root, intent.callId)).toEqual([]);
    expect((await readStudioGenerationRunEventHistory(fixture.root, generationRunId)).map((event) => event.kind))
      .toEqual(["dispatched", "cancel-requested", "cancelled"]);

    const replay = await abandonStudioGenerationUnknown(fixture.root, abandonInput);
    expect(replay.eventId).toBe(abandoned.eventId);
    await expect(abandonStudioGenerationUnknown(fixture.root, {
      ...abandonInput,
      reason: "用户改写了既有封存理由，这不能覆盖已落账的不可逆事实。",
    })).rejects.toMatchObject({ code: "call-intent-conflict" });
    await expect(reconcileStudioImagegenCall(fixture.root, {
      callId: intent.callId,
      projectContextToken,
      result: "not-invoked",
      evidenceReference: "forbidden-after-owner-abandon",
      evidenceFingerprint: digest({ forbidden: true }),
    })).rejects.toMatchObject({ code: "call-intent-conflict" });
    await expect(prepareStudioImagegenCall(fixture.root, {
      packId: frozen.packId,
      packFingerprint: frozen.fingerprint,
      generationRunId,
      provider: "codex",
      projectContextToken,
      commandRequestId: "owner-abandon-call-command-replay",
      expectedRevision: 0,
    })).resolves.toMatchObject({
      callId: intent.callId,
      status: "owner-abandoned",
      callAllowed: false,
      idempotentReplay: true,
    });

    const raw = await createImage(fixture.root, "owner-abandon-late-raw", "#283c4d");
    const labeled = await createImage(fixture.root, "owner-abandon-late-labeled", "#6b5440");
    const lateBundle = () => registerStudioGenerationResultBundle(fixture.root, {
      packId: frozen.packId,
      packFingerprint: frozen.fingerprint,
      generationRunId,
      provider: "codex" as const,
      rawMediaSha256: raw.sha256,
      labeledMediaSha256: labeled.sha256,
      callId: intent.callId,
    });
    await expect(lateBundle()).rejects.toMatchObject({ code: "run-cancelled" });

    const retried = await retryStudioGenerationPlanNodes(fixture.root, { planId: plan.planId });
    expect(retried).toMatchObject({
      planId: plan.planId,
      retried: [{
        nodeIndex: 1,
        generationRunId: `${plan.planId}:node:1:attempt:2`,
        attempt: 2,
        supersedesRunId: generationRunId,
        idempotentReplay: false,
      }],
      skipped: [],
    });
    await expect(lateBundle()).rejects.toMatchObject({ code: "run-cancelled" });
    await expect(readStudioImagegenCallIntentByRun(fixture.root, generationRunId))
      .resolves.toMatchObject({ status: "owner-abandoned" });
    await expect(getStudioGenerationPlanProjection(fixture.root, plan.planId)).resolves.toMatchObject({
      nodes: [{ generationRunId: `${plan.planId}:node:1:attempt:2`, attempt: 2, status: "dispatched" }],
    });
    expect((await getStudioGenerationLedgerState(fixture.root)).counts).toMatchObject({
      dispatches: 2,
      results: 0,
      callIntents: 1,
      callEvents: 0,
      runEvents: 5,
    });
  }, 120_000);

  it("已有 quarantine candidate+receipt 时只追加 context rebind，按 ledger sequence 抵抗墙钟回拨且禁止解锁第二次调用", async () => {
    const fixture = await readyProject();
    await bindReadyPanel(fixture.root, "unit-001", "panel-02");
    const frozen = await freezeAndPersistStudioUnitGridGenerationPack(fixture.root, {
      targetKind: "unit-grid",
      unitId: "unit-001",
    });
    const plan = await createStudioGenerationPlan(fixture.root, {
      nodes: [{ targetKind: "unit-grid", unitId: "unit-001" }],
      sourceCommandRequestId: "context-rebind-plan-command-001",
    });
    const generationRunId = (await getStudioGenerationPlanProjection(fixture.root, plan.planId))!.nodes[0]!.generationRunId;
    await dispatchStudioGenerationPack(fixture.root, {
      packId: frozen.packId,
      packFingerprint: frozen.fingerprint,
      generationRunId,
      provider: "grok",
    });
    const oldToken = `studioctx-v1-${"a".repeat(64)}`;
    const newToken = `studioctx-v1-${"b".repeat(64)}`;
    const intent = await prepareStudioImagegenCall(fixture.root, {
      packId: frozen.packId,
      packFingerprint: frozen.fingerprint,
      generationRunId,
      provider: "grok",
      projectContextToken: oldToken,
      commandRequestId: "context-rebind-call-command-001",
      expectedRevision: 0,
    });
    await sharp({ create: { width: 90, height: 160, channels: 3, background: "#24384b" } })
      .png({ compressionLevel: 0 })
      .toFile(intent.quarantine.candidatePath);
    const validCandidateBytes = await readFile(intent.quarantine.candidatePath);
    const candidateSha256 = createHash("sha256")
      .update(validCandidateBytes)
      .digest("hex");
    const startedAt = new Date(Date.parse(intent.createdAt) + 1_000).toISOString();
    const generatedAt = new Date(Date.parse(intent.createdAt) + 2_000).toISOString();
    const auditReceiptFor = (observedCandidateSha256: string) => ({
      schemaVersion: 1,
      kind: "agent-imagegen-execution-receipt",
      provider: "grok",
      source: "grok-build-imagine",
      attestationLevel: "agent-session-direct",
      cryptographicProviderReceipt: false,
      callId: intent.callId,
      model: "built-in image_gen",
      agentSessionId: "context-rebind-ledger-test",
      toolCallId: "context-rebind-ledger-tool-call",
      toolName: "image_gen",
      toolInvocationCount: 1,
      inputFingerprint: intent.inputFingerprint,
      candidateSha256: observedCandidateSha256,
      startedAt,
      generatedAt,
    });
    const damagedCandidateBytes = Buffer.from(validCandidateBytes);
    damagedCandidateBytes.fill(
      0,
      Math.floor(damagedCandidateBytes.byteLength * 0.45),
      Math.floor(damagedCandidateBytes.byteLength * 0.55),
    );
    await writeFile(intent.quarantine.candidatePath, damagedCandidateBytes);
    const damagedCandidateSha256 = createHash("sha256").update(damagedCandidateBytes).digest("hex");
    const damagedReceipt = auditReceiptFor(damagedCandidateSha256);
    await writeFile(intent.quarantine.receiptPath, `${JSON.stringify(damagedReceipt, null, 2)}\n`);
    const damagedReceiptSha256 = createHash("sha256")
      .update(await readFile(intent.quarantine.receiptPath))
      .digest("hex");
    await expect(rebindStudioImagegenCallContext(fixture.root, {
      callId: intent.callId,
      generationRunId,
      packId: frozen.packId,
      packFingerprint: frozen.fingerprint,
      inputFingerprint: intent.inputFingerprint,
      candidateSha256: damagedCandidateSha256,
      receiptSha256: damagedReceiptSha256,
      projectContextToken: newToken,
      evidenceReference: "damaged-idat-must-not-rebind",
      evidenceFingerprint: digest({ damagedCandidateSha256 }),
      reason: "保留 PNG 头但损坏像素流的候选不得建立 context rebind。",
      acknowledgeBuildChangedAfterInvocation: true,
      acknowledgeNoSecondModelCall: true,
    })).rejects.toMatchObject({ code: "call-intent-conflict" });
    await writeFile(intent.quarantine.candidatePath, validCandidateBytes);
    const auditReceipt = auditReceiptFor(candidateSha256);
    await writeFile(intent.quarantine.receiptPath, `${JSON.stringify(auditReceipt, null, 2)}\n`);
    const receiptSha256 = createHash("sha256")
      .update(await readFile(intent.quarantine.receiptPath))
      .digest("hex");
    const expectedExecutionReceiptFingerprint = digest({
      schemaVersion: 1,
      kind: "agent-imagegen-execution-receipt",
      provider: "grok",
      source: "grok-build-imagine",
      attestationLevel: "agent-session-direct",
      cryptographicProviderReceipt: false,
      callId: intent.callId,
      model: "built-in image_gen",
      generatedAt,
      agentSessionId: "context-rebind-ledger-test",
      toolCallId: "context-rebind-ledger-tool-call",
      toolName: "image_gen",
      toolInvocationCount: 1,
      inputFingerprint: intent.inputFingerprint,
      candidateSha256,
      startedAt,
    });
    const rebindInput = {
      callId: intent.callId,
      generationRunId,
      packId: frozen.packId,
      packFingerprint: frozen.fingerprint,
      inputFingerprint: intent.inputFingerprint,
      candidateSha256,
      receiptSha256,
      projectContextToken: newToken,
      evidenceReference: "user-context-rebind-authority-20260723",
      evidenceFingerprint: digest({ callId: intent.callId, decision: "context-rebind" }),
      reason: "模型调用完成后仅本地源码与构建身份变化，授权同一候选在当前上下文写回。",
      acknowledgeBuildChangedAfterInvocation: true as const,
      acknowledgeNoSecondModelCall: true as const,
    };
    const rebound = await rebindStudioImagegenCallContext(fixture.root, rebindInput);
    expect(rebound).toMatchObject({
      callId: intent.callId,
      generationRunId,
      packId: frozen.packId,
      packFingerprint: frozen.fingerprint,
      inputFingerprint: intent.inputFingerprint,
      fromContextTokenHash: studioImagegenContextTokenHash(oldToken),
      toContextTokenHash: studioImagegenContextTokenHash(newToken),
      candidateSha256,
      receiptSha256,
      executionReceiptFingerprint: expectedExecutionReceiptFingerprint,
      callAllowed: false,
      idempotentReplay: false,
    });
    await expect(readStudioImagegenCallIntentByRun(fixture.root, generationRunId)).resolves.toMatchObject({
      contextTokenHash: studioImagegenContextTokenHash(oldToken),
      status: "generation_unknown",
      callAllowed: false,
    });
    await expect(isStudioImagegenCallContextAuthorized(fixture.root, generationRunId, oldToken)).resolves.toBe(false);
    await expect(isStudioImagegenCallContextAuthorized(fixture.root, generationRunId, newToken)).resolves.toBe(true);
    await expect(isStudioImagegenCallContextAuthorized(
      fixture.root,
      generationRunId,
      `studioctx-v1-${"c".repeat(64)}`,
    )).resolves.toBe(false);
    await expect(readStudioImagegenCallContextRebindByRun(fixture.root, generationRunId))
      .resolves.toMatchObject({ eventId: rebound.eventId, callAllowed: false });

    const replay = await rebindStudioImagegenCallContext(fixture.root, rebindInput);
    expect(replay).toMatchObject({ eventId: rebound.eventId, idempotentReplay: true, callAllowed: false });
    await expect(rebindStudioImagegenCallContext(fixture.root, {
      ...rebindInput,
      candidateSha256: "c".repeat(64),
    })).rejects.toMatchObject({ code: "call-intent-conflict" });
    const legalReservedNote = (await readStudioImagegenCallEventHistory(fixture.root, intent.callId))[0]!.note;
    await expect(reconcileStudioImagegenCall(fixture.root, {
      callId: intent.callId,
      projectContextToken: newToken,
      result: "unknown-observation",
      evidenceReference: "reserved-prefix-injection",
      evidenceFingerprint: digest({ injection: true }),
      note: legalReservedNote,
    })).rejects.toMatchObject({ code: "invalid-input" });
    await expect(reconcileStudioImagegenCall(fixture.root, {
      callId: intent.callId,
      projectContextToken: oldToken,
      result: "not-invoked",
      evidenceReference: "forbidden-not-invoked-after-rebind",
      evidenceFingerprint: digest({ invoked: false }),
    })).rejects.toMatchObject({ code: "call-intent-conflict" });
    await expect(abandonStudioGenerationUnknown(fixture.root, {
      callId: intent.callId,
      generationRunId,
      projectContextToken: newToken,
      evidenceReference: "forbidden-owner-abandon-after-rebind",
      evidenceFingerprint: digest({ abandoned: true }),
      reason: "已有候选与回执，不得封存后开启第二次模型调用。",
      acknowledgeRemoteMayExist: true,
      acknowledgeLateResultWillBeRejected: true,
    })).rejects.toMatchObject({ code: "call-intent-conflict" });
    await expect(failStudioGenerationRun(fixture.root, {
      generationRunId,
      errorClass: "must-not-unlock-retry",
    })).rejects.toMatchObject({ code: "generation-unknown" });
    await expect(cancelStudioGenerationRun(fixture.root, {
      generationRunId,
      reason: "must-not-unlock-retry",
    })).rejects.toMatchObject({ code: "generation-unknown" });
    await expect(retryStudioGenerationPlanNodes(fixture.root, { planId: plan.planId }))
      .rejects.toMatchObject({ code: "generation-unknown" });

    // 模拟第二次构建轮换时系统墙钟被 NTP/人工回拨。第二跳 created_at 会早于
    // 第一跳，但不可变 sequence 更大；权威链必须仍按 ledger 提交顺序闭合。
    const clockRollbackToken = `studioctx-v1-${"d".repeat(64)}`;
    let clockRollbackRebind: Awaited<ReturnType<typeof rebindStudioImagegenCallContext>>;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2000-01-01T00:00:00.000Z"));
    try {
      clockRollbackRebind = await rebindStudioImagegenCallContext(fixture.root, {
        ...rebindInput,
        projectContextToken: clockRollbackToken,
        evidenceReference: "user-context-rebind-clock-rollback-20260723",
        evidenceFingerprint: digest({ callId: intent.callId, decision: "clock-rollback-rebind" }),
        reason: "系统墙钟回拨后仍按不可变 ledger sequence 追加第二跳，且继续禁止第二次模型调用。",
      });
    } finally {
      vi.useRealTimers();
    }
    expect(clockRollbackRebind).toMatchObject({
      fromContextTokenHash: studioImagegenContextTokenHash(newToken),
      toContextTokenHash: studioImagegenContextTokenHash(clockRollbackToken),
      callAllowed: false,
      idempotentReplay: false,
    });
    await expect(readStudioImagegenCallContextRebindByRun(fixture.root, generationRunId))
      .resolves.toMatchObject({ eventId: clockRollbackRebind.eventId });
    await expect(isStudioImagegenCallContextAuthorized(fixture.root, generationRunId, newToken))
      .resolves.toBe(false);
    await expect(isStudioImagegenCallContextAuthorized(fixture.root, generationRunId, clockRollbackToken))
      .resolves.toBe(true);
  }, 120_000);

  it("historical-import 仅投影 unit-grid 历史 PASS，幂等回放保持零调用且禁止真实派发", async () => {
    const fixture = await readyProject();
    await bindReadyPanel(fixture.root, "unit-001", "panel-02");
    const frozen = await freezeAndPersistStudioUnitGridGenerationPack(fixture.root, {
      targetKind: "unit-grid",
      unitId: "unit-001",
    });
    const raw = await createImage(fixture.root, "historical-grid-raw", "#33495a");
    const labeled = await createImage(fixture.root, "historical-grid-labeled", "#6b5842");
    const sourceManifestFingerprint = digest({
      unitId: "unit-001",
      rawSha256: raw.sha256,
      labeledSha256: labeled.sha256,
      qcReference: "02_出图总表/S1E1-U00_质检.md",
    });
    const input = {
      packId: frozen.packId,
      packFingerprint: frozen.fingerprint,
      rawMediaSha256: raw.sha256,
      labeledMediaSha256: labeled.sha256,
      sourceRawSha256: raw.sha256,
      sourceLabeledSha256: labeled.sha256,
      sourceManifestFingerprint,
      qcEvidenceReference: "02_出图总表/S1E1-U00_质检.md",
      qcEvidenceSha256: digest({ qc: "PASS", unitId: "unit-001" }),
      externalStoryboardStatus: "PASS",
    } as const;
    const first = await importStudioHistoricalGenerationEvidence(fixture.root, input);
    const replay = await importStudioHistoricalGenerationEvidence(fixture.root, input);
    expect(replay).toEqual(first);
    expect(first).toMatchObject({
      kind: "studio-historical-generation-evidence",
      provenance: "historical-import",
      packId: frozen.packId,
      packFingerprint: frozen.fingerprint,
      targetKind: "unit-grid",
      targetKey: "unit-grid:unit-001",
      unitId: "unit-001",
      generationRunId: null,
      provider: null,
      callId: null,
      generationCallCount: 0,
      raw: { mediaSha256: raw.sha256, sourceSha256: raw.sha256, status: "approved" },
      labeled: { mediaSha256: labeled.sha256, sourceSha256: labeled.sha256, status: "approved" },
      review: {
        provenance: "external-qc-import",
        decision: "pass",
        externalStoryboardStatus: "PASS",
      },
    });
    await expect(readStudioHistoricalGenerationEvidenceByPack(fixture.root, frozen.packId)).resolves.toEqual(first);
    await expect(readStudioHistoricalGenerationEvidenceByUnit(fixture.root, frozen.unitId)).resolves.toEqual(first);
    const trace = await getStudioGenerationTrace(fixture.root, { packId: frozen.packId });
    expect(trace.historicalEvidence).toEqual(first);
    expect(trace.runs).toEqual([]);
    expect(trace.results).toEqual([]);
    expect(trace.reviews).toEqual([]);
    expect((await getStudioGenerationLedgerState(fixture.root)).counts).toMatchObject({
      packs: 1,
      dispatches: 0,
      results: 0,
      runEvents: 0,
      callIntents: 0,
      callEvents: 0,
      historicalImports: 1,
    });
    await expect(importStudioHistoricalGenerationEvidence(fixture.root, {
      ...input,
      sourceManifestFingerprint: digest({ drift: true }),
    })).rejects.toMatchObject({ code: "historical-import-conflict" });
    await expect(dispatchStudioGenerationPack(fixture.root, {
      packId: frozen.packId,
      packFingerprint: frozen.fingerprint,
      generationRunId: "historical-grid-must-not-dispatch",
      provider: "codex",
    })).rejects.toMatchObject({ code: "historical-import-conflict" });

    const panelPack = await freezeAndPersistStudioGenerationPack(fixture.root, {
      unitId: "unit-001",
      panelId: "panel-01",
    });
    await expect(importStudioHistoricalGenerationEvidence(fixture.root, {
      ...input,
      packId: panelPack.packId,
      packFingerprint: panelPack.fingerprint,
    })).rejects.toMatchObject({ code: "historical-import-conflict" });
  }, 120_000);

  it("detached generation_unknown 只登记外部观察并按 unit-grid 目标阻断新派发", async () => {
    const fixture = await readyProject();
    await bindReadyPanel(fixture.root, "unit-001", "panel-02");
    const input = {
      unitId: fixture.unit.unit.id,
      unitRevision: fixture.unit.unit.revision,
      unitFingerprint: fixture.unit.fingerprint,
      sourceTaskId: "stopped-task-019f8051",
      evidenceReference: "/quarantine/late-unit-grid-candidate.png",
      evidenceFingerprint: digest({ sourceTaskId: "stopped-task-019f8051", observed: true }),
      candidateSha256: digest({ detachedCandidate: true }),
      candidateSizeBytes: 2_532_907,
      candidateWidth: 941,
      candidateHeight: 1_672,
      note: "迟到候选缺少同源 project/pack/run/call/provider 回执；保持原状，禁止转正或重试。",
    } as const;
    const first = await recordStudioDetachedGenerationUnknownObservation(fixture.root, input);
    const replay = await recordStudioDetachedGenerationUnknownObservation(fixture.root, input);
    expect(replay).toEqual(first);
    expect(first).toMatchObject({
      kind: "studio-detached-generation-observation",
      targetKind: "unit-grid",
      targetKey: "unit-grid:unit-001",
      status: "generation_unknown",
      sourceTaskId: input.sourceTaskId,
      candidateSha256: input.candidateSha256,
    });
    expect(first).not.toHaveProperty("provider");
    expect(first).not.toHaveProperty("generationRunId");
    expect(first).not.toHaveProperty("callId");
    await expect(listStudioDetachedGenerationUnknownObservations(fixture.root, { unitId: "unit-001" }))
      .resolves.toEqual([first]);
    await expect(getStudioDetachedGenerationUnknownUnitStates(fixture.root, {
      unitIds: ["unit-002", "unit-001", "unit-001"],
    })).resolves.toEqual({
      "unit-001": "blocked",
      "unit-002": "clear",
    });
    await expect(recordStudioDetachedGenerationUnknownObservation(fixture.root, {
      ...input,
      evidenceFingerprint: digest({ drift: true }),
    })).rejects.toMatchObject({ code: "generation-unknown" });

    const frozen = await freezeAndPersistStudioUnitGridGenerationPack(fixture.root, {
      targetKind: "unit-grid",
      unitId: "unit-001",
    });
    const trace = await getStudioGenerationTrace(fixture.root, { packId: frozen.packId });
    expect(trace.detachedUnknownObservations).toEqual([first]);
    await expect(dispatchStudioGenerationPack(fixture.root, {
      packId: frozen.packId,
      packFingerprint: frozen.fingerprint,
      generationRunId: "detached-unknown-must-not-dispatch",
      provider: "codex",
    })).rejects.toMatchObject({
      code: "generation-unknown",
      details: expect.arrayContaining([expect.stringContaining(first.observationId)]),
    });
    expect((await getStudioGenerationLedgerState(fixture.root)).counts).toMatchObject({
      dispatches: 0,
      results: 0,
      callIntents: 0,
      callEvents: 0,
      detachedUnknownObservations: 1,
    });
  }, 120_000);

  it("owner 以用户原文 SHA 原子处置 detached unknown，保留观察与候选并只放行 fresh run", async () => {
    const fixture = await readyProject();
    await bindReadyPanel(fixture.root, "unit-001", "panel-02");
    const candidateSha256 = digest({ detachedCandidate: "never-reuse" });
    const observation = await recordStudioDetachedGenerationUnknownObservation(fixture.root, {
      unitId: fixture.unit.unit.id,
      unitRevision: fixture.unit.unit.revision,
      unitFingerprint: fixture.unit.fingerprint,
      sourceTaskId: "detached-owner-abandon-source-001",
      evidenceReference: "detached-owner-abandon-evidence-001",
      evidenceFingerprint: digest({ sourceTaskId: "detached-owner-abandon-source-001" }),
      candidateSha256,
      candidateSizeBytes: 2_532_907,
      candidateWidth: 941,
      candidateHeight: 1_672,
      note: "候选保持隔离，owner 风险确认后也永不导入或复用。",
    });
    const frozen = await freezeAndPersistStudioUnitGridGenerationPack(fixture.root, {
      targetKind: "unit-grid",
      unitId: "unit-001",
    });
    const shell = await inspectManagedProject(fixture.root);
    const authorizationText = "接受风险，执行恢复，且优先把已经生成好的图片按时间线顺序 放入无限画布中，然后再执行后续生图任务。";
    const authorizationTextSha256 = createHash("sha256").update(authorizationText, "utf8").digest("hex");
    expect(authorizationTextSha256)
      .toBe("0a2034dbe676c4b30cbd7c78703860b9111a23a68671eb252fb96f2deccc9803");
    const input = {
      observationId: observation.observationId,
      expectedObservationFingerprint: observation.fingerprint,
      projectContextToken: `studioctx-v1-${"a".repeat(64)}`,
      authorizationEvidenceReference: "codex-user-message-20260723-u28-risk-acceptance",
      authorizationText,
      authorizationTextSha256,
      reason: "用户接受潜在重复调用风险；旧 detached 候选永久隔离，只恢复新的正式 run。",
      acknowledgeRemoteGenerationMayExist: true as const,
      acknowledgeDetachedCandidateWillNeverBeImportedOrReused: true as const,
      acknowledgeFreshFormalRunMayDuplicateRemoteGeneration: true as const,
      activeContext: {
        projectId: shell.project.id,
        manifestFingerprint: shell.manifestFingerprint,
        buildId: "build-detached-owner-abandon-test-001",
        sourceDigest: "b".repeat(64),
      },
    };
    await expect(abandonStudioDetachedGenerationUnknown(fixture.root, {
      ...input,
      expectedObservationFingerprint: "c".repeat(64),
    })).rejects.toMatchObject({ code: "generation-unknown" });
    await expect(abandonStudioDetachedGenerationUnknown(fixture.root, {
      ...input,
      authorizationTextSha256: "d".repeat(64),
    })).rejects.toMatchObject({ code: "invalid-input" });

    const first = await abandonStudioDetachedGenerationUnknown(fixture.root, input);
    const replay = await abandonStudioDetachedGenerationUnknown(fixture.root, input);
    expect(first).toMatchObject({
      observationId: observation.observationId,
      observationFingerprint: observation.fingerprint,
      status: "owner-abandoned",
      detachedCandidatePolicy: "never-import-or-reuse",
      nextRunPolicy: "fresh-formal-run-only",
      authorizationTextSha256,
      callAllowed: false,
      idempotentReplay: false,
    });
    expect(replay).toMatchObject({
      dispositionId: first.dispositionId,
      fingerprint: first.fingerprint,
      idempotentReplay: true,
    });
    await expect(listStudioDetachedGenerationUnknownObservations(fixture.root, { unitId: "unit-001" }))
      .resolves.toEqual([observation]);
    await expect(listStudioDetachedGenerationUnknownDispositions(fixture.root, { unitId: "unit-001" }))
      .resolves.toEqual([replay]);
    await expect(listStudioActiveDetachedGenerationUnknownObservations(fixture.root, { unitId: "unit-001" }))
      .resolves.toEqual([]);
    await expect(assertStudioGenerationRawNotDetachedCandidate(fixture.root, {
      packId: frozen.packId,
      packFingerprint: frozen.fingerprint,
      rawMediaSha256: candidateSha256,
    })).rejects.toMatchObject({ code: "generation-unknown" });

    const plan = await createStudioGenerationPlan(fixture.root, {
      nodes: [{ targetKind: "unit-grid", unitId: "unit-001" }],
      sourceCommandRequestId: "detached-owner-abandon-fresh-plan-001",
    });
    const projection = await getStudioGenerationPlanProjection(fixture.root, plan.planId);
    await expect(dispatchStudioGenerationPack(fixture.root, {
      packId: frozen.packId,
      packFingerprint: frozen.fingerprint,
      generationRunId: projection!.nodes[0]!.generationRunId,
      provider: "codex",
    })).resolves.toMatchObject({
      generationRunId: projection!.nodes[0]!.generationRunId,
    });
    const databasePath = path.join(fixture.root, ".aicanvas/studio-generation-ledger.sqlite");
    const tamper = new DatabaseSync(databasePath);
    try {
      expect(() => tamper.prepare(`
        UPDATE studio_generation_detached_unknown_dispositions SET reason='forbidden rewrite'
      `).run()).toThrow(/append-only/u);
      expect(() => tamper.prepare(`
        DELETE FROM studio_generation_detached_unknown_dispositions
      `).run()).toThrow(/append-only/u);
    } finally {
      tamper.close();
    }
    expect((await getStudioGenerationLedgerState(fixture.root)).counts).toMatchObject({
      detachedUnknownObservations: 1,
      detachedUnknownDispositions: 1,
      dispatches: 1,
    });
  }, 120_000);

  it("unit-grid 计划以目标扩展持久化且公开投影不泄漏第一格兼容锚点", async () => {
    const fixture = await readyProject();
    await bindReadyPanel(fixture.root, "unit-001", "panel-02");
    const frozen = await freezeAndPersistStudioUnitGridGenerationPack(fixture.root, {
      targetKind: "unit-grid",
      unitId: "unit-001",
    });
    const first = await createStudioGenerationPlan(fixture.root, {
      nodes: [{ targetKind: "unit-grid", unitId: "unit-001" }],
      sourceCommandRequestId: "grid-plan-command-001",
    });
    const replay = await createStudioGenerationPlan(fixture.root, {
      nodes: [{ targetKind: "unit-grid", unitId: "unit-001" }],
      sourceCommandRequestId: "grid-plan-command-replay",
    });
    expect(replay).toMatchObject({ planId: first.planId, idempotentReplay: true });
    expect(first.nodes).toEqual([expect.objectContaining({
      nodeIndex: 1,
      targetKind: "unit-grid",
      targetKey: "unit-grid:unit-001",
      unitId: "unit-001",
      packId: frozen.packId,
      packFingerprint: frozen.fingerprint,
    })]);
    expect(first.nodes[0]).not.toHaveProperty("panelId");
    const projected = await getStudioGenerationPlanProjection(fixture.root, first.planId);
    expect(projected?.nodes).toEqual([expect.objectContaining({
      targetKind: "unit-grid",
      targetKey: "unit-grid:unit-001",
      status: "planned",
      packStale: false,
    })]);
    expect(projected?.nodes[0]).not.toHaveProperty("panelId");
    await expect(getStudioGenerationLatestPlanForUnitGrid(fixture.root, "unit-001"))
      .resolves.toEqual(projected);
    await expect(buildStudioGenerationPlanProgress(fixture.root)).resolves.toMatchObject({
      nodes: [expect.objectContaining({
        targetKind: "unit-grid",
        targetKey: "unit-grid:unit-001",
        unitId: "unit-001",
      })],
    });
    expect((await buildStudioGenerationPlanProgress(fixture.root)).nodes[0]).not.toHaveProperty("panelId");
    expect(JSON.stringify({ first, projected })).not.toContain('"panelId":"panel-01"');
    expect((await getStudioGenerationLedgerState(fixture.root)).counts)
      .toMatchObject({ packs: 1, plans: 1, dispatches: 0, targetExtensions: 1 });
  }, 120_000);

  it("仅登记已导入且实测 SHA 通过的 image，同参数重复登记幂等且初始 pending", async () => {
    const fixture = await readyProject();
    const frozen = await freezeAndPersistStudioGenerationPack(fixture.root, { unitId: "unit-001", panelId: "panel-01" });
    const result = await registerInput(fixture.root, frozen, "run-success-001", "#293e55");
    const first = await registerStudioGenerationResult(fixture.root, result.input);
    const second = await registerStudioGenerationResult(fixture.root, result.input);
    expect(second).toEqual(first);
    expect(first).toMatchObject({
      resultId: expect.stringMatching(/^studio-generation-result-[a-f0-9]{40}$/u),
      generationRunId: "run-success-001",
      variant: "raw",
      status: "pending",
      mediaSha256: result.media.sha256,
      dispatchId: result.dispatch.dispatchId,
      dispatchProvenance: "local-dispatch-intent",
      packId: frozen.packId,
      packFingerprint: frozen.fingerprint,
      pairComplete: false,
      inputCurrent: true,
      promotionEligible: false,
      staleReasons: [],
    });
    await expect(readStudioGenerationDispatch(fixture.root, "run-success-001"))
      .resolves.toEqual(result.dispatch);
    await expect(assertStudioGenerationResultPromotionEligible(fixture.root, first.resultId))
      .rejects.toMatchObject({ code: "result-promotion-ineligible" });
    expect((await getStudioGenerationLedgerState(fixture.root)).counts).toEqual({
      packs: 1,
      dispatches: 1,
      results: 1,
      pendingResults: 1,
      staleAtRegistrationResults: 0,
      plans: 0,
      runEvents: 1,
      targetExtensions: 0,
      callIntents: 0,
      callEvents: 0,
      historicalImports: 0,
      detachedUnknownObservations: 0,
      detachedUnknownDispositions: 0,
    });
    const history = await listStudioGenerationPanelHistory(fixture.root, { unitId: "unit-001", panelId: "panel-01" });
    expect(history.items).toEqual([first]);
    expect(JSON.stringify(history)).not.toContain("objectPath");
    expect(JSON.stringify(history)).not.toContain(fixture.root);
  });

  it("同 generationRunId+variant 禁止静默换图，raw/labeled 可作为两个显式变体", async () => {
    const fixture = await readyProject();
    const frozen = await freezeAndPersistStudioGenerationPack(fixture.root, { unitId: "unit-001", panelId: "panel-01" });
    const rawA = await registerInput(fixture.root, frozen, "run-conflict-001", "#31506b", "raw");
    const rawB = await registerInput(fixture.root, frozen, "run-conflict-001", "#6b4031", "raw");
    const labeled = await registerInput(fixture.root, frozen, "run-conflict-001", "#31506b", "labeled");
    const first = await registerStudioGenerationResult(fixture.root, rawA.input);
    await expect(registerStudioGenerationResult(fixture.root, rawB.input))
      .rejects.toBeInstanceOf(StudioGenerationResultConflictError);
    await expect(registerStudioGenerationResult(fixture.root, rawB.input))
      .rejects.toMatchObject({ code: "result-conflict", existingResultId: first.resultId });
    const labeledRecord = await registerStudioGenerationResult(fixture.root, labeled.input);
    expect(labeledRecord).toMatchObject({
      generationRunId: "run-conflict-001",
      variant: "labeled",
      pairComplete: true,
      inputCurrent: true,
      promotionEligible: true,
    });
    const paired = (await listStudioGenerationPanelHistory(fixture.root, {
      unitId: "unit-001",
      panelId: "panel-01",
    })).items;
    expect(paired).toHaveLength(2);
    expect(paired).toEqual([
      expect.objectContaining({ resultId: first.resultId, pairComplete: true, promotionEligible: true }),
      labeledRecord,
    ]);
    await expect(assertStudioGenerationResultPromotionEligible(fixture.root, first.resultId))
      .resolves.toMatchObject({ promotionEligible: true, pairComplete: true });
  });

  it("结果历史支持倒序 keyset，超过 24 条时画布仍能取得最新 run", async () => {
    const fixture = await readyProject();
    const frozen = await freezeAndPersistStudioGenerationPack(fixture.root, { unitId: "unit-001", panelId: "panel-01" });
    for (let index = 1; index <= 13; index += 1) {
      const runId = `run-history-${String(index).padStart(2, "0")}`;
      const raw = await registerInput(fixture.root, frozen, runId, `#${(0x223344 + index).toString(16).padStart(6, "0")}`, "raw");
      const labeled = await registerInput(fixture.root, frozen, runId, `#${(0x334455 + index).toString(16).padStart(6, "0")}`, "labeled");
      const rawRecord = await registerStudioGenerationResult(fixture.root, raw.input);
      const labeledRecord = await registerStudioGenerationResult(fixture.root, labeled.input);
      // 门禁适配：同槽已有完整 raw+labeled 对且无 Review 时禁止另开 generationRunId；
      // 每轮登记成对结果后为该 run 提交机械 Review 再开下一 run。
      // Review 不产生 result 行，下方倒序 keyset 分页断言不受影响。
      await submitStudioGenerationReview(fixture.root, {
        operationId: `history-review-${String(index).padStart(2, "0")}`,
        generationRunId: runId,
        kind: "observation",
        expectedHeadRevision: 0,
        rawResultId: rawRecord.resultId,
        rawSha256: rawRecord.mediaSha256,
        labeledResultId: labeledRecord.resultId,
        labeledSha256: labeledRecord.mediaSha256,
        expectedPackFingerprint: frozen.fingerprint,
        continuityFingerprint: frozen.pack.continuity.fingerprint,
        decision: "pass",
        criteria: [{ code: "identity-consistency", status: "pass", note: "机械 fixture 成对验收。" }],
        reviewer: "ledger-history-test",
        note: `第 ${index} 轮历史 run 的机械 Review。`,
      });
    }

    const newest = await listStudioGenerationPanelHistory(fixture.root, {
      unitId: "unit-001",
      panelId: "panel-01",
      order: "newest-first",
      limit: 24,
    });
    expect(newest.items).toHaveLength(24);
    expect(newest.items[0]).toMatchObject({ generationRunId: "run-history-13", variant: "labeled" });
    expect(newest.items[1]).toMatchObject({ generationRunId: "run-history-13", variant: "raw" });
    expect(newest.nextCursor).toBeTruthy();
    const older = await listStudioGenerationPanelHistory(fixture.root, {
      unitId: "unit-001",
      panelId: "panel-01",
      order: "newest-first",
      cursor: newest.nextCursor,
      limit: 24,
    });
    expect(older.items).toHaveLength(2);
    expect(older.items.at(-1)).toMatchObject({ generationRunId: "run-history-01", variant: "raw" });
  }, 120_000);

  it("未 dispatch 的 run 即使结果图合法也失败关闭，不留孤立 result 行", async () => {
    const fixture = await readyProject();
    const frozen = await freezeAndPersistStudioGenerationPack(fixture.root, { unitId: "unit-001", panelId: "panel-01" });
    const media = await createImage(fixture.root, "undispatched-result", "#273f52");
    await expect(registerStudioGenerationResult(fixture.root, {
      packId: frozen.packId,
      packFingerprint: frozen.fingerprint,
      generationRunId: "run-undispatched-001",
      variant: "raw",
      mediaSha256: media.sha256,
    })).rejects.toMatchObject({ code: "dispatch-not-found" });
    expect((await getStudioGenerationLedgerState(fixture.root)).counts).toMatchObject({ dispatches: 0, results: 0 });
  });

  it("冻结并 dispatch 后 alias/BindingSet currentness 漂移，raw/labeled 仍挂回原 pack 但永不可提升", async () => {
    const fixture = await readyProject();
    const frozen = await freezeAndPersistStudioGenerationPack(fixture.root, { unitId: "unit-001", panelId: "panel-01" });
    const raw = await registerInput(fixture.root, frozen, "run-drift-001", "#263b4f", "raw");
    const labeled = await registerInput(fixture.root, frozen, "run-drift-001", "#344f67", "labeled");
    await updateStudioCanonicalAsset(fixture.root, {
      assetId: "character-ahang",
      expectedRevision: fixture.authoritative.revision,
      aliases: ["少年阿航"],
    });

    const rawFirst = await registerStudioGenerationResult(fixture.root, raw.input);
    const labeledRecord = await registerStudioGenerationResult(fixture.root, labeled.input);
    expect(rawFirst).toMatchObject({ pairComplete: false, inputCurrent: false, promotionEligible: false });
    const rawRecord = (await readStudioGenerationResult(fixture.root, rawFirst.resultId))!;
    for (const record of [rawRecord, labeledRecord]) {
      expect(record).toMatchObject({
        generationRunId: "run-drift-001",
        packId: frozen.packId,
        packFingerprint: frozen.fingerprint,
        status: "pending",
        pairComplete: true,
        inputCurrent: false,
        promotionEligible: false,
      });
      expect(record.staleReasons.length).toBeGreaterThan(0);
      expect(record.staleReasons.join("\n")).toMatch(/asset-binding|input-drift/u);
      await expect(assertStudioGenerationResultPromotionEligible(fixture.root, record.resultId))
        .rejects.toMatchObject({ code: "result-promotion-ineligible" });
    }
    await expect(readStudioGenerationResult(fixture.root, rawRecord.resultId))
      .resolves.toMatchObject({ inputCurrent: false, promotionEligible: false, staleReasons: rawRecord.staleReasons });
    expect((await getStudioGenerationLedgerState(fixture.root)).counts).toMatchObject({
      dispatches: 1,
      results: 2,
      pendingResults: 2,
      staleAtRegistrationResults: 2,
      plans: 0,
      runEvents: 1,
    });
    const serializedHistory = JSON.stringify(await listStudioGenerationPanelHistory(fixture.root, {
      unitId: "unit-001",
      panelId: "panel-01",
    }));
    expect(serializedHistory).not.toContain(fixture.root);
    expect(serializedHistory).not.toContain("objectPath");
  });

  it("冻结并 dispatch 后 authority 漂移也只生成不可提升的历史结果", async () => {
    const fixture = await readyProject();
    const frozen = await freezeAndPersistStudioGenerationPack(fixture.root, { unitId: "unit-001", panelId: "panel-01" });
    const raw = await registerInput(fixture.root, frozen, "run-authority-drift-001", "#31475d", "raw");
    const labeled = await registerInput(fixture.root, frozen, "run-authority-drift-001", "#3a526b", "labeled");
    const replacementMedia = await createImage(fixture.root, "ahang-authority-v2", "#725943");
    const appended = await appendStudioAssetVersion(fixture.root, {
      assetId: "character-ahang",
      mediaSha256: replacementMedia.sha256,
      reviewStatus: "pending",
      expectedRevision: fixture.authoritative.revision,
    });
    const reviewed = await reviewStudioAssetVersion(fixture.root, {
      assetId: "character-ahang",
      versionId: appended.version.id,
      decision: "approved",
      expectedRevision: appended.assetRevision,
      note: "authority drift fixture",
    });
    await setStudioPrimaryAuthority(fixture.root, {
      assetId: "character-ahang",
      versionId: appended.version.id,
      expectedRevision: reviewed.revision,
      note: "authority drift fixture",
    });

    await registerStudioGenerationResult(fixture.root, raw.input);
    const late = await registerStudioGenerationResult(fixture.root, labeled.input);
    expect(late).toMatchObject({
      pairComplete: true,
      inputCurrent: false,
      promotionEligible: false,
      packId: frozen.packId,
      dispatchProvenance: "local-dispatch-intent",
    });
    expect(late.staleReasons.join("\n")).toMatch(/asset-binding|authority|input-drift/u);
  });

  it("冻结并 dispatch 后 script/单元修订漂移时仍保留原 pack 历史，不冒充 current", async () => {
    const fixture = await readyProject();
    const frozen = await freezeAndPersistStudioGenerationPack(fixture.root, { unitId: "unit-001", panelId: "panel-01" });
    const raw = await registerInput(fixture.root, frozen, "run-script-drift-001", "#2d4358", "raw");
    const labeled = await registerInput(fixture.root, frozen, "run-script-drift-001", "#38536b", "labeled");
    const scriptV2 = await appendStudioScriptRevision(fixture.root, {
      documentId: fixture.script.document.id,
      expectedRevision: fixture.script.document.revision,
      body: "阿航走入古蜀石室，火光突然熄灭。",
      source: "scripts/EP01-v2.md",
      sourceVersion: "script-v2",
    });
    await reviseStudioProductionUnit(fixture.root, {
      unitId: fixture.unit.unit.id,
      expectedRevision: fixture.unit.unit.revision,
      season: fixture.unit.unit.season,
      episode: fixture.unit.unit.episode,
      sequence: fixture.unit.unit.sequence,
      title: fixture.unit.unit.title,
      scriptRevisionId: scriptV2.revision.id,
      panels: panels(fixture.prompt.revision.id),
    });

    await registerStudioGenerationResult(fixture.root, raw.input);
    const late = await registerStudioGenerationResult(fixture.root, labeled.input);
    expect(late).toMatchObject({ pairComplete: true, inputCurrent: false, promotionEligible: false });
    expect(late.staleReasons.join("\n")).toMatch(/asset-binding-stale|revision-drift|input-drift/u);
    await expect(assertStudioGenerationResultPromotionEligible(fixture.root, late.resultId))
      .rejects.toMatchObject({ code: "result-promotion-ineligible" });
  });

  it("同 generationRunId 禁止跨 pack dispatch，raw/labeled 不能跨冻结包拼对", async () => {
    const fixture = await readyProject();
    await bindReadyPanel(fixture.root, fixture.unit.unit.id, "panel-02");
    const firstPack = await freezeAndPersistStudioGenerationPack(fixture.root, { unitId: "unit-001", panelId: "panel-01" });
    const secondPack = await freezeAndPersistStudioGenerationPack(fixture.root, { unitId: "unit-001", panelId: "panel-02" });
    await dispatchStudioGenerationPack(fixture.root, {
      packId: firstPack.packId,
      packFingerprint: firstPack.fingerprint,
      generationRunId: "run-cross-pack-001",
    provider: "codex",
    });
    await expect(dispatchStudioGenerationPack(fixture.root, {
      packId: secondPack.packId,
      packFingerprint: secondPack.fingerprint,
      generationRunId: "run-cross-pack-001",
    provider: "codex",
    })).rejects.toMatchObject({ code: "dispatch-conflict" });
    const labeled = await createImage(fixture.root, "cross-pack-labeled", "#3f596f");
    await expect(registerStudioGenerationResult(fixture.root, {
      packId: secondPack.packId,
      packFingerprint: secondPack.fingerprint,
      generationRunId: "run-cross-pack-001",
      variant: "labeled",
      mediaSha256: labeled.sha256,
    })).rejects.toMatchObject({ code: "dispatch-conflict" });
    expect((await getStudioGenerationLedgerState(fixture.root)).counts.results).toBe(0);
  });

  it("冻结包 JSON CAS 损坏后无法读取或登记结果", async () => {
    const fixture = await readyProject();
    const frozen = await freezeAndPersistStudioGenerationPack(fixture.root, { unitId: "unit-001", panelId: "panel-01" });
    const output = await registerInput(fixture.root, frozen, "run-pack-corrupt-001", "#30475e");
    const db = new DatabaseSync(path.join(fixture.root, ".aicanvas", "studio-generation-ledger.sqlite"));
    const row = db.prepare("SELECT content_relpath FROM studio_generation_packs WHERE pack_id = ?").get(frozen.packId) as {
      content_relpath: string;
    };
    db.close();
    await writeFile(path.join(fixture.root, ...row.content_relpath.split("/")), "{\"corrupt\":true}\n", "utf8");

    await expect(readStudioGenerationFrozenPack(fixture.root, frozen.packId))
      .rejects.toMatchObject({ code: "pack-cas-drift" });
    await expect(registerStudioGenerationResult(fixture.root, output.input))
      .rejects.toMatchObject({ code: "pack-cas-drift" });
  });

  it("结果图虽已导入，但 material CAS 字节损坏后仍拒绝登记", async () => {
    const fixture = await readyProject();
    const frozen = await freezeAndPersistStudioGenerationPack(fixture.root, { unitId: "unit-001", panelId: "panel-01" });
    const output = await registerInput(fixture.root, frozen, "run-media-corrupt-001", "#405f79");
    await writeFile(output.media.objectPath, "not-the-imported-image", "utf8");

    await expect(registerStudioGenerationResult(fixture.root, output.input))
      .rejects.toMatchObject({ code: "result-media-drift" });
  });

  it("已登记结果的 material CAS 后续漂移时，查询和 promote 门禁都失败关闭", async () => {
    const fixture = await readyProject();
    const frozen = await freezeAndPersistStudioGenerationPack(fixture.root, { unitId: "unit-001", panelId: "panel-01" });
    const raw = await registerInput(fixture.root, frozen, "run-post-media-drift-001", "#355069", "raw");
    const labeled = await registerInput(fixture.root, frozen, "run-post-media-drift-001", "#416078", "labeled");
    const rawRecord = await registerStudioGenerationResult(fixture.root, raw.input);
    await registerStudioGenerationResult(fixture.root, labeled.input);
    // 只篡改配对的 labeled；读取/promote raw 也必须因整组证据不完整而拒绝。
    await writeFile(labeled.media.objectPath, "tampered-after-registration", "utf8");

    await expect(readStudioGenerationResult(fixture.root, rawRecord.resultId))
      .rejects.toMatchObject({ code: "result-media-drift" });
    await expect(assertStudioGenerationResultPromotionEligible(fixture.root, rawRecord.resultId))
      .rejects.toMatchObject({ code: "result-media-drift" });
    await expect(listStudioGenerationPanelHistory(fixture.root, { unitId: "unit-001", panelId: "panel-01" }))
      .rejects.toMatchObject({ code: "result-media-drift" });
  });

  it("v1 旧库确定性迁移 legacy-registration，不伪造远程 dispatch", async () => {
    const fixture = await readyProject();
    const frozen = await freezeAndPersistStudioGenerationPack(fixture.root, { unitId: "unit-001", panelId: "panel-01" });
    const raw = await registerInput(fixture.root, frozen, "run-legacy-001", "#31495f", "raw");
    const labeled = await registerInput(fixture.root, frozen, "run-legacy-001", "#3b566e", "labeled");
    const rawRecord = await registerStudioGenerationResult(fixture.root, raw.input);
    await registerStudioGenerationResult(fixture.root, labeled.input);
    const databasePath = path.join(fixture.root, ".aicanvas", "studio-generation-ledger.sqlite");
    downgradeGenerationLedgerToV1(databasePath);

    const migrated = await initializeStudioGenerationLedger(fixture.root);
    expect(migrated.schemaVersion).toBe(7);
    expect(migrated.counts).toMatchObject({ packs: 1, dispatches: 1, results: 2, staleAtRegistrationResults: 0 });
    const legacyDispatch = await readStudioGenerationDispatch(fixture.root, "run-legacy-001");
    expect(legacyDispatch).toMatchObject({
      dispatchId: expect.stringMatching(/^studio-generation-dispatch-[a-f0-9]{40}$/u),
      generationRunId: "run-legacy-001",
      packId: frozen.packId,
      provider: "codex",
      dispatchProvenance: "legacy-registration",
    });
    const projected = await readStudioGenerationResult(fixture.root, rawRecord.resultId);
    expect(projected).toMatchObject({
      dispatchId: legacyDispatch!.dispatchId,
      dispatchProvenance: "legacy-registration",
      pairComplete: true,
      inputCurrent: true,
      promotionEligible: true,
      staleReasons: [],
    });
    await expect(registerStudioGenerationResult(fixture.root, raw.input)).resolves.toMatchObject({
      resultId: rawRecord.resultId,
      dispatchId: legacyDispatch!.dispatchId,
      dispatchProvenance: "legacy-registration",
    });
    // 重复打开不再改写迁移身份。
    await initializeStudioGenerationLedger(fixture.root);
    await expect(readStudioGenerationDispatch(fixture.root, "run-legacy-001")).resolves.toEqual(legacyDispatch);
  });

  it("真实 v4 形状纯增迁移到 v5，保留旧 pack/dispatch/plan 且重复打开幂等", async () => {
    const fixture = await readyProject();
    await bindReadyPanel(fixture.root, "unit-001", "panel-02");
    const frozen = await freezeAndPersistStudioGenerationPack(fixture.root, { unitId: "unit-001", panelId: "panel-01" });
    await freezeAndPersistStudioGenerationPack(fixture.root, { unitId: "unit-001", panelId: "panel-02" });
    const plan = await createStudioGenerationPlan(fixture.root, {
      nodes: [{ unitId: "unit-001", panelId: "panel-02" }],
      sourceCommandRequestId: "v4-migration-plan-001",
    });
    const dispatch = await dispatchStudioGenerationPack(fixture.root, {
      packId: frozen.packId,
      packFingerprint: frozen.fingerprint,
      generationRunId: "run-v4-migration-001",
      provider: "codex",
    });
    const databasePath = path.join(fixture.root, ".aicanvas", "studio-generation-ledger.sqlite");
    downgradeGenerationLedgerToV4(databasePath);

    const before = new DatabaseSync(databasePath, { readOnly: true });
    expect(before.prepare("SELECT value FROM studio_generation_ledger_meta WHERE key='schema_version'").get()).toEqual({ value: "4" });
    expect(before.prepare("SELECT COUNT(*) AS count FROM studio_generation_packs").get()).toEqual({ count: 2 });
    expect(before.prepare("SELECT COUNT(*) AS count FROM studio_generation_dispatches").get()).toEqual({ count: 1 });
    expect(before.prepare("SELECT COUNT(*) AS count FROM studio_generation_plans").get()).toEqual({ count: 1 });
    expect(before.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='studio_generation_call_intents'").get())
      .toEqual({ count: 0 });
    before.close();

    const migrated = await initializeStudioGenerationLedger(fixture.root);
    expect(migrated).toMatchObject({ schemaVersion: 7, counts: { packs: 2, dispatches: 1, plans: 1, callIntents: 0 } });
    await expect(readStudioGenerationDispatch(fixture.root, "run-v4-migration-001")).resolves.toMatchObject({
      dispatchId: dispatch.dispatchId,
      packId: frozen.packId,
      generationRunId: "run-v4-migration-001",
    });
    await expect(getStudioGenerationPlanProjection(fixture.root, plan.planId)).resolves.toMatchObject({
      planId: plan.planId,
      nodeCount: 1,
    });

    const firstProjection = await getStudioGenerationLedgerState(fixture.root);
    const secondProjection = await initializeStudioGenerationLedger(fixture.root);
    expect(secondProjection).toEqual(firstProjection);
    const reopened = new DatabaseSync(databasePath, { readOnly: true });
    expect(reopened.prepare("SELECT value FROM studio_generation_ledger_meta WHERE key='schema_version'").get()).toEqual({ value: "7" });
    expect(reopened.prepare("SELECT COUNT(*) AS count FROM studio_generation_call_intents").get()).toEqual({ count: 0 });
    reopened.close();
  });

  it("真实 v3 形状按版本连续迁移到 v7，不提前制造新版残留", async () => {
    const fixture = await readyProject();
    const frozen = await freezeAndPersistStudioGenerationPack(fixture.root, { unitId: "unit-001", panelId: "panel-01" });
    const dispatch = await dispatchStudioGenerationPack(fixture.root, {
      packId: frozen.packId,
      packFingerprint: frozen.fingerprint,
      generationRunId: "run-v3-migration-001",
      provider: "codex",
    });
    const databasePath = path.join(fixture.root, ".aicanvas", "studio-generation-ledger.sqlite");
    downgradeGenerationLedgerToV3(databasePath);

    const before = new DatabaseSync(databasePath, { readOnly: true });
    expect(before.prepare("SELECT value FROM studio_generation_ledger_meta WHERE key='schema_version'").get()).toEqual({ value: "3" });
    expect(before.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name IN ('studio_generation_plans','studio_generation_pack_targets')").get())
      .toEqual({ count: 0 });
    before.close();

    await expect(initializeStudioGenerationLedger(fixture.root)).resolves.toMatchObject({
      schemaVersion: 7,
      counts: { packs: 1, dispatches: 1, plans: 0, targetExtensions: 0 },
    });
    await expect(readStudioGenerationDispatch(fixture.root, "run-v3-migration-001")).resolves.toMatchObject({
      dispatchId: dispatch.dispatchId,
      provider: "codex",
    });
  });

  it("真实 v2 形状补 executor_provider 后连续迁移到 v7 并保留旧 dispatch", async () => {
    const fixture = await readyProject();
    const frozen = await freezeAndPersistStudioGenerationPack(fixture.root, { unitId: "unit-001", panelId: "panel-01" });
    const dispatch = await dispatchStudioGenerationPack(fixture.root, {
      packId: frozen.packId,
      packFingerprint: frozen.fingerprint,
      generationRunId: "run-v2-migration-001",
      provider: "codex",
    });
    const databasePath = path.join(fixture.root, ".aicanvas", "studio-generation-ledger.sqlite");
    downgradeGenerationLedgerToV2(databasePath);

    const before = new DatabaseSync(databasePath, { readOnly: true });
    expect(before.prepare("SELECT value FROM studio_generation_ledger_meta WHERE key='schema_version'").get()).toEqual({ value: "2" });
    expect((before.prepare("PRAGMA table_info(studio_generation_dispatches)").all() as Array<{ name: string }>)
      .some((column) => column.name === "executor_provider")).toBe(false);
    before.close();

    await expect(initializeStudioGenerationLedger(fixture.root)).resolves.toMatchObject({
      schemaVersion: 7,
      counts: { packs: 1, dispatches: 1, plans: 0, targetExtensions: 0 },
    });
    await expect(readStudioGenerationDispatch(fixture.root, "run-v2-migration-001")).resolves.toMatchObject({
      dispatchId: dispatch.dispatchId,
      provider: "codex",
      dispatchProvenance: "local-dispatch-intent",
    });
  });

  it("真实 v5 连续迁移到 v7，保留 detached observation 并新增调用代理审计列", async () => {
    const fixture = await readyProject();
    const observation = await recordStudioDetachedGenerationUnknownObservation(fixture.root, {
      unitId: fixture.unit.unit.id,
      unitRevision: fixture.unit.unit.revision,
      unitFingerprint: fixture.unit.fingerprint,
      sourceTaskId: "v5-to-v6-detached-observation-001",
      evidenceReference: "v5-to-v6-evidence-001",
      evidenceFingerprint: digest({ migration: "v5-to-v6" }),
      candidateSha256: digest({ migrationCandidate: "preserve" }),
      candidateSizeBytes: 12_345,
      candidateWidth: 941,
      candidateHeight: 1_672,
    });
    const databasePath = path.join(fixture.root, ".aicanvas", "studio-generation-ledger.sqlite");
    downgradeGenerationLedgerToV5(databasePath);
    const before = new DatabaseSync(databasePath, { readOnly: true });
    expect(before.prepare("SELECT value FROM studio_generation_ledger_meta WHERE key='schema_version'").get())
      .toEqual({ value: "5" });
    expect(before.prepare(`SELECT COUNT(*) AS count FROM sqlite_master
      WHERE type='table' AND name='studio_generation_detached_unknown_dispositions'`).get())
      .toEqual({ count: 0 });
    before.close();

    await expect(initializeStudioGenerationLedger(fixture.root)).resolves.toMatchObject({
      schemaVersion: 7,
      counts: {
        detachedUnknownObservations: 1,
        detachedUnknownDispositions: 0,
      },
    });
    await expect(listStudioDetachedGenerationUnknownObservations(fixture.root, { unitId: "unit-001" }))
      .resolves.toEqual([observation]);
    await expect(listStudioDetachedGenerationUnknownDispositions(fixture.root, { unitId: "unit-001" }))
      .resolves.toEqual([]);
    const migratedDatabase = new DatabaseSync(databasePath, { readOnly: true });
    expect(migratedDatabase.prepare("SELECT value FROM studio_generation_ledger_meta WHERE key='schema_version'").get())
      .toEqual({ value: "7" });
    expect((migratedDatabase.prepare("PRAGMA table_info(studio_generation_call_intents)").all() as Array<{ name: string }>)
      .map((column) => column.name)).toContain("caller_agent_id");
    migratedDatabase.close();
    await expect(initializeStudioGenerationLedger(fixture.root)).resolves.toMatchObject({
      schemaVersion: 7,
      counts: { detachedUnknownObservations: 1, detachedUnknownDispositions: 0 },
    });
  }, 120_000);

  it("v4→v7 遇到冲突 schema 时整笔回滚并保留 v4 marker 与旧数据", async () => {
    const fixture = await readyProject();
    await freezeAndPersistStudioGenerationPack(fixture.root, { unitId: "unit-001", panelId: "panel-01" });
    const databasePath = path.join(fixture.root, ".aicanvas", "studio-generation-ledger.sqlite");
    downgradeGenerationLedgerToV4(databasePath, true);

    await expect(initializeStudioGenerationLedger(fixture.root)).rejects.toThrow();
    const preserved = new DatabaseSync(databasePath, { readOnly: true });
    expect(preserved.prepare("SELECT value FROM studio_generation_ledger_meta WHERE key='schema_version'").get()).toEqual({ value: "4" });
    expect(preserved.prepare("SELECT COUNT(*) AS count FROM studio_generation_packs").get()).toEqual({ count: 1 });
    expect(preserved.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='studio_generation_pack_targets'").get())
      .toEqual({ count: 0 });
    expect(preserved.prepare("PRAGMA table_info(studio_generation_call_events)").all())
      .toEqual([expect.objectContaining({ name: "wrong_column" })]);
    preserved.close();
  });

  it("v4→v7 遇到缺失旧 append-only 对象时迁移前失败且不静默修复", async () => {
    const fixture = await readyProject();
    await freezeAndPersistStudioGenerationPack(fixture.root, { unitId: "unit-001", panelId: "panel-01" });
    const databasePath = path.join(fixture.root, ".aicanvas", "studio-generation-ledger.sqlite");
    downgradeGenerationLedgerToV4(databasePath);
    const tamper = new DatabaseSync(databasePath);
    tamper.exec("DROP TRIGGER studio_generation_run_events_no_delete");
    tamper.close();

    await expect(initializeStudioGenerationLedger(fixture.root))
      .rejects.toMatchObject({ code: "storage-invalid" });
    const preserved = new DatabaseSync(databasePath, { readOnly: true });
    expect(preserved.prepare("SELECT value FROM studio_generation_ledger_meta WHERE key='schema_version'").get()).toEqual({ value: "4" });
    expect(preserved.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='trigger' AND name='studio_generation_run_events_no_delete'").get())
      .toEqual({ count: 0 });
    expect(preserved.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='studio_generation_pack_targets'").get())
      .toEqual({ count: 0 });
    preserved.close();
  });

  it("v1 旧库若已把同 run 的 raw/labeled 跨 pack 绑定，迁移保持原库且失败关闭", async () => {
    const fixture = await readyProject();
    await bindReadyPanel(fixture.root, fixture.unit.unit.id, "panel-02");
    const firstPack = await freezeAndPersistStudioGenerationPack(fixture.root, { unitId: "unit-001", panelId: "panel-01" });
    const secondPack = await freezeAndPersistStudioGenerationPack(fixture.root, { unitId: "unit-001", panelId: "panel-02" });
    const raw = await createImage(fixture.root, "legacy-cross-pack-raw", "#334c62");
    const labeled = await createImage(fixture.root, "legacy-cross-pack-labeled", "#3d586f");
    const databasePath = path.join(fixture.root, ".aicanvas", "studio-generation-ledger.sqlite");
    downgradeGenerationLedgerToV1(databasePath);
    const db = new DatabaseSync(databasePath);
    const insert = db.prepare(`
      INSERT INTO studio_generation_results(
        result_id, generation_run_id, variant, status, media_sha256,
        pack_id, pack_fingerprint, unit_id, unit_revision, panel_id, panel_index, created_at
      ) VALUES(?, 'run-legacy-cross-pack', ?, 'pending', ?, ?, ?, 'unit-001', 1, ?, ?, ?)
    `);
    const createdAt = new Date().toISOString();
    insert.run("legacy-result-raw", "raw", raw.sha256, firstPack.packId, firstPack.fingerprint, "panel-01", 1, createdAt);
    insert.run("legacy-result-labeled", "labeled", labeled.sha256, secondPack.packId, secondPack.fingerprint, "panel-02", 2, createdAt);
    db.close();

    await expect(initializeStudioGenerationLedger(fixture.root)).rejects.toMatchObject({ code: "storage-invalid" });
    const unchanged = new DatabaseSync(databasePath);
    const version = unchanged.prepare(
      "SELECT value FROM studio_generation_ledger_meta WHERE key = 'schema_version'",
    ).get() as { value: string };
    const resultCount = unchanged.prepare("SELECT COUNT(*) AS count FROM studio_generation_results")
      .get() as { count: number };
    unchanged.close();
    expect(version.value).toBe("1");
    expect(Number(resultCount.count)).toBe(2);
  });

  it("已声明当前 v7 的账本缺表时失败关闭且不在打开过程中静默补表", async () => {
    const fixture = await readyProject();
    const databasePath = path.join(fixture.root, ".aicanvas", "studio-generation-ledger.sqlite");
    const tamper = new DatabaseSync(databasePath);
    tamper.exec("DROP TABLE studio_generation_call_events");
    tamper.close();

    await expect(initializeStudioGenerationLedger(fixture.root))
      .rejects.toMatchObject({ code: "storage-invalid" });
    const audit = new DatabaseSync(databasePath, { readOnly: true });
    const missing = audit.prepare(
      "SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='studio_generation_call_events'",
    ).get() as { count: number };
    const marker = audit.prepare(
      "SELECT value FROM studio_generation_ledger_meta WHERE key='schema_version'",
    ).get() as { value: string };
    audit.close();
    expect(Number(missing.count)).toBe(0);
    expect(marker.value).toBe("7");
  });

  it("v5 call protocol、intent 与 event 使用复合外键锁定同一 dispatch/run/pack 身份", async () => {
    const fixture = await readyProject();
    const databasePath = path.join(fixture.root, ".aicanvas", "studio-generation-ledger.sqlite");
    const audit = new DatabaseSync(databasePath, { readOnly: true });
    const contracts = [
      ["studio_generation_dispatch_protocols", ["dispatch_id>dispatch_id", "generation_run_id>generation_run_id"]],
      ["studio_generation_call_intents", [
        "dispatch_id>dispatch_id", "generation_run_id>generation_run_id",
        "pack_id>pack_id", "pack_fingerprint>pack_fingerprint",
      ]],
      ["studio_generation_call_events", ["call_id>call_id", "generation_run_id>generation_run_id"]],
    ] as const;
    for (const [table, expected] of contracts) {
      const rows = audit.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<{
        id: number; seq: number; from: string; to: string;
      }>;
      expect(new Set(rows.map((row) => row.id)).size).toBe(1);
      expect(rows.sort((left, right) => left.seq - right.seq).map((row) => `${row.from}>${row.to}`)).toEqual(expected);
    }
    const dispatchIndexes = audit.prepare("PRAGMA index_list(studio_generation_dispatches)").all() as Array<{
      name: string; unique: number;
    }>;
    expect(dispatchIndexes).toContainEqual(expect.objectContaining({
      name: "studio_generation_dispatch_call_identity_idx",
      unique: 1,
    }));
    audit.close();
  });

  it("panel 历史使用 limit<=100 的键集分页，不重不漏", async () => {
    const fixture = await readyProject();
    const frozen = await freezeAndPersistStudioGenerationPack(fixture.root, { unitId: "unit-001", panelId: "panel-01" });
    for (let index = 0; index < 5; index += 1) {
      const color = `#${(0x24384c + index * 0x10101).toString(16).padStart(6, "0")}`;
      const result = await registerInput(fixture.root, frozen, `run-page-${String(index).padStart(3, "0")}`, color);
      await registerStudioGenerationResult(fixture.root, result.input);
      // P21 panel 互斥归因：raw 单边 run 为非终态，逐轮取消后下一轮才可派发。
      await cancelStudioGenerationRun(fixture.root, {
        generationRunId: `run-page-${String(index).padStart(3, "0")}`,
        reason: "分页夹具收尾",
      });
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await listStudioGenerationPanelHistory(fixture.root, {
        unitId: "unit-001",
        panelId: "panel-01",
        cursor,
        limit: 2,
      });
      seen.push(...page.items.map((item) => item.generationRunId));
      expect(JSON.stringify(page)).not.toContain("objectPath");
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual(["run-page-000", "run-page-001", "run-page-002", "run-page-003", "run-page-004"]);
    expect(new Set(seen).size).toBe(5);
    await expect(listStudioGenerationPanelHistory(fixture.root, {
      unitId: "unit-001",
      panelId: "panel-01",
      limit: 101,
    })).rejects.toThrow("1-100");
    const first = await listStudioGenerationPanelHistory(fixture.root, { unitId: "unit-001", panelId: "panel-01", limit: 1 });
    await expect(listStudioGenerationPanelHistory(fixture.root, {
      unitId: "unit-001",
      panelId: "panel-02",
      cursor: first.nextCursor,
      limit: 1,
    })).rejects.toMatchObject({ code: "invalid-cursor" });
  });
});
