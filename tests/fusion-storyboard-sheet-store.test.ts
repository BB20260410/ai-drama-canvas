import { createHash } from "node:crypto";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FUSION_STORYBOARD_SHEET_RENDER_POLICY_VERSION,
  buildFusionStoryboardSheetId,
  deriveFusionStoryboardSheetStatus,
  fusionStoryboardSheetFingerprint,
  fusionStoryboardSheetInputFingerprint,
  listFusionStoryboardSheetArtifactSnapshot,
  loadFusionStoryboardSheetRecord,
  loadFusionStoryboardSheetStore,
  registerFusionStoryboardSheetRecord,
  registerLegacyFusionStoryboardSheetRecord,
  type FusionStoryboardSheetCurrentEvidence,
  type FusionStoryboardSheetRegistrationInput,
} from "../src/core/fusion-storyboard-sheet-store.js";

const roots: string[] = [];

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

function sha(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function currentEvidence(panelCount = 2): FusionStoryboardSheetCurrentEvidence {
  const panels = Array.from({ length: panelCount }, (_, offset) => {
    const panelIndex = offset + 1;
    const panelId = `panel-${panelIndex}`;
    return {
      panelId,
      panelIndex,
      panelCount,
      generationJobId: `job-${panelIndex}`,
      generationJobFingerprint: sha(`job-${panelIndex}`),
      publicationReceiptId: `publication-${panelIndex}`,
      publicationReceiptFingerprint: sha(`publication-${panelIndex}`),
      raw: {
        artifactId: `raw-${panelIndex}`,
        path: `/project/raw-${panelIndex}.png`,
        sha256: sha(`raw-${panelIndex}`),
        bytes: 1_000 + panelIndex,
      },
      labeled: {
        artifactId: `labeled-${panelIndex}`,
        path: `/project/labeled-${panelIndex}.png`,
        sha256: sha(`labeled-${panelIndex}`),
        bytes: 2_000 + panelIndex,
      },
    };
  });
  return {
    projectId: "project-p4",
    sourceContentAddress: `sha256:${sha("source")}`,
    itemId: "season-三-ep01-unit001",
    contract: {
      contractId: "grid-6c02035d032128e0f62a",
      sourceFingerprint: sha("contract-source"),
      productionFingerprint: sha("contract-production"),
      contractFingerprint: sha("entire-contract"),
    },
    requirement: {
      requirementId: `fusion-review-${sha("requirement")}`,
      requirementFingerprint: sha("entire-requirement"),
      complete: true,
    },
    review: {
      reviewId: "review-current-p3",
      reviewFingerprint: sha("entire-review"),
      decision: "pass",
    },
    panels,
    renderPolicy: {
      policyVersion: FUSION_STORYBOARD_SHEET_RENDER_POLICY_VERSION,
      renderer: "svg-sharp-v2",
      locale: "zh-CN",
      defaultImageFit: "contain",
      textMeasurement: "deterministic-character-units-v2",
      overflowPolicy: "long-sheet",
      rowHeightPolicy: "dynamic-content-measured",
      silentTruncation: false,
      pageWidth: 2_160,
      basePageHeight: 3_840,
      maximumPageHeight: 12_000,
      panelImagePolicies: Object.fromEntries(panels.map((panel) => [panel.panelId, { fit: "contain" as const }])),
    },
  };
}

function registrationInput(evidence: FusionStoryboardSheetCurrentEvidence, pngPath: string, svgPath: string, png: Buffer, svg: Buffer): FusionStoryboardSheetRegistrationInput {
  const fieldNames = ["imageContentAction", "shotComposition", "shootingMethod", "continuitySound", "dialogueSubtitle"] as const;
  return {
    ...structuredClone(evidence),
    renderEvidence: {
      renderFingerprint: sha("render-result"),
      cropAudit: evidence.panels.map((panel) => ({
        panelId: panel.panelId,
        fit: "contain",
        geometry: "none",
        sourceWidth: 941,
        sourceHeight: 1_672,
        orientedWidth: 941,
        orientedHeight: 1_672,
        targetWidth: 570,
        targetHeight: 720,
        cropApplied: false,
      })),
      overflowReport: {
        policy: "long-sheet",
        basePageHeight: 3_840,
        actualPageHeight: 4_320,
        expanded: true,
        overflowPixels: 480,
        allRequiredTextVisible: true,
        silentTruncation: false,
        truncatedFields: [],
        rows: evidence.panels.map((panel, index) => ({
          panelId: panel.panelId,
          top: 320 + index * 1_500,
          height: 1_450,
          textFields: fieldNames.map((field) => ({
            panelId: panel.panelId,
            field,
            contentSha256: sha(`${panel.panelId}-${field}`),
            lineCount: 2,
            requiredHeight: 88,
            allocatedHeight: 96,
            complete: true,
          })),
        })),
      },
    },
    outputs: [
      { role: "png", path: pngPath, sha256: sha(png), bytes: png.length, width: 2_160, height: 4_320, pageIndex: 1, pageCount: 1 },
      { role: "svg", path: svgPath, sha256: sha(svg), bytes: svg.length, width: 2_160, height: 4_320, pageIndex: 1, pageCount: 1 },
    ],
  };
}

async function materializedInput(root: string, evidence: FusionStoryboardSheetCurrentEvidence, suffix: string): Promise<FusionStoryboardSheetRegistrationInput> {
  const png = Buffer.from(`png-v2-${suffix}-${evidence.review.reviewFingerprint}`);
  const svg = Buffer.from(`<svg data-version="v2">${suffix}-${evidence.requirement.requirementId}</svg>`);
  const provisional = registrationInput(evidence, path.join(root, "pending.png"), path.join(root, "pending.svg"), png, svg);
  const sheetId = buildFusionStoryboardSheetId(provisional);
  const directory = path.join(root, "outputs", sheetId);
  await mkdir(directory, { recursive: true });
  const pngPath = path.join(directory, `${sheetId}-page-01.png`);
  const svgPath = path.join(directory, `${sheetId}-page-01.svg`);
  await Promise.all([writeFile(pngPath, png), writeFile(svgPath, svg)]);
  return registrationInput(evidence, pngPath, svgPath, png, svg);
}

describe("P4 内容寻址正式中文分镜板 store", () => {
  it("sheetId 冻结合同、requirement、Review、逐格账本、渲染策略和输出 SHA", () => {
    const evidence = currentEvidence();
    const png = Buffer.from("png-content");
    const svg = Buffer.from("svg-content");
    const base = registrationInput(evidence, "/tmp/pending.png", "/tmp/pending.svg", png, svg);
    const inputFingerprint = fusionStoryboardSheetInputFingerprint(base);
    const fingerprint = fusionStoryboardSheetFingerprint(base);
    expect(inputFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(buildFusionStoryboardSheetId(base)).toBe(`sheet-v2-${inputFingerprint.slice(0, 32)}`);

    const cases: FusionStoryboardSheetRegistrationInput[] = [];
    const requirement = structuredClone(base);
    requirement.requirement.requirementFingerprint = sha("changed requirement");
    cases.push(requirement);
    const review = structuredClone(base);
    review.review.reviewFingerprint = sha("changed review");
    cases.push(review);
    const job = structuredClone(base);
    job.panels[0]!.generationJobFingerprint = sha("changed job");
    cases.push(job);
    const publication = structuredClone(base);
    publication.panels[0]!.publicationReceiptFingerprint = sha("changed publication");
    cases.push(publication);
    const raw = structuredClone(base);
    raw.panels[0]!.raw.sha256 = sha("changed raw");
    cases.push(raw);
    const labeled = structuredClone(base);
    labeled.panels[0]!.labeled.sha256 = sha("changed labeled");
    cases.push(labeled);
    const policy = structuredClone(base);
    policy.renderPolicy.maximumPageHeight += 1;
    cases.push(policy);
    const output = structuredClone(base);
    output.outputs[0]!.sha256 = sha("changed output");
    expect(fusionStoryboardSheetFingerprint(output)).not.toBe(fingerprint);
    expect(buildFusionStoryboardSheetId(output)).toBe(buildFusionStoryboardSheetId(base));
    expect(new Set(cases.map(buildFusionStoryboardSheetId)).size).toBe(cases.length);
    expect(cases.every((candidate) => buildFusionStoryboardSheetId(candidate) !== buildFusionStoryboardSheetId(base))).toBe(true);

    const cropped = structuredClone(base);
    cropped.renderPolicy.panelImagePolicies["panel-1"] = {
      fit: "crop",
      reason: "特写保留主体脸部",
      evidence: { kind: "normalized-focus", x: 0.5, y: 0.42 },
    };
    expect(buildFusionStoryboardSheetId(cropped)).not.toBe(buildFusionStoryboardSheetId(base));
    const unsafeCrop = structuredClone(cropped);
    unsafeCrop.renderPolicy.panelImagePolicies["panel-1"] = {
      fit: "crop",
      reason: "x",
      evidence: { kind: "normalized-focus", x: 0.5, y: 0.42 },
    };
    expect(() => buildFusionStoryboardSheetId(unsafeCrop)).toThrow(/理由/u);
  });

  it("严格拒绝缺格、伪造 crop 审计和任何 overflow 静默截断", () => {
    const evidence = currentEvidence();
    const base = registrationInput(evidence, "/tmp/pending.png", "/tmp/pending.svg", Buffer.from("png"), Buffer.from("svg"));

    const missingCrop = structuredClone(base);
    missingCrop.renderEvidence.cropAudit.pop();
    expect(() => fusionStoryboardSheetFingerprint(missingCrop)).toThrow(/cropAudit|逐格/u);

    const forgedCrop = structuredClone(base);
    forgedCrop.renderPolicy.panelImagePolicies["panel-1"] = {
      fit: "crop",
      reason: "保留主体脸部",
      evidence: { kind: "normalized-focus", x: 0.5, y: 0.4 },
    };
    expect(() => fusionStoryboardSheetFingerprint(forgedCrop)).toThrow(/crop|裁切|策略/u);

    const missingRow = structuredClone(base);
    missingRow.renderEvidence.overflowReport.rows.pop();
    expect(() => fusionStoryboardSheetFingerprint(missingRow)).toThrow(/overflow|逐格|rows/u);

    const truncated = structuredClone(base);
    const unsafeOverflow = truncated.renderEvidence.overflowReport as unknown as { silentTruncation: boolean; truncatedFields: string[] };
    unsafeOverflow.silentTruncation = true;
    unsafeOverflow.truncatedFields = ["panel-1.dialogueSubtitle"];
    expect(() => fusionStoryboardSheetFingerprint(truncated)).toThrow(/截断/u);
  });

  it("以 CAS 登记不可变 receipt/index，重放幂等、冲突不覆盖并保留历史版本", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-p4-sheet-store-"));
    roots.push(root);
    const firstInput = await materializedInput(root, currentEvidence(), "first");
    const first = await registerFusionStoryboardSheetRecord(root, firstInput, { expectedRevision: 0, createdAt: "2026-07-17T00:00:00.000Z" });
    expect(first).toMatchObject({ created: true, selected: true, store: { revision: 1 } });
    expect(first.record.sheetId).toBe(buildFusionStoryboardSheetId(firstInput));
    expect(await loadFusionStoryboardSheetRecord(root, first.record.sheetId)).toEqual(first.record);

    const replay = await registerFusionStoryboardSheetRecord(root, firstInput, { expectedRevision: 0, createdAt: "2099-01-01T00:00:00.000Z" });
    expect(replay).toMatchObject({ created: false, selected: true, store: { revision: 1 } });
    expect(replay.record.createdAt).toBe("2026-07-17T00:00:00.000Z");

    const conflictingPathInput = structuredClone(firstInput);
    const alternateDirectory = path.join(root, "alternate", first.record.sheetId);
    await mkdir(alternateDirectory, { recursive: true });
    for (const output of conflictingPathInput.outputs) {
      const source = await readFile(output.path);
      output.path = path.join(alternateDirectory, `${first.record.sheetId}-${output.role}.${output.role}`);
      await writeFile(output.path, source);
    }
    expect(buildFusionStoryboardSheetId(conflictingPathInput)).toBe(first.record.sheetId);
    await expect(registerFusionStoryboardSheetRecord(root, conflictingPathInput, { expectedRevision: 1 })).rejects.toThrow(/不同路径|拒绝覆盖/u);

    const conflictingOutputInput = structuredClone(firstInput);
    const changedDirectory = path.join(root, "changed-output", first.record.sheetId);
    await mkdir(changedDirectory, { recursive: true });
    for (const output of conflictingOutputInput.outputs) {
      const changed = Buffer.from(`changed-${output.role}-bytes`);
      output.path = path.join(changedDirectory, `${first.record.sheetId}-changed.${output.role}`);
      output.sha256 = sha(changed);
      output.bytes = changed.length;
      await writeFile(output.path, changed);
    }
    expect(buildFusionStoryboardSheetId(conflictingOutputInput)).toBe(first.record.sheetId);
    expect(fusionStoryboardSheetFingerprint(conflictingOutputInput)).not.toBe(first.record.fingerprint);
    await expect(registerFusionStoryboardSheetRecord(root, conflictingOutputInput, { expectedRevision: 1 })).rejects.toThrow(/不同路径|拒绝覆盖/u);

    const secondEvidence = currentEvidence();
    secondEvidence.review = { reviewId: "review-p3-rework", reviewFingerprint: sha("rework review"), decision: "pass" };
    const secondInput = await materializedInput(root, secondEvidence, "second");
    const secondId = buildFusionStoryboardSheetId(secondInput);
    await expect(registerFusionStoryboardSheetRecord(root, secondInput, { expectedRevision: 0 })).rejects.toThrow(/CAS|r0/u);
    await expect(access(path.join(root, ".aicanvas", "storyboard-sheets", secondEvidence.itemId, secondId, "receipt.json"))).rejects.toMatchObject({ code: "ENOENT" });
    const second = await registerFusionStoryboardSheetRecord(root, secondInput, { expectedRevision: 1, createdAt: "2026-07-17T01:00:00.000Z" });
    expect(second.store).toMatchObject({ revision: 2, currentByItemId: { [secondEvidence.itemId]: { sheetId: secondId } } });
    expect(Object.keys(second.store.records).sort()).toEqual([first.record.sheetId, secondId].sort());
  });

  it("从绝对路径派生 current/stale/invalid/legacy-invalid 及精确原因", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-p4-sheet-status-"));
    roots.push(root);
    const firstEvidence = currentEvidence();
    const firstInput = await materializedInput(root, firstEvidence, "first");
    const first = await registerFusionStoryboardSheetRecord(root, firstInput, { expectedRevision: 0, createdAt: "2026-07-17T00:00:00.000Z" });
    const secondEvidence = currentEvidence();
    secondEvidence.requirement = { requirementId: `fusion-review-${sha("new requirement")}`, requirementFingerprint: sha("new requirement body"), complete: true };
    secondEvidence.review = { reviewId: "review-new", reviewFingerprint: sha("new review"), decision: "pass" };
    const secondInput = await materializedInput(root, secondEvidence, "second");
    const second = await registerFusionStoryboardSheetRecord(root, secondInput, { expectedRevision: 1, createdAt: "2026-07-17T01:00:00.000Z" });

    let snapshot = await listFusionStoryboardSheetArtifactSnapshot(root, { currentEvidenceByItemId: { [secondEvidence.itemId]: secondEvidence } });
    expect(snapshot.items.filter((entry) => entry.sheetId === second.record.sheetId).every((entry) => entry.status === "current")).toBe(true);
    const stale = snapshot.items.filter((entry) => entry.sheetId === first.record.sheetId);
    expect(stale.every((entry) => entry.status === "stale")).toBe(true);
    expect(stale[0]?.reasons).toEqual(expect.arrayContaining(["superseded-by-current-selection", "requirement-id-drift", "review-id-drift"]));
    expect(Object.values(snapshot.byPath).every((entry) => path.isAbsolute(entry.path))).toBe(true);

    await writeFile(second.record.outputs[0]!.path, "tampered-png");
    snapshot = await listFusionStoryboardSheetArtifactSnapshot(root, { currentEvidenceByItemId: { [secondEvidence.itemId]: secondEvidence } });
    const invalid = snapshot.items.filter((entry) => entry.sheetId === second.record.sheetId);
    expect(invalid.every((entry) => entry.status === "invalid")).toBe(true);
    expect(invalid[0]?.reasons.join(" ")).toMatch(/png-page-1-(sha|size)-drift/u);

    const legacyPath = path.join(root, "legacy", "EP01_001-old.png");
    await mkdir(path.dirname(legacyPath), { recursive: true });
    await writeFile(legacyPath, "old-board");
    const legacy = await registerLegacyFusionStoryboardSheetRecord(root, {
      itemId: secondEvidence.itemId,
      contractId: firstEvidence.contract.contractId,
      requirementId: firstEvidence.requirement.requirementId,
      reviewId: firstEvidence.review.reviewId,
      artifacts: [{ role: "png", path: legacyPath, pageIndex: 1, pageCount: 1, sha256: sha("old-board"), bytes: 9 }],
      reason: "P0 旧板未冻结 P3 requirement",
    }, { expectedRevision: 2, registeredAt: "2026-07-17T02:00:00.000Z" });
    expect(legacy.store.revision).toBe(3);
    snapshot = await listFusionStoryboardSheetArtifactSnapshot(root, { currentEvidenceByItemId: { [secondEvidence.itemId]: secondEvidence } });
    const legacyEntries = snapshot.items.filter((entry) => entry.sheetId === legacy.record.sheetId);
    expect(legacyEntries).toHaveLength(1);
    expect(legacyEntries[0]).toMatchObject({ status: "legacy-invalid", role: "png", contractId: firstEvidence.contract.contractId });
    expect(legacyEntries[0]?.reasons.join(" ")).toMatch(/pre-p4|P3/u);
    await writeFile(legacyPath, "tampered-legacy-board");
    snapshot = await listFusionStoryboardSheetArtifactSnapshot(root, { currentEvidenceByItemId: { [secondEvidence.itemId]: secondEvidence } });
    const driftedLegacyEntries = snapshot.items.filter((entry) => entry.sheetId === legacy.record.sheetId);
    expect(driftedLegacyEntries).toHaveLength(1);
    expect(driftedLegacyEntries[0]?.status).toBe("invalid");
    expect(driftedLegacyEntries[0]?.reasons.join(" ")).toMatch(/png-(sha|size)-drift/u);

    const conflictingLegacy = await registerLegacyFusionStoryboardSheetRecord(root, {
      itemId: "season-三-ep01-unit999",
      contractId: "grid-legacy-path-conflict",
      artifacts: [{ role: "png", path: first.record.outputs[0]!.path, pageIndex: 1, pageCount: 1 }],
      reason: "测试历史路径冲突失败关闭",
    }, { expectedRevision: 3, registeredAt: "2026-07-17T03:00:00.000Z" });
    snapshot = await listFusionStoryboardSheetArtifactSnapshot(root, { currentEvidenceByItemId: { [secondEvidence.itemId]: secondEvidence } });
    const conflictedPathEntries = snapshot.items.filter((entry) => entry.path === path.resolve(first.record.outputs[0]!.path));
    expect(conflictedPathEntries).toHaveLength(2);
    expect(conflictedPathEntries.every((entry) => entry.status === "invalid" && entry.reasons.includes("artifact-path-claimed-by-multiple-sheets"))).toBe(true);
    expect(snapshot.byPath[path.resolve(first.record.outputs[0]!.path)]).toMatchObject({ status: "invalid" });

    const tamperedRecord = structuredClone(first.record);
    tamperedRecord.review.reviewId = "forged-review";
    expect(deriveFusionStoryboardSheetStatus(tamperedRecord, { selectedSheetId: tamperedRecord.sheetId, currentEvidence: firstEvidence })).toMatchObject({ status: "invalid" });
    expect(deriveFusionStoryboardSheetStatus(first.record, { selectedSheetId: first.record.sheetId })).toEqual({ status: "stale", reasons: ["current-evidence-unavailable"] });
    const finalStore = await loadFusionStoryboardSheetStore(root);
    expect(finalStore.legacyRecords[legacy.record.sheetId]).toEqual(legacy.record);
    expect(finalStore.legacyRecords[conflictingLegacy.record.sheetId]).toEqual(conflictingLegacy.record);
  });

  it("拒绝把 v2 或历史 Artifact 登记到工程根外", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-p4-sheet-contained-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "ai-canvas-p4-sheet-outside-"));
    roots.push(root, outside);
    const evidence = currentEvidence();
    const inside = await materializedInput(root, evidence, "inside-template");
    const escaped = structuredClone(inside);
    for (const output of escaped.outputs) {
      const content = await readFile(output.path);
      output.path = path.join(outside, `${buildFusionStoryboardSheetId(escaped)}-${output.role}-page-01.${output.role}`);
      await writeFile(output.path, content);
    }
    await expect(registerFusionStoryboardSheetRecord(root, escaped, { expectedRevision: 0 })).rejects.toThrow(/越出允许根目录/u);
    expect((await loadFusionStoryboardSheetStore(root)).revision).toBe(0);

    const legacyPath = path.join(outside, "legacy-outside.png");
    await writeFile(legacyPath, "legacy-outside");
    await expect(registerLegacyFusionStoryboardSheetRecord(root, {
      itemId: evidence.itemId,
      artifacts: [{ role: "png", path: legacyPath, pageIndex: 1, pageCount: 1, sha256: sha("legacy-outside"), bytes: 14 }],
      reason: "越界历史文件必须失败关闭",
    }, { expectedRevision: 0 })).rejects.toThrow(/越出允许根目录/u);
    expect((await loadFusionStoryboardSheetStore(root)).revision).toBe(0);
  });
});
